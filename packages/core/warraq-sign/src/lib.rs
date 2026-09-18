//! PDF digital signatures for Warraq: PAdES baseline signatures (B-B, B-T,
//! B-LT, B-LTA) made and checked in pure Rust, so the browser build and the
//! desktop build sign and verify with the same code.
//!
//! * [`pkcs12`] reads a certificate file (.p12/.pfx) — modern (PBES2, AES)
//!   and legacy (3DES, RC2-40) — into a [`keys::SoftwareSigner`].
//! * [`keys::Signer`] is what signs: that software signer, or a smart card
//!   on the desktop (the host implements it over PKCS#11). It only ever sees
//!   the digest of the signed attributes.
//! * [`cms`] writes and reads CMS `SignedData` (RFC 5652) with the PAdES
//!   attributes; [`tsp`] RFC 3161 timestamps; [`revocation`] OCSP and CRLs;
//!   [`chain`] certificate paths and trust.
//! * [`pades`] puts them together over `warraq_pdf::signature`: sign a PDF,
//!   timestamp it, add validation data, and verify every signature in it.
//!
//! Nothing here touches the network. A timestamp or a revocation answer is a
//! request built here, sent by the host only when the person asks, and an
//! answer handed back; the rest is pure functions over bytes.
pub mod asn1;
pub mod chain;
pub mod cms;
pub mod keys;
pub mod oids;
pub mod pades;
pub mod pkcs12;
pub mod revocation;
pub mod time;
pub mod tsp;

use sha1::Sha1;
use sha2::{Digest, Sha256, Sha384, Sha512};

#[derive(Debug, thiserror::Error)]
pub enum SignError {
    #[error("E_P12_PASSWORD: the certificate file's password is wrong")]
    P12Password,
    #[error("E_P12: {0}")]
    P12(String),
    #[error("E_KEY: {0}")]
    Key(String),
    #[error("E_CMS: {0}")]
    Cms(String),
    #[error("E_TSA: {0}")]
    Tsa(String),
    #[error("E_SIGN: {0}")]
    Sign(String),
    #[error("E_REVOCATION: {0}")]
    Revocation(String),
    #[error("{0}")]
    Pdf(#[from] warraq_pdf::Error),
}

pub type Result<T> = std::result::Result<T, SignError>;

pub(crate) fn cms_err(e: impl std::fmt::Display) -> SignError {
    SignError::Cms(e.to_string())
}

/// The digest algorithms a signature may use. SHA-1 is only ever read, for
/// old signatures, OCSP certificate ids and the PKCS#12 MACs of old files.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HashAlg {
    Sha1,
    Sha256,
    Sha384,
    Sha512,
}

impl HashAlg {
    pub fn digest(self, data: &[u8]) -> Vec<u8> {
        self.digest_parts(&[data])
    }

    /// The digest of several byte ranges, as one message.
    pub fn digest_parts(self, parts: &[&[u8]]) -> Vec<u8> {
        fn run<D: Digest>(parts: &[&[u8]]) -> Vec<u8> {
            let mut h = D::new();
            for p in parts {
                h.update(p);
            }
            h.finalize().to_vec()
        }
        match self {
            HashAlg::Sha1 => run::<Sha1>(parts),
            HashAlg::Sha256 => run::<Sha256>(parts),
            HashAlg::Sha384 => run::<Sha384>(parts),
            HashAlg::Sha512 => run::<Sha512>(parts),
        }
    }

    pub fn oid(self) -> const_oid::ObjectIdentifier {
        match self {
            HashAlg::Sha1 => oids::SHA1,
            HashAlg::Sha256 => oids::SHA256,
            HashAlg::Sha384 => oids::SHA384,
            HashAlg::Sha512 => oids::SHA512,
        }
    }

    pub fn from_oid(oid: &const_oid::ObjectIdentifier) -> Option<Self> {
        [Self::Sha1, Self::Sha256, Self::Sha384, Self::Sha512]
            .into_iter()
            .find(|h| h.oid() == *oid)
    }

    pub fn len(self) -> usize {
        match self {
            HashAlg::Sha1 => 20,
            HashAlg::Sha256 => 32,
            HashAlg::Sha384 => 48,
            HashAlg::Sha512 => 64,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            HashAlg::Sha1 => "SHA-1",
            HashAlg::Sha256 => "SHA-256",
            HashAlg::Sha384 => "SHA-384",
            HashAlg::Sha512 => "SHA-512",
        }
    }

    /// `AlgorithmIdentifier` for this digest, parameters absent (RFC 5754).
    pub fn algorithm(self) -> spki::AlgorithmIdentifierOwned {
        spki::AlgorithmIdentifierOwned {
            oid: self.oid(),
            parameters: None,
        }
    }
}

/// Upper-case hex, as PDF writes the VRI keys and a person reads a serial.
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02X}")).collect()
}
