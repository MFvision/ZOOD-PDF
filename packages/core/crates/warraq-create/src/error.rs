//! Errors of the Create PDF engine. Every reader failure is a value, never a panic.

/// Result alias.
pub type Result<T> = std::result::Result<T, CreateError>;

/// What went wrong while reading a source file or writing the PDF.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CreateError {
    /// The file type is not supported (or could not be recognised).
    #[error("unsupported file type: {0}")]
    Unsupported(String),
    /// The file is damaged or not what its extension claims.
    #[error("malformed file: {0}")]
    Malformed(String),
    /// A bound was hit (zip bomb, huge image, too many cells, …).
    #[error("limit exceeded: {0}")]
    Limit(String),
    /// Bad RPC parameters.
    #[error("invalid parameters: {0}")]
    Params(String),
    /// Font shaping or subsetting failed.
    #[error("font error: {0}")]
    Font(String),
    /// Writing the PDF failed.
    #[error("pdf error: {0}")]
    Pdf(String),
}

impl CreateError {
    /// Stable machine code for the RPC boundary.
    pub fn code(&self) -> &'static str {
        match self {
            CreateError::Unsupported(_) => "unsupported_format",
            CreateError::Malformed(_) => "malformed_input",
            CreateError::Limit(_) => "limit_exceeded",
            CreateError::Params(_) => "invalid_params",
            CreateError::Font(_) => "font_error",
            CreateError::Pdf(_) => "pdf_error",
        }
    }

    /// Shorthand for [`CreateError::Malformed`].
    pub fn malformed(m: impl Into<String>) -> Self {
        CreateError::Malformed(m.into())
    }

    /// Shorthand for [`CreateError::Limit`].
    pub fn limit(m: impl Into<String>) -> Self {
        CreateError::Limit(m.into())
    }
}

impl From<warraq_pdf::PdfError> for CreateError {
    fn from(e: warraq_pdf::PdfError) -> Self {
        CreateError::Pdf(e.to_string())
    }
}
