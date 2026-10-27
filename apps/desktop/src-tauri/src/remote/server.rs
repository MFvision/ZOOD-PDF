//! The remote's server: one port on the local network, while the remote is on.
//!
//! The same port answers a phone's browser — the remote page, the web app's
//! own `remote.html` and its scripts, served from the app itself — and the
//! WebSocket each phone then keeps open. A connection is read just far
//! enough to tell which it is (`peek`), then handed to one or the other.
//!
//! Only a request addressed to an IP address is answered: a page elsewhere
//! that points its own name at this PC (DNS rebinding) gets nothing.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;

use super::seal::{self, SealKey};
use super::{input, pairpc, Host, Peer, Shared, MESSAGE_EVENT};

/// The largest message a phone may send: a photographed page or a PDF.
pub const MAX_MESSAGE: usize = 64 * 1024 * 1024;
/// The largest file a phone flicks across, before base64 (as the phone's `MAX_FILE_BYTES`).
pub const MAX_FILE: usize = 40 * 1024 * 1024;
/// The most a request's head may take before it is turned away.
const MAX_HEAD: usize = 8 * 1024;
/// How long a phone has to say hello.
const HELLO_WAIT: Duration = Duration::from_secs(15);
/// The most messages a phone may send in a second; more are dropped.
const MAX_PER_SECOND: u32 = 240;
/// The most a connection may send before its hello is admitted: the upgrade
/// request and a hello, nowhere near a full message.
const HELLO_BUDGET: usize = MAX_HEAD + 64 * 1024;
/// The most connections that may be waiting to say hello at once.
const MAX_UNPAIRED: usize = 8;
/// How often a phone is pinged, and how many pings it may leave unanswered
/// before it is taken for gone.
const PING_EVERY: Duration = Duration::from_secs(20);
const MAX_MISSED_PINGS: u32 = 2;

/// Connections still waiting to be admitted.
static UNPAIRED: AtomicUsize = AtomicUsize::new(0);

/// One place among the `MAX_UNPAIRED`, given back when dropped.
struct Unpaired;

impl Unpaired {
    fn take() -> Option<Self> {
        if UNPAIRED.fetch_add(1, Ordering::Relaxed) >= MAX_UNPAIRED {
            UNPAIRED.fetch_sub(1, Ordering::Relaxed);
            return None;
        }
        Some(Unpaired)
    }
}

impl Drop for Unpaired {
    fn drop(&mut self) {
        UNPAIRED.fetch_sub(1, Ordering::Relaxed);
    }
}

/// The connection under a phone's WebSocket, which reads at most `budget`
/// bytes until the hello is admitted (`usize::MAX` after), so a peer that
/// has not paired cannot make the host hold a message of many megabytes.
struct Limited {
    inner: TcpStream,
    budget: Arc<AtomicUsize>,
}

impl AsyncRead for Limited {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let before = buf.filled().len();
        let ready = Pin::new(&mut self.inner).poll_read(cx, buf);
        if let Poll::Ready(Ok(())) = ready {
            let read = buf.filled().len() - before;
            let left = self.budget.load(Ordering::Relaxed);
            if left != usize::MAX {
                if read > left {
                    return Poll::Ready(Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "too much before the hello",
                    )));
                }
                self.budget.store(left - read, Ordering::Relaxed);
            }
        }
        ready
    }
}

impl AsyncWrite for Limited {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

/// What a request asked for, read from its head.
#[derive(Debug, PartialEq)]
pub struct Head {
    pub method: String,
    pub path: String,
    pub host: Option<String>,
    pub upgrade: bool,
    pub length: usize,
}

/// The request's head, if `bytes` holds all of it.
pub fn parse_head(bytes: &[u8]) -> Option<Head> {
    let end = bytes.windows(4).position(|w| w == b"\r\n\r\n")?;
    let text = std::str::from_utf8(&bytes[..end]).ok()?;
    let mut lines = text.split("\r\n");
    let mut first = lines.next()?.split(' ');
    let method = first.next()?.to_string();
    let path = first.next()?.to_string();
    let mut host = None;
    let mut upgrade = false;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        match name.trim().to_ascii_lowercase().as_str() {
            "host" => host = Some(value.to_string()),
            "upgrade" => upgrade = value.eq_ignore_ascii_case("websocket"),
            _ => {}
        }
    }
    Some(Head {
        method,
        path,
        host,
        upgrade,
        length: end + 4,
    })
}

/// Whether `host` is an IP address (with or without a port), not a name.
pub fn host_is_address(host: Option<&str>) -> bool {
    let Some(host) = host else { return false };
    if host.parse::<SocketAddr>().is_ok() || host.parse::<std::net::IpAddr>().is_ok() {
        return true;
    }
    // `[::1]` without a port.
    host.strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .is_some_and(|h| h.parse::<std::net::Ipv6Addr>().is_ok())
}

/// The file of the web app a path names, if the remote page may be given it:
/// the page itself, its icons, and the scripts, styles and fonts under `assets/`.
pub fn asset_for(path: &str) -> Option<String> {
    let path = path.split(['?', '#']).next().unwrap_or("");
    match path {
        "/" | "/remote" | "/remote.html" => Some("remote.html".into()),
        "/favicon.svg" => Some("favicon.svg".into()),
        "/icons/apple-touch-icon.png" => Some("icons/apple-touch-icon.png".into()),
        _ => {
            let rest = path.strip_prefix("/assets/")?;
            let safe = !rest.is_empty()
                && rest.len() < 200
                && rest
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
                && !rest.contains("..");
            safe.then(|| format!("assets/{rest}"))
        }
    }
}

/// The policy the remote page is served under: its own scripts only, and
/// connections back to this port only.
fn csp(host: &str) -> String {
    format!(
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; \
         font-src 'self'; connect-src 'self' ws://{host}; object-src 'none'; base-uri 'none'; \
         form-action 'none'; frame-ancestors 'none'"
    )
}

async fn respond(stream: &mut TcpStream, status: &str, kind: &str, extra: &str, body: &[u8]) {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nCache-Control: no-store\r\n\
         X-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\n{extra}Connection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes()).await;
    let _ = stream.write_all(body).await;
    let _ = stream.shutdown().await;
}

/// Answers one request for the remote page or one of its files.
async fn serve_page<H: Host>(shared: &Shared<H>, mut stream: TcpStream, head: Head) {
    let mut skip = vec![0u8; head.length];
    if stream.read_exact(&mut skip).await.is_err() {
        return;
    }
    if head.method != "GET" {
        respond(&mut stream, "405 Method Not Allowed", "text/plain", "", b"").await;
        return;
    }
    let Some(name) = asset_for(&head.path) else {
        respond(&mut stream, "404 Not Found", "text/plain", "", b"").await;
        return;
    };
    match shared.host.asset(&name) {
        Some((bytes, mime)) if asset_name_matches(&name, &mime) => {
            let host = head.host.as_deref().unwrap_or("");
            let extra = if name.ends_with(".html") {
                format!("Content-Security-Policy: {}\r\n", csp(host))
            } else {
                String::new()
            };
            respond(&mut stream, "200 OK", &mime, &extra, &bytes).await;
        }
        _ => respond(&mut stream, "404 Not Found", "text/plain", "", b"").await,
    }
}

/// The resolver falls back to `index.html` for a name it does not know: an
/// asset that is not a page must not come back as one.
fn asset_name_matches(name: &str, mime: &str) -> bool {
    name.ends_with(".html") || !mime.starts_with("text/html")
}

/// Reads until the request's head is in, without taking it off the stream.
async fn peek_head(stream: &TcpStream) -> Option<Head> {
    let mut buffer = vec![0u8; MAX_HEAD];
    let start = Instant::now();
    loop {
        let n = stream.peek(&mut buffer).await.ok()?;
        if n == 0 {
            return None;
        }
        if let Some(head) = parse_head(&buffer[..n]) {
            return Some(head);
        }
        if n >= MAX_HEAD || start.elapsed() > Duration::from_secs(5) {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(15)).await;
    }
}

/// Accepts connections until `stop` says otherwise.
pub async fn run<H: Host>(
    shared: Arc<Shared<H>>,
    listener: TcpListener,
    mut stop: watch::Receiver<bool>,
) {
    loop {
        tokio::select! {
            _ = stop.changed() => break,
            accepted = listener.accept() => {
                let Ok((stream, _)) = accepted else { continue };
                let shared = shared.clone();
                let stop = stop.clone();
                tauri::async_runtime::spawn(async move {
                    let Some(head) = peek_head(&stream).await else { return };
                    if !host_is_address(head.host.as_deref()) {
                        return;
                    }
                    if head.upgrade {
                        connect(shared, stream, stop).await;
                    } else {
                        serve_page(&shared, stream, head).await;
                    }
                });
            }
        }
    }
}

#[derive(Deserialize)]
struct Hello {
    #[serde(default)]
    device: Option<String>,
    #[serde(rename = "box")]
    sealed: String,
}

#[derive(Deserialize)]
struct HelloInside {
    c: String,
    #[serde(default)]
    name: String,
}

/// Who a hello came from, once it has been opened.
#[derive(Debug, PartialEq)]
pub enum Admitted {
    /// A phone remembered from before.
    Known {
        device: String,
        key: SealKey,
        name: String,
    },
    /// A phone that scanned the code now on screen; `key` is that code's.
    New { key: SealKey, name: String },
}

/// Opens a phone's hello against this connection's `challenge`: with the
/// key of the phone it says it is, or with the code on screen.
pub fn admit(
    hello: &str,
    challenge: &str,
    remembered: impl Fn(&str) -> Option<SealKey>,
    code: Option<SealKey>,
) -> Option<Admitted> {
    let hello: Hello = serde_json::from_str(hello).ok()?;
    let sealed = seal::from_base64(&hello.sealed)?;
    let (key, device) = match hello.device {
        Some(device) => (remembered(&device)?, Some(device)),
        None => (code?, None),
    };
    let inside: HelloInside = serde_json::from_slice(&seal::open(&key, &sealed)?).ok()?;
    if inside.c != challenge {
        return None;
    }
    Some(match device {
        Some(device) => Admitted::Known {
            device,
            key,
            name: inside.name,
        },
        None => Admitted::New {
            key,
            name: inside.name,
        },
    })
}

/// A message to the phone, sealed and numbered.
fn sealed_out(key: &SealKey, seq: &mut u64, mut message: Value) -> Option<Message> {
    *seq += 1;
    let object = message.as_object_mut()?;
    object.insert("s".into(), json!(*seq));
    object.insert("d".into(), json!("c"));
    Some(Message::Binary(
        seal::seal(key, &serde_json::to_vec(&message).ok()?).into(),
    ))
}

/// A message from the phone, if it is sealed with `key`, from the phone's
/// side, and numbered after the last one.
pub fn opened_in(key: &SealKey, last: &mut u64, sealed: &[u8]) -> Option<Value> {
    let mut message: Value = serde_json::from_slice(&seal::open(key, sealed)?).ok()?;
    let object = message.as_object_mut()?;
    let seq = object.remove("s")?.as_u64()?;
    if object.remove("d")?.as_str()? != "p" || seq <= *last {
        return None;
    }
    *last = seq;
    Some(message)
}

/// One phone's WebSocket, from its hello to its last message.
async fn connect<H: Host>(
    shared: Arc<Shared<H>>,
    stream: TcpStream,
    mut stop: watch::Receiver<bool>,
) {
    // Only a few connections at a time may be waiting to pair.
    let Some(unpaired) = Unpaired::take() else {
        return;
    };
    // The socket's own limits are for an admitted phone and cannot change
    // after it opens, so until the hello is admitted the stream under it
    // gives out only `HELLO_BUDGET` bytes.
    let budget = Arc::new(AtomicUsize::new(HELLO_BUDGET));
    let stream = Limited {
        inner: stream,
        budget: budget.clone(),
    };
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_MESSAGE * 2))
        .max_frame_size(Some(MAX_MESSAGE * 2));
    let Ok(socket) = tokio_tungstenite::accept_async_with_config(stream, Some(config)).await else {
        return;
    };
    let (mut sink, mut source) = socket.split();
    let challenge = seal::random_id();
    let hello = json!({ "t": "challenge", "c": challenge, "v": 1 }).to_string();
    if sink.send(Message::Text(hello.into())).await.is_err() {
        return;
    }

    let first = tokio::time::timeout(HELLO_WAIT, source.next()).await;
    let Ok(Some(Ok(Message::Text(mut text)))) = first else {
        return;
    };
    // Another computer pairing (`pairpc.rs`) has no code to scan: the two
    // agree on a key first, and its hello comes sealed with that key.
    let mut pairing: Option<pairpc::Agreed> = None;
    if let Some(theirs) = pairpc::asked(text.as_str()) {
        if !shared.pc_pairing_open() {
            let closed = json!({ "t": "refused", "why": "closed" }).to_string();
            let _ = sink.send(Message::Text(closed.into())).await;
            return;
        }
        let Some(ours) = pairpc::half() else {
            return;
        };
        let our_public = ours.public;
        let Some(agreed) = pairpc::agree(ours, &theirs, &theirs, &our_public) else {
            return;
        };
        let answer = json!({ "t": "pcPairPub", "pub": pairpc::to_text(&our_public) });
        if sink
            .send(Message::Text(answer.to_string().into()))
            .await
            .is_err()
        {
            return;
        }
        let next = tokio::time::timeout(HELLO_WAIT, source.next()).await;
        let Ok(Some(Ok(Message::Text(next)))) = next else {
            return;
        };
        text = next;
        pairing = Some(agreed);
    }
    let admitted = match &pairing {
        Some(agreed) => admit(text.as_str(), &challenge, |_| None, Some(agreed.key)),
        None => admit(
            text.as_str(),
            &challenge,
            |device| shared.phones.lock().ok()?.find(device)?.key(),
            shared.code(),
        ),
    };
    let Some(admitted) = admitted else {
        let _ = sink
            .send(Message::Text(json!({ "t": "refused" }).to_string().into()))
            .await;
        return;
    };
    // A new phone waits until the person allows it on the PC: whoever
    // photographs the code still cannot pair without them.
    if let Admitted::New { name, .. } = &admitted {
        // One phone per code: the next one needs a new code.
        if pairing.is_none() {
            shared.used_code();
        }
        let waiting = json!({ "t": "waiting" }).to_string();
        if sink.send(Message::Text(waiting.into())).await.is_err() {
            return;
        }
        let asked = match &pairing {
            Some(agreed) => shared.host.allow_new_pc(name, &agreed.digits),
            None => shared.host.allow_new_phone(name),
        };
        let allowed = tokio::select! {
            allowed = asked => allowed,
            _ = stop.changed() => false,
        };
        if !allowed {
            let denied = json!({ "t": "refused", "why": "denied" }).to_string();
            let _ = sink.send(Message::Text(denied.into())).await;
            return;
        }
    }
    budget.store(usize::MAX, Ordering::Relaxed);
    drop(unpaired);

    // This connection is locked with the key its hello came in. A new
    // phone's own key only reaches it inside the welcome, for next time.
    let is_pc = pairing.is_some();
    let (device, key, name, welcome, is_pc) = match admitted {
        Admitted::Known { device, key, name } => {
            let mut is_pc = false;
            if let Ok(mut phones) = shared.phones.lock() {
                phones.touch(&device, &name);
                is_pc = phones.find(&device).is_some_and(|phone| phone.pc);
            }
            (device, key, name, None, is_pc)
        }
        Admitted::New { key: code, name } => {
            let device = seal::random_id();
            let key = seal::random_key();
            if let Ok(mut phones) = shared.phones.lock() {
                if is_pc {
                    phones.add_pc(device.clone(), &name, &key);
                    // One computer per "Let a computer pair".
                    if let Ok(mut until) = shared.pc_pairing.lock() {
                        *until = None;
                    }
                } else {
                    phones.add(device.clone(), &name, &key);
                }
            }
            // Its tag joins the announcement, so the iPhone app trusts it
            // (off this task: the network may take a moment).
            let again = shared.clone();
            std::thread::spawn(move || again.announce());
            let welcome =
                json!({ "t": "welcome", "device": device, "key": seal::key_to_text(&key) });
            (device, code, name, Some(welcome), is_pc)
        }
    };
    let session = seal::session_key(&key, &challenge);
    let mut out_seq = 0u64;
    let mut in_seq = 0u64;

    let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
    let peer = shared.next_peer.fetch_add(1, Ordering::Relaxed);
    if let Ok(mut peers) = shared.peers.lock() {
        peers.insert(
            peer,
            Peer {
                device: device.clone(),
                name: super::devices::tidy_name(&name),
                tx,
                pc: is_pc,
            },
        );
    }
    if let Some(welcome) = welcome {
        if let Some(m) = sealed_out(&session, &mut out_seq, welcome) {
            let _ = sink.send(m).await;
        }
    }
    let mut ready = json!({ "t": "ready", "pc": super::pc_name(), "pcControl": shared.pc_control_on(), "os": std::env::consts::OS });
    // Another computer moves this one's pointer by place: it needs the size.
    if is_pc {
        if let Some((width, height)) = input::screen_size() {
            ready["screen"] = json!([width, height]);
        }
    }
    if let Some(m) = sealed_out(&session, &mut out_seq, ready) {
        let _ = sink.send(m).await;
    }
    shared.changed();
    shared.host.tell(
        MESSAGE_EVENT,
        json!({ "peer": peer, "message": { "t": "joined" } }),
    );
    // Files let go on "To phone" wait for a phone, not another computer.
    if !is_pc {
        super::give_waiting(&shared);
    }

    let mut window = Instant::now();
    let mut count = 0u32;
    // Pinged now and then: a phone that stops answering (its Wi-Fi gone, the
    // page asleep) is let go instead of staying in the list.
    let mut ping = tokio::time::interval_at(tokio::time::Instant::now() + PING_EVERY, PING_EVERY);
    let mut missed = 0u32;
    loop {
        tokio::select! {
            _ = stop.changed() => break,
            _ = ping.tick() => {
                if missed >= MAX_MISSED_PINGS {
                    break;
                }
                missed += 1;
                if sink.send(Message::Ping(Vec::new().into())).await.is_err() {
                    break;
                }
            }
            outgoing = rx.recv() => {
                let Some(message) = outgoing else { break };
                let Some(m) = sealed_out(&session, &mut out_seq, message) else { continue };
                if sink.send(m).await.is_err() {
                    break;
                }
            }
            incoming = source.next() => {
                let Some(Ok(frame)) = incoming else { break };
                missed = 0;
                let bytes = match frame {
                    Message::Binary(bytes) => bytes,
                    Message::Close(_) => break,
                    _ => continue,
                };
                if window.elapsed() >= Duration::from_secs(1) {
                    window = Instant::now();
                    count = 0;
                }
                count += 1;
                if count > MAX_PER_SECOND {
                    continue;
                }
                let Some(message) = opened_in(&session, &mut in_seq, &bytes) else {
                    // Not from this phone: a connection that sends one is dropped.
                    break;
                };
                handle(&shared, peer, message);
            }
        }
    }
    if let Ok(mut peers) = shared.peers.lock() {
        peers.remove(&peer);
    }
    // Half-sent files are thrown away; files going to it stop.
    if let Ok(mut streams) = shared.streams.lock() {
        streams.forget_peer(peer);
    }
    // A drag the phone was holding when it left is let go; keys and buttons
    // another computer was holding down come up.
    if is_pc {
        input::perform(input::Act::ReleaseAll);
    } else if shared.pc_control_on() {
        input::perform(input::Act::Release);
    }
    let _ = sink.close().await;
    shared.changed();
    shared.host.tell(
        MESSAGE_EVENT,
        json!({ "peer": peer, "message": { "t": "left" } }),
    );
}

/// What a phone's message does: PC control here, everything about the
/// document in the interface.
fn handle<H: Host>(shared: &Arc<Shared<H>>, peer: u64, message: Value) {
    match message.get("t").and_then(Value::as_str) {
        Some("pc") => {
            // A paired computer was allowed to control this one when it
            // paired; a phone only while the switch is on.
            let from_pc = shared
                .peers
                .lock()
                .is_ok_and(|peers| peers.get(&peer).is_some_and(|p| p.pc));
            if !from_pc && !shared.pc_control_on() {
                return;
            }
            if let Some(act) = input::parse(&message) {
                input::perform(act);
            }
        }
        Some("drop") => land(shared, peer, message),
        // The phone checks the link is alive (after waking, and every few
        // seconds while in view): answered at once, nothing else.
        Some("beat") => {
            shared.to_peer(peer, json!({ "t": "beat" }));
        }
        Some("putStart") | Some("putPart") | Some("putEnd") | Some("putStop") => {
            put(shared, peer, &message)
        }
        Some("giveGot") => {
            let id = message.get("id").and_then(Value::as_str).unwrap_or("");
            if let (Some(n), Ok(mut streams)) = (
                message.get("n").and_then(Value::as_u64),
                shared.streams.lock(),
            ) {
                streams.answered(peer, id, n);
            }
        }
        Some("clip") => {
            if !shared.clipboard_on() {
                return;
            }
            if let Some(clip) = super::clip::from_phone(&message) {
                shared
                    .last_clip
                    .store(clip.fingerprint(), Ordering::Relaxed);
                super::clip::write(&clip);
            }
        }
        Some(_) => {
            shared
                .host
                .tell(MESSAGE_EVENT, json!({ "peer": peer, "message": message }));
        }
        None => {}
    }
}

/// A file flicked from the phone: written to the Desktop on a thread of its
/// own (a large one must not hold up the phone's other messages), shown
/// arriving, and the phone told where it went.
fn land<H: Host>(shared: &Arc<Shared<H>>, peer: u64, message: Value) {
    let (Some(name), Some(data)) = (
        message
            .get("name")
            .and_then(Value::as_str)
            .map(str::to_owned),
        message
            .get("data")
            .and_then(Value::as_str)
            .map(str::to_owned),
    ) else {
        return;
    };
    let mime: String = message
        .get("mime")
        .and_then(Value::as_str)
        .unwrap_or("")
        .chars()
        .take(100)
        .collect();
    let id = message
        .get("id")
        .and_then(Value::as_str)
        .map(|s| s.chars().take(40).collect::<String>());
    let shared = shared.clone();
    std::thread::spawn(move || {
        let saved = shared
            .host
            .landing_folder()
            .ok_or_else(|| "E_IO: no Desktop".to_string())
            .and_then(|folder| super::transfer::save(&folder, &name, &data, MAX_FILE));
        let reply = match &saved {
            Ok(path) => {
                let picture = mime.starts_with("image/") && data.len() < 6_000_000;
                shared
                    .host
                    .landed(path, &mime, picture.then_some(data.as_str()));
                let shown = path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();
                json!({ "t": "landed", "id": id, "name": shown, "ok": true })
            }
            Err(e) => {
                crate::core_bridge::debug_log(format!("remote: a flicked file was not saved: {e}"));
                json!({ "t": "landed", "id": id, "name": name, "ok": false })
            }
        };
        if let Ok(peers) = shared.peers.lock() {
            if let Some(p) = peers.get(&peer) {
                let _ = p.tx.send(reply);
            }
        }
    });
}

/// A file the phone sends in parts (`stream.rs`): each part written as it
/// comes and answered, and the whole shown landing on the Desktop at the end.
fn put<H: Host>(shared: &Arc<Shared<H>>, peer: u64, message: &Value) {
    use super::stream::{good_id, Incoming};
    let Some(id) = message
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| good_id(id))
    else {
        return;
    };
    let say = |reply: Value| {
        shared.to_peer(peer, reply);
    };
    let Ok(mut streams) = shared.streams.lock() else {
        return;
    };
    match message.get("t").and_then(Value::as_str) {
        Some("putStart") => {
            let name = message.get("name").and_then(Value::as_str).unwrap_or("");
            let mime = message.get("mime").and_then(Value::as_str).unwrap_or("");
            let size = message.get("size").and_then(Value::as_u64);
            let begun = match (size, shared.host.landing_folder()) {
                _ if !streams.can_open(peer) => Err("E_BUSY".to_string()),
                (Some(size), Some(folder)) => Incoming::begin(&folder, id, name, mime, size),
                (None, _) => Err("E_ARGS".to_string()),
                (_, None) => Err("E_IO: no Desktop".to_string()),
            };
            match begun {
                Ok(incoming) => {
                    streams.add(peer, id, incoming);
                    say(json!({ "t": "putOk", "id": id }));
                }
                Err(why) => say(json!({ "t": "putNo", "id": id, "why": why })),
            }
        }
        Some("putPart") => {
            let n = message.get("n").and_then(Value::as_u64).unwrap_or(u64::MAX);
            let data = message.get("data").and_then(Value::as_str).unwrap_or("");
            let Some(incoming) = streams.get(peer, id) else {
                return say(json!({ "t": "putNo", "id": id, "why": "E_GONE" }));
            };
            match incoming.part(n, data) {
                Ok(()) => say(json!({ "t": "putGot", "id": id, "n": n })),
                Err(why) => {
                    streams.take(peer, id);
                    say(json!({ "t": "putNo", "id": id, "why": why }));
                }
            }
        }
        Some("putEnd") => {
            let Some(incoming) = streams.take(peer, id) else {
                return;
            };
            drop(streams);
            let (name, mime) = (incoming.name.clone(), incoming.mime.clone());
            let reply = match incoming.finish() {
                Ok(path) => {
                    let picture = small_picture_of(&path, &mime);
                    shared.host.landed(&path, &mime, picture.as_deref());
                    let shown = path
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();
                    json!({ "t": "landed", "id": id, "name": shown, "ok": true })
                }
                Err(e) => {
                    crate::core_bridge::debug_log(format!(
                        "remote: a sent file was not saved: {e}"
                    ));
                    json!({ "t": "landed", "id": id, "name": name, "ok": false })
                }
            };
            shared.to_peer(peer, reply);
        }
        Some("putStop") => {
            streams.take(peer, id);
        }
        _ => {}
    }
}

/// A picture small enough to show arriving, as base64.
pub fn small_picture_of(path: &std::path::Path, mime: &str) -> Option<String> {
    use base64::Engine;
    if !mime.starts_with("image/") {
        return None;
    }
    let size = std::fs::metadata(path).ok()?.len();
    if size > 4_500_000 {
        return None;
    }
    Some(base64::engine::general_purpose::STANDARD.encode(std::fs::read(path).ok()?))
}

/// The phones connected now, by peer number.
pub type Peers = HashMap<u64, Peer>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_request_head() {
        let head = parse_head(b"GET /remote.html HTTP/1.1\r\nHost: 192.168.1.4:47800\r\nUpgrade: websocket\r\n\r\nrest")
            .unwrap();
        assert_eq!(head.method, "GET");
        assert_eq!(head.path, "/remote.html");
        assert_eq!(head.host.as_deref(), Some("192.168.1.4:47800"));
        assert!(head.upgrade);
        assert_eq!(head.length, 74);
        assert!(parse_head(b"GET / HTTP/1.1\r\nHost: x").is_none());
    }

    #[test]
    fn answers_addresses_only() {
        assert!(host_is_address(Some("192.168.1.4:47800")));
        assert!(host_is_address(Some("10.0.0.2")));
        assert!(host_is_address(Some("[fe80::1]:47800")));
        assert!(host_is_address(Some("[::1]")));
        assert!(!host_is_address(Some("evil.example:47800")));
        assert!(!host_is_address(Some("localhost:47800")));
        assert!(!host_is_address(None));
    }

    #[test]
    fn serves_the_remote_page_and_its_files_only() {
        assert_eq!(asset_for("/").as_deref(), Some("remote.html"));
        assert_eq!(
            asset_for("/remote.html?x=1").as_deref(),
            Some("remote.html")
        );
        assert_eq!(
            asset_for("/assets/remote-Ab12_c.js").as_deref(),
            Some("assets/remote-Ab12_c.js")
        );
        for refused in [
            "/index.html",
            "/assets/",
            "/assets/../secret",
            "/assets/a/b.js",
            "/licenses/x",
            "/icons/icon-512.png",
            "/assets/%2e%2e",
        ] {
            assert_eq!(asset_for(refused), None, "{refused}");
        }
        assert!(!asset_name_matches("assets/x.js", "text/html"));
        assert!(asset_name_matches("assets/x.js", "text/javascript"));
    }

    fn hello(key: &SealKey, challenge: &str, device: Option<&str>) -> String {
        let inside = json!({ "c": challenge, "name": "iPhone" }).to_string();
        json!({ "t": "hello", "device": device, "box": seal::to_base64(&seal::seal(key, inside.as_bytes())) })
            .to_string()
    }

    #[test]
    fn admits_the_code_on_screen_and_remembered_phones() {
        let code = [3u8; 32];
        let known = [4u8; 32];
        let remembered = |d: &str| (d == "phone-1").then_some(known);
        assert_eq!(
            admit(&hello(&code, "c1", None), "c1", remembered, Some(code)),
            Some(Admitted::New {
                key: code,
                name: "iPhone".into()
            })
        );
        assert_eq!(
            admit(
                &hello(&known, "c1", Some("phone-1")),
                "c1",
                remembered,
                None
            ),
            Some(Admitted::Known {
                device: "phone-1".into(),
                key: known,
                name: "iPhone".into()
            })
        );
    }

    #[test]
    fn refuses_old_hellos_wrong_keys_and_spent_codes() {
        let code = [3u8; 32];
        let none = |_: &str| None;
        // Played back on another connection.
        assert_eq!(
            admit(&hello(&code, "c1", None), "c2", none, Some(code)),
            None
        );
        // Sealed with some other key.
        assert_eq!(
            admit(&hello(&[9u8; 32], "c1", None), "c1", none, Some(code)),
            None
        );
        // The code was used or ran out.
        assert_eq!(admit(&hello(&code, "c1", None), "c1", none, None), None);
        // A phone this PC forgot.
        assert_eq!(
            admit(&hello(&code, "c1", Some("gone")), "c1", none, Some(code)),
            None
        );
        assert_eq!(admit("not json", "c1", none, Some(code)), None);
    }

    #[test]
    fn messages_in_must_be_new_and_from_the_phone() {
        let key = [5u8; 32];
        let from_phone = |s: u64, d: &str| {
            seal::seal(
                &key,
                json!({ "t": "next", "s": s, "d": d })
                    .to_string()
                    .as_bytes(),
            )
        };
        let mut last = 0;
        assert_eq!(
            opened_in(&key, &mut last, &from_phone(1, "p")),
            Some(json!({ "t": "next" }))
        );
        // The same message again, and an older one.
        assert_eq!(opened_in(&key, &mut last, &from_phone(1, "p")), None);
        assert!(opened_in(&key, &mut last, &from_phone(3, "p")).is_some());
        assert_eq!(opened_in(&key, &mut last, &from_phone(2, "p")), None);
        // The PC's own message sent back to it.
        assert_eq!(opened_in(&key, &mut last, &from_phone(9, "c")), None);
        assert_eq!(opened_in(&[6u8; 32], &mut last, &from_phone(10, "p")), None);
    }

    #[test]
    fn messages_out_are_numbered() {
        let key = [5u8; 32];
        let mut seq = 0;
        let Some(Message::Binary(one)) = sealed_out(&key, &mut seq, json!({ "t": "state" })) else {
            panic!()
        };
        let Some(Message::Binary(two)) = sealed_out(&key, &mut seq, json!({ "t": "state" })) else {
            panic!()
        };
        let one: Value = serde_json::from_slice(&seal::open(&key, &one).unwrap()).unwrap();
        let two: Value = serde_json::from_slice(&seal::open(&key, &two).unwrap()).unwrap();
        assert_eq!((one["s"].as_u64(), two["s"].as_u64()), (Some(1), Some(2)));
        assert_eq!(one["d"], "c");
    }
}
