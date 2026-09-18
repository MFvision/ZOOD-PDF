//! Compress: a smaller copy of the document, written from scratch.
//!
//! An incremental update can only add bytes, so a smaller file is a new file
//! (the build plan's "rebase"); the open document and its revisions are left
//! as they are. Everything here is pure Rust and identical natively and in the
//! browser:
//!
//! * objects nothing refers to are dropped;
//! * identical streams — the same font or image embedded twice, as merged
//!   files often have — are kept once and shared;
//! * streams are recompressed at the highest Flate level when that is smaller;
//! * objects are packed into object streams with a cross-reference stream;
//! * optionally, images bigger than any page needs at a chosen resolution are
//!   downsampled and stored as JPEG — the one lossy step, and only on request.
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::io::Write as _;

use lopdf::{Dictionary, Object, ObjectId, SaveOptions, Stream};

use crate::{Error, PdfDocument, Result};

/// What to trade for size.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CompressOptions {
    /// Downsample images larger than any page needs at this resolution, and
    /// store them as JPEG; `None` keeps every image exactly as it is.
    pub image_dpi: Option<f32>,
    /// JPEG quality for the images that are re-encoded, 1–100.
    pub jpeg_quality: u8,
}

impl Default for CompressOptions {
    fn default() -> Self {
        Self {
            image_dpi: None,
            jpeg_quality: 75,
        }
    }
}

/// What a compression did.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct CompressReport {
    /// Objects nothing referred to, dropped.
    pub unused: usize,
    /// Streams that were exact copies of another, now shared.
    pub duplicates: usize,
    /// Streams stored smaller at the highest Flate level.
    pub recompressed: usize,
    /// Images downsampled and stored as JPEG.
    pub images: usize,
    /// The copy came out no smaller, so the file is handed back as it was.
    pub unchanged: bool,
}

/// Why a file is not compressed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// Written from scratch, the copy would lose the file's password.
    Protected,
    /// Written from scratch, the copy would break the file's signature.
    Signed,
}

impl PdfDocument {
    /// Whether this file can be compressed: not a protected one, whose copy
    /// would be written without its password, and not a signed one, whose
    /// signature a rewrite breaks.
    pub fn compress_refusal(&self) -> Option<Refusal> {
        if self.was_encrypted {
            return Some(Refusal::Protected);
        }
        let signed = self.doc.objects.values().any(|object| {
            object.as_dict().is_ok_and(|d| {
                (d.has_type(b"Sig") || d.has_type(b"DocTimeStamp"))
                    && (d.has(b"ByteRange") || d.has(b"Contents"))
            })
        });
        signed.then_some(Refusal::Signed)
    }

    /// A smaller copy of this document. See the module documentation for
    /// what is done; the document itself is not changed.
    pub fn compressed(&self, options: &CompressOptions) -> Result<(Vec<u8>, CompressReport)> {
        if let Some(refusal) = self.compress_refusal() {
            return Err(Error::Edit(format!(
                "this file cannot be compressed: {refusal:?}"
            )));
        }
        let mut report = CompressReport::default();
        let mut copy = self.detached_copy();

        let before = copy.doc.objects.len();
        copy.prune_unreachable();
        report.unused = before - copy.doc.objects.len();

        report.duplicates = copy.share_duplicate_streams();

        let mut resampled: HashSet<ObjectId> = HashSet::new();
        if let Some(dpi) = options.image_dpi {
            let limit = copy.largest_page_pixels(dpi);
            let quality = options.jpeg_quality.clamp(1, 100);
            let ids: Vec<ObjectId> = copy.doc.objects.keys().copied().collect();
            for id in ids {
                let Some(Object::Stream(stream)) = copy.doc.objects.get_mut(&id) else {
                    continue;
                };
                if downsample_image(stream, limit, quality) {
                    resampled.insert(id);
                }
            }
            report.images = resampled.len();
        }

        for (id, object) in copy.doc.objects.iter_mut() {
            if let Object::Stream(stream) = object {
                if !resampled.contains(id) && recompress(stream) {
                    report.recompressed += 1;
                }
            }
        }

        let mut out = Vec::new();
        copy.doc
            .save_with_options(
                &mut out,
                SaveOptions::builder()
                    .use_object_streams(true)
                    .use_xref_streams(true)
                    .compression_level(9)
                    .build(),
            )
            .map_err(|e| Error::Io(e.to_string()))?;
        // An already tight file can come out a few bytes bigger: then it is
        // better left exactly as it was.
        if !self.original_bytes().is_empty() && out.len() >= self.original_bytes().len() {
            report.unchanged = true;
            return Ok((self.original_bytes().to_vec(), report));
        }
        Ok((out, report))
    }

    /// Keeps one of each set of identical streams — same dictionary, same
    /// bytes — and points every reference at it. Returns how many went.
    fn share_duplicate_streams(&mut self) -> usize {
        let mut first: HashMap<u64, Vec<ObjectId>> = HashMap::new();
        let mut map: HashMap<ObjectId, ObjectId> = HashMap::new();
        for (&id, object) in &self.doc.objects {
            let Object::Stream(stream) = object else {
                continue;
            };
            let mut hasher = DefaultHasher::new();
            format!("{:?}", stream.dict).hash(&mut hasher);
            stream.content.hash(&mut hasher);
            let key = hasher.finish();
            let same = first.entry(key).or_default();
            // A hash is only a hint: compare the real thing.
            let twin = same.iter().copied().find(|other| {
                matches!(self.doc.objects.get(other), Some(Object::Stream(s))
                    if s.content == stream.content && format!("{:?}", s.dict) == format!("{:?}", stream.dict))
            });
            match twin {
                Some(keep) => {
                    map.insert(id, keep);
                }
                None => same.push(id),
            }
        }
        if map.is_empty() {
            return 0;
        }
        let redirect = |object: &mut Object| redirect_references(object, &map);
        for object in self.doc.objects.values_mut() {
            redirect(object);
        }
        for (_, value) in self.doc.trailer.iter_mut() {
            redirect(value);
        }
        for id in map.keys() {
            self.doc.objects.remove(id);
        }
        map.len()
    }

    /// The pixel size an image never needs to exceed: the largest page of the
    /// document at `dpi`.
    fn largest_page_pixels(&self, dpi: f32) -> (u32, u32) {
        let (mut w, mut h) = (0f32, 0f32);
        for index in 0..self.page_count() {
            if let Ok((pw, ph)) = self.page_size(index) {
                // Either way round: an image may be drawn rotated.
                w = w.max(pw.max(ph));
                h = h.max(pw.max(ph));
            }
        }
        let px = |pt: f32| ((pt / 72.0 * dpi).ceil() as u32).max(1);
        (px(w), px(h))
    }
}

/// Every reference to a key of `map`, pointed at its value instead.
fn redirect_references(object: &mut Object, map: &HashMap<ObjectId, ObjectId>) {
    match object {
        Object::Reference(id) => {
            if let Some(keep) = map.get(id) {
                *id = *keep;
            }
        }
        Object::Array(items) => items.iter_mut().for_each(|o| redirect_references(o, map)),
        Object::Dictionary(dict) => dict
            .iter_mut()
            .for_each(|(_, o)| redirect_references(o, map)),
        Object::Stream(stream) => stream
            .dict
            .iter_mut()
            .for_each(|(_, o)| redirect_references(o, map)),
        _ => {}
    }
}

/// The stream's single filter, if it has exactly one and no parameters.
fn only_filter(dict: &Dictionary) -> Option<Option<Vec<u8>>> {
    if dict.has(b"DecodeParms") || dict.has(b"DP") {
        return None;
    }
    match dict.get(b"Filter") {
        Err(_) => Some(None),
        Ok(Object::Name(name)) => Some(Some(name.clone())),
        Ok(Object::Array(items)) if items.len() == 1 => {
            items[0].as_name().ok().map(|n| Some(n.to_vec()))
        }
        Ok(Object::Array(items)) if items.is_empty() => Some(None),
        _ => None,
    }
}

/// Stores a plain or Flate stream at the highest Flate level when that is
/// smaller. True when it changed.
fn recompress(stream: &mut Stream) -> bool {
    let plain = match only_filter(&stream.dict) {
        Some(None) => stream.content.clone(),
        Some(Some(name)) if name == b"FlateDecode" => match stream.decompressed_content() {
            Ok(bytes) => bytes,
            Err(_) => return false,
        },
        _ => return false,
    };
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::best());
    if encoder.write_all(&plain).is_err() {
        return false;
    }
    let Ok(packed) = encoder.finish() else {
        return false;
    };
    if packed.len() >= stream.content.len() {
        return false;
    }
    stream
        .dict
        .set("Filter", Object::Name(b"FlateDecode".to_vec()));
    stream.set_content(packed);
    true
}

/// An 8-bit grey or RGB image, JPEG or Flate, bigger than `limit`: resampled
/// to fit and stored as JPEG at `quality`, when that is smaller. Images with a
/// mask, an unusual colour space or decode parameters are left alone.
fn downsample_image(stream: &mut Stream, limit: (u32, u32), quality: u8) -> bool {
    let dict = &stream.dict;
    if !dict.has_type(b"XObject") && !dict.has(b"Subtype") {
        return false;
    }
    if dict.get(b"Subtype").and_then(Object::as_name).ok() != Some(b"Image") {
        return false;
    }
    if dict.has(b"SMask") || dict.has(b"Mask") || dict.has(b"Decode") || dict.has(b"ImageMask") {
        return false;
    }
    let number = |key: &[u8]| dict.get(key).ok().and_then(|v| v.as_i64().ok());
    let (Some(width), Some(height), Some(8)) = (
        number(b"Width"),
        number(b"Height"),
        number(b"BitsPerComponent"),
    ) else {
        return false;
    };
    let (width, height) = (width as u32, height as u32);
    let channels = match dict.get(b"ColorSpace").ok().and_then(|c| c.as_name().ok()) {
        Some(b"DeviceGray") => 1,
        Some(b"DeviceRGB") => 3,
        _ => return false,
    };
    // Fits already: nothing to gain without touching quality.
    let scale = (limit.0 as f32 / width as f32).min(limit.1 as f32 / height as f32);
    if scale >= 1.0 {
        return false;
    }
    let image = match only_filter(dict) {
        Some(Some(name)) if name == b"DCTDecode" => {
            match image::load_from_memory_with_format(&stream.content, image::ImageFormat::Jpeg) {
                Ok(image) => image,
                Err(_) => return false,
            }
        }
        Some(Some(name)) if name == b"FlateDecode" => {
            let Ok(pixels) = stream.decompressed_content() else {
                return false;
            };
            let expected = (width * height * channels) as usize;
            if pixels.len() < expected {
                return false;
            }
            let pixels = pixels[..expected].to_vec();
            let built = if channels == 1 {
                image::GrayImage::from_raw(width, height, pixels)
                    .map(image::DynamicImage::ImageLuma8)
            } else {
                image::RgbImage::from_raw(width, height, pixels).map(image::DynamicImage::ImageRgb8)
            };
            match built {
                Some(image) => image,
                None => return false,
            }
        }
        _ => return false,
    };
    let (w, h) = (
        ((width as f32 * scale).round() as u32).max(1),
        ((height as f32 * scale).round() as u32).max(1),
    );
    let resized = image.resize_exact(w, h, image::imageops::FilterType::Triangle);
    let resized = if channels == 1 {
        image::DynamicImage::ImageLuma8(resized.to_luma8())
    } else {
        image::DynamicImage::ImageRgb8(resized.to_rgb8())
    };
    let mut jpeg = Vec::new();
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, quality);
    if resized.write_with_encoder(encoder).is_err() || jpeg.len() >= stream.content.len() {
        return false;
    }
    stream.dict.set("Width", Object::Integer(i64::from(w)));
    stream.dict.set("Height", Object::Integer(i64::from(h)));
    stream
        .dict
        .set("Filter", Object::Name(b"DCTDecode".to_vec()));
    stream.dict.remove(b"DecodeParms");
    stream.set_content(jpeg);
    true
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Refusal::Protected => "protected",
            Refusal::Signed => "signed",
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn corpus(name: &str) -> Vec<u8> {
        std::fs::read(format!(
            "{}/../../../tests/corpus/arabic/{name}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap()
    }

    fn images(doc: &PdfDocument) -> Vec<(i64, i64, Vec<u8>)> {
        doc.doc
            .objects
            .values()
            .filter_map(|o| o.as_stream().ok())
            .filter(|s| s.dict.get(b"Subtype").and_then(Object::as_name).ok() == Some(b"Image"))
            .map(|s| {
                let n = |k: &[u8]| s.dict.get(k).unwrap().as_i64().unwrap();
                let filter = s
                    .dict
                    .get(b"Filter")
                    .ok()
                    .and_then(|f| f.as_name().ok())
                    .unwrap_or(b"")
                    .to_vec();
                (n(b"Width"), n(b"Height"), filter)
            })
            .collect()
    }

    #[test]
    fn a_300_dpi_scan_comes_down_to_what_150_dpi_needs() {
        let original = corpus("generated/scan-notonaskh-300dpi-skewed-jpeg.pdf");
        let doc = PdfDocument::open(original.clone(), None).unwrap();
        let options = CompressOptions {
            image_dpi: Some(150.0),
            jpeg_quality: 75,
        };
        let (bytes, report) = doc.compressed(&options).unwrap();
        assert_eq!(report.images, 2);
        assert!(
            bytes.len() * 2 < original.len(),
            "{} -> {} bytes",
            original.len(),
            bytes.len()
        );
        let out = PdfDocument::open(bytes, None).unwrap();
        assert_eq!(out.page_count(), 2);
        for (w, h, filter) in images(&out) {
            // A4 at 150 dpi is 1240 x 1754.
            assert!(w <= 1241 && h <= 1755, "{w} x {h}");
            assert_eq!(filter, b"DCTDecode");
        }
    }

    #[test]
    fn without_the_image_option_every_image_stays_as_it_was() {
        let original = corpus("generated/scan-notonaskh-300dpi-skewed-jpeg.pdf");
        let doc = PdfDocument::open(original, None).unwrap();
        let before = images(&doc);
        let (bytes, report) = doc.compressed(&CompressOptions::default()).unwrap();
        assert_eq!(report.images, 0);
        assert_eq!(images(&PdfDocument::open(bytes, None).unwrap()), before);
    }

    #[test]
    fn a_text_document_keeps_every_page_and_gets_no_bigger() {
        for name in [
            "realworld/A_un_rome_statute_A-CONF.183-9-AR_word_pdfmaker6.pdf",
            "realworld/A_worldbank_malpass_g7_briefing_AR_word2016_pdftools.pdf",
            "generated/perf-text-100-pages.pdf",
        ] {
            let original = corpus(name);
            let doc = PdfDocument::open(original.clone(), None).unwrap();
            let (bytes, report) = doc.compressed(&CompressOptions::default()).unwrap();
            if report.unchanged {
                assert_eq!(bytes, original, "{name}: handed back as it was");
            }
            let out = PdfDocument::open(bytes.clone(), None).unwrap();
            assert_eq!(out.page_count(), doc.page_count(), "{name}");
            assert!(
                bytes.len() <= original.len(),
                "{name}: {} -> {}",
                original.len(),
                bytes.len()
            );
        }
    }

    #[test]
    fn a_file_combined_with_itself_shares_what_it_repeats() {
        let three = corpus("generated/chrome-notonaskh-justified-3pages.pdf");
        let doc = PdfDocument::open(three.clone(), None).unwrap();
        let mut twice = doc.detached_copy();
        twice.append_document(&doc).unwrap();
        let (bytes, report) = twice.compressed(&CompressOptions::default()).unwrap();
        assert!(report.duplicates > 0, "{report:?}");
        assert_eq!(
            PdfDocument::open(bytes.clone(), None).unwrap().page_count(),
            6
        );
        assert!(
            bytes.len() < three.len() * 3 / 2,
            "{} vs {}",
            bytes.len(),
            three.len()
        );
    }

    #[test]
    fn a_protected_file_is_refused_rather_than_unprotected() {
        let doc = PdfDocument::open(
            corpus("generated/variant-encrypted-aes256.pdf"),
            Some("warraq"),
        )
        .unwrap();
        assert_eq!(doc.compress_refusal(), Some(Refusal::Protected));
        assert!(doc.compressed(&CompressOptions::default()).is_err());
    }
}
