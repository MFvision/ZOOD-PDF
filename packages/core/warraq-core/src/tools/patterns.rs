//! Ready-made patterns for search-and-redact: what a person usually has to
//! remove from a document before it leaves their hands — email addresses,
//! phone numbers, Saudi national ID and Iqama numbers, IBANs, card numbers
//! and dates — and a person's own pattern.
//!
//! Every pattern runs on Rust's `regex`, which matches in time linear in the
//! text (no backtracking, so no pattern and no page can make it run away),
//! and a person's own is compiled within size limits. Digits are matched in
//! any script: Arabic-Indic (٠١٢) and Eastern Arabic-Indic (۰۱۲) digits are
//! read as the digits they are, so "٠٥٠١٢٣٤٥٦٧" is a phone number too.
use regex::{Regex, RegexBuilder};

use crate::CoreError;

/// A person's own pattern: the most characters it may have, and what its
/// compiled program and lazy DFA may take.
pub const MAX_PATTERN: usize = 1_000;
const COMPILED_LIMIT: usize = 1 << 20;
const DFA_LIMIT: usize = 2 << 20;

/// A kind of thing to find.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Email,
    Phone,
    NationalId,
    Iban,
    Card,
    Date,
}

impl Kind {
    pub const ALL: [Kind; 6] = [
        Kind::Email,
        Kind::Phone,
        Kind::NationalId,
        Kind::Iban,
        Kind::Card,
        Kind::Date,
    ];

    pub fn key(self) -> &'static str {
        match self {
            Kind::Email => "email",
            Kind::Phone => "phone",
            Kind::NationalId => "nationalId",
            Kind::Iban => "iban",
            Kind::Card => "card",
            Kind::Date => "date",
        }
    }

    pub fn from_key(key: &str) -> Option<Kind> {
        Kind::ALL.into_iter().find(|k| k.key() == key)
    }

    fn source(self) -> &'static str {
        match self {
            Kind::Email => r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}",
            // Saudi mobiles (05x), landlines (01x–07x), 800 and 9200
            // numbers, with or without +966 / 00966; and any number written
            // with an international prefix. Spaces, dashes and dots may
            // group the digits; the count is checked after the match.
            Kind::Phone => concat!(
                r"(?:(?:\+|00)966[\s\-.]?|0)5\d(?:[\s\-.]?\d){7}",
                r"|(?:(?:\+|00)966[\s\-.]?|0)1[1-7](?:[\s\-.]?\d){7}",
                r"|(?:(?:\+|00)966[\s\-.]?|0)[2-7]\d(?:[\s\-.]?\d){6}",
                r"|800[\s\-.]?\d{3}[\s\-.]?\d{4}",
                r"|9200[\s\-.]?\d{5}",
                r"|(?:\+|00)[1-9]\d{0,2}(?:[\s\-.]?\(?\d{1,5}\)?){2,6}",
            ),
            // Ten digits, the first 1 (a citizen) or 2 (a resident).
            Kind::NationalId => r"[12]\d{9}",
            Kind::Iban => r"[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}",
            Kind::Card => r"\d(?:[ \-]?\d){12,18}",
            Kind::Date => concat!(
                r"\d{1,2}[/.\-]\d{1,2}[/.\-](?:\d{4}|\d{2})",
                r"|\d{4}[/.\-]\d{1,2}[/.\-]\d{1,2}",
                r"|(?i:\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?,?\s+\d{4})",
                r"|(?i:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})",
                r"|\d{1,2}\s+(?:يناير|فبراير|مارس|أبريل|إبريل|ابريل|مايو|يونيو|يوليو|أغسطس|اغسطس|سبتمبر|أكتوبر|اكتوبر|نوفمبر|ديسمبر",
                r"|كانون الثاني|شباط|آذار|نيسان|أيار|حزيران|تموز|آب|أيلول|تشرين الأول|تشرين الثاني|كانون الأول",
                r"|محرم|صفر|ربيع الأول|ربيع الآخر|ربيع الثاني|جمادى الأولى|جمادى الآخرة|جمادى الثانية|رجب|شعبان|رمضان|شوال|ذو القعدة|ذو الحجة)",
                r"\s+\d{4}(?:\s*(?:هـ|م)\b)?",
            ),
        }
    }

    /// Whether a match is really one: a check digit that holds, a count of
    /// digits that fits, a date that exists.
    fn accepts(self, text: &str) -> bool {
        let digits: Vec<u32> = text.chars().filter_map(|c| c.to_digit(10)).collect();
        match self {
            Kind::Phone => (9..=15).contains(&digits.len()),
            Kind::Card => (13..=19).contains(&digits.len()) && luhn(&digits),
            Kind::Iban => iban_valid(text),
            Kind::Date => plausible_date(text),
            _ => true,
        }
    }
}

/// The Luhn check digit (ISO/IEC 7812) holds.
pub fn luhn(digits: &[u32]) -> bool {
    let sum: u32 = digits
        .iter()
        .rev()
        .enumerate()
        .map(|(i, &d)| {
            if i % 2 == 1 {
                let d = d * 2;
                if d > 9 {
                    d - 9
                } else {
                    d
                }
            } else {
                d
            }
        })
        .sum();
    !digits.is_empty() && sum.is_multiple_of(10)
}

/// ISO 13616: the IBAN, rearranged and read as a number, is 1 modulo 97.
pub fn iban_valid(text: &str) -> bool {
    let compact: Vec<char> = text.chars().filter(|c| !c.is_whitespace()).collect();
    if !(15..=34).contains(&compact.len()) {
        return false;
    }
    let mut rest = 0u32;
    for c in compact[4..].iter().chain(&compact[..4]) {
        let value = match c.to_digit(36) {
            Some(v) => v,
            None => return false,
        };
        rest = if value < 10 {
            (rest * 10 + value) % 97
        } else {
            (rest * 100 + value) % 97
        };
    }
    rest == 1
}

/// A numeric date whose day and month can exist, in either order.
fn plausible_date(text: &str) -> bool {
    let parts: Vec<u32> = text
        .split(|c: char| !c.is_ascii_digit())
        .filter(|p| !p.is_empty())
        .filter_map(|p| p.parse().ok())
        .collect();
    let numeric = text
        .chars()
        .all(|c| c.is_ascii_digit() || matches!(c, '/' | '.' | '-'));
    if !numeric || parts.len() != 3 {
        return true;
    }
    let (a, b) = if parts[0] > 31 {
        (parts[1], parts[2])
    } else {
        (parts[0], parts[1])
    };
    let day_month = |d: u32, m: u32| (1..=31).contains(&d) && (1..=12).contains(&m);
    day_month(a, b) || day_month(b, a)
}

/// `text` with every digit written as an ASCII one, char for char.
pub fn fold_digits(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            '٠'..='٩' => char::from_u32('0' as u32 + (c as u32 - '٠' as u32)).unwrap_or(c),
            '۰'..='۹' => char::from_u32('0' as u32 + (c as u32 - '۰' as u32)).unwrap_or(c),
            other => other,
        })
        .collect()
}

/// Something to look for: a ready-made kind, or a person's own pattern.
pub struct Finder {
    pub kind: Option<Kind>,
    regex: Regex,
}

impl Finder {
    pub fn ready_made(kind: Kind) -> Self {
        // A ready-made pattern is written here and tested; it compiles.
        let regex = RegexBuilder::new(kind.source())
            .size_limit(COMPILED_LIMIT * 8)
            .build()
            .unwrap_or_else(|_| Regex::new("$^").expect("the empty pattern compiles"));
        Self {
            kind: Some(kind),
            regex,
        }
    }

    /// A person's own pattern, compiled within limits; `E_ARGS` if it is too
    /// long, too large, or not a pattern.
    pub fn custom(pattern: &str) -> Result<Self, CoreError> {
        if pattern.trim().is_empty() {
            return Err(CoreError::Args("the pattern is empty".into()));
        }
        if pattern.chars().count() > MAX_PATTERN {
            return Err(CoreError::Args(format!(
                "a pattern may have at most {MAX_PATTERN} characters"
            )));
        }
        let regex = RegexBuilder::new(pattern)
            .size_limit(COMPILED_LIMIT)
            .dfa_size_limit(DFA_LIMIT)
            .nest_limit(64)
            .build()
            .map_err(|e| CoreError::Args(format!("not a usable pattern: {e}")))?;
        Ok(Self { kind: None, regex })
    }

    /// Every match in `line`, as char ranges of `line`. A ready-made kind is
    /// matched with digits folded and must not touch a letter or digit on
    /// either side (so a longer number never yields a shorter one).
    pub fn find(&self, line: &str) -> Vec<(usize, usize)> {
        let text = match self.kind {
            Some(_) => fold_digits(line),
            None => line.to_string(),
        };
        // Byte offset → char index, for `text` (same chars as `line`).
        let mut char_at = vec![0usize; text.len() + 1];
        let mut n = 0;
        for (i, c) in text.char_indices() {
            for slot in &mut char_at[i..i + c.len_utf8()] {
                *slot = n;
            }
            n += 1;
        }
        char_at[text.len()] = n;
        let chars: Vec<char> = text.chars().collect();
        // Char index → byte offset, to search on from a char.
        let byte_at: Vec<usize> = text
            .char_indices()
            .map(|(i, _)| i)
            .chain(std::iter::once(text.len()))
            .collect();
        // A match must not run on from, or into, a Latin letter or a digit:
        // a longer number never yields a shorter one. Arabic letters may
        // touch it — "و2026" is "and 2026".
        let glued = |c: Option<&char>| c.is_some_and(|c| c.is_ascii_alphanumeric());
        let mut out = vec![];
        let mut from = 0usize;
        // Each round starts past where the last one did: at most one round
        // per char of the line.
        while from <= text.len() {
            let Some(m) = self.regex.find_at(&text, from) else {
                break;
            };
            let (start, end) = (char_at[m.start()], char_at[m.end()]);
            let Some(kind) = self.kind else {
                // A person's own pattern: each match as it is; an empty one
                // is passed over.
                if start < end {
                    out.push((start, end));
                    from = m.end();
                } else if end < chars.len() {
                    from = byte_at[end + 1];
                } else {
                    break;
                }
                continue;
            };
            // Greedy grouping can take a group too many, at the end ("… 7519
            // 12") or at the start (a row number, a date before a card): an
            // account, card or phone number is tried from each group the
            // match holds, each shorter until it checks out, and the longest
            // that does is the number.
            let trimmed = matches!(kind, Kind::Iban | Kind::Card | Kind::Phone);
            let starts = std::iter::once(start)
                .chain((start + 1..end).filter(|&i| {
                    trimmed && chars[i].is_alphanumeric() && !glued(chars.get(i - 1))
                }));
            let mut found: Option<(usize, usize)> = None;
            for s in starts {
                let before = s.checked_sub(1).and_then(|i| chars.get(i));
                if s >= end || (glued(before) && kind != Kind::Email) {
                    continue;
                }
                // The pattern's own match from here.
                let Some(from_here) = self.regex.find_at(&text, byte_at[s]) else {
                    continue;
                };
                if char_at[from_here.start()] != s {
                    continue;
                }
                let last = char_at[from_here.end()];
                let shortest = if trimmed { s + 1 } else { last };
                let longest = (shortest..=last).rev().find(|&e| {
                    let candidate: String = chars[s..e].iter().collect();
                    !glued(chars.get(e))
                        && self
                            .regex
                            .find(&candidate)
                            .is_some_and(|w| w.start() == 0 && w.end() == candidate.len())
                        && kind.accepts(&candidate)
                });
                if let Some(e) = longest {
                    if found.is_none_or(|(fs, fe)| e - s > fe - fs) {
                        found = Some((s, e));
                    }
                }
            }
            match found {
                // On from its end: what a greedy match took past it is read again.
                Some((s, e)) => {
                    out.push((s, e));
                    from = byte_at[e];
                }
                // Not one from here: a number may start at the next group
                // inside it ("1 4111 1111 1111 1111", "REF12 SA03 …").
                None => {
                    let next = (start + 1..chars.len())
                        .find(|&i| chars[i].is_alphanumeric() && !glued(chars.get(i - 1)));
                    match next {
                        Some(i) => from = byte_at[i],
                        None => break,
                    }
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn found(kind: Kind, line: &str) -> Vec<String> {
        let chars: Vec<char> = line.chars().collect();
        Finder::ready_made(kind)
            .find(line)
            .into_iter()
            .map(|(s, e)| chars[s..e].iter().collect())
            .collect()
    }

    #[test]
    fn every_ready_made_pattern_compiles() {
        for kind in Kind::ALL {
            assert!(RegexBuilder::new(kind.source()).build().is_ok(), "{kind:?}");
        }
    }

    #[test]
    fn emails_are_found_in_arabic_and_english_lines() {
        assert_eq!(
            found(
                Kind::Email,
                "راسلنا على info@warraq.sa أو sales.team+ksa@mail.example.com."
            ),
            ["info@warraq.sa", "sales.team+ksa@mail.example.com"]
        );
        assert!(found(Kind::Email, "not an @ address").is_empty());
    }

    #[test]
    fn saudi_and_international_phone_numbers_in_either_digits() {
        assert_eq!(
            found(Kind::Phone, "جوال: 0501234567 وهاتف +966 11 234 5678"),
            ["0501234567", "+966 11 234 5678"]
        );
        assert_eq!(found(Kind::Phone, "الجوال ٠٥٠١٢٣٤٥٦٧"), ["٠٥٠١٢٣٤٥٦٧"]);
        assert_eq!(
            found(Kind::Phone, "Call +44 20 7946 0958 now"),
            ["+44 20 7946 0958"]
        );
        assert_eq!(
            found(Kind::Phone, "00966-50-123-4567"),
            ["00966-50-123-4567"]
        );
        assert_eq!(
            found(Kind::Phone, "800 123 4567 / 920012345"),
            ["800 123 4567", "920012345"]
        );
        assert!(found(Kind::Phone, "Invoice 2026-0042, total 1,200.00").is_empty());
    }

    #[test]
    fn national_id_and_iqama_are_ten_digits_starting_one_or_two() {
        assert_eq!(
            found(Kind::NationalId, "الهوية 1012345678 والإقامة ٢٣٤٥٦٧٨٩٠١"),
            ["1012345678", "٢٣٤٥٦٧٨٩٠١"]
        );
        assert!(found(Kind::NationalId, "10123456789 3012345678").is_empty());
    }

    #[test]
    fn ibans_are_checked_modulo_97() {
        assert_eq!(
            found(
                Kind::Iban,
                "IBAN: SA03 8000 0000 6080 1016 7519, GB82 WEST 1234 5698 7654 32"
            ),
            [
                "SA03 8000 0000 6080 1016 7519",
                "GB82 WEST 1234 5698 7654 32"
            ]
        );
        assert!(
            found(Kind::Iban, "SA04 8000 0000 6080 1016 7519").is_empty(),
            "a wrong check"
        );
    }

    #[test]
    fn card_numbers_must_pass_luhn() {
        assert_eq!(
            found(
                Kind::Card,
                "Visa 4111 1111 1111 1111 and 5500-0000-0000-0004"
            ),
            ["4111 1111 1111 1111", "5500-0000-0000-0004"]
        );
        assert!(found(Kind::Card, "4111 1111 1111 1112").is_empty());
    }

    /// A number with another group of digits before it — a table's row
    /// number, an expiry date, a year — is found all the same, and one
    /// straight after another is found too: a greedy match that takes the
    /// group before, or the next number's first group, is not the end.
    #[test]
    fn a_number_after_another_group_of_digits_is_found() {
        for line in [
            "1 4111 1111 1111 1111",
            "7 4111 1111 1111 1111",
            "No. 3 4111 1111 1111 1111",
            "12/28 4111 1111 1111 1111",
            "2026 4111 1111 1111 1111",
            "Ref 12 4111 1111 1111 1111",
        ] {
            assert_eq!(found(Kind::Card, line), ["4111 1111 1111 1111"], "{line}");
        }
        assert_eq!(
            found(Kind::Card, "4111 1111 1111 1111 5500 0000 0000 0004"),
            ["4111 1111 1111 1111", "5500 0000 0000 0004"]
        );
        assert_eq!(
            found(Kind::Iban, "REF12 SA03 8000 0000 6080 1016 7519"),
            ["SA03 8000 0000 6080 1016 7519"]
        );
        assert_eq!(
            found(Kind::NationalId, "10123456789 1012345678"),
            ["1012345678"]
        );
    }

    #[test]
    fn dates_numeric_and_written_in_arabic_and_english() {
        assert_eq!(
            found(
                Kind::Date,
                "في 12/09/2026 و2026-09-16 و١٦ سبتمبر ٢٠٢٦ و3 رمضان 1447 هـ"
            ),
            [
                "12/09/2026",
                "2026-09-16",
                "١٦ سبتمبر ٢٠٢٦",
                "3 رمضان 1447 هـ"
            ]
        );
        assert_eq!(
            found(Kind::Date, "Signed 5 March 2026, due September 16, 2026."),
            ["5 March 2026", "September 16, 2026"]
        );
        assert!(found(Kind::Date, "version 45/77/2026").is_empty());
    }

    #[test]
    fn a_person_s_own_pattern_is_limited_and_linear() {
        let f = Finder::custom(r"INV-\d+").unwrap();
        assert_eq!(f.find("رقم INV-2026 و INV-7"), vec![(4, 12), (15, 20)]);
        assert!(Finder::custom("(unclosed").is_err());
        assert!(Finder::custom(&"a".repeat(MAX_PATTERN + 1)).is_err());
        assert!(
            Finder::custom(r"(\w{1000}){1000}").is_err(),
            "too large to compile"
        );
        // The classic catastrophic pattern for a backtracking engine is
        // linear here: a long line of a's is searched at once.
        let f = Finder::custom(r"(a+)+$b").unwrap();
        let long = "a".repeat(100_000);
        let started = std::time::Instant::now();
        assert!(f.find(&long).is_empty());
        assert!(started.elapsed().as_secs() < 5);
    }
}
