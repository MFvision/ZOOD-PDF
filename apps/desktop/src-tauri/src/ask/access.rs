//! What macOS must allow before Ask ZOOD works in other apps: Accessibility,
//! to paste a drafted reply where the cursor is, and Screen Recording, to
//! read the window being replied to. Neither is asked for by using it (the
//! paste and the picture just quietly fail), so Settings asks here and
//! shows what is still missing. The microphone asks by itself the first
//! time it listens. On Windows nothing needs allowing.

use serde::Serialize;

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Access {
    /// The system has permissions to ask for at all (a Mac).
    pub applies: bool,
    pub accessibility: bool,
    pub screen: bool,
}

/// What the system allows ZOOD PDF now.
#[tauri::command]
pub fn ask_access() -> Access {
    system::access()
}

/// Asks for one permission (`accessibility`, `screen` or `microphone`): the
/// system's own question where it has one, and its Settings pane opened at
/// the list where ZOOD PDF is switched on.
#[tauri::command]
pub fn ask_allow(kind: String) {
    system::allow(&kind);
}

#[cfg(target_os = "macos")]
mod system {
    use std::ffi::c_void;

    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_foundation::NSString;

    use super::Access;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn AXIsProcessTrustedWithOptions(options: *const c_void) -> bool;
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
    }

    pub fn access() -> Access {
        // SAFETY: plain queries, no arguments.
        unsafe {
            Access {
                applies: true,
                accessibility: AXIsProcessTrusted(),
                screen: CGPreflightScreenCaptureAccess(),
            }
        }
    }

    pub fn allow(kind: &str) {
        match kind {
            "accessibility" => {
                prompt_accessibility();
                open_pane("Privacy_Accessibility");
            }
            "screen" => {
                // SAFETY: a plain request; macOS shows its own question once.
                unsafe {
                    CGRequestScreenCaptureAccess();
                }
                open_pane("Privacy_ScreenCapture");
            }
            "microphone" => open_pane("Privacy_Microphone"),
            _ => {}
        }
    }

    /// macOS's own "ZOOD PDF would like to control this computer" question.
    fn prompt_accessibility() {
        let key = NSString::from_str("AXTrustedCheckOptionPrompt");
        // SAFETY: NSNumber's and NSDictionary's documented class messages;
        // the dictionary lives across the call.
        unsafe {
            let yes: Option<Retained<AnyObject>> =
                msg_send![class!(NSNumber), numberWithBool: true];
            let Some(yes) = yes else { return };
            let options: Option<Retained<AnyObject>> =
                msg_send![class!(NSDictionary), dictionaryWithObject: &*yes, forKey: &*key];
            let Some(options) = options else { return };
            AXIsProcessTrustedWithOptions(Retained::as_ptr(&options) as *const c_void);
        }
    }

    fn open_pane(anchor: &str) {
        let _ = std::process::Command::new("/usr/bin/open")
            .arg(format!(
                "x-apple.systempreferences:com.apple.preference.security?{anchor}"
            ))
            .spawn();
    }
}

#[cfg(not(target_os = "macos"))]
mod system {
    use super::Access;

    pub fn access() -> Access {
        Access {
            applies: false,
            accessibility: true,
            screen: true,
        }
    }

    pub fn allow(_kind: &str) {}
}
