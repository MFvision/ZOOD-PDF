//! Reading units for read-aloud (`text.readingUnits`): the paragraphs of the logical-order
//! extraction, cleaned for a speech engine and split into language runs.
//!
//! * Paragraphs come in reading order (blocks by XY-cut, bidi logical order) with their page,
//!   bounding box and per-line boxes, so the interface can highlight what is being read.
//! * Text is cleaned for speech: tatweel (U+0640), bidi controls, soft hyphens and BOMs are
//!   dropped; tashkeel is **kept** (it tells the voice how to pronounce); whitespace collapses;
//!   an English word broken by a hyphen at a line end is joined again. Numbers and
//!   abbreviations are left to the voice.
//! * Each paragraph is split into runs by script so an Arabic run is spoken by an Arabic voice
//!   and a Latin run by an English one. Neutral tokens (numbers, punctuation) stay in the run
//!   they are in; a minority run of fewer than [`MIN_RUN_LETTERS`] letters (a stray "e" or "ب")
//!   is merged into its neighbour so the voice does not switch for a single letter.

use serde::Serialize;

use crate::bidi::Dir;
use crate::geom::Rect;
use crate::model::{PageText, Paragraph};

/// Letters a script run needs to get its own voice.
pub const MIN_RUN_LETTERS: usize = 3;

/// Upper bound on the reading units returned for one call (bounded allocation).
pub const MAX_UNITS: usize = 50_000;

/// Writing system of a letter, as far as choosing a voice goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum Script {
    Arab,
    Latn,
    Hebr,
    Cyrl,
    Grek,
    Deva,
    Thai,
    Hani,
    Jpan,
    Hang,
    Zyyy,
}

impl Script {
    /// Language to speak it with: `ar`, `en`, or `other` (the interface maps `other` by script).
    pub fn lang(self) -> &'static str {
        match self {
            Script::Arab => "ar",
            Script::Latn => "en",
            _ => "other",
        }
    }
}

/// Script of a character, `None` for neutrals (digits, punctuation, spaces, marks).
pub fn script_of(c: char) -> Option<Script> {
    if !c.is_alphabetic() {
        return None;
    }
    let u = u32::from(c);
    Some(match u {
        // Tashkeel / Quranic marks and tatweel are alphabetic-ish marks: neutral.
        0x064B..=0x065F | 0x0670 | 0x06D6..=0x06ED | 0x0640 => return None,
        0x0600..=0x06FF | 0x0750..=0x077F | 0x0870..=0x08FF | 0xFB50..=0xFDFF | 0xFE70..=0xFEFF => {
            Script::Arab
        }
        0x0041..=0x024F | 0x1E00..=0x1EFF | 0x2C60..=0x2C7F | 0xA720..=0xA7FF | 0xFF21..=0xFF5A => {
            Script::Latn
        }
        0x0590..=0x05FF | 0xFB1D..=0xFB4F => Script::Hebr,
        0x0400..=0x052F => Script::Cyrl,
        0x0370..=0x03FF | 0x1F00..=0x1FFF => Script::Grek,
        0x0900..=0x097F => Script::Deva,
        0x0E00..=0x0E7F => Script::Thai,
        0x3040..=0x30FF | 0x31F0..=0x31FF => Script::Jpan,
        0xAC00..=0xD7AF | 0x1100..=0x11FF | 0x3130..=0x318F => Script::Hang,
        0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF | 0x20000..=0x2FFFF => Script::Hani,
        _ => Script::Zyyy,
    })
}

/// Characters a speech engine should never see.
fn dropped(c: char) -> bool {
    matches!(
        c,
        '\u{0640}' // tatweel
            | '\u{00AD}' // soft hyphen
            | '\u{200B}' // zero width space
            | '\u{200E}' | '\u{200F}' | '\u{061C}' // bidi marks
            | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' // bidi embeddings / isolates
            | '\u{FEFF}'
    ) || (c.is_control() && !c.is_whitespace())
}

/// Clean text for speech: drop tatweel and invisible controls, keep tashkeel, collapse spaces.
pub fn clean_for_speech(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut space = false;
    for c in s.chars() {
        if dropped(c) {
            continue;
        }
        if c.is_whitespace() {
            space = !out.is_empty();
            continue;
        }
        if space {
            out.push(' ');
            space = false;
        }
        out.push(c);
    }
    out
}

/// Paragraph text from its lines, joining an English word hyphenated at a line end
/// ("exam-" + "ple" → "example").
fn paragraph_text(p: &Paragraph) -> String {
    if p.lines.is_empty() {
        return p.text.clone();
    }
    let mut out = String::new();
    for line in &p.lines {
        let t = line.text.trim();
        if t.is_empty() {
            continue;
        }
        if out.is_empty() {
            out.push_str(t);
            continue;
        }
        let first = t.chars().next();
        let mut tail = out.chars().rev();
        let hyphen_join = tail.next() == Some('-')
            && tail
                .next()
                .is_some_and(|c| script_of(c) == Some(Script::Latn))
            && first.is_some_and(|c| c.is_lowercase() && script_of(c) == Some(Script::Latn));
        if hyphen_join {
            out.pop();
        } else {
            out.push(' ');
        }
        out.push_str(t);
    }
    out
}

/// A stretch of one paragraph spoken with one voice.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Run {
    pub text: String,
    /// `ar`, `en` or `other`.
    pub lang: &'static str,
    pub script: Script,
}

/// Majority script of a token's letters, `None` when it has no letters.
fn token_script(tok: &str) -> (Option<Script>, usize) {
    let mut counts: Vec<(Script, usize)> = Vec::new();
    for s in tok.chars().filter_map(script_of) {
        match counts.iter_mut().find(|(k, _)| *k == s) {
            Some((_, n)) => *n += 1,
            None => counts.push((s, 1)),
        }
    }
    let total = counts.iter().map(|(_, n)| n).sum();
    let best = counts.into_iter().max_by_key(|(_, n)| *n).map(|(s, _)| s);
    (best, total)
}

struct Draft {
    script: Option<Script>,
    letters: usize,
    tokens: Vec<String>,
}

/// Split cleaned text into script runs (see the module docs for the rules).
pub fn split_runs(text: &str) -> Vec<Run> {
    let mut drafts: Vec<Draft> = Vec::new();
    for tok in text.split(' ').filter(|t| !t.is_empty()) {
        let (script, letters) = token_script(tok);
        match drafts.last_mut() {
            Some(d) if script.is_none() || d.script.is_none() || d.script == script => {
                if d.script.is_none() {
                    d.script = script;
                }
                d.letters += letters;
                d.tokens.push(tok.to_string());
            }
            _ => drafts.push(Draft {
                script,
                letters,
                tokens: vec![tok.to_string()],
            }),
        }
    }
    // Merge minority runs too short to deserve a voice switch into the previous run (or the
    // next one when it is first), then re-join neighbours that became the same script.
    let dominant = {
        let mut totals: Vec<(Option<Script>, usize)> = Vec::new();
        for d in &drafts {
            match totals.iter_mut().find(|(s, _)| *s == d.script) {
                Some((_, n)) => *n += d.letters,
                None => totals.push((d.script, d.letters)),
            }
        }
        totals
            .into_iter()
            .max_by_key(|(_, n)| *n)
            .and_then(|(s, _)| s)
    };
    let mut merged: Vec<Draft> = Vec::new();
    let mut carry: Vec<String> = Vec::new();
    for mut d in drafts {
        let short = d.letters < MIN_RUN_LETTERS && d.script != dominant;
        if short {
            if let Some(prev) = merged.last_mut() {
                prev.tokens.append(&mut d.tokens);
            } else {
                carry.append(&mut d.tokens);
            }
            continue;
        }
        if !carry.is_empty() {
            carry.append(&mut d.tokens);
            d.tokens = std::mem::take(&mut carry);
        }
        match merged.last_mut() {
            Some(prev) if prev.script == d.script => {
                prev.letters += d.letters;
                prev.tokens.append(&mut d.tokens);
            }
            _ => merged.push(d),
        }
    }
    if !carry.is_empty() {
        merged.push(Draft {
            script: dominant,
            letters: 0,
            tokens: carry,
        });
    }
    merged
        .into_iter()
        .map(|d| {
            let script = d.script.or(dominant).unwrap_or(Script::Zyyy);
            Run {
                text: d.tokens.join(" "),
                lang: script.lang(),
                script,
            }
        })
        .collect()
}

/// One paragraph to read aloud.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ReadingUnit {
    /// 0-based page index.
    pub page: usize,
    /// Position of the paragraph on its page (reading order).
    pub index: usize,
    /// Cleaned text (what is spoken).
    pub text: String,
    /// Main language of the paragraph (`ar`, `en` or `other`).
    pub lang: &'static str,
    pub dir: Dir,
    /// Paragraph box, page points from the top-left of the visible box.
    pub bbox: Rect,
    /// One box per line, for highlighting.
    pub rects: Vec<Rect>,
    pub runs: Vec<Run>,
}

fn round(r: Rect) -> Rect {
    let q = |v: f64| (v * 100.0).round() / 100.0;
    Rect {
        x0: q(r.x0),
        y0: q(r.y0),
        x1: q(r.x1),
        y1: q(r.y1),
    }
}

/// Reading units of the given pages, in reading order. Paragraphs without letters or digits
/// (rules, bullets alone) are skipped.
pub fn reading_units(pages: &[PageText]) -> Vec<ReadingUnit> {
    let mut out = Vec::new();
    for page in pages {
        let mut index = 0;
        for p in page.paragraphs() {
            if out.len() >= MAX_UNITS {
                return out;
            }
            let text = clean_for_speech(&paragraph_text(p));
            if !text.chars().any(char::is_alphanumeric) {
                continue;
            }
            let runs = split_runs(&text);
            let lang = main_lang(&runs);
            out.push(ReadingUnit {
                page: page.page,
                index,
                text,
                lang,
                dir: p.dir,
                bbox: round(p.bbox),
                rects: p.lines.iter().map(|l| round(l.bbox)).collect(),
                runs,
            });
            index += 1;
        }
    }
    out
}

fn main_lang(runs: &[Run]) -> &'static str {
    let mut best: (&'static str, usize) = ("other", 0);
    let mut totals: Vec<(&'static str, usize)> = Vec::new();
    for r in runs {
        let n = r.text.chars().filter(|c| script_of(*c).is_some()).count();
        match totals.iter_mut().find(|(l, _)| *l == r.lang) {
            Some((_, t)) => *t += n,
            None => totals.push((r.lang, n)),
        }
    }
    for (l, n) in totals {
        if n > best.1 {
            best = (l, n);
        }
    }
    best.0
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;
    use crate::model::{Block, Line};

    fn line(text: &str, y: f64) -> Line {
        Line {
            text: text.into(),
            bbox: Rect::new(10.0, y, 200.0, y + 12.0),
            dir: Dir::Ltr,
            words: Vec::new(),
        }
    }

    fn page(paras: &[&[&str]]) -> PageText {
        let mut y = 0.0;
        let paragraphs = paras
            .iter()
            .map(|lines| {
                let ls: Vec<Line> = lines
                    .iter()
                    .map(|t| {
                        y += 14.0;
                        line(t, y)
                    })
                    .collect();
                let bbox = ls.iter().fold(ls[0].bbox, |b, l| b.union(&l.bbox));
                Paragraph {
                    text: lines.join(" "),
                    bbox,
                    dir: Dir::Ltr,
                    lines: ls,
                }
            })
            .collect();
        PageText {
            page: 2,
            width: 600.0,
            height: 800.0,
            blocks: vec![Block {
                bbox: Rect::default(),
                dir: Dir::Ltr,
                paragraphs,
            }],
            plain: String::new(),
            spans: Vec::new(),
        }
    }

    #[test]
    fn clean_strips_tatweel_and_controls_but_keeps_tashkeel() {
        assert_eq!(clean_for_speech("مـــحمد"), "محمد");
        assert_eq!(clean_for_speech("كَتَبَ\u{200F} الدرسَ"), "كَتَبَ الدرسَ");
        assert_eq!(clean_for_speech("  a\u{00AD}b\t\n c  "), "ab c");
        assert_eq!(clean_for_speech("\u{202B}نص\u{202C}"), "نص");
    }

    #[test]
    fn arabic_paragraph_is_one_arabic_run_numbers_included() {
        let runs = split_runs("العقد رقم ٢٠٢٦ بين الطرفين، والمبلغ 1500 ريال.");
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].lang, "ar");
        assert_eq!(
            runs[0].text,
            "العقد رقم ٢٠٢٦ بين الطرفين، والمبلغ 1500 ريال."
        );
    }

    #[test]
    fn english_paragraph_is_one_english_run() {
        let runs = split_runs("This is page 2 of 9.");
        assert_eq!(runs.len(), 1);
        assert_eq!((runs[0].lang, runs[0].script), ("en", Script::Latn));
    }

    #[test]
    fn mixed_paragraph_splits_into_script_runs_in_logical_order() {
        let runs = split_runs("يقرأ تطبيق ZOOD PDF reads aloud هذا النص بصوت عربي.");
        let got: Vec<(&str, &str)> = runs.iter().map(|r| (r.lang, r.text.as_str())).collect();
        assert_eq!(
            got,
            vec![
                ("ar", "يقرأ تطبيق"),
                ("en", "ZOOD PDF reads aloud"),
                ("ar", "هذا النص بصوت عربي."),
            ]
        );
    }

    #[test]
    fn a_single_foreign_letter_does_not_switch_the_voice() {
        let runs = split_runs("الملحق A من العقد");
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].text, "الملحق A من العقد");
        let runs = split_runs("Section ب of the contract");
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].lang, "en");
        // A short foreign token at the very start joins the following run.
        let runs = split_runs("e النص العربي كله");
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].text, "e النص العربي كله");
    }

    #[test]
    fn other_scripts_are_tagged_other_with_their_script() {
        let runs = split_runs("Привет мир");
        assert_eq!((runs[0].lang, runs[0].script), ("other", Script::Cyrl));
        assert!(split_runs("   ").is_empty());
        let runs = split_runs("2026 — 15");
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].script, Script::Zyyy);
    }

    #[test]
    fn units_follow_reading_order_with_boxes_and_join_hyphenated_words() {
        let p = page(&[
            &["مقدمــة التقرير"],
            &["The exam-", "ple continues", "here."],
            &["---"],
            &["نص عربي مع English words داخله"],
        ]);
        let units = reading_units(&[p]);
        assert_eq!(units.len(), 3, "the rule-only paragraph is skipped");
        assert_eq!(units[0].text, "مقدمة التقرير");
        assert_eq!(units[0].lang, "ar");
        assert_eq!(units[1].text, "The example continues here.");
        assert_eq!(units[1].lang, "en");
        assert_eq!(units[1].rects.len(), 3);
        assert_eq!(units[1].page, 2);
        assert_eq!((units[0].index, units[1].index, units[2].index), (0, 1, 2));
        assert_eq!(units[2].lang, "ar");
        assert_eq!(
            units[2].runs.iter().map(|r| r.lang).collect::<Vec<_>>(),
            vec!["ar", "en", "ar"]
        );
        assert!(units[1].bbox.y1 > units[1].bbox.y0);
    }

    #[test]
    fn a_trailing_hyphen_before_a_capital_or_arabic_is_kept() {
        let p = page(&[&["Well-", "Known"], &["الرقم -", "خمسة"]]);
        let units = reading_units(&[p]);
        assert_eq!(units[0].text, "Well- Known");
        assert_eq!(units[1].text, "الرقم - خمسة");
    }
}
