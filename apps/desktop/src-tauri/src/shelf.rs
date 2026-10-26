//! ZOOD's shelf: files dropped on the drop zone at the top of the screen
//! (`sort.rs`) stay there, the way a notch shelf holds them (the owner's ask
//! after "Stow, in my notch"; NotchDrop, github.com/Lakr233/NotchDrop, MIT,
//! and Notchy's shelf were studied for the idea; none of their code is used).
//!
//! Dropped files wait on the shelf until the person drags them out again,
//! takes them off, or clears it, and they are still there after a restart.
//! While files wait, the zone rests as a small tab at the top middle of the
//! screen that says how many; the pointer on it opens the shelf, and the
//! shelf closes back into the tab a moment after the pointer leaves. On the
//! shelf, ZOOD's quick tools run at once on the files picked (convert,
//! merge, compress …), and what they make lands on the shelf too, ready to
//! be dragged into any folder, email or chat. Nothing on the shelf is moved
//! or changed: the shelf only names files where they are.
//!
//! The zone's window may only act on files that are on the shelf: every
//! command takes paths and checks them against the list here.
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindow};
use tauri_plugin_fs::FsExt;

use crate::ring::log;
use crate::sort::{self, ZONE_LABEL};

/// The shelf's files changed: the zone reads them again.
pub const CHANGED_EVENT: &str = "shelf://changed";
const FILE: &str = "shelf.json";
/// More than a shelf can show; the oldest go first.
const MAX_ITEMS: usize = 60;
/// How often the pointer is looked at while files wait.
const HOVER_TICK: Duration = Duration::from_millis(70);
/// How long the pointer is away before the open shelf closes into its tab.
const CLOSE_AFTER: Duration = Duration::from_millis(900);
/// Room round the tab and the shelf that still counts as on them, in points.
const TAB_SLACK: f64 = 8.0;
const SHELF_SLACK: f64 = 14.0;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
struct Held {
    path: PathBuf,
    /// Made by a tool run on the shelf.
    #[serde(default)]
    made: bool,
}

static HELD: Mutex<Vec<Held>> = Mutex::new(Vec::new());
static LOADED: AtomicBool = AtomicBool::new(false);
/// The shelf stays open: a tool runs, or a menu of it is open.
static HOLD: AtomicBool = AtomicBool::new(false);
static WATCHING: AtomicBool = AtomicBool::new(false);
/// Files are being dragged off the shelf: that drag is not one for the zone.
static OUTBOUND: AtomicBool = AtomicBool::new(false);

/// A file on the shelf, as the zone shows it.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShelfItem {
    pub name: String,
    pub path: String,
    pub size: u64,
    /// pdf, images, documents, … as the Sort window names kinds (`sort::kind_name`).
    pub kind: &'static str,
    pub made: bool,
}

fn file<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join(FILE))
}

fn save<R: Runtime>(app: &AppHandle<R>, held: &[Held]) {
    if let (Some(path), Ok(text)) = (file(app), serde_json::to_string(held)) {
        let _ = std::fs::write(path, text);
    }
}

/// The shelf as it was left, read once: files gone since are dropped, and
/// the rest are put back in the file scope (each was dropped by the person).
fn load<R: Runtime>(app: &AppHandle<R>) {
    if LOADED.swap(true, Ordering::Relaxed) {
        return;
    }
    let kept: Vec<Held> = file(app)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();
    let kept = present(kept);
    let scope = app.fs_scope();
    for held in &kept {
        let _ = scope.allow_file(&held.path);
    }
    if let Ok(mut all) = HELD.lock() {
        *all = kept;
    }
}

/// Only files that are still there, each once.
fn present(held: Vec<Held>) -> Vec<Held> {
    let mut out: Vec<Held> = Vec::new();
    for item in held {
        if item.path.is_file() && !out.iter().any(|o| o.path == item.path) {
            out.push(item);
        }
    }
    out
}

/// Adds files to `held`, each once, newest last, at most [`MAX_ITEMS`].
pub fn add_to(held: &mut Vec<(PathBuf, bool)>, files: &[PathBuf], made: bool) {
    for path in files {
        held.retain(|(p, _)| p != path);
        held.push((path.clone(), made));
    }
    let over = held.len().saturating_sub(MAX_ITEMS);
    held.drain(..over);
}

fn change<R: Runtime>(app: &AppHandle<R>, edit: impl FnOnce(&mut Vec<Held>)) -> usize {
    load(app);
    let count = match HELD.lock() {
        Ok(mut all) => {
            edit(&mut all);
            let fresh = present(std::mem::take(&mut *all));
            *all = fresh;
            save(app, &all);
            all.len()
        }
        Err(_) => 0,
    };
    let _ = app.emit_to(ZONE_LABEL, CHANGED_EVENT, count);
    count
}

/// Files let go on the zone: onto the shelf (and into the file scope).
pub fn add<R: Runtime>(app: &AppHandle<R>, files: &[PathBuf], made: bool) -> usize {
    let scope = app.fs_scope();
    for path in files {
        let _ = scope.allow_file(path);
    }
    change(app, |all| {
        let mut pairs: Vec<(PathBuf, bool)> = all.drain(..).map(|h| (h.path, h.made)).collect();
        add_to(&mut pairs, files, made);
        *all = pairs
            .into_iter()
            .map(|(path, made)| Held { path, made })
            .collect();
    })
}

/// How many files wait on the shelf.
pub fn count<R: Runtime>(app: &AppHandle<R>) -> usize {
    load(app);
    HELD.lock().map(|all| all.len()).unwrap_or(0)
}

/// Of `paths`, the ones on the shelf now, as they are kept there.
fn on_shelf(paths: &[String]) -> Vec<PathBuf> {
    let Ok(all) = HELD.lock() else {
        return Vec::new();
    };
    paths
        .iter()
        .map(PathBuf::from)
        .filter(|path| all.iter().any(|held| &held.path == path))
        .collect()
}

/// A drag off the shelf is under way (the watchers see it as any drag of files).
pub fn is_outbound() -> bool {
    OUTBOUND.load(Ordering::Relaxed)
}

/// The button came up: any drag off the shelf is over.
pub fn drag_ended() {
    OUTBOUND.store(false, Ordering::Relaxed);
}

pub fn is_holding() -> bool {
    HOLD.load(Ordering::Relaxed)
}

/// Is the pointer on `rect` (left, top, width, height), with `slack` round it?
pub fn is_on(at: (f64, f64), rect: (f64, f64, f64, f64), slack: f64) -> bool {
    let (left, top, width, height) = rect;
    at.0 >= left - slack
        && at.0 <= left + width + slack
        && at.1 >= top - slack
        && at.1 <= top + height + slack
}

/// While files wait: the pointer on the tab opens the shelf, and away from
/// the open shelf for a moment closes it again. One watcher at a time; it
/// ends when the shelf is empty or the zone is turned off.
pub fn watch<R: Runtime>(app: &AppHandle<R>) {
    if WATCHING.swap(true, Ordering::Relaxed) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let mut away_since: Option<Instant> = None;
        loop {
            std::thread::sleep(HOVER_TICK);
            if !sort::zone_on() || count(&app) == 0 {
                break;
            }
            // A drag of files is the zone's own business (`sort::dragging`).
            if sort::is_dragging() {
                away_since = None;
                continue;
            }
            let Some((look, rect, scale)) = sort::rest_place() else {
                continue;
            };
            let at = crate::ask::eye::pointer();
            match look {
                "tab" if is_on(at, rect, TAB_SLACK * scale) => {
                    away_since = None;
                    sort::show_look(&app, "shelf");
                }
                "shelf" if is_holding() || is_on(at, rect, SHELF_SLACK * scale) => {
                    away_since = None;
                }
                "shelf" => {
                    let since = *away_since.get_or_insert_with(Instant::now);
                    if since.elapsed() >= CLOSE_AFTER {
                        away_since = None;
                        sort::show_look(&app, "tab");
                    }
                }
                _ => away_since = None,
            }
        }
        WATCHING.store(false, Ordering::Relaxed);
    });
}

fn item_of(held: &Held) -> ShelfItem {
    ShelfItem {
        name: held
            .path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        path: held.path.to_string_lossy().into_owned(),
        size: std::fs::metadata(&held.path).map(|m| m.len()).unwrap_or(0),
        kind: sort::kind_name(&held.path),
        made: held.made,
    }
}

/// The files on the shelf, oldest first; files gone from the disk are taken off.
#[tauri::command]
pub fn shelf_items<R: Runtime>(app: AppHandle<R>) -> Vec<ShelfItem> {
    load(&app);
    let Ok(mut all) = HELD.lock() else {
        return Vec::new();
    };
    let before = all.len();
    let fresh = present(std::mem::take(&mut *all));
    *all = fresh;
    if all.len() != before {
        save(&app, &all);
    }
    all.iter().map(item_of).collect()
}

/// Takes files off the shelf (they stay where they are on the disk).
#[tauri::command]
pub fn shelf_remove<R: Runtime>(app: AppHandle<R>, paths: Vec<String>) {
    let gone = on_shelf(&paths);
    if change(&app, |all| all.retain(|h| !gone.contains(&h.path))) == 0 {
        sort::rest(&app);
    }
}

/// Takes every file off the shelf; the zone goes.
#[tauri::command]
pub fn shelf_clear<R: Runtime>(app: AppHandle<R>) {
    change(&app, Vec::clear);
    HOLD.store(false, Ordering::Relaxed);
    sort::rest(&app);
}

/// Files a tool on the shelf made: onto the shelf, marked new. Only files
/// this run may already read (the batch's writer put them beside files of
/// the shelf, or in the folder Settings chose).
#[tauri::command]
pub fn shelf_made<R: Runtime>(app: AppHandle<R>, paths: Vec<String>) -> usize {
    let scope = app.fs_scope();
    let made: Vec<PathBuf> = paths
        .iter()
        .map(PathBuf::from)
        .filter(|p| p.is_absolute() && p.is_file() && scope.is_allowed(p))
        .take(MAX_ITEMS)
        .collect();
    if made.is_empty() {
        return count(&app);
    }
    log(&format!("{} new files on the shelf", made.len()));
    add(&app, &made, true)
}

/// Keeps the shelf open (a tool runs, a menu is open) or lets it close again.
#[tauri::command]
pub fn shelf_hold(on: bool) {
    HOLD.store(on, Ordering::Relaxed);
}

/// Closes the open shelf into its tab.
#[tauri::command]
pub fn shelf_collapse<R: Runtime>(app: AppHandle<R>) {
    HOLD.store(false, Ordering::Relaxed);
    sort::rest(&app);
}

/// Drags files off the shelf into another app: a folder, an email, a chat.
/// The files are offered as a copy; they stay on the shelf.
#[tauri::command]
pub fn shelf_drag<R: Runtime>(app: AppHandle<R>, window: WebviewWindow<R>, paths: Vec<String>) {
    let files = on_shelf(&paths);
    if files.is_empty() {
        return;
    }
    log(&format!("{} files dragged off the shelf", files.len()));
    HOLD.store(true, Ordering::Relaxed);
    OUTBOUND.store(true, Ordering::Relaxed);
    let done = app.clone();
    let _ = app.run_on_main_thread(move || {
        start_drag(&window, files);
        HOLD.store(false, Ordering::Relaxed);
        let _ = done.emit_to(ZONE_LABEL, CHANGED_EVENT, count(&done));
    });
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn start_drag<R: Runtime>(window: &WebviewWindow<R>, files: Vec<PathBuf>) {
    let icon = drag::Image::Raw(include_bytes!("../icons/64x64.png").to_vec());
    let result = drag::start_drag(
        window,
        drag::DragItem::Files(files),
        icon,
        |result, _| {
            OUTBOUND.store(false, Ordering::Relaxed);
            log(&format!("drag off the shelf: {result:?}"));
        },
        drag::Options::default(),
    );
    if let Err(e) = result {
        OUTBOUND.store(false, Ordering::Relaxed);
        log(&format!("cannot drag off the shelf: {e}"));
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn start_drag<R: Runtime>(_window: &WebviewWindow<R>, _files: Vec<PathBuf>) {}

/// Opens a file of the shelf in ZOOD's editor.
#[tauri::command]
pub fn shelf_open<R: Runtime>(app: AppHandle<R>, path: String) {
    if let Some(file) = on_shelf(&[path]).into_iter().next() {
        crate::open_in_editor_at(&app, Some(file), None);
    }
}

/// Shows a file of the shelf in File Explorer or Finder, picked.
#[tauri::command]
pub fn shelf_reveal(path: String) -> Result<(), String> {
    let file = on_shelf(&[path])
        .into_iter()
        .next()
        .ok_or_else(|| "E_SCOPE: not on the shelf".to_string())?;
    reveal(&file)
}

#[cfg(target_os = "windows")]
fn reveal(file: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    // Explorer reads its own command line: the path is quoted whole.
    std::process::Command::new("explorer.exe")
        .raw_arg(format!("/select,\"{}\"", file.display()))
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("E_IO: {e}"))
}

#[cfg(target_os = "macos")]
fn reveal(file: &Path) -> Result<(), String> {
    std::process::Command::new("open")
        .arg("-R")
        .arg(file)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("E_IO: {e}"))
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn reveal(file: &Path) -> Result<(), String> {
    let folder = file.parent().ok_or("E_IO: no folder")?;
    std::process::Command::new("xdg-open")
        .arg(folder)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("E_IO: {e}"))
}

/// Organize with ZOOD: the files go to a Sort window, which suggests merging,
/// splitting, folders and names (`sort.rs`).
#[tauri::command]
pub fn shelf_sort<R: Runtime>(app: AppHandle<R>, paths: Vec<String>) {
    let files = on_shelf(&paths);
    if !files.is_empty() {
        sort::open(&app, files);
    }
}

/// A tool that needs the person (a password, which pages, the mark's text):
/// its quick window opens, with the pages to see (`quick.rs`).
#[tauri::command]
pub fn shelf_quick<R: Runtime>(app: AppHandle<R>, tool: String, paths: Vec<String>) {
    let files = on_shelf(&paths);
    let Some(tool) = crate::quick::TOOLS.iter().find(|t| **t == tool) else {
        return;
    };
    if !files.is_empty() {
        crate::quick::request(
            &app,
            crate::quick::QuickRequest {
                tool: Some(tool.to_string()),
                files,
            },
        );
    }
}

/// A phone is connected to the remote: the shelf offers "To phone".
#[tauri::command]
pub fn shelf_has_phone<R: Runtime>(app: AppHandle<R>) -> bool {
    crate::remote::has_phone(&app)
}

/// Sends files of the shelf to the connected phone, off the main thread.
#[tauri::command]
pub fn shelf_phone<R: Runtime>(app: AppHandle<R>, paths: Vec<String>) {
    let files = on_shelf(&paths);
    if files.is_empty() {
        return;
    }
    std::thread::spawn(move || {
        let sent = crate::remote::give_paths(&app, &files, None);
        log(&format!(
            "{sent} of {} shelf files to the phone",
            files.len()
        ));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn files_go_on_the_shelf_once_newest_last_and_not_too_many() {
        let a = PathBuf::from("/x/a.pdf");
        let b = PathBuf::from("/x/b.pdf");
        let mut held = vec![(a.clone(), false), (b.clone(), false)];
        add_to(&mut held, std::slice::from_ref(&a), true);
        assert_eq!(held, vec![(b.clone(), false), (a.clone(), true)]);
        let many: Vec<PathBuf> = (0..MAX_ITEMS + 5)
            .map(|k| PathBuf::from(format!("/x/{k}.pdf")))
            .collect();
        add_to(&mut held, &many, false);
        assert_eq!(held.len(), MAX_ITEMS);
        assert_eq!(held.last().unwrap().0, many.last().unwrap().clone());
        assert!(!held.iter().any(|(p, _)| p == &b), "the oldest went first");
    }

    #[test]
    fn the_pointer_is_on_the_tab_with_a_little_room() {
        let tab = (855.0, 0.0, 210.0, 34.0);
        assert!(is_on((960.0, 10.0), tab, 8.0));
        assert!(is_on((850.0, 40.0), tab, 8.0));
        assert!(!is_on((960.0, 60.0), tab, 8.0));
        assert!(!is_on((700.0, 10.0), tab, 8.0));
    }

    #[test]
    fn files_gone_from_the_disk_leave_the_shelf() {
        let dir = std::env::temp_dir().join(format!("zood-shelf-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let here = dir.join("here.pdf");
        std::fs::write(&here, "x").unwrap();
        let kept = present(vec![
            Held {
                path: here.clone(),
                made: false,
            },
            Held {
                path: dir.join("gone.pdf"),
                made: false,
            },
            Held {
                path: here.clone(),
                made: true,
            },
        ]);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].path, here);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
