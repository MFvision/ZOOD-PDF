//! Redact: search-and-redact, and Remove hidden information.
//!
//! `redact.find` searches the document the way Warraq's find bar does —
//! Arabic-aware: diacritics ignored, alef, taa marbuta, yaa and digit forms
//! unified — and with ready-made patterns (`patterns.rs`) or a person's own,
//! and answers each match with the boxes of the glyphs it was drawn with.
//! Those boxes become redaction marks in the viewer, which removes what is
//! under them when the marks are applied.
//!
//! `redact.inspect` and `redact.scrub` report and remove what a file carries
//! besides its pages (`warraq_pdf::hidden`); the scrubbed file is written
//! whole, with no earlier revision and nothing unreferenced left in it.
use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use warraq_pdf::Hidden;
use warraq_text::{find_in_lines, SearchNormalization, TextLine};

use super::patterns::{Finder, Kind};
use super::{args, Reply};
use crate::{CoreError, Document};

/// The most matches one search answers; the rest are counted, not listed.
const MAX_MATCHES: usize = 5_000;
/// Characters of context kept on either side of a match.
const CONTEXT: usize = 32;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Find {
    /// Words to find, Arabic-aware; empty for none.
    #[serde(default)]
    query: String,
    /// Ready-made patterns by name: email, phone, nationalId, iban, card, date.
    #[serde(default)]
    patterns: Vec<String>,
    /// A person's own pattern (Rust `regex` syntax).
    #[serde(default)]
    custom: Option<String>,
    /// Pages to search, zero-based; all when absent.
    #[serde(default)]
    pages: Option<Vec<usize>>,
}

/// A box on a page, in points from the top-left corner of the page as it is
/// stored — before its `/Rotate` — which is how the viewer places marks.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
struct Found {
    page: usize,
    /// What matched, as the page reads.
    text: String,
    before: String,
    after: String,
    /// "text", a pattern's name, or "custom".
    kind: &'static str,
    rects: Vec<Rect>,
}

/// Each char of `line`'s boxes, left to right on the page: its own spans,
/// or, where the reader has none (a turned line), an even share of the line.
pub(crate) fn char_boxes(line: &TextLine) -> Vec<(f32, f32)> {
    let n = line.text.chars().count();
    if line.spans.len() == n {
        return line.spans.clone();
    }
    let step = line.width / n.max(1) as f32;
    (0..n)
        .map(|i| {
            // Right to left, the first char is at the right.
            let k = if line.direction == warraq_text::Direction::Rtl {
                n - 1 - i
            } else {
                i
            };
            (line.x + step * k as f32, line.x + step * (k + 1) as f32)
        })
        .collect()
}

/// The boxes chars `start..end` of `line` were drawn in, in the page's shown
/// space (y down, after `/Rotate`): one box for each stretch of the line
/// that holds only matched chars — so a word is one box even where its
/// glyphs' advances leave a gap, and a match that bidi splits across the
/// line is two boxes that take nothing between them.
pub(crate) fn match_boxes(line: &TextLine, start: usize, end: usize) -> Vec<Rect> {
    let mut boxes: Vec<(f32, f32, bool)> = char_boxes(line)
        .into_iter()
        .enumerate()
        .filter(|(_, (a, b))| b > a)
        .map(|(i, (a, b))| (a, b, (start..end).contains(&i)))
        .collect();
    boxes.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut merged: Vec<(f32, f32)> = vec![];
    let mut open = false;
    for (a, b, matched) in boxes {
        if !matched {
            open = false;
            continue;
        }
        match merged.last_mut() {
            Some(last) if open => {
                last.0 = last.0.min(a);
                last.1 = last.1.max(b);
            }
            _ => merged.push((a, b)),
        }
        open = true;
    }
    merged
        .into_iter()
        .map(|(a, b)| Rect {
            x: a,
            y: line.y,
            width: b - a,
            height: line.height,
        })
        .collect()
}

/// A box from the page as shown (after `/Rotate`, `shown` its size) to the
/// page as stored, turned back by `rotation` degrees clockwise.
pub fn unrotate(r: Rect, rotation: i64, shown: (f32, f32)) -> Rect {
    let (sw, sh) = shown;
    match rotation {
        90 => Rect {
            x: r.y,
            y: sw - (r.x + r.width),
            width: r.height,
            height: r.width,
        },
        180 => Rect {
            x: sw - (r.x + r.width),
            y: sh - (r.y + r.height),
            width: r.width,
            height: r.height,
        },
        270 => Rect {
            x: sh - (r.y + r.height),
            y: r.x,
            width: r.height,
            height: r.width,
        },
        _ => r,
    }
}

fn find(doc: &Document, a: Find) -> Result<Reply, CoreError> {
    let mut finders: Vec<Finder> = vec![];
    for name in &a.patterns {
        let kind = Kind::from_key(name)
            .ok_or_else(|| CoreError::Args(format!("no pattern called {name}")))?;
        finders.push(Finder::ready_made(kind));
    }
    if let Some(custom) = a.custom.as_deref().filter(|c| !c.trim().is_empty()) {
        finders.push(Finder::custom(custom)?);
    }
    let query = a.query.trim();
    if query.is_empty() && finders.is_empty() {
        return Err(CoreError::Args(
            "give words to find, a pattern, or both".into(),
        ));
    }
    let pages: Vec<usize> = match a.pages {
        Some(p) => p.into_iter().filter(|i| *i < doc.page_count()).collect(),
        None => (0..doc.page_count()).collect(),
    };
    let opts = SearchNormalization::default();
    let mut found: Vec<Found> = vec![];
    let mut total = 0usize;
    for page in pages {
        let lines = doc.text_lines(page)?;
        let shown = doc.page_size(page)?;
        let rotation = doc.pdf.page_rotation(page).unwrap_or(0);
        let texts: Vec<String> = lines.iter().map(|l| l.text.clone()).collect();
        // (line, first char, end char, kind)
        let mut hits: Vec<(usize, usize, usize, &'static str)> = vec![];
        if !query.is_empty() {
            for m in find_in_lines(&texts, query, &opts) {
                let line = &texts[m.line];
                let start = line[..m.start].chars().count();
                let end = start + line[m.start..m.end].chars().count();
                hits.push((m.line, start, end, "text"));
            }
        }
        for finder in &finders {
            let kind = finder.kind.map(Kind::key).unwrap_or("custom");
            for (li, text) in texts.iter().enumerate() {
                for (start, end) in finder.find(text) {
                    hits.push((li, start, end, kind));
                }
            }
        }
        // In reading order, and each stretch of text once.
        hits.sort_by_key(|h| (h.0, h.1, std::cmp::Reverse(h.2)));
        hits.dedup_by(|b, a| a.0 == b.0 && b.1 < a.2);
        for (li, start, end, kind) in hits {
            total += 1;
            if found.len() >= MAX_MATCHES {
                continue;
            }
            let chars: Vec<char> = texts[li].chars().collect();
            let slice = |from: usize, to: usize| -> String { chars[from..to].iter().collect() };
            let rects = match_boxes(&lines[li], start, end)
                .into_iter()
                .map(|r| unrotate(r, rotation, shown))
                .collect();
            found.push(Found {
                page,
                text: slice(start, end),
                before: slice(start.saturating_sub(CONTEXT), start),
                after: slice(end, (end + CONTEXT).min(chars.len())),
                kind,
                rects,
            });
        }
    }
    Reply::of(&serde_json::json!({ "matches": found, "total": total }))
}

pub fn call(
    doc: &mut Document,
    name: &str,
    json: &str,
    _blobs: Vec<Vec<u8>>,
) -> Result<Reply, CoreError> {
    match name {
        "find" => find(doc, args(json)?),
        _ => Err(CoreError::UnknownOp(format!("redact.{name}"))),
    }
}

#[derive(Deserialize, Default)]
struct Password {
    #[serde(default)]
    password: Option<String>,
}

#[derive(Deserialize, Default)]
struct Scrub {
    #[serde(default)]
    password: Option<String>,
    /// The kinds to remove, by the names `redact.inspect` gives them.
    #[serde(default)]
    remove: Vec<String>,
}

pub fn call_static(name: &str, json: &str, blobs: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let pdf = || {
        blobs
            .first()
            .cloned()
            .ok_or_else(|| CoreError::Args(format!("redact.{name} takes the PDF")))
    };
    match name {
        "inspect" => {
            let a: Password = args(json)?;
            let doc = warraq_pdf::PdfDocument::open(pdf()?, a.password.as_deref())?;
            let r = doc.hidden_report();
            let findings: Vec<serde_json::Value> = r
                .findings
                .iter()
                .map(|f| {
                    serde_json::json!({
                        "kind": f.kind.key(),
                        "count": f.count,
                        "details": f.details,
                    })
                })
                .collect();
            Reply::of(&serde_json::json!({
                "findings": findings,
                "revisions": r.revisions,
                "unreachable": r.unreachable,
                "signed": r.signed,
                "protected": r.protected,
            }))
        }
        "scrub" => {
            let a: Scrub = args(json)?;
            let mut remove = BTreeSet::new();
            for key in &a.remove {
                remove.insert(
                    Hidden::from_key(key)
                        .ok_or_else(|| CoreError::Args(format!("nothing called {key}")))?,
                );
            }
            let doc = warraq_pdf::PdfDocument::open(pdf()?, a.password.as_deref())?;
            if doc.was_encrypted() {
                return Reply::of(&serde_json::json!({ "refused": "protected" }));
            }
            let bytes = doc.without_hidden(&remove)?;
            Ok(Reply::of(&serde_json::json!({ "size": bytes.len() }))?.with_blob(bytes))
        }
        _ => Err(CoreError::UnknownOp(format!("redact.{name}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn contract() -> Document {
        let bytes = std::fs::read(format!(
            "{}/../../../tests/fixtures/redact/contract.pdf",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap();
        Document::open(bytes, None).unwrap()
    }

    fn matches(doc: &mut Document, args: serde_json::Value) -> Vec<serde_json::Value> {
        let reply = doc.call("redact.find", &args.to_string(), vec![]).unwrap();
        let v: serde_json::Value = serde_json::from_str(&reply.json).unwrap();
        v["matches"].as_array().unwrap().clone()
    }

    fn rect(m: &serde_json::Value) -> (f64, f64, f64, f64) {
        let r = &m["rects"][0];
        let f = |k: &str| r[k].as_f64().unwrap();
        (f("x"), f("y"), f("width"), f("height"))
    }

    /// Words are found as the find bar finds them — the Arabic without its
    /// diacritics or letter variants — and each comes with the box its
    /// glyphs were drawn in, not its line's.
    #[test]
    fn words_are_found_arabic_aware_with_the_boxes_of_their_glyphs() {
        let mut doc = contract();
        // Case does not matter: the name is found in the email address too.
        let found = matches(&mut doc, serde_json::json!({ "query": "Haddad" }));
        assert_eq!(found.len(), 2, "{found:?}");
        assert_eq!(found[0]["text"], "Haddad");
        assert_eq!(found[1]["text"], "haddad");
        assert_eq!(found[0]["rects"].as_array().unwrap().len(), 1);
        assert_eq!(found[0]["page"], 0);
        let (x, y, w, h) = rect(&found[0]);
        // The first line, set at 56 pt from the left, 62 pt from the top.
        assert!(x > 200.0 && x + w < 330.0, "{x} {w}");
        assert!(y > 40.0 && y < 70.0 && h < 20.0, "{y} {h}");
        assert!(w > 30.0 && w < 60.0, "six letters of 12 pt Helvetica: {w}");

        // Written without the shadda and with a plain alef: still found.
        let found = matches(&mut doc, serde_json::json!({ "query": "وراق" }));
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0]["text"], "ورّاق");
        let found = matches(&mut doc, serde_json::json!({ "query": "نادية" }));
        assert_eq!(found.len(), 1, "{found:?}");
        let (x, y, w, _) = rect(&found[0]);
        // The line starts at 540 pt and runs leftwards: its last word is at
        // its left end, well short of where it began.
        assert!(x + w < 400.0 && x > 150.0, "{x} {w}");
        assert!(w > 20.0 && w < 60.0, "{w}");
        assert!(y > 320.0 && y < 360.0, "{y}");
    }

    #[test]
    fn patterns_find_emails_phones_ids_ibans_cards_and_dates() {
        let mut doc = contract();
        let kinds = |doc: &mut Document, p: &str| -> Vec<String> {
            matches(doc, serde_json::json!({ "patterns": [p] }))
                .iter()
                .map(|m| m["text"].as_str().unwrap().to_string())
                .collect()
        };
        assert_eq!(
            kinds(&mut doc, "email"),
            ["nadia.haddad@example.com", "nadia@example.sa"]
        );
        assert_eq!(kinds(&mut doc, "phone"), ["+966 50 123 4567", "٠٥٠١٢٣٤٥٦٧"]);
        assert_eq!(kinds(&mut doc, "iban"), ["SA03 8000 0000 6080 1016 7519"]);
        assert_eq!(kinds(&mut doc, "card"), ["4111 1111 1111 1111"]);
        assert_eq!(kinds(&mut doc, "nationalId"), ["1012345678"]);
        assert_eq!(kinds(&mut doc, "date"), ["16/09/2026", "١٦ سبتمبر ٢٠٢٦"]);
        let custom = matches(&mut doc, serde_json::json!({ "custom": "Warraq \\w+" }));
        assert_eq!(custom[0]["text"], "Warraq Labs");
        assert_eq!(custom[0]["kind"], "custom");
        assert!(doc
            .call("redact.find", r#"{"custom":"(unclosed"}"#, vec![])
            .is_err());
        assert!(doc.call("redact.find", "{}", vec![]).is_err());
    }

    #[test]
    fn a_box_turns_back_with_its_page() {
        let r = Rect {
            x: 10.0,
            y: 20.0,
            width: 30.0,
            height: 5.0,
        };
        // A 600×800 page turned a quarter: shown 800 wide and 600 high.
        assert_eq!(unrotate(r, 0, (800.0, 600.0)), r);
        let back = unrotate(r, 90, (800.0, 600.0));
        assert_eq!(
            back,
            Rect {
                x: 20.0,
                y: 760.0,
                width: 5.0,
                height: 30.0
            }
        );
        // Turning twice by half is the identity.
        let half = unrotate(r, 180, (600.0, 800.0));
        assert_eq!(unrotate(half, 180, (600.0, 800.0)), r);
    }
}
