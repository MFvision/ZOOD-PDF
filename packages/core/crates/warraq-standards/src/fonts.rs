//! Font analysis shared by the validator and the converter: simple-font encodings and glyph names,
//! the ISO 32000-1 9.6.6.4 code→glyph mapping for TrueType, widths from the font program
//! (ttf-parser), ToUnicode CMaps (parse and write), and the metric-compatible substitutes
//! (Liberation, OFL-1.1) for the standard 14 text fonts.

use crate::encodings::{AGL, MAC_ROMAN, STANDARD, WIN_ANSI};
use crate::lexer::{Lexer, Tok};
use crate::model::{decoded, dict, get, get_dict, get_name, get_num, num, stream};
use std::collections::BTreeMap;
use ttf_parser::{Face, GlyphId, PlatformId};
use warraq_pdf::lopdf::{Dictionary, Object, Stream};
use warraq_pdf::Pdf;

/// Font dictionary summary.
#[derive(Debug, Clone)]
pub struct FontInfo<'a> {
    /// The font dictionary.
    pub dict: &'a Dictionary,
    /// /Subtype.
    pub subtype: String,
    /// /BaseFont (for Type 0: the descendant's if the parent has none).
    pub base_font: String,
    /// For Type 0: the descendant CIDFont.
    pub descendant: Option<&'a Dictionary>,
    /// The font descriptor (the descendant's for Type 0).
    pub descriptor: Option<&'a Dictionary>,
    /// Embedded program: (key, stream).
    pub program: Option<(&'static str, &'a Stream)>,
}

impl FontInfo<'_> {
    /// Type 3 fonts carry their glyphs as content streams (no program to embed).
    pub fn is_type3(&self) -> bool {
        self.subtype == "Type3"
    }

    /// Whether a font program is embedded (Type 3 counts as embedded).
    pub fn embedded(&self) -> bool {
        self.is_type3() || self.program.is_some()
    }

    /// Descriptor flag bit 3 (Symbolic).
    pub fn symbolic(&self) -> bool {
        self.flags() & 4 != 0
    }

    /// Descriptor /Flags.
    pub fn flags(&self) -> i64 {
        self.descriptor
            .and_then(|d| d.get(b"Flags").ok())
            .and_then(|o| o.as_i64().ok())
            .unwrap_or(0)
    }

    /// Subset font (`ABCDEF+Name`).
    pub fn is_subset(&self) -> bool {
        let b = self.base_font.as_bytes();
        b.len() > 7 && b.get(6) == Some(&b'+') && b.iter().take(6).all(u8::is_ascii_uppercase)
    }
}

/// Summarise a font dictionary.
pub fn info<'a>(pdf: &'a Pdf, d: &'a Dictionary) -> FontInfo<'a> {
    let subtype = get_name(pdf, d, b"Subtype")
        .map(|n| String::from_utf8_lossy(n).into_owned())
        .unwrap_or_default();
    let mut base_font = get_name(pdf, d, b"BaseFont")
        .map(|n| String::from_utf8_lossy(n).into_owned())
        .unwrap_or_default();
    let descendant = if subtype == "Type0" {
        match get(pdf, d, b"DescendantFonts") {
            Some(Object::Array(a)) => a.first().and_then(|o| dict(pdf, o)),
            _ => None,
        }
    } else {
        None
    };
    if base_font.is_empty() {
        if let Some(dd) = descendant {
            base_font = get_name(pdf, dd, b"BaseFont")
                .map(|n| String::from_utf8_lossy(n).into_owned())
                .unwrap_or_default();
        }
    }
    let descriptor = get_dict(pdf, descendant.unwrap_or(d), b"FontDescriptor");
    let program = descriptor.and_then(|fd| {
        [
            ("FontFile", b"FontFile".as_slice()),
            ("FontFile2", b"FontFile2"),
            ("FontFile3", b"FontFile3"),
        ]
        .into_iter()
        .find_map(|(k, key)| {
            fd.get(key)
                .ok()
                .and_then(|o| stream(pdf, o))
                .map(|s| (k, s))
        })
    });
    FontInfo {
        dict: d,
        subtype,
        base_font,
        descendant,
        descriptor,
        program,
    }
}

/// Decoded font program bytes when ttf-parser can read them (TrueType / OpenType).
pub fn sfnt_bytes(pdf: &Pdf, fi: &FontInfo<'_>) -> Option<Vec<u8>> {
    let (key, s) = fi.program?;
    let ok = match key {
        "FontFile2" => true,
        "FontFile3" => get_name(pdf, &s.dict, b"Subtype") == Some(b"OpenType"),
        _ => false,
    };
    if !ok {
        return None;
    }
    let bytes = decoded(pdf, s)?;
    Face::parse(&bytes, 0).ok()?;
    Some(bytes)
}

// ---------------------------------------------------------------- glyph names

/// Unicode text for a glyph name: AGL, `uniXXXX[XXXX…]`, `uXXXX[XX]`, suffixes (`a.sc`) dropped.
pub fn glyph_unicode(name: &str) -> Option<String> {
    let base = name.split('.').next().unwrap_or(name);
    if base.is_empty() {
        return None;
    }
    if let Some(parts) = base
        .split('_')
        .map(single_glyph_unicode)
        .collect::<Option<Vec<String>>>()
    {
        let s: String = parts.concat();
        if !s.is_empty() {
            return Some(s);
        }
    }
    None
}

fn single_glyph_unicode(n: &str) -> Option<String> {
    if let Ok(i) = AGL.binary_search_by(|(k, _)| (*k).cmp(n)) {
        return AGL
            .get(i)
            .and_then(|(_, u)| char::from_u32(*u))
            .map(String::from);
    }
    if let Some(hex) = n.strip_prefix("uni") {
        if hex.len() >= 4
            && hex.len() % 4 == 0
            && hex
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_lowercase())
        {
            let mut units = Vec::new();
            for i in (0..hex.len()).step_by(4) {
                units.push(u16::from_str_radix(hex.get(i..i + 4)?, 16).ok()?);
            }
            return String::from_utf16(&units).ok();
        }
    }
    if let Some(hex) = n.strip_prefix('u') {
        if (4..=6).contains(&hex.len())
            && hex
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_lowercase())
        {
            return u32::from_str_radix(hex, 16)
                .ok()
                .and_then(char::from_u32)
                .map(String::from);
        }
    }
    None
}

/// Whether a glyph name is in the Adobe Glyph List.
pub fn in_agl(name: &str) -> bool {
    AGL.binary_search_by(|(k, _)| (*k).cmp(name)).is_ok()
}

fn base_table(name: &[u8]) -> Option<&'static [&'static str; 256]> {
    match name {
        b"WinAnsiEncoding" => Some(&WIN_ANSI),
        b"MacRomanEncoding" => Some(&MAC_ROMAN),
        b"StandardEncoding" => Some(&STANDARD),
        _ => None,
    }
}

/// How a simple font's encoding is specified.
#[derive(Debug, Clone, PartialEq)]
pub struct SimpleEncoding {
    /// Glyph name per code (`None` = undefined / built-in encoding unknown).
    pub names: Vec<Option<String>>,
    /// Base encoding name, if one of the three standard ones.
    pub base: Option<&'static str>,
    /// Has a /Differences array.
    pub has_differences: bool,
    /// All /Differences names are AGL names.
    pub differences_in_agl: bool,
}

/// Code → glyph name for a simple font. Without /Encoding (or /BaseEncoding), non-symbolic
/// fonts use StandardEncoding; symbolic fonts use their built-in encoding (unknown here).
pub fn simple_encoding(pdf: &Pdf, fi: &FontInfo<'_>) -> SimpleEncoding {
    let default_base: Option<&'static str> = if fi.symbolic() && !is_standard14_text(&fi.base_font)
    {
        None
    } else {
        Some("StandardEncoding")
    };
    let mut enc = SimpleEncoding {
        names: vec![None; 256],
        base: default_base,
        has_differences: false,
        differences_in_agl: true,
    };
    let mut diffs: Option<&Vec<Object>> = None;
    match get(pdf, fi.dict, b"Encoding") {
        Some(Object::Name(n)) => {
            if let Some((name, _)) = [
                ("WinAnsiEncoding", ()),
                ("MacRomanEncoding", ()),
                ("StandardEncoding", ()),
            ]
            .into_iter()
            .find(|(k, _)| k.as_bytes() == n.as_slice())
            {
                enc.base = Some(name);
            }
        }
        Some(Object::Dictionary(d)) => {
            if let Some(n) = get_name(pdf, d, b"BaseEncoding") {
                enc.base = ["WinAnsiEncoding", "MacRomanEncoding", "StandardEncoding"]
                    .into_iter()
                    .find(|k| k.as_bytes() == n)
                    .or(default_base);
            }
            if let Some(Object::Array(a)) = get(pdf, d, b"Differences") {
                diffs = Some(a);
            }
        }
        _ => {}
    }
    if let Some(table) = enc.base.and_then(|b| base_table(b.as_bytes())) {
        for (slot, n) in enc.names.iter_mut().zip(table.iter()) {
            if !n.is_empty() {
                *slot = Some((*n).to_string());
            }
        }
    }
    if let Some(a) = diffs {
        enc.has_differences = true;
        let mut code: i64 = -1;
        for o in a.iter().take(4096) {
            match pdf.resolve(o) {
                Some(Object::Integer(i)) => code = *i,
                Some(Object::Name(n)) => {
                    if (0..256).contains(&code) {
                        let name = String::from_utf8_lossy(n).into_owned();
                        if !in_agl(&name) && name != ".notdef" {
                            enc.differences_in_agl = false;
                        }
                        if let Some(slot) = enc.names.get_mut(code as usize) {
                            *slot = Some(name);
                        }
                    }
                    code += 1;
                }
                _ => {}
            }
        }
    }
    enc
}

// ---------------------------------------------------------------- TrueType mapping

fn cmap_lookup(face: &Face<'_>, platform: PlatformId, encoding: u16, code: u32) -> Option<GlyphId> {
    let cmap = face.tables().cmap?;
    for st in cmap.subtables {
        if st.platform_id == platform && st.encoding_id == encoding {
            if let Some(g) = st.glyph_index(code) {
                if g.0 != 0 {
                    return Some(g);
                }
            }
        }
    }
    None
}

fn has_cmap(face: &Face<'_>, platform: PlatformId, encoding: u16) -> bool {
    face.tables().cmap.is_some_and(|c| {
        c.subtables
            .into_iter()
            .any(|s| s.platform_id == platform && s.encoding_id == encoding)
    })
}

/// Glyph for `code` in a simple TrueType font (ISO 32000-1 9.6.6.4). `None` = .notdef.
pub fn truetype_glyph(
    face: &Face<'_>,
    enc: &SimpleEncoding,
    symbolic: bool,
    code: u8,
) -> Option<GlyphId> {
    let name = enc.names.get(usize::from(code)).and_then(|n| n.as_deref());
    if !symbolic && has_cmap(face, PlatformId::Windows, 1) {
        let u = name.and_then(glyph_unicode)?;
        let c = u.chars().next()?;
        return cmap_lookup(face, PlatformId::Windows, 1, c as u32);
    }
    if has_cmap(face, PlatformId::Windows, 0) {
        let c = u32::from(code);
        for base in [0, 0xF000, 0xF100, 0xF200] {
            if let Some(g) = cmap_lookup(face, PlatformId::Windows, 0, base + c) {
                return Some(g);
            }
        }
        return None;
    }
    if has_cmap(face, PlatformId::Macintosh, 0) {
        // With an encoding: glyph name → MacRoman code; otherwise the code itself.
        let mac_code = match (name, enc.base.is_some() || enc.has_differences) {
            (Some(n), true) => MAC_ROMAN.iter().position(|m| *m == n).map(|p| p as u32),
            _ => Some(u32::from(code)),
        };
        return mac_code.and_then(|c| cmap_lookup(face, PlatformId::Macintosh, 0, c));
    }
    if has_cmap(face, PlatformId::Windows, 1) {
        let u = name.and_then(glyph_unicode)?;
        return cmap_lookup(face, PlatformId::Windows, 1, u.chars().next()? as u32);
    }
    if has_cmap(face, PlatformId::Unicode, 3) {
        let u = name.and_then(glyph_unicode)?;
        return cmap_lookup(face, PlatformId::Unicode, 3, u.chars().next()? as u32);
    }
    None
}

/// Advance width of `g` in PDF glyph space (1/1000 em).
pub fn advance(face: &Face<'_>, g: GlyphId) -> Option<f64> {
    let upem = f64::from(face.units_per_em());
    if upem <= 0.0 {
        return None;
    }
    face.glyph_hor_advance(g)
        .map(|a| f64::from(a) * 1000.0 / upem)
}

/// Declared width of simple-font code `code` from /FirstChar, /Widths (and /MissingWidth).
pub fn declared_width(pdf: &Pdf, fi: &FontInfo<'_>, code: u8) -> Option<f64> {
    let first = get_num(pdf, fi.dict, b"FirstChar")? as i64;
    let Some(Object::Array(w)) = get(pdf, fi.dict, b"Widths") else {
        return None;
    };
    let i = i64::from(code) - first;
    if i < 0 || i as usize >= w.len() {
        return fi
            .descriptor
            .and_then(|d| get_num(pdf, d, b"MissingWidth"))
            .or(Some(0.0));
    }
    w.get(i as usize).and_then(|o| pdf.resolve(o)).and_then(num)
}

/// CIDFont widths: `(cid, width)` pairs from /W (bounded to `limit` entries).
pub fn cid_widths(pdf: &Pdf, cidfont: &Dictionary, limit: usize) -> Vec<(u32, f64)> {
    let mut out = Vec::new();
    let Some(Object::Array(w)) = get(pdf, cidfont, b"W") else {
        return out;
    };
    let mut i = 0;
    while i < w.len() && out.len() < limit {
        let first = w.get(i).and_then(|o| pdf.resolve(o)).and_then(num);
        let second = w.get(i + 1).and_then(|o| pdf.resolve(o));
        match (first, second) {
            (Some(c), Some(Object::Array(ws))) => {
                for (k, x) in ws.iter().enumerate() {
                    if out.len() >= limit {
                        break;
                    }
                    if let Some(v) = pdf.resolve(x).and_then(num) {
                        out.push((c as u32 + k as u32, v));
                    }
                }
                i += 2;
            }
            (Some(c1), Some(o)) => {
                let c2 = num(o).unwrap_or(c1);
                let v = w
                    .get(i + 2)
                    .and_then(|o| pdf.resolve(o))
                    .and_then(num)
                    .unwrap_or(0.0);
                let mut c = c1 as u32;
                while f64::from(c) <= c2 && out.len() < limit {
                    out.push((c, v));
                    c += 1;
                }
                i += 3;
            }
            _ => break,
        }
    }
    out
}

/// CID → GID via /CIDToGIDMap (Identity when absent or /Identity).
pub fn cid_to_gid(pdf: &Pdf, cidfont: &Dictionary, map: &Option<Vec<u8>>, cid: u32) -> u32 {
    let _ = (pdf, cidfont);
    match map {
        Some(bytes) => {
            let i = cid as usize * 2;
            match (bytes.get(i), bytes.get(i + 1)) {
                (Some(a), Some(b)) => u32::from(*a) << 8 | u32::from(*b),
                _ => 0,
            }
        }
        None => cid,
    }
}

/// The /CIDToGIDMap stream bytes (`None` = Identity or absent).
pub fn cid_map_bytes(pdf: &Pdf, cidfont: &Dictionary) -> Option<Vec<u8>> {
    stream(pdf, cidfont.get(b"CIDToGIDMap").ok()?).and_then(|s| decoded(pdf, s))
}

// ---------------------------------------------------------------- codes and CMaps

/// A parsed CMap (codespace + code → Unicode / CID mappings).
#[derive(Debug, Clone, Default)]
pub struct CMap {
    /// Codespace ranges (low, high, byte length).
    pub codespace: Vec<(u32, u32, usize)>,
    /// bfchar/bfrange mappings (code → UTF-16 decoded text).
    pub uni: BTreeMap<u32, String>,
    /// cidchar/cidrange mappings (code → CID).
    pub cid: BTreeMap<u32, u32>,
    /// /CIDSystemInfo registry-ordering found in the CMap, if any.
    pub registry_ordering: Option<(String, String)>,
}

fn be(bytes: &[u8]) -> u32 {
    bytes
        .iter()
        .take(4)
        .fold(0u32, |a, b| a << 8 | u32::from(*b))
}

fn utf16(bytes: &[u8]) -> String {
    let u: Vec<u16> = bytes
        .chunks(2)
        .map(|c| {
            u16::from_be_bytes([
                c.first().copied().unwrap_or(0),
                c.get(1).copied().unwrap_or(0),
            ])
        })
        .collect();
    String::from_utf16_lossy(&u)
}

/// Parse a CMap (ToUnicode or encoding CMap). Bounded to 1,000,000 mappings.
pub fn parse_cmap(bytes: &[u8]) -> CMap {
    const MAX: usize = 1_000_000;
    let mut cm = CMap::default();
    let mut lx = Lexer::new(bytes);
    let mut toks: Vec<Tok<'_>> = Vec::new();
    let mut mode: Option<&[u8]> = None;
    let mut registry: Option<String> = None;
    let mut ordering: Option<String> = None;
    let mut last_name: Option<Vec<u8>> = None;
    while let Some((_, t)) = lx.next_tok() {
        match &t {
            Tok::Kw(k) if k.starts_with(b"begin") => {
                mode = Some(k);
                toks.clear();
                continue;
            }
            Tok::Kw(k) if k.starts_with(b"end") => {
                let items = std::mem::take(&mut toks);
                match mode {
                    Some(b"begincodespacerange") => {
                        for pair in items.chunks(2) {
                            if let [Tok::Hex { bytes: lo, .. }, Tok::Hex { bytes: hi, .. }] = pair {
                                cm.codespace.push((be(lo), be(hi), lo.len().clamp(1, 4)));
                            }
                        }
                    }
                    Some(b"beginbfchar") => {
                        for pair in items.chunks(2) {
                            if let [Tok::Hex { bytes: src, .. }, dst] = pair {
                                let text = match dst {
                                    Tok::Hex { bytes, .. } => utf16(bytes),
                                    Tok::Name(n) => glyph_unicode(&String::from_utf8_lossy(n))
                                        .unwrap_or_default(),
                                    _ => continue,
                                };
                                if cm.uni.len() < MAX {
                                    cm.uni.insert(be(src), text);
                                }
                            }
                        }
                    }
                    Some(b"beginbfrange") => {
                        let mut i = 0;
                        while i + 2 < items.len() {
                            let (
                                Some(Tok::Hex { bytes: lo, .. }),
                                Some(Tok::Hex { bytes: hi, .. }),
                            ) = (items.get(i), items.get(i + 1))
                            else {
                                i += 1;
                                continue;
                            };
                            let (lo, hi) = (be(lo), be(hi));
                            match items.get(i + 2) {
                                Some(Tok::Hex { bytes: dst, .. }) => {
                                    let mut units: Vec<u16> = dst
                                        .chunks(2)
                                        .map(|c| {
                                            u16::from_be_bytes([
                                                c.first().copied().unwrap_or(0),
                                                c.get(1).copied().unwrap_or(0),
                                            ])
                                        })
                                        .collect();
                                    let mut c = lo;
                                    while c <= hi && cm.uni.len() < MAX && c - lo < 65_536 {
                                        cm.uni.insert(c, String::from_utf16_lossy(&units));
                                        if let Some(last) = units.last_mut() {
                                            *last = last.wrapping_add(1);
                                        }
                                        c += 1;
                                    }
                                    i += 3;
                                }
                                Some(Tok::ArrOpen) => {
                                    let mut c = lo;
                                    let mut j = i + 3;
                                    while let Some(t) = items.get(j) {
                                        j += 1;
                                        match t {
                                            Tok::Hex { bytes, .. } => {
                                                if c <= hi && cm.uni.len() < MAX {
                                                    cm.uni.insert(c, utf16(bytes));
                                                }
                                                c += 1;
                                            }
                                            Tok::ArrClose => break,
                                            _ => {}
                                        }
                                    }
                                    i = j;
                                }
                                _ => i += 3,
                            }
                        }
                    }
                    Some(b"begincidchar") => {
                        for pair in items.chunks(2) {
                            if let [Tok::Hex { bytes: src, .. }, Tok::Int(cid)] = pair {
                                if cm.cid.len() < MAX {
                                    cm.cid.insert(be(src), u32::try_from(*cid).unwrap_or(0));
                                }
                            }
                        }
                    }
                    Some(b"begincidrange") => {
                        for tri in items.chunks(3) {
                            if let [Tok::Hex { bytes: lo, .. }, Tok::Hex { bytes: hi, .. }, Tok::Int(cid)] =
                                tri
                            {
                                let (lo, hi) = (be(lo), be(hi));
                                let mut c = lo;
                                while c <= hi && cm.cid.len() < MAX && c - lo < 65_536 {
                                    cm.cid
                                        .insert(c, u32::try_from(*cid).unwrap_or(0) + (c - lo));
                                    c += 1;
                                }
                            }
                        }
                    }
                    _ => {}
                }
                mode = None;
                continue;
            }
            Tok::Name(n) => last_name = Some(n.clone()),
            Tok::Str(s) => match last_name.as_deref() {
                Some(b"Registry") => registry = Some(String::from_utf8_lossy(s).into_owned()),
                Some(b"Ordering") => ordering = Some(String::from_utf8_lossy(s).into_owned()),
                _ => {}
            },
            _ => {}
        }
        if mode.is_some() && toks.len() < 3 * MAX {
            toks.push(t);
        }
    }
    if let (Some(r), Some(o)) = (registry, ordering) {
        cm.registry_ordering = Some((r, o));
    }
    cm
}

impl CMap {
    /// Split a string into codes using the codespace ranges (1 byte if none).
    pub fn codes(&self, s: &[u8]) -> Vec<u32> {
        let mut out = Vec::new();
        let mut i = 0;
        while i < s.len() {
            let mut matched = 0;
            for n in 1..=4 {
                let Some(chunk) = s.get(i..i + n) else { break };
                let v = be(chunk);
                if self
                    .codespace
                    .iter()
                    .any(|(lo, hi, len)| *len == n && v >= *lo && v <= *hi)
                {
                    matched = n;
                    break;
                }
            }
            let n = if matched == 0 {
                self.codespace.first().map(|c| c.2).unwrap_or(1)
            } else {
                matched
            };
            out.push(be(s.get(i..(i + n).min(s.len())).unwrap_or_default()));
            i += n;
        }
        out
    }
}

/// Codes of a text string for a font: 1 byte for simple fonts, 2 bytes for Identity-H/V,
/// codespace of an embedded encoding CMap; `None` for predefined CMaps we do not know.
pub fn codes(pdf: &Pdf, fi: &FontInfo<'_>, s: &[u8]) -> Option<Vec<u32>> {
    if fi.subtype != "Type0" {
        return Some(s.iter().map(|b| u32::from(*b)).collect());
    }
    match get(pdf, fi.dict, b"Encoding")? {
        Object::Name(n) if n == b"Identity-H" || n == b"Identity-V" => {
            Some(s.chunks(2).map(be).collect())
        }
        Object::Stream(st) => {
            let cm = parse_cmap(&decoded(pdf, st)?);
            Some(cm.codes(s))
        }
        _ => None,
    }
}

/// A ToUnicode CMap mapping `entries` (code → text); `code_bytes` is 1 or 2.
pub fn write_tounicode(entries: &BTreeMap<u32, String>, code_bytes: usize) -> Vec<u8> {
    let mut out = String::from(
        "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n",
    );
    if code_bytes == 1 {
        out.push_str("<00> <FF>\n");
    } else {
        out.push_str("<0000> <FFFF>\n");
    }
    out.push_str("endcodespacerange\n");
    let list: Vec<(&u32, &String)> = entries
        .iter()
        .filter(|(_, t)| !t.is_empty() && !t.contains(['\u{0}', '\u{FEFF}', '\u{FFFE}']))
        .collect();
    for chunk in list.chunks(100) {
        out.push_str(&format!("{} beginbfchar\n", chunk.len()));
        for (code, text) in chunk {
            let hex: String = text.encode_utf16().map(|u| format!("{u:04X}")).collect();
            if code_bytes == 1 {
                out.push_str(&format!("<{code:02X}> <{hex}>\n"));
            } else {
                out.push_str(&format!("<{code:04X}> <{hex}>\n"));
            }
        }
        out.push_str("endbfchar\n");
    }
    out.push_str("endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n");
    out.into_bytes()
}

// ---------------------------------------------------------------- standard 14

/// Whether `base` names one of the 12 standard text fonts (or a common alias).
pub fn is_standard14_text(base: &str) -> bool {
    substitute_for(base).is_some()
}

/// Whether `base` is Symbol or ZapfDingbats (no metric-compatible OFL substitute is bundled).
pub fn is_symbol_font(base: &str) -> bool {
    let b = strip_subset(base).to_ascii_lowercase();
    b == "symbol"
        || b == "zapfdingbats"
        || b.starts_with("symbol,")
        || b.starts_with("zapfdingbats")
}

fn strip_subset(base: &str) -> &str {
    match base.split_once('+') {
        Some((p, rest)) if p.len() == 6 && p.bytes().all(|b| b.is_ascii_uppercase()) => rest,
        _ => base,
    }
}

/// The bundled metric-compatible substitute (PostScript name of a Liberation font) for a standard
/// text font or its common Windows alias: Helvetica/Arial → Liberation Sans, Times/Times New Roman →
/// Liberation Serif, Courier/Courier New → Liberation Mono.
pub fn substitute_for(base: &str) -> Option<&'static str> {
    let b: String = strip_subset(base)
        .chars()
        .filter(|c| !matches!(c, ' ' | '-' | ',' | '_'))
        .collect::<String>()
        .to_ascii_lowercase();
    let families: [(&str, usize); 8] = [
        ("helvetica", 0),
        ("arialmt", 0),
        ("arial", 0),
        ("timesnewromanps", 1),
        ("timesnewroman", 1),
        ("timesroman", 1),
        ("times", 1),
        ("couriernewps", 2),
    ];
    let extra: [(&str, usize); 2] = [("couriernew", 2), ("courier", 2)];
    let (fam, rest) = families
        .iter()
        .chain(extra.iter())
        .find_map(|(p, f)| b.strip_prefix(p).map(|r| (*f, r.to_string())))?;
    let mut rest = rest;
    for suffix in ["psmt", "mt", "ps"] {
        if let Some(r) = rest.strip_suffix(suffix) {
            rest = r.to_string();
            break;
        }
    }
    let (bold, italic) = match rest.as_str() {
        "" | "roman" | "regular" => (false, false),
        "bold" => (true, false),
        "italic" | "oblique" => (false, true),
        "bolditalic" | "boldoblique" => (true, true),
        _ => return None,
    };
    let names: [[&'static str; 4]; 3] = [
        [
            "LiberationSans",
            "LiberationSans-Bold",
            "LiberationSans-Italic",
            "LiberationSans-BoldItalic",
        ],
        [
            "LiberationSerif",
            "LiberationSerif-Bold",
            "LiberationSerif-Italic",
            "LiberationSerif-BoldItalic",
        ],
        [
            "LiberationMono",
            "LiberationMono-Bold",
            "LiberationMono-Italic",
            "LiberationMono-BoldItalic",
        ],
    ];
    let idx = usize::from(bold) + 2 * usize::from(italic);
    names.get(fam).and_then(|n| n.get(idx)).copied()
}

/// Liberation file stem for a PostScript name (`LiberationSans` → `LiberationSans-Regular`).
pub fn substitute_file(ps: &str) -> String {
    if ps.contains('-') {
        ps.to_string()
    } else {
        format!("{ps}-Regular")
    }
}

/// PostScript name (name ID 6) of a font program.
pub fn postscript_name(face: &Face<'_>) -> Option<String> {
    face.names()
        .into_iter()
        .filter(|n| n.name_id == ttf_parser::name_id::POST_SCRIPT_NAME)
        .find_map(|n| {
            n.to_string()
                .or_else(|| std::str::from_utf8(n.name).ok().map(str::to_string))
        })
}

/// Fonts dictionary helper: the /FontFile2 stream's object for a descriptor.
pub fn descriptor_of<'a>(pdf: &'a Pdf, d: &'a Dictionary) -> Option<&'a Dictionary> {
    get_dict(pdf, d, b"FontDescriptor")
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    #[test]
    fn glyph_names() {
        assert_eq!(glyph_unicode("A").as_deref(), Some("A"));
        assert_eq!(glyph_unicode("quoteright").as_deref(), Some("\u{2019}"));
        assert_eq!(glyph_unicode("uni0627").as_deref(), Some("\u{627}"));
        assert_eq!(glyph_unicode("u1F600").as_deref(), Some("\u{1F600}"));
        assert_eq!(glyph_unicode("f_i").as_deref(), Some("fi"));
        assert_eq!(glyph_unicode("a.sc").as_deref(), Some("a"));
        assert_eq!(glyph_unicode("g123"), None);
        assert!(in_agl("Euro") && !in_agl("g123"));
        assert_eq!(WIN_ANSI[0x80], "Euro");
        assert_eq!(STANDARD[0x27], "quoteright");
    }

    #[test]
    fn substitutes() {
        assert_eq!(substitute_for("Helvetica"), Some("LiberationSans"));
        assert_eq!(
            substitute_for("Helvetica-BoldOblique"),
            Some("LiberationSans-BoldItalic")
        );
        assert_eq!(
            substitute_for("ABCDEF+Arial,Bold"),
            Some("LiberationSans-Bold")
        );
        assert_eq!(substitute_for("ArialMT"), Some("LiberationSans"));
        assert_eq!(
            substitute_for("Arial-ItalicMT"),
            Some("LiberationSans-Italic")
        );
        assert_eq!(substitute_for("Times-Roman"), Some("LiberationSerif"));
        assert_eq!(
            substitute_for("TimesNewRomanPS-BoldMT"),
            Some("LiberationSerif-Bold")
        );
        assert_eq!(
            substitute_for("Courier-Oblique"),
            Some("LiberationMono-Italic")
        );
        assert_eq!(substitute_for("CourierNewPSMT"), Some("LiberationMono"));
        assert_eq!(substitute_for("Helvetica-Narrow"), None);
        assert_eq!(substitute_for("Arial-Black"), None);
        assert_eq!(substitute_for("Symbol"), None);
        assert!(is_symbol_font("ZapfDingbats"));
        assert_eq!(substitute_file("LiberationSans"), "LiberationSans-Regular");
    }

    #[test]
    fn cmaps_round_trip() {
        let mut m = BTreeMap::new();
        m.insert(0x41, "A".to_string());
        m.insert(0x42, "\u{627}\u{644}".to_string());
        m.insert(0x43, "\u{0}".to_string());
        let cm = parse_cmap(&write_tounicode(&m, 1));
        assert_eq!(cm.uni.get(&0x41).map(String::as_str), Some("A"));
        assert_eq!(
            cm.uni.get(&0x42).map(String::as_str),
            Some("\u{627}\u{644}")
        );
        assert!(!cm.uni.contains_key(&0x43));
        assert_eq!(cm.codes(b"AB"), vec![0x41, 0x42]);
        let cm = parse_cmap(b"1 begincodespacerange <0000> <FFFF> endcodespacerange 1 beginbfrange <0010> <0012> <0061> endbfrange 1 beginbfrange <0020> <0021> [<0041> <0042>] endbfrange");
        assert_eq!(cm.uni.get(&0x12).map(String::as_str), Some("c"));
        assert_eq!(cm.uni.get(&0x21).map(String::as_str), Some("B"));
        assert_eq!(cm.codes(&[0, 0x10, 0, 0x20]), vec![0x10, 0x20]);
    }
}
