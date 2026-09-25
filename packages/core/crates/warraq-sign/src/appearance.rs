//! Visible signature appearance with real Arabic shaping.
//!
//! Text is split into bidi runs (unicode-bidi), each run is shaped with HarfRust (the Rust
//! port of HarfBuzz: contextual forms, lam-alef and other ligatures, mark positioning) using
//! the bundled Amiri subset, and drawn with an embedded, subsetted CID font (Identity-H,
//! ToUnicode). Every word is wrapped in `/Span <</ActualText …>> BDC … EMC` so extraction
//! reads back the logical text.
//!
//! INTEGRATION POINT (warraq-text): when warraq-text's shaping API lands, `shape_run` is the
//! one function to replace; everything else (layout, font embedding, ActualText) stays.

use crate::error::{Result, SignError};
use crate::pdfobj::{name, num, pdf_date, Edit};
use lopdf::{Dictionary, Object, Stream, StringFormat};
use std::collections::BTreeMap;
use std::fmt::Write as _;

#[cfg(feature = "builtin-font")]
static FONT: &[u8] = include_bytes!("../assets/Amiri-Sign.ttf");
#[cfg(not(feature = "builtin-font"))]
static FONT: &[u8] = &[];

/// What the appearance shows.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AppearanceSpec {
    /// Explicit lines (already localised by the UI). `None` = name, date, reason, location.
    pub lines: Option<Vec<String>>,
    /// Arabic labels for the default lines (default: when the name contains Arabic).
    pub arabic_labels: Option<bool>,
}

fn has_arabic(s: &str) -> bool {
    s.chars().any(|c| matches!(c as u32, 0x0600..=0x06FF | 0x0750..=0x077F | 0xFB50..=0xFDFF | 0xFE70..=0xFEFF))
}

impl AppearanceSpec {
    /// The lines to draw.
    pub fn lines_or_default(
        &self,
        signer: &str,
        time: i64,
        reason: Option<&str>,
        location: Option<&str>,
    ) -> Vec<String> {
        if let Some(l) = &self.lines {
            return l.iter().filter(|s| !s.trim().is_empty()).cloned().collect();
        }
        let ar = self.arabic_labels.unwrap_or_else(|| has_arabic(signer));
        let (y, mo, d, h, mi, _) = crate::pdfobj::civil(time);
        let date = format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02} UTC");
        let _ = pdf_date;
        let mut out = vec![signer.to_string()];
        if ar {
            out.push(format!("التاريخ: {date}"));
            if let Some(r) = reason {
                out.push(format!("السبب: {r}"));
            }
            if let Some(l) = location {
                out.push(format!("المكان: {l}"));
            }
        } else {
            out.push(format!("Date: {date}"));
            if let Some(r) = reason {
                out.push(format!("Reason: {r}"));
            }
            if let Some(l) = location {
                out.push(format!("Location: {l}"));
            }
        }
        out
    }
}

/// An empty appearance for invisible signatures.
pub fn empty_form() -> Stream {
    let mut d = Dictionary::new();
    d.set("Type", name("XObject"));
    d.set("Subtype", name("Form"));
    d.set(
        "BBox",
        Object::Array(vec![0.into(), 0.into(), 0.into(), 0.into()]),
    );
    Stream::new(d, Vec::new())
}

/// One positioned glyph (font units).
#[derive(Debug, Clone, Copy)]
struct Glyph {
    gid: u16,
    adv: i32,
    dx: i32,
    dy: i32,
    /// Byte offset of the glyph's cluster in the line.
    cluster: usize,
}

struct Font<'a> {
    data: &'a [u8],
    upem: f64,
    ascent: f64,
    descent: f64,
    bbox: [f64; 4],
    cap: f64,
}

fn load_font() -> Result<Font<'static>> {
    use read_fonts::TableProvider;
    if FONT.is_empty() {
        return Err(SignError::Unsupported(
            "visible signatures need the builtin-font feature".into(),
        ));
    }
    let f =
        read_fonts::FontRef::new(FONT).map_err(|e| SignError::Malformed(format!("font: {e}")))?;
    let head = f
        .head()
        .map_err(|e| SignError::Malformed(format!("font head: {e}")))?;
    let hhea = f
        .hhea()
        .map_err(|e| SignError::Malformed(format!("font hhea: {e}")))?;
    let cap = f
        .os2()
        .ok()
        .and_then(|o| o.s_cap_height())
        .map(f64::from)
        .unwrap_or(700.0);
    Ok(Font {
        data: FONT,
        upem: f64::from(head.units_per_em()).max(16.0),
        ascent: f64::from(hhea.ascender().to_i16()),
        descent: f64::from(hhea.descender().to_i16()),
        bbox: [
            f64::from(head.x_min()),
            f64::from(head.y_min()),
            f64::from(head.x_max()),
            f64::from(head.y_max()),
        ],
        cap,
    })
}

/// Shape one directional run. INTEGRATION POINT for warraq-text's shaper.
fn shape_run(font: &Font<'_>, text: &str, rtl: bool, base: usize) -> Result<Vec<Glyph>> {
    let fr = harfrust::FontRef::new(font.data)
        .map_err(|e| SignError::Malformed(format!("font: {e}")))?;
    let data = harfrust::ShaperData::new(&fr);
    let shaper = data.shaper(&fr).build();
    let mut buf = harfrust::UnicodeBuffer::new();
    buf.push_str(text);
    buf.set_direction(if rtl {
        harfrust::Direction::RightToLeft
    } else {
        harfrust::Direction::LeftToRight
    });
    buf.guess_segment_properties();
    let out = shaper.shape(buf, harfrust::ShapeOptions::new());
    Ok(out
        .glyph_infos()
        .iter()
        .zip(out.glyph_positions())
        .map(|(i, p)| Glyph {
            gid: u16::try_from(i.glyph_id).unwrap_or(0),
            adv: p.x_advance,
            dx: p.x_offset,
            dy: p.y_offset,
            cluster: base + i.cluster as usize,
        })
        .collect())
}

/// A shaped line in visual order.
struct Line {
    text: String,
    glyphs: Vec<Glyph>,
    width: f64,
    rtl: bool,
}

fn shape_line(font: &Font<'_>, text: &str) -> Result<Line> {
    let info = unicode_bidi::BidiInfo::new(text, None);
    let mut glyphs = Vec::new();
    let mut rtl = false;
    if let Some(para) = info.paragraphs.first() {
        rtl = para.level.is_rtl();
        let (levels, runs) = info.visual_runs(para, para.range.clone());
        for run in runs {
            let level = levels.get(run.start).copied().unwrap_or(para.level);
            let piece = text.get(run.clone()).unwrap_or_default();
            glyphs.extend(shape_run(font, piece, level.is_rtl(), run.start)?);
        }
    }
    let width = glyphs.iter().map(|g| f64::from(g.adv)).sum::<f64>();
    Ok(Line {
        text: text.to_string(),
        glyphs,
        width,
        rtl,
    })
}

/// Word index (in logical order) for each byte of `text`; `None` for whitespace.
fn word_of_byte(text: &str) -> (Vec<Option<usize>>, Vec<String>) {
    let mut map = vec![None; text.len()];
    let mut words = Vec::new();
    let mut cur: Option<(usize, usize)> = None;
    for (i, c) in text.char_indices() {
        if c.is_whitespace() {
            if let Some((s, _)) = cur.take() {
                words.push(text.get(s..i).unwrap_or_default().to_string());
            }
        } else {
            let w = match cur {
                Some((_, w)) => w,
                None => {
                    cur = Some((i, words.len()));
                    words.len()
                }
            };
            for slot in map.iter_mut().skip(i).take(c.len_utf8()) {
                *slot = Some(w);
            }
        }
    }
    if let Some((s, _)) = cur {
        words.push(text.get(s..).unwrap_or_default().to_string());
    }
    (map, words)
}

fn utf16_hex(s: &str) -> String {
    let mut h = String::from("<FEFF");
    for u in s.encode_utf16() {
        let _ = write!(h, "{u:04X}");
    }
    h.push('>');
    h
}

/// Build the appearance form XObject for a widget of `rect` on a page rotated by `rot`
/// degrees. Font objects are added to `edit`.
pub fn build(edit: &mut Edit<'_>, rect: [f64; 4], rot: i64, lines: &[String]) -> Result<Stream> {
    let font = load_font()?;
    let (rw, rh) = ((rect[2] - rect[0]).abs(), (rect[3] - rect[1]).abs());
    let (w, h) = if rot == 90 || rot == 270 {
        (rh, rw)
    } else {
        (rw, rh)
    };
    let shaped: Vec<Line> = lines
        .iter()
        .take(8)
        .map(|l| shape_line(&font, l))
        .collect::<Result<_>>()?;
    let pad = (w.min(h) * 0.06).clamp(1.0, 6.0);
    let line_h = (font.ascent - font.descent) / font.upem;
    let n = shaped.len().max(1) as f64;
    // Name line at size s, others at 0.6 s.
    let ratio = 0.6;
    let height_units = line_h * (1.0 + ratio * (n - 1.0));
    let mut s = ((h - 2.0 * pad) / height_units).min(28.0);
    for (i, l) in shaped.iter().enumerate() {
        let f = if i == 0 { 1.0 } else { ratio };
        let wu = l.width / font.upem * f;
        if wu > 0.0 {
            s = s.min((w - 2.0 * pad) / wu);
        }
    }
    let s = s.max(1.0);
    // Glyph subset.
    let mut remap = subsetter::GlyphRemapper::new();
    for l in &shaped {
        for g in &l.glyphs {
            remap.remap(g.gid);
        }
    }
    let mut content = String::new();
    let _ = writeln!(content, "q 1 1 1 rg 0 0 {} {} re f Q", num_s(w), num_s(h));
    let _ = writeln!(
        content,
        "q 0.1 0.2 0.45 RG 0.8 w 0.4 0.4 {} {} re S Q",
        num_s(w - 0.8),
        num_s(h - 0.8)
    );
    content.push_str("BT\n0.05 0.1 0.25 rg\n");
    let mut y = h - pad;
    let mut to_unicode: BTreeMap<u16, String> = BTreeMap::new();
    for (i, line) in shaped.iter().enumerate() {
        let size = if i == 0 { s } else { s * ratio };
        let scale = size / font.upem;
        y -= font.ascent * scale;
        let lw = line.width * scale;
        let x0 = if line.rtl { w - pad - lw } else { pad };
        let _ = writeln!(content, "/F1 {} Tf", num_s(size));
        let (word_map, words) = word_of_byte(&line.text);
        // Group consecutive glyphs by word.
        let mut pen = x0;
        let mut idx = 0;
        while idx < line.glyphs.len() {
            let wi = line
                .glyphs
                .get(idx)
                .and_then(|g| word_map.get(g.cluster).copied().flatten());
            let mut end = idx + 1;
            while end < line.glyphs.len()
                && line
                    .glyphs
                    .get(end)
                    .and_then(|g| word_map.get(g.cluster).copied().flatten())
                    == wi
            {
                end += 1;
            }
            if let Some(word) = wi.and_then(|k| words.get(k)) {
                let _ = writeln!(content, "/Span <</ActualText {}>> BDC", utf16_hex(word));
            }
            let _ = writeln!(content, "1 0 0 1 {} {} Tm", num_s(pen), num_s(y));
            let mut tj = String::new();
            for g in line.glyphs.get(idx..end).unwrap_or_default() {
                let new_gid = remap.get(g.gid).unwrap_or(0);
                let cluster_text: String = line
                    .text
                    .get(g.cluster..)
                    .unwrap_or_default()
                    .chars()
                    .take(1)
                    .collect();
                to_unicode.entry(new_gid).or_insert(cluster_text);
                let hmtx_adv = glyph_advance(&font, g.gid);
                if g.dx != 0 || g.dy != 0 {
                    if !tj.is_empty() {
                        let _ = writeln!(content, "[{tj}] TJ");
                        tj.clear();
                    }
                    let _ = writeln!(
                        content,
                        "1 0 0 1 {} {} Tm <{new_gid:04X}> Tj",
                        num_s(pen + f64::from(g.dx) * scale),
                        num_s(y + f64::from(g.dy) * scale)
                    );
                    pen += f64::from(g.adv) * scale;
                    let _ = writeln!(content, "1 0 0 1 {} {} Tm", num_s(pen), num_s(y));
                    continue;
                }
                let _ = write!(tj, "<{new_gid:04X}>");
                let adj = (hmtx_adv - f64::from(g.adv)) * 1000.0 / font.upem;
                if adj.abs() > 0.01 {
                    let _ = write!(tj, " {} ", num_s(adj));
                }
                pen += f64::from(g.adv) * scale;
            }
            if !tj.is_empty() {
                let _ = writeln!(content, "[{tj}] TJ");
            }
            if wi.is_some() {
                content.push_str("EMC\n");
            }
            idx = end;
        }
        y -= -font.descent * scale;
    }
    content.push_str("ET\n");
    let font_id = embed_font(edit, &font, &remap, &to_unicode)?;
    let mut res = Dictionary::new();
    let mut fonts = Dictionary::new();
    fonts.set("F1", Object::Reference(font_id));
    res.set("Font", Object::Dictionary(fonts));
    let mut d = Dictionary::new();
    d.set("Type", name("XObject"));
    d.set("Subtype", name("Form"));
    d.set(
        "BBox",
        Object::Array(vec![0.into(), 0.into(), num(w), num(h)]),
    );
    let m: [i64; 4] = match rot {
        90 => [0, 1, -1, 0],
        180 => [-1, 0, 0, -1],
        270 => [0, -1, 1, 0],
        _ => [1, 0, 0, 1],
    };
    if rot != 0 {
        d.set(
            "Matrix",
            Object::Array(
                m.iter()
                    .map(|v| Object::Integer(*v))
                    .chain([0.into(), 0.into()])
                    .collect(),
            ),
        );
    }
    d.set("Resources", Object::Dictionary(res));
    let mut st = Stream::new(d, content.into_bytes());
    let _ = st.compress();
    Ok(st)
}

fn num_s(v: f64) -> String {
    let s = format!("{v:.3}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s.is_empty() || s == "-0" {
        "0".into()
    } else {
        s.to_string()
    }
}

fn glyph_advance(font: &Font<'_>, gid: u16) -> f64 {
    use read_fonts::TableProvider;
    read_fonts::FontRef::new(font.data)
        .ok()
        .and_then(|f| f.hmtx().ok())
        .and_then(|h| h.advance(read_fonts::types::GlyphId::new(u32::from(gid))))
        .map(f64::from)
        .unwrap_or(0.0)
}

fn subset_tag(remap: &subsetter::GlyphRemapper) -> String {
    let gids: Vec<u8> = remap
        .remapped_gids()
        .flat_map(|g| g.to_be_bytes())
        .collect();
    let d = crate::hash::HashAlg::Sha256.digest(&gids);
    d.iter()
        .take(6)
        .map(|b| char::from(b'A' + b % 26))
        .collect()
}

fn embed_font(
    edit: &mut Edit<'_>,
    font: &Font<'_>,
    remap: &subsetter::GlyphRemapper,
    to_unicode: &BTreeMap<u16, String>,
) -> Result<lopdf::ObjectId> {
    let sub = subsetter::subset(font.data, 0, remap)
        .map_err(|e| SignError::Malformed(format!("font subsetting: {e:?}")))?;
    let base = format!("{}+Amiri-Regular", subset_tag(remap));
    let k = 1000.0 / font.upem;
    let mut ff = Dictionary::new();
    ff.set("Length1", Object::Integer(sub.len() as i64));
    let mut ff = Stream::new(ff, sub);
    let _ = ff.compress();
    let ff_id = edit.add(Object::Stream(ff));
    let mut fd = Dictionary::new();
    fd.set("Type", name("FontDescriptor"));
    fd.set("FontName", name(&base));
    fd.set("Flags", Object::Integer(4));
    fd.set(
        "FontBBox",
        Object::Array(font.bbox.iter().map(|v| num((v * k).round())).collect()),
    );
    fd.set("ItalicAngle", Object::Integer(0));
    fd.set("Ascent", num((font.ascent * k).round()));
    fd.set("Descent", num((font.descent * k).round()));
    fd.set("CapHeight", num((font.cap * k).round()));
    fd.set("StemV", Object::Integer(80));
    fd.set("FontFile2", Object::Reference(ff_id));
    let fd_id = edit.add(Object::Dictionary(fd));
    // Widths per new gid.
    let mut w = Vec::new();
    for old in remap.remapped_gids() {
        let new = remap.get(old).unwrap_or(0);
        w.push(Object::Integer(i64::from(new)));
        w.push(Object::Array(vec![num(
            (glyph_advance(font, old) * k).round()
        )]));
    }
    let mut sys = Dictionary::new();
    sys.set("Registry", Object::string_literal("Adobe"));
    sys.set("Ordering", Object::string_literal("Identity"));
    sys.set("Supplement", Object::Integer(0));
    let mut cid = Dictionary::new();
    cid.set("Type", name("Font"));
    cid.set("Subtype", name("CIDFontType2"));
    cid.set("BaseFont", name(&base));
    cid.set("CIDSystemInfo", Object::Dictionary(sys));
    cid.set("FontDescriptor", Object::Reference(fd_id));
    cid.set("CIDToGIDMap", name("Identity"));
    cid.set("DW", Object::Integer(0));
    cid.set("W", Object::Array(w));
    let cid_id = edit.add(Object::Dictionary(cid));
    // ToUnicode.
    let mut cmap = String::from(
        "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n",
    );
    let entries: Vec<(&u16, &String)> = to_unicode.iter().filter(|(_, s)| !s.is_empty()).collect();
    for chunk in entries.chunks(100) {
        let _ = writeln!(cmap, "{} beginbfchar", chunk.len());
        for (g, s) in chunk {
            let hex: String = s.encode_utf16().map(|u| format!("{u:04X}")).collect();
            let _ = writeln!(cmap, "<{g:04X}> <{hex}>");
        }
        cmap.push_str("endbfchar\n");
    }
    cmap.push_str("endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n");
    let mut tu = Stream::new(Dictionary::new(), cmap.into_bytes());
    let _ = tu.compress();
    let tu_id = edit.add(Object::Stream(tu));
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
    let _ = StringFormat::Literal;
    Ok(edit.add(Object::Dictionary(t0)))
}

/// Shape `text` and return `(glyph ids, total advance in font units)` — exposed for tests.
pub fn shape_for_test(text: &str) -> Result<(Vec<u16>, f64)> {
    let font = load_font()?;
    let l = shape_line(&font, text)?;
    Ok((l.glyphs.iter().map(|g| g.gid).collect(), l.width))
}

/// The glyph id the bundled font maps `c` to (nominal, unshaped) — exposed for tests.
pub fn nominal_glyph_for_test(c: char) -> Option<u16> {
    use read_fonts::TableProvider;
    let f = read_fonts::FontRef::new(FONT).ok()?;
    let cmap = f.cmap().ok()?;
    cmap.map_codepoint(c)
        .map(|g| u16::try_from(g.to_u32()).unwrap_or(0))
}
