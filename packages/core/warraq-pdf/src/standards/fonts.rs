//! Fonts as the standards see them: embedded or not, what each code shown
//! means in Unicode, whether the embedded program has the glyphs and widths
//! the dictionary claims — and, for a font the file does not carry, a
//! bundled face embedded in its place.
//!
//! A substitute keeps the file's own character codes, so no content stream
//! changes: a simple font becomes a symbolic TrueType font whose (3,0)
//! `cmap` maps each code (as U+F000 + code) to the glyph for the character
//! it stood for, with widths from the new face and a ToUnicode; a CID font
//! keeps its CIDs and gets a `CIDToGIDMap`. What moves is where letters
//! fall: the new face's widths are not the missing font's.
use std::collections::{BTreeMap, BTreeSet};

use lopdf::{dictionary, Dictionary, Document, Object, ObjectId, Stream};
use skrifa::instance::{LocationRef, Size};
use skrifa::raw::TableProvider;
use skrifa::{GlyphId, MetadataProvider};

use super::scan::FontUse;
use crate::{Error, Result};

fn resolve<'a>(doc: &'a Document, o: &'a Object) -> &'a Object {
    match o {
        Object::Reference(id) => doc.get_object(*id).unwrap_or(o),
        other => other,
    }
}

fn name_of(o: Option<&Object>) -> Option<String> {
    o.and_then(|o| o.as_name().ok())
        .map(|n| String::from_utf8_lossy(n).into_owned())
}

/// Which embedded program a font carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Program {
    Type1,
    TrueType,
    /// `FontFile3`, with its subtype.
    Compact,
}

/// What a font is, as far as the standards ask.
#[derive(Debug, Clone)]
pub struct FontFacts {
    pub base_font: String,
    pub subtype: String,
    /// The descendant's subtype, for a Type0 font.
    pub cid_subtype: Option<String>,
    pub program: Option<(Program, ObjectId)>,
    pub descriptor: Option<ObjectId>,
    pub symbolic: bool,
    pub tounicode: Option<BTreeMap<u32, String>>,
    /// The Type0 font's encoding CMap, by name, when it is a name.
    pub cmap_name: Option<String>,
}

impl FontFacts {
    /// Type 3 fonts are drawn by the file's own content.
    pub fn embedded(&self) -> bool {
        self.subtype == "Type3" || self.program.is_some()
    }
}

/// A Type0 font's descendant, resolved.
fn descendant<'a>(doc: &'a Document, font: &'a Dictionary) -> Option<&'a Dictionary> {
    let kids = resolve(doc, font.get(b"DescendantFonts").ok()?)
        .as_array()
        .ok()?;
    resolve(doc, kids.first()?).as_dict().ok()
}

/// The id of a Type0 font's descendant, when it is its own object.
fn descendant_id(doc: &Document, font: &Dictionary) -> Option<ObjectId> {
    let kids = resolve(doc, font.get(b"DescendantFonts").ok()?)
        .as_array()
        .ok()?;
    kids.first()?.as_reference().ok()
}

fn stream_bytes(doc: &Document, o: &Object) -> Option<Vec<u8>> {
    let s = resolve(doc, o).as_stream().ok()?;
    if s.dict.get(b"Filter").is_err() {
        return Some(s.content.clone());
    }
    s.decompressed_content_with_limit(32 << 20).ok()
}

pub fn facts(doc: &Document, font: &Dictionary) -> FontFacts {
    let subtype = name_of(font.get(b"Subtype").ok()).unwrap_or_default();
    let desc_holder = if subtype == "Type0" {
        descendant(doc, font)
    } else {
        Some(font)
    };
    let descriptor_obj = desc_holder.and_then(|d| d.get(b"FontDescriptor").ok());
    let descriptor = descriptor_obj.and_then(|d| resolve(doc, d).as_dict().ok());
    let program = descriptor.and_then(|d| {
        [
            (b"FontFile2".as_slice(), Program::TrueType),
            (b"FontFile", Program::Type1),
            (b"FontFile3", Program::Compact),
        ]
        .into_iter()
        .find_map(|(key, kind)| Some((kind, d.get(key).ok()?.as_reference().ok()?)))
    });
    let flags = descriptor
        .and_then(|d| d.get(b"Flags").ok())
        .and_then(|f| f.as_i64().ok())
        .unwrap_or(0);
    let tounicode = font
        .get(b"ToUnicode")
        .ok()
        .and_then(|t| stream_bytes(doc, t))
        .map(|b| crate::tounicode::parse(&b));
    FontFacts {
        base_font: name_of(font.get(b"BaseFont").ok()).unwrap_or_default(),
        cid_subtype: if subtype == "Type0" {
            descendant(doc, font).and_then(|d| name_of(d.get(b"Subtype").ok()))
        } else {
            None
        },
        subtype,
        program,
        descriptor: descriptor_obj.and_then(|d| d.as_reference().ok()),
        symbolic: flags & 4 != 0,
        tounicode,
        cmap_name: name_of(font.get(b"Encoding").ok()),
    }
}

/// Standard encodings a non-symbolic simple font may name (§9.6.6).
const STANDARD: &[&str] = &[
    "WinAnsiEncoding",
    "MacRomanEncoding",
    "MacExpertEncoding",
    "StandardEncoding",
];

/// Predefined CMaps whose character collection a reader can map to Unicode
/// (PDF/A-2 §6.2.11.7.2).
fn predefined_unicode_collection(doc: &Document, font: &Dictionary) -> bool {
    let Some(d) = descendant(doc, font) else {
        return false;
    };
    let Some(info) = d
        .get(b"CIDSystemInfo")
        .ok()
        .and_then(|i| resolve(doc, i).as_dict().ok())
    else {
        return false;
    };
    let text = |k: &[u8]| {
        info.get(k)
            .ok()
            .and_then(|v| resolve(doc, v).as_str().ok())
            .map(|s| String::from_utf8_lossy(s).into_owned())
    };
    text(b"Registry").as_deref() == Some("Adobe")
        && matches!(
            text(b"Ordering").as_deref(),
            Some("GB1" | "CNS1" | "Japan1" | "Korea1")
        )
}

/// What `code` means in Unicode by the rules PDF/A-2u reads it with: the
/// ToUnicode map, or a standard encoding of a non-symbolic simple font (its
/// glyph names in the Adobe Glyph List). `None` when neither says.
pub fn unicode_of(
    doc: &Document,
    font: &Dictionary,
    facts: &FontFacts,
    code: u32,
) -> Option<String> {
    if let Some(map) = &facts.tounicode {
        if let Some(text) = map.get(&code) {
            let bad = text.is_empty()
                || text
                    .chars()
                    .all(|c| matches!(c, '\0' | '\u{FEFF}' | '\u{FFFE}' | '\u{FFFD}'));
            return (!bad).then(|| text.clone());
        }
    }
    if facts.subtype == "Type0" {
        return None;
    }
    if facts.subtype == "Type3" {
        return None;
    }
    if facts.symbolic {
        return None;
    }
    let encoding_ok = match font.get(b"Encoding").map(|e| resolve(doc, e)) {
        Err(_) => true,
        Ok(Object::Name(n)) => STANDARD.contains(&String::from_utf8_lossy(n).as_ref()),
        Ok(Object::Dictionary(d)) => d
            .get(b"BaseEncoding")
            .ok()
            .and_then(|b| b.as_name().ok())
            .is_none_or(|b| STANDARD.contains(&String::from_utf8_lossy(b).as_ref())),
        _ => false,
    };
    if !encoding_ok || code > 255 {
        return None;
    }
    let mut typed = font.clone();
    if !typed.has(b"Type") {
        typed.set("Type", Object::Name(b"Font".to_vec()));
    }
    // A glyph name outside the Adobe Glyph List decodes to nothing.
    let text = typed
        .get_font_encoding_with_limit(doc, 1 << 20)
        .ok()?
        .bytes_to_string(&[code as u8])
        .ok()?;
    let good = !text.is_empty() && !text.chars().any(|c| matches!(c, '\u{FFFD}' | '\0'));
    good.then_some(text)
}

/// Whether every code a font shows has a Unicode value (PDF/A-2u).
pub fn unmapped_codes(doc: &Document, font: &FontUse, facts: &FontFacts) -> Vec<u32> {
    if facts.subtype == "Type0"
        && facts.tounicode.is_none()
        && predefined_unicode_collection(doc, &font.dict)
        && facts
            .cmap_name
            .as_deref()
            .is_some_and(|n| !n.starts_with("Identity"))
    {
        return vec![];
    }
    font.codes
        .iter()
        .copied()
        .filter(|c| unicode_of(doc, &font.dict, facts, *c).is_none())
        .collect()
}

/// A code's Unicode by any means Warraq knows, for choosing a substitute's
/// glyphs: the rules above, then the encoding whatever it is.
fn any_unicode(doc: &Document, font: &Dictionary, facts: &FontFacts, code: u32) -> Option<String> {
    if let Some(t) = unicode_of(doc, font, facts, code) {
        return Some(t);
    }
    if facts.subtype == "Type0" || code > 255 {
        return None;
    }
    let mut typed = font.clone();
    typed.set("Type", Object::Name(b"Font".to_vec()));
    let text = typed
        .get_font_encoding_with_limit(doc, 1 << 20)
        .ok()?
        .bytes_to_string(&[code as u8])
        .ok()?;
    (!text.is_empty() && !text.contains('\u{FFFD}')).then_some(text)
}

/// A TrueType program's view of a code: the glyph it draws, by the rules of
/// ISO 32000-1 §9.6.6.4, or `None` when it draws `.notdef`.
pub fn truetype_glyph(
    doc: &Document,
    font: &Dictionary,
    facts: &FontFacts,
    program: &[u8],
    code: u32,
) -> Option<u32> {
    let face = skrifa::FontRef::new(program).ok()?;
    let glyphs = face.maxp().ok()?.num_glyphs() as u32;
    if facts.subtype == "Type0" {
        // CID = code for Identity; the CIDToGIDMap says the glyph.
        let d = descendant(doc, font)?;
        let gid = match d.get(b"CIDToGIDMap").map(|m| resolve(doc, m)) {
            Ok(Object::Stream(s)) => {
                let map = s
                    .decompressed_content_with_limit(1 << 20)
                    .unwrap_or_else(|_| s.content.clone());
                let at = code as usize * 2;
                u32::from(u16::from_be_bytes([*map.get(at)?, *map.get(at + 1)?]))
            }
            _ => code,
        };
        return (gid != 0 && gid < glyphs).then_some(gid);
    }
    let cmap = face.cmap().ok()?;
    let lookup = |platform: u16, encoding: u16, c: u32| -> Option<u32> {
        cmap.encoding_records()
            .iter()
            .filter(|r| r.platform_id() as u16 == platform && r.encoding_id() == encoding)
            .find_map(|r| {
                r.subtable(cmap.offset_data())
                    .ok()?
                    .map_codepoint(c)
                    .map(|g| g.to_u32())
            })
            .filter(|g| *g != 0)
    };
    let gid = if facts.symbolic {
        lookup(3, 0, code)
            .or_else(|| lookup(3, 0, 0xF000 | code))
            .or_else(|| lookup(1, 0, code))
    } else {
        let text = unicode_of(doc, font, facts, code)?;
        let ch = text.chars().next()?;
        lookup(3, 1, ch as u32).or_else(|| lookup(1, 0, code))
    };
    gid.filter(|g| *g < glyphs)
}

/// Width of glyph `gid` in 1/1000 em.
pub fn glyph_width(program: &[u8], gid: u32) -> Option<f32> {
    let face = skrifa::FontRef::new(program).ok()?;
    let upem = face.head().ok()?.units_per_em() as f32;
    let w = face
        .glyph_metrics(Size::unscaled(), LocationRef::default())
        .advance_width(GlyphId::new(gid))?;
    Some(w * 1000.0 / upem.max(1.0))
}

/// The width the dictionary gives `code` (`/Widths`, or `/W` and `/DW`).
pub fn dictionary_width(
    doc: &Document,
    font: &Dictionary,
    facts: &FontFacts,
    code: u32,
) -> Option<f32> {
    let num = |o: &Object| resolve(doc, o).as_float().ok();
    if facts.subtype == "Type0" {
        let d = descendant(doc, font)?;
        let default = d.get(b"DW").ok().and_then(num).unwrap_or(1000.0);
        let Some(w) = d
            .get(b"W")
            .ok()
            .and_then(|w| resolve(doc, w).as_array().ok())
        else {
            return Some(default);
        };
        let mut i = 0;
        while i < w.len() {
            let first = num(&w[i])? as u32;
            match w.get(i + 1).map(|o| resolve(doc, o)) {
                Some(Object::Array(list)) => {
                    if code >= first && ((code - first) as usize) < list.len() {
                        return num(&list[(code - first) as usize]);
                    }
                    i += 2;
                }
                Some(last) => {
                    let last = num(last)? as u32;
                    if (first..=last).contains(&code) {
                        return w.get(i + 2).and_then(num);
                    }
                    i += 3;
                }
                None => break,
            }
        }
        return Some(default);
    }
    let first = font.get(b"FirstChar").ok().and_then(num)? as u32;
    let widths = resolve(doc, font.get(b"Widths").ok()?).as_array().ok()?;
    if code < first {
        return None;
    }
    widths.get((code - first) as usize).and_then(num)
}

/// A table added to (or replacing one in) an sfnt, with the directory and
/// checksums written again.
pub fn with_table(font: &[u8], tag: &[u8; 4], table: &[u8]) -> Option<Vec<u8>> {
    let be16 = |at: usize| -> Option<u16> {
        Some(u16::from_be_bytes(font.get(at..at + 2)?.try_into().ok()?))
    };
    let be32 = |at: usize| -> Option<u32> {
        Some(u32::from_be_bytes(font.get(at..at + 4)?.try_into().ok()?))
    };
    let count = be16(4)? as usize;
    let mut tables: Vec<([u8; 4], Vec<u8>)> = vec![];
    for k in 0..count {
        let at = 12 + 16 * k;
        let t: [u8; 4] = font.get(at..at + 4)?.try_into().ok()?;
        let offset = be32(at + 8)? as usize;
        let len = be32(at + 12)? as usize;
        if &t != tag {
            tables.push((t, font.get(offset..offset.checked_add(len)?)?.to_vec()));
        }
    }
    tables.push((*tag, table.to_vec()));
    tables.sort_by_key(|t| t.0);
    let n = tables.len() as u16;
    let selector = 15 - n.leading_zeros() as u16;
    let range = (1u16 << selector) * 16;
    let mut out = font.get(0..4)?.to_vec();
    out.extend(n.to_be_bytes());
    out.extend(range.to_be_bytes());
    out.extend(selector.to_be_bytes());
    out.extend((n * 16 - range).to_be_bytes());
    let checksum = |data: &[u8]| -> u32 {
        data.chunks(4).fold(0u32, |acc, c| {
            let mut w = [0u8; 4];
            w[..c.len()].copy_from_slice(c);
            acc.wrapping_add(u32::from_be_bytes(w))
        })
    };
    let directory = 12 + 16 * tables.len();
    let mut offset = directory;
    let mut body = vec![];
    let mut head_at = None;
    for (t, data) in &mut tables {
        if t == b"head" && data.len() >= 12 {
            data[8..12].fill(0);
            head_at = Some(offset);
        }
        out.extend_from_slice(t);
        out.extend(checksum(data).to_be_bytes());
        out.extend((offset as u32).to_be_bytes());
        out.extend((data.len() as u32).to_be_bytes());
        body.extend_from_slice(data);
        while body.len() % 4 != 0 {
            body.push(0);
        }
        offset = directory + body.len();
    }
    out.extend(body);
    if let Some(at) = head_at {
        let adjust = 0xB1B0_AFBAu32.wrapping_sub(checksum(&out));
        out[at + 8..at + 12].copy_from_slice(&adjust.to_be_bytes());
    }
    Some(out)
}

/// A `cmap` with one format 4 subtable, platform 3 encoding 0 (symbol):
/// each (code point, glyph).
pub fn symbol_cmap(pairs: &BTreeMap<u16, u16>) -> Vec<u8> {
    // One segment per mapping, then the closing 0xFFFF segment.
    let mut segs: Vec<(u16, u16)> = pairs.iter().map(|(c, g)| (*c, *g)).collect();
    segs.retain(|(c, _)| *c != 0xFFFF);
    let n = segs.len() + 1;
    let mut sub = vec![];
    let length = 16 + 8 * n;
    sub.extend(4u16.to_be_bytes());
    sub.extend((length as u16).to_be_bytes());
    sub.extend(0u16.to_be_bytes());
    sub.extend(((n * 2) as u16).to_be_bytes());
    let selector = 15 - (n as u16).leading_zeros() as u16;
    let range = (1u16 << selector) * 2;
    sub.extend(range.to_be_bytes());
    sub.extend(selector.to_be_bytes());
    sub.extend(((n * 2) as u16 - range).to_be_bytes());
    for (c, _) in &segs {
        sub.extend(c.to_be_bytes());
    }
    sub.extend(0xFFFFu16.to_be_bytes());
    sub.extend(0u16.to_be_bytes());
    for (c, _) in &segs {
        sub.extend(c.to_be_bytes());
    }
    sub.extend(0xFFFFu16.to_be_bytes());
    for (c, g) in &segs {
        sub.extend(g.wrapping_sub(*c).to_be_bytes());
    }
    sub.extend(1u16.to_be_bytes());
    for _ in 0..n {
        sub.extend(0u16.to_be_bytes());
    }
    let mut table = vec![];
    table.extend(0u16.to_be_bytes());
    table.extend(1u16.to_be_bytes());
    table.extend(3u16.to_be_bytes());
    table.extend(0u16.to_be_bytes());
    table.extend(12u32.to_be_bytes());
    table.extend(sub);
    table
}

/// A face Warraq bundles, offered as a substitute.
pub struct Face<'a> {
    pub name: &'a str,
    pub data: &'a [u8],
    /// A face with serifs (Amiri), or without (Inter): the missing font's
    /// name says which it was, and the closer one is chosen when both have
    /// every character.
    pub serif: bool,
}

/// Whether a font's name says it has serifs.
fn named_serif(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    !lower.contains("sans")
        && [
            "times",
            "roman",
            "serif",
            "georgia",
            "garamond",
            "book",
            "minion",
            "cambria",
            "palatino",
            "traditional",
            "naskh",
            "amiri",
            "scheherazade",
            "lotus",
            "badr",
        ]
        .iter()
        .any(|k| lower.contains(k))
}

/// What happened to one font.
#[derive(Debug, Clone, PartialEq)]
pub struct Substitution {
    pub font: String,
    pub face: String,
    /// Characters the face has no glyph for: drawn as nothing.
    pub missing: Vec<char>,
}

fn subset_tag(n: usize) -> String {
    let mut n = n;
    let mut tag = String::new();
    for _ in 0..6 {
        tag.push((b'A' + (n % 26) as u8) as char);
        n /= 26;
    }
    format!("WQ{}", &tag[..4])
}

fn sanitized(name: &str) -> String {
    let base = name.split_once('+').map(|(_, b)| b).unwrap_or(name);
    let s: String = base
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(48)
        .collect();
    if s.is_empty() {
        "Font".into()
    } else {
        s
    }
}

/// Embeds `faces` in place of font `font`, which the file does not carry.
/// The font's object keeps its number, so every page that names it gets the
/// substitute; the codes in the content are not touched.
pub fn substitute(
    doc: &mut Document,
    font: &FontUse,
    faces: &[Face<'_>],
    serial: usize,
) -> Result<Substitution> {
    let Some(id) = font.id else {
        return Err(Error::Edit(
            "a font written inside a resource dictionary cannot be replaced".into(),
        ));
    };
    let facts = facts(doc, &font.dict);
    // What each code stands for.
    // A CMap that is Unicode itself (`Uni…-UCS2-H`, `Uni…-UTF16-H`): each
    // code is its character, and becomes its own CID under Identity-H.
    let unicode_cmap = facts.subtype == "Type0"
        && facts.cmap_name.as_deref().is_some_and(|n| {
            n.starts_with("Uni") && (n.contains("UCS2") || n.contains("UTF16")) && n.ends_with("-H")
        });
    let texts: BTreeMap<u32, String> = font
        .codes
        .iter()
        .filter_map(|c| {
            if unicode_cmap {
                return char::from_u32(*c).map(|ch| (*c, ch.to_string()));
            }
            any_unicode(doc, &font.dict, &facts, *c).map(|t| (*c, t))
        })
        .collect();
    let chars: Vec<char> = texts.values().filter_map(|t| t.chars().next()).collect();
    // The face that has the most of them.
    // The face with the most of them; of equals, the one whose style is
    // closer, then the first offered.
    let serif = named_serif(&facts.base_font);
    let best = faces
        .iter()
        .enumerate()
        .filter_map(|(k, f)| {
            let face = skrifa::FontRef::new(f.data).ok()?;
            let cmap = face.charmap();
            let covered = chars.iter().filter(|c| cmap.map(**c).is_some()).count();
            Some(((covered, f.serif == serif, usize::MAX - k), f))
        })
        .max_by_key(|(rank, _)| *rank)
        .map(|(_, f)| f)
        .ok_or_else(|| Error::Font("no bundled face could be read".into()))?;
    let face = skrifa::FontRef::new(best.data).map_err(|e| Error::Font(e.to_string()))?;
    let charmap = face.charmap();
    let shaper = warraq_text::Shaper::new(best.data).map_err(|e| Error::Font(format!("{e:?}")))?;
    let metrics = shaper.metrics();
    let mut remap = subsetter::GlyphRemapper::new();
    let mut code_gid: BTreeMap<u32, u16> = BTreeMap::new();
    let mut missing = BTreeSet::new();
    for (code, text) in &texts {
        let Some(ch) = text.chars().next() else {
            continue;
        };
        match charmap.map(ch) {
            Some(g) if g.to_u32() != 0 => {
                let old = g.to_u32() as u16;
                remap.remap(old);
                code_gid.insert(*code, old);
            }
            _ if ch.is_whitespace() => {
                if let Some(g) = charmap.map(' ') {
                    remap.remap(g.to_u32() as u16);
                    code_gid.insert(*code, g.to_u32() as u16);
                }
            }
            _ => {
                missing.insert(ch);
            }
        }
    }
    let program = subsetter::subset(best.data, 0, &remap)
        .map_err(|e| Error::Font(format!("subset: {e:?}")))?;
    let new_gid = |old: u16| remap.get(old).unwrap_or(0);
    let name = format!("{}+{}", subset_tag(serial), sanitized(&facts.base_font));
    let width_of = |old: u16| shaper.advance(old).round();
    let tounicode: String = {
        let mut s = String::from("/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n");
        let two = facts.subtype == "Type0";
        s.push_str(if two {
            "1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n"
        } else {
            "1 begincodespacerange\n<00> <FF>\nendcodespacerange\n"
        });
        let entries: Vec<(&u32, &String)> = texts.iter().collect();
        for chunk in entries.chunks(100) {
            s.push_str(&format!("{} beginbfchar\n", chunk.len()));
            for (code, text) in chunk {
                let hex: String = text.encode_utf16().map(|u| format!("{u:04X}")).collect();
                if two {
                    s.push_str(&format!("<{:04X}> <{hex}>\n", code));
                } else {
                    s.push_str(&format!("<{:02X}> <{hex}>\n", code));
                }
            }
            s.push_str("endbfchar\n");
        }
        s.push_str("endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n");
        s
    };
    let mut tu = Stream::new(Dictionary::new(), tounicode.into_bytes());
    let _ = tu.compress();
    let tu = doc.add_object(tu);
    let descriptor = |doc: &mut Document, program: Vec<u8>| -> ObjectId {
        let mut ff = Stream::new(dictionary! { "Length1" => program.len() as i64 }, program);
        let _ = ff.compress();
        let ff = doc.add_object(ff);
        doc.add_object(dictionary! {
            "Type" => "FontDescriptor",
            "FontName" => Object::Name(name.clone().into_bytes()),
            "Flags" => 4,
            "FontBBox" => metrics.bbox.iter().map(|v| Object::Integer(v.round() as i64)).collect::<Vec<_>>(),
            "ItalicAngle" => 0,
            "Ascent" => Object::Integer(metrics.ascent.round() as i64),
            "Descent" => Object::Integer(metrics.descent.round() as i64),
            "CapHeight" => Object::Integer((metrics.ascent * 0.7).round() as i64),
            "StemV" => 80,
            "FontFile2" => ff,
        })
    };
    if facts.subtype == "Type0" {
        // The CIDs stay; a map says which glyph each one is.
        let identity = unicode_cmap
            || facts
                .cmap_name
                .as_deref()
                .is_some_and(|n| n == "Identity-H" || n == "Identity-V");
        if !identity {
            return Err(Error::Font(format!(
                "{}: its CMap is not Identity, so its CIDs cannot be read",
                facts.base_font
            )));
        }
        let top = code_gid.keys().max().copied().unwrap_or(0) as usize;
        if top > 0xFFFF {
            return Err(Error::Font("a CID past 65535".into()));
        }
        let mut map = vec![0u8; (top + 1) * 2];
        let mut w = vec![];
        for (cid, old) in &code_gid {
            let g = new_gid(*old);
            map[*cid as usize * 2..*cid as usize * 2 + 2].copy_from_slice(&g.to_be_bytes());
            w.push(Object::Integer(i64::from(*cid)));
            w.push(Object::Array(vec![Object::Integer(width_of(*old) as i64)]));
        }
        let mut map = Stream::new(Dictionary::new(), map);
        let _ = map.compress();
        let map = doc.add_object(map);
        let desc = descriptor(doc, program);
        let cid_font = dictionary! {
            "Type" => "Font",
            "Subtype" => "CIDFontType2",
            "BaseFont" => Object::Name(name.clone().into_bytes()),
            "CIDSystemInfo" => dictionary! {
                "Registry" => Object::string_literal("Adobe"),
                "Ordering" => Object::string_literal("Identity"),
                "Supplement" => 0,
            },
            "FontDescriptor" => desc,
            "DW" => 1000,
            "W" => w,
            "CIDToGIDMap" => map,
        };
        let cid_id = match descendant_id(doc, &font.dict) {
            Some(cid_id) => {
                doc.objects.insert(cid_id, Object::Dictionary(cid_font));
                cid_id
            }
            None => doc.add_object(cid_font),
        };
        let mut top_font = font.dict.clone();
        top_font.set("BaseFont", Object::Name(name.clone().into_bytes()));
        top_font.set("DescendantFonts", vec![Object::Reference(cid_id)]);
        if unicode_cmap {
            top_font.set("Encoding", Object::Name(b"Identity-H".to_vec()));
        }
        top_font.set("ToUnicode", tu);
        doc.objects.insert(id, Object::Dictionary(top_font));
    } else {
        if code_gid.keys().any(|c| *c > 255) {
            return Err(Error::Font("a simple font with a code past 255".into()));
        }
        // Symbolic: the (3,0) cmap takes U+F000 + code to the glyph.
        let pairs: BTreeMap<u16, u16> = code_gid
            .iter()
            .map(|(code, old)| (0xF000 | *code as u16, new_gid(*old)))
            .collect();
        let program = with_table(&program, b"cmap", &symbol_cmap(&pairs))
            .ok_or_else(|| Error::Font("the subset could not be given a cmap".into()))?;
        let first = code_gid.keys().min().copied().unwrap_or(32);
        let last = code_gid.keys().max().copied().unwrap_or(32);
        let widths: Vec<Object> = (first..=last)
            .map(|c| Object::Integer(code_gid.get(&c).map(|g| width_of(*g) as i64).unwrap_or(0)))
            .collect();
        let desc = descriptor(doc, program);
        let simple = dictionary! {
            "Type" => "Font",
            "Subtype" => "TrueType",
            "BaseFont" => Object::Name(name.clone().into_bytes()),
            "FirstChar" => i64::from(first),
            "LastChar" => i64::from(last),
            "Widths" => widths,
            "FontDescriptor" => desc,
            "ToUnicode" => tu,
        };
        doc.objects.insert(id, Object::Dictionary(simple));
    }
    Ok(Substitution {
        font: facts.base_font,
        face: best.name.to_string(),
        missing: missing.into_iter().collect(),
    })
}

/// A ToUnicode for an embedded TrueType font that has none, read from its
/// own `cmap` through the way it selects glyphs. `None` when the program
/// does not say enough.
pub fn tounicode_from_program(
    doc: &Document,
    font: &FontUse,
    facts: &FontFacts,
    program: &[u8],
) -> Option<Vec<u8>> {
    let face = skrifa::FontRef::new(program).ok()?;
    let mut reverse: BTreeMap<u32, char> = BTreeMap::new();
    for (cp, g) in face.charmap().mappings() {
        if let Some(ch) = char::from_u32(cp) {
            let pua = ('\u{E000}'..='\u{F8FF}').contains(&ch);
            if !pua {
                reverse.entry(g.to_u32()).or_insert(ch);
            }
        }
    }
    let two = facts.subtype == "Type0";
    let mut entries = vec![];
    for code in &font.codes {
        let gid = truetype_glyph(doc, &font.dict, facts, program, *code)?;
        let ch = reverse.get(&gid)?;
        entries.push((*code, *ch));
    }
    let mut s = String::from("/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n");
    s.push_str(if two {
        "1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n"
    } else {
        "1 begincodespacerange\n<00> <FF>\nendcodespacerange\n"
    });
    for chunk in entries.chunks(100) {
        s.push_str(&format!("{} beginbfchar\n", chunk.len()));
        for (code, ch) in chunk {
            let hex: String = ch
                .to_string()
                .encode_utf16()
                .map(|u| format!("{u:04X}"))
                .collect();
            if two {
                s.push_str(&format!("<{code:04X}> <{hex}>\n"));
            } else {
                s.push_str(&format!("<{code:02X}> <{hex}>\n"));
            }
        }
        s.push_str("endbfchar\n");
    }
    s.push_str("endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n");
    Some(s.into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    const INTER: &[u8] =
        include_bytes!("../../../../../tests/fonts/static/Inter-Regular-static.ttf");

    #[test]
    fn a_table_added_to_a_font_reads_back() {
        let mut pairs = BTreeMap::new();
        pairs.insert(0xF041u16, 36u16);
        pairs.insert(0xF042u16, 37u16);
        let with = with_table(INTER, b"cmap", &symbol_cmap(&pairs)).unwrap();
        let face = skrifa::FontRef::new(&with).unwrap();
        let cmap = face.cmap().unwrap();
        let record = cmap
            .encoding_records()
            .iter()
            .find(|r| r.platform_id() as u16 == 3 && r.encoding_id() == 0)
            .unwrap();
        let sub = record.subtable(cmap.offset_data()).unwrap();
        assert_eq!(sub.map_codepoint(0xF041u32).map(|g| g.to_u32()), Some(36));
        assert_eq!(sub.map_codepoint(0xF042u32).map(|g| g.to_u32()), Some(37));
        assert_eq!(sub.map_codepoint(0xF043u32).map(|g| g.to_u32()), None);
        // Every other table is still there.
        assert!(face.hmtx().is_ok() && face.head().is_ok() && face.maxp().is_ok());
    }
}
