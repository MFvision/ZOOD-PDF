//! The Library on the desktop: the folders a person chose, walked; their files
//! read one at a time when their turn comes; and the index kept in the app's
//! own data directory.
//!
//! Nothing here reads a document's content to list it — a folder of ten
//! thousand files costs one `stat` each, not ten thousand reads — and nothing
//! here is held in memory whole: the walk hands its findings to the interface
//! in batches as it goes (`warraq://library-scan`), on a thread of its own, so
//! the window stays alive and Stop is answered at once.
//!
//! Scope. The dialog plugin puts a folder the person picked into the fs scope
//! (with everything under it, `recursive`), and every path this module touches
//! is checked against that scope. A link that leaves the chosen folder is
//! refused even though the scope's glob would let it through: the person chose
//! a folder, not wherever its links point.
//!
//! Hostile input. A folder can hold anything. A subfolder that cannot be read,
//! a file whose metadata is refused, a link that loops: each is recorded as a
//! skip with its reason and the walk carries on. Depth, entries, files and a
//! single file's size are all bounded.
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_fs::FsExt;

use crate::core_bridge::debug_log;

/// Progress and findings while a folder is walked. Payload: [`ScanEvent`].
pub const LIBRARY_SCAN_EVENT: &str = "warraq://library-scan";

/// What changed under a watched folder since the last look. Payload: [`WatchEvent`].
pub const LIBRARY_WATCH_EVENT: &str = "warraq://library-watch";

/// A folder is walked this deep, and no further; deeper ones are a skip with
/// a reason, not a silent stop.
const MAX_DEPTH: usize = 24;
/// The most files one scan lists, over all its folders.
const MAX_FILES: usize = 100_000;
/// The most entries one scan looks at, listed or not: a folder of a million
/// files must not hold the window.
const MAX_ENTRIES: usize = 1_000_000;
/// The most files whose size and date one scan is told about beforehand. No
/// more than one scan can list: everything past that could only ever come
/// back as missing.
const MAX_KNOWN: usize = MAX_FILES;
/// Findings travel to the interface this many at a time.
const BATCH: usize = 256;
/// The largest single file handed to the indexer. Bigger ones are a skip with
/// a reason: the index is built from text, and no document is read into memory
/// whole beyond this.
pub const MAX_FILE_BYTES: u64 = 512 * 1024 * 1024;
/// The most files re-checked by the watcher, over all its folders. Beyond it
/// the watcher says plainly that it is not watching, rather than re-stat a
/// hundred thousand files every few seconds.
const MAX_WATCHED: usize = 20_000;
/// How often the watcher looks again.
const WATCH_INTERVAL: Duration = Duration::from_secs(5);
/// An index's name may be this long, at most.
const MAX_INDEX_NAME: usize = 64;

/// The kinds the Library reads, when the interface names none. Kept here so
/// the same folder lists the same files on macOS, Windows and Linux.
pub const DEFAULT_EXTENSIONS: &[&str] = &[
    "pdf", "png", "jpg", "jpeg", "tif", "tiff", "webp", "heic", "heif", "bmp", "gif", "docx",
    "xlsx", "pptx", "html", "htm", "md", "markdown", "txt", "csv",
];

/* ------------------------------------------------------------------ walking */

/// One file found under a chosen folder. Its bytes are not read here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryFile {
    /// The core's `key`: the full path, which on the desktop is stable.
    pub key: String,
    pub name: String,
    /// Its place under the chosen folder, `/`-separated whatever the platform.
    pub relative: String,
    /// The chosen folder it was found under, as the person picked it.
    pub root: String,
    pub size: u64,
    /// Milliseconds since the epoch, negative before it, 0 when the file
    /// system does not say.
    pub modified: i64,
    /// Lower-case, without its dot; empty when the name has none.
    pub extension: String,
    /// Against what the interface said it already had: [`FileState`].
    pub state: FileState,
}

/// What a walked file is, next to the index that already exists.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileState {
    /// Not in the index.
    New,
    /// In the index, but its size or its date has moved — while the app was
    /// closed, or while it was open and looking elsewhere.
    Changed,
    /// In the index, untouched: it is not read again.
    Same,
}

/// A file or folder passed over, and why. Never fatal: the walk carries on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySkip {
    pub path: String,
    /// `unreadable` (the folder or its metadata was refused), `link` (a link
    /// out of the chosen folder, or one that loops back into it), `too-deep`,
    /// `too-big`, `too-many`.
    pub reason: &'static str,
}

/// One folder to walk, as the person chose it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanRoot {
    pub path: String,
    /// Its subfolders too. Off when the person asked for this folder alone.
    #[serde(default)]
    pub recursive: bool,
    /// Subfolders the person unticked, by full path. What they did not choose
    /// is not walked and not reported: it is not a skip, it is a choice.
    #[serde(default)]
    pub exclude: Vec<String>,
}

/// What the interface already has for a file, so the walk can say whether it
/// needs reading again.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownFile {
    pub key: String,
    pub size: u64,
    pub modified: i64,
}

/// The arguments of one walk.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanRequest {
    pub roots: Vec<ScanRoot>,
    /// Lower-case, without dots. Empty: [`DEFAULT_EXTENSIONS`].
    #[serde(default)]
    pub extensions: Vec<String>,
    /// What the index holds already. Files it does not name are `new`; files
    /// it names that the walk never meets come back as `missing`.
    #[serde(default)]
    pub known: Vec<KnownFile>,
}

/// How one folder is walked, without any of Tauri in it so a test can drive it.
pub struct WalkOptions {
    pub recursive: bool,
    /// Full paths not to enter.
    pub exclude: HashSet<PathBuf>,
    /// Lower-case extensions, without dots. Empty: every file.
    pub extensions: HashSet<String>,
    /// What is already indexed, by full path.
    pub known: HashMap<String, (u64, i64)>,
    /// Counted across every folder of one scan.
    pub budget: Budget,
}

/// What one scan may still spend. Shared by its folders, so a scan of five
/// folders is bounded like a scan of one.
#[derive(Debug, Clone, Copy)]
pub struct Budget {
    pub files: usize,
    pub entries: usize,
}

impl Default for Budget {
    fn default() -> Self {
        Self {
            files: MAX_FILES,
            entries: MAX_ENTRIES,
        }
    }
}

/// What one walk found, beside the files it handed over as it went.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct WalkSummary {
    pub files: usize,
    pub folders: usize,
    pub skipped: usize,
    /// What the budget has left, for the next folder of the same scan.
    pub budget_left: (usize, usize),
    /// The budget ran out: the interface is told, rather than shown a short
    /// list that looks complete.
    pub truncated: bool,
    /// Stop was asked for.
    pub stopped: bool,
}

/// Milliseconds since the epoch for a file's date; 0 when there is none.
fn millis(time: std::io::Result<SystemTime>) -> i64 {
    let Ok(time) = time else { return 0 };
    match time.duration_since(UNIX_EPOCH) {
        Ok(since) => i64::try_from(since.as_millis()).unwrap_or(i64::MAX),
        // Before 1970: a real date, and one some archives carry.
        Err(before) => -i64::try_from(before.duration().as_millis()).unwrap_or(i64::MAX),
    }
}

fn extension_of(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default()
}

/// `/`-separated wherever it runs, so a key looks the same in the interface on
/// Windows as it does here.
fn relative_to(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

/// Whether `path` is inside `root`, both already canonical. On Windows both
/// carry the same `\\?\` verbatim prefix, which is also what lets a path
/// longer than 260 characters through at all.
fn inside(root: &Path, path: &Path) -> bool {
    path == root || path.starts_with(root)
}

/// What a walk hands back, one at a time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WalkItem {
    File(LibraryFile),
    Skipped(LibrarySkip),
}

/// Walks `root`, handing every file and every skip to `on` as it meets them.
///
/// Links are the careful part. `file_type` does not follow one, so a link is
/// recognised before anything is opened; it is then resolved once, and taken
/// only if it lands inside the chosen folder. Every folder is entered by its
/// one true path and no more than once, which is what keeps `deeper -> ..`
/// from walking for ever and what keeps a folder reached both directly and
/// through a link from being read twice. A *file* reached through a link
/// inside the folder is listed — it is a file of that folder, and the core
/// puts two paths holding the same bytes together by their content hash.
pub fn walk_folder<F>(
    root: &Path,
    options: &mut WalkOptions,
    stop: &AtomicBool,
    on: &mut F,
) -> WalkSummary
where
    F: FnMut(WalkItem),
{
    let mut summary = WalkSummary {
        budget_left: (options.budget.files, options.budget.entries),
        ..WalkSummary::default()
    };
    // The chosen folder's own true path: every link is judged against it.
    let Ok(anchor) = std::fs::canonicalize(root) else {
        on(WalkItem::Skipped(LibrarySkip {
            path: root.to_string_lossy().into_owned(),
            reason: "unreadable",
        }));
        summary.skipped += 1;
        return summary;
    };
    // Every folder by its one true path, so none is entered twice.
    let mut seen: HashSet<PathBuf> = HashSet::from([anchor.clone()]);
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        if stop.load(Ordering::Relaxed) {
            summary.stopped = true;
            break;
        }
        summary.folders += 1;
        let listing = match std::fs::read_dir(&dir) {
            Ok(listing) => listing,
            Err(e) => {
                debug_log(format!("library: cannot read {}: {e}", dir.display()));
                on(WalkItem::Skipped(LibrarySkip {
                    path: dir.to_string_lossy().into_owned(),
                    reason: "unreadable",
                }));
                summary.skipped += 1;
                continue;
            }
        };
        // Sorted so the interface shows a folder in the order a person reads
        // it, and so two runs over the same folder agree.
        let mut children: Vec<_> = listing.flatten().collect();
        children.sort_by_key(|entry| entry.file_name());
        // Subfolders are entered after their folder's own files are listed,
        // and a real one before a link to it: taken in order, the folder a
        // person sees is the one whose name the interface shows.
        let mut pending: Vec<(PathBuf, bool)> = Vec::new();
        for entry in children {
            if stop.load(Ordering::Relaxed) {
                summary.stopped = true;
                break;
            }
            if options.budget.entries == 0 || options.budget.files == 0 {
                summary.truncated = true;
                break;
            }
            options.budget.entries -= 1;
            let name = entry.file_name().to_string_lossy().into_owned();
            // Hidden everywhere: `.git`, `.DS_Store`, an editor's swap files.
            if name.starts_with('.') {
                continue;
            }
            let path = entry.path();
            if options.exclude.contains(&path) {
                // Not a skip: the person unticked it.
                continue;
            }
            let Ok(kind) = entry.file_type() else {
                on(WalkItem::Skipped(LibrarySkip {
                    path: path.to_string_lossy().into_owned(),
                    reason: "unreadable",
                }));
                summary.skipped += 1;
                continue;
            };
            // A link is resolved once, and only taken where it stays inside.
            let linked = kind.is_symlink();
            let (is_dir, is_file) = if linked {
                // `canonicalize` both resolves the link and proves what it
                // points at exists; a link to nothing is a skip, not a panic.
                match std::fs::canonicalize(&path) {
                    Ok(target) if inside(&anchor, &target) => match std::fs::metadata(&target) {
                        Ok(meta) => (meta.is_dir(), meta.is_file()),
                        Err(_) => {
                            on(WalkItem::Skipped(LibrarySkip {
                                path: path.to_string_lossy().into_owned(),
                                reason: "unreadable",
                            }));
                            summary.skipped += 1;
                            continue;
                        }
                    },
                    // Out of the chosen folder, or pointing at nothing.
                    _ => {
                        on(WalkItem::Skipped(LibrarySkip {
                            path: path.to_string_lossy().into_owned(),
                            reason: "link",
                        }));
                        summary.skipped += 1;
                        continue;
                    }
                }
            } else {
                (kind.is_dir(), kind.is_file())
            };
            if is_dir {
                if !options.recursive {
                    continue;
                }
                if depth + 1 >= MAX_DEPTH {
                    on(WalkItem::Skipped(LibrarySkip {
                        path: path.to_string_lossy().into_owned(),
                        reason: "too-deep",
                    }));
                    summary.skipped += 1;
                    continue;
                }
                pending.push((path, linked));
                continue;
            }
            if !is_file {
                continue; // a socket, a device, a pipe: not a document
            }
            let extension = extension_of(&path);
            if !options.extensions.is_empty() && !options.extensions.contains(&extension) {
                continue;
            }
            let Ok(meta) = entry.metadata().or_else(|_| std::fs::metadata(&path)) else {
                on(WalkItem::Skipped(LibrarySkip {
                    path: path.to_string_lossy().into_owned(),
                    reason: "unreadable",
                }));
                summary.skipped += 1;
                continue;
            };
            let size = meta.len();
            if size > MAX_FILE_BYTES {
                on(WalkItem::Skipped(LibrarySkip {
                    path: path.to_string_lossy().into_owned(),
                    reason: "too-big",
                }));
                summary.skipped += 1;
                continue;
            }
            let modified = millis(meta.modified());
            let key = path.to_string_lossy().into_owned();
            let state = match options.known.get(&key) {
                None => FileState::New,
                Some(&(had_size, had_modified)) => {
                    if had_size == size && had_modified == modified {
                        FileState::Same
                    } else {
                        FileState::Changed
                    }
                }
            };
            options.budget.files -= 1;
            summary.files += 1;
            on(WalkItem::File(LibraryFile {
                key,
                name,
                relative: relative_to(root, &path),
                root: root.to_string_lossy().into_owned(),
                size,
                modified,
                extension,
                state,
            }));
        }
        // Each subfolder by its true path, entered once. A real folder is
        // taken before a link to the same one, so the interface shows the
        // name the person would recognise. Pushed in reverse: the stack takes
        // the last first, and a folder should be read in the order it is read
        // on screen.
        pending.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(&b.0)));
        let mut next: Vec<(PathBuf, usize)> = Vec::with_capacity(pending.len());
        for (path, _) in pending {
            let Ok(target) = std::fs::canonicalize(&path) else {
                on(WalkItem::Skipped(LibrarySkip {
                    path: path.to_string_lossy().into_owned(),
                    reason: "unreadable",
                }));
                summary.skipped += 1;
                continue;
            };
            if !inside(&anchor, &target) {
                on(WalkItem::Skipped(LibrarySkip {
                    path: path.to_string_lossy().into_owned(),
                    reason: "link",
                }));
                summary.skipped += 1;
                continue;
            }
            // Already walked, by this path or another that leads to it.
            if seen.insert(target) {
                next.push((path, depth + 1));
            }
        }
        for folder in next.into_iter().rev() {
            stack.push(folder);
        }
        if summary.stopped {
            break;
        }
    }
    if summary.truncated {
        on(WalkItem::Skipped(LibrarySkip {
            path: root.to_string_lossy().into_owned(),
            reason: "too-many",
        }));
        summary.skipped += 1;
    }
    summary.budget_left = (options.budget.files, options.budget.entries);
    summary
}

/* ------------------------------------------------------------------ the scan */

/// One message of a walk under way.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanEvent {
    /// Which walk: the number `library_scan_start` answered with.
    pub scan: u64,
    /// `progress` while it walks, `done` once — and only once.
    pub kind: &'static str,
    /// The folder being read now, as the person sees it.
    pub current: String,
    pub files: Vec<LibraryFile>,
    pub skipped: Vec<LibrarySkip>,
    /// Totals so far, over every folder of this scan.
    pub found: usize,
    pub folders: usize,
    /// On `done` only: indexed files no folder held any more — moved, renamed
    /// or gone. They are reported, never forgotten on their behalf.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub missing: Vec<String>,
    /// On `done`: Stop was pressed, or a bound was reached.
    pub stopped: bool,
    pub truncated: bool,
}

impl ScanEvent {
    fn progress(scan: u64, current: &str) -> Self {
        Self {
            scan,
            kind: "progress",
            current: current.to_string(),
            files: Vec::new(),
            skipped: Vec::new(),
            found: 0,
            folders: 0,
            missing: Vec::new(),
            stopped: false,
            truncated: false,
        }
    }
}

/// The walks under way, so each can be stopped by itself, and the watcher.
#[derive(Default)]
pub struct LibraryState {
    scans: Mutex<HashMap<u64, Arc<AtomicBool>>>,
    next: AtomicU64,
    watch: Mutex<Option<Arc<AtomicBool>>>,
}

impl LibraryState {
    fn begin(&self) -> (u64, Arc<AtomicBool>) {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let stop = Arc::new(AtomicBool::new(false));
        if let Ok(mut scans) = self.scans.lock() {
            scans.insert(id, Arc::clone(&stop));
        }
        (id, stop)
    }

    fn end(&self, id: u64) {
        if let Ok(mut scans) = self.scans.lock() {
            scans.remove(&id);
        }
    }

    fn stop(&self, id: u64) -> bool {
        let Ok(scans) = self.scans.lock() else {
            return false;
        };
        match scans.get(&id) {
            Some(flag) => {
                flag.store(true, Ordering::Relaxed);
                true
            }
            None => false,
        }
    }
}

/// The folders of one scan, each checked against the fs scope before a single
/// entry is read.
/// The same check without any of Tauri in it, so a test can drive it:
/// `allowed` is the fs scope's answer, which the folder picker filled in.
pub fn check_roots(
    roots: &[ScanRoot],
    allowed: impl Fn(&Path) -> bool,
) -> Result<Vec<PathBuf>, String> {
    if roots.is_empty() {
        return Err("E_ARGS: no folder to read".into());
    }
    let mut checked = Vec::with_capacity(roots.len());
    for root in roots {
        let dir = PathBuf::from(&root.path);
        if !dir.is_absolute() || !dir.is_dir() {
            return Err(format!("E_SCOPE: not a folder: {}", root.path));
        }
        if !allowed(&dir) {
            return Err(format!(
                "E_SCOPE: {} was not chosen through the folder picker",
                root.path
            ));
        }
        checked.push(dir);
    }
    Ok(checked)
}

fn checked_roots<R: Runtime>(
    app: &AppHandle<R>,
    roots: &[ScanRoot],
) -> Result<Vec<PathBuf>, String> {
    let scope = app.fs_scope();
    check_roots(roots, |path| scope.is_allowed(path))
}

fn options_for(
    root: &ScanRoot,
    extensions: &HashSet<String>,
    known: &HashMap<String, (u64, i64)>,
    budget: Budget,
) -> WalkOptions {
    WalkOptions {
        recursive: root.recursive,
        exclude: root.exclude.iter().map(PathBuf::from).collect(),
        extensions: extensions.clone(),
        known: known.clone(),
        budget,
    }
}

fn wanted_extensions(named: &[String]) -> HashSet<String> {
    if named.is_empty() {
        return DEFAULT_EXTENSIONS
            .iter()
            .map(|e| (*e).to_string())
            .collect();
    }
    named
        .iter()
        .map(|e| e.trim_start_matches('.').to_ascii_lowercase())
        .filter(|e| !e.is_empty())
        .collect()
}

/// Starts walking the chosen folders on a thread of its own, and answers at
/// once with the number that names this walk. Everything found arrives as
/// `warraq://library-scan` events; `library_scan_stop` ends it early.
#[tauri::command]
pub async fn library_scan_start<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, LibraryState>,
    request: ScanRequest,
) -> Result<u64, String> {
    let dirs = checked_roots(&app, &request.roots)?;
    if request.known.len() > MAX_KNOWN {
        return Err(format!(
            "E_ARGS: the index may name at most {MAX_KNOWN} files in one scan"
        ));
    }
    let extensions = wanted_extensions(&request.extensions);
    let known: HashMap<String, (u64, i64)> = request
        .known
        .iter()
        .map(|file| (file.key.clone(), (file.size, file.modified)))
        .collect();
    // Everything the index holds; each one met is struck off, and what is left
    // at the end has moved or gone.
    let mut unseen: HashSet<String> = known.keys().cloned().collect();
    let (id, stop) = state.begin();
    let roots = request.roots.clone();
    let handle = app.clone();
    // Its own thread: `read_dir` blocks, and a folder of a hundred thousand
    // files would otherwise hold a runtime worker for minutes.
    std::thread::Builder::new()
        .name(format!("warraq-library-scan-{id}"))
        .spawn(move || {
            let mut budget = Budget::default();
            let mut found = 0usize;
            let mut folders = 0usize;
            let mut stopped = false;
            let mut truncated = false;
            let mut files: Vec<LibraryFile> = Vec::with_capacity(BATCH);
            let mut skipped: Vec<LibrarySkip> = Vec::new();
            for (root, dir) in roots.iter().zip(dirs.iter()) {
                if stop.load(Ordering::Relaxed) {
                    stopped = true;
                    break;
                }
                let _ = handle.emit(
                    LIBRARY_SCAN_EVENT,
                    ScanEvent::progress(id, &root.path),
                );
                let mut options = options_for(root, &extensions, &known, budget);
                let summary = walk_folder(dir, &mut options, &stop, &mut |item| {
                    match item {
                        WalkItem::File(file) => {
                            unseen.remove(&file.key);
                            found += 1;
                            files.push(file);
                        }
                        WalkItem::Skipped(skip) => skipped.push(skip),
                    }
                    // Both are flushed on a full batch: a folder of nothing but
                    // unreadable entries would otherwise pile up a million
                    // skips before the `done` event ever came.
                    if files.len() >= BATCH || skipped.len() >= BATCH {
                        let mut event = ScanEvent::progress(id, &root.path);
                        event.files = std::mem::take(&mut files);
                        event.skipped = std::mem::take(&mut skipped);
                        event.found = found;
                        let _ = handle.emit(LIBRARY_SCAN_EVENT, event);
                    }
                });
                budget = options.budget;
                folders += summary.folders;
                stopped |= summary.stopped;
                truncated |= summary.truncated;
                if stopped {
                    break;
                }
            }
            let missing: Vec<String> = if stopped {
                // A walk cut short met only part of the folder: what it did
                // not reach is not gone, and must not be reported as gone.
                Vec::new()
            } else {
                let mut left: Vec<String> = unseen.into_iter().collect();
                left.sort();
                left
            };
            debug_log(format!(
                "library: scan {id} found {found} files in {folders} folders, {} skipped, {} missing{}",
                skipped.len(),
                missing.len(),
                if stopped { ", stopped" } else { "" }
            ));
            let _ = handle.emit(
                LIBRARY_SCAN_EVENT,
                ScanEvent {
                    scan: id,
                    kind: "done",
                    current: String::new(),
                    files,
                    skipped,
                    found,
                    folders,
                    missing,
                    stopped,
                    truncated,
                },
            );
            if let Some(state) = handle.try_state::<LibraryState>() {
                state.end(id);
            }
        })
        .map_err(|e| format!("E_IO: cannot start the scan: {e}"))?;
    Ok(id)
}

/// Stops a walk. `false` when it had already finished — not an error: Stop
/// pressed as the last folder ends is an ordinary thing.
#[tauri::command]
pub fn library_scan_stop(state: State<'_, LibraryState>, scan: u64) -> bool {
    state.stop(scan)
}

/* -------------------------------------------------------------- reading files */

/// A file's size and date without reading it, so the interface can tell that
/// a file moved on between the walk and its turn.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStamp {
    pub exists: bool,
    pub size: u64,
    pub modified: i64,
}

/// The chosen folder `path` sits under: its topmost forebear the scope still
/// allows. The folder picker grants the folder and everything under it, so
/// walking up until the scope says no lands on the folder itself.
fn chosen_folder(path: &Path, allowed: &impl Fn(&Path) -> bool) -> Option<PathBuf> {
    let mut chosen = None;
    let mut cursor = path.parent();
    while let Some(dir) = cursor {
        if allowed(dir) {
            chosen = Some(dir.to_path_buf());
        }
        cursor = dir.parent();
    }
    chosen
}

/// A path is readable when it is inside the fs scope — and, when it is a link,
/// when what it points at is inside the folder the person chose too.
pub fn check_readable(path: &Path, allowed: impl Fn(&Path) -> bool) -> Result<(), String> {
    if !path.is_absolute() {
        return Err(format!(
            "E_SCOPE: path must be absolute: {}",
            path.display()
        ));
    }
    if !allowed(path) {
        return Err(format!(
            "E_SCOPE: {} was not chosen through the folder picker",
            path.display()
        ));
    }
    // `symlink_metadata` does not follow: a link is seen as one. The scope's
    // glob would let a link inside a chosen folder through whatever it points
    // at, so what it points at is checked as well — against the chosen folder
    // as the file system truly names it, since on macOS `/tmp` is
    // `/private/tmp` and a home directory may itself be a link. Comparing a
    // resolved target with an unresolved scope would refuse honest files.
    if let Ok(meta) = std::fs::symlink_metadata(path) {
        if meta.file_type().is_symlink() {
            let target = std::fs::canonicalize(path)
                .map_err(|e| format!("E_IO: {}: {e}", path.display()))?;
            let out = format!(
                "E_SCOPE: {} points outside the chosen folder",
                path.display()
            );
            let anchor =
                chosen_folder(path, &allowed).and_then(|folder| std::fs::canonicalize(folder).ok());
            match anchor {
                Some(anchor) if inside(&anchor, &target) => {}
                _ => return Err(out),
            }
        }
    }
    Ok(())
}

fn readable<R: Runtime>(app: &AppHandle<R>, path: &Path) -> Result<(), String> {
    let scope = app.fs_scope();
    check_readable(path, |path| scope.is_allowed(path))
}

/// One file's bytes, when its turn comes. The size is checked before the read,
/// so a huge file is refused rather than pulled into memory.
#[tauri::command]
pub async fn library_read_file<R: Runtime>(
    app: AppHandle<R>,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    let path = PathBuf::from(path);
    readable(&app, &path)?;
    let meta = std::fs::metadata(&path).map_err(|e| format!("E_IO: {}: {e}", path.display()))?;
    if !meta.is_file() {
        return Err(format!("E_IO: not a file: {}", path.display()));
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(format!(
            "E_TOO_BIG: {} is {} bytes; the Library reads at most {MAX_FILE_BYTES}",
            path.display(),
            meta.len()
        ));
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("E_IO: {}: {e}", path.display()))?;
    debug_log(format!(
        "library: read {} -> {} bytes",
        path.display(),
        bytes.len()
    ));
    Ok(tauri::ipc::Response::new(bytes))
}

/// Whether a file is still there, and whether it is still what the index
/// holds. A file that has gone is reported, not an error.
#[tauri::command]
pub async fn library_stat<R: Runtime>(
    app: AppHandle<R>,
    path: String,
) -> Result<FileStamp, String> {
    let path = PathBuf::from(path);
    readable(&app, &path)?;
    Ok(match std::fs::metadata(&path) {
        Ok(meta) if meta.is_file() => FileStamp {
            exists: true,
            size: meta.len(),
            modified: millis(meta.modified()),
        },
        _ => FileStamp {
            exists: false,
            size: 0,
            modified: 0,
        },
    })
}

/* ------------------------------------------------------------------- the index */

/// An index kept in the app's data directory.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexFile {
    pub name: String,
    pub bytes: u64,
    pub modified: i64,
    pub path: String,
}

/// An index's name is the person's, but it never becomes a path: letters,
/// digits, `.`, `-` and `_`, never leading with a dot, never empty.
pub fn safe_name(name: &str) -> Option<&str> {
    let ok = !name.is_empty()
        && name.len() <= MAX_INDEX_NAME
        && !name.starts_with('.')
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'));
    ok.then_some(name)
}

/// The folder the index lives in: the app's own data directory, made if it is
/// not there. Never a temporary folder — the index holds text out of the
/// person's own documents, and a temporary folder is swept by the system.
pub fn index_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("E_IO: no data directory for this app: {e}"))?;
    let dir = base.join("library");
    std::fs::create_dir_all(&dir).map_err(|e| format!("E_IO: {}: {e}", dir.display()))?;
    Ok(dir)
}

/// Writes `bytes` beside the old index and renames it over it, so a crash
/// halfway leaves the old index whole rather than half a new one.
pub fn write_index(dir: &Path, name: &str, bytes: &[u8]) -> std::io::Result<PathBuf> {
    let name = safe_name(name).ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "not an index name")
    })?;
    let target = dir.join(format!("{name}.wlx"));
    let temp = dir.join(format!("{name}.wlx.writing"));
    {
        let mut file = std::fs::File::create(&temp)?;
        use std::io::Write;
        if let Err(e) = file.write_all(bytes).and_then(|()| file.sync_all()) {
            drop(file);
            let _ = std::fs::remove_file(&temp);
            return Err(e);
        }
    }
    // Windows renames over an existing file with `rename` too, since Rust 1.0
    // uses `MoveFileEx(MOVEFILE_REPLACE_EXISTING)`.
    if let Err(e) = std::fs::rename(&temp, &target) {
        let _ = std::fs::remove_file(&temp);
        return Err(e);
    }
    Ok(target)
}

/// Reads an index back. `None` when there is none yet.
pub fn read_index(dir: &Path, name: &str) -> std::io::Result<Option<Vec<u8>>> {
    let name = safe_name(name).ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "not an index name")
    })?;
    match std::fs::read(dir.join(format!("{name}.wlx"))) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// Deletes an index, and any half-written one beside it. `false` when there
/// was nothing to delete. Nothing is kept back: the file is removed, not
/// emptied or renamed aside.
pub fn delete_index(dir: &Path, name: &str) -> std::io::Result<bool> {
    let name = safe_name(name).ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "not an index name")
    })?;
    let mut gone = false;
    for suffix in [".wlx", ".wlx.writing"] {
        match std::fs::remove_file(dir.join(format!("{name}{suffix}"))) {
            Ok(()) => gone = true,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
    }
    Ok(gone)
}

/// Every index in the folder, newest name first by name order.
pub fn list_indexes(dir: &Path) -> std::io::Result<Vec<IndexFile>> {
    let mut found = Vec::new();
    for entry in std::fs::read_dir(dir)?.flatten() {
        let path = entry.path();
        let Some(name) = path
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| n.strip_suffix(".wlx"))
        else {
            continue;
        };
        if safe_name(name).is_none() {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        found.push(IndexFile {
            name: name.to_string(),
            bytes: meta.len(),
            modified: millis(meta.modified()),
            path: path.to_string_lossy().into_owned(),
        });
    }
    found.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(found)
}

/// Where the indexes live, for the panel to show the person whose data it is.
#[tauri::command]
pub fn library_index_path<R: Runtime>(app: AppHandle<R>) -> Result<String, String> {
    Ok(index_dir(&app)?.to_string_lossy().into_owned())
}

/// Writes the index the core handed over. The body is the index; the header
/// `x-warraq-name` names it (percent-encoded, as the batch's writes are).
#[tauri::command]
pub async fn library_index_save<R: Runtime>(
    app: AppHandle<R>,
    request: tauri::ipc::Request<'_>,
) -> Result<u64, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("E_ARGS: the index travels as a raw body".into());
    };
    let name = request
        .headers()
        .get("x-warraq-name")
        .and_then(|value| value.to_str().ok())
        .and_then(crate::batch::percent_decode)
        .ok_or("E_ARGS: no index name")?;
    let dir = index_dir(&app)?;
    let written = write_index(&dir, &name, bytes).map_err(|e| format!("E_IO: {e}"))?;
    debug_log(format!(
        "library: wrote {} ({} bytes)",
        written.display(),
        bytes.len()
    ));
    Ok(bytes.len() as u64)
}

/// The index's bytes. Rejects with `E_MISSING` when there is none yet, which
/// is how a first run is told apart from an empty index.
#[tauri::command]
pub async fn library_index_load<R: Runtime>(
    app: AppHandle<R>,
    name: String,
) -> Result<tauri::ipc::Response, String> {
    let dir = index_dir(&app)?;
    match read_index(&dir, &name).map_err(|e| format!("E_IO: {e}"))? {
        Some(bytes) => Ok(tauri::ipc::Response::new(bytes)),
        None => Err(format!("E_MISSING: no index named {name}")),
    }
}

/// The indexes on this device, with their size and when they were written.
#[tauri::command]
pub async fn library_index_list<R: Runtime>(app: AppHandle<R>) -> Result<Vec<IndexFile>, String> {
    let dir = index_dir(&app)?;
    list_indexes(&dir).map_err(|e| format!("E_IO: {e}"))
}

/// Deletes an index for good. It is the person's data: nothing of it is kept.
#[tauri::command]
pub async fn library_index_delete<R: Runtime>(
    app: AppHandle<R>,
    name: String,
) -> Result<bool, String> {
    let dir = index_dir(&app)?;
    let gone = delete_index(&dir, &name).map_err(|e| format!("E_IO: {e}"))?;
    debug_log(format!("library: deleted index {name} = {gone}"));
    Ok(gone)
}

/* ----------------------------------------------------------------- watching */

/// What changed under the watched folders since the last look.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchEvent {
    pub added: Vec<LibraryFile>,
    pub changed: Vec<LibraryFile>,
    /// Keys that are no longer there.
    pub removed: Vec<String>,
    /// Set once, on the last event, when the watcher gave up: `too-many`
    /// while it was running the folders grew past what it re-checks. The
    /// interface says so rather than leave a person thinking it still looks.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stopped: Option<&'static str>,
}

impl WatchEvent {
    fn is_empty(&self) -> bool {
        self.added.is_empty() && self.changed.is_empty() && self.removed.is_empty()
    }
}

/// Whether the watcher took the folders, and why not when it did not.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchAnswer {
    pub watching: bool,
    /// How many files are re-checked each time.
    pub files: usize,
    /// How often, in seconds, so the interface can say it plainly.
    pub seconds: u64,
    /// `too-many` when the folders hold more files than the watcher re-checks.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
}

/// One look at the watched folders: every file's size and date, by key.
type Stamps = HashMap<String, LibraryFile>;

/// Takes one look at the folders and returns what it found.
fn look(
    roots: &[(ScanRoot, PathBuf)],
    extensions: &HashSet<String>,
    stop: &AtomicBool,
) -> (Stamps, bool) {
    let mut stamps = Stamps::new();
    let mut budget = Budget {
        files: MAX_WATCHED,
        entries: MAX_ENTRIES,
    };
    let mut truncated = false;
    let known = HashMap::new();
    for (root, dir) in roots {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        let mut options = options_for(root, extensions, &known, budget);
        let summary = walk_folder(dir, &mut options, stop, &mut |item| {
            if let WalkItem::File(file) = item {
                stamps.insert(file.key.clone(), file);
            }
        });
        budget = options.budget;
        truncated |= summary.truncated;
        if summary.stopped {
            break;
        }
    }
    (stamps, truncated)
}

/// What is different between two looks.
pub fn differences(before: &Stamps, after: &Stamps) -> WatchEvent {
    let mut event = WatchEvent::default();
    for (key, file) in after {
        match before.get(key) {
            None => event.added.push(file.clone()),
            Some(had) if had.size != file.size || had.modified != file.modified => {
                event.changed.push(file.clone());
            }
            Some(_) => {}
        }
    }
    for key in before.keys() {
        if !after.contains_key(key) {
            event.removed.push(key.clone());
        }
    }
    event.added.sort_by(|a, b| a.key.cmp(&b.key));
    event.changed.sort_by(|a, b| a.key.cmp(&b.key));
    event.removed.sort();
    event
}

/// Watches the chosen folders while the app runs, by looking again every few
/// seconds and reporting only what moved.
///
/// It is a re-check, not the operating system's own notifications: FSEvents,
/// inotify and ReadDirectoryChangesW each behave differently, each has its own
/// silent failures (a network volume, a full watch table), and none could be
/// exercised on more than this one machine. A re-check behaves the same on all
/// three systems and can be tested. The cost is that a change is noticed within
/// [`WATCH_INTERVAL`] rather than at once, and that folders holding more than
/// [`MAX_WATCHED`] files are refused — plainly, so the interface can say so
/// instead of quietly watching nothing.
#[tauri::command]
pub async fn library_watch_start<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, LibraryState>,
    request: ScanRequest,
) -> Result<WatchAnswer, String> {
    let dirs = checked_roots(&app, &request.roots)?;
    let extensions = wanted_extensions(&request.extensions);
    let roots: Vec<(ScanRoot, PathBuf)> = request.roots.iter().cloned().zip(dirs).collect();
    let never = AtomicBool::new(false);
    let (first, truncated) = look(&roots, &extensions, &never);
    if truncated || first.len() >= MAX_WATCHED {
        stop_watch(&state);
        return Ok(WatchAnswer {
            watching: false,
            files: first.len(),
            seconds: WATCH_INTERVAL.as_secs(),
            reason: Some("too-many"),
        });
    }
    let stop = Arc::new(AtomicBool::new(false));
    stop_watch(&state);
    if let Ok(mut slot) = state.watch.lock() {
        *slot = Some(Arc::clone(&stop));
    }
    let files = first.len();
    let handle = app.clone();
    std::thread::Builder::new()
        .name("warraq-library-watch".into())
        .spawn(move || {
            let mut before = first;
            loop {
                // Slept in short steps so Stop is answered at once rather than
                // after the whole interval.
                for _ in 0..(WATCH_INTERVAL.as_millis() / 250).max(1) {
                    if stop.load(Ordering::Relaxed) {
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(250));
                }
                if stop.load(Ordering::Relaxed) {
                    return;
                }
                let (after, truncated) = look(&roots, &extensions, &stop);
                if stop.load(Ordering::Relaxed) {
                    return;
                }
                if truncated {
                    // The folder grew past what the watcher re-checks: it says
                    // so and stands down rather than report half the truth.
                    let _ = handle.emit(
                        LIBRARY_WATCH_EVENT,
                        WatchEvent {
                            stopped: Some("too-many"),
                            ..WatchEvent::default()
                        },
                    );
                    return;
                }
                let event = differences(&before, &after);
                if !event.is_empty() {
                    debug_log(format!(
                        "library: watch +{} ~{} -{}",
                        event.added.len(),
                        event.changed.len(),
                        event.removed.len()
                    ));
                    let _ = handle.emit(LIBRARY_WATCH_EVENT, event);
                }
                before = after;
            }
        })
        .map_err(|e| format!("E_IO: cannot start the watcher: {e}"))?;
    Ok(WatchAnswer {
        watching: true,
        files,
        seconds: WATCH_INTERVAL.as_secs(),
        reason: None,
    })
}

fn stop_watch(state: &LibraryState) {
    if let Ok(mut slot) = state.watch.lock() {
        if let Some(flag) = slot.take() {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

/// Stops watching. Safe to call when nothing is watched.
#[tauri::command]
pub fn library_watch_stop(state: State<'_, LibraryState>) {
    stop_watch(&state);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    /// A folder of its own under the system's temporary directory, as
    /// `batch.rs` and `tests/print.rs` make one. Only tests use it: the index
    /// itself never goes there.
    fn scratch(name: &str) -> PathBuf {
        static COUNT: AtomicUsize = AtomicUsize::new(0);
        let n = COUNT.fetch_add(1, Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("warraq-library-{name}-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(dir: &Path, relative: &str, bytes: &[u8]) -> PathBuf {
        let path = dir.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, bytes).unwrap();
        path
    }

    fn options(recursive: bool) -> WalkOptions {
        WalkOptions {
            recursive,
            exclude: HashSet::new(),
            extensions: wanted_extensions(&[]),
            known: HashMap::new(),
            budget: Budget::default(),
        }
    }

    /// Walks and collects, as the scan thread does without the events.
    fn collect(
        root: &Path,
        options: &mut WalkOptions,
    ) -> (Vec<LibraryFile>, Vec<LibrarySkip>, WalkSummary) {
        let stop = AtomicBool::new(false);
        let mut files = Vec::new();
        let mut skipped = Vec::new();
        let summary = walk_folder(root, options, &stop, &mut |item| match item {
            WalkItem::File(file) => files.push(file),
            WalkItem::Skipped(skip) => skipped.push(skip),
        });
        (files, skipped, summary)
    }

    #[test]
    fn only_a_folder_the_person_picked_is_walked() {
        let chosen = scratch("scope");
        let elsewhere = scratch("scope-elsewhere");
        write(&chosen, "a.pdf", b"x");
        // What the folder picker leaves behind: the chosen folder and
        // everything under it, and nothing else.
        let picked = chosen.clone();
        let allowed = move |path: &Path| path.starts_with(&picked);

        let root = |path: &Path| ScanRoot {
            path: path.to_string_lossy().into_owned(),
            recursive: true,
            exclude: Vec::new(),
        };
        assert_eq!(
            check_roots(&[root(&chosen)], &allowed).unwrap(),
            vec![chosen.clone()]
        );
        // Nothing chosen at all.
        assert!(check_roots(&[], &allowed)
            .unwrap_err()
            .starts_with("E_ARGS"));
        // A folder the person never picked, even though it exists.
        assert!(check_roots(&[root(&elsewhere)], &allowed)
            .unwrap_err()
            .starts_with("E_SCOPE"));
        // A file, not a folder; and a path that is not absolute.
        assert!(check_roots(&[root(&chosen.join("a.pdf"))], &allowed)
            .unwrap_err()
            .contains("not a folder"));
        assert!(check_roots(
            &[ScanRoot {
                path: "فواتير".into(),
                recursive: true,
                exclude: Vec::new(),
            }],
            &allowed
        )
        .unwrap_err()
        .contains("not a folder"));
        // One folder out of several sinks the whole scan: a person is told,
        // rather than given a list quietly missing a folder they chose.
        assert!(
            check_roots(&[root(&chosen), root(&elsewhere)], &allowed).is_err(),
            "one folder outside the scope refuses the scan"
        );
        std::fs::remove_dir_all(chosen).unwrap();
        std::fs::remove_dir_all(elsewhere).unwrap();
    }

    #[test]
    fn a_file_is_read_only_from_inside_the_chosen_folder() {
        let chosen = scratch("read-scope");
        let elsewhere = scratch("read-scope-elsewhere");
        let inside = write(&chosen, "a.pdf", b"x");
        let outside = write(&elsewhere, "secret.pdf", b"x");
        let picked = chosen.clone();
        let allowed = move |path: &Path| path.starts_with(&picked);

        assert!(check_readable(&inside, &allowed).is_ok());
        assert!(check_readable(&outside, &allowed)
            .unwrap_err()
            .starts_with("E_SCOPE"));
        assert!(check_readable(Path::new("a.pdf"), &allowed)
            .unwrap_err()
            .contains("must be absolute"));

        // A link inside the chosen folder pointing out of it: the scope's own
        // glob says yes to the link's path, so what it points at is checked
        // too. This is the hole the walk refuses and the read must refuse as
        // well, since the panel can ask for any path.
        #[cfg(unix)]
        {
            let escape = chosen.join("escape.pdf");
            std::os::unix::fs::symlink(&outside, &escape).unwrap();
            assert!(allowed(&escape), "the scope alone would let it through");
            assert!(check_readable(&escape, &allowed)
                .unwrap_err()
                .contains("points outside"));
            // A link that stays inside is a file of the chosen folder.
            let within = chosen.join("same.pdf");
            std::os::unix::fs::symlink(&inside, &within).unwrap();
            assert!(check_readable(&within, &allowed).is_ok());
        }
        std::fs::remove_dir_all(chosen).unwrap();
        std::fs::remove_dir_all(elsewhere).unwrap();
    }

    #[test]
    fn a_folder_lists_the_kinds_the_library_reads_and_nothing_hidden() {
        let dir = scratch("walk");
        for file in [
            "b.pdf",
            "a.PDF",
            "notes.txt",
            "photo.JPG",
            "sheet.xlsx",
            "program.exe",
            "archive.zip",
            ".secret.pdf",
            "sub/c.docx",
            "sub/deeper/d.png",
            ".git/e.pdf",
        ] {
            write(&dir, file, b"x");
        }
        let (flat, _, _) = collect(&dir, &mut options(false));
        let names: Vec<&str> = flat.iter().map(|f| f.relative.as_str()).collect();
        assert_eq!(
            names,
            ["a.PDF", "b.pdf", "notes.txt", "photo.JPG", "sheet.xlsx"]
        );

        let (all, _, summary) = collect(&dir, &mut options(true));
        let mut relative: Vec<&str> = all.iter().map(|f| f.relative.as_str()).collect();
        relative.sort_unstable();
        assert_eq!(
            relative,
            [
                "a.PDF",
                "b.pdf",
                "notes.txt",
                "photo.JPG",
                "sheet.xlsx",
                "sub/c.docx",
                "sub/deeper/d.png",
            ]
        );
        assert_eq!(summary.files, 7);
        assert!(!summary.stopped && !summary.truncated);
        // The extension is what the indexer switches on: lower case, no dot.
        let photo = all.iter().find(|f| f.name == "photo.JPG").unwrap();
        assert_eq!(photo.extension, "jpg");
        assert_eq!(photo.size, 1);
        assert_eq!(photo.state, FileState::New);
        assert_eq!(photo.root, dir.to_string_lossy());
        assert!(photo.key.ends_with("photo.JPG"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_subfolder_the_person_unticked_is_not_walked() {
        let dir = scratch("exclude");
        write(&dir, "keep/a.pdf", b"x");
        write(&dir, "leave/b.pdf", b"x");
        write(&dir, "leave/deeper/c.pdf", b"x");
        let mut options = options(true);
        options.exclude.insert(dir.join("leave"));
        let (files, skipped, _) = collect(&dir, &mut options);
        let relative: Vec<&str> = files.iter().map(|f| f.relative.as_str()).collect();
        assert_eq!(relative, ["keep/a.pdf"]);
        // Not chosen is not skipped: nothing to report about it.
        assert!(skipped.is_empty(), "{skipped:?}");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_unreadable_folder_is_reported_and_the_walk_carries_on() {
        let dir = scratch("hostile");
        write(&dir, "good.pdf", b"x");
        let locked = dir.join("locked");
        std::fs::create_dir_all(&locked).unwrap();
        write(&dir, "locked/hidden.pdf", b"x");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        }
        let (files, skipped, summary) = collect(&dir, &mut options(true));
        assert!(
            files.iter().any(|f| f.name == "good.pdf"),
            "the readable file is still listed"
        );
        #[cfg(unix)]
        {
            assert!(
                skipped
                    .iter()
                    .any(|s| s.reason == "unreadable" && s.path.ends_with("locked")),
                "the folder that refused is reported: {skipped:?}"
            );
            assert!(!files.iter().any(|f| f.name == "hidden.pdf"));
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        #[cfg(not(unix))]
        let _ = (&skipped, &summary);
        #[cfg(unix)]
        assert!(!summary.stopped, "a refusal is never fatal");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_link_out_of_the_chosen_folder_is_refused_and_one_that_loops_is_walked_once() {
        let dir = scratch("links");
        let outside = scratch("links-outside");
        write(&outside, "secret.pdf", b"x");
        write(&dir, "inside/real.pdf", b"x");
        std::os::unix::fs::symlink(&outside, dir.join("escape")).unwrap();
        std::os::unix::fs::symlink(outside.join("secret.pdf"), dir.join("escape.pdf")).unwrap();
        std::os::unix::fs::symlink(dir.join("inside"), dir.join("again")).unwrap();
        // A folder that links to its own parent: the classic endless walk.
        std::os::unix::fs::symlink(&dir, dir.join("inside/up")).unwrap();

        let (files, skipped, summary) = collect(&dir, &mut options(true));
        let keys: Vec<&str> = files.iter().map(|f| f.key.as_str()).collect();
        assert!(
            !keys.iter().any(|k| k.contains("secret.pdf")),
            "nothing outside the chosen folder is listed: {keys:?}"
        );
        for escape in ["escape", "escape.pdf"] {
            assert!(
                skipped
                    .iter()
                    .any(|s| s.reason == "link" && s.path.ends_with(escape)),
                "{escape} is reported as a link out: {skipped:?}"
            );
        }
        // `again` points at `inside`, which was walked already: once only.
        assert_eq!(
            files.iter().filter(|f| f.name == "real.pdf").count(),
            1,
            "the same file is not listed twice through a link: {keys:?}"
        );
        assert!(!summary.stopped);
        std::fs::remove_dir_all(dir).unwrap();
        std::fs::remove_dir_all(outside).unwrap();
    }

    /// The size the Library is meant for. It also measures what docs/STATUS.md
    /// records: run it with `--nocapture` to see the number on this machine.
    #[test]
    fn a_folder_of_ten_thousand_files_is_walked_without_reading_one() {
        let dir = scratch("many");
        for bucket in 0..20 {
            for n in 0..500 {
                write(&dir, &format!("d{bucket:02}/f{n:03}.pdf"), b"%PDF-1.7");
            }
        }
        let started = std::time::Instant::now();
        let (files, skipped, summary) = collect(&dir, &mut options(true));
        let took = started.elapsed();
        assert_eq!(files.len(), 10_000);
        assert!(skipped.is_empty(), "{skipped:?}");
        assert!(!summary.truncated && !summary.stopped);
        println!("walked {} files in {took:?}", files.len());
        // Far above what a `stat` each costs, and only here to catch a walk
        // that started reading files or lost itself in a loop.
        assert!(took.as_secs() < 30, "the walk took {took:?}");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_walk_stops_when_it_is_asked_to() {
        let dir = scratch("stop");
        for n in 0..50 {
            write(&dir, &format!("f{n:03}.pdf"), b"x");
        }
        let stop = AtomicBool::new(false);
        let mut options = options(true);
        let mut files = Vec::new();
        let summary = walk_folder(&dir, &mut options, &stop, &mut |item| {
            if let WalkItem::File(file) = item {
                files.push(file);
                if files.len() == 5 {
                    stop.store(true, Ordering::Relaxed);
                }
            }
        });
        assert_eq!(files.len(), 5, "nothing is read after Stop");
        assert!(summary.stopped);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_walk_is_bounded_in_files_depth_and_size() {
        let dir = scratch("bounds");
        for n in 0..12 {
            write(&dir, &format!("f{n:02}.pdf"), b"x");
        }
        let mut few = options(true);
        few.budget = Budget {
            files: 4,
            entries: MAX_ENTRIES,
        };
        let (files, skipped, summary) = collect(&dir, &mut few);
        assert_eq!(files.len(), 4);
        assert!(summary.truncated, "a short list says it is short");
        assert!(skipped.iter().any(|s| s.reason == "too-many"));

        // Deeper than MAX_DEPTH: reported, not walked, and not a hang.
        let deep = scratch("deep");
        let mut path = deep.clone();
        for n in 0..(MAX_DEPTH + 3) {
            path = path.join(format!("d{n}"));
        }
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(path.join("buried.pdf"), b"x").unwrap();
        let (files, skipped, _) = collect(&deep, &mut options(true));
        assert!(files.is_empty(), "{files:?}");
        assert!(
            skipped.iter().any(|s| s.reason == "too-deep"),
            "{skipped:?}"
        );
        std::fs::remove_dir_all(dir).unwrap();
        std::fs::remove_dir_all(deep).unwrap();
    }

    #[test]
    fn a_file_that_changed_while_the_app_was_closed_is_noticed() {
        let dir = scratch("changes");
        write(&dir, "same.pdf", b"one");
        write(&dir, "grown.pdf", b"one");
        write(&dir, "fresh.pdf", b"one");
        let (first, _, _) = collect(&dir, &mut options(true));
        assert!(first.iter().all(|f| f.state == FileState::New));

        // What the index would hold after that run — minus the file that is
        // about to be added, and plus one that is about to go away.
        let mut known: HashMap<String, (u64, i64)> = first
            .iter()
            .filter(|f| f.name != "fresh.pdf")
            .map(|f| (f.key.clone(), (f.size, f.modified)))
            .collect();
        let gone = dir.join("gone.pdf").to_string_lossy().into_owned();
        known.insert(gone.clone(), (10, 1));

        // The app is closed; the file is edited. Its date may land in the same
        // millisecond on a coarse file system, so its size moves as well.
        std::fs::write(dir.join("grown.pdf"), b"one and more").unwrap();

        let mut options = options(true);
        options.known = known.clone();
        let (second, _, _) = collect(&dir, &mut options);
        let state = |name: &str| {
            second
                .iter()
                .find(|f| f.name == name)
                .unwrap_or_else(|| panic!("{name} missing"))
                .state
        };
        assert_eq!(state("same.pdf"), FileState::Same, "not read again");
        assert_eq!(state("grown.pdf"), FileState::Changed);
        assert_eq!(state("fresh.pdf"), FileState::New);

        // What the scan reports as missing: everything known that no folder held.
        let seen: HashSet<&str> = second.iter().map(|f| f.key.as_str()).collect();
        let missing: Vec<&String> = known
            .keys()
            .filter(|k| !seen.contains(k.as_str()))
            .collect();
        assert_eq!(missing, [&gone]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_watcher_reports_what_was_added_changed_and_taken_away() {
        let dir = scratch("watch");
        write(&dir, "a.pdf", b"one");
        write(&dir, "b.pdf", b"one");
        let root = ScanRoot {
            path: dir.to_string_lossy().into_owned(),
            recursive: true,
            exclude: Vec::new(),
        };
        let roots = vec![(root, dir.clone())];
        let extensions = wanted_extensions(&[]);
        let never = AtomicBool::new(false);
        let (before, truncated) = look(&roots, &extensions, &never);
        assert!(!truncated);
        assert_eq!(before.len(), 2);
        assert!(
            differences(&before, &before).is_empty(),
            "a quiet folder says nothing"
        );

        std::fs::write(dir.join("c.pdf"), b"new").unwrap();
        std::fs::write(dir.join("a.pdf"), b"one and more").unwrap();
        std::fs::remove_file(dir.join("b.pdf")).unwrap();
        let (after, _) = look(&roots, &extensions, &never);
        let event = differences(&before, &after);
        assert_eq!(
            event
                .added
                .iter()
                .map(|f| f.name.as_str())
                .collect::<Vec<_>>(),
            ["c.pdf"]
        );
        assert_eq!(
            event
                .changed
                .iter()
                .map(|f| f.name.as_str())
                .collect::<Vec<_>>(),
            ["a.pdf"]
        );
        assert_eq!(event.removed.len(), 1);
        assert!(event.removed[0].ends_with("b.pdf"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_index_is_written_whole_read_back_and_really_deleted() {
        let dir = scratch("index");
        assert_eq!(
            read_index(&dir, "main").unwrap(),
            None,
            "a first run has none"
        );
        assert!(list_indexes(&dir).unwrap().is_empty());

        let first = vec![b'W', b'L', b'X', 1];
        let path = write_index(&dir, "main", &first).unwrap();
        assert_eq!(path, dir.join("main.wlx"));
        assert_eq!(
            read_index(&dir, "main").unwrap().as_deref(),
            Some(&first[..])
        );

        // Written again, over the first: one file, no leftovers.
        let second = vec![0u8; 4096];
        write_index(&dir, "main", &second).unwrap();
        assert_eq!(read_index(&dir, "main").unwrap().unwrap().len(), 4096);
        assert!(
            !dir.join("main.wlx.writing").exists(),
            "nothing half-written is left"
        );

        let listed = list_indexes(&dir).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "main");
        assert_eq!(listed[0].bytes, 4096);

        // Half a write left behind by a crash goes with the index.
        std::fs::write(dir.join("main.wlx.writing"), b"half").unwrap();
        assert!(delete_index(&dir, "main").unwrap());
        assert!(!dir.join("main.wlx").exists());
        assert!(!dir.join("main.wlx.writing").exists());
        assert_eq!(read_index(&dir, "main").unwrap(), None);
        assert!(
            !delete_index(&dir, "main").unwrap(),
            "deleting twice is not an error"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_index_name_is_never_a_path() {
        for bad in [
            "../escape",
            "a/b",
            "a\\b",
            "/etc/passwd",
            ".hidden",
            "",
            "with space",
            "نص",
            "c:main",
        ] {
            assert_eq!(safe_name(bad), None, "{bad:?}");
        }
        assert_eq!(safe_name("main"), Some("main"));
        assert_eq!(safe_name("library-2026_09.v1"), Some("library-2026_09.v1"));
        assert_eq!(
            safe_name(&"a".repeat(MAX_INDEX_NAME)),
            Some("a".repeat(MAX_INDEX_NAME).as_str())
        );
        assert_eq!(safe_name(&"a".repeat(MAX_INDEX_NAME + 1)), None);

        let dir = scratch("names");
        assert!(write_index(&dir, "../escape", b"x").is_err());
        assert!(!dir.parent().unwrap().join("escape.wlx").exists());
        assert!(delete_index(&dir, "../escape").is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_extensions_asked_for_win_and_a_dot_is_forgiven() {
        let named = wanted_extensions(&[".PDF".into(), "docx".into(), "".into()]);
        assert_eq!(named.len(), 2);
        assert!(named.contains("pdf") && named.contains("docx"));
        assert!(wanted_extensions(&[]).contains("pdf"));
        assert!(wanted_extensions(&[]).contains("heic"));
    }

    #[test]
    fn dates_come_back_in_milliseconds() {
        assert_eq!(millis(Ok(UNIX_EPOCH)), 0);
        assert_eq!(millis(Ok(UNIX_EPOCH + Duration::from_millis(1_500))), 1_500);
        assert_eq!(
            millis(Ok(UNIX_EPOCH - Duration::from_millis(1_500))),
            -1_500
        );
        assert_eq!(
            millis(Err(std::io::Error::other("no date"))),
            0,
            "a file system without dates is not an error"
        );
    }
}
