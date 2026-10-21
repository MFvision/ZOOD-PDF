//! What the system must allow before Ask ZOOD works in other apps.
//!
//! On a Mac: the microphone, to listen; Input Monitoring, so the tap key is
//! told apart from a shortcut made with it (⌘C with the right ⌘ is not a
//! tap); Accessibility, to paste a drafted reply where the cursor is; and
//! Screen Recording, to read the window being replied to. Only the
//! microphone asks by itself, and only once it is used, so the welcome
//! card's one button and Settings ask for each here and show what is still
//! missing. On Windows only the microphone can be switched off (Settings ›
//! Privacy › Microphone); nothing else needs allowing.

use serde::Serialize;

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Access {
    /// The system has permissions to ask for at all (a Mac).
    pub applies: bool,
    pub accessibility: bool,
    pub screen: bool,
    /// `allowed`, `denied`, or `ask` when the system has not asked yet.
    pub microphone: &'static str,
    /// Input Monitoring (a Mac): the keys typed with the tap key are seen.
    pub input: bool,
}

/// What the system allows ZOOD PDF now.
#[tauri::command]
pub fn ask_access() -> Access {
    system::access()
}

/// Asks for one permission (`microphone`, `input`, `accessibility` or
/// `screen`): the system's own question when it has not asked yet, else
/// its Settings opened at the list where ZOOD PDF is switched on.
#[tauri::command]
pub fn ask_allow(kind: String) {
    system::allow(&kind);
}

/// Opens the microphone for a moment, which is what makes the system ask.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn touch_microphone() {
    std::thread::spawn(|| {
        if let Ok(listening) = super::ear::start(|_| {}) {
            std::thread::sleep(std::time::Duration::from_millis(400));
            drop(listening.finish());
        }
    });
}

#[cfg(target_os = "macos")]
mod system {
    use std::ffi::c_void;

    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject};
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

    /// kIOHIDRequestTypeListenEvent; kIOHIDAccessTypeGranted is 0.
    const LISTEN_EVENT: u32 = 1;

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOHIDCheckAccess(request: u32) -> u32;
        fn IOHIDRequestAccess(request: u32) -> bool;
    }

    // AVCaptureDevice lives there (speech.rs links it too).
    #[link(name = "AVFoundation", kind = "framework")]
    extern "C" {}

    /// AVAuthorizationStatus for sound: 0 not asked yet, 1 restricted,
    /// 2 denied, 3 allowed.
    fn microphone_status() -> isize {
        let Some(device) = AnyClass::get(c"AVCaptureDevice") else {
            return 0;
        };
        // AVMediaTypeAudio's value.
        let sound = NSString::from_str("soun");
        // SAFETY: AVCaptureDevice's documented class message, with an NSString.
        unsafe { msg_send![device, authorizationStatusForMediaType: &*sound] }
    }

    pub fn access() -> Access {
        // SAFETY: plain queries, no arguments but a documented constant.
        unsafe {
            Access {
                applies: true,
                accessibility: AXIsProcessTrusted(),
                screen: CGPreflightScreenCaptureAccess(),
                microphone: match microphone_status() {
                    3 => "allowed",
                    0 => "ask",
                    _ => "denied",
                },
                input: IOHIDCheckAccess(LISTEN_EVENT) == 0,
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
            "input" => {
                // SAFETY: a plain request; macOS shows its own question once
                // and answers false until the switch is on.
                let granted = unsafe { IOHIDRequestAccess(LISTEN_EVENT) };
                if !granted {
                    open_pane("Privacy_ListenEvent");
                }
            }
            "microphone" => {
                if microphone_status() == 0 {
                    super::touch_microphone();
                } else {
                    open_pane("Privacy_Microphone");
                }
            }
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

#[cfg(target_os = "windows")]
mod system {
    use windows_sys::Win32::System::Registry::{
        RegGetValueW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ,
    };

    use super::Access;

    const STORE: &str = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// The consent store's `Value` under `path`: "Allow", "Deny" or missing.
    fn value(root: HKEY, path: &str) -> Option<String> {
        let path = wide(path);
        let name = wide("Value");
        let mut buffer = [0u16; 32];
        let mut size = std::mem::size_of_val(&buffer) as u32;
        // SAFETY: a bounded read into a local buffer, its size given.
        let code = unsafe {
            RegGetValueW(
                root,
                path.as_ptr(),
                name.as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                buffer.as_mut_ptr().cast(),
                &mut size,
            )
        };
        if code != 0 {
            return None;
        }
        let len = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
        Some(String::from_utf16_lossy(&buffer[..len]))
    }

    /// The microphone switches in Settings › Privacy: for the computer, for
    /// this account, and "Let desktop apps access your microphone".
    pub fn access() -> Access {
        let denied = [
            (HKEY_LOCAL_MACHINE, STORE.to_string()),
            (HKEY_CURRENT_USER, STORE.to_string()),
            (HKEY_CURRENT_USER, format!(r"{STORE}\NonPackaged")),
        ]
        .iter()
        .any(|(root, path)| value(*root, path).as_deref() == Some("Deny"));
        Access {
            applies: false,
            accessibility: true,
            screen: true,
            microphone: if denied { "denied" } else { "allowed" },
            input: true,
        }
    }

    pub fn allow(kind: &str) {
        if kind == "microphone" {
            let _ = std::process::Command::new("explorer")
                .arg("ms-settings:privacy-microphone")
                .spawn();
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod system {
    use super::Access;

    pub fn access() -> Access {
        Access {
            applies: false,
            accessibility: true,
            screen: true,
            microphone: "allowed",
            input: true,
        }
    }

    pub fn allow(_kind: &str) {}
}
