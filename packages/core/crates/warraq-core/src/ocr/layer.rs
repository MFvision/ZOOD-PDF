//! The invisible OCR text layer.
//!
//! Every recognised word becomes one run of GlyphLessFont characters in text rendering mode 3
//! (invisible), horizontally scaled (`Tz`) so the run covers the word's box, wrapped in a
//! `/Span <</ActualText …>> BDC … EMC` with the word itself. Characters are written in LOGICAL
//! order; for right-to-left words the text matrix is mirrored (the pen moves leftwards from the
//! word's right edge), the same convention as Tesseract's PDF renderer, so readers that ignore
//! `/ActualText` still see the characters in reading order. `/Direction` is never written.
//!
//! Coordinates: word boxes are in pixels of the image that was recognised (y down). That image
//! shows the page as displayed (after `/Rotate`), optionally deskewed by `angle` degrees
//! (counter-clockwise skew of the content, rotated about the image centre). The layer undoes both
//! so the text sits on the original, possibly crooked, page image.

use super::font::{glyphless_font, ADVANCE, ASCENT, DESCENT, UNITS_PER_EM};
use crate::CoreError;
use serde::Deserialize;
use warraq_pdf::lopdf::{Dictionary, Object, ObjectId, Stream, StringFormat};
use warraq_pdf::{pages, Pdf};

/// Most words accepted for one page.
pub const MAX_WORDS: usize = 20_000;
/// Longest word accepted (in chars).
pub const MAX_WORD_CHARS: usize = 256;
/// Largest image side accepted (pixels).
pub const MAX_IMAGE_SIDE: f64 = 100_000.0;
/// Largest skew angle accepted (degrees).
pub const MAX_ANGLE: f64 = 45.0;
/// BaseFont of the text-layer font; an existing one in the document is reused.
pub const FONT_NAME: &[u8] = b"GlyphLessFont";

/// One recognised word.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrWord {
    pub text: String,
    /// `[x0, y0, x1, y1]` in image pixels, y down.
    pub bbox: Vec<f64>,
    /// Recognition confidence 0–100.
    #[serde(default)]
    pub conf: Option<f64>,
    /// Line number (informational).
    #[serde(default)]
    pub line: Option<u32>,
}

/// Where the recognised image sits on the page.
#[derive(Debug, Clone, Copy)]
pub struct ImageFrame {
    /// Image size in pixels (if known).
    pub width: Option<f64>,
    pub height: Option<f64>,
    /// Image resolution (used when the size is not given).
    pub dpi: Option<f64>,
    /// Counter-clockwise skew of the content in degrees (0 = straight).
    pub angle: f64,
    /// Display rotation of the image relative to the unrotated page (default: the page's /Rotate).
    pub rotation: Option<i64>,
}

/// Result of adding a layer to one page.
#[derive(Debug, Clone, Copy, Default)]
pub struct LayerStats {
    pub words: usize,
    pub skipped: usize,
}

fn finite(v: f64, what: &str) -> Result<f64, CoreError> {
    if v.is_finite() {
        Ok(v)
    } else {
        Err(CoreError::params(format!("{what} must be a finite number")))
    }
}

/// Validates the frame and words (bounded, before touching the document).
pub fn validate(frame: &ImageFrame, words: &[OcrWord]) -> Result<(), CoreError> {
    if words.len() > MAX_WORDS {
        return Err(CoreError::params(format!(
            "at most {MAX_WORDS} words per page"
        )));
    }
    let a = finite(frame.angle, "angle")?;
    if a.abs() > MAX_ANGLE {
        return Err(CoreError::params(format!(
            "angle must be within ±{MAX_ANGLE}°"
        )));
    }
    for (v, what) in [(frame.width, "imageWidth"), (frame.height, "imageHeight")] {
        if let Some(v) = v {
            let v = finite(v, what)?;
            if !(1.0..=MAX_IMAGE_SIDE).contains(&v) {
                return Err(CoreError::params(format!(
                    "{what} must be 1–{MAX_IMAGE_SIDE}"
                )));
            }
        }
    }
    if frame.width.is_some() != frame.height.is_some() {
        return Err(CoreError::params("give both imageWidth and imageHeight"));
    }
    if let Some(d) = frame.dpi {
        let d = finite(d, "imageDpi")?;
        if !(10.0..=2400.0).contains(&d) {
            return Err(CoreError::params("imageDpi must be 10–2400"));
        }
    }
    if frame.width.is_none() && frame.dpi.is_none() {
        return Err(CoreError::params("give imageWidth/imageHeight or imageDpi"));
    }
    for w in words {
        if w.text.chars().count() > MAX_WORD_CHARS {
            return Err(CoreError::params(format!(
                "words are at most {MAX_WORD_CHARS} characters"
            )));
        }
        let [x0, y0, x1, y1] = <[f64; 4]>::try_from(w.bbox.as_slice())
            .map_err(|_| CoreError::params("bbox must be [x0, y0, x1, y1]"))?;
        for v in [x0, y0, x1, y1] {
            if !finite(v, "bbox")?.abs().le(&(MAX_IMAGE_SIDE * 2.0)) {
                return Err(CoreError::params("bbox is outside the image"));
            }
        }
        if x1 <= x0 || y1 <= y0 {
            return Err(CoreError::params("bbox must have x1 > x0 and y1 > y0"));
        }
        if let Some(c) = w.conf {
            finite(c, "conf")?;
        }
    }
    Ok(())
}

/// True when the first strong character of `s` is right-to-left (Hebrew, Arabic, Syriac,
/// Thaana, NKo, Arabic presentation forms …).
pub fn is_rtl(s: &str) -> bool {
    for c in s.chars() {
        let u = c as u32;
        let rtl = matches!(u, 0x0590..=0x08FF | 0xFB1D..=0xFDFF | 0xFE70..=0xFEFF | 0x10800..=0x10FFF | 0x1E800..=0x1EFFF);
        if rtl {
            // Arabic-Indic digits are weak; keep looking for a letter.
            if matches!(u, 0x0660..=0x0669 | 0x06F0..=0x06F9) {
                continue;
            }
            return true;
        }
        if c.is_alphabetic() {
            return false;
        }
    }
    false
}

fn name(n: &[u8]) -> Object {
    Object::Name(n.to_vec())
}

/// The text-layer font (Type0 → CIDFontType2 → GlyphLessFont); reuses one already in the file.
pub fn ensure_font(pdf: &mut Pdf) -> Result<ObjectId, CoreError> {
    let existing = pdf.objects().iter().find_map(|(id, o)| {
        let d = o.as_dict().ok()?;
        let is_ours = d.get(b"Subtype").ok()?.as_name().ok()? == b"Type0"
            && d.get(b"BaseFont").ok()?.as_name().ok()? == FONT_NAME
            && d.get(b"Encoding").ok()?.as_name().ok()? == b"Identity-H";
        is_ours.then_some(*id)
    });
    if let Some(id) = existing {
        return Ok(id);
    }
    let ttf = glyphless_font();
    let mut ff = Dictionary::new();
    ff.set("Length1", Object::Integer(ttf.len() as i64));
    let mut file = Stream::new(ff, ttf);
    let _ = file.compress();
    let file_id = pdf.add(Object::Stream(file));

    let mut fd = Dictionary::new();
    fd.set("Type", name(b"FontDescriptor"));
    fd.set("FontName", name(FONT_NAME));
    fd.set("Flags", Object::Integer(5)); // FixedPitch + Symbolic
    fd.set(
        "FontBBox",
        Object::Array(vec![
            0.into(),
            i64::from(DESCENT).into(),
            i64::from(ADVANCE).into(),
            i64::from(ASCENT).into(),
        ]),
    );
    fd.set("ItalicAngle", Object::Integer(0));
    fd.set("Ascent", Object::Integer(i64::from(ASCENT)));
    fd.set("Descent", Object::Integer(i64::from(DESCENT)));
    fd.set("CapHeight", Object::Integer(i64::from(ASCENT)));
    fd.set("StemV", Object::Integer(80));
    fd.set("FontFile2", Object::Reference(file_id));
    let fd_id = pdf.add(Object::Dictionary(fd));

    // Every CID (a UTF-16 code unit) → glyph 1.
    let map: Vec<u8> = std::iter::repeat_n([0u8, 1u8], 65_536).flatten().collect();
    let mut map_stream = Stream::new(Dictionary::new(), map);
    let _ = map_stream.compress();
    let map_id = pdf.add(Object::Stream(map_stream));

    let mut sys = Dictionary::new();
    sys.set("Registry", Object::string_literal("Adobe"));
    sys.set("Ordering", Object::string_literal("Identity"));
    sys.set("Supplement", Object::Integer(0));
    let mut cid = Dictionary::new();
    cid.set("Type", name(b"Font"));
    cid.set("Subtype", name(b"CIDFontType2"));
    cid.set("BaseFont", name(FONT_NAME));
    cid.set("CIDSystemInfo", Object::Dictionary(sys));
    cid.set("FontDescriptor", Object::Reference(fd_id));
    cid.set("DW", Object::Integer(i64::from(ADVANCE)));
    cid.set("CIDToGIDMap", Object::Reference(map_id));
    let cid_id = pdf.add(Object::Dictionary(cid));

    let cmap = "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n\
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n\
/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n\
1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n\
1 beginbfrange\n<0000> <FFFF> <0000>\nendbfrange\n\
endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n";
    let mut tu = Stream::new(Dictionary::new(), cmap.as_bytes().to_vec());
    let _ = tu.compress();
    let tu_id = pdf.add(Object::Stream(tu));

    let mut t0 = Dictionary::new();
    t0.set("Type", name(b"Font"));
    t0.set("Subtype", name(b"Type0"));
    t0.set("BaseFont", name(FONT_NAME));
    t0.set("Encoding", name(b"Identity-H"));
    t0.set(
        "DescendantFonts",
        Object::Array(vec![Object::Reference(cid_id)]),
    );
    t0.set("ToUnicode", Object::Reference(tu_id));
    Ok(pdf.add(Object::Dictionary(t0)))
}

fn num(v: f64) -> String {
    let r = if v.abs() < 5e-5 { 0.0 } else { v };
    format!("{r:.4}")
}

fn pt(v: f64) -> String {
    let r = if v.abs() < 5e-4 { 0.0 } else { v };
    format!("{r:.3}")
}

fn hex_utf16(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 4 + 2);
    for u in s.encode_utf16() {
        out.push_str(&format!("{u:04X}"));
    }
    out
}

/// Maps a point of the recognised image (display space, points, y down) to page space.
struct Mapper {
    /// Unrotated visible box.
    b: [f64; 4],
    rotation: i64,
    cx: f64,
    cy: f64,
    cos: f64,
    sin: f64,
}

impl Mapper {
    fn map(&self, x: f64, y: f64) -> (f64, f64) {
        // undo the deskew: rotate counter-clockwise (visually) about the centre
        let (dx, dy) = (x - self.cx, y - self.cy);
        let x = self.cx + dx * self.cos + dy * self.sin;
        let y = self.cy - dx * self.sin + dy * self.cos;
        let [x0, y0, x1, y1] = self.b;
        match self.rotation {
            90 => (x0 + y, y0 + x),
            180 => (x1 - x, y0 + y),
            270 => (x1 - y, y1 - x),
            _ => (x0 + x, y1 - y),
        }
    }
}

/// Adds the invisible text layer of `words` to page `index` (pending until the next commit).
pub fn add_text_layer(
    pdf: &mut Pdf,
    index: usize,
    frame: &ImageFrame,
    words: &[OcrWord],
    min_conf: f64,
) -> Result<LayerStats, CoreError> {
    validate(frame, words)?;
    pdf.require("adding a text layer", |p| p.modify)?;
    let list = pages::flatten(pdf)?;
    let page = list.get(index).ok_or_else(|| {
        CoreError::params(format!(
            "page {} does not exist ({} pages)",
            index + 1,
            list.len()
        ))
    })?;
    let b = page.visible_box();
    let rotation = frame
        .rotation
        .map(|r| r.rem_euclid(360) / 90 * 90)
        .unwrap_or(page.rotate);
    let (pw, ph) = (b[2] - b[0], b[3] - b[1]);
    let (dw, dh) = if rotation == 90 || rotation == 270 {
        (ph, pw)
    } else {
        (pw, ph)
    };
    let (sx, sy) = match (frame.width, frame.height, frame.dpi) {
        (Some(w), Some(h), _) => (dw / w, dh / h),
        (_, _, Some(d)) => (72.0 / d, 72.0 / d),
        _ => return Err(CoreError::params("give imageWidth/imageHeight or imageDpi")),
    };
    let rad = frame.angle.to_radians();
    let m = Mapper {
        b,
        rotation,
        cx: dw / 2.0,
        cy: dh / 2.0,
        cos: rad.cos(),
        sin: rad.sin(),
    };

    let mut stats = LayerStats::default();
    let mut ops = String::new();
    let font_id = ensure_font(pdf)?;
    let res_name = add_font_resource(pdf, page.id, page.resources.as_ref(), font_id)?;
    ops.push_str("BT\n3 Tr 0 Tc 0 Tw 0 Ts\n");
    let em = f64::from(UNITS_PER_EM);
    for w in words {
        let text = w.text.trim();
        if text.is_empty() || w.conf.is_some_and(|c| c < min_conf) {
            stats.skipped += 1;
            continue;
        }
        let [x0, y0, x1, y1] = <[f64; 4]>::try_from(w.bbox.as_slice())
            .map_err(|_| CoreError::params("bbox must be [x0, y0, x1, y1]"))?;
        let (bx0, by0, bx1, by1) = (x0 * sx, y0 * sy, x1 * sx, y1 * sy);
        let height = (by1 - by0).max(0.5);
        let size = height * em / f64::from(ASCENT - DESCENT);
        let baseline = by1 + size * f64::from(DESCENT) / em; // DESCENT < 0: above the bottom
        let rtl = is_rtl(text);
        let (sx0, adv) = if rtl { (bx1, -1.0) } else { (bx0, 1.0) };
        let p = m.map(sx0, baseline);
        let a = m.map(sx0 + adv, baseline);
        let u = m.map(sx0, baseline - 1.0);
        let units = text.encode_utf16().count().max(1) as f64;
        let natural = units * size * f64::from(ADVANCE) / em;
        let tz = (100.0 * (bx1 - bx0) / natural).clamp(1.0, 10_000.0);
        ops.push_str(&format!(
            "/Span <</ActualText <FEFF{}>>> BDC\n/{} {} Tf {} Tz {} {} {} {} {} {} Tm <{}> Tj\nEMC\n",
            hex_utf16(text),
            res_name,
            pt(size),
            pt(tz),
            num(a.0 - p.0),
            num(a.1 - p.1),
            num(u.0 - p.0),
            num(u.1 - p.1),
            pt(p.0),
            pt(p.1),
            hex_utf16(text),
        ));
        stats.words += 1;
    }
    ops.push_str("ET\n");
    if stats.words > 0 {
        append_content(pdf, page.id, ops.into_bytes())?;
    }
    Ok(stats)
}

/// Gives the page its own /Resources (a copy of the effective ones) with the font added.
fn add_font_resource(
    pdf: &mut Pdf,
    page_id: ObjectId,
    effective: Option<&Object>,
    font_id: ObjectId,
) -> Result<String, CoreError> {
    let mut res = effective
        .and_then(|o| pdf.resolve(o))
        .and_then(|o| o.as_dict().ok())
        .cloned()
        .unwrap_or_default();
    let mut fonts = res
        .get(b"Font")
        .ok()
        .and_then(|o| pdf.resolve(o))
        .and_then(|o| o.as_dict().ok())
        .cloned()
        .unwrap_or_default();
    // Already there (a second layer on the same page)?
    let existing = fonts.iter().find_map(|(k, v)| {
        (v.as_reference().ok() == Some(font_id)).then(|| String::from_utf8_lossy(k).into_owned())
    });
    let key = match existing {
        Some(k) => k,
        None => {
            let mut k = "ZoodOcr".to_string();
            let mut n = 0u32;
            while fonts.has(k.as_bytes()) && n < 10_000 {
                n += 1;
                k = format!("ZoodOcr{n}");
            }
            fonts.set(k.as_bytes().to_vec(), Object::Reference(font_id));
            k
        }
    };
    res.set("Font", Object::Dictionary(fonts));
    let mut page = pdf
        .get_dict(page_id)
        .cloned()
        .ok_or_else(|| CoreError::new("structure_error", "page is not a dictionary"))?;
    page.set("Resources", Object::Dictionary(res));
    pdf.set(page_id, Object::Dictionary(page));
    Ok(key)
}

/// Appends `ops` after the page's content, isolated by `q … Q` around the original.
fn append_content(pdf: &mut Pdf, page_id: ObjectId, ops: Vec<u8>) -> Result<(), CoreError> {
    let mut page = pdf
        .get_dict(page_id)
        .cloned()
        .ok_or_else(|| CoreError::new("structure_error", "page is not a dictionary"))?;
    let old: Vec<Object> = match page.get(b"Contents").ok() {
        None => Vec::new(),
        Some(Object::Reference(r)) => match pdf.get(*r) {
            Some(Object::Array(a)) => a.clone(),
            Some(_) => vec![Object::Reference(*r)],
            None => Vec::new(),
        },
        Some(Object::Array(a)) => a.clone(),
        Some(_) => Vec::new(),
    };
    let mut list = Vec::with_capacity(old.len() + 2);
    let body = if old.is_empty() {
        let mut v = b"q\n".to_vec();
        v.extend_from_slice(&ops);
        v.extend_from_slice(b"Q\n");
        v
    } else {
        let q = pdf.add(Object::Stream(Stream::new(
            Dictionary::new(),
            b"q\n".to_vec(),
        )));
        list.push(Object::Reference(q));
        list.extend(old);
        let mut v = b"Q\nq\n".to_vec();
        v.extend_from_slice(&ops);
        v.extend_from_slice(b"Q\n");
        v
    };
    let mut s = Stream::new(Dictionary::new(), body);
    let _ = s.compress();
    let id = pdf.add(Object::Stream(s));
    list.push(Object::Reference(id));
    page.set("Contents", Object::Array(list));
    pdf.set(page_id, Object::Dictionary(page));
    Ok(())
}

/// A PDF text string (UTF-16BE with BOM when not plain ASCII).
pub fn text_string(s: &str) -> Object {
    if s.is_ascii() {
        Object::String(s.as_bytes().to_vec(), StringFormat::Literal)
    } else {
        let mut v = vec![0xFE, 0xFF];
        for u in s.encode_utf16() {
            v.extend_from_slice(&u.to_be_bytes());
        }
        Object::String(v, StringFormat::Hexadecimal)
    }
}
