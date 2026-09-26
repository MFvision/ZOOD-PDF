//! XML/HTML text helpers shared by every writer.

use warraq_text::bidi::{detect_direction, Dir};

/// Characters XML 1.0 allows (others — C0 controls, lone surrogates never occur in `str`,
/// U+FFFE/U+FFFF — are dropped).
fn xml_char(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\r' | '\u{20}'..='\u{D7FF}' | '\u{E000}'..='\u{FFFD}' | '\u{10000}'..)
}

/// Escape text for element content and attribute values (both quotes escaped).
pub fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c if xml_char(c) => out.push(c),
            _ => {}
        }
    }
    out
}

/// True when the text contains any right-to-left strong character.
pub fn has_rtl(s: &str) -> bool {
    s.chars()
        .any(|c| warraq_text::bidi::strong_dir(c) == Some(Dir::Rtl))
}

/// Paragraph direction of a text (majority of strong characters).
pub fn dir_of(s: &str) -> Dir {
    detect_direction([s])
}

/// BCP 47 language guessed from the script of a text: `ur`/`fa` from their distinctive letters,
/// `ar` for other Arabic script, `he` for Hebrew, `en` for Latin, `None` otherwise.
pub fn guess_lang(s: &str) -> Option<&'static str> {
    let (mut arabic, mut latin, mut hebrew) = (0usize, 0usize, 0usize);
    let (mut urdu, mut persian) = (0usize, 0usize);
    for c in s.chars() {
        match c {
            // ے ڈ ٹ ڑ ں ھ ہ: Urdu-specific
            '\u{06D2}' | '\u{0688}' | '\u{0679}' | '\u{0691}' | '\u{06BA}' | '\u{06BE}'
            | '\u{06C1}' => {
                urdu += 1;
                arabic += 1;
            }
            // پ چ ژ گ ی ک and Persian digits
            '\u{067E}'
            | '\u{0686}'
            | '\u{0698}'
            | '\u{06AF}'
            | '\u{06CC}'
            | '\u{06A9}'
            | '\u{06F0}'..='\u{06F9}' => {
                persian += 1;
                arabic += 1;
            }
            '\u{0600}'..='\u{06FF}'
            | '\u{0750}'..='\u{077F}'
            | '\u{FB50}'..='\u{FDFF}'
            | '\u{FE70}'..='\u{FEFF}' => arabic += 1,
            '\u{0590}'..='\u{05FF}' => hebrew += 1,
            'A'..='Z' | 'a'..='z' | '\u{00C0}'..='\u{024F}' => latin += 1,
            _ => {}
        }
    }
    if arabic == 0 && latin == 0 && hebrew == 0 {
        return None;
    }
    if hebrew > arabic && hebrew > latin {
        return Some("he");
    }
    if arabic >= latin {
        if urdu > 0 && urdu >= persian {
            return Some("ur");
        }
        if persian > 0 {
            return Some("fa");
        }
        return Some("ar");
    }
    Some("en")
}

/// Split text into runs of one direction: a run changes at a strong character of the other
/// direction; neutrals (spaces, digits, punctuation) stay with the run they follow (leading
/// neutrals join the first strong run). Returns `(text, rtl)` pairs covering the whole text.
pub fn dir_runs(s: &str) -> Vec<(String, bool)> {
    dir_runs_in(s, dir_of(s) == Dir::Rtl)
}

/// [`dir_runs`] for a paragraph of known direction: spaces and punctuation between two runs of
/// different directions go to the run that has the paragraph's direction (as the bidi algorithm
/// resolves them).
pub fn dir_runs_in(s: &str, para_rtl: bool) -> Vec<(String, bool)> {
    let mut out = split_runs(s);
    for i in 1..out.len() {
        let (Some((prev, prev_rtl)), Some((_, next_rtl))) = (out.get(i - 1), out.get(i)) else {
            continue;
        };
        if *prev_rtl == para_rtl || *next_rtl != para_rtl {
            continue;
        }
        let keep = prev.trim_end_matches(|c: char| !c.is_alphanumeric()).len();
        let moved = prev.get(keep..).unwrap_or("").to_string();
        if moved.is_empty() || keep == 0 {
            continue;
        }
        if let Some((p, _)) = out.get_mut(i - 1) {
            p.truncate(keep);
        }
        if let Some((n, _)) = out.get_mut(i) {
            n.insert_str(0, &moved);
        }
    }
    out
}

fn split_runs(s: &str) -> Vec<(String, bool)> {
    let mut out: Vec<(String, bool)> = Vec::new();
    let mut lead = String::new();
    for c in s.chars() {
        match warraq_text::bidi::strong_dir(c) {
            Some(d) => {
                let rtl = d == Dir::Rtl;
                match out.last_mut() {
                    Some((t, r)) if *r == rtl => t.push(c),
                    _ => {
                        let mut t = std::mem::take(&mut lead);
                        t.push(c);
                        out.push((t, rtl));
                    }
                }
            }
            None => match out.last_mut() {
                Some((t, _)) => t.push(c),
                None => lead.push(c),
            },
        }
    }
    if !lead.is_empty() {
        // No strong character at all: digits/punctuation only.
        out.push((
            lead,
            s.chars()
                .any(|c| matches!(c, '\u{0660}'..='\u{0669}' | '\u{06F0}'..='\u{06F9}')),
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_and_drops_invalid_chars() {
        assert_eq!(esc("a<b>&\"'\u{1}c"), "a&lt;b&gt;&amp;&quot;&#39;c");
        assert_eq!(esc("مرحبا"), "مرحبا");
    }

    #[test]
    fn direction_runs() {
        let r = dir_runs_in("مرحبا Hello World ٣ عالم", true);
        assert_eq!(
            r,
            vec![
                ("مرحبا ".to_string(), true),
                ("Hello World ٣".to_string(), false),
                (" عالم".to_string(), true)
            ]
        );
        assert_eq!(dir_runs("12 34"), vec![("12 34".to_string(), false)]);
        // Neutrals between a Latin and an Arabic run resolve to the paragraph direction.
        assert_eq!(
            dir_runs_in("معيار PDF/UA، و", true),
            vec![
                ("معيار ".to_string(), true),
                ("PDF/UA".to_string(), false),
                ("، و".to_string(), true)
            ]
        );
        assert!(dir_runs("").is_empty());
    }

    #[test]
    fn languages_from_script() {
        assert_eq!(guess_lang("مرحبا بالعالم"), Some("ar"));
        assert_eq!(guess_lang("یہ اردو ہے"), Some("ur"));
        assert_eq!(guess_lang("این فارسی است"), Some("fa"));
        assert_eq!(guess_lang("Hello"), Some("en"));
        assert_eq!(guess_lang("123"), None);
    }
}
