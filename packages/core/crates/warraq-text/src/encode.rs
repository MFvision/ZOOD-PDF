//! How writers encode shaped text so it reads back in logical order in **every** reader — the one
//! place Edit, Create PDF, the signature appearance, redaction overlays (and later Page marks and
//! Forms) decide, word by word, between glyph `ToUnicode` entries and `/ActualText` (ADR 0018).
//!
//! Measured with the viewer's PDFium (EmbedPDF 2.15.1, the engine of Chrome's viewer):
//! PDFium collects a line's characters in content order and reverses every right-to-left run —
//! **including the characters of `/ActualText`**. A logical ActualText (`مرحبا`) therefore comes
//! back reversed (`ابحرم`): search for the word fails and copy is backwards. Characters it takes
//! from `ToUnicode` in visual glyph order come back logical, and Arabic presentation-form
//! ligatures (U+FB50–U+FDFF, U+FE70–U+FEFF) are decomposed *after* the reversal, i.e. in logical
//! order (464 of the 465 Arabic ligature forms decompose exactly as NFKC; U+FBDD is excluded).
//!
//! So a right-to-left word is written **without** `/ActualText`; every glyph's ToUnicode entry
//! carries the characters it draws such that the visual sequence, read right to left, is the
//! logical word:
//! * a cluster of `k` glyphs and `n` characters (harfrust's visual order) with `k == n`: glyph `i`
//!   (from the left) stands for character `n-1-i`;
//! * `k < n` (a ligature such as lam-alef or the Allah ligature, possibly with marks): the right-most
//!   glyph stands for the logical prefix, written as the presentation-form ligature whose NFKC is
//!   exactly that prefix;
//! * a glyph always keeps one text per font (ToUnicode is per glyph, not per occurrence).
//!
//! That is also how Chrome and the classic Arabic writers encode text, so pdf.js, Acrobat, Poppler and
//! our own extractor (visual → logical bidi, presentation forms mapped back with NFKC) read it too.
//! When a word cannot be expressed that way — a font whose ToUnicode we do not own (a page's
//! original font), a glyph that already stands for other text, a ligature without a presentation
//! form, a cluster with more glyphs than characters, a word mixing directions, kashida-stretched
//! words, and words with tashkeel (PDFium positions zero-width marks geometrically — it inserts
//! spaces and moves marks to other letters whatever the encoding, Chrome's own PDFs included) —
//! the word keeps its per-word `/ActualText` (correct in spec-following readers; PDFium
//! reads that one word reversed, see STATUS). Left-to-right words keep `/ActualText` too: PDFium does
//! not reverse them, and it carries ligatures such as `fi`.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::ops::Range;
use std::sync::OnceLock;

use unicode_normalization::char::canonical_combining_class;
use unicode_normalization::UnicodeNormalization;

/// One glyph of a line, in visual order (left to right).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GlyphRef {
    /// The writer's font index (ToUnicode maps are per font).
    pub font: usize,
    pub glyph_id: u32,
    /// Byte offset in the line's logical text of the cluster this glyph belongs to.
    pub cluster: usize,
    /// The glyph comes from a right-to-left bidi run.
    pub rtl: bool,
}

/// A contiguous group of glyphs (visual order) for one logical word or whitespace run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncodedSpan {
    pub glyphs: Range<usize>,
    /// The logical text of the word ("" for the second piece of a word split by direction).
    pub text: String,
    /// `Some(t)`: wrap the glyphs in `/Span <</ActualText t>> BDC … EMC`. `None`: the glyphs'
    /// ToUnicode entries already read back as `text` in every reader; write no ActualText.
    pub actual_text: Option<String>,
}

/// The ToUnicode entries of every font a writer uses, filled while lines are encoded.
#[derive(Debug, Clone, Default)]
pub struct ToUnicodeMaps {
    map: BTreeMap<(usize, u32), String>,
    locked: BTreeSet<usize>,
}

impl ToUnicodeMaps {
    pub fn new() -> Self {
        Self::default()
    }

    /// `font`'s ToUnicode is not ours to write (a page's own font reused by Edit): its words keep
    /// `/ActualText`.
    pub fn lock_font(&mut self, font: usize) {
        self.locked.insert(font);
    }

    pub fn get(&self, font: usize, glyph_id: u32) -> Option<&str> {
        self.map.get(&(font, glyph_id)).map(String::as_str)
    }

    /// `(glyph id, text)` for one font, glyph ids ascending; empty texts are skipped.
    pub fn entries(&self, font: usize) -> impl Iterator<Item = (u32, &str)> + '_ {
        self.map
            .range((font, 0)..=(font, u32::MAX))
            .filter(|(_, t)| !t.is_empty())
            .map(|((_, g), t)| (*g, t.as_str()))
    }

    /// All claims or none: every glyph must be free or already stand for the same text.
    fn claim_all(&mut self, claims: &[(usize, u32, String)]) -> bool {
        let mut pending: HashMap<(usize, u32), &str> = HashMap::new();
        for (f, g, t) in claims {
            if self.locked.contains(f) {
                return false;
            }
            let existing = self.map.get(&(*f, *g)).map(String::as_str);
            let prior = pending.get(&(*f, *g)).copied().or(existing);
            match prior {
                Some(p) if p != t => return false,
                _ => {
                    pending.insert((*f, *g), t);
                }
            }
        }
        for (f, g, t) in claims {
            self.map.entry((*f, *g)).or_insert_with(|| t.clone());
        }
        true
    }

    /// First come, first served (the text readers without ActualText support will see).
    fn claim_if_free(&mut self, font: usize, glyph_id: u32, text: &str) {
        if !self.locked.contains(&font) && !text.is_empty() {
            self.map
                .entry((font, glyph_id))
                .or_insert_with(|| text.to_string());
        }
    }
}

/// Options of [`encode_line`].
#[derive(Debug, Clone, Copy, Default)]
pub struct EncodeOptions {
    /// Every word keeps `/ActualText` (the glyphs no longer map to the text, e.g. kashida-stretched).
    pub force_actual_text: bool,
}

/// Logical tokens of `text`: words and whitespace runs, as byte ranges.
pub(crate) fn tokens(text: &str) -> Vec<Range<usize>> {
    let mut out: Vec<Range<usize>> = Vec::new();
    let mut cur: Option<(usize, bool)> = None;
    for (i, c) in text.char_indices() {
        let ws = c.is_whitespace();
        match cur {
            Some((_, w)) if w == ws => {}
            Some((s, _)) => {
                out.push(s..i);
                cur = Some((i, ws));
            }
            None => cur = Some((i, ws)),
        }
    }
    if let Some((s, _)) = cur {
        out.push(s..text.len());
    }
    out
}

/// Group glyphs (visual order, by cluster) per logical word and whitespace run. Groups are
/// contiguous in visual order; when a word's glyphs are split (a word mixing directions) the first
/// piece carries the text and later pieces carry "", so the text is never duplicated.
pub(crate) fn word_groups(text: &str, clusters: &[usize]) -> Vec<(Range<usize>, String)> {
    let toks = tokens(text);
    let token_of = |cluster: usize| toks.iter().position(|r| r.contains(&cluster));
    let mut used = vec![false; toks.len()];
    let mut out: Vec<(Range<usize>, String)> = Vec::new();
    let mut close =
        |tok: Option<usize>, s: usize, e: usize, out: &mut Vec<(Range<usize>, String)>| {
            let t = match tok {
                Some(t) if !used.get(t).copied().unwrap_or(true) => {
                    if let Some(u) = used.get_mut(t) {
                        *u = true;
                    }
                    toks.get(t)
                        .and_then(|r| text.get(r.clone()))
                        .unwrap_or("")
                        .to_string()
                }
                _ => String::new(),
            };
            out.push((s..e, t));
        };
    let mut cur: Option<(Option<usize>, usize)> = None;
    for (i, c) in clusters.iter().enumerate() {
        let t = token_of(*c);
        match cur {
            Some((ct, _)) if ct == t => {}
            Some((ct, s)) => {
                close(ct, s, i, &mut out);
                cur = Some((t, i));
            }
            None => cur = Some((t, i)),
        }
    }
    if let Some((ct, s)) = cur {
        close(ct, s, clusters.len(), &mut out);
    }
    out
}

/// Arabic presentation-form ligature whose NFKC is exactly `s` (two or more Arabic characters).
pub fn presentation_ligature(s: &str) -> Option<char> {
    static TABLE: OnceLock<HashMap<String, char>> = OnceLock::new();
    TABLE
        .get_or_init(|| {
            let mut t = HashMap::new();
            for cp in (0xFB50u32..=0xFDFF).chain(0xFE70..=0xFEFF) {
                // U+FBDD's NFKC starts with U+0677, which PDFium does not decompose further.
                if cp == 0xFBDD {
                    continue;
                }
                let Some(c) = char::from_u32(cp) else {
                    continue;
                };
                let d: String = c.nfkc().collect();
                let arabic = d
                    .chars()
                    .all(|x| matches!(x as u32, 0x0600..=0x06FF) && x != '\u{0640}');
                if d.chars().count() >= 2 && arabic {
                    t.entry(d).or_insert(c);
                }
            }
            t
        })
        .get(s)
        .copied()
}

/// Logical characters of a cluster with runs of combining marks in canonical order (harfrust
/// normalises the same way before shaping, so glyph order follows this order).
fn cluster_chars(s: &str) -> Vec<char> {
    let mut v: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < v.len() {
        if canonical_combining_class(v.get(i).copied().unwrap_or('\0')) == 0 {
            i += 1;
            continue;
        }
        let start = i;
        while i < v.len() && canonical_combining_class(v.get(i).copied().unwrap_or('\0')) != 0 {
            i += 1;
        }
        if let Some(run) = v.get_mut(start..i) {
            run.sort_by_key(|c| canonical_combining_class(*c));
        }
    }
    v
}

/// ToUnicode texts for the glyphs of one right-to-left word (visual order), or None when the word
/// cannot be expressed without ActualText.
fn rtl_glyph_texts(
    text: &str,
    glyphs: &[GlyphRef],
    ends: &dyn Fn(usize) -> usize,
) -> Option<Vec<String>> {
    let mut out: Vec<String> = Vec::with_capacity(glyphs.len());
    let mut i = 0;
    while i < glyphs.len() {
        let c = glyphs.get(i)?.cluster;
        let mut j = i + 1;
        while j < glyphs.len() && glyphs.get(j)?.cluster == c {
            j += 1;
        }
        let chars = cluster_chars(text.get(c..ends(c))?);
        let (k, n) = (j - i, chars.len());
        if n == 0 || k > n {
            return None;
        }
        // Left to right: the last characters first.
        for m in 0..k - 1 {
            out.push(chars.get(n - 1 - m)?.to_string());
        }
        let head: String = chars.get(..=n - k)?.iter().collect();
        if head.chars().count() == 1 {
            out.push(head);
        } else {
            out.push(presentation_ligature(&head)?.to_string());
        }
        i = j;
    }
    Some(out)
}

/// Encode one shaped line: `text` is its logical text, `glyphs` its glyphs in visual order with
/// clusters indexing `text`. Returns one span per word / whitespace run (visual order) and records
/// the glyphs' ToUnicode texts in `maps`.
pub fn encode_line(
    text: &str,
    glyphs: &[GlyphRef],
    maps: &mut ToUnicodeMaps,
    opts: EncodeOptions,
) -> Vec<EncodedSpan> {
    let clusters: Vec<usize> = glyphs.iter().map(|g| g.cluster).collect();
    let mut starts = clusters.clone();
    starts.sort_unstable();
    starts.dedup();
    let ends = |c: usize| -> usize {
        starts
            .iter()
            .find(|s| **s > c)
            .copied()
            .unwrap_or(text.len())
            .min(text.len())
    };
    let mut out = Vec::new();
    for (range, word) in word_groups(text, &clusters) {
        let gs = glyphs.get(range.clone()).unwrap_or(&[]);
        let rtl = !gs.is_empty() && gs.iter().all(|g| g.rtl);
        let texts = if rtl && !word.is_empty() && !opts.force_actual_text {
            rtl_glyph_texts(text, gs, &ends)
        } else {
            None
        };
        let claims: Option<Vec<(usize, u32, String)>> = texts.map(|texts| {
            gs.iter()
                .zip(texts)
                .map(|(g, t)| (g.font, g.glyph_id, t))
                .collect()
        });
        // Words with combining marks (tashkeel) keep ActualText: PDFium places zero-width mark
        // glyphs by geometry (inserting spaces, moving marks to other letters) whatever the
        // encoding, while ActualText gives our extractor and spec-following readers the exact word.
        let marks = word.chars().any(|c| canonical_combining_class(c) != 0);
        let direct = claims
            .as_ref()
            .filter(|_| !marks)
            .and_then(|c| maps.claim_all(c).then_some(()));
        if direct.is_none() && !opts.force_actual_text {
            // ToUnicode for readers without ActualText support: the visual assignment when there is
            // one, else the first glyph of each cluster gets the cluster's text.
            if let Some(c) = &claims {
                for (f, gid, t) in c {
                    maps.claim_if_free(*f, *gid, t);
                }
            } else {
                let mut seen = BTreeSet::new();
                for g in gs {
                    if seen.insert(g.cluster) {
                        let t = text.get(g.cluster..ends(g.cluster)).unwrap_or("");
                        maps.claim_if_free(g.font, g.glyph_id, t);
                    }
                }
            }
        }
        out.push(EncodedSpan {
            glyphs: range,
            actual_text: if direct.is_some() {
                None
            } else {
                Some(word.clone())
            },
            text: word,
        });
    }
    out
}

/// A ToUnicode CMap (two-byte codes, `bfchar` entries) for `(code, text)` pairs; empty texts are
/// skipped.
pub fn tounicode_cmap<'a>(entries: impl IntoIterator<Item = (u32, &'a str)>) -> Vec<u8> {
    use std::fmt::Write as _;
    let mut s = String::from(
        "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo <</Registry (Adobe) /Ordering (UCS) /Supplement 0>> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n",
    );
    let list: Vec<(u32, &str)> = entries
        .into_iter()
        .filter(|(c, t)| !t.is_empty() && *c <= 0xFFFF)
        .collect();
    for chunk in list.chunks(100) {
        let _ = writeln!(s, "{} beginbfchar", chunk.len());
        for (c, t) in chunk {
            let hex: String = t.encode_utf16().map(|u| format!("{u:04X}")).collect();
            let _ = writeln!(s, "<{c:04X}> <{hex}>");
        }
        s.push_str("endbfchar\n");
    }
    s.push_str("endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n");
    s.into_bytes()
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    fn g(glyph_id: u32, cluster: usize, rtl: bool) -> GlyphRef {
        GlyphRef {
            font: 0,
            glyph_id,
            cluster,
            rtl,
        }
    }

    #[test]
    fn rtl_word_has_no_actual_text_and_glyphs_map_in_visual_order() {
        // "بت" (beh 0..2, teh 2..4): visual order teh, beh.
        let mut m = ToUnicodeMaps::new();
        let s = encode_line(
            "بت",
            &[g(20, 2, true), g(10, 0, true)],
            &mut m,
            EncodeOptions::default(),
        );
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].actual_text, None);
        assert_eq!(s[0].text, "بت");
        assert_eq!(m.get(0, 20), Some("ت"));
        assert_eq!(m.get(0, 10), Some("ب"));
    }

    #[test]
    fn words_with_marks_keep_actual_text() {
        // "نُ" = noon + damma in one cluster; harfrust's visual order: damma, noon.
        let mut m = ToUnicodeMaps::new();
        let s = encode_line(
            "نُ",
            &[g(7, 0, true), g(3, 0, true)],
            &mut m,
            EncodeOptions::default(),
        );
        assert_eq!(s[0].actual_text.as_deref(), Some("نُ"));
        // The ToUnicode fallback still gets the visual assignment.
        assert_eq!(m.get(0, 7), Some("\u{064F}"));
        assert_eq!(m.get(0, 3), Some("ن"));
        // Shadda typed before fatha: canonical order is fatha (30) then shadda (33).
        let mut m = ToUnicodeMaps::new();
        encode_line(
            "بَّ",
            &[g(2, 0, true), g(1, 0, true), g(9, 0, true)],
            &mut m,
            EncodeOptions::default(),
        );
        assert_eq!(m.get(0, 2), Some("\u{0651}"));
        assert_eq!(m.get(0, 1), Some("\u{064E}"));
        assert_eq!(m.get(0, 9), Some("ب"));
    }

    #[test]
    fn single_glyph_ligatures_use_presentation_forms() {
        let mut m = ToUnicodeMaps::new();
        // "لا" as one glyph (Cairo), "الله" as one glyph.
        encode_line(
            "لا الله",
            &[g(5, 5, true), g(1, 4, true), g(4, 0, true)],
            &mut m,
            EncodeOptions::default(),
        );
        assert_eq!(m.get(0, 4), Some("\u{FEFB}"));
        assert_eq!(m.get(0, 5), Some("\u{FDF2}"));
        assert_eq!(
            presentation_ligature("لا").map(|c| c.nfkc().collect::<String>()),
            Some("لا".into())
        );
        assert_eq!(presentation_ligature("ab"), None);
        // lam-alef with a fatha: [fatha, lam-alef] — the ligature takes the logical prefix (the
        // word keeps ActualText for its mark; the ToUnicode entries still follow the rule).
        let mut m = ToUnicodeMaps::new();
        let s = encode_line(
            "لاَ",
            &[g(8, 0, true), g(4, 0, true)],
            &mut m,
            EncodeOptions::default(),
        );
        assert_eq!(s[0].actual_text.as_deref(), Some("لاَ"));
        assert_eq!(m.get(0, 8), Some("\u{064E}"));
        assert_eq!(m.get(0, 4), Some("\u{FEFB}"));
    }

    #[test]
    fn two_glyph_lam_alef_maps_alef_left_lam_right() {
        let mut m = ToUnicodeMaps::new();
        let s = encode_line(
            "لا",
            &[g(31, 0, true), g(30, 0, true)],
            &mut m,
            EncodeOptions::default(),
        );
        assert_eq!(s[0].actual_text, None);
        assert_eq!(m.get(0, 31), Some("ا"));
        assert_eq!(m.get(0, 30), Some("ل"));
    }

    #[test]
    fn falls_back_to_actual_text_when_the_glyphs_cannot_say_it() {
        // A glyph already standing for other text.
        let mut m = ToUnicodeMaps::new();
        encode_line("ب", &[g(1, 0, true)], &mut m, EncodeOptions::default());
        let s = encode_line("ت", &[g(1, 0, true)], &mut m, EncodeOptions::default());
        assert_eq!(s[0].actual_text.as_deref(), Some("ت"));
        assert_eq!(m.get(0, 1), Some("ب"));
        // More glyphs than characters.
        let s = encode_line(
            "س",
            &[g(40, 0, true), g(41, 0, true)],
            &mut m,
            EncodeOptions::default(),
        );
        assert_eq!(s[0].actual_text.as_deref(), Some("س"));
        // A locked (page's own) font.
        m.lock_font(1);
        let s = encode_line(
            "ن",
            &[GlyphRef {
                font: 1,
                glyph_id: 3,
                cluster: 0,
                rtl: true,
            }],
            &mut m,
            EncodeOptions::default(),
        );
        assert_eq!(s[0].actual_text.as_deref(), Some("ن"));
        assert_eq!(m.get(1, 3), None);
        // Forced (kashida-stretched).
        let s = encode_line(
            "من",
            &[g(50, 2, true), g(51, 0, true)],
            &mut m,
            EncodeOptions {
                force_actual_text: true,
            },
        );
        assert_eq!(s[0].actual_text.as_deref(), Some("من"));
        assert_eq!(m.get(0, 50), None);
    }

    #[test]
    fn ltr_words_keep_actual_text_and_spaces_are_their_own_spans() {
        let mut m = ToUnicodeMaps::new();
        // "ab نص": LTR "ab" then space then RTL word (visual: a b [space] ص ن — paragraph LTR).
        let s = encode_line(
            "ab نص",
            &[
                g(1, 0, false),
                g(2, 1, false),
                g(3, 2, false),
                g(4, 5, true),
                g(5, 3, true),
            ],
            &mut m,
            EncodeOptions::default(),
        );
        let texts: Vec<(&str, Option<&str>)> = s
            .iter()
            .map(|x| (x.text.as_str(), x.actual_text.as_deref()))
            .collect();
        assert_eq!(texts, [("ab", Some("ab")), (" ", Some(" ")), ("نص", None)]);
        assert_eq!(m.get(0, 1), Some("a"));
        assert_eq!(m.get(0, 4), Some("ص"));
        let e: Vec<(u32, &str)> = m.entries(0).collect();
        assert_eq!(e.len(), 5);
        let cmap = String::from_utf8(tounicode_cmap(e)).unwrap();
        assert!(cmap.contains("5 beginbfchar\n<0001> <0061>\n"), "{cmap}");
        assert!(cmap.contains("<0004> <0635>"), "{cmap}");
    }
}
