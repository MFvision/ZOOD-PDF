//! Errors of the redaction crate; `code()` gives the stable RPC error code.

/// Result alias.
pub type Result<T> = std::result::Result<T, RedactError>;

/// Redaction / sanitisation errors.
#[derive(Debug, thiserror::Error)]
pub enum RedactError {
    /// Object layer error (limits, structure, encryption, …).
    #[error(transparent)]
    Pdf(#[from] warraq_pdf::PdfError),
    /// Text extraction failed.
    #[error("text: {0}")]
    Text(String),
    /// Bad parameters.
    #[error("{0}")]
    Params(String),
    /// A custom pattern was rejected (syntax, size, length).
    #[error("{0}")]
    Regex(String),
    /// Overlay text needs a font that covers it.
    #[error("{0}")]
    FontRequired(String),
    /// The document's permissions forbid the change.
    #[error("{0}")]
    Permission(String),
}

impl RedactError {
    /// Stable machine code.
    pub fn code(&self) -> &str {
        match self {
            RedactError::Pdf(e) => e.code(),
            RedactError::Text(_) => "text_error",
            RedactError::Params(_) => "invalid_params",
            RedactError::Regex(_) => "invalid_pattern",
            RedactError::FontRequired(_) => "font_required",
            RedactError::Permission(_) => "permission_denied",
        }
    }
}

impl From<warraq_text::TextError> for RedactError {
    fn from(e: warraq_text::TextError) -> Self {
        RedactError::Text(e.to_string())
    }
}
