//! Words for the Library's index.
//!
//! A token is a run of letters and digits in the text the find bar would
//! search: `warraq_text::normalize_for_search` first — tashkeel and tatweel
//! dropped, alef, taa marbuta, yaa and the Arabic-Indic digits unified, case
//! folded — so "فاتورة" and "فَاتُوْرَه" and "الفَاتُورَةِ"'s second word are
//! one term, and "٢٠٢٦" and "2026" are one term too.
//!
//! Every token also carries where it is in the ORIGINAL line, so a snippet can
//! mark the match over the text the person wrote, marks and all.
use warraq_text::{normalize_for_search, SearchNormalization};

/// A term longer than this is cut into pieces of this length: one run of
/// letters must never cost more than a bounded amount of index.
pub const MAX_TOKEN_CHARS: usize = 64;

/// A word of a line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Token {
    /// The normalized word — what the index stores and the query is matched on.
    pub text: String,
    /// Byte offset of the word in the original line.
    pub start: usize,
    /// Its length there, in bytes, including the marks attached to its letters.
    pub len: usize,
}

/// What a word is made of. Marks and controls are already gone by now, so
/// letters and digits are all that is left.
fn is_word(c: char) -> bool {
    c.is_alphanumeric()
}

/// The words of one line, with their places in it.
pub fn tokenize(line: &str) -> Vec<Token> {
    let opts = SearchNormalization::default();
    let (norm, map) = normalize_for_search(line, &opts);
    let chars: Vec<char> = norm.chars().collect();
    // The map holds one entry per normalized char; a mismatch would mean the
    // normalizer changed under us, and guessing byte offsets from it would be
    // worse than finding nothing.
    if map.len() != chars.len() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if !is_word(chars[i]) {
            i += 1;
            continue;
        }
        let from = i;
        while i < chars.len() && is_word(chars[i]) && i - from < MAX_TOKEN_CHARS {
            i += 1;
        }
        let start = map[from];
        let last = map[i - 1];
        let mut end = last + line[last..].chars().next().map(char::len_utf8).unwrap_or(1);
        // The marks on the last letter belong to the word, as the find bar's
        // highlight takes them.
        for c in line[end..].chars() {
            if warraq_text::normalize::is_mark_or_control(c) {
                end += c.len_utf8();
            } else {
                break;
            }
        }
        out.push(Token {
            text: chars[from..i].iter().collect(),
            start,
            len: end.saturating_sub(start),
        });
    }
    out
}

/// The words of a query or a rule: the same normalization, no places.
pub fn terms(text: &str) -> Vec<String> {
    tokenize(text).into_iter().map(|t| t.text).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words_are_normalized_the_way_the_find_bar_searches() {
        assert_eq!(terms("الْفَاتُورَةُ رقم ١٢٣"), vec!["الفاتوره", "رقم", "123"]);
        assert_eq!(terms("إبراهيم أحمد مُوسَى"), vec!["ابراهيم", "احمد", "موسي"]);
        assert_eq!(terms("Invoice No. 42"), vec!["invoice", "no", "42"]);
    }

    #[test]
    fn a_token_points_back_at_the_original_bytes_marks_and_all() {
        let line = "قال: «مَرْحَباً» ثم غادر.";
        let tokens = tokenize(line);
        let marhaba = tokens.iter().find(|t| t.text == "مرحبا").expect("found");
        assert_eq!(&line[marhaba.start..marhaba.start + marhaba.len], "مَرْحَباً");
    }

    #[test]
    fn a_run_longer_than_the_cap_becomes_several_tokens() {
        let long = "ا".repeat(MAX_TOKEN_CHARS * 2 + 3);
        let tokens = tokenize(&long);
        assert_eq!(tokens.len(), 3);
        assert_eq!(tokens[0].text.chars().count(), MAX_TOKEN_CHARS);
        assert_eq!(tokens[2].text.chars().count(), 3);
        // and they still cover the line without overlapping
        assert_eq!(tokens[0].start, 0);
        assert_eq!(tokens[1].start, tokens[0].start + tokens[0].len);
    }

    #[test]
    fn nothing_but_punctuation_has_no_words() {
        assert!(tokenize("… — «» ،؛.").is_empty());
        assert!(tokenize("").is_empty());
    }
}
