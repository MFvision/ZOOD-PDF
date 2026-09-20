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
//! one is left alone rather than given a second — unless the new reading is
//! meant to replace it (a corrected one), when the old layer is taken out of
//! the page's streams first. The words and their boxes are also kept in the
//! page's private data (`/PieceInfo /Warraq`, ISO 32000 §14.5), so a layer
//! can be corrected later without reading the scan again.
//!
//! A cleaned-up scan can take the place of the page's own picture: a page
//! that is only a picture over the whole page gets the cleaned one, drawn
//! over the whole page, and its words are then written level.
use lopdf::content::{Content, Operation};
use lopdf::{dictionary, Dictionary, Object, ObjectId, Stream};
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
    /// Take out a layer Warraq wrote on the page before and write this one
    /// in its place (a corrected reading), instead of leaving the page alone.
    pub replace: bool,
    /// The scan cleaned up, PNG or JPEG: the whole page as shown, turned
    /// level by `angle`. It takes the place of the page's own picture when
    /// the page is one picture over the whole page, and the words are then
    /// written level; otherwise the page keeps its picture.
    pub image: Option<Vec<u8>>,
}

/// What a text layer run wrote.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct OcrReport {
    pub pages: usize,
    pub words: usize,
    /// Pages that already had Warraq's layer and were left alone.
    pub skipped: usize,
    /// Pages whose picture was replaced by the cleaned-up one.
    pub images: usize,
    /// Pages given a cleaned-up picture that is not the only thing on them,
    /// and so kept their own.
    pub images_kept: usize,
}

const MARK: &[u8] = b"WarraqOCR";
/// Warraq's entry in a page's `/PieceInfo`, and the key of the words in it.
const PIECE_INFO: &[u8] = b"PieceInfo";
const PIECE: &[u8] = b"Warraq";
const WORDS: &[u8] = b"OCR";
/// The most words read back from a page's private data, and the most bytes.
const MAX_WORDS: usize = 50_000;
const MAX_WORDS_BYTES: usize = 8 * 1024 * 1024;
/// How much of the page a picture must cover to be the scan of it.
const SCAN_COVERS: f32 = 0.85;
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
    /// already have one are skipped, unless `replace` asks for the old one to
    /// be taken out first. See the module documentation.
    pub fn add_text_layer(&mut self, pages: &[OcrPage], font: &[u8]) -> Result<OcrReport> {
        self.add_text_layer_at(pages, font, "D:20000101000000Z")
    }

    /// `add_text_layer`, dating the page's private data `modified` (a PDF
    /// date, `D:YYYYMMDDHHmmSSZ`): the core has no clock of its own.
    pub fn add_text_layer_at(
        &mut self,
        pages: &[OcrPage],
        font: &[u8],
        modified: &str,
    ) -> Result<OcrReport> {
        let mut report = OcrReport::default();
        let mut todo: Vec<OcrPage> = Vec::new();
        for page in pages {
            if page.words.iter().all(|w| w.text.trim().is_empty()) {
                continue;
            }
            if self.has_ocr_layer(page.index)? {
                if !page.replace {
                    report.skipped += 1;
                    continue;
                }
                self.strip_ocr_layer(page.index)?;
            }
            let mut page = page.clone();
            if let Some(image) = page.image.take() {
                if self.replace_scan(page.index, &image)? {
                    report.images += 1;
                    // The picture now is the straightened page.
                    page.angle = 0.0;
                } else {
                    report.images_kept += 1;
                }
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
            self.keep_words(page_id, page, modified)?;
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

    /// Takes Warraq's text layer out of page `index`'s streams — `q`, its
    /// turn, the marked sequence and its `Q` — leaving every other byte as it
    /// is. Returns whether there was one.
    pub fn strip_ocr_layer(&mut self, index: usize) -> Result<bool> {
        let page_id = self.page_id(index)?;
        let mut found = false;
        for id in self.content_ids(page_id) {
            let Ok(bytes) = self.stream_bytes(id) else {
                continue;
            };
            if !bytes.windows(MARK.len()).any(|w| w == MARK) {
                continue;
            }
            // A stream too large to lex is refused rather than half-edited.
            let ops = crate::lex::lex(&bytes)?;
            let mut cut: Vec<std::ops::Range<usize>> = Vec::new();
            let mut k = 0;
            while k < ops.len() {
                if !(ops[k].is("BMC") && ops[k].name(0) == Some(MARK)) {
                    k += 1;
                    continue;
                }
                let mut depth = 0usize;
                let mut end = None;
                for (j, op) in ops.iter().enumerate().skip(k) {
                    if op.is("BDC") || op.is("BMC") {
                        depth += 1;
                    } else if op.is("EMC") {
                        depth = depth.saturating_sub(1);
                        if depth == 0 {
                            end = Some(j);
                            break;
                        }
                    }
                }
                let Some(mut last) = end else { break };
                // Written as `q [cm] /WarraqOCR BMC … EMC Q`.
                let mut first = k;
                if first >= 2 && ops[first - 1].is("cm") && ops[first - 2].is("q") {
                    first -= 2;
                } else if first >= 1 && ops[first - 1].is("q") {
                    first -= 1;
                }
                if first < k && ops.get(last + 1).is_some_and(|op| op.is("Q")) {
                    last += 1;
                }
                cut.push(ops[first].range.start..ops[last].range.end);
                k = last + 1;
            }
            if cut.is_empty() {
                continue;
            }
            let mut out = Vec::with_capacity(bytes.len());
            let mut at = 0;
            for r in cut {
                out.extend_from_slice(&bytes[at..r.start]);
                at = r.end;
            }
            out.extend_from_slice(&bytes[at..]);
            self.set_stream_bytes(id, out)?;
            found = true;
        }
        if found {
            mark_page_objects(self, page_id);
        }
        Ok(found)
    }

    /// Puts `picture` in place of page `index`'s scan: the one picture that
    /// covers most of the page, not used anywhere else. The new one is drawn
    /// over the whole page as shown. Returns false — and changes nothing —
    /// when the page is not such a scan.
    pub fn replace_scan(&mut self, index: usize, picture: &[u8]) -> Result<bool> {
        let (w, h) = self.page_size(index)?;
        if w <= 0.0 || h <= 0.0 {
            return Ok(false);
        }
        // The share of the page the unit square covers, carried by `m`.
        let covering = |m: [f32; 6]| -> f32 {
            let corners = [(0.0f32, 0.0f32), (1.0, 0.0), (0.0, 1.0), (1.0, 1.0)]
                .map(|(u, v)| (m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]));
            let (mut x0, mut x1, mut y0, mut y1) = (f32::MAX, f32::MIN, f32::MAX, f32::MIN);
            for (x, y) in corners {
                x0 = x0.min(x);
                x1 = x1.max(x);
                y0 = y0.min(y);
                y1 = y1.max(y);
            }
            let across = (x1.min(w) - x0.max(0.0)).max(0.0);
            let down = (y1.min(h) - y0.max(0.0)).max(0.0);
            across * down / (w * h)
        };
        let images = self.list_images(index)?;
        let scans: Vec<_> = images
            .iter()
            .filter(|i| covering(i.matrix) >= SCAN_COVERS)
            .collect();
        // One picture over the page, of its own: anything else is not a scan
        // to swap, and the page keeps what it has.
        let [scan] = scans.as_slice() else {
            return Ok(false);
        };
        if scan.shared || scan.in_form {
            return Ok(false);
        }
        let id = scan.id.clone();
        // Checked before anything changes: a picture that cannot be read
        // must not leave the page without its scan.
        crate::picture::add_picture(&mut lopdf::Document::with_version("1.7"), picture)?;
        self.delete_image(index, &id)?;
        self.add_image(index, [w, 0.0, 0.0, -h, 0.0, h], picture)?;
        Ok(true)
    }

    /// Keeps `page`'s words in the page's private data, for a later correction.
    fn keep_words(&mut self, page_id: ObjectId, page: &OcrPage, modified: &str) -> Result<()> {
        let mut text = format!("angle\t{}\n", page.angle);
        for word in &page.words {
            let clean: String = word
                .text
                .chars()
                .map(|c| {
                    if matches!(c, '\t' | '\n' | '\r') {
                        ' '
                    } else {
                        c
                    }
                })
                .collect();
            let [x0, y0, x1, y1] = word.bbox;
            text.push_str(&format!("{x0}\t{y0}\t{x1}\t{y1}\t{clean}\n"));
        }
        let mut stream = Stream::new(dictionary! {}, text.into_bytes());
        let _ = stream.compress();
        let words = self.doc.add_object(stream);
        let date = Object::string_literal(modified);
        let mut piece = match self
            .doc
            .get_dictionary(page_id)
            .ok()
            .and_then(|p| p.get(PIECE_INFO).ok())
        {
            Some(Object::Dictionary(d)) => d.clone(),
            Some(Object::Reference(id)) => {
                self.doc.get_dictionary(*id).cloned().unwrap_or_default()
            }
            _ => Dictionary::new(),
        };
        piece.set(
            PIECE,
            dictionary! {
                "LastModified" => date.clone(),
                "Private" => dictionary! { "OCR" => words },
            },
        );
        let dict = self
            .doc
            .get_dictionary_mut(page_id)
            .map_err(|e| Error::Edit(e.to_string()))?;
        dict.set(PIECE_INFO, piece);
        // Required beside `/PieceInfo` (ISO 32000-1, table 30).
        dict.set("LastModified", date);
        self.mark_touched(page_id);
        Ok(())
    }

    /// The words of the layer Warraq wrote on page `index`, as they were kept
    /// with it; `None` when the page has no such layer or no words kept.
    pub fn ocr_layer_words(&self, index: usize) -> Result<Option<OcrPage>> {
        if !self.has_ocr_layer(index)? {
            return Ok(None);
        }
        let page_id = self.page_id(index)?;
        let resolve = |o: &Object| -> Option<Dictionary> {
            match o {
                Object::Dictionary(d) => Some(d.clone()),
                Object::Reference(id) => self.doc.get_dictionary(*id).ok().cloned(),
                _ => None,
            }
        };
        let Some(stream_id) = self
            .doc
            .get_dictionary(page_id)
            .ok()
            .and_then(|p| p.get(PIECE_INFO).ok())
            .and_then(resolve)
            .and_then(|piece| piece.get(PIECE).ok().and_then(resolve))
            .and_then(|ours| ours.get(b"Private").ok().and_then(resolve))
            .and_then(|private| private.get(WORDS).ok().and_then(|o| o.as_reference().ok()))
        else {
            return Ok(None);
        };
        let Ok(stream) = self.doc.get_object(stream_id).and_then(Object::as_stream) else {
            return Ok(None);
        };
        let bytes = if stream.dict.get(b"Filter").is_ok() {
            match stream.decompressed_content_with_limit(MAX_WORDS_BYTES) {
                Ok(b) => b,
                Err(_) => return Ok(None),
            }
        } else {
            stream.content.clone()
        };
        let text = String::from_utf8_lossy(&bytes[..bytes.len().min(MAX_WORDS_BYTES)]);
        let mut page = OcrPage {
            index,
            words: Vec::new(),
            angle: 0.0,
            replace: false,
            image: None,
        };
        for line in text.lines().take(MAX_WORDS + 1) {
            let mut parts = line.splitn(5, '\t');
            let first = parts.next().unwrap_or_default();
            if first == "angle" {
                page.angle = parts
                    .next()
                    .and_then(|a| a.parse::<f32>().ok())
                    .filter(|a| a.is_finite() && a.abs() <= 45.0)
                    .unwrap_or(0.0);
                continue;
            }
            let numbers: Vec<f32> = std::iter::once(first)
                .chain(parts.by_ref().take(3))
                .filter_map(|n| n.parse::<f32>().ok())
                .filter(|n| n.is_finite())
                .collect();
            let (Ok(bbox), Some(word)) = (<[f32; 4]>::try_from(numbers), parts.next()) else {
                continue;
            };
            page.words.push(OcrWord {
                text: word.to_string(),
                bbox,
            });
        }
        Ok(Some(page))
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
                    replace: false,
                    image: None,
                }],
                AMIRI,
            )
            .unwrap();
        assert_eq!(
            report,
            OcrReport {
                pages: 1,
                words: 3,
                ..OcrReport::default()
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
                    replace: false,
                    image: None,
                }],
                AMIRI,
            )
            .unwrap();
        assert_eq!(
            again,
            OcrReport {
                skipped: 1,
                ..OcrReport::default()
            }
        );
    }

    fn page(words: Vec<OcrWord>, replace: bool, image: Option<Vec<u8>>) -> OcrPage {
        OcrPage {
            index: 0,
            words,
            angle: 1.5,
            replace,
            image,
        }
    }

    fn layers(doc: &PdfDocument) -> usize {
        let content = doc.doc.get_page_content(doc.page_id(0).unwrap());
        let needle = [b"/".as_slice(), MARK].concat();
        content
            .windows(needle.len())
            .filter(|w| *w == needle)
            .count()
    }

    #[test]
    fn a_corrected_reading_replaces_the_layer_and_its_words_are_kept_with_the_page() {
        let original = corpus("scan-arial-200dpi-bilevel.pdf");
        let mut doc = PdfDocument::open(original.clone(), None).unwrap();
        doc.add_text_layer(&[page(words(), false, None)], AMIRI)
            .unwrap();
        let saved = doc.save_incremental().unwrap();

        // Read back after a save: the words and the angle they were read at.
        let mut back = PdfDocument::open(saved.clone(), None).unwrap();
        let kept = back.ocr_layer_words(0).unwrap().unwrap();
        assert_eq!(kept.words, words());
        assert!((kept.angle - 1.5).abs() < 1e-6);

        let mut corrected = words();
        corrected[1].text = "بالعالَم".into();
        let report = back
            .add_text_layer_at(
                &[page(corrected.clone(), true, None)],
                AMIRI,
                "D:20260919120000Z",
            )
            .unwrap();
        assert_eq!((report.pages, report.words, report.skipped), (1, 3, 0));
        assert_eq!(
            layers(&back),
            1,
            "the old layer is gone, the new one is there"
        );
        let content = back.doc.get_page_content(back.page_id(0).unwrap());
        let ops = Content::decode(&content).unwrap().operations;
        // One size set per word: three words, not six.
        assert_eq!(ops.iter().filter(|op| op.operator == "Tf").count(), 3);
        // The scan itself is still drawn.
        assert_eq!(back.list_images(0).unwrap().len(), 1);
        let again = PdfDocument::open(back.save_incremental().unwrap(), None).unwrap();
        assert_eq!(again.ocr_layer_words(0).unwrap().unwrap().words, corrected);
    }

    #[test]
    fn a_page_without_the_layer_has_no_words_to_read_back() {
        let doc = PdfDocument::open(corpus("scan-arial-200dpi-bilevel.pdf"), None).unwrap();
        assert_eq!(doc.ocr_layer_words(0).unwrap(), None);
        let mut doc = PdfDocument::open(corpus("scan-arial-200dpi-bilevel.pdf"), None).unwrap();
        assert!(!doc.strip_ocr_layer(0).unwrap());
    }

    fn black_and_white(width: u32, height: u32) -> Vec<u8> {
        let image = image::GrayImage::from_fn(width, height, |x, y| {
            image::Luma([if (x / 4 + y / 4) % 2 == 0 { 0 } else { 255 }])
        });
        let mut out = Vec::new();
        image::DynamicImage::ImageLuma8(image)
            .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
            .unwrap();
        out
    }

    #[test]
    fn a_cleaned_scan_takes_the_place_of_the_page_picture_and_the_words_go_level() {
        let original = corpus("scan-arial-200dpi-bilevel.pdf");
        let mut doc = PdfDocument::open(original.clone(), None).unwrap();
        let (w, h) = doc.page_size(0).unwrap();
        let report = doc
            .add_text_layer(
                &[page(words(), false, Some(black_and_white(170, 220)))],
                AMIRI,
            )
            .unwrap();
        assert_eq!((report.images, report.images_kept), (1, 0));
        let images = doc.list_images(0).unwrap();
        assert_eq!(images.len(), 1, "{images:?}");
        assert_eq!(images[0].pixels, (170, 220));
        let m = images[0].matrix;
        for (a, b) in m.iter().zip([w, 0.0, 0.0, -h, 0.0, h]) {
            assert!((a - b).abs() < 0.01, "{m:?}");
        }
        // Written level: the picture now is the straightened page.
        assert_eq!(doc.ocr_layer_words(0).unwrap().unwrap().angle, 0.0);
        let saved = doc.save_incremental().unwrap();
        assert!(saved.starts_with(&original));
        assert!(PdfDocument::open(saved, None)
            .unwrap()
            .has_ocr_layer(0)
            .unwrap());
    }

    #[test]
    fn a_page_that_is_not_just_a_picture_keeps_what_it_has() {
        let mut doc =
            PdfDocument::open(corpus("chrome-notonaskh-justified-3pages.pdf"), None).unwrap();
        let before = doc.list_images(0).unwrap().len();
        let report = doc
            .add_text_layer(
                &[page(words(), false, Some(black_and_white(60, 80)))],
                AMIRI,
            )
            .unwrap();
        assert_eq!((report.images, report.images_kept, report.pages), (0, 1, 1));
        assert_eq!(doc.list_images(0).unwrap().len(), before);
    }

    #[test]
    fn a_picture_that_cannot_be_read_leaves_the_scan_where_it_was() {
        let mut doc = PdfDocument::open(corpus("scan-arial-200dpi-bilevel.pdf"), None).unwrap();
        assert!(doc.replace_scan(0, b"\x89PNG\r\n\x1a\nnot really").is_err());
        assert_eq!(doc.list_images(0).unwrap().len(), 1);
    }
}
