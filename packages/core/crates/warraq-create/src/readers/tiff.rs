//! Own bounded TIFF reader (baseline + LZW/Deflate/PackBits + CCITT pass-through), multi-page.
//!
//! * Every IFD offset is visited once (cycles end the chain); at most
//!   [`limits::MAX_TIFF_PAGES`] pages; dimensions are checked before decoding.
//! * CCITT Group 4 / Group 3 / Modified Huffman strips are **not decoded**: each strip becomes an
//!   image XObject with `/CCITTFaxDecode` (bits reversed first when `FillOrder` is 2).
//! * Uncompressed, LZW (`weezl`), Deflate and PackBits strips are decoded (with the predictor)
//!   and written as Flate images: bilevel, 8-bit gray, RGB (alpha → SMask), palette → RGB.
//! * Tiled, planar, 16-bit, CMYK and JPEG-in-TIFF files are refused with `unsupported_format`.

use crate::error::{CreateError, Result};
use crate::image::{ColorSpace, Encoding, ImageData};
use crate::limits;

/// One strip group drawn as one image (CCITT strips are separate bands).
#[derive(Debug, Clone, PartialEq)]
pub struct Band {
    pub image: ImageData,
    /// First pixel row of the band.
    pub row: u32,
}

/// One TIFF page.
#[derive(Debug, Clone, PartialEq)]
pub struct TiffPage {
    pub width: u32,
    pub height: u32,
    pub dpi: Option<(f64, f64)>,
    pub bands: Vec<Band>,
}

impl TiffPage {
    /// Page size in points at the file's resolution (72 dpi when unknown, like fax viewers do
    /// not: fax files always carry a resolution).
    pub fn size_pt(&self) -> (f64, f64) {
        let (dx, dy) = self
            .dpi
            .filter(|(x, y)| *x >= 10.0 && *y >= 10.0 && *x <= 10_000.0 && *y <= 10_000.0)
            .unwrap_or((72.0, 72.0));
        (
            f64::from(self.width) * 72.0 / dx,
            f64::from(self.height) * 72.0 / dy,
        )
    }
}

struct Rd<'a> {
    b: &'a [u8],
    le: bool,
}

impl Rd<'_> {
    fn u16(&self, at: usize) -> Result<u16> {
        let s = self
            .b
            .get(at..at + 2)
            .ok_or_else(|| CreateError::malformed("TIFF: offset out of range"))?;
        let a = [
            s.first().copied().unwrap_or(0),
            s.get(1).copied().unwrap_or(0),
        ];
        Ok(if self.le {
            u16::from_le_bytes(a)
        } else {
            u16::from_be_bytes(a)
        })
    }
    fn u32(&self, at: usize) -> Result<u32> {
        let s = self
            .b
            .get(at..at + 4)
            .ok_or_else(|| CreateError::malformed("TIFF: offset out of range"))?;
        let mut a = [0u8; 4];
        a.copy_from_slice(s);
        Ok(if self.le {
            u32::from_le_bytes(a)
        } else {
            u32::from_be_bytes(a)
        })
    }
}

#[derive(Default)]
struct Ifd {
    width: u32,
    height: u32,
    bits: Vec<u32>,
    compression: u32,
    photometric: u32,
    strip_offsets: Vec<u32>,
    strip_counts: Vec<u32>,
    spp: u32,
    rows_per_strip: u32,
    xres: Option<f64>,
    yres: Option<f64>,
    res_unit: u32,
    planar: u32,
    predictor: u32,
    colormap: Vec<u32>,
    t4: u32,
    fill_order: u32,
    tiled: bool,
}

const MAX_ENTRIES: usize = 4096;
const MAX_VALUES: usize = 1 << 20;

fn values(r: &Rd, typ: u16, count: u32, field: usize) -> Result<Vec<u32>> {
    let n = count as usize;
    if n > MAX_VALUES {
        return Err(CreateError::limit("TIFF tag has too many values"));
    }
    let size = match typ {
        1 | 2 | 6 | 7 => 1,
        3 | 8 => 2,
        4 | 9 => 4,
        _ => return Ok(Vec::new()),
    };
    let total = n.saturating_mul(size);
    let base = if total <= 4 {
        field
    } else {
        r.u32(field)? as usize
    };
    if base.saturating_add(total) > r.b.len() {
        return Err(CreateError::malformed("TIFF: tag data out of range"));
    }
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let at = base + i * size;
        out.push(match size {
            1 => u32::from(r.b.get(at).copied().unwrap_or(0)),
            2 => u32::from(r.u16(at)?),
            _ => r.u32(at)?,
        });
    }
    Ok(out)
}

fn rational(r: &Rd, typ: u16, field: usize) -> Option<f64> {
    if typ != 5 {
        return None;
    }
    let at = r.u32(field).ok()? as usize;
    let n = f64::from(r.u32(at).ok()?);
    let d = f64::from(r.u32(at + 4).ok()?);
    (d > 0.0).then_some(n / d)
}

fn parse_ifd(r: &Rd, off: usize) -> Result<(Ifd, usize)> {
    let count = usize::from(r.u16(off)?);
    if count > MAX_ENTRIES {
        return Err(CreateError::limit("TIFF directory is too large"));
    }
    let mut d = Ifd {
        spp: 1,
        planar: 1,
        predictor: 1,
        fill_order: 1,
        res_unit: 2,
        compression: 1,
        rows_per_strip: u32::MAX,
        ..Ifd::default()
    };
    for i in 0..count {
        let e = off + 2 + i * 12;
        let tag = r.u16(e)?;
        let typ = r.u16(e + 2)?;
        let cnt = r.u32(e + 4)?;
        let field = e + 8;
        let first = || -> Result<u32> {
            Ok(values(r, typ, cnt.min(1), field)?
                .first()
                .copied()
                .unwrap_or(0))
        };
        match tag {
            256 => d.width = first()?,
            257 => d.height = first()?,
            258 => d.bits = values(r, typ, cnt.min(16), field)?,
            259 => d.compression = first()?,
            262 => d.photometric = first()?,
            266 => d.fill_order = first()?,
            273 => d.strip_offsets = values(r, typ, cnt, field)?,
            277 => d.spp = first()?,
            278 => d.rows_per_strip = first()?,
            279 => d.strip_counts = values(r, typ, cnt, field)?,
            282 => d.xres = rational(r, typ, field),
            283 => d.yres = rational(r, typ, field),
            284 => d.planar = first()?,
            292 => d.t4 = first()?,
            296 => d.res_unit = first()?,
            317 => d.predictor = first()?,
            320 => d.colormap = values(r, typ, cnt.min(3 * 65536), field)?,
            322..=325 => d.tiled = true,
            _ => {}
        }
    }
    let next = r.u32(off + 2 + count * 12).unwrap_or(0) as usize;
    Ok((d, next))
}

/// Read every page of a TIFF file.
pub fn read(bytes: &[u8]) -> Result<Vec<TiffPage>> {
    let le = match bytes.get(..4) {
        Some(b"II*\0") => true,
        Some(b"MM\0*") => false,
        Some([b'I', b'I', 43, 0]) | Some([b'M', b'M', 0, 43]) => {
            return Err(CreateError::Unsupported("BigTIFF".into()))
        }
        _ => return Err(CreateError::malformed("not a TIFF file")),
    };
    let r = Rd { b: bytes, le };
    let mut off = r.u32(4)? as usize;
    let mut seen = std::collections::HashSet::new();
    let mut pages = Vec::new();
    while off != 0 {
        if !seen.insert(off) {
            break; // cycle
        }
        limits::check(pages.len() + 1, limits::MAX_TIFF_PAGES, "TIFF pages")?;
        let (ifd, next) = parse_ifd(&r, off)?;
        pages.push(page(bytes, &ifd)?);
        off = next;
    }
    if pages.is_empty() {
        return Err(CreateError::malformed("TIFF has no pages"));
    }
    Ok(pages)
}

fn strip<'a>(bytes: &'a [u8], ifd: &Ifd, i: usize) -> Result<&'a [u8]> {
    let o = *ifd
        .strip_offsets
        .get(i)
        .ok_or_else(|| CreateError::malformed("TIFF: missing strip offset"))? as usize;
    let n = *ifd
        .strip_counts
        .get(i)
        .ok_or_else(|| CreateError::malformed("TIFF: missing strip byte count"))?
        as usize;
    bytes
        .get(o..o.saturating_add(n))
        .ok_or_else(|| CreateError::malformed("TIFF: strip out of range"))
}

fn packbits(src: &[u8], cap: usize) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < src.len() {
        let n = src.get(i).copied().unwrap_or(0) as i8;
        i += 1;
        if n >= 0 {
            let k = n as usize + 1;
            out.extend_from_slice(src.get(i..i + k).unwrap_or(&[]));
            i += k;
        } else if n != -128 {
            let k = (1 - i32::from(n)) as usize;
            let b = src.get(i).copied().unwrap_or(0);
            out.extend(std::iter::repeat_n(b, k));
            i += 1;
        }
        if out.len() > cap {
            return Err(CreateError::limit("TIFF PackBits strip inflates too much"));
        }
    }
    Ok(out)
}

fn decode_strip(data: &[u8], compression: u32, cap: usize) -> Result<Vec<u8>> {
    let mut out = match compression {
        1 => data.to_vec(),
        5 => {
            let mut dec = weezl::decode::Decoder::with_tiff_size_switch(weezl::BitOrder::Msb, 8);
            let mut out = Vec::new();
            let res = dec.into_vec(&mut out).decode(data);
            if out.len() > cap {
                return Err(CreateError::limit("TIFF LZW strip inflates too much"));
            }
            if let Err(e) = res.status {
                if out.is_empty() {
                    return Err(CreateError::malformed(format!("TIFF LZW: {e}")));
                }
            }
            out
        }
        8 | 32946 => miniz_oxide::inflate::decompress_to_vec_zlib_with_limit(data, cap)
            .map_err(|_| CreateError::malformed("TIFF Deflate strip is damaged or too large"))?,
        32773 => packbits(data, cap)?,
        6 | 7 => return Err(CreateError::Unsupported("JPEG-compressed TIFF".into())),
        c => return Err(CreateError::Unsupported(format!("TIFF compression {c}"))),
    };
    out.truncate(cap);
    Ok(out)
}

fn page(bytes: &[u8], ifd: &Ifd) -> Result<TiffPage> {
    limits::check_image(ifd.width, ifd.height)?;
    if ifd.tiled {
        return Err(CreateError::Unsupported("tiled TIFF".into()));
    }
    if ifd.planar != 1 && ifd.spp > 1 {
        return Err(CreateError::Unsupported("planar TIFF".into()));
    }
    if ifd.strip_offsets.is_empty() || ifd.strip_offsets.len() != ifd.strip_counts.len() {
        return Err(CreateError::malformed("TIFF strip tables"));
    }
    let dpi = match (ifd.xres, ifd.yres, ifd.res_unit) {
        (Some(x), Some(y), 2) => Some((x, y)),
        (Some(x), Some(y), 3) => Some((x * 2.54, y * 2.54)),
        (Some(x), None, 2) => Some((x, x)),
        _ => None,
    };
    let (w, h) = (ifd.width, ifd.height);
    let rps = ifd.rows_per_strip.clamp(1, h);
    let bits = ifd.bits.first().copied().unwrap_or(1);
    let mut bands = Vec::new();
    // CCITT: pass each strip through.
    if matches!(ifd.compression, 2..=4) {
        if bits != 1 || ifd.spp != 1 {
            return Err(CreateError::malformed("CCITT TIFF must be bilevel"));
        }
        let (k, byte_align) = match ifd.compression {
            2 => (0, true),
            3 => (if ifd.t4 & 1 == 1 { 1 } else { 0 }, false),
            _ => (-1, false),
        };
        for i in 0..ifd.strip_offsets.len() {
            let row = (i as u32).saturating_mul(rps);
            if row >= h {
                break;
            }
            let rows = rps.min(h - row);
            let mut data = strip(bytes, ifd, i)?.to_vec();
            if ifd.fill_order == 2 {
                for b in &mut data {
                    *b = b.reverse_bits();
                }
            }
            // CCITT codes white/black runs; decoded 0 is black unless BlackIs1. A
            // BlackIsZero page therefore needs BlackIs1 to invert.
            bands.push(Band {
                image: ImageData {
                    width: w,
                    height: rows,
                    color: ColorSpace::Gray,
                    bits: 1,
                    encoding: Encoding::Ccitt {
                        k,
                        black_is_1: ifd.photometric == 1,
                        byte_align,
                    },
                    data,
                    alpha: None,
                    invert: false,
                    dpi,
                },
                row,
            });
        }
        return Ok(TiffPage {
            width: w,
            height: h,
            dpi,
            bands,
        });
    }
    // Decoded pixel formats.
    let spp = ifd.spp.max(1) as usize;
    let (bpp_bits, kind) = match (ifd.photometric, bits, spp) {
        (0 | 1, 1, 1) => (1usize, "bilevel"),
        (0 | 1, 8, 1) => (8, "gray"),
        (0 | 1, 8, 2) => (16, "gray+alpha"),
        (2, 8, 3) => (24, "rgb"),
        (2, 8, 4) => (32, "rgba"),
        (3, 8, 1) => (8, "palette"),
        (3, 4, 1) => (4, "palette4"),
        (p, b, s) => {
            return Err(CreateError::Unsupported(format!(
                "TIFF photometric {p} with {s}×{b}-bit samples"
            )))
        }
    };
    let row_bytes = (w as usize * bpp_bits).div_ceil(8);
    let total = row_bytes
        .checked_mul(h as usize)
        .ok_or_else(|| CreateError::limit("TIFF size"))?;
    let mut raw = Vec::with_capacity(total.min(64 << 20));
    for i in 0..ifd.strip_offsets.len() {
        if raw.len() >= total {
            break;
        }
        let row = (i as u32).saturating_mul(rps);
        if row >= h {
            break;
        }
        let rows = rps.min(h - row) as usize;
        let want = row_bytes * rows;
        let mut s = decode_strip(strip(bytes, ifd, i)?, ifd.compression, want)?;
        s.resize(want, 0);
        if ifd.predictor == 2 && bpp_bits >= 8 {
            let step = bpp_bits / 8;
            for r in s.chunks_exact_mut(row_bytes) {
                for x in step..r.len() {
                    let prev = r.get(x - step).copied().unwrap_or(0);
                    if let Some(v) = r.get_mut(x) {
                        *v = v.wrapping_add(prev);
                    }
                }
            }
        }
        raw.extend_from_slice(&s);
    }
    raw.resize(total, 0);
    let px = w as usize * h as usize;
    let image = match kind {
        "bilevel" => {
            if ifd.photometric == 0 {
                for b in &mut raw {
                    *b = !*b;
                }
            }
            ImageData::from_samples(w, h, ColorSpace::Gray, 1, &raw, None, dpi)?
        }
        "gray" => {
            if ifd.photometric == 0 {
                for b in &mut raw {
                    *b = 255 - *b;
                }
            }
            ImageData::from_samples(w, h, ColorSpace::Gray, 8, &raw, None, dpi)?
        }
        "gray+alpha" | "rgba" => {
            let cc = spp - 1;
            let mut c = Vec::with_capacity(px * cc);
            let mut a = Vec::with_capacity(px);
            for p in raw.chunks_exact(spp) {
                c.extend_from_slice(p.get(..cc).unwrap_or(&[]));
                a.push(p.get(cc).copied().unwrap_or(255));
            }
            let cs = if cc == 1 {
                ColorSpace::Gray
            } else {
                ColorSpace::Rgb
            };
            // Opaque alpha channels are dropped by from_samples.
            ImageData::from_samples(w, h, cs, 8, &c, Some(&a), dpi)?
        }
        "rgb" => ImageData::from_samples(w, h, ColorSpace::Rgb, 8, &raw, None, dpi)?,
        _ => {
            // Palette (8- or 4-bit) → RGB.
            let n = if kind == "palette" { 256 } else { 16 };
            if ifd.colormap.len() < 3 * n {
                return Err(CreateError::malformed("TIFF palette is missing"));
            }
            let map = |i: usize, ch: usize| -> u8 {
                (ifd.colormap.get(ch * n + i).copied().unwrap_or(0) >> 8) as u8
            };
            let mut rgb = Vec::with_capacity(px * 3);
            for y in 0..h as usize {
                let rowd = raw.get(y * row_bytes..(y + 1) * row_bytes).unwrap_or(&[]);
                for x in 0..w as usize {
                    let idx = if kind == "palette" {
                        usize::from(rowd.get(x).copied().unwrap_or(0))
                    } else {
                        let b = rowd.get(x / 2).copied().unwrap_or(0);
                        usize::from(if x % 2 == 0 { b >> 4 } else { b & 15 })
                    };
                    rgb.extend_from_slice(&[map(idx, 0), map(idx, 1), map(idx, 2)]);
                }
            }
            ImageData::from_samples(w, h, ColorSpace::Rgb, 8, &rgb, None, dpi)?
        }
    };
    bands.push(Band { image, row: 0 });
    Ok(TiffPage {
        width: w,
        height: h,
        dpi,
        bands,
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    /// Minimal little-endian TIFF: 2×2 8-bit gray, uncompressed, one strip, 2 pages chained.
    fn tiny(pages: usize, cycle: bool) -> Vec<u8> {
        let mut b = b"II*\0".to_vec();
        b.extend_from_slice(&8u32.to_le_bytes());
        let mut ifd_offsets = Vec::new();
        for p in 0..pages {
            let ifd_at = b.len();
            ifd_offsets.push(ifd_at);
            let entries: Vec<(u16, u16, u32, u32)> = vec![
                (256, 3, 1, 2),
                (257, 3, 1, 2),
                (258, 3, 1, 8),
                (259, 3, 1, 1),
                (262, 3, 1, 1),
                (273, 4, 1, 0), // patched
                (277, 3, 1, 1),
                (278, 3, 1, 2),
                (279, 4, 1, 4),
            ];
            b.extend_from_slice(&(entries.len() as u16).to_le_bytes());
            let data_at = ifd_at + 2 + entries.len() * 12 + 4;
            for (t, ty, c, v) in &entries {
                b.extend_from_slice(&t.to_le_bytes());
                b.extend_from_slice(&ty.to_le_bytes());
                b.extend_from_slice(&c.to_le_bytes());
                let v = if *t == 273 { data_at as u32 } else { *v };
                if *ty == 3 {
                    b.extend_from_slice(&(v as u16).to_le_bytes());
                    b.extend_from_slice(&[0, 0]);
                } else {
                    b.extend_from_slice(&v.to_le_bytes());
                }
            }
            let next = if p + 1 < pages {
                data_at + 4
            } else if cycle {
                8
            } else {
                0
            };
            b.extend_from_slice(&(next as u32).to_le_bytes());
            b.extend_from_slice(&[0, 255, 255, 0]);
        }
        b
    }

    #[test]
    fn multi_page_and_cycles() {
        assert_eq!(read(&tiny(3, false)).unwrap().len(), 3);
        // A cycle back to the first IFD ends the chain instead of looping.
        assert_eq!(read(&tiny(2, true)).unwrap().len(), 2);
        assert!(read(b"II*\0\xff\xff\xff\xff").is_err());
        assert!(read(b"nope").is_err());
        let mut t = tiny(1, false);
        let n = t.len();
        t.truncate(n - 3);
        assert!(read(&t).is_err());
    }

    #[test]
    fn packbits_is_bounded() {
        assert_eq!(
            packbits(&[2, 1, 2, 3, 0xFE, 9], 100).unwrap(),
            vec![1, 2, 3, 9, 9, 9]
        );
        assert!(packbits(&[0x81, 1].repeat(100), 50).is_err());
    }
}
