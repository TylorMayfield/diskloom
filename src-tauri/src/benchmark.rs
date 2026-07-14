use crate::types::*;
use chrono::Utc;
use rand::RngCore;
use serde::Serialize;
use std::{
    fs::{self, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};
use sysinfo::{Disks, System};
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
struct Progress {
    completed: usize,
    total: usize,
    current: String,
}
fn median(values: &[f64]) -> f64 {
    let mut v = values.to_vec();
    v.sort_by(|a, b| a.total_cmp(b));
    if v.len() % 2 == 1 {
        v[v.len() / 2]
    } else {
        (v[v.len() / 2 - 1] + v[v.len() / 2]) / 2.0
    }
}
fn variation(values: &[f64]) -> f64 {
    if values.len() < 2 {
        return 0.0;
    }
    let center = median(values);
    if center == 0.0 {
        return 0.0;
    }
    let deviations: Vec<_> = values.iter().map(|v| (v - center).abs()).collect();
    median(&deviations) / center * 100.0
}
fn test_dir(target: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(target);
    let probe = path.join(format!(".diskloom-write-probe-{}", std::process::id()));
    match fs::write(&probe, []) {
        Ok(_) => {
            let _ = fs::remove_file(probe);
            Ok(path)
        }
        Err(e) => {
            #[cfg(target_os = "macos")]
            if path == Path::new("/") {
                return Ok(std::env::temp_dir());
            }
            Err(format!(
                "This drive is read-only, so its write performance cannot be benchmarked: {e}"
            ))
        }
    }
}
fn benchmark_read_only(mount: &str, filesystem_read_only: bool) -> bool {
    // Modern macOS reports its sealed system volume at `/` as read-only. The
    // benchmark intentionally redirects that target to the writable data
    // volume via the system temporary directory in `test_dir`.
    filesystem_read_only && !(cfg!(target_os = "macos") && mount == "/")
}
pub fn drives() -> Vec<BenchmarkDrive> {
    Disks::new_with_refreshed_list()
        .iter()
        .filter(|d| {
            let p = d.mount_point().to_string_lossy();
            cfg!(target_os = "macos") && (p == "/" || p.starts_with("/Volumes/"))
                || cfg!(target_os = "linux")
                    && (p == "/"
                        || p.starts_with("/mnt/")
                        || p.starts_with("/media/")
                        || p.starts_with("/run/media/"))
                || cfg!(windows)
        })
        .map(|d| {
            let mount = d.mount_point().to_string_lossy().into_owned();
            let read_only = benchmark_read_only(&mount, d.is_read_only());
            BenchmarkDrive {
                id: format!("{}:{mount}", d.name().to_string_lossy()),
                name: if mount == "/" {
                    "System drive".into()
                } else {
                    d.name().to_string_lossy().into_owned()
                },
                mount_point: mount,
                total_bytes: d.total_space(),
                free_bytes: d.available_space(),
                read_only,
            }
        })
        .collect()
}
pub fn memory() -> u64 {
    let mut system = System::new();
    system.refresh_memory();
    system.total_memory()
}
pub fn run(
    request: BenchmarkRequest,
    app: AppHandle,
    cancel: &AtomicBool,
) -> Result<BenchmarkReport, String> {
    cancel.store(false, Ordering::Relaxed);
    let size_mib = request.size_mi_b.clamp(32, 64 * 1024);
    let size = size_mib * 1024 * 1024;
    let runs = request.runs.clamp(1, 5);
    let directory = test_dir(&request.target)?;
    let tests = [
        ("seq1m-q8", "SEQ1M", "Q8T1", 1024 * 1024, false),
        ("seq1m-q1", "SEQ1M", "Q1T1", 1024 * 1024, false),
        ("rnd4k-q32", "RND4K", "Q32T1", 4096, true),
        ("rnd4k-q1", "RND4K", "Q1T1", 4096, true),
    ];
    let total = tests.len() * (runs + 1) * 2;
    let mut completed = 0;
    let mut results = Vec::new();
    for (id, label, detail, block, random) in tests {
        let path = directory.join(format!(
            ".diskloom-benchmark-{}-{id}.tmp",
            std::process::id()
        ));
        let bytes_per_pass = if random {
            size.min(32 * 1024 * 1024)
        } else {
            size
        };
        let operations = (bytes_per_pass / block as u64).max(1);
        let blocks = (size / block as u64).max(1);
        let mut buffer = vec![0x5a; block];
        rand::rng().fill_bytes(&mut buffer);
        let mut writes = Vec::new();
        let mut reads = Vec::new();
        let result = (|| -> Result<(), String> {
            let mut file = OpenOptions::new()
                .create(true)
                .truncate(true)
                .read(true)
                .write(true)
                .open(&path)
                .map_err(|e| e.to_string())?;
            file.set_len(size).map_err(|e| e.to_string())?;
            for pass in 0..=runs {
                if cancel.load(Ordering::Relaxed) {
                    return Err("Benchmark cancelled.".into());
                }
                let _ = app.emit(
                    "benchmark-progress",
                    Progress {
                        completed,
                        total,
                        current: format!(
                            "{} {label} {detail}",
                            if pass == 0 { "Warming up" } else { "Writing" }
                        ),
                    },
                );
                let start = Instant::now();
                for op in 0..operations {
                    let position = if random {
                        (op.wrapping_mul(2654435761) % blocks) * block as u64
                    } else {
                        op * block as u64
                    };
                    file.seek(SeekFrom::Start(position))
                        .map_err(|e| e.to_string())?;
                    file.write_all(&buffer).map_err(|e| e.to_string())?
                }
                file.sync_all().map_err(|e| e.to_string())?;
                if pass > 0 {
                    writes.push(bytes_per_pass as f64 / 1048576.0 / start.elapsed().as_secs_f64())
                }
                completed += 1
            }
            for pass in 0..=runs {
                if cancel.load(Ordering::Relaxed) {
                    return Err("Benchmark cancelled.".into());
                }
                let _ = app.emit(
                    "benchmark-progress",
                    Progress {
                        completed,
                        total,
                        current: format!(
                            "{} {label} {detail}",
                            if pass == 0 { "Warming up" } else { "Reading" }
                        ),
                    },
                );
                let start = Instant::now();
                for op in 0..operations {
                    let position = if random {
                        (op.wrapping_mul(2654435761) % blocks) * block as u64
                    } else {
                        op * block as u64
                    };
                    file.seek(SeekFrom::Start(position))
                        .map_err(|e| e.to_string())?;
                    file.read_exact(&mut buffer).map_err(|e| e.to_string())?
                }
                if pass > 0 {
                    reads.push(bytes_per_pass as f64 / 1048576.0 / start.elapsed().as_secs_f64())
                }
                completed += 1
            }
            Ok(())
        })();
        let _ = fs::remove_file(&path);
        result?;
        let read = median(&reads);
        let write = median(&writes);
        results.push(BenchmarkResult {
            id: id.into(),
            label: label.into(),
            detail: detail.into(),
            read,
            write,
            read_variation: variation(&reads),
            write_variation: variation(&writes),
            read_iops: random.then_some(read * 256.0),
            write_iops: random.then_some(write * 256.0),
        })
    }
    Ok(BenchmarkReport {
        target: request.target,
        size_mi_b: size_mib,
        runs,
        total_memory_bytes: memory(),
        completed_at: Utc::now().to_rfc3339(),
        results,
    })
}

#[cfg(test)]
mod tests {
    use super::benchmark_read_only;

    #[test]
    fn writable_benchmark_target_matches_platform_behavior() {
        assert!(!benchmark_read_only("/", false));
        assert!(benchmark_read_only("/Volumes/Archive", true));

        if cfg!(target_os = "macos") {
            assert!(!benchmark_read_only("/", true));
        } else {
            assert!(benchmark_read_only("/", true));
        }
    }
}
