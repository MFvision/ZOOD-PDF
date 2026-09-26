//! Pictures: JPEG/PNG → PDF image XObjects (Insert picture) and the raster helpers Compress
//! uses (decode, box-filter downsample, JPEG/Flate encode). Every decode is bounded by
//! [`MAX_PIXELS`] and never panics on hostile bytes.

use crate::CoreError;
use std::io::{Cursor, Write};
use warraq_pdf::lopdf::{Dictionary, Object, Stream};

/// Largest picture accepted (pixels): 100 megapixels.
pub const MAX_PIXELS: u64 = 100_000_000;
/// Largest side accepted (JPEG's own limit).
pub const MAX_SIDE: u32 = 65_535;
/// Largest picture file accepted (bytes).
pub const MAX_FILE: usize = 128 << 20;

fn invalid(msg: impl Into<String>) -> CoreError {
    CoreError::new("invalid_image", msg)
}

/// Picture formats we embed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Jpeg,
    Png,
}

/// Detect the format from the magic bytes.
pub fn sniff(b: &[u8]) -> Option<Kind> {
    if b.starts_with(&[0xff, 0xd8, 0xff]) {
        Some(Kind::Jpeg)
    } else if b.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(Kind::Png)
    } else {
        None
    }
}

/// What a JPEG header says.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JpegInfo {
    pub width: u32,
    pub height: u32,
    pub components: u8,
    pub precision: u8,
    /// An Adobe APP14 marker is present (CMYK data is then stored inverted).
    pub adobe: bool,
}

fn check_dims(w: u32, h: u32) -> Result<(), CoreError> {
    if w == 0 || h == 0 || w > MAX_SIDE || h > MAX_SIDE {
        return Err(invalid(format!("picture size {w}×{h} is not supported")));
    }
    if u64::from(w) * u64::from(h) > MAX_PIXELS {
        return Err(CoreError::new(
            "limit_exceeded",
            format!("picture has more than {MAX_PIXELS} pixels"),
        ));
    }
    Ok(())
}

/// Read the frame header of a JPEG (bounded marker walk; no pixel decoding).
pub fn jpeg_info(b: &[u8]) -> Result<JpegInfo, CoreError> {
    if !b.starts_with(&[0xff, 0xd8]) {
        return Err(invalid("not a JPEG"));
    }
    let mut pos = 2usize;
    let mut adobe = false;
    // Each iteration advances by at least 2 bytes: bounded by the input length.
    while pos + 4 <= b.len() {
        if b.get(pos) != Some(&0xff) {
            return Err(invalid("broken JPEG marker"));
        }
        let marker = *b.get(pos + 1).ok_or_else(|| invalid("truncated JPEG"))?;
        if marker == 0xff {
            pos += 1; // fill byte
            continue;
        }
        if marker == 0xd8 || (0xd0..=0xd7).contains(&marker) || marker == 0x01 {
            pos += 2;
            continue;
        }
        if marker == 0xd9 || marker == 0xda {
            break; // EOI / start of scan before any frame header
        }
        let len = usize::from(u16::from_be_bytes([
            *b.get(pos + 2).ok_or_else(|| invalid("truncated JPEG"))?,
            *b.get(pos + 3).ok_or_else(|| invalid("truncated JPEG"))?,
        ]));
        if len < 2 {
            return Err(invalid("broken JPEG segment"));
        }
        let seg = b
            .get(pos + 4..pos + 2 + len)
            .ok_or_else(|| invalid("truncated JPEG"))?;
        if marker == 0xee && seg.starts_with(b"Adobe") {
            adobe = true;
        }
        let is_sof = matches!(marker, 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf);
        if is_sof {
            let (&precision, rest) = seg.split_first().ok_or_else(|| invalid("short SOF"))?;
            let h = u32::from(u16::from_be_bytes([
                *rest.first().ok_or_else(|| invalid("short SOF"))?,
                *rest.get(1).ok_or_else(|| invalid("short SOF"))?,
            ]));
            let w = u32::from(u16::from_be_bytes([
                *rest.get(2).ok_or_else(|| invalid("short SOF"))?,
                *rest.get(3).ok_or_else(|| invalid("short SOF"))?,
            ]));
            let components = *rest.get(4).ok_or_else(|| invalid("short SOF"))?;
            if !matches!(components, 1 | 3 | 4) {
                return Err(invalid(format!("{components} colour components")));
            }
            check_dims(w, h)?;
            return Ok(JpegInfo {
                width: w,
                height: h,
                components,
                precision,
                adobe,
            });
        }
        pos += 2 + len;
    }
    Err(invalid("JPEG has no frame header"))
}

/// Pixels: 8-bit gray (1 channel) or RGB (3 channels), row-major.
#[derive(Debug, Clone, PartialEq)]
pub struct Raster {
    pub width: u32,
    pub height: u32,
    pub channels: u8,
    pub pixels: Vec<u8>,
}

impl Raster {
    fn expected_len(&self) -> usize {
        self.width as usize * self.height as usize * usize::from(self.channels)
    }
}

/// Decode a PNG to 8-bit gray/RGB plus an optional alpha plane (bounded).
pub fn png_decode(b: &[u8]) -> Result<(Raster, Option<Vec<u8>>), CoreError> {
    let mut dec = png::Decoder::new_with_limits(
        Cursor::new(b),
        png::Limits {
            bytes: (MAX_PIXELS as usize).saturating_mul(4),
        },
    );
    dec.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = dec.read_info().map_err(|e| invalid(format!("PNG: {e}")))?;
    let (w, h) = {
        let info = reader.info();
        (info.width, info.height)
    };
    check_dims(w, h)?;
    let size = reader
        .output_buffer_size()
        .ok_or_else(|| invalid("PNG is too large"))?;
    let mut buf = vec![0u8; size];
    let out = reader
        .next_frame(&mut buf)
        .map_err(|e| invalid(format!("PNG: {e}")))?;
    buf.truncate(out.buffer_size());
    let n = w as usize * h as usize;
    let (channels, has_alpha) = match out.color_type {
        png::ColorType::Grayscale => (1u8, false),
        png::ColorType::GrayscaleAlpha => (1, true),
        png::ColorType::Rgb => (3, false),
        png::ColorType::Rgba => (3, true),
        png::ColorType::Indexed => return Err(invalid("PNG palette was not expanded")),
    };
    if out.bit_depth != png::BitDepth::Eight {
        return Err(invalid("PNG bit depth"));
    }
    let stride = usize::from(channels) + usize::from(has_alpha);
    if buf.len() < n * stride {
        return Err(invalid("PNG data is short"));
    }
    if !has_alpha {
        buf.truncate(n * stride);
        return Ok((
            Raster {
                width: w,
                height: h,
                channels,
                pixels: buf,
            },
            None,
        ));
    }
    let mut pixels = Vec::with_capacity(n * usize::from(channels));
    let mut alpha = Vec::with_capacity(n);
    for px in buf.chunks_exact(stride).take(n) {
        let (c, a) = px.split_at(usize::from(channels));
        pixels.extend_from_slice(c);
        alpha.push(a.first().copied().unwrap_or(255));
    }
    let opaque = alpha.iter().all(|&a| a == 255);
    Ok((
        Raster {
            width: w,
            height: h,
            channels,
            pixels,
        },
        (!opaque).then_some(alpha),
    ))
}

/// Decode a baseline/progressive JPEG to gray or RGB (CMYK/YCCK are refused).
pub fn jpeg_decode(b: &[u8]) -> Result<Raster, CoreError> {
    let info = jpeg_info(b)?;
    if !matches!(info.components, 1 | 3) || info.precision != 8 {
        return Err(invalid("only 8-bit gray/RGB JPEGs are decoded"));
    }
    let out = if info.components == 1 {
        zune_core::colorspace::ColorSpace::Luma
    } else {
        zune_core::colorspace::ColorSpace::RGB
    };
    let opts = zune_core::options::DecoderOptions::default()
        .set_max_width(MAX_SIDE as usize)
        .set_max_height(MAX_SIDE as usize)
        .jpeg_set_out_colorspace(out);
    let mut dec = zune_jpeg::JpegDecoder::new_with_options(Cursor::new(b), opts);
    let pixels = dec.decode().map_err(|e| invalid(format!("JPEG: {e:?}")))?;
    let r = Raster {
        width: info.width,
        height: info.height,
        channels: info.components,
        pixels,
    };
    if r.pixels.len() < r.expected_len() {
        return Err(invalid("JPEG data is short"));
    }
    Ok(r)
}

/// Encode gray/RGB pixels as a baseline JPEG.
pub fn jpeg_encode(r: &Raster, quality: u8) -> Result<Vec<u8>, CoreError> {
    let w = u16::try_from(r.width).map_err(|_| invalid("too wide for JPEG"))?;
    let h = u16::try_from(r.height).map_err(|_| invalid("too tall for JPEG"))?;
    let ct = match r.channels {
        1 => jpeg_encoder::ColorType::Luma,
        3 => jpeg_encoder::ColorType::Rgb,
        _ => return Err(invalid("unsupported channel count")),
    };
    let mut out = Vec::new();
    let enc = jpeg_encoder::Encoder::new(&mut out, quality.clamp(1, 100));
    enc.encode(&r.pixels, w, h, ct)
        .map_err(|e| invalid(format!("JPEG encode: {e}")))?;
    Ok(out)
}

/// Area-average (box filter) downsample to `nw`×`nh` (both ≤ the source size).
pub fn downsample(r: &Raster, nw: u32, nh: u32) -> Raster {
    let (w, h) = (r.width as usize, r.height as usize);
    let (nw, nh) = (
        nw.clamp(1, r.width) as usize,
        nh.clamp(1, r.height) as usize,
    );
    let c = usize::from(r.channels);
    let mut out = vec![0u8; nw * nh * c];
    for oy in 0..nh {
        let y0 = oy * h / nh;
        let y1 = ((oy + 1) * h / nh).max(y0 + 1).min(h);
        for ox in 0..nw {
            let x0 = ox * w / nw;
            let x1 = ((ox + 1) * w / nw).max(x0 + 1).min(w);
            let count = ((y1 - y0) * (x1 - x0)).max(1) as u64;
            for ch in 0..c {
                let mut sum = 0u64;
                for y in y0..y1 {
                    let row = y * w * c;
                    for x in x0..x1 {
                        sum += u64::from(r.pixels.get(row + x * c + ch).copied().unwrap_or(255));
                    }
                }
                if let Some(slot) = out.get_mut((oy * nw + ox) * c + ch) {
                    *slot = ((sum + count / 2) / count) as u8;
                }
            }
        }
    }
    Raster {
        width: nw as u32,
        height: nh as u32,
        channels: r.channels,
        pixels: out,
    }
}

/// zlib (FlateDecode) compression.
pub fn deflate(data: &[u8], level: u32) -> Result<Vec<u8>, CoreError> {
    let mut enc = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::new(level));
    enc.write_all(data)
        .map_err(|e| CoreError::new("internal", format!("compress: {e}")))?;
    enc.finish()
        .map_err(|e| CoreError::new("internal", format!("compress: {e}")))
}

fn name(n: &str) -> Object {
    Object::Name(n.as_bytes().to_vec())
}

fn image_dict(w: u32, h: u32, cs: &str) -> Dictionary {
    let mut d = Dictionary::new();
    d.set("Type", name("XObject"));
    d.set("Subtype", name("Image"));
    d.set("Width", Object::Integer(i64::from(w)));
    d.set("Height", Object::Integer(i64::from(h)));
    d.set("ColorSpace", name(cs));
    d.set("BitsPerComponent", Object::Integer(8));
    d
}

/// A picture ready to embed: the image stream and an optional soft mask stream.
#[derive(Debug, Clone)]
pub struct Picture {
    pub width: u32,
    pub height: u32,
    pub image: Stream,
    pub smask: Option<Stream>,
    pub kind: Kind,
}

/// JPEG → `/DCTDecode` passthrough (the file bytes are embedded unchanged); PNG → Flate with
/// the alpha channel as a `/SMask`.
pub fn picture_from_file(b: &[u8]) -> Result<Picture, CoreError> {
    if b.len() > MAX_FILE {
        return Err(CoreError::new(
            "limit_exceeded",
            "picture file is too large",
        ));
    }
    match sniff(b) {
        Some(Kind::Jpeg) => {
            let info = jpeg_info(b)?;
            if info.precision != 8 {
                return Err(invalid("only 8-bit JPEGs can be embedded"));
            }
            let cs = match info.components {
                1 => "DeviceGray",
                3 => "DeviceRGB",
                _ => "DeviceCMYK",
            };
            let mut d = image_dict(info.width, info.height, cs);
            d.set("Filter", name("DCTDecode"));
            if info.components == 4 && info.adobe {
                // Adobe CMYK JPEGs store inverted values.
                d.set(
                    "Decode",
                    Object::Array(
                        (0..4)
                            .flat_map(|_| [Object::Integer(1), Object::Integer(0)])
                            .collect(),
                    ),
                );
            }
            Ok(Picture {
                width: info.width,
                height: info.height,
                image: Stream::new(d, b.to_vec()),
                smask: None,
                kind: Kind::Jpeg,
            })
        }
        Some(Kind::Png) => {
            let (r, alpha) = png_decode(b)?;
            let cs = if r.channels == 1 {
                "DeviceGray"
            } else {
                "DeviceRGB"
            };
            let mut d = image_dict(r.width, r.height, cs);
            d.set("Filter", name("FlateDecode"));
            let image = Stream::new(d, deflate(&r.pixels, 6)?);
            let smask = match alpha {
                Some(a) => {
                    let mut md = image_dict(r.width, r.height, "DeviceGray");
                    md.set("Filter", name("FlateDecode"));
                    Some(Stream::new(md, deflate(&a, 6)?))
                }
                None => None,
            };
            Ok(Picture {
                width: r.width,
                height: r.height,
                image,
                smask,
                kind: Kind::Png,
            })
        }
        None => Err(CoreError::new(
            "unsupported_image",
            "only JPEG and PNG pictures can be inserted",
        )),
    }
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
mod tests {
    use super::*;

    pub(crate) fn gradient(w: u32, h: u32) -> Raster {
        let mut pixels = Vec::new();
        for y in 0..h {
            for x in 0..w {
                pixels.extend_from_slice(&[(x * 255 / w) as u8, (y * 255 / h) as u8, 128]);
            }
        }
        Raster {
            width: w,
            height: h,
            channels: 3,
            pixels,
        }
    }

    fn png_bytes(w: u32, h: u32, alpha: bool) -> Vec<u8> {
        let mut out = Vec::new();
        {
            let mut e = png::Encoder::new(&mut out, w, h);
            e.set_color(if alpha {
                png::ColorType::Rgba
            } else {
                png::ColorType::Rgb
            });
            e.set_depth(png::BitDepth::Eight);
            let mut wr = e.write_header().unwrap();
            let mut data = Vec::new();
            for y in 0..h {
                for x in 0..w {
                    data.extend_from_slice(&[x as u8, y as u8, 7]);
                    if alpha {
                        data.push(if x < w / 2 { 0 } else { 255 });
                    }
                }
            }
            wr.write_image_data(&data).unwrap();
        }
        out
    }

    #[test]
    fn jpeg_round_trip_and_header() {
        let r = gradient(64, 32);
        let j = jpeg_encode(&r, 80).unwrap();
        let info = jpeg_info(&j).unwrap();
        assert_eq!((info.width, info.height, info.components), (64, 32, 3));
        let back = jpeg_decode(&j).unwrap();
        assert_eq!((back.width, back.height, back.channels), (64, 32, 3));
        let diff: u64 = back
            .pixels
            .iter()
            .zip(&r.pixels)
            .map(|(a, b)| u64::from(a.abs_diff(*b)))
            .sum();
        assert!(diff / (r.pixels.len() as u64) < 6);
    }

    #[test]
    fn jpeg_passthrough_keeps_file_bytes() {
        let j = jpeg_encode(&gradient(20, 10), 90).unwrap();
        let p = picture_from_file(&j).unwrap();
        assert_eq!(p.image.content, j);
        assert_eq!(
            p.image.dict.get(b"Filter").unwrap().as_name().unwrap(),
            b"DCTDecode"
        );
        assert_eq!(
            p.image.dict.get(b"ColorSpace").unwrap().as_name().unwrap(),
            b"DeviceRGB"
        );
        assert!(p.smask.is_none());
    }

    #[test]
    fn png_alpha_becomes_smask() {
        let p = picture_from_file(&png_bytes(16, 8, true)).unwrap();
        assert_eq!((p.width, p.height), (16, 8));
        let m = p.smask.unwrap();
        assert_eq!(
            m.dict.get(b"ColorSpace").unwrap().as_name().unwrap(),
            b"DeviceGray"
        );
        let alpha = m.decompressed_content().unwrap();
        assert_eq!(alpha.len(), 128);
        assert_eq!(alpha[0], 0);
        assert_eq!(alpha[15], 255);
        let rgb = p.image.decompressed_content().unwrap();
        assert_eq!(rgb.len(), 16 * 8 * 3);
        // opaque PNG: no mask
        assert!(picture_from_file(&png_bytes(4, 4, false))
            .unwrap()
            .smask
            .is_none());
    }

    #[test]
    fn hostile_pictures_are_errors_not_panics() {
        let j = jpeg_encode(&gradient(20, 10), 90).unwrap();
        for cut in [0, 2, 3, 5, 10, 20, j.len() / 2] {
            let _ = picture_from_file(&j[..cut]);
            let _ = jpeg_decode(&j[..cut]);
        }
        let p = png_bytes(8, 8, true);
        for cut in [8, 16, 33, p.len() / 2] {
            assert!(picture_from_file(&p[..cut]).is_err());
        }
        // only the end chunk missing: the pixels are complete, either answer is fine
        let _ = picture_from_file(&p[..p.len() - 3]);
        // a JPEG header claiming 0×0 and one claiming 65535×65535
        let mut bad = j.clone();
        let sof = bad.windows(2).position(|w| w == [0xff, 0xc0]).unwrap();
        bad[sof + 5..sof + 9].copy_from_slice(&[0, 0, 0, 0]);
        assert_eq!(picture_from_file(&bad).unwrap_err().code, "invalid_image");
        bad[sof + 5..sof + 9].copy_from_slice(&[0xff, 0xff, 0xff, 0xff]);
        assert_eq!(picture_from_file(&bad).unwrap_err().code, "limit_exceeded");
        assert_eq!(
            picture_from_file(b"GIF89a").unwrap_err().code,
            "unsupported_image"
        );
        // random junk after a JPEG SOI
        let mut junk = vec![0xff, 0xd8, 0xff];
        junk.extend((0..500u32).map(|i| (i * 7919 % 251) as u8));
        let _ = picture_from_file(&junk);
    }

    #[test]
    fn downsample_averages_boxes() {
        let r = Raster {
            width: 4,
            height: 2,
            channels: 1,
            pixels: vec![0, 100, 200, 250, 0, 100, 200, 250],
        };
        let d = downsample(&r, 2, 1);
        assert_eq!(d.pixels, vec![50, 225]);
    }
}
