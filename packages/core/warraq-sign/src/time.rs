//! Times: Unix seconds in, and PDF dates (`D:YYYYMMDDHHmmSS+HH'mm'`) and
//! ISO 8601 out. The browser build has no clock of its own (`SystemTime`
//! panics on wasm32), so "now" always comes from the host.

/// Days since 1970-01-01 of a civil date (proleptic Gregorian).
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let m = m as i64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Broken-down local time of `unix` at `offset_minutes` east of UTC.
fn fields(unix: i64, offset_minutes: i32) -> (i64, u32, u32, u32, u32, u32) {
    let t = unix + offset_minutes as i64 * 60;
    let (y, mo, d) = civil_from_days(t.div_euclid(86_400));
    let s = t.rem_euclid(86_400);
    (
        y,
        mo,
        d,
        (s / 3600) as u32,
        ((s % 3600) / 60) as u32,
        (s % 60) as u32,
    )
}

/// `D:20260918200000+03'00'`, the form `/M` takes (ISO 32000-2 §7.9.4).
pub fn pdf_date(unix: i64, offset_minutes: i32) -> String {
    let (y, mo, d, h, mi, s) = fields(unix, offset_minutes);
    let zone = if offset_minutes == 0 {
        "Z".to_string()
    } else {
        let sign = if offset_minutes < 0 { '-' } else { '+' };
        let off = offset_minutes.unsigned_abs();
        format!("{sign}{:02}'{:02}'", off / 60, off % 60)
    };
    format!("D:{y:04}{mo:02}{d:02}{h:02}{mi:02}{s:02}{zone}")
}

/// `2026-09-18T17:00:00Z`.
pub fn iso(unix: i64) -> String {
    let (y, mo, d, h, mi, s) = fields(unix, 0);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

/// A PDF date string as Unix seconds; `None` when it is not one. Missing
/// fields default as the standard says (month and day 1, time 0, UTC).
pub fn parse_pdf_date(text: &str) -> Option<i64> {
    let t = text.trim();
    let t = t.strip_prefix("D:").unwrap_or(t);
    let digits: String = t.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.len() < 4 {
        return None;
    }
    let num = |from: usize, len: usize, default: u32| -> Option<u32> {
        if digits.len() >= from + len {
            digits[from..from + len].parse().ok()
        } else {
            Some(default)
        }
    };
    let y: i64 = digits[..4].parse().ok()?;
    let (mo, d, h, mi, s) = (
        num(4, 2, 1)?,
        num(6, 2, 1)?,
        num(8, 2, 0)?,
        num(10, 2, 0)?,
        num(12, 2, 0)?,
    );
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || s > 60 {
        return None;
    }
    let rest = &t[digits.len()..];
    let offset = match rest.chars().next() {
        Some(sign @ ('+' | '-')) => {
            let z: String = rest[1..].chars().filter(|c| c.is_ascii_digit()).collect();
            let hh: i64 = z.get(..2).and_then(|x| x.parse().ok()).unwrap_or(0);
            let mm: i64 = z.get(2..4).and_then(|x| x.parse().ok()).unwrap_or(0);
            let o = hh * 3600 + mm * 60;
            if sign == '-' {
                -o
            } else {
                o
            }
        }
        _ => 0,
    };
    Some(days_from_civil(y, mo, d) * 86_400 + (h * 3600 + mi * 60 + s) as i64 - offset)
}

/// An X.509 / CMS time as Unix seconds.
pub fn x509_unix(t: &x509_cert::time::Time) -> i64 {
    t.to_unix_duration().as_secs() as i64
}

pub fn generalized_unix(t: &der::asn1::GeneralizedTime) -> i64 {
    t.to_unix_duration().as_secs() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pdf_dates_round_trip_through_unix_seconds() {
        // 2026-09-18 17:00:00 UTC
        let unix = 1_789_750_800;
        assert_eq!(iso(unix), "2026-09-18T17:00:00Z");
        assert_eq!(pdf_date(unix, 180), "D:20260918200000+03'00'");
        assert_eq!(pdf_date(unix, 0), "D:20260918170000Z");
        assert_eq!(pdf_date(unix, -330), "D:20260918113000-05'30'");
        for off in [0, 180, -330] {
            assert_eq!(parse_pdf_date(&pdf_date(unix, off)), Some(unix));
        }
        assert_eq!(parse_pdf_date("D:2026"), Some(days_from_civil(2026, 1, 1) * 86_400));
        assert_eq!(parse_pdf_date("D:20261340"), None);
        assert_eq!(parse_pdf_date("yesterday"), None);
    }
}
