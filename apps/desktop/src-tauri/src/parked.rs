//! Windows that wait for files to be dropped on them: the ring (`ring.rs`),
//! the drop zone (`sort.rs`) and the bubble (`presence.rs`).
//!
//! On Windows, WebView2 takes dropped files only in a window that was on the
//! screen when its webview was made: Tauri (wry) hooks its drop handler into
//! the webview's own child windows at that moment, and a window made hidden
//! has none yet. WebView2's own handler then answers every drag, and it is
//! told to refuse files, so Explorer shows the red "not allowed" sign. So on
//! Windows these windows are made shown, far off every screen, and go back
//! there instead of hiding. On a Mac they hide as before.
use tauri::{Manager, Runtime, WebviewWindow, WebviewWindowBuilder};

/// Off every screen (left of and above any monitor a PC has).
const AWAY: i32 = -20000;

/// A drop window, made ready but out of sight.
pub fn hidden<'a, R: Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M> {
    if cfg!(target_os = "windows") {
        builder
            .visible(true)
            .position(f64::from(AWAY), f64::from(AWAY))
    } else {
        builder.visible(false)
    }
}

/// Just made: on Windows, kept out of Alt+Tab while it waits off screen.
pub fn made<R: Runtime>(window: &WebviewWindow<R>) {
    #[cfg(target_os = "windows")]
    if let Ok(hwnd) = window.hwnd() {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
        };
        let hwnd = hwnd.0 as windows_sys::Win32::Foundation::HWND;
        // SAFETY: the window Tauri just made, still alive (`window` holds it);
        // its extended style read and written back with one flag changed.
        unsafe {
            let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            let style = (style | WS_EX_TOOLWINDOW as isize) & !(WS_EX_APPWINDOW as isize);
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style);
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = window;
}

/// Is this the place off the screens (or near it)?
pub fn is_away(x: i32, y: i32) -> bool {
    x <= AWAY / 2 && y <= AWAY / 2
}

/// Out of sight: off the screens on Windows, hidden on a Mac.
pub fn away<R: Runtime>(window: &WebviewWindow<R>) {
    if cfg!(target_os = "windows") {
        let _ = window.set_position(tauri::PhysicalPosition::new(AWAY, AWAY));
    } else {
        let _ = window.hide();
    }
}
