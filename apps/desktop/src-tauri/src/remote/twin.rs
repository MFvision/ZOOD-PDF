//! One mouse and keyboard for two computers (the idea of TwinDesk, none of
//! its code): the pointer runs off one edge of this computer's screen and
//! carries on across the other computer's, and the keys type there, until
//! it comes back over the same edge. Copied text and pictures go along.
//!
//! The other computer (the helper) only needs its phone remote ready: it
//! takes this computer as one more paired device (`server.rs`), paired once
//! with six digits both screens show (`pairpc.rs`), and works its own mouse
//! and keys from what arrives (`input.rs`). This computer takes its own
//! mouse and keyboard while the pointer is over there (`capture.rs`).
//!
//! Off until the person turns it on and pairs, and then nothing is taken
//! until the pointer crosses. Ctrl+Alt+Esc, a lost link, or the system
//! taking its events back each bring the pointer home at once.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Runtime, State, Wry};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

use super::capture::{self, Event, Rect};
use super::seal::{self, SealKey};
use super::{clip, keys, pairpc, server};

/// The state changed. Payload: [`TwinStatus`].
pub const TWIN_EVENT: &str = "warraq://twin";

/// How long a step of the link may take before it is given up.
const STEP_WAIT: Duration = Duration::from_secs(6);
/// How long pairing waits for the person at the other computer.
const PAIR_WAIT: Duration = Duration::from_secs(95);
/// A beat goes this often; a link silent for `SILENT` is let go.
const BEAT_EVERY: Duration = Duration::from_secs(3);
const SILENT: Duration = Duration::from_secs(10);
/// The longest wait between tries to reach the other computer.
const MAX_BACKOFF: Duration = Duration::from_secs(15);
/// How often the pointer is looked at for a crossing, and moves are sent.
const LOOK_EVERY: Duration = Duration::from_millis(10);
const SEND_EVERY: Duration = Duration::from_millis(16);
/// How far the pointer must jump in one look into the edge to cross:
/// pushed there on purpose, not crept up to (a scroll bar, a menu).
const PUSH: i32 = 3;
/// Where the pointer comes back, this far in from the edge.
const INSET: i32 = 4;

/// Where the other computer's screen is, seen from this one.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    /// To the right, as most desks have it.
    #[default]
    Auto,
    Left,
    Right,
    Top,
    Bottom,
}

impl Side {
    fn real(self) -> Side {
        match self {
            Side::Auto => Side::Right,
            other => other,
        }
    }
}

/// The pointer was pushed over `side`'s edge of `desk` between two looks.
pub fn crossing(side: Side, before: (i32, i32), now: (i32, i32), desk: Rect) -> bool {
    match side.real() {
        Side::Left => now.0 <= desk.left && before.0 - now.0 >= PUSH,
        Side::Top => now.1 <= desk.top && before.1 - now.1 >= PUSH,
        Side::Bottom => now.1 >= desk.bottom - 1 && now.1 - before.1 >= PUSH,
        _ => now.0 >= desk.right - 1 && now.0 - before.0 >= PUSH,
    }
}

/// `value` of `from` as the same share of `to`.
fn scale(value: i32, from: i32, to: i32) -> i32 {
    let scaled = i64::from(value) * i64::from(to) / i64::from(from.max(1));
    scaled.clamp(0, i64::from(to.max(1) - 1)) as i32
}

/// The pointer over on the other screen.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Away {
    side: Side,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    desk: Rect,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    /// Here on the other screen.
    There(i32, i32),
    /// Back over the edge: here on this screen.
    Home(i32, i32),
}

impl Away {
    /// Crossing at `at` on this computer's `desk` onto a `screen` that size.
    pub fn enter(side: Side, at: (i32, i32), desk: Rect, screen: (i32, i32)) -> Away {
        let side = side.real();
        let (width, height) = (screen.0.max(1), screen.1.max(1));
        let across = scale(at.0 - desk.left, desk.width(), width);
        let down = scale(at.1 - desk.top, desk.height(), height);
        let (x, y) = match side {
            Side::Left => (width - 1, down),
            Side::Top => (across, height - 1),
            Side::Bottom => (across, 0),
            _ => (0, down),
        };
        Away {
            side,
            x,
            y,
            width,
            height,
            desk,
        }
    }

    pub fn at(&self) -> (i32, i32) {
        (self.x, self.y)
    }

    /// The mouse moved by `dx`, `dy`.
    pub fn step(&mut self, dx: i32, dy: i32) -> Step {
        let x = self.x.saturating_add(dx);
        let y = self.y.saturating_add(dy);
        let back = match self.side {
            Side::Left => x > self.width - 1,
            Side::Top => y > self.height - 1,
            Side::Bottom => y < 0,
            _ => x < 0,
        };
        self.x = x.clamp(0, self.width - 1);
        self.y = y.clamp(0, self.height - 1);
        if back {
            let (x, y) = self.home();
            return Step::Home(x, y);
        }
        Step::There(self.x, self.y)
    }

    /// Where the pointer comes back on this screen: at the same share of
    /// the edge it left by, a little in from it.
    pub fn home(&self) -> (i32, i32) {
        let d = self.desk;
        let across = d.left + scale(self.x, self.width, d.width());
        let down = d.top + scale(self.y, self.height, d.height());
        match self.side {
            Side::Left => (d.left + INSET, down),
            Side::Top => (across, d.top + INSET),
            Side::Bottom => (across, d.bottom - 1 - INSET),
            _ => (d.right - 1 - INSET, down),
        }
    }
}

/// The other computer, as remembered after pairing.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Helper {
    pub pc: String,
    pub device: String,
    key: String,
    /// `ip:port` it was last reached at.
    pub addr: String,
}

impl Helper {
    fn key(&self) -> Option<SealKey> {
        seal::key_from_text(&self.key)
    }
}

/// What is kept in `remote-twin.json`.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub on: bool,
    #[serde(default)]
    pub side: Side,
    #[serde(default)]
    pub helper: Option<Helper>,
}

fn config_file<R: Runtime>(app: &AppHandle<R>) -> Option<std::path::PathBuf> {
    Some(app.path().app_data_dir().ok()?.join("remote-twin.json"))
}

fn load<R: Runtime>(app: &AppHandle<R>) -> Config {
    config_file(app)
        .and_then(|file| std::fs::read(file).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save<R: Runtime>(app: &AppHandle<R>, config: &Config) {
    let Some(file) = config_file(app) else {
        return;
    };
    if let Some(folder) = file.parent() {
        let _ = std::fs::create_dir_all(folder);
    }
    if let Ok(bytes) = serde_json::to_vec_pretty(config) {
        let _ = std::fs::write(file, bytes);
    }
}

/// What the "Two computers" card shows.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TwinStatus {
    /// This system can lend its mouse and keyboard at all.
    pub available: bool,
    pub on: bool,
    pub side: Side,
    /// The paired computer's name.
    pub helper: Option<String>,
    /// `off`, `looking` (trying to reach it), `ready`, `away` (the pointer
    /// is over there), `refused` (it no longer knows this computer) or
    /// `permission` (a Mac must allow Accessibility first).
    pub state: &'static str,
    /// Pairing: the six digits to compare with the other screen.
    pub digits: Option<String>,
}

/// The link to the other computer, while it is up.
#[derive(Clone)]
struct Link {
    tx: mpsc::UnboundedSender<Value>,
    os: String,
    screen: (i32, i32),
}

impl Link {
    fn pc(&self, mut message: Value) {
        message["t"] = "pc".into();
        let _ = self.tx.send(message);
    }
}

#[derive(Default)]
pub struct Twin {
    config: Mutex<Config>,
    state: Mutex<&'static str>,
    digits: Mutex<Option<String>>,
    link: Mutex<Option<Link>>,
    /// Bumped to stop the link and the pointer watch (turned off, forgotten).
    generation: AtomicU64,
    /// The last clip sent or received, so it does not go round again.
    last_clip: AtomicU64,
    clipboard: std::sync::atomic::AtomicBool,
}

/// Managed by Tauri.
#[derive(Default)]
pub struct TwinState(pub Arc<Twin>);

impl Twin {
    fn status(&self) -> TwinStatus {
        let config = self.config.lock().map(|c| c.clone()).unwrap_or_default();
        let state = self.state.lock().map(|s| *s).unwrap_or("off");
        TwinStatus {
            available: capture::AVAILABLE,
            on: config.on,
            side: config.side,
            helper: config.helper.map(|h| h.pc),
            state: if config.on { state } else { "off" },
            digits: self.digits.lock().ok().and_then(|d| d.clone()),
        }
    }

    fn set_state<R: Runtime>(&self, app: &AppHandle<R>, state: &'static str) {
        let changed = self
            .state
            .lock()
            .map(|mut s| std::mem::replace(&mut *s, state) != state);
        if changed.unwrap_or(false) {
            let _ = app.emit(TWIN_EVENT, self.status());
        }
    }

    fn link(&self) -> Option<Link> {
        self.link.lock().ok()?.clone()
    }

    fn current(&self, generation: u64) -> bool {
        self.generation.load(Ordering::Relaxed) == generation
    }
}

/// Starts (or stops) the link and the pointer watch to match the settings.
fn restart(app: &AppHandle<Wry>, twin: &Arc<Twin>) {
    let generation = twin.generation.fetch_add(1, Ordering::Relaxed) + 1;
    if let Ok(mut link) = twin.link.lock() {
        *link = None;
    }
    let config = twin.config.lock().map(|c| c.clone()).unwrap_or_default();
    let (true, Some(helper)) = (config.on && capture::AVAILABLE, config.helper) else {
        twin.set_state(app, "off");
        return;
    };
    twin.clipboard.store(
        super::clipboard_wanted(app) && super::CLIPBOARD_AVAILABLE,
        Ordering::Relaxed,
    );
    twin.set_state(app, "looking");
    let (app_link, twin_link) = (app.clone(), twin.clone());
    tauri::async_runtime::spawn(keep_linked(app_link, twin_link, helper, generation));
    let (app_watch, twin_watch) = (app.clone(), twin.clone());
    let _ = std::thread::Builder::new()
        .name("twin-watch".into())
        .spawn(move || watch_pointer(app_watch, twin_watch, generation));
}

/// At launch: on again if it was on.
pub fn start_if_on(app: &AppHandle<Wry>) {
    let twin = app.state::<TwinState>().0.clone();
    if let Ok(mut config) = twin.config.lock() {
        *config = load(app);
    }
    restart(app, &twin);
}

// ---- The link ------------------------------------------------------------

type Socket = WebSocketStream<TcpStream>;

/// A link made: the socket, its session key and numbering, and what the
/// other computer said first.
pub struct Linked {
    socket: Socket,
    session: SealKey,
    out_seq: u64,
    in_seq: u64,
    /// The other computer's `ready`: its name, system and screen size.
    pub ready: Value,
    /// A new pairing's own device id and key, for next time.
    pub welcome: Option<(String, SealKey)>,
}

impl Linked {
    async fn send(&mut self, mut message: Value) -> bool {
        self.out_seq += 1;
        message["s"] = self.out_seq.into();
        message["d"] = "p".into();
        let sealed = seal::seal(&self.session, message.to_string().as_bytes());
        self.socket
            .send(Message::Binary(sealed.into()))
            .await
            .is_ok()
    }

    /// A sealed message from the other computer, numbered after the last.
    fn opened(&mut self, sealed: &[u8]) -> Option<Value> {
        opened_from_pc(&self.session, &mut self.in_seq, sealed)
    }
}

fn opened_from_pc(session: &SealKey, last: &mut u64, sealed: &[u8]) -> Option<Value> {
    let mut message: Value = serde_json::from_slice(&seal::open(session, sealed)?).ok()?;
    let object = message.as_object_mut()?;
    let seq = object.remove("s")?.as_u64()?;
    if object.remove("d")?.as_str()? != "c" || seq <= *last {
        return None;
    }
    *last = seq;
    Some(message)
}

async fn text(socket: &mut Socket, wait: Duration) -> Result<Value, String> {
    loop {
        let next = tokio::time::timeout(wait, socket.next())
            .await
            .map_err(|_| "E_TWIN_TIMEOUT".to_string())?;
        match next {
            Some(Ok(Message::Text(text))) => {
                return serde_json::from_str(text.as_str()).map_err(|_| "E_TWIN_PROTOCOL".into())
            }
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
            _ => return Err("E_TWIN_CLOSED".into()),
        }
    }
}

/// Reaches the other computer at `addr` (`ip:port`) as `name`: with the
/// pairing kept from before, or else pairing now, `digits` told the six
/// digits to show while the person there is asked.
pub async fn join(
    addr: &str,
    name: &str,
    known: Option<(String, SealKey)>,
    digits: impl FnOnce(String),
) -> Result<Linked, String> {
    let stream = tokio::time::timeout(STEP_WAIT, TcpStream::connect(addr))
        .await
        .map_err(|_| "E_TWIN_UNREACHABLE".to_string())?
        .map_err(|_| "E_TWIN_UNREACHABLE".to_string())?;
    let config = WebSocketConfig::default()
        .max_message_size(Some(server::MAX_MESSAGE * 2))
        .max_frame_size(Some(server::MAX_MESSAGE * 2));
    let (mut socket, _) = tokio::time::timeout(
        STEP_WAIT,
        tokio_tungstenite::client_async_with_config(format!("ws://{addr}/"), stream, Some(config)),
    )
    .await
    .map_err(|_| "E_TWIN_UNREACHABLE".to_string())?
    .map_err(|_| "E_TWIN_UNREACHABLE".to_string())?;

    let challenge = text(&mut socket, STEP_WAIT).await?;
    if challenge["t"] != "challenge" {
        return Err("E_TWIN_PROTOCOL".into());
    }
    let challenge = challenge["c"].as_str().unwrap_or_default().to_string();
    let inside = json!({ "c": challenge, "name": name }).to_string();
    let (device, key, pairing) = match known {
        Some((device, key)) => (Some(device), key, false),
        None => {
            let ours = pairpc::half().ok_or("E_TWIN_PAIR")?;
            let our_public = ours.public;
            let ask = json!({ "t": "pcPair", "pub": pairpc::to_text(&our_public) });
            socket
                .send(Message::Text(ask.to_string().into()))
                .await
                .map_err(|_| "E_TWIN_CLOSED".to_string())?;
            let answer = text(&mut socket, STEP_WAIT).await?;
            if answer["t"] == "refused" {
                return Err("E_TWIN_NOT_OPEN".into());
            }
            let theirs = answer["pub"]
                .as_str()
                .filter(|_| answer["t"] == "pcPairPub")
                .and_then(pairpc::from_text)
                .ok_or("E_TWIN_PROTOCOL")?;
            let agreed = pairpc::agree(ours, &theirs, &our_public, &theirs).ok_or("E_TWIN_PAIR")?;
            digits(agreed.digits.clone());
            (None, agreed.key, true)
        }
    };
    let hello = json!({
        "t": "hello",
        "device": device,
        "box": seal::to_base64(&seal::seal(&key, inside.as_bytes())),
    });
    socket
        .send(Message::Text(hello.to_string().into()))
        .await
        .map_err(|_| "E_TWIN_CLOSED".to_string())?;

    let session = seal::session_key(&key, &challenge);
    let mut in_seq = 0u64;
    let mut welcome = None;
    let wait = if pairing { PAIR_WAIT } else { STEP_WAIT };
    loop {
        let next = tokio::time::timeout(wait, socket.next())
            .await
            .map_err(|_| "E_TWIN_TIMEOUT".to_string())?;
        match next {
            Some(Ok(Message::Text(said))) => {
                let said: Value = serde_json::from_str(said.as_str()).unwrap_or_default();
                match said["t"].as_str() {
                    Some("waiting") => continue,
                    Some("refused") if said["why"] == "denied" => {
                        return Err("E_TWIN_DENIED".into())
                    }
                    Some("refused") => return Err("E_TWIN_REFUSED".into()),
                    _ => return Err("E_TWIN_PROTOCOL".into()),
                }
            }
            Some(Ok(Message::Binary(sealed))) => {
                let message =
                    opened_from_pc(&session, &mut in_seq, &sealed).ok_or("E_TWIN_PROTOCOL")?;
                match message["t"].as_str() {
                    Some("welcome") => {
                        let device = message["device"].as_str().unwrap_or_default().to_string();
                        let key = message["key"]
                            .as_str()
                            .and_then(seal::key_from_text)
                            .ok_or("E_TWIN_PROTOCOL")?;
                        welcome = Some((device, key));
                    }
                    Some("ready") => {
                        return Ok(Linked {
                            socket,
                            session,
                            out_seq: 0,
                            in_seq,
                            ready: message,
                            welcome,
                        })
                    }
                    _ => continue,
                }
            }
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
            _ => return Err("E_TWIN_CLOSED".into()),
        }
    }
}

/// The other computer's address, found again on the network by the tag
/// only its pairing makes (it moved: a new address from the router).
fn find_again(helper: &Helper) -> Option<String> {
    let key = helper.key()?;
    find(Duration::from_secs(3))
        .into_iter()
        .find(|found| found.tags.contains(&seal::here_tag(&key, &found.addr)))
        .map(|found| found.addr)
}

/// Keeps the link up while this generation lasts: reaches the other
/// computer, carries messages both ways, and tries again when it drops.
async fn keep_linked(app: AppHandle<Wry>, twin: Arc<Twin>, mut helper: Helper, generation: u64) {
    let mut backoff = Duration::from_secs(1);
    while twin.current(generation) {
        let Some(key) = helper.key() else {
            twin.set_state(&app, "refused");
            return;
        };
        let known = Some((helper.device.clone(), key));
        match join(&helper.addr, &super::pc_name(), known, |_| {}).await {
            Ok(linked) => {
                backoff = Duration::from_secs(1);
                run_link(&app, &twin, linked, generation).await;
            }
            Err(error) if error == "E_TWIN_REFUSED" => {
                // The other computer forgot this one: pairing again is needed.
                twin.set_state(&app, "refused");
                tokio::time::sleep(Duration::from_secs(30)).await;
                continue;
            }
            Err(_) => {
                let found = {
                    let helper = helper.clone();
                    tokio::task::spawn_blocking(move || find_again(&helper))
                        .await
                        .ok()
                        .flatten()
                };
                if let Some(addr) = found.filter(|addr| *addr != helper.addr) {
                    helper.addr = addr;
                    if let Ok(mut config) = twin.config.lock() {
                        if let Some(kept) = config.helper.as_mut() {
                            kept.addr = helper.addr.clone();
                        }
                        save(&app, &config);
                    }
                    continue;
                }
            }
        }
        if !twin.current(generation) {
            break;
        }
        twin.set_state(&app, "looking");
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(MAX_BACKOFF);
    }
}

async fn run_link(app: &AppHandle<Wry>, twin: &Arc<Twin>, mut linked: Linked, generation: u64) {
    let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
    let screen = linked.ready["screen"]
        .as_array()
        .and_then(|s| Some((s.first()?.as_i64()? as i32, s.get(1)?.as_i64()? as i32)))
        .filter(|(w, h)| *w > 0 && *h > 0)
        .unwrap_or((1920, 1080));
    let link = Link {
        tx,
        os: linked.ready["os"].as_str().unwrap_or_default().to_string(),
        screen,
    };
    if let Ok(mut slot) = twin.link.lock() {
        *slot = Some(link);
    }
    twin.set_state(app, "ready");
    let mut beat = tokio::time::interval(BEAT_EVERY);
    let mut heard = Instant::now();
    loop {
        if !twin.current(generation) {
            break;
        }
        tokio::select! {
            _ = beat.tick() => {
                if heard.elapsed() > SILENT || !linked.send(json!({ "t": "beat" })).await {
                    break;
                }
            }
            outgoing = rx.recv() => {
                let Some(message) = outgoing else { break };
                if !linked.send(message).await {
                    break;
                }
            }
            incoming = linked.socket.next() => {
                let Some(Ok(frame)) = incoming else { break };
                heard = Instant::now();
                let Message::Binary(sealed) = frame else { continue };
                let Some(message) = linked.opened(&sealed) else { break };
                if message["t"] == "clip" && twin.clipboard.load(Ordering::Relaxed) {
                    if let Some(clip) = clip::from_phone(&message) {
                        twin.last_clip.store(clip.fingerprint(), Ordering::Relaxed);
                        clip::write(&clip);
                    }
                }
            }
        }
    }
    if let Ok(mut slot) = twin.link.lock() {
        *slot = None;
    }
    let _ = linked.socket.close(None).await;
}

// ---- The pointer ---------------------------------------------------------

/// Watches the pointer for a crossing while the link is up.
fn watch_pointer(app: AppHandle<Wry>, twin: Arc<Twin>, generation: u64) {
    let mut before: Option<(i32, i32)> = None;
    while twin.current(generation) {
        let (Some(link), Some(desk), Some(now)) =
            (twin.link(), capture::desktop(), capture::cursor())
        else {
            before = None;
            std::thread::sleep(Duration::from_millis(250));
            continue;
        };
        let side = twin.config.lock().map(|c| c.side).unwrap_or_default();
        if let Some(was) = before {
            if crossing(side, was, now, desk) && !capture::held() {
                go_over(
                    &app,
                    &twin,
                    &link,
                    Away::enter(side, now, desk, link.screen),
                    generation,
                );
                before = None;
                continue;
            }
        }
        before = Some(now);
        std::thread::sleep(LOOK_EVERY);
    }
}

fn button_name(button: capture::Button) -> &'static str {
    match button {
        capture::Button::Left => "left",
        capture::Button::Right => "right",
        capture::Button::Middle => "middle",
    }
}

/// The pointer is over there until it comes back, the link drops, or the
/// person presses Ctrl+Alt+Esc.
fn go_over(app: &AppHandle<Wry>, twin: &Arc<Twin>, link: &Link, mut away: Away, generation: u64) {
    let (tx, events) = std::sync::mpsc::channel();
    let park = capture::main_screen()
        .map(|r| r.center())
        .unwrap_or(away.home());
    let Some(grab) = capture::Grab::start(park, tx) else {
        twin.set_state(app, "permission");
        capture::place(away.home().0, away.home().1);
        std::thread::sleep(Duration::from_secs(2));
        return;
    };
    twin.set_state(app, "away");
    // What was copied here goes along, ready to paste there.
    if twin.clipboard.load(Ordering::Relaxed) {
        if let Some(now) = clip::read() {
            let print = now.fingerprint();
            if twin.last_clip.swap(print, Ordering::Relaxed) != print {
                let _ = link.tx.send(clip::to_phone(&now));
            }
        }
    }
    let (x, y) = away.at();
    link.pc(json!({ "k": "at", "x": x, "y": y }));

    let this_os = std::env::consts::OS;
    let mut moved = (0i32, 0i32);
    let mut wheel = (0i32, 0i32);
    let mut sent_at = Instant::now();
    let mut checked_at = Instant::now();
    let mut lost = 0;
    let home = loop {
        match events.recv_timeout(Duration::from_millis(4)) {
            Ok(Event::Moved { dx, dy }) => {
                moved.0 = moved.0.saturating_add(dx);
                moved.1 = moved.1.saturating_add(dy);
            }
            Ok(Event::Wheel { dx, dy }) => {
                wheel.0 += dx;
                wheel.1 += dy;
            }
            Ok(Event::Button { button, down }) => {
                if moved != (0, 0) {
                    if let Step::Home(x, y) = away.step(moved.0, moved.1) {
                        break (x, y);
                    }
                    moved = (0, 0);
                    let (x, y) = away.at();
                    link.pc(json!({ "k": "at", "x": x, "y": y }));
                }
                link.pc(json!({ "k": "button", "b": button_name(button), "down": down }));
            }
            Ok(Event::Key { name, down }) => {
                let name = keys::across(name, this_os, &link.os);
                link.pc(json!({ "k": "code", "code": name, "down": down }));
            }
            Ok(Event::Home) | Ok(Event::Lost) => break away.home(),
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break away.home(),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
        }
        if sent_at.elapsed() >= SEND_EVERY {
            sent_at = Instant::now();
            if moved != (0, 0) {
                match away.step(moved.0, moved.1) {
                    Step::Home(x, y) => break (x, y),
                    Step::There(x, y) => link.pc(json!({ "k": "at", "x": x, "y": y })),
                }
                moved = (0, 0);
            }
            if wheel != (0, 0) {
                link.pc(json!({ "k": "wheel", "dx": wheel.0, "dy": wheel.1 }));
                wheel = (0, 0);
            }
        }
        if checked_at.elapsed() >= Duration::from_millis(200) {
            checked_at = Instant::now();
            if !twin.current(generation) || link.tx.is_closed() || twin.link().is_none() {
                break away.home();
            }
            lost = if grab.alive() { 0 } else { lost + 1 };
            if lost >= 3 {
                break away.home();
            }
        }
    };
    // Keys and buttons held there come up; the mouse is this computer's again.
    link.pc(json!({ "k": "leave" }));
    drop(grab);
    capture::place(home.0, home.1);
    if twin.current(generation) {
        let state = if twin.link().is_some() {
            "ready"
        } else {
            "looking"
        };
        twin.set_state(app, state);
    }
}

// ---- Finding computers ---------------------------------------------------

/// A ZOOD on the network with its remote ready.
#[derive(Clone, Debug)]
pub struct Found {
    pub pc: String,
    pub addr: String,
    tags: Vec<[u8; 8]>,
}

/// The ZOODs announcing themselves within `wait`, this computer left out.
pub fn find(wait: Duration) -> Vec<Found> {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;
    use mdns_sd::{ServiceDaemon, ServiceEvent};

    let Ok(daemon) = ServiceDaemon::new() else {
        return Vec::new();
    };
    let Ok(events) = daemon.browse(super::announce::SERVICE) else {
        let _ = daemon.shutdown();
        return Vec::new();
    };
    let ours: Vec<String> = super::local_addresses()
        .iter()
        .map(|ip| ip.to_string())
        .collect();
    let until = Instant::now() + wait;
    let mut found: Vec<Found> = Vec::new();
    while let Some(left) = until.checked_duration_since(Instant::now()) {
        let Ok(event) = events.recv_timeout(left) else {
            break;
        };
        let ServiceEvent::ServiceResolved(info) = event else {
            continue;
        };
        let (Some(ip), Some(port)) = (
            info.get_property_val_str("addr"),
            info.get_property_val_str("port"),
        ) else {
            continue;
        };
        let (Ok(ip), Ok(port)) = (ip.parse::<std::net::Ipv4Addr>(), port.parse::<u16>()) else {
            continue;
        };
        if ours.contains(&ip.to_string()) || found.len() >= 16 {
            continue;
        }
        let addr = format!("{ip}:{port}");
        let tags = info
            .get_property_val_str("seen")
            .and_then(|seen| URL_SAFE_NO_PAD.decode(seen).ok())
            .map(|bytes| bytes.chunks(8).filter_map(|c| c.try_into().ok()).collect())
            .unwrap_or_default();
        let pc = super::devices::tidy_name(info.get_property_val_str("pc").unwrap_or("ZOOD PDF"));
        found.retain(|f| f.addr != addr);
        found.push(Found { pc, addr, tags });
    }
    let _ = daemon.stop_browse(super::announce::SERVICE);
    let _ = daemon.shutdown();
    found
}

// ---- The interface -------------------------------------------------------

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundPc {
    pub pc: String,
    pub addr: String,
}

#[tauri::command]
pub fn twin_status(state: State<'_, TwinState>) -> TwinStatus {
    state.0.status()
}

/// Looks for other computers with ZOOD's remote ready (about 3 seconds).
#[tauri::command]
pub async fn twin_find() -> Vec<FoundPc> {
    tokio::task::spawn_blocking(|| find(Duration::from_secs(3)))
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|f| FoundPc {
            pc: f.pc,
            addr: f.addr,
        })
        .collect()
}

/// Pairs with the computer at `addr`: the digits show here (and there)
/// until the person there allows it. Turns sharing on once paired.
#[tauri::command]
pub async fn twin_pair(
    app: AppHandle<Wry>,
    state: State<'_, TwinState>,
    addr: String,
    pc: String,
) -> Result<TwinStatus, String> {
    let twin = state.0.clone();
    if addr.parse::<std::net::SocketAddrV4>().is_err() {
        return Err("E_TWIN_UNREACHABLE".into());
    }
    // Paused while pairing, so the old link does not get in the way.
    twin.generation.fetch_add(1, Ordering::Relaxed);
    let shown = {
        let (app, twin) = (app.clone(), twin.clone());
        move |digits: String| {
            if let Ok(mut slot) = twin.digits.lock() {
                *slot = Some(digits);
            }
            let _ = app.emit(TWIN_EVENT, twin.status());
        }
    };
    let result = join(&addr, &super::pc_name(), None, shown).await;
    if let Ok(mut slot) = twin.digits.lock() {
        *slot = None;
    }
    let outcome = match result {
        Ok(mut linked) => match linked.welcome.take() {
            Some((device, key)) => {
                let _ = linked.socket.close(None).await;
                if let Ok(mut config) = twin.config.lock() {
                    config.on = true;
                    config.helper = Some(Helper {
                        pc: super::devices::tidy_name(&pc),
                        device,
                        key: seal::key_to_text(&key),
                        addr,
                    });
                    save(&app, &config);
                }
                Ok(())
            }
            None => Err("E_TWIN_PROTOCOL".to_string()),
        },
        Err(error) => Err(error),
    };
    restart(&app, &twin);
    let status = twin.status();
    let _ = app.emit(TWIN_EVENT, status.clone());
    outcome.map(|_| status)
}

/// On or off, and where the other screen is; remembered.
#[tauri::command]
pub fn twin_set(
    app: AppHandle<Wry>,
    state: State<'_, TwinState>,
    on: Option<bool>,
    side: Option<Side>,
) -> TwinStatus {
    let twin = state.0.clone();
    let mut restart_needed = false;
    if let Ok(mut config) = twin.config.lock() {
        if let Some(on) = on {
            restart_needed = config.on != on;
            config.on = on;
        }
        if let Some(side) = side {
            config.side = side;
        }
        save(&app, &config);
    }
    if restart_needed {
        restart(&app, &twin);
    }
    let status = twin.status();
    let _ = app.emit(TWIN_EVENT, status.clone());
    status
}

/// Forgets the other computer (it can be paired again).
#[tauri::command]
pub fn twin_forget(app: AppHandle<Wry>, state: State<'_, TwinState>) -> TwinStatus {
    let twin = state.0.clone();
    if let Ok(mut config) = twin.config.lock() {
        config.helper = None;
        config.on = false;
        save(&app, &config);
    }
    restart(&app, &twin);
    let status = twin.status();
    let _ = app.emit(TWIN_EVENT, status.clone());
    status
}

/// How long this computer may be paired with after the person says so.
const OFFER_FOR: Duration = Duration::from_secs(180);

/// This computer ready to be used from another one: the remote on (no QR
/// code), and for three minutes another computer may ask to pair. Once one
/// has, the remote comes on at every launch (`start_if_ready`); "Keep the
/// remote ready", the phones' switch, is left as the person set it.
#[tauri::command]
pub async fn twin_offer(app: AppHandle<Wry>) -> Result<super::Status, String> {
    let status = super::start(&app, false).await?;
    let state = app.state::<super::RemoteState>();
    if let Some(shared) = super::running(&state) {
        if let Ok(mut until) = shared.pc_pairing.lock() {
            *until = Some(Instant::now() + OFFER_FOR);
        }
        shared.changed();
        return Ok(super::status_of(Some(&shared), &app));
    }
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;

    const DESK: Rect = Rect {
        left: 0,
        top: 0,
        right: 1920,
        bottom: 1080,
    };

    #[test]
    fn crosses_only_when_pushed_over_the_chosen_edge() {
        assert!(crossing(Side::Auto, (1900, 500), (1919, 500), DESK));
        assert!(crossing(Side::Right, (1900, 500), (1919, 500), DESK));
        // Crept up to, one pixel at a time: a scroll bar, not a crossing.
        assert!(!crossing(Side::Right, (1918, 500), (1919, 500), DESK));
        // The other edges do nothing while the screen is on the right.
        assert!(!crossing(Side::Right, (20, 500), (0, 500), DESK));
        assert!(crossing(Side::Left, (20, 500), (0, 500), DESK));
        assert!(crossing(Side::Top, (900, 30), (900, 0), DESK));
        assert!(crossing(Side::Bottom, (900, 1060), (900, 1079), DESK));
        assert!(!crossing(Side::Bottom, (900, 1060), (900, 1070), DESK));
    }

    #[test]
    fn the_pointer_arrives_at_the_same_height_and_comes_back_there() {
        let mut away = Away::enter(Side::Right, (1919, 540), DESK, (2560, 1440));
        assert_eq!(away.at(), (0, 720));
        assert_eq!(away.step(100, -20), Step::There(100, 700));
        // Off the far edges it stays on the screen.
        assert_eq!(away.step(5000, 5000), Step::There(2559, 1439));
        assert_eq!(away.step(-2559, -719), Step::There(0, 720));
        // Back over the edge it came in by: home, a little in from the edge.
        assert_eq!(away.step(-1, 0), Step::Home(1915, 540));
    }

    #[test]
    fn every_side_comes_back_over_its_own_edge() {
        let mut left = Away::enter(Side::Left, (0, 0), DESK, (1000, 500));
        assert_eq!(left.at(), (999, 0));
        assert!(matches!(left.step(1, 0), Step::Home(4, 0)));

        let mut top = Away::enter(Side::Top, (960, 0), DESK, (1000, 500));
        assert_eq!(top.at(), (500, 499));
        assert!(matches!(top.step(0, -300), Step::There(500, 199)));
        assert!(matches!(top.step(0, 301), Step::Home(960, 4)));

        let mut bottom = Away::enter(Side::Bottom, (960, 1079), DESK, (1000, 500));
        assert_eq!(bottom.at(), (500, 0));
        assert!(matches!(bottom.step(0, -1), Step::Home(960, 1075)));
    }

    #[test]
    fn odd_sizes_do_not_break_it() {
        let tiny = Rect {
            left: -1920,
            top: 0,
            right: 0,
            bottom: 1,
        };
        let mut away = Away::enter(Side::Right, (-1, 0), tiny, (0, 0));
        assert_eq!(away.at(), (0, 0));
        assert_eq!(away.step(i32::MAX, i32::MAX), Step::There(0, 0));
        assert!(matches!(away.step(i32::MIN, 0), Step::Home(_, 0)));
    }

    #[test]
    fn the_settings_read_back_and_old_files_still_load() {
        let config = Config {
            on: true,
            side: Side::Left,
            helper: Some(Helper {
                pc: "OFFICE-PC".into(),
                device: "d1".into(),
                key: seal::key_to_text(&[3u8; 32]),
                addr: "192.168.1.9:47800".into(),
            }),
        };
        let text = serde_json::to_string(&config).unwrap();
        let back: Config = serde_json::from_str(&text).unwrap();
        assert_eq!(back.side, Side::Left);
        assert_eq!(back.helper.unwrap().key(), Some([3u8; 32]));
        let empty: Config = serde_json::from_str("{}").unwrap();
        assert!(!empty.on);
        assert_eq!(empty.side, Side::Auto);
    }
}
