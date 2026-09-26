//! Fonts for writing text: the bundled OFL fonts (Amiri, Cairo, Inter — `packages/core/assets/fonts`,
//! the same files and names as warraq-create's), reuse of a page's own embedded font when it covers
//! the new text, shaping with harfrust, and embedding a subset as a Type0/Identity-H font.
//!
//! SEAM: when warraq-create (Create PDF) lands, `Bundled` can delegate to `warraq_create::fonts`
//! (same assets, same instances) so the font programs are compiled into the engine once.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use harfrust::{Direction, FontRef, ShapeOptions, ShaperData, ShaperInstance, UnicodeBuffer};
use lopdf::{Dictionary, Object, ObjectId, StringFormat};
use read_fonts::TableProvider;
use subsetter::GlyphRemapper;
use warraq_pdf::limits::decode_stream;
use warraq_pdf::Pdf;

use crate::error::{EditError, Result};
use crate::page::new_stream;

macro_rules! font_file {
    ($p:literal) => {
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../assets/fonts/",
            $p
        ))
    };
}

static AMIRI_REGULAR: &[u8] = font_file!("amiri/Amiri-Regular.ttf");
static AMIRI_BOLD: &[u8] = font_file!("amiri/Amiri-Bold.ttf");
static CAIRO: &[u8] = font_file!("cairo/Cairo-Variable.ttf");
static INTER: &[u8] = font_file!("inter/Inter-Variable.ttf");

/// A bundled font instance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Bundled {
    AmiriRegular,
    AmiriBold,
    CairoRegular,
    CairoBold,
    InterRegular,
    InterBold,
}

impl Bundled {
    pub fn data(self) -> &'static [u8] {
        match self {
            Bundled::AmiriRegular => AMIRI_REGULAR,
            Bundled::AmiriBold => AMIRI_BOLD,
            Bundled::CairoRegular | Bundled::CairoBold => CAIRO,
            Bundled::InterRegular | Bundled::InterBold => INTER,
        }
    }

    pub fn variations(self) -> &'static [(&'static str, f32)] {
        match self {
            Bundled::AmiriRegular | Bundled::AmiriBold => &[],
            Bundled::CairoRegular => &[("wght", 400.0), ("slnt", 0.0)],
            Bundled::CairoBold => &[("wght", 700.0), ("slnt", 0.0)],
            Bundled::InterRegular => &[("wght", 400.0), ("opsz", 14.0)],
            Bundled::InterBold => &[("wght", 700.0), ("opsz", 14.0)],
        }
    }

    pub fn base_name(self) -> &'static str {
        match self {
            Bundled::AmiriRegular => "Amiri-Regular",
            Bundled::AmiriBold => "Amiri-Bold",
            Bundled::CairoRegular => "Cairo-Regular",
            Bundled::CairoBold => "Cairo-Bold",
            Bundled::InterRegular => "Inter-Regular",
            Bundled::InterBold => "Inter-Bold",
        }
    }
}

/// Style of the text being written.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Family {
    /// Arabic serif (Amiri; also its Latin).
    Serif,
    /// Sans: Cairo for Arabic, Inter for Latin.
    Sans,
}

/// Guess the family of an existing font from its PostScript name.
pub fn family_of(base_font: &str) -> Family {
    let n = base_font.to_ascii_lowercase();
    let sans = [
        "sans",
        "cairo",
        "arial",
        "helvetica",
        "tahoma",
        "dubai",
        "kufi",
        "segoe",
        "inter",
        "verdana",
        "calibri",
        "roboto",
        "vazir",
        "almarai",
        "tajawal",
        "ibmplex",
    ];
    if sans.iter().any(|s| n.contains(s)) {
        Family::Sans
    } else {
        Family::Serif
    }
}

/// The bundled instances to try for `c`, in order.
pub fn bundled_chain(family: Family, bold: bool, c: char) -> [Bundled; 3] {
    let arabic = is_arabic(c);
    match (family, bold, arabic) {
        (Family::Serif, false, _) => [
            Bundled::AmiriRegular,
            Bundled::CairoRegular,
            Bundled::InterRegular,
        ],
        (Family::Serif, true, _) => [Bundled::AmiriBold, Bundled::CairoBold, Bundled::InterBold],
        (Family::Sans, false, true) => [
            Bundled::CairoRegular,
            Bundled::AmiriRegular,
            Bundled::InterRegular,
        ],
        (Family::Sans, true, true) => [Bundled::CairoBold, Bundled::AmiriBold, Bundled::InterBold],
        (Family::Sans, false, false) => [
            Bundled::InterRegular,
            Bundled::CairoRegular,
            Bundled::AmiriRegular,
        ],
        (Family::Sans, true, false) => [Bundled::InterBold, Bundled::CairoBold, Bundled::AmiriBold],
    }
}

pub fn is_arabic(c: char) -> bool {
    matches!(c as u32, 0x0600..=0x06FF | 0x0750..=0x077F | 0x0870..=0x08FF | 0xFB50..=0xFDFF | 0xFE70..=0xFEFF)
}

/// Characters that never need a glyph (joiners, bidi controls, variation selectors).
pub fn is_ignorable(c: char) -> bool {
    matches!(c,
        '\u{00AD}' | '\u{034F}' | '\u{061C}' | '\u{115F}' | '\u{1160}' | '\u{180B}'..='\u{180F}'
        | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{206F}'
        | '\u{FE00}'..='\u{FE0F}' | '\u{FEFF}')
}

/// Where a face comes from.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum FaceSource {
    Bundled(Bundled),
    /// The page's own embedded Type0/Identity-H font, used through its resource name.
    Original {
        font: ObjectId,
        resource: Vec<u8>,
    },
}

/// A font program that can shape and be written.
pub struct Face {
    pub source: FaceSource,
    data: FaceData,
    pub upem: f64,
    pub ascender: f64,
    pub descender: f64,
    pub num_glyphs: u32,
    pub has_gsub: bool,
}

enum FaceData {
    Static(&'static [u8]),
    Owned(Vec<u8>),
}

impl Face {
    pub fn bytes(&self) -> &[u8] {
        match &self.data {
            FaceData::Static(b) => b,
            FaceData::Owned(v) => v,
        }
    }

    fn from_data(source: FaceSource, data: FaceData) -> Option<Face> {
        let bytes: &[u8] = match &data {
            FaceData::Static(b) => b,
            FaceData::Owned(v) => v,
        };
        let f = FontRef::new(bytes).ok()?;
        let upem = f64::from(f.head().ok()?.units_per_em().max(16));
        let (asc, desc) = match f.hhea() {
            Ok(h) => (
                f64::from(h.ascender().to_i16()),
                f64::from(h.descender().to_i16()),
            ),
            Err(_) => (upem * 0.8, -upem * 0.2),
        };
        let num_glyphs = f.maxp().map(|m| u32::from(m.num_glyphs())).unwrap_or(0);
        let has_gsub = f.gsub().is_ok();
        let _ = &f;
        Some(Face {
            source,
            data,
            upem,
            ascender: asc,
            descender: desc,
            num_glyphs,
            has_gsub,
        })
    }

    fn variations(&self) -> &'static [(&'static str, f32)] {
        match &self.source {
            FaceSource::Bundled(b) => b.variations(),
            FaceSource::Original { .. } => &[],
        }
    }

    /// Ready-to-shape handle.
    pub fn shaper(&self) -> Option<FaceShaper<'_>> {
        let font = FontRef::new(self.bytes()).ok()?;
        let data = ShaperData::new(&font);
        let vars = self.variations();
        let instance =
            (!vars.is_empty()).then(|| ShaperInstance::from_variations(&font, vars.iter()));
        Some(FaceShaper {
            face: self,
            font,
            data,
            instance,
        })
    }
}

/// The bundled face `b` (loaded once per process).
pub fn bundled(b: Bundled) -> Result<&'static Face> {
    static FACES: OnceLock<Vec<(Bundled, Option<Face>)>> = OnceLock::new();
    FACES
        .get_or_init(|| {
            [
                Bundled::AmiriRegular,
                Bundled::AmiriBold,
                Bundled::CairoRegular,
                Bundled::CairoBold,
                Bundled::InterRegular,
                Bundled::InterBold,
            ]
            .into_iter()
            .map(|b| {
                (
                    b,
                    Face::from_data(FaceSource::Bundled(b), FaceData::Static(b.data())),
                )
            })
            .collect()
        })
        .iter()
        .find(|(k, _)| *k == b)
        .and_then(|(_, f)| f.as_ref())
        .ok_or_else(|| EditError::Font(format!("bundled font {b:?} failed to load")))
}

/// A shaped glyph (font units), visual order within its run.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Glyph {
    pub gid: u16,
    /// Byte offset of the cluster in the shaped text.
    pub cluster: usize,
    pub x_advance: f64,
    pub y_advance: f64,
    pub x_offset: f64,
    pub y_offset: f64,
}

pub struct FaceShaper<'a> {
    pub face: &'a Face,
    font: FontRef<'a>,
    data: ShaperData,
    instance: Option<ShaperInstance>,
}

impl FaceShaper<'_> {
    /// Does the font map `c` to a real glyph?
    pub fn covers(&self, c: char) -> bool {
        if is_ignorable(c) {
            return true;
        }
        self.font
            .cmap()
            .ok()
            .and_then(|cm| cm.map_codepoint(c))
            .is_some_and(|g| g.to_u32() != 0)
    }

    /// Shape `text` in one direction; glyphs in visual (left-to-right) order.
    pub fn shape(&self, text: &str, rtl: bool) -> Vec<Glyph> {
        let shaper = self
            .data
            .shaper(&self.font)
            .instance(self.instance.as_ref())
            .build();
        let mut buf = UnicodeBuffer::new();
        buf.push_str(text);
        buf.set_direction(if rtl {
            Direction::RightToLeft
        } else {
            Direction::LeftToRight
        });
        buf.guess_segment_properties();
        let out = shaper.shape(buf, ShapeOptions::new());
        out.glyph_infos()
            .iter()
            .zip(out.glyph_positions())
            .map(|(gi, gp)| Glyph {
                gid: u16::try_from(gi.glyph_id).unwrap_or(0),
                cluster: gi.cluster as usize,
                x_advance: f64::from(gp.x_advance),
                y_advance: f64::from(gp.y_advance),
                x_offset: f64::from(gp.x_offset),
                y_offset: f64::from(gp.y_offset),
            })
            .collect()
    }
}

/// Try to use the page's own font (object `font`, resource `resource`) for `text`: it must be a
/// Type0 font with Identity-H encoding, an embedded TrueType program (FontFile2), an identity
/// CID→GID map, map every character through its cmap, keep GSUB when the text needs Arabic joining,
/// and shape without `.notdef`. Adding glyphs to an existing subset is not attempted.
pub fn original_face(pdf: &Pdf, font: ObjectId, resource: &[u8], text: &str) -> Option<Face> {
    let d = pdf.get_dict(font)?;
    let name = |o: Option<&Object>| match o.and_then(|o| pdf.resolve(o)) {
        Some(Object::Name(n)) => Some(n.clone()),
        _ => None,
    };
    if name(d.get(b"Subtype").ok())?.as_slice() != b"Type0" {
        return None;
    }
    if name(d.get(b"Encoding").ok())?.as_slice() != b"Identity-H" {
        return None;
    }
    let desc = match pdf.resolve(d.get(b"DescendantFonts").ok()?)? {
        Object::Array(a) => match pdf.resolve(a.first()?)? {
            Object::Dictionary(dd) => dd,
            _ => return None,
        },
        _ => return None,
    };
    if name(desc.get(b"Subtype").ok())?.as_slice() != b"CIDFontType2" {
        return None;
    }
    if let Ok(m) = desc.get(b"CIDToGIDMap") {
        if name(Some(m)).as_deref() != Some(b"Identity".as_slice()) {
            return None;
        }
    }
    let fd = match pdf.resolve(desc.get(b"FontDescriptor").ok()?)? {
        Object::Dictionary(fd) => fd,
        _ => return None,
    };
    let Object::Stream(ff) = pdf.resolve(fd.get(b"FontFile2").ok()?)? else {
        return None;
    };
    let bytes = decode_stream(ff, pdf.limits()).ok()?;
    let face = Face::from_data(
        FaceSource::Original {
            font,
            resource: resource.to_vec(),
        },
        FaceData::Owned(bytes),
    )?;
    {
        let sh = face.shaper()?;
        let needs_joining = text.chars().any(is_arabic);
        if needs_joining && !face.has_gsub {
            return None;
        }
        if !text.chars().all(|c| c == '\n' || sh.covers(c)) {
            return None;
        }
        for line in text.split('\n') {
            for rtl in [false, true] {
                if sh
                    .shape(line, rtl)
                    .iter()
                    .any(|g| g.gid == 0 || u32::from(g.gid) >= face.num_glyphs)
                {
                    return None;
                }
            }
        }
    }
    Some(face)
}

/// A face as used in a page's content: resource name plus the glyph id → CID map.
#[derive(Debug, Clone)]
pub struct Written {
    pub resource: Vec<u8>,
    /// Old glyph id → CID written in the content stream.
    pub cid: BTreeMap<u16, u16>,
}

fn subset_tag(seed: &[u8]) -> String {
    let mut h: u32 = 2166136261;
    for &b in seed {
        h = (h ^ u32::from(b)).wrapping_mul(16777619);
    }
    (0..6)
        .map(|i| char::from(b'A' + ((h >> (i * 5)) % 26) as u8))
        .collect()
}

fn tounicode(map: &BTreeMap<u16, String>) -> Vec<u8> {
    let mut s = String::from(
        "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n",
    );
    let entries: Vec<(&u16, &String)> = map.iter().filter(|(_, t)| !t.is_empty()).collect();
    for chunk in entries.chunks(100) {
        s.push_str(&format!("{} beginbfchar\n", chunk.len()));
        for (g, t) in chunk {
            let hex: String = t.encode_utf16().map(|u| format!("{u:04X}")).collect();
            s.push_str(&format!("<{:04X}> <{hex}>\n", g));
        }
        s.push_str("endbfchar\n");
    }
    s.push_str("endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n");
    s.into_bytes()
}

/// Make `face` usable on page `page_id` for the glyphs in `used` (glyph id → text it stands for).
/// Bundled faces are subset and embedded as a new Type0 font; the original face is used as is.
pub fn write_face(
    pdf: &mut Pdf,
    page_id: ObjectId,
    face: &Face,
    used: &BTreeMap<u16, String>,
) -> Result<Written> {
    let b = match &face.source {
        FaceSource::Original { resource, .. } => {
            return Ok(Written {
                resource: resource.clone(),
                cid: used.keys().map(|g| (*g, *g)).collect(),
            });
        }
        FaceSource::Bundled(b) => *b,
    };
    let glyphs: Vec<u16> = used.keys().copied().collect();
    let remap = GlyphRemapper::new_from_glyphs_sorted(&glyphs);
    let vars: Vec<(subsetter::Tag, f32)> = b
        .variations()
        .iter()
        .filter_map(|(t, v)| {
            let bytes: [u8; 4] = t.as_bytes().try_into().ok()?;
            Some((subsetter::Tag::new(&bytes), *v))
        })
        .collect();
    let program = if vars.is_empty() {
        subsetter::subset(face.bytes(), 0, &remap)
    } else {
        subsetter::subset_with_variations(face.bytes(), 0, &vars, &remap)
    }
    .map_err(|e| EditError::Font(format!("subsetting {}: {e}", b.base_name())))?;
    let sub = FontRef::new(&program).map_err(|e| EditError::Font(format!("subset font: {e}")))?;
    let upem = f64::from(sub.head().map(|h| h.units_per_em()).unwrap_or(1000).max(16));
    let hmtx = sub.hmtx().ok();
    let mut cid = BTreeMap::new();
    let mut widths: Vec<Object> = Vec::new();
    let mut tu = BTreeMap::new();
    for (&old, text) in used {
        let Some(new) = remap.get(old) else { continue };
        cid.insert(old, new);
        tu.insert(new, text.clone());
        let adv = hmtx
            .as_ref()
            .and_then(|h| h.h_metrics().get(usize::from(new)).map(|m| m.advance()))
            .or_else(|| {
                hmtx.as_ref()
                    .and_then(|h| h.h_metrics().last().map(|m| m.advance()))
            })
            .unwrap_or(0);
        widths.push(Object::Integer(i64::from(new)));
        widths.push(Object::Array(vec![Object::Real(
            (f64::from(adv) * 1000.0 / upem) as f32,
        )]));
    }
    let tag = subset_tag(
        &[
            glyphs
                .iter()
                .flat_map(|g| g.to_be_bytes())
                .collect::<Vec<_>>(),
            b.base_name().as_bytes().to_vec(),
        ]
        .concat(),
    );
    let base = format!("{tag}+{}", b.base_name());
    let s = 1000.0 / face.upem;
    let bbox = sub
        .head()
        .map(|h| {
            vec![
                Object::Integer((f64::from(h.x_min()) * s) as i64),
                Object::Integer((f64::from(h.y_min()) * s) as i64),
                Object::Integer((f64::from(h.x_max()) * s) as i64),
                Object::Integer((f64::from(h.y_max()) * s) as i64),
            ]
        })
        .unwrap_or_else(|_| vec![0.into(), (-300).into(), 1000.into(), 1000.into()]);
    let ff = new_stream(pdf, Dictionary::new(), &program)?;
    let mut fd = Dictionary::new();
    fd.set("Type", Object::Name(b"FontDescriptor".to_vec()));
    fd.set("FontName", Object::Name(base.clone().into_bytes()));
    fd.set("Flags", 4);
    fd.set("FontBBox", Object::Array(bbox));
    fd.set("ItalicAngle", 0);
    fd.set("Ascent", Object::Integer((face.ascender * s) as i64));
    fd.set("Descent", Object::Integer((face.descender * s) as i64));
    fd.set(
        "CapHeight",
        Object::Integer((face.ascender * s * 0.7) as i64),
    );
    fd.set("StemV", 80);
    fd.set("FontFile2", Object::Reference(ff));
    let fd_id = pdf.add(Object::Dictionary(fd));
    let mut cidf = Dictionary::new();
    cidf.set("Type", Object::Name(b"Font".to_vec()));
    cidf.set("Subtype", Object::Name(b"CIDFontType2".to_vec()));
    cidf.set("BaseFont", Object::Name(base.clone().into_bytes()));
    let mut csi = Dictionary::new();
    csi.set(
        "Registry",
        Object::String(b"Adobe".to_vec(), StringFormat::Literal),
    );
    csi.set(
        "Ordering",
        Object::String(b"Identity".to_vec(), StringFormat::Literal),
    );
    csi.set("Supplement", 0);
    cidf.set("CIDSystemInfo", Object::Dictionary(csi));
    cidf.set("FontDescriptor", Object::Reference(fd_id));
    cidf.set("CIDToGIDMap", Object::Name(b"Identity".to_vec()));
    cidf.set("DW", 1000);
    cidf.set("W", Object::Array(widths));
    let cid_id = pdf.add(Object::Dictionary(cidf));
    let tu_id = new_stream(pdf, Dictionary::new(), &tounicode(&tu))?;
    let mut t0 = Dictionary::new();
    t0.set("Type", Object::Name(b"Font".to_vec()));
    t0.set("Subtype", Object::Name(b"Type0".to_vec()));
    t0.set("BaseFont", Object::Name(base.into_bytes()));
    t0.set("Encoding", Object::Name(b"Identity-H".to_vec()));
    t0.set(
        "DescendantFonts",
        Object::Array(vec![Object::Reference(cid_id)]),
    );
    t0.set("ToUnicode", Object::Reference(tu_id));
    let font_id = pdf.add(Object::Dictionary(t0));
    let resource =
        crate::page::add_resource(pdf, page_id, b"Font", "ZE", Object::Reference(font_id))?;
    Ok(Written { resource, cid })
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    #[test]
    fn bundled_fonts_load_and_cover_their_scripts() {
        for b in [
            Bundled::AmiriRegular,
            Bundled::AmiriBold,
            Bundled::CairoRegular,
            Bundled::CairoBold,
            Bundled::InterRegular,
            Bundled::InterBold,
        ] {
            let f = bundled(b).unwrap();
            let s = f.shaper().unwrap();
            assert!(s.covers('A'), "{b:?}");
        }
        assert!(bundled(Bundled::AmiriRegular)
            .unwrap()
            .shaper()
            .unwrap()
            .covers('ب'));
        assert!(!bundled(Bundled::InterRegular)
            .unwrap()
            .shaper()
            .unwrap()
            .covers('ب'));
        assert_eq!(family_of("AAAAAA+Cairo-Regular"), Family::Sans);
        assert_eq!(family_of("BCDEFG+Amiri-Bold"), Family::Serif);
    }

    #[test]
    fn arabic_shapes_right_to_left() {
        let f = bundled(Bundled::AmiriRegular).unwrap();
        let g = f.shaper().unwrap().shape("سلام", true);
        assert_eq!(g.last().unwrap().cluster, 0);
    }
}
