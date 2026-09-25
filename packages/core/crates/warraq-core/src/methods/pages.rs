//! `pages.*`: the Organize tool. Page indices are 0-based. Every mutating method commits an
//! incremental update and returns the new file as `blobs[0]`.

use super::doc::commit_reply;
use super::{blob0, params};
use crate::registry::Registry;
use crate::{CoreError, Document, Reply};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use warraq_pdf::{pages, Pdf};

pub fn register(r: &mut Registry) {
    r.doc("pages.rotate", rotate)
        .doc("pages.move", move_pages)
        .doc("pages.delete", delete)
        .doc("pages.insertBlank", insert_blank)
        .doc("pages.insertFrom", insert_from)
        .doc("pages.extract", extract)
        .doc("pages.crop", crop);
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Rotate {
    pages: Vec<usize>,
    degrees: i64,
}

fn rotate(doc: &mut Document, p: &Value, _b: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let p: Rotate = params(p)?;
    pages::rotate(doc.pdf_mut(), &p.pages, p.degrees)?;
    commit_reply(doc, Map::new())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Move {
    /// Full new order: `order[k]` = old index of the page that becomes page k.
    order: Option<Vec<usize>>,
    /// Alternatively: pages to move …
    pages: Option<Vec<usize>>,
    /// … and the index they move to (in the document without them).
    to: Option<usize>,
}

fn move_pages(doc: &mut Document, p: &Value, _b: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let p: Move = params(p)?;
    match (p.order, p.pages, p.to) {
        (Some(order), None, None) => pages::reorder(doc.pdf_mut(), &order)?,
        (None, Some(list), Some(to)) => pages::move_to(doc.pdf_mut(), &list, to)?,
        _ => return Err(CoreError::params("give either `order` or `pages` + `to`")),
    }
    commit_reply(doc, Map::new())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PageList {
    pages: Vec<usize>,
}

fn delete(doc: &mut Document, p: &Value, _b: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let p: PageList = params(p)?;
    pages::delete(doc.pdf_mut(), &p.pages)?;
    commit_reply(doc, Map::new())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InsertBlank {
    at: usize,
    /// Points; default: the size of the page before `at` (or A4).
    width: Option<f64>,
    height: Option<f64>,
    #[serde(default = "one")]
    count: usize,
}

fn one() -> usize {
    1
}

fn insert_blank(doc: &mut Document, p: &Value, _b: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let p: InsertBlank = params(p)?;
    if p.count == 0 || p.count > 1000 {
        return Err(CoreError::params("count must be 1–1000"));
    }
    let list = pages::flatten(doc.pdf())?;
    let neighbour = list
        .get(p.at.saturating_sub(1))
        .or(list.first())
        .map(|pg| pg.size());
    let (w, h) = match (p.width, p.height, neighbour) {
        (Some(w), Some(h), _) => (w, h),
        (None, None, Some(s)) => s,
        (None, None, None) => (595.276, 841.89),
        _ => return Err(CoreError::params("give both width and height, or neither")),
    };
    for k in 0..p.count {
        pages::insert_blank(doc.pdf_mut(), p.at + k, w, h)?;
    }
    commit_reply(doc, Map::new())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InsertFrom {
    at: usize,
    /// Pages of the source to insert (default: all).
    pages: Option<Vec<usize>>,
    /// Password of the source document.
    password: Option<String>,
}

fn insert_from(doc: &mut Document, p: &Value, blobs: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let p: InsertFrom = params(p)?;
    let src = Pdf::open(blob0(blobs, "the PDF to insert")?, p.password.as_deref())?;
    let list = match p.pages {
        Some(l) => l,
        None => (0..pages::count(&src)?).collect(),
    };
    let ids = pages::insert_from(doc.pdf_mut(), &src, &list, p.at)?;
    let mut extra = Map::new();
    extra.insert("inserted".into(), json!(ids.len()));
    commit_reply(doc, extra)
}

fn extract(doc: &mut Document, p: &Value, _b: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let p: PageList = params(p)?;
    let bytes = pages::extract(doc.pdf(), &p.pages)?;
    Ok(Reply::with_blob(
        json!({ "byteLength": bytes.len(), "pageCount": p.pages.len() }),
        bytes,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Crop {
    pages: Vec<usize>,
    /// `[x0, y0, x1, y1]` in PDF points.
    #[serde(rename = "box")]
    rect: [f64; 4],
}

fn crop(doc: &mut Document, p: &Value, _b: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let p: Crop = params(p)?;
    pages::crop(doc.pdf_mut(), &p.pages, p.rect)?;
    commit_reply(doc, Map::new())
}
