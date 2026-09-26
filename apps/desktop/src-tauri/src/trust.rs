//! The user's trusted certificates for signature verification (desktop): DER files in
//! `<app data>/trusted-certificates/<SHA-256 hex>.der`. Empty by default — a signature then
//! verifies as "valid, identity unknown". The UI parses and fingerprints certificates with the
//! engine (`sign.certInfo`); this module only stores bytes under a validated name.

use std::path::Path;

pub const DIR_NAME: &str = "trusted-certificates";
pub const MAX_CERT_BYTES: usize = 64 * 1024;
pub const MAX_CERTS: usize = 500;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum TrustError {
    #[error("the fingerprint must be 64 hexadecimal characters")]
    BadName,
    #[error("not a DER certificate")]
    NotDer,
    #[error("the trust list is full")]
    Full,
    #[error("{0}")]
    Io(String),
}

fn io(e: std::io::Error) -> TrustError {
    TrustError::Io(e.to_string())
}

/// A SHA-256 fingerprint in hex (either case); returned upper-case.
pub fn check_name(sha256: &str) -> Result<String, TrustError> {
    if sha256.len() == 64 && sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(sha256.to_ascii_uppercase())
    } else {
        Err(TrustError::BadName)
    }
}

/// Every stored certificate (DER), sorted by fingerprint.
pub fn list(dir: &Path) -> Result<Vec<Vec<u8>>, TrustError> {
    let rd = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(io(e)),
    };
    let mut names: Vec<String> = rd
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| {
            n.strip_suffix(".der")
                .is_some_and(|s| check_name(s).is_ok())
        })
        .collect();
    names.sort();
    let mut out = Vec::new();
    for n in names.into_iter().take(MAX_CERTS) {
        let b = std::fs::read(dir.join(&n)).map_err(io)?;
        if b.len() <= MAX_CERT_BYTES && b.first() == Some(&0x30) {
            out.push(b);
        }
    }
    Ok(out)
}

pub fn add(dir: &Path, sha256: &str, der: &[u8]) -> Result<(), TrustError> {
    let name = check_name(sha256)?;
    if der.is_empty() || der.len() > MAX_CERT_BYTES || der.first() != Some(&0x30) {
        return Err(TrustError::NotDer);
    }
    std::fs::create_dir_all(dir).map_err(io)?;
    let path = dir.join(format!("{name}.der"));
    if !path.exists() && list(dir)?.len() >= MAX_CERTS {
        return Err(TrustError::Full);
    }
    std::fs::write(path, der).map_err(io)
}

pub fn remove(dir: &Path, sha256: &str) -> Result<(), TrustError> {
    let name = check_name(sha256)?;
    match std::fs::remove_file(dir.join(format!("{name}.der"))) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io(e)),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn add_list_remove() {
        let dir = std::env::temp_dir().join(format!("zood-trust-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(
            list(&dir).unwrap(),
            Vec::<Vec<u8>>::new(),
            "empty by default"
        );
        let a = "a".repeat(64);
        let b = "B".repeat(64);
        add(&dir, &b, b"\x30\x03\x02\x01\x02").unwrap();
        add(&dir, &a, b"\x30\x03\x02\x01\x01").unwrap();
        add(&dir, &a, b"\x30\x03\x02\x01\x01").unwrap(); // idempotent
        assert_eq!(list(&dir).unwrap().len(), 2);
        assert_eq!(list(&dir).unwrap()[0], b"\x30\x03\x02\x01\x01");
        remove(&dir, &a).unwrap();
        remove(&dir, &a).unwrap();
        assert_eq!(list(&dir).unwrap().len(), 1);
    }

    #[test]
    fn names_and_bytes_are_validated() {
        let dir = std::env::temp_dir().join(format!("zood-trust-bad-{}", std::process::id()));
        for bad in ["../../etc/passwd", "", &"g".repeat(64), &"a".repeat(63)] {
            assert_eq!(
                add(&dir, bad, b"\x30\x00"),
                Err(TrustError::BadName),
                "{bad}"
            );
            assert_eq!(remove(&dir, bad), Err(TrustError::BadName));
        }
        let ok = "0".repeat(64);
        assert_eq!(add(&dir, &ok, b"-----BEGIN"), Err(TrustError::NotDer));
        assert_eq!(
            add(&dir, &ok, &vec![0x30; MAX_CERT_BYTES + 1]),
            Err(TrustError::NotDer)
        );
    }
}
