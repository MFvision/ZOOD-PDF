//! The ring: hold Ctrl (Option on a Mac) and drag files out of File
//! Explorer or Finder, and a ring of tools opens at the pointer; let the
//! files go on a tool and its quick window opens (`quick.rs`). The idea is
//! Filee's (github.com/KnifeLemon/Filee, MIT); none of its code is used.
//!
//! A watcher sees the system's mouse — a low-level mouse hook on Windows, a
//! global event monitor on macOS (which needs no permission for mouse
//! events) — and only notices a drag that started in Explorer or Finder
//! with the key held. The ring itself is a small transparent window that
//! takes the drop like any window; the files it is given are the ones the
//! person let go there. Nothing is read or kept from any other drag.
//!
//! The ring works while the app runs. "Keep the quick tools ready" in
//! Settings starts the app at sign-in without a window (`--background`),
//! with an icon in the tray (menu bar on a Mac) to open the editor or quit.
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

use crate::quick::{self, QuickRequest, TOOLS};

pub const BACKGROUND_FLAG: &str = "--background";
pub const LABEL: &str = "ring";
/// The ring's side, in points.
const SIDE: f64 = 300.0;
/// How far the pointer moves, in pixels, before a press is a drag.
pub const DRAG_START: i32 = 14;
/// After the button is let go, how long a drop on the ring has to arrive.
const DROP_GRACE: Duration = Duration::from_millis(700);
const SETTINGS_FILE: &str = "quick-tools.json";

pub const SHOW_EVENT: &str = "ring://show";
pub const FILES_EVENT: &str = "ring://files";
pub const OVER_EVENT: &str = "ring://over";
pub const DROP_EVENT: &str = "ring://drop";

static ENABLED: AtomicBool = AtomicBool::new(true);
static BACKGROUND: AtomicBool = AtomicBool::new(false);
static GESTURES: OnceLock<Mutex<Sender<Gesture>>> = OnceLock::new();
static DROPPED: Mutex<Option<Vec<PathBuf>>> = Mutex::new(None);

/// What the watchers see.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Gesture {
    /// A drag with the key held began in the file manager; the pointer is
    /// here: physical pixels on Windows, points from the top-left of the
    /// main screen on macOS.
    Start { x: f64, y: f64 },
    /// The button was let go.
    End,
}

/// The ring's two switches, kept beside the app's data so a `--background`
/// start (which runs no interface) knows them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RingSettings {
    pub ring: bool,
    pub background: bool,
}

impl Default for RingSettings {
    fn default() -> Self {
        RingSettings {
            ring: true,
            background: false,
        }
    }
}

pub fn enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

/// Whether the app stays running, in the tray, when its windows close.
pub fn background() -> bool {
    BACKGROUND.load(Ordering::Relaxed)
}

pub fn send(gesture: Gesture) {
    if let Some(sender) = GESTURES.get() {
        if let Ok(sender) = sender.lock() {
            let _ = sender.send(gesture);
        }
    }
}

/// Does a drag from `start` to `now` count, with the key held?
pub fn is_drag(start: (i32, i32), now: (i32, i32), key_held: bool) -> bool {
    let (dx, dy) = (now.0 - start.0, now.1 - start.1);
    key_held && dx * dx + dy * dy >= DRAG_START * DRAG_START
}

/// The window classes of File Explorer's windows and of the desktop.
pub fn is_file_manager_class(class: &str) -> bool {
    matches!(
        class,
        "CabinetWClass" | "ExploreWClass" | "Progman" | "WorkerW"
    )
}

fn settings_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join(SETTINGS_FILE))
}

pub fn load_settings<R: Runtime>(app: &AppHandle<R>) -> RingSettings {
    settings_path(app)
        .and_then(|path| std::fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// Starts the watcher for this system and the thread that answers it.
/// `start_hidden`: this run began with `--background`.
pub fn start<R: Runtime>(app: &AppHandle<R>, start_hidden: bool) {
    let settings = load_settings(app);
    ENABLED.store(settings.ring, Ordering::Relaxed);
    BACKGROUND.store(settings.background || start_hidden, Ordering::Relaxed);
    show_tray(app, background());
    let (sender, receiver) = channel::<Gesture>();
    if GESTURES.set(Mutex::new(sender)).is_err() {
        return;
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        while let Ok(gesture) = receiver.recv() {
            match gesture {
                Gesture::Start { x, y } => show(&handle, x, y),
                Gesture::End => {
                    let handle = handle.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(DROP_GRACE);
                        if DROPPED.lock().map(|d| d.is_none()).unwrap_or(true) {
                            hide(&handle);
                        }
                    });
                }
            }
        }
    });
    #[cfg(target_os = "windows")]
    windows::watch();
    #[cfg(target_os = "macos")]
    macos::watch();
}

fn ring_window<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    if let Some(window) = app.get_webview_window(LABEL) {
        return Some(window);
    }
    let builder =
        WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html?ring=1".into()))
            .title("محرر PDF")
            .inner_size(SIDE, SIDE)
            .decorations(false)
            .resizable(false)
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(false)
            .focusable(false)
            .visible(false)
            // On macOS this needs Tauri's macos-private-api (Cargo.toml).
            .transparent(true);
    builder
        .build()
        .map_err(|e| eprintln!("warraq: cannot make the ring: {e}"))
        .ok()
}

fn show<R: Runtime>(app: &AppHandle<R>, x: f64, y: f64) {
    if !enabled() {
        return;
    }
    if let Ok(mut dropped) = DROPPED.lock() {
        *dropped = None;
    }
    let Some(window) = ring_window(app) else {
        return;
    };
    if cfg!(target_os = "windows") {
        let size = window
            .outer_size()
            .map(|s| (f64::from(s.width), f64::from(s.height)))
            .unwrap_or((SIDE, SIDE));
        let _ = window.set_position(tauri::PhysicalPosition::new(
            x - size.0 / 2.0,
            y - size.1 / 2.0,
        ));
    } else {
        let _ = window.set_position(tauri::LogicalPosition::new(x - SIDE / 2.0, y - SIDE / 2.0));
    }
    let _ = window.emit_to(LABEL, SHOW_EVENT, ());
    let _ = window.show();
}

pub fn hide<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.hide();
    }
}

#[derive(Clone, Serialize)]
struct FilesPayload {
    names: Vec<String>,
}

#[derive(Clone, Serialize)]
struct PointPayload {
    x: f64,
    y: f64,
}

/// The ring window's own drag and drop (`lib.rs` passes it here).
pub fn on_drag<R: Runtime>(
    window: &tauri::Window<R>,
    event: &tauri::DragDropEvent,
    at: Option<(f64, f64)>,
) {
    match event {
        tauri::DragDropEvent::Enter { paths, .. } => {
            let names = paths
                .iter()
                .filter(|p| p.is_file())
                .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
                .collect();
            let _ = window.emit_to(LABEL, FILES_EVENT, FilesPayload { names });
            if let Some((x, y)) = at {
                let _ = window.emit_to(LABEL, OVER_EVENT, Some(PointPayload { x, y }));
            }
        }
        tauri::DragDropEvent::Over { .. } => {
            if let Some((x, y)) = at {
                let _ = window.emit_to(LABEL, OVER_EVENT, Some(PointPayload { x, y }));
            }
        }
        tauri::DragDropEvent::Leave => {
            let _ = window.emit_to(LABEL, OVER_EVENT, None::<PointPayload>);
        }
        tauri::DragDropEvent::Drop { paths, .. } => {
            let files: Vec<PathBuf> = paths
                .iter()
                .filter(|p| p.is_file())
                .take(500)
                .cloned()
                .collect();
            if let Ok(mut dropped) = DROPPED.lock() {
                *dropped = Some(files);
            }
            let (x, y) = at.unwrap_or((-1.0, -1.0));
            let _ = window.emit_to(LABEL, DROP_EVENT, PointPayload { x, y });
        }
        _ => {}
    }
}

/// The tool the files were let go on (`none`: the middle, or off the ring).
#[tauri::command]
pub fn ring_pick<R: Runtime>(app: AppHandle<R>, tool: String) {
    let files = DROPPED
        .lock()
        .ok()
        .and_then(|mut d| d.take())
        .unwrap_or_default();
    hide(&app);
    if tool == "none" || files.is_empty() {
        return;
    }
    let tool = match tool.as_str() {
        "all" => None,
        named => match TOOLS.iter().find(|t| **t == named) {
            Some(found) => Some(found.to_string()),
            None => return,
        },
    };
    quick::request(&app, QuickRequest { tool, files });
}

/// The two switches from Settings: the ring, and keeping the app ready in
/// the background (and starting it at sign-in).
#[tauri::command]
pub fn ring_configure<R: Runtime>(
    app: AppHandle<R>,
    ring: bool,
    background: bool,
) -> Result<RingSettings, String> {
    let settings = RingSettings { ring, background };
    ENABLED.store(ring, Ordering::Relaxed);
    BACKGROUND.store(background, Ordering::Relaxed);
    if let Some(path) = settings_path(&app) {
        let bytes = serde_json::to_vec(&settings).map_err(|e| format!("E_IO: {e}"))?;
        std::fs::write(&path, bytes).map_err(|e| format!("E_IO: {}: {e}", path.display()))?;
    }
    autostart(background)?;
    show_tray(&app, background);
    if !ring {
        hide(&app);
    }
    Ok(settings)
}

#[tauri::command]
pub fn ring_settings<R: Runtime>(app: AppHandle<R>) -> RingSettings {
    load_settings(&app)
}

pub const TRAY_ID: &str = "main";
pub const TRAY_OPEN: &str = "tray-open";
pub const TRAY_QUIT: &str = "tray-quit";

/// The tray icon (menu bar on a Mac): there only while the app is kept ready.
pub fn show_tray<R: Runtime>(app: &AppHandle<R>, visible: bool) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    if visible {
        let menu = tauri::menu::MenuBuilder::new(app)
            .text(TRAY_OPEN, "فتح محرر PDF")
            .separator()
            .text(TRAY_QUIT, "إنهاء")
            .build();
        if let Ok(menu) = menu {
            let _ = tray.set_menu(Some(menu));
        }
    }
    let _ = tray.set_visible(visible);
}

/// Starting at sign-in, without a window.
fn autostart(on: bool) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("E_IO: {e}"))?;
    #[cfg(target_os = "windows")]
    {
        crate::shell_menu::set_run_at_sign_in(
            on.then(|| format!("\"{}\" {BACKGROUND_FLAG}", exe.display())),
        )
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME").ok_or("E_IO: no home folder")?;
        let path =
            PathBuf::from(home).join("Library/LaunchAgents/app.warraq.desktop.background.plist");
        if on {
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir).map_err(|e| format!("E_IO: {e}"))?;
            }
            std::fs::write(&path, launch_agent(&exe.to_string_lossy()))
                .map_err(|e| format!("E_IO: {e}"))
        } else {
            match std::fs::remove_file(&path) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("E_IO: {e}")),
                _ => Ok(()),
            }
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = (on, exe);
        Ok(())
    }
}

fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// The macOS LaunchAgent that starts the app at sign-in, in the background.
pub fn launch_agent(exe: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>app.warraq.desktop.background</string>
  <key>ProgramArguments</key><array><string>{}</string><string>{BACKGROUND_FLAG}</string></array>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
</dict>
</plist>
"#,
        xml_escape(exe)
    )
}

#[cfg(target_os = "windows")]
mod windows {
    use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};

    use windows_sys::Win32::Foundation::{LPARAM, LRESULT, POINT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetAncestor, GetClassNameW, GetMessageW, SetWindowsHookExW,
        WindowFromPoint, GA_ROOT, MSG, MSLLHOOKSTRUCT, WH_MOUSE_LL, WM_LBUTTONDOWN, WM_LBUTTONUP,
        WM_MOUSEMOVE,
    };

    use super::{enabled, is_drag, is_file_manager_class, send, Gesture};

    static DOWN: AtomicBool = AtomicBool::new(false);
    static FROM_FILES: AtomicBool = AtomicBool::new(false);
    static SHOWN: AtomicBool = AtomicBool::new(false);
    static START_X: AtomicI32 = AtomicI32::new(0);
    static START_Y: AtomicI32 = AtomicI32::new(0);

    fn class_at(point: POINT) -> String {
        // SAFETY: plain window queries on a point; a buffer of fixed size.
        unsafe {
            let window = WindowFromPoint(point);
            if window.is_null() {
                return String::new();
            }
            let root = GetAncestor(window, GA_ROOT);
            let mut buffer = [0u16; 64];
            let length = GetClassNameW(
                if root.is_null() { window } else { root },
                buffer.as_mut_ptr(),
                64,
            );
            String::from_utf16_lossy(&buffer[..length.max(0) as usize])
        }
    }

    unsafe extern "system" fn hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 && lparam != 0 {
            // SAFETY: for WH_MOUSE_LL, lparam points at an MSLLHOOKSTRUCT.
            let info = unsafe { &*(lparam as *const MSLLHOOKSTRUCT) };
            let point = (info.pt.x, info.pt.y);
            match wparam as u32 {
                WM_LBUTTONDOWN => {
                    DOWN.store(true, Ordering::Relaxed);
                    SHOWN.store(false, Ordering::Relaxed);
                    START_X.store(point.0, Ordering::Relaxed);
                    START_Y.store(point.1, Ordering::Relaxed);
                    let from_files = enabled() && is_file_manager_class(&class_at(info.pt));
                    FROM_FILES.store(from_files, Ordering::Relaxed);
                }
                WM_MOUSEMOVE
                    if DOWN.load(Ordering::Relaxed)
                        && FROM_FILES.load(Ordering::Relaxed)
                        && !SHOWN.load(Ordering::Relaxed) =>
                {
                    // SAFETY: a plain key state query.
                    let control =
                        (unsafe { GetAsyncKeyState(i32::from(VK_CONTROL)) } as u16 & 0x8000) != 0;
                    let start = (
                        START_X.load(Ordering::Relaxed),
                        START_Y.load(Ordering::Relaxed),
                    );
                    if is_drag(start, point, control) {
                        SHOWN.store(true, Ordering::Relaxed);
                        send(Gesture::Start {
                            x: f64::from(point.0),
                            y: f64::from(point.1),
                        });
                    }
                }
                WM_LBUTTONUP => {
                    DOWN.store(false, Ordering::Relaxed);
                    if SHOWN.swap(false, Ordering::Relaxed) {
                        send(Gesture::End);
                    }
                }
                _ => {}
            }
        }
        // SAFETY: passes the event on, as every hook must.
        unsafe { CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam) }
    }

    /// The hook lives on a thread of its own, which must pump messages for it.
    pub fn watch() {
        std::thread::spawn(|| {
            // SAFETY: the hook procedure above, for this process; the loop
            // below keeps it called until the app ends.
            unsafe {
                let module = GetModuleHandleW(std::ptr::null());
                let hook = SetWindowsHookExW(WH_MOUSE_LL, Some(hook), module, 0);
                if hook.is_null() {
                    eprintln!("warraq: the ring's mouse hook could not be set");
                    return;
                }
                let mut message: MSG = std::mem::zeroed();
                while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 {}
            }
        });
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use std::cell::Cell;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_foundation::{NSPoint, NSRect, NSString};

    use super::{enabled, is_drag, send, Gesture};

    const LEFT_DOWN: usize = 1;
    const LEFT_UP: usize = 2;
    const LEFT_DRAGGED: usize = 6;
    const OPTION_KEY: usize = 1 << 19;

    thread_local! {
        static DOWN: Cell<Option<(i32, i32)>> = const { Cell::new(None) };
        static FROM_FINDER: Cell<bool> = const { Cell::new(false) };
        static SHOWN: Cell<bool> = const { Cell::new(false) };
    }

    /// The pointer, in points from the top-left of the main screen.
    fn pointer() -> (f64, f64) {
        // SAFETY: NSEvent's and NSScreen's documented class messages.
        unsafe {
            let at: NSPoint = msg_send![class!(NSEvent), mouseLocation];
            let screens: Option<Retained<AnyObject>> = msg_send![class!(NSScreen), screens];
            let height = screens
                .map(|screens| {
                    let main: Retained<AnyObject> = msg_send![&*screens, objectAtIndex: 0usize];
                    let frame: NSRect = msg_send![&*main, frame];
                    frame.size.height
                })
                .unwrap_or(0.0);
            (at.x, height - at.y)
        }
    }

    fn finder_in_front() -> bool {
        // SAFETY: NSWorkspace's documented messages, each answered with an object or nil.
        unsafe {
            let workspace: Retained<AnyObject> = msg_send![class!(NSWorkspace), sharedWorkspace];
            let app: Option<Retained<AnyObject>> = msg_send![&*workspace, frontmostApplication];
            let Some(app) = app else { return false };
            let id: Option<Retained<NSString>> = msg_send![&*app, bundleIdentifier];
            id.is_some_and(|id| id.to_string() == "com.apple.finder")
        }
    }

    /// A global monitor of the left button: macOS asks no permission for it.
    /// Called on the main thread, where its events arrive.
    pub fn watch() {
        let block = RcBlock::new(|event: *mut AnyObject| {
            if event.is_null() {
                return;
            }
            // SAFETY: the monitor hands a live NSEvent.
            let (kind, flags): (usize, usize) =
                unsafe { (msg_send![event, r#type], msg_send![event, modifierFlags]) };
            let (x, y) = pointer();
            let now = (x as i32, y as i32);
            match kind {
                LEFT_DOWN => {
                    DOWN.set(Some(now));
                    SHOWN.set(false);
                    FROM_FINDER.set(enabled() && finder_in_front());
                }
                LEFT_DRAGGED => {
                    if let (Some(start), true, false) = (DOWN.get(), FROM_FINDER.get(), SHOWN.get())
                    {
                        if is_drag(start, now, flags & OPTION_KEY != 0) {
                            SHOWN.set(true);
                            send(Gesture::Start { x, y });
                        }
                    }
                }
                LEFT_UP => {
                    DOWN.set(None);
                    if SHOWN.replace(false) {
                        send(Gesture::End);
                    }
                }
                _ => {}
            }
        });
        let mask: u64 = (1 << LEFT_DOWN) | (1 << LEFT_UP) | (1 << LEFT_DRAGGED);
        // SAFETY: NSEvent's documented class method; the monitor (and the
        // block it keeps) lives for the app's life.
        unsafe {
            let monitor: Option<Retained<AnyObject>> = msg_send![class!(NSEvent), addGlobalMonitorForEventsMatchingMask: mask, handler: &*block];
            std::mem::forget(monitor);
        }
        std::mem::forget(block);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_drag_counts_only_with_the_key_and_far_enough() {
        assert!(!is_drag((0, 0), (5, 5), true));
        assert!(is_drag((0, 0), (10, 10), true));
        assert!(!is_drag((0, 0), (40, 0), false));
    }

    #[test]
    fn only_the_file_manager_starts_the_ring() {
        assert!(is_file_manager_class("CabinetWClass"));
        assert!(is_file_manager_class("Progman"));
        assert!(!is_file_manager_class("Chrome_WidgetWin_1"));
    }

    #[test]
    fn the_settings_default_to_the_ring_on_and_no_background() {
        assert_eq!(
            RingSettings::default(),
            RingSettings {
                ring: true,
                background: false
            }
        );
        let read: RingSettings =
            serde_json::from_str(r#"{"ring":false,"background":true}"#).unwrap();
        assert!(!read.ring && read.background);
    }

    #[test]
    fn the_launch_agent_starts_the_app_in_the_background() {
        let plist = launch_agent("/Applications/محرر PDF.app/Contents/MacOS/warraq-desktop");
        assert!(plist
            .contains("<string>/Applications/محرر PDF.app/Contents/MacOS/warraq-desktop</string>"));
        assert!(plist.contains("<string>--background</string>"));
        assert!(launch_agent("a&b").contains("a&amp;b"));
    }
}
