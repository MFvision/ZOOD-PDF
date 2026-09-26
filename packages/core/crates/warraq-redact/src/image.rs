//! Image redaction: decode the samples, clear every pixel under a redaction area, re-encode.
//!
//! Supported: unfiltered images and the lossless filters lopdf decodes (Flate, LZW, ASCII85,
//! ASCIIHex, RunLength, with predictors), and single-filter `DCTDecode` (JPEG, grey or RGB) via
//! zune-jpeg. Redacted pixels get all sample bits cleared (black for Gray/RGB, white for CMYK,
//! index 0 for Indexed, "paint" for stencil masks — the fill box covers them either way), and
//! the image is re-encoded with Flate. Anything else (JPX, JBIG2, CCITT, CMYK JPEG, sizes out of
//! bounds, truncated data we cannot trust) is reported as undecodable and the caller removes
//! the whole image.

use crate::util::{invert, number};
use lopdf::{Dictionary, Object, Stream};
use warraq_text::geom::{Matrix, Rect};
use warraq_text::lexer::{Lexer, Token};
use warraq_text::source::{resolve, resolve_dict, ContentSource};
use zune_core::bytestream::ZCursor;
use zune_core::colorspace::ColorSpace;
use zune_core::options::DecoderOptions;

/// Largest image side accepted.
pub const MAX_SIDE: usize = 30_000;
/// Largest decoded image accepted (bytes).
pub const MAX_IMAGE_BYTES: usize = 256 << 20;

/// Result of redacting one image.
#[derive(Debug)]
pub enum Outcome {
    /// New (unfiltered) samples and the dictionary to store them with.
    Redacted { dict: Dictionary, data: Vec<u8> },
    /// Could not decode safely; the reason is reported and the caller removes the image.
    Undecodable(&'static str),
}

/// Pixel rectangles `[i0, i1) × [j0, j1)` (columns × rows, row 0 at the top) covered by `rects`
/// for an image drawn with `ctm` (unit square → page).
pub fn pixel_boxes(ctm: &Matrix, w: usize, h: usize, rects: &[Rect]) -> Vec<[usize; 4]> {
    let Some(inv) = invert(ctm) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for r in rects {
        let u = crate::util::transform_rect(&inv, r);
        let (u0, u1) = (u.x0.clamp(0.0, 1.0), u.x1.clamp(0.0, 1.0));
        let (v0, v1) = (u.y0.clamp(0.0, 1.0), u.y1.clamp(0.0, 1.0));
        if u1 <= u0 || v1 <= v0 {
            continue;
        }
        let i0 = (u0 * w as f64).floor() as usize;
        let i1 = ((u1 * w as f64).ceil() as usize).min(w);
        let j0 = ((1.0 - v1) * h as f64).floor() as usize;
        let j1 = (((1.0 - v0) * h as f64).ceil() as usize).min(h);
        if i1 > i0 && j1 > j0 {
            out.push([i0, i1, j0, j1]);
        }
    }
    out
}

/// Clear the bits of every pixel in `boxes`.
pub fn clear_pixels(
    data: &mut [u8],
    w: usize,
    h: usize,
    bits_per_pixel: usize,
    boxes: &[[usize; 4]],
) {
    let stride = (w * bits_per_pixel).div_ceil(8);
    for b in boxes {
        let [i0, i1, j0, j1] = *b;
        for row in j0..j1.min(h) {
            let Some(line) = data.get_mut(row * stride..(row + 1) * stride) else {
                break;
            };
            clear_bits(line, i0 * bits_per_pixel, i1 * bits_per_pixel);
        }
    }
}

fn clear_bits(line: &mut [u8], start: usize, end: usize) {
    let mut bit = start;
    while bit < end {
        let byte = bit / 8;
        let off = bit % 8;
        if off == 0 && end - bit >= 8 {
            let n = (end - bit) / 8;
            if let Some(s) = line.get_mut(byte..byte + n) {
                s.fill(0);
            }
            bit += n * 8;
            continue;
        }
        if let Some(b) = line.get_mut(byte) {
            *b &= !(0x80u8 >> off);
        }
        bit += 1;
    }
}

/// Number of colour components of a colour space object (`None` = unsupported, e.g. Pattern).
pub fn components<S: ContentSource + ?Sized>(
    src: &S,
    cs: &Object,
    resources: Option<&Dictionary>,
    depth: usize,
) -> Option<usize> {
    if depth > 8 {
        return None;
    }
    let cs = resolve(src, cs)?;
    match cs {
        Object::Name(n) => match n.as_slice() {
            b"DeviceGray" | b"CalGray" | b"G" | b"Indexed" | b"I" => Some(1),
            b"DeviceRGB" | b"CalRGB" | b"RGB" | b"Lab" => Some(3),
            b"DeviceCMYK" | b"CMYK" => Some(4),
            other => {
                // A named resource (inline images).
                let res = resources?;
                let dict = res
                    .get(b"ColorSpace")
                    .ok()
                    .and_then(|o| resolve_dict(src, o))?;
                let v = dict.get(other).ok()?;
                components(src, v, None, depth + 1)
            }
        },
        Object::Array(a) => {
            let family = match a.first().and_then(|o| resolve(src, o)) {
                Some(Object::Name(n)) => n.as_slice(),
                _ => return None,
            };
            match family {
                b"Indexed" | b"I" | b"Separation" | b"CalGray" => Some(1),
                b"CalRGB" | b"Lab" => Some(3),
                b"DeviceN" => match a.get(1).and_then(|o| resolve(src, o)) {
                    Some(Object::Array(names)) if !names.is_empty() && names.len() <= 32 => {
                        Some(names.len())
                    }
                    _ => None,
                },
                b"ICCBased" => match a.get(1).and_then(|o| resolve(src, o)) {
                    Some(Object::Stream(s)) => match s.dict.get(b"N").ok().and_then(number) {
                        Some(n) if (1.0..=4.0).contains(&n) => Some(n as usize),
                        _ => None,
                    },
                    _ => None,
                },
                b"DeviceGray" | b"G" => Some(1),
                b"DeviceRGB" | b"RGB" => Some(3),
                b"DeviceCMYK" | b"CMYK" => Some(4),
                _ => None,
            }
        }
        _ => None,
    }
}

fn int<S: ContentSource + ?Sized>(src: &S, d: &Dictionary, keys: &[&[u8]]) -> Option<usize> {
    for k in keys {
        if let Ok(o) = d.get(k) {
            let v = resolve(src, o).and_then(number)?;
            return (0.0..=1e9).contains(&v).then_some(v as usize);
        }
    }
    None
}

fn flag<S: ContentSource + ?Sized>(src: &S, d: &Dictionary, keys: &[&[u8]]) -> bool {
    keys.iter().any(|k| {
        matches!(
            d.get(k).ok().and_then(|o| resolve(src, o)),
            Some(Object::Boolean(true))
        )
    })
}

/// Geometry of an image: width, height, bits per component, components.
struct Geometry {
    w: usize,
    h: usize,
    bpc: usize,
    comps: usize,
}

impl Geometry {
    fn stride(&self) -> usize {
        (self.w * self.bpc * self.comps).div_ceil(8)
    }
    fn len(&self) -> usize {
        self.stride().saturating_mul(self.h)
    }
}

fn geometry<S: ContentSource + ?Sized>(
    src: &S,
    d: &Dictionary,
    resources: Option<&Dictionary>,
) -> Result<Geometry, &'static str> {
    let w = int(src, d, &[b"Width", b"W"]).ok_or("image without width")?;
    let h = int(src, d, &[b"Height", b"H"]).ok_or("image without height")?;
    if w == 0 || h == 0 || w > MAX_SIDE || h > MAX_SIDE {
        return Err("image size out of bounds");
    }
    let mask = flag(src, d, &[b"ImageMask", b"IM"]);
    let (bpc, comps) = if mask {
        (1, 1)
    } else {
        let bpc = int(src, d, &[b"BitsPerComponent", b"BPC"]).unwrap_or(8);
        if !matches!(bpc, 1 | 2 | 4 | 8 | 16) {
            return Err("unsupported bits per component");
        }
        let cs = d
            .get(b"ColorSpace")
            .or_else(|_| d.get(b"CS"))
            .map_err(|_| "image without colour space")?;
        let comps = components(src, cs, resources, 0).ok_or("unsupported colour space")?;
        (bpc, comps)
    };
    let g = Geometry { w, h, bpc, comps };
    if g.len() > MAX_IMAGE_BYTES {
        return Err("image too large");
    }
    Ok(g)
}

const SIMPLE_FILTERS: &[&[u8]] = &[
    b"FlateDecode",
    b"LZWDecode",
    b"ASCII85Decode",
    b"ASCIIHexDecode",
    b"RunLengthDecode",
];

fn filters_of(d: &Dictionary) -> Vec<Vec<u8>> {
    match d.get(b"Filter") {
        Ok(Object::Name(n)) => vec![n.clone()],
        Ok(Object::Array(a)) => a
            .iter()
            .filter_map(|o| match o {
                Object::Name(n) => Some(n.clone()),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// Decode a JPEG to 8-bit Gray or RGB samples.
fn decode_jpeg(data: &[u8]) -> Result<(Vec<u8>, usize, usize, usize), &'static str> {
    let opts = DecoderOptions::default()
        .set_max_width(MAX_SIDE)
        .set_max_height(MAX_SIDE);
    let mut probe = zune_jpeg::JpegDecoder::new_with_options(ZCursor::new(data), opts);
    probe.decode_headers().map_err(|_| "unreadable JPEG")?;
    let info = probe.info().ok_or("unreadable JPEG")?;
    let comps = usize::from(info.components);
    let out = match comps {
        1 => ColorSpace::Luma,
        3 => ColorSpace::RGB,
        _ => return Err("CMYK JPEG"),
    };
    let (w, h) = (usize::from(info.width), usize::from(info.height));
    if w.saturating_mul(h).saturating_mul(comps) > MAX_IMAGE_BYTES {
        return Err("image too large");
    }
    let mut dec = zune_jpeg::JpegDecoder::new_with_options(
        ZCursor::new(data),
        opts.jpeg_set_out_colorspace(out),
    );
    let px = dec.decode().map_err(|_| "unreadable JPEG")?;
    if px.len() < w * h * comps {
        return Err("truncated JPEG");
    }
    Ok((px, w, h, comps))
}

/// Redact an image XObject drawn with `ctm`.
pub fn redact_xobject<S: ContentSource + ?Sized>(
    src: &S,
    stream: &Stream,
    ctm: &Matrix,
    rects: &[Rect],
) -> Outcome {
    let filters = filters_of(&stream.dict);
    let mut dict = stream.dict.clone();
    let geo = match geometry(src, &stream.dict, None) {
        Ok(g) => g,
        Err(e) => return Outcome::Undecodable(e),
    };
    let (mut data, geo) = if filters
        .iter()
        .all(|f| SIMPLE_FILTERS.contains(&f.as_slice()))
    {
        let d = if filters.is_empty() {
            stream.content.clone()
        } else {
            match stream.decompressed_content_with_limit(MAX_IMAGE_BYTES) {
                Ok(d) => d,
                Err(_) => return Outcome::Undecodable("image data does not decode"),
            }
        };
        (d, geo)
    } else if filters.len() == 1 && filters.first().map(Vec::as_slice) == Some(b"DCTDecode") {
        match decode_jpeg(&stream.content) {
            Ok((px, w, h, comps)) => {
                dict.set("BitsPerComponent", Object::Integer(8));
                let keep_cs = components(
                    src,
                    stream.dict.get(b"ColorSpace").unwrap_or(&Object::Null),
                    None,
                    0,
                ) == Some(comps);
                if !keep_cs {
                    let name: &[u8] = if comps == 1 {
                        b"DeviceGray"
                    } else {
                        b"DeviceRGB"
                    };
                    dict.set("ColorSpace", Object::Name(name.to_vec()));
                }
                dict.set("Width", Object::Integer(w as i64));
                dict.set("Height", Object::Integer(h as i64));
                dict.remove(b"ColorTransform");
                (
                    px,
                    Geometry {
                        w,
                        h,
                        bpc: 8,
                        comps,
                    },
                )
            }
            Err(e) => return Outcome::Undecodable(e),
        }
    } else {
        return Outcome::Undecodable("image filter not supported for redaction");
    };
    data.resize(geo.len(), 0);
    let boxes = pixel_boxes(ctm, geo.w, geo.h, rects);
    clear_pixels(&mut data, geo.w, geo.h, geo.bpc * geo.comps, &boxes);
    dict.remove(b"Filter");
    dict.remove(b"DecodeParms");
    dict.remove(b"Length");
    Outcome::Redacted { dict, data }
}

/// An inline image (`BI … ID … EI`) parsed from its content-stream bytes.
struct Inline {
    /// (key, raw value bytes) in order.
    entries: Vec<(Vec<u8>, Vec<u8>)>,
    dict: Dictionary,
    data: Vec<u8>,
}

fn expand_key(k: &[u8]) -> &[u8] {
    match k {
        b"BPC" => b"BitsPerComponent",
        b"CS" => b"ColorSpace",
        b"D" => b"Decode",
        b"DP" => b"DecodeParms",
        b"F" => b"Filter",
        b"H" => b"Height",
        b"IM" => b"ImageMask",
        b"I" => b"Interpolate",
        b"W" => b"Width",
        other => other,
    }
}

fn expand_filter(n: &[u8]) -> Vec<u8> {
    match n {
        b"AHx" => b"ASCIIHexDecode".to_vec(),
        b"A85" => b"ASCII85Decode".to_vec(),
        b"LZW" => b"LZWDecode".to_vec(),
        b"Fl" => b"FlateDecode".to_vec(),
        b"RL" => b"RunLengthDecode".to_vec(),
        b"CCF" => b"CCITTFaxDecode".to_vec(),
        b"DCT" => b"DCTDecode".to_vec(),
        other => other.to_vec(),
    }
}

fn token_object(tok: &Token<'_>) -> Option<Object> {
    Some(match tok {
        Token::Num(n) => {
            if n.fract() == 0.0 && n.abs() < 1e15 {
                Object::Integer(*n as i64)
            } else {
                Object::Real(*n as f32)
            }
        }
        Token::Name(n) => Object::Name(n.clone()),
        Token::Str(s) | Token::Hex(s) => {
            Object::String(s.clone(), lopdf::StringFormat::Hexadecimal)
        }
        Token::Keyword(b"true") => Object::Boolean(true),
        Token::Keyword(b"false") => Object::Boolean(false),
        _ => return None,
    })
}

fn parse_inline(span: &[u8]) -> Option<Inline> {
    let mut lex = Lexer::new(span);
    if lex.next_token()? != Token::Keyword(b"BI") {
        return None;
    }
    let mut entries = Vec::new();
    let mut dict = Dictionary::new();
    loop {
        lex.skip_ws_and_comments();
        let key_tok = lex.next_token()?;
        let key = match key_tok {
            Token::Keyword(b"ID") => break,
            Token::Name(n) => n,
            _ => continue,
        };
        lex.skip_ws_and_comments();
        let vstart = lex.pos();
        let tok = lex.next_token()?;
        let value = match tok {
            Token::ArrOpen => {
                let mut items = Vec::new();
                let mut guard = 0;
                loop {
                    guard += 1;
                    if guard > 4096 {
                        return None;
                    }
                    match lex.next_token()? {
                        Token::ArrClose => break,
                        t => {
                            if let Some(o) = token_object(&t) {
                                items.push(o);
                            }
                        }
                    }
                }
                Object::Array(items)
            }
            Token::DictOpen => return None,
            t => token_object(&t)?,
        };
        let raw = span.get(vstart..lex.pos())?.to_vec();
        let full = expand_key(&key).to_vec();
        let value = if full.as_slice() == b"Filter" {
            match value {
                Object::Name(n) => Object::Name(expand_filter(&n)),
                Object::Array(a) => Object::Array(
                    a.into_iter()
                        .map(|o| match o {
                            Object::Name(n) => Object::Name(expand_filter(&n)),
                            o => o,
                        })
                        .collect(),
                ),
                o => o,
            }
        } else {
            value
        };
        dict.set(full, value);
        entries.push((key, raw));
        if entries.len() > 64 {
            return None;
        }
    }
    // One whitespace byte after ID, data up to the final EI.
    let mut start = lex.pos();
    if span.get(start).is_some_and(|b| b.is_ascii_whitespace()) {
        start += 1;
    }
    let end = span.len().checked_sub(2)?;
    if span.get(end..)? != b"EI" || end < start {
        return None;
    }
    let data = span.get(start..end)?.to_vec();
    Some(Inline {
        entries,
        dict,
        data,
    })
}

/// Redact an inline image (its exact `BI … EI` bytes). `Some(bytes)` = replacement, `None` =
/// the image cannot be decoded and must be removed.
pub fn redact_inline<S: ContentSource + ?Sized>(
    src: &S,
    resources: &Dictionary,
    span: &[u8],
    ctm: &Matrix,
    rects: &[Rect],
) -> Option<Vec<u8>> {
    let img = parse_inline(span)?;
    let mut geo = geometry(src, &img.dict, Some(resources)).ok()?;
    let filters = filters_of(&img.dict);
    let mut overrides: Vec<(&[u8], String)> = Vec::new();
    let mut data = if filters.is_empty() {
        img.data.clone()
    } else if filters
        .iter()
        .all(|f| SIMPLE_FILTERS.contains(&f.as_slice()))
    {
        let mut d = img.dict.clone();
        d.remove(b"Length");
        let s = Stream::new(d, img.data.clone());
        s.decompressed_content_with_limit(MAX_IMAGE_BYTES).ok()?
    } else if filters.len() == 1 && filters.first().map(Vec::as_slice) == Some(b"DCTDecode") {
        let (px, w, h, comps) = decode_jpeg(&img.data).ok()?;
        if w != geo.w || h != geo.h {
            return None;
        }
        geo = Geometry {
            w,
            h,
            bpc: 8,
            comps,
        };
        overrides.push((b"BPC", "8".into()));
        overrides.push((
            b"CS",
            if comps == 1 {
                "/G".into()
            } else {
                "/RGB".into()
            },
        ));
        px
    } else {
        return None;
    };
    data.resize(geo.len(), 0);
    let boxes = pixel_boxes(ctm, geo.w, geo.h, rects);
    clear_pixels(&mut data, geo.w, geo.h, geo.bpc * geo.comps, &boxes);
    let mut out = b"BI".to_vec();
    for (k, raw) in &img.entries {
        let full = expand_key(k);
        if matches!(full, b"Filter" | b"DecodeParms" | b"Length") {
            continue;
        }
        if overrides.iter().any(|(o, _)| expand_key(o) == full) {
            continue;
        }
        out.push(b' ');
        out.push(b'/');
        out.extend_from_slice(k);
        out.push(b' ');
        out.extend_from_slice(raw);
    }
    for (k, v) in &overrides {
        out.extend_from_slice(format!(" /{} {v}", String::from_utf8_lossy(k)).as_bytes());
    }
    out.extend_from_slice(b" /F /AHx ID ");
    for b in &data {
        out.extend_from_slice(format!("{b:02X}").as_bytes());
    }
    out.extend_from_slice(b"> EI");
    Some(out)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;
    use warraq_text::LopdfSource;

    #[test]
    fn clears_sub_byte_pixels() {
        // 16×2 1-bit image, all ones; clear columns 3..11 of row 1.
        let mut d = vec![0xff; 4];
        clear_pixels(&mut d, 16, 2, 1, &[[3, 11, 1, 2]]);
        assert_eq!(d, [0xff, 0xff, 0b1110_0000, 0b0001_1111]);
    }

    #[test]
    fn pixel_boxes_follow_the_ctm() {
        // 100×100 image drawn at (100,100) size 200×200; redact page rect 100..200 × 200..300
        // (left half columns, top half rows).
        let ctm = Matrix::new(200.0, 0.0, 0.0, 200.0, 100.0, 100.0);
        let b = pixel_boxes(&ctm, 100, 100, &[Rect::new(100.0, 200.0, 200.0, 300.0)]);
        assert_eq!(b, vec![[0, 50, 0, 50]]);
    }

    #[test]
    fn inline_image_round_trip() {
        let src = LopdfSource::from_document(lopdf::Document::with_version("1.7"));
        let span = b"BI /W 2 /H 2 /BPC 8 /CS /G ID \xff\xff\xff\xff EI";
        let ctm = Matrix::new(10.0, 0.0, 0.0, 10.0, 0.0, 0.0);
        let out = redact_inline(
            &src,
            &Dictionary::new(),
            span,
            &ctm,
            &[Rect::new(0.0, 5.0, 5.0, 10.0)],
        )
        .unwrap();
        let s = String::from_utf8(out).unwrap();
        assert!(
            s.starts_with("BI /W 2 /H 2 /BPC 8 /CS /G /F /AHx ID "),
            "{s}"
        );
        assert!(s.ends_with("00FFFFFF> EI"), "{s}");
        // Undecodable filter → None.
        assert!(redact_inline(
            &src,
            &Dictionary::new(),
            b"BI /W 2 /H 2 /BPC 8 /CS /G /F /CCF ID \x00 EI",
            &ctm,
            &[]
        )
        .is_none());
    }
}
