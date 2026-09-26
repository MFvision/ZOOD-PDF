//! warraq-office — export and compare for the ZOOD PDF engine.
//!
//! * [`model`] builds an export model (paragraphs with direction/language/heading/bold/italic,
//!   tables with spans) from warraq-text's logical-order extraction and [`table`] detection
//!   (ruling lines from [`rules`] + column alignment).
//! * Own writers, no office suite involved: [`docx`], [`xlsx`], [`pptx`], [`html`] (+ Markdown)
//!   and plain text; [`zip`] and [`png`] are minimal container/image encoders.
//! * [`compare`] diffs two documents' text (Arabic-aware, bounded) and two rasters;
//!   [`report`] renders a self-contained HTML report.
//!
//! The RPC glue lives in `warraq-core` (`methods/export.rs`, `methods/compare.rs`).

pub mod compare;
pub mod docx;
pub mod error;
pub mod html;
pub mod model;
pub mod ooxml;
pub mod png;
pub mod pptx;
pub mod report;
pub mod rules;
pub mod table;
pub mod xlsx;
pub mod xml;
pub mod zip;

pub use error::{OfficeError, Result};
pub use model::ExportDoc;

use serde_json::{json, Value};
use warraq_text::{ContentSource, LayoutOptions};

/// Export formats.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Docx,
    Xlsx,
    Pptx,
    Html,
    Markdown,
    Text,
}

impl Format {
    pub fn from_method(m: &str) -> Option<Format> {
        Some(match m.strip_prefix("export.")? {
            "docx" => Format::Docx,
            "xlsx" => Format::Xlsx,
            "pptx" => Format::Pptx,
            "html" => Format::Html,
            "markdown" => Format::Markdown,
            "text" => Format::Text,
            _ => return None,
        })
    }
    pub fn extension(self) -> &'static str {
        match self {
            Format::Docx => "docx",
            Format::Xlsx => "xlsx",
            Format::Pptx => "pptx",
            Format::Html => "html",
            Format::Markdown => "md",
            Format::Text => "txt",
        }
    }
    pub fn mime(self) -> &'static str {
        match self {
            Format::Docx => {
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            }
            Format::Xlsx => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            Format::Pptx => {
                "application/vnd.openxmlformats-officedocument.presentationml.presentation"
            }
            Format::Html => "text/html",
            Format::Markdown => "text/markdown",
            Format::Text => "text/plain",
        }
    }
}

/// Resolve `params.pages` (array of 0-based indices, or `{from, to}` inclusive) against
/// `count` pages. Default: every page. Out-of-range indices are an error; duplicates are kept
/// once, in the given order.
pub fn page_list(count: usize, params: &Value) -> Result<Vec<usize>> {
    let bad = |m: &str| OfficeError::Params(m.to_string());
    let list: Vec<usize> = match params.get("pages") {
        None | Some(Value::Null) => (0..count).collect(),
        Some(Value::Array(a)) => {
            let mut v = Vec::with_capacity(a.len().min(count));
            for x in a.iter().take(100_000) {
                let p = x
                    .as_u64()
                    .and_then(|x| usize::try_from(x).ok())
                    .ok_or_else(|| bad("pages must be non-negative integers"))?;
                if p >= count {
                    return Err(OfficeError::Text(warraq_text::TextError::PageOutOfRange(p)));
                }
                if !v.contains(&p) {
                    v.push(p);
                }
            }
            v
        }
        Some(Value::Object(o)) => {
            let from = o.get("from").and_then(Value::as_u64).unwrap_or(0) as usize;
            let to = o
                .get("to")
                .and_then(Value::as_u64)
                .map_or(count.saturating_sub(1), |v| v as usize);
            if count == 0 || from > to || from >= count {
                return Err(bad("empty page range"));
            }
            (from..=to.min(count - 1)).collect()
        }
        Some(_) => return Err(bad("pages must be an array or {from,to}")),
    };
    if list.is_empty() {
        return Err(bad("no pages to export"));
    }
    Ok(list)
}

/// Run an export. `blobs` (PPTX only): optional PNG background per exported page.
/// Returns the reply JSON and the file bytes.
pub fn export<S: ContentSource + ?Sized>(
    src: &S,
    format: Format,
    params: &Value,
    blobs: &[Vec<u8>],
) -> Result<(Value, Vec<u8>)> {
    let pages = page_list(src.page_count(), params)?;
    let title = params
        .get("title")
        .and_then(Value::as_str)
        .map(|s| s.chars().take(500).collect::<String>());
    let (bytes, tables) = if format == Format::Text {
        let texts = warraq_text::extract_pages(src, &pages, &LayoutOptions::default())?;
        (warraq_text::plain_text(&texts).into_bytes(), 0)
    } else {
        let doc = model::build(src, &pages, title)?;
        let tables = doc.tables().count();
        let bytes = match format {
            Format::Docx => docx::write(&doc)?,
            Format::Xlsx => {
                let mut names = xlsx::SheetNames::default();
                if let Some(n) = params.get("sheetNames") {
                    if let Some(t) = n.get("table").and_then(Value::as_str) {
                        names.table = t.to_string();
                    }
                    if let Some(t) = n.get("text").and_then(Value::as_str) {
                        names.text = t.to_string();
                    }
                }
                xlsx::write(&doc, &names)?
            }
            Format::Pptx => pptx::write(&doc, blobs)?,
            Format::Html => html::write(&doc),
            Format::Markdown => html::markdown(&doc),
            Format::Text => Vec::new(),
        };
        (bytes, tables)
    };
    Ok((
        json!({
            "pages": pages.len(),
            "tables": tables,
            "extension": format.extension(),
            "mime": format.mime(),
            "size": bytes.len(),
        }),
        bytes,
    ))
}

/// The export model as JSON (for inspection and tests): `{ pages: [...] }`.
pub fn model_json<S: ContentSource + ?Sized>(src: &S, params: &Value) -> Result<Value> {
    let pages = page_list(src.page_count(), params)?;
    let doc = model::build(src, &pages, None)?;
    serde_json::to_value(&doc).map_err(|e| OfficeError::Params(e.to_string()))
}

/// `compare.text`: A = `a`, B = `b`; params `{ pagesA?, pagesB?, options? }`.
pub fn compare_docs<A: ContentSource + ?Sized, B: ContentSource + ?Sized>(
    a: &A,
    b: &B,
    params: &Value,
) -> Result<compare::TextDiff> {
    let sub = |k: &str| -> Value {
        params
            .get(k)
            .map(|p| json!({ "pages": p }))
            .unwrap_or(Value::Null)
    };
    let pa = page_list(a.page_count(), &sub("pagesA"))?;
    let pb = page_list(b.page_count(), &sub("pagesB"))?;
    let opts: compare::TextOptions = match params.get("options") {
        Some(v) if !v.is_null() => {
            serde_json::from_value(v.clone()).map_err(|e| OfficeError::Params(e.to_string()))?
        }
        _ => compare::TextOptions::default(),
    };
    let lo = LayoutOptions::default();
    let ta = warraq_text::extract_pages(a, &pa, &lo)?;
    let tb = warraq_text::extract_pages(b, &pb, &lo)?;
    Ok(compare::compare_text(&ta, &tb, &opts))
}
