//! JSON RPC surface of the Accessibility tool (`a11y.*`). warraq-core registers these names and
//! commits mutating calls as one incremental update. Element ids are object numbers (from
//! `a11y.structure`); boxes are `[x0, y0, x1, y1]` in points from the top-left corner of the
//! page's visible box (y down).

use serde::Deserialize;
use serde_json::{json, Value};
use warraq_pdf::Pdf;

use crate::autotag::{autotag, Options};
use crate::check::{check, fix, RULES};
use crate::edit;
use crate::error::{A11yError, Result};
use crate::structure::list;

/// Document methods (`mutating` says whether the call changes the document).
pub const DOC_METHODS: &[(&str, bool)] = &[
    ("a11y.structure", false),
    ("a11y.check", false),
    ("a11y.rules", false),
    ("a11y.autotag", true),
    ("a11y.fix", true),
    ("a11y.move", true),
    ("a11y.setType", true),
    ("a11y.setAlt", true),
    ("a11y.setLang", true),
    ("a11y.decorative", true),
    ("a11y.merge", true),
    ("a11y.split", true),
    ("a11y.setTitle", true),
    ("a11y.setDocLang", true),
];

fn p<T: for<'de> Deserialize<'de>>(v: &Value) -> Result<T> {
    let v = if v.is_null() { json!({}) } else { v.clone() };
    serde_json::from_value(v).map_err(|e| A11yError::Params(e.to_string()))
}

fn to_json<T: serde::Serialize>(v: &T) -> Result<Value> {
    serde_json::to_value(v).map_err(|e| A11yError::Params(e.to_string()))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NoParams {}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Autotag {
    #[serde(default)]
    mode: Option<String>,
    title: Option<String>,
    lang: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Fix {
    #[serde(default)]
    rules: Vec<String>,
    title: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Move {
    id: u32,
    index: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetType {
    id: u32,
    #[serde(rename = "type")]
    ty: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetAlt {
    id: u32,
    alt: String,
    lang: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetLang {
    id: u32,
    lang: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Id {
    id: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Split {
    id: u32,
    at: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Title {
    title: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DocLang {
    lang: String,
}

/// Dispatch `method`; `None` when the name is not an `a11y.*` method.
pub fn call(pdf: &mut Pdf, method: &str, params: &Value) -> Option<Result<Value>> {
    Some(match method {
        "a11y.structure" => p::<NoParams>(params)
            .and_then(|_| list(pdf))
            .and_then(|l| to_json(&l)),
        "a11y.check" => p::<NoParams>(params)
            .and_then(|_| check(pdf))
            .and_then(|r| to_json(&r)),
        "a11y.rules" => p::<NoParams>(params).map(|_| {
            Value::Array(
                RULES
                    .iter()
                    .map(|r| {
                        json!({
                            "id": r.id, "clause": r.clause, "matterhorn": r.matterhorn,
                            "severity": r.severity, "fix": r.fix,
                        })
                    })
                    .collect(),
            )
        }),
        "a11y.autotag" => p::<Autotag>(params).and_then(|a| {
            let retag = match a.mode.as_deref() {
                None | Some("untagged") => false,
                Some("retag") => true,
                Some(o) => return Err(A11yError::Params(format!("unknown mode {o:?}"))),
            };
            let r = autotag(
                pdf,
                &Options {
                    retag,
                    title: a.title,
                    lang: a.lang,
                },
            )?;
            to_json(&r)
        }),
        "a11y.fix" => p::<Fix>(params).and_then(|f| {
            let done = fix(pdf, &f.rules, f.title.as_deref())?;
            Ok(json!({ "fixed": to_json(&done)? }))
        }),
        "a11y.move" => {
            p::<Move>(params).and_then(|m| edit::move_to(pdf, m.id, m.index).map(|_| json!({})))
        }
        "a11y.setType" => {
            p::<SetType>(params).and_then(|m| edit::set_type(pdf, m.id, &m.ty).map(|_| json!({})))
        }
        "a11y.setAlt" => p::<SetAlt>(params)
            .and_then(|m| edit::set_alt(pdf, m.id, &m.alt, m.lang.as_deref()).map(|_| json!({}))),
        "a11y.setLang" => p::<SetLang>(params)
            .and_then(|m| edit::set_lang(pdf, m.id, m.lang.as_deref()).map(|_| json!({}))),
        "a11y.decorative" => {
            p::<Id>(params).and_then(|m| edit::decorative(pdf, m.id).map(|_| json!({})))
        }
        "a11y.merge" => {
            p::<Id>(params).and_then(|m| edit::merge_next(pdf, m.id).map(|_| json!({})))
        }
        "a11y.split" => p::<Split>(params)
            .and_then(|m| edit::split(pdf, m.id, m.at).map(|n| json!({ "id": n }))),
        "a11y.setTitle" => {
            p::<Title>(params).and_then(|m| edit::set_title(pdf, &m.title).map(|_| json!({})))
        }
        "a11y.setDocLang" => {
            p::<DocLang>(params).and_then(|m| edit::set_doc_lang(pdf, &m.lang).map(|_| json!({})))
        }
        _ => return None,
    })
}
