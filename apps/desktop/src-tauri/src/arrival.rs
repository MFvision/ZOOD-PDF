//! A file flicked from the phone, seen arriving on the PC: a glow sweeps the
//! screen and the file flies in to settle at the Desktop's corner, then the
//! window goes. The window is transparent, on top, out of the taskbar, never
//! focused, and lets every click through to what is under it; it only ever
//! shows the interface's `?arrival=1` view (`packages/ui/src/remote/Arrival.tsx`).

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

const LABEL: &str = "arrival";
/// What the window shows. Payload: `{ name, kind, picture }`.
pub const ARRIVE_EVENT: &str = "arrival://file";
/// How long the window stays after the last file came.
const STAY: Duration = Duration::from_millis(3200);

/// Which arrival is the newest: an older one's timer leaves the window alone.
static LATEST: AtomicU64 = AtomicU64::new(0);

/// What kind of file, for its icon: picture, pdf or file.
pub fn kind_of(name: &str, mime: &str) -> &'static str {
    let lower = name.to_ascii_lowercase();
    if mime.starts_with("image/") {
        "picture"
    } else if mime == "application/pdf" || lower.ends_with(".pdf") {
        "pdf"
    } else {
        "file"
    }
}

pub fn show<R: Runtime>(app: &AppHandle<R>, path: &Path, mime: &str, picture: Option<&str>) {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let kind = kind_of(&name, mime);
    // A picture is shown as itself; its type must be one a page can draw.
    let picture = picture
        .filter(|_| {
            matches!(
                mime,
                "image/jpeg" | "image/png" | "image/webp" | "image/gif"
            )
        })
        .map(|data| format!("data:{mime};base64,{data}"));
    let payload = serde_json::json!({ "name": name, "kind": kind, "picture": picture });
    let app = app.clone();
    let turn = LATEST.fetch_add(1, Ordering::Relaxed) + 1;
    // Windows are made and moved on the main thread.
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(window) = window(&handle) else {
            return;
        };
        if let Ok(Some(screen)) = window.primary_monitor() {
            let area = screen.work_area();
            let _ = window.set_position(area.position);
            let _ = window.set_size(area.size);
        }
        let _ = window.set_ignore_cursor_events(true);
        let _ = window.show();
        // The view may still be loading the first time: it asks for the
        // latest arrival itself once it runs (`arrival_last`).
        if let Ok(mut last) = LAST.lock() {
            *last = Some(payload.clone());
        }
        let _ = window.emit_to(LABEL, ARRIVE_EVENT, payload);
        let later = handle.clone();
        std::thread::spawn(move || {
            std::thread::sleep(STAY);
            if LATEST.load(Ordering::Relaxed) != turn {
                return;
            }
            let _ = later.clone().run_on_main_thread(move || {
                if let Some(window) = later.get_webview_window(LABEL) {
                    let _ = window.hide();
                }
            });
        });
    });
}

static LAST: std::sync::Mutex<Option<serde_json::Value>> = std::sync::Mutex::new(None);

/// The newest arrival, for the view when it first loads.
#[tauri::command]
pub fn arrival_last() -> Option<serde_json::Value> {
    LAST.lock().ok()?.take()
}

fn window<R: Runtime>(app: &AppHandle<R>) -> Option<tauri::WebviewWindow<R>> {
    if let Some(window) = app.get_webview_window(LABEL) {
        return Some(window);
    }
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html?arrival=1".into()))
        .title("ZOOD PDF")
        .decorations(false)
        .resizable(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .focusable(false)
        .visible(false)
        .transparent(true)
        .build()
        .map_err(|e| crate::core_bridge::debug_log(format!("cannot make the arrival window: {e}")))
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn files_are_shown_by_their_kind() {
        assert_eq!(kind_of("a.jpg", "image/jpeg"), "picture");
        assert_eq!(kind_of("Contract.PDF", ""), "pdf");
        assert_eq!(
            kind_of("notes.docx", "application/vnd.openxmlformats"),
            "file"
        );
    }
}
