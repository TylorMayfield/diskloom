use crate::types::*;
use chrono::{DateTime, Utc};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    phase: String,
    current_path: String,
    files_processed: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    total_files: Option<usize>,
    bytes_hashed: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    total_bytes: Option<u64>,
}

#[cfg(unix)]
fn physical(_: &Path, meta: &fs::Metadata) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    Some((meta.dev(), meta.ino()))
}
#[cfg(windows)]
fn physical(path: &Path, _: &fs::Metadata) -> Option<same_file::Handle> {
    same_file::Handle::from_path(path).ok()
}
fn iso(time: std::time::SystemTime) -> String {
    DateTime::<Utc>::from(time).to_rfc3339()
}
fn fingerprint(meta: &fs::Metadata) -> String {
    let modified = meta
        .modified()
        .ok()
        .and_then(|v| v.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|v| v.as_millis())
        .unwrap_or(0);
    format!("{}:{modified}", meta.len())
}
pub fn file_matches(file: &DuplicateFile) -> bool {
    fs::symlink_metadata(&file.path)
        .map(|m| m.is_file() && !m.file_type().is_symlink() && fingerprint(&m) == file.fingerprint)
        .unwrap_or(false)
}

pub fn analyze(
    root: String,
    app: AppHandle,
    cancel: &AtomicBool,
) -> Result<DuplicateAnalysisResult, String> {
    cancel.store(false, Ordering::Relaxed);
    let mut files = Vec::new();
    let mut seen = HashSet::new();
    let mut pending = vec![PathBuf::from(&root)];
    let mut discovered: usize = 0;
    while let Some(target) = pending.pop() {
        if cancel.load(Ordering::Relaxed) {
            return Err("Duplicate analysis cancelled".into());
        }
        let meta = match fs::symlink_metadata(&target) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_dir() {
            if let Ok(entries) = fs::read_dir(&target) {
                for entry in entries.flatten() {
                    pending.push(entry.path())
                }
            }
            continue;
        }
        if !meta.is_file() {
            continue;
        }
        discovered += 1;
        if meta.len() > 0 && physical(&target, &meta).is_none_or(|identity| seen.insert(identity)) {
            files.push(DuplicateFile {
                name: target
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned(),
                path: target.to_string_lossy().into_owned(),
                parent_path: target
                    .parent()
                    .unwrap_or(Path::new(""))
                    .to_string_lossy()
                    .into_owned(),
                size: meta.len(),
                modified_at: meta.modified().map(iso).unwrap_or_default(),
                created_at: meta.created().ok().map(iso),
                fingerprint: fingerprint(&meta),
            })
        }
        if discovered.is_multiple_of(100) {
            let _ = app.emit(
                "duplicate-progress",
                Progress {
                    phase: "discovering".into(),
                    current_path: target.to_string_lossy().into_owned(),
                    files_processed: discovered,
                    total_files: None,
                    bytes_hashed: 0,
                    total_bytes: None,
                },
            );
        }
    }
    let mut by_size: HashMap<u64, Vec<DuplicateFile>> = HashMap::new();
    for file in files {
        by_size.entry(file.size).or_default().push(file)
    }
    let candidates: Vec<_> = by_size
        .into_values()
        .filter(|v| v.len() > 1)
        .flatten()
        .collect();
    let total_bytes = candidates.iter().map(|f| f.size).sum();
    let mut matches: HashMap<(u64, String), Vec<DuplicateFile>> = HashMap::new();
    let mut bytes_hashed = 0;
    let mut hashed = 0;
    for file in candidates.iter() {
        if cancel.load(Ordering::Relaxed) {
            return Err("Duplicate analysis cancelled".into());
        }
        let mut input = match File::open(&file.path) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let mut digest = Sha256::new();
        let mut buffer = vec![0u8; 1024 * 1024];
        loop {
            let count = input.read(&mut buffer).map_err(|e| e.to_string())?;
            if count == 0 {
                break;
            }
            digest.update(&buffer[..count]);
            bytes_hashed += count as u64;
            if cancel.load(Ordering::Relaxed) {
                return Err("Duplicate analysis cancelled".into());
            }
        }
        hashed += 1;
        let hash = hex::encode(digest.finalize());
        matches
            .entry((file.size, hash))
            .or_default()
            .push(file.clone());
        let _ = app.emit(
            "duplicate-progress",
            Progress {
                phase: "hashing".into(),
                current_path: file.path.clone(),
                files_processed: hashed,
                total_files: Some(candidates.len()),
                bytes_hashed,
                total_bytes: Some(total_bytes),
            },
        );
    }
    let mut groups: Vec<_> = matches
        .into_iter()
        .filter(|(_, v)| v.len() > 1)
        .map(|((size, hash), mut files)| {
            files.sort_by(|a, b| a.path.cmp(&b.path));
            DuplicateGroup {
                id: format!("{size}:{hash}"),
                size,
                hash,
                wasted_space: size * (files.len() as u64 - 1),
                files,
            }
        })
        .collect();
    groups.sort_by_key(|group| std::cmp::Reverse(group.wasted_space));
    Ok(DuplicateAnalysisResult {
        total_wasted_space: groups.iter().map(|g| g.wasted_space).sum(),
        duplicate_file_count: groups.iter().map(|g| g.files.len() - 1).sum(),
        groups,
        scanned_file_count: discovered,
        hashed_file_count: hashed,
    })
}
