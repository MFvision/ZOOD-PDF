//! The phone remote: a phone on the same Wi-Fi presents the open PDF, works
//! the PC as its trackpad and keyboard, and swaps files and signatures with
//! it. No account and nothing on the internet: the phone and the PC talk
//! directly, locked with the key in the QR code the PC shows (`seal.rs`).
//!
//! This side is only the link. It listens while the person has the remote
//! on (`server.rs`), carries PC control out itself when that is switched on
//! (`input.rs`), remembers paired phones (`devices.rs`) and hands every
//! other message to the interface as [`MESSAGE_EVENT`], where the document
//! is (`packages/ui/src/remote/`). The interface answers with `remote_send`.

pub mod announce;
pub mod capture;
pub mod clip;
pub mod devices;
pub mod input;
pub mod keys;
pub mod pairpc;
pub mod seal;
pub mod server;
pub mod stream;
pub mod transfer;
pub mod twin;

use std::collections::HashMap;
use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, UdpSocket};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, Runtime, State, Wry};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot, watch};

use devices::Phones;
use seal::SealKey;

/// A phone's message for the interface. Payload: `{ peer, message }`;
/// `message.t` is what it is (`joined` and `left` come from here).
pub const MESSAGE_EVENT: &str = "warraq://remote-message";

/// The remote's state changed: a phone came or went, a new code, PC control
/// on or off. Payload: [`Status`].
pub const STATUS_EVENT: &str = "warraq://remote-status";

/// The port tried first, so a phone that saved the page finds it again.
const PORT: u16 = 47800;

/// A phone that scanned the code asks to pair; the PC asks the person.
/// Payload: `{ id, name }`. Answered with `remote_pair_answer`.
pub const PAIR_ASK_EVENT: &str = "warraq://remote-pair-ask";

/// That question is settled (answered, timed out or the phone left), so every
/// window takes it away. Payload: `{ id }`.
pub const PAIR_DONE_EVENT: &str = "warraq://remote-pair-done";

/// How long the PC waits for the person to allow a new phone.
const PAIR_ASK_WAIT: Duration = Duration::from_secs(90);

/// The questions on screen, by id, each with where its answer goes.
fn pair_asks() -> &'static Mutex<HashMap<String, oneshot::Sender<bool>>> {
    static ASKS: OnceLock<Mutex<HashMap<String, oneshot::Sender<bool>>>> = OnceLock::new();
    ASKS.get_or_init(Default::default)
}

/// How long a QR code pairs a new phone.
const CODE_LIFE: Duration = Duration::from_secs(5 * 60);

/// A phone connected now.
pub struct Peer {
    pub device: String,
    pub name: String,
    pub tx: mpsc::UnboundedSender<Value>,
    /// Another computer (`twin.rs`): its mouse and keyboard work here.
    pub pc: bool,
}

/// The QR code on screen.
struct Code {
    key: SealKey,
    until: Instant,
    /// Milliseconds since 1970, for the interface.
    until_ms: u64,
}

/// What the remote needs from the app: a way to tell the interface, and the
/// web app's own files, which hold the phone's page. The app is the host; a
/// test can be one without a window (it then runs on any machine).
pub trait Host: Send + Sync + 'static {
    fn tell(&self, event: &str, payload: Value);
    /// A file of the web app and its media type.
    fn asset(&self, name: &str) -> Option<(Vec<u8>, String)>;
    /// Where files flicked from a phone land: the Desktop.
    fn landing_folder(&self) -> Option<std::path::PathBuf>;
    /// A flicked file arrived at `path`: the PC shows it coming in.
    fn landed(&self, path: &std::path::Path, mime: &str, picture: Option<&str>);
    /// A phone that scanned the code on screen wants to pair: true only once
    /// the person allows it on the PC. A photo of the code is not enough.
    fn allow_new_phone(&self, name: &str) -> Pin<Box<dyn Future<Output = bool> + Send>>;
    /// Another computer wants to use its mouse and keyboard here: true only
    /// once the person allows it, having seen `digits` match on both screens.
    fn allow_new_pc(&self, name: &str, digits: &str) -> Pin<Box<dyn Future<Output = bool> + Send>>;
}

impl<R: Runtime> Host for AppHandle<R> {
    fn tell(&self, event: &str, payload: Value) {
        let _ = self.emit(event, payload);
    }

    fn asset(&self, name: &str) -> Option<(Vec<u8>, String)> {
        self.asset_resolver()
            .get(name.to_string())
            .map(|asset| (asset.bytes, asset.mime_type))
    }

    fn landing_folder(&self) -> Option<std::path::PathBuf> {
        transfer::landing_folder(self.path().desktop_dir().ok(), self.path().home_dir().ok())
    }

    fn landed(&self, path: &std::path::Path, mime: &str, picture: Option<&str>) {
        crate::arrival::show(self, path, mime, picture);
    }

    fn allow_new_phone(&self, name: &str) -> Pin<Box<dyn Future<Output = bool> + Send>> {
        ask_pairing(self, name, None)
    }

    fn allow_new_pc(&self, name: &str, digits: &str) -> Pin<Box<dyn Future<Output = bool> + Send>> {
        ask_pairing(self, name, Some(digits))
    }
}

/// "Allow this phone?" (or this computer, with its six digits) on the PC.
fn ask_pairing<R: Runtime>(
    app: &AppHandle<R>,
    name: &str,
    digits: Option<&str>,
) -> Pin<Box<dyn Future<Output = bool> + Send>> {
    let id = seal::random_id();
    let (answer, answered) = oneshot::channel();
    if let Ok(mut asks) = pair_asks().lock() {
        asks.insert(id.clone(), answer);
    }
    let _ = app.emit(
        PAIR_ASK_EVENT,
        serde_json::json!({ "id": id, "name": devices::tidy_name(name), "digits": digits }),
    );
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.request_user_attention(Some(tauri::UserAttentionType::Critical));
    }
    let app = app.clone();
    Box::pin(async move {
        let allowed = matches!(
            tokio::time::timeout(PAIR_ASK_WAIT, answered).await,
            Ok(Ok(true))
        );
        if let Ok(mut asks) = pair_asks().lock() {
            asks.remove(&id);
        }
        let _ = app.emit(PAIR_DONE_EVENT, serde_json::json!({ "id": id }));
        allowed
    })
}

/// The person's answer to "Allow this phone?"; false when the question is gone.
#[tauri::command]
pub fn remote_pair_answer(id: String, allow: bool) -> bool {
    pair_asks()
        .lock()
        .ok()
        .and_then(|mut asks| asks.remove(&id))
        .is_some_and(|answer| answer.send(allow).is_ok())
}

/// What the server and the commands share while the remote is on.
pub struct Shared<H: Host> {
    host: H,
    port: u16,
    /// Looked at again every few seconds (`watch_network`): a PC that moves
    /// to another Wi-Fi shows a QR code for where it is now.
    addresses: Mutex<Vec<Ipv4Addr>>,
    code: Mutex<Option<Code>>,
    phones: Mutex<Phones>,
    peers: Mutex<server::Peers>,
    next_peer: AtomicU64,
    pc_control: AtomicBool,
    /// The clipboard shared with the phones (`clip.rs`); on by default.
    clipboard: AtomicBool,
    /// The last clip either side put on the PC's clipboard, so it is not sent back.
    last_clip: AtomicU64,
    /// "Keep the remote ready" (`remote-ready`), shown in the panel.
    keep_ready: AtomicBool,
    /// Files on their way in parts, either way (`stream.rs`).
    streams: Mutex<stream::Streams>,
    /// Where the remote is, said on the network for the iPhone app (`announce.rs`).
    announced: Mutex<Option<announce::Announcer>>,
    /// Files let go on "To phone" before any phone was there: the first
    /// phone that joins gets them (`give_waiting`).
    waiting: Mutex<Vec<std::path::PathBuf>>,
    /// Until when another computer may ask to pair (`twin.rs`): only for a
    /// few minutes after the person here says so, like Bluetooth pairing.
    pc_pairing: Mutex<Option<Instant>>,
}

impl<H: Host> Shared<H> {
    /// The key of the code on screen, while it still pairs.
    fn code(&self) -> Option<SealKey> {
        let code = self.code.lock().ok()?;
        code.as_ref()
            .filter(|c| c.until > Instant::now())
            .map(|c| c.key)
    }

    fn pc_pairing_open(&self) -> bool {
        self.pc_pairing
            .lock()
            .ok()
            .and_then(|until| *until)
            .is_some_and(|until| until > Instant::now())
    }

    fn used_code(&self) {
        if let Ok(mut code) = self.code.lock() {
            *code = None;
        }
    }

    fn new_code(&self) {
        if let Ok(mut code) = self.code.lock() {
            let until_ms = SystemTime::now()
                .checked_add(CODE_LIFE)
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            *code = Some(Code {
                key: seal::random_key(),
                until: Instant::now() + CODE_LIFE,
                until_ms,
            });
        }
    }

    fn pc_control_on(&self) -> bool {
        self.pc_control.load(Ordering::Relaxed)
    }

    fn clipboard_on(&self) -> bool {
        self.clipboard.load(Ordering::Relaxed)
    }

    /// Sends `message` to every connected phone.
    fn to_all(&self, message: &Value) -> bool {
        let Ok(peers) = self.peers.lock() else {
            return false;
        };
        let mut sent = false;
        for peer in peers.values() {
            sent |= peer.tx.send(message.clone()).is_ok();
        }
        sent
    }

    /// Says on the network where the remote is now (again, after a move).
    fn announce(&self) {
        let first = self.addresses.lock().ok().and_then(|a| a.first().copied());
        if let Ok(mut slot) = self.announced.lock() {
            // The old one goes first, so the network never hears two.
            *slot = None;
            let keys: Vec<seal::SealKey> = self
                .phones
                .lock()
                .map(|phones| phones.list().iter().filter_map(|p| p.key()).collect())
                .unwrap_or_default();
            *slot =
                first.and_then(|ip| announce::Announcer::start(&pc_name(), ip, self.port, &keys));
            if slot.is_none() {
                core_bridge_log(
                    "remote: not announced on this network (the QR code still works)".into(),
                );
            }
        }
    }

    /// Sends `message` to one connected phone.
    fn to_peer(&self, peer: u64, message: Value) -> bool {
        self.peers
            .lock()
            .ok()
            .and_then(|peers| peers.get(&peer).map(|p| p.tx.send(message).is_ok()))
            .unwrap_or(false)
    }

    /// Tells the interface what changed.
    fn changed(&self) {
        self.host.tell(
            STATUS_EVENT,
            serde_json::to_value(self.status()).unwrap_or_default(),
        );
    }
}

struct Running {
    shared: Arc<Shared<AppHandle<Wry>>>,
    stop: watch::Sender<bool>,
}

#[derive(Default)]
pub struct RemoteState(Mutex<Option<Running>>);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConnectedPhone {
    pub peer: u64,
    pub device: String,
    pub name: String,
    /// Another computer using its mouse and keyboard here (`twin.rs`).
    pub pc: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RememberedPhone {
    pub id: String,
    pub name: String,
    pub pc: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub running: bool,
    /// The address the QR code holds, its key included; `None` while no code
    /// pairs (used, run out, or no network).
    pub url: Option<String>,
    /// That address as a QR code, an SVG.
    pub qr: Option<String>,
    pub code_until: Option<u64>,
    /// The page's address without the key, for a phone that was paired before.
    pub address: Option<String>,
    pub phones: Vec<ConnectedPhone>,
    pub remembered: Vec<RememberedPhone>,
    pub pc_control: bool,
    pub pc_control_available: bool,
    /// The clipboard is shared with the phones.
    pub clipboard: bool,
    pub clipboard_available: bool,
    /// The remote comes on by itself at launch for phones paired before.
    pub keep_ready: bool,
    /// Files waiting for a phone to join (let go on "To phone" with none
    /// there): the panel opens with its QR code while there are some.
    pub waiting: usize,
    /// Another computer may pair now ("Let a computer pair", `twin.rs`).
    pub pc_pairing: bool,
}

fn phones_file<R: Runtime>(app: &AppHandle<R>) -> Option<std::path::PathBuf> {
    Some(app.path().app_data_dir().ok()?.join("remote-phones.json"))
}

/// The computer's name, as phones show it.
pub fn pc_name() -> String {
    for var in ["COMPUTERNAME", "HOSTNAME"] {
        if let Ok(name) = std::env::var(var) {
            if !name.trim().is_empty() {
                return devices::tidy_name(&name);
            }
        }
    }
    String::new()
}

/// This PC's addresses on the local network, the one its traffic leaves by
/// first. Asking the system which way it would reach a far address sends
/// nothing.
fn local_addresses() -> Vec<Ipv4Addr> {
    let mut found: Vec<Ipv4Addr> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter(|i| !i.is_loopback())
        .filter_map(|i| match i.ip() {
            IpAddr::V4(ip) if ip.is_private() || ip.is_link_local() => Some(ip),
            _ => None,
        })
        .collect();
    let preferred = UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| {
            s.connect("192.0.2.1:9")?;
            s.local_addr()
        })
        .ok()
        .and_then(|a| match a.ip() {
            IpAddr::V4(ip) => Some(ip),
            _ => None,
        });
    // Link-local addresses (169.254…) last: they reach only a cable.
    found.sort_by_key(|ip| (Some(*ip) != preferred, ip.is_link_local()));
    found.dedup();
    found
}

fn qr_svg(text: &str) -> Option<String> {
    use qrcode::render::svg;
    let code = qrcode::QrCode::with_error_correction_level(text, qrcode::EcLevel::M).ok()?;
    Some(
        code.render::<svg::Color>()
            .min_dimensions(232, 232)
            .dark_color(svg::Color("#041e42"))
            .light_color(svg::Color("#ffffff"))
            .quiet_zone(true)
            .build(),
    )
}

fn status_of<R: Runtime>(shared: Option<&Shared<AppHandle<R>>>, app: &AppHandle<R>) -> Status {
    let Some(shared) = shared else {
        let remembered = phones_file(app)
            .map(|f| Phones::load(&f))
            .unwrap_or_default()
            .list()
            .iter()
            .map(|p| RememberedPhone {
                id: p.id.clone(),
                name: p.name.clone(),
                pc: p.pc,
            })
            .collect();
        return Status {
            running: false,
            url: None,
            qr: None,
            code_until: None,
            address: None,
            phones: vec![],
            remembered,
            pc_control: false,
            pc_control_available: input::AVAILABLE,
            clipboard: clipboard_wanted(app),
            clipboard_available: CLIPBOARD_AVAILABLE,
            keep_ready: ready_wanted(app),
            waiting: 0,
            pc_pairing: false,
        };
    };
    shared.status()
}

impl<H: Host> Shared<H> {
    /// The remote's state while it is on.
    fn status(&self) -> Status {
        let shared = self;
        let address = shared
            .addresses
            .lock()
            .ok()
            .and_then(|a| a.first().copied())
            .map(|ip| format!("http://{ip}:{}/", shared.port));
        let (url, code_until) = match (&address, shared.code.lock().ok().as_deref()) {
            (Some(address), Some(Some(code))) if code.until > Instant::now() => (
                Some(format!("{address}#k={}", seal::key_to_url(&code.key))),
                Some(code.until_ms),
            ),
            _ => (None, None),
        };
        let mut phones: Vec<ConnectedPhone> = shared
            .peers
            .lock()
            .map(|p| {
                p.iter()
                    .map(|(peer, p)| ConnectedPhone {
                        peer: *peer,
                        device: p.device.clone(),
                        name: p.name.clone(),
                        pc: p.pc,
                    })
                    .collect()
            })
            .unwrap_or_default();
        phones.sort_by_key(|p| p.peer);
        let remembered = shared
            .phones
            .lock()
            .map(|p| {
                p.list()
                    .iter()
                    .map(|p| RememberedPhone {
                        id: p.id.clone(),
                        name: p.name.clone(),
                        pc: p.pc,
                    })
                    .collect()
            })
            .unwrap_or_default();
        Status {
            running: true,
            qr: url.as_deref().and_then(qr_svg),
            url,
            code_until,
            address,
            phones,
            remembered,
            pc_control: shared.pc_control_on(),
            pc_control_available: input::AVAILABLE,
            clipboard: shared.clipboard_on(),
            clipboard_available: CLIPBOARD_AVAILABLE,
            keep_ready: shared.keep_ready.load(Ordering::Relaxed),
            waiting: shared.waiting.lock().map(|w| w.len()).unwrap_or(0),
            pc_pairing: shared.pc_pairing_open(),
        }
    }
}

fn running(state: &State<'_, RemoteState>) -> Option<Arc<Shared<AppHandle<Wry>>>> {
    state.0.lock().ok()?.as_ref().map(|r| r.shared.clone())
}

/// Turns the remote on (or keeps it on) with a fresh QR code.
#[tauri::command]
pub async fn remote_start(
    app: AppHandle<Wry>,
    _state: State<'_, RemoteState>,
) -> Result<Status, String> {
    start(&app, true).await
}

/// The remote on: listening, the clipboard and the network watched. With
/// `code`, a fresh QR code pairs a new phone; without (started by itself at
/// launch), only phones paired before may come.
async fn start(app: &AppHandle<Wry>, code: bool) -> Result<Status, String> {
    let state = app.state::<RemoteState>();
    if let Some(shared) = running(&state) {
        if code {
            shared.new_code();
            shared.changed();
        }
        return Ok(status_of(Some(&shared), app));
    }
    let listener = listen().await?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("E_REMOTE: {e}"))?
        .port();
    let phones = phones_file(app)
        .map(|f| Phones::load(&f))
        .unwrap_or_default();
    let shared = Arc::new(Shared {
        host: app.clone(),
        port,
        addresses: Mutex::new(local_addresses()),
        code: Mutex::new(None),
        phones: Mutex::new(phones),
        peers: Mutex::new(Default::default()),
        next_peer: AtomicU64::new(1),
        pc_control: AtomicBool::new(false),
        clipboard: AtomicBool::new(clipboard_wanted(app) && CLIPBOARD_AVAILABLE),
        last_clip: AtomicU64::new(0),
        keep_ready: AtomicBool::new(ready_wanted(app)),
        streams: Mutex::new(Default::default()),
        announced: Mutex::new(None),
        waiting: Mutex::new(Vec::new()),
        pc_pairing: Mutex::new(None),
    });
    if code {
        shared.new_code();
    }
    let (stop, stopped) = watch::channel(false);
    tauri::async_runtime::spawn(server::run(shared.clone(), listener, stopped));
    watch_clipboard(Arc::downgrade(&shared));
    watch_network(Arc::downgrade(&shared));
    core_bridge_log(format!(
        "remote on, port {port}, addresses {:?}",
        shared
            .addresses
            .lock()
            .map(|a| a.clone())
            .unwrap_or_default()
    ));
    let status = status_of(Some(&shared), app);
    if let Ok(mut slot) = state.0.lock() {
        // Two starts at once: the first one in stays, this one lets go.
        if slot.is_some() {
            let _ = stop.send(true);
            drop(slot);
            return Ok(status_of(running(&state).as_deref(), app));
        }
        *slot = Some(Running {
            shared: shared.clone(),
            stop,
        });
    }
    shared.announce();
    let _ = app.emit(STATUS_EVENT, status.clone());
    Ok(status)
}

fn ready_file<R: Runtime>(app: &AppHandle<R>) -> Option<std::path::PathBuf> {
    Some(app.path().app_data_dir().ok()?.join("remote-ready"))
}

/// "Keep the remote ready": the person's choice, off unless they turned it on.
fn ready_wanted<R: Runtime>(app: &AppHandle<R>) -> bool {
    ready_file(app)
        .and_then(|f| std::fs::read_to_string(f).ok())
        .is_some_and(|v| v.trim() == "on")
}

/// At launch: with "Keep the remote ready" on and a phone paired before, the
/// remote comes on by itself (no QR code), so that phone finds the PC
/// without anyone pressing Phone remote first. Off by default.
pub fn start_if_ready(app: &AppHandle<Wry>) {
    if !ready_wanted(app) {
        return;
    }
    let paired = phones_file(app)
        .map(|f| !Phones::load(&f).list().is_empty())
        .unwrap_or(false);
    if !paired {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = start(&app, false).await {
            core_bridge_log(format!("remote: not ready at launch: {e}"));
        }
    });
}

/// Remembers "Keep the remote ready" for the next launch.
fn keep_ready_now<R: Runtime>(app: &AppHandle<R>, on: bool) {
    if let Some(file) = ready_file(app) {
        if let Some(folder) = file.parent() {
            let _ = std::fs::create_dir_all(folder);
        }
        let _ = std::fs::write(file, if on { "on" } else { "off" });
    }
    let state = app.try_state::<RemoteState>();
    if let Some(shared) = state.and_then(|s| s.0.lock().ok()?.as_ref().map(|r| r.shared.clone())) {
        shared.keep_ready.store(on, Ordering::Relaxed);
    }
}

/// "Keep the remote ready" on or off; remembered for the next launch.
#[tauri::command]
pub fn remote_keep_ready(app: AppHandle<Wry>, state: State<'_, RemoteState>, on: bool) -> Status {
    keep_ready_now(&app, on);
    let shared = running(&state);
    if let Some(shared) = &shared {
        shared.keep_ready.store(on, Ordering::Relaxed);
        shared.changed();
    }
    status_of(shared.as_deref(), &app)
}

/// The remote's port: the usual one, or one of the few after it when
/// another app holds it (a phone that saved the page then still finds it
/// after one more scan), and any free port only as a last resort.
async fn listen() -> Result<TcpListener, String> {
    for port in PORT..PORT + PORTS_TRIED {
        if let Ok(listener) = TcpListener::bind(("0.0.0.0", port)).await {
            return Ok(listener);
        }
    }
    TcpListener::bind(("0.0.0.0", 0))
        .await
        .map_err(|e| format!("E_REMOTE: {e}"))
}

/// How many ports from [`PORT`] on are tried before any free one.
const PORTS_TRIED: u16 = 10;

/// How often the PC's own address is looked at again while the remote is on.
const NETWORK_EVERY: Duration = Duration::from_secs(4);

/// While the remote is on: when the PC's address changes (another Wi-Fi, a
/// new address from the router, a cable put in), the QR code and the
/// address shown follow. Ends once the remote is off.
fn watch_network<H: Host>(shared: std::sync::Weak<Shared<H>>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(NETWORK_EVERY);
        let Some(shared) = shared.upgrade() else {
            return;
        };
        let now = local_addresses();
        let moved = shared
            .addresses
            .lock()
            .map(|mut known| {
                if known.first() == now.first() {
                    return false;
                }
                *known = now.clone();
                true
            })
            .unwrap_or(false);
        if moved {
            shared.announce();
            shared.changed();
            core_bridge_log(format!("remote: the PC's address is now {:?}", now.first()));
        }
    });
}

/// Whether this system has a clipboard the remote can share.
pub const CLIPBOARD_AVAILABLE: bool = cfg!(any(target_os = "windows", target_os = "macos"));

fn clipboard_file<R: Runtime>(app: &AppHandle<R>) -> Option<std::path::PathBuf> {
    Some(app.path().app_data_dir().ok()?.join("remote-clipboard"))
}

/// The person's choice from last time; on unless they turned it off.
fn clipboard_wanted<R: Runtime>(app: &AppHandle<R>) -> bool {
    clipboard_file(app)
        .and_then(|f| std::fs::read_to_string(f).ok())
        .is_none_or(|v| v.trim() != "off")
}

/// While the remote is on: what is copied on the PC goes to the phones.
/// Ends by itself once the remote is off (the last `Arc` gone).
fn watch_clipboard<H: Host>(shared: std::sync::Weak<Shared<H>>) {
    if !CLIPBOARD_AVAILABLE {
        return;
    }
    std::thread::spawn(move || {
        // What was on the clipboard when the remote came on is not news.
        let mut seen = clip::read().map(|c| c.fingerprint()).unwrap_or(0);
        // The clipboard is opened only once a copy has settled: reading it
        // every turn held it open again and again, and a screenshot tool
        // writing its picture then found it taken (and a big picture was
        // read and made a PNG each time).
        let mut settle = clip::Settle::new(clip::changes());
        loop {
            std::thread::sleep(Duration::from_millis(700));
            let Some(shared) = shared.upgrade() else {
                return;
            };
            let anyone = shared.peers.lock().map(|p| !p.is_empty()).unwrap_or(false);
            if !shared.clipboard_on() || !anyone {
                continue;
            }
            if !settle.ready(clip::changes()) {
                continue;
            }
            let Some(now) = clip::read() else {
                continue;
            };
            let print = now.fingerprint();
            if print == seen {
                continue;
            }
            seen = print;
            // The phone's own clip, just put there, does not go back to it.
            if shared.last_clip.swap(0, Ordering::Relaxed) == print {
                continue;
            }
            shared.to_all(&clip::to_phone(&now));
        }
    });
}

fn core_bridge_log(message: String) {
    crate::core_bridge::debug_log(message);
}

/// Turns the remote off: phones are let go and nothing listens.
#[tauri::command]
pub fn remote_stop(app: AppHandle<Wry>, state: State<'_, RemoteState>) -> Status {
    let taken = state.0.lock().ok().and_then(|mut slot| slot.take());
    if let Some(running) = taken {
        running.shared.pc_control.store(false, Ordering::Relaxed);
        if let Ok(mut announced) = running.shared.announced.lock() {
            *announced = None;
        }
        let _ = running.stop.send(true);
    }
    let status = status_of::<Wry>(None, &app);
    let _ = app.emit(STATUS_EVENT, status.clone());
    status
}

#[tauri::command]
pub fn remote_status(app: AppHandle<Wry>, state: State<'_, RemoteState>) -> Status {
    status_of(running(&state).as_deref(), &app)
}

/// PC control on or off; only while the remote is on.
#[tauri::command]
pub fn remote_pc_control(app: AppHandle<Wry>, state: State<'_, RemoteState>, on: bool) -> Status {
    let shared = running(&state);
    if let Some(shared) = &shared {
        shared
            .pc_control
            .store(on && input::AVAILABLE, Ordering::Relaxed);
        let flag = serde_json::json!({ "t": "pcControl", "on": shared.pc_control_on() });
        if let Ok(peers) = shared.peers.lock() {
            for peer in peers.values() {
                let _ = peer.tx.send(flag.clone());
            }
        }
        shared.changed();
    }
    status_of(shared.as_deref(), &app)
}

/// The clipboard shared with the phones, on or off; remembered for next time.
#[tauri::command]
pub fn remote_clipboard(app: AppHandle<Wry>, state: State<'_, RemoteState>, on: bool) -> Status {
    if let Some(file) = clipboard_file(&app) {
        let _ = std::fs::write(file, if on { "on" } else { "off" });
    }
    let shared = running(&state);
    if let Some(shared) = &shared {
        shared
            .clipboard
            .store(on && CLIPBOARD_AVAILABLE, Ordering::Relaxed);
        shared.changed();
    }
    status_of(shared.as_deref(), &app)
}

/// A file from the PC for the phones, picked in the remote's panel and sent
/// by the interface as base64; the host only checks its size, then sends it
/// in parts (`stream.rs`). The file is seen leaving the screen for the phone.
/// Off the main thread, as a large file takes a while to read.
#[tauri::command(async)]
pub fn remote_give(
    app: AppHandle<Wry>,
    state: State<'_, RemoteState>,
    name: String,
    mime: String,
    data: String,
) -> bool {
    use base64::Engine;
    let Some(shared) = running(&state) else {
        return false;
    };
    if data.len() > MAX_GIVE_DATA {
        return false;
    }
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(&data) else {
        return false;
    };
    let name = transfer::safe_name(&name);
    let mime: String = mime.chars().take(100).collect();
    let sent = give_to_all(
        &shared,
        stream::Source::Bytes(Arc::new(bytes)),
        &name,
        &mime,
    );
    if sent {
        crate::arrival::depart(&app, &name, &mime, small_picture(&mime, &data), None);
    }
    sent
}

/// The most one file picked in the panel may be (it is read into memory there).
const MAX_GIVE_BYTES: u64 = 40 * 1024 * 1024;
const MAX_GIVE_DATA: usize = (MAX_GIVE_BYTES as usize).div_ceil(3) * 4;
/// A picture this small (as base64) is also shown flying to the phone.
const MAX_SHOWN_PICTURE: usize = 8 * 1024 * 1024;

fn small_picture<'a>(mime: &str, data: &'a str) -> Option<&'a str> {
    (mime.starts_with("image/") && data.len() <= MAX_SHOWN_PICTURE).then_some(data)
}

/// Sends one file to every connected phone, each on a thread of its own, in
/// parts it answers (`stream.rs`). True when at least one phone is there.
fn give_to_all<H: Host>(
    shared: &Arc<Shared<H>>,
    source: stream::Source,
    name: &str,
    mime: &str,
) -> bool {
    // Phones only: a computer sharing its mouse and keyboard takes no files.
    let peers: Vec<u64> = shared
        .peers
        .lock()
        .map(|p| p.iter().filter(|(_, p)| !p.pc).map(|(id, _)| *id).collect())
        .unwrap_or_default();
    if peers.is_empty() || source.size().is_none_or(|s| s > stream::MAX_STREAM) {
        return false;
    }
    let source = Arc::new(source);
    for peer in peers {
        let id = seal::random_id();
        let answers = match shared.streams.lock() {
            Ok(mut streams) => streams.listen(peer, &id),
            Err(_) => continue,
        };
        let (shared, source, name, mime) = (
            shared.clone(),
            source.clone(),
            name.to_string(),
            mime.to_string(),
        );
        std::thread::spawn(move || {
            let say = |m: Value| shared.to_peer(peer, m);
            let whole = stream::give(&source, &id, &name, &mime, &answers, &say);
            if let Ok(mut streams) = shared.streams.lock() {
                streams.stop_listening(peer, &id);
            }
            if !whole {
                core_bridge_log(format!("remote: {name} did not reach phone {peer}"));
            }
        });
    }
    true
}

/// A file's type, from its name, for the phone to show and save it right.
pub fn mime_of(name: &str) -> &'static str {
    let lower = name.to_ascii_lowercase();
    let ext = lower.rsplit_once('.').map_or("", |(_, ext)| ext);
    match ext {
        "pdf" => "application/pdf",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "heic" => "image/heic",
        "txt" => "text/plain",
        "csv" => "text/csv",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

/// A phone is connected now (the ring then offers "To phone").
pub fn has_phone<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.try_state::<RemoteState>()
        .and_then(|state| state.0.lock().ok()?.as_ref().map(|r| r.shared.clone()))
        .and_then(|shared| {
            shared
                .peers
                .lock()
                .ok()
                .map(|peers| peers.values().any(|p| !p.pc))
        })
        .unwrap_or(false)
}

/// Files on this computer for every connected phone, let go on the ring's
/// "To phone" (or a drop panel tile): each is seen flying off the screen
/// from `from` (the pointer), then goes in parts, however large, up to
/// `stream::MAX_STREAM`. How many went.
pub fn give_paths<R: Runtime>(
    app: &AppHandle<R>,
    files: &[std::path::PathBuf],
    from: Option<(f64, f64)>,
) -> usize {
    let Some(shared) = app
        .try_state::<RemoteState>()
        .and_then(|state| state.0.lock().ok()?.as_ref().map(|r| r.shared.clone()))
    else {
        return 0;
    };
    let mut sent = 0;
    for path in files.iter().take(20) {
        let name = transfer::safe_name(
            &path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
        );
        let mime = mime_of(&name);
        if give_to_all(&shared, stream::Source::Path(path.clone()), &name, mime) {
            if sent == 0 {
                let picture = server::small_picture_of(path, mime);
                crate::arrival::depart(app, &name, mime, picture.as_deref(), from);
            }
            sent += 1;
        }
    }
    sent
}

/// The most files kept waiting for a phone.
const MAX_WAITING: usize = 20;

/// Files let go on "To phone" (the drop panel, the ring): to the connected
/// phones now, or, with none connected, kept until one joins while the
/// remote's panel shows its QR code (the remote comes on for it).
pub fn give_or_wait<R: Runtime>(
    app: &AppHandle<R>,
    files: Vec<std::path::PathBuf>,
    from: Option<(f64, f64)>,
) {
    if files.is_empty() {
        return;
    }
    if has_phone(app) {
        let app = app.clone();
        std::thread::spawn(move || {
            let sent = give_paths(&app, &files, from);
            core_bridge_log(format!(
                "remote: {sent} of {} files to the phone",
                files.len()
            ));
        });
        return;
    }
    // The remote runs on the real app only (its state is kept for `Wry`).
    let Some(app) = (app as &dyn std::any::Any).downcast_ref::<AppHandle<Wry>>() else {
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = start(&app, true).await {
            core_bridge_log(format!("remote: could not start for waiting files: {e}"));
            return;
        }
        let Some(shared) = running(&app.state::<RemoteState>()) else {
            return;
        };
        if let Ok(mut waiting) = shared.waiting.lock() {
            for file in files {
                if waiting.len() < MAX_WAITING && !waiting.contains(&file) {
                    waiting.push(file);
                }
            }
        }
        // A phone may have joined while the remote came on.
        if shared.peers.lock().map(|p| !p.is_empty()).unwrap_or(false) {
            give_waiting(&shared);
        }
        crate::quick::show_editor(&app);
        shared.changed();
    });
}

/// The files waiting for a phone go to the phone that just joined.
fn give_waiting<H: Host>(shared: &Arc<Shared<H>>) {
    let files = shared
        .waiting
        .lock()
        .map(|mut w| std::mem::take(&mut *w))
        .unwrap_or_default();
    if files.is_empty() {
        return;
    }
    let shared = shared.clone();
    std::thread::spawn(move || {
        let sent = files
            .iter()
            .filter(|path| {
                let name = transfer::safe_name(
                    &path
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_default(),
                );
                give_to_all(
                    &shared,
                    stream::Source::Path((*path).clone()),
                    &name,
                    mime_of(&name),
                )
            })
            .count();
        core_bridge_log(format!(
            "remote: {sent} of {} waiting files to the phone",
            files.len()
        ));
        shared.changed();
    });
}

/// Forgets a remembered phone; if it is connected, it is let go.
#[tauri::command]
pub fn remote_forget(app: AppHandle<Wry>, state: State<'_, RemoteState>, device: String) -> Status {
    if let Some(shared) = running(&state) {
        if let Ok(mut phones) = shared.phones.lock() {
            phones.forget(&device);
        }
        if let Ok(mut peers) = shared.peers.lock() {
            // Dropping its sender ends that phone's connection.
            peers.retain(|_, p| p.device != device);
        }
        shared.changed();
        return status_of(Some(&shared), &app);
    }
    if let Some(file) = phones_file(&app) {
        Phones::load(&file).forget(&device);
    }
    status_of::<Wry>(None, &app)
}

/// Sends `message` to one phone, or to every connected phone.
#[tauri::command]
pub fn remote_send(state: State<'_, RemoteState>, message: Value, peer: Option<u64>) -> bool {
    let Some(shared) = running(&state) else {
        return false;
    };
    if !message.is_object() {
        return false;
    }
    let Ok(peers) = shared.peers.lock() else {
        return false;
    };
    let mut sent = false;
    for (id, p) in peers.iter() {
        if peer.is_none_or(|wanted| wanted == *id) {
            sent |= p.tx.send(message.clone()).is_ok();
        }
    }
    sent
}

/// Present mode fills the screen: the window goes full screen and back.
#[tauri::command]
pub fn remote_fullscreen(window: tauri::WebviewWindow<Wry>, on: bool) -> bool {
    window.set_fullscreen(on).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn files_for_the_phone_are_typed_by_their_name() {
        assert_eq!(mime_of("Scan.PDF"), "application/pdf");
        assert_eq!(mime_of("photo.jpeg"), "image/jpeg");
        assert_eq!(mime_of("no-extension"), "application/octet-stream");
        const { assert!(stream::PART * 2 < server::MAX_MESSAGE) };
    }

    #[test]
    fn draws_a_qr_code() {
        let svg = qr_svg("http://192.168.1.4:47800/#k=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
            .unwrap();
        assert!(svg.starts_with("<?xml") || svg.starts_with("<svg"));
        assert!(svg.contains("#041e42"));
    }

    /// The app, as far as the remote can tell: the interface's events go
    /// down a channel, and the web app's files come from its `dist`. No
    /// window is made, so these tests run on any machine (a Tauri app in a
    /// Windows test binary does not even load).
    struct TestHost {
        told: Mutex<std::sync::mpsc::Sender<Value>>,
        landing: std::path::PathBuf,
    }

    impl Host for TestHost {
        fn tell(&self, event: &str, payload: Value) {
            if event == MESSAGE_EVENT {
                let _ = self.told.lock().unwrap().send(payload);
            }
        }

        fn asset(&self, name: &str) -> Option<(Vec<u8>, String)> {
            let dist = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../web/dist");
            let bytes = std::fs::read(dist.join(name)).ok()?;
            let mime = match name.rsplit('.').next()? {
                "html" => "text/html",
                "js" => "text/javascript",
                "css" => "text/css",
                "svg" => "image/svg+xml",
                "png" => "image/png",
                "woff2" => "font/woff2",
                _ => "application/octet-stream",
            };
            Some((bytes, mime.into()))
        }

        fn landing_folder(&self) -> Option<std::path::PathBuf> {
            Some(self.landing.clone())
        }

        fn landed(&self, path: &std::path::Path, mime: &str, _picture: Option<&str>) {
            let _ = self.told.lock().unwrap().send(serde_json::json!({
                "landed": path.file_name().map(|n| n.to_string_lossy().to_string()),
                "mime": mime,
            }));
        }

        /// The person allows every phone but one called "Stranger".
        fn allow_new_phone(&self, name: &str) -> Pin<Box<dyn Future<Output = bool> + Send>> {
            let allowed = name != "Stranger";
            Box::pin(async move { allowed })
        }

        /// The same for computers; the digits are kept for the test to see.
        fn allow_new_pc(
            &self,
            name: &str,
            digits: &str,
        ) -> Pin<Box<dyn Future<Output = bool> + Send>> {
            let _ = self
                .told
                .lock()
                .unwrap()
                .send(serde_json::json!({ "digits": digits }));
            let allowed = name != "Stranger";
            Box::pin(async move { allowed })
        }
    }

    /// The remote on, on this machine only, for a test: what the server
    /// shares, the QR code's address, what the interface is told, and the
    /// switch that stops it.
    fn serve(
        pc_control: bool,
    ) -> (
        Arc<Shared<TestHost>>,
        String,
        std::sync::mpsc::Receiver<Value>,
        watch::Sender<bool>,
    ) {
        let (told, heard) = std::sync::mpsc::channel();
        let listener = tauri::async_runtime::block_on(TcpListener::bind(("127.0.0.1", 0))).unwrap();
        let shared = Arc::new(Shared {
            host: TestHost {
                told: Mutex::new(told),
                landing: std::env::temp_dir().join(format!("zood-landing-{}", seal::random_id())),
            },
            port: listener.local_addr().unwrap().port(),
            addresses: Mutex::new(vec![Ipv4Addr::LOCALHOST]),
            code: Mutex::new(None),
            phones: Mutex::new(Phones::default()),
            peers: Mutex::new(Default::default()),
            next_peer: AtomicU64::new(1),
            pc_control: AtomicBool::new(pc_control),
            clipboard: AtomicBool::new(false),
            last_clip: AtomicU64::new(0),
            keep_ready: AtomicBool::new(false),
            streams: Mutex::new(Default::default()),
            announced: Mutex::new(None),
            waiting: Mutex::new(Vec::new()),
            pc_pairing: Mutex::new(None),
        });
        shared.new_code();
        let url = shared.status().url.unwrap();
        let (stop, stopped) = watch::channel(false);
        tauri::async_runtime::spawn(server::run(shared.clone(), listener, stopped));
        (shared, url, heard, stop)
    }

    type Socket = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;

    /// A phone, in Rust: pairs with the code in `url` as the phone page does
    /// (`packages/ui/src/remote/phone/link.ts`) and hands back the open
    /// connection, its key, and the messages that came first.
    async fn pair(url: &str) -> (Socket, SealKey, Vec<Value>) {
        use futures_util::SinkExt;
        use tokio_tungstenite::tungstenite::Message;

        let (address, code) = url.split_once("/#k=").unwrap();
        let code: SealKey =
            base64::Engine::decode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, code)
                .unwrap()
                .try_into()
                .unwrap();
        let host = address.trim_start_matches("http://");
        let stream = tokio::net::TcpStream::connect(host).await.unwrap();
        let (mut socket, _) = tokio_tungstenite::client_async(format!("ws://{host}/"), stream)
            .await
            .unwrap();
        let Message::Text(challenge) = next(&mut socket).await else {
            panic!("no challenge")
        };
        let challenge: Value = serde_json::from_str(challenge.as_str()).unwrap();
        let challenge = challenge["c"].as_str().unwrap().to_string();
        let inside = serde_json::json!({ "c": challenge, "name": "Test phone" }).to_string();
        let hello = serde_json::json!({ "t": "hello", "device": null, "box": seal::to_base64(&seal::seal(&code, inside.as_bytes())) });
        socket
            .send(Message::Text(hello.to_string().into()))
            .await
            .unwrap();
        // A new phone is told to wait while the person is asked on the PC
        // (the test host allows it at once).
        let Message::Text(waiting) = next(&mut socket).await else {
            panic!("not told to wait")
        };
        assert_eq!(
            serde_json::from_str::<Value>(waiting.as_str()).unwrap()["t"],
            "waiting"
        );
        let session = seal::session_key(&code, &challenge);
        let mut first = Vec::new();
        while first.len() < 2 {
            let Message::Binary(sealed) = next(&mut socket).await else {
                panic!("not sealed")
            };
            let plain = seal::open(&session, &sealed).expect("sealed with the code's key");
            first.push(serde_json::from_slice(&plain).unwrap());
        }
        (socket, session, first)
    }

    async fn next(socket: &mut Socket) -> tokio_tungstenite::tungstenite::Message {
        use futures_util::StreamExt;
        let read = tokio::time::timeout(Duration::from_secs(5), socket.next());
        read.await.unwrap().unwrap().unwrap()
    }

    async fn say(socket: &mut Socket, session: &SealKey, seq: u64, mut message: Value) {
        use futures_util::SinkExt;
        message["s"] = seq.into();
        message["d"] = "p".into();
        let sealed = seal::seal(session, message.to_string().as_bytes());
        socket
            .send(tokio_tungstenite::tungstenite::Message::Binary(
                sealed.into(),
            ))
            .await
            .unwrap();
    }

    #[test]
    fn a_phone_the_person_does_not_allow_is_turned_away() {
        use futures_util::SinkExt;
        use tokio_tungstenite::tungstenite::Message;
        let (shared, url, _told, _stop) = serve(false);

        tauri::async_runtime::block_on(async {
            let (address, code) = url.split_once("/#k=").unwrap();
            let code: SealKey =
                base64::Engine::decode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, code)
                    .unwrap()
                    .try_into()
                    .unwrap();
            let host = address.trim_start_matches("http://");
            let stream = tokio::net::TcpStream::connect(host).await.unwrap();
            let (mut socket, _) = tokio_tungstenite::client_async(format!("ws://{host}/"), stream)
                .await
                .unwrap();
            let Message::Text(challenge) = next(&mut socket).await else {
                panic!("no challenge")
            };
            let challenge: Value = serde_json::from_str(challenge.as_str()).unwrap();
            let inside = serde_json::json!({ "c": challenge["c"], "name": "Stranger" }).to_string();
            let hello = serde_json::json!({ "t": "hello", "device": null, "box": seal::to_base64(&seal::seal(&code, inside.as_bytes())) });
            socket
                .send(Message::Text(hello.to_string().into()))
                .await
                .unwrap();
            for expected in ["waiting", "refused"] {
                let Message::Text(said) = next(&mut socket).await else {
                    panic!("expected {expected}")
                };
                let said: Value = serde_json::from_str(said.as_str()).unwrap();
                assert_eq!(said["t"], expected);
                if expected == "refused" {
                    assert_eq!(said["why"], "denied");
                }
            }
        });
        // Nothing remembered, and the code cannot be tried again.
        assert!(shared.phones.lock().unwrap().list().is_empty());
        assert!(shared.code().is_none());
    }

    #[test]
    fn a_phone_pairs_and_its_messages_reach_the_interface() {
        let (shared, url, told, _stop) = serve(false);

        tauri::async_runtime::block_on(async {
            let (mut socket, session, first) = pair(&url).await;
            assert_eq!(first[0]["t"], "welcome");
            assert_eq!(first[1]["t"], "ready");
            assert_eq!(first[1]["pcControl"], false);
            // The code is spent; the phone is remembered under its own key.
            assert!(shared.code().is_none());
            assert_eq!(shared.phones.lock().unwrap().list().len(), 1);

            say(
                &mut socket,
                &session,
                1,
                serde_json::json!({ "t": "go", "page": 3 }),
            )
            .await;
            // A replay of an old number is not taken, and the connection goes.
            say(&mut socket, &session, 1, serde_json::json!({ "t": "next" })).await;
            tokio::time::sleep(Duration::from_millis(300)).await;
        });

        let heard: Vec<Value> = told.try_iter().collect();
        let kinds: Vec<&str> = heard
            .iter()
            .filter_map(|e| e["message"]["t"].as_str())
            .collect();
        assert_eq!(kinds, ["joined", "go", "left"], "{heard:?}");
        assert_eq!(heard[1]["message"]["page"], 3);
    }

    /// PC control for real: a paired phone's trackpad moves this machine's
    /// pointer. Moves the pointer, so not in the everyday run; the Windows
    /// build runs it (`.github/workflows/desktop-windows.yml`).
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    #[test]
    #[ignore]
    fn a_paired_phone_moves_the_pointer() {
        use enigo::{Coordinate, Enigo, Mouse, Settings};

        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        let (width, height) = enigo.main_display().unwrap();
        enigo
            .move_mouse(width / 2, height / 2, Coordinate::Abs)
            .unwrap();
        let before = enigo.location().unwrap();

        let (_shared, url, _told, _stop) = serve(true);
        tauri::async_runtime::block_on(async {
            let (mut socket, session, first) = pair(&url).await;
            assert_eq!(first[1]["pcControl"], true);
            say(
                &mut socket,
                &session,
                1,
                serde_json::json!({ "t": "pc", "k": "move", "dx": 40, "dy": 30 }),
            )
            .await;
            tokio::time::sleep(Duration::from_millis(800)).await;
        });
        let after = enigo.location().unwrap();
        println!("pointer {before:?} -> {after:?}");
        assert_ne!(before, after, "the pointer did not move");
        assert!(
            after.0 > before.0 && after.1 > before.1,
            "{before:?} -> {after:?}"
        );
    }

    #[test]
    fn a_flicked_file_lands_on_the_desktop_and_the_phone_hears_where() {
        use base64::Engine;
        let (shared, url, told, _stop) = serve(false);
        let landing = shared.host.landing.clone();
        let reply = tauri::async_runtime::block_on(async {
            let (mut socket, session, _first) = pair(&url).await;
            let data = base64::engine::general_purpose::STANDARD.encode(b"%PDF-1.7 from the phone");
            say(
                &mut socket,
                &session,
                1,
                serde_json::json!({ "t": "drop", "id": "a1", "name": "../Invoice.pdf", "mime": "application/pdf", "data": data }),
            )
            .await;
            let tokio_tungstenite::tungstenite::Message::Binary(sealed) = next(&mut socket).await
            else {
                panic!("not sealed")
            };
            let plain = seal::open(&session, &sealed).unwrap();
            serde_json::from_slice::<Value>(&plain).unwrap()
        });
        assert_eq!(reply["t"], "landed");
        assert_eq!(reply["id"], "a1");
        assert_eq!(reply["ok"], true);
        assert_eq!(reply["name"], "Invoice.pdf");
        assert_eq!(
            std::fs::read(landing.join("Invoice.pdf")).unwrap(),
            b"%PDF-1.7 from the phone"
        );
        // The PC showed it arriving; the document side heard only the phone come.
        let heard: Vec<Value> = told.try_iter().collect();
        assert!(
            heard.iter().any(|h| h["landed"] == "Invoice.pdf"),
            "{heard:?}"
        );
        assert!(
            !heard.iter().any(|h| h["message"]["t"] == "drop"),
            "{heard:?}"
        );
        let _ = std::fs::remove_dir_all(&landing);
    }

    #[test]
    fn a_large_file_sent_in_parts_lands_whole_and_beats_are_answered() {
        use base64::Engine;
        let (shared, url, _told, _stop) = serve(false);
        let landing = shared.host.landing.clone();
        let data: Vec<u8> = (0..(stream::PART * 3 + 1234))
            .map(|i| (i * 31 % 256) as u8)
            .collect();
        let replies = tauri::async_runtime::block_on(async {
            let (mut socket, session, _first) = pair(&url).await;
            let mut replies = Vec::new();
            let mut seq = 0;
            let mut out = |m: Value| {
                seq += 1;
                (seq, m)
            };
            let open_next = |sealed: &[u8]| {
                serde_json::from_slice::<Value>(&seal::open(&session, sealed).unwrap()).unwrap()
            };
            let (n, m) = out(serde_json::json!({ "t": "beat" }));
            say(&mut socket, &session, n, m).await;
            let size = data.len();
            let (n, m) = out(
                serde_json::json!({ "t": "putStart", "id": "big1", "name": "Site photos.zip", "mime": "application/zip", "size": size }),
            );
            say(&mut socket, &session, n, m).await;
            for (i, chunk) in data.chunks(stream::PART).enumerate() {
                let part = base64::engine::general_purpose::STANDARD.encode(chunk);
                let (n, m) =
                    out(serde_json::json!({ "t": "putPart", "id": "big1", "n": i, "data": part }));
                say(&mut socket, &session, n, m).await;
            }
            let (n, m) = out(serde_json::json!({ "t": "putEnd", "id": "big1" }));
            say(&mut socket, &session, n, m).await;
            while replies.len() < 7 {
                if let tokio_tungstenite::tungstenite::Message::Binary(sealed) =
                    next(&mut socket).await
                {
                    replies.push(open_next(&sealed));
                }
            }
            replies
        });
        let kinds: Vec<&str> = replies.iter().map(|r| r["t"].as_str().unwrap()).collect();
        assert_eq!(
            kinds,
            ["beat", "putOk", "putGot", "putGot", "putGot", "putGot", "landed"]
        );
        assert_eq!(replies[6]["ok"], true);
        assert_eq!(
            std::fs::read(landing.join("Site photos.zip")).unwrap(),
            data
        );
        assert!(!landing.join(".zood-big1.part").exists());
        let _ = std::fs::remove_dir_all(&landing);
    }

    /// A file let go on "To phone" before any phone was there goes to the
    /// first phone that joins, and the panel stops saying it waits.
    /// Two computers (`twin.rs`): paired with the digits both screens show,
    /// remembered as a computer, and let in again by the key it was given.
    #[test]
    fn another_computer_pairs_with_digits_and_comes_back_by_its_key() {
        let (shared, url, told, _stop) = serve(false);
        let addr = url
            .trim_start_matches("http://")
            .split('/')
            .next()
            .unwrap()
            .to_string();
        let file = std::env::temp_dir().join(format!("zood-twin-{}.txt", std::process::id()));
        std::fs::write(&file, b"for a phone").unwrap();
        shared.waiting.lock().unwrap().push(file.clone());

        // Not until the person here opens pairing for a few minutes.
        let closed = tauri::async_runtime::block_on(twin::join(&addr, "Office PC", None, |_| {}));
        assert_eq!(closed.err().as_deref(), Some("E_TWIN_NOT_OPEN"));
        *shared.pc_pairing.lock().unwrap() = Some(Instant::now() + Duration::from_secs(60));

        let (device, key, shown) = tauri::async_runtime::block_on(async {
            let mut shown = None;
            let linked = twin::join(&addr, "Office PC", None, |d| shown = Some(d))
                .await
                .unwrap();
            assert_eq!(linked.ready["t"], "ready");
            let (device, key) = linked.welcome.clone().expect("welcomed");
            (device, key, shown.expect("digits shown"))
        });
        assert_eq!(shown.len(), 6);
        let asked: Vec<Value> = told
            .try_iter()
            .filter(|m| m.get("digits").is_some())
            .collect();
        assert_eq!(asked, [serde_json::json!({ "digits": shown })]);
        // Remembered as a computer; the phone's QR code is still unused, and
        // a file waiting for a phone keeps waiting.
        let status = shared.status();
        assert_eq!(status.remembered.len(), 1);
        assert!(status.remembered[0].pc);
        assert!(shared.code().is_some());
        assert_eq!(shared.status().waiting, 1);

        tauri::async_runtime::block_on(async {
            let again = twin::join(&addr, "Office PC", Some((device.clone(), key)), |_| {
                panic!("no digits for a computer paired before")
            })
            .await
            .unwrap();
            assert_eq!(again.ready["t"], "ready");
            assert!(again.welcome.is_none());
            let wrong = twin::join(&addr, "Office PC", Some((device, [7u8; 32])), |_| {}).await;
            assert_eq!(wrong.err().as_deref(), Some("E_TWIN_REFUSED"));
            // One computer per opening: a second must wait for the next.
            let shut = twin::join(&addr, "Stranger", None, |_| {}).await;
            assert_eq!(shut.err().as_deref(), Some("E_TWIN_NOT_OPEN"));
            *shared.pc_pairing.lock().unwrap() = Some(Instant::now() + Duration::from_secs(60));
            let denied = twin::join(&addr, "Stranger", None, |_| {}).await;
            assert_eq!(denied.err().as_deref(), Some("E_TWIN_DENIED"));
        });
        assert_eq!(shared.phones.lock().unwrap().list().len(), 1);
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn a_file_waiting_for_a_phone_goes_to_the_first_that_joins() {
        let (shared, url, _told, _stop) = serve(false);
        let file = std::env::temp_dir().join(format!("zood-waiting-{}.txt", std::process::id()));
        std::fs::write(&file, b"for the phone").unwrap();
        shared.waiting.lock().unwrap().push(file.clone());
        assert_eq!(shared.status().waiting, 1);
        let start = tauri::async_runtime::block_on(async {
            let (mut socket, session, _first) = pair(&url).await;
            loop {
                if let tokio_tungstenite::tungstenite::Message::Binary(sealed) =
                    next(&mut socket).await
                {
                    let m: Value =
                        serde_json::from_slice(&seal::open(&session, &sealed).unwrap()).unwrap();
                    if m["t"] == "giveStart" {
                        return m;
                    }
                }
            }
        });
        let name = file.file_name().unwrap().to_string_lossy().into_owned();
        assert_eq!(start["name"], name.as_str());
        assert_eq!(start["size"], 13);
        assert_eq!(shared.status().waiting, 0);
        let _ = std::fs::remove_file(&file);
    }

    /// The phone page end to end: the page this build serves (the web app's
    /// `dist`, built with `vite build --mode tauri`), in a phone-sized
    /// Chromium (`apps/web/e2e/remote-phone.mjs`), against this server, with
    /// this test playing the PC's interface. Needs that build and Playwright,
    /// so it is not in the everyday run: `cargo test remote -- --ignored`.
    #[test]
    #[ignore]
    fn the_phone_page_pairs_and_presents() {
        let (shared, url, told, _stop) = serve(false);

        // The PC's interface, as far as a phone can tell: a three-page document.
        let heard = Arc::new(Mutex::new(Vec::<String>::new()));
        let pc = shared.clone();
        let log = heard.clone();
        let mut view = (1u64, false);
        std::thread::spawn(move || {
            for event in told {
                // A file shown arriving is not a phone's message.
                let Some(peer) = event["peer"].as_u64() else {
                    continue;
                };
                let message = &event["message"];
                let t = message["t"].as_str().unwrap_or("").to_string();
                log.lock().unwrap().push(t.clone());
                if t == "joined" {
                    // What the host sends on its own: the PC's clipboard, and files the person gave.
                    let peer_id = peer;
                    let peer = pc.peers.lock().unwrap().get(&peer_id).map(|p| Peer {
                        device: p.device.clone(),
                        name: p.name.clone(),
                        tx: p.tx.clone(),
                        pc: p.pc,
                    });
                    if let Some(peer) = peer {
                        let _ = peer
                            .tx
                            .send(serde_json::json!({ "t": "clip", "text": "Hello from the PC" }));
                        // A larger one in parts first (the phone answers each part
                        // as it comes), then a small one the old way, so the
                        // small one is the newest caught.
                        let answers = pc.streams.lock().unwrap().listen(peer_id, "test-give");
                        let say = |m: Value| peer.tx.send(m).is_ok();
                        let source = stream::Source::Bytes(Arc::new(vec![5u8; 1_200_000]));
                        assert!(stream::give(
                            &source,
                            "test-give",
                            "Site plan from the PC.bin",
                            "application/octet-stream",
                            &answers,
                            &say
                        ));
                        let _ = peer.tx.send(serde_json::json!({ "t": "give", "name": "Notes from the PC.txt", "mime": "text/plain", "data": "aGVsbG8=" }));
                    }
                }
                let reply = match t.as_str() {
                    "next" => {
                        view.0 = (view.0 + 1).min(3);
                        None
                    }
                    "present" => {
                        view.1 = message["on"].as_bool().unwrap_or(false);
                        None
                    }
                    "picture" => {
                        let page = message["page"].as_u64().unwrap();
                        let svg = format!(
                        "<svg xmlns='http://www.w3.org/2000/svg' width='90' height='120'><rect width='90' height='120' fill='white'/><text x='10' y='60'>{page}</text></svg>"
                    );
                        Some(serde_json::json!({
                            "t": "picture", "page": page, "width": message["width"],
                            "url": format!("data:image/svg+xml,{}", svg.replace('<', "%3C").replace('>', "%3E").replace('#', "%23")),
                        }))
                    }
                    _ => None,
                };
                let state = serde_json::json!({
                    "t": "state",
                    "doc": { "name": "Talk.pdf", "pages": 3, "shapes": [0.75, 0.75, 0.75] },
                    "page": view.0, "presenting": view.1, "black": false, "rtl": false,
                    "notes": [{ "text": format!("Speaker note for page {}", view.0), "author": null }],
                });
                if let Some(peer) = pc.peers.lock().unwrap().get(&peer) {
                    let _ = peer.tx.send(reply.unwrap_or(state));
                }
            }
        });

        let script = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../web/e2e/remote-phone.mjs"
        );
        let status = std::process::Command::new("node")
            .arg(script)
            .arg(&url)
            .status()
            .expect("node");
        assert!(status.success(), "the phone page's steps failed");

        let heard = heard.lock().unwrap();
        for t in ["joined", "picture", "next", "present", "laser", "left"] {
            assert!(heard.iter().any(|h| h == t), "never heard {t}: {heard:?}");
        }
        // The phone that paired is remembered, and only it.
        assert_eq!(shared.phones.lock().unwrap().list().len(), 1);
        // The flicked file is on the "desktop", as sent.
        let landed = shared.host.landing.join("Receipt.pdf");
        assert_eq!(std::fs::read(&landed).unwrap(), b"%PDF-1.7 flicked");
        let _ = std::fs::remove_dir_all(&shared.host.landing);
    }

    #[test]
    fn local_addresses_are_private_and_ipv4() {
        for ip in local_addresses() {
            assert!(ip.is_private() || ip.is_link_local(), "{ip}");
        }
    }
}
