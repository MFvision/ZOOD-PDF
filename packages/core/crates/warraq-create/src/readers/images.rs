//! Pictures → pages. Each picture (and each TIFF page) becomes one PDF page sized by the file's
//! resolution (96 dpi for JPEG/PNG without one, 72 dpi for TIFF without one).

use super::tiff;
use crate::error::Result;
use crate::image;
use crate::model::{Content, Document, FixedPage, Frame, FrameContent, PageSetup, Section};

fn alt_of(name: &str) -> String {
    let stem = name.rsplit(['/', '\\']).next().unwrap_or(name);
    stem.chars().take(200).collect()
}

/// A JPEG or PNG → one page.
pub fn read_picture(bytes: &[u8], name: &str) -> Result<Document> {
    let img = image::decode(bytes)?;
    let (w, h) = img.natural_size();
    let mut doc = Document::default();
    let idx = doc.add_image(img);
    doc.sections.push(Section {
        page: PageSetup::with_size(w, h, 0.0),
        content: Content::Fixed(vec![FixedPage {
            width: w,
            height: h,
            frames: vec![Frame {
                x: 0.0,
                y: 0.0,
                width: w,
                height: h,
                content: FrameContent::Image {
                    image: idx,
                    alt: alt_of(name),
                },
            }],
            background: None,
        }]),
        page_from_source: true,
    });
    Ok(doc)
}

/// A (multi-page) TIFF → one page per TIFF page; CCITT strips stay CCITT.
pub fn read_tiff(bytes: &[u8], name: &str) -> Result<Document> {
    let pages = tiff::read(bytes)?;
    let mut doc = Document::default();
    let mut fixed = Vec::with_capacity(pages.len());
    let alt = alt_of(name);
    for (n, p) in pages.into_iter().enumerate() {
        let (w, h) = p.size_pt();
        let py = h / f64::from(p.height.max(1));
        let mut frames = Vec::new();
        for band in p.bands {
            let bh = f64::from(band.image.height) * py;
            let y = f64::from(band.row) * py;
            let idx = doc.add_image(band.image);
            frames.push(Frame {
                x: 0.0,
                y,
                width: w,
                height: bh,
                content: FrameContent::Image {
                    image: idx,
                    alt: format!("{alt} ({})", n + 1),
                },
            });
        }
        fixed.push(FixedPage {
            width: w,
            height: h,
            frames,
            background: None,
        });
    }
    let first = fixed
        .first()
        .map_or((595.0, 842.0), |p| (p.width, p.height));
    doc.sections.push(Section {
        page: PageSetup::with_size(first.0, first.1, 0.0),
        content: Content::Fixed(fixed),
        page_from_source: true,
    });
    Ok(doc)
}
