//! Errors of the Accessibility engine. Every variant has a stable machine code for the RPC layer.

use warraq_edit::EditError;
use warraq_pdf::PdfError;

/// Errors raised by `warraq-a11y`.
#[derive(Debug, thiserror::Error)]
pub enum A11yError {
    /// Error of the object layer (parse, limits, permissions, …).
    #[error(transparent)]
    Pdf(#[from] PdfError),
    /// Error of the content layer (lexer, page write-back).
    #[error(transparent)]
    Edit(#[from] EditError),
    /// Bad caller argument.
    #[error("invalid params: {0}")]
    Params(String),
    /// A structure element (or page) does not exist (the UI's list is stale).
    #[error("not found: {0}")]
    NotFound(String),
    /// The operation needs a structure tree and the document has none.
    #[error("the document is not tagged; auto-tag it first")]
    NotTagged,
    /// The operation is not possible on this element (e.g. content inside a form XObject).
    #[error("not possible: {0}")]
    NotPossible(String),
    /// A bound was hit (structure too large or too deep, too many pages, …).
    #[error("limit exceeded: {0}")]
    Limit(String),
}

impl A11yError {
    /// Stable machine code.
    pub fn code(&self) -> &'static str {
        match self {
            A11yError::Pdf(e) => e.code(),
            A11yError::Edit(e) => e.code(),
            A11yError::Params(_) => "invalid_params",
            A11yError::NotFound(_) => "not_found",
            A11yError::NotTagged => "not_tagged",
            A11yError::NotPossible(_) => "not_possible",
            A11yError::Limit(_) => "limit_exceeded",
        }
    }
}

impl From<lopdf::Error> for A11yError {
    fn from(e: lopdf::Error) -> Self {
        A11yError::Pdf(PdfError::from(e))
    }
}

/// Result alias.
pub type Result<T> = std::result::Result<T, A11yError>;
