//! Visual → logical ordering of a line, built on `unicode-bidi`, with the **W5 fix**.
//!
//! PDFs store glyphs in visual order. The classic way to recover logical order is to run the
//! Unicode Bidirectional Algorithm on the *visual* sequence as if it were logical and apply rule
//! L2 (reversal); for most text that reversal is an involution and gives back the logical order.
//!
//! ## The W5 fix
//!
//! The involution breaks for European digits next to European terminators (`%`, `$`, `#`,
//! `+`, `٪`, …) and separators inside Arabic text. In logical order `بنسبة 50%` the digits
//! follow an Arabic letter, so UAX #9 rule **W2** turns them into Arabic numbers (AN); rule
//! **W5** ("ET adjacent to EN becomes EN") therefore does *not* apply and `%` stays neutral
//! and resolves to R (N1). The line is displayed as `%50 ةبسنب` (visually left to right).
//! Run the algorithm on that visual string and the Arabic letter now comes *after* the digits,
//! W2 leaves them EN, W5 glues `%` to the number and the result is the wrong `بنسبة %50`.
//! Dates suffer the same way (`2024-06-01` → `01-06-2024`, because ES between AN is neutral).
//!
//! The fix restores the W2 context before W5 runs: for every run of European digits in the
//! visual line we look for the nearest strong character on each side. If the run sits in a
//! right-to-left context (strong R/AL — or the paragraph edge of an RTL paragraph — on both
//! sides), its logical predecessor is the strong character on its **right**; if that is an
//! Arabic letter (AL) the digits are treated as AN (by substituting an Arabic-Indic digit
//! proxy). W5 then correctly leaves adjacent ETs alone, W4 no longer joins `-` separators,
//! and the reversal restores `50%` and `2024-06-01`. Digits that are really EN in logical
//! order (e.g. at the start of an RTL paragraph, or after a Latin word) are left untouched.

use unicode_bidi::{bidi_class, BidiClass, Level, ParagraphBidiInfo};

/// Base direction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Dir {
    Ltr,
    Rtl,
}

/// Strong direction of a character, if it has one.
pub fn strong_dir(c: char) -> Option<Dir> {
    match bidi_class(c) {
        BidiClass::L => Some(Dir::Ltr),
        BidiClass::R | BidiClass::AL => Some(Dir::Rtl),
        _ => None,
    }
}

/// Paragraph direction: majority of strong characters; ties go to the first strong character;
/// no strong characters → RTL if Arabic-Indic digits are present, else LTR.
pub fn detect_direction<'a>(texts: impl IntoIterator<Item = &'a str>) -> Dir {
    let (mut l, mut r) = (0usize, 0usize);
    let mut first = None;
    let mut arabic_digits = false;
    for t in texts {
        for c in t.chars() {
            match strong_dir(c) {
                Some(Dir::Ltr) => l += 1,
                Some(Dir::Rtl) => r += 1,
                None => {
                    if bidi_class(c) == BidiClass::AN {
                        arabic_digits = true;
                    }
                    continue;
                }
            }
            if first.is_none() {
                first = strong_dir(c);
            }
        }
    }
    if r > l {
        Dir::Rtl
    } else if l > r {
        Dir::Ltr
    } else {
        first.unwrap_or(if arabic_digits { Dir::Rtl } else { Dir::Ltr })
    }
}

/// Pick the character that stands for a unit of text in the bidi run.
pub fn proxy_char(text: &str) -> char {
    let mut fallback = None;
    let mut number = None;
    for c in text.chars() {
        match bidi_class(c) {
            BidiClass::L | BidiClass::R | BidiClass::AL => return c,
            BidiClass::EN | BidiClass::AN => {
                number.get_or_insert(c);
            }
            BidiClass::B | BidiClass::S | BidiClass::BN => {}
            _ => {
                fallback.get_or_insert(c);
            }
        }
    }
    let c = number.or(fallback).unwrap_or(' ');
    if matches!(bidi_class(c), BidiClass::B | BidiClass::S) {
        ' '
    } else {
        c
    }
}

/// Apply the W5 fix (see module docs) to visual-order proxy characters.
pub fn w5_fix(proxies: &mut [char], para: Dir) {
    let classes: Vec<BidiClass> = proxies.iter().map(|&c| bidi_class(c)).collect();
    let n = classes.len();
    let mut i = 0usize;
    while i < n {
        if classes.get(i) != Some(&BidiClass::EN) {
            i += 1;
            continue;
        }
        let start = i;
        while classes.get(i) == Some(&BidiClass::EN) {
            i += 1;
        }
        let end = i; // exclusive
        let left = classes
            .get(..start)
            .and_then(|s| s.iter().rev().find(|c| is_strong(**c)).copied());
        let right = classes
            .get(end..)
            .and_then(|s| s.iter().find(|c| is_strong(**c)).copied());
        let rtl = |c: Option<BidiClass>| match c {
            Some(BidiClass::R | BidiClass::AL) => true,
            Some(_) => false,
            None => para == Dir::Rtl,
        };
        if !(rtl(left) && rtl(right)) {
            continue;
        }
        if right == Some(BidiClass::AL) {
            // Logically preceded by an Arabic letter: W2 makes these AN; W5 must not apply.
            for p in proxies.get_mut(start..end).into_iter().flatten() {
                *p = '\u{0660}';
            }
        } else {
            // Logically EN (preceded by R or the paragraph start): W2 must not see the Arabic
            // letter that is only *visually* before the digits. The number and the terminators
            // W5 attaches to it form one left-to-right block: use a strong-L proxy for all.
            let mut s = start;
            while s > 0 && classes.get(s - 1) == Some(&BidiClass::ET) {
                s -= 1;
            }
            let mut e = end;
            while classes.get(e) == Some(&BidiClass::ET) {
                e += 1;
            }
            for p in proxies.get_mut(s..e).into_iter().flatten() {
                *p = 'a';
            }
            i = e;
        }
    }
}

fn is_strong(c: BidiClass) -> bool {
    matches!(c, BidiClass::L | BidiClass::R | BidiClass::AL)
}

/// Given one proxy char per visual item (left to right), return the item indices in logical
/// order.
pub fn visual_to_logical(proxies: &[char], para: Dir) -> Vec<usize> {
    if proxies.is_empty() {
        return Vec::new();
    }
    let mut fixed = proxies.to_vec();
    w5_fix(&mut fixed, para);
    let s: String = fixed.iter().collect();
    let level = match para {
        Dir::Ltr => Level::ltr(),
        Dir::Rtl => Level::rtl(),
    };
    let info = ParagraphBidiInfo::new(&s, Some(level));
    let levels = info.reordered_levels_per_char(0..s.len());
    let order = ParagraphBidiInfo::reorder_visual(&levels);
    if order.len() == proxies.len() {
        order
    } else {
        (0..proxies.len()).collect()
    }
}

/// Logical → visual using the standard algorithm (used by tests and the shaper).
pub fn logical_to_visual(text: &str, para: Option<Dir>) -> String {
    let level = para.map(|d| {
        if d == Dir::Rtl {
            Level::rtl()
        } else {
            Level::ltr()
        }
    });
    let info = ParagraphBidiInfo::new(text, level);
    info.reorder_line(0..text.len()).into_owned()
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    /// Visual string (as a PDF stores it) → logical, char by char.
    fn to_logical(visual: &str, para: Dir) -> String {
        let chars: Vec<char> = visual.chars().collect();
        let order = visual_to_logical(&chars, para);
        order.iter().map(|&i| chars[i]).collect()
    }

    fn roundtrip(logical: &str, para: Dir) -> String {
        let visual = logical_to_visual(logical, Some(para));
        to_logical(&visual, para)
    }

    #[test]
    fn plain_arabic_is_reversed() {
        assert_eq!(roundtrip("مرحبا بالعالم", Dir::Rtl), "مرحبا بالعالم");
        assert_eq!(to_logical("ابحرم", Dir::Rtl), "مرحبا");
    }

    #[test]
    fn w5_percent_after_arabic_word() {
        // Logical: digits after an Arabic letter are AN (W2): % is displayed on the left.
        let logical = "ارتفع بنسبة 50%";
        let visual = logical_to_visual(logical, Some(Dir::Rtl));
        assert!(visual.starts_with("%50 ة"), "visual was {visual}");
        // Without the fix the involution produces "%50".
        let chars: Vec<char> = visual.chars().collect();
        let s: String = chars.iter().collect();
        let naive_info = ParagraphBidiInfo::new(&s, Some(Level::rtl()));
        let naive = naive_info.reorder_line(0..s.len()).into_owned();
        assert_ne!(naive, logical, "unicode-bidi alone does not restore it");
        assert_eq!(to_logical(&visual, Dir::Rtl), logical);
    }

    #[test]
    fn w5_dates_and_currency() {
        for logical in [
            "صدر في 2024-06-01 رسميا",
            "السعر 25$ فقط",
            "ارتفع بنسبة 3.5% خلال العام",
            "الرقم 1,250,000 مستخدم",
            "خصم 50٪ اليوم",
            "بلغ ٣٥٪ تقريبا",
            "ارتفع بنسبة 3.5%",
            "صدر في 2024-06-01",
            "السعر 25$",
            "بنسبة 50% من",
        ] {
            assert_eq!(roundtrip(logical, Dir::Rtl), logical, "{logical}");
        }
    }

    #[test]
    fn european_numbers_that_really_are_en_keep_w5() {
        for (logical, para) in [
            ("50% من الطلاب", Dir::Rtl),
            ("كلمة ABC 50", Dir::Rtl),
            ("Price: 50 السعر", Dir::Ltr),
            ("Version 2.5 released", Dir::Ltr),
            ("Growth was 35% in 2024", Dir::Ltr),
        ] {
            assert_eq!(roundtrip(logical, para), logical, "{logical}");
        }
    }

    #[test]
    fn mixed_scripts() {
        for logical in [
            "استخدم فريق ZOOD PDF مكتبة Rust لبناء المحرك",
            "أصدر النسخة 2.5 في 15 مارس 2025",
            "اتصل على 920012345 أو ٠٥٠١٢٣٤٥٦٧ الآن",
        ] {
            assert_eq!(roundtrip(logical, Dir::Rtl), logical, "{logical}");
        }
    }

    #[test]
    fn direction_detection() {
        assert_eq!(detect_direction(["hello مرحبا بكم"]), Dir::Rtl);
        assert_eq!(detect_direction(["hello world مرحبا"]), Dir::Ltr);
        assert_eq!(detect_direction(["١٢٣"]), Dir::Rtl);
        assert_eq!(detect_direction(["123"]), Dir::Ltr);
    }

    #[test]
    fn ambiguous_visual_orders_are_documented() {
        // In an LTR paragraph "Price: السعر 50%" and "Price: 50 السعر%" have the same visual
        // order (W7 makes the second one's digits L). Visual text cannot tell them apart; we
        // return the reading where the number follows the Latin text.
        let a = logical_to_visual("Price: السعر 50%", Some(Dir::Ltr));
        let b = logical_to_visual("Price: 50 السعر%", Some(Dir::Ltr));
        assert_eq!(a, b);
    }

    #[test]
    fn proxies() {
        assert_eq!(proxy_char("لا"), 'ل');
        assert_eq!(proxy_char("12"), '1');
        assert_eq!(proxy_char("\u{064E}"), '\u{064E}');
        assert_eq!(proxy_char("\n"), ' ');
    }
}
