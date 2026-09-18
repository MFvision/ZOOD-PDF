//! Scan & OCR: the text layer. Recognition happens in the interface
//! (Tesseract); this writes what it read into the file as invisible, shaped
//! text (`warraq_pdf::ocr`), as an incremental update — sealed with the file's
//! own key when it is protected.
use serde::Deserialize;

use super::{args, Reply};
use crate::CoreError;

#[derive(Deserialize)]
struct Word {
    text: String,
    /// `[x0, top, x1, bottom]` in points from the page's top-left, as shown.
    bbox: [f32; 4],
}

#[derive(Deserialize)]
struct Page {
    index: usize,
    words: Vec<Word>,
    /// Degrees counter-clockwise the scan is turned; its words' boxes are in
    /// the page straightened by it.
    #[serde(default)]
    angle: f32,
}

#[derive(Deserialize)]
struct AddTextLayer {
    #[serde(default)]
    password: Option<String>,
    pages: Vec<Page>,
}

pub fn call_static(name: &str, json: &str, blobs: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    match name {
        // blobs: the PDF, then the face to write with (a bundled one).
        "add_text_layer" => {
            let a: AddTextLayer = args(json)?;
            let mut blobs = blobs.into_iter();
            let (Some(pdf), Some(font)) = (blobs.next(), blobs.next()) else {
                return Err(CoreError::Args(
                    "ocr.add_text_layer takes the PDF and a font".into(),
                ));
            };
            let mut doc = warraq_pdf::PdfDocument::open(pdf.clone(), a.password.as_deref())?;
            let pages: Vec<warraq_pdf::OcrPage> = a
                .pages
                .into_iter()
                .map(|p| warraq_pdf::OcrPage {
                    index: p.index,
                    angle: p.angle,
                    words: p
                        .words
                        .into_iter()
                        .map(|w| warraq_pdf::OcrWord {
                            text: w.text,
                            bbox: w.bbox,
                        })
                        .collect(),
                })
                .collect();
            let report = doc.add_text_layer(&pages, &font)?;
            let bytes = if report.pages == 0 {
                pdf
            } else {
                match doc.save_incremental() {
                    Ok(bytes) => bytes,
                    // Never trade a file's protection for its text layer.
                    Err(e) if doc.was_encrypted() => return Err(e.into()),
                    Err(_) => doc.save_to_vec()?,
                }
            };
            Ok(Reply::of(&serde_json::json!({
                "pages": report.pages,
                "words": report.words,
                "skipped": report.skipped,
            }))?
            .with_blob(bytes))
        }
        _ => Err(CoreError::UnknownOp(format!("ocr.{name}"))),
    }
}
