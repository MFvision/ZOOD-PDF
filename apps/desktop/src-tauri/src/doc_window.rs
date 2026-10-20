//! Settings › Viewing › "Open documents in: New windows": each document after
//! the first opens in an editor window of its own (`doc-1`, `doc-2`…), made
//! from the main window's configuration. The new window claims its file with
//! `startup_file`, as the main window does at boot, so nothing is passed
//! through the address bar and a reload does not reopen it.
//!
//! Events meant for one window (a drop, the macOS menu) go to that window
//! alone: see `focused_editor` and the `emit_to` calls in `lib.rs`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Manager, Runtime, State, WebviewWindowBuilder};
use tauri_plugin_fs::FsExt;

pub const PREFIX: &str = "doc-";

/// The file each document window opens with, by label, until it claims it.
#[derive(Default)]
pub struct DocWindowFiles(pub Mutex<HashMap<String, String>>);

static NEXT: AtomicU32 = AtomicU32::new(1);

pub fn is_doc_window(label: &str) -> bool {
    label.starts_with(PREFIX)
}

/// Is `label` an editor window: the main one or a document's?
pub fn is_editor(label: &str) -> bool {
    label == "main" || is_doc_window(label)
}

/// The editor window in front, else the main one: where the menu bar's
/// choice and a file from outside go.
pub fn focused_editor<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    let windows = app.webview_windows();
    windows
        .iter()
        .find(|(label, window)| is_editor(label) && window.is_focused().unwrap_or(false))
        .map(|(label, _)| label.clone())
        .or_else(|| windows.contains_key("main").then(|| "main".to_string()))
}

/// Claims the file a document window was opened for (once).
pub fn take<R: Runtime>(app: &AppHandle<R>, label: &str) -> Option<String> {
    let files = app.try_state::<DocWindowFiles>()?;
    let mut files = files.0.lock().ok()?;
    files.remove(label)
}

/// Opens `path` (a file this run may already read) in a new editor window.
#[tauri::command]
pub fn open_document_window<R: Runtime>(
    app: AppHandle<R>,
    files: State<'_, DocWindowFiles>,
    path: String,
) -> Result<String, String> {
    let file = PathBuf::from(&path);
    if !file.is_absolute() || !file.is_file() || !app.fs_scope().is_allowed(&file) {
        return Err(format!("E_SCOPE: {path} was not opened in this run"));
    }
    let mut config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .cloned()
        .ok_or("E_WINDOW: no editor configuration")?;
    let label = format!("{PREFIX}{}", NEXT.fetch_add(1, Ordering::Relaxed));
    config.label = label.clone();
    files
        .0
        .lock()
        .map_err(|_| "E_WINDOW: busy")?
        .insert(label.clone(), path);
    let window = WebviewWindowBuilder::from_config(&app, &config)
        .and_then(|builder| builder.build())
        .map_err(|e| {
            if let Ok(mut files) = files.0.lock() {
                files.remove(&label);
            }
            format!("E_WINDOW: {e}")
        })?;
    // Cascaded from the window it came from, as a second document window does.
    if let Some(from) = focused_editor(&app).and_then(|l| app.get_webview_window(&l)) {
        if let Ok(at) = from.outer_position() {
            let _ = window.set_position(tauri::PhysicalPosition::new(at.x + 28, at.y + 28));
        }
    }
    let _ = window.set_focus();
    Ok(label)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn document_windows_are_editors_and_quick_windows_are_not() {
        assert!(is_editor("main"));
        assert!(is_editor("doc-3"));
        assert!(is_doc_window("doc-1"));
        assert!(!is_editor("ring"));
        assert!(!is_editor("quick-2"));
    }
}
