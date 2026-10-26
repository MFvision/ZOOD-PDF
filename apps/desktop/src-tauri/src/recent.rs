//! Where the home screen's recent files are, so choosing one opens it again
//! instead of asking for it (the owner's backlog, item 4).
//!
//! The interface keeps the recent list by name (`packages/ui/src/state/recent.ts`);
//! the host keeps, beside it, the path each name was last opened from, in a
//! small file in the app's own data directory — on this device only, like
//! the list. A path is kept only while it is in the file scope, that is, only
//! a file the person chose in the open panel, dropped on the window or opened
//! from Explorer: the webview cannot make the host remember, and so later
//! read, a file nobody chose. Taking a file off the list, or clearing it,
//! forgets its path here too.
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_fs::FsExt;

/// The interface lists ten (`RECENT_LIMIT`); a few more cost nothing and
/// cover a name taken off its list a moment before.
const LIMIT: usize = 20;
/// A file name, not a document: anything longer is not one the list holds.
const MAX_NAME: usize = 1024;
const MAX_PATH: usize = 4096;
const FILE_NAME: &str = "recent-paths.json";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecentPath {
    pub name: String,
    pub path: String,
}

/// The list, newest first, and the lock that keeps two writes from crossing.
#[derive(Default)]
pub struct RecentState(pub Mutex<()>);

/// `name` now comes from `path`, at the head of the list.
pub fn remember(list: &mut Vec<RecentPath>, name: &str, path: &str) {
    list.retain(|entry| entry.name != name);
    list.insert(
        0,
        RecentPath {
            name: name.to_string(),
            path: path.to_string(),
        },
    );
    list.truncate(LIMIT);
}

/// Forgets `name`, or every path when `None`.
pub fn forget(list: &mut Vec<RecentPath>, name: Option<&str>) {
    match name {
        Some(name) => list.retain(|entry| entry.name != name),
        None => list.clear(),
    }
}

/// Where `name` was last opened from, if that is known.
pub fn lookup<'a>(list: &'a [RecentPath], name: &str) -> Option<&'a str> {
    list.iter()
        .find(|entry| entry.name == name)
        .map(|entry| entry.path.as_str())
}

/// Reads the list back; a missing or unreadable file is an empty list (the
/// interface then asks for the file, as it always did).
pub fn load(file: &Path) -> Vec<RecentPath> {
    std::fs::read(file)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Vec<RecentPath>>(&bytes).ok())
        .map(|mut list| {
            list.retain(|entry| entry.name.len() <= MAX_NAME && entry.path.len() <= MAX_PATH);
            list.truncate(LIMIT);
            list
        })
        .unwrap_or_default()
}

/// Writes the list beside the old one and renames it over it, so a crash
/// halfway leaves the old list whole.
pub fn store(file: &Path, list: &[RecentPath]) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(list).map_err(std::io::Error::other)?;
    let temp = file.with_extension("json.writing");
    std::fs::write(&temp, bytes)?;
    std::fs::rename(&temp, file).inspect_err(|_| {
        let _ = std::fs::remove_file(&temp);
    })
}

fn list_file<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("E_IO: no data directory for this app: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("E_IO: {}: {e}", dir.display()))?;
    Ok(dir.join(FILE_NAME))
}

/// The files whose paths are kept, newest first, that are still there: the
/// tray's Recent files.
pub fn known<R: Runtime>(app: &AppHandle<R>) -> Vec<RecentPath> {
    let Ok(file) = list_file(app) else {
        return Vec::new();
    };
    load(&file)
        .into_iter()
        .filter(|entry| Path::new(&entry.path).is_file())
        .collect()
}

fn checked_name(name: &str) -> Result<&str, String> {
    if name.is_empty() || name.len() > MAX_NAME {
        return Err("E_ARGS: not a file name".to_string());
    }
    Ok(name)
}

/// Keeps where `name` was opened from. Refused for a path the person did not
/// choose (outside the file scope).
// Off the main thread on Windows, where it draws every window (`stall.rs`).
#[cfg_attr(windows, tauri::command(async))]
#[cfg_attr(not(windows), tauri::command)]
pub fn recent_remember<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, RecentState>,
    name: String,
    path: String,
) -> Result<(), String> {
    let name = checked_name(&name)?;
    let file = PathBuf::from(&path);
    if path.len() > MAX_PATH || !file.is_absolute() || !app.fs_scope().is_allowed(&file) {
        return Err(format!("E_SCOPE: {path} was not chosen by the person"));
    }
    let _guard = state.0.lock().map_err(|_| "E_STATE: lock poisoned")?;
    let target = list_file(&app)?;
    let mut list = load(&target);
    remember(&mut list, name, &path);
    store(&target, &list).map_err(|e| format!("E_IO: {}: {e}", target.display()))?;
    // The tray's Recent files (`presence.rs`).
    crate::presence::refresh_tray(&app);
    Ok(())
}

/// The path `name` was last opened from, put back in the file scope so the
/// interface can read it as it reads any chosen file. `None` when the path is
/// not known, or the file is no longer there (moved, renamed or deleted):
/// the interface then asks for it.
// Off the main thread on Windows, where it draws every window (`stall.rs`).
#[cfg_attr(windows, tauri::command(async))]
#[cfg_attr(not(windows), tauri::command)]
pub fn recent_path<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, RecentState>,
    name: String,
) -> Result<Option<String>, String> {
    let name = checked_name(&name)?;
    let _guard = state.0.lock().map_err(|_| "E_STATE: lock poisoned")?;
    let list = load(&list_file(&app)?);
    let Some(path) = lookup(&list, name) else {
        return Ok(None);
    };
    let file = PathBuf::from(path);
    if !file.is_absolute() || !file.is_file() {
        return Ok(None);
    }
    app.fs_scope()
        .allow_file(&file)
        .map_err(|e| format!("E_SCOPE: {e}"))?;
    Ok(Some(path.to_string()))
}

/// Forgets where `name` was, or every path when `name` is absent.
// Off the main thread on Windows, where it draws every window (`stall.rs`).
#[cfg_attr(windows, tauri::command(async))]
#[cfg_attr(not(windows), tauri::command)]
pub fn recent_forget<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, RecentState>,
    name: Option<String>,
) -> Result<(), String> {
    let _guard = state.0.lock().map_err(|_| "E_STATE: lock poisoned")?;
    let target = list_file(&app)?;
    let mut list = load(&target);
    forget(&mut list, name.as_deref());
    store(&target, &list).map_err(|e| format!("E_IO: {}: {e}", target.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_newest_comes_first_and_a_name_is_kept_once() {
        let mut list = Vec::new();
        remember(&mut list, "a.pdf", "/docs/a.pdf");
        remember(&mut list, "b.pdf", "/docs/b.pdf");
        remember(&mut list, "a.pdf", "/elsewhere/a.pdf");
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].name, "a.pdf");
        assert_eq!(lookup(&list, "a.pdf"), Some("/elsewhere/a.pdf"));
        assert_eq!(lookup(&list, "b.pdf"), Some("/docs/b.pdf"));
        assert_eq!(lookup(&list, "c.pdf"), None);
    }

    #[test]
    fn the_list_is_bounded() {
        let mut list = Vec::new();
        for i in 0..LIMIT + 5 {
            remember(&mut list, &format!("{i}.pdf"), &format!("/d/{i}.pdf"));
        }
        assert_eq!(list.len(), LIMIT);
        assert_eq!(lookup(&list, "0.pdf"), None);
    }

    #[test]
    fn forgetting_one_or_all() {
        let mut list = Vec::new();
        remember(&mut list, "a.pdf", "/a.pdf");
        remember(&mut list, "b.pdf", "/b.pdf");
        forget(&mut list, Some("a.pdf"));
        assert_eq!(lookup(&list, "a.pdf"), None);
        assert_eq!(lookup(&list, "b.pdf"), Some("/b.pdf"));
        forget(&mut list, None);
        assert!(list.is_empty());
    }

    #[test]
    fn a_stored_list_reads_back_and_a_broken_one_is_empty() {
        let dir = std::env::temp_dir().join(format!("warraq-recent-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join(FILE_NAME);
        let mut list = Vec::new();
        remember(&mut list, "تقرير.pdf", "C:\\Users\\م\\تقرير.pdf");
        store(&file, &list).unwrap();
        assert_eq!(load(&file), list);
        std::fs::write(&file, b"not json").unwrap();
        assert!(load(&file).is_empty());
        assert!(load(&dir.join("missing.json")).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
