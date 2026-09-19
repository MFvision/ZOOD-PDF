//! Warraq core façade: the one API every host uses (native and WASM).
use serde::Serialize;
use warraq_pdf::PdfDocument;
use warraq_render::RenderDoc;
use warraq_text::{
    detect_paragraphs, find_in_lines, reconstruct_lines, with_actual_text, Paragraph,
    SearchNormalization, TextLine,
};

pub mod tools;
#[cfg(target_arch = "wasm32")]
pub mod wasm;

pub use tools::{call_static, Reply};
/// Whether an address is one a link may open (`http`, `https`, `mailto`).
pub use warraq_pdf::allowed_uri;

pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error("{0}")]
    Pdf(#[from] warraq_pdf::Error),
    #[error("{0}")]
    Render(#[from] warraq_render::RenderError),
    #[error("E_ARGS: {0}")]
    Args(String),
    #[error("E_UNKNOWN_OP: no tool operation called {0}")]
    UnknownOp(String),
    /// Signing and verifying (`warraq_sign`), with their own codes:
    /// `E_P12_PASSWORD`, `E_P12`, `E_TSA`, `E_SIGN`, …
    #[error("{0}")]
    Sign(String),
}

#[derive(Debug, Clone, Serialize)]
pub struct Metadata {
    pub title: Option<String>,
    pub author: Option<String>,
    pub producer: Option<String>,
    pub creator: Option<String>,
    pub pages: usize,
    pub encrypted: bool,
    pub engine: &'static str,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct ParagraphReplacement {
    pub lines_drawn: usize,
    /// True when the text was drawn with a bundled font instead of the original.
    pub font_substituted: bool,
    /// True when the text had to be shrunk to fit the paragraph's box.
    pub shrunk: bool,
    /// True when it still runs past the box; the user should be warned.
    pub overflowed: bool,
    /// The size actually used.
    pub font_size: f32,
}

pub struct Document {
    pdf: PdfDocument,
    render: Box<dyn RenderDoc>,
    lines_cache: std::cell::RefCell<std::collections::HashMap<usize, Vec<TextLine>>>,
}

impl Document {
    pub fn open(bytes: Vec<u8>, password: Option<&str>) -> Result<Self, CoreError> {
        // Our object layer owns encryption: it implements the standard security
        // handler, the rasterizers do not. So decrypt first and hand the renderer
        // plaintext, otherwise every encrypted file would fail to render even
        // though we can read it perfectly well.
        let pdf = PdfDocument::open(bytes.clone(), password)?;
        let (render_bytes, render_password) = if pdf.was_encrypted() {
            let mut plain = PdfDocument::open(bytes, password)?;
            (plain.save_to_vec()?, None)
        } else {
            (bytes, password)
        };
        let render = warraq_render::open(render_bytes, render_password)?;
        Ok(Self {
            pdf,
            render,
            lines_cache: Default::default(),
        })
    }

    pub fn page_count(&self) -> usize {
        self.pdf.page_count().max(self.render.page_count())
    }

    pub fn page_size(&self, index: usize) -> Result<(f32, f32), CoreError> {
        Ok(self
            .render
            .page_size(index)
            .or_else(|_| self.pdf.page_size(index))?)
    }

    pub fn render_page(
        &self,
        index: usize,
        scale: f32,
    ) -> Result<warraq_render::Bitmap, CoreError> {
        Ok(self.render.render(index, scale.clamp(0.05, 8.0))?)
    }

    pub fn text_lines(&self, index: usize) -> Result<Vec<TextLine>, CoreError> {
        if let Some(l) = self.lines_cache.borrow().get(&index) {
            return Ok(l.clone());
        }
        let lines = self.read_lines(index, false)?;
        self.lines_cache.borrow_mut().insert(index, lines.clone());
        Ok(lines)
    }

    /// A page's glyphs as the reader takes them — positioned, with their
    /// text, a run marked with `/ActualText` as that text — its artifacts
    /// left out, as `text_lines` leaves them out.
    pub fn glyphs(&self, index: usize) -> Result<Vec<warraq_text::PositionedGlyph>, CoreError> {
        self.read_glyphs(index, false)
    }

    /// The text of the page's artifacts only — its page marks, running
    /// heads, page numbers — which `text_lines` leaves out.
    pub fn artifact_lines(&self, index: usize) -> Result<Vec<TextLine>, CoreError> {
        self.read_lines(index, true)
    }

    /// The page's lines, read from either what it says or its artifacts.
    ///
    /// What is marked `/Artifact` (PDF 2.0 §14.8.2.2) is not part of the
    /// page's text: a watermark across the middle, a header, a page number.
    /// Mixed in, a diagonal DRAFT splits every line it crosses and a running
    /// head reads as the first sentence of each page, so the reader — and
    /// with it search, Export, Compare and Edit — keeps them apart.
    fn read_lines(&self, index: usize, artifacts: bool) -> Result<Vec<TextLine>, CoreError> {
        Ok(reconstruct_lines(&self.read_glyphs(index, artifacts)?))
    }

    /// The glyphs `read_lines` reads.
    fn read_glyphs(
        &self,
        index: usize,
        artifacts: bool,
    ) -> Result<Vec<warraq_text::PositionedGlyph>, CoreError> {
        let (glyphs, marked) = self.render.marked_glyphs(index)?;
        let artifact: Vec<bool> = marked.tags.iter().map(|t| t == b"Artifact").collect();
        let (glyphs, inside): (Vec<_>, Vec<_>) = glyphs
            .into_iter()
            .zip(
                marked
                    .inside
                    .iter()
                    .cloned()
                    .chain(std::iter::repeat(vec![])),
            )
            .filter(|(_, seqs)| {
                let is = seqs
                    .iter()
                    .any(|k| artifact.get(*k as usize).copied().unwrap_or(false));
                is == artifacts
            })
            .unzip();
        let marked = warraq_render::MarkedGlyphs {
            tags: marked.tags,
            inside,
        };
        // Glyphs inside `/ActualText` read as that text — when the document's
        // own list of the page's sequences matches, tag for tag, the one the
        // renderer met; otherwise as they are.
        let glyphs = match self.pdf.marked_content(index) {
            Some(sequences)
                if sequences.len() == marked.tags.len()
                    && sequences.iter().zip(&marked.tags).all(|(s, t)| &s.tag == t) =>
            {
                let texts: Vec<Option<String>> =
                    sequences.into_iter().map(|s| s.actual_text).collect();
                with_actual_text(glyphs, &marked.inside, &texts)
            }
            _ => glyphs,
        };
        Ok(glyphs)
    }

    /// Prepare form's proposals for the pages asked (every page when none):
    /// where the page expects input, found from its text and its lines, and
    /// never over a field it already has. See `warraq_pdf::forms::detect`.
    pub fn detect_fields(
        &self,
        pages: &[usize],
    ) -> Result<Vec<(usize, Vec<warraq_pdf::forms::Proposal>)>, CoreError> {
        let form = self.pdf.form();
        let all: Vec<usize> = (0..self.page_count()).collect();
        let pages = if pages.is_empty() { &all } else { pages };
        let mut out = Vec::new();
        for &index in pages {
            if index >= self.page_count() {
                return Err(warraq_pdf::Error::Page(index).into());
            }
            let (width, height) = self.page_size(index)?;
            let glyphs = self.glyphs(index)?;
            let drawing = self.render.drawing(index)?;
            let rules: Vec<warraq_pdf::forms::Rule> = drawing
                .rules
                .into_iter()
                .map(|r| warraq_pdf::forms::Rule {
                    horizontal: r.horizontal,
                    at: r.at,
                    from: r.from,
                    to: r.to,
                })
                .collect();
            let existing: Vec<[f32; 4]> = form
                .fields
                .iter()
                .flat_map(|f| f.widgets.iter())
                .filter(|w| w.page == index)
                .map(|w| w.rect)
                .collect();
            let found = warraq_pdf::forms::detect(&warraq_pdf::forms::PageInput {
                width,
                height,
                glyphs: &glyphs,
                rules: &rules,
                pictures: &drawing.pictures,
                existing: &existing,
            });
            out.push((index, found));
        }
        Ok(out)
    }

    /// The form as `warraq_pdf` reads it.
    pub fn form(&self) -> warraq_pdf::forms::FormReport {
        self.pdf.form()
    }

    pub fn extract_text(&self, index: usize) -> Result<String, CoreError> {
        Ok(self
            .text_lines(index)?
            .iter()
            .map(|l| l.text.as_str())
            .collect::<Vec<_>>()
            .join("\n"))
    }

    /// Page indices containing `query` (Arabic-aware normalization).
    pub fn search(&self, query: &str) -> Vec<usize> {
        let opts = SearchNormalization::default();
        (0..self.page_count())
            .filter(|i| {
                let lines: Vec<String> = self
                    .text_lines(*i)
                    .map(|l| l.into_iter().map(|t| t.text).collect())
                    .unwrap_or_default();
                !find_in_lines(&lines, query, &opts).is_empty()
            })
            .collect()
    }

    pub fn metadata(&self) -> Metadata {
        let m = self.pdf.metadata();
        Metadata {
            title: m.title,
            author: m.author,
            producer: m.producer,
            creator: m.creator,
            pages: self.page_count(),
            encrypted: m.encrypted,
            engine: if cfg!(feature = "pdfium") {
                "pdfium+hayro"
            } else {
                "hayro"
            },
        }
    }

    /// Paragraphs of a page, in reading order, with their boxes in DEVICE space
    /// (y down from the top-left corner, points at scale 1) so the UI can hit-test
    /// them against what it drew.
    pub fn paragraphs(&self, index: usize) -> Result<Vec<Paragraph>, CoreError> {
        Ok(detect_paragraphs(&self.text_lines(index)?))
    }

    /// Replace paragraph `para_index` of a page with `new_text`, reflowed to the
    /// same box with correct shaping, bidi and alignment.
    ///
    /// `font` is a face from the bundled fallback chain: a PDF embeds only a
    /// subset of its fonts, so new characters generally cannot reuse the
    /// document's own file. The returned flag says whether the original glyphs
    /// were drawn with a different font, i.e. whether the user should be warned
    /// about a substitution (brief §15.5).
    pub fn replace_paragraph(
        &mut self,
        index: usize,
        para_index: usize,
        new_text: &str,
        font: &[u8],
    ) -> Result<ParagraphReplacement, CoreError> {
        let (_, page_height) = self.page_size(index)?;
        let lines = self.text_lines(index)?;
        let paragraphs = detect_paragraphs(&lines);
        let para = paragraphs
            .get(para_index)
            .ok_or(warraq_pdf::Error::Edit(format!(
                "no paragraph {para_index} on page {index}"
            )))?;
        let (x, y_top, w, h) = para.bbox;
        let first = &lines[para.lines[0]];
        let size = (first.height / 1.2).max(1.0);
        let edit = warraq_pdf::ops::ParagraphEdit {
            rect: (x, page_height - (y_top + h), w, h),
            first_baseline: page_height - (first.y + size),
            text: new_text,
            font,
            font_size: size,
            leading: para.leading.max(size * 1.15),
            direction: para.direction,
            alignment: para.alignment,
        };
        let r = warraq_pdf::ops::replace_paragraph(self.pdf_mut(), index, &edit)?;
        self.refresh_after_edit()?;
        Ok(ParagraphReplacement {
            lines_drawn: r.lines_drawn,
            font_substituted: true,
            shrunk: r.shrunk,
            overflowed: r.overflowed,
            font_size: r.font_size,
        })
    }

    /// Draw `text` on a page at a point the reader chose, in the bundled `font`.
    ///
    /// `x` and `y` are UI coordinates — points from the top-left corner of the
    /// page, the same frame `paragraphs` reports — because that is what the
    /// interface hit-tests against. `x` is where the line *starts*: the left
    /// edge of a Latin run and the right edge of an Arabic one, so in both
    /// scripts the text grows away from the point that was clicked. `y` is the
    /// top of the line, not its baseline.
    ///
    /// Everything hard already lives in `ops::append_line`: shaping, the
    /// subset, the embedded font and its ToUnicode. This only places it.
    pub fn add_text(
        &mut self,
        index: usize,
        x: f32,
        y: f32,
        size: f32,
        text: &str,
        font: &[u8],
    ) -> Result<(), CoreError> {
        if text.trim().is_empty() {
            return Err(warraq_pdf::Error::Edit("there is no text to add".into()).into());
        }
        if !(size.is_finite() && size > 0.0) {
            return Err(warraq_pdf::Error::Edit(format!("font size {size} is not usable")).into());
        }
        // `page_size` is also the page check: an index out of range fails here.
        let (_, page_height) = self.page_size(index)?;
        // PDF y grows upwards from the bottom, and `append_line` wants a baseline.
        let baseline = page_height - y - size;
        warraq_pdf::ops::append_line(self.pdf_mut(), index, text, font, size, x, baseline)?;
        self.refresh_after_edit()?;
        Ok(())
    }

    /// One entry point for tool operations; see [`tools`].
    pub fn call(&mut self, op: &str, args: &str, blobs: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
        tools::call(self, op, args, blobs)
    }

    /// Save the edited document.
    ///
    /// Prefers an incremental update, which keeps the bytes handed to `open` as
    /// the literal prefix of the result, so anything we did not fully understand
    /// survives and an older reader can still open the previous revision. Falls
    /// back to a full rewrite when that is impossible (encrypted documents, or a
    /// file with no usable cross-reference section).
    pub fn save(&mut self) -> Result<Vec<u8>, CoreError> {
        match self.pdf.save_incremental() {
            Ok(bytes) => Ok(bytes),
            Err(_) => Ok(self.pdf.save_to_vec()?),
        }
    }

    /// Save by rewriting the whole file (smaller output, no revision history).
    pub fn save_rewritten(&mut self) -> Result<Vec<u8>, CoreError> {
        Ok(self.pdf.save_to_vec()?)
    }

    pub fn pdf_mut(&mut self) -> &mut PdfDocument {
        self.lines_cache.borrow_mut().clear();
        &mut self.pdf
    }

    /// Rebuild the rasterizer from the edited document.
    ///
    /// The renderer is built from bytes, so after an edit it still describes the
    /// document as it was opened. Every mutating operation must call this, or the
    /// user would edit a page and see no change until they saved and reopened.
    pub fn refresh_after_edit(&mut self) -> Result<(), CoreError> {
        let bytes = self.pdf.save_to_vec()?;
        self.render = warraq_render::open(bytes, None)?;
        self.lines_cache.borrow_mut().clear();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn corpus(name: &str) -> Vec<u8> {
        std::fs::read(format!(
            "{}/../../../tests/corpus/arabic/generated/{name}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap()
    }

    #[test]
    fn extracts_logical_order_text_from_the_ideal_corpus_file() {
        let d = Document::open(corpus("raw-amiri-cid-identity-tounicode.pdf"), None).unwrap();
        let text = d.extract_text(0).unwrap();
        let truth = std::fs::read_to_string(format!(
            "{}/../../../tests/corpus/arabic/truth/raw-amiri-cid-identity-tounicode.txt",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap();
        for line in truth.lines().take(4) {
            assert!(text.contains(line), "missing {line:?} in:\n{text}");
        }
        assert_eq!(d.search("الفاتورة"), vec![0]);
        assert_eq!(d.search("فاتوره"), vec![0], "taa marbuta / haa unified");
        assert!(d.search("لا يوجد").is_empty());
    }

    /// A subset font with no ToUnicode, no usable cmap and no GSUB is the hardest
    /// case in the corpus: the only evidence left is the shape of each glyph.
    #[test]
    fn a_file_with_no_tounicode_is_still_partly_readable_from_glyph_shapes() {
        let d = Document::open(corpus("raw-amiri-cid-no-tounicode.pdf"), None).unwrap();
        let text = d.extract_text(0).unwrap();
        for word in ["فاتورة", "الفاتورة", "العميل"] {
            assert!(
                text.contains(word),
                "expected {word:?} to be recovered from glyph shapes, got:\n{text}"
            );
        }
        // recovery is deliberately conservative: unknown glyphs stay as placeholders
        // rather than being guessed at, so some are expected to remain
        assert!(
            text.contains('\u{FFFD}'),
            "placeholders should remain for glyphs we cannot identify"
        );
    }

    /// Regression: the rasterizer is built from bytes, so an edit used to leave it
    /// describing the document as opened — the user saw nothing change until they
    /// saved and reopened. Found by the editing UI.
    #[test]
    fn an_edit_is_visible_in_the_very_next_render_and_paragraph_read() {
        const AMIRI: &[u8] = include_bytes!("../../../../tests/fonts/Amiri-Regular.ttf");
        let mut d = Document::open(corpus("chrome-notonaskh-justified-3pages.pdf"), None).unwrap();
        let before: u64 = d
            .render_page(0, 0.4)
            .unwrap()
            .rgba
            .iter()
            .map(|b| *b as u64)
            .sum();
        let new_text = "نص بديل قصير";
        d.replace_paragraph(0, 1, new_text, AMIRI).unwrap();
        let after: u64 = d
            .render_page(0, 0.4)
            .unwrap()
            .rgba
            .iter()
            .map(|b| *b as u64)
            .sum();
        assert_ne!(
            before, after,
            "the page must look different immediately after an edit"
        );
        assert!(
            d.extract_text(0).unwrap().contains(new_text),
            "the new text must be readable without saving first"
        );
        assert!(
            d.paragraphs(0)
                .unwrap()
                .iter()
                .any(|p| p.text.contains(new_text)),
            "paragraph boxes must be refreshed too"
        );
    }

    /// Adding text is the first Edit capability beyond replacing a paragraph.
    /// The engine already shapes, subsets and embeds; the core only has to place
    /// the line, and an Arabic run has to grow leftwards from the chosen point.
    ///
    /// The margin matters. Text dropped within a few points of an existing
    /// baseline is read back as part of *that* line, because it is one — which
    /// is right for a word in another font mid-sentence, and is why this places
    /// the note in the bottom margin like a person would.
    #[test]
    fn text_added_in_the_margin_is_readable_and_shows_up_immediately() {
        const AMIRI: &[u8] = include_bytes!("../../../../tests/fonts/Amiri-Regular.ttf");
        let ink = |d: &Document| -> u64 {
            d.render_page(0, 0.4)
                .unwrap()
                .rgba
                .iter()
                .map(|b| *b as u64)
                .sum()
        };
        let added = "ملاحظة مضافة";
        for name in [
            "raw-amiri-cid-identity-tounicode.pdf",
            "chrome-notonaskh-justified-3pages.pdf",
        ] {
            let mut d = Document::open(corpus(name), None).unwrap();
            let (width, height) = d.page_size(0).unwrap();
            let before = ink(&d);
            d.add_text(0, width * 0.7, height - 48.0, 14.0, added, AMIRI)
                .unwrap();
            assert_ne!(
                before,
                ink(&d),
                "{name}: the page must change straight away"
            );
            assert!(
                d.extract_text(0).unwrap().contains(added),
                "{name}: added text must be readable without saving first"
            );
            let reopened = Document::open(d.save().unwrap(), None).unwrap();
            assert!(
                reopened.extract_text(0).unwrap().contains(added),
                "{name}: and it must survive the save"
            );
        }

        let mut d = Document::open(corpus("raw-amiri-cid-identity-tounicode.pdf"), None).unwrap();
        assert!(
            d.add_text(0, 10.0, 10.0, 12.0, "   ", AMIRI).is_err(),
            "blank text is a mistake, not an empty edit"
        );
        assert!(
            d.add_text(99, 10.0, 10.0, 12.0, "x", AMIRI).is_err(),
            "a page that does not exist must fail, not panic"
        );
    }

    /// Every face the interface offers has to survive shaping, subsetting and
    /// embedding — including the variable ones, which carry tables a subsetter
    /// can trip over. The panel may only offer what this proves.
    #[test]
    fn each_bundled_face_can_draw_and_be_read_back() {
        let added = "ملاحظة بخط مختلف";
        for face in [
            "Amiri-Regular.ttf",
            "Cairo-Variable.ttf",
            "Inter-Variable.ttf",
        ] {
            let font = std::fs::read(format!(
                "{}/../../../tests/fonts/{face}",
                env!("CARGO_MANIFEST_DIR")
            ))
            .unwrap();
            let mut d =
                Document::open(corpus("raw-amiri-cid-identity-tounicode.pdf"), None).unwrap();
            let (width, height) = d.page_size(0).unwrap();
            let text = if face.starts_with("Inter") {
                "Added note"
            } else {
                added
            };
            d.add_text(0, width * 0.7, height - 48.0, 14.0, text, &font)
                .unwrap_or_else(|e| panic!("{face}: {e}"));
            assert!(
                d.extract_text(0).unwrap().contains(text),
                "{face}: text drawn with this face must be readable"
            );
        }
    }

    /// Regression, on the document where it was found: the World Bank Word
    /// export carries "Public Disclosure Authorized" up its margin, and every
    /// rotated run used to come back mirrored ("cilbuP…"). Found by the
    /// end-to-end suite, in the label of an edit box.
    #[test]
    fn the_rotated_margin_note_of_a_real_word_export_reads_forwards() {
        let bytes = std::fs::read(format!(
            "{}/../../../tests/corpus/arabic/realworld/A_worldbank_malpass_g7_briefing_AR_word2016_pdftools.pdf",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap();
        let d = Document::open(bytes, None).unwrap();
        let text = d.extract_text(0).unwrap();
        assert!(
            text.contains("Public Disclosure Authorized"),
            "the margin note should read forwards, got:\n{text}"
        );
        assert!(!text.contains("cilbuP"), "no mirrored runs:\n{text}");
    }

    #[test]
    fn every_encrypted_corpus_variant_opens_with_its_password_and_reports_itself_encrypted() {
        for (name, password) in [
            ("variant-encrypted-rc4-40.pdf", "warraq"),
            ("variant-encrypted-rc4-128.pdf", "warraq"),
            ("variant-encrypted-aes128.pdf", "warraq"),
            ("variant-encrypted-aes256.pdf", "warraq"),
            ("variant-encrypted-aes256-owner-only.pdf", ""),
        ] {
            let d = Document::open(corpus(name), Some(password))
                .unwrap_or_else(|e| panic!("{name}: {e}"));
            assert!(d.page_count() >= 1, "{name}");
            assert!(
                d.metadata().encrypted,
                "{name}: metadata must still say the file was encrypted"
            );
            let text = d.extract_text(0).unwrap();
            // the variants derive from two source documents: the invoice and the prose page
            assert!(
                text.contains("فاتورة") || text.contains("وراق"),
                "{name}: decrypted text looks wrong:\n{text}"
            );
            assert!(
                Document::open(corpus(name), Some("wrong-password")).is_err()
                    || password.is_empty(),
                "{name}: a wrong password must fail"
            );
        }
    }

    #[test]
    fn paragraphs_are_detected_and_one_can_be_reflowed_and_saved() {
        const AMIRI: &[u8] = include_bytes!("../../../../tests/fonts/Amiri-Regular.ttf");
        let mut d = Document::open(corpus("chrome-notonaskh-justified-3pages.pdf"), None).unwrap();
        let paras = d.paragraphs(0).unwrap();
        assert!(
            paras.len() >= 2,
            "expected a heading and body paragraphs, got {}",
            paras.len()
        );
        assert!(
            paras.iter().any(|p| p.lines.len() > 1),
            "at least one multi-line paragraph"
        );
        let target = paras.iter().position(|p| p.lines.len() > 1).unwrap();
        let (_, before_h) = (paras[target].bbox.2, paras[target].bbox.3);
        let new = "فقرة أعاد محرر وراق توزيعها بالكامل مع الحفاظ على عرض الإطار الأصلي وتشكيل الحروف العربية بشكل صحيح.";
        let r = d.replace_paragraph(0, target, new, AMIRI).unwrap();
        assert!(r.lines_drawn >= 1);
        let bytes = d.save().unwrap();
        // the saved file must reopen and the new text must come back in logical order
        let d2 = Document::open(bytes, None).unwrap();
        let text = d2.extract_text(0).unwrap();
        assert!(
            text.contains("محرر وراق"),
            "reflowed text missing from:\n{text}"
        );
        assert!(before_h > 0.0);
    }

    /// Regression: a shadda came back one letter late (`حررّها` for `حرّرها`)
    /// because marks were attached to a base by geometry alone. Found by editing
    /// a page through the WASM core in a browser and reading it back.
    #[test]
    fn text_we_write_comes_back_character_for_character_including_marks() {
        const AMIRI: &[u8] = include_bytes!("../../../../tests/fonts/Amiri-Regular.ttf");
        for wanted in [
            "فقرة حرّرها المتصفح عبر نواة وراق",
            "الْعِلْمُ نُورٌ وَالْجَهْلُ ظَلَامٌ",
            "محرّر وراق: إعادة توزيع الأسطر",
            // Amiri draws kha, and lam before kaf, with two glyphs; the second
            // has no text. These came back as ال�خير and للكن (found by Compare).
            "صباح الخير لكن الكثير يتركَّز هنا",
        ] {
            let mut d =
                Document::open(corpus("chrome-notonaskh-justified-3pages.pdf"), None).unwrap();
            d.replace_paragraph(0, 1, wanted, AMIRI).unwrap();
            let reopened = Document::open(d.save().unwrap(), None).unwrap();
            let extracted = reopened.extract_text(0).unwrap();
            let got = extracted
                .lines()
                .map(str::to_string)
                .find(|l| l.contains(wanted.split(' ').next().unwrap()))
                .unwrap_or_default();
            assert_eq!(got, wanted, "round trip changed the text");
        }
    }

    #[test]
    fn chrome_skia_file_with_presentation_form_tounicode_reads_logically() {
        let d = Document::open(corpus("chrome-cairo-mixed-invoice.pdf"), None).unwrap();
        let text = d.extract_text(0).unwrap();
        assert!(text.contains("فاتورة ضريبية مبسطة"), "{text}");
        assert!(text.contains("رقم الفاتورة: INV-2026-0042"), "{text}");
        let m = d.metadata();
        assert_eq!(m.pages, 1);
    }
}
