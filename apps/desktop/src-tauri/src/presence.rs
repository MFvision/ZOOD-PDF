//! ZOOD within reach without its window: the tray icon (the menu bar on a
//! Mac) and the ZOOD bubble, as Claude and ChatGPT keep theirs.
//!
//! The icon is there while the app is kept ready (Settings › Quick tools ›
//! "Keep the quick tools ready", which also starts ZOOD PDF at sign-in, in
//! `ring.rs`); the welcome tour offers it, so nobody has to find it. A
//! click on the icon starts Ask ZOOD; its menu has Ask ZOOD, the editor, the
//! recent files, Settings, the bubble and Quit.
//!
//! The bubble is a small round ZOOD button on the edge of the screen, above
//! every window and never taking the keyboard, so the app in front stays the
//! one Ask ZOOD helps with. A click starts Ask ZOOD; it can be dragged
//! anywhere, and stays where it was left. Off until the person turns it on.
//! Files dropped on it are sorted (`sort.rs`).

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, SubmenuBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

use crate::core_bridge::debug_log;

pub const BUBBLE_LABEL: &str = "ask-bubble";
const FILE: &str = "presence.json";
/// The bubble's side, in the window's own units.
const BUBBLE_SIDE: f64 = 64.0;

pub const TRAY_ASK: &str = "tray-ask";
pub const TRAY_SETTINGS: &str = "tray-settings";
pub const TRAY_BUBBLE: &str = "tray-bubble";
/// A recent file: this, then its place in the list.
pub const TRAY_RECENT: &str = "tray-recent-";

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Presence {
    /// The ZOOD bubble is on the screen.
    pub bubble: bool,
    /// Where the person left it, in physical pixels.
    pub at: Option<(i32, i32)>,
    /// The app's language, for the tray menu's words: "ar" or "en".
    pub lang: String,
}

static BUBBLE: AtomicBool = AtomicBool::new(false);
static SETTINGS: Mutex<Option<Presence>> = Mutex::new(None);

fn file<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join(FILE))
}

pub fn load<R: Runtime>(app: &AppHandle<R>) -> Presence {
    if let Some(kept) = SETTINGS.lock().ok().and_then(|s| s.clone()) {
        return kept;
    }
    let read: Presence = file(app)
        .and_then(|path| std::fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    if let Ok(mut kept) = SETTINGS.lock() {
        *kept = Some(read.clone());
    }
    read
}

fn store<R: Runtime>(app: &AppHandle<R>, presence: &Presence) {
    if let Ok(mut kept) = SETTINGS.lock() {
        *kept = Some(presence.clone());
    }
    if let (Some(path), Ok(bytes)) = (file(app), serde_json::to_vec(presence)) {
        if let Err(e) = std::fs::write(&path, bytes) {
            debug_log(format!("presence: {}: {e}", path.display()));
        }
    }
}

/// The tray menu's words, in the app's language.
pub fn words(lang: &str) -> [&'static str; 7] {
    if lang == "en" {
        [
            "Ask ZOOD",
            "Open ZOOD PDF",
            "Recent files",
            "Settings",
            "Show the ZOOD bubble",
            "Quit",
            "No recent files",
        ]
    } else {
        [
            "اسأل زود",
            "فتح محرر زود PDF",
            "الملفات الأخيرة",
            "الإعدادات",
            "إظهار فقاعة زود",
            "إنهاء",
            "لا توجد ملفات أخيرة",
        ]
    }
}

/// The tray icon's menu, built again whenever it may have changed.
pub fn tray_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    let presence = load(app);
    let [ask, open, recent, settings, bubble, quit, none] = words(&presence.lang);
    let mut files = SubmenuBuilder::new(app, recent);
    let known = crate::recent::known(app);
    if known.is_empty() {
        files = files.item(
            &tauri::menu::MenuItemBuilder::new(none)
                .enabled(false)
                .build(app)?,
        );
    }
    for (index, entry) in known.iter().take(8).enumerate() {
        files = files.text(format!("{TRAY_RECENT}{index}"), &entry.name);
    }
    let bubble = CheckMenuItemBuilder::new(bubble)
        .id(TRAY_BUBBLE)
        .checked(BUBBLE.load(Ordering::Relaxed))
        .build(app)?;
    MenuBuilder::new(app)
        .text(TRAY_ASK, ask)
        .text(crate::ring::TRAY_OPEN, open)
        .item(&files.build()?)
        .text(TRAY_SETTINGS, settings)
        .separator()
        .item(&bubble)
        .separator()
        .text(crate::ring::TRAY_QUIT, quit)
        .build()
}

/// The tray icon answers clicks, and the bubble is put back as it was left.
pub fn start<R: Runtime>(app: &AppHandle<R>) {
    let presence = load(app);
    BUBBLE.store(presence.bubble, Ordering::Relaxed);
    if let Some(tray) = app.tray_by_id(crate::ring::TRAY_ID) {
        // A click asks; the menu is on the other button.
        let _ = tray.set_show_menu_on_left_click(false);
        tray.on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                crate::ask::summon(tray.app_handle());
            }
        });
    }
    if presence.bubble {
        show_bubble(app);
    }
}

/// A choice in the tray menu that is this file's: true when handled.
pub fn on_menu<R: Runtime>(app: &AppHandle<R>, id: &str) -> bool {
    if id == TRAY_ASK {
        crate::ask::summon(app);
    } else if id == TRAY_SETTINGS {
        open_settings(app);
    } else if id == TRAY_BUBBLE {
        let on = !BUBBLE.load(Ordering::Relaxed);
        set_bubble(app, on);
    } else if let Some(index) = id.strip_prefix(TRAY_RECENT) {
        let Some(entry) = index
            .parse::<usize>()
            .ok()
            .and_then(|index| crate::recent::known(app).into_iter().nth(index))
        else {
            return true;
        };
        crate::open_in_editor_at(app, Some(PathBuf::from(entry.path)), None);
    } else {
        return false;
    }
    true
}

/// The editor, with Settings open: run as the command book runs a step
/// (`ask/book.rs`), after a new window has had time to load.
fn open_settings<R: Runtime>(app: &AppHandle<R>) {
    let fresh = app.get_webview_window("main").is_none();
    crate::quick::show_editor(app);
    let handle = app.clone();
    std::thread::spawn(move || {
        if fresh {
            std::thread::sleep(std::time::Duration::from_millis(2500));
        }
        if let Some(editor) = crate::doc_window::focused_editor(&handle) {
            let _ = handle.emit_to(
                editor.as_str(),
                crate::ask::book::COMMAND_EVENT,
                serde_json::json!({ "request": 0, "step": { "id": "settings", "label": "" }, "mode": "do" }),
            );
        }
    });
}

/// The bubble on or off, kept for the next run, and the tray's check with it.
pub fn set_bubble<R: Runtime>(app: &AppHandle<R>, on: bool) {
    BUBBLE.store(on, Ordering::Relaxed);
    let mut presence = load(app);
    presence.bubble = on;
    store(app, &presence);
    if on {
        show_bubble(app);
    } else if let Some(window) = app.get_webview_window(BUBBLE_LABEL) {
        let _ = window.close();
    }
    refresh_tray(app);
    let _ = app.emit("presence://changed", &presence);
}

/// The tray menu again: a recent file opened, the bubble switched, the language changed.
pub fn refresh_tray<R: Runtime>(app: &AppHandle<R>) {
    if let (Some(tray), Ok(menu)) = (app.tray_by_id(crate::ring::TRAY_ID), tray_menu(app)) {
        let _ = tray.set_menu(Some(menu));
    }
}

/// Where a new bubble goes: the right edge of the main screen, a third down.
fn first_place<R: Runtime>(app: &AppHandle<R>) -> Option<(i32, i32)> {
    let monitor = app.primary_monitor().ok().flatten()?;
    let scale = monitor.scale_factor();
    let side = (BUBBLE_SIDE * scale) as i32;
    let position = monitor.position();
    let size = monitor.size();
    Some((
        position.x + size.width as i32 - side - (16.0 * scale) as i32,
        position.y + size.height as i32 / 3,
    ))
}

fn show_bubble<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = handle.get_webview_window(BUBBLE_LABEL) {
            let _ = window.show();
            return;
        }
        let builder = WebviewWindowBuilder::new(
            &handle,
            BUBBLE_LABEL,
            WebviewUrl::App("index.html?askbubble=1".into()),
        )
        .title("ZOOD")
        .inner_size(BUBBLE_SIDE, BUBBLE_SIDE)
        // Without a smallest size of its own, Windows keeps a window at
        // least as wide as a title bar needs (SM_CXMINTRACK, ~140 px), and
        // the round bubble came out a flat oval.
        .min_inner_size(BUBBLE_SIDE, BUBBLE_SIDE)
        .decorations(false)
        .resizable(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .focusable(false)
        .transparent(true);
        // Made ready out of sight, so it takes drops on Windows (`parked.rs`),
        // then put in its place below.
        let window = match crate::parked::hidden(builder).build() {
            Ok(window) => window,
            Err(e) => {
                debug_log(format!("presence: cannot make the bubble: {e}"));
                return;
            }
        };
        crate::parked::made(&window);
        // Windows widened it to that smallest width while making it, before
        // the size above applied: square again now that it does.
        let _ = window.set_size(tauri::LogicalSize::new(BUBBLE_SIDE, BUBBLE_SIDE));
        if let Some((x, y)) = load(&handle).at.or_else(|| first_place(&handle)) {
            let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
        }
        crate::ask::notch::above_menu_bar(&window);
        let kept = handle.clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::Moved(at) = event {
                // Where it waited off screen (`parked.rs`) is not a place to keep.
                if crate::parked::is_away(at.x, at.y) {
                    return;
                }
                let mut presence = load(&kept);
                presence.at = Some((at.x, at.y));
                store(&kept, &presence);
            }
        });
        let _ = window.show();
    });
}

/// The bubble's look while files are dragged over it (`Bubble.tsx`).
pub const BUBBLE_DRAG_EVENT: &str = "bubble://drag";

/// Files dragged onto the bubble: it opens its arms, and files let go on it
/// are sorted (`sort.rs`), so the bubble is a place to throw messy files.
pub fn on_drag<R: Runtime>(window: &tauri::Window<R>, event: &tauri::DragDropEvent) {
    match event {
        tauri::DragDropEvent::Enter { .. } => {
            let _ = window.emit_to(BUBBLE_LABEL, BUBBLE_DRAG_EVENT, true);
        }
        tauri::DragDropEvent::Leave => {
            let _ = window.emit_to(BUBBLE_LABEL, BUBBLE_DRAG_EVENT, false);
        }
        tauri::DragDropEvent::Drop { paths, .. } => {
            let _ = window.emit_to(BUBBLE_LABEL, BUBBLE_DRAG_EVENT, false);
            let files = crate::sort::files_of(paths);
            if !files.is_empty() {
                crate::sort::open(window.app_handle(), files);
            }
        }
        _ => {}
    }
}

/// The bubble was clicked.
#[tauri::command]
pub fn presence_ask<R: Runtime>(app: AppHandle<R>) {
    crate::ask::summon(&app);
}

#[tauri::command]
pub fn presence_settings<R: Runtime>(app: AppHandle<R>) -> Presence {
    let mut presence = load(&app);
    presence.bubble = BUBBLE.load(Ordering::Relaxed);
    presence
}

/// Settings and the tour: the bubble on or off; the app's language for the tray.
#[tauri::command]
pub fn presence_configure<R: Runtime>(
    app: AppHandle<R>,
    bubble: Option<bool>,
    lang: Option<String>,
) -> Presence {
    if let Some(lang) = lang.filter(|l| l == "ar" || l == "en") {
        let mut presence = load(&app);
        if presence.lang != lang {
            presence.lang = lang;
            store(&app, &presence);
            refresh_tray(&app);
        }
    }
    if let Some(on) = bubble {
        if on != BUBBLE.load(Ordering::Relaxed) {
            set_bubble(&app, on);
        }
    }
    presence_settings(app)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_settings_start_with_no_bubble_and_read_old_files() {
        let presence: Presence = serde_json::from_str("{}").unwrap();
        assert!(!presence.bubble);
        assert_eq!(presence.at, None);
        let kept: Presence =
            serde_json::from_str(r#"{"bubble":true,"at":[10,20],"lang":"en"}"#).unwrap();
        assert_eq!(kept.at, Some((10, 20)));
        assert_eq!(words(&kept.lang)[0], "Ask ZOOD");
        assert_eq!(words("ar")[0], "اسأل زود");
    }
}
