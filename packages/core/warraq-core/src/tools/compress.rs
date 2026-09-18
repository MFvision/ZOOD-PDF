//! Compress: a smaller copy of the file (see `warraq_pdf::compress`). A new
//! file, written from scratch; the open one is not changed.
use serde::Deserialize;

use super::{args, Reply};
use crate::CoreError;

fn default_quality() -> u8 {
    75
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Compress {
    #[serde(default)]
    password: Option<String>,
    /// Downsample images to this resolution; absent keeps them as they are.
    #[serde(default)]
    image_dpi: Option<f32>,
    #[serde(default = "default_quality")]
    jpeg_quality: u8,
}

pub fn call_static(name: &str, json: &str, blobs: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    match name {
        "file" => {
            let a: Compress = args(json)?;
            let Some(pdf) = blobs.into_iter().next() else {
                return Err(CoreError::Args("compress.file takes the PDF".into()));
            };
            let before = pdf.len();
            let doc = warraq_pdf::PdfDocument::open(pdf, a.password.as_deref())?;
            if let Some(refusal) = doc.compress_refusal() {
                return Reply::of(&serde_json::json!({ "refused": refusal.to_string() }));
            }
            let options = warraq_pdf::CompressOptions {
                image_dpi: a.image_dpi,
                jpeg_quality: a.jpeg_quality,
            };
            let (bytes, report) = doc.compressed(&options)?;
            Ok(Reply::of(&serde_json::json!({
                "before": before,
                "after": bytes.len(),
                "unused": report.unused,
                "duplicates": report.duplicates,
                "recompressed": report.recompressed,
                "images": report.images,
                "unchanged": report.unchanged,
            }))?
            .with_blob(bytes))
        }
        _ => Err(CoreError::UnknownOp(format!("compress.{name}"))),
    }
}
