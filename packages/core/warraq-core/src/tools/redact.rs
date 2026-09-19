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
    /// In a header, footer, page number or watermark (an artifact).
    artifact: bool,
    /// Empty when the reader does not know where its glyphs are: the match
    /// is listed, to be marked by hand.
    rects: Vec<Rect>,
}

/// A char's box on the page as shown (y down, after `/Rotate`): its four
/// corners.
type Quad = [(f32, f32); 4];

/// Each char of `line`: where it lies along the line, and its box on the
/// page. A level line's boxes are its spans, its height across; a turned
/// line's — text on a page `/Rotate` turns, up a margin, a crooked scan's
/// text layer — are its spans along the baseline in the run's own frame,
/// from below the baseline to above the letters, turned back onto the
/// page. Empty where the reader knows no boxes: none is guessed.
fn char_places(line: &TextLine) -> Vec<(f32, f32, Quad)> {
    let n = line.text.chars().count();
    match &line.turned {
        None if line.spans.len() == n => {
            let (top, bottom) = (line.y, line.y + line.height);
            line.spans
                .iter()
                .map(|&(a, b)| (a, b, [(a, top), (b, top), (b, bottom), (a, bottom)]))
                .collect()
        }
        Some(turned) if turned.spans.len() == n => {
            let top = turned.baseline - turned.size;
            let bottom = turned.baseline + 0.2 * turned.size;
            turned
                .spans
                .iter()
                .map(|&(a, b)| {
                    let quad = [
                        turned.on_page(a, top),
                        turned.on_page(b, top),
                        turned.on_page(b, bottom),
                        turned.on_page(a, bottom),
                    ];
                    (a, b, quad)
                })
                .collect()
        }
        _ => vec![],
    }
}

/// The smallest box, in the page's shown space, around `quads`.
fn bounds(quads: &[Quad]) -> Rect {
    let points = quads.iter().flatten();
    let x0 = points.clone().map(|p| p.0).fold(f32::MAX, f32::min);
    let x1 = points.clone().map(|p| p.0).fold(f32::MIN, f32::max);
    let y0 = points.clone().map(|p| p.1).fold(f32::MAX, f32::min);
    let y1 = points.map(|p| p.1).fold(f32::MIN, f32::max);
    Rect {
        x: x0,
        y: y0,
        width: x1 - x0,
        height: y1 - y0,
    }
}

/// Each char of `line`, its box in the page's shown space: where the reader
/// placed it (`char_places`), else an even share of the line's box — good
/// enough to tell which chars a selection covers (the view's copy), never
/// used to mark anything for redaction.
pub(crate) fn char_rects(line: &TextLine) -> Vec<Rect> {
    let n = line.text.chars().count();
    let places = char_places(line);
    if places.len() == n {
        return places.iter().map(|(_, _, quad)| bounds(&[*quad])).collect();
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
            Rect {
                x: line.x + step * k as f32,
                y: line.y,
                width: step,
                height: line.height,
            }
        })
        .collect()
}

/// The boxes chars `start..end` of `line` were drawn in, in the page's shown
/// space: one for each stretch of the line that holds only matched chars —
/// so a word is one box even where its glyphs' advances leave a gap, and a
/// match that bidi splits across the line is two boxes that take nothing
/// between them. A box is square to the page (the viewer's marks are), so
/// a stretch of a slanting line is cut into boxes short enough that each
/// reaches past the letters by no more than a quarter of their height:
/// never over the next line, nor far along the one it is on.
pub(crate) fn match_boxes(line: &TextLine, start: usize, end: usize) -> Vec<Rect> {
    let mut chars: Vec<(f32, f32, Quad, bool)> = char_places(line)
        .into_iter()
        .enumerate()
        .filter(|(_, (a, b, _))| b > a)
        .map(|(i, (a, b, quad))| (a, b, quad, (start..end).contains(&i)))
        .collect();
    chars.sort_by(|a, b| a.0.total_cmp(&b.0));
    // How far a stretch may run before its box grows past its letters: a
    // line level on the page, or turned by a quarter, never does.
    let longest = match &line.turned {
        Some(turned) => {
            let quarter = std::f32::consts::FRAC_PI_2;
            let slant = turned.angle - (turned.angle / quarter).round() * quarter;
            let height = 1.2 * turned.size;
            if slant.sin().abs() < 1e-3 {
                f32::INFINITY
            } else {
                0.25 * height / slant.sin().abs()
            }
        }
        None => f32::INFINITY,
    };
    // Pieces of stretches: (first along, quads).
    let mut pieces: Vec<(f32, Vec<Quad>)> = vec![];
    let mut open = false;
    for (a, b, quad, matched) in chars {
        if !matched {
            open = false;
            continue;
        }
        match pieces.last_mut() {
            Some((from, quads)) if open && b - *from <= longest => quads.push(quad),
            _ => pieces.push((a, vec![quad])),
        }
        open = true;
    }
    pieces.iter().map(|(_, quads)| bounds(quads)).collect()
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
        // The page's text and, apart, its artifacts — running heads, page
        // numbers, a footer, a watermark — which the reader keeps out of the
        // page's text, but which carry names and numbers as much as it does.
        let (body, artifacts) = doc.redaction_lines(page)?;
        let first_artifact = body.len();
        let lines: Vec<TextLine> = body.into_iter().chain(artifacts).collect();
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
        for (li, start, end, kind) in merged(hits) {
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
                artifact: li >= first_artifact,
                rects,
            });
        }
    }
    Reply::of(&serde_json::json!({ "matches": found, "total": total }))
}

/// Hits in reading order, each stretch of text once: hits on one line
/// that overlap become one, from the first's start to the furthest end —
/// what any finder matched is kept. It is named by the first.
fn merged(
    mut hits: Vec<(usize, usize, usize, &'static str)>,
) -> Vec<(usize, usize, usize, &'static str)> {
    hits.sort_by_key(|h| (h.0, h.1, std::cmp::Reverse(h.2)));
    let mut out: Vec<(usize, usize, usize, &'static str)> = Vec::with_capacity(hits.len());
    for hit in hits {
        match out.last_mut() {
            Some(last) if last.0 == hit.0 && hit.1 < last.2 => last.2 = last.2.max(hit.2),
            _ => out.push(hit),
        }
    }
    out
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

/// A detail of a finding, as the interface reads it: the core's own word,
/// an annotation's kind or a property's key — each for it to say in the
/// person's language — or a name from the file, shown as it is. A date
/// property also comes as the moment it names (ISO 8601, UTC).
fn detail_json(detail: &warraq_pdf::Detail) -> serde_json::Value {
    use warraq_pdf::Detail;
    match detail {
        Detail::Word(word, count) => serde_json::json!({ "word": word, "count": count }),
        Detail::Subtype(name, count) => serde_json::json!({ "subtype": name, "count": count }),
        Detail::Property(key, value) => {
            let date = matches!(key.as_str(), "CreationDate" | "ModDate")
                .then(|| warraq_sign::time::parse_pdf_date(value))
                .flatten()
                .map(warraq_sign::time::iso);
            serde_json::json!({ "property": key, "value": value, "date": date })
        }
        Detail::Name(name) => serde_json::json!({ "name": name }),
    }
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
                        "details": f.details.iter().map(detail_json).collect::<Vec<_>>(),
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

    fn turned() -> Document {
        let bytes = std::fs::read(format!(
            "{}/../../../tests/fixtures/redact/turned.pdf",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap();
        Document::open(bytes, None).unwrap()
    }

    fn rects(m: &serde_json::Value) -> Vec<(f64, f64, f64, f64)> {
        m["rects"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| {
                let f = |k: &str| r[k].as_f64().unwrap();
                (f("x"), f("y"), f("width"), f("height"))
            })
            .collect()
    }

    /// Helvetica's advance widths (thousandths of the size), for the
    /// letters of the turned fixture.
    fn helvetica(c: char) -> f64 {
        match c {
            'N' | 'H' => 722.0,
            'i' => 222.0,
            't' | ' ' => 278.0,
            'k' | 's' => 500.0,
            'r' => 333.0,
            _ => 556.0,
        }
    }

    /// The middle of each glyph of `line`, drawn at 12 pt from `(x, y)`
    /// along the angle `degrees`, in points from the top-left of a 792-pt
    /// page as stored: `(char, x, y)`.
    fn centres(line: &str, x: f64, y: f64, degrees: f64) -> Vec<(char, f64, f64)> {
        let (s, c) = degrees.to_radians().sin_cos();
        let mut along = 0.0;
        line.chars()
            .map(|ch| {
                let w = helvetica(ch) * 12.0 / 1000.0;
                let (u, v) = (along + w / 2.0, 0.35 * 12.0);
                along += w;
                (ch, x + c * u - s * v, 792.0 - (y + s * u + c * v))
            })
            .collect()
    }

    fn inside(r: &[(f64, f64, f64, f64)], (x, y): (f64, f64)) -> bool {
        r.iter()
            .any(|(rx, ry, w, h)| x >= *rx && x <= rx + w && y >= *ry && y <= ry + h)
    }

    /// On a page turned by `/Rotate`, horizontal text reads turned: its
    /// box is still where its glyphs are stored — the same, turned 90, 180
    /// or 270 degrees, as on the level page.
    #[test]
    fn a_word_on_a_turned_page_is_boxed_where_it_is_stored() {
        let mut doc = turned();
        let found = matches(
            &mut doc,
            serde_json::json!({ "query": "Haddad", "pages": [0, 1, 2, 3] }),
        );
        assert_eq!(found.len(), 4, "{found:?}");
        let level = rects(&found[0]);
        assert_eq!(level.len(), 1);
        let (x, y, w, h) = level[0];
        // "Nadia " is 34.7 pt of 12 pt Helvetica; "Haddad" 42 pt.
        assert!((x - 106.7).abs() < 2.0 && (w - 42.0).abs() < 3.0, "{x} {w}");
        assert!(y > 75.0 && y + h < 100.0, "{y} {h}");
        for (page, m) in found.iter().enumerate().skip(1) {
            assert_eq!(m["page"], page);
            let r = rects(m);
            assert_eq!(r.len(), 1, "page {page}: {r:?}");
            let d = |a: f64, b: f64| (a - b).abs() < 0.75;
            assert!(
                d(r[0].0, x) && d(r[0].1, y) && d(r[0].2, w) && d(r[0].3, h),
                "page {page} turned {}: {:?} against {:?}",
                page * 90,
                r[0],
                level[0]
            );
        }
    }

    /// A page whose lines all slant, as a crooked scan's text layer does,
    /// and a line up a page's margin: the boxes cover the word's glyphs, and
    /// none of its neighbours' — on its line or on the lines about it.
    #[test]
    fn a_word_on_a_slanting_or_upright_line_is_boxed_on_its_glyphs() {
        let mut doc = turned();
        let line = "Nadia Haddad keeps the rest";
        for (page, degrees, x, y) in [(4, 8.0, 72.0, 700.0), (5, 90.0, 540.0, 200.0)] {
            let found = matches(
                &mut doc,
                serde_json::json!({ "query": "Haddad", "pages": [page] }),
            );
            let others: Vec<(char, f64, f64)> = if page == 4 {
                [
                    centres("Line above stays", 72.0, 740.0, 8.0),
                    centres("Line below stays", 72.0, 660.0, 8.0),
                ]
                .concat()
            } else {
                centres("Text beside it stays", 400.0, 260.0, 0.0)
            };
            let glyphs = centres(line, x, y, degrees);
            let word = &glyphs[6..12];
            let m = found
                .iter()
                .find(|m| {
                    let r = rects(m);
                    !r.is_empty() && inside(&r, (word[0].1, word[0].2))
                })
                .unwrap_or_else(|| panic!("{degrees}°: no box on the word: {found:?}"));
            let r = rects(m);
            for (ch, cx, cy) in word {
                assert!(
                    inside(&r, (*cx, *cy)),
                    "{degrees}°: {ch} is left out: {r:?}"
                );
            }
            // The neighbours on its line, and every glyph of the others.
            for (ch, cx, cy) in [glyphs[4], glyphs[13]].iter().chain(&others) {
                assert!(
                    !inside(&r, (*cx, *cy)),
                    "{degrees}°: {ch} is taken too: {r:?}"
                );
            }
            // Short enough to stay on its line.
            for (_, _, w, h) in &r {
                assert!(w.min(*h) < 20.0, "{degrees}°: a box {w} by {h}");
            }
        }
    }

    /// Headers, footers, page numbers and watermarks are artifacts, which
    /// the reader keeps out of a page's text: a redaction search reads them
    /// too, and says where a match is.
    #[test]
    fn a_footer_marked_as_an_artifact_is_searched_too() {
        let mut doc = turned();
        let found = matches(
            &mut doc,
            serde_json::json!({ "query": "Haddad", "patterns": ["phone"], "pages": [5] }),
        );
        let footer: Vec<&serde_json::Value> =
            found.iter().filter(|m| m["artifact"] == true).collect();
        let texts: Vec<&str> = footer.iter().map(|m| m["text"].as_str().unwrap()).collect();
        assert_eq!(texts, ["Haddad", "+966 50 123 4567"], "{found:?}");
        // Boxed at the foot of the page, where it is drawn.
        for m in footer {
            let r = rects(m);
            assert!(
                !r.is_empty() && r.iter().all(|(_, y, _, _)| *y > 730.0),
                "{r:?}"
            );
        }
        assert_eq!(found.iter().filter(|m| m["artifact"] == false).count(), 1);

        // Warraq's own page marks are artifacts too.
        let amiri = std::fs::read(format!(
            "{}/../../../tests/fonts/Amiri-Regular.ttf",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap();
        let file = std::fs::read(format!(
            "{}/../../../tests/fixtures/redact/contract.pdf",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap();
        let marked = crate::call_static(
            "marks.add",
            &serde_json::json!({
                "mark": { "kind": "header", "slots": ["", "Prepared by Samir Qasim", ""], "size": 10 },
                "fontBlob": 1,
            })
            .to_string(),
            vec![file, amiri],
        )
        .unwrap();
        let mut doc = Document::open(marked.blobs[0].clone(), None).unwrap();
        let found = matches(&mut doc, serde_json::json!({ "query": "Qasim" }));
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0]["artifact"], true);
        assert!(!rects(&found[0]).is_empty());
    }

    /// Hits of different finders that overlap are one match, as far as
    /// either reaches: none of what a finder matched is left unmarked.
    #[test]
    fn overlapping_hits_become_one_match_as_long_as_both() {
        let mut doc = contract();
        let found = matches(
            &mut doc,
            serde_json::json!({ "query": "Contact: nadia", "patterns": ["email"] }),
        );
        let texts: Vec<&str> = found.iter().map(|m| m["text"].as_str().unwrap()).collect();
        assert!(
            texts.contains(&"Contact: nadia.haddad@example.com"),
            "{texts:?}"
        );
        let found = matches(
            &mut doc,
            serde_json::json!({ "query": "IBAN SA03", "patterns": ["iban"] }),
        );
        let texts: Vec<&str> = found.iter().map(|m| m["text"].as_str().unwrap()).collect();
        assert_eq!(texts, ["IBAN SA03 8000 0000 6080 1016 7519"]);
        assert_eq!(
            merged(vec![
                (0, 0, 9, "text"),
                (0, 5, 34, "iban"),
                (0, 40, 44, "text"),
                (1, 0, 3, "text")
            ]),
            [(0, 0, 34, "text"), (0, 40, 44, "text"), (1, 0, 3, "text")]
        );
    }

    /// The report says what the core found in words the interface can put
    /// in the person's language: its own terms, the kinds of annotation, the
    /// keys of properties — apart from the file's own names and values.
    #[test]
    fn the_report_details_are_words_kinds_properties_and_names() {
        let file = std::fs::read(format!(
            "{}/../../../tests/fixtures/hidden/everything.pdf",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap();
        let reply = crate::call_static("redact.inspect", "{}", vec![file]).unwrap();
        let v: serde_json::Value = serde_json::from_str(&reply.json).unwrap();
        let details = |kind: &str| -> Vec<serde_json::Value> {
            v["findings"]
                .as_array()
                .unwrap()
                .iter()
                .find(|f| f["kind"] == kind)
                .unwrap()["details"]
                .as_array()
                .unwrap()
                .clone()
        };
        let metadata = details("metadata");
        assert!(metadata.contains(&serde_json::json!({
            "property": "Title", "value": "INFO-TITLE-SECRET", "date": null
        })));
        // A date as the moment it is, for the interface to write its way.
        assert!(metadata.contains(&serde_json::json!({
            "property": "CreationDate",
            "value": "D:20240101120000+03'00'",
            "date": "2024-01-01T09:00:00Z"
        })));
        assert!(metadata.contains(&serde_json::json!({ "word": "XMP", "count": 1 })));
        assert_eq!(
            details("comments"),
            [serde_json::json!({ "subtype": "Text", "count": 1 })]
        );
        assert_eq!(
            details("hiddenLayers"),
            [serde_json::json!({ "name": "LAYERNAME-OFF-SECRET" })]
        );
        assert!(details("hiddenText").contains(&serde_json::json!({ "word": "white", "count": 1 })));
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
