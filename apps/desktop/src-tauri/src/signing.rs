//! Digital signatures, the parts only the desktop can do.
//!
//! * `net_exchange`: one HTTP request to a timestamp authority or a
//!   certificate status responder, on the person's click. A browser page
//!   cannot read their answers (none of them sends CORS headers), and the
//!   desktop's webview is a browser page — so the request is made here, in
//!   Rust, and only the answer's bytes go back. Nothing else in the app
//!   touches the network.
//! * `pkcs11_certificates` / `pkcs11_sign`: smart cards and tokens through
//!   a PKCS#11 module the person names (OpenSC's, a vendor's). The key never
//!   leaves the card: `warraq_sign` hands [`TokenSigner`] the digest of the
//!   signed attributes, and the card signs it.
//!
//! What is tested here without a card: the HTTP exchange (against a local
//! server) and the signer's encodings. Signing on a real card is not — see
//! docs/STATUS.md.
use std::net::{IpAddr, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::time::Duration;

use cryptoki::context::{CInitializeArgs, CInitializeFlags, Pkcs11};
use cryptoki::error::{Error as TokenError, RvError};
use cryptoki::mechanism::rsa::{PkcsMgfType, PkcsPssParams};
use cryptoki::mechanism::{Mechanism, MechanismType};
use cryptoki::object::{Attribute, AttributeType, CertificateType, ObjectClass, ObjectHandle};
use cryptoki::session::{Session, UserType};
use cryptoki::types::AuthPin;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Runtime};
use tauri_plugin_fs::FsExt;
use warraq_sign::chain::Cert;
use warraq_sign::keys::{KeyKind, Padding, Signer};
use warraq_sign::HashAlg;

use crate::core_bridge::{debug_log, decode_frame, encode_frame};

/// The largest answer taken from a server: OCSP answers and timestamp tokens
/// are a few kilobytes, a large CA's revocation list some megabytes.
const MAX_ANSWER: u64 = 16 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(20);
/// Redirects followed, each to an address checked as the first was.
const MAX_REDIRECTS: usize = 3;

fn header(request: &Request<'_>, name: &str) -> Option<String> {
    request
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
}

/// `%XX` decoding, for the header values the interface percent-encodes.
fn percent_decoded(text: &str) -> Result<String, String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 3 <= bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).map_err(|e| e.to_string())?;
            let byte = u8::from_str_radix(hex, 16)
                .map_err(|_| "E_ARGS: bad percent-encoding".to_string())?;
            out.push(byte);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "E_ARGS: not UTF-8".to_string())
}

fn hex_decoded(text: &str) -> Result<String, String> {
    if !text.len().is_multiple_of(2) {
        return Err("E_ARGS: bad hex".into());
    }
    let bytes = (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16))
        .collect::<Result<Vec<u8>, _>>()
        .map_err(|_| "E_ARGS: bad hex".to_string())?;
    String::from_utf8(bytes).map_err(|_| "E_ARGS: not UTF-8".to_string())
}

/// Only plain web addresses: no files, no other schemes.
fn checked_url(url: &str) -> Result<&str, String> {
    let lower = url.to_ascii_lowercase();
    if (lower.starts_with("http://") || lower.starts_with("https://"))
        && url.len() > 8
        && !url.contains(char::is_whitespace)
    {
        Ok(url)
    } else {
        Err(format!("E_NET: not a web address: {url}"))
    }
}

/// Whether `ip` is on the open internet: not this machine, the local
/// network, a link-local or carrier-grade NAT range, nor unspecified.
fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            !(v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_multicast()
                || a == 0
                || (a == 100 && (64..128).contains(&b)))
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return public_ip(IpAddr::V4(v4));
            }
            let first = v6.segments()[0];
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || first & 0xfe00 == 0xfc00
                || first & 0xffc0 == 0xfe80)
        }
    }
}

/// Refuses an address whose host is, or resolves to, anything but the open
/// internet. The status and issuer addresses come from the PDF being
/// checked, which must not make the app reach the person's router or a
/// service on their own machine.
fn checked_host(url: &str) -> Result<(), String> {
    let parsed = tauri::Url::parse(url).map_err(|_| format!("E_NET: not a web address: {url}"))?;
    let host = parsed
        .host_str()
        .map(|h| h.trim_start_matches('[').trim_end_matches(']'))
        .ok_or_else(|| format!("E_NET: not a web address: {url}"))?;
    let port = parsed.port_or_known_default().unwrap_or(80);
    let addresses: Vec<IpAddr> = match host.parse::<IpAddr>() {
        Ok(ip) => vec![ip],
        Err(_) => (host, port)
            .to_socket_addrs()
            .map_err(|e| format!("E_NET: {host}: {e}"))?
            .map(|a| a.ip())
            .collect(),
    };
    if addresses.is_empty() || !addresses.into_iter().all(public_ip) {
        return Err(format!("E_NET_LOCAL: {host} is not on the open internet"));
    }
    Ok(())
}

/// POSTs `body` (when there is one, as `content_type`) or GETs `url`, and
/// answers the response's bytes. A status other than 2xx is an error. Only
/// a host on the open internet is asked, and each redirect is checked again.
pub fn exchange(url: &str, body: &[u8], content_type: Option<&str>) -> Result<Vec<u8>, String> {
    let mut url = checked_url(url)?.to_string();
    for _ in 0..=MAX_REDIRECTS {
        checked_host(&url)?;
        match fetch(&url, body, content_type)? {
            Fetched::Body(bytes) => return Ok(bytes),
            Fetched::Moved(to) => url = checked_url(&to)?.to_string(),
        }
    }
    Err("E_NET: too many redirects".into())
}

/// What one request answered: the body, or where it was sent on to.
enum Fetched {
    Body(Vec<u8>),
    Moved(String),
}

/// One request to `url`, redirects not followed. A redirect's target is
/// made absolute against `url`.
fn fetch(url: &str, body: &[u8], content_type: Option<&str>) -> Result<Fetched, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(TIMEOUT))
        .max_redirects(0)
        .user_agent("Warraq")
        .build()
        .into();
    let result = if body.is_empty() {
        agent.get(url).call()
    } else {
        agent
            .post(url)
            .header(
                "Content-Type",
                content_type.unwrap_or("application/octet-stream"),
            )
            .send(body)
    };
    let mut response = result.map_err(|e| format!("E_NET: {e}"))?;
    let status = response.status();
    if status.is_redirection() {
        let location = response
            .headers()
            .get("location")
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| format!("E_NET: {status} without a location"))?;
        let to = tauri::Url::parse(url)
            .and_then(|base| base.join(location))
            .map_err(|_| format!("E_NET: a bad redirect: {location}"))?;
        return Ok(Fetched::Moved(to.to_string()));
    }
    if !status.is_success() {
        return Err(format!("E_NET: {status}"));
    }
    response
        .body_mut()
        .with_config()
        .limit(MAX_ANSWER)
        .read_to_vec()
        .map(Fetched::Body)
        .map_err(|e| format!("E_NET: {e}"))
}

/// One request for the interface: `x-warraq-url` (percent-encoded), an
/// optional `x-warraq-content-type`, and the body raw.
#[tauri::command(async)]
pub fn net_exchange(request: Request<'_>) -> Result<Response, String> {
    let url = percent_decoded(&header(&request, "x-warraq-url").ok_or("E_ARGS: no URL")?)?;
    let content_type = header(&request, "x-warraq-content-type");
    let body = match request.body() {
        InvokeBody::Raw(bytes) => bytes.clone(),
        InvokeBody::Json(_) => Vec::new(),
    };
    debug_log(format!(
        "net: {} {url} ({} bytes)",
        if body.is_empty() { "GET" } else { "POST" },
        body.len()
    ));
    let answer = exchange(&url, &body, content_type.as_deref())?;
    debug_log(format!("net: {} bytes back from {url}", answer.len()));
    Ok(Response::new(answer))
}

/* ---------------------------------------------------------------- PKCS#11 */

fn token_err(e: TokenError) -> String {
    match e {
        TokenError::Pkcs11(
            RvError::PinIncorrect | RvError::PinLocked | RvError::PinInvalid | RvError::PinLenRange,
            _,
        ) => {
            format!("E_PKCS11_PIN: {e}")
        }
        // A key that wants the PIN again for its signature (see `pkcs11_sign`).
        TokenError::Pkcs11(RvError::UserNotLoggedIn, _) => format!("E_PKCS11_LOGIN: {e}"),
        other => format!("E_PKCS11: {other}"),
    }
}

/// Folders a PKCS#11 module is looked for in when only its file name is
/// given (`opensc-pkcs11.so`).
fn module_folders() -> Vec<PathBuf> {
    let mut folders: Vec<PathBuf> = Vec::new();
    if cfg!(target_os = "windows") {
        if let Some(system) = std::env::var_os("SystemRoot") {
            folders.push(PathBuf::from(system).join("System32"));
        }
    } else if cfg!(target_os = "macos") {
        for folder in ["/Library/OpenSC/lib", "/usr/local/lib", "/opt/homebrew/lib"] {
            folders.push(folder.into());
        }
    } else {
        for folder in [
            "/usr/lib",
            "/usr/lib64",
            "/usr/local/lib",
            "/usr/lib/pkcs11",
            "/usr/lib64/pkcs11",
            "/usr/lib/x86_64-linux-gnu",
            "/usr/lib/x86_64-linux-gnu/pkcs11",
            "/usr/lib/aarch64-linux-gnu",
            "/usr/lib/aarch64-linux-gnu/pkcs11",
        ] {
            folders.push(folder.into());
        }
    }
    folders
}

/// Where system-wide software is installed, which a module named by its
/// full path must be under (unless the person chose it in the dialog).
fn module_roots() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if cfg!(target_os = "windows") {
        for name in ["SystemRoot", "ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(root) = std::env::var_os(name) {
                roots.push(root.into());
            }
        }
    } else if cfg!(target_os = "macos") {
        for root in [
            "/usr/lib",
            "/usr/local/lib",
            "/Library",
            "/opt/homebrew/lib",
            "/opt/local/lib",
        ] {
            roots.push(root.into());
        }
    } else {
        for root in ["/usr/lib", "/usr/lib64", "/usr/local/lib", "/lib", "/lib64", "/opt"] {
            roots.push(root.into());
        }
    }
    // Compared with the module's real path, so these are made real too.
    roots
        .into_iter()
        .filter_map(|root| std::fs::canonicalize(root).ok())
        .collect()
}

/// The module the interface named, if the app may load it: a native library
/// runs with the app's rights, so only a file the person chose in the
/// dialog (`allowed`), one under where system software is installed, or a
/// bare file name found in a standard module folder is taken.
fn module_path(path: &str, allowed: impl Fn(&Path) -> bool) -> Result<PathBuf, String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("E_PKCS11: no module".into());
    }
    let named = Path::new(path);
    let is_library = |p: &Path| {
        p.extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| ["so", "dylib", "dll"].contains(&e.to_ascii_lowercase().as_str()))
            || p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.contains(".so."))
    };
    let refused = || format!("E_PKCS11_MODULE: {path} is not a module the app may load");
    if !is_library(named) {
        return Err(refused());
    }
    if named.components().count() == 1 {
        return module_folders()
            .into_iter()
            .map(|folder| folder.join(named))
            .find(|candidate| candidate.is_file())
            .ok_or_else(refused);
    }
    if !named.is_absolute() {
        return Err(refused());
    }
    let real = std::fs::canonicalize(named).map_err(|e| format!("E_PKCS11: {path}: {e}"))?;
    if allowed(named) || allowed(&real) || module_roots().iter().any(|root| real.starts_with(root))
    {
        Ok(real)
    } else {
        Err(refused())
    }
}

/// The module loaded and initialised; `path` comes from `module_path`.
fn module(path: &Path) -> Result<Pkcs11, String> {
    let pkcs11 = Pkcs11::new(path).map_err(token_err)?;
    match pkcs11.initialize(CInitializeArgs::new(CInitializeFlags::OS_LOCKING_OK)) {
        Ok(()) | Err(TokenError::Pkcs11(RvError::CryptokiAlreadyInitialized, _)) => Ok(pkcs11),
        Err(e) => Err(token_err(e)),
    }
}

fn login(session: &Session, pin: &str) -> Result<(), String> {
    match session.login(UserType::User, Some(&AuthPin::from(pin.to_string()))) {
        Ok(()) | Err(TokenError::Pkcs11(RvError::UserAlreadyLoggedIn, _)) => Ok(()),
        Err(e) => Err(token_err(e)),
    }
}

/// A certificate on a token: its `CKA_ID`, its label and its DER.
type TokenCert = (Vec<u8>, String, Vec<u8>);

/// Every X.509 certificate on a session's token, with its id and label.
fn certificates(session: &Session) -> Result<Vec<TokenCert>, String> {
    let handles = session
        .find_objects(&[
            Attribute::Class(ObjectClass::CERTIFICATE),
            Attribute::CertificateType(CertificateType::X_509),
        ])
        .map_err(token_err)?;
    let mut out = Vec::new();
    for handle in handles.into_iter().take(256) {
        let attrs = session
            .get_attributes(
                handle,
                &[
                    AttributeType::Id,
                    AttributeType::Label,
                    AttributeType::Value,
                ],
            )
            .map_err(token_err)?;
        let (mut id, mut label, mut value) = (Vec::new(), String::new(), Vec::new());
        for a in attrs {
            match a {
                Attribute::Id(v) => id = v,
                Attribute::Label(v) => label = String::from_utf8_lossy(&v).into_owned(),
                Attribute::Value(v) => value = v,
                _ => {}
            }
        }
        if !value.is_empty() {
            out.push((id, label, value));
        }
    }
    Ok(out)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Which slots' certificates to read, and whether to log in first: none —
/// certificates are public objects — unless nothing is listed without and
/// there is exactly one token, the only one the PIN can be for. A PIN tried
/// on every slot burnt a retry on each slot with a PIN of its own
/// (authentication and signing, on one card) and listed nothing when the
/// first refused it.
fn login_to_list(listed_without: usize, tokens: usize, pin: &str) -> bool {
    listed_without == 0 && tokens == 1 && !pin.is_empty()
}

/// The certificates on every token the module sees.
#[tauri::command(async)]
pub fn pkcs11_certificates<R: Runtime>(
    app: AppHandle<R>,
    request: Request<'_>,
) -> Result<String, String> {
    let path = percent_decoded(&header(&request, "x-warraq-module").ok_or("E_ARGS: no module")?)?;
    let scope = app.fs_scope();
    let path = module_path(&path, |p| scope.is_allowed(p))?;
    let pin = hex_decoded(&header(&request, "x-warraq-pin-hex").unwrap_or_default())?;
    let pkcs11 = module(&path)?;
    let slots = pkcs11.get_slots_with_token().map_err(token_err)?;
    let mut found: Vec<(u64, TokenCert)> = Vec::new();
    for slot in &slots {
        let session = pkcs11.open_ro_session(*slot).map_err(token_err)?;
        for cert in certificates(&session)? {
            found.push((slot.id(), cert));
        }
    }
    if let (true, Some(slot)) = (login_to_list(found.len(), slots.len(), &pin), slots.first()) {
        let session = pkcs11.open_ro_session(*slot).map_err(token_err)?;
        login(&session, &pin)?;
        for cert in certificates(&session)? {
            found.push((slot.id(), cert));
        }
    }
    let mut listed = Vec::new();
    for (slot, (id, label, der)) in found {
        let Ok(cert) = Cert::parse(&der) else {
            continue;
        };
        listed.push(serde_json::json!({
            "slot": slot,
            "id": hex(&id),
            "label": label,
            "name": cert.common_name(),
            "issuer": cert.issuer_name(),
            "notAfter": warraq_sign::time::iso(cert.not_after()),
        }));
    }
    debug_log(format!("pkcs11: {} certificate(s) in {}", listed.len(), path.display()));
    serde_json::to_string(&listed).map_err(|e| e.to_string())
}

/// The DER `DigestInfo` prefix a raw RSA PKCS#1 v1.5 signature (`CKM_RSA_PKCS`)
/// is made over: the token pads, the prefix names the digest.
fn digest_info(hash: HashAlg, digest: &[u8]) -> Vec<u8> {
    let prefix: &[u8] = match hash {
        HashAlg::Sha1 => &[
            0x30, 0x21, 0x30, 0x09, 0x06, 0x05, 0x2b, 0x0e, 0x03, 0x02, 0x1a, 0x05, 0x00, 0x04,
            0x14,
        ],
        HashAlg::Sha256 => &[
            0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02,
            0x01, 0x05, 0x00, 0x04, 0x20,
        ],
        HashAlg::Sha384 => &[
            0x30, 0x41, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02,
            0x02, 0x05, 0x00, 0x04, 0x30,
        ],
        HashAlg::Sha512 => &[
            0x30, 0x51, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02,
            0x03, 0x05, 0x00, 0x04, 0x40,
        ],
    };
    [prefix, digest].concat()
}

/// A raw ECDSA signature (`r ‖ s`, as PKCS#11 returns it) as the DER
/// `Ecdsa-Sig-Value` CMS carries.
fn ecdsa_der(raw: &[u8]) -> Result<Vec<u8>, String> {
    if raw.is_empty() || !raw.len().is_multiple_of(2) {
        return Err("E_PKCS11: odd ECDSA signature".into());
    }
    let integer = |bytes: &[u8]| {
        let trimmed: Vec<u8> = bytes.iter().copied().skip_while(|b| *b == 0).collect();
        let mut v = if trimmed.first().is_some_and(|b| b & 0x80 != 0) || trimmed.is_empty() {
            [vec![0], trimmed].concat()
        } else {
            trimmed
        };
        let mut out = vec![0x02, v.len() as u8];
        out.append(&mut v);
        out
    };
    let (r, s) = raw.split_at(raw.len() / 2);
    let body = [integer(r), integer(s)].concat();
    let mut out = vec![0x30];
    if body.len() >= 0x80 {
        out.push(0x81);
    }
    out.push(body.len() as u8);
    out.extend(body);
    Ok(out)
}

/// How a signature is asked of a card: the mechanism, and what is signed.
pub fn token_request(
    kind: KeyKind,
    digest: &[u8],
    hash: HashAlg,
    padding: Padding,
) -> (Mechanism<'static>, Vec<u8>) {
    match (kind, padding) {
        (KeyKind::Rsa { .. }, Padding::Pss) => {
            let (hash_alg, mgf) = match hash {
                HashAlg::Sha384 => (MechanismType::SHA384, PkcsMgfType::MGF1_SHA384),
                HashAlg::Sha512 => (MechanismType::SHA512, PkcsMgfType::MGF1_SHA512),
                _ => (MechanismType::SHA256, PkcsMgfType::MGF1_SHA256),
            };
            (
                Mechanism::RsaPkcsPss(PkcsPssParams {
                    hash_alg,
                    mgf,
                    // A PKCS#11 length is the platform's `unsigned long`:
                    // 64 bits on macOS and Linux, 32 on Windows, where a
                    // `u64` does not convert. A digest's length fits both.
                    s_len: (hash.len() as std::ffi::c_ulong).into(),
                }),
                digest.to_vec(),
            )
        }
        (KeyKind::Rsa { .. }, Padding::Pkcs1v15) => (Mechanism::RsaPkcs, digest_info(hash, digest)),
        _ => (Mechanism::Ecdsa, digest.to_vec()),
    }
}

/// The key on a card, as `warraq_sign` asks things of a signer.
pub struct TokenSigner<'a> {
    session: &'a Session,
    key: ObjectHandle,
    cert: Vec<u8>,
    chain: Vec<Vec<u8>>,
    kind: KeyKind,
}

impl Signer for TokenSigner<'_> {
    fn certificate(&self) -> &[u8] {
        &self.cert
    }
    fn chain(&self) -> &[Vec<u8>] {
        &self.chain
    }
    fn key_kind(&self) -> KeyKind {
        self.kind
    }
    fn sign_digest(
        &self,
        digest: &[u8],
        hash: HashAlg,
        padding: Padding,
    ) -> warraq_sign::Result<Vec<u8>> {
        let (mechanism, data) = token_request(self.kind, digest, hash, padding);
        let signed = self
            .session
            .sign(&mechanism, self.key, &data)
            .map_err(|e| warraq_sign::SignError::Sign(token_err(e)))?;
        match self.kind {
            KeyKind::Rsa { .. } => Ok(signed),
            _ => ecdsa_der(&signed).map_err(warraq_sign::SignError::Sign),
        }
    }
}

/// Signs on the card: `x-warraq-module`, `x-warraq-pin-hex`, `x-warraq-slot`
/// and `x-warraq-key-id` say where; the body is the frame `signatures.sign`
/// takes, less the certificate file; the answer is its frame.
#[tauri::command(async)]
pub fn pkcs11_sign<R: Runtime>(
    app: AppHandle<R>,
    request: Request<'_>,
) -> Result<Response, String> {
    let path = percent_decoded(&header(&request, "x-warraq-module").ok_or("E_ARGS: no module")?)?;
    let scope = app.fs_scope();
    let path = module_path(&path, |p| scope.is_allowed(p))?;
    let pin = hex_decoded(&header(&request, "x-warraq-pin-hex").unwrap_or_default())?;
    let slot_id: u64 = header(&request, "x-warraq-slot")
        .and_then(|s| s.parse().ok())
        .ok_or("E_ARGS: no slot")?;
    let key_id = header(&request, "x-warraq-key-id").unwrap_or_default();
    let (args, blobs) = match request.body() {
        InvokeBody::Raw(bytes) => decode_frame(bytes)?,
        InvokeBody::Json(_) => return Err("E_ARGS: pkcs11_sign expects a raw frame".into()),
    };
    let pkcs11 = module(&path)?;
    let slot = pkcs11
        .get_slots_with_token()
        .map_err(token_err)?
        .into_iter()
        .find(|s| s.id() == slot_id)
        .ok_or("E_PKCS11: the card is no longer there")?;
    let session = pkcs11.open_ro_session(slot).map_err(token_err)?;
    login(&session, &pin)?;
    let certs = certificates(&session)?;
    let (id, _, der) = certs
        .iter()
        .find(|(id, _, _)| hex(id) == key_id)
        .cloned()
        .ok_or("E_PKCS11: the certificate is no longer on the card")?;
    let key = session
        .find_objects(&[
            Attribute::Class(ObjectClass::PRIVATE_KEY),
            Attribute::Id(id),
        ])
        .map_err(token_err)?
        .into_iter()
        .next()
        .ok_or("E_PKCS11: no private key beside that certificate")?;
    // A key that asks for the PIN again for every signature
    // (CKA_ALWAYS_AUTHENTICATE: a PIV card's signing key, many national eID
    // qualified keys) needs a context-specific login between C_SignInit and
    // C_Sign, which the PKCS#11 binding does not expose for one-part
    // signing. Said plainly, rather than failing at C_Sign as if the card
    // were not there.
    let asks_again = session
        .get_attributes(key, &[AttributeType::AlwaysAuthenticate])
        .ok()
        .is_some_and(|attrs| attrs.contains(&Attribute::AlwaysAuthenticate(true)));
    if asks_again {
        return Err("E_PKCS11_LOGIN: the key asks for the PIN for each signature".into());
    }
    let cert = Cert::parse(&der).map_err(|e| e.to_string())?;
    // The other certificates on the card, nearest first: often its CA's.
    let others: Vec<Vec<u8>> = certs
        .into_iter()
        .map(|(_, _, d)| d)
        .filter(|d| *d != der)
        .collect();
    let signer = TokenSigner {
        session: &session,
        key,
        kind: cert
            .key_kind()
            .ok_or("E_PKCS11: the card's key is not RSA, P-256 or P-384")?,
        chain: warraq_sign::chain::order_above(&der, others),
        cert: der,
    };
    let reply = warraq_core::tools::signatures::sign_with(&args, blobs, &signer)
        .map_err(|e| e.to_string())?;
    debug_log(format!("pkcs11: signed with {}", cert.common_name()));
    Ok(Response::new(encode_frame(&reply.json, &reply.blobs)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[test]
    fn only_web_addresses_are_fetched() {
        assert!(checked_url("http://timestamp.digicert.com").is_ok());
        assert!(checked_url("https://freetsa.org/tsr").is_ok());
        assert!(checked_url("file:///etc/passwd").is_err());
        assert!(checked_url("javascript:alert(1)").is_err());
        assert!(checked_url("http://a b").is_err());
        assert_eq!(
            percent_decoded("http%3A%2F%2Fexample.test%2F%D8%B9").unwrap(),
            "http://example.test/ع"
        );
        assert_eq!(hex_decoded("d8b9").unwrap(), "ع");
    }

    /// A local server stands in for a timestamp authority: the request's
    /// body and content type arrive as sent, and the answer comes back whole.
    #[test]
    fn a_post_reaches_the_server_and_its_answer_comes_back() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut seen = Vec::new();
            let mut buf = [0u8; 4096];
            loop {
                let n = stream.read(&mut buf).unwrap();
                seen.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&seen);
                if let Some(end) = text.find("\r\n\r\n") {
                    let length: usize = text
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse().unwrap())
                        })
                        .unwrap_or(0);
                    if seen.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            let answer = b"\x30\x03\x02\x01\x00";
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/timestamp-reply\r\nContent-Length: {}\r\n\r\n", answer.len()).unwrap();
            stream.write_all(answer).unwrap();
            String::from_utf8_lossy(&seen).into_owned()
        });
        // `fetch`, not `exchange`: the local server is on this machine,
        // which `exchange` refuses.
        let Fetched::Body(answer) = fetch(
            &format!("http://127.0.0.1:{port}/tsr"),
            b"digest",
            Some("application/timestamp-query"),
        )
        .unwrap() else {
            panic!("not a body");
        };
        assert_eq!(answer, b"\x30\x03\x02\x01\x00");
        let request = server.join().unwrap();
        assert!(request.starts_with("POST /tsr "), "{request}");
        assert!(request
            .to_ascii_lowercase()
            .contains("content-type: application/timestamp-query"));
        assert!(request.ends_with("digest"));
    }

    #[test]
    fn an_unreachable_server_is_an_error_not_a_hang() {
        // Port 9 (discard) on this machine is closed.
        let e = fetch("http://127.0.0.1:9/ocsp", b"", None).err().unwrap();
        assert!(e.starts_with("E_NET"), "{e}");
    }

    #[test]
    fn only_a_module_the_app_may_load_is_loaded() {
        let refused = |path: &str| {
            module_path(path, |_| false)
                .unwrap_err()
                .starts_with("E_PKCS11")
        };
        assert!(refused(""));
        assert!(refused("evil.txt"));
        assert!(refused("relative/dir/opensc-pkcs11.so"));
        assert!(refused("no-such-module-anywhere.so"));
        // A library the person did not choose, outside system folders.
        let dir = std::env::temp_dir().join(format!("warraq-pkcs11-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let module = dir.join("planted.so");
        std::fs::write(&module, b"not a library").unwrap();
        let text = module.to_string_lossy().into_owned();
        assert!(module_path(&text, |_| false)
            .unwrap_err()
            .starts_with("E_PKCS11_MODULE"));
        // The same file, chosen in the dialog.
        assert!(module_path(&text, |p| p == module.as_path()).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_hosts_on_the_open_internet_are_asked() {
        for local in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "100.127.255.255",
            "0.0.0.0",
            "::1",
            "::",
            "fc00::1",
            "fd12:3456::1",
            "fe80::1",
            "::ffff:127.0.0.1",
            "::ffff:192.168.0.1",
        ] {
            assert!(!public_ip(local.parse().unwrap()), "{local}");
        }
        for public in ["8.8.8.8", "1.1.1.1", "100.128.0.1", "172.32.0.1", "2606:4700::1111"] {
            assert!(public_ip(public.parse().unwrap()), "{public}");
        }
        for url in [
            "http://127.0.0.1:9/ocsp",
            "http://localhost/crl",
            "http://[::1]/ocsp",
            "http://169.254.169.254/latest/meta-data",
            "http://2130706433/",
        ] {
            let e = exchange(url, b"", None).unwrap_err();
            assert!(e.starts_with("E_NET_LOCAL"), "{url}: {e}");
        }
    }

    /// The card is asked for exactly what a software key would sign: checked
    /// by verifying, with the certificate's key, what the encodings produce
    /// when a software key plays the card.
    #[test]
    fn what_the_card_is_asked_matches_what_a_software_key_signs() {
        let digest = HashAlg::Sha256.digest(b"signed attributes");
        let (m, data) = token_request(
            KeyKind::Rsa { bits: 2048 },
            &digest,
            HashAlg::Sha256,
            Padding::Pkcs1v15,
        );
        assert!(matches!(m, Mechanism::RsaPkcs));
        assert_eq!(data.len(), 19 + 32);
        assert!(data.ends_with(&digest));
        let (m, data) = token_request(KeyKind::P256, &digest, HashAlg::Sha256, Padding::Pkcs1v15);
        assert!(matches!(m, Mechanism::Ecdsa));
        assert_eq!(data, digest);
        assert!(matches!(
            token_request(
                KeyKind::Rsa { bits: 2048 },
                &digest,
                HashAlg::Sha256,
                Padding::Pss
            )
            .0,
            Mechanism::RsaPkcsPss(_)
        ));
        // r ‖ s from a card, re-encoded: a SEQUENCE of two positive INTEGERs.
        let mut raw = vec![0x80u8; 32];
        raw.extend(vec![0x00u8, 0x01]);
        raw.extend(vec![0x01u8; 30]);
        let der = ecdsa_der(&raw).unwrap();
        let (seq, rest) = warraq_sign::asn1::read(&der).unwrap();
        assert!(rest.is_empty() && seq.tag == 0x30);
        let ints = warraq_sign::asn1::children(seq.value).unwrap();
        assert_eq!(ints.len(), 2);
        assert_eq!(ints[0].value.len(), 33, "a leading zero keeps r positive");
        assert_eq!(ints[1].value.len(), 31, "s loses its leading zero");
    }

    /// The whole desktop path with a real authority on the internet:
    /// sign, send the request, finish with the answer, verify. Needs the
    /// network, so it runs only when asked:
    /// `cargo test --lib real_timestamp -- --ignored`.
    #[test]
    #[ignore = "reaches a public timestamp authority"]
    fn a_real_timestamp_authority_stamps_a_signature() {
        let fixtures = format!(
            "{}/../../../tests/fixtures/signatures",
            env!("CARGO_MANIFEST_DIR")
        );
        let p12 = std::fs::read(format!("{fixtures}/signer-rsa-aes.p12")).unwrap();
        let pdf = std::fs::read(format!(
            "{}/../../../tests/corpus/arabic/generated/chrome-cairo-mixed-invoice.pdf",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let signed = warraq_core::call_static(
            "signatures.sign",
            &format!(r#"{{"p12Password":"warraq-test","time":{now},"timestamp":true}}"#),
            vec![pdf, p12],
        )
        .unwrap();
        let request = signed.blobs[2].clone();
        for url in [
            "http://timestamp.digicert.com",
            "https://timestamp.sectigo.com",
        ] {
            let answer = exchange(url, &request, Some("application/timestamp-query")).unwrap();
            let done = warraq_core::call_static(
                "signatures.finish",
                "{}",
                vec![
                    signed.blobs[0].clone(),
                    signed.blobs[1].clone(),
                    request.clone(),
                    answer,
                ],
            )
            .unwrap();
            let root = std::fs::read(format!("{fixtures}/root-rsa.cer")).unwrap();
            let verified = warraq_core::call_static(
                "signatures.verify",
                &format!(r#"{{"now":{}}}"#, now + 60),
                vec![done.blobs[0].clone(), root],
            )
            .unwrap();
            eprintln!("{url}: {}", verified.json);
            assert!(verified.json.contains(r#""status":"valid""#), "{url}");
            assert!(
                verified.json.contains(r#""timestamp":{"#)
                    && verified.json.contains(r#""valid":true"#),
                "{url}"
            );

            // Long-term validation against the authority's real responders:
            // its certificates carry OCSP addresses that answer.
            let plan = warraq_core::call_static(
                "signatures.fetches",
                &format!(r#"{{"now":{now}}}"#),
                vec![done.blobs[0].clone()],
            )
            .unwrap();
            let fetches: serde_json::Value = serde_json::from_str(&plan.json).unwrap();
            let mut kinds = Vec::new();
            let mut blobs = vec![done.blobs[0].clone()];
            for (i, f) in fetches["fetches"].as_array().unwrap().iter().enumerate() {
                let kind = f["kind"].as_str().unwrap();
                let content_type = (kind == "ocsp").then_some("application/ocsp-request");
                match exchange(f["url"].as_str().unwrap(), &plan.blobs[i], content_type) {
                    Ok(answer) => {
                        kinds.push(kind.to_string());
                        blobs.push(answer);
                    }
                    Err(e) => eprintln!("{}: {e}", f["url"]),
                }
            }
            let added = warraq_core::call_static(
                "signatures.add_validation",
                &serde_json::json!({ "now": now, "kinds": kinds }).to_string(),
                blobs,
            )
            .unwrap();
            eprintln!("{url} LTV: {} over {:?}", added.json, fetches["fetches"]);
            let counts: serde_json::Value = serde_json::from_str(&added.json).unwrap();
            if url.contains("digicert") {
                assert!(
                    counts["ocsps"].as_u64().unwrap() > 0,
                    "{url}: {}",
                    added.json
                );
            }
        }
    }

    #[test]
    fn listing_a_card_tries_the_pin_nowhere_it_could_be_wrong() {
        assert!(
            !login_to_list(2, 1, "1234"),
            "certificates were found without it"
        );
        assert!(!login_to_list(0, 2, "1234"), "two tokens: whose PIN is it?");
        assert!(!login_to_list(0, 1, ""), "no PIN given");
        assert!(login_to_list(0, 1, "1234"));
        // A key that wants its PIN again is said to, not taken for a missing card.
        let again = token_err(TokenError::Pkcs11(
            RvError::UserNotLoggedIn,
            cryptoki::context::Function::Sign,
        ));
        assert!(again.starts_with("E_PKCS11_LOGIN"), "{again}");
    }

    /// A software key playing the card, through the very path a card's
    /// signature takes (`TokenSigner` minus the session): the result is a
    /// signature the verifier accepts.
    #[test]
    fn a_pdf_signed_through_the_signer_trait_verifies() {
        let fixtures = format!(
            "{}/../../../tests/fixtures/signatures",
            env!("CARGO_MANIFEST_DIR")
        );
        let p12 = std::fs::read(format!("{fixtures}/signer-ec.p12")).unwrap();
        let id = warraq_sign::pkcs12::open(&p12, "warraq-test").unwrap();
        let pdf = std::fs::read(format!(
            "{}/../../../tests/corpus/arabic/generated/chrome-cairo-mixed-invoice.pdf",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap();
        let reply = warraq_core::tools::signatures::sign_with(
            r#"{"time":1789837200}"#,
            vec![pdf],
            &id.signer,
        )
        .unwrap();
        let root = std::fs::read(format!("{fixtures}/root-ec.cer")).unwrap();
        let verified = warraq_core::call_static(
            "signatures.verify",
            r#"{"now":1789837260}"#,
            vec![reply.blobs[0].clone(), root],
        )
        .unwrap();
        assert!(
            verified.json.contains(r#""status":"valid""#),
            "{}",
            verified.json
        );
    }
}
