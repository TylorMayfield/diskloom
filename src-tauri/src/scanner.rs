use crate::types::*;
use chrono::{DateTime, Utc};
use rayon::prelude::*;
use rusqlite::{params, Connection, Statement};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashSet, VecDeque},
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{sync_channel, Receiver, SyncSender},
        Arc, Mutex,
    },
    time::{Duration, Instant, UNIX_EPOCH},
};
use sysinfo::{DiskKind, Disks, System};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

const MAX_SESSIONS: usize = 2;
const VISUAL_CHILDREN: usize = 16;
const SCAN_DB_PREFIX: &str = "diskloom-scan-";
const SCAN_DB_SUFFIX: &str = ".sqlite";
const LEGACY_DB_GRACE: Duration = Duration::from_secs(24 * 60 * 60);

pub struct ScanSession {
    pub id: String,
    pub root: PathBuf,
    pub db_path: PathBuf,
    pub db: Connection,
    pub created_at: DateTime<Utc>,
}
#[derive(Clone)]
pub struct ScanState(pub Arc<Mutex<VecDeque<ScanSession>>>);

struct PendingScanDb {
    path: PathBuf,
    preserve: bool,
}

impl PendingScanDb {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            preserve: false,
        }
    }

    fn preserve(&mut self) {
        self.preserve = true;
    }
}

impl Drop for PendingScanDb {
    fn drop(&mut self) {
        if !self.preserve {
            let _ = fs::remove_file(&self.path);
        }
    }
}

#[derive(Serialize, Clone)]
pub struct ScanProgress {
    path: String,
    items: u64,
}

#[derive(Clone)]
struct IndexedNode {
    name: String,
    path: String,
    parent: Option<String>,
    size: u64,
    kind: String,
    inaccessible: bool,
    child_count: usize,
    mtime_ms: i64,
    // SQLite only has signed 64-bit integers. Filesystem identifiers are
    // unsigned on some platforms, so preserve their bits in an i64.
    device: i64,
    inode: i64,
    revision: String,
}
struct Counts {
    cancel: Arc<AtomicBool>,
    items: AtomicU64,
    inaccessible: AtomicU64,
    excluded: AtomicU64,
    physical: Mutex<HashSet<PhysicalId>>,
    #[cfg(test)]
    workers: Mutex<HashSet<std::thread::ThreadId>>,
}

#[cfg(unix)]
type PhysicalId = (u64, u64);
#[cfg(windows)]
type PhysicalId = same_file::Handle;

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn scan_db_path(directory: &Path, id: &str) -> PathBuf {
    directory.join(format!(
        "{SCAN_DB_PREFIX}p{}-{id}{SCAN_DB_SUFFIX}",
        std::process::id()
    ))
}

fn tagged_scan_pid(name: &str) -> Option<u32> {
    name.strip_prefix(SCAN_DB_PREFIX)?
        .strip_suffix(SCAN_DB_SUFFIX)?
        .strip_prefix('p')?
        .split_once('-')?
        .0
        .parse()
        .ok()
}

fn cleanup_stale_in(directory: &Path, legacy_grace: Duration) {
    let mut active_pids: HashSet<u32> = System::new_all()
        .processes()
        .keys()
        .map(|pid| pid.as_u32())
        .collect();
    active_pids.insert(std::process::id());
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !name.starts_with(SCAN_DB_PREFIX) || !name.ends_with(SCAN_DB_SUFFIX) {
            continue;
        }
        let stale = tagged_scan_pid(name)
            .map(|pid| !active_pids.contains(&pid))
            .unwrap_or_else(|| {
                entry
                    .metadata()
                    .and_then(|metadata| metadata.modified())
                    .ok()
                    .and_then(|modified| modified.elapsed().ok())
                    .is_some_and(|age| age >= legacy_grace)
            });
        if stale {
            let _ = fs::remove_file(entry.path());
        }
    }
}

pub fn cleanup_stale() {
    cleanup_stale_in(&std::env::temp_dir(), LEGACY_DB_GRACE);
}
fn name(path: &Path) -> String {
    path.file_name()
        .map(|v| v.to_string_lossy().into_owned())
        .unwrap_or_else(|| path_string(path))
}
fn mtime_ms(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|v| v.duration_since(UNIX_EPOCH).ok())
        .map(|v| v.as_millis() as i64)
        .unwrap_or(0)
}
#[cfg(unix)]
fn identity(meta: &fs::Metadata) -> (u64, u64, u64) {
    use std::os::unix::fs::MetadataExt;
    (meta.dev(), meta.ino(), meta.blocks() * 512)
}
#[cfg(windows)]
fn identity(meta: &fs::Metadata) -> (u64, u64, u64) {
    use std::os::windows::fs::MetadataExt;
    (0, 0, meta.file_size())
}

#[cfg(unix)]
fn physical_id(_: &Path, meta: &fs::Metadata) -> Option<PhysicalId> {
    let (device, inode, _) = identity(meta);
    Some((device, inode))
}

#[cfg(windows)]
fn physical_id(path: &Path, _: &fs::Metadata) -> Option<PhysicalId> {
    same_file::Handle::from_path(path).ok()
}

#[cfg(unix)]
fn volume_used(path: &Path) -> Option<u64> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let path = CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut value = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    if unsafe { libc::statvfs(path.as_ptr(), value.as_mut_ptr()) } != 0 {
        return None;
    }
    let value = unsafe { value.assume_init() };
    Some((value.f_blocks.saturating_sub(value.f_bfree) as u64).saturating_mul(value.f_frsize))
}

#[cfg(windows)]
fn volume_used(path: &Path) -> Option<u64> {
    use sysinfo::Disks;
    let disks = Disks::new_with_refreshed_list();
    let disk = disks
        .iter()
        .filter(|disk| path.starts_with(disk.mount_point()))
        .max_by_key(|disk| disk.mount_point().as_os_str().len())?;
    Some(disk.total_space().saturating_sub(disk.available_space()))
}

fn stat_revision(meta: &fs::Metadata, kind: &str) -> String {
    let (device, inode, _) = identity(meta);
    format!("{kind}:{device}:{inode}:{}:{}", meta.len(), mtime_ms(meta))
}

fn sqlite_id(value: u64) -> i64 {
    value as i64
}

fn save(statement: &mut Statement<'_>, node: &IndexedNode) -> Result<(), String> {
    statement
        .execute(params![
            node.path,
            node.parent,
            node.name,
            node.size,
            node.kind,
            node.inaccessible,
            node.child_count,
            node.mtime_ms,
            node.device,
            node.inode,
            node.revision
        ])
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn create_table(db: &Connection) -> Result<(), String> {
    db.execute_batch(
        "PRAGMA journal_mode=OFF;
         PRAGMA synchronous=OFF;
         CREATE TABLE nodes(
             path TEXT PRIMARY KEY,
             parent TEXT,
             name TEXT NOT NULL,
             size INTEGER NOT NULL,
             kind TEXT NOT NULL,
             inaccessible INTEGER NOT NULL,
             child_count INTEGER NOT NULL,
             mtime_ms INTEGER NOT NULL,
             device INTEGER NOT NULL,
             inode INTEGER NOT NULL,
             revision TEXT NOT NULL
         );",
    )
    .map_err(|e| e.to_string())
}

fn persist(mut db: Connection, nodes: Receiver<Arc<IndexedNode>>) -> Result<Connection, String> {
    let transaction = db.transaction().map_err(|e| e.to_string())?;
    {
        let mut statement = transaction
            .prepare(
                "INSERT INTO nodes(
                    path,parent,name,size,kind,inaccessible,child_count,mtime_ms,device,inode,revision
                 ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            )
            .map_err(|e| e.to_string())?;
        for node in nodes {
            save(&mut statement, &node)?;
        }
    }
    transaction
        .execute_batch("CREATE INDEX nodes_parent_size ON nodes(parent,size DESC,name ASC);")
        .map_err(|e| e.to_string())?;
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(db)
}

fn completed(node: IndexedNode, output: &SyncSender<Arc<IndexedNode>>) -> Arc<IndexedNode> {
    let node = Arc::new(node);
    // A database error closes the receiver. Discovery can still finish so the
    // writer's original error is returned to the caller.
    let _ = output.send(node.clone());
    node
}

fn walk<F>(
    target: &Path,
    parent: Option<&Path>,
    counts: &Counts,
    progress: &F,
    output: &SyncSender<Arc<IndexedNode>>,
) -> Result<Arc<IndexedNode>, String>
where
    F: Fn(ScanProgress) + Sync,
{
    if counts.cancel.load(Ordering::Relaxed) {
        return Err("Scan cancelled.".into());
    }
    #[cfg(test)]
    counts
        .workers
        .lock()
        .unwrap()
        .insert(std::thread::current().id());
    let items = counts.items.fetch_add(1, Ordering::Relaxed) + 1;
    if items.is_multiple_of(200) {
        progress(ScanProgress {
            path: path_string(target),
            items,
        });
    }
    let metadata = match fs::symlink_metadata(target) {
        Ok(value) => value,
        Err(_) => {
            counts.inaccessible.fetch_add(1, Ordering::Relaxed);
            let node = IndexedNode {
                name: name(target),
                path: path_string(target),
                parent: parent.map(path_string),
                size: 0,
                kind: "other".into(),
                inaccessible: true,
                child_count: 0,
                mtime_ms: 0,
                device: 0,
                inode: 0,
                revision: "inaccessible".into(),
            };
            return Ok(completed(node, output));
        }
    };
    let (device, inode, allocated) = identity(&metadata);
    let common =
        |kind: &str, size: u64, inaccessible: bool, child_count: usize, revision: String| {
            IndexedNode {
                name: name(target),
                path: path_string(target),
                parent: parent.map(path_string),
                size,
                kind: kind.into(),
                inaccessible,
                child_count,
                mtime_ms: mtime_ms(&metadata),
                device: sqlite_id(device),
                inode: sqlite_id(inode),
                revision,
            }
        };
    if metadata.file_type().is_symlink() {
        counts.excluded.fetch_add(1, Ordering::Relaxed);
        let node = common(
            "other",
            allocated,
            false,
            0,
            stat_revision(&metadata, "other"),
        );
        return Ok(completed(node, output));
    }
    if !metadata.is_dir() {
        let kind = if metadata.is_file() { "file" } else { "other" };
        let size = physical_id(target, &metadata).map_or(allocated, |id| {
            let mut seen = counts
                .physical
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if seen.insert(id) {
                allocated
            } else {
                0
            }
        });
        let node = common(kind, size, false, 0, stat_revision(&metadata, kind));
        return Ok(completed(node, output));
    }
    let entries = match fs::read_dir(target) {
        Ok(v) => v,
        Err(_) => {
            counts.inaccessible.fetch_add(1, Ordering::Relaxed);
            let node = common(
                "folder",
                allocated,
                true,
                0,
                stat_revision(&metadata, "folder"),
            );
            return Ok(completed(node, output));
        }
    };
    let paths: Vec<_> = entries.flatten().map(|entry| entry.path()).collect();
    let mut children: Vec<_> = paths
        .into_par_iter()
        .map(|path| walk(&path, Some(target), counts, progress, output))
        .collect::<Result<Vec<_>, _>>()?;
    let mut size = allocated;
    for child in &children {
        size = size.saturating_add(child.size);
    }
    children.sort_by(|a, b| a.name.cmp(&b.name));
    let mut hash = Sha256::new();
    hash.update(stat_revision(&metadata, "folder"));
    for child in &children {
        hash.update([0]);
        hash.update(child.name.as_bytes());
        hash.update([0]);
        hash.update(child.revision.as_bytes());
    }
    let node = common(
        "folder",
        size,
        false,
        children.len(),
        hex::encode(hash.finalize()),
    );
    Ok(completed(node, output))
}

fn parallelism(root: &Path) -> usize {
    let available = std::thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(4);
    let kind = Disks::new_with_refreshed_list()
        .iter()
        .filter(|disk| root.starts_with(disk.mount_point()))
        .max_by_key(|disk| disk.mount_point().as_os_str().len())
        .map(|disk| disk.kind());
    parallelism_for(kind, available)
}

fn parallelism_for(kind: Option<DiskKind>, available: usize) -> usize {
    let available = available.max(1);
    match kind {
        Some(DiskKind::HDD) => available.clamp(1, 4),
        Some(DiskKind::SSD) => available.saturating_mul(2).clamp(8, 24),
        _ => available.clamp(2, 8),
    }
}

fn discover<F>(
    root: &Path,
    threads: usize,
    progress: &F,
    output: &SyncSender<Arc<IndexedNode>>,
    cancel: Arc<AtomicBool>,
) -> Result<(Arc<IndexedNode>, Counts), String>
where
    F: Fn(ScanProgress) + Sync,
{
    let counts = Counts {
        cancel,
        items: AtomicU64::new(0),
        inaccessible: AtomicU64::new(0),
        excluded: AtomicU64::new(0),
        physical: Mutex::new(HashSet::new()),
        #[cfg(test)]
        workers: Mutex::new(HashSet::new()),
    };
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(threads.max(1))
        .thread_name(|index| format!("diskloom-scan-{index}"))
        .build()
        .map_err(|e| e.to_string())?;
    let scanned = pool.install(|| walk(root, None, &counts, progress, output))?;
    Ok((scanned, counts))
}

fn row_node(row: &rusqlite::Row<'_>) -> rusqlite::Result<IndexedNode> {
    Ok(IndexedNode {
        path: row.get(0)?,
        parent: row.get(1)?,
        name: row.get(2)?,
        size: row.get(3)?,
        kind: row.get(4)?,
        inaccessible: row.get(5)?,
        child_count: row.get(6)?,
        mtime_ms: row.get(7)?,
        device: row.get(8)?,
        inode: row.get(9)?,
        revision: row.get(10)?,
    })
}
fn find(db: &Connection, path: &Path) -> Result<Option<IndexedNode>, String> {
    let mut stmt = db.prepare("SELECT path,parent,name,size,kind,inaccessible,child_count,mtime_ms,device,inode,revision FROM nodes WHERE path=?1").map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query(params![path_string(path)])
        .map_err(|e| e.to_string())?;
    rows.next()
        .map_err(|e| e.to_string())?
        .map(|r| row_node(r))
        .transpose()
        .map_err(|e| e.to_string())
}
fn children(
    db: &Connection,
    parent: &str,
    offset: usize,
    limit: usize,
) -> Result<Vec<IndexedNode>, String> {
    let mut stmt = db.prepare("SELECT path,parent,name,size,kind,inaccessible,child_count,mtime_ms,device,inode,revision FROM nodes WHERE parent=?1 ORDER BY size DESC,name ASC LIMIT ?2 OFFSET ?3").map_err(|e| e.to_string())?;
    let values = stmt
        .query_map(params![parent, limit, offset], row_node)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(values)
}
fn public_node(db: &Connection, node: IndexedNode, depth: usize) -> Result<DiskNode, String> {
    let nested = if depth > 0 {
        let values = children(db, &node.path, 0, VISUAL_CHILDREN)?;
        if values.is_empty() {
            None
        } else {
            Some(
                values
                    .into_iter()
                    .map(|v| public_node(db, v, depth - 1))
                    .collect::<Result<_, _>>()?,
            )
        }
    } else {
        None
    };
    Ok(DiskNode {
        name: node.name,
        path: node.path,
        size: node.size,
        kind: node.kind,
        children: nested,
        inaccessible: node.inaccessible.then_some(true),
        child_count: node.child_count,
    })
}

pub fn scan(
    path: String,
    app: AppHandle,
    state: &ScanState,
    cancel: Arc<AtomicBool>,
) -> Result<ScanResult, String> {
    let started = Instant::now();
    let created_at = Utc::now();
    let root = fs::canonicalize(&path).map_err(|e| format!("Could not scan {path}: {e}"))?;
    let id = Uuid::new_v4().to_string();
    let db_path = scan_db_path(&std::env::temp_dir(), &id);
    let mut pending_db = PendingScanDb::new(db_path.clone());
    let db = Connection::open(&db_path).map_err(|e| e.to_string())?;
    create_table(&db)?;
    let (node_sender, node_receiver) = sync_channel(4096);
    let writer = std::thread::Builder::new()
        .name("diskloom-scan-index".into())
        .spawn(move || persist(db, node_receiver))
        .map_err(|e| e.to_string())?;
    let emit_progress = |progress| {
        let _ = app.emit("scan-progress", progress);
    };
    let discovered = discover(
        &root,
        parallelism(&root),
        &emit_progress,
        &node_sender,
        cancel,
    );
    drop(node_sender);
    let db = writer
        .join()
        .map_err(|_| "Scan index writer stopped unexpectedly".to_string())??;
    let (indexed, counts) = discovered?;
    let indexed = (*indexed).clone();
    let accessible_size = indexed.size;
    let root_node = public_node(&db, indexed, 0)?;
    let item_count = counts.items.load(Ordering::Relaxed);
    let inaccessible_count = counts.inaccessible.load(Ordering::Relaxed);
    let excluded_count = counts.excluded.load(Ordering::Relaxed);
    let _ = app.emit(
        "scan-progress",
        ScanProgress {
            path: path_string(&root),
            items: item_count,
        },
    );
    let is_volume_root = root.parent().is_none()
        || root
            .parent()
            .and_then(|parent| fs::metadata(parent).ok())
            .map(|parent| identity(&parent).0 != identity(&fs::metadata(&root).unwrap()).0)
            .unwrap_or(false);
    let unaccounted_size = is_volume_root
        .then(|| volume_used(&root))
        .flatten()
        .map(|used| used.saturating_sub(root_node.size));
    let result = ScanResult {
        id: id.clone(),
        root: root_node,
        started_at: created_at.to_rfc3339(),
        duration_ms: started.elapsed().as_millis() as u64,
        item_count,
        inaccessible_count,
        excluded_count,
        unknown_count: inaccessible_count,
        accessible_size,
        accounting: "allocated",
        unaccounted_size,
    };
    let mut sessions = state
        .0
        .lock()
        .map_err(|_| "Scan state is unavailable".to_string())?;
    sessions.push_back(ScanSession {
        id,
        root,
        db_path,
        db,
        created_at,
    });
    while sessions.len() > MAX_SESSIONS {
        if let Some(old) = sessions.pop_front() {
            drop(old.db);
            let _ = fs::remove_file(old.db_path);
        }
    }
    pending_db.preserve();
    Ok(result)
}

pub fn get_children(
    state: &ScanState,
    scan_id: String,
    path: String,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<ChildPage, String> {
    let sessions = state
        .0
        .lock()
        .map_err(|_| "Scan state is unavailable".to_string())?;
    let session = sessions
        .iter()
        .find(|s| s.id == scan_id)
        .ok_or("This scan is no longer available. Please scan again.")?;
    let parent = find(&session.db, Path::new(&path))?
        .ok_or("The requested folder is not part of this scan.")?;
    let offset = offset.unwrap_or(0);
    let limit = limit.unwrap_or(60).clamp(1, 200);
    let values = children(&session.db, &parent.path, offset, limit)?;
    let count = values.len();
    Ok(ChildPage {
        parent_path: parent.path,
        children: values
            .into_iter()
            .map(|v| public_node(&session.db, v, 2))
            .collect::<Result<_, _>>()?,
        offset,
        total: parent.child_count,
        has_more: offset + count < parent.child_count,
    })
}

pub fn get_reclaim_item(
    state: &ScanState,
    scan_id: String,
    path: String,
) -> Result<ReclaimItem, String> {
    let sessions = state
        .0
        .lock()
        .map_err(|_| "Scan state is unavailable".to_string())?;
    let session = sessions
        .iter()
        .find(|s| s.id == scan_id)
        .ok_or("This scan is no longer available. Please scan again.")?;
    let node = find(&session.db, Path::new(&path))?.ok_or("This item is not reclaimable.")?;
    if node.inaccessible || !(node.kind == "file" || node.kind == "folder") {
        return Err("This item is not reclaimable.".into());
    }
    let target = Path::new(&node.path);
    if target == session.root {
        return Err("The scan root cannot be added to Reclaim.".into());
    }
    let sensitive = [
        "System",
        "Library",
        "Applications",
        "bin",
        "etc",
        "sbin",
        "usr",
        "var",
        "Windows",
        "Program Files",
        "Program Files (x86)",
        "ProgramData",
    ]
    .iter()
    .any(|part| target.components().any(|c| c.as_os_str() == *part));
    Ok(ReclaimItem {
        name: node.name,
        path: node.path,
        size: node.size,
        kind: node.kind,
        scanned_at: session.created_at.to_rfc3339(),
        fingerprint: node.revision,
        warning: sensitive
            .then(|| "This item is in a sensitive or system-managed location.".into()),
    })
}

fn current_revision(path: &Path) -> Result<(String, String), String> {
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    let kind = if meta.file_type().is_symlink() {
        "other"
    } else if meta.is_dir() {
        "folder"
    } else if meta.is_file() {
        "file"
    } else {
        "other"
    };
    if kind != "folder" {
        return Ok((kind.into(), stat_revision(&meta, kind)));
    }
    let mut values = Vec::new();
    for entry in fs::read_dir(path).map_err(|e| e.to_string())?.flatten() {
        let (name, rev) = (
            entry.file_name().to_string_lossy().into_owned(),
            current_revision(&entry.path())?.1,
        );
        values.push((name, rev))
    }
    values.sort();
    let mut hash = Sha256::new();
    hash.update(stat_revision(&meta, "folder"));
    for (name, rev) in values {
        hash.update([0]);
        hash.update(name);
        hash.update([0]);
        hash.update(rev)
    }
    Ok((kind.into(), hex::encode(hash.finalize())))
}
pub fn item_matches(item: &ReclaimItem) -> bool {
    current_revision(Path::new(&item.path))
        .map(|(kind, revision)| kind == item.kind && revision == item.fingerprint)
        .unwrap_or(false)
}
pub fn paths_overlap(first: &str, second: &str) -> bool {
    fn contains(parent: &Path, child: &Path) -> bool {
        child == parent || child.starts_with(parent)
    }
    let a = Path::new(first);
    let b = Path::new(second);
    contains(a, b) || contains(b, a)
}

pub fn cleanup(state: &ScanState) {
    if let Ok(mut sessions) = state.0.lock() {
        for session in sessions.drain(..) {
            drop(session.db);
            let _ = fs::remove_file(session.db_path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("diskloom-{name}-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn index_fixture(root: &Path, threads: usize) -> (Connection, Arc<IndexedNode>, Counts) {
        let db = Connection::open_in_memory().unwrap();
        create_table(&db).unwrap();
        let (sender, receiver) = sync_channel(128);
        let writer = std::thread::spawn(move || persist(db, receiver));
        let discovered = discover(
            root,
            threads,
            &|_| {},
            &sender,
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        drop(sender);
        let db = writer.join().unwrap().unwrap();
        (db, discovered.0, discovered.1)
    }

    #[cfg(unix)]
    fn allocated(meta: &fs::Metadata) -> u64 {
        use std::os::unix::fs::MetadataExt;
        meta.blocks() * 512
    }

    #[cfg(windows)]
    fn allocated(meta: &fs::Metadata) -> u64 {
        meta.len()
    }

    #[test]
    fn overlap_is_component_aware() {
        assert!(paths_overlap("/data/photos", "/data/photos/trip/a.jpg"));
        assert!(paths_overlap("/data/photos/trip/a.jpg", "/data/photos"));
        assert!(!paths_overlap("/data/photos", "/data/photos-old"));
    }

    #[test]
    fn discovery_honors_cancellation_before_work_starts() {
        let root = fixture("cancelled-scan-test");
        let (sender, _receiver) = sync_channel(1);
        let error = discover(&root, 1, &|_| {}, &sender, Arc::new(AtomicBool::new(true)))
            .err()
            .unwrap();
        assert_eq!(error, "Scan cancelled.");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reclaim_revision_detects_nested_changes() {
        let root = fixture("reclaim-test");
        let nested = root.join("a/b");
        fs::create_dir_all(&nested).unwrap();
        let file = nested.join("data.bin");
        fs::write(&file, vec![1u8; 4096]).unwrap();
        let (_, fingerprint) = current_revision(&root).unwrap();
        let item = ReclaimItem {
            name: "candidate".into(),
            path: path_string(&root),
            size: 0,
            kind: "folder".into(),
            scanned_at: Utc::now().to_rfc3339(),
            fingerprint,
            warning: None,
        };
        assert!(item_matches(&item));
        fs::write(file, vec![2u8; 8192]).unwrap();
        assert!(!item_matches(&item));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn parallel_discovery_and_bulk_index_preserve_scan_results() {
        let root = fixture("parallel-scan-test");
        let wide = root.join("wide");
        fs::create_dir(&wide).unwrap();
        for index in 0..600 {
            fs::write(
                wide.join(format!("file-{index:04}.bin")),
                vec![index as u8; index % 257 + 1],
            )
            .unwrap();
        }

        let mut deep = root.clone();
        for depth in 0..12 {
            deep = deep.join(format!("depth-{depth}"));
            fs::create_dir(&deep).unwrap();
        }
        fs::write(deep.join("deep.bin"), vec![7; 17_000]).unwrap();

        let original = root.join("original.bin");
        let hard_link = root.join("hard-link.bin");
        fs::write(&original, vec![3; 9_000]).unwrap();
        fs::hard_link(&original, &hard_link).unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            symlink(&deep, root.join("not-followed")).unwrap();
        }

        let (db, indexed, counts) = index_fixture(&root, 4);
        let item_count = counts.items.load(Ordering::Relaxed);
        let stored_count: u64 = db
            .query_row("SELECT COUNT(*) FROM nodes", [], |row| row.get(0))
            .unwrap();
        assert_eq!(stored_count, item_count);
        assert_eq!(find(&db, &root).unwrap().unwrap().size, indexed.size);
        assert_eq!(
            counts.excluded.load(Ordering::Relaxed),
            if cfg!(unix) { 1 } else { 0 }
        );

        let hard_link_total: u64 = [&original, &hard_link]
            .iter()
            .map(|path| find(&db, path).unwrap().unwrap().size)
            .sum();
        assert_eq!(
            hard_link_total,
            allocated(&fs::metadata(&original).unwrap())
        );

        let first = children(&db, &path_string(&wide), 0, 60).unwrap();
        let second = children(&db, &path_string(&wide), 60, 60).unwrap();
        let last = children(&db, &path_string(&wide), 600 - 60, 60).unwrap();
        assert_eq!((first.len(), second.len(), last.len()), (60, 60, 60));
        assert_eq!(find(&db, &wide).unwrap().unwrap().child_count, 600);

        let index_count: u64 = db
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='nodes_parent_size'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(index_count, 1);
        assert!(counts.workers.lock().unwrap().len() > 1);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn bulk_index_rolls_back_the_whole_transaction_on_failure() {
        let root = fixture("transaction-test");
        let db_path = root.join("scan.sqlite");
        let db = Connection::open(&db_path).unwrap();
        create_table(&db).unwrap();
        let node = Arc::new(IndexedNode {
            name: "same".into(),
            path: "/same".into(),
            parent: None,
            size: 1,
            kind: "file".into(),
            inaccessible: false,
            child_count: 0,
            mtime_ms: 0,
            device: 1,
            inode: 1,
            revision: "revision".into(),
        });
        let (sender, receiver) = sync_channel(2);
        sender.send(node.clone()).unwrap();
        sender.send(node).unwrap();
        drop(sender);
        assert!(persist(db, receiver).is_err());

        let db = Connection::open(&db_path).unwrap();
        let stored_count: u64 = db
            .query_row("SELECT COUNT(*) FROM nodes", [], |row| row.get(0))
            .unwrap();
        assert_eq!(stored_count, 0);
        drop(db);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unsigned_filesystem_ids_round_trip_through_sqlite() {
        let db = Connection::open_in_memory().unwrap();
        create_table(&db).unwrap();
        let node = Arc::new(IndexedNode {
            name: "large-id".into(),
            path: "/large-id".into(),
            parent: None,
            size: 1,
            kind: "file".into(),
            inaccessible: false,
            child_count: 0,
            mtime_ms: 0,
            device: sqlite_id(u64::MAX),
            inode: sqlite_id(i64::MAX as u64 + 1),
            revision: "revision".into(),
        });
        let (sender, receiver) = sync_channel(1);
        sender.send(node).unwrap();
        drop(sender);
        let db = persist(db, receiver).unwrap();

        let stored = find(&db, Path::new("/large-id")).unwrap().unwrap();
        assert_eq!(stored.device as u64, u64::MAX);
        assert_eq!(stored.inode as u64, i64::MAX as u64 + 1);
    }

    #[test]
    fn startup_cleanup_removes_orphans_without_touching_active_scans() {
        let root = fixture("stale-cleanup-test");
        let active = scan_db_path(&root, "active");
        let orphan = root.join(format!(
            "{SCAN_DB_PREFIX}p{}-orphan{SCAN_DB_SUFFIX}",
            u32::MAX
        ));
        let legacy = root.join(format!("{SCAN_DB_PREFIX}legacy{SCAN_DB_SUFFIX}"));
        let unrelated = root.join("keep-me.sqlite");
        for path in [&active, &orphan, &legacy, &unrelated] {
            fs::write(path, []).unwrap();
        }

        cleanup_stale_in(&root, Duration::ZERO);

        assert!(active.exists());
        assert!(!orphan.exists());
        assert!(!legacy.exists());
        assert!(unrelated.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unfinished_database_guard_removes_only_failed_scans() {
        let root = fixture("pending-database-test");
        let failed = root.join("failed.sqlite");
        fs::write(&failed, []).unwrap();
        {
            let _pending = PendingScanDb::new(failed.clone());
        }
        assert!(!failed.exists());

        let completed = root.join("completed.sqlite");
        fs::write(&completed, []).unwrap();
        {
            let mut pending = PendingScanDb::new(completed.clone());
            pending.preserve();
        }
        assert!(completed.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn storage_kind_sets_a_bounded_worker_count() {
        assert_eq!(parallelism_for(Some(DiskKind::HDD), 64), 4);
        assert_eq!(parallelism_for(Some(DiskKind::SSD), 64), 24);
        assert_eq!(parallelism_for(None, 64), 8);
        assert_eq!(parallelism_for(Some(DiskKind::SSD), 6), 12);
        assert_eq!(parallelism_for(Some(DiskKind::SSD), 2), 8);
        assert_eq!(parallelism_for(None, 1), 2);
        assert_eq!(parallelism_for(Some(DiskKind::HDD), 1), 1);
    }
}
