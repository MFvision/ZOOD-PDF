//! The pixels of a picture under a mark, blanked.
//!
//! A picture is drawn into the unit square, which the transform in force
//! takes onto the page; each mark is taken back through that transform into
//! the picture's own rows and columns, and every sample there is set to
//! zero. The copy is written uncompressed-then-Flate, with the picture's own
//! colour space, depth and decode array; a JPEG is decoded to its samples
//! first and stays decoded. A soft mask is blanked in the same place, or
//! the shape of what was under the mark would still be in it.
//!
//! What cannot be decoded here — JBIG2, JPEG 2000, CCITT fax, a filter
//! chain ending in one, a colour space whose components are not known — is
//! answered `None`, and the walker does not draw that picture at all: a
//! picture that cannot be read cannot be shown to be clear.
use std::io::Write;

use lopdf::{Dictionary, Document, Object, Stream};

use super::walk::Rect;
use crate::lex::{Op, Operand};
use crate::text_walk::Matrix;

/// Pictures larger than this are not decoded (as `tiff`'s limit).
const MAX_PIXELS: u64 = 64_000_000;
const MAX_SIDE: i64 = 30_000;

fn resolve<'a>(doc: &'a Document, o: &'a Object) -> &'a Object {
    match o {
        Object::Reference(id) => doc.get_object(*id).unwrap_or(o),
        _ => o,
    }
}

/// How many components a colour space has, or `None` if it is not known.
fn components(doc: &Document, space: &Object, depth: usize) -> Option<usize> {
    if depth > 8 {
        return None;
    }
    match resolve(doc, space) {
        Object::Name(n) => match n.as_slice() {
            b"DeviceGray" | b"CalGray" | b"G" | b"Indexed" | b"I" | b"Separation" => Some(1),
            b"DeviceRGB" | b"CalRGB" | b"RGB" | b"Lab" => Some(3),
            b"DeviceCMYK" | b"CMYK" => Some(4),
            _ => None,
        },
        Object::Array(a) => {
            let family = a.first().and_then(|f| f.as_name().ok())?;
            match family {
                b"ICCBased" => {
                    let profile = resolve(doc, a.get(1)?).as_stream().ok()?;
                    profile
                        .dict
                        .get(b"N")
                        .ok()
                        .and_then(|n| n.as_i64().ok())
                        .filter(|n| matches!(n, 1 | 3 | 4))
                        .map(|n| n as usize)
                }
                b"Indexed" | b"I" | b"Separation" | b"CalGray" | b"DeviceGray" => Some(1),
                b"CalRGB" | b"Lab" | b"DeviceRGB" => Some(3),
                b"DeviceCMYK" => Some(4),
                b"DeviceN" => resolve(doc, a.get(1)?)
                    .as_array()
                    .ok()
                    .map(Vec::len)
                    .filter(|n| (1..=32).contains(n)),
                _ => None,
            }
        }
        _ => None,
    }
}

fn int(doc: &Document, d: &Dictionary, key: &[u8]) -> Option<i64> {
    d.get(key)
        .ok()
        .map(|v| resolve(doc, v))
        .and_then(|v| v.as_i64().ok())
}

/// The filters of a stream, by name.
fn filters(doc: &Document, d: &Dictionary) -> Vec<Vec<u8>> {
    match d.get(b"Filter").ok().map(|f| resolve(doc, f)) {
        Some(Object::Name(n)) => vec![n.clone()],
        Some(Object::Array(a)) => a
            .iter()
            .filter_map(|f| f.as_name().ok().map(<[u8]>::to_vec))
            .collect(),
        _ => vec![],
    }
}

/// A picture's samples: width, height, components, bits, the rows (each
/// padded to a byte), and whether they came out of a JPEG decoded here.
struct Samples {
    width: usize,
    height: usize,
    comps: usize,
    bits: usize,
    rows: Vec<u8>,
    /// Decoded from a JPEG to this many components (the colour space may
    /// then have to say so).
    from_jpeg: bool,
}

impl Samples {
    fn row_bytes(&self) -> usize {
        (self.width * self.comps * self.bits).div_ceil(8)
    }

    /// Every sample of the pixels in columns `c0..c1` and rows `r0..r1` set
    /// to zero.
    fn blank(&mut self, (c0, c1): (usize, usize), (r0, r1): (usize, usize)) {
        let row_bytes = self.row_bytes();
        let bits_per_pixel = self.comps * self.bits;
        for r in r0..r1.min(self.height) {
            let row = &mut self.rows[r * row_bytes..(r + 1) * row_bytes];
            if bits_per_pixel.is_multiple_of(8) {
                let p = bits_per_pixel / 8;
                let len = row.len();
                let (a, b) = ((c0 * p).min(len), (c1.min(self.width) * p).min(len));
                if a < b {
                    row[a..b].fill(0);
                }
            } else {
                for c in c0..c1.min(self.width) {
                    for bit in c * bits_per_pixel..(c + 1) * bits_per_pixel {
                        row[bit / 8] &= !(0x80 >> (bit % 8));
                    }
                }
            }
        }
    }

    /// Blanks what each mark covers, the picture drawn under `ctm`.
    fn blank_marks(&mut self, ctm: Matrix, marks: &[Rect]) {
        let Some(inverse) = ctm.invert() else {
            return;
        };
        let (w, h) = (self.width as f32, self.height as f32);
        for m in marks {
            let corners = [(m[0], m[1]), (m[2], m[1]), (m[2], m[3]), (m[0], m[3])]
                .map(|(x, y)| inverse.apply(x, y));
            let (u0, u1) = (
                corners.iter().map(|p| p.0).fold(f32::MAX, f32::min),
                corners.iter().map(|p| p.0).fold(f32::MIN, f32::max),
            );
            let (v0, v1) = (
                corners.iter().map(|p| p.1).fold(f32::MAX, f32::min),
                corners.iter().map(|p| p.1).fold(f32::MIN, f32::max),
            );
            if u1 <= 0.0 || u0 >= 1.0 || v1 <= 0.0 || v0 >= 1.0 {
                continue;
            }
            // Row 0 is the top of the picture, where v is 1.
            let cols = (
                (u0.max(0.0) * w).floor() as usize,
                (u1.min(1.0) * w).ceil() as usize,
            );
            let rows = (
                ((1.0 - v1.min(1.0)) * h).floor() as usize,
                ((1.0 - v0.max(0.0)) * h).ceil() as usize,
            );
            self.blank(cols, rows);
        }
    }
}

fn decode(doc: &Document, stream: &Stream) -> Option<Samples> {
    let d = &stream.dict;
    let width = int(doc, d, b"Width").filter(|w| (1..=MAX_SIDE).contains(w))? as usize;
    let height = int(doc, d, b"Height").filter(|h| (1..=MAX_SIDE).contains(h))? as usize;
    if (width as u64) * (height as u64) > MAX_PIXELS {
        return None;
    }
    let mask = d
        .get(b"ImageMask")
        .ok()
        .map(|m| resolve(doc, m))
        .and_then(|m| m.as_bool().ok())
        .unwrap_or(false);
    let names = filters(doc, d);
    if names
        .last()
        .is_some_and(|f| f == b"DCTDecode" || f == b"DCT")
    {
        if names.len() != 1 || mask {
            return None;
        }
        let image =
            image::load_from_memory_with_format(&stream.content, image::ImageFormat::Jpeg).ok()?;
        let (comps, rows) = match image.color().channel_count() {
            1 => (1, image.to_luma8().into_raw()),
            _ => (3, image.to_rgb8().into_raw()),
        };
        if image.width() as usize != width || image.height() as usize != height {
            return None;
        }
        return Some(Samples {
            width,
            height,
            comps,
            bits: 8,
            rows,
            from_jpeg: true,
        });
    }
    if names.iter().any(|f| {
        !matches!(
            f.as_slice(),
            b"FlateDecode"
                | b"Fl"
                | b"LZWDecode"
                | b"LZW"
                | b"ASCII85Decode"
                | b"A85"
                | b"ASCIIHexDecode"
                | b"AHx"
                | b"RunLengthDecode"
                | b"RL"
        )
    }) {
        return None;
    }
    let (comps, bits) = if mask {
        (1, 1)
    } else {
        let comps = components(doc, d.get(b"ColorSpace").ok()?, 0)?;
        let bits =
            int(doc, d, b"BitsPerComponent").filter(|b| matches!(b, 1 | 2 | 4 | 8 | 16))? as usize;
        (comps, bits)
    };
    let row_bytes = (width * comps * bits).div_ceil(8);
    let expected = row_bytes.checked_mul(height)?;
    let mut rows = if names.is_empty() {
        stream.content.clone()
    } else {
        stream
            .decompressed_content_with_limit(expected + 1024)
            .ok()?
    };
    // A short stream is drawn padded; a long one, cut.
    rows.resize(expected, 0);
    Some(Samples {
        width,
        height,
        comps,
        bits,
        rows,
        from_jpeg: false,
    })
}

fn deflate(bytes: &[u8]) -> Option<Vec<u8>> {
    let mut e = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    e.write_all(bytes).ok()?;
    e.finish().ok()
}

/// The picture with its samples written back, Flate-compressed.
fn rewritten(original: &Dictionary, samples: &Samples) -> Option<Stream> {
    let mut dict = original.clone();
    for key in [
        b"Filter".as_slice(),
        b"DecodeParms",
        b"Length",
        b"SMask",
        b"Metadata",
    ] {
        dict.remove(key);
    }
    if samples.from_jpeg {
        dict.set("BitsPerComponent", Object::Integer(8));
        dict.set(
            "ColorSpace",
            Object::Name(if samples.comps == 1 {
                b"DeviceGray".to_vec()
            } else {
                b"DeviceRGB".to_vec()
            }),
        );
        dict.remove(b"Decode");
    }
    dict.set("Filter", Object::Name(b"FlateDecode".to_vec()));
    Some(Stream::new(dict, deflate(&samples.rows)?))
}

/// A picture blanked under the marks: the copy, and copies of its soft mask
/// and its stencil mask when it has them (objects of their own, for the
/// walker to add and point the copy at).
pub(super) struct Painted {
    pub image: Stream,
    pub soft_mask: Option<Stream>,
    pub stencil: Option<Stream>,
}

/// A copy of `image` with what the marks cover blanked, and of its masks;
/// `None` when any of them cannot be read.
pub(super) fn paint_image(
    doc: &Document,
    image: &Stream,
    ctm: Matrix,
    marks: &[Rect],
) -> Option<Painted> {
    let mut samples = decode(doc, image)?;
    samples.blank_marks(ctm, marks);
    let mut copy = rewritten(&image.dict, &samples)?;
    copy.dict.remove(b"Mask");
    let soft_mask = match image.dict.get(b"SMask").ok().map(|m| resolve(doc, m)) {
        Some(Object::Stream(soft)) => {
            let mut alpha = decode(doc, soft)?;
            alpha.blank_marks(ctm, marks);
            Some(rewritten(&soft.dict, &alpha)?)
        }
        _ => None,
    };
    // `/Mask` is a stencil (a picture of its own, blanked like the rest) or
    // colour-key ranges, kept as they are.
    let stencil = match image.dict.get(b"Mask").ok() {
        Some(held) => match resolve(doc, held) {
            Object::Stream(stencil) => {
                let mut bits = decode(doc, stencil)?;
                bits.blank_marks(ctm, marks);
                Some(rewritten(&stencil.dict, &bits)?)
            }
            ranges => {
                copy.dict.set("Mask", ranges.clone());
                None
            }
        },
        None => None,
    };
    Some(Painted {
        image: copy,
        soft_mask,
        stencil,
    })
}

/// An inline image (`BI … ID … EI`, `op` with its ranges relative to the
/// stream, `bytes` the operation's own) with what the marks cover blanked,
/// written back unfiltered; `None` when it is filtered or not understood.
pub(super) fn paint_inline(
    bytes: &[u8],
    op: &Op,
    start: usize,
    ctm: Matrix,
    marks: &[Rect],
) -> Option<Vec<u8>> {
    let entries = &op.operands;
    let value = |short: &[u8], long: &[u8]| -> Option<&(Operand, std::ops::Range<usize>)> {
        entries.windows(2).find_map(|w| match &w[0].0 {
            Operand::Name(k) if k == short || k == long => Some(&w[1]),
            _ => None,
        })
    };
    if value(b"F", b"Filter").is_some() || value(b"DP", b"DecodeParms").is_some() {
        return None;
    }
    let number = |short: &[u8], long: &[u8]| match value(short, long) {
        Some((Operand::Number(n), _)) if n.is_finite() && *n >= 1.0 && *n <= MAX_SIDE as f32 => {
            Some(*n as usize)
        }
        _ => None,
    };
    let width = number(b"W", b"Width")?;
    let height = number(b"H", b"Height")?;
    if (width as u64) * (height as u64) > MAX_PIXELS {
        return None;
    }
    let mask = matches!(value(b"IM", b"ImageMask"), Some((Operand::Other, r)) if bytes.get(r.start - start..r.end - start) == Some(b"true".as_slice()));
    let (comps, bits) = if mask {
        (1, 1)
    } else {
        let comps = match value(b"CS", b"ColorSpace")? {
            (Operand::Name(n), _) => match n.as_slice() {
                b"G" | b"DeviceGray" => 1,
                b"RGB" | b"DeviceRGB" => 3,
                b"CMYK" | b"DeviceCMYK" => 4,
                _ => return None,
            },
            _ => return None,
        };
        let bits =
            number(b"BPC", b"BitsPerComponent").filter(|b| matches!(b, 1 | 2 | 4 | 8 | 16))?;
        (comps, bits)
    };
    // The data: one white-space byte after `ID`, then the rows.
    let dict_end = entries.last().map(|(_, r)| r.end - start).unwrap_or(2);
    let id_at = dict_end + bytes.get(dict_end..)?.windows(2).position(|w| w == b"ID")?;
    let data_start = id_at + 3;
    let row_bytes = (width * comps * bits).div_ceil(8);
    let expected = row_bytes.checked_mul(height)?;
    let mut rows = bytes.get(data_start..)?.to_vec();
    rows.truncate(expected);
    rows.resize(expected, 0);
    let mut samples = Samples {
        width,
        height,
        comps,
        bits,
        rows,
        from_jpeg: false,
    };
    samples.blank_marks(ctm, marks);
    let mut out = bytes[..id_at].to_vec();
    out.extend_from_slice(b"ID ");
    out.extend_from_slice(&samples.rows);
    out.extend_from_slice(b"\nEI");
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::dictionary;

    fn gray(width: i64, height: i64, value: u8) -> Stream {
        Stream::new(
            dictionary! { "Type" => "XObject", "Subtype" => "Image", "Width" => width, "Height" => height,
            "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8 },
            vec![value; (width * height) as usize],
        )
    }

    #[test]
    fn the_pixels_under_a_mark_are_zero_and_the_rest_as_they_were() {
        let doc = Document::with_version("1.7");
        // 10 × 10 pixels drawn over (100, 100)–(200, 200).
        let ctm = Matrix([100.0, 0.0, 0.0, 100.0, 100.0, 100.0]);
        // The mark covers the picture's top-left quarter.
        let painted = paint_image(
            &doc,
            &gray(10, 10, 200),
            ctm,
            &[[100.0, 150.0, 150.0, 200.0]],
        )
        .unwrap();
        assert!(painted.soft_mask.is_none());
        let rows = painted.image.decompressed_content().unwrap();
        for r in 0..10 {
            for c in 0..10 {
                let want = if r < 5 && c < 5 { 0 } else { 200 };
                assert_eq!(rows[r * 10 + c], want, "row {r} column {c}");
            }
        }
    }

    #[test]
    fn one_bit_pixels_are_cleared_bit_by_bit() {
        let doc = Document::with_version("1.7");
        let image = Stream::new(
            dictionary! { "Subtype" => "Image", "Width" => 16, "Height" => 1, "ImageMask" => true },
            vec![0xFF, 0xFF],
        );
        let ctm = Matrix([16.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
        let painted = paint_image(&doc, &image, ctm, &[[4.0, 0.0, 8.0, 1.0]]).unwrap();
        assert_eq!(
            painted.image.decompressed_content().unwrap(),
            vec![0xF0, 0xFF]
        );
    }

    #[test]
    fn a_soft_mask_is_blanked_too_and_an_unreadable_picture_is_refused() {
        let mut doc = Document::with_version("1.7");
        let alpha = doc.add_object(gray(4, 4, 255));
        let mut picture = gray(4, 4, 9);
        picture.dict.set("SMask", Object::Reference(alpha));
        let ctm = Matrix([4.0, 0.0, 0.0, 4.0, 0.0, 0.0]);
        let painted = paint_image(&doc, &picture, ctm, &[[0.0, 0.0, 4.0, 4.0]]).unwrap();
        assert!(painted
            .soft_mask
            .unwrap()
            .decompressed_content()
            .unwrap()
            .iter()
            .all(|a| *a == 0));
        let mut jbig2 = gray(4, 4, 9);
        jbig2
            .dict
            .set("Filter", Object::Name(b"JBIG2Decode".to_vec()));
        assert!(paint_image(&doc, &jbig2, ctm, &[[0.0, 0.0, 4.0, 4.0]]).is_none());
    }
}
