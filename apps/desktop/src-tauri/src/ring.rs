//! The ring: hold Ctrl or Shift (Option or Command on a Mac) and drag files
//! out of File Explorer or Finder, and a ring of tools opens at the pointer; let the
//! files go on a tool and its quick window opens (`quick.rs`). The idea is
//! Filee's (github.com/KnifeLemon/Filee, MIT); none of its code is used.
//!
//! A watcher sees the system's mouse: a low-level mouse hook on Windows,
//! and on macOS a look every few milliseconds at the mouse button, the keys
//! and the system's drag pasteboard (none of which needs a permission). It
//! only notices a drag of files that started with the key held, from
//! Explorer on Windows and from any app on a Mac. The ring itself is a small transparent window that
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
static LOG: OnceLock<PathBuf> = OnceLock::new();
/// The ring's log stops growing here; it is for finding why the ring did
/// not open, so its first lines are the ones that matter.
const LOG_LIMIT: u64 = 64 * 1024;
/// How long after start the ring window is made, so the first drag finds
/// it ready instead of waiting for a web view to load.
const PREPARE_AFTER: Duration = Duration::from_secs(3);

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

/// One line in `ring.log` beside the app's data: what the watcher saw.
/// Only what kind of window was pressed and whether the ring opened; never
/// a file's name. It stays on this computer.
pub fn log(line: &str) {
    use std::io::Write;
    let Some(path) = LOG.get() else { return };
    if std::fs::metadata(path).map(|m| m.len()).unwrap_or(0) >= LOG_LIMIT {
        return;
    }
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(file, "{seconds} {line}");
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
    if let Some(path) = settings_path(app) {
        let _ = LOG.set(path.with_file_name("ring.log"));
    }
    log(&format!(
        "started; ring {}",
        if settings.ring { "on" } else { "off" }
    ));
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
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(PREPARE_AFTER);
        if enabled() {
            let _ = ring_window(&handle);
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
        .map_err(|e| log(&format!("cannot make the ring window: {e}")))
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
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL, VK_SHIFT};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetAncestor, GetClassNameW, GetMessageW, SetWindowsHookExW,
        WindowFromPoint, GA_ROOT, MSG, MSLLHOOKSTRUCT, WH_MOUSE_LL, WM_LBUTTONDOWN, WM_LBUTTONUP,
        WM_MOUSEMOVE,
    };

    use super::{enabled, is_drag, is_file_manager_class, log, send, Gesture};

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

    /// Ctrl or Shift, held now.
    fn held() -> bool {
        // SAFETY: plain key state queries.
        let down = |key: u16| (unsafe { GetAsyncKeyState(i32::from(key)) } as u16 & 0x8000) != 0;
        down(VK_CONTROL) || down(VK_SHIFT)
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
                    let class = class_at(info.pt);
                    let from_files = enabled() && is_file_manager_class(&class);
                    FROM_FILES.store(from_files, Ordering::Relaxed);
                    if held() {
                        log(&format!(
                            "press with Ctrl or Shift held, over a {class} window"
                        ));
                    }
                }
                WM_MOUSEMOVE
                    if DOWN.load(Ordering::Relaxed)
                        && FROM_FILES.load(Ordering::Relaxed)
                        && !SHOWN.load(Ordering::Relaxed) =>
                {
                    let control = held();
                    let start = (
                        START_X.load(Ordering::Relaxed),
                        START_Y.load(Ordering::Relaxed),
                    );
                    if is_drag(start, point, control) {
                        SHOWN.store(true, Ordering::Relaxed);
                        log("drag from the file manager with Ctrl or Shift: ring shown");
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
                    log("the mouse hook could not be set");
                    return;
                }
                log("watching the mouse");
                let mut message: MSG = std::mem::zeroed();
                while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 {}
            }
        });
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use std::time::Duration;

    use objc2::rc::{autoreleasepool, Retained};
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_foundation::{NSPoint, NSRect, NSString};

    use super::{enabled, is_drag, log, send, Gesture};

    const OPTION_KEY: usize = 1 << 19;
    const COMMAND_KEY: usize = 1 << 20;
    /// How often the mouse and the drag pasteboard are looked at.
    const TICK: Duration = Duration::from_millis(30);

    /// The pointer, in points from the top-left of the main screen.
    fn pointer() -> (f64, f64) {
        // SAFETY: NSEvent's and NSScreen's documented class messages.
        unsafe {
            let at: NSPoint = msg_send![class!(NSEvent), mouseLocation];
            let screens: Option<Retained<AnyObject>> = msg_send![class!(NSScreen), screens];
            let height = screens
                .filter(|screens| {
                    let count: usize = msg_send![&**screens, count];
                    count > 0
                })
                .map(|screens| {
                    let main: Retained<AnyObject> = msg_send![&*screens, objectAtIndex: 0usize];
                    let frame: NSRect = msg_send![&*main, frame];
                    frame.size.height
                })
                .unwrap_or(0.0);
            (at.x, height - at.y)
        }
    }

    /// The system's drag pasteboard: every drag of files writes to it, so
    /// its change count moves when one starts.
    fn drag_pasteboard() -> Option<Retained<AnyObject>> {
        let name = NSString::from_str("Apple CFPasteboard drag");
        // SAFETY: NSPasteboard's documented class message; nil-checked.
        unsafe { msg_send![class!(NSPasteboard), pasteboardWithName: &*name] }
    }

    fn change_count(board: &AnyObject) -> isize {
        // SAFETY: NSPasteboard's documented property.
        unsafe { msg_send![board, changeCount] }
    }

    /// Whether what is being dragged is files (file URLs).
    fn holds_files(board: &AnyObject) -> bool {
        // SAFETY: NSPasteboard's documented property, an NSArray of NSString.
        unsafe {
            let types: Option<Retained<AnyObject>> = msg_send![board, types];
            let Some(types) = types else { return false };
            let count: usize = msg_send![&*types, count];
            (0..count.min(64)).any(|k| {
                let item: Retained<NSString> = msg_send![&*types, objectAtIndex: k];
                let item = item.to_string();
                item == "public.file-url" || item == "NSFilenamesPboardType"
            })
        }
    }

    /// The left button and the modifier keys, as the system has them now.
    fn buttons_and_keys() -> (bool, usize) {
        // SAFETY: NSEvent's documented class properties.
        unsafe {
            let buttons: usize = msg_send![class!(NSEvent), pressedMouseButtons];
            let flags: usize = msg_send![class!(NSEvent), modifierFlags];
            (buttons & 1 != 0, flags)
        }
    }

    /// Watches by looking: while another app drags, event monitors are not
    /// told of the mouse, but the button, the keys and the drag pasteboard
    /// can always be read. A drag of files that begins with Option (or
    /// Command) held, and moves far enough, opens the ring.
    pub fn watch() {
        std::thread::spawn(|| {
            let mut down: Option<((i32, i32), isize)> = None;
            let mut shown = false;
            loop {
                std::thread::sleep(TICK);
                autoreleasepool(|_| {
                    let Some(board) = drag_pasteboard() else {
                        return;
                    };
                    let (pressed, flags) = buttons_and_keys();
                    let (x, y) = pointer();
                    let now = (x as i32, y as i32);
                    match (pressed, down) {
                        (true, None) => {
                            down = Some((now, change_count(&board)));
                            shown = false;
                        }
                        (true, Some((start, count))) if !shown && enabled() => {
                            let key = flags & (OPTION_KEY | COMMAND_KEY) != 0;
                            if change_count(&board) != count
                                && is_drag(start, now, key)
                                && holds_files(&board)
                            {
                                shown = true;
                                log("drag of files with Option or Command: ring shown");
                                send(Gesture::Start { x, y });
                            }
                        }
                        (false, Some(_)) => {
                            down = None;
                            if std::mem::take(&mut shown) {
                                send(Gesture::End);
                            }
                        }
                        _ => {}
                    }
                });
            }
        });
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
