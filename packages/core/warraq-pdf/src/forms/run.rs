//! Running a form's scripts the way Acrobat runs them, in Rust.
//!
//! When a value is committed, its field's keystroke check (`/K`) and
//! validation (`/V`) run; a value either fails there — and is not kept — or
//! every calculation (`/C`) then runs once, in the form's calculation order
//! (`/CO`), each seeing the results of those before it. Last, each field's
//! format (`/F`) says how its value is shown. Only scripts `script::parse`
//! accepts are run; any other is skipped, never executed.
use std::collections::BTreeMap;

use super::format::{
    arabic_digits, format_date, format_hijri, format_number, format_percent, format_special,
    latin_digits, parse_date, parse_hijri, parse_number, special_accepts, Shown,
};
use super::script::{parse, Action, SimpleOp, Stage};

/// A field as the form holds it now: its value and its scripts.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FieldState {
    pub name: String,
    pub value: String,
    pub keystroke: Option<String>,
    pub format: Option<String>,
    pub validate: Option<String>,
    pub calculate: Option<String>,
}

/// Why a committed value was not accepted.
#[derive(Debug, Clone, PartialEq)]
pub enum Rejection {
    /// Not a number, for a number or percentage field.
    Number,
    /// Not a date in the field's pattern.
    Date(String),
    /// Not a real Umm al-Qura date in the field's pattern.
    Hijri(String),
    /// Not the digits a ZIP code, phone or SSN field wants.
    Special,
    /// Outside the field's range.
    Range { min: Option<f64>, max: Option<f64> },
}

/// What a run changed and how each formatted field is shown.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Outcome {
    /// The committed value, rewritten by its keystroke check (Arabic-Indic
    /// digits typed into a number field become Western ones).
    pub normalized: Option<String>,
    /// The committed value was refused, and nothing was calculated.
    pub rejected: Option<Rejection>,
    /// Calculated fields whose value changed, with their new values.
    pub values: BTreeMap<String, String>,
    /// How every field with a format is shown now.
    pub shown: BTreeMap<String, Shown>,
}

/// A calculated number as JavaScript writes it; nothing for NaN or infinity.
pub fn number_text(n: f64) -> String {
    if !n.is_finite() {
        return String::new();
    }
    if n == n.trunc() && n.abs() < 1e21 {
        return format!("{}", n as i128);
    }
    format!("{n}")
}

/// Whether `name` is `wanted`, or a field below it (`wanted.1`, `wanted.x`):
/// `AFSimple_Calculate` takes a parent's name for all its kids.
fn under(name: &str, wanted: &str) -> bool {
    name == wanted || (name.starts_with(wanted) && name[wanted.len()..].starts_with('.'))
}

/// The value a field holds for a calculation: its number, or 0.
fn number_of(values: &BTreeMap<String, String>, wanted: &str) -> f64 {
    values
        .get(wanted)
        .and_then(|v| parse_number(v))
        .unwrap_or(0.0)
}

fn simple(op: SimpleOp, names: &[String], values: &BTreeMap<String, String>) -> f64 {
    let mut numbers = Vec::new();
    for wanted in names {
        let mut found = false;
        for (name, value) in values.range(wanted.clone()..) {
            if !name.starts_with(wanted.as_str()) {
                break;
            }
            if under(name, wanted) {
                found = true;
                numbers.push(parse_number(value).unwrap_or(0.0));
            }
        }
        if !found {
            // A field the form does not have counts as empty, as in Acrobat.
            numbers.push(0.0);
        }
    }
    match op {
        SimpleOp::Sum => numbers.iter().sum(),
        SimpleOp::Product => numbers.iter().product(),
        SimpleOp::Average => numbers.iter().sum::<f64>() / numbers.len().max(1) as f64,
        SimpleOp::Min => numbers.iter().copied().fold(f64::INFINITY, f64::min),
        SimpleOp::Max => numbers.iter().copied().fold(f64::NEG_INFINITY, f64::max),
    }
}

/// The keystroke check and validation of a committed value.
fn check(field: &FieldState, value: &str) -> (Option<String>, Option<Rejection>) {
    let mut normalized = None;
    let mut value = value.to_string();
    if let Some(Ok(script)) = field.keystroke.as_deref().map(parse) {
        for action in &script.actions {
            match action {
                Action::LatinDigits => {
                    let latin = latin_digits(&value);
                    if latin != value {
                        value = latin.clone();
                        normalized = Some(latin);
                    }
                }
                _ if value.trim().is_empty() => {}
                Action::Number(_, Stage::Keystroke) | Action::Percent(_, _, Stage::Keystroke)
                    if parse_number(&value).is_none() =>
                {
                    return (normalized, Some(Rejection::Number));
                }
                Action::Date(spec, Stage::Keystroke) if parse_date(&value, spec).is_none() => {
                    return (normalized, Some(Rejection::Date(spec.pattern.clone())));
                }
                Action::Hijri(spec, _, Stage::Keystroke) if parse_hijri(&value, spec).is_none() => {
                    return (normalized, Some(Rejection::Hijri(spec.pattern.clone())));
                }
                Action::Special(kind, Stage::Keystroke) if !special_accepts(&value, *kind) => {
                    return (normalized, Some(Rejection::Special));
                }
                _ => {}
            }
        }
    }
    if let Some(Ok(script)) = field.validate.as_deref().map(parse) {
        for action in &script.actions {
            if let Action::Range { min, max } = action {
                if value.trim().is_empty() {
                    continue;
                }
                let n = parse_number(&value);
                let out = match n {
                    None => true,
                    Some(n) => min.is_some_and(|m| n < m) || max.is_some_and(|m| n > m),
                };
                if out {
                    return (
                        normalized,
                        Some(Rejection::Range {
                            min: *min,
                            max: *max,
                        }),
                    );
                }
            }
        }
    }
    (normalized, None)
}

/// How a value is shown through its format script.
pub fn show(format: &str, value: &str) -> Option<Shown> {
    let script = parse(format).ok()?;
    let mut shown: Option<Shown> = None;
    for action in &script.actions {
        let current = shown
            .as_ref()
            .map(|s| s.text.clone())
            .unwrap_or_else(|| value.to_string());
        let next = match action {
            Action::Number(spec, Stage::Format) => format_number(value, spec),
            Action::Percent(decimals, separator, Stage::Format) => {
                format_percent(value, *decimals, *separator)
            }
            Action::Date(spec, Stage::Format) => format_date(value, spec),
            Action::Special(kind, Stage::Format) => format_special(value, *kind),
            Action::Hijri(spec, arabic, Stage::Format) => format_hijri(value, spec, *arabic),
            Action::ArabicDigits => Shown {
                text: arabic_digits(&current),
                red: shown.as_ref().is_some_and(|s| s.red),
            },
            _ => continue,
        };
        shown = Some(next);
    }
    shown
}

/// Commits `changed` (when given) and recalculates the form.
pub fn recalculate(fields: &[FieldState], order: &[String], changed: Option<&str>) -> Outcome {
    let mut outcome = Outcome::default();
    let mut values: BTreeMap<String, String> = fields
        .iter()
        .map(|f| (f.name.clone(), f.value.clone()))
        .collect();
    if let Some(name) = changed {
        if let Some(field) = fields.iter().find(|f| f.name == name) {
            let (normalized, rejected) = check(field, &field.value);
            if let Some(value) = &normalized {
                values.insert(name.to_string(), value.clone());
            }
            outcome.normalized = normalized;
            if rejected.is_some() {
                outcome.rejected = rejected;
                return outcome;
            }
        }
    }
    // The calculation order, then any calculated field it leaves out.
    let mut sequence: Vec<&FieldState> = Vec::new();
    for name in order {
        if let Some(f) = fields
            .iter()
            .find(|f| &f.name == name && f.calculate.is_some())
        {
            if !sequence.iter().any(|s| s.name == f.name) {
                sequence.push(f);
            }
        }
    }
    for f in fields.iter().filter(|f| f.calculate.is_some()) {
        if !sequence.iter().any(|s| s.name == f.name) {
            sequence.push(f);
        }
    }
    for field in sequence {
        let Some(Ok(script)) = field.calculate.as_deref().map(parse) else {
            continue;
        };
        let mut result = None;
        for action in &script.actions {
            match action {
                Action::Simple(op, names) => result = Some(simple(*op, names, &values)),
                Action::Assign(expr) => result = Some(expr.eval(&|n| number_of(&values, n))),
                _ => {}
            }
        }
        let Some(result) = result else { continue };
        let text = number_text(result);
        if values.get(&field.name) != Some(&text) {
            outcome.values.insert(field.name.clone(), text.clone());
        }
        values.insert(field.name.clone(), text);
    }
    for field in fields {
        if let Some(format) = &field.format {
            if let Some(shown) = show(
                format,
                values.get(&field.name).map(String::as_str).unwrap_or(""),
            ) {
                outcome.shown.insert(field.name.clone(), shown);
            }
        }
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    fn field(name: &str, value: &str) -> FieldState {
        FieldState {
            name: name.into(),
            value: value.into(),
            ..Default::default()
        }
    }

    #[test]
    fn a_total_follows_its_rows_in_order() {
        let mut total = field("total", "");
        total.calculate = Some("AFSimple_Calculate(\"SUM\", new Array(\"row\"));".into());
        let mut tax = field("tax", "");
        tax.calculate = Some("event.value = AFMakeNumber(getField(\"total\").value) * 0.15".into());
        let fields = vec![
            field("row.1", "100"),
            field("row.2", "٢٠٠"),
            field("row.3", ""),
            total,
            tax,
        ];
        let out = recalculate(&fields, &["total".into(), "tax".into()], Some("row.2"));
        assert_eq!(out.values.get("total").map(String::as_str), Some("300"));
        assert_eq!(out.values.get("tax").map(String::as_str), Some("45"));
        // In the wrong order, the tax sees the old total — as in Acrobat.
        let out = recalculate(&fields, &["tax".into(), "total".into()], None);
        assert_eq!(out.values.get("tax").map(String::as_str), Some("0"));
    }

    #[test]
    fn every_simple_operation() {
        let values = [("a", "2"), ("b", "8"), ("c", "")];
        for (op, want) in [
            ("SUM", "10"),
            ("PRD", "0"),
            ("AVG", "3.3333333333333335"),
            ("MIN", "0"),
            ("MAX", "8"),
        ] {
            let mut t = field("t", "");
            t.calculate = Some(format!(
                "AFSimple_Calculate(\"{op}\", [\"a\", \"b\", \"c\"])"
            ));
            let mut fields: Vec<FieldState> = values.iter().map(|(n, v)| field(n, v)).collect();
            fields.push(t);
            let out = recalculate(&fields, &[], None);
            assert_eq!(out.values.get("t").map(String::as_str), Some(want), "{op}");
        }
    }

    #[test]
    fn a_rejected_value_stops_the_calculation() {
        let mut qty = field("qty", "abc");
        qty.keystroke = Some("AFNumber_Keystroke(0, 0, 0, 0, \"\", true)".into());
        let mut total = field("total", "5");
        total.calculate = Some("AFSimple_Calculate(\"SUM\", [\"qty\"])".into());
        let out = recalculate(&[qty.clone(), total.clone()], &[], Some("qty"));
        assert_eq!(out.rejected, Some(Rejection::Number));
        assert!(out.values.is_empty());

        qty.value = "150".into();
        qty.validate = Some("AFRange_Validate(true, 1, true, 100)".into());
        let out = recalculate(&[qty.clone(), total.clone()], &[], Some("qty"));
        assert_eq!(
            out.rejected,
            Some(Rejection::Range {
                min: Some(1.0),
                max: Some(100.0)
            })
        );

        qty.value = "100".into();
        let out = recalculate(&[qty, total], &[], Some("qty"));
        assert_eq!(out.rejected, None);
        assert_eq!(out.values.get("total").map(String::as_str), Some("100"));
    }

    #[test]
    fn arabic_digits_typed_are_kept_as_a_number() {
        let mut qty = field("qty", "١٢");
        qty.keystroke = Some(format!(
            "Warraq_LatinDigits();\nAFNumber_Keystroke(0, 0, 0, 0, \"\", true);\n{}",
            super::super::script::LATIN_DIGITS_JS
        ));
        qty.format = Some(format!(
            "AFNumber_Format(0, 0, 0, 0, \"\", true);\nWarraq_Digits();\n{}",
            super::super::script::DIGITS_JS
        ));
        let out = recalculate(&[qty], &[], Some("qty"));
        assert_eq!(out.normalized.as_deref(), Some("12"));
        assert_eq!(out.shown.get("qty").map(|s| s.text.as_str()), Some("١٢"));
    }

    #[test]
    fn formats_show_the_final_values() {
        let mut total = field("total", "");
        total.calculate = Some("AFSimple_Calculate(\"SUM\", [\"a\"])".into());
        total.format = Some("AFNumber_Format(2, 0, 0, 0, \" ر.س\", false);".into());
        let out = recalculate(&[field("a", "1234.5"), total], &[], None);
        assert_eq!(
            out.shown.get("total").map(|s| s.text.as_str()),
            Some("1,234.50 ر.س")
        );
    }

    #[test]
    fn a_script_warraq_does_not_run_is_skipped() {
        let mut t = field("t", "7");
        t.calculate = Some("event.value = app.doSomething()".into());
        let out = recalculate(&[t], &[], None);
        assert!(out.values.is_empty());
    }

    #[test]
    fn numbers_are_written_as_javascript_writes_them() {
        assert_eq!(number_text(3.0), "3");
        assert_eq!(number_text(-0.5), "-0.5");
        assert_eq!(number_text(0.1 + 0.2), "0.30000000000000004");
        assert_eq!(number_text(f64::NAN), "");
        assert_eq!(number_text(1.0 / 0.0), "");
    }
}
