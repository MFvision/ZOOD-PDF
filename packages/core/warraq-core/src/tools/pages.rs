//! Organize pages and Combine files: rotate, reorder, delete, insert a blank
//! page, extract pages into a new file, combine files. The page structure is
//! edited in Warraq's object layer (`warraq_pdf::pages`), so every change is an
//! incremental update of the open file; extract and combine write new files.
use serde::{Deserialize, Serialize};

use super::{args, Reply};
use crate::{CoreError, Document};

#[derive(Deserialize)]
struct Pages {
    pages: Vec<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Rotate {
    pages: Vec<usize>,
    /// 1 is 90° clockwise, -1 counter-clockwise.
    quarter_turns: i32,
}

#[derive(Deserialize)]
struct Reorder {
    /// `order[k]` is the current index of the page that becomes page `k`.
    order: Vec<usize>,
}

#[derive(Deserialize)]
struct InsertBlank {
    /// 0 puts it first, the page count last.
    at: usize,
    /// The page whose size and rotation it takes.
    like: usize,
}

#[derive(Deserialize, Default)]
struct Combine {
    /// One per file, in order; null for a file without a password.
    #[serde(default)]
    passwords: Vec<Option<String>>,
}

/// The document's shape after a change, which is what the UI needs to redraw.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Shape {
    pub page_count: usize,
    pub page_sizes: Vec<[f32; 2]>,
}

fn shape(doc: &Document) -> Result<Shape, CoreError> {
    let page_sizes = (0..doc.page_count())
        .map(|i| doc.page_size(i).map(|(w, h)| [w, h]))
        .collect::<Result<_, _>>()?;
    Ok(Shape {
        page_count: doc.page_count(),
        page_sizes,
    })
}

pub fn call(
    doc: &mut Document,
    name: &str,
    json: &str,
    _blobs: Vec<Vec<u8>>,
) -> Result<Reply, CoreError> {
    match name {
        "rotate" => {
            let a: Rotate = args(json)?;
            doc.pdf_mut().rotate_pages(&a.pages, a.quarter_turns)?;
        }
        "reorder" => {
            let a: Reorder = args(json)?;
            doc.pdf_mut().reorder_pages(&a.order)?;
        }
        "delete" => {
            let a: Pages = args(json)?;
            doc.pdf_mut().delete_pages(&a.pages)?;
        }
        "insert_blank" => {
            let a: InsertBlank = args(json)?;
            doc.pdf_mut().insert_blank_page(a.at, a.like)?;
        }
        "extract" => {
            let a: Pages = args(json)?;
            let bytes = doc.pdf.extract_pages(&a.pages)?;
            return Ok(
                Reply::of(&serde_json::json!({ "pageCount": a.pages.len() }))?.with_blob(bytes),
            );
        }
        _ => return Err(CoreError::UnknownOp(format!("pages.{name}"))),
    }
    doc.refresh_after_edit()?;
    Reply::of(&shape(doc)?)
}

pub fn call_static(name: &str, json: &str, blobs: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    match name {
        "combine" => {
            let a: Combine = args(json)?;
            let inputs = blobs
                .into_iter()
                .enumerate()
                .map(|(i, bytes)| (bytes, a.passwords.get(i).cloned().flatten()))
                .collect();
            let bytes = warraq_pdf::combine(inputs)?;
            let pages = warraq_pdf::PdfDocument::open(bytes.clone(), None)?.page_count();
            Ok(Reply::of(&serde_json::json!({ "pageCount": pages }))?.with_blob(bytes))
        }
        _ => Err(CoreError::UnknownOp(format!("pages.{name}"))),
    }
}
