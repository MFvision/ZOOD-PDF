//! Files between the phone and the PC, seen moving: one flicked from the
//! phone rises in a glow from the bottom of the screen, is shown large, then
//! settles at the Desktop's corner; one sent to the phone lifts where it was
//! and flies off the bottom of the screen in a burst of light. Then the
//! window goes. The window is transparent, on top, out of the taskbar, never
//! focused, and lets every click through to what is under it; it only ever
//! shows the interface's `?arrival=1` view (`packages/ui/src/remote/Arrival.tsx`).

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

const LABEL: &str = "arrival";
/// What the window shows. Payload: `{ way: "in" | "out", name, kind, picture, from: { x, y } | null }`.
pub const ARRIVE_EVENT: &str = "arrival://file";
/// How long the window stays after the last file came.
const STAY: Duration = Duration::from_millis(3600);

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

/// The picture a page can draw, as a data address, or none.
fn picture_of(mime: &str, picture: Option<&str>) -> Option<String> {
    picture
        .filter(|_| {
            matches!(
                mime,
                "image/jpeg" | "image/png" | "image/webp" | "image/gif"
            )
        })
        .map(|data| format!("data:{mime};base64,{data}"))
}

fn name_of(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// A file from the phone, arriving: up from the bottom of the screen, shown
/// large for a moment, then to the Desktop's corner where it was saved.
pub fn show<R: Runtime>(app: &AppHandle<R>, path: &Path, mime: &str, picture: Option<&str>) {
    let name = name_of(path);
    let kind = kind_of(&name, mime);
    let picture = picture_of(mime, picture);
    let payload = serde_json::json!({ "way": "in", "name": name, "kind": kind, "picture": picture, "from": null });
    present(app, payload, None);
}

/// A file going to the phone: it lifts where it was (`from`, the pointer, in
/// the units the ring's watcher gives: physical pixels on Windows, points on
/// macOS; the screen's middle without one) and flies off the bottom of the
/// screen, toward the phone, in a burst of light.
pub fn depart<R: Runtime>(
    app: &AppHandle<R>,
    name: &str,
    mime: &str,
    picture: Option<&str>,
    from: Option<(f64, f64)>,
) {
    let kind = kind_of(name, mime);
    let picture = picture_of(mime, picture);
    let payload = serde_json::json!({ "way": "out", "name": name, "kind": kind, "picture": picture, "from": null });
    present(app, payload, from);
}

/// Where `at` falls in a window over `area`, in the page's own pixels; none
/// when it is off that area.
pub fn local_point(
    at: (f64, f64),
    windows: bool,
    scale: f64,
    area: ((f64, f64), (f64, f64)),
) -> Option<(f64, f64)> {
    let scale = if scale > 0.0 { scale } else { 1.0 };
    let (x, y) = if windows {
        at
    } else {
        (at.0 * scale, at.1 * scale)
    };
    let ((left, top), (width, height)) = area;
    let inside = x >= left && x < left + width && y >= top && y < top + height;
    inside.then(|| ((x - left) / scale, (y - top) / scale))
}

fn present<R: Runtime>(
    app: &AppHandle<R>,
    mut payload: serde_json::Value,
    from: Option<(f64, f64)>,
) {
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
            if let Some(at) = from {
                let bounds = (
                    (f64::from(area.position.x), f64::from(area.position.y)),
                    (f64::from(area.size.width), f64::from(area.size.height)),
                );
                if let Some((x, y)) = local_point(
                    at,
                    cfg!(target_os = "windows"),
                    screen.scale_factor(),
                    bounds,
                ) {
                    payload["from"] = serde_json::json!({ "x": x, "y": y });
                }
            }
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

    #[test]
    fn the_pointer_is_placed_in_the_window_in_its_own_pixels() {
        let area = ((0.0, 25.0), (2880.0, 1775.0));
        // Windows: physical pixels in, page pixels out.
        assert_eq!(
            local_point((300.0, 425.0), true, 2.0, area),
            Some((150.0, 200.0))
        );
        // macOS: points in.
        assert_eq!(
            local_point((150.0, 212.5), false, 2.0, area),
            Some((150.0, 200.0))
        );
        // Off the screen: none.
        assert_eq!(local_point((-5.0, 10.0), true, 1.0, area), None);
    }
}
