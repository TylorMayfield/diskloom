mod benchmark;
mod duplicates;
mod scanner;
mod types;

use scanner::ScanState;
use serde::Serialize;
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::{AppHandle, Manager, State};
use types::*;

#[cfg(any(target_os = "macos", windows))]
use std::process::Command;

struct Jobs {
    duplicates: Arc<AtomicBool>,
    benchmark: Arc<AtomicBool>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    version: String,
    platform: String,
    arch: String,
    tauri_version: &'static str,
}

#[tauri::command]
fn get_app_info(app: AppHandle) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        platform: match std::env::consts::OS {
            "macos" => "darwin",
            "windows" => "win32",
            other => other,
        }
        .into(),
        arch: std::env::consts::ARCH.into(),
        tauri_version: tauri::VERSION,
    }
}
#[tauri::command]
fn pick_folder() -> Option<String> {
    rfd::FileDialog::new()
        .set_directory(dirs_home())
        .pick_folder()
        .map(|p| p.to_string_lossy().into_owned())
}
fn dirs_home() -> std::path::PathBuf {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(Into::into)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default())
}
#[tauri::command]
fn list_scan_locations() -> Vec<ScanLocation> {
    let home = dirs_home();
    let home_path = home
        .canonicalize()
        .unwrap_or(home)
        .to_string_lossy()
        .into_owned();
    let drives = benchmark::drives();
    let home_drive = drives
        .iter()
        .filter(|drive| std::path::Path::new(&home_path).starts_with(&drive.mount_point))
        .max_by_key(|drive| drive.mount_point.len());
    let mut locations = vec![ScanLocation {
        id: format!("home:{home_path}"),
        name: "Home folder".into(),
        path: home_path,
        kind: "home".into(),
        total_bytes: home_drive.map(|drive| drive.total_bytes),
        free_bytes: home_drive.map(|drive| drive.free_bytes),
    }];
    for drive in drives {
        if locations
            .iter()
            .any(|location| location.path == drive.mount_point)
        {
            continue;
        }
        locations.push(ScanLocation {
            id: format!("volume:{}", drive.id),
            name: drive.name,
            path: drive.mount_point,
            kind: "volume".into(),
            total_bytes: Some(drive.total_bytes),
            free_bytes: Some(drive.free_bytes),
        });
    }
    locations
}
#[tauri::command]
async fn scan(
    path: String,
    app: AppHandle,
    state: State<'_, ScanState>,
) -> Result<ScanResult, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || scanner::scan(path, app, &state))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
fn get_children(
    scan_id: String,
    path: String,
    offset: Option<usize>,
    limit: Option<usize>,
    state: State<ScanState>,
) -> Result<ChildPage, String> {
    scanner::get_children(&state, scan_id, path, offset, limit)
}
#[tauri::command]
fn get_reclaim_item(
    scan_id: String,
    path: String,
    state: State<ScanState>,
) -> Result<ReclaimItem, String> {
    scanner::get_reclaim_item(&state, scan_id, path)
}
#[tauri::command]
fn reveal(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(windows)]
    {
        Command::new("explorer.exe")
            .arg(format!("/select,{path}"))
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let target = std::path::Path::new(&path);
        let parent = if target.is_dir() {
            target
        } else {
            target.parent().unwrap_or(target)
        };
        open::that_detached(parent).map_err(|e| e.to_string())
    }
}
#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    open::that_detached(path).map_err(|e| e.to_string())
}
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    let parsed = url
        .parse::<tauri::Url>()
        .map_err(|_| "Invalid external URL".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Only web links can be opened.".into());
    }
    open::that_detached(url).map_err(|e| e.to_string())
}
#[tauri::command]
fn trash(path: String) -> Result<(), String> {
    trash::delete(path).map_err(|e| e.to_string())
}
#[tauri::command]
fn trash_reclaim(items: Vec<ReclaimItem>) -> ReclaimResult {
    let mut outcomes = Vec::new();
    let mut approved: Vec<ReclaimItem> = Vec::new();
    for item in items.into_iter().take(10_000) {
        if approved
            .iter()
            .any(|p| scanner::paths_overlap(&p.path, &item.path))
        {
            outcomes.push(ReclaimOutcome {
                path: item.path,
                status: "skipped".into(),
                size: item.size,
                reason: Some("This selection overlaps another selected item.".into()),
            });
            continue;
        }
        if !scanner::item_matches(&item) {
            outcomes.push(ReclaimOutcome {
                path: item.path,
                status: "skipped".into(),
                size: item.size,
                reason: Some("The item changed or is missing.".into()),
            });
            continue;
        }
        approved.push(item)
    }
    for item in approved {
        match trash::delete(&item.path) {
            Ok(_) => outcomes.push(ReclaimOutcome {
                path: item.path,
                status: "trashed".into(),
                size: item.size,
                reason: None,
            }),
            Err(e) => outcomes.push(ReclaimOutcome {
                path: item.path,
                status: "failed".into(),
                size: item.size,
                reason: Some(e.to_string()),
            }),
        }
    }
    let reclaimed_bytes = outcomes
        .iter()
        .filter(|v| v.status == "trashed")
        .map(|v| v.size)
        .sum();
    ReclaimResult {
        outcomes,
        reclaimed_bytes,
    }
}
#[tauri::command]
async fn analyze_duplicates(
    path: String,
    app: AppHandle,
    jobs: State<'_, Jobs>,
) -> Result<DuplicateAnalysisResult, String> {
    let cancel = jobs.duplicates.clone();
    tauri::async_runtime::spawn_blocking(move || duplicates::analyze(path, app, &cancel))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
fn cancel_duplicate_analysis(jobs: State<Jobs>) {
    jobs.duplicates.store(true, Ordering::Relaxed)
}
#[tauri::command]
fn trash_duplicates(request: DuplicateCleanupRequest) -> DuplicateCleanupResult {
    let mut outcomes = Vec::new();
    for group in request.groups {
        if group.selected.iter().any(|f| f.path == group.retained.path) {
            for file in group.selected {
                outcomes.push(DuplicateCleanupOutcome {
                    path: file.path,
                    status: "skipped".into(),
                    reason: Some("No protected copy was retained.".into()),
                })
            }
            continue;
        }
        if !duplicates::file_matches(&group.retained) {
            for file in group.selected {
                outcomes.push(DuplicateCleanupOutcome {
                    path: file.path,
                    status: "skipped".into(),
                    reason: Some("The retained copy changed or is missing.".into()),
                })
            }
            continue;
        }
        for file in group.selected {
            if !duplicates::file_matches(&file) {
                outcomes.push(DuplicateCleanupOutcome {
                    path: file.path,
                    status: "skipped".into(),
                    reason: Some("File changed or is missing.".into()),
                });
                continue;
            }
            match trash::delete(&file.path) {
                Ok(_) => outcomes.push(DuplicateCleanupOutcome {
                    path: file.path,
                    status: "trashed".into(),
                    reason: None,
                }),
                Err(e) => outcomes.push(DuplicateCleanupOutcome {
                    path: file.path,
                    status: "failed".into(),
                    reason: Some(e.to_string()),
                }),
            }
        }
    }
    DuplicateCleanupResult { outcomes }
}
#[tauri::command]
fn list_benchmark_drives() -> Vec<BenchmarkDrive> {
    benchmark::drives()
}
#[tauri::command]
fn get_system_memory() -> u64 {
    benchmark::memory()
}
#[tauri::command]
async fn run_benchmark(
    request: BenchmarkRequest,
    app: AppHandle,
    jobs: State<'_, Jobs>,
) -> Result<BenchmarkReport, String> {
    let cancel = jobs.benchmark.clone();
    tauri::async_runtime::spawn_blocking(move || benchmark::run(request, app, &cancel))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
fn cancel_benchmark(jobs: State<Jobs>) {
    jobs.benchmark.store(true, Ordering::Relaxed)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    scanner::cleanup_stale();
    let app = tauri::Builder::default()
        .manage(ScanState(Arc::new(Mutex::new(VecDeque::new()))))
        .manage(Jobs {
            duplicates: Arc::new(AtomicBool::new(false)),
            benchmark: Arc::new(AtomicBool::new(false)),
        })
        .invoke_handler(tauri::generate_handler![
            get_app_info,
            pick_folder,
            list_scan_locations,
            scan,
            get_children,
            get_reclaim_item,
            trash_reclaim,
            reveal,
            open_path,
            open_external,
            trash,
            analyze_duplicates,
            cancel_duplicate_analysis,
            trash_duplicates,
            list_benchmark_drives,
            get_system_memory,
            run_benchmark,
            cancel_benchmark
        ])
        .build(tauri::generate_context!())
        .expect("error while building Diskloom");
    app.run(|handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            scanner::cleanup(&handle.state::<ScanState>());
        }
    });
}
