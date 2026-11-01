//! Warraq core façade: the one API every host uses (native and WASM).
use serde::Serialize;
use warraq_pdf::PdfDocument;
use warraq_render::RenderDoc;
use warraq_text::{
    detect_paragraphs, edit_paragraphs, find_in_lines, reconstruct_lines, with_actual_text,
    Paragraph, SearchNormalization, TextLine,
};

#[cfg(feature = "ffi")]
pub mod ffi;
pub mod tables;
pub mod tools;
#[cfg(target_arch = "wasm32")]
pub mod wasm;

pub use tools::{call_static, Reply};
/// Whether an address is one a link may open (`http`, `https`, `mailto`).
pub use warraq_pdf::{allowed_uri, safe_uri};

/// The size a substitute face is drawn at so the paragraph's own words take
/// the width they took before. Drawn at the original's size, a substitute can
/// be much larger than the face it stands in for (Cairo's Arabic beside
/// Arial's): a one-letter typo fix came back bigger and heavier, with its
/// lines touching (First Five, 2026-10-31). Never larger than the original
/// size, and never below three quarters of it.
pub(crate) fn size_matching_width(
    font: &[u8],
    lines: &[&TextLine],
    size: f32,
    direction: warraq_text::Direction,
) -> f32 {
    let Ok(shaper) = warraq_text::Shaper::new(font) else {
        return size;
    };
    let (mut was, mut now) = (0.0f32, 0.0f32);
    for line in lines {
        if line.turned.is_some() || line.text.trim().is_empty() || line.width <= 0.0 {
            continue;
        }
        let advance: f32 = shaper
            .shape_run(&line.text, direction)
            .iter()
            .map(|glyph| glyph.x_advance)
            .sum();
        if advance <= 0.0 {
            continue;
        }
        was += line.width;
        now += advance / 1000.0 * size;
    }
    if !(was > 0.0 && now > 0.0) {
        return size;
    }
    size * (was / now).clamp(0.75, 1.0)
}

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
    /// A Library index that cannot be read: damaged, cut short, written by
    /// another version, or never an index at all (`tools::library::format`).
    #[error("E_INDEX: {0}")]
    Index(String),
    /// A paragraph asked to be redrawn in its own font, which cannot draw
    /// the new text (`Document::replace_paragraph` with no font given).
    #[error("E_OWN_FONT: the paragraph's own font cannot draw this text")]
    OwnFont,
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

/// x, y, width, height in points.
type Rect = (f32, f32, f32, f32);

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

/// What a paragraph of the edit view is set in, for the host that must
/// choose a font for the text that replaces it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParagraphFont {
    /// The face as the file names it — family, weight, slant, serif or
    /// sans — of the font most of the paragraph's runs use; `None` when the
    /// file names none (a Type 3 font, text inside a form).
    pub face: Option<warraq_pdf::OriginalFace>,
    /// Whether the paragraph's own font can draw the text it has now, so an
    /// edit that keeps to its letters needs no other font
    /// (`warraq_pdf::ownfont`). Never true for right-to-left text.
    pub own_font: bool,
}

/// Which of a page's text a reading takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Reading {
    /// All of it: for search, and for finding what to redact.
    Everything,
    /// All but Warraq's own page marks: the page's text for Edit, Export,
    /// Compare and AI.
    Content,
    /// Warraq's page marks only.
    Marks,
}

/// The document drawn without its text (`export.picture`), made once when
/// asked for; with, for each page, whether all its text was invisible.
type Textless = (Box<dyn RenderDoc>, Vec<bool>);

/// The rasterizer for `bytes`, which are `pdf` as written (or a copy of it
/// with the same objects): given a tamed copy when the file has a shape that
/// would make it overflow the stack or allocate without bound
/// (`PdfDocument::for_rasterizer`).
pub(crate) fn open_renderer(
    pdf: &PdfDocument,
    bytes: Vec<u8>,
    password: Option<&str>,
) -> Result<Box<dyn RenderDoc>, CoreError> {
    if let Some(safe) = pdf.for_rasterizer()? {
        // `bytes` can differ from `pdf` (a copy with its text taken out):
        // tame that copy when it opens, else draw from `pdf` itself.
        let safe = match PdfDocument::open(bytes, password) {
            Ok(copy) => copy.for_rasterizer()?.unwrap_or(safe),
            Err(_) => safe,
        };
        return Ok(warraq_render::open(safe, None)?);
    }
    Ok(warraq_render::open(bytes, password)?)
}

pub struct Document {
    pdf: PdfDocument,
    render: Box<dyn RenderDoc>,
    lines_cache: std::cell::RefCell<std::collections::HashMap<(usize, Reading), Vec<TextLine>>>,
    textless: std::cell::RefCell<Option<Textless>>,
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
        let render = open_renderer(&pdf, render_bytes, render_password)?;
        Ok(Self {
            pdf,
            render,
            lines_cache: Default::default(),
            textless: Default::default(),
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

    /// The page's text, without Warraq's own page marks: what Edit,
    /// Export, Compare and AI read (see `Reading::Content`).
    pub fn text_lines(&self, index: usize) -> Result<Vec<TextLine>, CoreError> {
        self.cached_lines(index, Reading::Content)
    }

    /// Everything the page says, Warraq's page marks too: what search and
    /// Find and redact read, so no text on the page escapes them.
    pub fn all_lines(&self, index: usize) -> Result<Vec<TextLine>, CoreError> {
        self.cached_lines(index, Reading::Everything)
    }

    /// A page's glyphs as the reader takes them — positioned, with their
    /// text, a run marked with `/ActualText` as that text — Warraq's page
    /// marks left out, as `text_lines` leaves them out.
    pub fn glyphs(&self, index: usize) -> Result<Vec<warraq_text::PositionedGlyph>, CoreError> {
        self.read_glyphs(index, Reading::Content)
    }

    /// What the page draws besides text: its lines along the axes (table
    /// rules, form boxes) and its pictures, in the same space as `text_lines`.
    pub fn drawing(&self, index: usize) -> Result<warraq_render::Drawing, CoreError> {
        Ok(self.render.drawing(index)?)
    }

    /// The text of Warraq's page marks on the page only, which
    /// `text_lines` leaves out.
    pub fn mark_lines(&self, index: usize) -> Result<Vec<TextLine>, CoreError> {
        Ok(reconstruct_lines(&self.read_glyphs(index, Reading::Marks)?))
    }

    fn cached_lines(&self, index: usize, reading: Reading) -> Result<Vec<TextLine>, CoreError> {
        if let Some(l) = self.lines_cache.borrow().get(&(index, reading)) {
            return Ok(l.clone());
        }
        // The page's text and all of it come from one reading of the page,
        // and are kept together: search after Export or Edit reads no page
        // twice. On a page without Warraq's marks they are the same lines.
        let readings: &[Reading] = match reading {
            Reading::Marks => &[Reading::Marks],
            _ => &[Reading::Content, Reading::Everything],
        };
        let (sets, marked) = self.read_glyph_sets(index, readings)?;
        let mut wanted = None;
        let mut first: Option<Vec<TextLine>> = None;
        for (r, glyphs) in readings.iter().zip(sets) {
            let lines = match &first {
                Some(same) if !marked => same.clone(),
                _ => reconstruct_lines(&glyphs),
            };
            if *r == reading {
                wanted = Some(lines.clone());
            }
            first.get_or_insert_with(|| lines.clone());
            self.lines_cache.borrow_mut().insert((index, *r), lines);
        }
        Ok(wanted.unwrap_or_default())
    }

    /// The glyphs of the page a reading takes.
    fn read_glyphs(
        &self,
        index: usize,
        reading: Reading,
    ) -> Result<Vec<warraq_text::PositionedGlyph>, CoreError> {
        Ok(self
            .read_glyph_sets(index, &[reading])?
            .0
            .into_iter()
            .next()
            .unwrap_or_default())
    }

    /// The glyphs each of `readings` takes, from one reading of the page;
    /// and whether any glyph is in one of Warraq's marks.
    ///
    /// Warraq's page marks are `/Artifact` sequences carrying `/WarraqMark`
    /// (PDF 2.0 §14.8.2.2): mixed into the page's text, a diagonal DRAFT
    /// would split every line it crosses and a header would read as the
    /// first sentence of each page. Which sequences are Warraq's is known
    /// when the document's own list of the page's sequences pairs, tag for
    /// tag, with the one the renderer met; when it does not, on a page that
    /// carries Warraq's marks every artifact is taken for one, and on any
    /// other page none is. Other programs' artifacts — Word's running heads
    /// and footers, say — are the page's text like the rest.
    #[allow(clippy::type_complexity)]
    fn read_glyph_sets(
        &self,
        index: usize,
        readings: &[Reading],
    ) -> Result<(Vec<Vec<warraq_text::PositionedGlyph>>, bool), CoreError> {
        let (glyphs, marked) = self.render.marked_glyphs(index)?;
        let sequences = self.pdf.marked_content(index).filter(|sequences| {
            sequences.len() == marked.tags.len()
                && sequences.iter().zip(&marked.tags).all(|(s, t)| &s.tag == t)
        });
        let ours: Vec<bool> = match &sequences {
            Some(sequences) => sequences.iter().map(|s| s.warraq_mark).collect(),
            None if self.pdf.has_marks(index) => {
                marked.tags.iter().map(|t| t == b"Artifact").collect()
            }
            None => vec![],
        };
        let inside: Vec<Vec<u32>> = marked
            .inside
            .iter()
            .cloned()
            .chain(std::iter::repeat(vec![]))
            .take(glyphs.len())
            .collect();
        let is_mark: Vec<bool> = inside
            .iter()
            .map(|seqs| {
                seqs.iter()
                    .any(|k| ours.get(*k as usize).copied().unwrap_or(false))
            })
            .collect();
        let any_mark = is_mark.iter().any(|m| *m);
        // Glyphs inside `/ActualText` read as that text — when the sequences
        // pair; otherwise as they are.
        let texts: Option<Vec<Option<String>>> =
            sequences.map(|s| s.into_iter().map(|s| s.actual_text).collect());
        let sets = readings
            .iter()
            .map(|reading| {
                let (glyphs, inside): (Vec<_>, Vec<_>) = glyphs
                    .iter()
                    .zip(&inside)
                    .zip(&is_mark)
                    .filter(|(_, mark)| match reading {
                        Reading::Everything => true,
                        Reading::Content => !**mark,
                        Reading::Marks => **mark,
                    })
                    .map(|((g, i), _)| (g.clone(), i.clone()))
                    .unzip();
                match &texts {
                    Some(texts) => with_actual_text(glyphs, &inside, texts),
                    None => glyphs,
                }
            })
            .collect();
        Ok((sets, any_mark))
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
                    .all_lines(*i)
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
        Ok(self.edit_view(index)?.1)
    }

    /// The lines of a page as the editor takes them, and their paragraphs
    /// (whose `lines` index those lines): a page set in columns — cards side
    /// by side, a table — cut into its columns, so each is a paragraph of its
    /// own (`warraq_text::edit_paragraphs`).
    ///
    /// Replacing a paragraph blanks the text operators that start inside its
    /// box, so a column can only be edited on its own when its text is drawn
    /// by operators of its own. Where a piece cut from a line has none that
    /// starts in it — the whole line is one operator, spaced out — the page
    /// keeps its lines whole, as `detect_paragraphs` has them, rather than
    /// let an edit to one column take its neighbour's text with it.
    pub(crate) fn edit_view(
        &self,
        index: usize,
    ) -> Result<(Vec<TextLine>, Vec<Paragraph>), CoreError> {
        let lines = self.text_lines(index)?;
        let (pieces, was_cut, paragraphs) = edit_paragraphs(&lines);
        if !was_cut.contains(&true) {
            return Ok((pieces, paragraphs));
        }
        let (_, page_height) = self.page_size(index)?;
        let runs = warraq_pdf::ops::show_run_origins(&self.pdf, index)?;
        let own_runs = pieces.iter().zip(&was_cut).all(|(piece, cut)| {
            if !cut {
                return true;
            }
            let size = (piece.height / 1.2).max(1.0);
            let (y0, y1) = (
                page_height - (piece.y + piece.height),
                page_height - piece.y,
            );
            runs.iter().any(|&(x, y, _)| {
                x >= piece.x - 0.2 * size
                    && x <= piece.x + piece.width + 0.2 * size
                    && y >= y0 - 0.5 * size
                    && y <= y1 + 0.2 * size
            })
        });
        if own_runs {
            Ok((pieces, paragraphs))
        } else {
            let paragraphs = detect_paragraphs(&lines);
            Ok((lines, paragraphs))
        }
    }

    /// What each paragraph of a page is set in, in the order of
    /// [`Document::paragraphs`]: its face as the file names it, and whether
    /// its own font can draw its text.
    pub fn paragraph_fonts(&self, index: usize) -> Result<Vec<ParagraphFont>, CoreError> {
        let (_, page_height) = self.page_size(index)?;
        let (_, paragraphs) = self.edit_view(index)?;
        let mut fonts = warraq_pdf::ownfont::PageFonts::read(&self.pdf, index)?;
        Ok(paragraphs
            .iter()
            .map(|para| {
                let (x, y_top, w, h) = para.bbox;
                let rect = (x, page_height - (y_top + h), w, h);
                ParagraphFont {
                    face: fonts.face_in(rect),
                    own_font: para.direction == warraq_text::Direction::Ltr
                        && fonts
                            .own_font_in(rect)
                            .is_some_and(|font| font.covers(&para.text)),
                }
            })
            .collect())
    }

    /// Replace paragraph `para_index` of a page with `new_text`, reflowed to the
    /// same box with correct shaping, bidi and alignment.
    ///
    /// With no `font` (an empty slice) the paragraph is redrawn in its OWN
    /// font, by that font's own character codes: the same resource, size and
    /// colour, nothing embedded (`warraq_pdf::ownfont`). That is possible only
    /// for left-to-right text whose every character the document's font
    /// already has; otherwise the answer is `E_OWN_FONT`, nothing is changed,
    /// and the host asks again with a font.
    ///
    /// A `font` given is shaped and embedded as a subset: one installed on
    /// the device, one from the open library or a bundled face, as the host
    /// chose. The returned flag says whether the text was drawn with a font
    /// other than the paragraph's own, i.e. whether the user should be told
    /// about a substitution (brief §15.5).
    pub fn replace_paragraph(
        &mut self,
        index: usize,
        para_index: usize,
        new_text: &str,
        font: &[u8],
    ) -> Result<ParagraphReplacement, CoreError> {
        let (_, page_height) = self.page_size(index)?;
        let (lines, paragraphs) = self.edit_view(index)?;
        let para = paragraphs
            .get(para_index)
            .ok_or(warraq_pdf::Error::Edit(format!(
                "no paragraph {para_index} on page {index}"
            )))?;
        let (x, y_top, w, h) = para.bbox;
        let first = &lines[para.lines[0]];
        let size = (first.height / 1.2).max(1.0);
        // Words that are also part of a picture under the text stay on the
        // page when their text is erased: covered first, in the picture's
        // own colour around them.
        if let Some((rgb, cover)) = self.picture_words_under(index, (x, y_top, w, h), size) {
            warraq_pdf::ops::cover_area(self.pdf_mut(), index, cover, rgb)?;
        }
        if font.is_empty() {
            let edit = warraq_pdf::ownfont::OwnFontEdit {
                rect: (x, page_height - (y_top + h), w, h),
                text: new_text,
                leading: para.leading.max(size * 1.15),
                direction: para.direction,
                alignment: para.alignment,
            };
            let r = warraq_pdf::ownfont::replace_paragraph_own_font(self.pdf_mut(), index, &edit)?
                .ok_or(CoreError::OwnFont)?;
            self.refresh_after_edit()?;
            return Ok(ParagraphReplacement {
                lines_drawn: r.lines_drawn,
                font_substituted: false,
                shrunk: r.shrunk,
                overflowed: r.overflowed,
                font_size: r.font_size,
            });
        }
        // A bold paragraph drawn in a face without bold (the bundled
        // faces have one weight) is drawn heavier rather than come back regular.
        let rect = (x, page_height - (y_top + h), w, h);
        let was_bold = warraq_pdf::ownfont::PageFonts::read(&self.pdf, index)
            .ok()
            .and_then(|mut fonts| fonts.face_in(rect))
            .is_some_and(|face| face.weight >= 600);
        let drawn_weight = warraq_text::fontfile::faces(&mut std::io::Cursor::new(font))
            .first()
            .map(|face| face.weight);
        let synthetic_bold = was_bold && drawn_weight.is_some_and(|weight| weight < 600);
        let para_lines: Vec<&TextLine> = para.lines.iter().filter_map(|&i| lines.get(i)).collect();
        let drawn_size = size_matching_width(font, &para_lines, size, para.direction);
        let edit = warraq_pdf::ops::ParagraphEdit {
            rect,
            first_baseline: page_height - (first.y + size),
            text: new_text,
            font,
            font_size: drawn_size,
            leading: para.leading.max(size * 1.15),
            direction: para.direction,
            alignment: para.alignment,
            synthetic_bold,
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
        self.add_text_in_color(index, x, y, size, text, font, None)
    }

    /// `add_text` in a colour: `color` is RGB from 0 to 1, or `None` for the
    /// colour the page's own content leaves behind (black on nearly every
    /// page), which is what `add_text` has always drawn. The iPhone and iPad
    /// app offers a colour beside the face and the size, so a line added to a
    /// page can be told apart from what was printed on it.
    #[allow(clippy::too_many_arguments)]
    pub fn add_text_in_color(
        &mut self,
        index: usize,
        x: f32,
        y: f32,
        size: f32,
        text: &str,
        font: &[u8],
        color: Option<[f32; 3]>,
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
        warraq_pdf::ops::append_line_in_color(
            self.pdf_mut(),
            index,
            text,
            font,
            size,
            x,
            baseline,
            color,
        )?;
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
        self.textless.borrow_mut().take();
        &mut self.pdf
    }

    /// Page `index` drawn with no text on it — pictures, lines, fills and
    /// shading only — and whether all the page's text was invisible to begin
    /// with (a scan's text layer), when the picture is the page as it is.
    pub fn render_without_text(
        &self,
        index: usize,
        scale: f32,
    ) -> Result<(warraq_render::Bitmap, bool), CoreError> {
        if self.textless.borrow().is_none() {
            let (bytes, shown) = self.pdf.without_text()?;
            let render = open_renderer(&self.pdf, bytes, None)?;
            let hidden = shown.iter().map(|s| s.only_invisible()).collect();
            *self.textless.borrow_mut() = Some((render, hidden));
        }
        let cached = self.textless.borrow();
        let (render, hidden) = cached.as_ref().expect("made above");
        let bitmap = render.render(index, scale.clamp(0.05, 8.0))?;
        Ok((bitmap, hidden.get(index).copied().unwrap_or(false)))
    }

    /// Whether a paragraph's words (box in UI points from the top-left, and
    /// its text size) are also drawn by a picture under them, as on pages
    /// that are one image with their words again as text on top; and if so,
    /// the colour around them (0 to 1) and the box to cover, in PDF space.
    /// Only where the surround is one colour: over a photo nothing is
    /// covered, rather than paint a box on it.
    fn picture_words_under(
        &self,
        index: usize,
        (x, y_top, w, h): (f32, f32, f32, f32),
        size: f32,
    ) -> Option<([f32; 3], Rect)> {
        let (page_width, page_height) = self.page_size(index).ok()?;
        if !(page_width > 0.0 && page_height > 0.0 && w > 0.0 && h > 0.0) {
            return None;
        }
        let scale = (2400.0 / page_width.max(page_height)).clamp(0.5, 2.0);
        let (bitmap, _) = self.render_without_text(index, scale).ok()?;
        let (bw, bh) = (bitmap.width as i64, bitmap.height as i64);
        if bitmap.rgba.len() < (bw * bh * 4) as usize {
            return None;
        }
        let px = bw as f32 / page_width;
        let pixel = |cx: i64, cy: i64| -> [f32; 3] {
            let i = ((cy.clamp(0, bh - 1) * bw + cx.clamp(0, bw - 1)) * 4) as usize;
            let a = f32::from(bitmap.rgba[i + 3]) / 255.0;
            // Over white, as the page is shown.
            [0, 1, 2].map(|c| f32::from(bitmap.rgba[i + c]) * a + 255.0 * (1.0 - a))
        };
        let distance = |p: [f32; 3], q: [f32; 3]| (0..3).map(|c| (p[c] - q[c]).abs()).sum::<f32>();
        let pad = (0.3 * size).max(2.0);
        // Kept on the picture: a box from a hostile file can be 10^30 points
        // wide, and walking its edge pixel by pixel filled gigabytes.
        let on_x = |v: f32| (v * px).clamp(0.0, (bw - 1) as f32) as i64;
        let on_y = |v: f32| (v * px).clamp(0.0, (bh - 1) as f32) as i64;
        let (left, top) = (on_x(x - pad), on_y(y_top - pad));
        let (right, bottom) = (on_x(x + w + pad), on_y(y_top + h + pad));
        if right - left < 4 || bottom - top < 4 {
            return None;
        }
        // The ring just outside the box: the colour the words sit on.
        let mut ring = Vec::new();
        for cx in (left..=right).step_by(2) {
            ring.push(pixel(cx, top));
            ring.push(pixel(cx, bottom));
        }
        for cy in (top..=bottom).step_by(2) {
            ring.push(pixel(left, cy));
            ring.push(pixel(right, cy));
        }
        let mut buckets: std::collections::HashMap<[u8; 3], (usize, [f32; 3])> = Default::default();
        for p in &ring {
            let key = p.map(|v| (v as u8) >> 4);
            let entry = buckets.entry(key).or_insert((0, [0.0; 3]));
            entry.0 += 1;
            for (sum, v) in entry.1.iter_mut().zip(p) {
                *sum += v;
            }
        }
        let (count, sum) = buckets.values().max_by_key(|(n, _)| *n)?;
        let around = sum.map(|v| v / *count as f32);
        let even = ring
            .iter()
            .filter(|p| distance(**p, around) <= 48.0)
            .count();
        if even * 4 < ring.len() * 3 {
            return None;
        }
        // Ink inside: the words in the picture. Most of what the page shows
        // there must be in the picture too, so an underline or a rule under
        // ordinary text is not taken for words.
        let shown = self.render_page(index, scale).ok()?;
        if shown.width != bitmap.width || shown.rgba.len() < bitmap.rgba.len() {
            return None;
        }
        let shown_pixel = |cx: i64, cy: i64| -> [f32; 3] {
            let i = ((cy.clamp(0, bh - 1) * bw + cx.clamp(0, bw - 1)) * 4) as usize;
            let a = f32::from(shown.rgba[i + 3]) / 255.0;
            [0, 1, 2].map(|c| f32::from(shown.rgba[i + c]) * a + 255.0 * (1.0 - a))
        };
        let (mut ink, mut ink_shown, mut seen) = (0usize, 0usize, 0usize);
        for cy in on_y(y_top)..=on_y(y_top + h) {
            for cx in on_x(x)..=on_x(x + w) {
                seen += 1;
                if distance(pixel(cx, cy), around) > 96.0 {
                    ink += 1;
                }
                if distance(shown_pixel(cx, cy), around) > 96.0 {
                    ink_shown += 1;
                }
            }
        }
        if ink < 12 || ink * 50 < seen || ink * 2 < ink_shown {
            return None;
        }
        let rgb = around.map(|v| v / 255.0);
        Some((
            rgb,
            (
                x - pad,
                page_height - (y_top + h + pad),
                w + 2.0 * pad,
                h + 2.0 * pad,
            ),
        ))
    }

    /// Rebuild the rasterizer from the edited document.
    ///
    /// The renderer is built from bytes, so after an edit it still describes the
    /// document as it was opened. Every mutating operation must call this, or the
    /// user would edit a page and see no change until they saved and reopened.
    pub fn refresh_after_edit(&mut self) -> Result<(), CoreError> {
        let bytes = self.pdf.save_to_vec()?;
        self.render = open_renderer(&self.pdf, bytes, None)?;
        self.lines_cache.borrow_mut().clear();
        self.textless.borrow_mut().take();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cairo() -> Vec<u8> {
        std::fs::read(format!(
            "{}/../../../tests/fonts/Cairo-Variable.ttf",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap()
    }

    fn line(text: &str, width: f32) -> TextLine {
        TextLine {
            text: text.into(),
            x: 0.0,
            y: 0.0,
            width,
            height: 12.0,
            direction: warraq_text::Direction::Rtl,
            spans: vec![],
            turned: None,
        }
    }

    #[test]
    fn a_substitute_face_takes_the_width_the_paragraph_took() {
        let font = cairo();
        let text = "نطمح أن يكون الدليل مفيد ويساعدكم على التفكير بشكل مختلف";
        let shaper = warraq_text::Shaper::new(&font).unwrap();
        let natural: f32 = shaper
            .shape_run(text, warraq_text::Direction::Rtl)
            .iter()
            .map(|g| g.x_advance)
            .sum::<f32>()
            / 1000.0
            * 10.0;
        // The original face set the words in 85% of Cairo's width: Cairo comes down to match.
        let narrower = line(text, natural * 0.85);
        let size = size_matching_width(&font, &[&narrower], 10.0, warraq_text::Direction::Rtl);
        assert!((size - 8.5).abs() < 0.05, "{size}");
        // Never larger than the original size, never below three quarters of it.
        let wider = line(text, natural * 1.3);
        assert_eq!(
            size_matching_width(&font, &[&wider], 10.0, warraq_text::Direction::Rtl),
            10.0
        );
        let tiny = line(text, natural * 0.3);
        assert_eq!(
            size_matching_width(&font, &[&tiny], 10.0, warraq_text::Direction::Rtl),
            7.5
        );
        // Nothing to measure: the size as it was.
        assert_eq!(
            size_matching_width(&font, &[], 10.0, warraq_text::Direction::Rtl),
            10.0
        );
        assert_eq!(
            size_matching_width(
                b"not a font",
                &[&narrower],
                10.0,
                warraq_text::Direction::Rtl
            ),
            10.0
        );
    }

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

    /// A colour asked for is a colour drawn, and it stays inside the line's
    /// own graphics state: the red is in the page's stream, the text still
    /// reads back, and the page's own words are still black afterwards (a
    /// fill colour that leaked would repaint everything drawn after it).
    #[test]
    fn added_text_takes_the_colour_it_was_given_and_leaves_the_page_alone() {
        const AMIRI: &[u8] = include_bytes!("../../../../tests/fonts/Amiri-Regular.ttf");
        let added = "ملاحظة حمراء";
        let mut d = Document::open(corpus("raw-amiri-cid-identity-tounicode.pdf"), None).unwrap();
        let (width, height) = d.page_size(0).unwrap();
        d.add_text_in_color(
            0,
            width * 0.7,
            height - 48.0,
            14.0,
            added,
            AMIRI,
            Some([1.0, 0.0, 0.0]),
        )
        .unwrap();
        let reopened = Document::open(d.save().unwrap(), None).unwrap();
        assert!(
            reopened.extract_text(0).unwrap().contains(added),
            "the coloured line must read back like any other"
        );
        // The red pixels are the added line's; the page's own text is dark.
        let page = d.render_page(0, 1.0).unwrap();
        let red = page
            .rgba
            .as_chunks::<4>()
            .0
            .iter()
            .filter(|p| p[0] > 180 && p[1] < 90 && p[2] < 90)
            .count();
        assert!(red > 0, "the line must be drawn in red");
        assert!(
            red * 40 < page.width as usize * page.height as usize,
            "only the line may be red, not the page"
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
