//! Text normalisation.
//!
//! * [`normalize_extracted`] — for extraction output: Arabic presentation forms
//!   (U+FB50–U+FDFF, U+FE70–U+FEFC) and Latin/Hebrew presentation ligatures (U+FB00–U+FB4F) are
//!   mapped back to base letters with NFKC **only for those characters** (so lam-alef
//!   ligatures ﻻ become ل + ا in logical order); nothing else is touched.
//! * [`normalize_for_search`] — Arabic-aware folding with an offset map back to the input.

use unicode_normalization::UnicodeNormalization;

/// True for Unicode presentation-form blocks that NFKC maps back to base letters.
pub fn is_presentation_form(c: char) -> bool {
    matches!(u32::from(c), 0xFB00..=0xFDFF | 0xFE70..=0xFEFC)
}

/// NFKC of one character, only if it changes it.
fn nfkc_if_changed(c: char) -> Option<String> {
    let n: String = std::iter::once(c).nfkc().collect();
    let mut it = n.chars();
    match (it.next(), it.next()) {
        (Some(x), None) if x == c => None,
        _ => Some(n),
    }
}

/// Normalise text read from a PDF glyph: presentation forms → base letters, NUL/BOM and C0
/// controls dropped.
pub fn normalize_extracted(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c == '\u{FEFF}' || (c.is_control() && c != '\n' && c != '\t') {
            continue;
        }
        if is_presentation_form(c) {
            match nfkc_if_changed(c) {
                Some(n) => out.push_str(&n),
                None => out.push(c),
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Arabic diacritics (tashkeel), Quranic marks and tatweel.
pub fn is_tashkeel_or_tatweel(c: char) -> bool {
    matches!(u32::from(c), 0x064B..=0x065F | 0x0670 | 0x06D6..=0x06ED | 0x0640)
}

fn is_ignorable(c: char) -> bool {
    is_tashkeel_or_tatweel(c)
        || matches!(
            c,
            '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{061C}' | '\u{FEFF}' | '\u{00AD}'
        )
}

fn fold_char(c: char, out: &mut Vec<char>) {
    let mapped = match c {
        'أ' | 'إ' | 'آ' | 'ٱ' | '\u{0672}' | '\u{0673}' => 'ا',
        'ة' => 'ه',
        'ى' => 'ي',
        'ی' => 'ي',
        'ک' => 'ك',
        '\u{0660}'..='\u{0669}' => {
            char::from_u32(u32::from(c) - 0x0660 + u32::from('0')).unwrap_or(c)
        }
        '\u{06F0}'..='\u{06F9}' => {
            char::from_u32(u32::from(c) - 0x06F0 + u32::from('0')).unwrap_or(c)
        }
        _ => {
            if c.is_uppercase() {
                out.extend(c.to_lowercase());
                return;
            }
            c
        }
    };
    out.push(mapped);
}

/// Normalise for Arabic-aware search.
///
/// Drops tashkeel (U+064B–065F, U+0670, U+06D6–06ED), tatweel (U+0640) and invisible
/// formatting characters (ZWNJ/ZWJ, bidi marks, soft hyphen); unifies alef forms (أ إ آ ٱ → ا),
/// taa marbuta (ة → ه), alef maqsura (ى → ي), Persian yeh/kaf (ی → ي, ک → ك); maps
/// Arabic-Indic and Extended Arabic-Indic digits to ASCII; lower-cases; applies NFKC to a
/// character only when that changes it; collapses whitespace runs to one space.
///
/// Returns the normalised string and, for every **char** of it, the byte offset of the
/// originating char in `s`; the vector has one extra final entry equal to `s.len()`.
pub fn normalize_for_search(s: &str) -> (String, Vec<usize>) {
    let mut out = String::with_capacity(s.len());
    let mut map = Vec::with_capacity(s.len() + 1);
    let mut last_space = false;
    let mut buf: Vec<char> = Vec::with_capacity(4);
    for (i, c) in s.char_indices() {
        if c.is_whitespace() {
            if !last_space && !out.is_empty() {
                out.push(' ');
                map.push(i);
                last_space = true;
            }
            continue;
        }
        if is_ignorable(c) {
            continue;
        }
        buf.clear();
        match nfkc_if_changed(c) {
            Some(n) => {
                for e in n.chars() {
                    if !is_ignorable(e) {
                        fold_char(e, &mut buf);
                    }
                }
            }
            None => fold_char(c, &mut buf),
        }
        for &e in &buf {
            if e.is_whitespace() {
                if last_space || out.is_empty() {
                    continue;
                }
                out.push(' ');
                last_space = true;
            } else {
                out.push(e);
                last_space = false;
            }
            map.push(i);
        }
    }
    map.push(s.len());
    (out, map)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    #[test]
    fn presentation_forms_to_base_letters() {
        // ﻻ (FEFB) lam-alef isolated → ل + ا ; ﺑ (FE91) beh initial → ب
        assert_eq!(normalize_extracted("\u{FEFB}\u{FE91}"), "لاب");
        // lam-alef with hamza above final (FEF8) → ل + أ
        assert_eq!(normalize_extracted("\u{FEF8}"), "لأ");
        // ﬁ ligature
        assert_eq!(normalize_extracted("\u{FB01}"), "fi");
        // Other compatibility characters are untouched (no global NFKC).
        assert_eq!(normalize_extracted("x² ١٢"), "x² ١٢");
        assert_eq!(normalize_extracted("a\u{0}b\u{FEFF}"), "ab");
    }

    #[test]
    fn search_folding() {
        let (n, _) = normalize_for_search("إِنَّ الـمـدرسةَ الكبرى، مدرسة ک ی ١٢٣ ۴۵ ABC");
        assert_eq!(n, "ان المدرسه الكبري، مدرسه ك ي 123 45 abc");
        let (n, _) = normalize_for_search("آمال أحمد ٱلله");
        assert_eq!(n, "امال احمد الله");
        // presentation form + tashkeel
        let (n, _) = normalize_for_search("\u{FEF7}\u{064E}");
        assert_eq!(n, "لا");
    }

    #[test]
    fn offset_map_points_into_original() {
        let s = "مَدْرَسَة  2";
        let (n, map) = normalize_for_search(s);
        assert_eq!(n, "مدرسه 2");
        assert_eq!(map.len(), n.chars().count() + 1);
        // every mapped offset is a char boundary of the original
        for &o in &map {
            assert!(s.is_char_boundary(o));
        }
        // 'ه' comes from 'ة'
        let idx = n.chars().position(|c| c == 'ه').unwrap();
        assert!(s[map[idx]..].starts_with('ة'));
        assert_eq!(*map.last().unwrap(), s.len());
    }

    #[test]
    fn nfkc_only_when_it_changes() {
        let (n, map) = normalize_for_search("ﷲ");
        assert_eq!(n, "الله");
        assert!(map[..4].iter().all(|&o| o == 0));
    }
}
