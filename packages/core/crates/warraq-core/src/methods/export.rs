//! `export.*` (warraq-office): Word, Excel, PowerPoint, HTML, Markdown and text from the engine's
//! logical-order text, tables from ruling lines + column alignment. Exports never modify the
//! document.
//!
//! * `export.docx|xlsx|pptx|html|markdown|text` `{ pages?, title?, sheetNames? }` →
//!   `{ pages, tables, extension, mime, size }` + the file as `blobs[0]`. PPTX takes optional
//!   PNG page backgrounds as blobs.
//! * `export.png` (feature `render`, not in the default wasm): `{ pages?, scale? }` → one PNG per
//!   page. The web UI renders PNGs with PDFium instead (see ADR 0013).
//! * `export.zip` (static) `{ names: [...] }` + one blob per name → a ZIP (`blobs[0]`).

use super::params;
use crate::registry::Registry;
use crate::{CoreError, Document, Reply};
use serde::Deserialize;
use serde_json::{json, Value};
use warraq_office::{Format, OfficeError};
use warraq_text::DocSource;

pub fn register(r: &mut Registry) {
    r.doc("export.docx", docx)
        .doc("export.xlsx", xlsx)
        .doc("export.pptx", pptx)
        .doc("export.html", html)
        .doc("export.markdown", markdown)
        .doc("export.text", text)
        .static_fn("export.zip", zip);
    #[cfg(feature = "render")]
    r.doc("export.png", png);
}

pub(crate) fn office_err(e: OfficeError) -> CoreError {
    CoreError::new(e.code(), e.to_string())
}

fn run(d: &mut Document, f: Format, p: &Value, blobs: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    if !(p.is_null() || p.is_object()) {
        return Err(CoreError::params("params must be an object"));
    }
    let src = DocSource::borrowed(d.pdf().document());
    let (json, bytes) = warraq_office::export(&src, f, p, &blobs).map_err(office_err)?;
    Ok(Reply::with_blob(json, bytes))
}

fn docx(d: &mut Document, p: &Value, b: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    run(d, Format::Docx, p, b)
}
fn xlsx(d: &mut Document, p: &Value, b: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    run(d, Format::Xlsx, p, b)
}
fn pptx(d: &mut Document, p: &Value, b: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    run(d, Format::Pptx, p, b)
}
fn html(d: &mut Document, p: &Value, b: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    run(d, Format::Html, p, b)
}
fn markdown(d: &mut Document, p: &Value, b: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    run(d, Format::Markdown, p, b)
}
fn text(d: &mut Document, p: &Value, b: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    run(d, Format::Text, p, b)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Zip {
    names: Vec<String>,
}

fn zip(p: &Value, blobs: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let p: Zip = params(p)?;
    if p.names.len() != blobs.len() || blobs.is_empty() {
        return Err(CoreError::params("one name per blob is required"));
    }
    let mut z = warraq_office::zip::ZipWriter::new();
    let mut seen = std::collections::BTreeSet::new();
    for (name, data) in p.names.iter().zip(&blobs) {
        // Plain file names only: no directories, no traversal, no duplicates.
        let bad = name.is_empty()
            || name.len() > 255
            || name.contains(['/', '\\', '\0'])
            || name == "."
            || name == ".."
            || !seen.insert(name.as_str());
        if bad {
            return Err(CoreError::params(format!("bad file name {name:?}")));
        }
        let packed = !(name.ends_with(".png") || name.ends_with(".jpg"));
        z.add(name, data, packed).map_err(office_err)?;
    }
    let bytes = z.finish().map_err(office_err)?;
    Ok(Reply::with_blob(json!({ "files": blobs.len(), "size": bytes.len() }), bytes))
}

#[cfg(feature = "render")]
fn png(d: &mut Document, p: &Value, _b: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    use warraq_render::{HayroRenderer, PageRenderer};
    let scale = p.get("scale").and_then(Value::as_f64).unwrap_or(2.0).clamp(0.1, 8.0) as f32;
    let pages = warraq_office::page_list(d.pdf().document().get_pages().len(), p).map_err(office_err)?;
    let bytes = if d.pdf().is_encrypted() || d.pdf().has_changes() {
        d.pdf().write_full(warraq_pdf::Protection::Remove)?
    } else {
        d.pdf().bytes().to_vec()
    };
    let r = HayroRenderer::new(bytes).map_err(|e| CoreError::new("render_error", e.to_string()))?;
    let mut blobs = Vec::with_capacity(pages.len());
    for &i in &pages {
        let bmp = r
            .render(i, scale)
            .map_err(|e| CoreError::new("render_error", e.to_string()))?;
        blobs.push(
            bmp.to_png()
                .map_err(|e| CoreError::new("render_error", e.to_string()))?,
        );
    }
    Ok(Reply {
        json: json!({ "pages": pages }),
        blobs,
    })
}
