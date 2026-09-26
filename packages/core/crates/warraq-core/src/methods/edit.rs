//! `edit.*`: the Edit tool (warraq-edit). Text blocks (replace with reflow, add), pictures
//! (move/resize/rotate/crop/replace/delete/add), links (list/add/update/delete) and the static
//! link check `edit.checkUrl`. Mutating methods need the modify permission, commit one
//! incremental update and return the new file as `blobs[0]`; a failed edit leaves the document
//! exactly as it was.

use super::doc::commit_reply;
use crate::registry::Registry;
use crate::{CoreError, Document, Reply};
use serde_json::{Map, Value};
use warraq_edit::api;

fn err(e: warraq_edit::EditError) -> CoreError {
    CoreError::new(e.code(), e.to_string())
}

fn run(
    doc: &mut Document,
    method: &str,
    mutating: bool,
    p: &Value,
    blobs: Vec<Vec<u8>>,
) -> Result<Reply, CoreError> {
    if mutating {
        doc.pdf().require("editing content", |f| f.modify)?;
    }
    let res = api::call(doc.pdf_mut(), method, p, &blobs)
        .ok_or_else(|| CoreError::new("unknown_method", method.to_string()))?;
    match res {
        Ok(v) if mutating => {
            let extra = match v {
                Value::Object(m) => m,
                _ => Map::new(),
            };
            commit_reply(doc, extra)
        }
        Ok(v) => Ok(Reply::json(v)),
        Err(e) => {
            if mutating && doc.pdf().has_changes() {
                // Drop half-made objects: reload the last committed bytes.
                let bytes = doc.pdf().bytes().to_vec();
                let pw = doc.pdf().password().to_string();
                doc.pdf_mut().replace_bytes(bytes, Some(&pw))?;
            }
            Err(err(e))
        }
    }
}

macro_rules! methods {
    ($(($f:ident, $name:literal, $mutating:expr)),* $(,)?) => {
        $(fn $f(d: &mut Document, p: &Value, b: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
            run(d, $name, $mutating, p, b)
        })*
        pub fn register(r: &mut Registry) {
            $(r.doc($name, $f);)*
            r.static_fn("edit.checkUrl", check_url);
        }
    };
}

methods![
    (text_blocks, "edit.textBlocks", false),
    (replace_text, "edit.replaceText", true),
    (add_text, "edit.addText", true),
    (images, "edit.images", false),
    (image_transform, "edit.imageTransform", true),
    (image_crop, "edit.imageCrop", true),
    (image_replace, "edit.imageReplace", true),
    (image_delete, "edit.imageDelete", true),
    (image_add, "edit.imageAdd", true),
    (links, "edit.links", false),
    (link_add, "edit.linkAdd", true),
    (link_update, "edit.linkUpdate", true),
    (link_delete, "edit.linkDelete", true),
];

fn check_url(p: &Value, _b: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    match api::call_static("edit.checkUrl", p) {
        Some(Ok(v)) => Ok(Reply::json(v)),
        Some(Err(e)) => Err(err(e)),
        None => Err(CoreError::new("unknown_method", "edit.checkUrl")),
    }
}
