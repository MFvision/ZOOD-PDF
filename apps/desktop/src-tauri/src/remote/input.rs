//! PC control: the phone as the PC's trackpad and keyboard.
//!
//! Off until the person turns it on in the remote's panel, and off again
//! whenever the remote stops. While it is on, a paired phone's `pc` messages
//! become the system's own pointer, key and media-key events (enigo), as if
//! from a mouse and keyboard. Only the small set of actions below exists:
//! no shortcut a phone could send opens anything on its own.
//!
//! A Mac asks once for the Accessibility permission (enigo opens the prompt);
//! Windows needs none. Elsewhere there is no PC control.

use serde::Deserialize;

/// The furthest one message moves the pointer, in pixels.
const MAX_MOVE: i32 = 400;
/// The most scroll steps in one message.
const MAX_SCROLL: i32 = 40;
/// The most characters one message types.
const MAX_TEXT: usize = 500;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Click {
    Left,
    Right,
    Middle,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Named {
    Enter,
    Backspace,
    Tab,
    Escape,
    Space,
    Delete,
    Left,
    Right,
    Up,
    Down,
    Home,
    End,
    PageUp,
    PageDown,
    VolumeUp,
    VolumeDown,
    Mute,
    PlayPause,
    NextTrack,
    PreviousTrack,
}

/// One thing the phone asked the PC to do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Act {
    Move {
        dx: i32,
        dy: i32,
    },
    Click(Click),
    /// Held down for a drag, until [`Act::Release`].
    Press,
    Release,
    Scroll {
        dx: i32,
        dy: i32,
    },
    Text(String),
    Key(Named),
    /// One of a few everyday shortcuts, in this system's own keys (Ctrl on
    /// Windows, Command on a Mac). None of them opens anything by itself.
    Shortcut(Shortcut),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shortcut {
    Copy,
    Paste,
    Cut,
    Undo,
    Redo,
    SelectAll,
    /// The next open app (Alt+Tab, Command+Tab).
    SwitchApp,
    ZoomIn,
    ZoomOut,
}

fn shortcut(name: &str) -> Option<Shortcut> {
    Some(match name {
        "copy" => Shortcut::Copy,
        "paste" => Shortcut::Paste,
        "cut" => Shortcut::Cut,
        "undo" => Shortcut::Undo,
        "redo" => Shortcut::Redo,
        "selectAll" => Shortcut::SelectAll,
        "switchApp" => Shortcut::SwitchApp,
        "zoomIn" => Shortcut::ZoomIn,
        "zoomOut" => Shortcut::ZoomOut,
        _ => return None,
    })
}

#[derive(Deserialize)]
struct Wire {
    k: String,
    #[serde(default)]
    dx: f64,
    #[serde(default)]
    dy: f64,
    #[serde(default)]
    b: Option<String>,
    #[serde(default)]
    s: Option<String>,
    #[serde(default)]
    key: Option<String>,
}

fn whole(value: f64, limit: i32) -> i32 {
    if value.is_finite() {
        (value.round() as i64).clamp(-(limit as i64), limit as i64) as i32
    } else {
        0
    }
}

fn named(name: &str) -> Option<Named> {
    Some(match name {
        "enter" => Named::Enter,
        "backspace" => Named::Backspace,
        "tab" => Named::Tab,
        "escape" => Named::Escape,
        "space" => Named::Space,
        "delete" => Named::Delete,
        "left" => Named::Left,
        "right" => Named::Right,
        "up" => Named::Up,
        "down" => Named::Down,
        "home" => Named::Home,
        "end" => Named::End,
        "pageup" => Named::PageUp,
        "pagedown" => Named::PageDown,
        "volup" => Named::VolumeUp,
        "voldown" => Named::VolumeDown,
        "mute" => Named::Mute,
        "play" => Named::PlayPause,
        "next" => Named::NextTrack,
        "prev" => Named::PreviousTrack,
        _ => return None,
    })
}

/// A `pc` message as an action, or `None` for anything outside the set.
pub fn parse(message: &serde_json::Value) -> Option<Act> {
    let wire: Wire = serde_json::from_value(message.clone()).ok()?;
    Some(match wire.k.as_str() {
        "move" => Act::Move {
            dx: whole(wire.dx, MAX_MOVE),
            dy: whole(wire.dy, MAX_MOVE),
        },
        "click" => Act::Click(match wire.b.as_deref() {
            None | Some("left") => Click::Left,
            Some("right") => Click::Right,
            Some("middle") => Click::Middle,
            Some(_) => return None,
        }),
        "press" => Act::Press,
        "release" => Act::Release,
        "scroll" => Act::Scroll {
            dx: whole(wire.dx, MAX_SCROLL),
            dy: whole(wire.dy, MAX_SCROLL),
        },
        "text" => {
            let text: String = wire
                .s?
                .chars()
                .filter(|c| !c.is_control() || *c == '\n')
                .take(MAX_TEXT)
                .collect();
            if text.is_empty() {
                return None;
            }
            Act::Text(text)
        }
        "key" => Act::Key(named(wire.key.as_deref()?)?),
        "shortcut" => Act::Shortcut(shortcut(wire.key.as_deref()?)?),
        _ => return None,
    })
}

/// Whether this PC can be controlled from the phone at all.
pub const AVAILABLE: bool = cfg!(any(target_os = "windows", target_os = "macos"));

#[cfg(any(target_os = "windows", target_os = "macos"))]
mod system {
    use std::sync::mpsc::{channel, Sender};
    use std::sync::{Mutex, OnceLock};

    use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};

    use super::{Act, Click, Named, Shortcut};

    /// The key held for shortcuts here, and the letter (or key) pressed with it.
    fn chord(shortcut: Shortcut) -> (Vec<Key>, Key) {
        let command = if cfg!(target_os = "macos") {
            Key::Meta
        } else {
            Key::Control
        };
        match shortcut {
            Shortcut::Copy => (vec![command], Key::Unicode('c')),
            Shortcut::Paste => (vec![command], Key::Unicode('v')),
            Shortcut::Cut => (vec![command], Key::Unicode('x')),
            Shortcut::Undo => (vec![command], Key::Unicode('z')),
            Shortcut::Redo if cfg!(target_os = "macos") => {
                (vec![command, Key::Shift], Key::Unicode('z'))
            }
            Shortcut::Redo => (vec![command], Key::Unicode('y')),
            Shortcut::SelectAll => (vec![command], Key::Unicode('a')),
            Shortcut::SwitchApp if cfg!(target_os = "macos") => (vec![Key::Meta], Key::Tab),
            Shortcut::SwitchApp => (vec![Key::Alt], Key::Tab),
            Shortcut::ZoomIn => (vec![command], Key::Unicode('=')),
            Shortcut::ZoomOut => (vec![command], Key::Unicode('-')),
        }
    }

    fn press_chord(enigo: &mut Enigo, shortcut: Shortcut) -> enigo::InputResult<()> {
        let (held, key) = chord(shortcut);
        let mut pressed = Vec::new();
        let mut result = Ok(());
        for k in &held {
            result = enigo.key(*k, Direction::Press);
            if result.is_err() {
                break;
            }
            pressed.push(*k);
        }
        if result.is_ok() {
            result = enigo.key(key, Direction::Click);
        }
        // Whatever happened, nothing is left held down.
        for k in pressed.iter().rev() {
            let _ = enigo.key(*k, Direction::Release);
        }
        result
    }

    fn key(named: Named) -> Key {
        match named {
            Named::Enter => Key::Return,
            Named::Backspace => Key::Backspace,
            Named::Tab => Key::Tab,
            Named::Escape => Key::Escape,
            Named::Space => Key::Space,
            Named::Delete => Key::Delete,
            Named::Left => Key::LeftArrow,
            Named::Right => Key::RightArrow,
            Named::Up => Key::UpArrow,
            Named::Down => Key::DownArrow,
            Named::Home => Key::Home,
            Named::End => Key::End,
            Named::PageUp => Key::PageUp,
            Named::PageDown => Key::PageDown,
            Named::VolumeUp => Key::VolumeUp,
            Named::VolumeDown => Key::VolumeDown,
            Named::Mute => Key::VolumeMute,
            Named::PlayPause => Key::MediaPlayPause,
            Named::NextTrack => Key::MediaNextTrack,
            Named::PreviousTrack => Key::MediaPrevTrack,
        }
    }

    fn button(click: Click) -> Button {
        match click {
            Click::Left => Button::Left,
            Click::Right => Button::Right,
            Click::Middle => Button::Middle,
        }
    }

    fn run(enigo: &mut Enigo, act: Act) -> enigo::InputResult<()> {
        match act {
            Act::Move { dx, dy } => enigo.move_mouse(dx, dy, Coordinate::Rel),
            Act::Click(click) => enigo.button(button(click), Direction::Click),
            Act::Press => enigo.button(Button::Left, Direction::Press),
            Act::Release => enigo.button(Button::Left, Direction::Release),
            Act::Scroll { dx, dy } => {
                if dy != 0 {
                    enigo.scroll(dy, Axis::Vertical)?;
                }
                if dx != 0 {
                    enigo.scroll(dx, Axis::Horizontal)?;
                }
                Ok(())
            }
            Act::Text(text) => enigo.text(&text),
            Act::Key(named) => enigo.key(key(named), Direction::Click),
            Act::Shortcut(shortcut) => press_chord(enigo, shortcut),
        }
    }

    /// One thread owns the input connection; actions queue to it in order.
    fn worker() -> &'static Mutex<Sender<Act>> {
        static WORKER: OnceLock<Mutex<Sender<Act>>> = OnceLock::new();
        WORKER.get_or_init(|| {
            let (tx, rx) = channel::<Act>();
            std::thread::Builder::new()
                .name("remote-input".into())
                .spawn(move || {
                    let mut enigo = None::<Enigo>;
                    for act in rx {
                        if enigo.is_none() {
                            enigo = Enigo::new(&Settings::default()).ok();
                        }
                        let Some(e) = enigo.as_mut() else { continue };
                        if let Err(error) = run(e, act) {
                            crate::core_bridge::debug_log(format!("remote input: {error}"));
                        }
                    }
                })
                .expect("the remote's input thread");
            Mutex::new(tx)
        })
    }

    pub fn perform(act: Act) {
        if let Ok(tx) = worker().lock() {
            let _ = tx.send(act);
        }
    }
}

/// Carries `act` out on this PC; nothing where there is no PC control.
pub fn perform(act: Act) {
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    system::perform(act);
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let _ = act;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_each_action() {
        assert_eq!(
            parse(&json!({"k":"move","dx":3.4,"dy":-2})),
            Some(Act::Move { dx: 3, dy: -2 })
        );
        assert_eq!(parse(&json!({"k":"click"})), Some(Act::Click(Click::Left)));
        assert_eq!(
            parse(&json!({"k":"click","b":"right"})),
            Some(Act::Click(Click::Right))
        );
        assert_eq!(parse(&json!({"k":"press"})), Some(Act::Press));
        assert_eq!(
            parse(&json!({"k":"scroll","dy":3})),
            Some(Act::Scroll { dx: 0, dy: 3 })
        );
        assert_eq!(
            parse(&json!({"k":"text","s":"مرحبا"})),
            Some(Act::Text("مرحبا".into()))
        );
        assert_eq!(
            parse(&json!({"k":"key","key":"volup"})),
            Some(Act::Key(Named::VolumeUp))
        );
        assert_eq!(
            parse(&json!({"k":"shortcut","key":"paste"})),
            Some(Act::Shortcut(Shortcut::Paste))
        );
        assert_eq!(
            parse(&json!({"k":"shortcut","key":"switchApp"})),
            Some(Act::Shortcut(Shortcut::SwitchApp))
        );
        // Only the named few: nothing that opens a program or a window.
        assert_eq!(parse(&json!({"k":"shortcut","key":"run"})), None);
        assert_eq!(parse(&json!({"k":"shortcut"})), None);
    }

    #[test]
    fn keeps_every_action_small() {
        assert_eq!(
            parse(&json!({"k":"move","dx":1e9,"dy":-1e9})),
            Some(Act::Move { dx: 400, dy: -400 })
        );
        assert_eq!(
            parse(&json!({"k":"scroll","dy":1e6})),
            Some(Act::Scroll { dx: 0, dy: 40 })
        );
        let long = "a".repeat(5000);
        assert_eq!(
            parse(&json!({"k":"text","s":long})),
            Some(Act::Text("a".repeat(500)))
        );
        assert_eq!(
            parse(&json!({"k":"text","s":"\u{1b}[2J"})),
            Some(Act::Text("[2J".into()))
        );
    }

    #[test]
    fn refuses_anything_else() {
        for wrong in [
            json!({"k":"run","s":"cmd"}),
            json!({"k":"key","key":"win"}),
            json!({"k":"key"}),
            json!({"k":"click","b":"fourth"}),
            json!({"k":"text","s":""}),
            json!({"k":"text"}),
            json!("move"),
            json!({}),
        ] {
            assert_eq!(parse(&wrong), None, "{wrong} was accepted");
        }
    }
}
