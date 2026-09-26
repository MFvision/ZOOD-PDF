//! New PDFs from scanned images (Scan from files / camera): one page per image, the image drawn
//! full-page, plus the invisible OCR text layer.

use super::jpeg::jpeg_info;
use super::layer::{add_text_layer, text_string, ImageFrame, OcrWord};
use crate::CoreError;
use flate2::write::ZlibEncoder;
use flate2::Compression;
use serde::Deserialize;
use std::io::Write;
use warraq_pdf::builder::empty_pdf;
use warraq_pdf::lopdf::{Dictionary, Object, Stream};
use warraq_pdf::{pages, Pdf, Protection};

/// Most pages in one scan.
pub const MAX_PAGES: usize = 500;
/// Largest image side (pixels).
pub const MAX_SIDE: u32 = 20_000;
/// Largest image area (pixels).
pub const MAX_PIXELS: u64 = 100_000_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageSpec {
    /// `jpeg` (embedded unchanged) or `gray` (8-bit samples, row-major).
    pub format: String,
    /// Index into the call's blobs.
    pub blob: usize,
    pub pixel_width: Option<u32>,
    pub pixel_height: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NewPage {
    pub image: ImageSpec,
    pub image_dpi: f64,
    #[serde(default)]
    pub words: Vec<OcrWord>,
    /// Skew (degrees, counter-clockwise) of the content in the embedded image; 0 when deskewed.
    #[serde(default)]
    pub angle: f64,
    #[serde(default)]
    pub min_conf: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateParams {
    pub pages: Vec<NewPage>,
    pub title: Option<String>,
    /// BCP 47 language of the document (catalog /Lang).
    pub lang: Option<String>,
}

fn check_size(w: u32, h: u32) -> Result<(), CoreError> {
    if w == 0 || h == 0 || w > MAX_SIDE || h > MAX_SIDE || u64::from(w) * u64::from(h) > MAX_PIXELS
    {
        return Err(CoreError::params(format!(
            "images must be 1–{MAX_SIDE} pixels a side and at most {MAX_PIXELS} pixels"
        )));
    }
    Ok(())
}

/// Image XObject for one page: `(stream, width, height)`.
fn image_object(
    spec: &ImageSpec,
    blobs: &mut [Option<Vec<u8>>],
) -> Result<(Stream, u32, u32), CoreError> {
    let data = blobs
        .get_mut(spec.blob)
        .and_then(Option::take)
        .ok_or_else(|| {
            CoreError::params(format!("blobs[{}] is missing (or used twice)", spec.blob))
        })?;
    let mut d = Dictionary::new();
    d.set("Type", Object::Name(b"XObject".to_vec()));
    d.set("Subtype", Object::Name(b"Image".to_vec()));
    match spec.format.as_str() {
        "jpeg" => {
            let info = jpeg_info(&data)
                .ok_or_else(|| CoreError::params("the image is not a readable JPEG"))?;
            check_size(info.width, info.height)?;
            let cs: &[u8] = match (info.components, info.bits) {
                (1, 8) => b"DeviceGray",
                (3, 8) => b"DeviceRGB",
                _ => {
                    return Err(CoreError::params(
                        "only 8-bit gray or colour JPEGs are supported",
                    ))
                }
            };
            d.set("Width", Object::Integer(i64::from(info.width)));
            d.set("Height", Object::Integer(i64::from(info.height)));
            d.set("ColorSpace", Object::Name(cs.to_vec()));
            d.set("BitsPerComponent", Object::Integer(8));
            d.set("Filter", Object::Name(b"DCTDecode".to_vec()));
            Ok((
                Stream::new(d, data).with_compression(false),
                info.width,
                info.height,
            ))
        }
        "gray" => {
            let (w, h) = match (spec.pixel_width, spec.pixel_height) {
                (Some(w), Some(h)) => (w, h),
                _ => {
                    return Err(CoreError::params(
                        "gray images need pixelWidth and pixelHeight",
                    ))
                }
            };
            check_size(w, h)?;
            let (wu, hu) = (w as usize, h as usize);
            if data.len() != wu * hu {
                return Err(CoreError::params(
                    "gray image data must be pixelWidth × pixelHeight bytes",
                ));
            }
            let bilevel = data.iter().all(|&v| v == 0 || v == 255);
            let (bits, raw) = if bilevel {
                let row = wu.div_ceil(8);
                let mut packed = vec![0u8; row * hu];
                for (src, dst) in data.chunks_exact(wu).zip(packed.chunks_exact_mut(row)) {
                    for (x, &v) in src.iter().enumerate() {
                        if v != 0 {
                            if let Some(b) = dst.get_mut(x / 8) {
                                *b |= 0x80 >> (x % 8);
                            }
                        }
                    }
                }
                (1, packed)
            } else {
                (8, data)
            };
            let mut enc = ZlibEncoder::new(Vec::new(), Compression::default());
            enc.write_all(&raw)
                .and_then(|_| enc.flush())
                .map_err(|e| CoreError::new("internal_error", e.to_string()))?;
            let z = enc
                .finish()
                .map_err(|e| CoreError::new("internal_error", e.to_string()))?;
            d.set("Width", Object::Integer(i64::from(w)));
            d.set("Height", Object::Integer(i64::from(h)));
            d.set("ColorSpace", Object::Name(b"DeviceGray".to_vec()));
            d.set("BitsPerComponent", Object::Integer(bits));
            d.set("Filter", Object::Name(b"FlateDecode".to_vec()));
            Ok((Stream::new(d, z).with_compression(false), w, h))
        }
        other => Err(CoreError::params(format!("unknown image format {other:?}"))),
    }
}

/// Builds the new document (a single revision).
pub fn create_pdf(p: &CreateParams, blobs: Vec<Vec<u8>>) -> Result<Vec<u8>, CoreError> {
    if p.pages.is_empty() || p.pages.len() > MAX_PAGES {
        return Err(CoreError::params(format!("give 1–{MAX_PAGES} pages")));
    }
    for pg in &p.pages {
        if !pg.image_dpi.is_finite() || !(10.0..=2400.0).contains(&pg.image_dpi) {
            return Err(CoreError::params("imageDpi must be 10–2400"));
        }
    }
    let mut blobs: Vec<Option<Vec<u8>>> = blobs.into_iter().map(Some).collect();
    let mut pdf = Pdf::open(empty_pdf()?, None)?;
    for (i, pg) in p.pages.iter().enumerate() {
        let (img, w, h) = image_object(&pg.image, &mut blobs)?;
        let (wpt, hpt) = (
            f64::from(w) * 72.0 / pg.image_dpi,
            f64::from(h) * 72.0 / pg.image_dpi,
        );
        if !(1.0..=14_400.0).contains(&wpt) || !(1.0..=14_400.0).contains(&hpt) {
            return Err(CoreError::params(
                "page size must be 1–14400 points (check imageDpi)",
            ));
        }
        let page_id = pages::insert_blank(&mut pdf, i, wpt, hpt)?;
        let img_id = pdf.add(Object::Stream(img));
        let draw = format!("q {wpt:.4} 0 0 {hpt:.4} 0 0 cm /Im0 Do Q\n");
        let content = pdf.add(Object::Stream(Stream::new(
            Dictionary::new(),
            draw.into_bytes(),
        )));
        let mut xo = Dictionary::new();
        xo.set("Im0", Object::Reference(img_id));
        let mut res = Dictionary::new();
        res.set("XObject", Object::Dictionary(xo));
        let mut page = pdf
            .get_dict(page_id)
            .cloned()
            .ok_or_else(|| CoreError::new("structure_error", "new page missing"))?;
        page.set("Resources", Object::Dictionary(res));
        page.set("Contents", Object::Reference(content));
        pdf.set(page_id, Object::Dictionary(page));
        let frame = ImageFrame {
            width: Some(f64::from(w)),
            height: Some(f64::from(h)),
            dpi: None,
            angle: pg.angle,
            rotation: Some(0),
        };
        add_text_layer(&mut pdf, i, &frame, &pg.words, pg.min_conf)?;
    }
    let root = pdf.root_id()?;
    let mut cat = pdf.catalog()?.clone();
    if let Some(lang) = p.lang.as_deref().filter(|l| !l.is_empty() && l.len() <= 35) {
        cat.set("Lang", text_string(lang));
    }
    cat.set("ViewerPreferences", {
        let mut vp = Dictionary::new();
        vp.set("DisplayDocTitle", Object::Boolean(true));
        Object::Dictionary(vp)
    });
    pdf.set(root, Object::Dictionary(cat));
    if let Some(title) = p.title.as_deref().filter(|t| !t.is_empty()) {
        let title: String = title.chars().take(512).collect();
        let mut changes = std::collections::BTreeMap::new();
        changes.insert("Title".to_string(), Some(title));
        warraq_pdf::metadata::set_info(&mut pdf, &changes)?;
    }
    Ok(pdf.write_full(Protection::Keep)?)
}
