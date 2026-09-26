//! Heuristics that turn logical-order paragraphs into structure: headings by relative font size,
//! list items by their markers (bullets, Latin / Arabic-Indic / Persian digits, Arabic abjad
//! letters), and pagination artifacts (running headers/footers repeated across pages, page
//! numbers such as «صفحة ١ من ٩» or "Page 3 of 9").

use std::collections::HashMap;

use warraq_text::model::PageText;

use crate::lang;

/// Bullet characters that start a list item.
const BULLETS: &[char] = &[
    '•', '●', '○', '◦', '▪', '▫', '■', '□', '◆', '◇', '►', '▶', '➢', '✓', '✔', '–', '—', '-', '*',
    '·', '⁃', '❖', '∙', '◉', '۞',
];

/// Arabic letters used as list labels (abjad order and the common alphabetical ones).
const ARABIC_LABELS: &[char] = &[
    'أ', 'ا', 'ب', 'ج', 'د', 'ه', 'و', 'ز', 'ح', 'ط', 'ي', 'ك', 'ل', 'م', 'ن', 'س', 'ع', 'ف', 'ص',
    'ق', 'ر', 'ش', 'ت', 'ث', 'خ', 'ذ', 'ض', 'ظ', 'غ',
];

fn is_digit_any(c: char) -> bool {
    c.is_ascii_digit() || ('\u{0660}'..='\u{0669}').contains(&c) || ('\u{06F0}'..='\u{06F9}').contains(&c)
}

/// The list label at the start of a paragraph's logical text, if any (e.g. `•`, `1.`, `١-`,
/// `(٣)`, `أ)`, `b.`).
pub fn list_label(text: &str) -> Option<String> {
    let t = text.trim_start();
    let first = t.split_whitespace().next()?;
    let chars: Vec<char> = first.chars().collect();
    let rest_nonempty = t.get(first.len()..).is_some_and(|r| !r.trim().is_empty());
    // Bullets: the bullet alone, or glued to the text.
    if let Some(c) = chars.first() {
        if BULLETS.contains(c) {
            if chars.len() == 1 {
                return rest_nonempty.then(|| first.to_string());
            }
            // "-" glued to a word is a hyphenated word, not a bullet.
            if !matches!(c, '-' | '–' | '—' | '*') {
                return Some(c.to_string());
            }
            return None;
        }
    }
    if !rest_nonempty {
        return None;
    }
    // (n) or (letter)
    let inner: &[char] = match (chars.first(), chars.last()) {
        (Some('('), Some(')')) if chars.len() >= 3 => chars.get(1..chars.len() - 1)?,
        _ => {
            let (last, body) = chars.split_last()?;
            if !matches!(last, '.' | ')' | '-' | '–' | '/' | '٫' | ':') {
                return None;
            }
            body
        }
    };
    if inner.is_empty() || inner.len() > 3 {
        return None;
    }
    if inner.iter().all(|c| is_digit_any(*c)) {
        return Some(first.to_string());
    }
    if inner.len() == 1 {
        let c = inner.first().copied()?;
        if c.is_ascii_alphabetic() || ARABIC_LABELS.contains(&c) {
            return Some(first.to_string());
        }
    }
    // Roman numerals up to 3 letters (i, ii, iv, …).
    if inner.iter().all(|c| matches!(c, 'i' | 'v' | 'x' | 'I' | 'V' | 'X')) {
        return Some(first.to_string());
    }
    None
}

/// Whether a short text is a page number (`3`, `- 3 -`, `٣`, `Page 3`, `Page 3 of 9`, `صفحة ٣ من ٩`,
/// `3 / 9`).
pub fn is_page_number(text: &str) -> bool {
    let t = text.trim();
    if t.is_empty() || t.chars().count() > 30 {
        return false;
    }
    let words: Vec<&str> = t.split_whitespace().collect();
    let digits = t.chars().filter(|c| is_digit_any(*c)).count();
    if digits == 0 {
        return false;
    }
    let allowed_words = ["page", "Page", "PAGE", "صفحة", "الصفحة", "ص", "of", "من", "صفحه"];
    words.iter().all(|w| {
        let w = w.trim_matches(|c: char| matches!(c, '-' | '–' | '—' | '|' | '.' | '/' | ':' | '(' | ')'));
        w.is_empty() || w.chars().all(is_digit_any) || allowed_words.contains(&w)
    })
}

/// Text with digits and spaces removed (running headers/footers differ only by the page number).
pub fn running_key(text: &str) -> String {
    text.chars()
        .filter(|c| !is_digit_any(*c) && !c.is_whitespace())
        .collect()
}

/// Document-wide statistics for the auto-tagger.
#[derive(Debug, Clone, Default)]
pub struct Stats {
    /// Body font size (character-weighted most common size).
    pub body: f64,
    /// Heading sizes, largest first (H1, H2, …).
    pub heading_sizes: Vec<f64>,
    /// (page, paragraph) pairs that are pagination artifacts, with header (true) / footer.
    pub pagination: HashMap<(usize, usize), bool>,
    /// Dominant language.
    pub lang: Option<&'static str>,
}

fn round_half(v: f64) -> f64 {
    (v * 2.0).round() / 2.0
}

fn median(mut v: Vec<f64>) -> f64 {
    v.retain(|x| x.is_finite());
    v.sort_by(f64::total_cmp);
    v.get(v.len() / 2).copied().unwrap_or(0.0)
}

/// Median word size of a paragraph.
pub fn para_size(p: &warraq_text::model::Paragraph) -> f64 {
    median(
        p.lines
            .iter()
            .flat_map(|l| l.words.iter().map(|w| w.size))
            .collect(),
    )
}

/// Whether a paragraph is short enough to be a heading.
pub fn heading_shape(text: &str, lines: usize) -> bool {
    let n = text.chars().count();
    lines <= 3 && n > 0 && n <= 200
}

/// Compute [`Stats`] over extracted pages (existing artifacts ignored).
pub fn stats(pages: &[PageText]) -> Stats {
    let mut hist: Vec<(f64, usize)> = Vec::new();
    let mut texts: Vec<String> = Vec::new();
    for p in pages {
        for para in p.paragraphs() {
            let mut non_artifact = false;
            for l in &para.lines {
                for w in &l.words {
                    if w.artifact {
                        continue;
                    }
                    non_artifact = true;
                    let s = round_half(w.size);
                    let n = w.text.chars().count();
                    if let Some(e) = hist.iter_mut().find(|(k, _)| *k == s) {
                        e.1 += n;
                    } else if hist.len() < 4096 {
                        hist.push((s, n));
                    }
                }
            }
            if non_artifact && texts.len() < 20_000 {
                texts.push(para.text.clone());
            }
        }
    }
    let body = hist
        .iter()
        .max_by(|a, b| a.1.cmp(&b.1).then(b.0.total_cmp(&a.0)))
        .map_or(12.0, |(s, _)| *s)
        .max(1.0);

    // Pagination: margin paragraphs repeated across pages (digits ignored) or page numbers.
    let mut margin: Vec<(usize, usize, String, f64, bool, bool)> = Vec::new();
    for p in pages {
        let h = p.height.max(1.0);
        for (pi, para) in p.paragraphs().enumerate() {
            if para.lines.len() > 2 {
                continue;
            }
            // Running headers/footers repeat within the outer 15 %; lone page numbers sit in
            // the outer 12 %.
            let top = para.bbox.y1 < h * 0.15;
            let bottom = para.bbox.y0 > h * 0.85;
            let edge = para.bbox.y1 < h * 0.12 || para.bbox.y0 > h * 0.88;
            if top || bottom {
                margin.push((p.page, pi, running_key(&para.text), para.bbox.cy(), top, edge));
            }
        }
    }
    let mut pagination = HashMap::new();
    let multi = pages.len() > 1;
    for (i, (page, pi, key, y, top, edge)) in margin.iter().enumerate() {
        let para_text = pages
            .iter()
            .find(|p| p.page == *page)
            .and_then(|p| p.paragraphs().nth(*pi))
            .map(|p| p.text.clone())
            .unwrap_or_default();
        let repeated = multi
            && !key.is_empty()
            && margin.iter().enumerate().any(|(j, (pg, _, k, yy, _, _))| {
                j != i && pg != page && k == key && (yy - y).abs() < 8.0
            });
        if repeated || (*edge && is_page_number(&para_text)) {
            pagination.insert((*page, *pi), *top);
        }
    }

    // Headings: short paragraphs clearly larger than the body text.
    let mut sizes: Vec<f64> = Vec::new();
    for p in pages {
        for (pi, para) in p.paragraphs().enumerate() {
            if pagination.contains_key(&(p.page, pi)) || list_label(&para.text).is_some() {
                continue;
            }
            if para.lines.iter().all(|l| l.words.iter().all(|w| w.artifact)) {
                continue;
            }
            let s = round_half(para_size(para));
            if s >= body * 1.15 && heading_shape(&para.text, para.lines.len()) && !sizes.contains(&s) {
                sizes.push(s);
            }
        }
    }
    sizes.sort_by(|a, b| b.total_cmp(a));
    sizes.truncate(6);
    Stats {
        body,
        heading_sizes: sizes,
        pagination,
        lang: lang::dominant(texts.iter().map(String::as_str)),
    }
}

impl Stats {
    /// Heading level (1–6) of a paragraph, or None.
    pub fn heading_level(&self, size: f64, text: &str, lines: usize) -> Option<u8> {
        if !heading_shape(text, lines) {
            return None;
        }
        let s = round_half(size);
        self.heading_sizes
            .iter()
            .position(|h| (h - s).abs() < 0.25)
            .map(|i| (i + 1).min(6) as u8)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn list_labels() {
        assert_eq!(list_label("• نقطة أولى").as_deref(), Some("•"));
        assert_eq!(list_label("١. البند الأول").as_deref(), Some("١."));
        assert_eq!(list_label("٢- البند").as_deref(), Some("٢-"));
        assert_eq!(list_label("(٣) البند").as_deref(), Some("(٣)"));
        assert_eq!(list_label("۴) بند").as_deref(), Some("۴)"));
        assert_eq!(list_label("أ) البند").as_deref(), Some("أ)"));
        assert_eq!(list_label("1. Install").as_deref(), Some("1."));
        assert_eq!(list_label("b) second").as_deref(), Some("b)"));
        assert_eq!(list_label("iv. fourth").as_deref(), Some("iv."));
        assert_eq!(list_label("2024. was a year"), None);
        assert_eq!(list_label("well-known words"), None);
        assert_eq!(list_label("1."), None);
        assert_eq!(list_label("الفقرة العادية."), None);
    }

    #[test]
    fn page_numbers() {
        assert!(is_page_number("٣"));
        assert!(is_page_number("- 3 -"));
        assert!(is_page_number("صفحة ١ من ٩"));
        assert!(is_page_number("Page 3 of 9"));
        assert!(is_page_number("3 / 9"));
        assert!(!is_page_number("Chapter 3"));
        assert!(!is_page_number("الفصل الأول"));
        assert_eq!(running_key("تقرير ٣ page 4"), "تقريرpage");
    }
}
