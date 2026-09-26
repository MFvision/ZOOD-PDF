//! JSON shapes of reports, conversions and the rule catalogue (used by warraq-core's
//! `standards.*` RPC methods).

use crate::convert::Converted;
use crate::profile::Profile;
use crate::report::{Finding, Report};
use crate::rules::{rules_for, RULES};
use serde_json::{json, Value};

/// One finding.
pub fn finding(f: &Finding, p: Profile) -> Value {
    json!({
        "rule": f.rule,
        "variant": f.variant,
        "key": f.key(),
        "clause": f.clause,
        "standard": p.standard(),
        "object": f.object_ref(),
        "page": f.page,
        "params": f.params,
        "message": f.message,
        "severity": f.severity.as_str(),
        "fixable": f.fixable,
    })
}

/// A validation report.
pub fn report(r: &Report) -> Value {
    json!({
        "profile": r.profile.id(),
        "label": r.profile.label(),
        "standard": r.profile.standard(),
        "conforms": r.conforms(),
        "errorCount": r.error_count(),
        "warningCount": r.warning_count(),
        "fixableCount": r.findings.iter().filter(|f| f.fixable).count(),
        "rulesChecked": r.rules_checked,
        "incomplete": r.incomplete,
        "fontsNeeded": r.fonts_needed,
        "counts": r.counts,
        "findings": r.findings.iter().map(|f| finding(f, r.profile)).collect::<Vec<_>>(),
    })
}

/// A conversion (without the bytes, which travel as a blob).
pub fn converted(c: &Converted, profile: Profile) -> Value {
    json!({
        "profile": profile.id(),
        "suffix": profile.file_suffix(),
        "conforms": c.after.conforms(),
        "byteLength": c.bytes.len(),
        "before": report(&c.before),
        "after": report(&c.after),
        "actions": c.actions.iter().map(|(a, n)| json!({ "id": a.id, "detail": a.detail, "count": n })).collect::<Vec<_>>(),
    })
}

/// The catalogue (for `standards.rules`).
pub fn rules(profile: Option<Profile>) -> Value {
    let list: Vec<Value> = match profile {
        Some(p) => rules_for(p)
            .map(|r| json!({ "id": r.id, "area": r.area, "clause": r.clause(p), "severity": r.severity.as_str(), "fix": r.fix.as_str(), "summary": r.summary }))
            .collect(),
        None => RULES
            .iter()
            .map(|r| {
                json!({
                    "id": r.id, "area": r.area, "severity": r.severity.as_str(), "fix": r.fix.as_str(), "summary": r.summary,
                    "profiles": Profile::ALL.iter().filter(|p| r.applies(**p)).map(|p| p.id()).collect::<Vec<_>>(),
                    "clauses": {
                        "pdfa-1": r.a1, "pdfa-2": r.a2, "pdfa-3": if r.a3.is_empty() { r.a2 } else { r.a3 }, "pdfx-4": r.x4,
                    },
                })
            })
            .collect(),
    };
    json!({ "rules": list, "pdfaRuleCount": crate::rules::PDFA_RULE_COUNT })
}
