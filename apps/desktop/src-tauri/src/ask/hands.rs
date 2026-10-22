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
    use enigo::{Direction, Enigo, Key, Keyboard, Settings};
    let modifier = if cfg!(target_os = "macos") {
        Key::Meta
    } else {
        Key::Control
    };
    let mut keys = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
    keys.key(modifier, Direction::Press)
        .and_then(|()| keys.key(Key::Unicode(key), Direction::Click))
        .and_then(|()| keys.key(modifier, Direction::Release))
        .map_err(|e| e.to_string())
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
    fn a_draft_is_bounded() {
        assert_eq!(
            clean(&"ا".repeat(MAX_DRAFT + 50)).chars().count(),
            MAX_DRAFT
        );
    }
}
