//! PDF font model for text extraction: code splitting, code → Unicode, glyph widths.
//!
//! Fonts are identified by [`FontKey`] — the font dictionary's object id (or a content hash for
//! the rare direct dictionary) — never by pointer, so a cache entry can never alias a freed or
//! different font.

use std::collections::{BTreeMap, HashMap};
use std::hash::{Hash, Hasher};

use lopdf::{Dictionary, Object};

use crate::cmap::{utf16_to_string, CMap};
use crate::encoding::{glyph_name_to_unicode, BaseEncoding};
use crate::geom::Matrix;
use crate::limits;
use crate::source::{as_number, dict_get, resolve, resolve_dict, stream_data, ContentSource};

/// Stable font identity.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum FontKey {
    /// Indirect font dictionary `(object number, generation)`.
    Object(u32, u16),
    /// Direct dictionary: hash of its serialised content.
    Inline(u64),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FontKind {
    Simple,
    Type0,
    Type3,
}

/// One decoded character code.
#[derive(Debug, Clone, PartialEq)]
pub struct Decoded {
    pub code: u32,
    pub len: usize,
    /// Unicode text (may be empty or several characters).
    pub text: String,
    /// Horizontal advance in text space units per unit font size (i.e. already ÷1000).
    pub width: f64,
    /// Single-byte code 32: word spacing applies.
    pub word_space: bool,
}

/// A loaded font.
#[derive(Debug, Clone)]
pub struct Font {
    pub key: FontKey,
    pub name: String,
    pub kind: FontKind,
    pub vertical: bool,
    pub bold: bool,
    /// Italic/oblique (font name or descriptor `/Flags` bit 7, `/ItalicAngle`).
    pub italic: bool,
    /// Ascent / descent in text space units per unit font size.
    pub ascent: f64,
    pub descent: f64,
    encoding: Option<CMap>,
    ucs2_encoding: bool,
    to_unicode: Option<CMap>,
    simple_map: Vec<Option<String>>,
    first_char: u32,
    widths: Vec<f64>,
    missing_width: f64,
    cid_default_width: f64,
    cid_widths: BTreeMap<u32, (u32, f64)>,
    cid_to_gid: Option<Vec<u16>>,
    gid_to_unicode: HashMap<u32, char>,
    /// Glyph space → text space scale for widths (0.001 except Type3).
    width_scale: f64,
    standard_widths: Option<fn(u8) -> f64>,
}

fn hash_dict(d: &Dictionary) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    let s = format!("{d:?}");
    s.get(..s.len().min(64 * 1024)).unwrap_or("").hash(&mut h);
    h.finish()
}

fn name_of(o: Option<&Object>) -> Option<&[u8]> {
    match o {
        Some(Object::Name(n)) => Some(n.as_slice()),
        _ => None,
    }
}

/// Helvetica widths for 0x20..=0x7E (Standard 14 fonts without /Widths).
const HELVETICA: [u16; 95] = [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
    556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
    611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
    667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
    222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

fn helvetica_width(code: u8) -> f64 {
    match code {
        0x20..=0x7e => f64::from(
            HELVETICA
                .get(usize::from(code - 0x20))
                .copied()
                .unwrap_or(556),
        ),
        _ => 556.0,
    }
}

fn courier_width(_: u8) -> f64 {
    600.0
}

fn times_width(code: u8) -> f64 {
    helvetica_width(code) * 0.9
}

impl Font {
    /// Minimal font used when `Tf` names an unknown resource (text is still positioned).
    pub fn fallback() -> Font {
        Font {
            key: FontKey::Inline(0),
            name: String::from("(missing)"),
            kind: FontKind::Simple,
            vertical: false,
            bold: false,
            italic: false,
            ascent: 0.8,
            descent: -0.2,
            encoding: None,
            ucs2_encoding: false,
            to_unicode: None,
            simple_map: (0u8..=255)
                .map(|c| BaseEncoding::WinAnsi.decode(c).map(String::from))
                .collect(),
            first_char: 0,
            widths: Vec::new(),
            missing_width: 500.0,
            cid_default_width: 1000.0,
            cid_widths: BTreeMap::new(),
            cid_to_gid: None,
            gid_to_unicode: HashMap::new(),
            width_scale: 0.001,
            standard_widths: Some(helvetica_width),
        }
    }

    /// Key for a font resource entry.
    pub fn key_for(obj: &Object, resolved: &Dictionary) -> FontKey {
        match obj {
            Object::Reference((n, g)) => FontKey::Object(*n, *g),
            _ => FontKey::Inline(hash_dict(resolved)),
        }
    }

    /// Load a font from its dictionary.
    pub fn load<S: ContentSource + ?Sized>(src: &S, key: FontKey, dict: &Dictionary) -> Font {
        let subtype = name_of(dict_get(src, dict, b"Subtype")).unwrap_or(b"Type1");
        let base_font = name_of(dict_get(src, dict, b"BaseFont"))
            .map(|n| String::from_utf8_lossy(n).into_owned())
            .unwrap_or_default();
        let mut f = Font::fallback();
        f.key = key;
        f.name = base_font.clone();
        f.standard_widths = None;
        f.simple_map = vec![None; 256];
        let to_unicode = dict_get(src, dict, b"ToUnicode").and_then(|o| match o {
            Object::Stream(s) => stream_data(s).ok().map(|d| CMap::parse(&d)),
            _ => None,
        });
        f.to_unicode = to_unicode.filter(|m| !m.is_empty());
        match subtype {
            b"Type0" => f.load_type0(src, dict),
            b"Type3" => {
                f.kind = FontKind::Type3;
                f.load_simple(src, dict, true);
            }
            _ => f.load_simple(src, dict, false),
        }
        let lname = base_font.to_ascii_lowercase();
        f.bold =
            f.bold || lname.contains("bold") || lname.contains("black") || lname.contains("heavy");
        f.italic = f.italic || lname.contains("italic") || lname.contains("oblique");
        f
    }

    fn load_descriptor<S: ContentSource + ?Sized>(&mut self, src: &S, fd: &Dictionary) {
        let num = |k: &[u8]| dict_get(src, fd, k).and_then(as_number);
        if let (Some(a), Some(d)) = (num(b"Ascent"), num(b"Descent")) {
            let (a, d) = (a / 1000.0, d / 1000.0);
            if a > 0.3 && a < 3.0 {
                self.ascent = a;
            }
            if d < 0.0 && d > -2.0 {
                self.descent = d;
            } else if d > 0.0 && d < 2.0 {
                self.descent = -d;
            }
        }
        if let Some(w) = num(b"MissingWidth") {
            self.missing_width = w;
        }
        if let Some(w) = num(b"FontWeight") {
            self.bold = w >= 600.0;
        }
        if let Some(flags) = num(b"Flags") {
            if (flags as i64) & (1 << 18) != 0 {
                self.bold = true;
            }
            if (flags as i64) & (1 << 6) != 0 {
                self.italic = true;
            }
        }
        if num(b"ItalicAngle").is_some_and(|a| a.abs() > 1.0 && a.abs() < 45.0) {
            self.italic = true;
        }
    }

    fn load_embedded_cmap<S: ContentSource + ?Sized>(&mut self, src: &S, fd: &Dictionary) {
        let Some(Object::Stream(s)) =
            dict_get(src, fd, b"FontFile2").or_else(|| dict_get(src, fd, b"FontFile3"))
        else {
            return;
        };
        let Ok(data) = stream_data(s) else { return };
        use read_fonts::TableProvider;
        let Ok(font) = read_fonts::FontRef::new(&data) else {
            return;
        };
        let Ok(cmap) = font.cmap() else { return };
        let Some((_, _, sub)) = cmap.best_subtable() else {
            return;
        };
        for (cp, gid) in sub.iter().take(70_000) {
            if let Some(c) = char::from_u32(cp) {
                if !c.is_control() {
                    self.gid_to_unicode.entry(gid.to_u32()).or_insert(c);
                }
            }
        }
    }

    fn load_simple<S: ContentSource + ?Sized>(&mut self, src: &S, dict: &Dictionary, type3: bool) {
        if type3 {
            if let Some(Object::Array(a)) = dict_get(src, dict, b"FontMatrix") {
                let v: Vec<f64> = a
                    .iter()
                    .filter_map(|o| resolve(src, o).and_then(as_number))
                    .collect();
                if let [a0, b, c, d, e, f] = v.as_slice() {
                    let m = Matrix::new(*a0, *b, *c, *d, *e, *f);
                    if m.a.abs() > 1e-9 {
                        self.width_scale = m.a;
                    }
                }
            }
        }
        if let Some(fd) = dict_get(src, dict, b"FontDescriptor").and_then(|o| resolve_dict(src, o))
        {
            self.load_descriptor(src, fd);
        }
        self.first_char = dict_get(src, dict, b"FirstChar")
            .and_then(as_number)
            .map(|v| v.max(0.0) as u32)
            .unwrap_or(0);
        if let Some(Object::Array(ws)) = dict_get(src, dict, b"Widths") {
            self.widths = ws
                .iter()
                .take(limits::MAX_WIDTH_ENTRIES)
                .map(|o| resolve(src, o).and_then(as_number).unwrap_or(0.0))
                .collect();
        }
        let lname = self.name.to_ascii_lowercase();
        if self.widths.is_empty() && !type3 {
            self.standard_widths = Some(if lname.contains("courier") {
                courier_width
            } else if lname.contains("times") {
                times_width
            } else {
                helvetica_width
            });
        }
        // Encoding.
        let symbolic = lname.contains("symbol") || lname.contains("dingbats");
        let mut base = if symbolic {
            BaseEncoding::Builtin
        } else {
            BaseEncoding::Standard
        };
        let mut differences: Vec<(u8, String)> = Vec::new();
        match dict_get(src, dict, b"Encoding") {
            Some(Object::Name(n)) => {
                if let Some(b) = BaseEncoding::from_name(n) {
                    base = b;
                }
            }
            Some(Object::Dictionary(ed)) => {
                if let Some(b) =
                    name_of(dict_get(src, ed, b"BaseEncoding")).and_then(BaseEncoding::from_name)
                {
                    base = b;
                } else if type3 || lname.contains('+') {
                    // Embedded subset without base encoding: names carry the meaning.
                    base = BaseEncoding::Standard;
                }
                if let Some(Object::Array(diffs)) = dict_get(src, ed, b"Differences") {
                    let mut code: i64 = 0;
                    for item in diffs.iter().take(4096) {
                        match resolve(src, item) {
                            Some(Object::Integer(i)) => code = *i,
                            Some(Object::Real(r)) => code = *r as i64,
                            Some(Object::Name(n)) => {
                                if let Ok(c) = u8::try_from(code) {
                                    differences.push((c, String::from_utf8_lossy(n).into_owned()));
                                }
                                code += 1;
                            }
                            _ => {}
                        }
                    }
                }
            }
            _ => {
                if !self.widths.is_empty() && lname.contains('+') && !type3 {
                    // Embedded TrueType without encoding: treat as WinAnsi (common producer behaviour).
                    base = BaseEncoding::WinAnsi;
                }
            }
        }
        for c in 0u8..=255 {
            if let Some(slot) = self.simple_map.get_mut(usize::from(c)) {
                *slot = base.decode(c).map(String::from);
            }
        }
        for (c, name) in differences {
            if let Some(slot) = self.simple_map.get_mut(usize::from(c)) {
                *slot = glyph_name_to_unicode(&name);
            }
        }
    }

    fn load_type0<S: ContentSource + ?Sized>(&mut self, src: &S, dict: &Dictionary) {
        self.kind = FontKind::Type0;
        match dict_get(src, dict, b"Encoding") {
            Some(Object::Name(n)) => {
                let name = String::from_utf8_lossy(n).into_owned();
                self.set_predefined_cmap(&name);
            }
            Some(Object::Stream(s)) => {
                let mut cm = stream_data(s).map(|d| CMap::parse(&d)).unwrap_or_default();
                if let Some(parent) = cm.use_cmap.clone() {
                    if parent.starts_with("Identity") {
                        cm.merge_parent(&CMap::identity(parent.ends_with('V')));
                    }
                }
                let wm = dict_get(src, &s.dict, b"WMode")
                    .and_then(as_number)
                    .unwrap_or(0.0);
                self.vertical = cm.wmode == 1 || wm >= 1.0;
                if !cm.has_codespace() && cm.is_empty() {
                    cm = CMap::identity(self.vertical);
                }
                self.encoding = Some(cm);
            }
            _ => self.set_predefined_cmap("Identity-H"),
        }
        let desc = dict_get(src, dict, b"DescendantFonts").and_then(|o| match o {
            Object::Array(a) => a.first().and_then(|d| resolve_dict(src, d)),
            _ => None,
        });
        let Some(desc) = desc else { return };
        if let Some(fd) = dict_get(src, desc, b"FontDescriptor").and_then(|o| resolve_dict(src, o))
        {
            self.load_descriptor(src, fd);
            if self.to_unicode.is_none() {
                self.load_embedded_cmap(src, fd);
            }
        }
        self.cid_default_width = dict_get(src, desc, b"DW")
            .and_then(as_number)
            .unwrap_or(1000.0);
        if let Some(Object::Array(w)) = dict_get(src, desc, b"W") {
            self.parse_w(src, w);
        }
        if let Some(Object::Stream(s)) = dict_get(src, desc, b"CIDToGIDMap") {
            if let Ok(d) = stream_data(s) {
                self.cid_to_gid = Some(
                    d.chunks(2)
                        .take(70_000)
                        .map(|c| match c {
                            [a, b] => u16::from(*a) << 8 | u16::from(*b),
                            _ => 0,
                        })
                        .collect(),
                );
            }
        }
    }

    fn set_predefined_cmap(&mut self, name: &str) {
        self.vertical = name.ends_with("-V");
        if name.starts_with("Uni") && (name.contains("UCS2") || name.contains("UTF16")) {
            self.ucs2_encoding = true;
        }
        self.encoding = Some(CMap::identity(self.vertical));
    }

    fn parse_w<S: ContentSource + ?Sized>(&mut self, src: &S, w: &[Object]) {
        let mut i = 0usize;
        let mut entries = 0usize;
        while i < w.len() && entries < limits::MAX_WIDTH_ENTRIES {
            let Some(first) = w.get(i).and_then(|o| resolve(src, o)).and_then(as_number) else {
                i += 1;
                continue;
            };
            let first = first.max(0.0) as u32;
            match w.get(i + 1).and_then(|o| resolve(src, o)) {
                Some(Object::Array(ws)) => {
                    for (k, wv) in ws.iter().take(limits::MAX_WIDTH_ENTRIES).enumerate() {
                        let cid = first.saturating_add(k as u32);
                        let v = resolve(src, wv)
                            .and_then(as_number)
                            .unwrap_or(self.cid_default_width);
                        self.cid_widths.insert(cid, (cid, v));
                        entries += 1;
                    }
                    i += 2;
                }
                Some(o) => {
                    let last = as_number(o).unwrap_or(0.0).max(0.0) as u32;
                    let v = w
                        .get(i + 2)
                        .and_then(|o| resolve(src, o))
                        .and_then(as_number);
                    if let Some(v) = v {
                        if last >= first {
                            self.cid_widths.insert(first, (last, v));
                            entries += 1;
                        }
                    }
                    i += 3;
                }
                None => break,
            }
        }
    }

    fn cid_width(&self, cid: u32) -> f64 {
        match self.cid_widths.range(..=cid).next_back() {
            Some((_, (last, w))) if cid <= *last => *w,
            _ => self.cid_default_width,
        }
    }

    fn simple_width(&self, code: u32) -> f64 {
        if let Some(f) = self.standard_widths {
            return f(u8::try_from(code).unwrap_or(0));
        }
        match code
            .checked_sub(self.first_char)
            .and_then(|i| self.widths.get(i as usize))
        {
            Some(w) => *w,
            None => self.missing_width,
        }
    }

    /// Decode a string operand into character codes with text and advance.
    pub fn decode(&self, bytes: &[u8]) -> Vec<Decoded> {
        let mut out = Vec::new();
        let mut rest = bytes;
        while !rest.is_empty() {
            let (code, len) = match (&self.kind, &self.encoding) {
                (FontKind::Type0, Some(cm)) => cm.next_code(rest),
                _ => (u32::from(rest.first().copied().unwrap_or(0)), 1),
            };
            let len = len.clamp(1, rest.len().max(1));
            rest = rest.get(len..).unwrap_or(&[]);
            out.push(self.decode_code(code, len));
        }
        out
    }

    fn decode_code(&self, code: u32, len: usize) -> Decoded {
        let from_tu = self
            .to_unicode
            .as_ref()
            .and_then(|m| m.lookup_unicode(code, len));
        let (text, width) = match self.kind {
            FontKind::Type0 => {
                let cid = self
                    .encoding
                    .as_ref()
                    .and_then(|m| m.lookup_cid(code, len))
                    .unwrap_or(code);
                let text = from_tu.or_else(|| {
                    if self.ucs2_encoding {
                        Some(utf16_to_string(&[(code & 0xffff) as u16]))
                    } else {
                        let gid = match &self.cid_to_gid {
                            Some(map) => {
                                map.get(cid as usize).map(|g| u32::from(*g)).unwrap_or(cid)
                            }
                            None => cid,
                        };
                        self.gid_to_unicode.get(&gid).map(|c| c.to_string())
                    }
                });
                (text, self.cid_width(cid) * 0.001)
            }
            FontKind::Simple | FontKind::Type3 => {
                let text =
                    from_tu.or_else(|| self.simple_map.get(code as usize).cloned().flatten());
                (text, self.simple_width(code) * self.width_scale)
            }
        };
        Decoded {
            code,
            len,
            text: text.unwrap_or_default(),
            width,
            word_space: len == 1 && code == 32,
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;
    use lopdf::{dictionary, Document, Stream};

    use crate::source::LopdfSource;

    fn src_with(doc: Document) -> LopdfSource {
        LopdfSource::from_document(doc)
    }

    #[test]
    fn simple_font_differences_and_widths() {
        let mut doc = Document::with_version("1.7");
        let enc = doc.add_object(dictionary! {
            "Type" => "Encoding",
            "BaseEncoding" => "WinAnsiEncoding",
            "Differences" => vec![Object::Integer(1), Object::Name(b"afii57415".to_vec()), Object::Name(b"lam_alef-ar".to_vec())],
        });
        let font = doc.add_object(dictionary! {
            "Type" => "Font", "Subtype" => "TrueType", "BaseFont" => "ABCDEF+Test",
            "FirstChar" => 0, "Widths" => vec![Object::Integer(0), Object::Integer(400), Object::Integer(700)],
            "Encoding" => enc,
        });
        let src = src_with(doc);
        let d = resolve_dict(&src, &Object::Reference(font))
            .unwrap()
            .clone();
        let f = Font::load(&src, FontKey::Object(font.0, font.1), &d);
        let dec = f.decode(&[1, 2, b'A']);
        assert_eq!(dec[0].text, "ا");
        assert!((dec[0].width - 0.4).abs() < 1e-9);
        assert_eq!(dec[1].text, "لا");
        assert_eq!(dec[2].text, "A");
    }

    #[test]
    fn type0_identity_with_tounicode_and_w() {
        let mut doc = Document::with_version("1.7");
        let tu = doc.add_object(Stream::new(
            dictionary! {},
            b"1 begincodespacerange <0000> <FFFF> endcodespacerange 1 beginbfchar <0005> <0628> endbfchar".to_vec(),
        ));
        let desc = doc.add_object(dictionary! {
            "Type" => "Font", "Subtype" => "CIDFontType2", "BaseFont" => "X",
            "DW" => 1000,
            "W" => vec![Object::Integer(5), Object::Array(vec![Object::Integer(321)]), Object::Integer(10), Object::Integer(20), Object::Integer(250)],
        });
        let font = doc.add_object(dictionary! {
            "Type" => "Font", "Subtype" => "Type0", "BaseFont" => "X", "Encoding" => "Identity-H",
            "DescendantFonts" => vec![Object::Reference(desc)], "ToUnicode" => tu,
        });
        let src = src_with(doc);
        let d = resolve_dict(&src, &Object::Reference(font))
            .unwrap()
            .clone();
        let f = Font::load(&src, FontKey::Object(font.0, font.1), &d);
        let dec = f.decode(&[0, 5, 0, 15, 0, 30, 7]);
        assert_eq!(dec.len(), 4);
        assert_eq!(dec[0].text, "ب");
        assert!((dec[0].width - 0.321).abs() < 1e-9);
        assert!((dec[1].width - 0.25).abs() < 1e-9);
        assert!((dec[2].width - 1.0).abs() < 1e-9);
        assert_eq!(dec[3].len, 1, "odd trailing byte still consumed");
    }

    #[test]
    fn italic_from_name_flags_or_angle() {
        let mut doc = Document::with_version("1.7");
        let named = doc.add_object(dictionary! {"Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica-Oblique"});
        let fd = doc.add_object(dictionary! {"Type" => "FontDescriptor", "Flags" => 64});
        let flagged = doc.add_object(dictionary! {"Type" => "Font", "Subtype" => "TrueType", "BaseFont" => "ABC+Naskh", "FontDescriptor" => fd});
        let fd2 = doc.add_object(dictionary! {"Type" => "FontDescriptor", "Flags" => 32, "ItalicAngle" => -12});
        let angled = doc.add_object(dictionary! {"Type" => "Font", "Subtype" => "TrueType", "BaseFont" => "Serif", "FontDescriptor" => fd2});
        let plain = doc.add_object(dictionary! {"Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica-Bold"});
        let src = src_with(doc);
        let load = |id: lopdf::ObjectId| {
            let d = resolve_dict(&src, &Object::Reference(id)).unwrap().clone();
            Font::load(&src, FontKey::Object(id.0, id.1), &d)
        };
        assert!(load(named).italic);
        assert!(load(flagged).italic);
        assert!(load(angled).italic);
        let bold = load(plain);
        assert!(!bold.italic && bold.bold);
    }
}
