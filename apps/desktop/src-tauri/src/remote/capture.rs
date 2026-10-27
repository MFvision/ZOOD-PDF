//! The mouse and keyboard taken from this computer while they work the other
//! one (`twin.rs`), and given back.
//!
//! While taken, the pointer stays still here and every movement, button,
//! wheel turn and key goes down a channel instead of to this computer's
//! apps: on Windows through low-level hooks, on a Mac through an event tap
//! (which needs the Accessibility permission, as PC control does). Nothing
//! is taken until the pointer crosses to the other screen, and dropping the
//! `Grab` gives everything back at once.
//!
//! Ctrl+Alt+Esc always brings the pointer home. Windows can drop a hook
//! that answers too slowly, and a Mac can switch a tap off: either way the
//! grab says it is lost and `twin.rs` lets go.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Button {
    Left,
    Right,
    Middle,
}

/// What the mouse and keyboard did while taken.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event {
    Moved {
        dx: i32,
        dy: i32,
    },
    Button {
        button: Button,
        down: bool,
    },
    /// A key by its place (`keys.rs`).
    Key {
        name: &'static str,
        down: bool,
    },
    /// Wheel steps: down and right are positive.
    Wheel {
        dx: i32,
        dy: i32,
    },
    /// Ctrl+Alt+Esc: the pointer comes home.
    Home,
    /// The system stopped giving the events to ZOOD: let go at once.
    Lost,
}

/// A rectangle on the desktop; `right` and `bottom` are just outside it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl Rect {
    pub fn width(&self) -> i32 {
        self.right - self.left
    }

    pub fn height(&self) -> i32 {
        self.bottom - self.top
    }

    pub fn center(&self) -> (i32, i32) {
        (self.left + self.width() / 2, self.top + self.height() / 2)
    }
}

/// Whether this system can lend its mouse and keyboard at all.
pub const AVAILABLE: bool = cfg!(any(target_os = "windows", target_os = "macos"));

pub use system::{cursor, desktop, held, main_screen, place, Grab};

#[cfg(target_os = "windows")]
mod system {
    use std::cell::RefCell;
    use std::sync::mpsc::{channel, Sender};
    use std::thread::JoinHandle;
    use std::time::Duration;

    use windows_sys::Win32::Foundation::{LPARAM, LRESULT, POINT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::System::Threading::GetCurrentThreadId;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetCursorPos, GetMessageW, GetSystemMetrics, PeekMessageW,
        PostThreadMessageW, SetCursorPos, SetWindowsHookExW, UnhookWindowsHookEx, KBDLLHOOKSTRUCT,
        LLKHF_INJECTED, LLKHF_UP, LLMHF_INJECTED, MSG, MSLLHOOKSTRUCT, PM_NOREMOVE, SM_CXSCREEN,
        SM_CXVIRTUALSCREEN, SM_CYSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
        WH_KEYBOARD_LL, WH_MOUSE_LL, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN, WM_MBUTTONUP,
        WM_MOUSEHWHEEL, WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_QUIT, WM_RBUTTONDOWN, WM_RBUTTONUP,
    };

    use super::super::keys;
    use super::{Button, Event, Rect};

    /// One wheel notch.
    const NOTCH: i32 = 120;

    struct Hooked {
        tx: Sender<Event>,
        park: POINT,
        ctrl: bool,
        alt: bool,
        /// Wheel turned less than a notch so far (touchpads turn in bits).
        wheel: (i32, i32),
    }

    thread_local! {
        // The hooks run on the thread that set them, so its state is here.
        static HOOKED: RefCell<Option<Hooked>> = const { RefCell::new(None) };
    }

    fn send(event: Event) {
        HOOKED.with(|hooked| {
            if let Some(hooked) = hooked.borrow().as_ref() {
                let _ = hooked.tx.send(event);
            }
        });
    }

    unsafe extern "system" fn mouse(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code < 0 || lparam == 0 {
            // SAFETY: handing the event on, as the hook's contract asks.
            return unsafe { CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam) };
        }
        // SAFETY: for WH_MOUSE_LL, lparam points at an MSLLHOOKSTRUCT.
        let info = unsafe { &*(lparam as *const MSLLHOOKSTRUCT) };
        if info.flags & LLMHF_INJECTED != 0 {
            // A phone working this computer (`input.rs`): not ours to take.
            return unsafe { CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam) };
        }
        let turn = (info.mouseData >> 16) as u16 as i16 as i32;
        HOOKED.with(|hooked| {
            let mut hooked = hooked.borrow_mut();
            let Some(hooked) = hooked.as_mut() else {
                return;
            };
            let event = match wparam as u32 {
                WM_MOUSEMOVE => {
                    let (dx, dy) = (info.pt.x - hooked.park.x, info.pt.y - hooked.park.y);
                    ((dx, dy) != (0, 0)).then_some(Event::Moved { dx, dy })
                }
                WM_LBUTTONDOWN => Some(Event::Button {
                    button: Button::Left,
                    down: true,
                }),
                WM_LBUTTONUP => Some(Event::Button {
                    button: Button::Left,
                    down: false,
                }),
                WM_RBUTTONDOWN => Some(Event::Button {
                    button: Button::Right,
                    down: true,
                }),
                WM_RBUTTONUP => Some(Event::Button {
                    button: Button::Right,
                    down: false,
                }),
                WM_MBUTTONDOWN => Some(Event::Button {
                    button: Button::Middle,
                    down: true,
                }),
                WM_MBUTTONUP => Some(Event::Button {
                    button: Button::Middle,
                    down: false,
                }),
                WM_MOUSEWHEEL => {
                    // Away from the person is up, so the steps go negative.
                    hooked.wheel.1 += turn;
                    let steps = hooked.wheel.1 / NOTCH;
                    hooked.wheel.1 -= steps * NOTCH;
                    (steps != 0).then_some(Event::Wheel { dx: 0, dy: -steps })
                }
                WM_MOUSEHWHEEL => {
                    hooked.wheel.0 += turn;
                    let steps = hooked.wheel.0 / NOTCH;
                    hooked.wheel.0 -= steps * NOTCH;
                    (steps != 0).then_some(Event::Wheel { dx: steps, dy: 0 })
                }
                _ => None,
            };
            if let Some(event) = event {
                let _ = hooked.tx.send(event);
            }
        });
        // Taken: this computer's apps never see it, and the pointer stays.
        1
    }

    unsafe extern "system" fn keyboard(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code < 0 || lparam == 0 {
            // SAFETY: handing the event on, as the hook's contract asks.
            return unsafe { CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam) };
        }
        // SAFETY: for WH_KEYBOARD_LL, lparam points at a KBDLLHOOKSTRUCT.
        let info = unsafe { &*(lparam as *const KBDLLHOOKSTRUCT) };
        if info.flags & LLKHF_INJECTED != 0 {
            return unsafe { CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam) };
        }
        let down = info.flags & LLKHF_UP == 0;
        let vk = info.vkCode as u16;
        let mut home = false;
        HOOKED.with(|hooked| {
            if let Some(hooked) = hooked.borrow_mut().as_mut() {
                match vk {
                    0xA2 | 0xA3 => hooked.ctrl = down,
                    0xA4 | 0xA5 => hooked.alt = down,
                    0x1B => home = down && hooked.ctrl && hooked.alt,
                    _ => {}
                }
            }
        });
        if home {
            send(Event::Home);
        } else if let Some(name) = keys::from_windows(vk) {
            send(Event::Key { name, down });
        }
        1
    }

    /// The mouse and keyboard, taken until dropped.
    pub struct Grab {
        thread: u32,
        join: Option<JoinHandle<()>>,
        park: (i32, i32),
    }

    impl Grab {
        /// Takes them, with the pointer held still at `park`; `None` when the
        /// system refuses.
        pub fn start(park: (i32, i32), tx: Sender<Event>) -> Option<Grab> {
            let (ready, answer) = channel::<Option<u32>>();
            let join = std::thread::Builder::new()
                .name("twin-grab".into())
                .spawn(move || {
                    // SAFETY: the hooks are set and removed on this thread,
                    // which pumps its messages until told to quit.
                    unsafe {
                        let mut msg: MSG = std::mem::zeroed();
                        // Makes the thread's queue, so the quit can reach it.
                        PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_NOREMOVE);
                        HOOKED.with(|hooked| {
                            *hooked.borrow_mut() = Some(Hooked {
                                tx,
                                park: POINT {
                                    x: park.0,
                                    y: park.1,
                                },
                                ctrl: false,
                                alt: false,
                                wheel: (0, 0),
                            })
                        });
                        SetCursorPos(park.0, park.1);
                        let module = GetModuleHandleW(std::ptr::null());
                        let m = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse), module, 0);
                        let k = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard), module, 0);
                        if m.is_null() || k.is_null() {
                            if !m.is_null() {
                                UnhookWindowsHookEx(m);
                            }
                            if !k.is_null() {
                                UnhookWindowsHookEx(k);
                            }
                            let _ = ready.send(None);
                            return;
                        }
                        let _ = ready.send(Some(GetCurrentThreadId()));
                        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {}
                        UnhookWindowsHookEx(m);
                        UnhookWindowsHookEx(k);
                        HOOKED.with(|hooked| *hooked.borrow_mut() = None);
                    }
                })
                .ok()?;
            match answer.recv_timeout(Duration::from_secs(2)) {
                Ok(Some(thread)) => Some(Grab {
                    thread,
                    join: Some(join),
                    park,
                }),
                _ => {
                    let _ = join.join();
                    None
                }
            }
        }

        /// Still taken: Windows silently drops a hook that answered too
        /// slowly, and then the pointer moves away from where it was held.
        pub fn alive(&self) -> bool {
            cursor()
                .is_none_or(|(x, y)| (x - self.park.0).abs() < 40 && (y - self.park.1).abs() < 40)
        }
    }

    impl Drop for Grab {
        fn drop(&mut self) {
            // SAFETY: a plain message to the grab's own thread.
            unsafe {
                PostThreadMessageW(self.thread, WM_QUIT, 0, 0);
            }
            if let Some(join) = self.join.take() {
                let _ = join.join();
            }
        }
    }

    pub fn cursor() -> Option<(i32, i32)> {
        let mut point = POINT { x: 0, y: 0 };
        // SAFETY: writes the point given.
        (unsafe { GetCursorPos(&mut point) } != 0).then_some((point.x, point.y))
    }

    pub fn place(x: i32, y: i32) {
        // SAFETY: a plain request.
        unsafe {
            SetCursorPos(x, y);
        }
    }

    /// All screens together.
    pub fn desktop() -> Option<Rect> {
        // SAFETY: plain system metric queries.
        let (left, top, width, height) = unsafe {
            (
                GetSystemMetrics(SM_XVIRTUALSCREEN),
                GetSystemMetrics(SM_YVIRTUALSCREEN),
                GetSystemMetrics(SM_CXVIRTUALSCREEN),
                GetSystemMetrics(SM_CYVIRTUALSCREEN),
            )
        };
        (width > 0 && height > 0).then_some(Rect {
            left,
            top,
            right: left + width,
            bottom: top + height,
        })
    }

    /// The main screen, where the pointer is held while away.
    pub fn main_screen() -> Option<Rect> {
        // SAFETY: plain system metric queries.
        let (width, height) =
            unsafe { (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)) };
        (width > 0 && height > 0).then_some(Rect {
            left: 0,
            top: 0,
            right: width,
            bottom: height,
        })
    }

    /// A mouse button or a modifier key is down: not the moment to cross.
    pub fn held() -> bool {
        // Buttons, then Shift, Ctrl, Alt and both Windows keys.
        [0x01, 0x02, 0x04, 0x10, 0x11, 0x12, 0x5B, 0x5C]
            .into_iter()
            // SAFETY: a plain query.
            .any(|vk| unsafe { GetAsyncKeyState(vk) } as u16 & 0x8000 != 0)
    }
}

#[cfg(target_os = "macos")]
mod system {
    use std::cell::Cell;
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc::{channel, Sender};
    use std::sync::Arc;
    use std::thread::JoinHandle;
    use std::time::Duration;

    use super::super::keys;
    use super::{Button, Event, Rect};

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGPoint {
        x: f64,
        y: f64,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGSize {
        width: f64,
        height: f64,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGRect {
        origin: CGPoint,
        size: CGSize,
    }

    type Ref = *mut c_void;
    type TapCallback = unsafe extern "C" fn(proxy: Ref, kind: u32, event: Ref, user: Ref) -> Ref;

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGEventTapCreate(
            tap: u32,
            place: u32,
            options: u32,
            mask: u64,
            callback: TapCallback,
            user: Ref,
        ) -> Ref;
        fn CGEventTapEnable(tap: Ref, enable: bool);
        fn CGEventGetIntegerValueField(event: Ref, field: u32) -> i64;
        fn CGEventGetFlags(event: Ref) -> u64;
        fn CGEventCreate(source: Ref) -> Ref;
        fn CGEventGetLocation(event: Ref) -> CGPoint;
        fn CGWarpMouseCursorPosition(point: CGPoint) -> i32;
        fn CGAssociateMouseAndMouseCursorPosition(connected: u32) -> i32;
        fn CGGetActiveDisplayList(max: u32, displays: *mut u32, count: *mut u32) -> i32;
        fn CGDisplayBounds(display: u32) -> CGRect;
        fn CGMainDisplayID() -> u32;
        fn CGEventSourceButtonState(state: i32, button: u32) -> bool;
        fn CGEventSourceFlagsState(state: i32) -> u64;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFMachPortCreateRunLoopSource(allocator: Ref, port: Ref, order: isize) -> Ref;
        fn CFMachPortInvalidate(port: Ref);
        fn CFRunLoopGetCurrent() -> Ref;
        fn CFRunLoopAddSource(run_loop: Ref, source: Ref, mode: Ref);
        fn CFRunLoopRunInMode(mode: Ref, seconds: f64, return_after_source: u8) -> i32;
        fn CFRelease(object: *const c_void);
        static kCFRunLoopDefaultMode: Ref;
        static kCFRunLoopCommonModes: Ref;
    }

    // Event kinds and fields, from CGEventTypes.h.
    const LEFT_DOWN: u32 = 1;
    const LEFT_UP: u32 = 2;
    const RIGHT_DOWN: u32 = 3;
    const RIGHT_UP: u32 = 4;
    const MOVED: u32 = 5;
    const LEFT_DRAGGED: u32 = 6;
    const RIGHT_DRAGGED: u32 = 7;
    const KEY_DOWN: u32 = 10;
    const KEY_UP: u32 = 11;
    const FLAGS_CHANGED: u32 = 12;
    const SCROLL: u32 = 22;
    const OTHER_DOWN: u32 = 25;
    const OTHER_UP: u32 = 26;
    const OTHER_DRAGGED: u32 = 27;
    const DISABLED_BY_TIMEOUT: u32 = 0xFFFF_FFFE;
    const DISABLED_BY_USER: u32 = 0xFFFF_FFFF;
    const TAKEN: [u32; 14] = [
        LEFT_DOWN,
        LEFT_UP,
        RIGHT_DOWN,
        RIGHT_UP,
        MOVED,
        LEFT_DRAGGED,
        RIGHT_DRAGGED,
        KEY_DOWN,
        KEY_UP,
        FLAGS_CHANGED,
        SCROLL,
        OTHER_DOWN,
        OTHER_UP,
        OTHER_DRAGGED,
    ];

    const FIELD_BUTTON: u32 = 3;
    const FIELD_DELTA_X: u32 = 4;
    const FIELD_DELTA_Y: u32 = 5;
    const FIELD_KEYCODE: u32 = 9;
    const FIELD_SCROLL_Y: u32 = 11;
    const FIELD_SCROLL_X: u32 = 12;
    const FIELD_SCROLL_CONTINUOUS: u32 = 88;
    const FIELD_SCROLL_POINTS_Y: u32 = 96;
    const FIELD_SCROLL_POINTS_X: u32 = 97;

    const FLAG_CAPS: u64 = 0x1_0000;
    const FLAG_SHIFT: u64 = 0x2_0000;
    const FLAG_CONTROL: u64 = 0x4_0000;
    const FLAG_OPTION: u64 = 0x8_0000;
    const FLAG_COMMAND: u64 = 0x10_0000;

    /// A trackpad's scroll, in points, that makes one wheel step.
    const POINTS_PER_STEP: i64 = 12;

    struct Tapped {
        tx: Sender<Event>,
        port: Cell<Ref>,
        scroll: Cell<(i64, i64)>,
    }

    fn send(tapped: &Tapped, event: Event) {
        let _ = tapped.tx.send(event);
    }

    unsafe extern "C" fn tap(_proxy: Ref, kind: u32, event: Ref, user: Ref) -> Ref {
        // SAFETY: `user` is the `Tapped` the tap thread keeps alive while
        // the tap exists; only that thread calls back.
        let tapped = unsafe { &*(user as *const Tapped) };
        if kind == DISABLED_BY_TIMEOUT || kind == DISABLED_BY_USER {
            send(tapped, Event::Lost);
            return event;
        }
        // SAFETY: reading fields of the event the tap was handed.
        let field = |f: u32| unsafe { CGEventGetIntegerValueField(event, f) };
        let flags = unsafe { CGEventGetFlags(event) };
        match kind {
            MOVED | LEFT_DRAGGED | RIGHT_DRAGGED | OTHER_DRAGGED => {
                let (dx, dy) = (field(FIELD_DELTA_X) as i32, field(FIELD_DELTA_Y) as i32);
                if (dx, dy) != (0, 0) {
                    send(tapped, Event::Moved { dx, dy });
                }
            }
            LEFT_DOWN | LEFT_UP => send(
                tapped,
                Event::Button {
                    button: Button::Left,
                    down: kind == LEFT_DOWN,
                },
            ),
            RIGHT_DOWN | RIGHT_UP => send(
                tapped,
                Event::Button {
                    button: Button::Right,
                    down: kind == RIGHT_DOWN,
                },
            ),
            OTHER_DOWN | OTHER_UP => {
                if field(FIELD_BUTTON) == 2 {
                    send(
                        tapped,
                        Event::Button {
                            button: Button::Middle,
                            down: kind == OTHER_DOWN,
                        },
                    );
                }
            }
            SCROLL => {
                // Up and left are positive here; the other way round there.
                let (dx, dy) = if field(FIELD_SCROLL_CONTINUOUS) != 0 {
                    let (mut x, mut y) = tapped.scroll.get();
                    x += field(FIELD_SCROLL_POINTS_X);
                    y += field(FIELD_SCROLL_POINTS_Y);
                    let steps = (x / POINTS_PER_STEP, y / POINTS_PER_STEP);
                    tapped
                        .scroll
                        .set((x - steps.0 * POINTS_PER_STEP, y - steps.1 * POINTS_PER_STEP));
                    steps
                } else {
                    (field(FIELD_SCROLL_X), field(FIELD_SCROLL_Y))
                };
                if (dx, dy) != (0, 0) {
                    send(
                        tapped,
                        Event::Wheel {
                            dx: -(dx as i32),
                            dy: -(dy as i32),
                        },
                    );
                }
            }
            KEY_DOWN | KEY_UP => {
                let code = field(FIELD_KEYCODE) as u16;
                let down = kind == KEY_DOWN;
                if down && code == 0x35 && flags & FLAG_CONTROL != 0 && flags & FLAG_OPTION != 0 {
                    send(tapped, Event::Home);
                } else if let Some(name) = keys::from_mac(code) {
                    send(tapped, Event::Key { name, down });
                }
            }
            FLAGS_CHANGED => {
                let code = field(FIELD_KEYCODE) as u16;
                let flag = match code {
                    0x38 | 0x3C => FLAG_SHIFT,
                    0x3B | 0x3E => FLAG_CONTROL,
                    0x3A | 0x3D => FLAG_OPTION,
                    0x37 | 0x36 => FLAG_COMMAND,
                    0x39 => FLAG_CAPS,
                    _ => 0,
                };
                if let Some(name) = keys::from_mac(code) {
                    if flag == FLAG_CAPS {
                        // Caps Lock reports each press once: press it there.
                        send(tapped, Event::Key { name, down: true });
                        send(tapped, Event::Key { name, down: false });
                    } else if flag != 0 {
                        send(
                            tapped,
                            Event::Key {
                                name,
                                down: flags & flag != 0,
                            },
                        );
                    }
                }
            }
            _ => return event,
        }
        // Taken: this Mac's apps never see it.
        std::ptr::null_mut()
    }

    /// The mouse and keyboard, taken until dropped.
    pub struct Grab {
        stop: Arc<AtomicBool>,
        join: Option<JoinHandle<()>>,
    }

    impl Grab {
        /// Takes them, with the pointer held still at `park`; `None` when
        /// the Mac refuses (no Accessibility permission).
        pub fn start(park: (i32, i32), tx: Sender<Event>) -> Option<Grab> {
            let stop = Arc::new(AtomicBool::new(false));
            let stopped = stop.clone();
            let (ready, answer) = channel::<bool>();
            let join = std::thread::Builder::new()
                .name("twin-grab".into())
                .spawn(move || {
                    let tapped = Box::into_raw(Box::new(Tapped {
                        tx,
                        port: Cell::new(std::ptr::null_mut()),
                        scroll: Cell::new((0, 0)),
                    }));
                    let mask = TAKEN.iter().fold(0u64, |mask, kind| mask | (1u64 << kind));
                    // SAFETY: the tap, its run loop source and `tapped` all
                    // live on this thread and are released at its end.
                    unsafe {
                        // Session tap, at the head, able to take events.
                        let port = CGEventTapCreate(1, 0, 0, mask, tap, tapped as Ref);
                        if port.is_null() {
                            drop(Box::from_raw(tapped));
                            let _ = ready.send(false);
                            return;
                        }
                        (*tapped).port.set(port);
                        let source = CFMachPortCreateRunLoopSource(std::ptr::null_mut(), port, 0);
                        CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
                        CGEventTapEnable(port, true);
                        CGWarpMouseCursorPosition(CGPoint {
                            x: park.0 as f64,
                            y: park.1 as f64,
                        });
                        CGAssociateMouseAndMouseCursorPosition(0);
                        let _ = ready.send(true);
                        while !stopped.load(Ordering::Relaxed) {
                            CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.1, 0);
                        }
                        CGEventTapEnable(port, false);
                        CFMachPortInvalidate(port);
                        CFRelease(source);
                        CFRelease(port);
                        drop(Box::from_raw(tapped));
                    }
                })
                .ok()?;
            if answer.recv_timeout(Duration::from_secs(2)) == Ok(true) {
                return Some(Grab {
                    stop,
                    join: Some(join),
                });
            }
            stop.store(true, Ordering::Relaxed);
            let _ = join.join();
            restore();
            None
        }

        /// A Mac says so itself when it switches the tap off (`Event::Lost`).
        pub fn alive(&self) -> bool {
            true
        }
    }

    impl Drop for Grab {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            if let Some(join) = self.join.take() {
                let _ = join.join();
            }
            restore();
        }
    }

    /// The mouse moves the pointer again.
    fn restore() {
        // SAFETY: a plain request.
        unsafe {
            CGAssociateMouseAndMouseCursorPosition(1);
        }
    }

    pub fn cursor() -> Option<(i32, i32)> {
        // SAFETY: an event made only to read where the pointer is, then released.
        unsafe {
            let event = CGEventCreate(std::ptr::null_mut());
            if event.is_null() {
                return None;
            }
            let point = CGEventGetLocation(event);
            CFRelease(event);
            Some((point.x.round() as i32, point.y.round() as i32))
        }
    }

    pub fn place(x: i32, y: i32) {
        restore();
        // SAFETY: a plain request.
        unsafe {
            CGWarpMouseCursorPosition(CGPoint {
                x: x as f64,
                y: y as f64,
            });
        }
    }

    fn rect(bounds: CGRect) -> Rect {
        Rect {
            left: bounds.origin.x.round() as i32,
            top: bounds.origin.y.round() as i32,
            right: (bounds.origin.x + bounds.size.width).round() as i32,
            bottom: (bounds.origin.y + bounds.size.height).round() as i32,
        }
    }

    /// All screens together.
    pub fn desktop() -> Option<Rect> {
        let mut displays = [0u32; 16];
        let mut count = 0u32;
        // SAFETY: writes at most 16 display ids into the array given.
        if unsafe { CGGetActiveDisplayList(16, displays.as_mut_ptr(), &mut count) } != 0
            || count == 0
        {
            return None;
        }
        displays[..(count as usize).min(16)]
            .iter()
            // SAFETY: a plain query about a display the system listed.
            .map(|&display| rect(unsafe { CGDisplayBounds(display) }))
            .reduce(|a, b| Rect {
                left: a.left.min(b.left),
                top: a.top.min(b.top),
                right: a.right.max(b.right),
                bottom: a.bottom.max(b.bottom),
            })
            .filter(|r| r.width() > 0 && r.height() > 0)
    }

    /// The main screen, where the pointer is held while away.
    pub fn main_screen() -> Option<Rect> {
        // SAFETY: plain display queries.
        let r = rect(unsafe { CGDisplayBounds(CGMainDisplayID()) });
        (r.width() > 0 && r.height() > 0).then_some(r)
    }

    /// A mouse button or a modifier key is down: not the moment to cross.
    pub fn held() -> bool {
        const COMBINED: i32 = 0;
        // SAFETY: plain queries.
        unsafe {
            (0..3).any(|button| CGEventSourceButtonState(COMBINED, button))
                || CGEventSourceFlagsState(COMBINED)
                    & (FLAG_SHIFT | FLAG_CONTROL | FLAG_OPTION | FLAG_COMMAND)
                    != 0
        }
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod system {
    use super::{Event, Rect};
    use std::sync::mpsc::Sender;

    pub struct Grab;

    impl Drop for Grab {
        fn drop(&mut self) {}
    }

    impl Grab {
        pub fn start(_park: (i32, i32), _tx: Sender<Event>) -> Option<Grab> {
            None
        }

        pub fn alive(&self) -> bool {
            false
        }
    }

    pub fn cursor() -> Option<(i32, i32)> {
        None
    }

    pub fn place(_x: i32, _y: i32) {}

    pub fn desktop() -> Option<Rect> {
        None
    }

    pub fn main_screen() -> Option<Rect> {
        None
    }

    pub fn held() -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_rect_knows_its_size_and_middle() {
        let r = Rect {
            left: -1920,
            top: 0,
            right: 1920,
            bottom: 1080,
        };
        assert_eq!((r.width(), r.height()), (3840, 1080));
        assert_eq!(r.center(), (0, 540));
    }

    /// The hooks go on and come off again on a real Windows desktop: the
    /// pointer is held while taken and moves again once given back.
    #[cfg(target_os = "windows")]
    #[test]
    #[ignore = "takes the real mouse; desktop-windows.yml runs it"]
    fn the_mouse_is_taken_and_given_back() {
        let (tx, _events) = std::sync::mpsc::channel();
        let park = main_screen().unwrap().center();
        let grab = Grab::start(park, tx).expect("hooks set");
        assert_eq!(cursor(), Some(park));
        assert!(grab.alive());
        assert!(desktop().unwrap().width() > 0);
        drop(grab);
        place(park.0 + 10, park.1 + 10);
        assert_eq!(cursor(), Some((park.0 + 10, park.1 + 10)));
    }
}
