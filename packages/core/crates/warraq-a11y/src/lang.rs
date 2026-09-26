//! Natural language from the script of a text, and BCP 47 tag helpers.
//!
//! The script decides: Arabic script → `ar`, or `fa` / `ur` when their distinctive letters appear
//! (پ چ ژ گ ی ک / ٹ ڈ ڑ ں ہ ھ ے); Latin → `en`; Hebrew → `he` (warraq-office's `guess_lang`).
//! Text without letters (digits, punctuation) has no language of its own.

/// Language of a text from its script, if it has letters.
pub fn detect(text: &str) -> Option<&'static str> {
    // Letters only: Arabic-Indic and Persian digits are neutral, not Arabic or Persian.
    let letters: String = text.chars().filter(|c| c.is_alphabetic()).collect();
    warraq_office::xml::guess_lang(&letters)
}

/// Letters counted for language weighting.
pub fn letters(text: &str) -> usize {
    text.chars().filter(|c| c.is_alphabetic()).count()
}

/// Primary subtag, lower-cased (`ar-SA` → `ar`).
pub fn primary(tag: &str) -> String {
    tag.split(['-', '_'])
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
}

/// Whether two tags name the same language (primary subtags equal).
pub fn same(a: &str, b: &str) -> bool {
    let (a, b) = (primary(a), primary(b));
    !a.is_empty() && a == b
}

/// A well-formed BCP 47-like tag: 2–8 letter primary subtag, then alphanumeric subtags of 1–8
/// characters separated by `-`, at most 35 characters.
pub fn valid_tag(tag: &str) -> bool {
    if tag.is_empty() || tag.len() > 35 {
        return false;
    }
    let mut parts = tag.split('-');
    let Some(first) = parts.next() else {
        return false;
    };
    if !(2..=8).contains(&first.len()) || !first.bytes().all(|b| b.is_ascii_alphabetic()) {
        return false;
    }
    parts.all(|p| (1..=8).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_alphanumeric()))
}

/// Dominant language of weighted texts (letters count as weight).
pub fn dominant<'a>(texts: impl IntoIterator<Item = &'a str>) -> Option<&'static str> {
    let mut counts: Vec<(&'static str, usize)> = Vec::new();
    for t in texts {
        if let Some(l) = detect(t) {
            let n = letters(t).max(1);
            match counts.iter_mut().find(|(k, _)| *k == l) {
                Some(e) => e.1 += n,
                None => counts.push((l, n)),
            }
        }
    }
    counts.into_iter().max_by_key(|(_, n)| *n).map(|(l, _)| l)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn scripts() {
        assert_eq!(detect("مرحبا بالعالم"), Some("ar"));
        assert_eq!(detect("PDF"), Some("en"));
        assert_eq!(detect("کتاب فارسی"), Some("fa"));
        assert_eq!(detect("یہ اردو ہے"), Some("ur"));
        assert_eq!(detect("١٢٣ - 45"), None);
        assert_eq!(dominant(["مرحبا بالعالم", "PDF"]), Some("ar"));
    }

    #[test]
    fn tags() {
        assert!(valid_tag("ar"));
        assert!(valid_tag("ar-SA"));
        assert!(valid_tag("en-US"));
        assert!(!valid_tag(""));
        assert!(!valid_tag("a"));
        assert!(!valid_tag("ar SA"));
        assert!(!valid_tag("ar-"));
        assert!(!valid_tag("ar-\u{202e}x"));
        assert!(same("ar-SA", "AR"));
        assert!(!same("ar", "en"));
    }
}
