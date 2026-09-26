//! Errors of the export/compare crate. Nothing panics on input data.

use warraq_text::TextError;

#[derive(Debug, thiserror::Error)]
pub enum OfficeError {
    #[error("{0}")]
    Text(#[from] TextError),
    #[error("invalid params: {0}")]
    Params(String),
    #[error("limit exceeded: {0}")]
    Limit(&'static str),
}

impl OfficeError {
    /// Stable machine code for RPC replies.
    pub fn code(&self) -> &'static str {
        match self {
            OfficeError::Text(e) => e.code(),
            OfficeError::Params(_) => "invalid_params",
            OfficeError::Limit(_) => "limit",
        }
    }
}

pub type Result<T> = std::result::Result<T, OfficeError>;
