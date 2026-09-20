//! Preflight, light: what a print shop checks before a file goes to press —
//! fonts that are not embedded, pictures too coarse for print, RGB where the
//! press prints CMYK, spot colours, transparency, trim and bleed boxes,
//! hairlines — as a list of findings, each with the pages it is on.
use std::collections::{BTreeMap, BTreeSet};

use lopdf::Object;

use super::fonts;
use super::scan::ScanOptions;
use crate::PdfDocument;

/// What to hold a file to.
#[derive(Debug, Clone, Copy)]
pub struct Options {
    /// Pictures placed at fewer pixels per inch than this are flagged
    /// (twice this for one-bit line art).
    pub min_ppi: f32,
    /// Strokes thinner than this, in points, are hairlines.
    pub hairline: f32,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            min_ppi: 150.0,
            hairline: 0.25,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Severity {
    Error,
    Warning,
    Info,
}

impl Severity {
    pub fn key(self) -> &'static str {
        match self {
            Severity::Error => "error",
            Severity::Warning => "warning",
            Severity::Info => "info",
        }
    }
}

/// One finding.
#[derive(Debug, Clone, PartialEq)]
pub struct Item {
    pub check: &'static str,
    pub severity: Severity,
    /// What it is about: a font's name, a resolution, colourant names.
    pub detail: String,
    /// Pages it is on (0-based), in order.
    pub pages: Vec<usize>,
}

/// The whole report.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Report {
    pub items: Vec<Item>,
    /// Page sizes in points, each with the pages that have it.
    pub sizes: Vec<((f32, f32), Vec<usize>)>,
    pub fonts: usize,
    pub images: usize,
    /// The file is too large to read whole: the report covers what was read.
    pub truncated: bool,
}

/// Checks the preflight runs, in the order it reports them.
pub const CHECKS: &[&str] = &[
    "fontNotEmbedded",
    "type3Font",
    "lowResolution",
    "rgb",
    "cmyk",
    "spotColour",
    "transparency",
    "noTrimBox",
    "noBleedBox",
    "boxes",
    "hairline",
    "encrypted",
];

impl PdfDocument {
    /// Runs the preflight: see the module documentation.
    pub fn preflight(&self, options: Options) -> Report {
        let doc = &self.doc;
        let scan = self.scan_content(ScanOptions {
            hairline: options.hairline,
        });
        let mut report = Report {
            fonts: scan.fonts.len(),
            images: scan.images.len(),
            truncated: scan.truncated,
            ..Default::default()
        };
        let mut push =
            |check: &'static str, severity: Severity, detail: String, pages: BTreeSet<usize>| {
                if !pages.is_empty() || check == "encrypted" {
                    report.items.push(Item {
                        check,
                        severity,
                        detail,
                        pages: pages.into_iter().collect(),
                    });
                }
            };
        for font in &scan.fonts {
            let facts = fonts::facts(doc, &font.dict);
            let label = facts
                .base_font
                .split_once('+')
                .map(|(_, b)| b.to_string())
                .unwrap_or(facts.base_font.clone());
            if !facts.embedded() && font.visible {
                push(
                    "fontNotEmbedded",
                    Severity::Error,
                    label,
                    font.pages.clone(),
                );
            } else if facts.subtype == "Type3" {
                push("type3Font", Severity::Info, label, font.pages.clone());
            }
        }
        // Pictures, the coarsest first, one finding per resolution band.
        let mut coarse: BTreeMap<u32, BTreeSet<usize>> = BTreeMap::new();
        for image in &scan.images {
            if image.in_annotation || !image.ppi.is_finite() || image.width < 2 || image.height < 2
            {
                continue;
            }
            let needed = if image.bits == 1 || image.mask {
                options.min_ppi * 2.0
            } else {
                options.min_ppi
            };
            if image.ppi + 0.5 < needed {
                coarse
                    .entry(image.ppi.round() as u32)
                    .or_default()
                    .insert(image.page);
            }
        }
        for (ppi, pages) in coarse {
            push("lowResolution", Severity::Warning, ppi.to_string(), pages);
        }
        let mut rgb = BTreeSet::new();
        let mut cmyk = BTreeSet::new();
        let mut spots: BTreeMap<String, BTreeSet<usize>> = BTreeMap::new();
        let mut transparency: BTreeMap<&'static str, BTreeSet<usize>> = BTreeMap::new();
        let mut hairlines = BTreeSet::new();
        let mut thinnest = f32::MAX;
        let icc_n = |id: &lopdf::ObjectId| {
            doc.get_object(*id)
                .ok()
                .and_then(|o| o.as_stream().ok())
                .and_then(|s| s.dict.get(b"N").ok())
                .and_then(|n| n.as_i64().ok())
        };
        for (page, p) in scan.pages.iter().enumerate() {
            let c = &p.colours;
            if c.rgb || c.alt_rgb || c.icc.iter().any(|id| icc_n(id) == Some(3)) {
                rgb.insert(page);
            }
            if c.cmyk || c.alt_cmyk || c.icc.iter().any(|id| icc_n(id) == Some(4)) {
                cmyk.insert(page);
            }
            for s in c.spots.iter().chain(c.device_n.iter()) {
                if !matches!(s.as_str(), "Cyan" | "Magenta" | "Yellow" | "Black") {
                    spots.entry(s.clone()).or_default().insert(page);
                }
            }
            for kind in &p.transparency {
                transparency.entry(kind).or_default().insert(page);
            }
            if p.hairlines > 0 {
                hairlines.insert(page);
                thinnest = thinnest.min(p.thinnest.unwrap_or(0.0));
            }
        }
        push("rgb", Severity::Warning, String::new(), rgb);
        push("cmyk", Severity::Info, String::new(), cmyk);
        for (name, pages) in spots {
            push("spotColour", Severity::Info, name, pages);
        }
        for (kind, pages) in transparency {
            push("transparency", Severity::Info, kind.to_string(), pages);
        }
        // Boxes.
        let mut no_trim = BTreeSet::new();
        let mut no_bleed = BTreeSet::new();
        let mut bad_boxes = BTreeSet::new();
        let mut sizes: BTreeMap<(i64, i64), Vec<usize>> = BTreeMap::new();
        for (index, page) in self.pages.iter().enumerate() {
            let Ok(dict) = doc.get_dictionary(*page) else {
                continue;
            };
            let get = |k: &[u8]| self.rect(self.inherited(dict, k));
            let media = get(b"MediaBox").unwrap_or([0.0, 0.0, 612.0, 792.0]);
            let trim = get(b"TrimBox").or_else(|| get(b"ArtBox"));
            let bleed = get(b"BleedBox");
            if trim.is_none() {
                no_trim.insert(index);
            }
            if bleed.is_none() {
                no_bleed.insert(index);
            }
            let inside = |a: [f32; 4], b: [f32; 4]| {
                a[0] >= b[0] - 0.01
                    && a[1] >= b[1] - 0.01
                    && a[2] <= b[2] + 0.01
                    && a[3] <= b[3] + 0.01
            };
            if trim.is_some_and(|t| !inside(t, bleed.unwrap_or(media)))
                || bleed.is_some_and(|b| !inside(b, media))
            {
                bad_boxes.insert(index);
            }
            if let Ok((w, h)) = self.page_size(index) {
                sizes
                    .entry((w.round() as i64, h.round() as i64))
                    .or_default()
                    .push(index);
            }
        }
        push("noTrimBox", Severity::Warning, String::new(), no_trim);
        push("noBleedBox", Severity::Info, String::new(), no_bleed);
        push("boxes", Severity::Error, String::new(), bad_boxes);
        push(
            "hairline",
            Severity::Warning,
            if thinnest == f32::MAX {
                String::new()
            } else {
                format!("{thinnest:.2}")
            },
            hairlines,
        );
        if self.was_encrypted() {
            push("encrypted", Severity::Error, String::new(), BTreeSet::new());
        }
        report.items.sort_by_key(|i| {
            (
                i.severity,
                CHECKS
                    .iter()
                    .position(|c| *c == i.check)
                    .unwrap_or(usize::MAX),
            )
        });
        report.sizes = sizes
            .into_iter()
            .map(|((w, h), pages)| ((w as f32, h as f32), pages))
            .collect();
        let _ = Object::Null;
        report
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn corpus(name: &str) -> Vec<u8> {
        std::fs::read(format!(
            "{}/../../../tests/corpus/arabic/{name}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap()
    }

    fn checks(r: &Report) -> Vec<&'static str> {
        r.items.iter().map(|i| i.check).collect()
    }

    #[test]
    fn a_scan_at_200_dpi_is_coarse_for_300_and_fine_for_150() {
        let doc =
            PdfDocument::open(corpus("generated/scan-arial-200dpi-bilevel.pdf"), None).unwrap();
        let strict = doc.preflight(Options {
            min_ppi: 300.0,
            ..Default::default()
        });
        assert!(
            checks(&strict).contains(&"lowResolution"),
            "{:?}",
            strict.items
        );
        let item = strict
            .items
            .iter()
            .find(|i| i.check == "lowResolution")
            .unwrap();
        assert_eq!(item.pages, vec![0]);
        let lenient = doc.preflight(Options {
            min_ppi: 72.0,
            ..Default::default()
        });
        assert!(
            !checks(&lenient).contains(&"lowResolution"),
            "{:?}",
            lenient.items
        );
    }

    #[test]
    fn a_word_export_has_no_trim_box_and_says_so_for_every_page() {
        let doc = PdfDocument::open(
            corpus("realworld/A_worldbank_malpass_g7_briefing_AR_word2016_pdftools.pdf"),
            None,
        )
        .unwrap();
        let r = doc.preflight(Options::default());
        let trim = r.items.iter().find(|i| i.check == "noTrimBox").unwrap();
        assert_eq!(trim.pages.len(), doc.page_count());
        assert!(!r.sizes.is_empty());
        // Errors come first.
        let order: Vec<Severity> = r.items.iter().map(|i| i.severity).collect();
        let mut sorted = order.clone();
        sorted.sort();
        assert_eq!(order, sorted);
    }

    #[test]
    fn fonts_a_file_does_not_carry_are_errors() {
        let doc = PdfDocument::open(
            corpus("generated/chrome-windows-arial-tahoma-times.pdf"),
            None,
        )
        .unwrap();
        let r = doc.preflight(Options::default());
        let scan = doc.scan_content(ScanOptions::default());
        let missing = scan
            .fonts
            .iter()
            .filter(|f| !fonts::facts(&doc.doc, &f.dict).embedded())
            .count();
        assert_eq!(
            r.items
                .iter()
                .filter(|i| i.check == "fontNotEmbedded")
                .count()
                > 0,
            missing > 0
        );
    }
}
