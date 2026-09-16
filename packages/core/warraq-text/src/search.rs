//! Arabic-aware search over reconstructed lines.
use crate::normalize::{normalize_for_search, SearchNormalization};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Match {
    pub line: usize,
    /// Byte range in the ORIGINAL line text (for highlighting).
    pub start: usize,
    pub end: usize,
}

/// Find all occurrences of `query` in `lines` under the given normalization.
pub fn find_in_lines(lines: &[String], query: &str, opts: &SearchNormalization) -> Vec<Match> {
    let (q, _) = normalize_for_search(query, opts);
    if q.is_empty() {
        return vec![];
    }
    let mut out = vec![];
    for (li, line) in lines.iter().enumerate() {
        let (n, map) = normalize_for_search(line, opts);
        let mut from = 0;
        while let Some(pos) = n[from..].find(&q) {
            let start_n = from + pos;
            let end_n = start_n + q.len();
            let nchars_before = n[..start_n].chars().count();
            let nchars_len = q.chars().count();
            let start = map[nchars_before];
            let last = map[nchars_before + nchars_len - 1];
            let mut end = last + line[last..].chars().next().map(char::len_utf8).unwrap_or(1);
            // a highlight covers the marks attached to the last matched letter
            for c in line[end..].chars() {
                if crate::normalize::is_mark_or_control(c) {
                    end += c.len_utf8();
                } else {
                    break;
                }
            }
            out.push(Match {
                line: li,
                start,
                end,
            });
            from = end_n;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_words_regardless_of_tashkeel_alef_and_taa_marbuta() {
        let lines = vec![
            "الْعِلْمُ نُورٌ".to_string(),
            "شركة زود للتقنية".to_string(),
            "أحمد".to_string(),
        ];
        let opts = SearchNormalization::default();
        assert_eq!(
            find_in_lines(&lines, "العلم", &opts),
            vec![Match {
                line: 0,
                start: 0,
                end: "الْعِلْمُ".len()
            }]
        );
        assert_eq!(find_in_lines(&lines, "شركه", &opts).len(), 1);
        assert_eq!(
            find_in_lines(&lines, "احمد", &opts),
            vec![Match {
                line: 2,
                start: 0,
                end: "أحمد".len()
            }]
        );
        assert!(find_in_lines(&lines, "كتاب", &opts).is_empty());
    }

    #[test]
    fn highlight_range_maps_back_to_original_bytes() {
        let lines = vec!["قال: «مرحباً» ثم غادر.".to_string()];
        let m = &find_in_lines(&lines, "مرحبا", &SearchNormalization::default())[0];
        assert_eq!(&lines[0][m.start..m.end], "مرحباً");
    }
}
