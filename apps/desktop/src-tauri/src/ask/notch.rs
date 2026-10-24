//! The notch: Ask ZOOD's island grows out of the top of the screen, from
//! the camera notch on a Mac that has one, and from a notch drawn flush with
//! the top edge everywhere else (Windows, older Macs, other screens). Here
//! the host finds how wide and tall the real notch is, for the island to
//! start at exactly that size, and lifts ZOOD's windows over the menu bar so
//! the island can sit where the notch is.

use serde::Serialize;
use tauri::{PhysicalPosition, PhysicalSize, Runtime, WebviewWindow};

/// The notch, in the screen's points.
#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
pub struct Notch {
    pub width: f64,
    pub height: f64,
}

/// The notch of the screen at `position` and `size` (as Tauri places
/// windows), or none when that screen has none.
pub fn find(position: PhysicalPosition<i32>, size: PhysicalSize<u32>) -> Option<Notch> {
    system::find(position, size)
}

/// Lets a window of ZOOD's sit over the menu bar and on every Space,
/// beside full-screen apps too. Nothing to do elsewhere.
///
/// Always done on the main thread: callers may be on a thread of their own
/// (the drop zone is made a few seconds after start), and AppKit stops the
/// app when a window's level changes anywhere else (0.4.9 crashed so).
pub fn above_menu_bar<R: Runtime>(window: &WebviewWindow<R>) {
    let lifted = window.clone();
    if let Err(e) = window.run_on_main_thread(move || system::above_menu_bar(&lifted)) {
        eprintln!("warraq: cannot lift a window over the menu bar: {e}");
    }
}

#[cfg(target_os = "macos")]
mod system {
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send, sel};
    use objc2_foundation::{NSEdgeInsets, NSRect};
    use tauri::{PhysicalPosition, PhysicalSize, Runtime, WebviewWindow};

    use super::Notch;

    /// NSMainMenuWindowLevel + 1: over the menu bar, as the notch is.
    const OVER_MENU_BAR: isize = 25;
    /// canJoinAllSpaces | stationary | ignoresCycle | fullScreenAuxiliary.
    const EVERYWHERE: usize = 1 | (1 << 4) | (1 << 6) | (1 << 8);

    pub fn find(position: PhysicalPosition<i32>, size: PhysicalSize<u32>) -> Option<Notch> {
        // SAFETY: NSScreen's documented class and instance messages, each
        // result nil-checked or a plain struct; the notch's two side areas
        // are only asked of a screen that answers to them (macOS 12+).
        unsafe {
            let screens: Option<Retained<AnyObject>> = msg_send![class!(NSScreen), screens];
            let screens = screens?;
            let count: usize = msg_send![&*screens, count];
            for index in 0..count {
                let screen: Option<Retained<AnyObject>> =
                    msg_send![&*screens, objectAtIndex: index];
                let Some(screen) = screen else { continue };
                let frame: NSRect = msg_send![&*screen, frame];
                let scale: f64 = msg_send![&*screen, backingScaleFactor];
                let width = (frame.size.width * scale).round() as i64;
                let left = (frame.origin.x * scale).round() as i64;
                if width != i64::from(size.width) || (left - i64::from(position.x)).abs() > 2 {
                    continue;
                }
                let knows: bool =
                    msg_send![&*screen, respondsToSelector: sel!(auxiliaryTopLeftArea)];
                if !knows {
                    return None;
                }
                let insets: NSEdgeInsets = msg_send![&*screen, safeAreaInsets];
                if insets.top <= 0.0 {
                    return None;
                }
                let left_area: NSRect = msg_send![&*screen, auxiliaryTopLeftArea];
                let right_area: NSRect = msg_send![&*screen, auxiliaryTopRightArea];
                let notch = frame.size.width - left_area.size.width - right_area.size.width;
                return (notch > 0.0 && notch < frame.size.width).then_some(Notch {
                    width: notch,
                    height: insets.top,
                });
            }
            None
        }
    }

    pub fn above_menu_bar<R: Runtime>(window: &WebviewWindow<R>) {
        let Ok(handle) = window.ns_window() else {
            return;
        };
        let window = handle.cast::<AnyObject>();
        if window.is_null() {
            return;
        }
        // SAFETY: the NSWindow Tauri made, on the main thread (the public
        // above_menu_bar sends this there); NSWindow's documented setters with plain values.
        unsafe {
            let _: () = msg_send![window, setLevel: OVER_MENU_BAR];
            let _: () = msg_send![window, setCollectionBehavior: EVERYWHERE];
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod system {
    use tauri::{PhysicalPosition, PhysicalSize, Runtime, WebviewWindow};

    use super::Notch;

    pub fn find(_position: PhysicalPosition<i32>, _size: PhysicalSize<u32>) -> Option<Notch> {
        None
    }

    pub fn above_menu_bar<R: Runtime>(_window: &WebviewWindow<R>) {}
}
