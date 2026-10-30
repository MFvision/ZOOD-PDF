//! Ask ZOOD puts a draft where the person's cursor is: the text goes on the
//! clipboard, the app that was in front gets the keyboard back, one Ctrl+V
//! (Command+V) is pressed, and what the clipboard held before is put back.
//!
//! Pasted, never typed key by key: in WhatsApp, Teams or Outlook's chat a
//! typed Enter sends, while a pasted line break is only a line break, so a
//! draft can never send itself. Typing many lines is also much slower.

/// The longest draft pasted, in characters.
pub const MAX_DRAFT: usize = 8000;
/// How long the pasted text stays on the clipboard before the person's own
/// comes back: long enough for a slow app to read it.
#[cfg(any(target_os = "windows", target_os = "macos"))]
const KEEP: std::time::Duration = std::time::Duration::from_millis(900);

/// A draft as it is pasted: no control characters but line breaks and
/// tabs, Windows' line breaks where Windows wants them, and bounded.
pub fn clean(text: &str) -> String {
    let kept: String = text
        .replace("\r\n", "\n")
        .chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
        .take(MAX_DRAFT)
        .collect();
    let kept = kept.trim().to_string();
    if cfg!(target_os = "windows") {
        kept.replace('\n', "\r\n")
    } else {
        kept
    }
}

/// Presses the system's Ctrl (Command) with `key`, as the person would.
#[cfg(any(target_os = "windows", target_os = "macos"))]
fn chord(key: char) -> Result<(), String> {
    chord_with(key, false)
}

/// Ctrl (Command), with Shift when `shift`, and `key`.
#[cfg(any(target_os = "windows", target_os = "macos"))]
fn chord_with(key: char, shift: bool) -> Result<(), String> {
    use enigo::{Direction, Enigo, Key, Keyboard, Settings};
    let modifier = if cfg!(target_os = "macos") {
        Key::Meta
    } else {
        Key::Control
    };
    let mut keys = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
    let pressed = keys
        .key(modifier, Direction::Press)
        .and_then(|()| {
            if shift {
                keys.key(Key::Shift, Direction::Press)
            } else {
                Ok(())
            }
        })
        .and_then(|()| keys.key(crate::remote::keys::shortcut_key(key), Direction::Click));
    // Let go of both whatever happened, so no key stays held down.
    if shift {
        let _ = keys.key(Key::Shift, Direction::Release);
    }
    let released = keys.key(modifier, Direction::Release);
    pressed.and(released).map_err(|e| e.to_string())
}

/// The everyday shortcuts Ask ZOOD may press in another app, by name: each
/// is the same in nearly every app on Windows and on a Mac, so "print" is
/// done by the app's own command, not by finding a button in a picture.
/// Nothing else can be pressed: the name must be one of these.
pub const SHORTCUTS: [(&str, char, bool); 17] = [
    ("print", 'p', false),
    ("save", 's', false),
    ("find", 'f', false),
    ("select-all", 'a', false),
    ("copy", 'c', false),
    ("new-tab", 't', false),
    ("close-tab", 'w', false),
    ("reopen-tab", 't', true),
    ("refresh", 'r', false),
    ("zoom-in", '=', false),
    ("zoom-out", '-', false),
    ("undo", 'z', false),
    (
        "redo",
        if cfg!(target_os = "macos") { 'z' } else { 'y' },
        cfg!(target_os = "macos"),
    ),
    ("bold", 'b', false),
    ("italic", 'i', false),
    ("underline", 'u', false),
    ("new-window", 'n', false),
];

/// The keys of the shortcut called `name`; None for any other name.
pub fn shortcut_keys(name: &str) -> Option<(char, bool)> {
    SHORTCUTS
        .iter()
        .find(|(one, _, _)| *one == name)
        .map(|(_, key, shift)| (*key, *shift))
}

/// Presses the shortcut called `name` (one of `SHORTCUTS`).
#[cfg(any(target_os = "windows", target_os = "macos"))]
pub fn shortcut(name: &str) -> Result<(), String> {
    let (key, shift) =
        shortcut_keys(name).ok_or_else(|| format!("E_ARGS: no shortcut called {name:?}"))?;
    chord_with(key, shift).map_err(|e| format!("E_ASK: {e}"))
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn shortcut(name: &str) -> Result<(), String> {
    shortcut_keys(name).ok_or_else(|| format!("E_ARGS: no shortcut called {name:?}"))?;
    Err("E_ASK: shortcuts are on Windows and macOS".to_string())
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
pub fn paste(text: &str) -> Result<(), String> {
    use crate::remote::clip::{read, write, Clip};

    let before = read();
    if !write(&Clip::Text(text.to_string())) {
        return Err("E_ASK: the clipboard could not be written".to_string());
    }
    let pressed = chord('v');
    std::thread::sleep(KEEP);
    // The person's own clipboard comes back unless something replaced the draft.
    if let Some(clip) = before {
        if read() == Some(Clip::Text(text.to_string())) {
            write(&clip);
        }
    }
    pressed.map_err(|e| format!("E_ASK: {e}"))
}

/// Takes the draft just pasted back out (the app's own Undo), before
/// another is written.
#[cfg(any(target_os = "windows", target_os = "macos"))]
pub fn undo() -> Result<(), String> {
    chord('z').map_err(|e| format!("E_ASK: {e}"))
}

/// One left click at `x`, `y`, in the system's own units (pixels on
/// Windows, points on a Mac): Do it for me's click inside ZOOD PDF.
#[cfg(any(target_os = "windows", target_os = "macos"))]
pub fn click_at(x: f64, y: f64) -> Result<(), String> {
    use enigo::{Button, Coordinate, Direction, Enigo, Mouse, Settings};
    if !x.is_finite() || !y.is_finite() {
        return Err("E_ASK: no place to click".to_string());
    }
    let mut mouse = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
    mouse
        .move_mouse(x.round() as i32, y.round() as i32, Coordinate::Abs)
        .map_err(|e| format!("E_ASK: {e}"))?;
    // The app sees the pointer arrive before the button goes down.
    std::thread::sleep(std::time::Duration::from_millis(60));
    mouse
        .button(Button::Left, Direction::Click)
        .map_err(|e| format!("E_ASK: {e}"))
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn click_at(_x: f64, _y: f64) -> Result<(), String> {
    Err("E_ASK: clicking is on Windows and macOS".to_string())
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn paste(_text: &str) -> Result<(), String> {
    Err("E_ASK: pasting is on Windows and macOS".to_string())
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn undo() -> Result<(), String> {
    Err("E_ASK: pasting is on Windows and macOS".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_draft_keeps_its_lines_and_loses_stray_controls() {
        let cleaned = clean("  Hi Sara,\r\n\nThanks!\u{7}\u{1b}[0m  ");
        let expected = if cfg!(target_os = "windows") {
            "Hi Sara,\r\n\r\nThanks![0m"
        } else {
            "Hi Sara,\n\nThanks![0m"
        };
        assert_eq!(cleaned, expected);
    }

    #[test]
    fn only_the_listed_shortcuts_can_be_pressed() {
        assert_eq!(shortcut_keys("print"), Some(('p', false)));
        assert_eq!(shortcut_keys("reopen-tab"), Some(('t', true)));
        assert_eq!(shortcut_keys("quit"), None);
        assert_eq!(shortcut_keys(""), None);
    }

    #[test]
    fn a_draft_is_bounded() {
        assert_eq!(
            clean(&"ا".repeat(MAX_DRAFT + 50)).chars().count(),
            MAX_DRAFT
        );
    }
}
