//! Findings and the validation report.

use crate::profile::Profile;
use crate::rules::{rule, Severity};
use std::collections::BTreeMap;
use warraq_pdf::lopdf::ObjectId;

/// At most this many findings are kept per rule (the total is still counted).
pub const MAX_FINDINGS_PER_RULE: usize = 25;

/// One violation of one rule.
#[derive(Debug, Clone, PartialEq)]
pub struct Finding {
    /// Rule id (`font-embedded`).
    pub rule: &'static str,
    /// Message variant (`missing`, `lzw`, …); the UI key is `standards.finding.<rule>.<variant>`.
    pub variant: &'static str,
    /// Clause of the target standard (e.g. `6.2.11.4.1`).
    pub clause: &'static str,
    /// The indirect object that holds the problem (the page for direct dictionaries).
    pub object: Option<ObjectId>,
    /// 0-based page index when the problem belongs to a page.
    pub page: Option<usize>,
    /// Message parameters (`font`, `value`, …).
    pub params: BTreeMap<String, String>,
    /// English message (the UI localises by key).
    pub message: String,
    /// Error or warning.
    pub severity: Severity,
    /// Whether `standards.convert` repairs it.
    pub fixable: bool,
}

impl Finding {
    /// The i18n key of the message.
    pub fn key(&self) -> String {
        format!("standards.finding.{}.{}", self.rule, self.variant)
    }

    /// `"12 0 R"` for the object.
    pub fn object_ref(&self) -> Option<String> {
        self.object.map(|(n, g)| format!("{n} {g} R"))
    }
}

/// A validation run.
#[derive(Debug, Clone)]
pub struct Report {
    /// Target.
    pub profile: Profile,
    /// Kept findings (≤ [`MAX_FINDINGS_PER_RULE`] per rule), in rule-catalogue order.
    pub findings: Vec<Finding>,
    /// Total findings per rule (including the ones not kept).
    pub counts: BTreeMap<&'static str, usize>,
    /// Number of rules evaluated.
    pub rules_checked: usize,
    /// Content analysis stopped at the operator budget (results may be incomplete).
    pub incomplete: bool,
    /// Standard font names the converter would embed from bundled fonts (`LiberationSans-Bold`, …).
    pub fonts_needed: Vec<String>,
}

impl Report {
    /// Errors (all, counted).
    pub fn error_count(&self) -> usize {
        self.counted(Severity::Error)
    }

    /// Warnings (all, counted).
    pub fn warning_count(&self) -> usize {
        self.counted(Severity::Warning)
    }

    fn counted(&self, s: Severity) -> usize {
        self.counts
            .iter()
            .filter(|(id, _)| rule(id).is_some_and(|r| r.severity == s))
            .map(|(_, n)| *n)
            .sum()
    }

    /// No errors.
    pub fn conforms(&self) -> bool {
        self.error_count() == 0
    }

    /// Whether some kept finding violates `rule_id`.
    pub fn has(&self, rule_id: &str) -> bool {
        self.counts.get(rule_id).is_some_and(|n| *n > 0)
    }

    /// Kept findings of one rule.
    pub fn of<'a>(&'a self, rule_id: &'a str) -> impl Iterator<Item = &'a Finding> + 'a {
        self.findings.iter().filter(move |f| f.rule == rule_id)
    }
}

/// Collects findings for one profile, applying the per-rule cap.
#[derive(Debug)]
pub struct Sink {
    profile: Profile,
    by_rule: BTreeMap<&'static str, Vec<Finding>>,
    counts: BTreeMap<&'static str, usize>,
}

/// Builder for one finding.
pub struct F {
    rule: &'static str,
    variant: &'static str,
    message: String,
    object: Option<ObjectId>,
    page: Option<usize>,
    params: BTreeMap<String, String>,
    fixable: bool,
}

impl F {
    /// A finding of `rule`/`variant` with an English message.
    pub fn new(rule: &'static str, variant: &'static str, message: impl Into<String>) -> F {
        F {
            rule,
            variant,
            message: message.into(),
            object: None,
            page: None,
            params: BTreeMap::new(),
            fixable: false,
        }
    }

    /// Set the object.
    pub fn obj(mut self, id: Option<ObjectId>) -> F {
        self.object = id;
        self
    }

    /// Set the page.
    pub fn page(mut self, page: Option<usize>) -> F {
        self.page = page;
        self
    }

    /// Add a message parameter.
    pub fn param(mut self, k: &str, v: impl ToString) -> F {
        self.params.insert(k.to_string(), v.to_string());
        self
    }

    /// Mark repairable by the converter.
    pub fn fixable(mut self, yes: bool) -> F {
        self.fixable = yes;
        self
    }
}

impl Sink {
    /// New sink for `profile`.
    pub fn new(profile: Profile) -> Sink {
        Sink {
            profile,
            by_rule: BTreeMap::new(),
            counts: BTreeMap::new(),
        }
    }

    /// The profile.
    pub fn profile(&self) -> Profile {
        self.profile
    }

    /// Whether `rule_id` applies to the profile.
    pub fn applies(&self, rule_id: &str) -> bool {
        rule(rule_id).is_some_and(|r| r.applies(self.profile))
    }

    /// Record a finding (ignored when its rule does not apply to the profile).
    pub fn push(&mut self, f: F) {
        let Some(r) = rule(f.rule) else {
            return;
        };
        if !r.applies(self.profile) {
            return;
        }
        let n = self.counts.entry(r.id).or_insert(0);
        *n += 1;
        let list = self.by_rule.entry(r.id).or_default();
        if list.len() >= MAX_FINDINGS_PER_RULE {
            return;
        }
        // Identical findings (same variant, object, params) are reported once.
        if list.iter().any(|x| {
            x.variant == f.variant
                && x.object == f.object
                && x.params == f.params
                && x.page == f.page
        }) {
            *n -= 1;
            return;
        }
        list.push(Finding {
            rule: r.id,
            variant: f.variant,
            clause: r.clause(self.profile),
            object: f.object,
            page: f.page,
            params: f.params,
            message: f.message,
            severity: r.severity,
            fixable: f.fixable,
        });
    }

    /// Findings recorded so far for a rule.
    pub fn count(&self, rule_id: &str) -> usize {
        self.counts.get(rule_id).copied().unwrap_or(0)
    }

    /// Set the fixable flag of every kept finding of a rule.
    pub fn mark_fixable(&mut self, rule_id: &str, yes: bool) {
        if let Some(list) = self.by_rule.get_mut(rule_id) {
            for f in list {
                f.fixable = yes;
            }
        }
    }

    /// Finish into a report (findings in catalogue order).
    pub fn finish(self, incomplete: bool, fonts_needed: Vec<String>) -> Report {
        let profile = self.profile;
        let mut findings = Vec::new();
        for r in crate::rules::RULES.iter() {
            if let Some(list) = self.by_rule.get(r.id) {
                findings.extend(list.iter().cloned());
            }
        }
        Report {
            profile,
            findings,
            counts: self.counts,
            rules_checked: crate::rules::rules_for(profile).count(),
            incomplete,
            fonts_needed,
        }
    }
}
