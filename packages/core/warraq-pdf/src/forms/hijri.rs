//! The Hijri calendar as it is used in Saudi Arabia: Umm al-Qura.
//!
//! Umm al-Qura is not arithmetic — each month's length is published — so the
//! months from 1356 to 1500 AH (1937 to 2077) are a table, taken from ICU's
//! calendar data (Unicode License v3). Outside it, the dates are the
//! tabular Islamic calendar, which can be a day off Umm al-Qura; Hijri
//! fields in Warraq are for dates people fill in on forms, well inside it.
//!
//! Days are counted from 1970-01-01, as JavaScript's `Date` counts them; the
//! same table goes into the script other readers run (`script::hijri_js`).

/// Days from 1970-01-01 to 1 Muharram 1356.
pub(crate) const FIRST_DAY: i64 = -11981;
pub(crate) const FIRST_YEAR: i32 = 1356;
pub(crate) const LAST_YEAR: i32 = 1500;
/// Twelve bits a year, three hex digits, the lowest bit Muharram: 1 is a
/// month of 30 days, 0 of 29.
pub(crate) const MONTHS: &str = "eaae94d2ac564aea6d56ad55d4aa9352ba5b53a6b5ea9d52d29a554ad56daea6e4ed1da2aaa95a2da5b9bb27646c95552ab4dbaba5b4da9d52aa592d26d8ed2daad5aa5a4b4979372b6975d69d52c9592b25b4db9d55d2da5d4aa9554daad3aabd2bc4b89a9552d5adb6a6d4dc9d92aa69562ae56d36ab55aaa94d49d95d2ba5b55aad55a9a92e26e55dada6d46a5b27a4d4ad56db5a754f49e92d26a563566b5baab92b2568ba9b55aada5b4da9b52a9a536276575af26d46a95552ad4bd9ba574b69b52a9552da5d4daad96b2e95e2ac9692eaad56ad65d4a";

fn year_mask(year: i32) -> Option<u16> {
    if !(FIRST_YEAR..=LAST_YEAR).contains(&year) {
        return None;
    }
    let at = (year - FIRST_YEAR) as usize * 3;
    u16::from_str_radix(MONTHS.get(at..at + 3)?, 16).ok()
}

/// Days in a year of the table.
fn year_length(year: i32) -> i64 {
    12 * 29 + i64::from(year_mask(year).unwrap_or(0).count_ones())
}

fn table_month_length(year: i32, month: u32) -> Option<u32> {
    Some(if year_mask(year)? >> (month - 1) & 1 == 1 {
        30
    } else {
        29
    })
}

/// Days from 1970-01-01 of a Gregorian date (proleptic), or None when it is
/// not a real date.
pub fn gregorian_to_days(year: i32, month: u32, day: u32) -> Option<i64> {
    if !(1..=12).contains(&month) || day == 0 || day > gregorian_month_length(year, month) {
        return None;
    }
    // Howard Hinnant's days_from_civil.
    let y = i64::from(year) - i64::from(month <= 2);
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let m = i64::from(month);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + i64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468)
}

/// The Gregorian date of a day counted from 1970-01-01.
pub fn days_to_gregorian(days: i64) -> (i32, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = (yoe + era * 400 + i64::from(month <= 2)) as i32;
    (year, month, day)
}

pub fn gregorian_month_length(year: i32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        2 => 28,
        _ => 0,
    }
}

/// Days of the tabular Islamic calendar (the "civil" epoch, 16 July 622),
/// used outside the Umm al-Qura table.
const TABULAR_EPOCH: i64 = -492_148;

fn tabular_to_days(year: i32, month: u32, day: u32) -> i64 {
    let (y, m) = (i64::from(year), i64::from(month));
    i64::from(day) + (295 * (m - 1) + 5) / 10 + 354 * (y - 1) + (3 + 11 * y) / 30 + TABULAR_EPOCH
        - 1
}

fn tabular_month_length(year: i32, month: u32) -> u32 {
    if month % 2 == 1 {
        return 30;
    }
    if month < 12 {
        return 29;
    }
    // Leap years of the 30-year cycle give Dhu al-Hijjah its 30th day.
    if (11 * i64::from(year) + 14).rem_euclid(30) < 11 {
        30
    } else {
        29
    }
}

/// The length of a Hijri month.
pub fn hijri_month_length(year: i32, month: u32) -> u32 {
    if !(1..=12).contains(&month) {
        return 0;
    }
    table_month_length(year, month).unwrap_or_else(|| tabular_month_length(year, month))
}

/// Days from 1970-01-01 of a Hijri date, or None when it is not a real date.
pub fn hijri_to_days(year: i32, month: u32, day: u32) -> Option<i64> {
    if !(1..=9999).contains(&year) || day == 0 || day > hijri_month_length(year, month) {
        return None;
    }
    if year_mask(year).is_none() {
        return Some(tabular_to_days(year, month, day));
    }
    let mut days = FIRST_DAY;
    for y in FIRST_YEAR..year {
        days += year_length(y);
    }
    for m in 1..month {
        days += i64::from(table_month_length(year, m).unwrap_or(29));
    }
    Some(days + i64::from(day) - 1)
}

/// The Hijri date of a day counted from 1970-01-01.
pub fn days_to_hijri(days: i64) -> (i32, u32, u32) {
    if days >= FIRST_DAY {
        let mut start = FIRST_DAY;
        for year in FIRST_YEAR..=LAST_YEAR {
            // Whole years first: 29 days a month, one more for each long month.
            if days >= start + year_length(year) {
                start += year_length(year);
                continue;
            }
            for month in 1..=12 {
                let length = i64::from(table_month_length(year, month).unwrap_or(29));
                if days < start + length {
                    return (year, month, (days - start + 1) as u32);
                }
                start += length;
            }
        }
    }
    // Tabular: estimate the year, then walk to it (a few steps at most).
    let mut year = (((days - TABULAR_EPOCH) * 30 + 10_646) / 10_631).clamp(1, 9999) as i32;
    while year > 1 && tabular_to_days(year, 1, 1) > days {
        year -= 1;
    }
    while year < 9999 && tabular_to_days(year + 1, 1, 1) <= days {
        year += 1;
    }
    let mut month = 1;
    while month < 12 && tabular_to_days(year, month + 1, 1) <= days {
        month += 1;
    }
    let day = (days - tabular_to_days(year, month, 1) + 1).max(1) as u32;
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gregorian_days_round_trip() {
        assert_eq!(gregorian_to_days(1970, 1, 1), Some(0));
        assert_eq!(gregorian_to_days(1937, 3, 14), Some(FIRST_DAY));
        assert_eq!(gregorian_to_days(2023, 2, 29), None);
        assert_eq!(gregorian_to_days(2024, 2, 29), Some(19_782));
        for days in (-200_000..200_000).step_by(37) {
            let (y, m, d) = days_to_gregorian(days);
            assert_eq!(gregorian_to_days(y, m, d), Some(days));
        }
    }

    #[test]
    fn known_umm_al_qura_dates() {
        // 1 Muharram 1356 and the samples ICU gives (umalqura.mjs, every 97th day).
        assert_eq!(days_to_hijri(FIRST_DAY), (1356, 1, 1));
        let day = gregorian_to_days(2025, 9, 17).unwrap();
        assert_eq!(days_to_hijri(day), (1447, 3, 25));
        assert_eq!(hijri_to_days(1447, 3, 25), Some(day));
        // 1 Ramadan 1445 was Monday 11 March 2024 in Saudi Arabia.
        assert_eq!(hijri_to_days(1445, 9, 1), gregorian_to_days(2024, 3, 11));
        // 1 Shawwal 1446 (Eid al-Fitr) was 30 March 2025.
        assert_eq!(hijri_to_days(1446, 10, 1), gregorian_to_days(2025, 3, 30));
        assert_eq!(hijri_to_days(1446, 13, 1), None);
        assert_eq!(hijri_to_days(1446, 1, 31), None);
    }

    #[test]
    fn every_day_of_the_table_round_trips() {
        let last = hijri_to_days(LAST_YEAR, 12, hijri_month_length(LAST_YEAR, 12)).unwrap();
        for days in FIRST_DAY - 800..last + 800 {
            let (y, m, d) = days_to_hijri(days);
            assert!(
                d >= 1 && d <= hijri_month_length(y, m),
                "{days}: {y}/{m}/{d}"
            );
            assert_eq!(hijri_to_days(y, m, d), Some(days), "{y}/{m}/{d}");
        }
    }

    #[test]
    fn every_date_icu_gives_matches() {
        // Every 97th day from 1356 to 1500 AH, as ICU's Umm al-Qura calendar
        // has it (tests/fixtures/forms/umalqura.mjs wrote the file).
        let path = format!(
            "{}/../../../tests/fixtures/forms/umalqura-icu-sample.json",
            env!("CARGO_MANIFEST_DIR")
        );
        let text = std::fs::read_to_string(path).unwrap();
        let rows: Vec<[i64; 4]> = text
            .trim()
            .trim_matches(|c| c == '[' || c == ']')
            .split("],[")
            .map(|row| {
                let v: Vec<i64> = row.split(',').map(|n| n.trim().parse().unwrap()).collect();
                [v[0], v[1], v[2], v[3]]
            })
            .collect();
        assert!(rows.len() > 500);
        for [days, y, m, d] in rows {
            let (y, m, d) = (y as i32, m as u32, d as u32);
            assert_eq!(days_to_hijri(days), (y, m, d), "{days}");
            assert_eq!(hijri_to_days(y, m, d), Some(days));
        }
    }

    #[test]
    fn tabular_dates_far_away_still_round_trip() {
        for days in [-300_000i64, -12_000, 100_000, 400_000] {
            let (y, m, d) = days_to_hijri(days);
            assert_eq!(hijri_to_days(y, m, d), Some(days), "{y}/{m}/{d}");
        }
    }
}
