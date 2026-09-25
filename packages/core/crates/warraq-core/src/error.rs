//! `CoreError`: the only error shape that crosses the engine boundary.

use serde::Serialize;
use serde_json::{json, Value};

/// `{ "code": "…", "message": "…" }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, thiserror::Error)]
#[error("{code}: {message}")]
pub struct CoreError {
    /// Stable machine code (snake_case), e.g. `password_required`.
    pub code: String,
    /// Human-readable English message (the UI localises by `code`).
    pub message: String,
}

impl CoreError {
    /// Build an error.
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        CoreError {
            code: code.to_string(),
            message: message.into(),
        }
    }

    /// `invalid_params` error.
    pub fn params(message: impl Into<String>) -> Self {
        Self::new("invalid_params", message)
    }

    /// JSON form.
    pub fn to_json(&self) -> Value {
        json!({ "code": self.code, "message": self.message })
    }
}

impl From<warraq_pdf::PdfError> for CoreError {
    fn from(e: warraq_pdf::PdfError) -> Self {
        CoreError::new(e.code(), e.to_string())
    }
}
