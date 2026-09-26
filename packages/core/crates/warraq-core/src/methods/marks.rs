//! `marks.*`: the Page marks tool (warraq-marks). `marks.list` (ours + other applications'),
//! `marks.add` (picture as `blobs[0]`), `marks.update`, `marks.remove`. Mutating methods need the
//! modify permission, commit one incremental update and return the new file as `blobs[0]`; a
//! failed call leaves the document exactly as it was.

use super::doc::commit_reply;
use crate::registry::Registry;
use crate::{CoreError, Document, Reply};
use serde_json::{Map, Value};
use warraq_marks::api;

fn run(
    doc: &mut Document,
    method: &str,
    mutating: bool,
    p: &Value,
    blobs: Vec<Vec<u8>>,
) -> Result<Reply, CoreError> {
    if mutating {
        doc.pdf().require("adding page marks", |f| f.modify)?;
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
            Err(CoreError::new(e.code(), e.to_string()))
        }
    }
}

fn list(d: &mut Document, p: &Value, b: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    run(d, "marks.list", false, p, b)
}
fn add(d: &mut Document, p: &Value, b: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    run(d, "marks.add", true, p, b)
}
fn update(d: &mut Document, p: &Value, b: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    run(d, "marks.update", true, p, b)
}
fn remove(d: &mut Document, p: &Value, b: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    run(d, "marks.remove", true, p, b)
}

pub fn register(r: &mut Registry) {
    r.doc("marks.list", list)
        .doc("marks.add", add)
        .doc("marks.update", update)
        .doc("marks.remove", remove);
}
