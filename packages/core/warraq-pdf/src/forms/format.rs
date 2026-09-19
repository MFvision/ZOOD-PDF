//! What Acrobat's format functions do to a value, done in Rust: numbers
//! (`AFNumber_*`), percentages (`AFPercent_*`), dates (`AFDate_*`), the
//! special masks (`AFSpecial_*`), and Warraq's Arabic-Indic digits and
//! Umm al-Qura dates. Each takes the value as stored in the field and gives
//! what is shown; the keystroke checks say whether a typed value is accepted.
use super::hijri;

/// `AFNumber_Format(decimals, separator, negative, _, currency, prepend)`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct NumberSpec {
    pub decimals: u8,
    /// 0 `1,234.56`, 1 `1234.56`, 2 `1.234,56`, 3 `1234,56`, 4 `1'234.56`.
    pub separator: u8,
    /// 0 minus sign, 1 red, 2 parentheses, 3 red parentheses.
    pub negative: u8,
    pub currency: String,
    /// The currency before the number, not after it.
    pub prepend: bool,
}

/// A date pattern such as `dd/mm/yyyy`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DateSpec {
    pub pattern: String,
}

impl DateSpec {
    pub fn new(pattern: &str) -> Self {
        Self {
            pattern: pattern.to_string(),
        }
    }
}

/// What a format makes of a value: the text shown, and whether it is shown
/// in red (a negative number, in styles 1 and 3).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Shown {
    pub text: String,
    pub red: bool,
}

/// Western digits for Arabic-Indic and Persian ones; the Arabic decimal and
/// thousands signs become `.` and `,`.
pub fn latin_digits(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            '\u{0660}'..='\u{0669}' => char::from(b'0' + (c as u32 - 0x0660) as u8),
            '\u{06F0}'..='\u{06F9}' => char::from(b'0' + (c as u32 - 0x06F0) as u8),
            '\u{066B}' => '.',
            '\u{066C}' => ',',
            '\u{2212}' => '-',
            c => c,
        })
        .collect()
}

/// Arabic-Indic digits, and the Arabic decimal, thousands and percent signs
/// — a separator only when a digit follows it, as `js/digits.js` does.
pub fn arabic_digits(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    chars
        .iter()
        .enumerate()
        .map(|(i, &c)| match c {
            '0'..='9' => char::from_u32(0x0660 + (c as u32 - '0' as u32)).unwrap_or(c),
            '%' => '\u{066A}',
            '.' | ',' if chars.get(i + 1).is_some_and(|n| n.is_ascii_digit()) => {
                if c == '.' {
                    '\u{066B}'
                } else {
                    '\u{066C}'
                }
            }
            c => c,
        })
        .collect()
}

/// The number a field's value holds, as Warraq reads it: Western,
/// Arabic-Indic or Persian digits; `.` or `٫` for the decimal point, with
/// thousands separators; a minus sign or parentheses. None when it is not a
/// number at all (or is empty).
pub fn parse_number(raw: &str) -> Option<f64> {
    let text: String = latin_digits(raw)
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '\u{200F}' && *c != '\u{200E}' && *c != '\'')
        .collect();
    if text.is_empty() || text.len() > 64 {
        return None;
    }
    let (negative, body) =
        if let Some(inner) = text.strip_prefix('(').and_then(|t| t.strip_suffix(')')) {
            (true, inner.to_string())
        } else if let Some(rest) = text.strip_prefix('-') {
            (true, rest.to_string())
        } else {
            (false, text.strip_prefix('+').unwrap_or(&text).to_string())
        };
    let dot = body.rfind('.');
    let comma = body.rfind(',');
    let normal = match (dot, comma) {
        (Some(d), Some(c)) if d > c => body.replace(',', ""),
        (Some(_), Some(_)) => body.replace('.', "").replace(',', "."),
        (None, Some(c)) => {
            // One comma with anything but three digits after it is a decimal
            // comma ("12,5"); otherwise commas group thousands ("1,234").
            let after = body.len() - c - 1;
            if body.matches(',').count() == 1 && after != 3 {
                body.replace(',', ".")
            } else {
                body.replace(',', "")
            }
        }
        _ => body,
    };
    if normal.is_empty() || !normal.chars().all(|c| c.is_ascii_digit() || c == '.') || normal == "."
    {
        return None;
    }
    let value: f64 = normal.parse().ok()?;
    value
        .is_finite()
        .then_some(if negative { -value } else { value })
}

/// `n` with `decimals` places, grouped per `separator` style.
fn plain_number(n: f64, decimals: u8, separator: u8) -> String {
    let fixed = format!("{:.*}", usize::from(decimals.min(15)), n.abs());
    let (whole, fraction) = match fixed.split_once('.') {
        Some((w, f)) => (w.to_string(), Some(f.to_string())),
        None => (fixed, None),
    };
    let (group, point) = match separator {
        0 => (Some(','), '.'),
        1 => (None, '.'),
        2 => (Some('.'), ','),
        3 => (None, ','),
        _ => (Some('\''), '.'),
    };
    let mut out = String::new();
    let digits: Vec<char> = whole.chars().collect();
    for (i, c) in digits.iter().enumerate() {
        if let Some(g) = group {
            if i > 0 && (digits.len() - i).is_multiple_of(3) {
                out.push(g);
            }
        }
        out.push(*c);
    }
    if let Some(f) = fraction {
        out.push(point);
        out.push_str(&f);
    }
    out
}

/// `AFNumber_Format`: an empty value stays empty; anything else not a
/// number is shown as it is.
pub fn format_number(raw: &str, spec: &NumberSpec) -> Shown {
    let Some(n) = parse_number(raw) else {
        return Shown {
            text: if raw.trim().is_empty() {
                String::new()
            } else {
                raw.to_string()
            },
            red: false,
        };
    };
    let body = plain_number(n, spec.decimals, spec.separator);
    let negative = n < 0.0 && body.chars().any(|c| c.is_ascii_digit() && c != '0');
    let with_currency = if spec.currency.is_empty() {
        body
    } else if spec.prepend {
        format!("{}{body}", spec.currency)
    } else {
        format!("{body}{}", spec.currency)
    };
    let text = match (negative, spec.negative) {
        (true, 0) => format!("-{with_currency}"),
        (true, 2) | (true, 3) => format!("({with_currency})"),
        _ => with_currency,
    };
    Shown {
        text,
        red: negative && (spec.negative == 1 || spec.negative == 3),
    }
}

/// `AFPercent_Format`: the value times a hundred, and `%`.
pub fn format_percent(raw: &str, decimals: u8, separator: u8) -> Shown {
    let Some(n) = parse_number(raw) else {
        return Shown {
            text: if raw.trim().is_empty() {
                String::new()
            } else {
                raw.to_string()
            },
            red: false,
        };
    };
    let body = plain_number(n * 100.0, decimals, separator.min(3));
    let negative = n < 0.0 && body.chars().any(|c| c.is_ascii_digit() && c != '0');
    Shown {
        text: format!("{}{body}%", if negative { "-" } else { "" }),
        red: false,
    }
}

/// `AFSpecial_Format`: ZIP, ZIP+4, phone number, social security number.
pub fn format_special(raw: &str, kind: u8) -> Shown {
    let digits: String = latin_digits(raw)
        .chars()
        .filter(char::is_ascii_digit)
        .collect();
    let d = |a: usize, b: usize| digits.get(a..b.min(digits.len())).unwrap_or("");
    let text = match kind {
        0 => d(0, 5).to_string(),
        1 if digits.len() > 5 => format!("{}-{}", d(0, 5), d(5, 9)),
        1 => d(0, 5).to_string(),
        2 if digits.len() >= 10 => format!("({}) {}-{}", d(0, 3), d(3, 6), d(6, 10)),
        2 if digits.len() > 3 => format!("{}-{}", d(0, 3), d(3, 7)),
        2 => digits.clone(),
        _ if digits.len() > 5 => format!("{}-{}-{}", d(0, 3), d(3, 5), d(5, 9)),
        _ => digits.clone(),
    };
    Shown { text, red: false }
}

/// Whether a committed value fits `AFSpecial_Keystroke`.
pub fn special_accepts(raw: &str, kind: u8) -> bool {
    let digits = latin_digits(raw)
        .chars()
        .filter(char::is_ascii_digit)
        .count();
    let only = latin_digits(raw)
        .chars()
        .all(|c| c.is_ascii_digit() || " -().+".contains(c));
    only && match kind {
        0 => digits == 5,
        1 => digits == 9,
        2 => digits == 7 || digits == 10,
        _ => digits == 9,
    }
}

const MONTHS: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];
const WEEKDAYS: [&str; 7] = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
];
pub const HIJRI_MONTHS: [&str; 12] = [
    "محرم",
    "صفر",
    "ربيع الأول",
    "ربيع الآخر",
    "جمادى الأولى",
    "جمادى الآخرة",
    "رجب",
    "شعبان",
    "رمضان",
    "شوال",
    "ذو القعدة",
    "ذو الحجة",
];

/// The pattern as runs of one character: `dd/mm/yyyy` → dd, /, mm, /, yyyy.
fn runs(pattern: &str) -> Vec<(char, usize)> {
    let mut out: Vec<(char, usize)> = Vec::new();
    for c in pattern.chars() {
        match out.last_mut() {
            Some((last, n)) if *last == c => *n += 1,
            _ => out.push((c, 1)),
        }
    }
    out
}

/// A date as year, month, day.
pub type Ymd = (i32, u32, u32);

/// The numbers in a value, in order, and the month it names, if any.
fn pieces(text: &str, month_names: &[&str], lowercase: bool) -> (Vec<i64>, u32) {
    let text = latin_digits(text);
    let mut numbers = Vec::new();
    let mut current = String::new();
    for c in text.chars().chain(std::iter::once(' ')) {
        if c.is_ascii_digit() {
            current.push(c);
        } else if !current.is_empty() {
            // Longer runs of digits than a year are not a date.
            numbers.push(
                current
                    .get(..9)
                    .unwrap_or(&current)
                    .parse()
                    .unwrap_or(i64::MAX),
            );
            current.clear();
        }
        if numbers.len() > 8 {
            break;
        }
    }
    let haystack = if lowercase {
        text.to_lowercase()
    } else {
        text.clone()
    };
    let mut named = 0;
    for (k, name) in month_names.iter().enumerate() {
        let name = if lowercase {
            name.to_lowercase()
        } else {
            name.to_string()
        };
        // English names match by their first three letters, as Acrobat's do.
        let needle: String = if lowercase {
            name.chars().take(3).collect()
        } else {
            name
        };
        if haystack.contains(&needle) {
            named = k as u32 + 1;
        }
    }
    (numbers, named)
}

/// The numbers of `text` given to the pattern's year, month and day, in the
/// order the pattern writes them.
fn assign(pattern: &str, numbers: &[i64], named: u32) -> Option<(i64, i64, i64)> {
    let mut order: Vec<(usize, char)> = Vec::new();
    for key in ['y', 'm', 'd'] {
        if key == 'm' && named > 0 {
            continue;
        }
        if let Some(at) = pattern.find(key) {
            order.push((at, key));
        }
    }
    order.sort();
    if numbers.len() != order.len() {
        return None;
    }
    let (mut y, mut m, mut d) = (i64::MIN, i64::from(named), 1);
    for ((_, key), n) in order.iter().zip(numbers) {
        match key {
            'y' => y = *n,
            'm' => m = *n,
            _ => d = *n,
        }
    }
    Some((y, m, d))
}

/// `AFParseDateEx`, for the patterns Warraq offers and Acrobat's own: the
/// value's numbers in the pattern's order (month names in English, as
/// Acrobat's), or failing that an ISO `yyyy-mm-dd`. A pattern without a
/// year takes 2000.
pub fn parse_date(raw: &str, spec: &DateSpec) -> Option<Ymd> {
    if raw.trim().is_empty() || raw.len() > 128 {
        return None;
    }
    let (numbers, named) = pieces(raw, &MONTHS, true);
    let pattern_names = spec.pattern.contains("mmm");
    let named = if pattern_names || named > 0 { named } else { 0 };
    let from_pattern = assign(&spec.pattern, &numbers, named).and_then(|(y, m, d)| {
        let y = match y {
            i64::MIN => 2000,
            y if y < 50 => 2000 + y,
            y if y < 100 => 1900 + y,
            y => y,
        };
        valid_gregorian(y, m, d)
    });
    // Failing the pattern, a date written year first (ISO), or day first
    // with the year last, as most of the world writes one.
    from_pattern.or_else(|| match numbers.as_slice() {
        [y, m, d] if *y >= 1000 => valid_gregorian(*y, *m, *d),
        [d, m, y] if *y >= 1000 => valid_gregorian(*y, *m, *d),
        _ => None,
    })
}

fn valid_gregorian(y: i64, m: i64, d: i64) -> Option<Ymd> {
    let (y, m, d) = (
        i32::try_from(y).ok()?,
        u32::try_from(m).ok()?,
        u32::try_from(d).ok()?,
    );
    if !(1..=9999).contains(&y) {
        return None;
    }
    hijri::gregorian_to_days(y, m, d).map(|_| (y, m, d))
}

/// `util.printd` for a date: d dd ddd dddd, m mm mmm mmmm, yy yyyy; H h M s t
/// for a time of midnight; anything else as written.
pub fn print_date(date: Ymd, pattern: &str) -> String {
    let (y, m, d) = date;
    let weekday = hijri::gregorian_to_days(y, m, d)
        .map(|days| (days + 4).rem_euclid(7) as usize)
        .unwrap_or(0);
    let mut out = String::new();
    for (c, n) in runs(pattern) {
        match (c, n) {
            ('y', 1 | 2) => out.push_str(&format!("{:02}", y.rem_euclid(100))),
            ('y', _) => out.push_str(&format!("{y:04}")),
            ('m', 1) => out.push_str(&m.to_string()),
            ('m', 2) => out.push_str(&format!("{m:02}")),
            ('m', 3) => out.push_str(&MONTHS[(m as usize - 1) % 12][..3]),
            ('m', _) => out.push_str(MONTHS[(m as usize - 1) % 12]),
            ('d', 1) => out.push_str(&d.to_string()),
            ('d', 2) => out.push_str(&format!("{d:02}")),
            ('d', 3) => out.push_str(&WEEKDAYS[weekday][..3]),
            ('d', _) => out.push_str(WEEKDAYS[weekday]),
            ('H' | 'M' | 's', n) => out.push_str(&"0".repeat(n.min(2))),
            ('h', 1) => out.push_str("12"),
            ('h', _) => out.push_str("12"),
            ('t', 1) => out.push('a'),
            ('t', _) => out.push_str("am"),
            (c, n) => out.extend(std::iter::repeat_n(c, n)),
        }
    }
    out
}

/// `AFDate_FormatEx`: a date that does not read is shown empty, as Acrobat does.
pub fn format_date(raw: &str, spec: &DateSpec) -> Shown {
    Shown {
        text: parse_date(raw, spec)
            .map(|date| print_date(date, &spec.pattern))
            .unwrap_or_default(),
        red: false,
    }
}

/// An Umm al-Qura date in the pattern's order, or with its month named.
pub fn parse_hijri(raw: &str, spec: &DateSpec) -> Option<Ymd> {
    if raw.trim().is_empty() || raw.len() > 128 {
        return None;
    }
    let (numbers, named) = pieces(raw, &HIJRI_MONTHS, false);
    let (y, m, d) = assign(&spec.pattern, &numbers, named)?;
    let y = if (0..100).contains(&y) { 1400 + y } else { y };
    let (y, m, d) = (
        i32::try_from(y).ok()?,
        u32::try_from(m).ok()?,
        u32::try_from(d).ok()?,
    );
    hijri::hijri_to_days(y, m, d).map(|_| (y, m, d))
}

/// `Warraq_HijriFormat`, as `js/hijri-format.js` shows it: a value that does
/// not read as a Hijri date is shown as it is.
pub fn format_hijri(raw: &str, spec: &DateSpec, arabic: bool) -> Shown {
    let Some((y, m, d)) = parse_hijri(raw, spec) else {
        return Shown {
            text: raw.to_string(),
            red: false,
        };
    };
    let mut out = String::new();
    for (c, n) in runs(&spec.pattern) {
        match (c, n) {
            ('y', 1 | 2) => out.push_str(&format!("{:02}", y.rem_euclid(100))),
            ('y', _) => out.push_str(&format!("{y:04}")),
            ('m', 1) => out.push_str(&m.to_string()),
            ('m', 2) => out.push_str(&format!("{m:02}")),
            ('m', _) => out.push_str(HIJRI_MONTHS[(m as usize - 1) % 12]),
            ('d', 1) => out.push_str(&d.to_string()),
            ('d', _) => out.push_str(&format!("{d:02}")),
            (c, n) => out.extend(std::iter::repeat_n(c, n)),
        }
    }
    let text = if arabic {
        out.chars()
            .map(|c| match c {
                '0'..='9' => char::from_u32(0x0660 + (c as u32 - '0' as u32)).unwrap_or(c),
                c => c,
            })
            .collect()
    } else {
        out
    };
    Shown { text, red: false }
}

/// The Gregorian date of a Hijri one, for showing both.
pub fn hijri_to_gregorian(date: Ymd) -> Option<Ymd> {
    hijri::hijri_to_days(date.0, date.1, date.2).map(hijri::days_to_gregorian)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(
        decimals: u8,
        separator: u8,
        negative: u8,
        currency: &str,
        prepend: bool,
    ) -> NumberSpec {
        NumberSpec {
            decimals,
            separator,
            negative,
            currency: currency.into(),
            prepend,
        }
    }

    #[test]
    fn numbers_read_in_every_digit_and_separator() {
        assert_eq!(parse_number("1234.5"), Some(1234.5));
        assert_eq!(parse_number(" 1,234.50 "), Some(1234.5));
        assert_eq!(parse_number("1.234,50"), Some(1234.5));
        assert_eq!(parse_number("12,5"), Some(12.5));
        assert_eq!(parse_number("1,234"), Some(1234.0));
        assert_eq!(parse_number("١٢٣٫٥"), Some(123.5));
        assert_eq!(parse_number("١٬٢٣٤٫٥"), Some(1234.5));
        assert_eq!(parse_number("۱۲"), Some(12.0));
        assert_eq!(parse_number("-7"), Some(-7.0));
        assert_eq!(parse_number("(7)"), Some(-7.0));
        assert_eq!(parse_number("−7"), Some(-7.0));
        for bad in ["", " ", "abc", "1.2.3a", "12 ر.س", ".", "--1", "1e5"] {
            assert_eq!(parse_number(bad), None, "{bad}");
        }
    }

    #[test]
    fn numbers_format_like_acrobat() {
        assert_eq!(
            format_number("1234.567", &spec(2, 0, 0, "", false)).text,
            "1,234.57"
        );
        assert_eq!(
            format_number("1234.5", &spec(2, 1, 0, "", false)).text,
            "1234.50"
        );
        assert_eq!(
            format_number("1234.5", &spec(2, 2, 0, "", false)).text,
            "1.234,50"
        );
        assert_eq!(
            format_number("1234.5", &spec(2, 3, 0, "", false)).text,
            "1234,50"
        );
        assert_eq!(
            format_number("1234567", &spec(0, 4, 0, "", false)).text,
            "1'234'567"
        );
        assert_eq!(
            format_number("-5", &spec(2, 0, 0, "$", true)).text,
            "-$5.00"
        );
        assert_eq!(
            format_number("-5", &spec(2, 0, 2, " ر.س", false)).text,
            "(5.00 ر.س)"
        );
        let red = format_number("-5", &spec(0, 0, 1, "", false));
        assert_eq!((red.text.as_str(), red.red), ("5", true));
        assert_eq!(
            format_number("1500", &spec(2, 0, 0, " ر.س", false)).text,
            "1,500.00 ر.س"
        );
        assert_eq!(
            format_number("1500", &spec(0, 0, 0, "SAR ", true)).text,
            "SAR 1,500"
        );
        assert_eq!(format_number("", &spec(2, 0, 0, "", false)).text, "");
        assert_eq!(
            format_number("-0.001", &spec(2, 0, 0, "", false)).text,
            "0.00"
        );
        assert_eq!(format_number("n/a", &spec(2, 0, 0, "", false)).text, "n/a");
        assert_eq!(format_percent("0.125", 1, 0).text, "12.5%");
        assert_eq!(format_percent("-0.5", 0, 0).text, "-50%");
    }

    #[test]
    fn arabic_indic_digits_leave_the_riyal_sign_alone() {
        let shown = format_number("1500.5", &spec(2, 0, 0, " ر.س", false)).text;
        assert_eq!(arabic_digits(&shown), "١٬٥٠٠٫٥٠ ر.س");
        assert_eq!(arabic_digits("12.5%"), "١٢٫٥٪");
        assert_eq!(latin_digits("١٬٥٠٠٫٥٠"), "1,500.50");
    }

    #[test]
    fn special_masks() {
        assert_eq!(format_special("123456789", 1).text, "12345-6789");
        assert_eq!(format_special("5551234567", 2).text, "(555) 123-4567");
        assert_eq!(format_special("123456789", 3).text, "123-45-6789");
        assert!(special_accepts("12345", 0));
        assert!(!special_accepts("1234x", 0));
        assert!(special_accepts("(555) 123-4567", 2));
    }

    #[test]
    fn dates_read_in_the_patterns_order() {
        let dmy = DateSpec::new("dd/mm/yyyy");
        assert_eq!(parse_date("17/09/2025", &dmy), Some((2025, 9, 17)));
        assert_eq!(parse_date("١٧/٩/٢٠٢٥", &dmy), Some((2025, 9, 17)));
        assert_eq!(
            parse_date("2025-09-17", &dmy),
            Some((2025, 9, 17)),
            "ISO always reads"
        );
        assert_eq!(parse_date("31/02/2025", &dmy), None);
        assert_eq!(parse_date("hello", &dmy), None);
        let mdy = DateSpec::new("mm/dd/yy");
        assert_eq!(parse_date("9/17/25", &mdy), Some((2025, 9, 17)));
        assert_eq!(parse_date("9/17/99", &mdy), Some((1999, 9, 17)));
        let named = DateSpec::new("d mmmm yyyy");
        assert_eq!(parse_date("17 September 2025", &named), Some((2025, 9, 17)));
        assert_eq!(parse_date("17 sep 2025", &named), Some((2025, 9, 17)));
        assert_eq!(format_date("17/9/2025", &dmy).text, "17/09/2025");
        assert_eq!(
            format_date("17/9/2025", &DateSpec::new("dddd, mmmm d, yyyy")).text,
            "Wednesday, September 17, 2025"
        );
        assert_eq!(
            format_date("17/9/2025", &DateSpec::new("yyyy-mm-dd")).text,
            "2025-09-17"
        );
        assert_eq!(format_date("not a date", &dmy).text, "");
    }

    #[test]
    fn hijri_dates_are_umm_al_qura() {
        let spec = DateSpec::new("dd/mm/yyyy هـ");
        assert_eq!(parse_hijri("25/3/1447", &spec), Some((1447, 3, 25)));
        assert_eq!(parse_hijri("٢٥/٠٣/١٤٤٧", &spec), Some((1447, 3, 25)));
        assert_eq!(
            parse_hijri("30/2/1447", &spec),
            None,
            "Safar 1447 has 29 days"
        );
        assert_eq!(
            parse_hijri("30/3/1447", &spec),
            Some((1447, 3, 30)),
            "Rabi' al-Awwal 1447 has 30"
        );
        assert_eq!(
            format_hijri("25/3/1447", &spec, false).text,
            "25/03/1447 هـ"
        );
        assert_eq!(format_hijri("25/3/1447", &spec, true).text, "٢٥/٠٣/١٤٤٧ هـ");
        let named = DateSpec::new("d mmmm yyyy هـ");
        assert_eq!(
            format_hijri("1/9/1445", &named, false).text,
            "1 رمضان 1445 هـ"
        );
        assert_eq!(parse_hijri("1 رمضان 1445", &named), Some((1445, 9, 1)));
        assert_eq!(hijri_to_gregorian((1445, 9, 1)), Some((2024, 3, 11)));
        assert_eq!(format_hijri("garbage", &spec, false).text, "garbage");
    }

    #[test]
    fn never_panics() {
        let dmy = DateSpec::new("dd/mm/yyyy");
        for raw in [
            "99999999999999999999/1/1",
            "1/1/-5",
            "0/0/0",
            "٣٣٣٣٣٣٣٣٣٣٣٣٣٣٣٣٣",
            "(",
            ")",
            "-",
            "1,,,,",
            "1..2",
        ] {
            let _ = parse_number(raw);
            let _ = parse_date(raw, &dmy);
            let _ = parse_hijri(raw, &dmy);
            let _ = format_special(raw, 2);
            let _ = format_number(raw, &spec(15, 4, 3, "", false));
        }
        let _ = format_number("1e308", &spec(15, 0, 0, "", false));
    }
}
