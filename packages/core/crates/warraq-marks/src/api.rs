//! JSON surface (`marks.*`) registered by warraq-core.
//!
//! * `marks.list` → `{ marks: [{ id, spec, pages }], foreign: [{ id, kind, pages, regions, removable, acrobat }] }`
//! * `marks.add` `{ mark, only? }` (+ picture as `blobs[0]`) → `{ id, pages }`
//! * `marks.update` `{ id, mark }` (+ optional new picture) → `{ id, pages }`
//! * `marks.remove` `{ id }` → `{ pages }` for ours; `{ removed, left }` for `foreign:<kind>`
//!
//! Mutating calls only record changes on the [`Pdf`]; the caller commits one incremental update.

use serde::Deserialize;
use serde_json::{json, Value};
use warraq_pdf::Pdf;

use crate::error::{MarkError, Result};
use crate::foreign::{self, ForeignKind};
use crate::marks;
use crate::model::MarkSpec;

pub const METHODS: &[(&str, bool)] = &[
    ("marks.list", false),
    ("marks.add", true),
    ("marks.update", true),
    ("marks.remove", true),
];

fn params<T: for<'de> Deserialize<'de>>(v: &Value) -> Result<T> {
    let v = if v.is_null() { json!({}) } else { v.clone() };
    serde_json::from_value(v).map_err(|e| MarkError::Params(e.to_string()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Add {
    mark: MarkSpec,
    #[serde(default)]
    only: Option<Vec<usize>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Update {
    id: String,
    mark: MarkSpec,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Remove {
    id: String,
}

fn to_json<T: serde::Serialize>(v: &T) -> Result<Value> {
    serde_json::to_value(v).map_err(|e| MarkError::Params(e.to_string()))
}

/// Dispatch a `marks.*` method; `None` if it is not one.
pub fn call(pdf: &mut Pdf, method: &str, p: &Value, blobs: &[Vec<u8>]) -> Option<Result<Value>> {
    let picture = blobs.first().map(Vec::as_slice);
    Some(match method {
        "marks.list" => (|| {
            Ok(json!({
                "marks": to_json(&marks::list(pdf)?)?,
                "foreign": to_json(&foreign::list(pdf)?)?,
            }))
        })(),
        "marks.add" => params::<Add>(p).and_then(|a| {
            let r = marks::add(pdf, &a.mark, picture, a.only.as_deref(), None, None)?;
            to_json(&r)
        }),
        "marks.update" => params::<Update>(p).and_then(|u| {
            let r = marks::update(pdf, &u.id, &u.mark, picture)?;
            to_json(&r)
        }),
        "marks.remove" => params::<Remove>(p).and_then(|r| {
            if let Some(kind) = r.id.strip_prefix("foreign:") {
                let k =
                    ForeignKind::parse(kind).ok_or_else(|| MarkError::NotFound(r.id.clone()))?;
                let (removed, left) = foreign::remove(pdf, k)?;
                if removed == 0 {
                    return Err(if left > 0 {
                        MarkError::Unsafe(format!("{left} region(s) of {kind}"))
                    } else {
                        MarkError::NotFound(r.id)
                    });
                }
                Ok(json!({ "removed": removed, "left": left }))
            } else {
                let (pages, _) = marks::remove(pdf, &r.id)?;
                Ok(json!({ "pages": pages }))
            }
        }),
        _ => return None,
    })
}
