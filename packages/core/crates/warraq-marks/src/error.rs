//! Errors of the Page marks engine, each with a stable machine code for the RPC layer.

use warraq_edit::EditError;
use warraq_pdf::PdfError;

#[derive(Debug, thiserror::Error)]
pub enum MarkError {
    #[error(transparent)]
    Pdf(#[from] PdfError),
    #[error(transparent)]
    Edit(#[from] EditError),
    #[error("invalid params: {0}")]
    Params(String),
    #[error("page {0} does not exist")]
    PageOutOfRange(usize),
    #[error("mark not found: {0}")]
    NotFound(String),
    /// A mark made by another application cannot be removed without risk to the page.
    #[error("this mark cannot be removed safely: {0}")]
    Unsafe(String),
    #[error("limit exceeded: {0}")]
    Limit(String),
}

impl MarkError {
    pub fn code(&self) -> &'static str {
        match self {
            MarkError::Pdf(e) => e.code(),
            MarkError::Edit(e) => e.code(),
            MarkError::Params(_) => "invalid_params",
            MarkError::PageOutOfRange(_) => "page_out_of_range",
            MarkError::NotFound(_) => "not_found",
            MarkError::Unsafe(_) => "not_removable",
            MarkError::Limit(_) => "limit_exceeded",
        }
    }
}

impl From<lopdf::Error> for MarkError {
    fn from(e: lopdf::Error) -> Self {
        MarkError::Pdf(PdfError::from(e))
    }
}

pub type Result<T> = std::result::Result<T, MarkError>;
