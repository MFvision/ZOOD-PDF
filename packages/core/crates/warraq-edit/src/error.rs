//! Errors of the Edit engine. Every variant has a stable machine code for the RPC layer.

use warraq_pdf::PdfError;

/// Errors raised by `warraq-edit`.
#[derive(Debug, thiserror::Error)]
pub enum EditError {
    /// Error of the object layer (parse, limits, permissions, …).
    #[error(transparent)]
    Pdf(#[from] PdfError),
    /// Bad caller argument.
    #[error("invalid params: {0}")]
    Params(String),
    /// Page index out of range.
    #[error("page {0} does not exist")]
    PageOutOfRange(usize),
    /// Text block / image / link index does not exist (the UI's list is stale).
    #[error("not found: {0}")]
    NotFound(String),
    /// The block cannot be edited (shares drawing operators with other text, hidden text, …).
    #[error("this text cannot be edited: {0}")]
    NotEditable(String),
    /// The page changed since the UI listed it.
    #[error("the page changed; list it again")]
    Stale,
    /// A font could not be used (bundled font failed to load, subsetting failed, …).
    #[error("font error: {0}")]
    Font(String),
    /// An image could not be read (unsupported or corrupt JPEG/PNG).
    #[error("image error: {0}")]
    Image(String),
    /// A link target was refused (bidi controls, unsupported scheme, unconfirmed look-alike host).
    #[error("refused link: {0}")]
    UrlRefused(String),
    /// A bound was hit.
    #[error("limit exceeded: {0}")]
    Limit(String),
}

impl EditError {
    /// Stable machine code.
    pub fn code(&self) -> &'static str {
        match self {
            EditError::Pdf(e) => e.code(),
            EditError::Params(_) => "invalid_params",
            EditError::PageOutOfRange(_) => "page_out_of_range",
            EditError::NotFound(_) => "not_found",
            EditError::NotEditable(_) => "not_editable",
            EditError::Stale => "stale",
            EditError::Font(_) => "font_error",
            EditError::Image(_) => "image_error",
            EditError::UrlRefused(_) => "url_refused",
            EditError::Limit(_) => "limit_exceeded",
        }
    }
}

impl From<lopdf::Error> for EditError {
    fn from(e: lopdf::Error) -> Self {
        EditError::Pdf(PdfError::from(e))
    }
}

/// Result alias.
pub type Result<T> = std::result::Result<T, EditError>;
