//! Sort with ZOOD: files thrown on ZOOD are looked at and sorted.
//!
//! While ZOOD runs (kept ready in the background, `ring.rs`), dragging files
//! out of File Explorer or Finder, with no key held, towards the top of the
//! screen brings ZOOD's drop zone down from there, where Ask ZOOD's island
//! lives: a small pill at first, opening into "Drop here to sort" when the
//! pointer comes near. Files let go there (or on the ZOOD bubble,
//! `presence.rs`, or on the ring's Sort place) open a Sort window
//! (`index.html?sort=1`) that reads them and suggests merging, splitting,
//! folders and better names (`packages/ui/src/sort/`).
//!
//! The window only ever names files by their place in the session's list:
//! the host keeps the paths. Files are moved or renamed, never overwritten,
//! and only inside the person's own user folder; the files ZOOD makes
//! (merged or split PDFs) are written by the window beside the others and
//! told to the host (`sort_made`), and they are the only files Undo removes.
//! Every move is written to a journal as it is made, so Undo puts each file
//! back, even after a crash.
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, Manager, Runtime, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_fs::FsExt;

use crate::ask::tidy::{self, Kind};
use crate::ring::log;

/// The drop zone's window.
pub const ZONE_LABEL: &str = "drop-zone";
const WINDOW_PREFIX: &str = "sort-";
/// The drop zone's look, for its window (`packages/ui/src/sort/DropZone.tsx`).
pub const ZONE_EVENT: &str = "drop://state";
/// Words for a Sort window, from Ask ZOOD (`sort_voice`).
pub const SAY_EVENT: &str = "sort://say";
/// The pill first seen at the top, and the zone it opens into, in points.
const PEEK: (f64, f64) = (196.0, 58.0);
const OPEN: (f64, f64) = (400.0, 168.0);
/// How near the top, and how far either side of the middle, opens the zone, in points.
const NEAR_TOP: f64 = 240.0;
/// How near the top the pointer comes before the zone peeks at all: a drag
/// lower down (files moved between folders, a rubber-band selection) shows nothing.
const PEEK_TOP: f64 = 460.0;
const NEAR_SIDE: f64 = 340.0;
/// After the button is let go, how long a drop on the zone has to arrive.
const DROP_GRACE: Duration = Duration::from_millis(700);
/// More than anyone drops at once; a bound on one session.
const MAX_FILES: usize = 300;
/// A PDF is read for its words only up to this size, and this many pages.
const READ_PDF_BYTES: u64 = 40 << 20;
const READ_PAGES: usize = 40;
const PAGE_CHARS: usize = 600;
const JOURNAL_PREFIX: &str = "sort-undo-";

/// The drop zone is on (Settings › Quick tools, `ring.rs` keeps it).
static ZONE_ON: AtomicBool = AtomicBool::new(true);
/// The zone is on the screen for this drag, and open (near).
static UP: AtomicBool = AtomicBool::new(false);
static NEAR: AtomicBool = AtomicBool::new(false);
static DROPPED: AtomicBool = AtomicBool::new(false);
/// A screen: left, top, width, height in the watcher's units, and its scale.
type Screen = (f64, f64, f64, f64, f64);
/// The screen the zone is on.
static SCREEN: Mutex<Option<Screen>> = Mutex::new(None);
/// A Sort window asked Ask ZOOD to listen: the next words are for it.
static VOICE_FOR: Mutex<Option<String>> = Mutex::new(None);

pub fn set_zone(on: bool) {
    ZONE_ON.store(on, Ordering::Relaxed);
}

pub fn zone_on() -> bool {
    ZONE_ON.load(Ordering::Relaxed)
}

/// Is the pointer near enough the top middle of `screen` to open the zone?
pub fn is_near(at: (f64, f64), screen: (f64, f64, f64, f64), scale: f64) -> bool {
    let (left, top, width, _) = screen;
    let middle = left + width / 2.0;
    at.1 - top <= NEAR_TOP * scale && (at.0 - middle).abs() <= NEAR_SIDE * scale
}

/// Has the pointer come near enough the top for the zone to peek?
pub fn may_peek(y: f64, top: f64, scale: f64) -> bool {
    y - top <= PEEK_TOP * scale
}

/// The zone's place: in the middle of the screen's top edge.
pub fn zone_place(screen: (f64, f64, f64, f64), size: (f64, f64)) -> (f64, f64) {
    let (left, top, width, _) = screen;
    ((left + (width - size.0) / 2.0).round(), top)
}

fn screen_at<R: Runtime>(app: &AppHandle<R>, x: f64, y: f64) -> Option<(f64, f64, f64, f64, f64)> {
    // Physical pixels on Windows, points on macOS: as the watchers give them.
    let windows = cfg!(target_os = "windows");
    let screens = app.available_monitors().unwrap_or_default();
    screens.iter().find_map(|m| {
        let unit = if windows { 1.0 } else { m.scale_factor() };
        let left = f64::from(m.position().x) / unit;
        let top = f64::from(m.position().y) / unit;
        let width = f64::from(m.size().width) / unit;
        let height = f64::from(m.size().height) / unit;
        let inside = x >= left && x < left + width && y >= top && y < top + height;
        // Sizes on Windows are physical too: scaled by the screen's own factor.
        let scale = if windows { m.scale_factor() } else { 1.0 };
        inside.then_some((left, top, width, height, scale))
    })
}

fn zone_window<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    if let Some(window) = app.get_webview_window(ZONE_LABEL) {
        return Some(window);
    }
    let builder = WebviewWindowBuilder::new(
        app,
        ZONE_LABEL,
        WebviewUrl::App("index.html?dropzone=1".into()),
    )
    .title("ZOOD PDF")
    .inner_size(PEEK.0, PEEK.1)
    .decorations(false)
    .resizable(false)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .focused(false)
    .focusable(false)
    .transparent(true);
    // Made ready out of sight, so it takes drops on Windows (`parked.rs`).
    let window = crate::parked::hidden(builder)
        .build()
        .map_err(|e| log(&format!("cannot make the drop zone: {e}")))
        .ok()?;
    crate::parked::made(&window);
    crate::ask::notch::above_menu_bar(&window);
    Some(window)
}

/// Made a few seconds after start, as the ring is, so the first drag finds it ready.
pub fn prepare<R: Runtime>(app: &AppHandle<R>) {
    if zone_on() {
        let _ = zone_window(app);
    }
}

#[derive(Clone, Serialize)]
struct ZoneState {
    /// "peek", "open" or "hidden".
    look: &'static str,
}

fn place_zone<R: Runtime>(
    window: &WebviewWindow<R>,
    screen: (f64, f64, f64, f64, f64),
    size: (f64, f64),
) {
    let (left, top, width, height, scale) = screen;
    let size = (size.0 * scale, size.1 * scale);
    let (x, y) = zone_place((left, top, width, height), size);
    if cfg!(target_os = "windows") {
        let _ = window.set_size(tauri::PhysicalSize::new(size.0, size.1));
        let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
    } else {
        let _ = window.set_size(tauri::LogicalSize::new(size.0, size.1));
        let _ = window.set_position(tauri::LogicalPosition::new(x, y));
    }
}

/// Files are being dragged, with no key held, and the pointer is here
/// (the watcher's units): the zone comes down, and opens when near.
pub fn dragging<R: Runtime>(app: &AppHandle<R>, x: f64, y: f64) {
    if !zone_on() {
        return;
    }
    if !UP.load(Ordering::Relaxed) {
        let Some(screen) = screen_at(app, x, y) else {
            return;
        };
        if !may_peek(y, screen.1, screen.4) {
            return;
        }
        let Some(window) = zone_window(app) else {
            return;
        };
        DROPPED.store(false, Ordering::Relaxed);
        NEAR.store(false, Ordering::Relaxed);
        if let Ok(mut kept) = SCREEN.lock() {
            *kept = Some(screen);
        }
        place_zone(&window, screen, PEEK);
        let _ = window.emit_to(ZONE_LABEL, ZONE_EVENT, ZoneState { look: "peek" });
        let _ = window.show();
        UP.store(true, Ordering::Relaxed);
        log("files dragged: the drop zone peeks");
        return;
    }
    let Some(screen) = SCREEN.lock().ok().and_then(|s| *s) else {
        return;
    };
    let (left, top, width, height, scale) = screen;
    let near = is_near((x, y), (left, top, width, height), scale);
    if near != NEAR.swap(near, Ordering::Relaxed) {
        if let Some(window) = app.get_webview_window(ZONE_LABEL) {
            place_zone(&window, screen, if near { OPEN } else { PEEK });
            let look = if near { "open" } else { "peek" };
            let _ = window.emit_to(ZONE_LABEL, ZONE_EVENT, ZoneState { look });
        }
    }
}

pub fn hide_zone<R: Runtime>(app: &AppHandle<R>) {
    UP.store(false, Ordering::Relaxed);
    NEAR.store(false, Ordering::Relaxed);
    if let Some(window) = app.get_webview_window(ZONE_LABEL) {
        let _ = window.emit_to(ZONE_LABEL, ZONE_EVENT, ZoneState { look: "hidden" });
        crate::parked::away(&window);
    }
}

/// The button was let go: the zone goes unless files were dropped on it.
pub fn released<R: Runtime>(app: &AppHandle<R>) {
    if !UP.load(Ordering::Relaxed) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(DROP_GRACE);
        if !DROPPED.load(Ordering::Relaxed) {
            hide_zone(&app);
        }
    });
}

/// The files of a drop, as a Sort session takes them: files only, each once,
/// and a Windows shortcut as the file it points at (`lnk.rs`).
pub fn files_of(paths: &[PathBuf]) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = Vec::new();
    for path in paths {
        let Some(path) = crate::lnk::file_of(path) else {
            continue;
        };
        if !files.contains(&path) {
            files.push(path);
            if files.len() >= MAX_FILES {
                break;
            }
        }
    }
    files
}

/// The zone's own drag and drop (`lib.rs` passes it here).
pub fn on_drag<R: Runtime>(window: &tauri::Window<R>, event: &tauri::DragDropEvent) {
    match event {
        tauri::DragDropEvent::Enter { .. } | tauri::DragDropEvent::Over { .. } => {
            if !NEAR.swap(true, Ordering::Relaxed) {
                if let (Some(web), Some(screen)) = (
                    window.app_handle().get_webview_window(ZONE_LABEL),
                    SCREEN.lock().ok().and_then(|s| *s),
                ) {
                    place_zone(&web, screen, OPEN);
                }
                let _ = window.emit_to(ZONE_LABEL, ZONE_EVENT, ZoneState { look: "open" });
            }
            let _ = window.emit_to(ZONE_LABEL, ZONE_EVENT, ZoneState { look: "over" });
        }
        tauri::DragDropEvent::Leave => {
            let _ = window.emit_to(ZONE_LABEL, ZONE_EVENT, ZoneState { look: "open" });
        }
        tauri::DragDropEvent::Drop { paths, .. } => {
            DROPPED.store(true, Ordering::Relaxed);
            let files = files_of(paths);
            log(&format!("{} files dropped on the drop zone", files.len()));
            let app = window.app_handle().clone();
            hide_zone(&app);
            open(&app, files);
        }
        _ => {}
    }
}

/// One Sort window's files.
#[derive(Clone, Debug, Default)]
struct Session {
    /// Where each file is now; the window names them by their place here.
    files: Vec<PathBuf>,
    /// The folder the files are sorted in: the one most of them came from.
    folder: PathBuf,
    /// Files this session made (merged, split): Undo removes them.
    made: Vec<PathBuf>,
}

#[derive(Default)]
pub struct SortState {
    sessions: Mutex<HashMap<String, Session>>,
    next: AtomicU32,
}

/// The folder most of the files are in (the first of those, on a tie).
pub fn main_folder(files: &[PathBuf]) -> Option<PathBuf> {
    let mut counts: Vec<(PathBuf, usize)> = Vec::new();
    for parent in files.iter().filter_map(|f| f.parent()) {
        match counts.iter_mut().find(|(p, _)| p == parent) {
            Some((_, n)) => *n += 1,
            None => counts.push((parent.to_path_buf(), 1)),
        }
    }
    let most = counts.iter().map(|(_, n)| *n).max()?;
    counts.into_iter().find(|(_, n)| *n == most).map(|(p, _)| p)
}

/// Opens a Sort window on `files` (a thread of its own: building a window
/// from an event handler of the main thread can deadlock on Windows).
pub fn open<R: Runtime>(app: &AppHandle<R>, files: Vec<PathBuf>) {
    let Some(folder) = main_folder(&files) else {
        return;
    };
    let scope = app.fs_scope();
    for file in &files {
        let _ = scope.allow_file(file);
    }
    let _ = scope.allow_directory(&folder, false);
    let app = app.clone();
    std::thread::spawn(move || {
        let Some(state) = app.try_state::<SortState>() else {
            return;
        };
        let label = format!(
            "{WINDOW_PREFIX}{}",
            state.next.fetch_add(1, Ordering::Relaxed)
        );
        if let Ok(old) = journal_path(&app, &label) {
            let _ = std::fs::remove_file(old);
        }
        if let Ok(mut sessions) = state.sessions.lock() {
            sessions.insert(
                label.clone(),
                Session {
                    files,
                    folder,
                    made: Vec::new(),
                },
            );
        }
        match WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html?sort=1".into()))
            .title("رتّب مع زود — ZOOD PDF")
            .inner_size(760.0, 660.0)
            .min_inner_size(440.0, 480.0)
            .center()
            .always_on_top(true)
            .focused(true)
            .build()
        {
            Ok(window) => {
                let _ = window.set_focus();
            }
            Err(e) => log(&format!("cannot open the Sort window: {e}")),
        }
    });
}

pub fn is_sort_window(label: &str) -> bool {
    label.starts_with(WINDOW_PREFIX)
}

/// A file as the Sort window sees it.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SortFile {
    pub index: usize,
    pub name: String,
    pub path: String,
    pub size: u64,
    /// Last changed, on this computer's calendar: "2026-10-21".
    pub day: String,
    /// pdf, images, documents, spreadsheets, presentations, archives, audio, video, installers, other.
    pub kind: &'static str,
    /// Made by this session (a merge or a split).
    pub made: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SortJob {
    pub folder: String,
    pub folder_name: String,
    pub files: Vec<SortFile>,
}

pub fn kind_name(path: &Path) -> &'static str {
    match tidy::kind_of(path) {
        Some(Kind::Pdf) => "pdf",
        Some(Kind::Images) => "images",
        Some(Kind::Documents) => "documents",
        Some(Kind::Spreadsheets) => "spreadsheets",
        Some(Kind::Presentations) => "presentations",
        Some(Kind::Archives) => "archives",
        Some(Kind::Audio) => "audio",
        Some(Kind::Video) => "video",
        Some(Kind::Installers) => "installers",
        None => "other",
    }
}

fn job_of(session: &Session) -> SortJob {
    let files = session
        .files
        .iter()
        .enumerate()
        .map(|(index, path)| {
            let meta = std::fs::metadata(path).ok();
            SortFile {
                index,
                name: path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                path: path.to_string_lossy().into_owned(),
                size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
                day: meta.as_ref().map(tidy::day_of).unwrap_or_default(),
                kind: kind_name(path),
                made: session.made.contains(path),
            }
        })
        .collect();
    SortJob {
        folder: session.folder.to_string_lossy().into_owned(),
        folder_name: session
            .folder
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        files,
    }
}

fn session_of<R: Runtime>(window: &WebviewWindow<R>, state: &SortState) -> Result<Session, String> {
    state
        .sessions
        .lock()
        .map_err(|_| "E_SORT: busy".to_string())?
        .get(window.label())
        .cloned()
        .ok_or_else(|| "E_SORT: this window has no files".to_string())
}

/// This Sort window's files, where they are now.
#[tauri::command]
pub fn sort_job<R: Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, SortState>,
) -> Option<SortJob> {
    session_of(&window, &state).ok().map(|s| job_of(&s))
}

/// What a file says, for the suggestions: a PDF's pages and the first words of each.
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileLook {
    pub pages: usize,
    /// The words of the first pages (a PDF) or the start of a text file.
    pub texts: Vec<String>,
    pub title: String,
    /// A PDF that needs a password to read.
    pub locked: bool,
}

fn first_chars(text: &str, most: usize) -> String {
    text.chars().take(most).collect()
}

pub fn look_at(path: &Path) -> FileLook {
    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(u64::MAX);
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    match ext.as_str() {
        "pdf" if size <= READ_PDF_BYTES => {
            let Ok(bytes) = std::fs::read(path) else {
                return FileLook::default();
            };
            match warraq_core::Document::open(bytes, None) {
                Ok(doc) => {
                    let pages = doc.page_count();
                    let texts = (0..pages.min(READ_PAGES))
                        .map(|page| {
                            first_chars(&doc.extract_text(page).unwrap_or_default(), PAGE_CHARS)
                        })
                        .collect();
                    FileLook {
                        pages,
                        texts,
                        title: doc.metadata().title.unwrap_or_default(),
                        locked: false,
                    }
                }
                Err(e) => FileLook {
                    locked: e.to_string().contains("E_PASSWORD"),
                    ..FileLook::default()
                },
            }
        }
        "txt" | "md" | "csv" if size <= 1 << 20 => FileLook {
            texts: vec![first_chars(
                &String::from_utf8_lossy(&std::fs::read(path).unwrap_or_default()),
                PAGE_CHARS,
            )],
            ..FileLook::default()
        },
        _ => FileLook::default(),
    }
}

/// Reads one file of this window's session, off the main thread.
#[tauri::command]
pub async fn sort_look<R: Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, SortState>,
    index: usize,
) -> Result<FileLook, String> {
    let session = session_of(&window, &state)?;
    let path = session
        .files
        .get(index)
        .cloned()
        .ok_or_else(|| "E_SORT: no such file".to_string())?;
    tauri::async_runtime::spawn_blocking(move || look_at(&path))
        .await
        .map_err(|e| format!("E_IO: {e}"))
}

/// Files the window wrote for this session (a merge, a split): they join it,
/// so they can go into a folder too, and Undo removes them. Only new files
/// in the session's folder are taken.
#[tauri::command]
pub fn sort_made<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    state: State<'_, SortState>,
    paths: Vec<String>,
) -> Result<SortJob, String> {
    let journal_file = journal_path(&app, window.label())?;
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "E_SORT: busy".to_string())?;
    let session = sessions
        .get_mut(window.label())
        .ok_or_else(|| "E_SORT: this window has no files".to_string())?;
    for path in paths.into_iter().map(PathBuf::from).take(MAX_FILES) {
        let fresh = path.is_file()
            && path.parent() == Some(session.folder.as_path())
            && !session.files.contains(&path);
        if fresh && session.files.len() < MAX_FILES * 2 {
            session.files.push(path.clone());
            session.made.push(path);
        }
    }
    let mut journal = read_journal(&journal_file);
    for file in &session.made {
        if !journal.made.contains(file) {
            journal.made.push(file.clone());
        }
    }
    write_journal(&journal_file, &journal)?;
    Ok(job_of(session))
}

/// One step of a sort: a file into a folder of the session's folder, and/or a new name.
#[derive(Deserialize, Clone, Debug)]
pub struct SortStep {
    pub file: usize,
    /// A folder inside the session's folder, by name; none: the folder itself.
    pub folder: Option<String>,
    /// The new name without its extension, which never changes; none: the same.
    pub name: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Journal {
    moves: Vec<tidy::Move>,
    /// Folders the sort made, removed again on undo when empty.
    dirs: Vec<PathBuf>,
    /// Files the sort made, where they were made: removed on undo, once moved back.
    made: Vec<PathBuf>,
}

/// A name the window gave, made a safe file name: no path parts, not too long.
pub fn safe_name(name: &str) -> Option<String> {
    let clean: String = name
        .chars()
        .filter(|c| !c.is_control() && !"/\\:*?\"<>|".contains(*c))
        .take(90)
        .collect();
    let clean = clean.trim().trim_matches('.').trim().to_string();
    (!clean.is_empty()).then_some(clean)
}

/// Where a step puts its file.
pub fn target_of(folder: &Path, from: &Path, step: &SortStep) -> Option<PathBuf> {
    let current = from.file_name()?.to_string_lossy().into_owned();
    let file_name = match step.name.as_deref().and_then(safe_name) {
        Some(stem) => match from.extension() {
            Some(ext) => format!("{stem}.{}", ext.to_string_lossy()),
            None => stem,
        },
        None => current,
    };
    let dir = match step.folder.as_deref() {
        Some(name) => folder.join(tidy::safe_folder(name)),
        None => folder.to_path_buf(),
    };
    Some(dir.join(file_name))
}

/// Moves and renames, each written down before the next; returns the moves made.
pub fn apply(
    folder: &Path,
    files: &mut [PathBuf],
    steps: &[SortStep],
    journal: &mut Journal,
    write: &dyn Fn(&Journal) -> Result<(), String>,
) -> Result<usize, String> {
    let mut taken: HashSet<PathBuf> = HashSet::new();
    let mut done = 0;
    for step in steps {
        let Some(from) = files.get(step.file).cloned() else {
            continue;
        };
        let Ok(meta) = std::fs::symlink_metadata(&from) else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let Some(target) = target_of(folder, &from, step) else {
            continue;
        };
        if target == from {
            continue;
        }
        let target = tidy::free_name(&target, &taken);
        // Checked again: inside the folder, one level down at most, nothing overwritten.
        let inside = target.parent() == Some(folder)
            || target.parent().and_then(Path::parent) == Some(folder);
        if !inside || target.exists() {
            continue;
        }
        if let Some(parent) = target.parent() {
            if !parent.exists() {
                std::fs::create_dir(parent).map_err(|e| format!("E_IO: {e}"))?;
                journal.dirs.push(parent.to_path_buf());
            }
        }
        // A file in use (Windows), or on another drive, is skipped, not the whole sort.
        if std::fs::rename(&from, &target).is_ok() {
            taken.insert(target.clone());
            journal.moves.push(tidy::Move {
                from: from.clone(),
                to: target.clone(),
            });
            files[step.file] = target;
            done += 1;
            write(journal)?;
        }
    }
    Ok(done)
}

/// Each Sort window's journal; a new window with the same label starts a new one.
fn journal_path<R: Runtime>(app: &AppHandle<R>, label: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("E_IO: no data directory: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("E_IO: {e}"))?;
    Ok(dir.join(format!("{JOURNAL_PREFIX}{label}.json")))
}

fn write_journal(file: &Path, journal: &Journal) -> Result<(), String> {
    let text = serde_json::to_string(journal).map_err(|e| e.to_string())?;
    std::fs::write(file, text).map_err(|e| format!("E_IO: {e}"))
}

fn read_journal(file: &Path) -> Journal {
    std::fs::read_to_string(file)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// Carries out the window's steps on the session's files.
#[tauri::command]
pub async fn sort_apply<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    state: State<'_, SortState>,
    steps: Vec<SortStep>,
) -> Result<SortJob, String> {
    let session = session_of(&window, &state)?;
    tidy::may_tidy(&app, &session.folder)?;
    for (index, file) in session.files.iter().enumerate() {
        if steps.iter().any(|s| s.file == index) {
            if let Some(parent) = file.parent() {
                tidy::may_tidy(&app, parent)?;
            }
        }
    }
    let label = window.label().to_string();
    let journal_file = journal_path(&app, &label)?;
    let mut files = session.files.clone();
    let folder = session.folder.clone();
    let (files, _) = tauri::async_runtime::spawn_blocking(move || {
        let mut journal = read_journal(&journal_file);
        let write = |journal: &Journal| write_journal(&journal_file, journal);
        let done = apply(&folder, &mut files, &steps, &mut journal, &write)?;
        Ok::<_, String>((files, done))
    })
    .await
    .map_err(|e| format!("E_IO: {e}"))??;
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "E_SORT: busy".to_string())?;
    let session = sessions
        .get_mut(&label)
        .ok_or_else(|| "E_SORT: this window has no files".to_string())?;
    for made in session.made.iter_mut() {
        if let Some(at) = session.files.iter().position(|f| f == made) {
            *made = files[at].clone();
        }
    }
    session.files = files;
    Ok(job_of(session))
}

pub fn undo(file: &Path) -> Result<usize, String> {
    let journal = read_journal(file);
    let mut back = 0;
    for step in journal.moves.iter().rev() {
        if step.to.exists() && !step.from.exists() && std::fs::rename(&step.to, &step.from).is_ok()
        {
            back += 1;
        }
    }
    for made in &journal.made {
        // Only what this sort made: a file ZOOD wrote, never one of the person's.
        let _ = std::fs::remove_file(made);
    }
    for dir in journal.dirs.iter().rev() {
        let _ = std::fs::remove_dir(dir);
    }
    let _ = std::fs::remove_file(file);
    Ok(back)
}

/// Puts every file of this window's sort back, and removes the files it made.
#[tauri::command]
pub async fn sort_undo<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    state: State<'_, SortState>,
) -> Result<SortJob, String> {
    let file = journal_path(&app, window.label())?;
    let journal = read_journal(&file);
    tauri::async_runtime::spawn_blocking(move || undo(&file))
        .await
        .map_err(|e| format!("E_IO: {e}"))??;
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "E_SORT: busy".to_string())?;
    let session = sessions
        .get_mut(window.label())
        .ok_or_else(|| "E_SORT: this window has no files".to_string())?;
    // Each file where it was before its first move; the made ones gone.
    for file in session.files.iter_mut() {
        let mut at = file.clone();
        for step in journal.moves.iter().rev() {
            if step.to == at {
                at = step.from.clone();
            }
        }
        *file = at;
    }
    let made = session.made.clone();
    session.files.retain(|f| !made.contains(f));
    session.made.clear();
    Ok(job_of(session))
}

/// Closes the Sort window asking; its session is forgotten, and its journal
/// stays only until a window of the same name opens again.
#[tauri::command]
pub fn sort_close<R: Runtime>(window: WebviewWindow<R>, state: State<'_, SortState>) {
    if let Ok(mut sessions) = state.sessions.lock() {
        sessions.remove(window.label());
    }
    let _ = window.close();
}

/// The window's Speak button: Ask ZOOD listens, and what is said comes here.
#[tauri::command]
pub fn sort_listen<R: Runtime>(app: AppHandle<R>, window: WebviewWindow<R>) {
    if let Ok(mut voice) = VOICE_FOR.lock() {
        *voice = Some(window.label().to_string());
    }
    crate::ask::summon(&app);
}

#[derive(Clone, Serialize)]
struct Said {
    words: String,
}

/// From Ask ZOOD: words for a Sort window — the one whose Speak button was
/// pressed, or the one in front. False when there is none, and Ask ZOOD
/// answers as always.
#[tauri::command]
pub fn sort_voice<R: Runtime>(app: AppHandle<R>, words: String) -> bool {
    let asked = VOICE_FOR.lock().ok().and_then(|mut v| v.take());
    let windows = app.webview_windows();
    let target = asked
        .filter(|label| windows.contains_key(label))
        .or_else(|| {
            windows
                .iter()
                .find(|(label, w)| is_sort_window(label) && w.is_focused().unwrap_or(false))
                .map(|(label, _)| label.clone())
        });
    let Some(label) = target else {
        return false;
    };
    if let Some(window) = windows.get(&label) {
        let _ = window.emit_to(label.as_str(), SAY_EVENT, Said { words });
        let _ = window.set_focus();
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("zood-sort-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_zone_opens_near_the_top_middle_only() {
        let screen = (0.0, 0.0, 1920.0, 1080.0);
        assert!(is_near((960.0, 20.0), screen, 1.0));
        assert!(is_near((700.0, 200.0), screen, 1.0));
        assert!(!is_near((960.0, 600.0), screen, 1.0));
        assert!(!is_near((100.0, 10.0), screen, 1.0));
        // A screen at 150% on Windows: the same distance in points.
        assert!(is_near((960.0, 330.0), screen, 1.5));
        // A second screen to the left.
        assert!(is_near((-960.0, 30.0), (-1920.0, 0.0, 1920.0, 1080.0), 1.0));
        assert_eq!(zone_place(screen, PEEK), (862.0, 0.0));
        // It peeks only once a drag heads for the top.
        assert!(may_peek(300.0, 0.0, 1.0));
        assert!(!may_peek(700.0, 0.0, 1.0));
        assert!(may_peek(600.0, 0.0, 1.5));
    }

    #[test]
    fn the_folder_is_where_most_files_are() {
        let files = [
            PathBuf::from("/home/me/Desktop/a.pdf"),
            PathBuf::from("/home/me/Downloads/b.pdf"),
            PathBuf::from("/home/me/Downloads/c.pdf"),
        ];
        assert_eq!(
            main_folder(&files),
            Some(PathBuf::from("/home/me/Downloads"))
        );
        assert_eq!(
            main_folder(&files[..1]),
            Some(PathBuf::from("/home/me/Desktop"))
        );
        assert_eq!(main_folder(&[]), None);
    }

    #[test]
    fn names_from_the_window_cannot_climb_or_change_the_kind() {
        let folder = Path::new("/home/me/Downloads");
        let from = folder.join("IMG_1.jpg");
        let step = |folder: Option<&str>, name: Option<&str>| SortStep {
            file: 0,
            folder: folder.map(String::from),
            name: name.map(String::from),
        };
        assert_eq!(
            target_of(folder, &from, &step(Some("../../etc"), Some("../x"))),
            Some(folder.join("etc").join("x.jpg"))
        );
        assert_eq!(
            target_of(folder, &from, &step(None, Some("فاتورة جرير 2026-10-21"))),
            Some(folder.join("فاتورة جرير 2026-10-21.jpg"))
        );
        assert_eq!(
            target_of(folder, &from, &step(None, Some(" .. "))),
            Some(from.clone())
        );
        assert_eq!(safe_name("a/b:c"), Some("abc".into()));
    }

    #[test]
    fn a_sort_is_done_and_undone_on_disk() {
        let folder = scratch("apply");
        let mut files: Vec<PathBuf> = ["IMG_1.jpg", "bill.pdf", "merged.pdf"]
            .iter()
            .map(|n| {
                std::fs::write(folder.join(n), n).unwrap();
                folder.join(n)
            })
            .collect();
        // Already there: never overwritten.
        std::fs::create_dir(folder.join("Invoices")).unwrap();
        std::fs::write(folder.join("Invoices").join("bill.pdf"), "old").unwrap();
        let journal_file = folder.join("journal.json");
        let mut journal = Journal {
            made: vec![folder.join("merged.pdf")],
            ..Journal::default()
        };
        let write = |j: &Journal| {
            std::fs::write(&journal_file, serde_json::to_string(j).unwrap())
                .map_err(|e| e.to_string())
        };
        let steps = vec![
            SortStep {
                file: 0,
                folder: Some("Pictures".into()),
                name: Some("Receipt".into()),
            },
            SortStep {
                file: 1,
                folder: Some("Invoices".into()),
                name: None,
            },
            SortStep {
                file: 2,
                folder: Some("Invoices".into()),
                name: None,
            },
            SortStep {
                file: 9,
                folder: None,
                name: None,
            },
        ];
        assert_eq!(
            apply(&folder, &mut files, &steps, &mut journal, &write).unwrap(),
            3
        );
        assert!(folder.join("Pictures").join("Receipt.jpg").exists());
        assert_eq!(
            std::fs::read_to_string(folder.join("Invoices").join("bill.pdf")).unwrap(),
            "old"
        );
        assert!(folder.join("Invoices").join("bill (2).pdf").exists());
        assert_eq!(files[0], folder.join("Pictures").join("Receipt.jpg"));
        // Undo moves a made file back to where it was made, then removes it there.
        assert_eq!(journal.made, vec![folder.join("merged.pdf")]);
        assert_eq!(undo(&journal_file).unwrap(), 3);
        assert!(folder.join("IMG_1.jpg").exists());
        assert!(folder.join("bill.pdf").exists());
        assert!(
            !folder.join("merged.pdf").exists(),
            "what the sort made is gone"
        );
        assert!(!folder.join("Pictures").exists());
        assert!(
            folder.join("Invoices").join("bill.pdf").exists(),
            "the person's own file stays"
        );
        let _ = std::fs::remove_dir_all(&folder);
    }

    #[test]
    fn a_drop_takes_files_once_and_no_folders() {
        let folder = scratch("drop");
        std::fs::write(folder.join("a.pdf"), "a").unwrap();
        let files = files_of(&[folder.join("a.pdf"), folder.clone(), folder.join("a.pdf")]);
        assert_eq!(files, vec![folder.join("a.pdf")]);
        let _ = std::fs::remove_dir_all(&folder);
    }

    #[test]
    fn a_text_file_is_read_and_a_picture_is_not() {
        let folder = scratch("look");
        std::fs::write(folder.join("note.txt"), "فاتورة رقم 7").unwrap();
        std::fs::write(folder.join("p.png"), "x").unwrap();
        assert_eq!(
            look_at(&folder.join("note.txt")).texts,
            vec!["فاتورة رقم 7".to_string()]
        );
        assert_eq!(look_at(&folder.join("p.png")), FileLook::default());
        let _ = std::fs::remove_dir_all(&folder);
    }
}
