//! The text layer of Scan & OCR.
//!
//! A recogniser (Tesseract, in the interface) reads the words off a scanned
//! page; this writes them into the page as invisible text — render mode 3,
//! neither filled nor stroked — each word over the place it was read from,
//! shaped and in an embedded subset of a bundled face with a correct
//! ToUnicode. The page looks exactly as it did, and can now be searched,
//! selected, copied and read aloud.
//!
//! The layer is marked (`/WarraqOCR BMC … EMC`), so a page that already has
//! one is left alone rather than given a second.
use lopdf::content::{Content, Operation};
use lopdf::Object;
use warraq_text::{ShapedGlyph, Shaper};

use crate::fonts::{embed_subset_font, FontSubset};
use crate::ops::{add_font_resource, mark_page_objects, reset_state_ops};
use crate::show::{show_line, ShownLine};
use crate::{Error, PdfDocument, Result};

/// A word the recogniser read, and where: its box in points from the page's
/// top-left corner as the page is shown (after `/Rotate`), `[x0, top, x1, bottom]`.
#[derive(Debug, Clone, PartialEq)]
pub struct OcrWord {
    pub text: String,
    pub bbox: [f32; 4],
}

/// The words of one page, in reading order.
#[derive(Debug, Clone, PartialEq)]
pub struct OcrPage {
    pub index: usize,
    pub words: Vec<OcrWord>,
    /// How far the scan is turned, in degrees counter-clockwise as shown.
    /// Its words were read off it straightened, and their boxes are in that
    /// straightened page; the layer is turned back by this about the page's
    /// centre, so it lies over the crooked words.
    pub angle: f32,
}

/// What a text layer run wrote.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct OcrReport {
    pub pages: usize,
    pub words: usize,
    /// Pages that already had Warraq's layer and were left alone.
    pub skipped: usize,
}

const MARK: &[u8] = b"WarraqOCR";
/// Of a word box's height, how much the font size is; the rest is room for
/// the ascenders and descenders a recogniser includes in the box.
const SIZE_OF_BOX: f32 = 0.9;
/// Where the baseline sits, as a share of the box height up from its bottom.
const BASELINE_UP: f32 = 0.22;

impl PdfDocument {
    /// Whether page `index` already carries a text layer from Warraq.
    pub fn has_ocr_layer(&self, index: usize) -> Result<bool> {
        let content = self.doc.get_page_content(self.page_id(index)?);
        let needle = [b"/".as_slice(), MARK].concat();
        Ok(content.windows(needle.len()).any(|w| w == needle))
    }

    /// Writes `pages`' words as an invisible text layer in `font`. Pages that
    /// already have one are skipped. See the module documentation.
    pub fn add_text_layer(&mut self, pages: &[OcrPage], font: &[u8]) -> Result<OcrReport> {
        let mut report = OcrReport::default();
        let mut todo = Vec::new();
        for page in pages {
            if page.words.iter().all(|w| w.text.trim().is_empty()) {
                continue;
            }
            if self.has_ocr_layer(page.index)? {
                report.skipped += 1;
                continue;
            }
            todo.push(page);
        }
        if todo.is_empty() {
            return Ok(report);
        }
        let shaper = Shaper::new(font).map_err(|e| Error::Font(e.to_string()))?;
        let shaped: Vec<Vec<Vec<ShapedGlyph>>> = todo
            .iter()
            .map(|page| {
                page.words
                    .iter()
                    .map(|w| shaper.shape_line(w.text.trim()))
                    .collect()
            })
            .collect();
        let all: Vec<ShapedGlyph> = shaped.iter().flatten().flatten().cloned().collect();
        let subset = FontSubset::build(font, &shaper, &all)?;
        let font_id = embed_subset_font(&mut self.doc, &shaper, &subset, "WarraqOcr");

        for (page, words) in todo.iter().zip(&shaped) {
            let page_id = self.page_id(page.index)?;
            let frame = self.display_frame(page.index)?;
            let name = add_font_resource(self, page_id, font_id)?;
            let mut ops = reset_state_ops(self, page_id);
            ops.push(Operation::new("q", vec![]));
            if page.angle != 0.0 {
                ops.push(Operation::new(
                    "cm",
                    frame
                        .turn_about_centre(page.angle)
                        .iter()
                        .map(|v| Object::Real(*v))
                        .collect(),
                ));
            }
            ops.push(Operation::new("BMC", vec![Object::Name(MARK.to_vec())]));
            ops.push(Operation::new("BT", vec![]));
            ops.push(Operation::new("Tr", vec![3.into()]));
            for (word, glyphs) in page.words.iter().zip(words) {
                if glyphs.is_empty() {
                    continue;
                }
                let [x0, top, x1, bottom] = word.bbox;
                let height = (bottom - top).abs().max(1.0);
                let size = height * SIZE_OF_BOX;
                let natural = glyphs.iter().map(|g| g.x_advance).sum::<f32>() / 1000.0 * size;
                let stretch = if natural > 0.01 {
                    (x1 - x0).abs() / natural
                } else {
                    1.0
                };
                let baseline = bottom.max(top) - height * BASELINE_UP;
                ops.push(Operation::new(
                    "Tf",
                    vec![Object::Name(name.clone()), Object::Real(size)],
                ));
                // Invisible, but read: a word its glyphs do not spell carries
                // its text, so it is found by search like any other (show.rs).
                show_line(
                    &mut ops,
                    &subset,
                    &shaper,
                    &ShownLine {
                        glyphs,
                        matrix: frame.text_matrix(x0.min(x1), baseline, stretch),
                        size,
                        space_stretch: 0.0,
                    },
                );
                report.words += 1;
            }
            ops.push(Operation::new("ET", vec![]));
            ops.push(Operation::new("EMC", vec![]));
            ops.push(Operation::new("Q", vec![]));
            let mut content = self.doc.get_page_content(page_id);
            content.push(b'\n');
            content.extend(
                Content { operations: ops }
                    .encode()
                    .map_err(|e| Error::Edit(e.to_string()))?,
            );
            self.doc
                .change_page_content(page_id, content)
                .map_err(|e| Error::Edit(e.to_string()))?;
            mark_page_objects(self, page_id);
            report.pages += 1;
        }
        Ok(report)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const AMIRI: &[u8] = include_bytes!("../../../../tests/fonts/Amiri-Regular.ttf");

    fn corpus(name: &str) -> Vec<u8> {
        std::fs::read(format!(
            "{}/../../../tests/corpus/arabic/generated/{name}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap()
    }

    fn words() -> Vec<OcrWord> {
        vec![
            OcrWord {
                text: "مرحبا".into(),
                bbox: [300.0, 100.0, 380.0, 120.0],
            },
            OcrWord {
                text: "بالعالم".into(),
                bbox: [200.0, 100.0, 290.0, 120.0],
            },
            OcrWord {
                text: "OCR 2026".into(),
                bbox: [72.0, 140.0, 150.0, 156.0],
            },
        ]
    }

    #[test]
    fn words_become_invisible_text_that_survives_a_save_and_is_not_written_twice() {
        let original = corpus("scan-arial-200dpi-bilevel.pdf");
        let mut doc = PdfDocument::open(original.clone(), None).unwrap();
        assert!(!doc.has_ocr_layer(0).unwrap());
        let report = doc
            .add_text_layer(
                &[OcrPage {
                    index: 0,
                    words: words(),
                    angle: 0.0,
                }],
                AMIRI,
            )
            .unwrap();
        assert_eq!(
            report,
            OcrReport {
                pages: 1,
                words: 3,
                skipped: 0
            }
        );
        assert!(doc.has_ocr_layer(0).unwrap());

        let content = doc.doc.get_page_content(doc.page_id(0).unwrap());
        let ops = Content::decode(&content).unwrap().operations;
        assert!(
            ops.iter()
                .any(|op| op.operator == "Tr" && op.operands[0].as_i64().ok() == Some(3)),
            "render mode 3: invisible"
        );
        assert_eq!(ops.iter().filter(|op| op.operator == "TJ").count(), 3);

        let saved = doc.save_incremental().unwrap();
        assert!(saved.starts_with(&original));
        let mut back = PdfDocument::open(saved, None).unwrap();
        assert!(back.has_ocr_layer(0).unwrap());
        let again = back
            .add_text_layer(
                &[OcrPage {
                    index: 0,
                    words: words(),
                    angle: 0.0,
                }],
                AMIRI,
            )
            .unwrap();
        assert_eq!(
            again,
            OcrReport {
                pages: 0,
                words: 0,
                skipped: 1
            }
        );
    }
}
