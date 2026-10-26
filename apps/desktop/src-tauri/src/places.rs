//! The Library's chosen places — the folders, and the files chosen one by one,
//! that the person added to it — kept so they can still be read after the app
//! restarts (the owner's report of 2026-10-26: a folder or file added from
//! Folders could not be opened again).
//!
//! The file scope is the app's memory of what the person chose, and it starts
//! empty every launch: without this, every folder the Library holds was out
//! of reach after a restart. Like `recent.rs`, a place is kept only while it
//! is in the scope — only a folder or file the person chose in the system's
//! panel — so the webview cannot make the host remember, and later read,
//! anything nobody chose. They are kept in a small file in the app's own data
//! directory, on this device only, and put back in the scope when the app
//! starts. A folder the person forgets in the Library is forgotten here too.
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_fs::FsExt;

/// Folders and single files together; the oldest go first past it.
const LIMIT: usize = 500;
const MAX_PATH: usize = 4096;
const FILE_NAME: &str = "library-places.json";

/// The lock that keeps two writes from crossing.
#[derive(Default)]
pub struct PlacesState(pub Mutex<()>);

/// `paths` join the list, newest first, each kept once; the list stays bounded.
pub fn remember(list: &mut Vec<String>, paths: &[String]) {
    for path in paths {
        list.retain(|kept| kept != path);
        list.insert(0, path.clone());
    }
    list.truncate(LIMIT);
}

/// Forgets `path`, and every place under it when it is a folder.
pub fn forget(list: &mut Vec<String>, path: &str) {
    let under = Path::new(path);
    list.retain(|kept| !Path::new(kept).starts_with(under));
}

/// Reads the list back; a missing or unreadable file is an empty list.
pub fn load(file: &Path) -> Vec<String> {
    std::fs::read(file)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Vec<String>>(&bytes).ok())
        .map(|mut list| {
            list.retain(|path| path.len() <= MAX_PATH && Path::new(path).is_absolute());
            list.truncate(LIMIT);
            list
        })
        .unwrap_or_default()
}

/// Writes the list beside the old one and renames it over it, so a crash
/// halfway leaves the old list whole.
pub fn store(file: &Path, list: &[String]) -> std::io::Result<()> {
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

/// Puts every kept place that is still there back in the file scope: a
/// folder with everything under it, as the folder panel gave it, a file by
/// itself. Run once when the app starts.
pub fn restore<R: Runtime>(app: &AppHandle<R>) {
    // Off the main thread: a folder on a network drive that is not there
    // can take many seconds to answer, and the windows would wait for it.
    let app = app.clone();
    std::thread::spawn(move || restore_now(&app));
}

fn restore_now<R: Runtime>(app: &AppHandle<R>) {
    let Ok(file) = list_file(app) else {
        return;
    };
    let scope = app.fs_scope();
    for place in load(&file) {
        let path = Path::new(&place);
        let allowed = if path.is_dir() {
            scope.allow_directory(path, true)
        } else if path.is_file() {
            scope.allow_file(path)
        } else {
            continue;
        };
        if let Err(e) = allowed {
            eprintln!("warraq: cannot allow {}: {e}", path.display());
        }
    }
}

/// Keeps the places the Library was given. Refused, as a whole, when any of
/// them is a path the person did not choose (outside the file scope).
// Off the main thread on Windows, where it draws every window (`stall.rs`).
#[cfg_attr(windows, tauri::command(async))]
#[cfg_attr(not(windows), tauri::command)]
pub fn library_places_remember<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, PlacesState>,
    paths: Vec<String>,
) -> Result<(), String> {
    if paths.len() > LIMIT {
        return Err("E_ARGS: too many places".to_string());
    }
    let scope = app.fs_scope();
    for path in &paths {
        let place = Path::new(path);
        if path.len() > MAX_PATH || !place.is_absolute() || !scope.is_allowed(place) {
            return Err(format!("E_SCOPE: {path} was not chosen by the person"));
        }
    }
    let _guard = state.0.lock().map_err(|_| "E_STATE: lock poisoned")?;
    let target = list_file(&app)?;
    let mut list = load(&target);
    remember(&mut list, &paths);
    store(&target, &list).map_err(|e| format!("E_IO: {}: {e}", target.display()))
}

/// Forgets a place (a folder, with everything kept under it), or every place
/// when `path` is absent (the Library deleted). It stays readable until the
/// app closes, as anything chosen does.
// Off the main thread on Windows, where it draws every window (`stall.rs`).
#[cfg_attr(windows, tauri::command(async))]
#[cfg_attr(not(windows), tauri::command)]
pub fn library_places_forget<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, PlacesState>,
    path: Option<String>,
) -> Result<(), String> {
    let _guard = state.0.lock().map_err(|_| "E_STATE: lock poisoned")?;
    let target = list_file(&app)?;
    let mut list = load(&target);
    match path {
        Some(path) => forget(&mut list, &path),
        None => list.clear(),
    }
    store(&target, &list).map_err(|e| format!("E_IO: {}: {e}", target.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_newest_comes_first_and_a_place_is_kept_once() {
        let mut list = Vec::new();
        remember(&mut list, &["/docs".to_string(), "/a.docx".to_string()]);
        remember(&mut list, &["/docs".to_string()]);
        assert_eq!(list, vec!["/docs".to_string(), "/a.docx".to_string()]);
    }

    #[test]
    fn the_list_is_bounded() {
        let mut list = Vec::new();
        let many: Vec<String> = (0..LIMIT + 20).map(|n| format!("/f{n}.pdf")).collect();
        remember(&mut list, &many);
        assert_eq!(list.len(), LIMIT);
        assert_eq!(list[0], format!("/f{}.pdf", LIMIT + 19));
    }

    #[test]
    fn forgetting_a_folder_forgets_what_is_under_it() {
        let mut list = vec![
            "/docs/a.pdf".to_string(),
            "/docs".to_string(),
            "/docsmore/b.pdf".to_string(),
            "/other".to_string(),
        ];
        forget(&mut list, "/docs");
        assert_eq!(
            list,
            vec!["/docsmore/b.pdf".to_string(), "/other".to_string()]
        );
    }

    #[test]
    fn a_broken_or_hostile_file_is_an_empty_or_shorter_list() {
        let dir = std::env::temp_dir().join(format!("warraq-places-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join(FILE_NAME);
        std::fs::write(&file, b"not json").unwrap();
        assert!(load(&file).is_empty());
        // Absolute on every system the tests run on.
        let kept = dir.join("kept").to_string_lossy().into_owned();
        let again = dir.join("again").to_string_lossy().into_owned();
        let long = dir
            .join("x".repeat(MAX_PATH + 1))
            .to_string_lossy()
            .into_owned();
        std::fs::write(
            &file,
            serde_json::to_vec(&vec!["relative/path", long.as_str(), kept.as_str()]).unwrap(),
        )
        .unwrap();
        assert_eq!(load(&file), vec![kept]);
        store(&file, std::slice::from_ref(&again)).unwrap();
        assert_eq!(load(&file), vec![again]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
