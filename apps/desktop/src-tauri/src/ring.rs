//! The ring: hold Ctrl or Shift (Option or Command on a Mac) and drag files
//! out of File Explorer or Finder, and a ring of tools opens at the pointer; let the
//! files go on a tool and its quick window opens (`quick.rs`); let them go in
//! the middle and the ring stays, to click a tool. The idea is
//! Filee's (github.com/KnifeLemon/Filee, MIT); none of its code is used.
//!
//! A watcher sees the system's mouse: a look every few milliseconds at the
//! mouse button and the keys, and on macOS the system's drag pasteboard
//! too (none of which needs a permission). It
//! notices a drag that started with the key held, from any window. The ring
//! is invisible until files are dragged over it, so a drag of anything else
//! shows nothing (Filee's approach). The ring itself is a small transparent window that
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
use tauri_plugin_fs::FsExt;

pub const BACKGROUND_FLAG: &str = "--background";
pub const LABEL: &str = "ring";
/// The ring's side, in points: the ring and, round it, the half circle a
/// group opens (`ringGeometry.ts`, RING_SIZE).
const SIDE: f64 = 420.0;
/// How far the pointer moves, in pixels, before a press is a drag.
pub const DRAG_START: i32 = 8;
/// After the button is let go, how long a drop on the ring has to arrive.
const DROP_GRACE: Duration = Duration::from_millis(700);
const SETTINGS_FILE: &str = "quick-tools.json";

pub const SHOW_EVENT: &str = "ring://show";
pub const FILES_EVENT: &str = "ring://files";
pub const OVER_EVENT: &str = "ring://over";
pub const DROP_EVENT: &str = "ring://drop";
/// The ring opened by its keyboard shortcut, already holding the selected files.
pub const HOLD_EVENT: &str = "ring://hold";
/// Opens the ring at the pointer on the files selected in File Explorer or
/// Finder, waiting for a click, unless Settings chose other keys.
pub const SHORTCUT: &str = "CommandOrControl+Alt+Z";
/// The ring's size from Settings: small, as made, or large.
pub const SCALES: [f64; 3] = [0.85, 1.0, 1.2];

static ENABLED: AtomicBool = AtomicBool::new(true);
/// The ring's scale (`SCALES`), in thousandths.
static SCALE: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1000);
/// The keys the shortcut is on now, to take them off when they change.
static CURRENT_SHORTCUT: Mutex<String> = Mutex::new(String::new());
/// The ring is running a tool on files let go on it: no new ring until done.
static BUSY: AtomicBool = AtomicBool::new(false);
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
    /// Files are being dragged with no key held (from the file manager on
    /// Windows); the pointer is here, in the same units: ZOOD's drop zone
    /// comes down from the top (`sort.rs`).
    Dragging { x: f64, y: f64 },
    /// The button was let go.
    End,
}

/// The ring's settings, kept beside the app's data so a `--background`
/// start (which runs no interface) knows them. Files written before the
/// size and the shortcut existed read with their defaults.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RingSettings {
    pub ring: bool,
    pub background: bool,
    #[serde(default = "default_scale")]
    pub scale: f64,
    #[serde(default = "default_shortcut")]
    pub shortcut: String,
    /// The key held while dragging that opens the ring (`DragKey`).
    #[serde(default = "default_drag_key", rename = "dragKey")]
    pub drag_key: String,
    /// Files dragged with no key bring ZOOD's drop zone down from the top (`sort.rs`).
    #[serde(default = "default_drop_zone", rename = "dropZone")]
    pub drop_zone: bool,
}

/// The key that, held while files are dragged, opens the ring. `Any` is
/// as made: Ctrl or Shift on Windows, Option or Command on a Mac.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DragKey {
    Any,
    Ctrl,
    Shift,
    /// Alt on Windows; Option on a Mac.
    Alt,
    /// The Windows key; Command on a Mac.
    Meta,
}

impl DragKey {
    pub fn from_name(name: &str) -> DragKey {
        match name {
            "ctrl" => DragKey::Ctrl,
            "shift" => DragKey::Shift,
            "alt" => DragKey::Alt,
            "meta" => DragKey::Meta,
            _ => DragKey::Any,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            DragKey::Any => "any",
            DragKey::Ctrl => "ctrl",
            DragKey::Shift => "shift",
            DragKey::Alt => "alt",
            DragKey::Meta => "meta",
        }
    }

    fn code(self) -> u8 {
        match self {
            DragKey::Any => 0,
            DragKey::Ctrl => 1,
            DragKey::Shift => 2,
            DragKey::Alt => 3,
            DragKey::Meta => 4,
        }
    }

    fn from_code(code: u8) -> DragKey {
        match code {
            1 => DragKey::Ctrl,
            2 => DragKey::Shift,
            3 => DragKey::Alt,
            4 => DragKey::Meta,
            _ => DragKey::Any,
        }
    }
}

static DRAG_KEY: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);

fn drag_key() -> DragKey {
    DragKey::from_code(DRAG_KEY.load(Ordering::Relaxed))
}

fn default_scale() -> f64 {
    1.0
}

fn default_shortcut() -> String {
    SHORTCUT.to_string()
}

fn default_drop_zone() -> bool {
    true
}

fn default_drag_key() -> String {
    DragKey::Any.name().to_string()
}

impl Default for RingSettings {
    fn default() -> Self {
        RingSettings {
            ring: true,
            background: false,
            scale: default_scale(),
            shortcut: default_shortcut(),
            drag_key: default_drag_key(),
            drop_zone: default_drop_zone(),
        }
    }
}

/// The nearest of the three sizes, so a hand-edited file cannot make a ring
/// larger than any screen.
pub fn nearest_scale(scale: f64) -> f64 {
    SCALES
        .iter()
        .copied()
        .min_by(|a, b| (a - scale).abs().total_cmp(&(b - scale).abs()))
        .unwrap_or(1.0)
}

fn scale() -> f64 {
    f64::from(SCALE.load(Ordering::Relaxed)) / 1000.0
}

/// The files selected in the File Explorer window in front, or in Finder:
/// what the ring's shortcut opens on, and what Ask ZOOD runs a tool on.
pub fn selected_files() -> Vec<PathBuf> {
    shortcut::parse(&shortcut::selected(shortcut::front_window()))
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
        // One write per line, so lines from two threads do not interleave.
        let _ = file.write_all(format!("{seconds} {line}\n").as_bytes());
    }
}

/// Does a drag from `start` to `now` count, with the key held?
pub fn is_drag(start: (i32, i32), now: (i32, i32), key_held: bool) -> bool {
    let (dx, dy) = (now.0 - start.0, now.1 - start.1);
    key_held && dx * dx + dy * dy >= DRAG_START * DRAG_START
}

/// Where the ring's window goes: centred on the pointer, but moved as
/// little as needed to stay whole inside `area` (the screen's work area:
/// left, top, width, height), as Filee places its donut.
pub fn place(at: (f64, f64), side: f64, area: (f64, f64, f64, f64)) -> (f64, f64) {
    let (left, top, width, height) = area;
    let clamp = |centre: f64, start: f64, length: f64| {
        (centre - side / 2.0).clamp(start, (start + length - side).max(start))
    };
    (clamp(at.0, left, width), clamp(at.1, top, height))
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
        let log = path.with_file_name("ring.log");
        // A full log from runs before starts again, so this run's lines show.
        if std::fs::metadata(&log).is_ok_and(|m| m.len() >= LOG_LIMIT) {
            let _ = std::fs::remove_file(&log);
        }
        let _ = LOG.set(log);
    }
    log(&format!(
        "started; ring {}",
        if settings.ring { "on" } else { "off" }
    ));
    ENABLED.store(settings.ring, Ordering::Relaxed);
    crate::sort::set_zone(settings.drop_zone);
    DRAG_KEY.store(
        DragKey::from_name(&settings.drag_key).code(),
        Ordering::Relaxed,
    );
    SCALE.store(
        (nearest_scale(settings.scale) * 1000.0) as u32,
        Ordering::Relaxed,
    );
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
                Gesture::Start { x, y } => {
                    crate::sort::hide_zone(&handle);
                    show(&handle, x, y)
                }
                Gesture::Dragging { x, y } => crate::sort::dragging(&handle, x, y),
                Gesture::End => {
                    crate::sort::released(&handle);
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
        crate::sort::prepare(&handle);
        crate::ask::prepare(&handle);
    });
    #[cfg(target_os = "windows")]
    windows::watch();
    #[cfg(target_os = "macos")]
    macos::watch();
    shortcut::register(app, &settings.shortcut);
}

fn ring_window<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    if let Some(window) = app.get_webview_window(LABEL) {
        return Some(window);
    }
    let builder =
        WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html?ring=1".into()))
            .title("ZOOD PDF")
            .inner_size(SIDE * scale(), SIDE * scale())
            .decorations(false)
            .resizable(false)
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(false)
            .focusable(false)
            // On macOS this needs Tauri's macos-private-api (Cargo.toml).
            .transparent(true);
    // Made ready out of sight, so it takes drops on Windows (`parked.rs`).
    let window = crate::parked::hidden(builder)
        .build()
        .map_err(|e| log(&format!("cannot make the ring window: {e}")))
        .ok()?;
    crate::parked::made(&window);
    Some(window)
}

fn show<R: Runtime>(app: &AppHandle<R>, x: f64, y: f64) {
    if !enabled() || BUSY.load(Ordering::Relaxed) {
        return;
    }
    if let Ok(mut dropped) = DROPPED.lock() {
        *dropped = None;
    }
    let Some(window) = ring_window(app) else {
        return;
    };
    // The screen under the pointer, in the units the watcher gives: physical
    // pixels on Windows, points on macOS. The window is sized for that
    // screen's scale every time, so the ring is never larger than its window
    // (a screen at 125% or 150% cut it off before), and kept whole on it.
    let windows = cfg!(target_os = "windows");
    let screens = app.available_monitors().unwrap_or_default();
    let unit = |m: &tauri::Monitor| if windows { 1.0 } else { m.scale_factor() };
    let screen = screens.iter().find(|m| {
        let (left, top) = (
            f64::from(m.position().x) / unit(m),
            f64::from(m.position().y) / unit(m),
        );
        let (width, height) = (
            f64::from(m.size().width) / unit(m),
            f64::from(m.size().height) / unit(m),
        );
        x >= left && x < left + width && y >= top && y < top + height
    });
    let area = screen.map(|m| {
        let work = m.work_area();
        (
            f64::from(work.position.x) / unit(m),
            f64::from(work.position.y) / unit(m),
            f64::from(work.size.width) / unit(m),
            f64::from(work.size.height) / unit(m),
        )
    });
    let side = if windows {
        (SIDE * scale() * screen.map_or(1.0, |m| m.scale_factor())).round()
    } else {
        SIDE * scale()
    };
    let (left, top) = area.map_or((x - side / 2.0, y - side / 2.0), |a| place((x, y), side, a));
    if windows {
        let _ = window.set_size(tauri::PhysicalSize::new(side, side));
        let _ = window.set_position(tauri::PhysicalPosition::new(left, top));
    } else {
        let _ = window.set_size(tauri::LogicalSize::new(side, side));
        let _ = window.set_position(tauri::LogicalPosition::new(left, top));
    }
    let _ = window.emit_to(LABEL, SHOW_EVENT, ());
    let _ = window.show();
    if let (Ok(at), Ok(size)) = (window.outer_position(), window.outer_size()) {
        log(&format!(
            "ring window at {},{} size {}x{}",
            at.x, at.y, size.width, size.height
        ));
    }
}

pub fn hide<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(LABEL) {
        crate::parked::away(&window);
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
                .filter_map(|p| crate::lnk::file_of(p))
                .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
                .collect::<Vec<String>>();
            log(&format!("{} files dragged onto the ring", names.len()));
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
            log("the drag left the ring");
            let _ = window.emit_to(LABEL, OVER_EVENT, None::<PointPayload>);
        }
        tauri::DragDropEvent::Drop { paths, .. } => {
            let files: Vec<PathBuf> = paths
                .iter()
                .filter_map(|p| crate::lnk::file_of(p))
                .take(500)
                .collect();
            log(&format!("{} files let go on the ring", files.len()));
            if let Ok(mut dropped) = DROPPED.lock() {
                *dropped = Some(files);
            }
            let (x, y) = at.unwrap_or((-1.0, -1.0));
            let _ = window.emit_to(LABEL, DROP_EVENT, PointPayload { x, y });
        }
        _ => {}
    }
}

/// The files let go on the ring, for a tool the ring runs itself (with its
/// progress round the ring). They stay held, so `ring_pick` can still hand
/// them to a quick window if the tool needs more (a password).
// Off the main thread on Windows, where it draws every window (`stall.rs`).
#[cfg_attr(windows, tauri::command(async))]
#[cfg_attr(not(windows), tauri::command)]
pub fn ring_take<R: Runtime>(app: AppHandle<R>) -> Vec<quick::QuickFile> {
    let files = DROPPED
        .lock()
        .ok()
        .and_then(|d| d.clone())
        .unwrap_or_default();
    let scope = app.fs_scope();
    for file in &files {
        let _ = scope.allow_file(file);
    }
    BUSY.store(!files.is_empty(), Ordering::Relaxed);
    log(&format!("running a tool on {} files", files.len()));
    quick::files_of(files)
}

/// The ring finished its tool: it goes, and the next drag can open it.
#[tauri::command]
pub fn ring_done<R: Runtime>(app: AppHandle<R>, done: usize, failed: usize) {
    if let Ok(mut dropped) = DROPPED.lock() {
        *dropped = None;
    }
    BUSY.store(false, Ordering::Relaxed);
    log(&format!("done: {done} made, {failed} failed"));
    hide(&app);
}

/// The ring's own place that sends the files to the connected phone.
const PHONE: &str = "phone";
/// The ring's place that sorts the files with ZOOD.
const SORT: &str = "sort";

/// A phone is connected to the remote now: the ring then has "To phone".
#[tauri::command]
pub fn ring_phone<R: Runtime>(app: AppHandle<R>) -> bool {
    crate::remote::has_phone(&app)
}

/// The tool the files were let go on (`none`: the middle, or off the ring).
/// `only`: of those files, these (the ones a tool run on the ring could not
/// open without their password).
// Off the main thread on Windows, where it draws every window (`stall.rs`).
#[cfg_attr(windows, tauri::command(async))]
#[cfg_attr(not(windows), tauri::command)]
pub fn ring_pick<R: Runtime>(app: AppHandle<R>, tool: String, only: Option<Vec<String>>) {
    BUSY.store(false, Ordering::Relaxed);
    let mut files = DROPPED
        .lock()
        .ok()
        .and_then(|mut d| d.take())
        .unwrap_or_default();
    if let Some(only) = only {
        files.retain(|file| {
            only.iter()
                .any(|path| file.as_path() == std::path::Path::new(path))
        });
    }
    hide(&app);
    log(&format!("picked {tool} for {} files", files.len()));
    if tool == "none" || files.is_empty() {
        return;
    }
    // To the phone: the files fly off the screen from where they were let go.
    // Read and sent on a thread of its own, so large files do not freeze
    // the windows.
    // Sort: the files go to a Sort window, which suggests what to do (`sort.rs`).
    if tool == SORT {
        crate::sort::open(&app, files);
        return;
    }
    if tool == PHONE {
        let from = crate::ask::eye::pointer();
        crate::remote::give_or_wait(&app, files, Some(from));
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

/// From Settings: the ring, keeping the app ready in the background (and
/// starting it at sign-in), the ring's size and its keyboard shortcut. A
/// shortcut the system will not take keeps the one before, and says so.
// Off the main thread on Windows, where it draws every window (`stall.rs`).
#[cfg_attr(windows, tauri::command(async))]
#[cfg_attr(not(windows), tauri::command)]
pub fn ring_configure<R: Runtime>(
    app: AppHandle<R>,
    ring: bool,
    background: bool,
    scale: Option<f64>,
    shortcut: Option<String>,
    drag_key: Option<String>,
    drop_zone: Option<bool>,
) -> Result<RingSettings, String> {
    let before = load_settings(&app);
    let scale = nearest_scale(scale.unwrap_or(before.scale));
    let key = DragKey::from_name(drag_key.as_deref().unwrap_or(&before.drag_key));
    let mut settings = RingSettings {
        ring,
        background,
        scale,
        shortcut: before.shortcut.clone(),
        drag_key: key.name().to_string(),
        drop_zone: drop_zone.unwrap_or(before.drop_zone),
    };
    if let Some(keys) = shortcut.filter(|keys| *keys != before.shortcut) {
        shortcut::replace(&app, &keys)?;
        settings.shortcut = keys;
    }
    SCALE.store((scale * 1000.0) as u32, Ordering::Relaxed);
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.set_size(tauri::LogicalSize::new(SIDE * scale, SIDE * scale));
    }
    ENABLED.store(ring, Ordering::Relaxed);
    DRAG_KEY.store(key.code(), Ordering::Relaxed);
    crate::sort::set_zone(settings.drop_zone);
    if settings.drop_zone {
        crate::sort::prepare(&app);
    } else {
        crate::sort::zone_off(&app);
    }
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

// Off the main thread on Windows, where it draws every window (`stall.rs`).
#[cfg_attr(windows, tauri::command(async))]
#[cfg_attr(not(windows), tauri::command)]
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
        // Ask ZOOD, the editor, recent files, Settings, the bubble, Quit (`presence.rs`).
        if let Ok(menu) = crate::presence::tray_menu(app) {
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
    use std::time::Duration;

    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, VK_CONTROL, VK_LBUTTON, VK_LWIN, VK_MENU, VK_RBUTTON, VK_RWIN, VK_SHIFT,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetAncestor, GetClassNameW, GetCursorPos, GetSystemMetrics, WindowFromPoint, GA_ROOT,
        SM_SWAPBUTTON,
    };

    use super::{drag_key, enabled, is_drag, log, send, DragKey, Gesture};

    /// How often the mouse and the keys are looked at.
    const TICK: Duration = Duration::from_millis(15);

    /// File Explorer's windows and the desktop: a drag from these may be of files.
    pub fn holds_files(class: &str) -> bool {
        matches!(
            class,
            "CabinetWClass" | "ExploreWClass" | "Progman" | "WorkerW"
        )
    }

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

    fn down(key: u16) -> bool {
        // SAFETY: a plain key state query.
        (unsafe { GetAsyncKeyState(i32::from(key)) } as u16 & 0x8000) != 0
    }

    /// The key chosen in Settings (Ctrl or Shift as made), held now.
    fn held() -> bool {
        match drag_key() {
            DragKey::Any => down(VK_CONTROL) || down(VK_SHIFT),
            DragKey::Ctrl => down(VK_CONTROL),
            DragKey::Shift => down(VK_SHIFT),
            DragKey::Alt => down(VK_MENU),
            DragKey::Meta => down(VK_LWIN) || down(VK_RWIN),
        }
    }

    /// The button that drags: the left one, or the right one when the
    /// person swapped them in Settings.
    fn dragging_button() -> bool {
        // SAFETY: a plain system setting query.
        let swapped = unsafe { GetSystemMetrics(SM_SWAPBUTTON) } != 0;
        down(if swapped { VK_RBUTTON } else { VK_LBUTTON })
    }

    fn pointer() -> Option<POINT> {
        let mut point = POINT { x: 0, y: 0 };
        // SAFETY: writes the pointer's place into `point`.
        (unsafe { GetCursorPos(&mut point) } != 0).then_some(point)
    }

    /// Watches by looking, as on a Mac: the button, the pointer and the keys
    /// are read every few milliseconds. A low-level mouse hook did this
    /// before, but Windows takes such a hook away without a word when one
    /// call is late (the computer busy, say with the on-device model), and
    /// the ring then never opened again until the app restarted.
    pub fn watch() {
        std::thread::spawn(|| {
            log("watching the mouse");
            let mut start: Option<(i32, i32)> = None;
            let mut shown = false;
            // The press was on File Explorer or the desktop; the drop zone was told.
            let mut from_files = false;
            let mut zoned = false;
            let mut last = (i32::MIN, i32::MIN);
            loop {
                std::thread::sleep(TICK);
                let pressed = dragging_button();
                let Some(point) = pointer() else { continue };
                let now = (point.x, point.y);
                match (pressed, start) {
                    (true, None) => {
                        start = Some(now);
                        shown = false;
                        zoned = false;
                        let held = held();
                        from_files = false;
                        if held || crate::sort::zone_on() {
                            let class = class_at(point);
                            from_files = holds_files(&class);
                            if held {
                                log(&format!("press with the key held, over a {class} window"));
                            }
                        }
                    }
                    (true, Some(from)) if !shown => {
                        if enabled() && is_drag(from, now, held()) {
                            shown = true;
                            log("drag with the key held: ring placed at the pointer");
                            send(Gesture::Start {
                                x: f64::from(now.0),
                                y: f64::from(now.1),
                            });
                        } else if from_files && now != last && is_drag(from, now, true) {
                            last = now;
                            zoned = true;
                            send(Gesture::Dragging {
                                x: f64::from(now.0),
                                y: f64::from(now.1),
                            });
                        }
                    }
                    (false, Some(_)) => {
                        start = None;
                        let shown = std::mem::take(&mut shown);
                        if shown | std::mem::take(&mut zoned) {
                            send(Gesture::End);
                        }
                    }
                    _ => {}
                }
            }
        });
    }
}

#[cfg(target_os = "macos")]
pub(crate) mod macos {
    use std::time::Duration;

    use objc2::rc::{autoreleasepool, Retained};
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_foundation::{NSPoint, NSRect, NSString};

    use super::{drag_key, enabled, is_drag, log, send, DragKey, Gesture};

    const SHIFT_KEY: usize = 1 << 17;
    const CONTROL_KEY: usize = 1 << 18;
    const OPTION_KEY: usize = 1 << 19;
    const COMMAND_KEY: usize = 1 << 20;
    /// How often the mouse and the drag pasteboard are looked at.
    const TICK: Duration = Duration::from_millis(30);

    /// The pointer, in points from the top-left of the main screen.
    pub(crate) fn pointer() -> (f64, f64) {
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
            let mut zoned = false;
            let mut last = (i32::MIN, i32::MIN);
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
                            zoned = false;
                        }
                        (true, Some((start, count))) if !shown => {
                            let wanted = match drag_key() {
                                DragKey::Any => OPTION_KEY | COMMAND_KEY,
                                DragKey::Ctrl => CONTROL_KEY,
                                DragKey::Shift => SHIFT_KEY,
                                DragKey::Alt => OPTION_KEY,
                                DragKey::Meta => COMMAND_KEY,
                            };
                            let key = flags & wanted != 0;
                            let files = change_count(&board) != count
                                && is_drag(start, now, true)
                                && holds_files(&board);
                            if files && key && enabled() {
                                shown = true;
                                log("drag of files with the key held: ring shown");
                                send(Gesture::Start { x, y });
                            } else if files && !key && now != last && crate::sort::zone_on() {
                                last = now;
                                zoned = true;
                                send(Gesture::Dragging { x, y });
                            }
                        }
                        (false, Some(_)) => {
                            down = None;
                            let shown = std::mem::take(&mut shown);
                            if shown | std::mem::take(&mut zoned) {
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
        assert!(!is_drag((0, 0), (4, 4), true));
        assert!(is_drag((0, 0), (6, 6), true));
        assert!(!is_drag((0, 0), (40, 0), false));
    }

    #[test]
    fn the_ring_stays_whole_on_the_screen() {
        let screen = (0.0, 0.0, 1920.0, 1040.0);
        // In the middle: centred on the pointer.
        assert_eq!(place((800.0, 500.0), 300.0, screen), (650.0, 350.0));
        // At the right and bottom edges: moved in just enough.
        assert_eq!(place((1910.0, 1030.0), 300.0, screen), (1620.0, 740.0));
        // At the top-left corner, and on a second screen to the left.
        assert_eq!(place((3.0, 2.0), 450.0, screen), (0.0, 0.0));
        assert_eq!(
            place((-1900.0, 20.0), 450.0, (-1920.0, 0.0, 1920.0, 1080.0)),
            (-1920.0, 0.0)
        );
        // A screen smaller than the ring: its top-left corner.
        assert_eq!(
            place((50.0, 50.0), 300.0, (0.0, 0.0, 200.0, 200.0)),
            (0.0, 0.0)
        );
    }

    #[test]
    fn the_settings_default_to_the_ring_on_and_no_background() {
        assert_eq!(
            RingSettings::default(),
            RingSettings {
                ring: true,
                background: false,
                scale: 1.0,
                shortcut: SHORTCUT.to_string(),
                drag_key: "any".to_string(),
                drop_zone: true,
            }
        );
        // A file from before the size and the shortcut reads with their defaults.
        let read: RingSettings =
            serde_json::from_str(r#"{"ring":false,"background":true}"#).unwrap();
        assert!(!read.ring && read.background);
        assert_eq!(read.scale, 1.0);
        assert_eq!(read.shortcut, SHORTCUT);
        assert_eq!(read.drag_key, "any");
        assert!(
            read.drop_zone,
            "the drop zone is on for those who had the ring before"
        );
        assert_eq!(DragKey::from_name("shift"), DragKey::Shift);
        assert_eq!(DragKey::from_name("nonsense"), DragKey::Any);
        assert_eq!(nearest_scale(9.0), 1.2);
        assert_eq!(nearest_scale(0.1), 0.85);
    }

    #[test]
    fn the_launch_agent_starts_the_app_in_the_background() {
        let plist = launch_agent("/Applications/ZOOD PDF.app/Contents/MacOS/warraq-desktop");
        assert!(plist
            .contains("<string>/Applications/ZOOD PDF.app/Contents/MacOS/warraq-desktop</string>"));
        assert!(plist.contains("<string>--background</string>"));
        assert!(launch_agent("a&b").contains("a&amp;b"));
    }
}

/// The ring's keyboard shortcut: the files selected in File Explorer (the
/// window in front) or Finder, and the ring at the pointer holding them,
/// waiting for a click on a tool.
mod shortcut {
    use std::path::PathBuf;
    use std::sync::atomic::Ordering;

    use tauri::{AppHandle, Emitter, Runtime};
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

    use super::{
        log, show, FilesPayload, BUSY, CURRENT_SHORTCUT, DROPPED, FILES_EVENT, HOLD_EVENT, LABEL,
        SHORTCUT,
    };

    /// The most files the shortcut takes, as a drag would.
    const MAX_FILES: usize = 500;

    /// Puts the shortcut on `keys`, or on the default when those will not do.
    pub fn register<R: Runtime>(app: &AppHandle<R>, keys: &str) {
        if listen(app, keys).is_err() && keys != SHORTCUT {
            log("the chosen shortcut could not be set; using the default");
            let _ = listen(app, SHORTCUT);
        }
    }

    /// Moves the shortcut to `keys`; on failure it stays where it was.
    pub fn replace<R: Runtime>(app: &AppHandle<R>, keys: &str) -> Result<(), String> {
        let old = CURRENT_SHORTCUT
            .lock()
            .map(|k| k.clone())
            .unwrap_or_default();
        if !old.is_empty() {
            let _ = app.global_shortcut().unregister(old.as_str());
        }
        listen(app, keys).map_err(|e| {
            if !old.is_empty() {
                let _ = listen(app, &old);
            }
            format!("E_SHORTCUT: {e}")
        })
    }

    fn listen<R: Runtime>(app: &AppHandle<R>, keys: &str) -> Result<(), String> {
        let result = app.global_shortcut().on_shortcut(keys, |app, _, event| {
            if event.state != ShortcutState::Pressed || !super::enabled() {
                return;
            }
            // Which window is in front, read now, before anything else can be.
            let front = front_window();
            let app = app.clone();
            std::thread::spawn(move || open(&app, front));
        });
        match result {
            Ok(()) => {
                log("keyboard shortcut ready");
                if let Ok(mut current) = CURRENT_SHORTCUT.lock() {
                    *current = keys.to_string();
                }
                Ok(())
            }
            Err(e) => {
                log(&format!("the keyboard shortcut could not be set: {e}"));
                Err(e.to_string())
            }
        }
    }

    fn open<R: Runtime>(app: &AppHandle<R>, front: isize) {
        if BUSY.load(Ordering::Relaxed) {
            return;
        }
        let files = parse(&selected(front));
        log(&format!("shortcut: {} files selected", files.len()));
        if files.is_empty() {
            return;
        }
        let Some((x, y)) = pointer() else { return };
        show(app, x, y);
        let names = files
            .iter()
            .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
            .collect();
        if let Ok(mut dropped) = DROPPED.lock() {
            *dropped = Some(files);
        }
        let _ = app.emit_to(LABEL, FILES_EVENT, FilesPayload { names });
        let _ = app.emit_to(LABEL, HOLD_EVENT, ());
    }

    /// One path a line, as the scripts below print them: existing files only.
    pub fn parse(output: &str) -> Vec<PathBuf> {
        let mut files: Vec<PathBuf> = Vec::new();
        for line in output.lines().map(str::trim).filter(|l| !l.is_empty()) {
            let path = PathBuf::from(line);
            if path.is_absolute() && path.is_file() && !files.contains(&path) {
                files.push(path);
                if files.len() >= MAX_FILES {
                    break;
                }
            }
        }
        files
    }

    #[cfg(target_os = "windows")]
    pub(super) fn front_window() -> isize {
        // SAFETY: no arguments; returns a handle or null.
        unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow() as isize }
    }

    #[cfg(not(target_os = "windows"))]
    pub(super) fn front_window() -> isize {
        0
    }

    /// The selection of the File Explorer window in front, through the
    /// Shell's own scripting interface.
    #[cfg(target_os = "windows")]
    pub(super) fn selected(front: isize) -> String {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let script = format!(
            "$OutputEncoding=[Console]::OutputEncoding=[Text.Encoding]::UTF8;\
             foreach($w in (New-Object -ComObject Shell.Application).Windows()){{\
             if($w.HWND -eq {front}){{foreach($i in $w.Document.SelectedItems()){{$i.Path}}}}}}"
        );
        std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|out| String::from_utf8_lossy(&out.stdout).into_owned())
            .unwrap_or_default()
    }

    /// Finder's selection (macOS asks once whether the app may read it).
    #[cfg(target_os = "macos")]
    pub(super) fn selected(_front: isize) -> String {
        std::process::Command::new("osascript")
            .args([
                "-e",
                "tell application \"Finder\"",
                "-e",
                "set out to \"\"",
                "-e",
                "repeat with f in (get selection as alias list)",
                "-e",
                "set out to out & POSIX path of f & linefeed",
                "-e",
                "end repeat",
                "-e",
                "return out",
                "-e",
                "end tell",
            ])
            .output()
            .map(|out| String::from_utf8_lossy(&out.stdout).into_owned())
            .unwrap_or_default()
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    pub(super) fn selected(_front: isize) -> String {
        String::new()
    }

    /// Where the pointer is, in the units `show` takes.
    #[cfg(target_os = "windows")]
    fn pointer() -> Option<(f64, f64)> {
        let mut at = windows_sys::Win32::Foundation::POINT { x: 0, y: 0 };
        // SAFETY: writes the cursor's position into `at`.
        let ok = unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos(&mut at) };
        (ok != 0).then(|| (f64::from(at.x), f64::from(at.y)))
    }

    #[cfg(target_os = "macos")]
    fn pointer() -> Option<(f64, f64)> {
        Some(super::macos::pointer())
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    fn pointer() -> Option<(f64, f64)> {
        None
    }

    #[cfg(test)]
    mod tests {
        #[test]
        fn only_existing_files_are_taken_once() {
            let here = std::env::current_dir().unwrap().join("Cargo.toml");
            let line = here.to_string_lossy().into_owned();
            let output = format!(
                "{line}\r\n\n{line}\nrelative.pdf\n/no/such/file.pdf\n{}\n",
                std::env::temp_dir().display()
            );
            assert_eq!(super::parse(&output), vec![here]);
        }
    }
}
