//! Serialise a [`Layout`] as a tagged PDF 1.7.
//!
//! * Fonts: every used font instance is subset with the `subsetter` crate (variable Cairo/Inter
//!   instanced at their weight) and embedded as `Type0`/`CIDFontType2` with `Identity-H`,
//!   `CIDToGIDMap /Identity`, a `/W` array read from the subset's `hmtx` and a `ToUnicode` CMap.
//! * Text: each piece is one `TJ` whose numbers carry the shaper's positioning; every piece is
//!   wrapped in `/Span <</Lang (xx) /ActualText (…)>> BDC … EMC` when it has Arabic letters (so
//!   extraction reads the logical word, even through kashidas and ligatures) and in
//!   `/Span <</Lang (xx)>>` otherwise. `/Direction /R2L` is never written.
//! * Tagging: marked-content sequences with MCIDs under a `StructTreeRoot` (P, H1–H6, L/LI/Lbl/
//!   LBody, Table/TR/TH/TD, Figure with `/Alt`), a `ParentTree`, `/MarkInfo`, `/Lang`.
//!   Borders, fills, repeated table headers and page numbers are `/Artifact`s.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fmt::Write as _;

use lopdf::{Dictionary, Object, ObjectId, Stream, StringFormat};
use read_fonts::{types::GlyphId, FontRef, TableProvider};
use subsetter::GlyphRemapper;
use warraq_pdf::{writer::write_new_file, Limits, XrefKind};

use crate::error::{CreateError, Result};
use crate::fonts::{font, FontId};
use crate::image::{zlib, Encoding, ImageData};
use crate::layout::{Item, Layout, Tag};
use crate::model::Document;

/// Document-level metadata for the writer.
#[derive(Debug, Clone, Default)]
pub struct Meta {
    pub title: Option<String>,
    pub lang: Option<String>,
}

struct Objects {
    map: BTreeMap<ObjectId, Object>,
    next: u32,
}

impl Objects {
    fn reserve(&mut self) -> ObjectId {
        let id = (self.next, 0);
        self.next += 1;
        id
    }
    fn add(&mut self, o: impl Into<Object>) -> ObjectId {
        let id = self.reserve();
        self.map.insert(id, o.into());
        id
    }
    fn set(&mut self, id: ObjectId, o: impl Into<Object>) {
        self.map.insert(id, o.into());
    }
}

fn name(s: &str) -> Object {
    Object::Name(s.as_bytes().to_vec())
}

/// UTF-16BE text string with BOM (hex form).
fn text_string(s: &str) -> Object {
    let mut b = vec![0xFE, 0xFF];
    for u in s.encode_utf16() {
        b.extend_from_slice(&u.to_be_bytes());
    }
    Object::String(b, StringFormat::Hexadecimal)
}

fn hex_text(s: &str) -> String {
    let mut out = String::from("<FEFF");
    for u in s.encode_utf16() {
        let _ = write!(out, "{u:04X}");
    }
    out.push('>');
    out
}

/// A language tag safe inside a literal string.
fn lang_tag(l: &str) -> String {
    let t: String = l
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(35)
        .collect();
    if t.is_empty() {
        "und".into()
    } else {
        t
    }
}

fn num(v: f64) -> String {
    if !v.is_finite() {
        return "0".into();
    }
    let r = (v * 1000.0).round() / 1000.0;
    if r == r.trunc() {
        format!("{}", r as i64)
    } else {
        let s = format!("{r:.3}");
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

struct FontOut {
    res: String,
    remap: GlyphRemapper,
    /// New gid → text for ToUnicode.
    unicode: BTreeMap<u16, String>,
    /// New gid → width in 1000-unit text space.
    widths: HashMap<u16, f64>,
    /// The ToUnicode stream object (written after the content pass).
    tu: ObjectId,
}

fn subset_tag(glyphs: &[u16], id: FontId) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325 ^ id as u64;
    for g in glyphs {
        h ^= u64::from(*g);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    (0..6)
        .map(|i| char::from(b'A' + ((h >> (i * 5)) % 26) as u8))
        .collect()
}

/// Logical text for each glyph of a piece (first glyph of a cluster gets the cluster's text).
fn cluster_texts(text: &str, clusters: &[usize]) -> Vec<Option<String>> {
    let mut starts: Vec<usize> = clusters.to_vec();
    starts.sort_unstable();
    starts.dedup();
    let mut seen = BTreeSet::new();
    clusters
        .iter()
        .map(|c| {
            if !seen.insert(*c) {
                return None;
            }
            let end = starts
                .iter()
                .find(|s| **s > *c)
                .copied()
                .unwrap_or(text.len());
            text.get(*c..end)
                .map(str::to_string)
                .filter(|s| !s.is_empty())
        })
        .collect()
}

fn tounicode_cmap(map: &BTreeMap<u16, String>) -> Vec<u8> {
    let mut s = String::from(
        "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo <</Registry (Adobe) /Ordering (UCS) /Supplement 0>> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n",
    );
    let entries: Vec<(&u16, &String)> = map.iter().collect();
    for chunk in entries.chunks(100) {
        let _ = writeln!(s, "{} beginbfchar", chunk.len());
        for (g, t) in chunk {
            let hex: String = t.encode_utf16().map(|u| format!("{u:04X}")).collect();
            let _ = writeln!(s, "<{:04X}> <{}>", g, hex);
        }
        s.push_str("endbfchar\n");
    }
    s.push_str("endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n");
    s.into_bytes()
}

fn stream(dict: Dictionary, data: Vec<u8>, compress: bool) -> Result<Object> {
    let mut d = dict;
    let content = if compress {
        d.set("Filter", name("FlateDecode"));
        zlib(&data)?
    } else {
        data
    };
    Ok(Object::Stream(Stream::new(d, content)))
}

fn image_object(img: &ImageData, smask: Option<ObjectId>) -> Object {
    let mut d = Dictionary::new();
    d.set("Type", name("XObject"));
    d.set("Subtype", name("Image"));
    d.set("Width", Object::Integer(i64::from(img.width)));
    d.set("Height", Object::Integer(i64::from(img.height)));
    d.set("ColorSpace", name(img.color.pdf_name()));
    d.set("BitsPerComponent", Object::Integer(i64::from(img.bits)));
    match &img.encoding {
        Encoding::Dct => {
            d.set("Filter", name("DCTDecode"));
            if img.invert {
                let dec: Vec<Object> = (0..img.color.components())
                    .flat_map(|_| [Object::Integer(1), Object::Integer(0)])
                    .collect();
                d.set("Decode", Object::Array(dec));
            }
        }
        Encoding::Flate => d.set("Filter", name("FlateDecode")),
        Encoding::Ccitt {
            k,
            black_is_1,
            byte_align,
        } => {
            d.set("Filter", name("CCITTFaxDecode"));
            let mut p = Dictionary::new();
            p.set("K", Object::Integer(i64::from(*k)));
            p.set("Columns", Object::Integer(i64::from(img.width)));
            p.set("Rows", Object::Integer(i64::from(img.height)));
            p.set("BlackIs1", Object::Boolean(*black_is_1));
            if *byte_align {
                p.set("EncodedByteAlign", Object::Boolean(true));
            }
            d.set("DecodeParms", Object::Dictionary(p));
        }
    }
    if let Some(s) = smask {
        d.set("SMask", Object::Reference(s));
    }
    Object::Stream(Stream::new(d, img.data.clone()))
}

/// Write the layout as PDF bytes.
pub fn write(layout: &Layout, doc: &Document, meta: &Meta) -> Result<Vec<u8>> {
    let mut objs = Objects {
        map: BTreeMap::new(),
        next: 1,
    };
    let catalog_id = objs.reserve();
    let pages_id = objs.reserve();
    let struct_root_id = objs.reserve();

    // 1. Used glyphs per font.
    let mut used: BTreeMap<FontId, BTreeSet<u16>> = BTreeMap::new();
    for page in &layout.pages {
        for it in &page.items {
            if let Item::Text { piece, .. } = it {
                let set = used.entry(piece.font).or_default();
                for g in &piece.glyphs {
                    set.insert(g.gid);
                }
            }
        }
    }
    // 2. Subset + font objects.
    let mut fonts: BTreeMap<FontId, FontOut> = BTreeMap::new();
    let mut font_res = Dictionary::new();
    for (k, (fid, glyphs)) in used.iter().enumerate() {
        let f = font(*fid)?;
        let mut remap = GlyphRemapper::new();
        for g in glyphs {
            remap.remap(*g);
        }
        let vars = f.subset_variations();
        let data = if vars.is_empty() {
            subsetter::subset(fid.data(), 0, &remap)
        } else {
            subsetter::subset_with_variations(fid.data(), 0, &vars, &remap)
        }
        .map_err(|e| CreateError::Font(format!("subsetting {fid:?}: {e}")))?;
        let sub =
            FontRef::new(&data).map_err(|e| CreateError::Font(format!("subset font: {e}")))?;
        let upem = f64::from(sub.head().map(|h| h.units_per_em()).unwrap_or(1000).max(16));
        let (bbox, asc, desc) = match sub.head() {
            Ok(h) => (
                [h.x_min(), h.y_min(), h.x_max(), h.y_max()].map(|v| f64::from(v) * 1000.0 / upem),
                f.ascender * 1000.0 / f.upem,
                f.descender * 1000.0 / f.upem,
            ),
            Err(_) => ([0.0, -300.0, 1000.0, 1000.0], 900.0, -300.0),
        };
        let hmtx = sub.hmtx().ok();
        let mut widths = HashMap::new();
        let mut w_arr: Vec<Object> = Vec::new();
        let mut new_ids: Vec<u16> = glyphs.iter().filter_map(|g| remap.get(*g)).collect();
        new_ids.push(0);
        new_ids.sort_unstable();
        new_ids.dedup();
        for ng in &new_ids {
            let adv = hmtx
                .as_ref()
                .and_then(|h| h.advance(GlyphId::new(u32::from(*ng))))
                .unwrap_or(0);
            let w = f64::from(adv) * 1000.0 / upem;
            widths.insert(*ng, w);
            w_arr.push(Object::Integer(i64::from(*ng)));
            w_arr.push(Object::Array(vec![Object::Real(w as f32)]));
        }
        let tag = subset_tag(&glyphs.iter().copied().collect::<Vec<_>>(), *fid);
        let base = format!("{tag}+{}", fid.base_name());
        let mut ff = Dictionary::new();
        ff.set("Length1", Object::Integer(data.len() as i64));
        let ff_id = objs.add(stream(ff, data, true)?);
        let mut fd = Dictionary::new();
        fd.set("Type", name("FontDescriptor"));
        fd.set("FontName", name(&base));
        fd.set("Flags", Object::Integer(4));
        fd.set(
            "FontBBox",
            Object::Array(bbox.iter().map(|v| Object::Integer(*v as i64)).collect()),
        );
        fd.set("ItalicAngle", Object::Integer(0));
        fd.set("Ascent", Object::Integer(asc as i64));
        fd.set("Descent", Object::Integer(desc as i64));
        fd.set("CapHeight", Object::Integer((asc * 0.7) as i64));
        fd.set(
            "StemV",
            Object::Integer(if fid.is_bold() { 140 } else { 80 }),
        );
        fd.set("FontFile2", Object::Reference(ff_id));
        let fd_id = objs.add(fd);
        let mut cid = Dictionary::new();
        cid.set("Type", name("Font"));
        cid.set("Subtype", name("CIDFontType2"));
        cid.set("BaseFont", name(&base));
        let mut csi = Dictionary::new();
        csi.set("Registry", Object::string_literal("Adobe"));
        csi.set("Ordering", Object::string_literal("Identity"));
        csi.set("Supplement", Object::Integer(0));
        cid.set("CIDSystemInfo", Object::Dictionary(csi));
        cid.set("FontDescriptor", Object::Reference(fd_id));
        cid.set("W", Object::Array(w_arr));
        cid.set("CIDToGIDMap", name("Identity"));
        let cid_id = objs.add(cid);
        let tu_id = objs.reserve();
        let mut t0 = Dictionary::new();
        t0.set("Type", name("Font"));
        t0.set("Subtype", name("Type0"));
        t0.set("BaseFont", name(&base));
        t0.set("Encoding", name("Identity-H"));
        t0.set(
            "DescendantFonts",
            Object::Array(vec![Object::Reference(cid_id)]),
        );
        t0.set("ToUnicode", Object::Reference(tu_id));
        let t0_id = objs.add(t0);
        let res = format!("F{}", k + 1);
        font_res.set(res.as_bytes().to_vec(), Object::Reference(t0_id));
        // ToUnicode is filled after the content pass (it needs the piece texts).
        objs.set(tu_id, Object::Null);
        fonts.insert(
            *fid,
            FontOut {
                res,
                remap,
                unicode: BTreeMap::new(),
                widths,
                tu: tu_id,
            },
        );
    }
    // 3. Images.
    let mut xobj_res = Dictionary::new();
    let mut image_res: HashMap<usize, String> = HashMap::new();
    for page in &layout.pages {
        for it in &page.items {
            if let Item::Image { image, .. } = it {
                if image_res.contains_key(image) {
                    continue;
                }
                let Some(img) = doc.images.get(*image) else {
                    continue;
                };
                let smask = match &img.alpha {
                    Some(a) => {
                        let mut d = Dictionary::new();
                        d.set("Type", name("XObject"));
                        d.set("Subtype", name("Image"));
                        d.set("Width", Object::Integer(i64::from(img.width)));
                        d.set("Height", Object::Integer(i64::from(img.height)));
                        d.set("ColorSpace", name("DeviceGray"));
                        d.set("BitsPerComponent", Object::Integer(8));
                        d.set("Filter", name("FlateDecode"));
                        Some(objs.add(Object::Stream(Stream::new(d, a.clone()))))
                    }
                    None => None,
                };
                let id = objs.add(image_object(img, smask));
                let res = format!("Im{}", image_res.len() + 1);
                xobj_res.set(res.as_bytes().to_vec(), Object::Reference(id));
                image_res.insert(*image, res);
            }
        }
    }
    let mut resources = Dictionary::new();
    resources.set("Font", Object::Dictionary(font_res));
    if !image_res.is_empty() {
        resources.set("XObject", Object::Dictionary(xobj_res));
    }
    resources.set(
        "ProcSet",
        Object::Array(vec![
            name("PDF"),
            name("Text"),
            name("ImageB"),
            name("ImageC"),
        ]),
    );
    let resources_id = objs.add(resources);

    // 4. Pages and content streams; MCIDs per page.
    let elem_ids: Vec<ObjectId> = layout.elems.iter().map(|_| objs.reserve()).collect();
    // elem → list of (page object, mcid)
    let mut elem_mcrs: Vec<Vec<(ObjectId, i64)>> = vec![Vec::new(); layout.elems.len()];
    let mut parent_tree: Vec<Object> = Vec::new();
    let mut kids = Vec::new();
    let mut hasher: u64 = 0xcbf2_9ce4_8422_2325;
    for (pi, page) in layout.pages.iter().enumerate() {
        let page_id = objs.reserve();
        let mut cs = String::new();
        let mut mcid_elems: Vec<Object> = Vec::new();
        let mut open: Option<Tag> = None;
        let mut in_bt = false;
        let mut cur_font: Option<(FontId, String)> = None;
        let mut cur_color: Option<(u8, u8, u8)> = None;
        let close_bt = |cs: &mut String, in_bt: &mut bool| {
            if *in_bt {
                cs.push_str("ET\n");
                *in_bt = false;
            }
        };
        for it in &page.items {
            let tag = match it {
                Item::Text { tag, .. } | Item::Image { tag, .. } => *tag,
                Item::Rect { .. } | Item::Rule { .. } => Tag::Artifact,
            };
            if open != Some(tag) {
                if open.is_some() {
                    close_bt(&mut cs, &mut in_bt);
                    cs.push_str("EMC\n");
                }
                match tag {
                    Tag::Artifact => cs.push_str("/Artifact BDC\n"),
                    Tag::Elem(e) => {
                        let mcid = mcid_elems.len() as i64;
                        let role = layout.elems.get(e).map_or("Span", |x| x.role);
                        let _ = writeln!(cs, "/{role} <</MCID {mcid}>> BDC");
                        if let (Some(list), Some(eid)) = (elem_mcrs.get_mut(e), elem_ids.get(e)) {
                            list.push((page_id, mcid));
                            mcid_elems.push(Object::Reference(*eid));
                        }
                    }
                }
                open = Some(tag);
                cur_font = None;
                cur_color = None;
            }
            match it {
                Item::Text { x, y, piece, .. } => {
                    let Some(fo) = fonts.get_mut(&piece.font) else {
                        continue;
                    };
                    let f = font(piece.font)?;
                    let scale = f.scale(piece.size);
                    if !in_bt {
                        cs.push_str("BT\n");
                        in_bt = true;
                    }
                    let fkey = (piece.font, num(piece.size));
                    if cur_font.as_ref() != Some(&fkey) {
                        let _ = writeln!(cs, "/{} {} Tf", fo.res, fkey.1);
                        cur_font = Some(fkey);
                    }
                    let c = (piece.color.r, piece.color.g, piece.color.b);
                    if cur_color != Some(c) {
                        let _ = writeln!(
                            cs,
                            "{} {} {} rg",
                            num(f64::from(c.0) / 255.0),
                            num(f64::from(c.1) / 255.0),
                            num(f64::from(c.2) / 255.0)
                        );
                        cur_color = Some(c);
                    }
                    let skew = if piece.italic { "0.21" } else { "0" };
                    let _ = writeln!(cs, "1 0 {skew} 1 {} {} Tm", num(*x), num(*y));
                    let lang = lang_tag(&piece.lang);
                    if piece.arabic || piece.stretched {
                        let _ = writeln!(
                            cs,
                            "/Span <</Lang ({lang}) /ActualText {}>> BDC",
                            hex_text(&piece.text)
                        );
                    } else {
                        let _ = writeln!(cs, "/Span <</Lang ({lang})>> BDC");
                    }
                    // ToUnicode entries.
                    if !piece.stretched {
                        let clusters: Vec<usize> = piece.glyphs.iter().map(|g| g.cluster).collect();
                        let texts = cluster_texts(&piece.text, &clusters);
                        for (g, t) in piece.glyphs.iter().zip(texts) {
                            if let (Some(ng), Some(t)) = (fo.remap.get(g.gid), t) {
                                fo.unicode.entry(ng).or_insert(t);
                            }
                        }
                    } else if let Some(tg) = f.shape("\u{0640}", true).first() {
                        if let Some(ng) = fo.remap.get(tg.gid) {
                            fo.unicode.entry(ng).or_insert_with(|| "\u{0640}".into());
                        }
                    }
                    // TJ with positioning.
                    let size = piece.size;
                    let mut pos = 0.0f64; // where the text position is, relative to x
                    let mut pen = 0.0f64;
                    let mut rise = 0.0f64;
                    let mut arr = String::from("[");
                    for g in &piece.glyphs {
                        let Some(ng) = fo.remap.get(g.gid) else {
                            continue;
                        };
                        let y_off = g.y_offset * scale;
                        if (y_off - rise).abs() > 0.001 {
                            arr.push_str("] TJ\n");
                            let _ = writeln!(cs, "{arr}");
                            let _ = writeln!(cs, "{} Ts", num(y_off));
                            arr = String::from("[");
                            rise = y_off;
                        }
                        let want = pen + g.x_offset * scale;
                        let delta = want - pos;
                        if delta.abs() > 0.0005 {
                            let _ = write!(arr, "{} ", num(-delta * 1000.0 / size));
                        }
                        let _ = write!(arr, "<{ng:04X}>");
                        let w = fo.widths.get(&ng).copied().unwrap_or(0.0) * size / 1000.0;
                        pos = want + w;
                        pen += g.x_advance * scale;
                    }
                    arr.push_str("] TJ");
                    let _ = writeln!(cs, "{arr}");
                    if rise.abs() > 0.001 {
                        cs.push_str("0 Ts\n");
                    }
                    cs.push_str("EMC\n");
                    hasher ^= piece.text.len() as u64;
                    hasher = hasher.wrapping_mul(0x0100_0000_01b3);
                }
                Item::Image {
                    x, y, w, h, image, ..
                } => {
                    close_bt(&mut cs, &mut in_bt);
                    if let Some(res) = image_res.get(image) {
                        let _ = writeln!(
                            cs,
                            "q {} 0 0 {} {} {} cm /{res} Do Q",
                            num(*w),
                            num(*h),
                            num(*x),
                            num(*y)
                        );
                    }
                }
                Item::Rect { x, y, w, h, color } => {
                    close_bt(&mut cs, &mut in_bt);
                    let _ = writeln!(
                        cs,
                        "q {} {} {} rg {} {} {} {} re f Q",
                        num(f64::from(color.r) / 255.0),
                        num(f64::from(color.g) / 255.0),
                        num(f64::from(color.b) / 255.0),
                        num(*x),
                        num(*y),
                        num(*w),
                        num(*h)
                    );
                }
                Item::Rule {
                    x1,
                    y1,
                    x2,
                    y2,
                    width,
                    color,
                } => {
                    close_bt(&mut cs, &mut in_bt);
                    let _ = writeln!(
                        cs,
                        "q {} {} {} RG {} w {} {} m {} {} l S Q",
                        num(f64::from(color.r) / 255.0),
                        num(f64::from(color.g) / 255.0),
                        num(f64::from(color.b) / 255.0),
                        num(*width),
                        num(*x1),
                        num(*y1),
                        num(*x2),
                        num(*y2)
                    );
                }
            }
        }
        close_bt(&mut cs, &mut in_bt);
        if open.is_some() {
            cs.push_str("EMC\n");
        }
        debug_assert!(!cs.contains("/Direction"));
        for b in cs.as_bytes().iter().step_by(97) {
            hasher ^= u64::from(*b);
            hasher = hasher.wrapping_mul(0x0100_0000_01b3);
        }
        let content_id = objs.add(stream(Dictionary::new(), cs.into_bytes(), true)?);
        let mut pd = Dictionary::new();
        pd.set("Type", name("Page"));
        pd.set("Parent", Object::Reference(pages_id));
        pd.set(
            "MediaBox",
            Object::Array(vec![
                Object::Integer(0),
                Object::Integer(0),
                Object::Real(page.width as f32),
                Object::Real(page.height as f32),
            ]),
        );
        pd.set("Resources", Object::Reference(resources_id));
        pd.set("Contents", Object::Reference(content_id));
        pd.set("StructParents", Object::Integer(pi as i64));
        pd.set("Tabs", name("S"));
        objs.set(page_id, pd);
        kids.push(Object::Reference(page_id));
        parent_tree.push(Object::Integer(pi as i64));
        parent_tree.push(Object::Array(mcid_elems));
    }
    // ToUnicode streams.
    for fo in fonts.values() {
        objs.set(
            fo.tu,
            stream(Dictionary::new(), tounicode_cmap(&fo.unicode), true)?,
        );
    }
    let mut pages = Dictionary::new();
    pages.set("Type", name("Pages"));
    pages.set("Count", Object::Integer(kids.len() as i64));
    pages.set("Kids", Object::Array(kids));
    objs.set(pages_id, pages);

    // 5. Structure tree.
    for (i, e) in layout.elems.iter().enumerate() {
        let Some(&id) = elem_ids.get(i) else { continue };
        let mut d = Dictionary::new();
        d.set("Type", name("StructElem"));
        d.set("S", name(e.role));
        let parent = if i == 0 {
            struct_root_id
        } else {
            elem_ids.get(e.parent).copied().unwrap_or(struct_root_id)
        };
        d.set("P", Object::Reference(parent));
        let mut k: Vec<Object> = e
            .kids
            .iter()
            .filter_map(|c| elem_ids.get(*c).map(|x| Object::Reference(*x)))
            .collect();
        let mcrs = elem_mcrs.get(i).cloned().unwrap_or_default();
        if let Some((pg, _)) = mcrs.first() {
            d.set("Pg", Object::Reference(*pg));
        }
        for (pg, mcid) in mcrs {
            let mut m = Dictionary::new();
            m.set("Type", name("MCR"));
            m.set("Pg", Object::Reference(pg));
            m.set("MCID", Object::Integer(mcid));
            k.push(Object::Dictionary(m));
        }
        d.set("K", Object::Array(k));
        if let Some(alt) = &e.alt {
            d.set("Alt", text_string(alt));
        }
        if let Some(l) = &e.lang {
            d.set("Lang", Object::string_literal(lang_tag(l)));
        }
        objs.set(id, d);
    }
    let mut sr = Dictionary::new();
    sr.set("Type", name("StructTreeRoot"));
    if let Some(root) = elem_ids.first() {
        sr.set("K", Object::Array(vec![Object::Reference(*root)]));
    }
    let mut pt = Dictionary::new();
    pt.set("Nums", Object::Array(parent_tree));
    sr.set("ParentTree", Object::Dictionary(pt));
    sr.set(
        "ParentTreeNextKey",
        Object::Integer(layout.pages.len() as i64),
    );
    objs.set(struct_root_id, sr);

    // 6. Catalog + Info.
    let mut cat = Dictionary::new();
    cat.set("Type", name("Catalog"));
    cat.set("Pages", Object::Reference(pages_id));
    cat.set("StructTreeRoot", Object::Reference(struct_root_id));
    let mut mi = Dictionary::new();
    mi.set("Marked", Object::Boolean(true));
    cat.set("MarkInfo", Object::Dictionary(mi));
    if let Some(l) = &meta.lang {
        cat.set("Lang", Object::string_literal(lang_tag(l)));
    }
    if meta.title.is_some() {
        let mut vp = Dictionary::new();
        vp.set("DisplayDocTitle", Object::Boolean(true));
        cat.set("ViewerPreferences", Object::Dictionary(vp));
    }
    objs.set(catalog_id, cat);
    let mut info = Dictionary::new();
    info.set("Producer", Object::string_literal("ZOOD PDF"));
    info.set("Creator", Object::string_literal("ZOOD PDF Create"));
    if let Some(t) = &meta.title {
        info.set("Title", text_string(t));
    }
    let info_id = objs.add(info);
    let id_bytes: Vec<u8> = (0..16u32)
        .map(|i| (hasher.rotate_left(i * 4) & 0xff) as u8)
        .collect();
    let id = Object::String(id_bytes, StringFormat::Hexadecimal);
    let out = write_new_file(
        "1.7",
        &objs.map,
        catalog_id,
        Some(info_id),
        Some((id.clone(), id)),
        None,
        XrefKind::Table,
        &Limits::default(),
    )?;
    Ok(out)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    #[test]
    fn cluster_texts_give_ligatures_their_whole_text() {
        // Two glyphs of one cluster (lam-alef in Amiri), then one glyph.
        let t = cluster_texts("لاب", &[4, 0, 0]);
        // Visual order: glyph 0 is cluster 2 ("ب"), glyphs 1–2 are cluster 0 ("لا").
        assert_eq!(t, vec![Some("ب".into()), Some("لا".into()), None]);
        assert_eq!(num(1.23456), "1.235");
        assert_eq!(num(2.0), "2");
        assert_eq!(lang_tag("ar-SA) /Evil"), "ar-SAEvil");
        assert_eq!(hex_text("ب"), "<FEFF0628>");
    }
}
