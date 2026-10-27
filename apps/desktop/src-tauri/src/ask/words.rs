//! What was heard, tidied the way dictation apps do it (after Handy,
//! https://github.com/cjpais/Handy, MIT — its custom-word matching and
//! filler removal, rebuilt here for Arabic as well as English):
//!
//! - "um", "uh", "اممم" and the like are left out, and a word said three
//!   times over in a stumble is said once;
//! - the person's own words — names, products, places the model does not
//!   know, kept in Ask ZOOD's settings — replace what was heard when it
//!   sounds close enough: "Hostinger" for "host injure", "الغماس" for
//!   "الغماز". Close means few letters apart for the length of the word,
//!   with English words that also sound alike (Soundex) counted closer.
//!
//! The same words go to the model before it listens, as the context its
//! makers built it to take (`ask_transcribe`); this catches what still
//! slips through.

/// How far apart a heard word may be from one of the person's, as a share
/// of the longer one's letters, and still be taken for it.
pub const THRESHOLD: f64 = 0.3;
/// The most words of the person's own the model is told before it listens.
pub const MAX_CONTEXT_WORDS: usize = 200;

/// Sounds that are never words, in any language the model hears.
const FILLERS: &[&str] = &[
    "uh", "uhh", "uhm", "um", "umm", "uhmm", "hmm", "hm", "mmm", "ehm", "ahm", "erm",
    // Not "أم" (mother) or "آه": only sounds no word is spelled with.
    "امم", "اممم", "ااا", "اااا", "اا", "ممم", "مممم",
];

/// The letters a word is compared by: lower case, no marks or tatweel,
/// Arabic's alef, yeh and teh marbuta forms made one, digits and letters only.
pub fn key(word: &str) -> String {
    word.chars()
        .filter_map(|c| match c {
            'أ' | 'إ' | 'آ' | 'ٱ' => Some('ا'),
            'ى' | 'ئ' => Some('ي'),
            'ة' => Some('ه'),
            'ؤ' => Some('و'),
            '\u{0640}' | '\u{064B}'..='\u{065F}' | '\u{0670}' => None,
            c if c.is_alphanumeric() => Some(c),
            _ => None,
        })
        .flat_map(char::to_lowercase)
        .collect()
}

fn levenshtein(a: &[char], b: &[char]) -> usize {
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut diagonal = row[0];
        row[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let above = row[j + 1];
            row[j + 1] = (above + 1)
                .min(row[j] + 1)
                .min(diagonal + usize::from(ca != cb));
            diagonal = above;
        }
    }
    row[b.len()]
}

/// American Soundex, for English words only.
fn soundex(word: &str) -> Option<String> {
    let mut letters = word
        .chars()
        .filter(char::is_ascii_alphabetic)
        .map(|c| c.to_ascii_uppercase());
    let first = letters.next()?;
    let code = |c: char| match c {
        'B' | 'F' | 'P' | 'V' => '1',
        'C' | 'G' | 'J' | 'K' | 'Q' | 'S' | 'X' | 'Z' => '2',
        'D' | 'T' => '3',
        'L' => '4',
        'M' | 'N' => '5',
        'R' => '6',
        'H' | 'W' => 'h',
        _ => '0',
    };
    let mut out = String::from(first);
    let mut last = code(first);
    for c in letters {
        let digit = code(c);
        if digit == 'h' {
            continue;
        }
        if digit != '0' && digit != last {
            out.push(digit);
            if out.len() == 4 {
                break;
            }
        }
        last = digit;
    }
    while out.len() < 4 {
        out.push('0');
    }
    Some(out)
}

/// How far `heard` is from `wanted` (both keys), 0 the same: the letters
/// that differ for the longer one's length, a third of it when English
/// words also sound alike. None when their lengths are too far apart to be
/// the same word.
fn distance(heard: &str, wanted: &str) -> Option<f64> {
    let (a, b): (Vec<char>, Vec<char>) = (heard.chars().collect(), wanted.chars().collect());
    let longest = a.len().max(b.len());
    if longest == 0 || a.len().abs_diff(b.len()) as f64 > (longest as f64 * 0.25).max(2.0) {
        return None;
    }
    let edits = levenshtein(&a, &b);
    // A short word one letter off is often another word ("good", "ZOOD"):
    // it must also sound alike.
    let score = if longest <= 5 && edits > 0 {
        (edits as f64 / longest as f64).max(THRESHOLD)
    } else {
        edits as f64 / longest as f64
    };
    let english = |k: &str| k.chars().all(|c| c.is_ascii_alphabetic());
    if english(heard)
        && english(wanted)
        && soundex(heard).is_some()
        && soundex(heard) == soundex(wanted)
    {
        Some(score * 0.3)
    } else {
        Some(score)
    }
}

/// `word` split into what leads it (quotes), its letters, and what follows (punctuation).
fn split_punctuation(word: &str) -> (&str, &str, &str) {
    let start = word
        .find(|c: char| c.is_alphanumeric())
        .unwrap_or(word.len());
    let end = word
        .char_indices()
        .rev()
        .find(|(_, c)| c.is_alphanumeric())
        .map_or(start, |(i, c)| i + c.len_utf8());
    (
        &word[..start],
        &word[start..end.max(start)],
        &word[end.max(start)..],
    )
}

/// `text` with the person's `words` in place of what sounds like them:
/// one to three heard words at a time ("Charge B" is "ChargeBee"), the
/// closest match winning, never across a comma or a full stop.
pub fn apply_custom_words(text: &str, words: &[String]) -> String {
    let wanted: Vec<(String, &String)> = words
        .iter()
        .filter(|w| !w.trim().is_empty())
        .map(|w| (key(w), w))
        .filter(|(k, _)| k.chars().count() >= 3)
        .collect();
    if wanted.is_empty() {
        return text.to_string();
    }
    let heard: Vec<&str> = text.split_whitespace().collect();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i < heard.len() {
        let mut best: Option<(usize, &String, f64)> = None;
        for n in (1..=3).rev() {
            if i + n > heard.len() {
                continue;
            }
            let span = &heard[i..i + n];
            if span[..n - 1]
                .iter()
                .any(|w| !split_punctuation(w).2.is_empty())
            {
                continue;
            }
            let candidate: String = span.iter().map(|w| key(w)).collect();
            if candidate.chars().count() < 3 || candidate.chars().count() > 50 {
                continue;
            }
            // The same words without the first one: if they are as close,
            // the first word is the person's own ("to" in "to Hostinjer").
            let without_first: String = span[1..].iter().map(|w| key(w)).collect();
            for (k, word) in &wanted {
                if let Some(score) = distance(&candidate, k) {
                    let shorter = (n > 1)
                        .then(|| distance(&without_first, k))
                        .flatten()
                        .is_some_and(|s| s <= score);
                    if score < THRESHOLD && !shorter && best.is_none_or(|(_, _, b)| score < b) {
                        best = Some((n, word, score));
                    }
                }
            }
        }
        match best {
            Some((n, word, _)) => {
                let (lead, _, _) = split_punctuation(heard[i]);
                let (_, _, trail) = split_punctuation(heard[i + n - 1]);
                out.push(format!("{lead}{word}{trail}"));
                i += n;
            }
            None => {
                out.push(heard[i].to_string());
                i += 1;
            }
        }
    }
    out.join(" ")
}

/// `text` without the sounds that are not words, and a word stumbled over
/// three times or more said once.
pub fn tidy(text: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    for word in text.split_whitespace() {
        let (_, letters, trail) = split_punctuation(word);
        let k = key(letters);
        if FILLERS.contains(&k.as_str()) || FILLERS.contains(&letters.to_lowercase().as_str()) {
            // Its punctuation stays with the word before it.
            if let Some(last) = out.last_mut() {
                if !trail.is_empty() && !last.ends_with(|c: char| !c.is_alphanumeric()) {
                    last.push_str(trail.trim_start_matches(','));
                }
            }
            continue;
        }
        out.push(word.to_string());
    }
    // A stumble: the same word three or more times in a row.
    let mut kept: Vec<String> = Vec::new();
    let mut i = 0;
    while i < out.len() {
        let k = key(&out[i]);
        let mut run = 1;
        while !k.is_empty() && i + run < out.len() && key(&out[i + run]) == k {
            run += 1;
        }
        if run >= 3 {
            kept.push(out[i + run - 1].clone());
            i += run;
        } else {
            kept.push(out[i].clone());
            i += 1;
        }
    }
    kept.join(" ")
}

/// The person's words as context for the model: one a line, the most the
/// model is told, none empty or overlong.
pub fn context(words: &[String]) -> String {
    words
        .iter()
        .map(|w| w.trim())
        .filter(|w| !w.is_empty() && w.chars().count() <= 60)
        .take(MAX_CONTEXT_WORDS)
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(list: &[&str]) -> Vec<String> {
        list.iter().map(|w| w.to_string()).collect()
    }

    #[test]
    fn names_the_model_misheard_are_put_right() {
        let mine = words(&["Hostinger", "ZOOD", "Alghammas", "ChargeBee", "الغماس"]);
        assert_eq!(
            apply_custom_words("upload it to Hostinjer please", &mine),
            "upload it to Hostinger please"
        );
        assert_eq!(
            apply_custom_words("send it to Mohammed Algamas.", &mine),
            "send it to Mohammed Alghammas."
        );
        assert_eq!(
            apply_custom_words("pay Charge B today", &mine),
            "pay ChargeBee today"
        );
        assert_eq!(
            apply_custom_words("أرسلها إلى محمد الغماز", &mine),
            "أرسلها إلى محمد الغماس"
        );
        // A short word one letter off is not taken for a name unless it sounds like it.
        assert_eq!(apply_custom_words("that is good", &mine), "that is good");
        assert_eq!(apply_custom_words("open Zood now", &mine), "open ZOOD now");
        // Ordinary words stay as they were.
        assert_eq!(
            apply_custom_words("open the contract and merge it", &mine),
            "open the contract and merge it"
        );
        assert_eq!(apply_custom_words("افتح العقد", &mine), "افتح العقد");
        // Not across a full stop.
        assert_eq!(
            apply_custom_words("Charge. B today", &mine),
            "Charge. B today"
        );
        assert_eq!(apply_custom_words("anything", &[]), "anything");
    }

    #[test]
    fn fillers_go_and_stumbles_are_said_once() {
        assert_eq!(tidy("um open the uh file"), "open the file");
        assert_eq!(
            tidy("Hmm, merge these, umm, two files"),
            "merge these, two files"
        );
        assert_eq!(tidy("اممم افتح الملف"), "افتح الملف");
        assert_eq!(tidy("the the the contract"), "the contract");
        // Said twice is often meant.
        assert_eq!(tidy("very very good"), "very very good");
        // Words that only look like fillers stay.
        assert_eq!(tidy("ham and umbrella"), "ham and umbrella");
    }

    #[test]
    fn keys_ignore_case_marks_and_alef_forms() {
        assert_eq!(key("Hostinger,"), "hostinger");
        assert_eq!(key("أَحْمَد"), "احمد");
        assert_eq!(key("مدرسة"), key("مدرسه"));
        assert_eq!(soundex("Robert"), Some("R163".into()));
        assert_eq!(soundex("Rupert"), Some("R163".into()));
        assert_eq!(soundex("Ashcraft"), Some("A261".into()));
    }

    #[test]
    fn context_is_one_word_a_line_and_bounded() {
        assert_eq!(
            context(&words(&[" ZOOD ", "", "Hostinger"])),
            "ZOOD\nHostinger"
        );
        let many: Vec<String> = (0..500).map(|i| format!("w{i}")).collect();
        assert_eq!(context(&many).lines().count(), MAX_CONTEXT_WORDS);
    }
}
