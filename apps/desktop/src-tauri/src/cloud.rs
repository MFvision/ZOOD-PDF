//! Cloud drives — OneDrive and Google Drive — the parts only the desktop can do.
//!
//! Signing in is OAuth 2.0 for native apps (RFC 8252) as a public client
//! with PKCE, and no client secret anywhere: the interface builds the
//! authorization request, the person signs in in the system's own browser,
//! and the browser comes back to a listener here on 127.0.0.1, at a port
//! chosen for that one sign-in, which takes exactly one answer carrying the
//! state the interface expects and then closes.
//!
//! What is kept, and where: the refresh token — the long-lived credential —
//! goes from the token endpoint's answer straight into the system's
//! credential store (the macOS keychain, Windows Credential Manager, the
//! Secret Service) and never reaches the webview, which is given access
//! tokens, good for an hour, only. Everything the drives are asked goes out
//! from here, to their own hosts only (`hosts.json`, the same list the web
//! build's security policy is made from). The webview could not do it
//! itself: its policy lets it reach none of these hosts, and Microsoft's
//! token endpoint refuses to redeem a desktop app's code for a request that
//! carries an `Origin`, as every request from a webview does.
//!
//! Nothing here runs without a click: the interface calls these commands
//! only when the person signs in, opens, saves or signs out.
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager, Runtime, State};
use ureq::http;

use crate::core_bridge::{debug_log, decode_frame, encode_frame};

/* -------------------------------------------------------------- drives */

/// A drive: whose token a secret is, and whose hosts a request may reach.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Provider {
    OneDrive,
    GoogleDrive,
}

impl Provider {
    pub fn parse(name: &str) -> Result<Self, String> {
        match name {
            "onedrive" => Ok(Self::OneDrive),
            "gdrive" => Ok(Self::GoogleDrive),
            other => Err(format!("E_ARGS: there is no drive called {other:?}")),
        }
    }

    /// Its name in `hosts.json`, in the interface and in the credential store.
    pub fn key(self) -> &'static str {
        match self {
            Self::OneDrive => "onedrive",
            Self::GoogleDrive => "gdrive",
        }
    }
}

/* --------------------------------------------------------------- hosts */

/// The hosts each drive's requests may go to, shared with the web build's
/// `connect-src` (`packages/ui/vite/cloudConfig.ts`).
const HOSTS_JSON: &str = include_str!("../../../../packages/ui/src/cloud/hosts.json");

#[derive(Deserialize, Default)]
struct HostList {
    onedrive: Vec<String>,
    gdrive: Vec<String>,
}

/// `hosts.json`, read once. Were it ever unreadable the lists would be
/// empty and every request refused: closed, not open.
fn host_list() -> &'static HostList {
    static LIST: OnceLock<HostList> = OnceLock::new();
    LIST.get_or_init(|| serde_json::from_str(HOSTS_JSON).unwrap_or_default())
}

fn hosts_of(provider: Provider) -> &'static [String] {
    match provider {
        Provider::OneDrive => &host_list().onedrive,
        Provider::GoogleDrive => &host_list().gdrive,
    }
}

/// `host` (lower case) is `pattern`, or — for `*.example.com` — a name under it.
fn host_matches(pattern: &str, host: &str) -> bool {
    match pattern.strip_prefix("*.") {
        Some(domain) => host
            .strip_suffix(domain)
            .and_then(|label| label.strip_suffix('.'))
            .is_some_and(|label| !label.is_empty()),
        None => host == pattern,
    }
}

/// The address without its query, which can itself be a credential (a
/// download link is pre-authenticated): for logs and messages.
fn without_query(url: &str) -> &str {
    url.split(['?', '#']).next().unwrap_or(url)
}

/// `url`, if it is `https` on the standard port to one of `provider`'s hosts,
/// with no credentials of its own.
pub fn checked_uri(provider: Provider, url: &str) -> Result<http::Uri, String> {
    let refused = || {
        format!(
            "E_CLOUD_HOST: {} is not one of {}'s addresses",
            without_query(url),
            provider.key()
        )
    };
    let uri: http::Uri = url.parse().map_err(|_| refused())?;
    let authority = uri.authority().ok_or_else(refused)?;
    let host = authority.host().to_ascii_lowercase();
    let allowed = uri.scheme_str() == Some("https")
        && !authority.as_str().contains('@')
        && authority.port_u16().is_none_or(|port| port == 443)
        && hosts_of(provider)
            .iter()
            .any(|pattern| host_matches(pattern, &host));
    if allowed {
        Ok(uri)
    } else {
        Err(refused())
    }
}

/// Microsoft's `/{tenant}/oauth2/v2.0/token` and Google's `/token`: the only
/// addresses a code or a refresh token is sent to.
fn is_token_endpoint(provider: Provider, uri: &http::Uri) -> bool {
    if uri.query().is_some() {
        return false;
    }
    match provider {
        Provider::OneDrive => {
            uri.host() == Some("login.microsoftonline.com")
                && uri
                    .path()
                    .strip_prefix('/')
                    .and_then(|path| path.strip_suffix("/oauth2/v2.0/token"))
                    .is_some_and(|tenant| {
                        !tenant.is_empty()
                            && tenant
                                .chars()
                                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
                    })
        }
        Provider::GoogleDrive => {
            uri.host() == Some("oauth2.googleapis.com") && uri.path() == "/token"
        }
    }
}

/// Google's revocation endpoint. Microsoft has none for a public client.
fn is_revoke_endpoint(provider: Provider, uri: &http::Uri) -> bool {
    provider == Provider::GoogleDrive
        && uri.host() == Some("oauth2.googleapis.com")
        && uri.path() == "/revoke"
        && uri.query().is_none()
}

/* ---------------------------------------------------------------- HTTP */

/// The largest answer taken from a drive: a PDF, however large it gets here.
const MAX_ANSWER: u64 = 1024 * 1024 * 1024;

/// A drive's answer, as the interface is given it.
#[derive(Debug)]
pub struct Answer {
    pub status: u16,
    /// Lower-case names; a repeated header keeps its last value.
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
}

/// Headers the interface may not set: the connection's own, and cookies.
fn forbidden_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "host"
            | "content-length"
            | "connection"
            | "transfer-encoding"
            | "te"
            | "upgrade"
            | "keep-alive"
            | "proxy-authorization"
            | "proxy-connection"
            | "cookie"
    )
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(20)))
        // A large file over a slow line; each phase is bounded again below.
        .timeout_global(Some(Duration::from_secs(30 * 60)))
        .timeout_recv_response(Some(Duration::from_secs(120)))
        // A redirect comes back as it is: the interface follows it only to
        // an allowed host, through this command again.
        .max_redirects(0)
        // A 4xx is an answer the interface acts on (a conflict, a token that
        // expired), not a failure of the request.
        .http_status_as_error(false)
        .user_agent("Warraq")
        .build()
        .into()
}

/// Sends one request exactly as asked. The address has been checked by the
/// caller (`checked_uri`); nothing here follows a redirect.
pub fn send(
    method: &str,
    uri: &http::Uri,
    headers: &BTreeMap<String, String>,
    body: Vec<u8>,
) -> Result<Answer, String> {
    let method = match method {
        "GET" => http::Method::GET,
        "POST" => http::Method::POST,
        "PUT" => http::Method::PUT,
        "PATCH" => http::Method::PATCH,
        "DELETE" => http::Method::DELETE,
        other => return Err(format!("E_ARGS: {other} is not a method a drive is sent")),
    };
    let mut builder = http::Request::builder().method(method.clone()).uri(uri);
    for (name, value) in headers {
        if forbidden_header(name) {
            return Err(format!(
                "E_ARGS: the {name} header is not set by the interface"
            ));
        }
        builder = builder.header(name.as_str(), value.as_str());
    }
    let agent = agent();
    let sent = if method == http::Method::GET || method == http::Method::DELETE {
        builder
            .body(())
            .map_err(|e| format!("E_ARGS: {e}"))
            .and_then(|request| agent.run(request).map_err(net_err))
    } else {
        builder
            .body(body)
            .map_err(|e| format!("E_ARGS: {e}"))
            .and_then(|request| agent.run(request).map_err(net_err))
    };
    let mut response = sent?;
    let status = response.status().as_u16();
    let headers = response
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.as_str().to_ascii_lowercase(), value.to_string()))
        })
        .collect();
    let body = response
        .body_mut()
        .with_config()
        .limit(MAX_ANSWER)
        .read_to_vec()
        .map_err(net_err)?;
    Ok(Answer {
        status,
        headers,
        body,
    })
}

fn net_err(e: ureq::Error) -> String {
    format!("E_NET: {e}")
}

/// `application/x-www-form-urlencoded`, as a token endpoint reads it.
pub fn form_encode<'a>(pairs: impl IntoIterator<Item = (&'a str, &'a str)>) -> String {
    fn encode(text: &str, out: &mut String) {
        for byte in text.bytes() {
            match byte {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                    out.push(byte as char)
                }
                _ => out.push_str(&format!("%{byte:02X}")),
            }
        }
    }
    let mut out = String::new();
    for (name, value) in pairs {
        if !out.is_empty() {
            out.push('&');
        }
        encode(name, &mut out);
        out.push('=');
        encode(value, &mut out);
    }
    out
}

fn post_form(uri: &http::Uri, form: String) -> Result<(u16, Vec<u8>), String> {
    let headers = BTreeMap::from([
        (
            "content-type".to_string(),
            "application/x-www-form-urlencoded".to_string(),
        ),
        ("accept".to_string(), "application/json".to_string()),
    ]);
    let answer = send("POST", uri, &headers, form.into_bytes())?;
    Ok((answer.status, answer.body))
}

/* ------------------------------------------------------ the credential store */

/// Where a drive's refresh token is kept between runs.
pub trait SecretStore: Send + Sync {
    fn get(&self, provider: Provider) -> Result<Option<String>, String>;
    fn set(&self, provider: Provider, secret: &str) -> Result<(), String>;
    /// Forgetting what is not there is not an error.
    fn delete(&self, provider: Provider) -> Result<(), String>;
}

/// The system's credential store: the macOS keychain, Windows Credential
/// Manager, the Secret Service on Linux (the `keyring` crate). One entry per
/// drive, under the app's identifier.
pub struct Keychain;

const KEYCHAIN_SERVICE: &str = "app.warraq.desktop.cloud";

fn keychain_err(e: keyring::Error) -> String {
    format!("E_KEYCHAIN: {e}")
}

impl Keychain {
    fn entry(provider: Provider) -> Result<keyring::Entry, String> {
        keyring::Entry::new(KEYCHAIN_SERVICE, provider.key()).map_err(keychain_err)
    }
}

impl SecretStore for Keychain {
    fn get(&self, provider: Provider) -> Result<Option<String>, String> {
        match Self::entry(provider)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(keychain_err(e)),
        }
    }

    fn set(&self, provider: Provider, secret: &str) -> Result<(), String> {
        Self::entry(provider)?
            .set_password(secret)
            .map_err(keychain_err)
    }

    fn delete(&self, provider: Provider) -> Result<(), String> {
        match Self::entry(provider)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(keychain_err(e)),
        }
    }
}

/* -------------------------------------------------------------- tokens */

/// A POST of a form to an endpoint already checked, answering its status
/// and body.
pub type PostForm<'a> = &'a dyn Fn(String) -> Result<(u16, Vec<u8>), String>;

/// Redeems an authorization code or refreshes, and keeps the refresh token.
///
/// The form is the interface's (client id, code, verifier, redirect, scope)
/// and may carry no refresh token and no secret: a refresh token is added
/// here from the store, and there is no secret. The answer goes back to the
/// interface without its refresh token. A new sign-in replaces whatever was
/// kept, even when it brings no refresh token of its own — it may be a
/// different account; a refresh keeps the old one unless a new one comes.
/// A refresh the provider no longer honours (`invalid_grant`) signs out.
pub fn token(
    store: &dyn SecretStore,
    provider: Provider,
    mut form: BTreeMap<String, String>,
    post: PostForm<'_>,
) -> Result<serde_json::Value, String> {
    let refreshing = match form.get("grant_type").map(String::as_str) {
        Some("authorization_code") => false,
        Some("refresh_token") => true,
        _ => return Err("E_ARGS: grant_type must be authorization_code or refresh_token".into()),
    };
    if form.contains_key("refresh_token") || form.contains_key("client_secret") {
        return Err("E_ARGS: refresh tokens and secrets are not sent by the interface".into());
    }
    if refreshing {
        let kept = store
            .get(provider)?
            .ok_or_else(|| "E_CLOUD_SIGNED_OUT: no sign-in is kept on this computer".to_string())?;
        form.insert("refresh_token".into(), kept);
    }
    let (status, body) = post(form_encode(
        form.iter()
            .map(|(name, value)| (name.as_str(), value.as_str())),
    ))?;
    let mut answer: serde_json::Value = serde_json::from_slice(&body)
        .map_err(|_| format!("E_CLOUD_TOKEN {status}: the answer is not JSON"))?;
    if !(200..300).contains(&status) {
        let error = answer["error"].as_str().unwrap_or("error").to_string();
        let description = answer["error_description"]
            .as_str()
            .unwrap_or("")
            .to_string();
        if refreshing && error == "invalid_grant" {
            store.delete(provider)?;
            return Err(format!("E_CLOUD_SIGNED_OUT: {description}"));
        }
        return Err(format!("E_CLOUD_TOKEN {status}: {error}: {description}"));
    }
    let fields = answer
        .as_object_mut()
        .ok_or_else(|| format!("E_CLOUD_TOKEN {status}: the answer is not an object"))?;
    if !fields
        .get("access_token")
        .is_some_and(serde_json::Value::is_string)
    {
        return Err(format!(
            "E_CLOUD_TOKEN {status}: the answer has no access token"
        ));
    }
    let refresh = fields.remove("refresh_token");
    if !refreshing {
        store.delete(provider)?;
    }
    if let Some(serde_json::Value::String(refresh)) = refresh {
        store.set(provider, &refresh)?;
    }
    Ok(answer)
}

/// Signs out: asks the provider to revoke the kept token where it can
/// (`revoke`, Google), then forgets it whether or not the provider could be
/// reached. Answers whether the provider confirmed the revocation.
pub fn forget(
    store: &dyn SecretStore,
    provider: Provider,
    revoke: Option<PostForm<'_>>,
) -> Result<bool, String> {
    let kept = store.get(provider).ok().flatten();
    let revoked = match (kept, revoke) {
        (Some(token), Some(post)) => post(form_encode([("token", token.as_str())]))
            .is_ok_and(|(status, _)| (200..300).contains(&status)),
        _ => false,
    };
    store.delete(provider)?;
    Ok(revoked)
}

/* ------------------------------------------------------------- sign-in */

/// The path the browser comes back to: `http://127.0.0.1:<port>/callback`.
pub const CALLBACK_PATH: &str = "/callback";

/// How long a sign-in may take in the browser (a password, a second factor,
/// a consent screen), and how long one connection may take to say what it
/// wants.
#[derive(Clone, Copy, Debug)]
pub struct Patience {
    pub whole: Duration,
    pub each: Duration,
}

pub const SIGN_IN: Patience = Patience {
    whole: Duration::from_secs(10 * 60),
    each: Duration::from_secs(5),
};

/// A request line and headers larger than this are not a browser's redirect.
const MAX_REQUEST: usize = 8 * 1024;
/// Connections read at once; more wait for these (a browser opens one or two).
const MAX_CONNECTIONS: usize = 8;

/// The one-shot listener of one sign-in, on 127.0.0.1 at a port the system
/// chose. Dropping it closes the port.
pub struct Listener {
    socket: TcpListener,
    port: u16,
    cancel: Arc<AtomicBool>,
}

impl Listener {
    pub fn open() -> Result<Self, String> {
        let listen_err = |e: std::io::Error| format!("E_CLOUD_LISTEN: {e}");
        let socket = TcpListener::bind(("127.0.0.1", 0)).map_err(listen_err)?;
        socket.set_nonblocking(true).map_err(listen_err)?;
        let port = socket.local_addr().map_err(listen_err)?.port();
        Ok(Self {
            socket,
            port,
            cancel: Arc::new(AtomicBool::new(false)),
        })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// Set it to end the wait with [`Ended::Cancelled`].
    pub fn canceller(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.cancel)
    }
}

/// Why a sign-in ended without an authorization code.
#[derive(Debug, PartialEq, Eq)]
pub enum Ended {
    Timeout,
    Cancelled,
    /// The provider sent the person back with an error (they declined, or
    /// the request was refused), or with neither a code nor an error.
    Denied {
        error: String,
        description: String,
    },
}

/// Waits for the browser to come back with `state`, and answers the
/// redirect's parameters (`code`, `scope`, Google's `picked_file_ids`…).
///
/// Only a `GET` of [`CALLBACK_PATH`] carrying exactly `state` ends the wait;
/// anything else — another path (a browser asks for `/favicon.ico`), another
/// method, a state that is not this sign-in's (a page elsewhere can make the
/// browser request 127.0.0.1 too), a repeated parameter — is refused and the
/// wait goes on, until `patience.whole` has passed. Nothing a request carries
/// is ever written back into a page. The listener is closed when this
/// returns, so the port answers nothing more.
pub fn wait(
    listener: Listener,
    state: &str,
    patience: Patience,
) -> Result<BTreeMap<String, String>, Ended> {
    let deadline = Instant::now() + patience.whole;
    let (sender, requests) = mpsc::channel::<(TcpStream, String, String)>();
    let reading = Arc::new(AtomicUsize::new(0));
    loop {
        if listener.cancel.load(Ordering::SeqCst) {
            return Err(Ended::Cancelled);
        }
        if Instant::now() >= deadline {
            return Err(Ended::Timeout);
        }
        let mut idle = true;
        while let Ok((stream, method, target)) = requests.try_recv() {
            idle = false;
            if let Some(outcome) = answer(stream, &method, &target, state) {
                return outcome;
            }
        }
        if reading.load(Ordering::SeqCst) < MAX_CONNECTIONS {
            match listener.socket.accept() {
                Ok((stream, _)) => {
                    idle = false;
                    reading.fetch_add(1, Ordering::SeqCst);
                    let sender = sender.clone();
                    let reading = Arc::clone(&reading);
                    let each = patience.each;
                    std::thread::spawn(move || {
                        if let Some((stream, method, target)) = read_request(stream, each) {
                            // The wait may be over; the connection then closes unanswered.
                            let _ = sender.send((stream, method, target));
                        }
                        reading.fetch_sub(1, Ordering::SeqCst);
                    });
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                // A connection that failed before it was accepted: the next one may not.
                Err(_) => {}
            }
        }
        if idle {
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

/// The request line of one connection: `(method, target)`, or `None` when
/// it is not a well-formed HTTP/1 request within the size and time allowed
/// (which is then answered, or simply closed).
fn read_request(mut stream: TcpStream, each: Duration) -> Option<(TcpStream, String, String)> {
    // An accepted socket inherits the listener's non-blocking mode on macOS.
    stream.set_nonblocking(false).ok()?;
    stream.set_read_timeout(Some(each)).ok()?;
    stream.set_write_timeout(Some(each)).ok()?;
    let deadline = Instant::now() + each;
    let mut seen = Vec::new();
    let mut buffer = [0u8; 1024];
    let too_large = |stream: &mut TcpStream| {
        respond(
            stream,
            431,
            "Request Header Fields Too Large",
            NOT_THIS_PAGE,
        );
    };
    let end = loop {
        if let Some(at) = seen.windows(4).position(|w| w == b"\r\n\r\n") {
            if at > MAX_REQUEST {
                too_large(&mut stream);
                return None;
            }
            break at;
        }
        if seen.len() > MAX_REQUEST {
            too_large(&mut stream);
            return None;
        }
        if Instant::now() >= deadline {
            return None;
        }
        match stream.read(&mut buffer) {
            Ok(0) | Err(_) => return None,
            Ok(n) => seen.extend_from_slice(&buffer[..n]),
        }
    };
    let head = std::str::from_utf8(&seen[..end]).ok()?;
    let mut parts = head.lines().next()?.split(' ');
    let (method, target, version) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() || !version.starts_with("HTTP/1.") || !target.starts_with('/') {
        respond(&mut stream, 400, "Bad Request", NOT_THIS_PAGE);
        return None;
    }
    Some((stream, method.to_string(), target.to_string()))
}

/// Answers one request; `Some` when it ends the wait.
fn answer(
    mut stream: TcpStream,
    method: &str,
    target: &str,
    state: &str,
) -> Option<Result<BTreeMap<String, String>, Ended>> {
    if method != "GET" {
        respond(&mut stream, 405, "Method Not Allowed", NOT_THIS_PAGE);
        return None;
    }
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    if path != CALLBACK_PATH {
        respond(&mut stream, 404, "Not Found", NOT_THIS_PAGE);
        return None;
    }
    let Some(params) = parse_query(query) else {
        respond(&mut stream, 400, "Bad Request", NOT_THIS_PAGE);
        return None;
    };
    if !params.get("state").is_some_and(|given| same(given, state)) {
        respond(&mut stream, 400, "Bad Request", NOT_THIS_PAGE);
        return None;
    }
    if let Some(error) = params.get("error") {
        respond(&mut stream, 200, "OK", NOT_DONE_PAGE);
        return Some(Err(Ended::Denied {
            error: error.clone(),
            description: params.get("error_description").cloned().unwrap_or_default(),
        }));
    }
    if !params.get("code").is_some_and(|code| !code.is_empty()) {
        respond(&mut stream, 400, "Bad Request", NOT_DONE_PAGE);
        return Some(Err(Ended::Denied {
            error: "invalid_response".into(),
            description: "the answer carried neither a code nor an error".into(),
        }));
    }
    respond(&mut stream, 200, "OK", DONE_PAGE);
    Some(Ok(params))
}

/// Compares every byte, so how long it takes says nothing of where they differ.
fn same(given: &str, expected: &str) -> bool {
    given.len() == expected.len()
        && given
            .bytes()
            .zip(expected.bytes())
            .fold(0u8, |differ, (a, b)| differ | (a ^ b))
            == 0
}

/// A query's parameters, `%XX` and `+` decoded; `None` when it is not
/// UTF-8, is badly encoded or repeats a parameter (RFC 6749 §3.1: none may
/// be sent twice — a second one could only be someone else's).
pub fn parse_query(query: &str) -> Option<BTreeMap<String, String>> {
    let mut params = BTreeMap::new();
    for pair in query.split('&').filter(|pair| !pair.is_empty()) {
        let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
        let (name, value) = (form_decode(name)?, form_decode(value)?);
        if params.insert(name, value).is_some() {
            return None;
        }
    }
    Some(params)
}

fn form_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        match bytes[at] {
            b'+' => {
                out.push(b' ');
                at += 1;
            }
            b'%' => {
                let hex = std::str::from_utf8(bytes.get(at + 1..at + 3)?).ok()?;
                out.push(u8::from_str_radix(hex, 16).ok()?);
                at += 3;
            }
            byte => {
                out.push(byte);
                at += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

fn respond(stream: &mut TcpStream, status: u16, reason: &str, page: &str) {
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: text/html; charset=utf-8\r\n\
         Content-Length: {}\r\n\
         Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'\r\n\
         Cache-Control: no-store\r\n\
         Referrer-Policy: no-referrer\r\n\
         X-Content-Type-Options: nosniff\r\n\
         Connection: close\r\n\r\n",
        page.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(page.as_bytes());
    let _ = stream.flush();
}

/// The pages the browser is left on: fixed text, in both languages, that
/// never repeats anything the request carried.
const DONE_PAGE: &str = concat!(
    "<!doctype html><html lang=\"ar\" dir=\"rtl\"><head><meta charset=\"utf-8\">",
    "<title>ZOOD PDF</title><style>",
    "body{font:15px/1.6 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f5f5f7;color:#1d1d1f}",
    "main{max-width:32em;padding:2em}h1{font-size:1.4em;margin:0 0 .4em}",
    "@media (prefers-color-scheme:dark){body{background:#1c1c1e;color:#f5f5f7}}",
    "</style></head><body><main>",
    "<h1>تمّ تسجيل الدخول</h1><p>يمكنك إغلاق هذا التبويب والعودة إلى محرر زود PDF.</p>",
    "<p lang=\"en\" dir=\"ltr\">Signed in. You can close this tab and go back to ZOOD PDF.</p>",
    "</main></body></html>"
);

const NOT_DONE_PAGE: &str = concat!(
    "<!doctype html><html lang=\"ar\" dir=\"rtl\"><head><meta charset=\"utf-8\">",
    "<title>ZOOD PDF</title><style>",
    "body{font:15px/1.6 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f5f5f7;color:#1d1d1f}",
    "main{max-width:32em;padding:2em}h1{font-size:1.4em;margin:0 0 .4em}",
    "@media (prefers-color-scheme:dark){body{background:#1c1c1e;color:#f5f5f7}}",
    "</style></head><body><main>",
    "<h1>لم يكتمل تسجيل الدخول</h1><p>يمكنك إغلاق هذا التبويب؛ يوضّح محرر زود PDF ما حدث.</p>",
    "<p lang=\"en\" dir=\"ltr\">Sign-in was not completed. You can close this tab; ZOOD PDF says what happened.</p>",
    "</main></body></html>"
);

const NOT_THIS_PAGE: &str = concat!(
    "<!doctype html><html lang=\"ar\" dir=\"rtl\"><head><meta charset=\"utf-8\">",
    "<title>ZOOD PDF</title></head><body>",
    "<p>ليس هذا ما ينتظره محرر زود PDF.</p>",
    "<p lang=\"en\" dir=\"ltr\">This is not what ZOOD PDF is waiting for.</p>",
    "</body></html>"
);

/* ------------------------------------------------------------- commands */

/// What the commands share: the sign-in under way, and the credential store.
pub struct CloudState {
    pending: Mutex<Option<Listener>>,
    cancel: Mutex<Option<Arc<AtomicBool>>>,
    secrets: Box<dyn SecretStore>,
}

impl CloudState {
    pub fn new(secrets: Box<dyn SecretStore>) -> Self {
        Self {
            pending: Mutex::new(None),
            cancel: Mutex::new(None),
            secrets,
        }
    }
}

impl Default for CloudState {
    fn default() -> Self {
        Self::new(Box::new(Keychain))
    }
}

fn poisoned<T>(_: T) -> String {
    "E_CLOUD: the sign-in state is unavailable".to_string()
}

/// Opens the listener of a new sign-in and answers its port, for the
/// interface's redirect URI. A sign-in started before is cancelled.
#[tauri::command]
pub fn cloud_auth_listen(state: State<'_, CloudState>) -> Result<u16, String> {
    let listener = Listener::open()?;
    let port = listener.port();
    if let Some(earlier) = state
        .cancel
        .lock()
        .map_err(poisoned)?
        .replace(listener.canceller())
    {
        earlier.store(true, Ordering::SeqCst);
    }
    *state.pending.lock().map_err(poisoned)? = Some(listener);
    debug_log(format!("cloud: waiting for a sign-in on 127.0.0.1:{port}"));
    Ok(port)
}

/// Waits for the browser to come back to the listener `cloud_auth_listen`
/// opened, with `expected_state`; answers the redirect's parameters, or
/// `E_CLOUD_TIMEOUT`, `E_CLOUD_CANCELLED`, `E_CLOUD_DENIED: <error>: <why>`.
#[tauri::command]
pub async fn cloud_auth_wait<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, CloudState>,
    expected_state: String,
) -> Result<BTreeMap<String, String>, String> {
    if expected_state.len() < 16 {
        return Err("E_ARGS: the sign-in's state is too short to be unguessable".into());
    }
    let listener = state
        .pending
        .lock()
        .map_err(poisoned)?
        .take()
        .ok_or("E_CLOUD_LISTEN: no sign-in is waiting")?;
    let outcome =
        tauri::async_runtime::spawn_blocking(move || wait(listener, &expected_state, SIGN_IN))
            .await
            .map_err(|e| format!("E_CLOUD: {e}"))?;
    let bring_back = || {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_focus();
        }
    };
    match outcome {
        Ok(params) => {
            debug_log("cloud: the browser came back with a code");
            bring_back();
            Ok(params)
        }
        Err(Ended::Timeout) => Err("E_CLOUD_TIMEOUT: the browser did not come back in time".into()),
        Err(Ended::Cancelled) => Err("E_CLOUD_CANCELLED: the sign-in was cancelled".into()),
        Err(Ended::Denied { error, description }) => {
            debug_log(format!("cloud: the sign-in ended with {error}"));
            bring_back();
            Err(format!("E_CLOUD_DENIED: {error}: {description}"))
        }
    }
}

/// Ends the sign-in under way, if any: its wait answers `E_CLOUD_CANCELLED`.
#[tauri::command]
pub fn cloud_auth_cancel(state: State<'_, CloudState>) -> Result<(), String> {
    if let Some(cancel) = state.cancel.lock().map_err(poisoned)?.take() {
        cancel.store(true, Ordering::SeqCst);
    }
    Ok(())
}

/// A code redeemed, or a refresh, at `provider`'s token endpoint (`url`);
/// the refresh token is kept in the credential store, the rest answered as
/// JSON (see [`token`]).
#[tauri::command(async)]
pub fn cloud_token(
    state: State<'_, CloudState>,
    provider: String,
    url: String,
    form: BTreeMap<String, String>,
) -> Result<String, String> {
    let provider = Provider::parse(&provider)?;
    let uri = checked_uri(provider, &url)?;
    if !is_token_endpoint(provider, &uri) {
        return Err(format!(
            "E_CLOUD_HOST: {} is not {}'s token endpoint",
            without_query(&url),
            provider.key()
        ));
    }
    debug_log(format!(
        "cloud: {} token ({})",
        provider.key(),
        form.get("grant_type").map(String::as_str).unwrap_or("?")
    ));
    let answer = token(state.secrets.as_ref(), provider, form, &|body: String| {
        post_form(&uri, body)
    })?;
    Ok(answer.to_string())
}

/// Whether a sign-in is kept for `provider` (reads the credential store).
#[tauri::command(async)]
pub fn cloud_has_session(state: State<'_, CloudState>, provider: String) -> Result<bool, String> {
    let provider = Provider::parse(&provider)?;
    Ok(state.secrets.get(provider)?.is_some())
}

/// Signs out of `provider`: the kept token is revoked at `revoke_url` when
/// one is given (Google's), then forgotten. Answers whether the provider
/// confirmed the revocation.
#[tauri::command(async)]
pub fn cloud_forget(
    state: State<'_, CloudState>,
    provider: String,
    revoke_url: Option<String>,
) -> Result<bool, String> {
    let provider = Provider::parse(&provider)?;
    let revoke = match revoke_url {
        Some(url) => {
            let uri = checked_uri(provider, &url)?;
            if !is_revoke_endpoint(provider, &uri) {
                return Err(format!(
                    "E_CLOUD_HOST: {} is not {}'s revocation endpoint",
                    without_query(&url),
                    provider.key()
                ));
            }
            Some(uri)
        }
        None => None,
    };
    let post = |body: String| match &revoke {
        Some(uri) => post_form(uri, body),
        None => Err("no revocation endpoint".to_string()),
    };
    let revoked = forget(
        state.secrets.as_ref(),
        provider,
        revoke.as_ref().map(|_| &post as PostForm<'_>),
    )?;
    debug_log(format!(
        "cloud: signed out of {} (revoked: {revoked})",
        provider.key()
    ));
    Ok(revoked)
}

/// What the interface asks `cloud_http` to send, in the frame's JSON.
#[derive(Deserialize)]
struct HttpCall {
    provider: String,
    method: String,
    url: String,
    #[serde(default)]
    headers: BTreeMap<String, String>,
}

/// One request to a drive, framed as `core_call` frames: the JSON of
/// [`HttpCall`], then the body as the one blob (or none). Answers
/// `{status, headers}` and the body as the one blob of the reply.
#[tauri::command(async)]
pub fn cloud_http(request: Request<'_>) -> Result<Response, String> {
    let InvokeBody::Raw(frame) = request.body() else {
        return Err("E_ARGS: cloud_http takes a raw frame".into());
    };
    let (json, mut blobs) = decode_frame(frame)?;
    let call: HttpCall = serde_json::from_str(&json).map_err(|e| format!("E_ARGS: {e}"))?;
    let provider = Provider::parse(&call.provider)?;
    let uri = checked_uri(provider, &call.url)?;
    let body = if blobs.is_empty() {
        Vec::new()
    } else {
        blobs.swap_remove(0)
    };
    debug_log(format!(
        "cloud: {} {} ({} bytes)",
        call.method,
        without_query(&call.url),
        body.len()
    ));
    let answer = send(&call.method, &uri, &call.headers, body)?;
    debug_log(format!(
        "cloud: {} and {} bytes back",
        answer.status,
        answer.body.len()
    ));
    let head = serde_json::json!({ "status": answer.status, "headers": answer.headers });
    Ok(Response::new(encode_frame(
        &head.to_string(),
        &[answer.body],
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// The credential store as a map, for tests: the real one is the
    /// system's (see `the_system_keychain_keeps_a_token`).
    #[derive(Default)]
    struct MemoryStore(Mutex<HashMap<&'static str, String>>);

    impl SecretStore for MemoryStore {
        fn get(&self, provider: Provider) -> Result<Option<String>, String> {
            Ok(self.0.lock().unwrap().get(provider.key()).cloned())
        }
        fn set(&self, provider: Provider, secret: &str) -> Result<(), String> {
            self.0
                .lock()
                .unwrap()
                .insert(provider.key(), secret.to_string());
            Ok(())
        }
        fn delete(&self, provider: Provider) -> Result<(), String> {
            self.0.lock().unwrap().remove(provider.key());
            Ok(())
        }
    }

    #[test]
    fn the_host_list_is_the_one_the_web_build_uses() {
        let list: serde_json::Value = serde_json::from_str(HOSTS_JSON).unwrap();
        assert!(list["onedrive"].is_array() && list["gdrive"].is_array());
        assert_eq!(hosts_of(Provider::OneDrive).len(), 5);
        assert_eq!(
            hosts_of(Provider::GoogleDrive),
            ["oauth2.googleapis.com", "www.googleapis.com"]
        );
    }

    #[test]
    fn requests_go_only_to_the_drives_own_hosts() {
        let one = |url: &str| checked_uri(Provider::OneDrive, url).is_ok();
        let google = |url: &str| checked_uri(Provider::GoogleDrive, url).is_ok();
        assert!(one(
            "https://graph.microsoft.com/v1.0/me/drive/root/children"
        ));
        assert!(one(
            "https://login.microsoftonline.com/common/oauth2/v2.0/token"
        ));
        assert!(one("https://GRAPH.microsoft.com/v1.0/me"));
        assert!(one("https://graph.microsoft.com:443/v1.0/me"));
        // Downloads and uploads come from per-account hosts under these.
        assert!(one("https://public.am.files.1drv.com/y4m?x=1"));
        assert!(one("https://sn3302.up.1drv.com/up/fe69"));
        assert!(one(
            "https://contoso-my.sharepoint.com/personal/a/_layouts/15/download.aspx"
        ));
        assert!(one("https://my.microsoftpersonalcontent.com/personal/x"));
        assert!(google(
            "https://www.googleapis.com/drive/v3/files/abc?alt=media"
        ));

        // Not https, another port, credentials, lookalikes, the bare domain.
        assert!(!one("http://graph.microsoft.com/v1.0/me"));
        assert!(!one("https://graph.microsoft.com:8443/v1.0/me"));
        assert!(!one("https://user@graph.microsoft.com/v1.0/me"));
        assert!(!one("https://graph.microsoft.com@evil.example/v1.0/me"));
        assert!(!one("https://graph.microsoft.com.evil.example/"));
        assert!(!one("https://evil1drv.com/"));
        assert!(!one("https://1drv.com/"));
        assert!(!one("https://sharepoint.com.evil.example/"));
        assert!(!one("https://127.0.0.1/"));
        assert!(!one("file:///etc/passwd"));
        assert!(!one("not an address"));
        // Each drive has its own hosts only.
        assert!(!one("https://www.googleapis.com/drive/v3/files"));
        assert!(!google("https://graph.microsoft.com/v1.0/me"));
        // A refused address is named without its query, which can be a credential.
        let refused =
            checked_uri(Provider::OneDrive, "https://evil.example/x?tempauth=SECRET").unwrap_err();
        assert!(refused.starts_with("E_CLOUD_HOST"), "{refused}");
        assert!(!refused.contains("SECRET"), "{refused}");
    }

    #[test]
    fn codes_and_refresh_tokens_go_only_to_the_token_endpoints() {
        let endpoint = |provider, url: &str| is_token_endpoint(provider, &url.parse().unwrap());
        assert!(endpoint(
            Provider::OneDrive,
            "https://login.microsoftonline.com/common/oauth2/v2.0/token"
        ));
        assert!(endpoint(
            Provider::OneDrive,
            "https://login.microsoftonline.com/0b3f6a2e-1c1d-4c55-9d5e-2a9f5e0c1d22/oauth2/v2.0/token"
        ));
        assert!(endpoint(
            Provider::GoogleDrive,
            "https://oauth2.googleapis.com/token"
        ));
        assert!(!endpoint(
            Provider::OneDrive,
            "https://graph.microsoft.com/common/oauth2/v2.0/token"
        ));
        assert!(!endpoint(
            Provider::OneDrive,
            "https://login.microsoftonline.com/common/oauth2/v2.0/token?x=1"
        ));
        assert!(!endpoint(
            Provider::OneDrive,
            "https://login.microsoftonline.com//oauth2/v2.0/token"
        ));
        assert!(!endpoint(
            Provider::OneDrive,
            "https://login.microsoftonline.com/a/b/oauth2/v2.0/token"
        ));
        assert!(!endpoint(
            Provider::GoogleDrive,
            "https://www.googleapis.com/token"
        ));
        let revoke = |provider, url: &str| is_revoke_endpoint(provider, &url.parse().unwrap());
        assert!(revoke(
            Provider::GoogleDrive,
            "https://oauth2.googleapis.com/revoke"
        ));
        assert!(!revoke(
            Provider::OneDrive,
            "https://oauth2.googleapis.com/revoke"
        ));
    }

    #[test]
    fn forms_and_queries_are_encoded_and_decoded_exactly() {
        assert_eq!(
            form_encode([("redirect_uri", "http://127.0.0.1:5000/callback"), ("scope", "Files.ReadWrite offline_access")]),
            "redirect_uri=http%3A%2F%2F127.0.0.1%3A5000%2Fcallback&scope=Files.ReadWrite%20offline_access"
        );
        assert_eq!(form_encode([("name", "ملف")]), "name=%D9%85%D9%84%D9%81");
        let params = parse_query("code=M.C1%2Babc&state=xyz&scope=a+b&empty=").unwrap();
        assert_eq!(params["code"], "M.C1+abc");
        assert_eq!(params["scope"], "a b");
        assert_eq!(params["empty"], "");
        assert!(parse_query("code=%ZZ").is_none());
        assert!(parse_query("code=%E0%A4").is_none(), "not UTF-8");
        assert!(
            parse_query("state=a&state=b").is_none(),
            "a repeated parameter"
        );
        assert!(same("abc", "abc") && !same("abc", "abd") && !same("abc", "abcd"));
    }

    /* ---------------------------------------------- the sign-in listener */

    const STATE: &str = "Qv7m3Zb8Yw1pL0sN9cXe2Rt6";

    const QUICK: Patience = Patience {
        whole: Duration::from_secs(10),
        each: Duration::from_millis(500),
    };

    /// A browser's visit: the request as given, and the status line and page back.
    fn visit(port: u16, request: &str) -> Option<(u16, String)> {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).ok()?;
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        stream.write_all(request.as_bytes()).ok()?;
        let mut answer = String::new();
        stream.read_to_string(&mut answer).ok()?;
        let status = answer.split(' ').nth(1)?.parse().ok()?;
        Some((status, answer))
    }

    fn get(port: u16, target: &str) -> Option<(u16, String)> {
        visit(
            port,
            &format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n"),
        )
    }

    type Waiting = std::thread::JoinHandle<Result<BTreeMap<String, String>, Ended>>;

    fn waiting(patience: Patience) -> (u16, Arc<AtomicBool>, Waiting) {
        let listener = Listener::open().unwrap();
        let (port, cancel) = (listener.port(), listener.canceller());
        let handle = std::thread::spawn(move || wait(listener, STATE, patience));
        (port, cancel, handle)
    }

    #[test]
    fn the_browser_coming_back_with_the_state_ends_the_wait_with_its_code() {
        let (port, _, handle) = waiting(QUICK);
        let (status, page) = get(
            port,
            &format!("/callback?code=M.C1_abc%2Bdef&state={STATE}&picked_file_ids=1a%2C2b"),
        )
        .unwrap();
        assert_eq!(status, 200);
        assert!(page.contains("Signed in."), "{page}");
        assert!(page.contains("Content-Security-Policy: default-src 'none'"));
        let params = handle.join().unwrap().unwrap();
        assert_eq!(params["code"], "M.C1_abc+def");
        assert_eq!(params["picked_file_ids"], "1a,2b");
    }

    #[test]
    fn it_is_one_shot_the_port_closes_once_answered() {
        let (port, _, handle) = waiting(QUICK);
        assert_eq!(
            get(port, &format!("/callback?code=c&state={STATE}"))
                .unwrap()
                .0,
            200
        );
        handle.join().unwrap().unwrap();
        // The listener is gone: the same answer again reaches nothing.
        assert!(TcpStream::connect(("127.0.0.1", port)).is_err());
    }

    #[test]
    fn a_wrong_or_missing_state_is_refused_and_the_wait_goes_on() {
        let (port, _, handle) = waiting(QUICK);
        let (status, page) = get(port, "/callback?code=stolen&state=someone-elses").unwrap();
        assert_eq!(status, 400);
        // Nothing the request carried is written back.
        assert!(!page.contains("stolen") && !page.contains("someone-elses"));
        assert_eq!(get(port, "/callback?code=stolen").unwrap().0, 400);
        let almost = &STATE[..STATE.len() - 1];
        assert_eq!(
            get(port, &format!("/callback?code=x&state={almost}"))
                .unwrap()
                .0,
            400
        );
        assert_eq!(
            get(
                port,
                &format!("/callback?code=x&state={STATE}&state={STATE}")
            )
            .unwrap()
            .0,
            400,
            "a repeated parameter"
        );
        assert_eq!(
            get(port, &format!("/callback?code=real&state={STATE}"))
                .unwrap()
                .0,
            200
        );
        assert_eq!(handle.join().unwrap().unwrap()["code"], "real");
    }

    #[test]
    fn other_paths_and_methods_are_refused_and_the_wait_goes_on() {
        let (port, _, handle) = waiting(QUICK);
        assert_eq!(get(port, "/favicon.ico").unwrap().0, 404);
        assert_eq!(
            get(port, &format!("/other?code=x&state={STATE}"))
                .unwrap()
                .0,
            404
        );
        assert_eq!(
            get(port, &format!("/callback/x?code=x&state={STATE}"))
                .unwrap()
                .0,
            404
        );
        assert_eq!(
            visit(
                port,
                &format!(
                    "POST /callback?code=x&state={STATE} HTTP/1.1\r\nContent-Length: 0\r\n\r\n"
                )
            )
            .unwrap()
            .0,
            405
        );
        // Not a path: a proxy's form, which no browser sends to 127.0.0.1.
        assert_eq!(
            visit(port, "GET http://evil.example/callback HTTP/1.1\r\n\r\n")
                .map(|(status, _)| status),
            Some(400)
        );
        assert_eq!(
            get(port, &format!("/callback?code=c&state={STATE}"))
                .unwrap()
                .0,
            200
        );
        handle.join().unwrap().unwrap();
    }

    #[test]
    fn a_declined_consent_ends_the_wait_with_the_providers_reason() {
        let (port, _, handle) = waiting(QUICK);
        let (status, page) = get(
            port,
            &format!(
                "/callback?error=access_denied&error_description=the+user+cancelled&state={STATE}"
            ),
        )
        .unwrap();
        assert_eq!(status, 200);
        assert!(page.contains("Sign-in was not completed"));
        assert_eq!(
            handle.join().unwrap().unwrap_err(),
            Ended::Denied {
                error: "access_denied".into(),
                description: "the user cancelled".into()
            }
        );
    }

    #[test]
    fn a_sign_in_nobody_finishes_times_out() {
        let started = Instant::now();
        let (_, _, handle) = waiting(Patience {
            whole: Duration::from_millis(300),
            each: Duration::from_millis(100),
        });
        assert_eq!(handle.join().unwrap().unwrap_err(), Ended::Timeout);
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn a_cancelled_sign_in_ends_at_once() {
        let (_, cancel, handle) = waiting(QUICK);
        std::thread::sleep(Duration::from_millis(50));
        cancel.store(true, Ordering::SeqCst);
        assert_eq!(handle.join().unwrap().unwrap_err(), Ended::Cancelled);
    }

    /// A connection that says nothing (a browser's spare, or someone's
    /// slow client) holds up nobody: the real answer behind it still ends
    /// the wait, and a request too large to be a redirect is refused.
    #[test]
    fn silent_and_oversized_connections_do_not_hold_up_the_sign_in() {
        let (port, _, handle) = waiting(QUICK);
        let _silent: Vec<TcpStream> = (0..3)
            .map(|_| TcpStream::connect(("127.0.0.1", port)).unwrap())
            .collect();
        let huge = format!(
            "GET /callback?pad={} HTTP/1.1\r\n\r\n",
            "a".repeat(MAX_REQUEST + 10)
        );
        let refused = visit(port, &huge).map(|(status, _)| status);
        assert!(refused.is_none() || refused == Some(431), "{refused:?}");
        let started = Instant::now();
        assert_eq!(
            get(port, &format!("/callback?code=c&state={STATE}"))
                .unwrap()
                .0,
            200
        );
        assert!(started.elapsed() < Duration::from_millis(400));
        handle.join().unwrap().unwrap();
    }

    /* ------------------------------------------------------------ tokens */

    fn form(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(name, value)| (name.to_string(), value.to_string()))
            .collect()
    }

    type Seen = Arc<Mutex<Vec<String>>>;
    type Reply = Result<(u16, Vec<u8>), String>;

    /// A token endpoint that answers `reply` and records each form it got.
    fn endpoint(reply: (u16, &'static str)) -> (Seen, impl Fn(String) -> Reply) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        (seen, move |body: String| {
            log.lock().unwrap().push(body);
            Ok((reply.0, reply.1.as_bytes().to_vec()))
        })
    }

    #[test]
    fn a_redeemed_code_keeps_the_refresh_token_and_answers_without_it() {
        let store = MemoryStore::default();
        store
            .set(Provider::OneDrive, "an earlier account's")
            .unwrap();
        let (seen, post) = endpoint((
            200,
            r#"{"token_type":"Bearer","access_token":"AT1","expires_in":3599,"refresh_token":"RT1","scope":"Files.ReadWrite"}"#,
        ));
        let answer = token(
            &store,
            Provider::OneDrive,
            form(&[
                ("grant_type", "authorization_code"),
                ("client_id", "cid"),
                ("code", "C"),
                ("code_verifier", "V"),
                ("redirect_uri", "http://127.0.0.1:5000/callback"),
            ]),
            &post,
        )
        .unwrap();
        assert_eq!(answer["access_token"], "AT1");
        assert_eq!(answer["expires_in"], 3599);
        assert!(answer.get("refresh_token").is_none(), "{answer}");
        assert_eq!(
            store.get(Provider::OneDrive).unwrap().as_deref(),
            Some("RT1")
        );
        let sent = seen.lock().unwrap()[0].clone();
        assert!(sent.contains("code_verifier=V") && sent.contains("grant_type=authorization_code"));
        assert!(!sent.contains("client_secret"), "{sent}");
    }

    #[test]
    fn a_refresh_sends_the_kept_token_and_keeps_a_rotated_one() {
        let store = MemoryStore::default();
        store.set(Provider::OneDrive, "RT1").unwrap();
        let (seen, post) = endpoint((
            200,
            r#"{"access_token":"AT2","expires_in":3599,"refresh_token":"RT2"}"#,
        ));
        let answer = token(
            &store,
            Provider::OneDrive,
            form(&[("grant_type", "refresh_token"), ("client_id", "cid")]),
            &post,
        )
        .unwrap();
        assert_eq!(answer["access_token"], "AT2");
        assert!(seen.lock().unwrap()[0].contains("refresh_token=RT1"));
        assert_eq!(
            store.get(Provider::OneDrive).unwrap().as_deref(),
            Some("RT2")
        );

        // Google does not rotate: the kept token stays.
        store.set(Provider::GoogleDrive, "G1").unwrap();
        let (_, post) = endpoint((200, r#"{"access_token":"GA","expires_in":3599}"#));
        token(
            &store,
            Provider::GoogleDrive,
            form(&[("grant_type", "refresh_token"), ("client_id", "g")]),
            &post,
        )
        .unwrap();
        assert_eq!(
            store.get(Provider::GoogleDrive).unwrap().as_deref(),
            Some("G1")
        );
    }

    #[test]
    fn a_refresh_the_provider_refuses_signs_out() {
        let store = MemoryStore::default();
        store.set(Provider::OneDrive, "RT-expired").unwrap();
        let (_, post) = endpoint((
            400,
            r#"{"error":"invalid_grant","error_description":"AADSTS700084: expired"}"#,
        ));
        let error = token(
            &store,
            Provider::OneDrive,
            form(&[("grant_type", "refresh_token"), ("client_id", "cid")]),
            &post,
        )
        .unwrap_err();
        assert!(error.starts_with("E_CLOUD_SIGNED_OUT"), "{error}");
        assert_eq!(store.get(Provider::OneDrive).unwrap(), None);

        // Nothing kept: nothing is sent.
        let (seen, post) = endpoint((200, "{}"));
        let error = token(
            &store,
            Provider::OneDrive,
            form(&[("grant_type", "refresh_token"), ("client_id", "cid")]),
            &post,
        )
        .unwrap_err();
        assert!(error.starts_with("E_CLOUD_SIGNED_OUT"), "{error}");
        assert!(seen.lock().unwrap().is_empty());
    }

    #[test]
    fn the_interface_cannot_send_a_refresh_token_or_a_secret_or_another_grant() {
        let store = MemoryStore::default();
        let (seen, post) = endpoint((200, r#"{"access_token":"x"}"#));
        for bad in [
            form(&[("grant_type", "refresh_token"), ("refresh_token", "stolen")]),
            form(&[("grant_type", "authorization_code"), ("client_secret", "s")]),
            form(&[("grant_type", "client_credentials")]),
            form(&[("grant_type", "password")]),
            form(&[]),
        ] {
            let error = token(&store, Provider::OneDrive, bad, &post).unwrap_err();
            assert!(error.starts_with("E_ARGS"), "{error}");
        }
        assert!(seen.lock().unwrap().is_empty());
    }

    #[test]
    fn a_failed_redemption_says_why_in_the_providers_words() {
        let store = MemoryStore::default();
        let (_, post) = endpoint((
            400,
            r#"{"error":"invalid_request","error_description":"client_secret is missing."}"#,
        ));
        let error = token(
            &store,
            Provider::GoogleDrive,
            form(&[("grant_type", "authorization_code"), ("code", "c")]),
            &post,
        )
        .unwrap_err();
        assert_eq!(
            error,
            "E_CLOUD_TOKEN 400: invalid_request: client_secret is missing."
        );
    }

    #[test]
    fn signing_out_revokes_where_it_can_and_always_forgets() {
        let store = MemoryStore::default();
        store.set(Provider::GoogleDrive, "G1").unwrap();
        let (seen, post) = endpoint((200, "{}"));
        assert!(forget(&store, Provider::GoogleDrive, Some(&post)).unwrap());
        assert_eq!(seen.lock().unwrap()[0], "token=G1");
        assert_eq!(store.get(Provider::GoogleDrive).unwrap(), None);

        // Offline: not revoked, still forgotten.
        store.set(Provider::GoogleDrive, "G2").unwrap();
        let offline =
            |_: String| -> Result<(u16, Vec<u8>), String> { Err("E_NET: offline".into()) };
        assert!(!forget(&store, Provider::GoogleDrive, Some(&offline)).unwrap());
        assert_eq!(store.get(Provider::GoogleDrive).unwrap(), None);

        // Microsoft has no revocation endpoint for a public client.
        store.set(Provider::OneDrive, "RT").unwrap();
        assert!(!forget(&store, Provider::OneDrive, None).unwrap());
        assert_eq!(store.get(Provider::OneDrive).unwrap(), None);
    }

    /// The form really leaves as `application/x-www-form-urlencoded` over
    /// HTTP, and a 4xx comes back as an answer, not an error: a local
    /// server stands in for the token endpoint.
    #[test]
    fn a_form_is_posted_as_a_token_endpoint_reads_it() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut seen = Vec::new();
            let mut buffer = [0u8; 4096];
            loop {
                let n = stream.read(&mut buffer).unwrap();
                seen.extend_from_slice(&buffer[..n]);
                let text = String::from_utf8_lossy(&seen).to_string();
                if let Some(end) = text.find("\r\n\r\n") {
                    let length: usize = text
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse().unwrap())
                        })
                        .unwrap_or(0);
                    if seen.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            let body = r#"{"error":"invalid_grant"}"#;
            write!(
                stream,
                "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nETag: \"x\"\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
            String::from_utf8_lossy(&seen).into_owned()
        });
        let uri: http::Uri = format!("http://127.0.0.1:{port}/common/oauth2/v2.0/token")
            .parse()
            .unwrap();
        let (status, body) =
            post_form(&uri, form_encode([("grant_type", "refresh_token")])).unwrap();
        assert_eq!(status, 400);
        assert_eq!(body, br#"{"error":"invalid_grant"}"#);
        let request = server.join().unwrap();
        assert!(
            request.starts_with("POST /common/oauth2/v2.0/token "),
            "{request}"
        );
        let lower = request.to_ascii_lowercase();
        assert!(lower.contains("content-type: application/x-www-form-urlencoded"));
        assert!(
            !lower.contains("origin:"),
            "no Origin: the token endpoint would refuse it"
        );
        assert!(request.ends_with("grant_type=refresh_token"));
    }

    #[test]
    fn a_redirect_comes_back_to_be_followed_by_the_interface_and_headers_are_checked() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0u8; 4096];
            let _ = stream.read(&mut buffer).unwrap();
            stream
                .write_all(b"HTTP/1.1 302 Found\r\nLocation: https://public.am.files.1drv.com/y4m\r\nContent-Length: 0\r\n\r\n")
                .unwrap();
        });
        let uri: http::Uri = format!("http://127.0.0.1:{port}/content").parse().unwrap();
        let answer = send("GET", &uri, &BTreeMap::new(), Vec::new()).unwrap();
        server.join().unwrap();
        assert_eq!(answer.status, 302);
        assert_eq!(
            answer.headers["location"],
            "https://public.am.files.1drv.com/y4m"
        );
        for name in ["Host", "cookie", "Content-Length", "transfer-encoding"] {
            let headers = BTreeMap::from([(name.to_string(), "x".to_string())]);
            assert!(send("GET", &uri, &headers, Vec::new())
                .unwrap_err()
                .starts_with("E_ARGS"));
        }
        assert!(send("TRACE", &uri, &BTreeMap::new(), Vec::new())
            .unwrap_err()
            .starts_with("E_ARGS"));
    }

    /// The system's own keychain keeps, gives back and forgets a token. Run
    /// by hand (`cargo test --lib keychain -- --ignored`): it writes to the
    /// login keychain of whoever runs it.
    #[test]
    #[ignore]
    fn the_system_keychain_keeps_a_token() {
        let store = Keychain;
        store.delete(Provider::GoogleDrive).unwrap();
        assert_eq!(store.get(Provider::GoogleDrive).unwrap(), None);
        store.set(Provider::GoogleDrive, "test-token-ع").unwrap();
        assert_eq!(
            store.get(Provider::GoogleDrive).unwrap().as_deref(),
            Some("test-token-ع")
        );
        store.delete(Provider::GoogleDrive).unwrap();
        assert_eq!(store.get(Provider::GoogleDrive).unwrap(), None);
    }
}
