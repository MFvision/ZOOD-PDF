//! Pictures for PDF image XObjects: JPEG (DCTDecode pass-through after a header check), PNG
//! (decoded with the `png` crate, re-compressed with Flate, alpha as `/SMask`) and TIFF (own
//! bounded reader in [`crate::readers::tiff`]; CCITT G3/G4 strips are passed through as
//! `CCITTFaxDecode`). Dimensions are checked before any pixel buffer is allocated.

use std::io::Write;

use crate::error::{CreateError, Result};
use crate::limits;

/// Colour space of the samples.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColorSpace {
    Gray,
    Rgb,
    Cmyk,
}

impl ColorSpace {
    pub fn components(self) -> usize {
        match self {
            ColorSpace::Gray => 1,
            ColorSpace::Rgb => 3,
            ColorSpace::Cmyk => 4,
        }
    }

    pub fn pdf_name(self) -> &'static str {
        match self {
            ColorSpace::Gray => "DeviceGray",
            ColorSpace::Rgb => "DeviceRGB",
            ColorSpace::Cmyk => "DeviceCMYK",
        }
    }
}

/// How the image bytes are stored in the PDF.
#[derive(Debug, Clone, PartialEq)]
pub enum Encoding {
    /// A complete JPEG file (`/DCTDecode`).
    Dct,
    /// zlib-compressed samples (`/FlateDecode`).
    Flate,
    /// CCITT fax data (`/CCITTFaxDecode`); `k` as in the PDF DecodeParms.
    Ccitt {
        k: i32,
        black_is_1: bool,
        byte_align: bool,
    },
}

/// A picture ready to be written as an image XObject.
#[derive(Debug, Clone, PartialEq)]
pub struct ImageData {
    pub width: u32,
    pub height: u32,
    pub color: ColorSpace,
    pub bits: u8,
    pub encoding: Encoding,
    /// Encoded bytes (see [`Encoding`]).
    pub data: Vec<u8>,
    /// 8-bit gray alpha channel, Flate-compressed.
    pub alpha: Option<Vec<u8>>,
    /// Adobe CMYK JPEGs store inverted samples (`/Decode [1 0 1 0 1 0 1 0]`).
    pub invert: bool,
    /// Resolution in dots per inch, when the file says.
    pub dpi: Option<(f64, f64)>,
}

impl ImageData {
    /// Natural size in points at the file's resolution (96 dpi when unknown).
    pub fn natural_size(&self) -> (f64, f64) {
        let (dx, dy) = self
            .dpi
            .filter(|(x, y)| *x >= 10.0 && *y >= 10.0 && *x <= 10_000.0 && *y <= 10_000.0)
            .unwrap_or((96.0, 96.0));
        (
            f64::from(self.width) * 72.0 / dx,
            f64::from(self.height) * 72.0 / dy,
        )
    }

    /// Raw samples → Flate image (samples must be `width*height*components` bytes at 8 bits,
    /// or packed rows at 1 bit).
    pub fn from_samples(
        width: u32,
        height: u32,
        color: ColorSpace,
        bits: u8,
        samples: &[u8],
        alpha: Option<&[u8]>,
        dpi: Option<(f64, f64)>,
    ) -> Result<ImageData> {
        let alpha = match alpha {
            Some(a) if a.iter().any(|&v| v != 255) => Some(zlib(a)?),
            _ => None,
        };
        Ok(ImageData {
            width,
            height,
            color,
            bits,
            encoding: Encoding::Flate,
            data: zlib(samples)?,
            alpha,
            invert: false,
            dpi,
        })
    }
}

/// zlib-compress with flate2 (pure Rust backend).
pub fn zlib(data: &[u8]) -> Result<Vec<u8>> {
    let mut e = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    e.write_all(data)
        .map_err(|e| CreateError::Pdf(format!("deflate: {e}")))?;
    e.finish()
        .map_err(|e| CreateError::Pdf(format!("deflate: {e}")))
}

/// Which picture format `bytes` is.
pub fn sniff(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("jpeg")
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if bytes.starts_with(b"II*\0") || bytes.starts_with(b"MM\0*") {
        Some("tiff")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("webp")
    } else if bytes.starts_with(b"GIF8") {
        Some("gif")
    } else {
        None
    }
}

fn be16(b: &[u8], i: usize) -> Option<u16> {
    Some(u16::from_be_bytes([*b.get(i)?, *b.get(i + 1)?]))
}

/// Check a JPEG's frame header and keep the file as-is for `/DCTDecode`.
pub fn jpeg(bytes: &[u8]) -> Result<ImageData> {
    if !bytes.starts_with(&[0xFF, 0xD8]) {
        return Err(CreateError::malformed("not a JPEG file"));
    }
    let mut i = 2usize;
    let mut dpi = None;
    let mut adobe = false;
    // Bounded: every step advances by at least 2 bytes.
    while i + 4 <= bytes.len() {
        if bytes.get(i) != Some(&0xFF) {
            return Err(CreateError::malformed("JPEG marker expected"));
        }
        let marker = *bytes.get(i + 1).ok_or_else(|| CreateError::malformed("JPEG"))?;
        if marker == 0xFF {
            i += 1;
            continue;
        }
        if marker == 0xD8 || (0xD0..=0xD7).contains(&marker) || marker == 0x01 {
            i += 2;
            continue;
        }
        let len = usize::from(be16(bytes, i + 2).ok_or_else(|| CreateError::malformed("JPEG"))?);
        if len < 2 {
            return Err(CreateError::malformed("JPEG segment length"));
        }
        let seg = bytes
            .get(i + 4..i + 2 + len)
            .ok_or_else(|| CreateError::malformed("truncated JPEG segment"))?;
        match marker {
            0xE0 if seg.starts_with(b"JFIF\0") => {
                let unit = seg.get(7).copied().unwrap_or(0);
                let x = f64::from(be16(seg, 8).unwrap_or(0));
                let y = f64::from(be16(seg, 10).unwrap_or(0));
                if x > 0.0 && y > 0.0 {
                    dpi = match unit {
                        1 => Some((x, y)),
                        2 => Some((x * 2.54, y * 2.54)),
                        _ => None,
                    };
                }
            }
            0xEE if seg.starts_with(b"Adobe") => adobe = true,
            0xC0..=0xCF if marker != 0xC4 && marker != 0xC8 && marker != 0xCC => {
                if marker >= 0xC9 {
                    return Err(CreateError::Unsupported(
                        "arithmetic-coded JPEG".into(),
                    ));
                }
                let precision = seg.first().copied().unwrap_or(0);
                if precision != 8 {
                    return Err(CreateError::Unsupported(format!(
                        "{precision}-bit JPEG"
                    )));
                }
                let h = u32::from(be16(seg, 1).unwrap_or(0));
                let w = u32::from(be16(seg, 3).unwrap_or(0));
                let comps = seg.get(5).copied().unwrap_or(0);
                limits::check_image(w, h)?;
                let color = match comps {
                    1 => ColorSpace::Gray,
                    3 => ColorSpace::Rgb,
                    4 => ColorSpace::Cmyk,
                    n => return Err(CreateError::Unsupported(format!("JPEG with {n} components"))),
                };
                return Ok(ImageData {
                    width: w,
                    height: h,
                    color,
                    bits: 8,
                    encoding: Encoding::Dct,
                    data: bytes.to_vec(),
                    alpha: None,
                    invert: color == ColorSpace::Cmyk && adobe,
                    dpi,
                });
            }
            0xDA | 0xD9 => break,
            _ => {}
        }
        i += 2 + len;
    }
    Err(CreateError::malformed("JPEG has no frame header"))
}

/// Decode a PNG (any colour type/bit depth) to 8-bit samples + optional alpha.
pub fn png(bytes: &[u8]) -> Result<ImageData> {
    let mut dec = png::Decoder::new_with_limits(
        std::io::Cursor::new(bytes),
        png::Limits {
            bytes: (limits::MAX_IMAGE_PIXELS as usize).saturating_mul(4),
        },
    );
    dec.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = dec
        .read_info()
        .map_err(|e| CreateError::malformed(format!("PNG: {e}")))?;
    let (w, h, dpi) = {
        let info = reader.info();
        let dpi = info.pixel_dims.and_then(|d| match d.unit {
            png::Unit::Meter => Some((
                f64::from(d.xppu) * 0.0254,
                f64::from(d.yppu) * 0.0254,
            )),
            png::Unit::Unspecified => None,
        });
        (info.width, info.height, dpi)
    };
    limits::check_image(w, h)?;
    let size = reader
        .output_buffer_size()
        .ok_or_else(|| CreateError::limit("PNG output buffer size"))?;
    let mut buf = vec![0u8; size];
    let out = reader
        .next_frame(&mut buf)
        .map_err(|e| CreateError::malformed(format!("PNG: {e}")))?;
    let px = (w as usize).saturating_mul(h as usize);
    let data = buf
        .get(..out.buffer_size())
        .ok_or_else(|| CreateError::malformed("PNG frame"))?;
    use png::ColorType as C;
    let (color, comps, has_alpha) = match out.color_type {
        C::Grayscale => (ColorSpace::Gray, 1, false),
        C::GrayscaleAlpha => (ColorSpace::Gray, 2, true),
        C::Rgb => (ColorSpace::Rgb, 3, false),
        C::Rgba => (ColorSpace::Rgb, 4, true),
        C::Indexed => return Err(CreateError::malformed("PNG palette was not expanded")),
    };
    if data.len() < px.saturating_mul(comps) {
        return Err(CreateError::malformed("PNG data is short"));
    }
    if !has_alpha {
        return ImageData::from_samples(w, h, color, 8, data, None, dpi);
    }
    let cc = comps - 1;
    let mut samples = Vec::with_capacity(px * cc);
    let mut alpha = Vec::with_capacity(px);
    for p in data.chunks_exact(comps).take(px) {
        samples.extend_from_slice(p.get(..cc).unwrap_or(&[]));
        alpha.push(p.get(cc).copied().unwrap_or(255));
    }
    ImageData::from_samples(w, h, color, 8, &samples, Some(&alpha), dpi)
}

/// Decode a single picture file (JPEG or PNG). TIFF goes through [`crate::readers::tiff`].
pub fn decode(bytes: &[u8]) -> Result<ImageData> {
    match sniff(bytes) {
        Some("jpeg") => jpeg(bytes),
        Some("png") => png(bytes),
        Some("tiff") => crate::readers::tiff::read(bytes)?
            .into_iter()
            .next()
            .and_then(|p| p.bands.into_iter().next().map(|b| b.image))
            .ok_or_else(|| CreateError::malformed("TIFF has no pages")),
        Some(other) => Err(CreateError::Unsupported(format!("{other} pictures"))),
        None => Err(CreateError::Unsupported("unknown picture format".into())),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    #[test]
    fn jpeg_header_bombs_and_garbage_are_errors() {
        assert!(jpeg(b"\xFF\xD8").is_err());
        assert!(jpeg(b"not a jpeg").is_err());
        // SOF0 claiming 65535×65535.
        let mut j = vec![0xFF, 0xD8, 0xFF, 0xC0, 0, 11, 8, 0xFF, 0xFF, 0xFF, 0xFF, 3, 1, 0x11, 0];
        j.extend_from_slice(&[0xFF, 0xD9]);
        assert_eq!(jpeg(&j).unwrap_err().code(), "limit_exceeded");
        // A sane header is accepted and keeps the bytes.
        let j = [
            0xFF, 0xD8, 0xFF, 0xE0, 0, 16, b'J', b'F', b'I', b'F', 0, 1, 1, 1, 0, 150, 0, 150, 0,
            0, 0xFF, 0xC0, 0, 11, 8, 0, 20, 0, 30, 1, 1, 0x11, 0, 0xFF, 0xD9,
        ];
        let im = jpeg(&j).unwrap();
        assert_eq!((im.width, im.height, im.color), (30, 20, ColorSpace::Gray));
        assert_eq!(im.dpi, Some((150.0, 150.0)));
        assert_eq!(im.natural_size(), (14.4, 9.6));
    }

    #[test]
    fn png_round_trip_with_alpha() {
        let mut out = Vec::new();
        {
            let mut enc = png::Encoder::new(&mut out, 2, 1);
            enc.set_color(png::ColorType::Rgba);
            enc.set_depth(png::BitDepth::Eight);
            let mut w = enc.write_header().unwrap();
            w.write_image_data(&[255, 0, 0, 255, 0, 0, 255, 128]).unwrap();
        }
        let im = png(&out).unwrap();
        assert_eq!((im.width, im.height, im.color), (2, 1, ColorSpace::Rgb));
        assert!(im.alpha.is_some());
        assert!(png(&out[..20]).is_err());
    }
}
