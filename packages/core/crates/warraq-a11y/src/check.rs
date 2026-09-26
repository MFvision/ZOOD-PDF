//! A PDF/UA-style checker: a Matterhorn-inspired subset of ISO 14289-1 checks that a machine can
//! decide, with automatic fixes where the engine can make them. It is **not** a certified PDF/UA
//! validator: human checks (meaningful alt text, correct reading order, colour contrast, …) and
//! many machine checkpoints are not covered.
//!
//! Every finding names its rule, the ISO 14289-1 clause (and Matterhorn checkpoint where one
//! matches), the object/page/element, an i18n key (`a11y.finding.<rule>.<variant>`) with params, a
//! severity, and whether [`fix`] repairs it.

use std::collections::{BTreeMap, HashMap, HashSet};

use lopdf::{Dictionary, Object, ObjectId, StringFormat};
use serde::Serialize;
use warraq_pdf::{pages, Pdf};

use crate::autotag::{
    annot_kind, annot_needs_tag, annot_rect, annots, autotag, current_title, form_class,
    set_display_doc_title, set_title, FormClass, Options,
};
use crate::error::{A11yError, Result};
use crate::lang;
use crate::pagemap::{extract, xobject_kind, PageMap};
use crate::structure::{display_doc_title, doc_lang, is_marked, page_index};
use crate::tree::{Kid, Tree};

/// Pages analysed for content rules (bigger documents are reported as incomplete).
pub const MAX_CHECK_PAGES: usize = 2_000;
/// Findings kept per rule (all are counted).
pub const MAX_FINDINGS_PER_RULE: usize = 25;

/// Severity of a finding.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
}

/// How a rule is fixed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FixKind {
    /// Repaired by [`fix`].
    Auto,
    /// Repaired by [`fix`] when a title is given (the UI asks for it).
    NeedsTitle,
    /// Repaired by re-tagging the whole document ([`fix`] with the rule selected).
    Retag,
    /// Needs a person (alt text, fonts, …).
    Manual,
}

/// One rule of the catalogue.
#[derive(Debug, Clone, Copy)]
pub struct Rule {
    pub id: &'static str,
    /// ISO 14289-1:2014 clause.
    pub clause: &'static str,
    /// Matterhorn Protocol 1.1 checkpoint, where one corresponds.
    pub matterhorn: Option<&'static str>,
    pub severity: Severity,
    pub fix: FixKind,
}

const fn rule(
    id: &'static str,
    clause: &'static str,
    matterhorn: Option<&'static str>,
    severity: Severity,
    fix: FixKind,
) -> Rule {
    Rule {
        id,
        clause,
        matterhorn,
        severity,
        fix,
    }
}

use FixKind::{Auto, Manual, NeedsTitle, Retag};
use Severity::{Error, Warning};

/// The rule catalogue, in report order.
pub const RULES: &[Rule] = &[
    rule("struct-tree", "7.1", None, Error, Auto),
    rule("marked", "7.1", None, Error, Auto),
    rule("suspects", "7.1", Some("01-007"), Error, Retag),
    rule("untagged-content", "7.1", Some("01-005"), Error, Auto),
    rule("orphan-mcid", "7.1", None, Error, Retag),
    rule("parent-tree", "7.1", None, Error, Auto),
    rule("role-map", "7.1", Some("02-001"), Error, Manual),
    rule("title", "7.1", Some("06-003"), Error, NeedsTitle),
    rule("display-doc-title", "7.1", Some("07-001"), Error, Auto),
    rule("doc-lang", "7.2", None, Error, Auto),
    rule("lang-mismatch", "7.2", None, Warning, Auto),
    rule("ligature-actualtext", "7.2", None, Warning, Manual),
    rule("figure-alt", "7.3", Some("13-004"), Error, Manual),
    rule("heading-skip", "7.4.2", Some("14-003"), Error, Auto),
    rule("table-th", "7.5", None, Warning, Auto),
    rule("list-structure", "7.6", None, Error, Auto),
    rule("annot-tagged", "7.18.1", None, Error, Auto),
    rule("tabs-order", "7.18.3", None, Error, Auto),
    rule("field-tu", "7.18.4", None, Error, Auto),
    rule("font-embedded", "7.21.4.1", None, Error, Manual),
    rule("font-unicode", "7.21.7", None, Error, Manual),
    rule("direction-trap", "—", None, Warning, Auto),
];

/// Look a rule up.
pub fn rule_by_id(id: &str) -> Option<&'static Rule> {
    RULES.iter().find(|r| r.id == id)
}

/// One finding.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub rule: &'static str,
    pub variant: &'static str,
    pub key: String,
    pub clause: &'static str,
    pub matterhorn: Option<&'static str>,
    /// `"12 0 R"`.
    pub object: Option<String>,
    /// 0-based page.
    pub page: Option<usize>,
    /// Structure element (object number).
    pub element: Option<u32>,
    pub params: BTreeMap<String, String>,
    pub message: String,
    pub severity: Severity,
    pub fixable: bool,
    pub fix: FixKind,
}

/// The report.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub findings: Vec<Finding>,
    pub counts: BTreeMap<&'static str, usize>,
    pub error_count: usize,
    pub warning_count: usize,
    pub fixable_count: usize,
    pub rules_checked: usize,
    /// No errors (warnings allowed).
    pub passed: bool,
    /// Some pages were not analysed (document too large).
    pub incomplete: bool,
    /// Always false: this is a subset checker, not a certified PDF/UA validator.
    pub certified: bool,
}

struct Collector {
    findings: Vec<Finding>,
    counts: BTreeMap<&'static str, usize>,
}

struct At {
    object: Option<ObjectId>,
    page: Option<usize>,
    element: Option<u32>,
}

const NOWHERE: At = At {
    object: None,
    page: None,
    element: None,
};

impl Collector {
    fn add(
        &mut self,
        rule_id: &'static str,
        variant: &'static str,
        at: At,
        params: &[(&str, String)],
        message: String,
        fixable: bool,
    ) {
        let Some(r) = rule_by_id(rule_id) else { return };
        let n = self.counts.entry(rule_id).or_default();
        *n += 1;
        if *n > MAX_FINDINGS_PER_RULE {
            return;
        }
        self.findings.push(Finding {
            rule: rule_id,
            variant,
            key: format!("a11y.finding.{rule_id}.{variant}"),
            clause: r.clause,
            matterhorn: r.matterhorn,
            object: at.object.map(|(n, g)| format!("{n} {g} R")),
            page: at.page,
            element: at.element,
            params: params
                .iter()
                .map(|(k, v)| ((*k).to_string(), v.clone()))
                .collect(),
            message,
            severity: r.severity,
            fixable,
            fix: r.fix,
        });
    }
}

fn catalog_vp(pdf: &Pdf) -> Option<Dictionary> {
    let c = pdf.catalog().ok()?;
    match pdf.resolve(c.get(b"ViewerPreferences").ok()?)? {
        Object::Dictionary(d) => Some(d.clone()),
        _ => None,
    }
}

fn suspects(pdf: &Pdf) -> bool {
    let Ok(c) = pdf.catalog() else { return false };
    match c.get(b"MarkInfo").ok().and_then(|o| pdf.resolve(o)) {
        Some(Object::Dictionary(d)) => matches!(
            d.get(b"Suspects").ok().and_then(|o| pdf.resolve(o)),
            Some(Object::Boolean(true))
        ),
        _ => false,
    }
}

fn heading_level(role: &str) -> Option<u8> {
    match role {
        "H1" => Some(1),
        "H2" => Some(2),
        "H3" => Some(3),
        "H4" => Some(4),
        "H5" => Some(5),
        "H6" => Some(6),
        _ => None,
    }
}

fn is_presentation_form(c: char) -> bool {
    ('\u{FB50}'..='\u{FDFF}').contains(&c) || ('\u{FE70}'..='\u{FEFF}').contains(&c)
}

fn preview(s: &str) -> String {
    let t: String = s.chars().take(60).collect();
    if s.chars().count() > 60 {
        format!("{t}…")
    } else {
        t
    }
}

/// Parent tree entries: key → value (bounded walk of the number tree).
fn parent_tree(pdf: &Pdf, tree: &Tree) -> HashMap<i64, Object> {
    let mut out = HashMap::new();
    let Some(pt) = tree.root_dict.get(b"ParentTree").ok() else {
        return out;
    };
    let mut stack: Vec<(Object, usize)> = vec![(pt.clone(), 0)];
    let mut seen = HashSet::new();
    let mut budget = 200_000usize;
    while let Some((o, depth)) = stack.pop() {
        if depth > 32 || budget == 0 {
            break;
        }
        budget -= 1;
        if let Object::Reference(id) = o {
            if !seen.insert(id) {
                continue;
            }
        }
        let Some(Object::Dictionary(d)) = pdf.resolve(&o) else {
            continue;
        };
        if let Ok(Object::Array(nums)) = d
            .get(b"Nums")
            .map(|x| pdf.resolve(x).cloned().unwrap_or(Object::Null))
        {
            for pair in nums.chunks(2).take(1_000_000) {
                if let [Object::Integer(k), v] = pair {
                    out.insert(*k, v.clone());
                }
            }
        }
        if let Some(Object::Array(kids)) = d.get(b"Kids").ok().and_then(|k| pdf.resolve(k)) {
            for k in kids.iter().take(100_000) {
                stack.push((k.clone(), depth + 1));
            }
        }
    }
    out
}

/// Nearest label text for a form field (same line; start side first, else above).
fn field_label(pm: &PageMap, rect_tl: &warraq_text::geom::Rect) -> Option<String> {
    let mut best: Option<(f64, usize)> = None;
    for (i, w) in pm.words.iter().enumerate() {
        if w.artifact {
            continue;
        }
        let overlap = w.bbox.y_overlap(rect_tl);
        if overlap < 0.4 * w.bbox.height().min(rect_tl.height()).max(1.0) {
            continue;
        }
        let gap = if w.bbox.x1 <= rect_tl.x0 {
            rect_tl.x0 - w.bbox.x1
        } else if w.bbox.x0 >= rect_tl.x1 {
            w.bbox.x0 - rect_tl.x1
        } else {
            continue;
        };
        if gap > 200.0 {
            continue;
        }
        if best.is_none_or(|(g, _)| gap < g) {
            best = Some((gap, i));
        }
    }
    let (_, i) = best?;
    let w = pm.words.get(i)?;
    // The words of that line on the same side of the field.
    let left = w.bbox.x1 <= rect_tl.x0;
    let text: Vec<&str> = pm
        .words
        .iter()
        .filter(|x| x.para == w.para && x.line == w.line)
        .filter(|x| {
            if left {
                x.bbox.x1 <= rect_tl.x0
            } else {
                x.bbox.x0 >= rect_tl.x1
            }
        })
        .map(|x| x.text.as_str())
        .collect();
    let label = text.join(" ");
    let label = label
        .trim()
        .trim_end_matches([':', '：'])
        .trim()
        .to_string();
    (!label.is_empty()).then(|| label.chars().take(120).collect())
}

/// The field dictionary chain of a widget (widget first, then parents; bounded).
fn field_chain(pdf: &Pdf, id: ObjectId) -> Vec<ObjectId> {
    let mut out = vec![id];
    let mut cur = id;
    for _ in 0..32 {
        let Some(p) = pdf
            .get_dict(cur)
            .and_then(|d| d.get(b"Parent").ok())
            .and_then(|o| o.as_reference().ok())
        else {
            break;
        };
        if out.contains(&p) {
            break;
        }
        out.push(p);
        cur = p;
    }
    out
}

fn has_tu(pdf: &Pdf, chain: &[ObjectId]) -> bool {
    chain.iter().any(|id| {
        pdf.get_dict(*id)
            .and_then(|d| d.get(b"TU").ok())
            .and_then(|o| pdf.resolve(o))
            .is_some_and(|o| matches!(o, Object::String(s, _) if !s.is_empty()))
    })
}

fn font_embedded(pdf: &Pdf, font: &Dictionary) -> bool {
    let sub = font
        .get(b"Subtype")
        .ok()
        .and_then(|o| o.as_name().ok())
        .unwrap_or(b"");
    if sub == b"Type3" {
        return true;
    }
    let fd_of = |d: &Dictionary| -> Option<Dictionary> {
        match pdf.resolve(d.get(b"FontDescriptor").ok()?)? {
            Object::Dictionary(x) => Some(x.clone()),
            _ => None,
        }
    };
    let fd = if sub == b"Type0" {
        match font
            .get(b"DescendantFonts")
            .ok()
            .and_then(|o| pdf.resolve(o))
        {
            Some(Object::Array(a)) => a.first().and_then(|d| match pdf.resolve(d) {
                Some(Object::Dictionary(x)) => fd_of(x),
                _ => None,
            }),
            _ => None,
        }
    } else {
        fd_of(font)
    };
    fd.is_some_and(|d| d.has(b"FontFile") || d.has(b"FontFile2") || d.has(b"FontFile3"))
}

fn font_unicode_ok(pdf: &Pdf, font: &Dictionary) -> bool {
    if font.has(b"ToUnicode") {
        return true;
    }
    let sub = font
        .get(b"Subtype")
        .ok()
        .and_then(|o| o.as_name().ok())
        .unwrap_or(b"");
    match sub {
        b"Type0" => {
            // Predefined CJK CMaps map to Unicode through their registry; Identity does not.
            let enc = font.get(b"Encoding").ok().and_then(|o| pdf.resolve(o));
            !matches!(enc, Some(Object::Name(n)) if n.starts_with(b"Identity"))
                && !matches!(enc, Some(Object::Stream(_)))
        }
        b"Type3" => false,
        _ => match font.get(b"Encoding").ok().and_then(|o| pdf.resolve(o)) {
            Some(Object::Name(n)) => matches!(
                n.as_slice(),
                b"WinAnsiEncoding"
                    | b"MacRomanEncoding"
                    | b"StandardEncoding"
                    | b"MacExpertEncoding"
            ),
            Some(Object::Dictionary(_)) => true, // Differences with glyph names (AGL)
            _ => {
                // No encoding: the standard 14 non-symbolic fonts are fine.
                let base = font
                    .get(b"BaseFont")
                    .ok()
                    .and_then(|o| o.as_name().ok())
                    .unwrap_or(b"");
                !base.is_empty()
                    && !base.starts_with(b"Symbol")
                    && !base.starts_with(b"ZapfDingbats")
            }
        },
    }
}

/// Run the checker.
pub fn check(pdf: &Pdf) -> Result<Report> {
    let mut c = Collector {
        findings: Vec::new(),
        counts: BTreeMap::new(),
    };
    let tree = Tree::read(pdf);
    let list = pages::flatten(pdf)?;
    let index = page_index(pdf);
    let mut incomplete = list.len() > MAX_CHECK_PAGES || tree.truncated;

    // Document level.
    if !tree.exists() {
        c.add(
            "struct-tree",
            "missing",
            NOWHERE,
            &[],
            "The document has no structure tree (it is not tagged).".into(),
            true,
        );
    }
    if !is_marked(pdf) {
        c.add(
            "marked",
            "missing",
            NOWHERE,
            &[],
            "The catalog does not declare /MarkInfo /Marked true.".into(),
            true,
        );
    }
    if suspects(pdf) {
        c.add(
            "suspects",
            "true",
            NOWHERE,
            &[],
            "/MarkInfo /Suspects is true: the tags may be wrong.".into(),
            true,
        );
    }
    if current_title(pdf).is_none() {
        c.add(
            "title",
            "missing",
            NOWHERE,
            &[],
            "The document has no title (dc:title).".into(),
            true,
        );
    }
    if !display_doc_title(pdf) {
        c.add(
            "display-doc-title",
            "missing",
            NOWHERE,
            &[],
            "/ViewerPreferences /DisplayDocTitle is not true.".into(),
            true,
        );
    }
    if doc_lang(pdf).is_none() {
        c.add(
            "doc-lang",
            "missing",
            NOWHERE,
            &[],
            "The document language (/Lang) is not set.".into(),
            true,
        );
    }
    if let Some(vp) = catalog_vp(pdf) {
        if matches!(vp.get(b"Direction").ok().and_then(|o| pdf.resolve(o)), Some(Object::Name(n)) if n.as_slice() == b"R2L")
        {
            c.add(
                "direction-trap",
                "r2l",
                NOWHERE,
                &[],
                "/ViewerPreferences /Direction /R2L makes some readers read lines backwards."
                    .into(),
                true,
            );
        }
    }

    // Structure.
    let order = tree.preorder();
    let dlang = doc_lang(pdf);
    let page_of = |e: &crate::tree::Elem| -> Option<usize> {
        e.page
            .or_else(|| e.mcrs().find_map(|(_, p, _)| p))
            .and_then(|p| index.get(&p).copied())
    };
    let mut prev_heading = 0u8;
    for (i, _) in &order {
        let Some(e) = tree.elems.get(*i) else {
            continue;
        };
        let role = tree.std_role(&e.s);
        let el = e.id.map(|(n, _)| n);
        let at = || At {
            object: e.id,
            page: page_of(e),
            element: el,
        };
        if !tree.is_standard(&e.s) {
            c.add(
                "role-map",
                "unmapped",
                at(),
                &[("type", e.s.clone())],
                format!("Structure type /{} is not mapped to a standard type.", e.s),
                false,
            );
        }
        if role == "Figure" && e.alt.is_none() && e.actual_text.is_none() {
            c.add(
                "figure-alt",
                "missing",
                at(),
                &[],
                "A figure has no alternate text.".into(),
                false,
            );
        }
        if let Some(l) = heading_level(&role) {
            if l > prev_heading + 1 {
                c.add(
                    "heading-skip",
                    "skipped",
                    at(),
                    &[
                        ("level", l.to_string()),
                        ("expected", (prev_heading + 1).to_string()),
                    ],
                    format!("Heading level H{l} follows H{prev_heading} (levels are skipped)."),
                    true,
                );
                prev_heading += 1;
            } else {
                prev_heading = l;
            }
        }
        if role == "Table" {
            let mut stack: Vec<usize> = e.child_elems().collect();
            let mut has_th = false;
            let mut n = 0;
            while let Some(x) = stack.pop() {
                n += 1;
                if n > 100_000 {
                    break;
                }
                if tree.role(x) == "TH" {
                    has_th = true;
                    break;
                }
                if let Some(xe) = tree.elems.get(x) {
                    if tree.role(x) != "Table" {
                        stack.extend(xe.child_elems());
                    }
                }
            }
            if !has_th {
                c.add(
                    "table-th",
                    "missing",
                    at(),
                    &[],
                    "A table has no header cells (TH).".into(),
                    true,
                );
            }
        }
        if role == "L" {
            let bad = e
                .child_elems()
                .any(|k| !matches!(tree.role(k).as_str(), "LI" | "Caption" | "L"))
                || e.mcrs().next().is_some();
            if bad {
                c.add(
                    "list-structure",
                    "list",
                    at(),
                    &[],
                    "A list (L) contains something other than list items (LI).".into(),
                    true,
                );
            }
        }
        if role == "LI" {
            let parent_ok = e.parent.is_some_and(|p| tree.role(p) == "L");
            let bad = e
                .child_elems()
                .any(|k| !matches!(tree.role(k).as_str(), "Lbl" | "LBody"))
                || e.mcrs().next().is_some();
            if bad || !parent_ok {
                c.add(
                    "list-structure",
                    "item",
                    at(),
                    &[],
                    "A list item (LI) is not inside a list or holds content outside Lbl/LBody."
                        .into(),
                    true,
                );
            }
        }
    }

    // Language of marked content vs the language in effect.
    if tree.exists() && dlang.is_some() {
        let (infos, complete) = crate::structure::page_infos(pdf, &tree);
        incomplete |= !complete;
        for (i, _) in &order {
            let Some(e) = tree.elems.get(*i) else {
                continue;
            };
            let mut eff = e.lang.clone();
            let mut up = e.parent;
            let mut hops = 0;
            while eff.is_none() && hops < 256 {
                let Some(p) = up.and_then(|p| tree.elems.get(p)) else {
                    break;
                };
                eff = p.lang.clone();
                up = p.parent;
                hops += 1;
            }
            let Some(eff) = eff.or_else(|| dlang.clone()) else {
                continue;
            };
            for (mcid, page, stm) in e.mcrs() {
                if stm.is_some() {
                    continue;
                }
                let Some(info) = page.and_then(|p| infos.get(&p)).and_then(|m| m.get(&mcid)) else {
                    continue;
                };
                let Some(d) = lang::detect(&info.text) else {
                    continue;
                };
                if lang::letters(&info.text) < 2 || lang::same(d, &eff) {
                    continue;
                }
                c.add(
                    "lang-mismatch",
                    "text",
                    At {
                        object: e.id,
                        page: page.and_then(|p| index.get(&p).copied()),
                        element: e.id.map(|(n, _)| n),
                    },
                    &[
                        ("lang", eff.clone()),
                        ("detected", d.to_string()),
                        ("text", preview(&info.text)),
                    ],
                    format!(
                        "Text «{}» looks like {d} but is marked as {eff}.",
                        preview(&info.text)
                    ),
                    true,
                );
                break;
            }
        }
    }

    // Parent tree consistency.
    if tree.exists() {
        let pt = parent_tree(pdf, &tree);
        let mut bad_pages: BTreeMap<ObjectId, usize> = BTreeMap::new();
        for (i, _) in &order {
            let Some(e) = tree.elems.get(*i) else {
                continue;
            };
            for (mcid, page, stm) in e.mcrs() {
                if stm.is_some() {
                    continue;
                }
                let Some(p) = page else { continue };
                let key = pdf
                    .get_dict(p)
                    .and_then(|d| d.get(b"StructParents").ok())
                    .and_then(|o| pdf.resolve(o))
                    .and_then(|o| o.as_i64().ok());
                let ok = key
                    .and_then(|k| pt.get(&k))
                    .is_some_and(|v| match pdf.resolve(v) {
                        Some(Object::Array(a)) => usize::try_from(mcid)
                            .ok()
                            .and_then(|m| a.get(m))
                            .is_some_and(|r| r.as_reference().ok() == e.id),
                        _ => false,
                    });
                if !ok {
                    *bad_pages.entry(p).or_default() += 1;
                }
            }
        }
        for (p, n) in bad_pages {
            c.add(
                "parent-tree",
                "missing",
                At {
                    object: Some(p),
                    page: index.get(&p).copied(),
                    element: None,
                },
                &[("count", n.to_string())],
                format!("{n} marked-content references are missing from the parent tree."),
                true,
            );
        }
    }

    // Pages: content, fonts, annotations, fields.
    let tree_mcids = tree.page_mcids();
    let objrs = tree.objrs();
    let mut fonts_seen: HashSet<ObjectId> = HashSet::new();
    for (pi, p) in list.iter().enumerate().take(MAX_CHECK_PAGES) {
        let at_page = || At {
            object: Some(p.id),
            page: Some(pi),
            element: None,
        };
        let pa = annots(pdf, p.id);
        let needing: Vec<(ObjectId, String)> = pa
            .iter()
            .filter_map(|a| {
                annot_kind(pdf, *a)
                    .filter(|(k, h)| annot_needs_tag(k, *h))
                    .map(|(k, _)| (*a, k))
            })
            .collect();
        if !needing.is_empty() {
            let tabs = pdf
                .get_dict(p.id)
                .and_then(|d| d.get(b"Tabs").ok())
                .and_then(|o| o.as_name().ok())
                .map(<[u8]>::to_vec);
            if tabs.as_deref() != Some(b"S") {
                c.add(
                    "tabs-order",
                    "missing",
                    at_page(),
                    &[],
                    "A page with annotations does not set /Tabs /S (structure order).".into(),
                    true,
                );
            }
        }
        let mut widget_pm: Option<PageMap> = None;
        for (a, kind) in &needing {
            if !objrs.contains(a) {
                c.add(
                    "annot-tagged",
                    "missing",
                    At {
                        object: Some(*a),
                        page: Some(pi),
                        element: None,
                    },
                    &[("kind", kind.clone())],
                    format!("A /{kind} annotation is not in the structure tree."),
                    true,
                );
            }
            if kind == "Widget" {
                let chain = field_chain(pdf, *a);
                if !has_tu(pdf, &chain) {
                    if widget_pm.is_none() {
                        widget_pm = PageMap::build(pdf, pi, None).ok();
                    }
                    let label = widget_pm.as_ref().and_then(|pm| {
                        let r = pdf.get_dict(*a).and_then(|d| annot_rect(pdf, d))?;
                        field_label(
                            pm,
                            &pm.to_tl(&warraq_edit::geom::Rect::new(r[0], r[1], r[2], r[3])),
                        )
                    });
                    let fixable = label.is_some();
                    c.add(
                        "field-tu",
                        "missing",
                        At {
                            object: Some(*a),
                            page: Some(pi),
                            element: None,
                        },
                        &[("label", label.unwrap_or_default())],
                        "A form field has no accessible name (/TU).".into(),
                        fixable,
                    );
                }
            }
        }
        let Ok(pm) = PageMap::build_light(pdf, pi) else {
            incomplete = true;
            continue;
        };
        let show_at = pm.show_at();
        let image_at = pm.image_at();
        let known = tree_mcids.get(&p.id);
        let mut untagged = 0usize;
        let mut orphans: HashSet<i64> = HashSet::new();
        let mut ligatures = 0usize;
        for (i, op) in pm.scan.content.ops.iter().enumerate() {
            let Some(m) = pm.marks.get(i) else { break };
            if let Some(x) = m.opens_mcid {
                if !known.is_some_and(|k| k.contains(&x)) {
                    orphans.insert(x);
                }
            }
            let tagged = m.mcid.is_some() || m.artifact;
            if crate::marked::is_path_construct(op) {
                continue;
            }
            let draws = if let Some(Some(si)) = show_at.get(i) {
                let visible = pm.show_visible.get(*si).copied().unwrap_or(false);
                if visible && !m.artifact && !m.actual_text {
                    if let Some(s) = pm.scan.shows.get(*si) {
                        if s.glyphs
                            .iter()
                            .any(|g| g.text.chars().any(is_presentation_form))
                        {
                            ligatures += 1;
                        }
                    }
                }
                visible
            } else if crate::marked::is_path_paint(op)
                || image_at.get(i).is_some_and(Option::is_some)
                || op.is(b"sh")
            {
                true
            } else if op.is(b"Do") {
                match xobject_kind(pdf, &pm, i) {
                    Some("form") => {
                        let id = op
                            .operands
                            .first()
                            .and_then(|o| o.value.name())
                            .and_then(|nm| {
                                let res = warraq_edit::page::resources(pdf, p.id);
                                warraq_edit::page::resource(pdf, &res, b"XObject", nm)
                                    .and_then(|(id, _)| id)
                            });
                        !matches!(form_class(pdf, id), FormClass::Artifact | FormClass::Tagged)
                    }
                    Some(_) => true,
                    None => false,
                }
            } else {
                false
            };
            if draws && !tagged {
                untagged += 1;
            }
            // Fonts of visible, real text.
            if let Some(Some(si)) = show_at.get(i) {
                if let Some(s) = pm.scan.shows.get(*si) {
                    if let (Some(fid), false) = (s.font_id, m.artifact) {
                        if pm.show_visible.get(*si).copied().unwrap_or(false)
                            && fonts_seen.insert(fid)
                        {
                            if let Some(fd) = pdf.get_dict(fid) {
                                let name = String::from_utf8_lossy(
                                    fd.get(b"BaseFont")
                                        .ok()
                                        .and_then(|o| o.as_name().ok())
                                        .unwrap_or(b""),
                                )
                                .into_owned();
                                if !font_embedded(pdf, fd) {
                                    c.add(
                                        "font-embedded",
                                        "missing",
                                        At {
                                            object: Some(fid),
                                            page: Some(pi),
                                            element: None,
                                        },
                                        &[("font", name.clone())],
                                        format!("Font {name} is not embedded."),
                                        false,
                                    );
                                }
                                if !font_unicode_ok(pdf, fd) {
                                    c.add(
                                        "font-unicode",
                                        "missing",
                                        At {
                                            object: Some(fid),
                                            page: Some(pi),
                                            element: None,
                                        },
                                        &[("font", name.clone())],
                                        format!("Font {name} has no ToUnicode map."),
                                        false,
                                    );
                                }
                            }
                        }
                    }
                }
            }
        }
        if untagged > 0 {
            c.add(
                "untagged-content",
                "page",
                at_page(),
                &[("count", untagged.to_string())],
                format!("{untagged} drawing operations are neither tagged nor artifacts."),
                true,
            );
        }
        if !orphans.is_empty() && tree.exists() {
            c.add(
                "orphan-mcid",
                "page",
                at_page(),
                &[("count", orphans.len().to_string())],
                format!(
                    "{} marked-content sequences belong to no structure element.",
                    orphans.len()
                ),
                true,
            );
        }
        if ligatures > 0 {
            c.add("ligature-actualtext", "page", at_page(), &[("count", ligatures.to_string())], format!("{ligatures} Arabic text runs use presentation-form glyphs without /ActualText."), false);
        }
    }

    let counted = |s: Severity| -> usize {
        c.counts
            .iter()
            .filter(|(id, _)| rule_by_id(id).is_some_and(|r| r.severity == s))
            .map(|(_, n)| *n)
            .sum()
    };
    let errors = counted(Severity::Error);
    let warnings = counted(Severity::Warning);
    let fixable = c.findings.iter().filter(|f| f.fixable).count();
    Ok(Report {
        error_count: errors,
        warning_count: warnings,
        fixable_count: fixable,
        rules_checked: RULES.len(),
        passed: errors == 0,
        incomplete,
        certified: false,
        findings: c.findings,
        counts: c.counts,
    })
}

/// What [`fix`] did.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FixReport {
    /// Rule ids repaired.
    pub applied: Vec<String>,
    /// Rules asked for that could not be repaired (e.g. no title given).
    pub skipped: Vec<String>,
}

/// Apply the automatic fixes for `rules` (all fixable rules when empty). `title` repairs `title`.
pub fn fix(pdf: &mut Pdf, rules: &[String], title: Option<&str>) -> Result<FixReport> {
    pdf.require("changing the document's tags", |p| p.modify)?;
    for r in rules {
        if rule_by_id(r).is_none() {
            return Err(A11yError::Params(format!("unknown rule {r:?}")));
        }
    }
    let report = check(pdf)?;
    let want = |id: &str| rules.is_empty() || rules.iter().any(|r| r == id);
    let found = |id: &str| report.counts.get(id).copied().unwrap_or(0) > 0;
    let wanted = |id: &str| want(id) && found(id);
    let mut out = FixReport::default();
    let title = title.map(str::trim).filter(|t| !t.is_empty());

    // 1. Tagging: retag (explicitly asked) or tag what is untagged.
    let retag = (wanted("suspects") || wanted("orphan-mcid")) && !rules.is_empty();
    let tag_rules = ["struct-tree", "untagged-content", "annot-tagged", "marked"];
    let needs_tag = tag_rules.iter().any(|r| wanted(r))
        && (!Tree::read(pdf).exists() || wanted("untagged-content") || wanted("annot-tagged"));
    if retag || needs_tag {
        autotag(
            pdf,
            &Options {
                retag,
                title: title.map(str::to_string).filter(|_| want("title")),
                lang: None,
            },
        )?;
        for r in [
            "struct-tree",
            "untagged-content",
            "annot-tagged",
            "marked",
            "tabs-order",
            "parent-tree",
        ] {
            if wanted(r) {
                out.applied.push(r.to_string());
            }
        }
        if retag {
            for r in ["suspects", "orphan-mcid"] {
                if wanted(r) {
                    out.applied.push(r.to_string());
                }
            }
        }
    }

    // 2. Structure fixes on the (possibly new) tree.
    let mut tree = Tree::read(pdf);
    let mut tree_changed = false;
    if tree.exists() && !tree.truncated {
        if wanted("heading-skip") {
            let mut prev = 0u8;
            for (i, _) in tree.preorder() {
                if let Some(l) = heading_level(&tree.role(i)) {
                    let nl = if l > prev + 1 { prev + 1 } else { l };
                    if nl != l {
                        if let Some(e) = tree.elems.get_mut(i) {
                            e.s = format!("H{nl}");
                            e.dirty = true;
                        }
                        tree_changed = true;
                    }
                    prev = nl;
                }
            }
            out.applied.push("heading-skip".into());
        }
        if wanted("table-th") {
            for (i, _) in tree.preorder() {
                if tree.role(i) != "Table" {
                    continue;
                }
                let has_th = subtree(&tree, i).iter().any(|x| tree.role(*x) == "TH");
                if has_th {
                    continue;
                }
                // First row: the first TR (directly or in THead/TBody).
                let first_tr = subtree(&tree, i)
                    .into_iter()
                    .find(|x| tree.role(*x) == "TR");
                if let Some(tr) = first_tr {
                    let cells: Vec<usize> = tree
                        .elems
                        .get(tr)
                        .map(|e| e.child_elems().collect())
                        .unwrap_or_default();
                    for cidx in cells {
                        if tree.role(cidx) == "TD" {
                            if let Some(ce) = tree.elems.get_mut(cidx) {
                                ce.s = "TH".into();
                                let mut a = Dictionary::new();
                                a.set("O", Object::Name(b"Table".to_vec()));
                                a.set("Scope", Object::Name(b"Column".to_vec()));
                                ce.dict.set("A", Object::Dictionary(a));
                                ce.dirty = true;
                                tree_changed = true;
                            }
                        }
                    }
                }
            }
            out.applied.push("table-th".into());
        }
        if wanted("list-structure") {
            tree_changed |= fix_lists(&mut tree);
            out.applied.push("list-structure".into());
        }
        if wanted("lang-mismatch") {
            tree_changed |= fix_langs(pdf, &mut tree);
            out.applied.push("lang-mismatch".into());
        }
        if wanted("parent-tree") && !out.applied.iter().any(|a| a == "parent-tree") {
            tree.root_dirty = true;
            tree_changed = true;
            out.applied.push("parent-tree".into());
        }
        if tree_changed {
            tree.write(pdf)?;
        }
    }

    // 3. Document level.
    if wanted("title") && !out.applied.iter().any(|a| a == "title") {
        match title {
            Some(t) if current_title(pdf).is_none() => {
                set_title(pdf, t)?;
                out.applied.push("title".into());
            }
            _ if current_title(pdf).is_some() => out.applied.push("title".into()),
            _ => out.skipped.push("title".into()),
        }
    }
    if wanted("display-doc-title") {
        set_display_doc_title(pdf)?;
        out.applied.push("display-doc-title".into());
    }
    if wanted("marked") && !out.applied.iter().any(|a| a == "marked") {
        let id = pdf.root_id()?;
        let mut cat = pdf.catalog()?.clone();
        let mut mi = match cat.get(b"MarkInfo").ok().and_then(|o| pdf.resolve(o)) {
            Some(Object::Dictionary(d)) => d.clone(),
            _ => Dictionary::new(),
        };
        mi.set("Marked", Object::Boolean(true));
        cat.set("MarkInfo", Object::Dictionary(mi));
        pdf.set(id, Object::Dictionary(cat));
        out.applied.push("marked".into());
    }
    if wanted("doc-lang") && doc_lang(pdf).is_none() {
        let n = list_len(pdf);
        let idx: Vec<usize> = (0..n.min(MAX_CHECK_PAGES)).collect();
        let texts = extract(pdf, &idx)?;
        let st = crate::classify::stats(&texts);
        match st.lang {
            Some(l) => {
                let id = pdf.root_id()?;
                let mut cat = pdf.catalog()?.clone();
                cat.set(
                    "Lang",
                    Object::String(l.as_bytes().to_vec(), StringFormat::Literal),
                );
                pdf.set(id, Object::Dictionary(cat));
                out.applied.push("doc-lang".into());
            }
            None => out.skipped.push("doc-lang".into()),
        }
    }
    if wanted("direction-trap") {
        let id = pdf.root_id()?;
        let mut cat = pdf.catalog()?.clone();
        match cat.get(b"ViewerPreferences").ok().cloned() {
            Some(Object::Reference(r)) => {
                if let Some(mut d) = pdf.get_dict(r).cloned() {
                    d.remove(b"Direction");
                    pdf.set(r, Object::Dictionary(d));
                }
            }
            Some(Object::Dictionary(mut d)) => {
                d.remove(b"Direction");
                cat.set("ViewerPreferences", Object::Dictionary(d));
                pdf.set(id, Object::Dictionary(cat));
            }
            _ => {}
        }
        out.applied.push("direction-trap".into());
    }
    if wanted("tabs-order") && !out.applied.iter().any(|a| a == "tabs-order") {
        for p in pages::flatten(pdf)? {
            if annots(pdf, p.id).is_empty() {
                continue;
            }
            if let Some(mut d) = pdf.get_dict(p.id).cloned() {
                d.set("Tabs", Object::Name(b"S".to_vec()));
                pdf.set(p.id, Object::Dictionary(d));
            }
        }
        out.applied.push("tabs-order".into());
    }
    if wanted("field-tu") {
        let mut any = false;
        for (pi, p) in pages::flatten(pdf)?.into_iter().enumerate() {
            let widgets: Vec<ObjectId> = annots(pdf, p.id)
                .into_iter()
                .filter(|a| annot_kind(pdf, *a).is_some_and(|(k, h)| k == "Widget" && !h))
                .filter(|a| !has_tu(pdf, &field_chain(pdf, *a)))
                .collect();
            if widgets.is_empty() {
                continue;
            }
            let Ok(pm) = PageMap::build(pdf, pi, None) else {
                continue;
            };
            for a in widgets {
                let Some(r) = pdf.get_dict(a).and_then(|d| annot_rect(pdf, d)) else {
                    continue;
                };
                let Some(label) = field_label(
                    &pm,
                    &pm.to_tl(&warraq_edit::geom::Rect::new(r[0], r[1], r[2], r[3])),
                ) else {
                    continue;
                };
                // TU belongs on the field: the widget when it is the field (has /T), else its parent.
                let chain = field_chain(pdf, a);
                let target = chain
                    .iter()
                    .copied()
                    .find(|id| pdf.get_dict(*id).is_some_and(|d| d.has(b"T")))
                    .unwrap_or(a);
                if let Some(mut d) = pdf.get_dict(target).cloned() {
                    d.set("TU", warraq_pdf::metadata::encode_text(&label));
                    pdf.set(target, Object::Dictionary(d));
                    any = true;
                }
            }
        }
        if any {
            out.applied.push("field-tu".into());
        } else {
            out.skipped.push("field-tu".into());
        }
    }
    out.applied.sort();
    out.applied.dedup();
    Ok(out)
}

fn list_len(pdf: &Pdf) -> usize {
    pages::count(pdf).unwrap_or(0)
}

fn subtree(tree: &Tree, i: usize) -> Vec<usize> {
    let mut out = Vec::new();
    let mut stack: Vec<usize> = tree
        .elems
        .get(i)
        .map(|e| e.child_elems().collect())
        .unwrap_or_default();
    stack.reverse();
    while let Some(x) = stack.pop() {
        out.push(x);
        if out.len() > 200_000 {
            break;
        }
        if let Some(e) = tree.elems.get(x) {
            let mut kids: Vec<usize> = e.child_elems().collect();
            kids.reverse();
            stack.extend(kids);
        }
    }
    out
}

/// Wrap stray list content: L kids that are not LI become LI > LBody; LI content outside
/// Lbl/LBody moves into an LBody.
fn fix_lists(tree: &mut Tree) -> bool {
    let mut changed = false;
    let order: Vec<usize> = tree.preorder().into_iter().map(|(i, _)| i).collect();
    for i in order {
        let role = tree.role(i);
        if role == "L" {
            let kids = tree
                .elems
                .get(i)
                .map(|e| e.kids.clone())
                .unwrap_or_default();
            let mut out = Vec::with_capacity(kids.len());
            let page = tree.elems.get(i).and_then(|e| e.page);
            for k in kids {
                let wrap = match &k {
                    Kid::Elem(c) => !matches!(tree.role(*c).as_str(), "LI" | "Caption" | "L"),
                    Kid::Mcr { .. } => true,
                    _ => false,
                };
                if !wrap {
                    out.push(k);
                    continue;
                }
                tree.elems.push(crate::tree::Elem::new("LI", Some(i), page));
                let li_i = tree.elems.len() - 1;
                let b_i = li_i + 1;
                if let Kid::Elem(c) = &k {
                    if let Some(ce) = tree.elems.get_mut(*c) {
                        ce.parent = Some(b_i);
                        ce.dirty = true;
                    }
                }
                let mut body = crate::tree::Elem::new("LBody", Some(li_i), page);
                body.kids = vec![k];
                tree.elems.push(body);
                if let Some(l) = tree.elems.get_mut(li_i) {
                    l.kids.push(Kid::Elem(b_i));
                }
                out.push(Kid::Elem(li_i));
                changed = true;
            }
            if let Some(e) = tree.elems.get_mut(i) {
                e.kids = out;
                e.dirty = true;
            }
        } else if role == "LI" {
            let kids = tree
                .elems
                .get(i)
                .map(|e| e.kids.clone())
                .unwrap_or_default();
            let stray: Vec<Kid> = kids
                .iter()
                .filter(|k| match k {
                    Kid::Elem(c) => !matches!(tree.role(*c).as_str(), "Lbl" | "LBody"),
                    Kid::Mcr { .. } => true,
                    _ => false,
                })
                .cloned()
                .collect();
            if stray.is_empty() {
                continue;
            }
            let page = tree.elems.get(i).and_then(|e| e.page);
            let mut body = crate::tree::Elem::new("LBody", Some(i), page);
            body.kids = stray.clone();
            tree.elems.push(body);
            let b_i = tree.elems.len() - 1;
            for k in &stray {
                if let Kid::Elem(c) = k {
                    if let Some(ce) = tree.elems.get_mut(*c) {
                        ce.parent = Some(b_i);
                        ce.dirty = true;
                    }
                }
            }
            if let Some(e) = tree.elems.get_mut(i) {
                e.kids.retain(|k| !stray.contains(k));
                e.kids.push(Kid::Elem(b_i));
                e.dirty = true;
            }
            changed = true;
        }
    }
    changed
}

/// Set `/Lang` where marked content's script disagrees with the language in effect: on the
/// element when all its own text agrees on one language, else on a `Span` around each MCID.
fn fix_langs(pdf: &Pdf, tree: &mut Tree) -> bool {
    let Some(dlang) = doc_lang(pdf) else {
        return false;
    };
    let (infos, _) = crate::structure::page_infos(pdf, tree);
    let mut changed = false;
    let order: Vec<usize> = tree.preorder().into_iter().map(|(i, _)| i).collect();
    for i in order {
        let (eff, mcrs, page) = {
            let Some(e) = tree.elems.get(i) else { continue };
            let mut eff = e.lang.clone();
            let mut up = e.parent;
            let mut hops = 0;
            while eff.is_none() && hops < 256 {
                let Some(p) = up.and_then(|p| tree.elems.get(p)) else {
                    break;
                };
                eff = p.lang.clone();
                up = p.parent;
                hops += 1;
            }
            (
                eff.unwrap_or_else(|| dlang.clone()),
                e.mcrs().collect::<Vec<_>>(),
                e.page,
            )
        };
        let mut detected: Vec<(i64, Option<ObjectId>, Option<&'static str>)> = Vec::new();
        for (mcid, p, stm) in &mcrs {
            if stm.is_some() {
                continue;
            }
            let d = p
                .and_then(|p| infos.get(&p))
                .and_then(|m| m.get(mcid))
                .filter(|info| lang::letters(&info.text) >= 2)
                .and_then(|info| lang::detect(&info.text));
            detected.push((*mcid, *p, d));
        }
        let strong: Vec<&'static str> = detected.iter().filter_map(|(_, _, d)| *d).collect();
        if strong.is_empty() || strong.iter().all(|d| lang::same(d, &eff)) {
            continue;
        }
        let first = strong.first().copied().unwrap_or("");
        if strong.iter().all(|d| *d == first) {
            if let Some(e) = tree.elems.get_mut(i) {
                e.lang = Some(first.to_string());
                e.dirty = true;
                changed = true;
            }
            continue;
        }
        // Mixed: wrap mismatching MCIDs in Spans.
        for (mcid, p, d) in detected {
            let Some(d) = d else { continue };
            if lang::same(d, &eff) {
                continue;
            }
            let mut span = crate::tree::Elem::new("Span", Some(i), page);
            span.lang = Some(d.to_string());
            span.kids = vec![Kid::Mcr {
                mcid,
                page: p.filter(|x| Some(*x) != page),
                stm: None,
            }];
            tree.elems.push(span);
            let si = tree.elems.len() - 1;
            if let Some(e) = tree.elems.get_mut(i) {
                for k in e.kids.iter_mut() {
                    if let Kid::Mcr {
                        mcid: m, stm: None, ..
                    } = k
                    {
                        if *m == mcid {
                            *k = Kid::Elem(si);
                            break;
                        }
                    }
                }
                e.dirty = true;
            }
            changed = true;
        }
    }
    changed
}
