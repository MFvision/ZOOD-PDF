//! warraq-core — the RPC facade of the ZOOD PDF engine.
//!
//! Every UI ↔ engine call is `method` + JSON params + binary blobs, answered by a
//! [`Reply`] (JSON + blobs) or a [`CoreError`] (`{ "code", "message" }`). The same shape is
//! exposed to JavaScript by `wasm.rs` (feature `wasm`) and to Swift by `ffi.rs` (feature
//! `ffi`, header `include/warraq.h`).
//!
//! Methods live in [`registry`]: one file per namespace under `src/methods/`, each with a
//! `register(&mut Registry)` function listed in `methods::NAMESPACES`. Adding a namespace
//! (e.g. `text.*` backed by warraq-text) is one new file plus one line — no giant match.
//!
//! Conventions: page indices are 0-based; mutating methods commit an incremental update
//! and return the new file as `blobs[0]`.

pub mod error;
mod methods;
pub mod ocr;
pub mod registry;

#[cfg(feature = "ffi")]
pub mod ffi;
#[cfg(feature = "wasm")]
pub mod wasm;

pub use error::CoreError;
pub use registry::{registry, Registry};
pub use warraq_pdf;

use serde_json::Value;
use warraq_pdf::Pdf;

/// A reply: JSON plus binary blobs.
#[derive(Debug, Clone, PartialEq)]
pub struct Reply {
    /// JSON payload.
    pub json: Value,
    /// Binary payloads (e.g. the saved file as `blobs[0]`).
    pub blobs: Vec<Vec<u8>>,
}

impl Reply {
    /// JSON only.
    pub fn json(json: Value) -> Self {
        Reply {
            json,
            blobs: Vec::new(),
        }
    }

    /// JSON plus one blob.
    pub fn with_blob(json: Value, blob: Vec<u8>) -> Self {
        Reply {
            json,
            blobs: vec![blob],
        }
    }
}

/// An open document.
pub struct Document {
    pdf: Pdf,
}

impl std::fmt::Debug for Document {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Document").field("pdf", &self.pdf).finish()
    }
}

impl Document {
    /// Open `bytes` with an optional (user or owner) password.
    pub fn open(bytes: Vec<u8>, password: Option<&str>) -> Result<Document, CoreError> {
        Ok(Document {
            pdf: Pdf::open(bytes, password)?,
        })
    }

    /// Call a document method (`namespace.verb`).
    pub fn call(
        &mut self,
        method: &str,
        params: &Value,
        blobs: Vec<Vec<u8>>,
    ) -> Result<Reply, CoreError> {
        let f = registry().doc_method(method).ok_or_else(|| {
            CoreError::new("unknown_method", format!("no document method {method:?}"))
        })?;
        f(self, params, blobs)
    }

    /// The underlying PDF (for methods in other modules).
    pub fn pdf(&self) -> &Pdf {
        &self.pdf
    }

    /// Mutable access to the underlying PDF.
    pub fn pdf_mut(&mut self) -> &mut Pdf {
        &mut self.pdf
    }
}

/// Call a method that needs no open document (`pdf.merge`, `pdf.isEncrypted`, …).
pub fn call_static(method: &str, params: &Value, blobs: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let f = registry()
        .static_method(method)
        .ok_or_else(|| CoreError::new("unknown_method", format!("no static method {method:?}")))?;
    f(params, blobs)
}

/// Outer belt for the FFI/wasm boundaries: a panic (which the code is written never to raise)
/// becomes `{ code: "internal_panic" }` instead of unwinding into foreign code. On
/// wasm32-unknown-unknown panics abort (no unwinding); the worker then sees a RuntimeError.
pub fn guarded<T>(f: impl FnOnce() -> Result<T, CoreError>) -> Result<T, CoreError> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
        Ok(r) => r,
        Err(_) => Err(CoreError::new(
            "internal_panic",
            "the engine hit an internal error",
        )),
    }
}
