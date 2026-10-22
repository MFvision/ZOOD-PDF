//! The buttons of the window in front, as the system lists them for screen
//! readers: Windows' UI Automation and the Mac's Accessibility. Every
//! ordinary app keeps this list — each button, link, tab, menu item and
//! field, with its name and where it is — so Ask ZOOD can find "Print" in
//! another app by its name, in a fraction of a second, instead of reading
//! a picture of the screen with the vision model. Apps that draw their own
//! buttons (games, some design tools, a canvas) list little or nothing;
//! there the picture is still the way.
//!
//! Only names, kinds and places are read; never the text typed in a field.

/// One control: its name, its kind, and its box in the system's own units
/// (pixels on Windows, points on a Mac).
#[derive(Clone, Debug, PartialEq)]
pub struct Raw {
    pub name: String,
    pub role: &'static str,
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
}

/// The most controls read from one window.
pub const MOST: usize = 400;
/// The most elements looked at to find them.
#[cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]
const MOST_SEEN: usize = 5000;

/// A name worth offering: words, not an empty label or a long paragraph.
pub fn named(name: &str) -> Option<String> {
    let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    let count = name.chars().count();
    ((1..=80).contains(&count) && name.chars().any(char::is_alphanumeric)).then_some(name)
}

#[cfg(target_os = "windows")]
pub fn read(front: isize) -> Result<Vec<Raw>, String> {
    use windows::core::Interface;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
    };
    use windows::Win32::System::Variant::{VARIANT, VARIANT_0, VARIANT_0_0, VARIANT_0_0_0, VT_I4};
    use windows::Win32::UI::Accessibility::*;

    if front == 0 {
        return Err("E_ASK: no window was in front".to_string());
    }
    const KINDS: [(UIA_CONTROLTYPE_ID, &str); 12] = [
        (UIA_ButtonControlTypeId, "button"),
        (UIA_SplitButtonControlTypeId, "button"),
        (UIA_HyperlinkControlTypeId, "link"),
        (UIA_MenuItemControlTypeId, "menu item"),
        (UIA_TabItemControlTypeId, "tab"),
        (UIA_CheckBoxControlTypeId, "check box"),
        (UIA_RadioButtonControlTypeId, "option"),
        (UIA_ComboBoxControlTypeId, "list"),
        (UIA_ListItemControlTypeId, "item"),
        (UIA_TreeItemControlTypeId, "item"),
        (UIA_EditControlTypeId, "field"),
        (UIA_MenuBarControlTypeId, "menu bar"),
    ];
    // SAFETY: plain COM calls on this thread; every result is checked, and
    // the element and its window handle come from the system.
    unsafe {
        // Already initialised on this thread is fine (S_FALSE, or another mode).
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| format!("E_ASK: {e}"))?;
        let window = automation
            .ElementFromHandle(HWND(front as *mut core::ffi::c_void))
            .map_err(|e| format!("E_ASK: {e}"))?;
        // A control type, as the VARIANT a property condition compares with (VT_I4).
        let number = |value: i32| VARIANT {
            Anonymous: VARIANT_0 {
                Anonymous: core::mem::ManuallyDrop::new(VARIANT_0_0 {
                    vt: VT_I4,
                    wReserved1: 0,
                    wReserved2: 0,
                    wReserved3: 0,
                    Anonymous: VARIANT_0_0_0 { lVal: value },
                }),
            },
        };
        let mut kinds: Option<IUIAutomationCondition> = None;
        for (kind, _) in KINDS {
            let one = automation
                .CreatePropertyCondition(UIA_ControlTypePropertyId, &number(kind.0))
                .map_err(|e| format!("E_ASK: {e}"))?;
            kinds = Some(match kinds {
                None => one,
                Some(before) => automation
                    .CreateOrCondition(&before, &one)
                    .map_err(|e| format!("E_ASK: {e}"))?
                    .cast()
                    .map_err(|e| format!("E_ASK: {e}"))?,
            });
        }
        let condition = kinds.ok_or("E_ASK: no kinds")?;
        let cache = automation
            .CreateCacheRequest()
            .map_err(|e| format!("E_ASK: {e}"))?;
        for property in [
            UIA_NamePropertyId,
            UIA_ControlTypePropertyId,
            UIA_BoundingRectanglePropertyId,
            UIA_IsOffscreenPropertyId,
            UIA_IsEnabledPropertyId,
        ] {
            cache
                .AddProperty(property)
                .map_err(|e| format!("E_ASK: {e}"))?;
        }
        let found = window
            .FindAllBuildCache(TreeScope_Descendants, &condition, &cache)
            .map_err(|e| format!("E_ASK: {e}"))?;
        let count = found.Length().map_err(|e| format!("E_ASK: {e}"))?;
        let mut controls = Vec::new();
        for index in 0..count.min(MOST_SEEN as i32) {
            let Ok(element) = found.GetElement(index) else {
                continue;
            };
            if element
                .CachedIsOffscreen()
                .map(|b| b.as_bool())
                .unwrap_or(true)
                || !element
                    .CachedIsEnabled()
                    .map(|b| b.as_bool())
                    .unwrap_or(false)
            {
                continue;
            }
            let Some(name) = element
                .CachedName()
                .ok()
                .and_then(|name| named(&name.to_string()))
            else {
                continue;
            };
            let Ok(kind) = element.CachedControlType() else {
                continue;
            };
            let role = KINDS
                .iter()
                .find(|(one, _)| *one == kind)
                .map(|(_, role)| *role)
                .unwrap_or("button");
            let Ok(rect) = element.CachedBoundingRectangle() else {
                continue;
            };
            let (width, height) = (
                f64::from(rect.right - rect.left),
                f64::from(rect.bottom - rect.top),
            );
            if width < 2.0 || height < 2.0 {
                continue;
            }
            controls.push(Raw {
                name,
                role,
                left: f64::from(rect.left),
                top: f64::from(rect.top),
                width,
                height,
            });
            if controls.len() >= MOST {
                break;
            }
        }
        Ok(controls)
    }
}

#[cfg(target_os = "macos")]
pub fn read(front: isize) -> Result<Vec<Raw>, String> {
    mac::read(front as i32)
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn read(_front: isize) -> Result<Vec<Raw>, String> {
    Err("E_ASK: reading other apps is on Windows and macOS".to_string())
}

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::c_void;

    use super::{named, Raw, MOST, MOST_SEEN};

    type CFTypeRef = *const c_void;

    const UTF8: u32 = 0x0800_0100;
    const AX_POINT: u32 = 1;
    const AX_SIZE: u32 = 2;

    #[repr(C)]
    #[derive(Default)]
    struct Pair {
        a: f64,
        b: f64,
    }

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXUIElementCreateApplication(pid: i32) -> CFTypeRef;
        fn AXUIElementCopyAttributeValue(
            element: CFTypeRef,
            attribute: CFTypeRef,
            value: *mut CFTypeRef,
        ) -> i32;
        fn AXUIElementSetMessagingTimeout(element: CFTypeRef, seconds: f32) -> i32;
        fn AXValueGetValue(value: CFTypeRef, kind: u32, out: *mut c_void) -> bool;
        fn AXValueGetTypeID() -> usize;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithBytes(
            allocator: CFTypeRef,
            bytes: *const u8,
            length: isize,
            encoding: u32,
            external: u8,
        ) -> CFTypeRef;
        fn CFStringGetLength(string: CFTypeRef) -> isize;
        fn CFStringGetCString(string: CFTypeRef, buffer: *mut u8, size: isize, encoding: u32)
            -> u8;
        fn CFStringGetTypeID() -> usize;
        fn CFArrayGetTypeID() -> usize;
        fn CFArrayGetCount(array: CFTypeRef) -> isize;
        fn CFArrayGetValueAtIndex(array: CFTypeRef, index: isize) -> CFTypeRef;
        fn CFGetTypeID(value: CFTypeRef) -> usize;
        fn CFRelease(value: CFTypeRef);
    }

    /// A CoreFoundation object this code owns, released when dropped.
    struct Owned(CFTypeRef);

    impl Drop for Owned {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY: an object created or copied here, released once.
                unsafe { CFRelease(self.0) }
            }
        }
    }

    fn cf_string(text: &str) -> Owned {
        // SAFETY: the bytes are valid UTF-8 of the given length.
        Owned(unsafe {
            CFStringCreateWithBytes(
                std::ptr::null(),
                text.as_ptr(),
                text.len() as isize,
                UTF8,
                0,
            )
        })
    }

    fn rust_string(value: CFTypeRef) -> Option<String> {
        // SAFETY: the type is checked before it is read as a string.
        unsafe {
            if value.is_null() || CFGetTypeID(value) != CFStringGetTypeID() {
                return None;
            }
            let size = CFStringGetLength(value) * 4 + 1;
            let mut buffer = vec![0u8; size as usize];
            if CFStringGetCString(value, buffer.as_mut_ptr(), size, UTF8) == 0 {
                return None;
            }
            let end = buffer.iter().position(|b| *b == 0).unwrap_or(buffer.len());
            buffer.truncate(end);
            String::from_utf8(buffer).ok()
        }
    }

    fn attribute(element: CFTypeRef, name: &str) -> Option<Owned> {
        let name = cf_string(name);
        let mut value: CFTypeRef = std::ptr::null();
        // SAFETY: a live element and attribute name; the copy is owned.
        let error = unsafe { AXUIElementCopyAttributeValue(element, name.0, &mut value) };
        (error == 0 && !value.is_null()).then_some(Owned(value))
    }

    fn text(element: CFTypeRef, name: &str) -> Option<String> {
        attribute(element, name).and_then(|value| rust_string(value.0))
    }

    fn pair(element: CFTypeRef, name: &str, kind: u32) -> Option<(f64, f64)> {
        let value = attribute(element, name)?;
        let mut out = Pair::default();
        // SAFETY: the value is an AXValue of the kind asked for, or refused.
        let read = unsafe {
            CFGetTypeID(value.0) == AXValueGetTypeID()
                && AXValueGetValue(value.0, kind, (&mut out as *mut Pair).cast())
        };
        read.then_some((out.a, out.b))
    }

    fn role_of(role: &str) -> Option<&'static str> {
        Some(match role {
            "AXButton" | "AXMenuButton" | "AXPopUpButton" => "button",
            "AXLink" => "link",
            "AXMenuItem" | "AXMenuBarItem" => "menu item",
            "AXTab" | "AXRadioButton" => "option",
            "AXCheckBox" => "check box",
            "AXTextField" | "AXTextArea" | "AXSearchField" | "AXComboBox" => "field",
            "AXCell" | "AXRow" => "item",
            _ => return None,
        })
    }

    pub fn read(pid: i32) -> Result<Vec<Raw>, String> {
        if pid <= 0 {
            return Err("E_ASK: no app was in front".to_string());
        }
        // SAFETY: an element for the app's process id; owned.
        let app = Owned(unsafe { AXUIElementCreateApplication(pid) });
        if app.0.is_null() {
            return Err("E_ASK: the app cannot be read".to_string());
        }
        // SAFETY: a live element; an app that does not answer is not waited on long.
        unsafe { AXUIElementSetMessagingTimeout(app.0, 0.4) };
        let window = attribute(app.0, "AXFocusedWindow")
            .or_else(|| attribute(app.0, "AXMainWindow"))
            .ok_or("E_ACCESS: Accessibility is off for ZOOD PDF, or the app shows no window")?;
        let mut controls = Vec::new();
        let mut seen = 0usize;
        // The window's own tree, then the menu bar's top items.
        walk(window.0, 0, &mut seen, &mut controls);
        if let Some(bar) = attribute(app.0, "AXMenuBar") {
            walk(bar.0, 28, &mut seen, &mut controls);
        }
        Ok(controls)
    }

    fn walk(element: CFTypeRef, depth: usize, seen: &mut usize, out: &mut Vec<Raw>) {
        if depth > 30 || *seen >= MOST_SEEN || out.len() >= MOST {
            return;
        }
        *seen += 1;
        if let Some(role) = text(element, "AXRole").as_deref().and_then(role_of) {
            let name = text(element, "AXTitle")
                .filter(|t| !t.trim().is_empty())
                .or_else(|| text(element, "AXDescription").filter(|t| !t.trim().is_empty()))
                .or_else(|| (role == "link").then(|| text(element, "AXValue")).flatten());
            if let (Some(name), Some((left, top)), Some((width, height))) = (
                name.as_deref().and_then(named),
                pair(element, "AXPosition", AX_POINT),
                pair(element, "AXSize", AX_SIZE),
            ) {
                if width >= 2.0 && height >= 2.0 {
                    out.push(Raw {
                        name,
                        role,
                        left,
                        top,
                        width,
                        height,
                    });
                }
            }
        }
        let Some(children) = attribute(element, "AXChildren") else {
            return;
        };
        // SAFETY: the type is checked before it is read as an array; its
        // items are borrowed for as long as the array lives.
        unsafe {
            if CFGetTypeID(children.0) != CFArrayGetTypeID() {
                return;
            }
            for index in 0..CFArrayGetCount(children.0) {
                walk(
                    CFArrayGetValueAtIndex(children.0, index),
                    depth + 1,
                    seen,
                    out,
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_is_words_of_a_sensible_length() {
        assert_eq!(named("  Print  \n now "), Some("Print now".to_string()));
        assert_eq!(named("طباعة"), Some("طباعة".to_string()));
        assert_eq!(named(""), None);
        assert_eq!(named(" • "), None);
        assert_eq!(named(&"x".repeat(81)), None);
    }
}
