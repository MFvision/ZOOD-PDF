//! Show me, Explain this and Do it for me: what the host does for Ask
//! ZOOD's pointer (`packages/ui/src/ask/guide.ts` runs the steps).
//!
//! - `ask_look_again` takes a new picture of what was asked about, after a
//!   click changed the screen, for the model to place the next step on.
//! - `ask_watch_clicks` tells the island where the person clicks while Show
//!   me waits for them — the mouse button and where it is, nothing else,
//!   and only until the guide ends or five minutes pass.
//! - `ask_click` is Do it for me's one hand: a left click at a step, and
//!   only when ZOOD PDF itself was in front when the person asked. In any
//!   other app Ask ZOOD only points. Before each click it checks the mouse
//!   is where its last click left it; when the person moved it, it stops
//!   (`E_MOVED`) until they say go on.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime, State};

use super::{eye, AskState, LABEL};

/// Where the person clicked, 0..1 across and down the screen asked about.
pub const CLICKED_EVENT: &str = "ask://clicked";
/// How long Show me waits for clicks at the longest.
const WATCH_AT_MOST: Duration = Duration::from_secs(300);
/// How often the mouse button is looked at.
const WATCH_EVERY: Duration = Duration::from_millis(25);
/// The mouse moved further than this (in the system's units) since Ask
/// ZOOD's last click means the person took it back.
const MOVED_BY: f64 = 10.0;

#[derive(Clone, Copy, Debug, Serialize)]
pub struct Clicked {
    pub x: f64,
    pub y: f64,
}

/// Counts the watches begun, so an old one stops when a new one starts.
static WATCH_TURN: AtomicU64 = AtomicU64::new(0);
/// Where Ask ZOOD's last click left the mouse.
static LAST_CLICK: Mutex<Option<(f64, f64)>> = Mutex::new(None);

/// The screen the question was asked on: the monitor's area in the system's
/// units, and the window the picture is of, when it is not the whole screen.
/// With no picture (the buttons read by name, `controls.rs`), the screen the
/// pointer was on.
pub(super) fn areas(state: &AskState) -> Option<(eye::Area, Option<eye::Area>)> {
    let moment = state.moment.lock().ok()?;
    if let Some(screen) = moment.screen.as_ref() {
        return Some((screen.monitor, screen.window));
    }
    let (position, size, scale) = moment.monitor?;
    Some((system_area(position, size, scale), None))
}

/// A monitor as Tauri places it, in the system's own units: pixels on
/// Windows, points on a Mac.
fn system_area(
    position: tauri::PhysicalPosition<i32>,
    size: tauri::PhysicalSize<u32>,
    scale: f64,
) -> eye::Area {
    let unit = if cfg!(target_os = "macos") && scale > 0.0 {
        scale
    } else {
        1.0
    };
    eye::Area {
        x: f64::from(position.x) / unit,
        y: f64::from(position.y) / unit,
        width: f64::from(size.width) / unit,
        height: f64::from(size.height) / unit,
    }
}

/// A step the model placed — thousandths of the picture — as 0..1 of the
/// screen it is on, and as the system's own coordinates.
pub fn place(
    x: f64,
    y: f64,
    monitor: eye::Area,
    window: Option<eye::Area>,
) -> ((f64, f64), (f64, f64)) {
    let (fx, fy) = eye::fraction(x, y);
    let (fx, fy) = match window {
        Some(window) => eye::on_monitor(fx, fy, window, monitor),
        None => (fx, fy),
    };
    (
        (fx, fy),
        (
            monitor.x + fx * monitor.width,
            monitor.y + fy * monitor.height,
        ),
    )
}

/// The mouse at `at`, as 0..1 of `monitor`, or None off it.
pub fn on_screen(at: (f64, f64), monitor: eye::Area) -> Option<Clicked> {
    if monitor.width <= 0.0 || monitor.height <= 0.0 {
        return None;
    }
    let x = (at.0 - monitor.x) / monitor.width;
    let y = (at.1 - monitor.y) / monitor.height;
    ((0.0..=1.0).contains(&x) && (0.0..=1.0).contains(&y)).then_some(Clicked { x, y })
}

/// The person moved the mouse away from where Ask ZOOD's click left it.
pub fn moved(last: Option<(f64, f64)>, now: (f64, f64)) -> bool {
    last.is_some_and(|(x, y)| (now.0 - x).hypot(now.1 - y) > MOVED_BY)
}

/// A new picture of what was asked about, for the next step: the same
/// window when the picture was of one, else the same screen. The pointer
/// is hidden for it, so the model does not see Ask ZOOD's own arrow.
#[tauri::command]
pub async fn ask_look_again<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AskState>,
) -> Result<(), String> {
    let (monitor, window) =
        areas(&state).ok_or_else(|| "E_SCREEN: nothing was looked at".to_string())?;
    super::hide_point(&app);
    let screen = tauri::async_runtime::spawn_blocking(move || {
        // The pointer window goes before the picture is taken.
        std::thread::sleep(Duration::from_millis(160));
        match window {
            Some(_) => eye::capture_front().map(|front| front.screen),
            None => eye::capture_at(monitor),
        }
    })
    .await
    .map_err(|e| format!("E_SCREEN: {e}"))??;
    let mut moment = state.moment.lock().map_err(|e| e.to_string())?;
    moment.screen = Some(screen);
    Ok(())
}

/// Starts (or stops) telling the island where the person clicks, while
/// Show me waits for them to click a step.
#[tauri::command]
pub fn ask_watch_clicks<R: Runtime>(app: AppHandle<R>, state: State<'_, AskState>, on: bool) {
    let turn = WATCH_TURN.fetch_add(1, Ordering::Relaxed) + 1;
    if !on {
        return;
    }
    let Some((monitor, _)) = areas(&state) else {
        return;
    };
    std::thread::spawn(move || {
        let until = Instant::now() + WATCH_AT_MOST;
        // A button already down when the watch starts is not a click.
        let mut was_down = mouse::left_down();
        while WATCH_TURN.load(Ordering::Relaxed) == turn && Instant::now() < until {
            std::thread::sleep(WATCH_EVERY);
            let down = mouse::left_down();
            if was_down && !down {
                if let Some(clicked) = on_screen(eye::pointer(), monitor) {
                    let _ = app.emit_to(LABEL, CLICKED_EVENT, clicked);
                }
            }
            was_down = down;
        }
    });
}

/// Stops watching clicks, when the island goes.
pub fn stop_watching() {
    WATCH_TURN.fetch_add(1, Ordering::Relaxed);
    if let Ok(mut last) = LAST_CLICK.lock() {
        *last = None;
    }
}

/// Do it for me: one left click at the step — in ZOOD PDF, or, for a
/// `control` read by name (`controls.rs`), on that control in another app.
/// `resume` after the person moved the mouse and said to go on.
#[tauri::command]
pub async fn ask_click<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AskState>,
    x: f64,
    y: f64,
    resume: Option<bool>,
    control: Option<bool>,
) -> Result<Clicked, String> {
    if !crate::remote::input::AVAILABLE {
        return Err("E_ASK: clicking is on Windows and macOS".to_string());
    }
    let ours = state
        .moment
        .lock()
        .map(|moment| super::focus::is_ours(&moment.front))
        .unwrap_or(false);
    let (monitor, window) =
        areas(&state).ok_or_else(|| "E_SCREEN: nothing was looked at".to_string())?;
    let (fraction, at) = place(x, y, monitor, window);
    // Outside ZOOD PDF only on a button read by its name, never on a guess.
    if !ours && !(control == Some(true) && super::controls::on_a_control(at)) {
        return Err("E_ASK: Ask ZOOD clicks only inside ZOOD PDF".to_string());
    }
    let last = LAST_CLICK.lock().map(|last| *last).unwrap_or(None);
    if resume != Some(true) && moved(last, eye::pointer()) {
        return Err("E_MOVED: the mouse was moved".to_string());
    }
    let front = super::let_go(&app, &state);
    tauri::async_runtime::spawn_blocking(move || {
        super::focus::restore(&front);
        std::thread::sleep(Duration::from_millis(150));
        super::hands::click_at(at.0, at.1)
    })
    .await
    .map_err(|e| format!("E_ASK: {e}"))??;
    if let Ok(mut last) = LAST_CLICK.lock() {
        *last = Some(eye::pointer());
    }
    Ok(Clicked {
        x: fraction.0,
        y: fraction.1,
    })
}

mod mouse {
    /// The primary mouse button is down (the left one, unless swapped).
    #[cfg(target_os = "windows")]
    pub fn left_down() -> bool {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
            GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON,
        };
        use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_SWAPBUTTON};
        // SAFETY: plain queries of the system's input state.
        unsafe {
            // GetAsyncKeyState reads the physical buttons.
            let key = if GetSystemMetrics(SM_SWAPBUTTON) != 0 {
                VK_RBUTTON
            } else {
                VK_LBUTTON
            };
            (GetAsyncKeyState(i32::from(key)) as u16 & 0x8000) != 0
        }
    }

    #[cfg(target_os = "macos")]
    pub fn left_down() -> bool {
        use objc2::{class, msg_send};
        // SAFETY: NSEvent's documented class property; no permission needed.
        let buttons: usize = unsafe { msg_send![class!(NSEvent), pressedMouseButtons] };
        buttons & 1 != 0
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    pub fn left_down() -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREEN: eye::Area = eye::Area {
        x: 1920.0,
        y: 0.0,
        width: 1600.0,
        height: 900.0,
    };

    #[test]
    fn a_step_lands_on_the_screen_it_was_seen_on() {
        let ((fx, fy), (x, y)) = place(500.0, 1000.0, SCREEN, None);
        assert_eq!((fx, fy), (0.5, 1.0));
        assert_eq!((x, y), (2720.0, 900.0));
        // A picture of a window: the step is inside that window.
        let window = eye::Area {
            x: 2020.0,
            y: 100.0,
            width: 800.0,
            height: 400.0,
        };
        let (_, (x, y)) = place(0.0, 500.0, SCREEN, Some(window));
        assert!((x - 2020.0).abs() < 1e-9 && (y - 300.0).abs() < 1e-9);
    }

    #[test]
    fn a_click_is_told_only_on_that_screen() {
        let clicked = on_screen((2720.0, 450.0), SCREEN).unwrap();
        assert!((clicked.x - 0.5).abs() < 1e-9 && (clicked.y - 0.5).abs() < 1e-9);
        assert!(on_screen((100.0, 450.0), SCREEN).is_none());
    }

    #[test]
    fn a_moved_mouse_stops_the_clicking() {
        assert!(!moved(None, (5.0, 5.0)));
        assert!(!moved(Some((100.0, 100.0)), (104.0, 103.0)));
        assert!(moved(Some((100.0, 100.0)), (140.0, 100.0)));
    }
}
