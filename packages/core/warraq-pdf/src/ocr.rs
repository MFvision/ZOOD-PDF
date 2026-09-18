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
use crate::ops::{add_font_resource, mark_page_objects, reset_state_ops, tj_items};
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

fn parse(e: impl std::fmt::Display) -> Error {
    Error::Parse(e.to_string())
}

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
                let [a, b, c, d, e, f] = frame.text_matrix(x0.min(x1), baseline, stretch);
                ops.push(Operation::new(
                    "Tf",
                    vec![Object::Name(name.clone()), Object::Real(size)],
                ));
                ops.push(Operation::new(
                    "Tm",
                    [a, b, c, d, e, f]
                        .iter()
                        .map(|v| Object::Real(*v))
                        .collect(),
                ));
                ops.push(Operation::new(
                    "TJ",
                    vec![Object::Array(tj_items(&subset, &shaper, glyphs))],
                ));
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

    /// How the page as shown maps onto its user space: its crop box and turn.
    fn display_frame(&self, index: usize) -> Result<Frame> {
        let id = self.page_id(index)?;
        let dict = self.doc.get_dictionary(id).map_err(parse)?;
        let rect = |key: &[u8]| {
            let mut value = dict.get(key).ok().cloned();
            let mut node = dict.get(b"Parent").ok().and_then(|p| p.as_reference().ok());
            while value.is_none() {
                let parent = self.doc.get_dictionary(node?).ok()?;
                value = parent.get(key).ok().cloned();
                node = parent
                    .get(b"Parent")
                    .ok()
                    .and_then(|p| p.as_reference().ok());
            }
            let value = match value? {
                Object::Reference(r) => self.doc.get_object(r).ok()?.clone(),
                other => other,
            };
            let v: Vec<f32> = value
                .as_array()
                .ok()?
                .iter()
                .filter_map(|n| n.as_float().ok())
                .collect();
            (v.len() == 4).then(|| {
                [
                    v[0].min(v[2]),
                    v[1].min(v[3]),
                    v[0].max(v[2]),
                    v[1].max(v[3]),
                ]
            })
        };
        let media = rect(b"MediaBox").unwrap_or([0.0, 0.0, 612.0, 792.0]);
        let crop = rect(b"CropBox").unwrap_or(media);
        Ok(Frame {
            crop: [
                crop[0].max(media[0]),
                crop[1].max(media[1]),
                crop[2].min(media[2]),
                crop[3].min(media[3]),
            ],
            turn: self.page_rotation(index)?,
        })
    }
}

/// The crop box `[x0, y0, x1, y1]` in user space, and the page's `/Rotate`.
struct Frame {
    crop: [f32; 4],
    turn: i64,
}

impl Frame {
    /// User space of a point given from the top-left of the page as shown.
    fn user(&self, x: f32, y: f32) -> (f32, f32) {
        let [cx0, cy0, cx1, cy1] = self.crop;
        match self.turn {
            90 => (cx0 + y, cy0 + x),
            180 => (cx1 - x, cy0 + y),
            270 => (cx1 - y, cy1 - x),
            _ => (cx0 + x, cy1 - y),
        }
    }

    /// A text matrix that writes left to right along the page as shown,
    /// starting at (`x`, `baseline`) there, stretched by `stretch`.
    fn text_matrix(&self, x: f32, baseline: f32, stretch: f32) -> [f32; 6] {
        // Along the line, and up, in user space, for each turn.
        let (along, up) = match self.turn {
            90 => ((0.0, 1.0), (-1.0, 0.0)),
            180 => ((-1.0, 0.0), (0.0, -1.0)),
            270 => ((0.0, -1.0), (1.0, 0.0)),
            _ => ((1.0, 0.0), (0.0, 1.0)),
        };
        let (e, f) = self.user(x, baseline);
        [along.0 * stretch, along.1 * stretch, up.0, up.1, e, f]
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
    fn a_frame_maps_the_page_as_shown_onto_user_space_for_every_turn() {
        let crop = [0.0, 0.0, 600.0, 800.0];
        let at = |turn, x, y| Frame { crop, turn }.user(x, y);
        // The top-left corner as shown.
        assert_eq!(at(0, 0.0, 0.0), (0.0, 800.0));
        assert_eq!(at(90, 0.0, 0.0), (0.0, 0.0));
        assert_eq!(at(180, 0.0, 0.0), (600.0, 0.0));
        assert_eq!(at(270, 0.0, 0.0), (600.0, 800.0));
        // Shown 90° turned, the page is 800 wide: its top-right corner is the
        // user-space top-left.
        assert_eq!(at(90, 800.0, 0.0), (0.0, 800.0));
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
