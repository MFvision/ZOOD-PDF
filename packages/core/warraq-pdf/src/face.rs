//! The face a piece of text was set in, as the file names it: its family,
//! weight, slant and whether it is a serif or a sans. An editor that
//! replaces a paragraph needs it to choose a font that matches — one
//! installed on the device, the same family from an open library, or the
//! closest face it carries — instead of always drawing in the same one.
//!
//! A PDF embeds a subset of a font under a name like
//! `ABCDEF+Montserrat-SemiBold`. The name is the best witness there is; the
//! font descriptor (`/FontFamily`, `/FontWeight`, `/ItalicAngle`, `/Flags`)
//! fills in what the name does not say. The flags are often wrong — many
//! producers write the same ones for every font — so they are asked last.
//!
//! Everything here is read from a file that may be hostile: names are cut to
//! letters, digits, spaces and hyphens and to 64 characters before a host
//! ever puts one in a path or an address, and nothing loops without a bound.
use lopdf::{Dictionary, Document, Object};

/// The longest family name a host is handed.
pub const MAX_FAMILY_CHARS: usize = 64;

/// Serif or sans, when it can be told.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FaceClass {
    Serif,
    Sans,
    Unknown,
}

impl FaceClass {
    /// The word every host uses for it.
    pub fn as_str(self) -> &'static str {
        match self {
            FaceClass::Serif => "serif",
            FaceClass::Sans => "sans",
            FaceClass::Unknown => "unknown",
        }
    }
}

/// The face text was set in.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct OriginalFace {
    /// The family, sanitised: letters, digits, spaces and hyphens, at most
    /// [`MAX_FAMILY_CHARS`] characters. Never empty.
    pub family: String,
    /// 100–900, in hundreds.
    pub weight: u16,
    pub italic: bool,
    pub class: FaceClass,
}

/// What a `/BaseFont` says by itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NameParts {
    /// Sanitised; empty when the name held nothing usable.
    pub family: String,
    /// The weight, when the name states one.
    pub weight: Option<u16>,
    pub italic: bool,
}

/// Letters, digits, spaces and hyphens only, runs of spaces made one, cut to
/// [`MAX_FAMILY_CHARS`]. Anything else — a slash, a dot, a control
/// character, a percent sign — becomes a space, so a name can never climb
/// out of a folder or change an address.
pub fn sanitize_family(name: &str) -> String {
    let mut out = String::new();
    let mut count = 0;
    let mut pending_space = false;
    for c in name.chars() {
        let keep = c.is_alphanumeric() || c == '-';
        if !keep {
            pending_space = true;
            continue;
        }
        if pending_space && !out.is_empty() {
            if count + 1 >= MAX_FAMILY_CHARS {
                break;
            }
            out.push(' ');
            count += 1;
        }
        pending_space = false;
        if count >= MAX_FAMILY_CHARS {
            break;
        }
        out.push(c);
        count += 1;
    }
    out.trim_matches(|c| c == '-' || c == ' ').to_string()
}

/// Takes `word` off the end of `name` when it stands there as a word of its
/// own: after a separator, or — in a name written without spaces — starting
/// with a capital after a small letter or a digit (`CalibriBold`, not the
/// `light` of `Highlight`).
fn strip_word<'a>(name: &'a str, word: &str) -> Option<&'a str> {
    if name.len() < word.len() || !name.is_char_boundary(name.len() - word.len()) {
        return None;
    }
    let (head, tail) = name.split_at(name.len() - word.len());
    if !tail.eq_ignore_ascii_case(word) {
        return None;
    }
    let before = head.chars().next_back();
    let own_word = match before {
        None => true,
        Some('-' | ',' | ' ' | '_') => true,
        Some(c) => {
            tail.starts_with(|t: char| t.is_ascii_uppercase())
                && (c.is_lowercase() || c.is_ascii_digit())
        }
    };
    own_word.then_some(head)
}

fn trim_separators(name: &str) -> &str {
    name.trim_end_matches(['-', ',', ' ', '_'])
}

/// `TimesNewRoman` → `Times New Roman`, `IBMPlexSans` → `IBM Plex Sans`,
/// `SourceSans3` → `Source Sans 3`. Names already written with spaces come
/// back as they are.
fn split_words(name: &str) -> String {
    let chars: Vec<char> = name.chars().collect();
    let mut out = String::with_capacity(name.len() + 8);
    for (i, &c) in chars.iter().enumerate() {
        if i > 0 {
            let prev = chars[i - 1];
            let next = chars.get(i + 1).copied();
            let boundary = (prev.is_lowercase() && c.is_uppercase())
                || (prev.is_uppercase()
                    && c.is_uppercase()
                    && next.is_some_and(|n| n.is_lowercase()))
                || (prev.is_alphabetic() && c.is_ascii_digit())
                || (prev.is_ascii_digit() && c.is_alphabetic() && c.is_uppercase());
            if boundary {
                out.push(' ');
            }
        }
        out.push(c);
    }
    out
}

/// Reads a `/BaseFont`: the subset tag off, the style words off the end —
/// `-SemiBold`, `,BoldItalic`, `-BoldMT`, `PS-ItalicMT` — and what is left
/// is the family.
pub fn parse_base_font(base: &str) -> NameParts {
    // Bounded before anything else: a name can be as long as the file.
    let base: String = base.chars().take(256).collect();
    // `ABCDEF+`: six capitals mark a subset.
    let mut name = match base.split_once('+') {
        Some((tag, rest)) if tag.len() == 6 && tag.bytes().all(|b| b.is_ascii_uppercase()) => rest,
        _ => base.as_str(),
    };
    // A CID font's Type0 name ends with its CMap's.
    for cmap in ["-Identity-H", "-Identity-V"] {
        if let Some(head) = name.strip_suffix(cmap) {
            name = head;
        }
    }
    let mut weight: Option<u16> = None;
    let mut italic = false;
    name = trim_separators(name);
    // Style words come off the end one at a time, in any order. The bound
    // is generous: no real name carries more than a handful.
    'words: for _ in 0..12 {
        // What foundries add to a PostScript name and no family has.
        for tail in ["PSMT", "MT", "PS"] {
            if let Some(head) = name.strip_suffix(tail) {
                if head.chars().next_back().is_some_and(|c| c.is_alphabetic()) {
                    name = trim_separators(head);
                    continue 'words;
                }
            }
        }
        for word in ["Italic", "Oblique", "Ital"] {
            if let Some(head) = strip_word(name, word) {
                italic = true;
                name = trim_separators(head);
                continue 'words;
            }
        }
        // `It` only as a style of its own (`Minion-It`, `-BoldIt`): never
        // the end of a family such as `Kermit`.
        if let Some(head) = name.strip_suffix("It") {
            let styled = head.ends_with('-')
                || ["Bold", "Light", "Medium", "Black", "Semibold", "Regular"]
                    .iter()
                    .any(|w| head.ends_with(w));
            if styled && head.contains('-') {
                italic = true;
                name = trim_separators(head);
                continue 'words;
            }
        }
        const WEIGHTS: [(&str, u16); 21] = [
            ("ExtraLight", 200),
            ("UltraLight", 200),
            ("ExtraBold", 800),
            ("UltraBold", 800),
            ("SemiBold", 600),
            ("DemiBold", 600),
            ("Hairline", 100),
            ("Regular", 400),
            ("Medium", 500),
            ("Normal", 400),
            ("Light", 300),
            ("Roman", 400),
            ("Black", 900),
            ("Heavy", 900),
            ("Thin", 100),
            ("Bold", 700),
            ("Book", 400),
            ("Demi", 600),
            ("Semi", 600),
            ("Extra", 0),
            ("Ultra", 0),
        ];
        for (word, value) in WEIGHTS {
            let Some(head) = strip_word(name, word) else {
                continue;
            };
            // `Roman`, `Book` and `Normal` are a style only after a hyphen
            // or a comma (`Times-Roman`): Times New Roman keeps its name.
            if matches!(word, "Roman" | "Book" | "Normal") && !head.ends_with(['-', ',']) {
                continue;
            }
            // `Semi Bold`, `Extra-Light`: the second word was read first.
            let value = match (word, weight) {
                ("Semi" | "Demi", Some(700)) => 600,
                ("Extra" | "Ultra", Some(700)) => 800,
                ("Extra" | "Ultra", Some(300)) => 200,
                // On their own they are part of the family's name.
                ("Semi" | "Demi" | "Extra" | "Ultra", _) => continue,
                _ => value,
            };
            // The word nearest the family wins only when nothing was read:
            // `Roman` and `Regular` never undo a `Bold` after them.
            if weight.is_none() || !matches!(word, "Regular" | "Normal" | "Roman" | "Book") {
                weight = Some(value);
            }
            name = trim_separators(head);
            continue 'words;
        }
        break;
    }
    NameParts {
        family: sanitize_family(&split_words(name)),
        weight,
        italic,
    }
}

/// Families whose class is known whatever the file's flags say: the ones
/// documents are set in most, Arabic and Latin. Matched on the family in
/// small letters without spaces, as a prefix.
const SANS: &[&str] = &[
    "arial",
    "helvetica",
    "calibri",
    "verdana",
    "tahoma",
    "segoe",
    "trebuchet",
    "roboto",
    "montserrat",
    "inter",
    "opensans",
    "lato",
    "poppins",
    "nunito",
    "raleway",
    "ubuntu",
    "worksans",
    "dmsans",
    "manrope",
    "sfpro",
    "sfui",
    "sfarabic",
    "myriad",
    "frutiger",
    "futura",
    "gillsans",
    "franklingothic",
    "centurygothic",
    "avenir",
    "gotham",
    "proximanova",
    "cairo",
    "tajawal",
    "almarai",
    "dubai",
    "vazir",
    "ibmplexsans",
    "dinnext",
    "dinarabic",
    "geeza",
    "frutigerltarabic",
    "helveticaneue",
    "liberationsans",
    "dejavusans",
    "carlito",
    "arimo",
];
const SERIF: &[&str] = &[
    "times",
    "georgia",
    "cambria",
    "garamond",
    "palatino",
    "bookantiqua",
    "baskerville",
    "minion",
    "didot",
    "bodoni",
    "century",
    "constantia",
    "courier",
    "merriweather",
    "playfair",
    "lora",
    "ptserif",
    "librebaskerville",
    "ebgaramond",
    "crimson",
    "amiri",
    "scheherazade",
    "lateef",
    "traditionalarabic",
    "simplifiedarabic",
    "arabictypesetting",
    "sakkalmajalla",
    "aldhabi",
    "adobearabic",
    "albayan",
    "baghdad",
    "kfgqpc",
    "lotus",
    "mylotus",
    "liberationserif",
    "dejavuserif",
    "tinos",
    "cmr",
];

/// Serif or sans from the family's name alone.
pub fn class_from_family(family: &str) -> FaceClass {
    let flat: String = family
        .chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect();
    // The name says it itself more often than any table: Noto Sans Arabic,
    // Noto Naskh Arabic, PT Serif, Noto Kufi Arabic.
    if flat.contains("sans") || flat.contains("kufi") || flat.contains("gothic") {
        return FaceClass::Sans;
    }
    if flat.contains("serif") || flat.contains("naskh") || flat.contains("nastaliq") {
        return FaceClass::Serif;
    }
    // The longest name that matches decides: `century` is a serif and
    // `centurygothic` is not.
    let best = |list: &[&str]| {
        list.iter()
            .filter(|p| flat.starts_with(**p))
            .map(|p| p.len())
            .max()
            .unwrap_or(0)
    };
    let (sans, serif) = (best(SANS), best(SERIF));
    if sans == 0 && serif == 0 {
        FaceClass::Unknown
    } else if sans >= serif {
        FaceClass::Sans
    } else {
        FaceClass::Serif
    }
}

fn resolve<'a>(doc: &'a Document, o: &'a Object) -> &'a Object {
    match o {
        Object::Reference(id) => doc.get_object(*id).unwrap_or(o),
        other => other,
    }
}

fn number(doc: &Document, o: &Object) -> Option<f32> {
    match resolve(doc, o) {
        Object::Integer(i) => Some(*i as f32),
        Object::Real(r) if r.is_finite() => Some(*r),
        _ => None,
    }
}

/// A name or a string as text: UTF-16 with its mark, else UTF-8, else
/// byte for byte.
fn text_of(doc: &Document, o: &Object) -> Option<String> {
    let bytes: &[u8] = match resolve(doc, o) {
        Object::Name(n) => n,
        Object::String(s, _) => s,
        _ => return None,
    };
    let bytes = &bytes[..bytes.len().min(1024)];
    if let Some(utf16) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        let units: Vec<u16> = utf16
            .chunks(2)
            .filter_map(|p| Some(u16::from_be_bytes([*p.first()?, *p.get(1)?])))
            .collect();
        return Some(String::from_utf16_lossy(&units));
    }
    Some(String::from_utf8_lossy(bytes).into_owned())
}

/// The face a font dictionary describes; `None` when it names none (a
/// Type 3 font, a dictionary that is not a font).
pub fn face_of(doc: &Document, font: &Dictionary) -> Option<OriginalFace> {
    // A composite font's descriptor is its descendant's.
    let descendant = font
        .get(b"DescendantFonts")
        .ok()
        .map(|k| resolve(doc, k))
        .and_then(|k| k.as_array().ok())
        .and_then(|k| k.first())
        .map(|k| resolve(doc, k))
        .and_then(|k| k.as_dict().ok());
    let descriptor = descendant
        .unwrap_or(font)
        .get(b"FontDescriptor")
        .ok()
        .map(|d| resolve(doc, d))
        .and_then(|d| d.as_dict().ok());
    let base = font
        .get(b"BaseFont")
        .ok()
        .and_then(|b| text_of(doc, b))
        .or_else(|| {
            descriptor
                .and_then(|d| d.get(b"FontName").ok())
                .and_then(|n| text_of(doc, n))
        })
        .unwrap_or_default();
    let name = parse_base_font(&base);
    let family = if name.family.is_empty() {
        descriptor
            .and_then(|d| d.get(b"FontFamily").ok())
            .and_then(|f| text_of(doc, f))
            .map(|f| sanitize_family(&f))
            .unwrap_or_default()
    } else {
        name.family
    };
    if family.is_empty() {
        return None;
    }
    let flags = descriptor
        .and_then(|d| d.get(b"Flags").ok())
        .and_then(|f| number(doc, f))
        .map(|f| f as i64)
        .unwrap_or(0);
    let weight = name
        .weight
        .or_else(|| {
            descriptor
                .and_then(|d| d.get(b"FontWeight").ok())
                .and_then(|w| number(doc, w))
                .filter(|w| (100.0..=900.0).contains(w))
                .map(|w| ((w / 100.0).round() as u16) * 100)
        })
        // Bit 19, ForceBold.
        .unwrap_or(if flags & (1 << 18) != 0 { 700 } else { 400 });
    let angle = descriptor
        .and_then(|d| d.get(b"ItalicAngle").ok())
        .and_then(|a| number(doc, a));
    let italic = name.italic
        || match angle {
            Some(a) => a.abs() > 0.5,
            // Bit 7, Italic: only when the angle is not given at all.
            None => flags & (1 << 6) != 0,
        };
    let class = match class_from_family(&family) {
        // Bit 2, Serif. Unset says nothing: most producers never set it.
        FaceClass::Unknown if flags & (1 << 1) != 0 => FaceClass::Serif,
        known => known,
    };
    Some(OriginalFace {
        family,
        weight: weight.clamp(100, 900),
        italic,
        class,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::dictionary;

    fn parts(family: &str, weight: Option<u16>, italic: bool) -> NameParts {
        NameParts {
            family: family.into(),
            weight,
            italic,
        }
    }

    #[test]
    fn a_subset_tag_and_a_style_come_off_the_name() {
        assert_eq!(
            parse_base_font("ABCDEF+Montserrat-SemiBold"),
            parts("Montserrat", Some(600), false)
        );
        assert_eq!(
            parse_base_font("Montserrat-Regular"),
            parts("Montserrat", Some(400), false)
        );
        assert_eq!(parse_base_font("Cairo"), parts("Cairo", None, false));
        // Six letters that are not all capitals are no tag.
        assert_eq!(
            parse_base_font("Abcdef+Lato"),
            parts("Abcdef Lato", None, false)
        );
    }

    #[test]
    fn weights_are_read_in_every_spelling() {
        for (name, weight) in [
            ("Roboto-Thin", 100),
            ("Roboto-ExtraLight", 200),
            ("Roboto-UltraLight", 200),
            ("Roboto-Light", 300),
            ("Roboto-Book", 400),
            ("Roboto-Medium", 500),
            ("Roboto-DemiBold", 600),
            ("Roboto-Semibold", 600),
            ("Roboto-Bold", 700),
            ("Roboto-ExtraBold", 800),
            ("Roboto-Black", 900),
            ("Roboto-Heavy", 900),
            ("Roboto Semi Bold", 600),
            ("Roboto-Extra-Light", 200),
            ("Roboto,Bold", 700),
            ("RobotoBold", 700),
        ] {
            assert_eq!(
                parse_base_font(name),
                parts("Roboto", Some(weight), false),
                "{name}"
            );
        }
    }

    #[test]
    fn italics_are_read_in_every_spelling() {
        assert_eq!(
            parse_base_font("XYZABC+OpenSans-BoldItalic"),
            parts("Open Sans", Some(700), true)
        );
        assert_eq!(
            parse_base_font("Helvetica-Oblique"),
            parts("Helvetica", None, true)
        );
        assert_eq!(
            parse_base_font("MyriadPro-BoldIt"),
            parts("Myriad Pro", Some(700), true)
        );
        assert_eq!(parse_base_font("Arial,Italic"), parts("Arial", None, true));
        // A family that only ends like a style keeps its name.
        assert_eq!(parse_base_font("Kermit"), parts("Kermit", None, false));
        assert_eq!(
            parse_base_font("Highlight"),
            parts("Highlight", None, false)
        );
    }

    #[test]
    fn the_names_windows_and_foundries_write_are_understood() {
        assert_eq!(parse_base_font("ArialMT"), parts("Arial", None, false));
        assert_eq!(
            parse_base_font("Arial-BoldMT"),
            parts("Arial", Some(700), false)
        );
        assert_eq!(
            parse_base_font("TimesNewRomanPS-BoldItalicMT"),
            parts("Times New Roman", Some(700), true)
        );
        assert_eq!(
            parse_base_font("TimesNewRomanPSMT"),
            parts("Times New Roman", None, false)
        );
        assert_eq!(
            parse_base_font("IBMPlexSansArabic-Medium"),
            parts("IBM Plex Sans Arabic", Some(500), false)
        );
        assert_eq!(
            parse_base_font("SourceSans3-Regular"),
            parts("Source Sans 3", Some(400), false)
        );
        assert_eq!(
            parse_base_font("AAAAAA+NotoNaskhArabic-Bold-Identity-H"),
            parts("Noto Naskh Arabic", Some(700), false)
        );
        assert_eq!(
            parse_base_font("Times-Roman"),
            parts("Times", Some(400), false)
        );
    }

    #[test]
    fn an_arabic_name_is_kept() {
        assert_eq!(
            parse_base_font("ABCDEF+الخط العربي-Bold"),
            parts("الخط العربي", Some(700), false)
        );
        assert_eq!(parse_base_font("نسخ"), parts("نسخ", None, false));
    }

    #[test]
    fn a_hostile_name_cannot_leave_a_folder_or_an_address() {
        let got = parse_base_font("../../etc/passwd%00?x=1&y=#frag\\..\\win.ini\n\u{202E}");
        assert_eq!(got.family, "etc passwd 00 x 1 y frag win ini");
        assert!(got
            .family
            .chars()
            .all(|c| c.is_alphanumeric() || c == ' ' || c == '-'));
        // Nothing usable: no family at all.
        assert_eq!(parse_base_font("../..//").family, "");
        assert_eq!(parse_base_font("").family, "");
        assert_eq!(parse_base_font("-Bold").family, "");
        // As long as the file allows: cut, never a panic.
        let long = "A".repeat(100_000);
        assert_eq!(
            parse_base_font(&long).family.chars().count(),
            MAX_FAMILY_CHARS
        );
        let long_arabic = "خ ".repeat(50_000);
        assert!(parse_base_font(&long_arabic).family.chars().count() <= MAX_FAMILY_CHARS);
        assert!(sanitize_family(&"ab ".repeat(100)).chars().count() <= MAX_FAMILY_CHARS);
    }

    #[test]
    fn the_class_comes_from_the_family_when_it_is_known() {
        for (family, class) in [
            ("Montserrat", FaceClass::Sans),
            ("Arial", FaceClass::Sans),
            ("Cairo", FaceClass::Sans),
            ("Noto Sans Arabic", FaceClass::Sans),
            ("Noto Kufi Arabic", FaceClass::Sans),
            ("Century Gothic", FaceClass::Sans),
            ("Times New Roman", FaceClass::Serif),
            ("Amiri", FaceClass::Serif),
            ("Noto Naskh Arabic", FaceClass::Serif),
            ("Century Schoolbook", FaceClass::Serif),
            ("PT Serif", FaceClass::Serif),
            ("Wingbats Unheard Of", FaceClass::Unknown),
        ] {
            assert_eq!(class_from_family(family), class, "{family}");
        }
    }

    #[test]
    fn the_descriptor_fills_in_what_the_name_leaves_out() {
        let mut doc = Document::with_version("1.7");
        let descriptor = doc.add_object(dictionary! {
            "Type" => "FontDescriptor", "FontName" => "ABCDEF+Unheardof",
            "Flags" => 2 | 4, "FontWeight" => 600, "ItalicAngle" => -12,
        });
        let font = dictionary! {
            "Type" => "Font", "Subtype" => "TrueType", "BaseFont" => "ABCDEF+Unheardof",
            "FontDescriptor" => descriptor,
        };
        assert_eq!(
            face_of(&doc, &font),
            Some(OriginalFace {
                family: "Unheardof".into(),
                weight: 600,
                italic: true,
                class: FaceClass::Serif,
            })
        );
        // The name wins where both speak.
        let font = dictionary! {
            "Type" => "Font", "Subtype" => "TrueType", "BaseFont" => "Montserrat-Bold",
            "FontDescriptor" => descriptor,
        };
        let face = face_of(&doc, &font).unwrap();
        assert_eq!((face.weight, face.class), (700, FaceClass::Sans));
    }

    #[test]
    fn a_composite_font_is_read_through_its_descendant() {
        let mut doc = Document::with_version("1.7");
        let descriptor = doc.add_object(dictionary! {
            "Type" => "FontDescriptor", "FontName" => "QWERTY+Tajawal-Medium",
            "Flags" => 4, "ItalicAngle" => 0,
        });
        let cid = doc.add_object(dictionary! {
            "Type" => "Font", "Subtype" => "CIDFontType2",
            "BaseFont" => "QWERTY+Tajawal-Medium", "FontDescriptor" => descriptor,
        });
        let font = dictionary! {
            "Type" => "Font", "Subtype" => "Type0", "BaseFont" => "QWERTY+Tajawal-Medium",
            "Encoding" => "Identity-H",
            "DescendantFonts" => vec![Object::Reference(cid)],
        };
        assert_eq!(
            face_of(&doc, &font),
            Some(OriginalFace {
                family: "Tajawal".into(),
                weight: 500,
                italic: false,
                class: FaceClass::Sans,
            })
        );
    }

    #[test]
    fn a_font_without_a_name_has_no_face_and_bad_values_do_no_harm() {
        let doc = Document::with_version("1.7");
        let type3 = dictionary! { "Type" => "Font", "Subtype" => "Type3" };
        assert_eq!(face_of(&doc, &type3), None);
        // A descriptor that points nowhere, a weight out of range, a flag
        // field that is a name: read as if they were not there.
        let font = dictionary! {
            "Type" => "Font", "Subtype" => "TrueType", "BaseFont" => "Lato",
            "FontDescriptor" => Object::Reference((9999, 0)),
        };
        assert_eq!(face_of(&doc, &font).map(|f| f.weight), Some(400));
        let font = dictionary! {
            "Type" => "Font", "Subtype" => "TrueType", "BaseFont" => "Lato",
            "FontDescriptor" => dictionary! {
                "FontWeight" => 123456789, "Flags" => "Bold", "ItalicAngle" => Object::Null,
            },
        };
        let face = face_of(&doc, &font).unwrap();
        assert_eq!((face.weight, face.italic), (400, false));
    }
}
