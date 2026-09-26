//! Network for digital signatures (desktop only, SPEC: "timestamps + LTV desktop only").
//!
//! The engine never does I/O. When the user signs at level B-T/B-LT/B-LTA and clicks Sign, the
//! UI hands this module the DER request the engine produced and the URL the user chose (a
//! timestamp authority from the editable list) or confirmed (OCSP responder / CRL distribution
//! point read from the certificate). Nothing here runs on its own.
//!
//! Rules: `http`/`https` only, no user-info in the URL, no redirects (a redirect would reach a
//! host the user did not choose), a hard timeout and a response size cap, rustls with the
//! operating system's trust store (rustls-platform-verifier) for https.

use std::io::Read;
use std::time::Duration;

/// Timestamp and OCSP replies are a few KiB; 1 MiB is generous.
pub const MAX_REPLY_BYTES: u64 = 1024 * 1024;
/// CRLs of large CAs reach several MiB.
pub const MAX_CRL_BYTES: u64 = 16 * 1024 * 1024;
/// Largest request body accepted from the UI (a TSA or OCSP request is < 1 KiB).
pub const MAX_REQUEST_BYTES: usize = 64 * 1024;
pub const MAX_URL_LEN: usize = 2048;
pub const TIMEOUT: Duration = Duration::from_secs(20);

pub const TSA_REQUEST: &str = "application/timestamp-query";
pub const TSA_REPLY: &str = "application/timestamp-reply";
pub const OCSP_REQUEST: &str = "application/ocsp-request";
pub const OCSP_REPLY: &str = "application/ocsp-response";

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum NetError {
    #[error("only http and https addresses are allowed")]
    Scheme,
    #[error("the address is not valid")]
    BadUrl,
    #[error("the request is too large")]
    RequestTooLarge,
    #[error("the server answered with status {0}")]
    Status(u16),
    #[error("the server's answer is larger than {0} bytes")]
    TooLarge(u64),
    #[error("the server's answer is not a {0}")]
    WrongType(String),
    #[error("network error: {0}")]
    Io(String),
}

/// Checks a user-entered URL: `http(s)://host[:port]/path`, no credentials, no whitespace or
/// control characters, bounded length.
pub fn validate_url(url: &str) -> Result<(), NetError> {
    let u = url.trim();
    if u.is_empty()
        || u.len() > MAX_URL_LEN
        || u.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(NetError::BadUrl);
    }
    let lower = u.to_ascii_lowercase();
    let rest = if let Some(r) = lower.strip_prefix("https://") {
        r
    } else if let Some(r) = lower.strip_prefix("http://") {
        r
    } else {
        return Err(NetError::Scheme);
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() || authority.contains('@') {
        return Err(NetError::BadUrl);
    }
    Ok(())
}

/// HTTP settings (tests turn the environment proxy off to reach their local server).
#[derive(Debug, Clone)]
pub struct HttpConfig {
    pub timeout: Duration,
    pub env_proxy: bool,
}

impl Default for HttpConfig {
    fn default() -> Self {
        HttpConfig {
            timeout: TIMEOUT,
            env_proxy: true,
        }
    }
}

fn agent(cfg: &HttpConfig) -> ureq::Agent {
    use ureq::tls::{RootCerts, TlsConfig, TlsProvider};
    let mut b = ureq::Agent::config_builder()
        .timeout_global(Some(cfg.timeout))
        .max_redirects(0)
        .http_status_as_error(false)
        .user_agent("ZOOD PDF")
        .tls_config(
            TlsConfig::builder()
                .provider(TlsProvider::Rustls)
                .root_certs(RootCerts::PlatformVerifier)
                .build(),
        );
    if !cfg.env_proxy {
        b = b.proxy(None);
    }
    b.build().into()
}

fn read_reply(
    mut resp: ureq::http::Response<ureq::Body>,
    limit: u64,
    expect_type: Option<&str>,
) -> Result<Vec<u8>, NetError> {
    let status = resp.status().as_u16();
    if status != 200 {
        return Err(NetError::Status(status));
    }
    if let Some(want) = expect_type {
        let got = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        // Some responders omit the header; a wrong explicit type (an HTML error page) is refused.
        if !got.is_empty() && !got.starts_with(want) && !got.starts_with("application/octet-stream")
        {
            return Err(NetError::WrongType(want.to_owned()));
        }
    }
    if let Some(len) = resp
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<u64>().ok())
    {
        if len > limit {
            return Err(NetError::TooLarge(limit));
        }
    }
    // Read at most limit + 1 bytes so an over-long body is detected without buffering it all.
    let mut out = Vec::new();
    resp.body_mut()
        .as_reader()
        .take(limit + 1)
        .read_to_end(&mut out)
        .map_err(|e| NetError::Io(e.to_string()))?;
    if out.len() as u64 > limit {
        return Err(NetError::TooLarge(limit));
    }
    Ok(out)
}

/// POSTs a DER request (`content_type`) and returns the reply body.
pub fn post_der(
    url: &str,
    content_type: &str,
    reply_type: &str,
    body: &[u8],
    cfg: &HttpConfig,
) -> Result<Vec<u8>, NetError> {
    validate_url(url)?;
    if body.len() > MAX_REQUEST_BYTES {
        return Err(NetError::RequestTooLarge);
    }
    let resp = agent(cfg)
        .post(url.trim())
        .header("Content-Type", content_type)
        .header("Accept", reply_type)
        .send(body)
        .map_err(|e| NetError::Io(e.to_string()))?;
    read_reply(resp, MAX_REPLY_BYTES, Some(reply_type))
}

/// GETs a CRL (DER or PEM; the engine accepts both).
pub fn get_crl(url: &str, cfg: &HttpConfig) -> Result<Vec<u8>, NetError> {
    validate_url(url)?;
    let resp = agent(cfg)
        .get(url.trim())
        .call()
        .map_err(|e| NetError::Io(e.to_string()))?;
    read_reply(resp, MAX_CRL_BYTES, None)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::path::PathBuf;
    use std::process::Command;

    fn cfg() -> HttpConfig {
        HttpConfig {
            timeout: Duration::from_secs(5),
            env_proxy: false,
        }
    }

    /// One-shot HTTP server on 127.0.0.1: reads one request, hands (head, body) to `answer`,
    /// writes what it returns. Returns the base URL.
    fn serve<F>(answer: F) -> String
    where
        F: FnOnce(&str, Vec<u8>) -> Vec<u8> + Send + 'static,
    {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let Ok((mut s, _)) = l.accept() else { return };
            let mut r = BufReader::new(s.try_clone().unwrap());
            let mut head = String::new();
            let mut len = 0usize;
            loop {
                let mut line = String::new();
                if r.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                    break;
                }
                if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    len = v.trim().parse().unwrap_or(0);
                }
                head.push_str(&line);
            }
            let mut body = vec![0; len];
            r.read_exact(&mut body).unwrap();
            let out = answer(&head, body);
            let _ = s.write_all(&out);
        });
        format!("http://127.0.0.1:{port}")
    }

    fn reply(status: &str, ctype: &str, body: &[u8]) -> Vec<u8> {
        let mut v = format!(
            "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        v.extend_from_slice(body);
        v
    }

    fn pki() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../tests/fixtures/sign/pki")
    }

    fn has_openssl() -> bool {
        Command::new("openssl")
            .arg("version")
            .output()
            .is_ok_and(|o| o.status.success())
    }

    #[test]
    fn urls_are_checked() {
        for ok in [
            "http://timestamp.digicert.com",
            "https://freetsa.org/tsr",
            "http://127.0.0.1:8080/tsa?x=1",
        ] {
            assert_eq!(validate_url(ok), Ok(()), "{ok}");
        }
        assert_eq!(validate_url("ftp://x/"), Err(NetError::Scheme));
        assert_eq!(validate_url("file:///etc/passwd"), Err(NetError::Scheme));
        assert_eq!(validate_url("javascript:alert(1)"), Err(NetError::Scheme));
        assert_eq!(validate_url("http://user:pw@host/"), Err(NetError::BadUrl));
        assert_eq!(validate_url("http:///x"), Err(NetError::BadUrl));
        assert_eq!(validate_url("http://a b/"), Err(NetError::BadUrl));
        assert_eq!(validate_url(""), Err(NetError::BadUrl));
        assert_eq!(
            validate_url(&format!("http://h/{}", "a".repeat(MAX_URL_LEN))),
            Err(NetError::BadUrl)
        );
    }

    /// A local mock TSA answering with `openssl ts -reply` and the engine's test PKI: the
    /// command POSTs `application/timestamp-query` and returns a granted token for our request.
    #[test]
    fn timestamp_request_against_a_local_mock_tsa() {
        if !has_openssl() {
            eprintln!("openssl not found: skipping the mock TSA");
            return;
        }
        let dir = std::env::temp_dir().join(format!("zood-mock-tsa-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("data"), b"signature value").unwrap();
        let q = Command::new("openssl")
            .args(["ts", "-query", "-sha256", "-cert", "-data"])
            .arg(dir.join("data"))
            .arg("-out")
            .arg(dir.join("req.tsq"))
            .output()
            .unwrap();
        assert!(q.status.success(), "{}", String::from_utf8_lossy(&q.stderr));
        let req = std::fs::read(dir.join("req.tsq")).unwrap();

        let d2 = dir.clone();
        let url = serve(move |head, body| {
            assert!(head.starts_with("POST /tsr "), "{head}");
            assert!(
                head.to_ascii_lowercase()
                    .contains("content-type: application/timestamp-query"),
                "{head}"
            );
            std::fs::write(d2.join("in.tsq"), &body).unwrap();
            let pki = pki();
            // openssl ts -reply writes its serial file; work on a copy of the config.
            std::fs::write(d2.join("tsaserial"), "01\n").unwrap();
            let conf = std::fs::read_to_string(pki.join("tsa.cnf"))
                .unwrap()
                .replace("./tsaserial", &d2.join("tsaserial").to_string_lossy());
            std::fs::write(d2.join("tsa.cnf"), conf).unwrap();
            let out = Command::new("openssl")
                .args(["ts", "-reply", "-config"])
                .arg(d2.join("tsa.cnf"))
                .arg("-queryfile")
                .arg(d2.join("in.tsq"))
                .arg("-signer")
                .arg(pki.join("tsa.pem"))
                .arg("-inkey")
                .arg(pki.join("tsa.key"))
                .arg("-chain")
                .arg(pki.join("root.pem"))
                .arg("-out")
                .arg(d2.join("out.tsr"))
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            reply(
                "200 OK",
                TSA_REPLY,
                &std::fs::read(d2.join("out.tsr")).unwrap(),
            )
        });
        let tsr = post_der(&format!("{url}/tsr"), TSA_REQUEST, TSA_REPLY, &req, &cfg()).unwrap();
        assert_eq!(tsr.first(), Some(&0x30), "DER TimeStampResp");
        std::fs::write(dir.join("got.tsr"), &tsr).unwrap();
        let v = Command::new("openssl")
            .args(["ts", "-verify", "-queryfile"])
            .arg(dir.join("req.tsq"))
            .arg("-in")
            .arg(dir.join("got.tsr"))
            .arg("-CAfile")
            .arg(pki().join("root.pem"))
            .output()
            .unwrap();
        assert!(
            String::from_utf8_lossy(&v.stdout).contains("Verification: OK"),
            "{}{}",
            String::from_utf8_lossy(&v.stdout),
            String::from_utf8_lossy(&v.stderr)
        );
    }

    #[test]
    fn error_status_wrong_type_and_redirects_are_refused() {
        let url = serve(|_, _| reply("500 Internal Server Error", "text/plain", b"no"));
        assert_eq!(
            post_der(&url, TSA_REQUEST, TSA_REPLY, b"\x30\x00", &cfg()),
            Err(NetError::Status(500))
        );
        let url = serve(|_, _| reply("200 OK", "text/html", b"<html>login</html>"));
        assert_eq!(
            post_der(&url, OCSP_REQUEST, OCSP_REPLY, b"\x30\x00", &cfg()),
            Err(NetError::WrongType(OCSP_REPLY.into()))
        );
        let url = serve(|_, _| {
            b"HTTP/1.1 302 Found\r\nLocation: http://example.invalid/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()
        });
        assert_eq!(
            post_der(&url, TSA_REQUEST, TSA_REPLY, b"\x30\x00", &cfg()),
            Err(NetError::Status(302))
        );
        assert_eq!(
            post_der(
                "http://127.0.0.1:9/",
                TSA_REQUEST,
                TSA_REPLY,
                &vec![0; MAX_REQUEST_BYTES + 1],
                &cfg()
            ),
            Err(NetError::RequestTooLarge)
        );
    }

    #[test]
    fn oversized_replies_are_capped() {
        // Declared too large.
        let url = serve(|_, _| {
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: {TSA_REPLY}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                MAX_REPLY_BYTES + 10
            )
            .into_bytes()
        });
        assert_eq!(
            post_der(&url, TSA_REQUEST, TSA_REPLY, b"\x30\x00", &cfg()),
            Err(NetError::TooLarge(MAX_REPLY_BYTES))
        );
        // Undeclared (connection-close body) and too large.
        let url = serve(|_, _| {
            let mut v = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: {TSA_REPLY}\r\nConnection: close\r\n\r\n"
            )
            .into_bytes();
            v.extend(std::iter::repeat_n(0u8, MAX_REPLY_BYTES as usize + 100));
            v
        });
        assert_eq!(
            post_der(&url, TSA_REQUEST, TSA_REPLY, b"\x30\x00", &cfg()),
            Err(NetError::TooLarge(MAX_REPLY_BYTES))
        );
    }

    #[test]
    fn crl_get_and_timeout() {
        let crl = std::fs::read(pki().join("int.crl")).unwrap();
        let c2 = crl.clone();
        let url = serve(move |head, _| {
            assert!(head.starts_with("GET /int.crl "), "{head}");
            reply("200 OK", "application/pkix-crl", &c2)
        });
        assert_eq!(get_crl(&format!("{url}/int.crl"), &cfg()).unwrap(), crl);
        // A server that never answers: the timeout fires.
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let hold = std::thread::spawn(move || {
            let c = l.accept();
            std::thread::sleep(Duration::from_secs(3));
            drop(c);
        });
        let quick = HttpConfig {
            timeout: Duration::from_millis(500),
            env_proxy: false,
        };
        let t0 = std::time::Instant::now();
        let e = get_crl(&format!("http://127.0.0.1:{port}/x.crl"), &quick).unwrap_err();
        assert!(matches!(e, NetError::Io(_)), "{e:?}");
        assert!(t0.elapsed() < Duration::from_secs(3));
        let _ = hold.join();
    }
}
