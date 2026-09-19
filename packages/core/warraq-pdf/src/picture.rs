//! A PNG or JPEG the person chose, made into an image XObject.
//!
//! The bytes come from a file picker or a drop, so they are treated like any
//! other input: the size is checked before anything is decoded, the decoder
//! runs with limits, and nothing here panics. A baseline or progressive JPEG
//! in grey or RGB goes in as it is (`/DCTDecode`, no loss); anything else —
//! a CMYK JPEG, every PNG — is decoded and stored losslessly with Flate, its
//! transparency as a soft mask.
use lopdf::{dictionary, Document, Object, ObjectId, Stream};

use crate::{Error, Result};

/// A picture bigger than this is refused rather than decoded.
const MAX_BYTES: usize = 64 * 1024 * 1024;
const MAX_SIDE: u32 = 16_384;
const MAX_PIXELS: u64 = 40_000_000;

/// What was added: the XObject and its size in pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Picture {
    pub id: ObjectId,
    pub width: u32,
    pub height: u32,
}

fn refuse(why: &str) -> Error {
    Error::Edit(format!("E_IMAGE: {why}"))
}

/// The width, height and components of a JPEG, from its frame header.
fn jpeg_frame(bytes: &[u8]) -> Option<(u32, u32, u8)> {
    if !bytes.starts_with(&[0xFF, 0xD8]) {
        return None;
    }
    let mut i = 2;
    // Every segment moves `i` on by at least two bytes, so this ends.
    while i + 4 <= bytes.len() {
        if bytes[i] != 0xFF {
            i += 1;
            continue;
        }
        let marker = bytes[i + 1];
        if marker == 0xFF {
            i += 1;
            continue;
        }
        if matches!(marker, 0xD0..=0xD9 | 0x01) {
            i += 2;
            continue;
        }
        let len = u16::from_be_bytes([bytes[i + 2], bytes[i + 3]]) as usize;
        let is_frame = matches!(marker, 0xC0..=0xCF) && !matches!(marker, 0xC4 | 0xC8 | 0xCC);
        if is_frame {
            let f = bytes.get(i + 4..i + 10)?;
            let height = u16::from_be_bytes([f[1], f[2]]) as u32;
            let width = u16::from_be_bytes([f[3], f[4]]) as u32;
            return Some((width, height, f[5]));
        }
        i += 2 + len.max(2);
    }
    None
}

fn check_size(width: u32, height: u32) -> Result<()> {
    if width == 0 || height == 0 {
        return Err(refuse("the picture has no pixels"));
    }
    if width > MAX_SIDE || height > MAX_SIDE || width as u64 * height as u64 > MAX_PIXELS {
        return Err(refuse("the picture is too large"));
    }
    Ok(())
}

fn flate_image(doc: &mut Document, image: image::DynamicImage) -> Result<Picture> {
    let (width, height) = (image.width(), image.height());
    check_size(width, height)?;
    let has_alpha = image.color().has_alpha();
    let grey = !image.color().has_color();
    let smask = if has_alpha {
        let alpha: Vec<u8> = image.to_rgba8().pixels().map(|p| p.0[3]).collect();
        // A mask of nothing but opaque pixels is no mask.
        if alpha.iter().all(|a| *a == 255) {
            None
        } else {
            let mut mask = Stream::new(
                dictionary! {
                    "Type" => "XObject", "Subtype" => "Image",
                    "Width" => width as i64, "Height" => height as i64,
                    "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8,
                },
                alpha,
            );
            let _ = mask.compress();
            Some(doc.add_object(mask))
        }
    } else {
        None
    };
    let (pixels, space) = if grey {
        (image.to_luma8().into_raw(), "DeviceGray")
    } else {
        (image.to_rgb8().into_raw(), "DeviceRGB")
    };
    let mut dict = dictionary! {
        "Type" => "XObject", "Subtype" => "Image",
        "Width" => width as i64, "Height" => height as i64,
        "ColorSpace" => space, "BitsPerComponent" => 8,
    };
    if let Some(mask) = smask {
        dict.set("SMask", Object::Reference(mask));
    }
    let mut stream = Stream::new(dict, pixels);
    let _ = stream.compress();
    Ok(Picture {
        id: doc.add_object(stream),
        width,
        height,
    })
}

fn decode(bytes: &[u8], format: image::ImageFormat) -> Result<image::DynamicImage> {
    let mut reader = image::ImageReader::with_format(std::io::Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_SIDE);
    limits.max_image_height = Some(MAX_SIDE);
    limits.max_alloc = Some(MAX_PIXELS * 4 + (1 << 20));
    reader.limits(limits);
    reader
        .decode()
        .map_err(|e| refuse(&format!("the picture could not be read: {e}")))
}

/// What a PNG or JPEG says about itself before it is decoded: its size, the
/// way a camera says to turn it, and the resolution it was made at.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PictureInfo {
    /// As stored, before `orientation` is applied.
    pub width: u32,
    pub height: u32,
    /// EXIF orientation, 1–8; 1 when the file says nothing (TIFF 6.0 §274).
    pub orientation: u8,
    /// Dots per inch the file records, when it records a believable one.
    pub dpi: Option<f32>,
}

impl PictureInfo {
    /// Width and height as the picture is meant to be seen.
    pub fn shown(&self) -> (u32, u32) {
        if self.orientation >= 5 {
            (self.height, self.width)
        } else {
            (self.width, self.height)
        }
    }
}

/// A resolution nobody scans or photographs at is a file's placeholder.
fn believable_dpi(dpi: f32) -> Option<f32> {
    (dpi.is_finite() && (50.0..=2400.0).contains(&dpi)).then_some(dpi)
}

/// Orientation and resolution from an EXIF block (a TIFF header and IFD0).
fn exif(tiff: &[u8]) -> (Option<u8>, Option<f32>) {
    let big = match tiff.get(..2) {
        Some(b"MM") => true,
        Some(b"II") => false,
        _ => return (None, None),
    };
    let u16_at = |at: usize| -> Option<u16> {
        let b = tiff.get(at..at + 2)?;
        Some(if big {
            u16::from_be_bytes([b[0], b[1]])
        } else {
            u16::from_le_bytes([b[0], b[1]])
        })
    };
    let u32_at = |at: usize| -> Option<u32> {
        let b = tiff.get(at..at + 4)?;
        Some(if big {
            u32::from_be_bytes([b[0], b[1], b[2], b[3]])
        } else {
            u32::from_le_bytes([b[0], b[1], b[2], b[3]])
        })
    };
    let Some(ifd) = u32_at(4).map(|o| o as usize) else {
        return (None, None);
    };
    let count = u16_at(ifd).unwrap_or(0).min(512) as usize;
    let (mut orientation, mut resolution, mut unit) = (None, None, 2u16);
    for k in 0..count {
        let entry = ifd + 2 + k * 12;
        match u16_at(entry) {
            Some(0x0112) => orientation = u16_at(entry + 8).map(|v| v as u8),
            Some(0x011A) => {
                resolution = u32_at(entry + 8).and_then(|at| {
                    let (n, d) = (u32_at(at as usize)?, u32_at(at as usize + 4)?);
                    (d > 0).then(|| n as f32 / d as f32)
                })
            }
            Some(0x0128) => unit = u16_at(entry + 8).unwrap_or(2),
            _ => {}
        }
    }
    let dpi = resolution.and_then(|r| match unit {
        2 => believable_dpi(r),
        3 => believable_dpi(r * 2.54),
        _ => None,
    });
    (orientation.filter(|o| (1..=8).contains(o)), dpi)
}

fn jpeg_info(bytes: &[u8]) -> Option<PictureInfo> {
    let (width, height, _) = jpeg_frame(bytes)?;
    let (mut orientation, mut dpi) = (None, None);
    let mut i = 2;
    // The markers before the frame: JFIF's density (APP0) and EXIF (APP1).
    while i + 4 <= bytes.len() {
        if bytes[i] != 0xFF {
            i += 1;
            continue;
        }
        let marker = bytes[i + 1];
        if matches!(marker, 0xFF) {
            i += 1;
            continue;
        }
        if matches!(marker, 0xD0..=0xD9 | 0x01) {
            i += 2;
            continue;
        }
        let frame = (0xC0..=0xCF).contains(&marker) && !matches!(marker, 0xC4 | 0xC8 | 0xCC);
        if marker == 0xDA || frame {
            break;
        }
        let len = u16::from_be_bytes([bytes[i + 2], bytes[i + 3]]) as usize;
        let body = bytes
            .get(i + 4..(i + 2 + len).min(bytes.len()))
            .unwrap_or(&[]);
        if marker == 0xE0 && body.starts_with(b"JFIF\0") && body.len() >= 12 {
            let x = u16::from_be_bytes([body[8], body[9]]) as f32;
            dpi = dpi.or(match body[7] {
                1 => believable_dpi(x),
                2 => believable_dpi(x * 2.54),
                _ => None,
            });
        }
        if marker == 0xE1 && body.starts_with(b"Exif\0\0") {
            let (o, d) = exif(&body[6..]);
            orientation = orientation.or(o);
            dpi = d.or(dpi);
        }
        i += 2 + len.max(2);
    }
    Some(PictureInfo {
        width,
        height,
        orientation: orientation.unwrap_or(1),
        dpi,
    })
}

fn png_info(bytes: &[u8]) -> Option<PictureInfo> {
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") || bytes.get(12..16) != Some(b"IHDR") {
        return None;
    }
    let be = |at: usize| -> Option<u32> {
        let b = bytes.get(at..at + 4)?;
        Some(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    };
    let (width, height) = (be(16)?, be(20)?);
    let mut dpi = None;
    let mut at = 8;
    // Chunks until the pixels start; pHYs must come before them.
    while at + 8 <= bytes.len() {
        let len = be(at)? as usize;
        let kind = &bytes[at + 4..at + 8];
        if kind == b"IDAT" || kind == b"IEND" {
            break;
        }
        if kind == b"pHYs" && len == 9 && bytes.get(at + 16) == Some(&1) {
            dpi = believable_dpi(be(at + 8)? as f32 * 0.0254);
        }
        at = at.checked_add(12 + len)?;
    }
    Some(PictureInfo {
        width,
        height,
        orientation: 1,
        dpi,
    })
}

/// What kind of picture a file is, by its first bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PictureKind {
    Jpeg,
    Png,
    Gif,
    Bmp,
    Webp,
    Tiff,
}

pub fn picture_kind(bytes: &[u8]) -> Option<PictureKind> {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some(PictureKind::Jpeg)
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(PictureKind::Png)
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some(PictureKind::Gif)
    } else if bytes.starts_with(b"BM") && bytes.len() > 26 {
        Some(PictureKind::Bmp)
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some(PictureKind::Webp)
    } else if crate::tiff::is_tiff(bytes) {
        Some(PictureKind::Tiff)
    } else {
        None
    }
}

fn image_format(kind: PictureKind) -> Option<image::ImageFormat> {
    match kind {
        PictureKind::Gif => Some(image::ImageFormat::Gif),
        PictureKind::Bmp => Some(image::ImageFormat::Bmp),
        PictureKind::Webp => Some(image::ImageFormat::WebP),
        _ => None,
    }
}

/// Size, orientation and resolution of a picture, read from its headers.
pub fn picture_info(bytes: &[u8]) -> Option<PictureInfo> {
    let kind = picture_kind(bytes)?;
    match kind {
        PictureKind::Jpeg => jpeg_info(bytes),
        PictureKind::Png => png_info(bytes),
        PictureKind::Tiff => crate::tiff::tiff_info(bytes),
        _ => {
            let format = image_format(kind)?;
            let (width, height) =
                image::ImageReader::with_format(std::io::Cursor::new(bytes), format)
                    .into_dimensions()
                    .ok()?;
            Some(PictureInfo {
                width,
                height,
                orientation: 1,
                dpi: None,
            })
        }
    }
}

/// Where the unit square of a picture stored in `orientation` lands so that
/// it is seen upright in the box `(x, y, w, h)` (PDF space, y up).
pub fn upright_matrix(orientation: u8, x: f32, y: f32, w: f32, h: f32) -> [f32; 6] {
    // Shown (X, Y) from stored (u, v), both in the unit square, v up.
    let [a, b, c, d, e, f] = match orientation {
        2 => [-1.0, 0.0, 0.0, 1.0, 1.0, 0.0],
        3 => [-1.0, 0.0, 0.0, -1.0, 1.0, 1.0],
        4 => [1.0, 0.0, 0.0, -1.0, 0.0, 1.0],
        5 => [0.0, -1.0, -1.0, 0.0, 1.0, 1.0],
        6 => [0.0, -1.0, 1.0, 0.0, 0.0, 1.0],
        7 => [0.0, 1.0, 1.0, 0.0, 0.0, 0.0],
        8 => [0.0, 1.0, -1.0, 0.0, 1.0, 0.0],
        _ => [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
    };
    [a * w, b * h, c * w, d * h, e * w + x, f * h + y]
}

/// Adds `bytes` — a PNG, JPEG, GIF, BMP, WebP or the first page of a TIFF — to
/// `doc` as an image XObject.
pub fn add_picture(doc: &mut Document, bytes: &[u8]) -> Result<Picture> {
    if bytes.len() > MAX_BYTES {
        return Err(refuse("the picture is too large"));
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        let (width, height, components) =
            jpeg_frame(bytes).ok_or_else(|| refuse("the JPEG has no frame header"))?;
        check_size(width, height)?;
        let space = match components {
            1 => "DeviceGray",
            3 => "DeviceRGB",
            // CMYK and the rest: decoded, so they are drawn as they look.
            _ => return flate_image(doc, decode(bytes, image::ImageFormat::Jpeg)?),
        };
        // Decoded once, to be sure a viewer will not meet a broken file.
        decode(bytes, image::ImageFormat::Jpeg)?;
        let stream = Stream::new(
            dictionary! {
                "Type" => "XObject", "Subtype" => "Image",
                "Width" => width as i64, "Height" => height as i64,
                "ColorSpace" => space, "BitsPerComponent" => 8,
                "Filter" => "DCTDecode",
            },
            bytes.to_vec(),
        )
        .with_compression(false);
        return Ok(Picture {
            id: doc.add_object(stream),
            width,
            height,
        });
    }
    match picture_kind(bytes) {
        Some(PictureKind::Png) => flate_image(doc, decode(bytes, image::ImageFormat::Png)?),
        // The first page; `add_picture_pages` takes them all.
        Some(PictureKind::Tiff) => crate::tiff::add_tiff_pages(doc, bytes)?
            .into_iter()
            .next()
            .map(|(p, _)| p)
            .ok_or_else(|| refuse("the TIFF has no pages")),
        Some(kind) => match image_format(kind) {
            // A GIF's first frame; the others of an animation are not pages.
            Some(format) => flate_image(doc, decode(bytes, format)?),
            None => Err(refuse("the picture could not be read")),
        },
        None => Err(refuse(
            "only PNG, JPEG, GIF, BMP, WebP and TIFF pictures can be placed",
        )),
    }
}

/// Every page of a picture — one, or each of a TIFF's — as image XObjects
/// added to `doc`, with how each is to be shown.
pub fn add_picture_pages(doc: &mut Document, bytes: &[u8]) -> Result<Vec<(Picture, PictureInfo)>> {
    if bytes.len() > MAX_BYTES {
        return Err(refuse("the picture is too large"));
    }
    if picture_kind(bytes) == Some(PictureKind::Tiff) {
        return crate::tiff::add_tiff_pages(doc, bytes);
    }
    let info = picture_info(bytes).ok_or_else(|| refuse("the picture could not be read"))?;
    let picture = add_picture(doc, bytes)?;
    Ok(vec![(picture, info)])
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A small PNG: a red square with a transparent quarter.
    pub(crate) fn png(width: u32, height: u32) -> Vec<u8> {
        let mut image = image::RgbaImage::new(width, height);
        for (x, y, p) in image.enumerate_pixels_mut() {
            *p = if x < width / 2 && y < height / 2 {
                image::Rgba([0, 0, 0, 0])
            } else {
                image::Rgba([220, 20, 20, 255])
            };
        }
        let mut out = Vec::new();
        image::DynamicImage::ImageRgba8(image)
            .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
            .unwrap();
        out
    }

    pub(crate) fn jpeg(width: u32, height: u32) -> Vec<u8> {
        let image = image::RgbImage::from_pixel(width, height, image::Rgb([20, 90, 200]));
        let mut out = Vec::new();
        image::DynamicImage::ImageRgb8(image)
            .write_to(
                &mut std::io::Cursor::new(&mut out),
                image::ImageFormat::Jpeg,
            )
            .unwrap();
        out
    }

    #[test]
    fn a_png_becomes_a_flate_image_with_its_transparency_as_a_mask() {
        let mut doc = Document::with_version("1.7");
        let picture = add_picture(&mut doc, &png(40, 20)).unwrap();
        assert_eq!((picture.width, picture.height), (40, 20));
        let stream = doc.get_object(picture.id).unwrap().as_stream().unwrap();
        assert!(stream.dict.get(b"SMask").is_ok());
        assert_eq!(
            stream.dict.get(b"ColorSpace").unwrap().as_name().unwrap(),
            b"DeviceRGB"
        );
    }

    #[test]
    fn a_jpeg_goes_in_as_it_is() {
        let bytes = jpeg(30, 10);
        let mut doc = Document::with_version("1.7");
        let picture = add_picture(&mut doc, &bytes).unwrap();
        let stream = doc.get_object(picture.id).unwrap().as_stream().unwrap();
        assert_eq!(stream.content, bytes);
        assert_eq!(
            stream.dict.get(b"Filter").unwrap().as_name().unwrap(),
            b"DCTDecode"
        );
        assert_eq!((picture.width, picture.height), (30, 10));
    }

    #[test]
    fn anything_else_or_anything_broken_is_refused_not_panicked_on() {
        let mut doc = Document::with_version("1.7");
        for bytes in [
            &b"GIF89a"[..],
            b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\xff\xff\xff\xff",
            b"\xFF\xD8\xFF\xC0\0\x11\x08\xff\xff\xff\xff\x03",
            b"\xFF\xD8\xFF",
            b"",
        ] {
            assert!(add_picture(&mut doc, bytes).is_err());
        }
    }
}
