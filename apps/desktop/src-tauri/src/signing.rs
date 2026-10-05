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
use std::time::Duration;

use cryptoki::context::{CInitializeArgs, CInitializeFlags, Pkcs11};
use cryptoki::error::{Error as TokenError, RvError};
use cryptoki::mechanism::rsa::{PkcsMgfType, PkcsPssParams};
use cryptoki::mechanism::{Mechanism, MechanismType};
use cryptoki::object::{Attribute, AttributeType, CertificateType, ObjectClass, ObjectHandle};
use cryptoki::session::{Session, UserType};
use cryptoki::types::AuthPin;
use tauri::ipc::{InvokeBody, Request, Response};
use warraq_sign::chain::Cert;
use warraq_sign::keys::{KeyKind, Padding, Signer};
use warraq_sign::HashAlg;

use crate::core_bridge::{debug_log, decode_frame, encode_frame};

/// The largest answer taken from a server: OCSP answers and timestamp tokens
/// are a few kilobytes, a large CA's revocation list some megabytes.
const MAX_ANSWER: u64 = 16 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(20);

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

/// POSTs `body` (when there is one, as `content_type`) or GETs `url`, and
/// answers the response's bytes. A status other than 2xx is an error.
pub fn exchange(url: &str, body: &[u8], content_type: Option<&str>) -> Result<Vec<u8>, String> {
    let url = checked_url(url)?;
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(TIMEOUT))
        .max_redirects(3)
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
    response
        .body_mut()
        .with_config()
        .limit(MAX_ANSWER)
        .read_to_vec()
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

/// The module loaded and initialised.
fn module(path: &str) -> Result<Pkcs11, String> {
    if path.trim().is_empty() {
        return Err("E_PKCS11: no module".into());
    }
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
pub fn pkcs11_certificates(request: Request<'_>) -> Result<String, String> {
    let path = percent_decoded(&header(&request, "x-warraq-module").ok_or("E_ARGS: no module")?)?;
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
    debug_log(format!("pkcs11: {} certificate(s) in {path}", listed.len()));
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
pub fn pkcs11_sign(request: Request<'_>) -> Result<Response, String> {
    let path = percent_decoded(&header(&request, "x-warraq-module").ok_or("E_ARGS: no module")?)?;
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
        let answer = exchange(
            &format!("http://127.0.0.1:{port}/tsr"),
            b"digest",
            Some("application/timestamp-query"),
        )
        .unwrap();
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
        let e = exchange("http://127.0.0.1:9/ocsp", b"", None).unwrap_err();
        assert!(e.starts_with("E_NET"), "{e}");
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
