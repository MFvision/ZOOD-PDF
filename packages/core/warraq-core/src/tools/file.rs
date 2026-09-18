//! Saving: another engine's whole rewrite of a file, kept as an update of
//! the file's own bytes (`warraq_pdf::rebase`) — so what was signed stays
//! signed, and what was not changed is not rewritten.
use serde::Deserialize;

use super::{args, Reply};
use crate::CoreError;

#[derive(Deserialize, Default)]
struct Rebase {
    #[serde(default)]
    password: Option<String>,
}

pub fn call_static(name: &str, json: &str, blobs: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    match name {
        // blobs: the file as it was opened, then the same file written whole.
        "rebase" => {
            let a: Rebase = args(json)?;
            let mut blobs = blobs.into_iter();
            let (Some(original), Some(rewritten)) = (blobs.next(), blobs.next()) else {
                return Err(CoreError::Args(
                    "file.rebase takes the file and its rewrite".into(),
                ));
            };
            let mut doc = warraq_pdf::PdfDocument::open(original, a.password.as_deref())?;
            Ok(match doc.rebase(rewritten, a.password.as_deref())? {
                Some(bytes) => Reply::of(&serde_json::json!({ "rebased": true }))?.with_blob(bytes),
                None => Reply::of(&serde_json::json!({ "rebased": false }))?,
            })
        }
        _ => Err(CoreError::UnknownOp(format!("file.{name}"))),
    }
}
