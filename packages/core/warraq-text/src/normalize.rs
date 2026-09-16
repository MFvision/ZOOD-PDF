//! Arabic-aware normalization: presentation forms, marks, search folding.
use unicode_normalization::UnicodeNormalization;

/// Tashkeel, tatweel and bidi controls that never matter for search.
pub fn is_mark_or_control(c: char) -> bool {
    matches!(c,
        '\u{064B}'..='\u{065F}' | '\u{0670}' | '\u{06D6}'..='\u{06ED}' | '\u{0640}' | '\u{0300}'..='\u{036F}' | '\u{20D0}'..='\u{20FF}' |
        '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}')
}

pub fn is_presentation_form(c: char) -> bool {
    matches!(c, '\u{FB50}'..='\u{FDFF}' | '\u{FE70}'..='\u{FEFF}')
}

/// Map Arabic presentation forms (U+FBxx/U+FExx) back to logical letters using
/// NFKC, leaving everything else untouched (NFKC would also alter ligatures such
/// as "ﬁ" or fullwidth forms elsewhere, which we do not want here).
pub fn fold_presentation_forms(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if is_presentation_form(c) {
            out.extend(c.to_string().nfkc());
        } else {
            out.push(c);
        }
    }
    out
}

/// Remove tashkeel, tatweel and bidi controls.
pub fn strip_marks(s: &str) -> String {
    s.chars().filter(|c| !is_mark_or_control(*c)).collect()
}

/// Mirror a bracket-like character (used when moving between visual and logical order).
pub fn mirror_bracket(c: char) -> char {
    match c {
        '(' => ')',
        ')' => '(',
        '[' => ']',
        ']' => '[',
        '{' => '}',
        '}' => '{',
        '<' => '>',
        '>' => '<',
        '«' => '»',
        '»' => '«',
        '‹' => '›',
        '›' => '‹',
        '⟨' => '⟩',
        '⟩' => '⟨',
        other => other,
    }
}

#[derive(Debug, Clone, Copy)]
pub struct SearchNormalization {
    pub ignore_marks: bool,
    pub unify_alef: bool,
    pub unify_taa_marbuta: bool,
    pub unify_yaa: bool,
    pub unify_digits: bool,
    pub ignore_case: bool,
}

impl Default for SearchNormalization {
    fn default() -> Self {
        Self {
            ignore_marks: true,
            unify_alef: true,
            unify_taa_marbuta: true,
            unify_yaa: true,
            unify_digits: true,
            ignore_case: true,
        }
    }
}

/// Normalize one character for search. Returns an empty string for characters
/// that are dropped, so callers can keep an index map from normalized to original.
pub fn normalize_char(c: char, opts: &SearchNormalization) -> String {
    let mut s = String::new();
    if is_presentation_form(c) {
        for f in c.to_string().nfkc() {
            s.push_str(&normalize_char(f, opts));
        }
        return s;
    }
    if opts.ignore_marks && is_mark_or_control(c) {
        return s;
    }
    let mapped = match c {
        'أ' | 'إ' | 'آ' | 'ٱ' if opts.unify_alef => 'ا',
        'ة' if opts.unify_taa_marbuta => 'ه',
        'ى' if opts.unify_yaa => 'ي',
        'ي' if opts.unify_yaa => 'ي',
        'ك' => 'ك', // Arabic kaf; Persian keheh handled below
        'ک' => 'ك',
        'ی' if opts.unify_yaa => 'ي',
        '٠'..='٩' if opts.unify_digits => {
            char::from_u32('0' as u32 + (c as u32 - '٠' as u32)).unwrap()
        }
        '۰'..='۹' if opts.unify_digits => {
            char::from_u32('0' as u32 + (c as u32 - '۰' as u32)).unwrap()
        }
        _ => c,
    };
    if opts.ignore_case {
        s.extend(mapped.to_lowercase());
    } else {
        s.push(mapped);
    }
    s
}

/// Normalize a string for search; also returns, for every normalized char, the
/// byte offset of the original char it came from (for highlighting).
pub fn normalize_for_search(s: &str, opts: &SearchNormalization) -> (String, Vec<usize>) {
    let mut out = String::with_capacity(s.len());
    let mut map = Vec::with_capacity(s.len());
    for (i, c) in s.char_indices() {
        let n = normalize_char(c, opts);
        for _ in n.chars() {
            map.push(i);
        }
        out.push_str(&n);
    }
    (out, map)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presentation_forms_fold_to_logical_letters() {
        assert_eq!(fold_presentation_forms("\u{FEFB}"), "لا"); // lam-alef ligature
        assert_eq!(
            fold_presentation_forms("\u{FEEA}\u{FEE0}\u{FEDF}\u{FE8D}"),
            "هللا"
        );
        assert_eq!(fold_presentation_forms("ﬁ"), "ﬁ"); // untouched outside the Arabic ranges
    }

    #[test]
    fn strip_marks_removes_tashkeel_and_tatweel() {
        assert_eq!(strip_marks("الْعِلْمُ نُورٌ"), "العلم نور");
        assert_eq!(strip_marks("الـعـربـيـة"), "العربية");
    }

    #[test]
    fn search_normalization_unifies_alef_taa_yaa_and_digits() {
        let (n, _) = normalize_for_search(
            "أحمد إلى آخر ٢٠٢٦ مكتبة موسى",
            &SearchNormalization::default(),
        );
        assert_eq!(n, "احمد الي اخر 2026 مكتبه موسي");
        let (n, map) = normalize_for_search("كِتَابٌ", &SearchNormalization::default());
        assert_eq!(n, "كتاب");
        assert_eq!(map, vec![0, 4, 8, 10]); // byte offsets of ك ت ا ب in the original
    }
}
