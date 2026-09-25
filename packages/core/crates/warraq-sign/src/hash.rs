//! Digest algorithms.

use crate::error::{Result, SignError};
use crate::oids;
use const_oid::ObjectIdentifier;
use sha2::Digest;

/// A digest algorithm.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HashAlg {
    /// SHA-1 (verification of legacy signatures only; never used for new signatures).
    Sha1,
    /// SHA-256.
    Sha256,
    /// SHA-384.
    Sha384,
    /// SHA-512.
    Sha512,
}

impl HashAlg {
    /// Identifier.
    pub fn oid(self) -> ObjectIdentifier {
        match self {
            HashAlg::Sha1 => oids::SHA1,
            HashAlg::Sha256 => oids::SHA256,
            HashAlg::Sha384 => oids::SHA384,
            HashAlg::Sha512 => oids::SHA512,
        }
    }

    /// From a digest OID.
    pub fn from_oid(oid: &ObjectIdentifier) -> Result<Self> {
        match *oid {
            o if o == oids::SHA1 => Ok(HashAlg::Sha1),
            o if o == oids::SHA256 => Ok(HashAlg::Sha256),
            o if o == oids::SHA384 => Ok(HashAlg::Sha384),
            o if o == oids::SHA512 => Ok(HashAlg::Sha512),
            o => Err(SignError::Unsupported(format!("digest algorithm {o}"))),
        }
    }

    /// Output length in bytes.
    pub fn len(self) -> usize {
        match self {
            HashAlg::Sha1 => 20,
            HashAlg::Sha256 => 32,
            HashAlg::Sha384 => 48,
            HashAlg::Sha512 => 64,
        }
    }

    /// Display name.
    pub fn name(self) -> &'static str {
        match self {
            HashAlg::Sha1 => "SHA-1",
            HashAlg::Sha256 => "SHA-256",
            HashAlg::Sha384 => "SHA-384",
            HashAlg::Sha512 => "SHA-512",
        }
    }

    /// Digest of the concatenation of `parts`.
    pub fn digest_parts(self, parts: &[&[u8]]) -> Vec<u8> {
        fn run<D: Digest>(parts: &[&[u8]]) -> Vec<u8> {
            let mut h = D::new();
            for p in parts {
                h.update(p);
            }
            h.finalize().to_vec()
        }
        match self {
            HashAlg::Sha1 => run::<sha1::Sha1>(parts),
            HashAlg::Sha256 => run::<sha2::Sha256>(parts),
            HashAlg::Sha384 => run::<sha2::Sha384>(parts),
            HashAlg::Sha512 => run::<sha2::Sha512>(parts),
        }
    }

    /// Digest of `data`.
    pub fn digest(self, data: &[u8]) -> Vec<u8> {
        self.digest_parts(&[data])
    }
}

/// Uppercase hex.
pub fn hex_upper(data: &[u8]) -> String {
    let mut s = String::with_capacity(data.len() * 2);
    for b in data {
        s.push_str(&format!("{b:02X}"));
    }
    s
}

/// Decode hex (whitespace not allowed). `None` on any non-hex character or odd length.
pub fn hex_decode(s: &[u8]) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    let val = |c: u8| -> Option<u8> {
        match c {
            b'0'..=b'9' => Some(c - b'0'),
            b'a'..=b'f' => Some(c - b'a' + 10),
            b'A'..=b'F' => Some(c - b'A' + 10),
            _ => None,
        }
    };
    s.chunks_exact(2)
        .map(|p| match p {
            [a, b] => Some(val(*a)? << 4 | val(*b)?),
            _ => None,
        })
        .collect()
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn known_answers() {
        assert_eq!(
            hex_upper(&HashAlg::Sha256.digest(b"abc")),
            "BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD"
        );
        assert_eq!(
            HashAlg::Sha256.digest_parts(&[b"a", b"bc"]),
            HashAlg::Sha256.digest(b"abc")
        );
        assert_eq!(HashAlg::Sha384.digest(b"").len(), 48);
        assert_eq!(hex_decode(b"0aFF").unwrap(), vec![10, 255]);
        assert!(hex_decode(b"0g").is_none());
        assert!(hex_decode(b"0").is_none());
    }
}
