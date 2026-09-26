//! Personal-data patterns for find & redact, with validators.
//!
//! Every pattern runs over text normalised by `warraq_text::normalize_for_search` (tashkeel and
//! tatweel removed, alef/taa-marbuta/yaa unified, Arabic-Indic ٠-٩ and Persian ۰-۹ digits → ASCII,
//! lower case, whitespace collapsed), so `٠٥٠ ١٢٣ ٤٥٦٧`, `۰۵۰۱۲۳۴۵۶۷` and `050-123-4567` are the
//! same number. Regexes come from the `regex` crate (finite automata: linear time, no
//! backtracking); candidates are then checked by a validator (Luhn, mod-97, digit counts, date
//! ranges). A candidate that fails validation is retried without its trailing groups so a valid
//! number followed by another short token is still found.

use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use warraq_text::normalize_for_search;

use crate::error::{RedactError, Result};

/// Longest custom pattern accepted (characters).
pub const MAX_CUSTOM_PATTERN: usize = 512;
/// Compiled-program budget for custom patterns (bytes).
pub const CUSTOM_SIZE_LIMIT: usize = 1 << 20;

/// Kinds of matches.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    /// The search box.
    Query,
    Email,
    Phone,
    /// Saudi National ID (starts with 1) or Iqama (starts with 2).
    SaudiId,
    Iban,
    Card,
    Date,
    /// User regular expression.
    Custom,
}

/// Luhn check over ASCII digits.
pub fn luhn(digits: &str) -> bool {
    let mut sum = 0u32;
    let mut n = 0usize;
    for (i, c) in digits.chars().rev().enumerate() {
        let Some(d) = c.to_digit(10) else {
            return false;
        };
        let v = if i % 2 == 1 {
            let x = d * 2;
            if x > 9 {
                x - 9
            } else {
                x
            }
        } else {
            d
        };
        sum += v;
        n += 1;
    }
    n > 0 && sum % 10 == 0
}

fn only_digits(s: &str) -> String {
    s.chars()
        .filter_map(|c| {
            if c.is_ascii_digit() {
                Some(c)
            } else {
                match u32::from(c) {
                    0x0660..=0x0669 => char::from_u32(u32::from(c) - 0x0660 + 0x30),
                    0x06F0..=0x06F9 => char::from_u32(u32::from(c) - 0x06F0 + 0x30),
                    _ => None,
                }
            }
        })
        .collect()
}

/// Saudi National ID / Iqama: 10 digits, first digit 1 (citizen) or 2 (resident), and the check
/// digit used by Absher/Yakeen: digits at odd positions (1st, 3rd, …) are doubled and the digits of
/// each product added, digits at even positions are added as they are, the total must be a
/// multiple of 10 (this is the Luhn scheme on 10 digits).
pub fn saudi_id_valid(s: &str) -> bool {
    let d = only_digits(s);
    if d.len() != 10 || !(d.starts_with('1') || d.starts_with('2')) {
        return false;
    }
    let mut sum = 0u32;
    for (i, c) in d.chars().enumerate() {
        let v = c.to_digit(10).unwrap_or(0);
        if i % 2 == 0 {
            let x = v * 2;
            sum += x / 10 + x % 10;
        } else {
            sum += v;
        }
    }
    sum % 10 == 0
}

const IBAN_LENGTHS: &[(&str, usize)] = &[
    ("SA", 24),
    ("AE", 23),
    ("BH", 22),
    ("KW", 30),
    ("QA", 29),
    ("OM", 23),
    ("JO", 30),
    ("EG", 29),
    ("LB", 28),
    ("IQ", 23),
    ("PS", 29),
    ("TN", 24),
    ("MR", 27),
    ("LY", 25),
    ("SD", 18),
    ("TR", 26),
    ("PK", 24),
    ("DE", 22),
    ("FR", 27),
    ("GB", 22),
    ("NL", 18),
    ("ES", 24),
    ("IT", 27),
    ("CH", 21),
    ("BE", 16),
    ("AT", 20),
    ("SE", 24),
    ("NO", 15),
    ("DK", 18),
    ("FI", 18),
    ("IE", 22),
    ("PT", 25),
    ("PL", 28),
];

/// IBAN: country code, check digits, length for the country (15–34 when unknown), mod-97 = 1.
pub fn iban_valid(s: &str) -> bool {
    let c: String = s
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_ascii_uppercase();
    if !(15..=34).contains(&c.len()) || !c.chars().all(|x| x.is_ascii_alphanumeric()) {
        return false;
    }
    let (cc, rest) = c.split_at(2);
    if !cc.chars().all(|x| x.is_ascii_uppercase())
        || !rest.chars().take(2).all(|x| x.is_ascii_digit())
    {
        return false;
    }
    if let Some((_, len)) = IBAN_LENGTHS.iter().find(|(k, _)| *k == cc) {
        if c.len() != *len {
            return false;
        }
    }
    if cc == "SA" && !c.chars().skip(4).take(2).all(|x| x.is_ascii_digit()) {
        return false;
    }
    let rearranged = format!("{rest}{cc}");
    let rest4 = rearranged.get(2..).unwrap_or("");
    let moved = format!("{rest4}{}", rearranged.get(..2).unwrap_or(""));
    let mut r: u32 = 0;
    for ch in moved.chars() {
        let v = match ch.to_digit(36) {
            Some(v) => v,
            None => return false,
        };
        r = if v >= 10 {
            (r * 100 + v) % 97
        } else {
            (r * 10 + v) % 97
        };
    }
    r == 1
}

/// Payment card: 13–19 digits and a valid Luhn check digit.
pub fn card_valid(s: &str) -> bool {
    let d = only_digits(s);
    (13..=19).contains(&d.len()) && luhn(&d) && !d.chars().all(|c| c == '0')
}

/// Phone: 9–15 digits.
pub fn phone_valid(s: &str) -> bool {
    let n = only_digits(s).len();
    (9..=15).contains(&n)
}

/// Numeric date: day/month plausible in either order, year 2 or 4 digits.
pub fn numeric_date_valid(s: &str) -> bool {
    let parts: Vec<&str> = s
        .split(|c: char| !c.is_ascii_digit())
        .filter(|p| !p.is_empty())
        .collect();
    let [a, b, c] = parts.as_slice() else {
        return false;
    };
    let (y, m, d) = if a.len() == 4 { (a, b, c) } else { (c, b, a) };
    let (Ok(m), Ok(d), Ok(_y)) = (m.parse::<u32>(), d.parse::<u32>(), y.parse::<u32>()) else {
        return false;
    };
    // dd/mm or mm/dd
    (1..=12).contains(&m) && (1..=31).contains(&d) || (1..=12).contains(&d) && (1..=31).contains(&m)
}

fn yes(_: &str) -> bool {
    true
}

/// A compiled built-in pattern.
pub struct Pattern {
    pub kind: Kind,
    pub regex: Regex,
    /// Capture group holding the match (0 = whole match).
    pub group: usize,
    pub validate: fn(&str) -> bool,
    /// On validation failure retry without trailing space-separated groups.
    pub shrink: bool,
}

fn build(src: &str) -> Result<Regex> {
    RegexBuilder::new(src)
        .size_limit(8 << 20)
        .dfa_size_limit(8 << 20)
        .build()
        .map_err(|e| RedactError::Regex(e.to_string()))
}

fn alternation(names: &[&str]) -> String {
    let mut v: Vec<String> = names
        .iter()
        .map(|n| regex::escape(&normalize_for_search(n).0))
        .collect();
    // Longest first so "ربيع الاول" wins over a shorter prefix.
    v.sort_by_key(|s| std::cmp::Reverse(s.len()));
    v.dedup();
    v.join("|")
}

const GREGORIAN_AR: &[&str] = &[
    "يناير",
    "فبراير",
    "مارس",
    "أبريل",
    "إبريل",
    "مايو",
    "يونيو",
    "يونيه",
    "يوليو",
    "يوليه",
    "أغسطس",
    "سبتمبر",
    "أكتوبر",
    "نوفمبر",
    "ديسمبر",
    "كانون الثاني",
    "شباط",
    "آذار",
    "نيسان",
    "أيار",
    "حزيران",
    "تموز",
    "آب",
    "أيلول",
    "تشرين الأول",
    "تشرين الثاني",
    "كانون الأول",
];
const GREGORIAN_EN: &[&str] = &[
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
    "jan",
    "feb",
    "mar",
    "apr",
    "jun",
    "jul",
    "aug",
    "sep",
    "sept",
    "oct",
    "nov",
    "dec",
];
const HIJRI: &[&str] = &[
    "محرم",
    "صفر",
    "ربيع الأول",
    "ربيع الآخر",
    "ربيع الثاني",
    "جمادى الأولى",
    "جمادى الآخرة",
    "جمادى الثانية",
    "جمادى الأول",
    "جمادى الآخر",
    "رجب",
    "شعبان",
    "رمضان",
    "شوال",
    "ذو القعدة",
    "ذو الحجة",
    "ذي القعدة",
    "ذي الحجة",
];

/// The built-in pattern(s) for `kind` (`Query`/`Custom` have none).
pub fn builtin(kind: Kind) -> Result<Vec<Pattern>> {
    let p =
        |src: &str, group: usize, validate: fn(&str) -> bool, shrink: bool| -> Result<Pattern> {
            Ok(Pattern {
                kind,
                regex: build(src)?,
                group,
                validate,
                shrink,
            })
        };
    Ok(match kind {
        Kind::Email => vec![p(
            r"\b[a-z0-9][a-z0-9._%+\-]{0,63}@[a-z0-9](?:[a-z0-9\-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9\-]{0,62}[a-z0-9])?)*\.[a-z]{2,24}\b",
            0,
            yes,
            false,
        )?],
        Kind::Phone => vec![
            // International: +966 50 123 4567, 00966-50-1234567, +1 (212) 555-0100
            p(
                r"(?:^|[^0-9a-z+])((?:\+|00)[1-9][0-9]{0,2}(?:[ .\-]?\(?[0-9]{1,4}\)?){2,6})",
                1,
                phone_valid,
                true,
            )?,
            // Saudi mobile: 05x xxx xxxx / 9665x…
            p(
                r"\b(?:05|9665)[0-9](?:[ .\-]?[0-9]){7}\b",
                0,
                phone_valid,
                false,
            )?,
            // Grouped local numbers: (011) 234-5678, 212 555 0100
            p(
                r"(?:^|[^0-9])(\(?[0-9]{2,4}\)?[ .\-][0-9]{3,4}[ .\-][0-9]{3,4})\b",
                1,
                phone_valid,
                true,
            )?,
        ],
        Kind::SaudiId => vec![p(r"\b[12][0-9]{9}\b", 0, saudi_id_valid, false)?],
        Kind::Iban => vec![p(
            r"\b[a-z]{2}[0-9]{2}(?: ?[a-z0-9]{4}){2,7}(?: ?[a-z0-9]{1,4})?\b",
            0,
            iban_valid,
            true,
        )?],
        Kind::Card => vec![p(r"\b[0-9](?:[ \-]?[0-9]){12,18}\b", 0, card_valid, true)?],
        Kind::Date => {
            let greg = alternation(GREGORIAN_AR);
            let en = alternation(GREGORIAN_EN);
            let hijri = alternation(HIJRI);
            let suffix = r"(?: ?(?:ه|م))?\b";
            vec![
                p(
                    &format!(
                        r"\b(?:[0-9]{{1,2}}[/.\-][0-9]{{1,2}}[/.\-](?:[0-9]{{4}}|[0-9]{{2}})|[0-9]{{4}}[/.\-][0-9]{{1,2}}[/.\-][0-9]{{1,2}}){suffix}"
                    ),
                    0,
                    numeric_date_valid,
                    false,
                )?,
                p(
                    &format!(
                        r"\b[0-9]{{1,2}} (?:{greg}|{hijri}|{en})\b(?: ?[,،])? ?[0-9]{{3,4}}{suffix}"
                    ),
                    0,
                    yes,
                    false,
                )?,
                p(
                    &format!(r"\b(?:{en}) [0-9]{{1,2}},? [0-9]{{4}}\b"),
                    0,
                    yes,
                    false,
                )?,
            ]
        }
        Kind::Query | Kind::Custom => Vec::new(),
    })
}

/// Run `patterns` over normalised text: validated matches as `(kind, byte range)`, in text order.
/// Overlapping matches of the same kind keep the longest; a candidate failing validation is
/// retried without its trailing separator-delimited groups (`shrink`).
pub fn scan(norm: &str, patterns: &[Pattern], max: usize) -> Vec<(Kind, std::ops::Range<usize>)> {
    let mut out: Vec<(Kind, std::ops::Range<usize>)> = Vec::new();
    for p in patterns {
        for c in p.regex.captures_iter(norm) {
            if out.len() >= max {
                break;
            }
            let Some(m) = c.get(p.group) else { continue };
            let start = m.start();
            let mut end = m.end();
            let ok = loop {
                let cand = norm.get(start..end).unwrap_or("");
                let t = cand.trim_end();
                end = start + t.len();
                if (p.validate)(t) {
                    break true;
                }
                if !p.shrink {
                    break false;
                }
                match t.rfind([' ', '-', '.']) {
                    Some(i) if i > 0 => end = start + i,
                    _ => break false,
                }
            };
            if !ok || end <= start {
                continue;
            }
            let r = start..end;
            if let Some(prev) = out
                .iter_mut()
                .find(|(k, q)| *k == p.kind && q.start < r.end && r.start < q.end)
            {
                if r.len() > prev.1.len() {
                    prev.1 = r;
                }
                continue;
            }
            out.push((p.kind, r));
        }
    }
    out.sort_by_key(|(_, r)| (r.start, r.end));
    out
}

/// Fold the Arabic letters of a user pattern the way the text is folded (alef forms, taa
/// marbuta, yaa, tashkeel, Arabic digits), leaving every regex metacharacter untouched.
pub fn fold_pattern(src: &str) -> String {
    let mut out = String::with_capacity(src.len());
    for c in src.chars() {
        if ('\u{0600}'..='\u{06FF}').contains(&c) {
            out.push_str(&normalize_for_search(&c.to_string()).0);
        } else {
            out.push(c);
        }
    }
    out
}

/// Compile a user pattern with bounds: length, program size, nesting; case-insensitive.
pub fn custom(src: &str) -> Result<Regex> {
    if src.trim().is_empty() {
        return Err(RedactError::Regex("the pattern is empty".into()));
    }
    if src.chars().count() > MAX_CUSTOM_PATTERN {
        return Err(RedactError::Regex(format!(
            "the pattern is longer than {MAX_CUSTOM_PATTERN} characters"
        )));
    }
    let r = RegexBuilder::new(&fold_pattern(src))
        .case_insensitive(true)
        .size_limit(CUSTOM_SIZE_LIMIT)
        .dfa_size_limit(CUSTOM_SIZE_LIMIT)
        .nest_limit(64)
        .build()
        .map_err(|e| RedactError::Regex(e.to_string()))?;
    if r.is_match("") {
        return Err(RedactError::Regex("the pattern matches empty text".into()));
    }
    Ok(r)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    fn found(kind: Kind, text: &str) -> Vec<String> {
        let (norm, _) = normalize_for_search(text);
        scan(&norm, &builtin(kind).unwrap(), 1000)
            .into_iter()
            .map(|(_, r)| norm[r].to_string())
            .collect()
    }

    #[test]
    fn saudi_id_check_digit() {
        assert!(saudi_id_valid("1010101010"));
        assert!(saudi_id_valid("1000000008"));
        assert!(saudi_id_valid("2000000006"));
        assert!(saudi_id_valid("١٠١٠١٠١٠١٠"), "Arabic-Indic digits");
        assert!(saudi_id_valid("۱۰۰۰۰۰۰۰۰۸"), "Persian digits");
        assert!(!saudi_id_valid("1000000009"), "bad check digit");
        assert!(!saudi_id_valid("3000000001"), "must start with 1 or 2");
        assert!(!saudi_id_valid("100000008"), "9 digits");
        assert_eq!(
            found(
                Kind::SaudiId,
                "رقم الهوية ١٠١٠١٠١٠١٠ والإقامة 2000000006 وليس 1000000009"
            ),
            ["1010101010", "2000000006"]
        );
    }

    #[test]
    fn iban_mod97() {
        assert!(iban_valid("SA03 8000 0000 6080 1016 7519"));
        assert!(iban_valid("GB82 WEST 1234 5698 7654 32"));
        assert!(iban_valid("DE89370400440532013000"));
        assert!(!iban_valid("SA04 8000 0000 6080 1016 7519"), "check digits");
        assert!(!iban_valid("SA03 8000 0000 6080 1016 751"), "length for SA");
        assert!(!iban_valid("GB82 WEST 1234 5698 7654 33"));
        let f = found(Kind::Iban, "الآيبان: SA03 8000 0000 6080 1016 7519 and more");
        assert_eq!(f, ["sa03 8000 0000 6080 1016 7519"]);
    }

    #[test]
    fn cards_luhn() {
        assert!(card_valid("4111 1111 1111 1111"));
        assert!(card_valid("5500-0000-0000-0004"));
        assert!(card_valid("378282246310005"));
        assert!(!card_valid("4111 1111 1111 1112"));
        assert!(!card_valid("0000 0000 0000 0000"));
        assert_eq!(
            found(Kind::Card, "بطاقة ٤١١١ ١١١١ ١١١١ ١١١١ ok"),
            ["4111 1111 1111 1111"]
        );
        assert!(found(Kind::Card, "4111 1111 1111 1112").is_empty());
    }

    #[test]
    fn luhn_basics() {
        assert!(luhn("79927398713"));
        assert!(!luhn("79927398710"));
        assert!(!luhn(""));
        assert!(!luhn("12a"));
    }

    #[test]
    fn phones_with_arabic_digits() {
        assert_eq!(found(Kind::Phone, "جوال: ٠٥٠١٢٣٤٥٦٧"), ["0501234567"]);
        assert_eq!(found(Kind::Phone, "هاتف ۰۵۵ ۱۲۳ ۴۵۶۷"), ["055 123 4567"]);
        assert_eq!(
            found(Kind::Phone, "اتصل +966 50 123 4567 الآن"),
            ["+966 50 123 4567"]
        );
        assert_eq!(
            found(Kind::Phone, "call 00966-55-1234567."),
            ["00966-55-1234567"]
        );
        assert_eq!(
            found(Kind::Phone, "NY +1 (212) 555-0100"),
            ["+1 (212) 555-0100"]
        );
        assert!(found(Kind::Phone, "the year 2024 and 12 apples").is_empty());
    }

    #[test]
    fn emails() {
        assert_eq!(
            found(Kind::Email, "راسلنا على Info.Sales@Example.com.sa اليوم"),
            ["info.sales@example.com.sa"]
        );
        assert!(found(Kind::Email, "not@an address").is_empty());
    }

    #[test]
    fn dates_gregorian_and_hijri() {
        let f = found(Kind::Date, "تاريخ ٢٠٢٤/٠١/١٥ و 15/01/2024 و ١٥ رمضان ١٤٤٥هـ و 3 ذو الحجة 1445 هـ و 5 يناير 2024 و January 5, 2024 و 12 تشرين الأول 2023");
        assert!(f.contains(&"2024/01/15".to_string()), "{f:?}");
        assert!(f.contains(&"15/01/2024".to_string()), "{f:?}");
        assert!(f.contains(&"15 رمضان 1445ه".to_string()), "{f:?}");
        assert!(f.contains(&"3 ذو الحجه 1445 ه".to_string()), "{f:?}");
        assert!(f.contains(&"5 يناير 2024".to_string()), "{f:?}");
        assert!(f.contains(&"january 5, 2024".to_string()), "{f:?}");
        assert!(f.contains(&"12 تشرين الاول 2023".to_string()), "{f:?}");
        assert!(found(Kind::Date, "99/99/2024").is_empty());
        let f = found(Kind::Date, "الموعد 1445/09/15 هـ");
        assert_eq!(f, ["1445/09/15 ه"]);
    }

    #[test]
    fn custom_patterns_are_bounded() {
        assert!(custom("").is_err());
        assert!(custom("a*").is_err(), "matches empty");
        assert!(custom(&"a".repeat(600)).is_err());
        assert!(custom("(").is_err());
        // Would be catastrophic for a backtracking engine; here it compiles and runs linearly,
        // or is rejected by the size limit.
        if let Ok(r) = custom("(a+)+$") {
            let s = "a".repeat(50_000) + "b";
            assert!(!r.is_match(&s));
        }
        assert!(custom("a{1000}{1000}").is_err(), "program too large");
        let r = custom("أحمد").unwrap();
        assert!(r.is_match(&normalize_for_search("إِحْمَد").0) || r.is_match("احمد"));
        let r = custom("INV-\\d{4}").unwrap();
        assert!(r.is_match(&normalize_for_search("inv-٢٠٢٤").0));
    }
}
