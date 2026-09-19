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
    // A black-and-white picture — a cleaned-up scan — at one bit a pixel:
    // an eighth of the data, and Flate does better still on it.
    let bilevel = grey && smask.is_none() && pixels.iter().all(|p| *p == 0 || *p == 255);
    let (pixels, bits) = if bilevel {
        (pack_bits(&pixels, width as usize), 1)
    } else {
        (pixels, 8)
    };
    let mut dict = dictionary! {
        "Type" => "XObject", "Subtype" => "Image",
        "Width" => width as i64, "Height" => height as i64,
        "ColorSpace" => space, "BitsPerComponent" => bits,
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

/// Grey pixels that are all 0 or 255 as rows of bits, most significant first,
/// each row padded to a whole byte (ISO 32000-1 §8.9.3): 1 is white.
fn pack_bits(pixels: &[u8], width: usize) -> Vec<u8> {
    if width == 0 {
        return Vec::new();
    }
    let stride = width.div_ceil(8);
    let mut out = Vec::with_capacity(stride * (pixels.len() / width));
    for row in pixels.chunks(width) {
        let start = out.len();
        out.resize(start + stride, 0);
        for (x, p) in row.iter().enumerate() {
            if *p == 255 {
                out[start + x / 8] |= 0x80 >> (x % 8);
            }
        }
    }
    out
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

/// Adds `bytes`, a PNG or JPEG, to `doc` as an image XObject.
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
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return flate_image(doc, decode(bytes, image::ImageFormat::Png)?);
    }
    Err(refuse("only PNG and JPEG pictures can be placed"))
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
    fn a_black_and_white_picture_is_kept_at_one_bit_a_pixel() {
        // 10 wide: rows of two bytes, the last one padded.
        let image = image::GrayImage::from_fn(10, 3, |x, _| {
            image::Luma([if x % 3 == 0 { 0 } else { 255 }])
        });
        let mut bytes = Vec::new();
        image::DynamicImage::ImageLuma8(image)
            .write_to(
                &mut std::io::Cursor::new(&mut bytes),
                image::ImageFormat::Png,
            )
            .unwrap();
        let mut doc = Document::with_version("1.7");
        let picture = add_picture(&mut doc, &bytes).unwrap();
        let stream = doc.get_object(picture.id).unwrap().as_stream().unwrap();
        assert_eq!(
            stream
                .dict
                .get(b"BitsPerComponent")
                .unwrap()
                .as_i64()
                .unwrap(),
            1
        );
        assert_eq!(
            stream.dict.get(b"ColorSpace").unwrap().as_name().unwrap(),
            b"DeviceGray"
        );
        let data = stream.decompressed_content().unwrap();
        // x = 0, 3, 6, 9 black: 0110 1101 10 then padding.
        assert_eq!(data, [0b0110_1101, 0b1000_0000].repeat(3));
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
