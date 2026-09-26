//! `compare.*` (warraq-office).
//!
//! * `compare.text` (document = A, the original) `{ password?, pagesA?, pagesB?, options? }` +
//!   `blobs[0]` = document B (the revised PDF) → `{ summary, changes: [...] }`.
//! * `compare.visual` (static) `{ widthA, heightA, widthB, heightB, threshold? }` + RGBA rasters
//!   of both pages → `{ width, height, changedPixels, ratio, boxes }` + overlay PNG `blobs[0]`.
//! * `compare.report` (static) `{ locale, nameA, nameB, labels?, text, visual? }` + overlay PNGs
//!   → self-contained HTML (`blobs[0]`).

use super::blob0;
use super::export::office_err;
use crate::registry::Registry;
use crate::{CoreError, Document, Reply};
use serde_json::{json, Value};
use warraq_office::compare::{compare_visual, Raster};
use warraq_pdf::Pdf;
use warraq_text::DocSource;

pub fn register(r: &mut Registry) {
    r.doc("compare.text", text)
        .static_fn("compare.visual", visual)
        .static_fn("compare.report", report);
}

fn text(d: &mut Document, p: &Value, blobs: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let other = blob0(blobs, "the PDF to compare with")?;
    let password = p.get("password").and_then(Value::as_str);
    let b = Pdf::open(other, password)?;
    let sa = DocSource::borrowed(d.pdf().document());
    let sb = DocSource::borrowed(b.document());
    let diff = warraq_office::compare_docs(&sa, &sb, p).map_err(office_err)?;
    let v = serde_json::to_value(&diff).map_err(|e| CoreError::new("internal", e.to_string()))?;
    Ok(Reply::json(v))
}

fn dim(p: &Value, k: &str) -> Result<u32, CoreError> {
    p.get(k)
        .and_then(Value::as_u64)
        .and_then(|v| u32::try_from(v).ok())
        .ok_or_else(|| CoreError::params(format!("{k} (integer) is required")))
}

fn visual(p: &Value, blobs: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let [a, b]: [Vec<u8>; 2] = blobs
        .try_into()
        .map_err(|_| CoreError::params("two RGBA blobs are required"))?;
    let threshold = p
        .get("threshold")
        .and_then(Value::as_u64)
        .unwrap_or(48)
        .min(255) as u8;
    let ra = Raster {
        width: dim(p, "widthA")?,
        height: dim(p, "heightA")?,
        rgba: &a,
    };
    let rb = Raster {
        width: dim(p, "widthB")?,
        height: dim(p, "heightB")?,
        rgba: &b,
    };
    let r = compare_visual(&ra, &rb, threshold).map_err(office_err)?;
    let json = serde_json::to_value(&r).map_err(|e| CoreError::new("internal", e.to_string()))?;
    Ok(Reply::with_blob(json, r.overlay_png))
}

fn report(p: &Value, blobs: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let input: warraq_office::report::ReportInput =
        serde_json::from_value(if p.is_null() { json!({}) } else { p.clone() })
            .map_err(|e| CoreError::params(e.to_string()))?;
    let html = warraq_office::report::render(&input, &blobs);
    Ok(Reply::with_blob(json!({ "size": html.len() }), html))
}
