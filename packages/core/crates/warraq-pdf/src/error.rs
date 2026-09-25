//! Error type of the PDF object layer. Every variant maps to a stable machine code
//! (`PdfError::code`) that warraq-core forwards to the UI as `{ code, message }`.

/// Errors raised by `warraq-pdf`. Never carries input bytes, only short descriptions.
#[derive(Debug, thiserror::Error)]
pub enum PdfError {
    /// A configured bound in [`crate::limits::Limits`] was exceeded.
    #[error("limit exceeded: {0}")]
    Limit(String),
    /// The input could not be parsed as a PDF at all.
    #[error("cannot read PDF: {0}")]
    Parse(String),
    /// The document is encrypted and neither the empty nor the supplied password opens it.
    #[error("this document needs a password")]
    PasswordRequired,
    /// A password was supplied but it matches neither the user nor the owner password.
    #[error("wrong password")]
    WrongPassword,
    /// The document uses a security handler or revision we do not implement.
    #[error("unsupported encryption: {0}")]
    UnsupportedEncryption(String),
    /// A cryptographic primitive failed (bad key length, corrupt ciphertext).
    #[error("crypto error: {0}")]
    Crypto(String),
    /// A caller-supplied argument is out of range or malformed.
    #[error("invalid argument: {0}")]
    InvalidArgument(String),
    /// The object graph does not have the structure the operation needs.
    #[error("document structure: {0}")]
    Structure(String),
    /// The document's permissions (opened with the user password) forbid this operation.
    #[error("permission denied: {0}")]
    Permission(String),
}

impl PdfError {
    /// Stable machine-readable code (snake_case) for the RPC layer.
    pub fn code(&self) -> &'static str {
        match self {
            PdfError::Limit(_) => "limit_exceeded",
            PdfError::Parse(_) => "parse_error",
            PdfError::PasswordRequired => "password_required",
            PdfError::WrongPassword => "wrong_password",
            PdfError::UnsupportedEncryption(_) => "unsupported_encryption",
            PdfError::Crypto(_) => "crypto_error",
            PdfError::InvalidArgument(_) => "invalid_argument",
            PdfError::Structure(_) => "structure_error",
            PdfError::Permission(_) => "permission_denied",
        }
    }
}

impl From<lopdf::Error> for PdfError {
    fn from(e: lopdf::Error) -> Self {
        PdfError::Structure(e.to_string())
    }
}

/// Result alias used throughout the crate.
pub type Result<T> = std::result::Result<T, PdfError>;
