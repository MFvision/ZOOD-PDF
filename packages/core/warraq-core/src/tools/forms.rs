//! Form fields and comments (ADR-0007). PDFium stores Arabic typed into a
//! field or a text box but draws nothing for it in the saved file; Warraq's
//! shaping draws it before the file leaves the app.
use serde::Deserialize;

use super::{args, Reply};
use crate::CoreError;

#[derive(Deserialize, Default)]
struct FixAppearances {
    /// The file's open password, when it has one: the fix is an incremental
    /// update, sealed with the same key.
    #[serde(default)]
    password: Option<String>,
}

pub fn call_static(name: &str, json: &str, blobs: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    match name {
        // blobs: the PDF, then the face to draw with (a bundled one).
        "fix_appearances" => {
            let a: FixAppearances = args(json)?;
            let mut blobs = blobs.into_iter();
            let (Some(pdf), Some(font)) = (blobs.next(), blobs.next()) else {
                return Err(CoreError::Args(
                    "forms.fix_appearances takes the PDF and a font".into(),
                ));
            };
            let mut doc = warraq_pdf::PdfDocument::open(pdf.clone(), a.password.as_deref())?;
            let report = doc.fix_arabic_appearances(&font)?;
            let answer = |fixed: bool| {
                serde_json::json!({
                    "fields": if fixed { report.fields } else { 0 },
                    "comments": if fixed { report.comments } else { 0 },
                })
            };
            if report.fields + report.comments == 0 {
                return Ok(Reply::of(&answer(false))?.with_blob(pdf));
            }
            let bytes = match doc.save_incremental() {
                Ok(bytes) => bytes,
                // Never trade a file's protection for its appearances.
                Err(_) if doc.was_encrypted() => {
                    return Ok(Reply::of(&answer(false))?.with_blob(pdf));
                }
                Err(_) => doc.save_to_vec()?,
            };
            Ok(Reply::of(&answer(true))?.with_blob(bytes))
        }
        _ => Err(CoreError::UnknownOp(format!("forms.{name}"))),
    }
}
