use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskNode {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<DiskNode>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inaccessible: Option<bool>,
    pub child_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub id: String,
    pub root: DiskNode,
    pub started_at: String,
    pub duration_ms: u64,
    pub item_count: u64,
    pub inaccessible_count: u64,
    pub excluded_count: u64,
    pub unknown_count: u64,
    pub accessible_size: u64,
    pub accounting: &'static str,
    pub unaccounted_size: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChildPage {
    pub parent_path: String,
    pub children: Vec<DiskNode>,
    pub offset: usize,
    pub total: usize,
    pub has_more: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReclaimItem {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub kind: String,
    pub scanned_at: String,
    pub fingerprint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReclaimOutcome {
    pub path: String,
    pub status: String,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReclaimResult {
    pub outcomes: Vec<ReclaimOutcome>,
    pub reclaimed_bytes: u64,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateFile {
    pub name: String,
    pub path: String,
    pub parent_path: String,
    pub size: u64,
    pub modified_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    pub fingerprint: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateGroup {
    pub id: String,
    pub size: u64,
    pub hash: String,
    pub wasted_space: u64,
    pub files: Vec<DuplicateFile>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateAnalysisResult {
    pub groups: Vec<DuplicateGroup>,
    pub total_wasted_space: u64,
    pub duplicate_file_count: usize,
    pub scanned_file_count: usize,
    pub hashed_file_count: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateCleanupGroup {
    pub retained: DuplicateFile,
    pub selected: Vec<DuplicateFile>,
}
#[derive(Deserialize)]
pub struct DuplicateCleanupRequest {
    pub groups: Vec<DuplicateCleanupGroup>,
}
#[derive(Serialize)]
pub struct DuplicateCleanupOutcome {
    pub path: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}
#[derive(Serialize)]
pub struct DuplicateCleanupResult {
    pub outcomes: Vec<DuplicateCleanupOutcome>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkRequest {
    pub target: String,
    pub size_mi_b: u64,
    pub runs: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkResult {
    pub id: String,
    pub label: String,
    pub detail: String,
    pub read: f64,
    pub write: f64,
    pub read_variation: f64,
    pub write_variation: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_iops: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub write_iops: Option<f64>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkReport {
    pub target: String,
    pub size_mi_b: u64,
    pub runs: usize,
    pub total_memory_bytes: u64,
    pub completed_at: String,
    pub results: Vec<BenchmarkResult>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkDrive {
    pub id: String,
    pub name: String,
    pub mount_point: String,
    pub total_bytes: u64,
    pub free_bytes: u64,
    pub read_only: bool,
}
