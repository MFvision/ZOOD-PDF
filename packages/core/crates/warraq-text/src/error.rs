//! Error type of the text engine. Every failure is a value; nothing panics on input data.

/// Errors returned by `warraq-text`.
#[derive(Debug, thiserror::Error)]
pub enum TextError {
    /// The PDF object layer could not provide what was asked (missing page, bad object…).
    #[error("pdf: {0}")]
    Pdf(String),
    /// A page index outside `0..page_count`.
    #[error("page {0} is out of range")]
    PageOutOfRange(usize),
    /// A font program could not be parsed (shaping only; extraction degrades gracefully).
    #[error("font: {0}")]
    Font(String),
    /// Invalid RPC parameters.
    #[error("invalid params: {0}")]
    Params(String),
    /// A hostile-input limit from [`crate::limits`] was reached.
    #[error("limit exceeded: {0}")]
    Limit(&'static str),
}

impl TextError {
    /// Stable machine-readable code used in RPC error replies.
    pub fn code(&self) -> &'static str {
        match self {
            TextError::Pdf(_) => "pdf",
            TextError::PageOutOfRange(_) => "page_out_of_range",
            TextError::Font(_) => "font",
            TextError::Params(_) => "invalid_params",
            TextError::Limit(_) => "limit",
        }
    }
}

/// Result alias.
pub type Result<T> = std::result::Result<T, TextError>;
