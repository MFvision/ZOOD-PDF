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
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;

use super::seal::{self, SealKey};
use super::{input, Host, Peer, Shared, MESSAGE_EVENT};

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
    let Ok(Some(Ok(Message::Text(text)))) = first else {
        return;
    };
    let admitted = admit(
        text.as_str(),
        &challenge,
        |device| shared.phones.lock().ok()?.find(device)?.key(),
        shared.code(),
    );
    let Some(admitted) = admitted else {
        let _ = sink
            .send(Message::Text(json!({ "t": "refused" }).to_string().into()))
            .await;
        return;
    };

    // This connection is locked with the key its hello came in. A new
    // phone's own key only reaches it inside the welcome, for next time.
    let (device, key, name, welcome) = match admitted {
        Admitted::Known { device, key, name } => {
            if let Ok(mut phones) = shared.phones.lock() {
                phones.touch(&device, &name);
            }
            (device, key, name, None)
        }
        Admitted::New { key: code, name } => {
            // One phone per code: the next one needs a new code.
            shared.used_code();
            let device = seal::random_id();
            let key = seal::random_key();
            if let Ok(mut phones) = shared.phones.lock() {
                phones.add(device.clone(), &name, &key);
            }
            let welcome =
                json!({ "t": "welcome", "device": device, "key": seal::key_to_text(&key) });
            (device, code, name, Some(welcome))
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
            },
        );
    }
    if let Some(welcome) = welcome {
        if let Some(m) = sealed_out(&session, &mut out_seq, welcome) {
            let _ = sink.send(m).await;
        }
    }
    let ready =
        json!({ "t": "ready", "pc": super::pc_name(), "pcControl": shared.pc_control_on() });
    if let Some(m) = sealed_out(&session, &mut out_seq, ready) {
        let _ = sink.send(m).await;
    }
    shared.changed();
    shared.host.tell(
        MESSAGE_EVENT,
        json!({ "peer": peer, "message": { "t": "joined" } }),
    );

    let mut window = Instant::now();
    let mut count = 0u32;
    loop {
        tokio::select! {
            _ = stop.changed() => break,
            outgoing = rx.recv() => {
                let Some(message) = outgoing else { break };
                let Some(m) = sealed_out(&session, &mut out_seq, message) else { continue };
                if sink.send(m).await.is_err() {
                    break;
                }
            }
            incoming = source.next() => {
                let Some(Ok(frame)) = incoming else { break };
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
    // A drag the phone was holding when it left is let go.
    if shared.pc_control_on() {
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
            if !shared.pc_control_on() {
                return;
            }
            if let Some(act) = input::parse(&message) {
                input::perform(act);
            }
        }
        Some("drop") => land(shared, peer, message),
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
