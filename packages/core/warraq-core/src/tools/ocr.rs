//! Scan & OCR: the text layer. Recognition happens in the interface
//! (Tesseract); this writes what it read into the file as invisible, shaped
//! text (`warraq_pdf::ocr`), as an incremental update — sealed with the file's
//! own key when it is protected. A cleaned-up scan can take the place of the
//! page's picture, and a corrected reading the place of an earlier layer.
use serde::{Deserialize, Serialize};

use super::{args, Reply};
use crate::CoreError;

#[derive(Deserialize, Serialize, Clone)]
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
    /// Take out Warraq's earlier layer on the page and write this one instead.
    #[serde(default)]
    replace: bool,
    /// Index into the blobs of the cleaned-up page (PNG or JPEG), the whole
    /// page as shown, straightened by `angle`, to replace the page's scan.
    #[serde(default)]
    image: Option<usize>,
}

#[derive(Deserialize)]
struct AddTextLayer {
    #[serde(default)]
    password: Option<String>,
    pages: Vec<Page>,
    /// When the layer was written, as a PDF date (the core has no clock).
    #[serde(default)]
    modified: Option<String>,
}

#[derive(Deserialize)]
struct LayerWords {
    #[serde(default)]
    password: Option<String>,
    /// Zero-based; all pages when absent.
    #[serde(default)]
    pages: Option<Vec<usize>>,
}

#[derive(Serialize)]
struct KeptPage {
    index: usize,
    angle: f32,
    words: Vec<Word>,
}

/// A PDF date as the interface sends it, or none: `D:` and digits, a zone.
fn pdf_date(date: Option<&str>) -> &str {
    match date {
        Some(d)
            if d.len() <= 32
                && d.starts_with("D:")
                && d[2..]
                    .chars()
                    .all(|c| c.is_ascii_digit() || matches!(c, 'Z' | '+' | '-' | '\'')) =>
        {
            d
        }
        _ => "D:20000101000000Z",
    }
}

pub fn call_static(name: &str, json: &str, blobs: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    match name {
        // blobs: the PDF, then the face to write with (a bundled one), then
        // the cleaned-up pages the `image` indices point at.
        "add_text_layer" => {
            let a: AddTextLayer = args(json)?;
            let mut blobs = blobs.into_iter();
            let (Some(pdf), Some(font)) = (blobs.next(), blobs.next()) else {
                return Err(CoreError::Args(
                    "ocr.add_text_layer takes the PDF and a font".into(),
                ));
            };
            let mut pictures: Vec<Option<Vec<u8>>> = blobs.map(Some).collect();
            let mut doc = warraq_pdf::PdfDocument::open(pdf.clone(), a.password.as_deref())?;
            let mut pages = Vec::with_capacity(a.pages.len());
            for p in a.pages {
                let image = match p.image {
                    Some(k) => {
                        Some(pictures.get_mut(k).and_then(Option::take).ok_or_else(|| {
                            CoreError::Args(format!("ocr.add_text_layer: no picture {k}"))
                        })?)
                    }
                    None => None,
                };
                pages.push(warraq_pdf::OcrPage {
                    index: p.index,
                    angle: p.angle,
                    replace: p.replace,
                    image,
                    words: p
                        .words
                        .into_iter()
                        .map(|w| warraq_pdf::OcrWord {
                            text: w.text,
                            bbox: w.bbox,
                        })
                        .collect(),
                });
            }
            let report = doc.add_text_layer_at(&pages, &font, pdf_date(a.modified.as_deref()))?;
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
                "images": report.images,
                "imagesKept": report.images_kept,
            }))?
            .with_blob(bytes))
        }
        // blobs: the PDF. The words of the layers Warraq wrote, as kept with
        // their pages: what an OCR correction starts from.
        "layer_words" => {
            let a: LayerWords = args(json)?;
            let Some(pdf) = blobs.into_iter().next() else {
                return Err(CoreError::Args("ocr.layer_words takes the PDF".into()));
            };
            let doc = warraq_pdf::PdfDocument::open(pdf, a.password.as_deref())?;
            let count = doc.page_count();
            let wanted: Vec<usize> = match a.pages {
                Some(pages) => pages.into_iter().filter(|p| *p < count).collect(),
                None => (0..count).collect(),
            };
            let mut pages = Vec::new();
            for index in wanted {
                if let Some(page) = doc.ocr_layer_words(index)? {
                    pages.push(KeptPage {
                        index,
                        angle: page.angle,
                        words: page
                            .words
                            .into_iter()
                            .map(|w| Word {
                                text: w.text,
                                bbox: w.bbox,
                            })
                            .collect(),
                    });
                }
            }
            Reply::of(&serde_json::json!({ "pages": pages }))
        }
        _ => Err(CoreError::UnknownOp(format!("ocr.{name}"))),
    }
}
