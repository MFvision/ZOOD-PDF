//! Form fields and comments (ADR-0007), and Prepare form.
//!
//! PDFium stores Arabic typed into a field or a text box but draws nothing
//! for it in the saved file; Warraq's shaping draws it before the file leaves
//! the app (`fix_appearances`). Prepare form reads a form (`inspect`), finds
//! where a flat one expects input (`detect`), makes real fields there
//! (`create`), gives fields formats, validations and calculations written as
//! Acrobat's own JavaScript (`set_actions`, `check_expression`), runs exactly
//! that subset while a form is filled (`recalculate`), and can take a static
//! XFA form's XFA away (`drop_xfa`). See `warraq_pdf::forms`.
use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Deserializer};
use serde_json::{json, Value};
use warraq_pdf::forms::{
    self, ActionsChange, ActionsError, CalcSpec, FieldState, FormReport, FormatSpec, NewField,
    NumberSpec, Place, Rejection, SimpleOp, Xfa,
};

use super::{args, Reply};
use crate::CoreError;

#[derive(Deserialize, Default)]
struct Password {
    /// The file's open password, when it has one: changes are an
    /// incremental update, sealed with the same key.
    #[serde(default)]
    password: Option<String>,
}

/// Distinguishes a key set to `null` (`Some(None)`) from one left out (`None`).
fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(d).map(Some)
}

#[derive(Deserialize)]
struct Detect {
    #[serde(default)]
    password: Option<String>,
    /// Pages to look at; every page when empty.
    #[serde(default)]
    pages: Vec<usize>,
}

#[derive(Deserialize)]
struct Create {
    #[serde(default)]
    password: Option<String>,
    fields: Vec<CreateField>,
}

#[derive(Deserialize)]
struct CreateField {
    page: usize,
    kind: String,
    name: String,
    #[serde(default)]
    tooltip: String,
    rect: [f32; 4],
    #[serde(default)]
    rtl: bool,
    #[serde(default)]
    pattern: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum FormatArg {
    Number {
        #[serde(default)]
        decimals: u8,
        #[serde(default)]
        separator: u8,
        #[serde(default)]
        negative: u8,
        #[serde(default)]
        currency: String,
        #[serde(default)]
        prepend: bool,
        #[serde(default)]
        arabic: bool,
    },
    Percent {
        #[serde(default)]
        decimals: u8,
        #[serde(default)]
        separator: u8,
        #[serde(default)]
        arabic: bool,
    },
    Date {
        pattern: String,
    },
    Hijri {
        pattern: String,
        #[serde(default)]
        arabic: bool,
    },
}

#[derive(Deserialize)]
struct RangeArg {
    #[serde(default)]
    min: Option<f64>,
    #[serde(default)]
    max: Option<f64>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum CalcArg {
    Simple { op: String, fields: Vec<String> },
    Expression { expression: String },
}

#[derive(Deserialize)]
struct FieldActions {
    name: String,
    #[serde(default, deserialize_with = "present")]
    format: Option<Option<FormatArg>>,
    #[serde(default, deserialize_with = "present")]
    range: Option<Option<RangeArg>>,
    #[serde(default, deserialize_with = "present")]
    calculate: Option<Option<CalcArg>>,
}

#[derive(Deserialize)]
struct SetActions {
    #[serde(default)]
    password: Option<String>,
    fields: Vec<FieldActions>,
}

#[derive(Deserialize)]
struct CheckExpression {
    expression: String,
    fields: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StateArg {
    name: String,
    #[serde(default)]
    value: String,
    #[serde(default)]
    keystroke: Option<String>,
    #[serde(default)]
    format: Option<String>,
    #[serde(default)]
    validate: Option<String>,
    #[serde(default)]
    calculate: Option<String>,
}

#[derive(Deserialize)]
struct Recalculate {
    fields: Vec<StateArg>,
    #[serde(default)]
    order: Vec<String>,
    #[serde(default)]
    changed: Option<String>,
}

fn the_pdf(blobs: &mut std::vec::IntoIter<Vec<u8>>, op: &str) -> Result<Vec<u8>, CoreError> {
    blobs
        .next()
        .ok_or_else(|| CoreError::Args(format!("forms.{op} takes the PDF")))
}

/// The update, or the whole file when it cannot be one — but never a
/// protected file written without its protection.
fn saved(doc: &mut warraq_pdf::PdfDocument) -> Result<Vec<u8>, CoreError> {
    match doc.save_incremental() {
        Ok(bytes) => Ok(bytes),
        Err(e) if doc.was_encrypted() => Err(e.into()),
        Err(_) => Ok(doc.save_to_vec()?),
    }
}

/// What a format script does, for the interface to show and edit.
fn describe_format(js: &str) -> Value {
    let Ok(script) = forms::parse_script(js) else {
        return Value::Null;
    };
    let arabic = script
        .actions
        .iter()
        .any(|a| matches!(a, forms::script::Action::ArabicDigits));
    for action in &script.actions {
        use forms::script::{Action, Stage};
        match action {
            Action::Number(spec, Stage::Format) => {
                return json!({
                    "kind": "number",
                    "decimals": spec.decimals,
                    "separator": spec.separator,
                    "negative": spec.negative,
                    "currency": spec.currency,
                    "prepend": spec.prepend,
                    "arabic": arabic,
                })
            }
            Action::Percent(decimals, separator, Stage::Format) => {
                return json!({ "kind": "percent", "decimals": decimals, "separator": separator, "arabic": arabic })
            }
            Action::Date(spec, Stage::Format) => {
                return json!({ "kind": "date", "pattern": spec.pattern })
            }
            Action::Hijri(spec, arabic, Stage::Format) => {
                return json!({ "kind": "hijri", "pattern": spec.pattern, "arabic": arabic })
            }
            Action::Special(kind, Stage::Format) => {
                return json!({ "kind": "special", "mask": kind })
            }
            _ => {}
        }
    }
    Value::Null
}

fn describe_range(js: &str) -> Value {
    let Ok(script) = forms::parse_script(js) else {
        return Value::Null;
    };
    for action in script.actions {
        if let forms::script::Action::Range { min, max } = action {
            return json!({ "min": min, "max": max });
        }
    }
    Value::Null
}

fn describe_calculation(js: &str) -> Value {
    let Ok(script) = forms::parse_script(js) else {
        return Value::Null;
    };
    for action in script.actions {
        match action {
            forms::script::Action::Simple(op, fields) => {
                return json!({ "kind": "simple", "op": op.code(), "fields": fields })
            }
            forms::script::Action::Assign(expr) => {
                return json!({ "kind": "expression", "expression": forms::expr::to_typed(&expr) })
            }
            _ => {}
        }
    }
    Value::Null
}

fn report_json(report: &FormReport) -> Value {
    let fields: Vec<Value> = report
        .fields
        .iter()
        .map(|f| {
            let scripts: Vec<&Option<String>> = vec![&f.keystroke, &f.format, &f.validate, &f.calculate];
            let supported = scripts
                .iter()
                .all(|s| s.as_deref().is_none_or(|js| forms::parse_script(js).is_ok()));
            json!({
                "name": f.name,
                "type": f.kind.code(),
                "value": f.value,
                "tooltip": f.tooltip,
                "readOnly": f.read_only,
                "widgets": f.widgets.iter().map(|w| json!({ "page": w.page, "rect": w.rect })).collect::<Vec<_>>(),
                "scripts": {
                    "keystroke": f.keystroke,
                    "format": f.format,
                    "validate": f.validate,
                    "calculate": f.calculate,
                },
                "supported": supported,
                "format": f.format.as_deref().map(describe_format).unwrap_or(Value::Null),
                "range": f.validate.as_deref().map(describe_range).unwrap_or(Value::Null),
                "calculate": f.calculate.as_deref().map(describe_calculation).unwrap_or(Value::Null),
            })
        })
        .collect();
    let not_run: Vec<Value> = report
        .not_run
        .iter()
        .map(|n| {
            let (place, page, field) = match &n.place {
                Place::Document => ("document", None, None),
                Place::Open => ("open", None, None),
                Place::Page(p) => ("page", Some(*p), None),
                Place::Field(name) => ("field", None, Some(name.clone())),
            };
            json!({ "place": place, "page": page, "field": field, "event": n.event, "text": n.text })
        })
        .collect();
    json!({
        "xfa": match report.xfa {
            Xfa::None => "none",
            Xfa::Static => "static",
            Xfa::Dynamic => "dynamic",
        },
        "order": report.order,
        "fields": fields,
        "notRun": not_run,
    })
}

fn format_spec(arg: FormatArg) -> FormatSpec {
    match arg {
        FormatArg::Number {
            decimals,
            separator,
            negative,
            currency,
            prepend,
            arabic,
        } => FormatSpec::Number {
            spec: NumberSpec {
                decimals: decimals.min(10),
                // Arabic-Indic digits have their own separators: `٬` and `٫`.
                separator: if arabic {
                    separator.min(1)
                } else {
                    separator.min(4)
                },
                negative: negative.min(3),
                currency: currency.chars().take(16).collect(),
                prepend,
            },
            arabic,
        },
        FormatArg::Percent {
            decimals,
            separator,
            arabic,
        } => FormatSpec::Percent {
            decimals: decimals.min(10),
            separator: if arabic {
                separator.min(1)
            } else {
                separator.min(3)
            },
            arabic,
        },
        FormatArg::Date { pattern } => FormatSpec::Date {
            pattern: pattern.chars().take(40).collect(),
        },
        FormatArg::Hijri { pattern, arabic } => FormatSpec::Hijri {
            pattern: pattern.chars().take(40).collect(),
            arabic,
        },
    }
}

fn expression_error(e: &forms::ExprError) -> Value {
    json!({ "kind": e.kind, "start": e.start, "end": e.end, "name": e.name })
}

pub fn call_static(name: &str, json: &str, blobs: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let mut blobs = blobs.into_iter();
    match name {
        // blobs: the PDF, then the face to draw with (a bundled one).
        "fix_appearances" => {
            let a: Password = args(json)?;
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
        "inspect" => {
            let a: Password = args(json)?;
            let pdf = the_pdf(&mut blobs, name)?;
            let doc = warraq_pdf::PdfDocument::open(pdf, a.password.as_deref())?;
            Reply::of(&report_json(&doc.form()))
        }
        "detect" => {
            let a: Detect = args(json)?;
            let pdf = the_pdf(&mut blobs, name)?;
            let doc = crate::Document::open(pdf, a.password.as_deref())?;
            let mut taken: BTreeSet<String> =
                doc.form().fields.into_iter().map(|f| f.name).collect();
            let mut pages = Vec::new();
            for (index, found) in doc.detect_fields(&a.pages)? {
                let (width, height) = doc.page_size(index)?;
                let fields: Vec<Value> = found
                    .into_iter()
                    .map(|p| {
                        // Proposed names are unique across the file, as fields' must be.
                        let mut name = p.name.clone();
                        let mut n = 2;
                        while taken.contains(&name) {
                            name = format!("{} {n}", p.name);
                            n += 1;
                        }
                        taken.insert(name.clone());
                        json!({
                            "kind": p.kind,
                            "name": name,
                            "tooltip": p.tooltip,
                            "rect": p.rect,
                            "rtl": p.rtl,
                            "source": p.source,
                            "pattern": p.pattern,
                        })
                    })
                    .collect();
                pages.push(
                    json!({ "index": index, "width": width, "height": height, "fields": fields }),
                );
            }
            Reply::of(&json!({ "pages": pages }))
        }
        "create" => {
            let a: Create = args(json)?;
            let pdf = the_pdf(&mut blobs, name)?;
            let mut doc = warraq_pdf::PdfDocument::open(pdf, a.password.as_deref())?;
            let fields: Vec<NewField> = a
                .fields
                .into_iter()
                .map(|f| NewField {
                    page: f.page,
                    kind: f.kind,
                    name: f.name,
                    tooltip: f.tooltip,
                    rect: f.rect,
                    rtl: f.rtl,
                    pattern: f.pattern,
                })
                .collect();
            let created = doc.create_fields(&fields)?;
            let bytes = saved(&mut doc)?;
            Ok(Reply::of(&json!({ "created": created }))?.with_blob(bytes))
        }
        // blobs: the PDF, then the face to draw calculated values with.
        "set_actions" => {
            let a: SetActions = args(json)?;
            let (Some(pdf), Some(font)) = (blobs.next(), blobs.next()) else {
                return Err(CoreError::Args(
                    "forms.set_actions takes the PDF and a font".into(),
                ));
            };
            let mut doc = warraq_pdf::PdfDocument::open(pdf, a.password.as_deref())?;
            let mut changes = Vec::new();
            for f in a.fields {
                let calculate = match f.calculate {
                    None => None,
                    Some(None) => Some(None),
                    Some(Some(CalcArg::Simple { op, fields })) => {
                        let Some(op) = SimpleOp::from_code(&op) else {
                            return Err(CoreError::Args(format!("no calculation called {op}")));
                        };
                        Some(Some(CalcSpec::Simple { op, fields }))
                    }
                    Some(Some(CalcArg::Expression { expression })) => {
                        Some(Some(CalcSpec::Expression(expression)))
                    }
                };
                changes.push(ActionsChange {
                    name: f.name,
                    format: f.format.map(|o| o.map(format_spec)),
                    range: f.range.map(|o| o.map(|r| (r.min, r.max))),
                    calculate,
                });
            }
            let changed = match doc.set_actions(&changes) {
                Ok(changed) => changed,
                Err(ActionsError::Pdf(e)) => {
                    return Err(CoreError::Pdf(warraq_pdf::Error::Edit(e)))
                }
                Err(e) => {
                    let error = match e {
                        ActionsError::NoField(name) => json!({ "kind": "noField", "name": name }),
                        ActionsError::Expression(e) => {
                            json!({ "kind": "expression", "expression": expression_error(&e) })
                        }
                        ActionsError::Cycle(fields) => json!({ "kind": "cycle", "fields": fields }),
                        ActionsError::Pdf(_) => unreachable!("handled above"),
                    };
                    return Reply::of(&json!({ "ok": false, "error": error }));
                }
            };
            // Calculated values, and every formatted one, drawn in the file.
            doc.redraw_named(&font, &changed)?;
            let bytes = saved(&mut doc)?;
            Ok(Reply::of(&json!({ "ok": true, "changed": changed }))?.with_blob(bytes))
        }
        "check_expression" => {
            let a: CheckExpression = args(json)?;
            match forms::parse_expression(&a.expression, &a.fields) {
                Ok(expr) => Reply::of(&json!({
                    "ok": true,
                    "uses": expr.fields(),
                    "typed": forms::expr::to_typed(&expr),
                })),
                Err(e) => Reply::of(&json!({ "ok": false, "error": expression_error(&e) })),
            }
        }
        "recalculate" => {
            let a: Recalculate = args(json)?;
            let states: Vec<FieldState> = a
                .fields
                .into_iter()
                .take(5000)
                .map(|f| FieldState {
                    name: f.name,
                    value: f.value,
                    keystroke: f.keystroke,
                    format: f.format,
                    validate: f.validate,
                    calculate: f.calculate,
                })
                .collect();
            let out = forms::recalculate(&states, &a.order, a.changed.as_deref());
            let rejected = out.rejected.map(|r| match r {
                Rejection::Number => json!({ "kind": "number" }),
                Rejection::Date(pattern) => json!({ "kind": "date", "pattern": pattern }),
                Rejection::Hijri(pattern) => json!({ "kind": "hijri", "pattern": pattern }),
                Rejection::Special => json!({ "kind": "special" }),
                Rejection::Range { min, max } => json!({ "kind": "range", "min": min, "max": max }),
            });
            let shown: BTreeMap<String, Value> = out
                .shown
                .into_iter()
                .map(|(k, s)| (k, json!({ "text": s.text, "red": s.red })))
                .collect();
            Reply::of(&json!({
                "normalized": out.normalized,
                "rejected": rejected,
                "values": out.values,
                "shown": shown,
            }))
        }
        "drop_xfa" => {
            let a: Password = args(json)?;
            let pdf = the_pdf(&mut blobs, name)?;
            let mut doc = warraq_pdf::PdfDocument::open(pdf.clone(), a.password.as_deref())?;
            if !doc.drop_xfa()? {
                return Ok(Reply::of(&json!({ "dropped": false }))?.with_blob(pdf));
            }
            let bytes = saved(&mut doc)?;
            Ok(Reply::of(&json!({ "dropped": true }))?.with_blob(bytes))
        }
        _ => Err(CoreError::UnknownOp(format!("forms.{name}"))),
    }
}
