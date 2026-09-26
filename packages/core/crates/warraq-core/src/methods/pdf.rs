//! Static `pdf.*` methods (no open document) and `methods.list`.

use super::{blob0, params};
use crate::registry::{registry, Registry};
use crate::{CoreError, Reply};
use serde::Deserialize;
use serde_json::{json, Value};
use warraq_pdf::{pages, Pdf, PdfError};

pub fn register(r: &mut Registry) {
    r.static_fn("pdf.isEncrypted", is_encrypted)
        .static_fn("pdf.merge", merge)
        .static_fn("methods.list", list);
}

fn is_encrypted(_p: &Value, blobs: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let bytes = blob0(blobs, "a PDF")?;
    let (encrypted, needs_password) = match Pdf::open(bytes, None) {
        Ok(pdf) => (pdf.is_encrypted(), false),
        Err(PdfError::PasswordRequired) => (true, true),
        Err(e) => return Err(e.into()),
    };
    Ok(Reply::json(
        json!({ "encrypted": encrypted, "needsPassword": needs_password }),
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Merge {
    /// Optional password per blob (null for none).
    #[serde(default)]
    passwords: Vec<Option<String>>,
    /// Optional bookmark title per blob (usually the file name): each file's pages get one
    /// top-level bookmark with the file's own bookmarks nested under it.
    #[serde(default)]
    titles: Vec<Option<String>>,
}

fn merge(p: &Value, blobs: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let p: Merge = params(p)?;
    if blobs.len() < 2 {
        return Err(CoreError::params(
            "pdf.merge needs at least two PDFs in blobs",
        ));
    }
    let docs = blobs
        .into_iter()
        .enumerate()
        .map(|(i, b)| {
            let pw = p.passwords.get(i).cloned().flatten();
            Pdf::open(b, pw.as_deref())
                .map_err(|e| CoreError::new(e.code(), format!("file {}: {e}", i + 1)))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let titled: Vec<(&Pdf, Option<String>)> = docs
        .iter()
        .enumerate()
        .map(|(i, d)| (d, p.titles.get(i).cloned().flatten()))
        .collect();
    let out = pages::merge_titled(&titled)?;
    let n = pages::count(&Pdf::open(out.clone(), None)?)?;
    Ok(Reply::with_blob(
        json!({ "byteLength": out.len(), "pageCount": n }),
        out,
    ))
}

fn list(_p: &Value, _b: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let r = registry();
    Ok(Reply::json(
        json!({ "document": r.doc_names(), "static": r.static_names() }),
    ))
}
