//! Tool operations behind one entry point: `Document::call(op, args, blobs)`,
//! and `call_static` for work that needs no open document.
//!
//! `op` is `"<tool>.<operation>"`, `args` is JSON and `blobs` carries bytes —
//! PDFs, images — both ways, outside the JSON. The bridges (WASM, the desktop
//! host, the web worker and the UI's client) carry any `op` without knowing
//! it, so a new tool adds a module here and touches none of them.
use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::{CoreError, Document};

pub mod compress;
pub mod file;
pub mod forms;
pub mod forms_eval;
pub mod images;
pub mod links;
pub mod marks;
pub mod ocr;
pub mod pages;
pub mod panes;
pub mod patterns;
pub mod redact;
pub mod signatures;
pub mod view;

/// What a tool operation answers: JSON for the UI, and bytes beside it.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Reply {
    pub json: String,
    pub blobs: Vec<Vec<u8>>,
}

impl Reply {
    pub fn of(value: &impl Serialize) -> Result<Self, CoreError> {
        let json = serde_json::to_string(value).map_err(|e| CoreError::Args(e.to_string()))?;
        Ok(Self {
            json,
            blobs: Vec::new(),
        })
    }

    pub fn with_blob(mut self, blob: Vec<u8>) -> Self {
        self.blobs.push(blob);
        self
    }
}

/// An operation's arguments; empty text is an empty object.
pub(crate) fn args<T: DeserializeOwned>(json: &str) -> Result<T, CoreError> {
    let json = if json.trim().is_empty() { "{}" } else { json };
    serde_json::from_str(json).map_err(|e| CoreError::Args(e.to_string()))
}

pub fn call(
    doc: &mut Document,
    op: &str,
    args: &str,
    blobs: Vec<Vec<u8>>,
) -> Result<Reply, CoreError> {
    match op.split_once('.') {
        Some(("images", name)) => images::call(doc, name, args, blobs),
        Some(("links", name)) => links::call(doc, name, args, blobs),
        Some(("pages", name)) => pages::call(doc, name, args, blobs),
        Some(("redact", name)) => redact::call(doc, name, args, blobs),
        Some(("view", name)) => view::call(doc, name, args, blobs),
        _ => Err(CoreError::UnknownOp(op.into())),
    }
}

pub fn call_static(op: &str, args: &str, blobs: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    match op.split_once('.') {
        Some(("compress", name)) => compress::call_static(name, args, blobs),
        Some(("file", name)) => file::call_static(name, args, blobs),
        Some(("forms", name)) => forms::call_static(name, args, blobs),
        Some(("images", name)) => images::call_static(name, args, blobs),
        Some(("links", name)) => links::call_static(name, args, blobs),
        Some(("marks", name)) => marks::call_static(name, args, blobs),
        Some(("ocr", name)) => ocr::call_static(name, args, blobs),
        Some(("pages", name)) => pages::call_static(name, args, blobs),
        Some(("redact", name)) => redact::call_static(name, args, blobs),
        Some(("attachments", name)) => panes::attachments(name, args, blobs),
        Some(("layers", name)) => panes::layers(name, args, blobs),
        Some(("outline", name)) => panes::outline(name, args, blobs),
        Some(("signatures", name)) => signatures::call_static(name, args, blobs),
        _ => Err(CoreError::UnknownOp(op.into())),
    }
}
