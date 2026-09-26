//! `redact.*`: true redaction, find & redact, remove hidden information (warraq-redact).
//! Every mutating method is a whole rewrite with a single revision (SPEC §1); the protection of
//! an encrypted document is kept.

use super::params;
use crate::registry::Registry;
use crate::{CoreError, Document, Reply};
use serde::Deserialize;
use serde_json::{json, Value};
use warraq_pdf::revisions;
use warraq_redact::apply::{apply_and_rewrite, ApplyOptions, Area};
use warraq_redact::find::{find, FindOptions};
use warraq_redact::patterns::Kind;
use warraq_redact::sanitize::{sanitize_and_rewrite, SanitizeOptions};
use warraq_redact::RedactError;
use warraq_text::geom::Rect;

pub fn register(r: &mut Registry) {
    r.doc("redact.find", find_m)
        .doc("redact.apply", apply_m)
        .doc("redact.sanitize", sanitize_m);
}

fn err(e: RedactError) -> CoreError {
    CoreError::new(e.code(), e.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Find {
    query: Option<String>,
    #[serde(default)]
    patterns: Vec<Kind>,
    regex: Option<String>,
    pages: Option<Vec<usize>>,
}

fn find_m(doc: &mut Document, p: &Value, _b: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let p: Find = params(p)?;
    if p.patterns
        .iter()
        .any(|k| matches!(k, Kind::Query | Kind::Custom))
    {
        return Err(CoreError::params(
            "patterns are email, phone, saudiId, iban, card, date",
        ));
    }
    let r = find(
        doc.pdf(),
        &FindOptions {
            query: p.query,
            patterns: p.patterns,
            regex: p.regex,
            pages: p.pages,
        },
    )
    .map_err(err)?;
    serde_json::to_value(&r)
        .map(Reply::json)
        .map_err(|e| CoreError::new("internal", e.to_string()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AreaParam {
    page: usize,
    /// User space `[x0, y0, x1, y1]`.
    rect: [f64; 4],
    /// Fill colour; `null` = no box; absent = the default fill.
    #[serde(default, deserialize_with = "some_option")]
    fill: Option<Option<[f64; 3]>>,
    overlay: Option<String>,
}

fn some_option<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<Option<[f64; 3]>>, D::Error> {
    Option::<[f64; 3]>::deserialize(d).map(Some)
}

fn yes() -> bool {
    true
}

fn black() -> Option<[f64; 3]> {
    Some([0.0, 0.0, 0.0])
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Apply {
    #[serde(default)]
    areas: Vec<AreaParam>,
    /// Apply the document's /Redact annotations (EmbedPDF's marks).
    #[serde(default = "yes")]
    annotations: bool,
    #[serde(default = "black")]
    fill: Option<[f64; 3]>,
    overlay_text: Option<String>,
    #[serde(default = "yes")]
    remove_annotations: bool,
    #[serde(default = "yes")]
    scrub: bool,
}

fn apply_m(doc: &mut Document, p: &Value, blobs: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let p: Apply = params(p)?;
    if p.areas.len() > 100_000 {
        return Err(CoreError::params("too many areas"));
    }
    let opts = ApplyOptions {
        areas: p
            .areas
            .into_iter()
            .map(|a| Area {
                page: a.page,
                rect: Rect::new(a.rect[0], a.rect[1], a.rect[2], a.rect[3]),
                fill: a.fill,
                overlay: a.overlay,
            })
            .collect(),
        use_annotations: p.annotations,
        fill: p.fill,
        overlay_text: p.overlay_text,
        font: blobs.into_iter().next().filter(|b| !b.is_empty()),
        remove_annotations: p.remove_annotations,
        scrub: p.scrub,
    };
    let (bytes, report) = apply_and_rewrite(doc.pdf_mut(), &opts).map_err(err)?;
    doc.pdf_mut().replace_bytes(bytes.clone(), None)?;
    let revs = revisions::revisions(doc.pdf().bytes(), doc.pdf().limits()).len();
    Ok(Reply::with_blob(
        json!({ "byteLength": bytes.len(), "revisions": revs, "report": report }),
        bytes,
    ))
}

fn sanitize_m(doc: &mut Document, p: &Value, _b: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let o: SanitizeOptions = params(p)?;
    let (bytes, report) = sanitize_and_rewrite(doc.pdf_mut(), &o).map_err(err)?;
    doc.pdf_mut().replace_bytes(bytes.clone(), None)?;
    let revs = revisions::revisions(doc.pdf().bytes(), doc.pdf().limits()).len();
    Ok(Reply::with_blob(
        json!({ "byteLength": bytes.len(), "revisions": revs, "report": report }),
        bytes,
    ))
}
