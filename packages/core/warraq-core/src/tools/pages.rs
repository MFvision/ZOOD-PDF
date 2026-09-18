//! Organize pages and Combine files: rotate, reorder, delete, insert a blank
//! page or another file's pages, extract pages into a new file, combine files. The page structure is
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

#[derive(Deserialize)]
struct InsertFile {
    /// 0 puts the pages first, the page count last.
    at: usize,
    /// The inserted file's, when it has one.
    #[serde(default)]
    password: Option<String>,
}

#[derive(Deserialize, Default, Clone, Copy)]
struct Margins {
    #[serde(default)]
    top: f32,
    #[serde(default)]
    right: f32,
    #[serde(default)]
    bottom: f32,
    #[serde(default)]
    left: f32,
}

#[derive(Deserialize)]
struct Crop {
    pages: Vec<usize>,
    /// Points to cut from each edge, as the page is shown.
    margins: Margins,
}

#[derive(Deserialize)]
struct Trim {
    pages: Vec<usize>,
    /// Points of white kept around what is printed.
    #[serde(default = "default_padding")]
    padding: f32,
}

fn default_padding() -> f32 {
    6.0
}

/// A pixel with ink on it: any channel darker than paper.
const INK: u8 = 245;
/// Pixels per point when looking for a page's ink: fine enough for margins.
const TRIM_SCALE: f32 = 1.0;

/// The margins of white around what page `index` prints, less `padding`, as
/// the page is shown. `None` for a page with nothing on it.
fn white_margins(
    doc: &Document,
    index: usize,
    padding: f32,
) -> Result<Option<warraq_pdf::Margins>, CoreError> {
    let page = doc.render_page(index, TRIM_SCALE)?;
    let (w, h) = (page.width as usize, page.height as usize);
    let (mut x0, mut y0, mut x1, mut y1) = (usize::MAX, usize::MAX, 0, 0);
    for y in 0..h {
        for x in 0..w {
            let p = &page.rgba[(y * w + x) * 4..(y * w + x) * 4 + 3];
            if p.iter().any(|c| *c < INK) {
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x);
                y1 = y1.max(y);
            }
        }
    }
    if x0 == usize::MAX {
        return Ok(None);
    }
    let (sw, sh) = doc.page_size(index)?;
    // Pixels back to points, on the page's own scale.
    let (kx, ky) = (sw / w.max(1) as f32, sh / h.max(1) as f32);
    let keep = |v: f32| (v - padding).max(0.0);
    Ok(Some(warraq_pdf::Margins {
        left: keep(x0 as f32 * kx),
        top: keep(y0 as f32 * ky),
        right: keep((w - 1 - x1) as f32 * kx),
        bottom: keep((h - 1 - y1) as f32 * ky),
    }))
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
    blobs: Vec<Vec<u8>>,
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
        "crop" => {
            let a: Crop = args(json)?;
            let Margins {
                top,
                right,
                bottom,
                left,
            } = a.margins;
            doc.pdf_mut().crop_pages(
                &a.pages,
                warraq_pdf::Margins {
                    top,
                    right,
                    bottom,
                    left,
                },
            )?;
        }
        "trim_margins" => {
            let a: Trim = args(json)?;
            // Measured before any is cropped: each page by its own ink.
            let mut cuts = Vec::new();
            for &index in &a.pages {
                if let Some(margins) = white_margins(doc, index, a.padding)? {
                    cuts.push((index, margins));
                }
            }
            for (index, margins) in cuts {
                doc.pdf_mut().crop_pages(&[index], margins)?;
            }
        }
        "insert_file" => {
            let a: InsertFile = args(json)?;
            let bytes = blobs.into_iter().next().ok_or_else(|| {
                CoreError::Args("pages.insert_file needs the file's bytes".into())
            })?;
            let other = warraq_pdf::PdfDocument::open(bytes, a.password.as_deref())?;
            doc.pdf_mut().insert_document(&other, a.at)?;
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
