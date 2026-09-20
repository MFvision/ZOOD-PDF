//! The date a document carries — not the date of the file.
//!
//! A letter written on 3 رمضان 1447 was copied onto the disk last night; the
//! Library shows the first. The finder reads the document's own text, in
//! Arabic and Latin digits, in the Gregorian and the Hijri calendars (Umm
//! al-Qura, through `warraq_pdf::forms::hijri`), in the shapes people
//! actually write:
//!
//! * `3/4/2026`, `03-04-2026`, `2026-04-03`, `٣/٤/٢٠٢٦`
//! * `3 أبريل 2026`, `3 نيسان 2026`, `3 April 2026`, `April 3, 2026`
//! * `3 رمضان 1447هـ`, `١٥ ذو الحجة ١٤٤٦`
//!
//! **How it picks.** Every date it finds is scored, and the best wins:
//! a date right after a label (التاريخ، بتاريخ، صدر في، Date:, Dated) counts
//! for four, being on the first page for two, standing in the first quarter
//! of its page for one, being written with the month's name rather than a
//! number for two, and carrying هـ or م for one. Ties go to the date that
//! comes first in the document. A document with no date at all has none —
//! the file's own date is never put in its place.
//!
//! **How it reads what it finds.** `2026-04-03` (a four-digit number first)
//! is read year-month-day. Otherwise the year is the four-digit part, and of
//! the two that are left the first is the day — the order written across the
//! Arab world and most of Europe — unless that is impossible (`4/25/2026`
//! can only be month-day). A two-digit year is 19xx from 69 up and 20xx below
//! it, as POSIX reads one. A date is Hijri when its month is a Hijri month,
//! when it is followed by هـ or AH, or when its year falls between 1300 and
//! 1500 with nothing saying otherwise; it is then converted to its Gregorian
//! day. A date that does not exist — 31 February, a Hijri day past the end of
//! its month — is thrown away, not corrected.
use std::sync::OnceLock;

use regex::Regex;
use warraq_pdf::forms::hijri;
use warraq_text::{normalize_for_search, SearchNormalization};

use super::index::{FoundDate, Line};

/// Pages read looking for the document's date.
const PAGES: u32 = 3;
/// Lines read, however many pages that is.
const MAX_LINES: usize = 3_000;
/// Dates weighed before the finder stops looking.
const MAX_CANDIDATES: usize = 400;
/// Characters before a date that may hold its label.
const LABEL_REACH: usize = 40;

/// The Gregorian months, in the names used across the Arab world and in
/// English, already normalized the way `normalize_for_search` leaves them.
/// The order matters: a longer name must come before a shorter one it starts
/// with, or the alternation stops early.
const GREGORIAN: &[(&str, u32)] = &[
    ("كانون الثاني", 1),
    ("كانون الاول", 12),
    ("تشرين الثاني", 11),
    ("تشرين الاول", 10),
    ("يناير", 1),
    ("فبراير", 2),
    ("مارس", 3),
    ("ابريل", 4),
    ("افريل", 4),
    ("مايو", 5),
    ("يونيو", 6),
    ("يونيه", 6),
    ("يوليو", 7),
    ("يوليه", 7),
    ("اغسطس", 8),
    ("سبتمبر", 9),
    ("اكتوبر", 10),
    ("نوفمبر", 11),
    ("ديسمبر", 12),
    ("شباط", 2),
    ("اذار", 3),
    ("نيسان", 4),
    ("ايار", 5),
    ("حزيران", 6),
    ("تموز", 7),
    ("ايلول", 9),
    ("اب", 8),
];

/// The Hijri months, likewise normalized (ة and ى are already folded).
const HIJRI: &[(&str, u32)] = &[
    ("محرم", 1),
    ("صفر", 2),
    ("ربيع الاول", 3),
    ("ربيع الاخر", 4),
    ("ربيع الثاني", 4),
    ("جمادي الاولي", 5),
    ("جمادي الاخره", 6),
    ("جمادي الثانيه", 6),
    ("رجب", 7),
    ("شعبان", 8),
    ("رمضان", 9),
    ("شوال", 10),
    ("ذو القعده", 11),
    ("ذي القعده", 11),
    ("ذو الحجه", 12),
    ("ذي الحجه", 12),
];

const LATIN: &[(&str, u32)] = &[
    ("january", 1),
    ("february", 2),
    ("march", 3),
    ("april", 4),
    ("may", 5),
    ("june", 6),
    ("july", 7),
    ("august", 8),
    ("september", 9),
    ("october", 10),
    ("november", 11),
    ("december", 12),
    ("jan", 1),
    ("feb", 2),
    ("mar", 3),
    ("apr", 4),
    ("jun", 6),
    ("jul", 7),
    ("aug", 8),
    ("sept", 9),
    ("sep", 9),
    ("oct", 10),
    ("nov", 11),
    ("dec", 12),
];

/// Words that say the number beside them is the document's date.
const LABELS: &[&str] = &[
    "التاريخ",
    "تاريخ",
    "بتاريخ",
    "الموافق",
    "موافق",
    "حرر في",
    "تحريرا في",
    "صدر في",
    "صدرت في",
    "مؤرخ",
    "مورخ",
    "المدينه في",
    "date",
    "dated",
    "issued",
    "as of",
    "effective",
];

struct Patterns {
    numeric: Regex,
    day_month_year: Regex,
    month_day_year: Regex,
}

fn patterns() -> &'static Patterns {
    static PATTERNS: OnceLock<Patterns> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        let named: Vec<&str> = GREGORIAN
            .iter()
            .chain(HIJRI)
            .chain(LATIN)
            .map(|(name, _)| *name)
            .collect();
        let months = named.join("|");
        let era = r"(?:\s*(?P<era>هجري|ميلادي|ه|م|ah|ad|ce)\b)?";
        Patterns {
            // \b keeps a date out of a longer run of digits: an invoice
            // number is not a date.
            numeric: Regex::new(r"\b(?P<a>\d{1,4})\s*[/\-.]\s*(?P<b>\d{1,2})\s*[/\-.]\s*(?P<c>\d{1,4})\b")
                .expect("the numeric date pattern compiles"),
            day_month_year: Regex::new(&format!(
                r"\b(?P<d>\d{{1,2}})(?:st|nd|rd|th)?\s+(?:من\s+)?(?P<mon>{months})\.?,?\s+(?:سنه\s+|عام\s+)?(?P<y>\d{{3,4}}){era}"
            ))
            .expect("the day-month-year pattern compiles"),
            month_day_year: Regex::new(&format!(
                r"\b(?P<mon>{months})\.?\s+(?P<d>\d{{1,2}})(?:st|nd|rd|th)?,?\s+(?P<y>\d{{3,4}}){era}"
            ))
            .expect("the month-day-year pattern compiles"),
        }
    })
}

fn month_number(name: &str) -> Option<(u32, bool)> {
    if let Some((_, m)) = HIJRI.iter().find(|(n, _)| *n == name) {
        return Some((*m, true));
    }
    if let Some((_, m)) = GREGORIAN.iter().find(|(n, _)| *n == name) {
        return Some((*m, false));
    }
    LATIN
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, m)| (*m, false))
}

/// One date found in the text, with what recommends it.
struct Candidate {
    iso: String,
    raw: String,
    hijri: bool,
    score: i32,
    at: (u32, usize, usize),
}

/// The date the document is about, if it carries one.
pub fn find(lines: &[Line]) -> Option<FoundDate> {
    // How long each of the first pages is, counted once: "near the top of the
    // page" must not cost a pass over the document per line.
    let mut page_lines = [0usize; PAGES as usize];
    for line in lines.iter().take(MAX_LINES) {
        if let Some(count) = page_lines.get_mut(line.page as usize) {
            *count += 1;
        }
    }
    let mut best: Option<Candidate> = None;
    let mut found = 0usize;
    let mut line_on_page = 0usize;
    let mut page_now = u32::MAX;
    for (index, line) in lines.iter().take(MAX_LINES).enumerate() {
        if line.page >= PAGES {
            break;
        }
        if line.page != page_now {
            page_now = line.page;
            line_on_page = 0;
        }
        let on_page = page_lines
            .get(line.page as usize)
            .copied()
            .unwrap_or(1)
            .max(1);
        let high = line_on_page * 4 < on_page;
        line_on_page += 1;
        for mut candidate in in_line(&line.text) {
            candidate.at = (line.page, index, candidate.at.2);
            if line.page == 0 {
                candidate.score += 2;
            }
            if high {
                candidate.score += 1;
            }
            found += 1;
            let better = match &best {
                None => true,
                Some(current) => {
                    (candidate.score, std::cmp::Reverse(candidate.at))
                        > (current.score, std::cmp::Reverse(current.at))
                }
            };
            if better {
                best = Some(candidate);
            }
            if found >= MAX_CANDIDATES {
                break;
            }
        }
        if found >= MAX_CANDIDATES {
            break;
        }
    }
    best.map(|c| FoundDate {
        iso: c.iso,
        raw: c.raw,
        hijri: c.hijri,
    })
}

/// Every date one line holds, scored by what is written around it.
fn in_line(text: &str) -> Vec<Candidate> {
    let opts = SearchNormalization::default();
    let (norm, map) = normalize_for_search(text, &opts);
    let chars: Vec<char> = norm.chars().collect();
    if map.len() != chars.len() || norm.is_empty() {
        return Vec::new();
    }
    // Which normalized char each normalized byte belongs to, so a match's
    // bytes can be turned back into the person's own text.
    let mut char_at_byte = vec![0usize; norm.len()];
    for (ci, (bi, c)) in norm.char_indices().enumerate() {
        for byte in char_at_byte.iter_mut().skip(bi).take(c.len_utf8()) {
            *byte = ci;
        }
    }
    let original = |start: usize, end: usize| -> (usize, usize) {
        let from = map[char_at_byte[start]];
        let last = map[char_at_byte[end.saturating_sub(1).min(norm.len() - 1)]];
        let mut to = last + text[last..].chars().next().map(char::len_utf8).unwrap_or(1);
        // The marks and the tatweel on the last letter are part of how the
        // document wrote the date: هـ must not come back as ه.
        for c in text[to..].chars() {
            if warraq_text::normalize::is_mark_or_control(c) {
                to += c.len_utf8();
            } else {
                break;
            }
        }
        (from, to.min(text.len()))
    };

    let p = patterns();
    let mut out = Vec::new();
    for caps in p.numeric.captures_iter(&norm) {
        let whole = caps.get(0).expect("the whole match");
        let (a, b, c) = (number(&caps, "a"), number(&caps, "b"), number(&caps, "c"));
        let Some((year, month, day, hijri)) = read_numeric(a, b, c) else {
            continue;
        };
        if let Some(candidate) = make(
            &norm,
            text,
            &original,
            whole.start(),
            whole.end(),
            year,
            month,
            day,
            hijri,
            0,
        ) {
            out.push(candidate);
        }
    }
    for (pattern, bonus) in [(&p.day_month_year, 2), (&p.month_day_year, 2)] {
        for caps in pattern.captures_iter(&norm) {
            let whole = caps.get(0).expect("the whole match");
            let name = caps.name("mon").map(|m| m.as_str()).unwrap_or("");
            let Some((month, hijri_month)) = month_number(name) else {
                continue;
            };
            let era = caps.name("era").map(|m| m.as_str()).unwrap_or("");
            let says_hijri = matches!(era, "ه" | "هجري" | "ah");
            let says_gregorian = matches!(era, "م" | "ميلادي" | "ad" | "ce");
            let year = number(&caps, "y");
            let hijri = hijri_month || says_hijri || (!says_gregorian && hijri_year(year));
            let bonus = bonus + i32::from(!era.is_empty());
            if let Some(candidate) = make(
                &norm,
                text,
                &original,
                whole.start(),
                whole.end(),
                year,
                month,
                number(&caps, "d"),
                hijri,
                bonus,
            ) {
                out.push(candidate);
            }
        }
    }
    out
}

fn number(caps: &regex::Captures<'_>, name: &str) -> u32 {
    caps.name(name)
        .and_then(|m| m.as_str().parse().ok())
        .unwrap_or(0)
}

/// A year in this band, with nothing else said, is a Hijri year: 1300 AH is
/// 1882 and 1500 AH is 2076, so no Gregorian document is mistaken for one.
fn hijri_year(year: u32) -> bool {
    (1300..=1500).contains(&year)
}

/// Read three numbers as a date, in the order the module's note describes.
fn read_numeric(a: u32, b: u32, c: u32) -> Option<(u32, u32, u32, bool)> {
    let (year, first, second) = if a >= 1000 {
        (a, b, c) // 2026-04-03: the year leads, then the month, then the day
    } else if c >= 100 {
        (c, a, b)
    } else {
        // A two-digit year, as POSIX reads one.
        (if c >= 69 { 1900 + c } else { 2000 + c }, a, b)
    };
    let (day, month) = if a >= 1000 {
        (second, first) // year-month-day
    } else if first > 12 && second <= 12 {
        (first, second)
    } else if second > 12 && first <= 12 {
        (second, first)
    } else {
        (first, second) // day first, as it is written here
    };
    Some((year, month, day, hijri_year(year)))
}

#[allow(clippy::too_many_arguments)]
fn make(
    norm: &str,
    text: &str,
    original: &dyn Fn(usize, usize) -> (usize, usize),
    start: usize,
    end: usize,
    year: u32,
    month: u32,
    day: u32,
    hijri: bool,
    bonus: i32,
) -> Option<Candidate> {
    let iso = to_iso(year, month, day, hijri)?;
    let (from, to) = original(start, end);
    // Back up to a character boundary: the window before the date is counted
    // in bytes, and Arabic letters are two of them.
    let mut window = start.saturating_sub(LABEL_REACH);
    while window < start && !norm.is_char_boundary(window) {
        window += 1;
    }
    let before = norm.get(window..start).unwrap_or_default();
    let labelled = LABELS.iter().any(|label| before.contains(label));
    Some(Candidate {
        iso,
        raw: text.get(from..to).unwrap_or_default().trim().to_string(),
        hijri,
        score: bonus + if labelled { 4 } else { 0 },
        at: (0, 0, start),
    })
}

/// A real date as `YYYY-MM-DD`, Gregorian; a Hijri one is converted.
fn to_iso(year: u32, month: u32, day: u32, hijri: bool) -> Option<String> {
    let year = i32::try_from(year).ok()?;
    let (y, m, d) = if hijri {
        hijri::days_to_gregorian(hijri::hijri_to_days(year, month, day)?)
    } else {
        if !(1000..=2400).contains(&year) {
            return None;
        }
        hijri::gregorian_to_days(year, month, day)?;
        (year, month, day)
    };
    Some(format!("{y:04}-{m:02}-{d:02}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(texts: &[(u32, &str)]) -> Vec<Line> {
        texts
            .iter()
            .map(|(page, text)| Line {
                page: *page,
                text: (*text).to_string(),
            })
            .collect()
    }

    fn date_of(texts: &[(u32, &str)]) -> Option<String> {
        find(&lines(texts)).map(|d| d.iso)
    }

    #[test]
    fn numeric_dates_in_both_digit_shapes() {
        assert_eq!(
            date_of(&[(0, "التاريخ: 3/4/2026")]),
            Some("2026-04-03".into())
        );
        assert_eq!(
            date_of(&[(0, "التاريخ: ٣/٤/٢٠٢٦")]),
            Some("2026-04-03".into())
        );
        assert_eq!(
            date_of(&[(0, "Date: 2026-04-03")]),
            Some("2026-04-03".into())
        );
        assert_eq!(
            date_of(&[(0, "Dated 04.25.2026")]),
            Some("2026-04-25".into())
        );
        assert_eq!(
            date_of(&[(0, "بتاريخ 25-04-2026")]),
            Some("2026-04-25".into())
        );
    }

    #[test]
    fn a_two_digit_year_follows_posix() {
        assert_eq!(date_of(&[(0, "التاريخ 1/2/99")]), Some("1999-02-01".into()));
        assert_eq!(date_of(&[(0, "التاريخ 1/2/05")]), Some("2005-02-01".into()));
    }

    #[test]
    fn months_written_out_in_arabic_and_english() {
        assert_eq!(
            date_of(&[(0, "حرر في 3 أبريل 2026")]),
            Some("2026-04-03".into())
        );
        assert_eq!(
            date_of(&[(0, "صدر في ٣ نيسان ٢٠٢٦")]),
            Some("2026-04-03".into())
        );
        assert_eq!(
            date_of(&[(0, "Issued 3 April 2026")]),
            Some("2026-04-03".into())
        );
        assert_eq!(
            date_of(&[(0, "Dated April 3, 2026")]),
            Some("2026-04-03".into())
        );
        assert_eq!(
            date_of(&[(0, "Dated Sept. 16, 2026")]),
            Some("2026-09-16".into())
        );
    }

    #[test]
    fn hijri_dates_are_umm_al_qura_and_become_gregorian() {
        // 1 Ramadan 1445 is 11 March 2024 (the crate's own test says so).
        assert_eq!(
            date_of(&[(0, "بتاريخ 1 رمضان 1445")]),
            Some("2024-03-11".into())
        );
        assert_eq!(
            date_of(&[(0, "التاريخ ١ رمضان ١٤٤٥ هـ")]),
            Some("2024-03-11".into())
        );
        // A bare year in the Hijri band is read as Hijri.
        assert_eq!(
            date_of(&[(0, "التاريخ 1/9/1445")]),
            Some("2024-03-11".into())
        );
        // …unless the document says it is Gregorian.
        assert_eq!(
            date_of(&[(0, "حرر في 1 مارس 1445 م")]),
            Some("1445-03-01".into())
        );
    }

    #[test]
    fn a_date_that_does_not_exist_is_thrown_away() {
        assert_eq!(date_of(&[(0, "التاريخ 31/2/2026")]), None);
        assert_eq!(date_of(&[(0, "نسخة 45/77/2026")]), None);
        assert_eq!(
            date_of(&[(0, "بتاريخ 30 صفر 1447")]),
            None,
            "صفر 1447 has 29 days"
        );
    }

    #[test]
    fn a_long_run_of_digits_is_not_a_date() {
        assert_eq!(date_of(&[(0, "رقم الفاتورة 12345/6/20261")]), None);
        assert_eq!(date_of(&[(0, "IBAN SA03 8000 0000 6080 1016 7519")]), None);
    }

    #[test]
    fn the_labelled_date_wins_over_one_buried_in_the_text() {
        let found = date_of(&[
            (0, "عقد إيجار"),
            (0, "يسري من 1/1/2020 إلى 1/1/2030"),
            (0, "التاريخ: 15/6/2026"),
        ]);
        assert_eq!(found, Some("2026-06-15".into()));
    }

    #[test]
    fn the_first_page_wins_over_a_later_one() {
        let found = date_of(&[(2, "التاريخ 1/1/2030"), (0, "التاريخ 2/2/2026")]);
        assert_eq!(found, Some("2026-02-02".into()));
    }

    #[test]
    fn a_document_with_no_date_has_none() {
        assert_eq!(date_of(&[(0, "بسم الله الرحمن الرحيم")]), None);
        assert_eq!(date_of(&[]), None);
    }

    #[test]
    fn the_date_as_the_document_wrote_it_is_kept() {
        let found = find(&lines(&[(0, "التاريخ: ١٥ رمضان ١٤٤٧هـ")])).expect("found");
        assert_eq!(found.raw, "١٥ رمضان ١٤٤٧هـ");
        assert!(found.hijri);
    }
}
