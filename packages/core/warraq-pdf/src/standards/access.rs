//! The accessibility checker: the rules of PDF/UA-1 (ISO 14289-1) and WCAG
//! 2.1 that can be read from a file, each with what it found, the pages it
//! is on, and whether Warraq can put it right by itself.
//!
//! It is not a PDF/UA validator. It checks what `CHECKS` lists and says
//! which things only a person can judge — colour contrast, whether the
//! reading order makes sense, whether an alternative text says what a
//! picture shows — as such, never as passed.
use std::collections::BTreeSet;

use lopdf::Object;

use super::fonts;
use super::scan::ScanOptions;
use super::{dict_of, name};
use crate::document::decode_text_string;
use crate::PdfDocument;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Status {
    Failed,
    Warning,
    /// Only a person can judge it.
    Manual,
    Passed,
}

impl Status {
    pub fn key(self) -> &'static str {
        match self {
            Status::Failed => "failed",
            Status::Warning => "warning",
            Status::Manual => "manual",
            Status::Passed => "passed",
        }
    }
}

/// One check's outcome.
#[derive(Debug, Clone, PartialEq)]
pub struct Check {
    pub id: &'static str,
    /// PDF/UA-1 clause, and WCAG 2.1 success criterion.
    pub clause: &'static str,
    pub wcag: &'static str,
    pub status: Status,
    /// A count, a name, a language: what the interface shows beside it.
    pub detail: String,
    pub pages: Vec<usize>,
    /// Warraq can put it right without asking: which fix does.
    pub fix: Option<&'static str>,
}

/// What the checker checks, in the order it reports it: id, PDF/UA-1 clause,
/// WCAG 2.1 criterion.
pub const CHECKS: &[(&str, &str, &str)] = &[
    ("tagged", "7.1", "1.3.1"),
    ("untagged", "7.1", "1.3.1"),
    ("title", "7.1", "2.4.2"),
    ("displayTitle", "7.1", "2.4.2"),
    ("language", "7.2", "3.1.1"),
    ("altText", "7.3", "1.1.1"),
    ("tableHeaders", "7.5", "1.3.1"),
    ("headings", "7.4", "2.4.6"),
    ("fontsEmbedded", "7.21.4.1", "-"),
    ("fontsUnicode", "7.21.7", "1.1.1"),
    ("annotationsTagged", "7.18.1", "4.1.2"),
    ("tabOrder", "7.18.3", "2.4.3"),
    ("fieldTooltips", "7.18.1", "4.1.2"),
    ("bookmarks", "7.17", "2.4.5"),
    ("readingOrder", "7.1", "1.3.2"),
    ("contrast", "-", "1.4.3"),
];

/// Pages beyond which a document wants bookmarks (WCAG technique PDF2).
const LONG: usize = 20;

fn check(id: &'static str) -> Check {
    let (_, clause, wcag) = CHECKS
        .iter()
        .find(|c| c.0 == id)
        .copied()
        .unwrap_or((id, "-", "-"));
    Check {
        id,
        clause,
        wcag,
        status: Status::Passed,
        detail: String::new(),
        pages: vec![],
        fix: None,
    }
}

impl PdfDocument {
    /// Runs every check in `CHECKS`.
    pub fn accessibility_check(&self) -> Vec<Check> {
        let doc = &self.doc;
        let catalog = doc.catalog().ok();
        let tagged = self.is_tagged();
        let leaves = self.structure_leaves();
        let scan = self.scan_content(ScanOptions::default());
        let mut out = vec![];

        let mut c = check("tagged");
        if !tagged {
            c.status = Status::Failed;
            c.fix = Some("tag");
        }
        out.push(c);

        let mut c = check("untagged");
        let pages: Vec<usize> = scan
            .pages
            .iter()
            .enumerate()
            .filter(|(_, p)| p.untagged > 0)
            .map(|(i, _)| i)
            .collect();
        if tagged && !pages.is_empty() {
            c.status = Status::Failed;
            c.detail = scan
                .pages
                .iter()
                .map(|p| p.untagged)
                .sum::<usize>()
                .to_string();
            c.pages = pages;
            c.fix = Some("tag");
        } else if !tagged {
            c.status = Status::Failed;
            c.fix = Some("tag");
        }
        out.push(c);

        let title = self.metadata().title.filter(|t| !t.trim().is_empty());
        let mut c = check("title");
        match &title {
            Some(t) => c.detail = t.clone(),
            None => {
                c.status = Status::Failed;
                c.fix = Some("title");
            }
        }
        out.push(c);

        let mut c = check("displayTitle");
        let shows = catalog
            .and_then(|c| dict_of(doc, c.get(b"ViewerPreferences").ok()))
            .and_then(|p| p.get(b"DisplayDocTitle").ok())
            .and_then(|v| v.as_bool().ok())
            == Some(true);
        if !shows {
            c.status = Status::Failed;
            c.fix = Some("displayTitle");
        }
        out.push(c);

        let mut c = check("language");
        let lang = catalog
            .and_then(|c| c.get(b"Lang").ok())
            .and_then(|l| l.as_str().ok())
            .map(decode_text_string)
            .filter(|l| {
                let primary = l.split('-').next().unwrap_or("");
                (2..=3).contains(&primary.len()) && primary.chars().all(|c| c.is_ascii_alphabetic())
            });
        match lang {
            Some(l) => c.detail = l,
            None => {
                c.status = Status::Failed;
                c.fix = Some("language");
            }
        }
        out.push(c);

        // Figures, and their alternative text.
        let figures: Vec<_> = leaves.iter().filter(|l| l.role == "Figure").collect();
        let mut c = check("altText");
        let missing: Vec<_> = figures
            .iter()
            .filter(|l| l.alt.as_deref().is_none_or(|a| a.trim().is_empty()) && l.text.is_none())
            .collect();
        if !missing.is_empty() {
            c.status = Status::Failed;
            c.detail = format!("{}/{}", missing.len(), figures.len());
            c.pages = missing
                .iter()
                .map(|l| l.page)
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect();
        } else if !figures.is_empty() {
            // Present, but whether it says what the picture shows is a person's call.
            c.status = Status::Manual;
            c.detail = figures.len().to_string();
        }
        out.push(c);

        let mut c = check("tableHeaders");
        let tables: BTreeSet<u32> = leaves
            .iter()
            .filter_map(|l| l.cell.map(|(t, _, _)| t))
            .collect();
        let headed: BTreeSet<u32> = leaves
            .iter()
            .filter(|l| l.role == "TH")
            .filter_map(|l| l.cell.map(|(t, _, _)| t))
            .collect();
        let bare: Vec<u32> = tables.difference(&headed).copied().collect();
        if !bare.is_empty() {
            c.status = Status::Failed;
            c.detail = format!("{}/{}", bare.len(), tables.len());
            c.pages = leaves
                .iter()
                .filter(|l| l.cell.is_some_and(|(t, _, _)| bare.contains(&t)))
                .map(|l| l.page)
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect();
        }
        out.push(c);

        // Headings: present in a long text, starting at level 1, none skipped.
        let mut c = check("headings");
        let levels: Vec<(u8, usize)> = leaves
            .iter()
            .filter_map(|l| Some((l.role.strip_prefix('H')?.parse::<u8>().ok()?, l.page)))
            .collect();
        let mut skipped = vec![];
        let mut previous = 0u8;
        for (level, page) in &levels {
            if *level > previous + 1 {
                skipped.push(*page);
            }
            previous = *level;
        }
        if tagged && levels.is_empty() && self.page_count() > 1 {
            c.status = Status::Warning;
            c.detail = "none".into();
        } else if !skipped.is_empty() {
            c.status = Status::Warning;
            c.detail = "skipped".into();
            c.pages = skipped
                .into_iter()
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect();
        }
        out.push(c);

        // Fonts.
        let mut embedded = check("fontsEmbedded");
        let mut unicode = check("fontsUnicode");
        let (mut not_embedded, mut no_unicode) = (BTreeSet::new(), BTreeSet::new());
        let (mut ne_pages, mut nu_pages) = (BTreeSet::new(), BTreeSet::new());
        for font in &scan.fonts {
            let facts = fonts::facts(doc, &font.dict);
            let label = facts
                .base_font
                .split_once('+')
                .map(|(_, b)| b.to_string())
                .unwrap_or(facts.base_font.clone());
            if !facts.embedded() {
                not_embedded.insert(label.clone());
                ne_pages.extend(font.pages.iter().copied());
            }
            if !fonts::unmapped_codes(doc, font, &facts).is_empty() {
                no_unicode.insert(label);
                nu_pages.extend(font.pages.iter().copied());
            }
        }
        if !not_embedded.is_empty() {
            embedded.status = Status::Failed;
            embedded.detail = not_embedded.into_iter().collect::<Vec<_>>().join(", ");
            embedded.pages = ne_pages.into_iter().collect();
        }
        if !no_unicode.is_empty() {
            unicode.status = Status::Failed;
            unicode.detail = no_unicode.into_iter().collect::<Vec<_>>().join(", ");
            unicode.pages = nu_pages.into_iter().collect();
        }
        out.push(embedded);
        out.push(unicode);

        // Annotations: tagged, in structure order; form fields named.
        let mut untagged_annots = BTreeSet::new();
        let mut tab_pages = BTreeSet::new();
        let mut unnamed = BTreeSet::new();
        for (index, page) in self.pages.iter().enumerate() {
            let annots = self.page_annotations(*page);
            let content: Vec<_> = annots
                .iter()
                .filter(|(_, a)| {
                    !matches!(
                        name(a.get(b"Subtype").ok()),
                        Some(b"Popup" | b"PrinterMark" | b"TrapNet")
                    )
                })
                .filter(|(_, a)| {
                    a.get(b"F").ok().and_then(|f| f.as_i64().ok()).unwrap_or(0) & 2 == 0
                })
                .collect();
            if content.is_empty() {
                continue;
            }
            if content.iter().any(|(_, a)| !a.has(b"StructParent")) {
                untagged_annots.insert(index);
            }
            let tabs = doc
                .get_dictionary(*page)
                .ok()
                .and_then(|d| name(d.get(b"Tabs").ok()));
            if tabs != Some(b"S") {
                tab_pages.insert(index);
            }
            for (_, a) in &content {
                if name(a.get(b"Subtype").ok()) != Some(b"Widget") {
                    continue;
                }
                // The tooltip may sit on the field the widget belongs to.
                let mut d = Some(*a);
                let mut named = false;
                for _ in 0..16 {
                    let Some(field) = d else { break };
                    if field.has(b"TU") {
                        named = true;
                        break;
                    }
                    d = dict_of(doc, field.get(b"Parent").ok());
                }
                if !named {
                    unnamed.insert(index);
                }
            }
        }
        let mut c = check("annotationsTagged");
        if !untagged_annots.is_empty() {
            c.status = Status::Failed;
            c.pages = untagged_annots.into_iter().collect();
            c.fix = Some("tag");
        }
        out.push(c);
        let mut c = check("tabOrder");
        if !tab_pages.is_empty() {
            c.status = Status::Failed;
            c.pages = tab_pages.into_iter().collect();
            c.fix = Some("tabOrder");
        }
        out.push(c);
        let mut c = check("fieldTooltips");
        if !unnamed.is_empty() {
            c.status = Status::Failed;
            c.pages = unnamed.into_iter().collect();
            c.fix = Some("fieldTooltips");
        }
        out.push(c);

        let mut c = check("bookmarks");
        let has_outline = catalog
            .and_then(|c| dict_of(doc, c.get(b"Outlines").ok()))
            .is_some_and(|o| o.has(b"First"));
        if self.page_count() > LONG && !has_outline {
            c.status = Status::Failed;
            c.detail = self.page_count().to_string();
            if levels.is_empty() {
                c.fix = None;
            } else {
                c.fix = Some("bookmarks");
            }
        }
        out.push(c);

        // What only a person can judge.
        let mut c = check("readingOrder");
        c.status = if tagged {
            Status::Manual
        } else {
            Status::Failed
        };
        if !tagged {
            c.fix = Some("tag");
        }
        out.push(c);
        let mut c = check("contrast");
        c.status = Status::Manual;
        out.push(c);

        let _ = Object::Null;
        out
    }
}

#[cfg(test)]
mod tests {
    use super::super::tagging::{Block, TagPlan};
    use super::*;

    fn corpus(name: &str) -> Vec<u8> {
        std::fs::read(format!(
            "{}/../../../tests/corpus/arabic/{name}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap()
    }

    fn status(checks: &[Check], id: &str) -> Status {
        checks.iter().find(|c| c.id == id).unwrap().status
    }

    #[test]
    fn an_untagged_file_fails_and_is_fixed_by_tagging() {
        let mut doc = PdfDocument::open(
            corpus("generated/coretext-sfarabic-mixed-invoice.pdf"),
            None,
        )
        .unwrap();
        let before = doc.accessibility_check();
        for id in [
            "tagged",
            "untagged",
            "language",
            "displayTitle",
            "readingOrder",
        ] {
            assert_eq!(status(&before, id), Status::Failed, "{id}");
        }
        assert_eq!(status(&before, "contrast"), Status::Manual);
        let (w, h) = doc.page_size(0).unwrap();
        doc.apply_tags(&TagPlan {
            pages: vec![vec![
                Block::new("H1", [0.0, 0.0, w, 90.0]),
                Block::new("P", [0.0, 90.0, w, h]),
            ]],
            lang: "ar".into(),
            title: Some("فاتورة".into()),
        })
        .unwrap();
        let doc = PdfDocument::open(doc.save_incremental().unwrap(), None).unwrap();
        let after = doc.accessibility_check();
        for id in ["tagged", "untagged", "title", "displayTitle", "language"] {
            assert_eq!(
                status(&after, id),
                Status::Passed,
                "{id}: {:?}",
                after.iter().find(|c| c.id == id)
            );
        }
        assert_eq!(
            after.iter().find(|c| c.id == "language").unwrap().detail,
            "ar"
        );
        assert_eq!(status(&after, "readingOrder"), Status::Manual);
    }

    #[test]
    fn every_check_is_reported_once_in_order() {
        let doc =
            PdfDocument::open(corpus("generated/acroform-pdflib-arabic-fields.pdf"), None).unwrap();
        let checks = doc.accessibility_check();
        let ids: Vec<&str> = checks.iter().map(|c| c.id).collect();
        let expected: Vec<&str> = CHECKS.iter().map(|c| c.0).collect();
        assert_eq!(ids, expected);
        assert!(checks.iter().all(|c| c.clause != "-" || c.id == "contrast"));
    }
}
