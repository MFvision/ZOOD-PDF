//! A PNG or JPEG the person chose, made into an image XObject.
//!
//! The bytes come from a file picker or a drop, so they are treated like any
//! other input: the size is checked before anything is decoded, the decoder
//! runs with limits, and nothing here panics. A baseline or progressive JPEG
//! in grey or RGB goes in as it is (`/DCTDecode`, no loss); anything else —
//! a CMYK JPEG, every PNG — is decoded and stored losslessly with Flate, its
//! transparency as a soft mask. A picture with an EXIF orientation (a phone
//! photo, typically) is turned upright first, since no PDF viewer reads the
//! tag; a JPEG so turned is written again, once, at `JPEG_QUALITY`.
use lopdf::{dictionary, Document, Object, ObjectId, Stream};

use crate::{Error, Result};

/// A picture bigger than this is refused rather than decoded.
const MAX_BYTES: usize = 64 * 1024 * 1024;
const MAX_SIDE: u32 = 16_384;
const MAX_PIXELS: u64 = 40_000_000;
/// A turned photo's JPEG is written again at this quality.
const JPEG_QUALITY: u8 = 92;

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

/// Decodes a picture, with limits, turned the way its EXIF orientation
/// says it is shown — as every photo viewer and the browser show it; a
/// PDF viewer never reads that tag. Says too whether it had to be turned.
fn decode(bytes: &[u8], format: image::ImageFormat) -> Result<(image::DynamicImage, bool)> {
    use image::ImageDecoder;
    let unreadable = |e: image::ImageError| refuse(&format!("the picture could not be read: {e}"));
    let mut reader = image::ImageReader::with_format(std::io::Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_SIDE);
    limits.max_image_height = Some(MAX_SIDE);
    limits.max_alloc = Some(MAX_PIXELS * 4 + (1 << 20));
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(unreadable)?;
    let orientation = decoder
        .orientation()
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut image = image::DynamicImage::from_decoder(decoder).map_err(unreadable)?;
    image.apply_orientation(orientation);
    Ok((
        image,
        orientation != image::metadata::Orientation::NoTransforms,
    ))
}

/// A turned photo, written again as a JPEG, upright: grey stays grey.
fn upright_jpeg(image: &image::DynamicImage) -> Result<(Vec<u8>, &'static str)> {
    let (image, space) = if image.color().has_color() {
        (image::DynamicImage::ImageRgb8(image.to_rgb8()), "DeviceRGB")
    } else {
        (
            image::DynamicImage::ImageLuma8(image.to_luma8()),
            "DeviceGray",
        )
    };
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY)
        .encode_image(&image)
        .map_err(|e| refuse(&format!("the picture could not be turned upright: {e}")))?;
    Ok((out, space))
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
            _ => return flate_image(doc, decode(bytes, image::ImageFormat::Jpeg)?.0),
        };
        // Decoded once, to be sure a viewer will not meet a broken file.
        let (image, turned) = decode(bytes, image::ImageFormat::Jpeg)?;
        if turned {
            // Turned upright and written again: once, at a high quality.
            let (jpeg, space) = upright_jpeg(&image)?;
            let (width, height) = (image.width(), image.height());
            let stream = Stream::new(
                dictionary! {
                    "Type" => "XObject", "Subtype" => "Image",
                    "Width" => width as i64, "Height" => height as i64,
                    "ColorSpace" => space, "BitsPerComponent" => 8,
                    "Filter" => "DCTDecode",
                },
                jpeg,
            )
            .with_compression(false);
            return Ok(Picture {
                id: doc.add_object(stream),
                width,
                height,
            });
        }
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
        return flate_image(doc, decode(bytes, image::ImageFormat::Png)?.0);
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

    /// A phone photo: stored landscape — red on the left, blue on the right
    /// — with an EXIF orientation of 6, "turn a quarter clockwise to show".
    fn turned_photo() -> Vec<u8> {
        let image = image::RgbImage::from_fn(40, 20, |x, _| {
            if x < 20 {
                image::Rgb([230, 20, 20])
            } else {
                image::Rgb([20, 20, 230])
            }
        });
        let exif = b"II\x2a\x00\x08\x00\x00\x00\x01\x00\x12\x01\x03\x00\x01\x00\x00\x00\x06\x00\x00\x00\x00\x00\x00\x00";
        let mut out = Vec::new();
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 95);
        image::ImageEncoder::set_exif_metadata(&mut encoder, exif.to_vec()).unwrap();
        encoder.encode_image(&image).unwrap();
        out
    }

    /// PDF viewers draw a JPEG's pixels as they are stored and never read
    /// its EXIF orientation: the picture goes in upright, as the photo
    /// shows everywhere else (and as the browser measured it).
    #[test]
    fn a_photo_goes_in_upright_whatever_its_exif_orientation() {
        let mut doc = Document::with_version("1.7");
        let picture = add_picture(&mut doc, &turned_photo()).unwrap();
        assert_eq!((picture.width, picture.height), (20, 40));
        let stream = doc.get_object(picture.id).unwrap().as_stream().unwrap();
        assert_eq!(stream.dict.get(b"Width").unwrap().as_i64().unwrap(), 20);
        assert_eq!(stream.dict.get(b"Height").unwrap().as_i64().unwrap(), 40);
        // Turned clockwise, the left (red) half is now on top.
        let stored = image::load_from_memory(&stream.content).unwrap().to_rgb8();
        assert_eq!(stored.dimensions(), (20, 40));
        let top = stored.get_pixel(10, 5).0;
        let bottom = stored.get_pixel(10, 35).0;
        assert!(top[0] > 150 && top[2] < 100, "{top:?}");
        assert!(bottom[2] > 150 && bottom[0] < 100, "{bottom:?}");
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
