//! Arabic-aware search over extracted pages, with hit rectangles from glyph boxes.

use serde::Serialize;

use crate::geom::Rect;
use crate::limits;
use crate::model::PageText;
use crate::normalize::{is_tashkeel_or_tatweel, normalize_for_search};

/// A search hit.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Hit {
    /// 0-based page index.
    pub page: usize,
    /// Rectangles (top-left page coordinates), one per line touched.
    pub rects: Vec<Rect>,
    /// Char offsets `[start, end)` in the page's logical plain text.
    pub start: usize,
    pub end: usize,
    /// The matched original text.
    pub text: String,
}

/// Find `query` in `pages` using [`normalize_for_search`] on both sides.
pub fn search(pages: &[PageText], query: &str) -> Vec<Hit> {
    let (q, _) = normalize_for_search(query);
    let q = q.trim();
    if q.is_empty() {
        return Vec::new();
    }
    let mut hits = Vec::new();
    for page in pages {
        search_page(page, q, &mut hits);
        if hits.len() >= limits::MAX_SEARCH_HITS {
            hits.truncate(limits::MAX_SEARCH_HITS);
            break;
        }
    }
    hits
}

fn search_page(page: &PageText, q: &str, hits: &mut Vec<Hit>) {
    let plain = &page.plain;
    let (norm, map) = normalize_for_search(plain);
    // byte offset in `norm` → char index in `norm`
    let norm_starts: Vec<usize> = norm.char_indices().map(|(b, _)| b).collect();
    // byte offset in `plain` → char index in `plain`
    let plain_starts: Vec<usize> = plain.char_indices().map(|(b, _)| b).collect();
    let char_of = |byte: usize| plain_starts.partition_point(|&b| b < byte);
    let q_chars = q.chars().count();
    let mut from = 0usize;
    while let Some(pos) = norm.get(from..).and_then(|s| s.find(q)) {
        let bstart = from + pos;
        from = bstart + q.len().max(1);
        let ci = norm_starts.partition_point(|&b| b < bstart);
        let Some(&ostart) = map.get(ci) else { break };
        let Some(&olast) = map.get(ci + q_chars.saturating_sub(1)) else {
            break;
        };
        // End: after the original char that produced the last matched char, plus trailing
        // diacritics that were folded away.
        let mut oend = olast
            + plain
                .get(olast..)
                .and_then(|s| s.chars().next())
                .map_or(0, char::len_utf8);
        while let Some(c) = plain.get(oend..).and_then(|s| s.chars().next()) {
            if is_tashkeel_or_tatweel(c) {
                oend += c.len_utf8();
            } else {
                break;
            }
        }
        let (start, end) = (char_of(ostart), char_of(oend));
        hits.push(Hit {
            page: page.page,
            rects: rects_for(page, start, end),
            start,
            end,
            text: plain.get(ostart..oend).unwrap_or("").to_string(),
        });
        if hits.len() >= limits::MAX_SEARCH_HITS {
            return;
        }
    }
}

/// Rectangles covering chars `[start, end)` of the page text, merged per line.
pub fn rects_for(page: &PageText, start: usize, end: usize) -> Vec<Rect> {
    let mut per_line: Vec<(usize, Rect)> = Vec::new();
    // Spans are in increasing text order.
    let first = page.spans.partition_point(|s| s.end <= start);
    for s in page.spans.get(first..).unwrap_or(&[]) {
        if s.start >= end {
            break;
        }
        if s.end <= start || s.end <= s.start {
            continue;
        }
        let n = (s.end - s.start) as f64;
        let a = start.max(s.start) - s.start;
        let b = end.min(s.end) - s.start;
        let w = s.bbox.width();
        let (fa, fb) = (a as f64 / n, b as f64 / n);
        let r = if s.rtl {
            Rect::new(s.bbox.x1 - fb * w, s.bbox.y0, s.bbox.x1 - fa * w, s.bbox.y1)
        } else {
            Rect::new(s.bbox.x0 + fa * w, s.bbox.y0, s.bbox.x0 + fb * w, s.bbox.y1)
        };
        match per_line.iter_mut().find(|(l, _)| *l == s.line) {
            Some((_, acc)) => *acc = acc.union(&r),
            None => per_line.push((s.line, r)),
        }
    }
    per_line.into_iter().map(|(_, r)| r.rounded()).collect()
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;
    use crate::model::TextSpan;

    fn page(plain: &str) -> PageText {
        // one span per char, 10pt wide, laid out right-to-left from x=500
        let spans = plain
            .chars()
            .enumerate()
            .map(|(k, _)| TextSpan {
                start: k,
                end: k + 1,
                bbox: Rect::new(
                    490.0 - 10.0 * k as f64,
                    100.0,
                    500.0 - 10.0 * k as f64,
                    112.0,
                ),
                rtl: true,
                line: 0,
            })
            .collect();
        PageText {
            page: 3,
            width: 600.0,
            height: 800.0,
            blocks: Vec::new(),
            plain: plain.to_string(),
            spans,
        }
    }

    #[test]
    fn finds_with_tashkeel_and_alef_variants() {
        let p = page("قالَ أحمدُ إنّ المدرسةَ جميلة");
        let hits = search(std::slice::from_ref(&p), "احمد");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].page, 3);
        assert_eq!(hits[0].text, "أحمدُ");
        let hits = search(std::slice::from_ref(&p), "المدرسه");
        assert_eq!(hits[0].text, "المدرسةَ");
        assert_eq!(hits[0].rects.len(), 1);
    }

    #[test]
    fn digits_and_persian_letters() {
        let p = page("سال ۱۴۰۳ و كتاب ١٢");
        assert_eq!(search(std::slice::from_ref(&p), "1403").len(), 1);
        assert_eq!(search(std::slice::from_ref(&p), "کتاب").len(), 1);
        assert_eq!(search(std::slice::from_ref(&p), "12").len(), 1);
        assert!(search(std::slice::from_ref(&p), "   ").is_empty());
    }

    #[test]
    fn rects_follow_rtl_spans() {
        let p = page("ابجد");
        let r = rects_for(&p, 1, 3);
        assert_eq!(r, vec![Rect::new(470.0, 100.0, 490.0, 112.0)]);
    }
}
