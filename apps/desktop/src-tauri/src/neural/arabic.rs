//! Arabic with its diacritics (tashkeel) to IPA phonemes, by rule.
//!
//! Piper's Arabic voice learned espeak-ng's phonemes, but espeak-ng is GPL
//! and the app takes no GPL code. Fully diacritized Arabic spells its sounds
//! out, so a page of rules stands in for it: the same inventory espeak-ng
//! uses for Arabic — one symbol per character, length as "ː",
//! pharyngealization as "ˤ", primary stress as "ˈ". The rules were tried
//! against espeak-ng in the voice lab (`scripts/voice-lab/arabic_g2p.py`,
//! the same rules in Python) before they came here.

const FATHA: char = '\u{064E}';
const DAMMA: char = '\u{064F}';
const KASRA: char = '\u{0650}';
const FATHATAN: char = '\u{064B}';
const DAMMATAN: char = '\u{064C}';
const KASRATAN: char = '\u{064D}';
const SHADDA: char = '\u{0651}';
const SUKUN: char = '\u{0652}';
const SUPERSCRIPT_ALEF: char = '\u{0670}';
const TATWEEL: char = '\u{0640}';

/// Whether `c` is one of the marks this file reads.
pub fn is_mark(c: char) -> bool {
    matches!(
        c,
        FATHA | DAMMA | KASRA | FATHATAN | DAMMATAN | KASRATAN | SHADDA | SUKUN | SUPERSCRIPT_ALEF
    )
}

fn consonant(c: char) -> Option<&'static str> {
    Some(match c {
        'ء' | 'أ' | 'إ' | 'ؤ' | 'ئ' => "ʔ",
        'ب' => "b",
        'ت' | 'ة' => "t",
        'ث' => "θ",
        'ج' => "dʒ",
        'ح' => "ħ",
        'خ' => "χ",
        'د' => "d",
        'ذ' => "ð",
        'ر' => "r",
        'ز' => "z",
        'س' => "s",
        'ش' => "ʃ",
        'ص' => "sˤ",
        'ض' => "dˤ",
        'ط' => "tˤ",
        'ظ' => "ðˤ",
        'ع' => "ʕ",
        'غ' => "ɣ",
        'ف' => "f",
        'ق' => "q",
        'ك' => "k",
        'ل' => "l",
        'م' => "m",
        'ن' => "n",
        'ه' => "h",
        'و' => "w",
        'ي' | 'ى' => "j",
        'پ' => "p",
        'چ' => "tʃ",
        'ڤ' => "v",
        'گ' => "ɡ",
        _ => return None,
    })
}

fn short(mark: char) -> Option<&'static str> {
    Some(match mark {
        FATHA => "a",
        DAMMA => "u",
        KASRA => "i",
        _ => return None,
    })
}

fn tanween(mark: char) -> Option<&'static str> {
    Some(match mark {
        FATHATAN => "an",
        DAMMATAN => "un",
        KASRATAN => "in",
        _ => return None,
    })
}

fn is_sun(c: char) -> bool {
    "تثدذرزسشصضطظلن".contains(c)
}

fn punctuation(c: char) -> Option<char> {
    Some(match c {
        '،' | '؛' | ',' | ':' | ';' => ',',
        '.' => '.',
        '!' => '!',
        '؟' | '?' => '?',
        _ => return None,
    })
}

const ONES: [&str; 20] = [
    "",
    "واحد",
    "اثنان",
    "ثلاثة",
    "أربعة",
    "خمسة",
    "ستة",
    "سبعة",
    "ثمانية",
    "تسعة",
    "عشرة",
    "أحد عشر",
    "اثنا عشر",
    "ثلاثة عشر",
    "أربعة عشر",
    "خمسة عشر",
    "ستة عشر",
    "سبعة عشر",
    "ثمانية عشر",
    "تسعة عشر",
];
const TENS: [&str; 10] = [
    "",
    "",
    "عشرون",
    "ثلاثون",
    "أربعون",
    "خمسون",
    "ستون",
    "سبعون",
    "ثمانون",
    "تسعون",
];
const HUNDREDS: [&str; 10] = [
    "",
    "مئة",
    "مئتان",
    "ثلاثمئة",
    "أربعمئة",
    "خمسمئة",
    "ستمئة",
    "سبعمئة",
    "ثمانمئة",
    "تسعمئة",
];

/// A whole number in Arabic words (masculine, nominative), below a billion.
pub fn number_words(mut n: u64) -> String {
    if n == 0 {
        return "صفر".into();
    }
    let mut parts: Vec<String> = Vec::new();
    for (size, one, two, many) in [
        (1_000_000, "مليون", "مليونان", "ملايين"),
        (1000, "ألف", "ألفان", "آلاف"),
    ] {
        let count = n / size;
        n %= size;
        match count {
            0 => {}
            1 => parts.push(one.into()),
            2 => parts.push(two.into()),
            3..=10 => parts.push(format!("{} {many}", ONES[count as usize])),
            _ => parts.push(format!("{} {one}", number_words(count))),
        }
    }
    if n >= 100 {
        parts.push(HUNDREDS[(n / 100) as usize].into());
        n %= 100;
    }
    if n > 0 {
        if n < 20 {
            parts.push(ONES[n as usize].into());
        } else {
            let (ten, one) = ((n / 10) as usize, (n % 10) as usize);
            parts.push(if one > 0 {
                format!("{} و{}", ONES[one], TENS[ten])
            } else {
                TENS[ten].into()
            });
        }
    }
    parts.join(" و")
}

/// The text with its numbers (Western or Arabic-Indic digits) spelled out.
pub fn spell_numbers(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut digits = String::new();
    for c in text.chars().chain(std::iter::once(' ')) {
        let digit = match c {
            '0'..='9' => Some(c),
            '٠'..='٩' => char::from_digit(c as u32 - '٠' as u32, 10),
            _ => None,
        };
        if let Some(d) = digit {
            digits.push(d);
            continue;
        }
        if !digits.is_empty() {
            let value: u64 = digits[..digits.len().min(9)].parse().unwrap_or(0);
            out.push_str(&number_words(value));
            digits.clear();
        }
        out.push(c);
    }
    out.trim_end().to_string()
}

/// The word as base letters, each with the marks on it.
fn letters(word: &str) -> Vec<(char, Vec<char>)> {
    let mut out: Vec<(char, Vec<char>)> = Vec::new();
    for c in word.chars() {
        if c == TATWEEL {
            continue;
        }
        if is_mark(c) {
            if let Some(last) = out.last_mut() {
                last.1.push(c);
            }
            continue;
        }
        out.push((c, Vec::new()));
    }
    out
}

/// One word's phonemes; `after_vowel` when the word before it ends in one.
fn word_phonemes(word: &str, after_vowel: bool) -> Vec<&'static str> {
    let seq = letters(word);
    let mut out: Vec<&'static str> = Vec::new();
    let mut tanween_a = false;
    for (i, (c, marks)) in seq.iter().enumerate() {
        let c = *c;
        let next = seq.get(i + 1);
        let vowelled = marks
            .iter()
            .any(|m| short(*m).is_some() || tanween(*m).is_some());
        if c == 'ا' && !vowelled {
            let article = next.is_some_and(|(n, _)| *n == 'ل') && i + 2 < seq.len();
            // At the word's start, or after a one-letter prefix (wa-, fa-,
            // bi-, ka-): the alif of al- and of al-wasl verbs is no long a.
            let initial = i == 0 || (i == 1 && "وفبك".contains(seq[0].0));
            let wasl = article || i == 0 || next.is_some_and(|(_, m)| m.contains(&SUKUN));
            if initial && wasl {
                // Hamzat al-wasl: heard only at the start of speech.
                if out.is_empty() && !after_vowel {
                    out.push(if article { "a" } else { "i" });
                }
            } else if tanween_a {
                // The alif written after fathatan is silent.
            } else if out.last() == Some(&"a") {
                out.push("ː");
            } else {
                out.extend(["a", "ː"]);
            }
            continue;
        }
        tanween_a = false;
        if c == 'ى' && !vowelled {
            out.push(if out.last() == Some(&"a") { "ː" } else { "a" });
            continue;
        }
        // Taa marbuta without a vowel is the pause form: "-a", no t.
        if c == 'ة' && !vowelled {
            if out.last() != Some(&"a") {
                out.push("a");
            }
            continue;
        }
        if c == 'آ' {
            out.extend(["ʔ", "a", "ː"]);
            continue;
        }
        // The article's l, taken by the sun letter after it.
        if c == 'ل'
            && (marks.is_empty() || marks == &[SUKUN])
            && next.is_some_and(|(n, m)| is_sun(*n) && m.contains(&SHADDA))
        {
            continue;
        }
        if c == 'و' && marks.is_empty() && out.last() == Some(&"u") {
            out.push("ː");
            continue;
        }
        if c == 'ي' && marks.is_empty() && out.last() == Some(&"i") {
            out.push("ː");
            continue;
        }
        let Some(sound) = consonant(c) else { continue };
        out.push(sound);
        if marks.contains(&SHADDA) {
            out.push("ː");
        }
        for mark in marks {
            if let Some(v) = short(*mark) {
                out.push(v);
            } else if let Some(t) = tanween(*mark) {
                out.push(t);
                tanween_a = *mark == FATHATAN;
            } else if *mark == SUPERSCRIPT_ALEF {
                out.extend(["a", "ː"]);
            }
        }
    }
    out
}

/// The word's phonemes as single IPA symbols.
fn symbols(parts: &[&str]) -> Vec<char> {
    parts.iter().flat_map(|p| p.chars()).collect()
}

fn is_vowel(c: char) -> bool {
    matches!(c, 'a' | 'i' | 'u')
}

/// Puts "ˈ" before the stressed vowel, by the usual rule of Modern Standard
/// Arabic: the last syllable when superheavy, else the one before it when
/// heavy, else the one before that.
fn stress(phones: Vec<char>) -> Vec<char> {
    let nuclei: Vec<usize> = phones
        .iter()
        .enumerate()
        .filter(|(_, c)| is_vowel(**c))
        .map(|(k, _)| k)
        .collect();
    if nuclei.is_empty() {
        return phones;
    }
    let weight = |n: usize| -> usize {
        let k = nuclei[n];
        let end = nuclei.get(n + 1).copied().unwrap_or(phones.len());
        let long = phones.get(k + 1) == Some(&'ː');
        let consonants = phones[k + 1..end]
            .iter()
            .filter(|c| !is_vowel(**c) && **c != 'ː' && **c != 'ˤ')
            .count();
        let coda = consonants.saturating_sub(usize::from(n + 1 < nuclei.len()));
        usize::from(long) + 1 + coda
    };
    let last = nuclei.len() - 1;
    let pick = if weight(last) >= 3 {
        last
    } else if last >= 1 && weight(last - 1) >= 2 {
        last - 1
    } else if last >= 2 {
        last - 2
    } else {
        last.saturating_sub(1)
    };
    let mut out = phones;
    out.insert(nuclei[pick], 'ˈ');
    out
}

/// Diacritized Arabic text to IPA symbols, words joined by spaces, with the
/// punctuation that shapes the voice's pauses.
pub fn phonemize(text: &str) -> Vec<char> {
    let spelled = spell_numbers(text);
    let mut out: Vec<char> = Vec::new();
    let mut after_vowel = false;
    for raw in spelled.split_whitespace() {
        let mut word = raw;
        let mut trail = String::new();
        while let Some(last) = word.chars().last() {
            let Some(p) = punctuation(last) else { break };
            trail.insert(0, p);
            word = &word[..word.len() - last.len_utf8()];
        }
        let parts = word_phonemes(word, after_vowel);
        if !parts.is_empty() {
            if out.last().is_some_and(|c| *c != ' ') {
                out.push(' ');
            }
            let phones = symbols(&parts);
            after_vowel = trail.is_empty()
                && phones
                    .iter()
                    .rev()
                    .find(|c| **c != 'ː')
                    .is_some_and(|c| is_vowel(*c));
            out.extend(stress(phones));
        }
        if !trail.is_empty() {
            out.extend(trail.chars());
            after_vowel = false;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ipa(text: &str) -> String {
        phonemize(text).into_iter().collect()
    }

    #[test]
    fn reads_long_vowels_the_article_and_sun_letters() {
        assert_eq!(ipa("كِتَابٌ"), "kitˈaːbun");
        assert_eq!(ipa("فِي التَّقْرِيرِ"), "fˈiː tːaqrˈiːri");
        assert_eq!(ipa("الْكِتَابُ"), "alkitˈaːbu");
        assert_eq!(ipa("لِلشَّرِكَة"), "liʃːˈarika");
        assert_eq!(ipa("وَالَّذِي"), "wˈalːaðiː");
    }

    #[test]
    fn hamzat_al_wasl_is_heard_only_at_the_start() {
        assert_eq!(ipa("اسْتِخْدَامُ"), "istiχdˈaːmu");
        assert_eq!(ipa("وَاسْتَمَرَّ"), "wastˈamarːa");
        assert_eq!(ipa("مِنَ الْبَيْتِ"), "mˈina lbˈajti");
        assert_eq!(ipa("وَاسِعٌ"), "wˈaːsiʕun");
    }

    #[test]
    fn tanween_and_punctuation() {
        assert_eq!(ipa("جِدًّا، شُكْرًا."), "dʒˈidːan, ʃˈukran.");
        assert_eq!(ipa("هَلْ أَنْتَ هُنَا؟"), "hˈal ʔˈanta hˈunaː?");
        assert_eq!(ipa("فِي مَدِينَةِ جُدَّة."), "fˈiː madˈiːnati dʒˈudːa.");
    }

    #[test]
    fn numbers_are_spelled_out() {
        assert_eq!(number_words(15), "خمسة عشر");
        assert_eq!(number_words(3_000_000), "ثلاثة ملايين");
        assert_eq!(number_words(2026), "ألفان وستة وعشرون");
        assert_eq!(spell_numbers("عام ٢٠٢٦ م"), "عام ألفان وستة وعشرون م");
    }

    #[test]
    fn bad_input_gives_nothing_rather_than_failing() {
        assert!(phonemize("").is_empty());
        assert!(phonemize("\u{0651}\u{064E}").is_empty());
        assert_eq!(ipa("ABC"), "");
        let long = "بَ".repeat(10_000);
        assert!(!phonemize(&long).is_empty());
    }
}
