//! Simple-font encodings (WinAnsi, MacRoman, Standard) and glyph-name → Unicode mapping
//! (an Adobe Glyph List subset: Latin, WinAnsi names, `uniXXXX` / `uXXXX[XX]`, ligature
//! `_` components, `.suffix` variants, Arabic `afii57xxx` names and the descriptive Arabic
//! names used by fonts such as Amiri and Noto, e.g. `lam-ar.init`, `lam_alef-ar`).

use std::collections::HashMap;
use std::sync::OnceLock;

/// Base encodings a simple font can name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BaseEncoding {
    Standard,
    WinAnsi,
    MacRoman,
    /// Symbolic font without an encoding: codes are taken as Latin-1.
    Builtin,
}

impl BaseEncoding {
    pub fn from_name(name: &[u8]) -> Option<BaseEncoding> {
        match name {
            b"WinAnsiEncoding" => Some(BaseEncoding::WinAnsi),
            b"MacRomanEncoding" => Some(BaseEncoding::MacRoman),
            b"StandardEncoding" => Some(BaseEncoding::Standard),
            _ => None,
        }
    }

    /// Unicode for a one-byte code.
    pub fn decode(self, code: u8) -> Option<char> {
        match self {
            BaseEncoding::WinAnsi => win_ansi(code),
            BaseEncoding::MacRoman => mac_roman(code),
            BaseEncoding::Standard => standard(code),
            BaseEncoding::Builtin => latin1(code),
        }
    }
}

fn latin1(code: u8) -> Option<char> {
    if code < 0x20 {
        None
    } else {
        Some(char::from(code))
    }
}

const WIN_ANSI_80: [u16; 32] = [
    0x20AC, 0, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039,
    0x0152, 0, 0x017D, 0, 0, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC,
    0x2122, 0x0161, 0x203A, 0x0153, 0, 0x017E, 0x0178,
];

fn win_ansi(code: u8) -> Option<char> {
    match code {
        0x20..=0x7e | 0xa0..=0xff => Some(char::from(code)),
        0x80..=0x9f => {
            let u = WIN_ANSI_80
                .get(usize::from(code - 0x80))
                .copied()
                .unwrap_or(0);
            if u == 0 {
                None
            } else {
                char::from_u32(u32::from(u))
            }
        }
        _ => None,
    }
}

const MAC_ROMAN_80: [u16; 128] = [
    0xC4, 0xC5, 0xC7, 0xC9, 0xD1, 0xD6, 0xDC, 0xE1, 0xE0, 0xE2, 0xE4, 0xE3, 0xE5, 0xE7, 0xE9, 0xE8,
    0xEA, 0xEB, 0xED, 0xEC, 0xEE, 0xEF, 0xF1, 0xF3, 0xF2, 0xF4, 0xF6, 0xF5, 0xFA, 0xF9, 0xFB, 0xFC,
    0x2020, 0xB0, 0xA2, 0xA3, 0xA7, 0x2022, 0xB6, 0xDF, 0xAE, 0xA9, 0x2122, 0xB4, 0xA8, 0x2260,
    0xC6, 0xD8, 0x221E, 0xB1, 0x2264, 0x2265, 0xA5, 0xB5, 0x2202, 0x2211, 0x220F, 0x3C0, 0x222B,
    0xAA, 0xBA, 0x3A9, 0xE6, 0xF8, 0xBF, 0xA1, 0xAC, 0x221A, 0x192, 0x2248, 0x2206, 0xAB, 0xBB,
    0x2026, 0xA0, 0xC0, 0xC3, 0xD5, 0x152, 0x153, 0x2013, 0x2014, 0x201C, 0x201D, 0x2018, 0x2019,
    0xF7, 0x25CA, 0xFF, 0x178, 0x2044, 0x20AC, 0x2039, 0x203A, 0xFB01, 0xFB02, 0x2021, 0xB7,
    0x201A, 0x201E, 0x2030, 0xC2, 0xCA, 0xC1, 0xCB, 0xC8, 0xCD, 0xCE, 0xCF, 0xCC, 0xD3, 0xD4,
    0xF8FF, 0xD2, 0xDA, 0xDB, 0xD9, 0x131, 0x2C6, 0x2DC, 0xAF, 0x2D8, 0x2D9, 0x2DA, 0xB8, 0x2DD,
    0x2DB, 0x2C7,
];

fn mac_roman(code: u8) -> Option<char> {
    match code {
        0x20..=0x7e => Some(char::from(code)),
        0x80..=0xff => MAC_ROMAN_80
            .get(usize::from(code - 0x80))
            .and_then(|&u| char::from_u32(u32::from(u))),
        _ => None,
    }
}

fn standard(code: u8) -> Option<char> {
    let u: u32 = match code {
        0x27 => 0x2019,
        0x60 => 0x2018,
        0x20..=0x7e => u32::from(code),
        0xa1 => 0xa1,
        0xa2 => 0xa2,
        0xa3 => 0xa3,
        0xa4 => 0x2044,
        0xa5 => 0xa5,
        0xa6 => 0x192,
        0xa7 => 0xa7,
        0xa8 => 0xa4,
        0xa9 => 0x27,
        0xaa => 0x201c,
        0xab => 0xab,
        0xac => 0x2039,
        0xad => 0x203a,
        0xae => 0xfb01,
        0xaf => 0xfb02,
        0xb1 => 0x2013,
        0xb2 => 0x2020,
        0xb3 => 0x2021,
        0xb4 => 0xb7,
        0xb6 => 0xb6,
        0xb7 => 0x2022,
        0xb8 => 0x201a,
        0xb9 => 0x201e,
        0xba => 0x201d,
        0xbb => 0xbb,
        0xbc => 0x2026,
        0xbd => 0x2030,
        0xbf => 0xbf,
        0xc1 => 0x60,
        0xc2 => 0xb4,
        0xc3 => 0x2c6,
        0xc4 => 0x2dc,
        0xc5 => 0xaf,
        0xc6 => 0x2d8,
        0xc7 => 0x2d9,
        0xc8 => 0xa8,
        0xca => 0x2da,
        0xcb => 0xb8,
        0xcd => 0x2dd,
        0xce => 0x2db,
        0xcf => 0x2c7,
        0xd0 => 0x2014,
        0xe1 => 0xc6,
        0xe3 => 0xaa,
        0xe8 => 0x141,
        0xe9 => 0xd8,
        0xea => 0x152,
        0xeb => 0xba,
        0xf1 => 0xe6,
        0xf5 => 0x131,
        0xf8 => 0x142,
        0xf9 => 0xf8,
        0xfa => 0x153,
        0xfb => 0xdf,
        _ => return None,
    };
    char::from_u32(u)
}

/// WinAnsi glyph names for codes 0x20..=0xFF ("" = undefined).
const WIN_ANSI_NAMES: [&str; 224] = [
    "space",
    "exclam",
    "quotedbl",
    "numbersign",
    "dollar",
    "percent",
    "ampersand",
    "quotesingle",
    "parenleft",
    "parenright",
    "asterisk",
    "plus",
    "comma",
    "hyphen",
    "period",
    "slash",
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "colon",
    "semicolon",
    "less",
    "equal",
    "greater",
    "question",
    "at",
    "A",
    "B",
    "C",
    "D",
    "E",
    "F",
    "G",
    "H",
    "I",
    "J",
    "K",
    "L",
    "M",
    "N",
    "O",
    "P",
    "Q",
    "R",
    "S",
    "T",
    "U",
    "V",
    "W",
    "X",
    "Y",
    "Z",
    "bracketleft",
    "backslash",
    "bracketright",
    "asciicircum",
    "underscore",
    "grave",
    "a",
    "b",
    "c",
    "d",
    "e",
    "f",
    "g",
    "h",
    "i",
    "j",
    "k",
    "l",
    "m",
    "n",
    "o",
    "p",
    "q",
    "r",
    "s",
    "t",
    "u",
    "v",
    "w",
    "x",
    "y",
    "z",
    "braceleft",
    "bar",
    "braceright",
    "asciitilde",
    "",
    "Euro",
    "",
    "quotesinglbase",
    "florin",
    "quotedblbase",
    "ellipsis",
    "dagger",
    "daggerdbl",
    "circumflex",
    "perthousand",
    "Scaron",
    "guilsinglleft",
    "OE",
    "",
    "Zcaron",
    "",
    "",
    "quoteleft",
    "quoteright",
    "quotedblleft",
    "quotedblright",
    "bullet",
    "endash",
    "emdash",
    "tilde",
    "trademark",
    "scaron",
    "guilsinglright",
    "oe",
    "",
    "zcaron",
    "Ydieresis",
    "nbspace",
    "exclamdown",
    "cent",
    "sterling",
    "currency",
    "yen",
    "brokenbar",
    "section",
    "dieresis",
    "copyright",
    "ordfeminine",
    "guillemotleft",
    "logicalnot",
    "sfthyphen",
    "registered",
    "macron",
    "degree",
    "plusminus",
    "twosuperior",
    "threesuperior",
    "acute",
    "mu",
    "paragraph",
    "periodcentered",
    "cedilla",
    "onesuperior",
    "ordmasculine",
    "guillemotright",
    "onequarter",
    "onehalf",
    "threequarters",
    "questiondown",
    "Agrave",
    "Aacute",
    "Acircumflex",
    "Atilde",
    "Adieresis",
    "Aring",
    "AE",
    "Ccedilla",
    "Egrave",
    "Eacute",
    "Ecircumflex",
    "Edieresis",
    "Igrave",
    "Iacute",
    "Icircumflex",
    "Idieresis",
    "Eth",
    "Ntilde",
    "Ograve",
    "Oacute",
    "Ocircumflex",
    "Otilde",
    "Odieresis",
    "multiply",
    "Oslash",
    "Ugrave",
    "Uacute",
    "Ucircumflex",
    "Udieresis",
    "Yacute",
    "Thorn",
    "germandbls",
    "agrave",
    "aacute",
    "acircumflex",
    "atilde",
    "adieresis",
    "aring",
    "ae",
    "ccedilla",
    "egrave",
    "eacute",
    "ecircumflex",
    "edieresis",
    "igrave",
    "iacute",
    "icircumflex",
    "idieresis",
    "eth",
    "ntilde",
    "ograve",
    "oacute",
    "ocircumflex",
    "otilde",
    "odieresis",
    "divide",
    "oslash",
    "ugrave",
    "uacute",
    "ucircumflex",
    "udieresis",
    "yacute",
    "thorn",
    "ydieresis",
];

const EXTRA_NAMES: &[(&str, u32)] = &[
    ("fi", 0xFB01),
    ("fl", 0xFB02),
    ("ff", 0xFB00),
    ("ffi", 0xFB03),
    ("ffl", 0xFB04),
    ("dotlessi", 0x131),
    ("minus", 0x2212),
    ("fraction", 0x2044),
    ("Lslash", 0x141),
    ("lslash", 0x142),
    ("quoteright", 0x2019),
    ("nonbreakingspace", 0xA0),
    ("uni00A0", 0xA0),
    ("afii61664", 0x200C),
    ("afii301", 0x200D),
    ("afii299", 0x200E),
    ("afii300", 0x200F),
    ("afii57388", 0x060C),
    ("afii57403", 0x061B),
    ("afii57407", 0x061F),
    ("afii57440", 0x0640),
    ("afii57470", 0x0647),
    ("afii57381", 0x066A),
    ("afii63167", 0x066D),
    ("afii57511", 0x0679),
    ("afii57506", 0x067E),
    ("afii57507", 0x0686),
    ("afii57512", 0x0688),
    ("afii57513", 0x0691),
    ("afii57508", 0x0698),
    ("afii57505", 0x06A4),
    ("afii57509", 0x06AF),
    ("afii57514", 0x06BA),
    ("afii57519", 0x06D2),
    ("afii57534", 0x06D5),
];

/// Descriptive Arabic glyph names (without `-ar` suffix and `.form` variants).
const ARABIC_NAMES: &[(&str, u32)] = &[
    ("hamza", 0x0621),
    ("alefmadda", 0x0622),
    ("alefmaddaabove", 0x0622),
    ("alefhamzaabove", 0x0623),
    ("alefhamza", 0x0623),
    ("wawhamzaabove", 0x0624),
    ("wawhamza", 0x0624),
    ("alefhamzabelow", 0x0625),
    ("yehhamzaabove", 0x0626),
    ("yehhamza", 0x0626),
    ("alef", 0x0627),
    ("beh", 0x0628),
    ("tehmarbuta", 0x0629),
    ("teh", 0x062A),
    ("theh", 0x062B),
    ("jeem", 0x062C),
    ("hah", 0x062D),
    ("khah", 0x062E),
    ("dal", 0x062F),
    ("thal", 0x0630),
    ("reh", 0x0631),
    ("zain", 0x0632),
    ("seen", 0x0633),
    ("sheen", 0x0634),
    ("sad", 0x0635),
    ("dad", 0x0636),
    ("tah", 0x0637),
    ("zah", 0x0638),
    ("ain", 0x0639),
    ("ghain", 0x063A),
    ("tatweel", 0x0640),
    ("kashida", 0x0640),
    ("feh", 0x0641),
    ("qaf", 0x0642),
    ("kaf", 0x0643),
    ("lam", 0x0644),
    ("meem", 0x0645),
    ("noon", 0x0646),
    ("heh", 0x0647),
    ("waw", 0x0648),
    ("alefmaksura", 0x0649),
    ("yeh", 0x064A),
    ("fathatan", 0x064B),
    ("dammatan", 0x064C),
    ("kasratan", 0x064D),
    ("fatha", 0x064E),
    ("damma", 0x064F),
    ("kasra", 0x0650),
    ("shadda", 0x0651),
    ("sukun", 0x0652),
    ("alefsuperior", 0x0670),
    ("superscriptalef", 0x0670),
    ("alefwasla", 0x0671),
    ("tteh", 0x0679),
    ("peh", 0x067E),
    ("tcheh", 0x0686),
    ("ddal", 0x0688),
    ("rreh", 0x0691),
    ("jeh", 0x0698),
    ("veh", 0x06A4),
    ("keheh", 0x06A9),
    ("gaf", 0x06AF),
    ("noonghunna", 0x06BA),
    ("hehdoachashmee", 0x06BE),
    ("hehgoal", 0x06C1),
    ("farsiyeh", 0x06CC),
    ("yehfarsi", 0x06CC),
    ("yehbarree", 0x06D2),
    ("fullstop", 0x06D4),
];

/// Names whose meaning changes with an Arabic suffix (`comma-ar` = U+060C).
const ARABIC_SUFFIXED: &[(&str, u32)] = &[
    ("comma", 0x060C),
    ("semicolon", 0x061B),
    ("question", 0x061F),
    ("percent", 0x066A),
    ("period", 0x06D4),
    ("zero", 0x0660),
    ("one", 0x0661),
    ("two", 0x0662),
    ("three", 0x0663),
    ("four", 0x0664),
    ("five", 0x0665),
    ("six", 0x0666),
    ("seven", 0x0667),
    ("eight", 0x0668),
    ("nine", 0x0669),
];

fn name_table() -> &'static HashMap<&'static str, u32> {
    static T: OnceLock<HashMap<&'static str, u32>> = OnceLock::new();
    T.get_or_init(|| {
        let mut m = HashMap::new();
        for (i, name) in WIN_ANSI_NAMES.iter().enumerate() {
            if name.is_empty() {
                continue;
            }
            let code = u8::try_from(i + 0x20).unwrap_or(0);
            if let Some(c) = win_ansi(code) {
                m.entry(*name).or_insert(u32::from(c));
            }
        }
        m.insert("sfthyphen", 0xAD);
        m.insert("nbspace", 0xA0);
        for (n, u) in EXTRA_NAMES.iter().chain(ARABIC_NAMES.iter()) {
            m.entry(*n).or_insert(*u);
        }
        // afii57409..afii57434 = U+0621..U+063A; afii57441..afii57458 = U+0641..U+0652 (except 57447)
        // afii57392..afii57401 = U+0660..U+0669
        m
    })
}

fn afii_arabic(name: &str) -> Option<u32> {
    let n: u32 = name.strip_prefix("afii")?.parse().ok()?;
    match n {
        57409..=57434 => Some(0x0621 + (n - 57409)),
        57441..=57446 => Some(0x0641 + (n - 57441)),
        57448..=57458 => Some(0x0648 + (n - 57448)),
        57392..=57401 => Some(0x0660 + (n - 57392)),
        _ => None,
    }
}

fn hex_codepoints(hex: &str, group: usize) -> Option<String> {
    if hex.is_empty() || hex.len() % group != 0 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let mut out = String::new();
    let mut i = 0;
    while i < hex.len() {
        let part = hex.get(i..i + group)?;
        let v = u32::from_str_radix(part, 16).ok()?;
        // Surrogates are not valid scalar values.
        out.push(char::from_u32(v)?);
        i += group;
    }
    Some(out)
}

fn component_to_unicode(comp: &str) -> Option<String> {
    if comp.is_empty() {
        return None;
    }
    if let Some(hex) = comp.strip_prefix("uni") {
        if let Some(s) = hex_codepoints(hex, 4) {
            return Some(s);
        }
    }
    if let Some(hex) = comp.strip_prefix('u') {
        if (4..=6).contains(&hex.len()) {
            if let Some(s) = hex_codepoints(hex, hex.len()) {
                return Some(s);
            }
        }
    }
    let (base, arabic_suffix) = match comp.rsplit_once('-') {
        Some((b, suf)) if matches!(suf, "ar" | "arab" | "fa" | "ur" | "farsi" | "urdu") => {
            (b, Some(suf))
        }
        _ => (comp, None),
    };
    if let Some(suf) = arabic_suffix {
        if let Some((_, u)) = ARABIC_SUFFIXED.iter().find(|(n, _)| *n == base) {
            let mut u = *u;
            // Persian/Urdu digits.
            if matches!(suf, "fa" | "ur" | "farsi" | "urdu") && (0x0660..=0x0669).contains(&u) {
                u += 0x06F0 - 0x0660;
            }
            return char::from_u32(u).map(String::from);
        }
    }
    if let Some(u) = name_table()
        .get(base)
        .copied()
        .or_else(|| afii_arabic(base))
    {
        return char::from_u32(u).map(String::from);
    }
    None
}

/// Map a glyph name to Unicode text (may be several characters for ligatures).
pub fn glyph_name_to_unicode(name: &str) -> Option<String> {
    if name.is_empty() || name == ".notdef" || name.len() > 256 {
        return None;
    }
    // Drop variant suffix: "lam-ar.init" → "lam-ar", "alef.fina" → "alef".
    let base = name.split('.').next().unwrap_or(name);
    if base.is_empty() {
        return None;
    }
    let mut out = String::new();
    for comp in base.split('_') {
        out.push_str(&component_to_unicode(comp)?);
    }
    Some(out)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    #[test]
    fn base_encodings() {
        assert_eq!(BaseEncoding::WinAnsi.decode(0x80), Some('€'));
        assert_eq!(BaseEncoding::WinAnsi.decode(0xe9), Some('é'));
        assert_eq!(BaseEncoding::WinAnsi.decode(0x81), None);
        assert_eq!(BaseEncoding::MacRoman.decode(0x8e), Some('é'));
        assert_eq!(BaseEncoding::Standard.decode(0x27), Some('\u{2019}'));
        assert_eq!(BaseEncoding::Standard.decode(0xae), Some('\u{FB01}'));
    }

    #[test]
    fn glyph_names() {
        let g = |n: &str| glyph_name_to_unicode(n);
        assert_eq!(g("A").as_deref(), Some("A"));
        assert_eq!(g("eacute").as_deref(), Some("é"));
        assert_eq!(g("uni0627").as_deref(), Some("ا"));
        assert_eq!(g("uni06440627").as_deref(), Some("لا"));
        assert_eq!(g("u1F600").as_deref(), Some("😀"));
        assert_eq!(g("afii57415").as_deref(), Some("ا"));
        assert_eq!(g("afii57470").as_deref(), Some("ه"));
        assert_eq!(g("afii57448").as_deref(), Some("و"));
        assert_eq!(g("afii57394").as_deref(), Some("٢"));
        assert_eq!(g("lam-ar.init").as_deref(), Some("ل"));
        assert_eq!(g("lam_alef-ar.fina").as_deref(), Some("لا"));
        assert_eq!(g("alef.fina").as_deref(), Some("ا"));
        assert_eq!(g("comma-ar").as_deref(), Some("،"));
        assert_eq!(g("four-fa").as_deref(), Some("۴"));
        assert_eq!(g("f_f_i").as_deref(), Some("ffi"));
        assert_eq!(g("uniD800"), None);
        assert_eq!(g(".notdef"), None);
        assert_eq!(g("g123"), None);
    }
}
