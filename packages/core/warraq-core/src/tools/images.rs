//! Edit PDF, pictures: list the pictures of a page with where they land,
//! then place, move, resize, turn, crop, replace and delete them
//! (`warraq_pdf::images`). On the open document, like text edits; `list` is
//! also static, to read a saved file.
use serde::Deserialize;
use warraq_pdf::{PdfDocument, PlacedImage};

use super::{args, Reply};
use crate::{CoreError, Document};

#[derive(Deserialize)]
struct Page {
    page: usize,
}

#[derive(Deserialize)]
struct Place {
    page: usize,
    /// Where the unit square lands, on the page as shown (points, y down).
    matrix: [f32; 6],
}

#[derive(Deserialize)]
struct Change {
    page: usize,
    id: String,
    #[serde(default)]
    matrix: Option<[f32; 6]>,
    #[serde(default)]
    clip: Option<[f32; 4]>,
}

#[derive(Deserialize)]
struct Saved {
    #[serde(default)]
    password: Option<String>,
    page: usize,
}

fn json(images: Vec<PlacedImage>) -> serde_json::Value {
    let images: Vec<serde_json::Value> = images
        .into_iter()
        .map(|i| {
            serde_json::json!({
                "id": i.id,
                "matrix": i.matrix,
                "clip": i.clip,
                "pixels": [i.pixels.0, i.pixels.1],
                "inline": i.inline,
                "inForm": i.in_form,
                "shared": i.shared,
            })
        })
        .collect();
    serde_json::json!({ "images": images })
}

fn picture(blobs: Vec<Vec<u8>>, op: &str) -> Result<Vec<u8>, CoreError> {
    blobs
        .into_iter()
        .next()
        .ok_or_else(|| CoreError::Args(format!("images.{op} takes the picture")))
}

pub fn call(
    doc: &mut Document,
    name: &str,
    json_args: &str,
    blobs: Vec<Vec<u8>>,
) -> Result<Reply, CoreError> {
    match name {
        "list" => {
            let a: Page = args(json_args)?;
            Reply::of(&json(doc.pdf_mut().list_images(a.page)?))
        }
        "add" => {
            let a: Place = args(json_args)?;
            let bytes = picture(blobs, name)?;
            let id = doc.pdf_mut().add_image(a.page, a.matrix, &bytes)?;
            doc.refresh_after_edit()?;
            Reply::of(&serde_json::json!({ "id": id }))
        }
        "transform" => {
            let a: Change = args(json_args)?;
            let matrix = a
                .matrix
                .ok_or_else(|| CoreError::Args("images.transform takes a matrix".into()))?;
            doc.pdf_mut()
                .transform_image(a.page, &a.id, matrix, a.clip)?;
            doc.refresh_after_edit()?;
            Reply::of(&json(doc.pdf_mut().list_images(a.page)?))
        }
        "replace" => {
            let a: Change = args(json_args)?;
            let bytes = picture(blobs, name)?;
            doc.pdf_mut().replace_image(a.page, &a.id, &bytes)?;
            doc.refresh_after_edit()?;
            Reply::of(&json(doc.pdf_mut().list_images(a.page)?))
        }
        "delete" => {
            let a: Change = args(json_args)?;
            doc.pdf_mut().delete_image(a.page, &a.id)?;
            doc.refresh_after_edit()?;
            Reply::of(&json(doc.pdf_mut().list_images(a.page)?))
        }
        _ => Err(CoreError::UnknownOp(format!("images.{name}"))),
    }
}

pub fn call_static(name: &str, json_args: &str, blobs: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    match name {
        // The pictures of a saved file, without opening it in the editor.
        "list" => {
            let a: Saved = args(json_args)?;
            let pdf = blobs
                .into_iter()
                .next()
                .ok_or_else(|| CoreError::Args("images.list takes the PDF".into()))?;
            let doc = PdfDocument::open(pdf, a.password.as_deref())?;
            Reply::of(&json(doc.list_images(a.page)?))
        }
        _ => Err(CoreError::UnknownOp(format!("images.{name}"))),
    }
}
