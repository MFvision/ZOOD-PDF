//! `a11y.*`: the Accessibility tool (warraq-a11y). Structure listing, PDF/UA-style checker (a
//! Matterhorn-inspired subset, not a certified validator), auto-tagging without moving pixels,
//! reading order, types, alt text, language, decorative, merge/split, title, fixes. Mutating
//! methods need the modify permission, commit one incremental update and return the new file as
//! `blobs[0]`; a failed call leaves the document exactly as it was.

use super::doc::commit_reply;
use crate::registry::Registry;
use crate::{CoreError, Document, Reply};
use serde_json::{Map, Value};
use warraq_a11y::api;

fn err(e: warraq_a11y::A11yError) -> CoreError {
    CoreError::new(e.code(), e.to_string())
}

fn run(doc: &mut Document, method: &str, mutating: bool, p: &Value) -> Result<Reply, CoreError> {
    if mutating {
        doc.pdf()
            .require("changing the document's tags", |f| f.modify)?;
    }
    let res = api::call(doc.pdf_mut(), method, p)
        .ok_or_else(|| CoreError::new("unknown_method", method.to_string()))?;
    match res {
        Ok(v) if mutating => {
            if !doc.pdf().has_changes() {
                return Ok(Reply::json(v));
            }
            let extra = match v {
                Value::Object(m) => m,
                other => {
                    let mut m = Map::new();
                    m.insert("result".into(), other);
                    m
                }
            };
            commit_reply(doc, extra)
        }
        Ok(v) => Ok(Reply::json(v)),
        Err(e) => {
            if doc.pdf().has_changes() {
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
        $(fn $f(d: &mut Document, p: &Value, _b: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
            run(d, $name, $mutating, p)
        })*
        pub fn register(r: &mut Registry) {
            $(r.doc($name, $f);)*
        }
    };
}

methods![
    (structure, "a11y.structure", false),
    (check, "a11y.check", false),
    (rules, "a11y.rules", false),
    (autotag, "a11y.autotag", true),
    (fix, "a11y.fix", true),
    (move_to, "a11y.move", true),
    (set_type, "a11y.setType", true),
    (set_alt, "a11y.setAlt", true),
    (set_lang, "a11y.setLang", true),
    (decorative, "a11y.decorative", true),
    (merge, "a11y.merge", true),
    (split, "a11y.split", true),
    (set_title, "a11y.setTitle", true),
    (set_doc_lang, "a11y.setDocLang", true),
];
