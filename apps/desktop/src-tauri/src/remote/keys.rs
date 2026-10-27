//! Keys between two computers (`twin.rs`): each key travels by its place on
//! the keyboard, named as the web names it (`KeyA`, `ShiftLeft`, `Enter`),
//! so a Windows PC and a Mac understand each other. The computer that types
//! keeps its own keyboard layout: an Arabic layout on the other computer
//! types Arabic from the same keys.
//!
//! Between a Windows PC and a Mac, Control and Command change places, so
//! Ctrl+C on a PC keyboard copies on the Mac and Command+C on a Mac keyboard
//! copies on the PC.

/// One key: its name, its Windows virtual-key code and its Mac key code.
struct Row(&'static str, u16, u16);

/// No such key on that system.
const NONE: u16 = u16::MAX;

#[rustfmt::skip]
const KEYS: &[Row] = &[
    Row("KeyA", 0x41, 0x00), Row("KeyB", 0x42, 0x0B), Row("KeyC", 0x43, 0x08), Row("KeyD", 0x44, 0x02),
    Row("KeyE", 0x45, 0x0E), Row("KeyF", 0x46, 0x03), Row("KeyG", 0x47, 0x05), Row("KeyH", 0x48, 0x04),
    Row("KeyI", 0x49, 0x22), Row("KeyJ", 0x4A, 0x26), Row("KeyK", 0x4B, 0x28), Row("KeyL", 0x4C, 0x25),
    Row("KeyM", 0x4D, 0x2E), Row("KeyN", 0x4E, 0x2D), Row("KeyO", 0x4F, 0x1F), Row("KeyP", 0x50, 0x23),
    Row("KeyQ", 0x51, 0x0C), Row("KeyR", 0x52, 0x0F), Row("KeyS", 0x53, 0x01), Row("KeyT", 0x54, 0x11),
    Row("KeyU", 0x55, 0x20), Row("KeyV", 0x56, 0x09), Row("KeyW", 0x57, 0x0D), Row("KeyX", 0x58, 0x07),
    Row("KeyY", 0x59, 0x10), Row("KeyZ", 0x5A, 0x06),
    Row("Digit0", 0x30, 0x1D), Row("Digit1", 0x31, 0x12), Row("Digit2", 0x32, 0x13), Row("Digit3", 0x33, 0x14),
    Row("Digit4", 0x34, 0x15), Row("Digit5", 0x35, 0x17), Row("Digit6", 0x36, 0x16), Row("Digit7", 0x37, 0x1A),
    Row("Digit8", 0x38, 0x1C), Row("Digit9", 0x39, 0x19),
    Row("Minus", 0xBD, 0x1B), Row("Equal", 0xBB, 0x18), Row("BracketLeft", 0xDB, 0x21), Row("BracketRight", 0xDD, 0x1E),
    Row("Backslash", 0xDC, 0x2A), Row("Semicolon", 0xBA, 0x29), Row("Quote", 0xDE, 0x27), Row("Backquote", 0xC0, 0x32),
    Row("Comma", 0xBC, 0x2B), Row("Period", 0xBE, 0x2F), Row("Slash", 0xBF, 0x2C), Row("IntlBackslash", 0xE2, 0x0A),
    Row("Enter", 0x0D, 0x24), Row("Tab", 0x09, 0x30), Row("Space", 0x20, 0x31), Row("Backspace", 0x08, 0x33),
    Row("Escape", 0x1B, 0x35), Row("Delete", 0x2E, 0x75), Row("Insert", 0x2D, NONE), Row("CapsLock", 0x14, 0x39),
    Row("Home", 0x24, 0x73), Row("End", 0x23, 0x77), Row("PageUp", 0x21, 0x74), Row("PageDown", 0x22, 0x79),
    Row("ArrowLeft", 0x25, 0x7B), Row("ArrowRight", 0x27, 0x7C), Row("ArrowUp", 0x26, 0x7E), Row("ArrowDown", 0x28, 0x7D),
    Row("ShiftLeft", 0xA0, 0x38), Row("ShiftRight", 0xA1, 0x3C), Row("ControlLeft", 0xA2, 0x3B), Row("ControlRight", 0xA3, 0x3E),
    Row("AltLeft", 0xA4, 0x3A), Row("AltRight", 0xA5, 0x3D), Row("MetaLeft", 0x5B, 0x37), Row("MetaRight", 0x5C, 0x36),
    Row("ContextMenu", 0x5D, NONE),
    Row("F1", 0x70, 0x7A), Row("F2", 0x71, 0x78), Row("F3", 0x72, 0x63), Row("F4", 0x73, 0x76),
    Row("F5", 0x74, 0x60), Row("F6", 0x75, 0x61), Row("F7", 0x76, 0x62), Row("F8", 0x77, 0x64),
    Row("F9", 0x78, 0x65), Row("F10", 0x79, 0x6D), Row("F11", 0x7A, 0x67), Row("F12", 0x7B, 0x6F),
    Row("F13", 0x7C, 0x69), Row("F14", 0x7D, 0x6B), Row("F15", 0x7E, 0x71), Row("F16", 0x7F, 0x6A),
    Row("F17", 0x80, 0x40), Row("F18", 0x81, 0x4F), Row("F19", 0x82, 0x50), Row("F20", 0x83, 0x5A),
    Row("Numpad0", 0x60, 0x52), Row("Numpad1", 0x61, 0x53), Row("Numpad2", 0x62, 0x54), Row("Numpad3", 0x63, 0x55),
    Row("Numpad4", 0x64, 0x56), Row("Numpad5", 0x65, 0x57), Row("Numpad6", 0x66, 0x58), Row("Numpad7", 0x67, 0x59),
    Row("Numpad8", 0x68, 0x5B), Row("Numpad9", 0x69, 0x5C), Row("NumpadMultiply", 0x6A, 0x43), Row("NumpadAdd", 0x6B, 0x45),
    Row("NumpadSubtract", 0x6D, 0x4E), Row("NumpadDecimal", 0x6E, 0x41), Row("NumpadDivide", 0x6F, 0x4B),
    Row("NumpadEnter", NONE, 0x4C), Row("NumLock", 0x90, 0x47),
    Row("AudioVolumeMute", 0xAD, 0x4A), Row("AudioVolumeDown", 0xAE, 0x49), Row("AudioVolumeUp", 0xAF, 0x48),
    Row("MediaTrackNext", 0xB0, NONE), Row("MediaTrackPrevious", 0xB1, NONE), Row("MediaPlayPause", 0xB3, NONE),
];

/// The most a key's name can be: anything longer is not one of ours.
pub const MAX_NAME: usize = 24;

/// A Windows key code's name; `None` for keys the other computer cannot
/// have (and the generic Shift, Control and Alt, which the hook never sends).
pub fn from_windows(vk: u16) -> Option<&'static str> {
    KEYS.iter().find(|row| row.1 == vk).map(|row| row.0)
}

/// A Mac key code's name.
pub fn from_mac(code: u16) -> Option<&'static str> {
    KEYS.iter().find(|row| row.2 == code).map(|row| row.0)
}

/// A name's Windows key code.
pub fn to_windows(name: &str) -> Option<u16> {
    KEYS.iter()
        .find(|row| row.0 == name)
        .map(|row| row.1)
        .filter(|&vk| vk != NONE)
}

/// A name's Mac key code.
pub fn to_mac(name: &str) -> Option<u16> {
    KEYS.iter()
        .find(|row| row.0 == name)
        .map(|row| row.2)
        .filter(|&code| code != NONE)
}

/// A key's name as the other computer should press it: between a PC and a
/// Mac, Control and Command (Windows key) change places.
pub fn across(name: &'static str, from_os: &str, to_os: &str) -> &'static str {
    let mac = |os: &str| os == "macos";
    if mac(from_os) == mac(to_os) {
        return name;
    }
    match name {
        "ControlLeft" => "MetaLeft",
        "ControlRight" => "MetaRight",
        "MetaLeft" => "ControlLeft",
        "MetaRight" => "ControlRight",
        other => other,
    }
}

/// The table's own copy of `name`, so it can be kept without a copy.
pub fn canonical(name: &str) -> Option<&'static str> {
    KEYS.iter().find(|row| row.0 == name).map(|row| row.0)
}

/// Whether `name` is a key this table knows.
pub fn known(name: &str) -> bool {
    name.len() <= MAX_NAME && KEYS.iter().any(|row| row.0 == name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_name_is_once_and_codes_go_both_ways() {
        for (i, row) in KEYS.iter().enumerate() {
            assert!(row.0.len() <= MAX_NAME);
            assert!(
                KEYS[i + 1..].iter().all(|other| other.0 != row.0),
                "{} twice",
                row.0
            );
            if row.1 != NONE {
                assert_eq!(from_windows(row.1), Some(row.0), "Windows {:#x}", row.1);
                assert_eq!(to_windows(row.0), Some(row.1));
            }
            if row.2 != NONE {
                assert_eq!(from_mac(row.2), Some(row.0), "Mac {:#x}", row.2);
                assert_eq!(to_mac(row.0), Some(row.2));
            }
        }
    }

    #[test]
    fn a_letter_from_a_pc_is_the_same_letter_on_a_mac() {
        let name = from_windows(0x43).unwrap();
        assert_eq!(name, "KeyC");
        assert_eq!(to_mac(name), Some(0x08));
        assert_eq!(to_windows(from_mac(0x24).unwrap()), Some(0x0D));
    }

    #[test]
    fn control_and_command_change_places_between_a_pc_and_a_mac() {
        assert_eq!(across("ControlLeft", "windows", "macos"), "MetaLeft");
        assert_eq!(across("MetaLeft", "macos", "windows"), "ControlLeft");
        assert_eq!(across("ControlLeft", "windows", "windows"), "ControlLeft");
        assert_eq!(across("KeyC", "windows", "macos"), "KeyC");
    }

    #[test]
    fn unknown_names_are_not_keys() {
        assert!(known("KeyA"));
        assert!(!known("Launch the rockets"));
        assert!(!known(""));
        assert_eq!(to_mac("Insert"), None);
    }
}
