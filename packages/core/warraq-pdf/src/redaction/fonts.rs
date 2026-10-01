//! What redaction needs to know of a font: how a string's bytes split into
//! character codes, how far each code moves the pen, and how tall a glyph
//! stands — so each glyph a show operator draws can be put in a box on the
//! page and kept or taken out on its own.
//!
//! Simple fonts take one byte a code and read their advances from
//! `/Widths`; composite fonts split codes by their CMap's codespace ranges
//! (`Identity-H`/`-V`, or a CMap the file embeds) and read advances by CID
//! from `/W` and `/DW`; Type 3 fonts scale theirs by their `/FontMatrix`.
//! A standard font with no `/Widths` takes Adobe's metrics for its face by
//! the glyph names its encoding gives each code (`standard.rs`). Where any
//! of that is missing or cannot be read — another font with no `/Widths`,
//! a predefined CJK CMap — the font is said to be *unsure*: its
//! boxes are guesses, so the redaction takes the whole run out whenever any
//! guess touches a mark rather than trust them to keep a neighbour.
//!
//! Everything read from the file is bounded: a hostile `/W` or CMap is cut
//! short, never followed without end.
use std::collections::BTreeMap;

use lopdf::{Dictionary, Document, Object};

use super::standard;

/// Entries read from a `/W` array or a CMap at most.
const MAX_ENTRIES: usize = 100_000;
/// A CMap stream is read up to this many bytes.
const MAX_CMAP: usize = 4 * 1024 * 1024;

/// How the bytes of a string are cut into codes, and which CID each is.
#[derive(Debug, Clone)]
enum Codes {
    /// One byte a code; the code is the glyph's index into `/Widths`.
    Simple,
    /// Two bytes a code, the code its own CID (`Identity-H`/`-V`).
    Identity,
    /// Codespace ranges `(bytes, low, high)` and CID ranges
    /// `(low, high, first CID)` read from an embedded CMap.
    Table {
        spaces: Vec<(usize, u32, u32)>,
        cids: Vec<(u32, u32, u32)>,
    },
}

/// One code of a string: where its bytes are, and what the font says of it.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Code {
    /// Its bytes within the string.
    pub bytes: std::ops::Range<usize>,
    /// Advance along the writing direction, in text space for a size of 1.
    pub advance: f32,
    /// A one-byte code 32: the word spacing applies to it.
    pub space: bool,
}

#[derive(Debug, Clone)]
pub(super) struct Font {
    codes: Codes,
    /// Simple fonts: the advance of each byte, for a size of 1.
    widths: Vec<f32>,
    /// Composite fonts: advances by CID `(last CID, advance)`, keyed by the
    /// first CID of each run, for a size of 1.
    cid_widths: BTreeMap<u32, (u32, f32)>,
    default_width: f32,
    /// Writing runs down the page (`-V` CMaps, `/WMode 1`).
    pub vertical: bool,
    /// How far above and below the baseline a glyph reaches, for a size of 1.
    pub ascent: f32,
    pub descent: f32,
    /// The advances are guesses: see the module's notes.
    pub unsure: bool,
}

fn resolve<'a>(doc: &'a Document, o: &'a Object) -> &'a Object {
    match o {
        Object::Reference(id) => doc.get_object(*id).unwrap_or(o),
        _ => o,
    }
}

fn dict<'a>(doc: &'a Document, o: Option<&'a Object>) -> Option<&'a Dictionary> {
    o.map(|o| resolve(doc, o)).and_then(|o| o.as_dict().ok())
}

fn number(doc: &Document, o: &Object) -> Option<f32> {
    let v = match resolve(doc, o) {
        Object::Integer(i) => *i as f32,
        Object::Real(r) => *r,
        _ => return None,
    };
    v.is_finite().then_some(v)
}

impl Font {
    /// A font nothing is known of: one byte a code, half an em each, unsure.
    pub fn unknown() -> Self {
        Self {
            codes: Codes::Simple,
            widths: vec![0.5; 256],
            cid_widths: BTreeMap::new(),
            default_width: 0.5,
            vertical: false,
            ascent: 0.9,
            descent: -0.25,
            unsure: true,
        }
    }

    /// Reads the font dictionary `font` (a resource's value).
    pub fn read(doc: &Document, font: &Object) -> Self {
        let Some(d) = dict(doc, Some(font)) else {
            return Self::unknown();
        };
        let subtype = d.get(b"Subtype").and_then(Object::as_name).unwrap_or(b"");
        if subtype == b"Type0" {
            Self::composite(doc, d)
        } else {
            Self::simple(doc, d, subtype == b"Type3")
        }
    }

    fn simple(doc: &Document, d: &Dictionary, type3: bool) -> Self {
        // A Type 3 font's glyph space reaches text space through its matrix;
        // everyone else's is a thousandth of the size.
        let scale = if type3 {
            d.get(b"FontMatrix")
                .ok()
                .map(|m| resolve(doc, m))
                .and_then(|m| m.as_array().ok())
                .and_then(|m| m.first())
                .and_then(|a| number(doc, a))
                .filter(|a| a.abs() > 1e-6 && a.abs() < 10.0)
                .unwrap_or(0.001)
        } else {
            0.001
        };
        let descriptor = dict(doc, d.get(b"FontDescriptor").ok());
        let missing = descriptor
            .and_then(|f| f.get(b"MissingWidth").ok())
            .and_then(|w| number(doc, w))
            .map(|w| w * scale);
        let first = d
            .get(b"FirstChar")
            .ok()
            .and_then(|f| number(doc, f))
            .map(|f| f as i64);
        let list = d
            .get(b"Widths")
            .ok()
            .map(|w| resolve(doc, w))
            .and_then(|w| w.as_array().ok());
        let mut unsure = false;
        let mut widths = vec![missing.unwrap_or(0.0); 256];
        match (first, list) {
            (Some(first), Some(list)) if (0..256).contains(&first) => {
                for (k, w) in list.iter().take(256).enumerate() {
                    let code = first as usize + k;
                    if code < 256 {
                        if let Some(w) = number(doc, w) {
                            widths[code] = (w * scale).clamp(-10.0, 10.0);
                        }
                    }
                }
            }
            // No widths: a standard font, measured by Adobe's metrics, or a
            // broken one, guessed and said so.
            _ => match standard_widths(doc, d) {
                Some(found) => widths = found,
                None => {
                    unsure = true;
                    let mono = d
                        .get(b"BaseFont")
                        .and_then(Object::as_name)
                        .is_ok_and(|n| n.windows(7).any(|w| w == b"Courier"));
                    widths = vec![if mono { 0.6 } else { 0.55 }; 256];
                }
            },
        }
        let (ascent, descent) = if type3 {
            type3_extent(doc, d, scale)
        } else {
            extent(doc, descriptor)
        };
        Self {
            codes: Codes::Simple,
            widths,
            cid_widths: BTreeMap::new(),
            default_width: 0.0,
            vertical: false,
            ascent,
            descent,
            unsure,
        }
    }

    fn composite(doc: &Document, d: &Dictionary) -> Self {
        let mut unsure = false;
        let mut vertical = false;
        let codes = match d.get(b"Encoding").ok().map(|e| resolve(doc, e)) {
            Some(Object::Name(name)) => {
                vertical = name.ends_with(b"-V");
                if name == b"Identity-H" || name == b"Identity-V" {
                    Codes::Identity
                } else {
                    // A predefined CMap (Shift-JIS, GBK…): its tables are not
                    // here, so its codes are taken two bytes at a time and
                    // its boxes are guesses.
                    unsure = true;
                    Codes::Identity
                }
            }
            Some(Object::Stream(stream)) => {
                vertical = stream
                    .dict
                    .get(b"WMode")
                    .ok()
                    .and_then(|w| number(doc, w))
                    .is_some_and(|w| w == 1.0);
                match stream.decompressed_content_with_limit(MAX_CMAP) {
                    Ok(bytes) => match parse_cmap(&bytes) {
                        Some(codes) => codes,
                        None => {
                            unsure = true;
                            Codes::Identity
                        }
                    },
                    Err(_) => {
                        unsure = true;
                        Codes::Identity
                    }
                }
            }
            _ => {
                unsure = true;
                Codes::Identity
            }
        };
        let descendant = d
            .get(b"DescendantFonts")
            .ok()
            .map(|o| resolve(doc, o))
            .and_then(|o| o.as_array().ok())
            .and_then(|a| a.first())
            .and_then(|f| dict(doc, Some(f)));
        let default_width = descendant
            .and_then(|f| f.get(b"DW").ok())
            .and_then(|w| number(doc, w))
            .map(|w| w / 1000.0)
            .unwrap_or(1.0);
        let mut cid_widths = BTreeMap::new();
        if let Some(w) = descendant
            .and_then(|f| f.get(b"W").ok())
            .map(|w| resolve(doc, w))
            .and_then(|w| w.as_array().ok())
        {
            read_w(doc, w, &mut cid_widths);
        }
        if descendant.is_none() {
            unsure = true;
        }
        let (ascent, descent) = extent(
            doc,
            descendant.and_then(|f| dict(doc, f.get(b"FontDescriptor").ok())),
        );
        Self {
            codes,
            widths: Vec::new(),
            cid_widths,
            default_width,
            vertical,
            ascent,
            descent,
            unsure,
        }
    }

    fn cid_width(&self, cid: u32) -> f32 {
        match self.cid_widths.range(..=cid).next_back() {
            Some((_, (last, w))) if cid <= *last => *w,
            _ => self.default_width,
        }
    }

    /// The codes of `bytes`, in order, each with its advance. A vertical
    /// font's advance is the em it moves down (the default `/DW2`): the
    /// glyph is placed by the same amount whatever `/W2` says, which only
    /// the boxes' height would change.
    pub fn codes(&self, bytes: &[u8]) -> Vec<Code> {
        let mut out = Vec::with_capacity(bytes.len());
        let mut i = 0;
        while i < bytes.len() {
            let (len, cid) = match &self.codes {
                Codes::Simple => (1, bytes[i] as u32),
                Codes::Identity => {
                    let len = 2.min(bytes.len() - i);
                    (len, read_code(&bytes[i..i + len]))
                }
                Codes::Table { spaces, cids } => {
                    let len = code_length(spaces, &bytes[i..]);
                    let code = read_code(&bytes[i..i + len]);
                    let cid = cids
                        .iter()
                        .find(|(lo, hi, _)| (*lo..=*hi).contains(&code))
                        .map(|(lo, _, first)| first + (code - lo))
                        .unwrap_or(0);
                    (len, cid)
                }
            };
            let advance = match &self.codes {
                Codes::Simple => self.widths.get(cid as usize).copied().unwrap_or(0.0),
                _ if self.vertical => 1.0,
                _ => self.cid_width(cid),
            };
            out.push(Code {
                bytes: i..i + len,
                advance,
                space: len == 1 && bytes[i] == 32,
            });
            i += len;
        }
        out
    }
}

/// Adobe's widths of one face, by glyph name.
type Widths = &'static [(&'static str, u16)];
/// A glyph name for each code.
type Encoding = [&'static str; 256];

/// The face of the 14 standard fonts a `/BaseFont` names — a subset tag,
/// the names Windows gives them and a `,Bold` style allowed for — with its
/// widths by glyph name and its own encoding (Symbol's and Dingbats').
fn standard_face(base: &[u8]) -> Option<(Widths, Option<&'static Encoding>)> {
    let name = String::from_utf8_lossy(base);
    let name = match name.split_once('+') {
        Some((tag, rest)) if tag.len() == 6 => rest.to_string(),
        _ => name.into_owned(),
    };
    let flat: String = name
        .chars()
        .filter(|c| !matches!(c, ',' | '-' | ' '))
        .collect::<String>()
        .to_ascii_lowercase();
    let bold = flat.contains("bold");
    let slant = flat.contains("italic") || flat.contains("oblique");
    let face = if flat.starts_with("symbol") {
        return Some((standard::SYMBOL, Some(&standard::SYMBOL_ENCODING)));
    } else if flat.starts_with("zapfdingbats") {
        return Some((standard::ZAPF_DING_BATS, Some(&standard::ZAPF_ENCODING)));
    } else if flat.starts_with("courier") {
        match (bold, slant) {
            (false, false) => standard::COURIER,
            (true, false) => standard::COURIER_BOLD,
            (false, true) => standard::COURIER_OBLIQUE,
            (true, true) => standard::COURIER_BOLD_OBLIQUE,
        }
    } else if flat.starts_with("helvetica") || flat.starts_with("arial") {
        match (bold, slant) {
            (false, false) => standard::HELVETICA,
            (true, false) => standard::HELVETICA_BOLD,
            (false, true) => standard::HELVETICA_OBLIQUE,
            (true, true) => standard::HELVETICA_BOLD_OBLIQUE,
        }
    } else if flat.starts_with("times") {
        match (bold, slant) {
            (false, false) => standard::TIMES_ROMAN,
            (true, false) => standard::TIMES_BOLD,
            (false, true) => standard::TIMES_ITALIC,
            (true, true) => standard::TIMES_BOLD_ITALIC,
        }
    } else {
        return None;
    };
    Some((face, None))
}

/// A standard font's advances by code, from its encoding — the face's own,
/// or the one `/Encoding` names, with its `/Differences` — and Adobe's
/// widths; `None` for a font that is not one of the 14.
fn standard_widths(doc: &Document, d: &Dictionary) -> Option<Vec<f32>> {
    let (face, own) = standard_face(d.get(b"BaseFont").and_then(Object::as_name).ok()?)?;
    let named = |n: &[u8]| -> Option<&'static Encoding> {
        match n {
            b"WinAnsiEncoding" => Some(&standard::WIN_ANSI),
            b"MacRomanEncoding" => Some(&standard::MAC_ROMAN),
            b"StandardEncoding" => Some(&standard::STANDARD),
            _ => None,
        }
    };
    let encoding = d.get(b"Encoding").ok().map(|e| resolve(doc, e));
    let base: &[&str; 256] = match encoding {
        Some(Object::Name(n)) => own.or_else(|| named(n)).unwrap_or(&standard::STANDARD),
        Some(Object::Dictionary(e)) => own
            .or_else(|| {
                e.get(b"BaseEncoding")
                    .ok()
                    .and_then(|b| b.as_name().ok())
                    .and_then(named)
            })
            .unwrap_or(&standard::STANDARD),
        _ => own.unwrap_or(&standard::STANDARD),
    };
    let mut names: Vec<String> = base.iter().map(|n| n.to_string()).collect();
    if let Some(Object::Dictionary(e)) = encoding {
        if let Some(differences) = e
            .get(b"Differences")
            .ok()
            .map(|x| resolve(doc, x))
            .and_then(|x| x.as_array().ok())
        {
            let mut code = 0usize;
            for item in differences.iter().take(512) {
                match item {
                    Object::Integer(c) => code = (*c).clamp(0, 255) as usize,
                    Object::Name(n) if code < 256 => {
                        names[code] = String::from_utf8_lossy(n).into_owned();
                        code += 1;
                    }
                    _ => {}
                }
            }
        }
    }
    let width = |name: &str| -> f32 {
        let name = match name {
            "nbspace" => "space",
            "sfthyphen" => "hyphen",
            n => n,
        };
        match face.binary_search_by(|(n, _)| (*n).cmp(name)) {
            Ok(i) => face[i].1 as f32 / 1000.0,
            // A code with no glyph draws `.notdef`, a quarter em.
            Err(_) => 0.25,
        }
    };
    Some(names.iter().map(|n| width(n)).collect())
}

fn read_code(bytes: &[u8]) -> u32 {
    bytes.iter().fold(0u32, |a, b| (a << 8) | *b as u32)
}

/// How many bytes the code at the start of `bytes` takes: the first
/// codespace range it falls in, else the shortest range's length (as a
/// reader skips an unmatched code), never past the end.
fn code_length(spaces: &[(usize, u32, u32)], bytes: &[u8]) -> usize {
    for len in 1..=4.min(bytes.len()) {
        let code = read_code(&bytes[..len]);
        if spaces
            .iter()
            .any(|(n, lo, hi)| *n == len && (*lo..=*hi).contains(&code))
        {
            return len;
        }
    }
    spaces
        .iter()
        .map(|(n, _, _)| *n)
        .min()
        .unwrap_or(2)
        .clamp(1, bytes.len().max(1))
}

/// Advances by CID from a `/W` array: `c [w1 w2 …]` and `c1 c2 w`.
fn read_w(doc: &Document, w: &[Object], out: &mut BTreeMap<u32, (u32, f32)>) {
    let mut i = 0;
    let mut entries = 0;
    while i < w.len() && entries < MAX_ENTRIES {
        let Some(first) = number(doc, &w[i]).filter(|f| *f >= 0.0) else {
            break;
        };
        let first = first as u32;
        match w.get(i + 1).map(|o| resolve(doc, o)) {
            Some(Object::Array(list)) => {
                for (k, v) in list.iter().enumerate().take(MAX_ENTRIES) {
                    if let Some(v) = number(doc, v) {
                        let cid = first.saturating_add(k as u32);
                        out.insert(cid, (cid, v / 1000.0));
                    }
                    entries += 1;
                }
                i += 2;
            }
            Some(last) => {
                let (Some(last), Some(v)) = (
                    number(doc, last).filter(|l| *l >= 0.0),
                    w.get(i + 2).and_then(|v| number(doc, v)),
                ) else {
                    break;
                };
                out.insert(first, ((last as u32).max(first), v / 1000.0));
                entries += 1;
                i += 3;
            }
            None => break,
        }
    }
}

/// How far a glyph reaches above and below the baseline, from the font's
/// descriptor when it says something sensible; never less than a Latin
/// face's, so a box is not smaller than the letters it holds.
fn extent(doc: &Document, descriptor: Option<&Dictionary>) -> (f32, f32) {
    let read = |key: &[u8]| {
        descriptor
            .and_then(|d| d.get(key).ok())
            .and_then(|v| number(doc, v))
            .map(|v| v / 1000.0)
    };
    let ascent = read(b"Ascent")
        .filter(|a| (0.3..2.0).contains(a))
        .unwrap_or(0.9);
    let descent = read(b"Descent")
        .filter(|d| (-1.0..=0.0).contains(d))
        .unwrap_or(-0.25);
    (ascent.max(0.75), descent.min(-0.2))
}

/// A Type 3 font's extent, from its `/FontBBox` through its matrix.
fn type3_extent(doc: &Document, d: &Dictionary, scale: f32) -> (f32, f32) {
    let bbox: Vec<f32> = d
        .get(b"FontBBox")
        .ok()
        .map(|b| resolve(doc, b))
        .and_then(|b| b.as_array().ok())
        .map(|b| b.iter().filter_map(|v| number(doc, v)).collect())
        .unwrap_or_default();
    // The matrix's vertical scale is taken as its horizontal one: the
    // fonts that differ are not worth a box of their own.
    if bbox.len() == 4 {
        let (lo, hi) = (bbox[1].min(bbox[3]) * scale, bbox[1].max(bbox[3]) * scale);
        if hi > lo && (hi - lo) < 5.0 {
            return (hi.max(0.75), lo.min(-0.2));
        }
    }
    (0.9, -0.25)
}

/// The codespace and CID ranges of an embedded CMap, or `None` if it has no
/// codespace to cut codes by.
fn parse_cmap(bytes: &[u8]) -> Option<Codes> {
    let text = String::from_utf8_lossy(bytes);
    let mut spaces = Vec::new();
    let mut cids = Vec::new();
    let mut words = text.split_whitespace();
    let hex = |w: &str| -> Option<(usize, u32)> {
        let inner = w.strip_prefix('<')?.strip_suffix('>')?;
        if inner.is_empty() || inner.len() > 8 {
            return None;
        }
        Some((
            inner.len().div_ceil(2),
            u32::from_str_radix(inner, 16).ok()?,
        ))
    };
    let mut entries = 0;
    while let Some(word) = words.next() {
        if entries > MAX_ENTRIES {
            break;
        }
        match word {
            "begincodespacerange" => {
                while let (Some(a), Some(b)) = (words.next(), words.next()) {
                    if a == "endcodespacerange" {
                        break;
                    }
                    if let (Some((n, lo)), Some((_, hi))) = (hex(a), hex(b)) {
                        spaces.push((n, lo, hi));
                    }
                    entries += 1;
                    if b == "endcodespacerange" || entries > MAX_ENTRIES {
                        break;
                    }
                }
            }
            "begincidrange" => {
                while let Some(a) = words.next() {
                    if a == "endcidrange" {
                        break;
                    }
                    let (Some(b), Some(c)) = (words.next(), words.next()) else {
                        break;
                    };
                    if let (Some((_, lo)), Some((_, hi)), Ok(first)) =
                        (hex(a), hex(b), c.parse::<u32>())
                    {
                        cids.push((lo, hi.max(lo), first));
                    }
                    entries += 1;
                    if entries > MAX_ENTRIES {
                        break;
                    }
                }
            }
            "begincidchar" => {
                while let Some(a) = words.next() {
                    if a == "endcidchar" {
                        break;
                    }
                    let Some(b) = words.next() else { break };
                    if let (Some((_, code)), Ok(cid)) = (hex(a), b.parse::<u32>()) {
                        cids.push((code, code, cid));
                    }
                    entries += 1;
                    if entries > MAX_ENTRIES {
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    (!spaces.is_empty()).then_some(Codes::Table { spaces, cids })
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::dictionary;

    #[test]
    fn simple_widths_come_from_the_widths_array() {
        let doc = Document::with_version("1.7");
        let font = Object::Dictionary(dictionary! {
            "Type" => "Font", "Subtype" => "TrueType", "FirstChar" => 65,
            "Widths" => vec![Object::Integer(600), Object::Integer(250)],
        });
        let f = Font::read(&doc, &font);
        assert!(!f.unsure);
        let codes = f.codes(b"AB ");
        assert_eq!(codes.len(), 3);
        assert_eq!((codes[0].advance, codes[1].advance), (0.6, 0.25));
        assert!(codes[2].space);
    }

    #[test]
    fn a_standard_font_without_widths_takes_adobes_and_another_is_unsure() {
        let doc = Document::with_version("1.7");
        let font = Object::Dictionary(dictionary! {
            "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica",
            "Encoding" => "WinAnsiEncoding",
        });
        let f = Font::read(&doc, &font);
        assert!(!f.unsure);
        let w: Vec<f32> = f.codes(b"Hi W").iter().map(|c| c.advance).collect();
        assert_eq!(w, [0.722, 0.222, 0.278, 0.944]);
        let bold = Object::Dictionary(dictionary! {
            "Type" => "Font", "Subtype" => "TrueType", "BaseFont" => "ABCDEF+Arial,Bold",
        });
        assert_eq!(Font::read(&doc, &bold).codes(b"i")[0].advance, 0.278);
        let other = Object::Dictionary(dictionary! {
            "Type" => "Font", "Subtype" => "TrueType", "BaseFont" => "Tahoma",
        });
        assert!(Font::read(&doc, &other).unsure);
    }

    #[test]
    fn identity_codes_are_two_bytes_with_widths_by_cid() {
        let mut doc = Document::with_version("1.7");
        let cid = doc.add_object(dictionary! {
            "Type" => "Font", "Subtype" => "CIDFontType2", "DW" => 1000,
            "W" => vec![Object::Integer(3), Object::Array(vec![Object::Integer(500), Object::Integer(300)]),
                        Object::Integer(10), Object::Integer(20), Object::Integer(700)],
        });
        let font = Object::Dictionary(dictionary! {
            "Type" => "Font", "Subtype" => "Type0", "Encoding" => "Identity-H",
            "DescendantFonts" => vec![Object::Reference(cid)],
        });
        let f = Font::read(&doc, &font);
        let codes = f.codes(&[0, 3, 0, 4, 0, 15, 0, 99]);
        let w: Vec<f32> = codes.iter().map(|c| c.advance).collect();
        assert_eq!(w, [0.5, 0.3, 0.7, 1.0]);
        assert_eq!(codes[1].bytes, 2..4);
    }

    #[test]
    fn an_embedded_cmap_cuts_mixed_length_codes() {
        let cmap = b"begincodespacerange <00> <80> <8140> <FFFF> endcodespacerange\n\
                     1 begincidrange <8140> <817F> 633 endcidrange 1 begincidchar <41> 34 endcidchar";
        let Some(Codes::Table { spaces, cids }) = parse_cmap(cmap) else {
            panic!("no table");
        };
        assert_eq!(spaces.len(), 2);
        assert_eq!(code_length(&spaces, &[0x41, 0x81]), 1);
        assert_eq!(code_length(&spaces, &[0x81, 0x40]), 2);
        assert!(cids.contains(&(0x41, 0x41, 34)));
    }

    #[test]
    fn a_hostile_w_array_is_read_within_bounds() {
        let doc = Document::with_version("1.7");
        let mut w = Vec::new();
        for i in 0..300_000 {
            w.push(Object::Integer(i));
            w.push(Object::Integer(i));
            w.push(Object::Integer(500));
        }
        let mut out = BTreeMap::new();
        read_w(&doc, &w, &mut out);
        assert!(out.len() <= MAX_ENTRIES + 1);
    }
}
