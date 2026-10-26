//! Ask ZOOD's taps: one key on the right of the keyboard — right Ctrl on
//! Windows, right Command on a Mac, unless Settings chose another — tapped
//! on its own. Twice quickly drafts a reply where the cursor is; once opens
//! a box to type a request in.
//!
//! A modifier on its own is not a shortcut the system can register, so the
//! key is watched by looking: every few milliseconds the key, and every
//! other key and mouse button, are read as the system has them. A tap is
//! the key going down and up quickly with nothing else pressed meanwhile,
//! so Ctrl+C with the right Ctrl, or a Ctrl+click, is never a tap. Nothing
//! typed is read or kept: only whether keys are down.

use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::time::{Duration, Instant};

/// The key that is tapped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TapKey {
    /// Right Ctrl on Windows; right Command on a Mac.
    RightMain,
    /// Right Alt on Windows; right Option on a Mac.
    RightAlt,
    RightShift,
}

impl TapKey {
    pub fn from_name(name: &str) -> TapKey {
        match name {
            "right-alt" => TapKey::RightAlt,
            "right-shift" => TapKey::RightShift,
            _ => TapKey::RightMain,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            TapKey::RightMain => "right-main",
            TapKey::RightAlt => "right-alt",
            TapKey::RightShift => "right-shift",
        }
    }

    fn code(self) -> u8 {
        match self {
            TapKey::RightMain => 0,
            TapKey::RightAlt => 1,
            TapKey::RightShift => 2,
        }
    }

    fn from_code(code: u8) -> TapKey {
        match code {
            1 => TapKey::RightAlt,
            2 => TapKey::RightShift,
            _ => TapKey::RightMain,
        }
    }
}

/// What the person did with the key.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tap {
    Once,
    Twice,
}

/// The longest press that is still a tap.
pub const LONGEST_PRESS: Duration = Duration::from_millis(350);
/// Two taps count as one double tap when the second press comes this soon
/// after the first one ended; a single tap is only known once it has passed.
pub const BETWEEN: Duration = Duration::from_millis(380);
/// How often the keys are read.
const TICK: Duration = Duration::from_millis(12);

/// Turns what the keys are doing, read again and again, into taps.
#[derive(Debug, Default)]
pub struct Tapper {
    /// The key went down at this moment, and is still down.
    down: Option<Instant>,
    /// Something else was pressed while it was down: not a tap.
    spoiled: bool,
    /// A tap ended at this moment, and a second may follow.
    first: Option<Instant>,
    /// The second press of a double tap: its release is not a tap.
    swallow: bool,
}

impl Tapper {
    /// Whether the other keys can change what `step` makes of this reading:
    /// only while the tap key is down, or a tap may still be followed.
    pub fn needs_others(&self, key: bool) -> bool {
        key || self.down.is_some() || self.first.is_some()
    }

    /// One reading of the keys: is the tap key down, is anything else down.
    pub fn step(&mut self, now: Instant, key: bool, other: bool) -> Option<Tap> {
        match (self.down, key) {
            (None, true) => {
                self.down = Some(now);
                self.spoiled = other;
                if !other
                    && self
                        .first
                        .is_some_and(|ended| now.duration_since(ended) <= BETWEEN)
                {
                    self.first = None;
                    self.swallow = true;
                    return Some(Tap::Twice);
                }
                if other {
                    self.first = None;
                }
                None
            }
            (Some(_), true) => {
                if other {
                    self.spoiled = true;
                    self.first = None;
                }
                None
            }
            (Some(at), false) => {
                self.down = None;
                let tapped = !self.spoiled && !other && now.duration_since(at) <= LONGEST_PRESS;
                if std::mem::take(&mut self.swallow) || !tapped {
                    self.first = None;
                } else {
                    self.first = Some(now);
                }
                None
            }
            (None, false) => {
                if other {
                    self.first = None;
                    return None;
                }
                match self.first {
                    Some(ended) if now.duration_since(ended) > BETWEEN => {
                        self.first = None;
                        Some(Tap::Once)
                    }
                    _ => None,
                }
            }
        }
    }
}

static WATCHING: AtomicBool = AtomicBool::new(false);
static ON: AtomicBool = AtomicBool::new(false);
static KEY: AtomicU8 = AtomicU8::new(0);
/// Single taps open the typing box; off, only double taps count.
static ONCE: AtomicBool = AtomicBool::new(true);

/// Turns the taps on or off and chooses the key. The watcher starts the
/// first time they go on and then only sleeps while they are off.
pub fn configure(on: bool, key: TapKey, once: bool, mut tapped: impl FnMut(Tap) + Send + 'static) {
    KEY.store(key.code(), Ordering::Relaxed);
    ONCE.store(once, Ordering::Relaxed);
    ON.store(on, Ordering::Relaxed);
    if !on || !system::AVAILABLE || WATCHING.swap(true, Ordering::Relaxed) {
        return;
    }
    std::thread::spawn(move || {
        let mut tapper = Tapper::default();
        loop {
            std::thread::sleep(TICK);
            if !ON.load(Ordering::Relaxed) {
                tapper = Tapper::default();
                std::thread::sleep(Duration::from_millis(250));
                continue;
            }
            let key = TapKey::from_code(KEY.load(Ordering::Relaxed));
            let down = system::key_down(key);
            // Every other key is only looked at while it can matter: a
            // round of them is some 250 questions to the system.
            let other = tapper.needs_others(down) && system::others_down(key);
            match tapper.step(Instant::now(), down, other) {
                Some(Tap::Once) if !ONCE.load(Ordering::Relaxed) => {}
                Some(tap) => tapped(tap),
                None => {}
            }
        }
    });
}

#[cfg(target_os = "windows")]
mod system {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, VK_CONTROL, VK_LCONTROL, VK_MENU, VK_RCONTROL, VK_RMENU, VK_RSHIFT,
        VK_SHIFT,
    };

    use super::TapKey;

    pub const AVAILABLE: bool = true;

    fn down(key: u16) -> bool {
        // SAFETY: a plain key state query.
        (unsafe { GetAsyncKeyState(i32::from(key)) } as u16 & 0x8000) != 0
    }

    fn codes(key: TapKey) -> (u16, u16) {
        match key {
            TapKey::RightMain => (VK_RCONTROL, VK_CONTROL),
            TapKey::RightAlt => (VK_RMENU, VK_MENU),
            TapKey::RightShift => (VK_RSHIFT, VK_SHIFT),
        }
    }

    /// Whether the tap key is down.
    pub fn key_down(key: TapKey) -> bool {
        down(codes(key).0)
    }

    /// Whether any other key or mouse button is down. The generic Ctrl, Alt
    /// and Shift codes also report the tap key, so they are not "other";
    /// their left-hand ones are.
    pub fn others_down(key: TapKey) -> bool {
        let (vk, generic) = codes(key);
        // AltGr is sent as left Ctrl with right Alt.
        let altgr_ctrl = key == TapKey::RightAlt;
        // Mouse buttons (0x01 to 0x06) are in the range too.
        (0x01u16..=0xFE).any(|code| {
            code != vk
                && code != generic
                && !(altgr_ctrl && (code == VK_LCONTROL || code == VK_CONTROL))
                && down(code)
        })
    }
}

#[cfg(target_os = "macos")]
mod system {
    use objc2::{class, msg_send};

    use super::TapKey;

    pub const AVAILABLE: bool = true;

    /// kCGEventSourceStateCombinedSessionState.
    const COMBINED: i32 = 0;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceKeyState(state: i32, key: u16) -> bool;
    }

    // The modifier flags as NSEvent has them: the device-independent ones,
    // and below them which hand's key it is (IOKit's NX_DEVICE* masks).
    const SHIFT: usize = 1 << 17;
    const CONTROL: usize = 1 << 18;
    const OPTION: usize = 1 << 19;
    const COMMAND: usize = 1 << 20;
    const LEFT_CONTROL: usize = 0x0001;
    const LEFT_SHIFT: usize = 0x0002;
    const RIGHT_SHIFT: usize = 0x0004;
    const LEFT_COMMAND: usize = 0x0008;
    const RIGHT_COMMAND: usize = 0x0010;
    const LEFT_OPTION: usize = 0x0020;
    const RIGHT_OPTION: usize = 0x0040;
    const RIGHT_CONTROL: usize = 0x2000;
    const HANDS: usize = LEFT_CONTROL
        | LEFT_SHIFT
        | RIGHT_SHIFT
        | LEFT_COMMAND
        | RIGHT_COMMAND
        | LEFT_OPTION
        | RIGHT_OPTION
        | RIGHT_CONTROL;

    /// The tap key, and whether any other key or mouse button is down.
    ///
    /// The modifiers and the buttons are read from NSEvent, which any app
    /// may do (the ring reads them the same way): reading keys through
    /// CGEventSourceKeyState needs Input Monitoring, which is never asked
    /// for, so on its own the tap key read as never down outside the app.
    /// The letter keys still come from there, where it is allowed; where it
    /// is not they read as up, and only a modifier or a button spoils a tap.
    pub fn read(key: TapKey) -> (bool, bool) {
        // SAFETY: NSEvent's documented class properties.
        let (flags, buttons): (usize, usize) = unsafe {
            (
                msg_send![class!(NSEvent), modifierFlags],
                msg_send![class!(NSEvent), pressedMouseButtons],
            )
        };
        let (hand, generic) = match key {
            TapKey::RightMain => (RIGHT_COMMAND, COMMAND),
            TapKey::RightAlt => (RIGHT_OPTION, OPTION),
            TapKey::RightShift => (RIGHT_SHIFT, SHIFT),
        };
        let (down, other_modifier) = if flags & HANDS != 0 {
            (flags & hand != 0, flags & HANDS & !hand != 0)
        } else {
            // No hands reported: any Command (or Option, Shift) counts.
            let all = SHIFT | CONTROL | OPTION | COMMAND;
            (flags & generic != 0, flags & all & !generic != 0)
        };
        // The modifiers themselves are 0x36 to 0x3E; Caps Lock (0x39) is a
        // state, not a press.
        let letter = (0u16..=0x7F)
            .filter(|code| !(0x36..=0x3E).contains(code))
            // SAFETY: a plain key state query with a documented state id.
            .any(|code| unsafe { CGEventSourceKeyState(COMBINED, code) });
        (down, other_modifier || buttons != 0 || letter)
    }

    pub fn key_down(key: TapKey) -> bool {
        read(key).0
    }

    pub fn others_down(key: TapKey) -> bool {
        read(key).1
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod system {
    use super::TapKey;

    pub const AVAILABLE: bool = false;

    pub fn key_down(_key: TapKey) -> bool {
        false
    }

    pub fn others_down(_key: TapKey) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Plays `(milliseconds, key down, other down)` readings, returning the taps.
    fn play(readings: &[(u64, bool, bool)]) -> Vec<(u64, Tap)> {
        let start = Instant::now();
        let mut tapper = Tapper::default();
        readings
            .iter()
            .filter_map(|&(ms, key, other)| {
                tapper
                    .step(start + Duration::from_millis(ms), key, other)
                    .map(|tap| (ms, tap))
            })
            .collect()
    }

    #[test]
    fn other_keys_are_only_read_while_a_tap_can_be_under_way() {
        let start = Instant::now();
        let mut tapper = Tapper::default();
        assert!(!tapper.needs_others(false));
        assert!(tapper.needs_others(true));
        tapper.step(start, true, false);
        tapper.step(start + Duration::from_millis(80), false, false);
        // A first tap waits for a second: a key pressed now still counts.
        assert!(tapper.needs_others(false));
        let once = tapper.step(start + Duration::from_millis(600), false, false);
        assert_eq!(once, Some(Tap::Once));
        assert!(!tapper.needs_others(false));
    }

    #[test]
    fn two_quick_taps_are_a_double_tap_at_the_second_press() {
        let taps = play(&[
            (0, true, false),
            (90, false, false),
            (200, true, false),
            (280, false, false),
            (900, false, false),
        ]);
        assert_eq!(taps, vec![(200, Tap::Twice)]);
    }

    #[test]
    fn one_tap_is_known_once_the_wait_for_a_second_has_passed() {
        let taps = play(&[
            (0, true, false),
            (90, false, false),
            (300, false, false),
            (480, false, false),
            (900, false, false),
        ]);
        assert_eq!(taps, vec![(480, Tap::Once)]);
    }

    #[test]
    fn a_shortcut_with_the_key_is_not_a_tap() {
        // Ctrl+C: C goes down while Ctrl is held.
        let taps = play(&[
            (0, true, false),
            (40, true, true),
            (80, true, false),
            (120, false, false),
            (900, false, false),
        ]);
        assert!(taps.is_empty());
    }

    #[test]
    fn a_long_press_is_not_a_tap() {
        let taps = play(&[(0, true, false), (600, false, false), (1400, false, false)]);
        assert!(taps.is_empty());
    }

    #[test]
    fn typing_between_two_taps_breaks_the_pair() {
        let taps = play(&[
            (0, true, false),
            (90, false, false),
            (150, false, true),
            (200, true, false),
            (280, false, false),
            (900, false, false),
        ]);
        // The second tap stands alone.
        assert_eq!(taps, vec![(900, Tap::Once)]);
    }

    #[test]
    fn three_taps_are_one_double_tap_and_one_tap() {
        let taps = play(&[
            (0, true, false),
            (80, false, false),
            (160, true, false),
            (240, false, false),
            (320, true, false),
            (400, false, false),
            (1000, false, false),
        ]);
        assert_eq!(taps, vec![(160, Tap::Twice), (1000, Tap::Once)]);
    }

    #[test]
    fn key_names_go_both_ways() {
        for key in [TapKey::RightMain, TapKey::RightAlt, TapKey::RightShift] {
            assert_eq!(TapKey::from_name(key.name()), key);
            assert_eq!(TapKey::from_code(key.code()), key);
        }
        assert_eq!(TapKey::from_name("anything"), TapKey::RightMain);
    }
}
