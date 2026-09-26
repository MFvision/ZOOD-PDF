//! `ocr.*`: the Scan & OCR tool.
//!
//! * `ocr.addTextLayer { page, words: [{ text, bbox: [x0,y0,x1,y1], conf? }], imageWidth?,
//!   imageHeight?, imageDpi?, angle?, rotation?, minConf?, commit? }` — invisible text over the
//!   page image (incremental update). `bbox` is in pixels of the recognised image (y down);
//!   `angle` is the counter-clockwise skew (degrees) of the content in the page image when the
//!   recognised image was deskewed. `commit: false` keeps the change pending for `doc.save`
//!   (several pages → one update).
//! * `ocr.createPdf { pages: [{ image: { format: "jpeg"|"gray", blob, pixelWidth?, pixelHeight? },
//!   imageDpi, words, angle?, minConf? }], title?, lang? }` (static) — a new PDF from images.

use super::doc::commit_reply;
use super::params;
use crate::ocr::{add_text_layer, create_pdf, CreateParams, ImageFrame, OcrWord};
use crate::registry::Registry;
use crate::{CoreError, Document, Reply};
use serde::Deserialize;
use serde_json::{json, Map, Value};

pub fn register(r: &mut Registry) {
    r.doc("ocr.addTextLayer", add_layer)
        .static_fn("ocr.createPdf", create);
}

fn yes() -> bool {
    true
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AddLayer {
    page: usize,
    words: Vec<OcrWord>,
    image_width: Option<f64>,
    image_height: Option<f64>,
    image_dpi: Option<f64>,
    #[serde(default)]
    angle: f64,
    rotation: Option<i64>,
    #[serde(default)]
    min_conf: f64,
    #[serde(default = "yes")]
    commit: bool,
}

fn add_layer(doc: &mut Document, p: &Value, _b: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let p: AddLayer = params(p)?;
    let frame = ImageFrame {
        width: p.image_width,
        height: p.image_height,
        dpi: p.image_dpi,
        angle: p.angle,
        rotation: p.rotation,
    };
    let stats = add_text_layer(doc.pdf_mut(), p.page, &frame, &p.words, p.min_conf)?;
    let mut extra = Map::new();
    extra.insert("words".into(), json!(stats.words));
    extra.insert("skipped".into(), json!(stats.skipped));
    if p.commit {
        commit_reply(doc, extra)
    } else {
        extra.insert("committed".into(), json!(false));
        Ok(Reply::json(Value::Object(extra)))
    }
}

fn create(p: &Value, blobs: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let p: CreateParams = params(p)?;
    let n = p.pages.len();
    let bytes = create_pdf(&p, blobs)?;
    Ok(Reply::with_blob(
        json!({ "pageCount": n, "byteLength": bytes.len() }),
        bytes,
    ))
}
