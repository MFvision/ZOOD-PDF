//! The reading view's text: search and copy in EmbedPDF's view (ADR-0007),
//! answered by Warraq's reader instead of PDFium's.
//!
//! PDFium reads most Arabic files out of logical order — reversed, split
//! into presentation forms, or as the raw codes of unmapped glyphs — so its
//! search misses words a person can see and its copy pastes them garbled.
//! The view keeps its own highlights, lists and selection; only the text
//! comes from here.
//!
//! `view.search` finds words the way the find bar does — diacritics
//! ignored, alef, taa marbuta, yaa and digit forms unified — optionally
//! matching case and whole words, and answers each hit with the boxes of its
//! glyphs. `view.text` answers the text of the glyphs inside boxes the view
//! selected, in logical order, a line of the page per line.
use serde::{Deserialize, Serialize};
use warraq_text::{find_in_lines, SearchNormalization, TextLine};

use super::redact::{char_boxes, match_boxes, unrotate, Rect};
use super::{args, Reply};
use crate::{CoreError, Document};

/// The most hits one search lists; the rest are counted, not listed.
const MAX_MATCHES: usize = 5_000;
/// Characters of context kept on either side of a hit, before it is cut
/// back to whole words.
const CONTEXT: usize = 40;
/// The most boxes one `view.text` takes: a selection has one per glyph.
const MAX_BOXES: usize = 100_000;
/// How far outside a box a char's centre may fall and still be in it, in
/// points: PDFium's and Warraq's boxes for one glyph differ by rounding.
const SLACK: f32 = 0.75;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Search {
    query: String,
    /// Upper and lower case differ (EmbedPDF's "Case sensitive").
    #[serde(default)]
    match_case: bool,
    /// Only hits that are whole words (EmbedPDF's "Whole word").
    #[serde(default)]
    whole_word: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
struct Hit {
    page: usize,
    text: String,
    /// Whole words before and after the hit, on its line.
    before: String,
    after: String,
    /// Words of the line were left out before or after.
    truncated_left: bool,
    truncated_right: bool,
    rects: Vec<Rect>,
}

#[derive(Deserialize)]
struct Selected {
    page: usize,
    /// Boxes in points from the top-left of the page as stored, as the view
    /// measures glyphs.
    boxes: Vec<Rect>,
}

/// A letter, a digit or a mark: something a word is made of.
fn word_char(c: char) -> bool {
    c.is_alphanumeric() || warraq_text::normalize::is_mark_or_control(c) || c == '_'
}

/// Chars `start..end` of `chars` are a whole word: nothing a word is made of
/// touches them on either side.
fn whole_word(chars: &[char], start: usize, end: usize) -> bool {
    let before = start.checked_sub(1).map(|i| chars[i]);
    let after = chars.get(end).copied();
    !before.is_some_and(word_char) && !after.is_some_and(word_char)
}

/// Up to `CONTEXT` chars before and after `start..end`, cut back to whole
/// words where the line goes on past them.
fn context(chars: &[char], start: usize, end: usize) -> (String, String, bool, bool) {
    let from = start.saturating_sub(CONTEXT);
    let mut before: String = chars[from..start].iter().collect();
    let cut_left = from > 0;
    if cut_left {
        // Drop the part word the window starts in.
        if let Some(space) = before.find(char::is_whitespace) {
            before = before[space..].to_string();
        }
    }
    let to = (end + CONTEXT).min(chars.len());
    let mut after: String = chars[end..to].iter().collect();
    let cut_right = to < chars.len();
    if cut_right {
        if let Some(space) = after.rfind(char::is_whitespace) {
            after.truncate(space);
        }
    }
    (
        before.trim_start().to_string(),
        after.trim_end().to_string(),
        cut_left,
        cut_right,
    )
}

fn search(doc: &Document, a: Search) -> Result<Reply, CoreError> {
    let query = a.query.trim();
    if query.is_empty() {
        return Reply::of(&serde_json::json!({ "matches": [], "total": 0 }));
    }
    let opts = SearchNormalization {
        ignore_case: !a.match_case,
        ..SearchNormalization::default()
    };
    let mut hits: Vec<Hit> = vec![];
    let mut total = 0usize;
    for page in 0..doc.page_count() {
        let lines = doc.text_lines(page)?;
        let shown = doc.page_size(page)?;
        let rotation = doc.pdf.page_rotation(page).unwrap_or(0);
        let texts: Vec<String> = lines.iter().map(|l| l.text.clone()).collect();
        for m in find_in_lines(&texts, query, &opts) {
            let line = &texts[m.line];
            let chars: Vec<char> = line.chars().collect();
            let start = line[..m.start].chars().count();
            let end = start + line[m.start..m.end].chars().count();
            if a.whole_word && !whole_word(&chars, start, end) {
                continue;
            }
            total += 1;
            if hits.len() >= MAX_MATCHES {
                continue;
            }
            let (before, after, truncated_left, truncated_right) = context(&chars, start, end);
            hits.push(Hit {
                page,
                text: chars[start..end].iter().collect(),
                before,
                after,
                truncated_left,
                truncated_right,
                rects: match_boxes(&lines[m.line], start, end)
                    .into_iter()
                    .map(|r| unrotate(r, rotation, shown))
                    .collect(),
            });
        }
    }
    Reply::of(&serde_json::json!({ "matches": hits, "total": total }))
}

/// The chars of `line` whose centre lies in one of `boxes` (page as stored),
/// in logical order.
fn chars_in(line: &TextLine, boxes: &[Rect], rotation: i64, shown: (f32, f32)) -> String {
    let inside = |r: Rect| {
        let (cx, cy) = (r.x + r.width / 2.0, r.y + r.height / 2.0);
        boxes.iter().any(|b| {
            cx >= b.x - SLACK
                && cx <= b.x + b.width + SLACK
                && cy >= b.y - SLACK
                && cy <= b.y + b.height + SLACK
        })
    };
    line.text
        .chars()
        .zip(char_boxes(line))
        .filter(|(_, (x0, x1))| {
            inside(unrotate(
                Rect {
                    x: *x0,
                    y: line.y,
                    width: (x1 - x0).max(0.0),
                    height: line.height,
                },
                rotation,
                shown,
            ))
        })
        .map(|(c, _)| c)
        .collect()
}

fn text(doc: &Document, a: Selected) -> Result<Reply, CoreError> {
    if a.page >= doc.page_count() {
        return Err(CoreError::Args(format!("no page {}", a.page)));
    }
    if a.boxes.len() > MAX_BOXES {
        return Err(CoreError::Args(format!(
            "at most {MAX_BOXES} boxes, not {}",
            a.boxes.len()
        )));
    }
    let boxes: Vec<Rect> = a
        .boxes
        .into_iter()
        .filter(|b| [b.x, b.y, b.width, b.height].iter().all(|v| v.is_finite()))
        .collect();
    let lines = doc.text_lines(a.page)?;
    let shown = doc.page_size(a.page)?;
    let rotation = doc.pdf.page_rotation(a.page).unwrap_or(0);
    let read: Vec<String> = lines
        .iter()
        .map(|line| chars_in(line, &boxes, rotation, shown).trim().to_string())
        .filter(|t| !t.is_empty())
        .collect();
    Reply::of(&serde_json::json!({ "text": read.join("\n"), "lines": read.len() }))
}

pub fn call(
    doc: &mut Document,
    name: &str,
    json: &str,
    _blobs: Vec<Vec<u8>>,
) -> Result<Reply, CoreError> {
    match name {
        "search" => search(doc, args(json)?),
        "text" => text(doc, args(json)?),
        _ => Err(CoreError::UnknownOp(format!("view.{name}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn open(path: &str) -> Document {
        let bytes = std::fs::read(format!(
            "{}/../../../tests/{path}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap();
        Document::open(bytes, None).unwrap()
    }

    fn reply(doc: &mut Document, op: &str, args: Value) -> Value {
        let r = doc.call(op, &args.to_string(), vec![]).unwrap();
        serde_json::from_str(&r.json).unwrap()
    }

    fn texts(v: &Value) -> Vec<String> {
        v["matches"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["text"].as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn arabic_is_found_with_and_without_its_diacritics() {
        let mut doc = open("corpus/arabic/generated/chrome-amiri-tashkeel-ligatures.pdf");
        let plain = reply(
            &mut doc,
            "view.search",
            serde_json::json!({ "query": "العلم" }),
        );
        let voweled = reply(
            &mut doc,
            "view.search",
            serde_json::json!({ "query": "الْعِلْمُ" }),
        );
        assert!(plain["total"].as_u64().unwrap() > 0, "{plain}");
        assert_eq!(plain["total"], voweled["total"]);
        assert_eq!(texts(&plain), texts(&voweled));
        let hit = &plain["matches"][0];
        assert!(!hit["rects"].as_array().unwrap().is_empty());
        // Taa marbuta and haa are one letter to a search, and so are the
        // word with its diacritics and without.
        let library = reply(
            &mut doc,
            "view.search",
            serde_json::json!({ "query": "مكتبه" }),
        );
        assert_eq!(texts(&library), ["مَكْتَبَةِ"]);
        let voweled = reply(
            &mut doc,
            "view.search",
            serde_json::json!({ "query": "الْمَكْتَبَةِ" }),
        );
        assert_eq!(texts(&voweled), ["الْمَكْتَبَةِ"]);
        let r = &hit["rects"][0];
        assert!(r["width"].as_f64().unwrap() > 5.0 && r["height"].as_f64().unwrap() > 5.0);
    }

    #[test]
    fn case_and_whole_words_are_matched_on_request() {
        let mut doc = open("fixtures/redact/contract.pdf");
        // "Haddad" is the name and part of an address.
        let any = reply(
            &mut doc,
            "view.search",
            serde_json::json!({ "query": "haddad" }),
        );
        assert_eq!(texts(&any), ["Haddad", "haddad"]);
        let cased = reply(
            &mut doc,
            "view.search",
            serde_json::json!({ "query": "haddad", "matchCase": true }),
        );
        assert_eq!(texts(&cased), ["haddad"]);
        let part = reply(
            &mut doc,
            "view.search",
            serde_json::json!({ "query": "Hadd" }),
        );
        assert_eq!(part["total"], 2);
        let whole = reply(
            &mut doc,
            "view.search",
            serde_json::json!({ "query": "Hadd", "wholeWord": true }),
        );
        assert_eq!(whole["total"], 0);
        let word = reply(
            &mut doc,
            "view.search",
            serde_json::json!({ "query": "Haddad", "wholeWord": true }),
        );
        // In the address it is joined to "nadia." and "@": still a word.
        assert_eq!(word["total"], 2);
        let empty = reply(
            &mut doc,
            "view.search",
            serde_json::json!({ "query": "  " }),
        );
        assert_eq!(empty["total"], 0);
    }

    #[test]
    fn context_is_cut_back_to_whole_words() {
        let line: Vec<char> =
            "one two three four five six seven eight nine ten eleven twelve thirteen"
                .chars()
                .collect();
        let start = 45; // "ten"
        assert_eq!(line[start..start + 3].iter().collect::<String>(), "ten");
        let (before, after, left, right) = context(&line, start, start + 3);
        assert!(left && !right);
        // The window began inside "two": that part word is dropped. The
        // spaces next to the hit stay — the view writes the three side by side.
        assert_eq!(before, "three four five six seven eight nine ");
        assert_eq!(after, " eleven twelve thirteen");
        let (before, _, left, _) = context(&line, 4, 7);
        assert_eq!((before.as_str(), left), ("one ", false));
    }

    /// Every glyph of a page selected reads back as Warraq reads the page;
    /// a box round one line reads back as that line only.
    #[test]
    fn the_text_in_boxes_is_the_page_read_in_logical_order() {
        let mut doc = open("corpus/arabic/generated/chrome-ibmplex-bidi-stress.pdf");
        let (w, h) = doc.page_size(0).unwrap();
        let all = reply(
            &mut doc,
            "view.text",
            serde_json::json!({ "page": 0, "boxes": [{ "x": 0.0, "y": 0.0, "width": w, "height": h }] }),
        );
        let whole = doc.extract_text(0).unwrap();
        let expected: Vec<&str> = whole
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .collect();
        assert_eq!(all["text"].as_str().unwrap(), expected.join("\n"));

        let lines = doc.text_lines(0).unwrap();
        let first = &lines[0];
        let one = reply(
            &mut doc,
            "view.text",
            serde_json::json!({ "page": 0, "boxes": [{
                "x": first.x, "y": first.y + first.height * 0.25,
                "width": first.width, "height": first.height * 0.5
            }] }),
        );
        assert_eq!(one["text"].as_str().unwrap(), first.text.trim());
        assert_eq!(one["lines"], 1);

        let none = reply(
            &mut doc,
            "view.text",
            serde_json::json!({ "page": 0, "boxes": [] }),
        );
        assert_eq!(none["text"], "");
        assert!(doc
            .call("view.text", r#"{"page":99,"boxes":[]}"#, vec![])
            .is_err());
    }

    /// A box round the start of a right-to-left line takes the words at its
    /// right end — the first ones read — and not the rest.
    #[test]
    fn part_of_a_right_to_left_line_is_its_first_words() {
        let mut doc = open("fixtures/redact/contract.pdf");
        let lines = doc.text_lines(0).unwrap();
        let line = lines
            .iter()
            .find(|l| l.direction == warraq_text::Direction::Rtl && l.text.split(' ').count() > 3)
            .expect("an Arabic line")
            .clone();
        let spans = char_boxes(&line);
        let words: Vec<&str> = line.text.split(' ').collect();
        let first_two = format!("{} {}", words[0], words[1]);
        let n = first_two.chars().count();
        // The first two words' glyphs: the rightmost stretch of the line.
        let x0 = spans[..n].iter().map(|s| s.0).fold(f32::MAX, f32::min);
        let x1 = spans[..n].iter().map(|s| s.1).fold(f32::MIN, f32::max);
        let got = reply(
            &mut doc,
            "view.text",
            serde_json::json!({ "page": 0, "boxes": [{
                "x": x0, "y": line.y, "width": x1 - x0, "height": line.height
            }] }),
        );
        assert_eq!(got["text"].as_str().unwrap(), first_two);
    }
}
