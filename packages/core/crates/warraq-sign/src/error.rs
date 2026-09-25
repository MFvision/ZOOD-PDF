//! Errors of the signature crate. Every variant maps to a stable machine code that
//! warraq-core forwards to the UI as `{ code, message }`. Messages never carry key material
//! or passwords.

use warraq_pdf::PdfError;

/// Errors raised by `warraq-sign`.
#[derive(Debug, thiserror::Error)]
pub enum SignError {
    /// Error from the PDF object layer (parse, encryption, permissions, limits).
    #[error(transparent)]
    Pdf(#[from] PdfError),
    /// The PKCS#12 password is wrong (MAC or decryption failed).
    #[error("wrong certificate password")]
    WrongPassword,
    /// DER/BER/CMS/PKCS#12 input could not be parsed.
    #[error("malformed {0}")]
    Malformed(String),
    /// Well-formed but not supported (algorithm, sub-filter, key type…).
    #[error("unsupported: {0}")]
    Unsupported(String),
    /// A caller-supplied argument is out of range or inconsistent.
    #[error("invalid argument: {0}")]
    InvalidArgument(String),
    /// A signature or key operation failed.
    #[error("crypto error: {0}")]
    Crypto(String),
    /// An input bound was exceeded.
    #[error("limit exceeded: {0}")]
    Limit(String),
    /// A timestamp (RFC 3161) response was rejected.
    #[error("timestamp rejected: {0}")]
    Timestamp(String),
    /// The document forbids the operation (certified with no changes allowed, field locked…).
    #[error("not allowed: {0}")]
    NotAllowed(String),
}

impl SignError {
    /// Stable machine-readable code (snake_case).
    pub fn code(&self) -> &'static str {
        match self {
            SignError::Pdf(e) => e.code(),
            SignError::WrongPassword => "wrong_certificate_password",
            SignError::Malformed(_) => "malformed_input",
            SignError::Unsupported(_) => "unsupported",
            SignError::InvalidArgument(_) => "invalid_params",
            SignError::Crypto(_) => "crypto_error",
            SignError::Limit(_) => "limit_exceeded",
            SignError::Timestamp(_) => "timestamp_rejected",
            SignError::NotAllowed(_) => "signing_not_allowed",
        }
    }

    pub(crate) fn der(what: &str, e: impl std::fmt::Display) -> Self {
        SignError::Malformed(format!("{what}: {e}"))
    }
}

/// Result alias.
pub type Result<T> = std::result::Result<T, SignError>;
