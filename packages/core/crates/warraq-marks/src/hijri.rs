//! Gregorian ↔ Hijri (Umm al-Qura) by table: month lengths for 1356–1500 AH (1937–2077 CE) in
//! [`crate::hijri_table`]. Dates outside the table have no Umm al-Qura date (`None`); the token
//! is then left empty rather than guessed with an arithmetic calendar.

use crate::hijri_table::{FIRST_JDN, FIRST_YEAR, MONTHS};

/// A civil date.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Date {
    pub year: i32,
    pub month: u32,
    pub day: u32,
}

/// Julian day number of a proleptic Gregorian date (Fliegel–Van Flandern).
pub fn gregorian_to_jdn(d: Date) -> Option<i64> {
    if !(1..=12).contains(&d.month)
        || d.day == 0
        || d.day > days_in_gregorian_month(d.year, d.month)
    {
        return None;
    }
    let (y, m, dd) = (i64::from(d.year), i64::from(d.month), i64::from(d.day));
    let a = (14 - m) / 12;
    let y2 = y + 4800 - a;
    let m2 = m + 12 * a - 3;
    Some(dd + (153 * m2 + 2) / 5 + 365 * y2 + y2 / 4 - y2 / 100 + y2 / 400 - 32045)
}

fn is_leap(y: i32) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

/// Days in a Gregorian month (0 for an invalid month).
pub fn days_in_gregorian_month(y: i32, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap(y) => 29,
        2 => 28,
        _ => 0,
    }
}

fn year_length(mask: u16) -> i64 {
    (0..12)
        .map(|m| if mask & (1 << m) != 0 { 30 } else { 29 })
        .sum()
}

/// The Umm al-Qura date of a Gregorian date, when it lies inside the table.
pub fn to_hijri(d: Date) -> Option<Date> {
    let jdn = gregorian_to_jdn(d)?;
    let mut day = jdn.checked_sub(FIRST_JDN)?;
    if day < 0 {
        return None;
    }
    for (i, mask) in MONTHS.iter().enumerate() {
        let len = year_length(*mask);
        if day >= len {
            day -= len;
            continue;
        }
        for m in 0..12u32 {
            let ml = if mask & (1 << m) != 0 { 30 } else { 29 };
            if day < ml {
                let year = FIRST_YEAR + i32::try_from(i).ok()?;
                return Some(Date {
                    year,
                    month: m + 1,
                    day: u32::try_from(day).ok()? + 1,
                });
            }
            day -= ml;
        }
    }
    None
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn g(year: i32, month: u32, day: u32) -> Date {
        Date { year, month, day }
    }

    #[test]
    fn jdn_known_answers() {
        assert_eq!(gregorian_to_jdn(g(2000, 1, 1)), Some(2_451_545));
        assert_eq!(gregorian_to_jdn(g(1970, 1, 1)), Some(2_440_588));
        assert_eq!(gregorian_to_jdn(g(2023, 2, 29)), None);
        assert_eq!(gregorian_to_jdn(g(2024, 2, 29)), Some(2_460_370));
        assert_eq!(gregorian_to_jdn(g(2024, 13, 1)), None);
    }

    /// Dates announced by the Saudi authorities / printed Umm al-Qura calendars.
    #[test]
    fn umm_al_qura_known_dates() {
        // 1 Ramadan 1447 = 18 February 2026; 1 Shawwal 1446 (Eid al-Fitr) = 30 March 2025.
        assert_eq!(to_hijri(g(2026, 2, 18)), Some(g(1447, 9, 1)));
        assert_eq!(to_hijri(g(2025, 3, 30)), Some(g(1446, 10, 1)));
        // 1 Muharram 1448 = 16 June 2026; 1 Muharram 1447 = 26 June 2025.
        assert_eq!(to_hijri(g(2026, 6, 16)), Some(g(1448, 1, 1)));
        assert_eq!(to_hijri(g(2025, 6, 26)), Some(g(1447, 1, 1)));
        // 26 September 2026 = 15 Rabi' al-Thani 1448.
        assert_eq!(to_hijri(g(2026, 9, 26)), Some(g(1448, 4, 15)));
        // 1 Muharram 1420 = 17 April 1999; 9 Dhu al-Hijjah 1445 (Arafah) = 15 June 2024.
        assert_eq!(to_hijri(g(1999, 4, 17)), Some(g(1420, 1, 1)));
        assert_eq!(to_hijri(g(2024, 6, 15)), Some(g(1445, 12, 9)));
    }

    #[test]
    fn outside_the_table_is_none() {
        assert_eq!(to_hijri(g(1900, 1, 1)), None);
        assert_eq!(to_hijri(g(2100, 1, 1)), None);
        assert_eq!(to_hijri(g(1937, 3, 14)), Some(g(1356, 1, 1)));
    }

    #[test]
    fn every_day_of_the_table_is_consecutive() {
        let mut prev: Option<Date> = None;
        let start = gregorian_to_jdn(g(1937, 3, 14)).unwrap();
        for jdn in start..start + 52_000 {
            // JDN → Gregorian (Richards) to walk day by day.
            let f = jdn + 1401 + (((4 * jdn + 274_277) / 146_097) * 3) / 4 - 38;
            let e = 4 * f + 3;
            let gg = (e % 1461) / 4;
            let h = 5 * gg + 2;
            let day = (h % 153) / 5 + 1;
            let month = ((h / 153 + 2) % 12) + 1;
            let year = e / 1461 - 4716 + (14 - month) / 12;
            let d = g(year as i32, month as u32, day as u32);
            let Some(hd) = to_hijri(d) else { break };
            if let Some(p) = prev {
                let next_ok = (hd.year == p.year && hd.month == p.month && hd.day == p.day + 1)
                    || (hd.day == 1
                        && ((hd.year == p.year && hd.month == p.month + 1)
                            || (hd.year == p.year + 1 && hd.month == 1 && p.month == 12)));
                assert!(next_ok, "{p:?} → {hd:?}");
            }
            prev = Some(hd);
        }
        assert_eq!(prev.map(|p| p.year), Some(1500));
    }
}
