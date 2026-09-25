//! Document-level API and the JSON RPC surface (`text.extract`, `text.search`, `text.plain`)
//! for `warraq-core` to register.
//!
//! Params (all optional unless stated):
//! * `pages`: array of 0-based page indices, or `{ "from": a, "to": b }` (inclusive, 0-based).
//!   Default: all pages.
//! * `glyphs` (extract): include per-glyph boxes in words. Default `false`.
//! * `hidden` / `artifacts`: include invisible text / pagination artifacts. Default `true`.
//! * `query` (search, required): the text to find.
//!
//! Replies: `text.extract` → `{ "pages": [PageText…] }`; `text.search` →
//! `{ "hits": [Hit…] }`; `text.plain` → `{ "text": "…", "pages": ["…", …] }`.

use serde_json::{json, Value};

use crate::error::{Result, TextError};
use crate::interp::Interpreter;
use crate::layout::{layout_page, LayoutOptions};
use crate::model::PageText;
use crate::search::search;
use crate::source::ContentSource;

/// RPC methods implemented here.
pub const METHODS: &[&str] = &["text.extract", "text.search", "text.plain"];

/// Extract the given pages (0-based).
pub fn extract_pages<S: ContentSource + ?Sized>(
    src: &S,
    pages: &[usize],
    opts: &LayoutOptions,
) -> Result<Vec<PageText>> {
    let mut it = Interpreter::new(src);
    let mut out = Vec::with_capacity(pages.len());
    for &p in pages {
        if p >= src.page_count() {
            return Err(TextError::PageOutOfRange(p));
        }
        let glyphs = it.page_glyphs(p)?;
        let pbox = src.page_box(p)?;
        out.push(layout_page(p, glyphs, pbox, opts));
    }
    Ok(out)
}

/// Extract every page.
pub fn extract_all<S: ContentSource + ?Sized>(
    src: &S,
    opts: &LayoutOptions,
) -> Result<Vec<PageText>> {
    let pages: Vec<usize> = (0..src.page_count()).collect();
    extract_pages(src, &pages, opts)
}

/// Logical-order plain text of pages, pages separated by a blank line.
pub fn plain_text(pages: &[PageText]) -> String {
    pages
        .iter()
        .map(|p| p.plain.as_str())
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn page_list<S: ContentSource + ?Sized>(src: &S, params: &Value) -> Result<Vec<usize>> {
    let n = src.page_count();
    match params.get("pages") {
        None | Some(Value::Null) => Ok((0..n).collect()),
        Some(Value::Array(a)) => a
            .iter()
            .map(|v| {
                v.as_u64()
                    .and_then(|x| usize::try_from(x).ok())
                    .ok_or_else(|| TextError::Params("pages must be non-negative integers".into()))
            })
            .collect(),
        Some(Value::Object(o)) => {
            let from = o.get("from").and_then(Value::as_u64).unwrap_or(0) as usize;
            let to = o
                .get("to")
                .and_then(Value::as_u64)
                .map_or(n.saturating_sub(1), |v| v as usize);
            if n == 0 || from > to {
                return Ok(Vec::new());
            }
            Ok((from..=to.min(n - 1)).collect())
        }
        Some(_) => Err(TextError::Params(
            "pages must be an array or {from,to}".into(),
        )),
    }
}

fn options(params: &Value) -> LayoutOptions {
    let flag = |k: &str, d: bool| params.get(k).and_then(Value::as_bool).unwrap_or(d);
    LayoutOptions {
        glyphs: flag("glyphs", false),
        include_hidden: flag("hidden", true),
        include_artifacts: flag("artifacts", true),
    }
}

/// `text.extract`
pub fn rpc_extract<S: ContentSource + ?Sized>(src: &S, params: &Value) -> Result<Value> {
    let pages = extract_pages(src, &page_list(src, params)?, &options(params))?;
    serde_json::to_value(&pages)
        .map(|p| json!({ "pages": p }))
        .map_err(|e| TextError::Params(e.to_string()))
}

/// `text.search`
pub fn rpc_search<S: ContentSource + ?Sized>(src: &S, params: &Value) -> Result<Value> {
    let query = params
        .get("query")
        .and_then(Value::as_str)
        .ok_or_else(|| TextError::Params("query (string) is required".into()))?;
    let pages = extract_pages(src, &page_list(src, params)?, &options(params))?;
    let hits = search(&pages, query);
    serde_json::to_value(&hits)
        .map(|h| json!({ "hits": h }))
        .map_err(|e| TextError::Params(e.to_string()))
}

/// `text.plain`
pub fn rpc_plain<S: ContentSource + ?Sized>(src: &S, params: &Value) -> Result<Value> {
    let pages = extract_pages(src, &page_list(src, params)?, &options(params))?;
    let per: Vec<&str> = pages.iter().map(|p| p.plain.as_str()).collect();
    Ok(json!({ "text": plain_text(&pages), "pages": per }))
}

/// Dispatch one of [`METHODS`]; `None` if the method is not a text method.
pub fn call<S: ContentSource + ?Sized>(
    src: &S,
    method: &str,
    params: &Value,
) -> Option<Result<Value>> {
    Some(match method {
        "text.extract" => rpc_extract(src, params),
        "text.search" => rpc_search(src, params),
        "text.plain" => rpc_plain(src, params),
        _ => return None,
    })
}
