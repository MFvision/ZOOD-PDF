//! New PDFs from other content (Export / Create): pictures, one to a page,
//! and documents — paragraphs, lists, tables, pictures and rules — typeset
//! in a bundled face with Arabic shaped by `warraq-text`.
//!
//! The interface reads a Word file, a web page, Markdown or plain text into
//! [`Block`]s; this lays them out on pages and writes the file. Its text is
//! written as all of Warraq's text is (`show_line`): an embedded subset with a
//! ToUnicode map, and `/ActualText` where the glyphs alone would not read
//! back, so a reader — Warraq's own, PDFium, a screen reader — finds what
//! was typed. Nothing is rasterised: a created page is text and vectors, and
//! the pictures go in as they came (a JPEG unchanged).
//!
//! The layout is a plain one, and says so: one face and size per paragraph
//! (bold drawn by stroking the glyphs as they are filled, which reads back
//! unchanged), greedy line breaking at spaces, tables as a grid of wrapped
//! cells that break across pages between their lines and repeat their
//! header rows. It is not Word's layout and does not pretend to be.
use std::collections::HashMap;

use lopdf::content::{Content, Operation};
use lopdf::{dictionary, Dictionary, Document, Object, ObjectId, Stream};
use warraq_text::{base_direction, Direction, ShapedGlyph, Shaper};

use crate::attachments::text_string;
use crate::fonts::{embed_subset_font, FontSubset};
use crate::picture::{add_picture, picture_info, upright_matrix};
use crate::show::{show_line, ShownLine};
use crate::{Error, Result};

/// PDF's own limit on a page side (Annex C: 14,400 units).
const MAX_SIDE: f32 = 14_400.0;
const MIN_SIDE: f32 = 72.0;
/// Of the text size: how much bolder a bold line's stroke makes it.
const BOLD_STROKE: f32 = 0.035;
/// Around the text of a table cell, in points.
const CELL_PAD: (f32, f32) = (4.0, 3.0);
const RULE_GREY: f32 = 0.7;
const BORDER_GREY: f32 = 0.55;
const HEADER_SHADE: [f32; 3] = [0.93, 0.93, 0.94];

/// A page's size and the margins inside it, in points.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PageSetup {
    pub width: f32,
    pub height: f32,
    /// Top, right, bottom, left.
    pub margins: [f32; 4],
}

/// Where a block's lines sit. Start and end follow the block's direction:
/// the start of an Arabic paragraph is its right edge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockAlign {
    Start,
    Center,
    End,
    Justify,
}

/// Which way a block reads; `Auto` takes its first strong letter (UAX #9).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockDir {
    Auto,
    Rtl,
    Ltr,
}

/// A paragraph, a heading, a list item or a line of code.
#[derive(Debug, Clone, PartialEq)]
pub struct TextBlock {
    /// `\n` breaks a line without ending the paragraph.
    pub text: String,
    pub size: f32,
    pub bold: bool,
    /// RGB, 0–1.
    pub color: [f32; 3],
    pub align: BlockAlign,
    pub dir: BlockDir,
    pub space_before: f32,
    pub space_after: f32,
    /// From the side the text starts on, in points.
    pub indent: f32,
    /// A list's bullet or number, hung in the indent before the first line.
    pub marker: Option<String>,
    /// Kept on the same page as the start of the block after it (headings).
    pub keep_with_next: bool,
    /// Line spacing as a multiple of the face's own line; 1 is single.
    pub spacing: f32,
    /// A shade behind the lines (code, quotations).
    pub shade: Option<[f32; 3]>,
    /// Spaces and line breaks kept exactly (code); otherwise runs of spaces
    /// are one space.
    pub preserve: bool,
}

impl Default for TextBlock {
    fn default() -> Self {
        Self {
            text: String::new(),
            size: 11.0,
            bold: false,
            color: [0.0; 3],
            align: BlockAlign::Start,
            dir: BlockDir::Auto,
            space_before: 0.0,
            space_after: 6.0,
            indent: 0.0,
            marker: None,
            keep_with_next: false,
            spacing: 1.0,
            shade: None,
            preserve: false,
        }
    }
}

/// One cell of a table row; `span` columns wide.
#[derive(Debug, Clone, PartialEq)]
pub struct TableCell {
    pub text: String,
    pub bold: bool,
    pub align: BlockAlign,
    pub dir: BlockDir,
    pub span: usize,
}

/// A table: rows of cells over columns of relative widths, drawn with
/// borders. Its first `header_rows` rows are shaded and repeated on every
/// page it runs onto. A right-to-left table has its first column on the right.
#[derive(Debug, Clone, PartialEq)]
pub struct TableBlock {
    /// Relative; missing columns share what is left equally.
    pub widths: Vec<f32>,
    pub rows: Vec<Vec<TableCell>>,
    pub header_rows: usize,
    pub dir: BlockDir,
    pub size: f32,
    pub space_before: f32,
    pub space_after: f32,
}

/// A picture of the document: `index` into the pictures handed over, at its
/// size in points when the source gave one, else at 96 per inch, never
/// wider or taller than the text area.
#[derive(Debug, Clone, PartialEq)]
pub struct ImageBlock {
    pub index: usize,
    pub width: Option<f32>,
    pub height: Option<f32>,
    pub align: BlockAlign,
    pub dir: BlockDir,
    pub space_before: f32,
    pub space_after: f32,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Block {
    Text(TextBlock),
    Table(TableBlock),
    Image(ImageBlock),
    PageBreak,
    /// A thin line across the text area.
    Rule,
}

/// Everything a document is made from.
pub struct DocumentSource<'a> {
    pub page: PageSetup,
    pub blocks: &'a [Block],
    /// The faces to set text in: the first for everything it has glyphs
    /// for, the others for paragraphs it does not cover.
    pub fonts: &'a [&'a [u8]],
    /// Names for the faces in the file (`/BaseFont`), in the same order.
    pub font_names: &'a [String],
    /// PNG or JPEG files, for the image blocks.
    pub pictures: &'a [Vec<u8>],
    pub info: FileInfo<'a>,
}

/// What the file says about itself.
#[derive(Debug, Clone, Copy, Default)]
pub struct FileInfo<'a> {
    pub title: Option<&'a str>,
    /// BCP 47, for `/Lang`: what a screen reader reads the text as.
    pub lang: Option<&'a str>,
    /// A PDF date (`D:YYYYMMDDHHmmSSZ`); the core has no clock of its own
    /// in a browser, so the interface passes it.
    pub created: Option<&'a str>,
}

/// What making a document did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CreateReport {
    pub pages: usize,
    /// Characters none of the faces has a glyph for; drawn as empty boxes.
    pub missing_glyphs: usize,
    /// Image blocks whose picture could not be read, left out.
    pub pictures_left_out: usize,
}

fn refuse(why: &str) -> Error {
    Error::Edit(format!("E_CREATE: {why}"))
}

fn usable_setup(page: &PageSetup) -> Result<PageSetup> {
    let ok = |v: f32| v.is_finite() && (MIN_SIDE..=MAX_SIDE).contains(&v);
    if !ok(page.width) || !ok(page.height) {
        return Err(refuse("the page size is not one a PDF can have"));
    }
    let mut margins = page
        .margins
        .map(|m| if m.is_finite() { m.max(0.0) } else { 0.0 });
    // At least an inch of room each way, whatever the margins asked for.
    let room = |a: f32, b: f32, side: f32| (a + b) <= side - MIN_SIDE;
    if !room(margins[1], margins[3], page.width) {
        margins[1] = 0.0;
        margins[3] = 0.0;
    }
    if !room(margins[0], margins[2], page.height) {
        margins[0] = 0.0;
        margins[2] = 0.0;
    }
    Ok(PageSetup { margins, ..*page })
}

/// A face and everything drawn with it, for its subset.
struct Face<'a> {
    bytes: &'a [u8],
    shaper: Shaper<'a>,
    name: String,
    /// Per 1000 of the size; descent is negative.
    ascent: f32,
    descent: f32,
    used: Vec<ShapedGlyph>,
    widths: HashMap<String, f32>,
}

impl<'a> Face<'a> {
    fn new(bytes: &'a [u8], name: &str) -> Result<Self> {
        let shaper = Shaper::new(bytes).map_err(|_| refuse("a font could not be read"))?;
        let m = shaper.metrics();
        Ok(Self {
            bytes,
            name: name
                .chars()
                .filter(|c| c.is_ascii_alphanumeric())
                .take(40)
                .collect(),
            ascent: if m.ascent > 0.0 { m.ascent } else { 900.0 },
            descent: if m.descent < 0.0 { m.descent } else { -250.0 },
            shaper,
            used: Vec::new(),
            widths: HashMap::new(),
        })
    }

    /// Width of `text` shaped as one line, in 1/1000 of the size.
    fn width(&mut self, text: &str) -> f32 {
        if let Some(w) = self.widths.get(text) {
            return *w;
        }
        let w = self
            .shaper
            .shape_line(text)
            .iter()
            .map(|g| g.x_advance)
            .sum::<f32>();
        if self.widths.len() < 50_000 {
            self.widths.insert(text.to_string(), w);
        }
        w
    }

    /// The height of one line of `size`, and how far below its top the
    /// baseline sits, at `spacing` times the face's own line.
    fn line(&self, size: f32, spacing: f32) -> (f32, f32) {
        let natural = (self.ascent - self.descent) / 1000.0 * size;
        let height = natural * spacing.clamp(0.5, 4.0);
        (
            height,
            (height - natural) / 2.0 + self.ascent / 1000.0 * size,
        )
    }
}

/// Something to draw on a page, in PDF space (points, y up).
enum Draw {
    Text {
        face: usize,
        glyphs: Vec<ShapedGlyph>,
        x: f32,
        baseline: f32,
        size: f32,
        stretch: f32,
        color: [f32; 3],
        bold: bool,
    },
    Line {
        from: (f32, f32),
        to: (f32, f32),
        width: f32,
        grey: f32,
    },
    Frame {
        rect: [f32; 4],
        grey: f32,
    },
    Fill {
        rect: [f32; 4],
        color: [f32; 3],
    },
    Picture {
        id: ObjectId,
        matrix: [f32; 6],
    },
}

/// A cell of a table row, broken into lines for its column.
struct LaidCell {
    /// Left edge and width of the cell's box.
    x: f32,
    width: f32,
    face: usize,
    lines: Vec<(String, bool)>,
    bold: bool,
    align: BlockAlign,
    dir: Direction,
}

struct Typesetter<'a> {
    setup: PageSetup,
    faces: Vec<Face<'a>>,
    pages: Vec<Vec<Draw>>,
    /// Top of the free space on the current page.
    y: f32,
    report: CreateReport,
    doc: Document,
    pictures: HashMap<usize, Option<(ObjectId, crate::picture::PictureInfo)>>,
    pictures_source: &'a [Vec<u8>],
    /// The direction most of the document's text runs in.
    dir: Direction,
}

/// A block's direction: as given, or from its first strong letter, or —
/// for text with no letters at all, a number or a date — the direction of
/// what it is in.
fn resolve(dir: BlockDir, text: &str, around: Direction) -> Direction {
    match dir {
        BlockDir::Rtl => Direction::Rtl,
        BlockDir::Ltr => Direction::Ltr,
        BlockDir::Auto if text.chars().any(char::is_alphabetic) => base_direction(text),
        BlockDir::Auto => around,
    }
}

/// Collapses runs of white space into one space, as HTML and Word do.
fn collapse(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut space = false;
    for c in text.chars() {
        if c.is_whitespace() && c != '\u{00A0}' {
            space = !out.is_empty();
        } else {
            if space {
                out.push(' ');
                space = false;
            }
            out.push(c);
        }
    }
    out
}

/// Where a line of `width` starts in `[left, right]`, and how wide it is drawn.
fn line_x(align: BlockAlign, dir: Direction, left: f32, right: f32, width: f32) -> f32 {
    match (align, dir) {
        (BlockAlign::Center, _) => left + (right - left - width) / 2.0,
        (BlockAlign::Start | BlockAlign::Justify, Direction::Rtl)
        | (BlockAlign::End, Direction::Ltr) => right - width,
        _ => left,
    }
}

impl<'a> Typesetter<'a> {
    fn top(&self) -> f32 {
        self.setup.height - self.setup.margins[0]
    }
    fn bottom(&self) -> f32 {
        self.setup.margins[2]
    }
    fn left(&self) -> f32 {
        self.setup.margins[3]
    }
    fn right(&self) -> f32 {
        self.setup.width - self.setup.margins[1]
    }
    /// Nothing is on this page yet.
    fn at_top(&self) -> bool {
        self.y >= self.top() - 0.01
    }

    fn new_page(&mut self) {
        self.pages.push(Vec::new());
        self.y = self.top();
    }

    fn draw(&mut self, d: Draw) {
        if let Draw::Text { face, glyphs, .. } = &d {
            self.faces[*face].used.extend(glyphs.iter().cloned());
        }
        if let Some(page) = self.pages.last_mut() {
            page.push(d);
        }
    }

    /// The first face with a glyph for every letter of `text`, or the one
    /// with the most; letters none has are counted.
    fn face_for(&mut self, text: &str) -> usize {
        if let Some(k) = self.faces.iter().position(|f| f.shaper.covers(text)) {
            return k;
        }
        let letters: Vec<String> = text
            .chars()
            .filter(|c| !c.is_whitespace() && !c.is_control())
            .map(String::from)
            .collect();
        let covered = |f: &Face| letters.iter().filter(|c| f.shaper.covers(c)).count();
        let best = (0..self.faces.len())
            .max_by_key(|k| covered(&self.faces[*k]))
            .unwrap_or(0);
        self.report.missing_glyphs += letters
            .iter()
            .filter(|c| !self.faces.iter().any(|f| f.shaper.covers(c)))
            .count();
        best
    }

    /// `text` broken into lines no wider than `width` at `size`: at spaces,
    /// and inside a word only when the word alone is wider than the line.
    /// Each line comes with whether it ends a line of the source (a line
    /// that is not justified).
    fn break_lines(
        &mut self,
        face: usize,
        text: &str,
        size: f32,
        width: f32,
        preserve: bool,
    ) -> Vec<(String, bool)> {
        let scale = size / 1000.0;
        let max = width.max(size);
        let mut out = Vec::new();
        for hard in text.split('\n') {
            let source = if preserve {
                hard.replace('\t', "    ")
            } else {
                collapse(hard)
            };
            let start = out.len();
            if preserve {
                self.split_to_fit(face, &source, scale, max, &mut out);
            } else {
                let space = self.faces[face].width(" ") * scale;
                let mut current = String::new();
                let mut current_w = 0.0f32;
                for word in source.split(' ').filter(|w| !w.is_empty()) {
                    let w = self.faces[face].width(word) * scale;
                    if w > max {
                        if !current.is_empty() {
                            out.push((std::mem::take(&mut current), false));
                        }
                        self.split_to_fit(face, word, scale, max, &mut out);
                        if let Some((last, _)) = out.pop() {
                            current_w = self.faces[face].width(&last) * scale;
                            current = last;
                        }
                        continue;
                    }
                    if current.is_empty() {
                        current = word.to_string();
                        current_w = w;
                    } else if current_w + space + w <= max + 0.01 {
                        current.push(' ');
                        current.push_str(word);
                        current_w += space + w;
                    } else {
                        out.push((std::mem::replace(&mut current, word.to_string()), false));
                        current_w = w;
                    }
                }
                if !current.is_empty() {
                    out.push((current, false));
                }
            }
            if out.len() == start {
                out.push((String::new(), false));
            }
            if let Some(last) = out.last_mut() {
                last.1 = true;
            }
        }
        out
    }

    /// A run too long for the line, in pieces that fit, letter by letter.
    fn split_to_fit(
        &mut self,
        face: usize,
        text: &str,
        scale: f32,
        max: f32,
        out: &mut Vec<(String, bool)>,
    ) {
        let mut piece = String::new();
        let mut piece_w = 0.0f32;
        for c in text.chars() {
            let mut buf = [0u8; 4];
            let w = self.faces[face].width(c.encode_utf8(&mut buf)) * scale;
            if !piece.is_empty() && piece_w + w > max {
                out.push((std::mem::take(&mut piece), false));
                piece_w = 0.0;
            }
            piece.push(c);
            piece_w += w;
        }
        if !piece.is_empty() || out.is_empty() {
            out.push((piece, false));
        }
    }

    /// One line of text, shaped and placed in `[left, right]` with its
    /// baseline at `baseline`.
    #[allow(clippy::too_many_arguments)]
    fn draw_line(
        &mut self,
        face: usize,
        line: &str,
        last: bool,
        (left, right): (f32, f32),
        baseline: f32,
        size: f32,
        align: BlockAlign,
        dir: Direction,
        color: [f32; 3],
        bold: bool,
    ) {
        if line.trim().is_empty() {
            return;
        }
        let glyphs = self.faces[face].shaper.shape_line_in(line, Some(dir));
        let natural = glyphs.iter().map(|g| g.x_advance).sum::<f32>() * size / 1000.0;
        let spaces = glyphs.iter().filter(|g| g.text == " ").count();
        let room = right - left;
        let justify = align == BlockAlign::Justify && !last && spaces > 0 && natural < room;
        let (stretch, width) = if justify {
            ((room - natural) / spaces as f32 * 1000.0 / size, room)
        } else {
            (0.0, natural)
        };
        let x = line_x(align, dir, left, right, width);
        self.draw(Draw::Text {
            face,
            glyphs,
            x,
            baseline,
            size,
            stretch,
            color,
            bold,
        });
    }

    fn text(&mut self, b: &TextBlock, next_line: f32) {
        let face = self.face_for(&b.text);
        let dir = resolve(b.dir, &b.text, self.dir);
        let size = if b.size.is_finite() {
            b.size.clamp(4.0, 144.0)
        } else {
            11.0
        };
        let (line_h, baseline_off) = self.faces[face].line(size, b.spacing);
        let indent = b.indent.clamp(0.0, (self.right() - self.left()) * 0.6);
        let (left, right) = match dir {
            Direction::Rtl => (self.left(), self.right() - indent),
            Direction::Ltr => (self.left() + indent, self.right()),
        };
        let lines = self.break_lines(face, &b.text, size, right - left, b.preserve);
        if !self.at_top() {
            self.y -= b.space_before.max(0.0);
        }
        // A heading, or a short block, is not left alone at the foot of a page.
        let whole = lines.len() as f32 * line_h;
        let keep = if b.keep_with_next { next_line } else { 0.0 };
        if !self.at_top()
            && self.y - whole - keep < self.bottom()
            && (b.keep_with_next || lines.len() <= 2)
        {
            self.new_page();
        }
        for (k, (line, last)) in lines.iter().enumerate() {
            if !self.at_top() && self.y - line_h < self.bottom() - 0.01 {
                self.new_page();
            }
            if let Some(color) = b.shade {
                let pad = size * 0.3;
                self.draw(Draw::Fill {
                    rect: [
                        left - pad,
                        self.y - line_h,
                        right - left + 2.0 * pad,
                        line_h,
                    ],
                    color,
                });
            }
            let baseline = self.y - baseline_off;
            let align = if b.preserve {
                BlockAlign::Start
            } else {
                b.align
            };
            self.draw_line(
                face,
                line,
                *last,
                (left, right),
                baseline,
                size,
                align,
                dir,
                b.color,
                b.bold,
            );
            if k == 0 {
                if let Some(marker) = b.marker.as_deref().filter(|m| !m.trim().is_empty()) {
                    let mface = self.face_for(marker);
                    // Wide enough that a reader puts a space after the marker.
                    let gap = size * 0.9;
                    let w = self.faces[mface].width(marker) * size / 1000.0;
                    let x = match dir {
                        Direction::Rtl => (right + gap, right + gap + w),
                        Direction::Ltr => (left - gap - w, left - gap),
                    };
                    // Shaped in the paragraph's direction: "٢." reads ".٢" on the page.
                    self.draw_line(
                        mface,
                        marker,
                        true,
                        x,
                        baseline,
                        size,
                        BlockAlign::Center,
                        dir,
                        b.color,
                        b.bold,
                    );
                }
            }
            self.y -= line_h;
        }
        self.y -= b.space_after.max(0.0);
    }

    /// The height of the first line of a block, for keeping a heading with it.
    fn first_line(&mut self, block: Option<&Block>) -> f32 {
        match block {
            Some(Block::Text(t)) => {
                let face = self.face_for(&t.text);
                2.0 * self.faces[face].line(t.size.clamp(4.0, 144.0), t.spacing).0 + t.space_before
            }
            Some(Block::Table(t)) => {
                let face = self.face_for("a");
                2.0 * (self.faces[face].line(t.size.clamp(4.0, 72.0), 1.0).0 + 2.0 * CELL_PAD.1)
            }
            Some(Block::Image(_)) => 72.0,
            _ => 0.0,
        }
    }

    fn rule(&mut self) {
        if !self.at_top() {
            self.y -= 6.0;
        }
        if self.y - 1.0 < self.bottom() {
            self.new_page();
        }
        let (left, right, y) = (self.left(), self.right(), self.y);
        self.draw(Draw::Line {
            from: (left, y),
            to: (right, y),
            width: 0.75,
            grey: RULE_GREY,
        });
        self.y -= 7.0;
    }

    fn picture(&mut self, index: usize) -> Option<(ObjectId, crate::picture::PictureInfo)> {
        if let Some(known) = self.pictures.get(&index) {
            return *known;
        }
        let source = self.pictures_source;
        let placed = source.get(index).and_then(|bytes| {
            let info = picture_info(bytes)?;
            let added = add_picture(&mut self.doc, bytes).ok()?;
            Some((added.id, info))
        });
        self.pictures.insert(index, placed);
        placed
    }

    fn image(&mut self, b: &ImageBlock) {
        let Some((id, info)) = self.picture(b.index) else {
            self.report.pictures_left_out += 1;
            return;
        };
        let (pw, ph) = info.shown();
        let (pw, ph) = (pw.max(1) as f32, ph.max(1) as f32);
        let usable = |v: Option<f32>| v.filter(|v| v.is_finite() && *v > 0.5);
        let (mut w, mut h) = match (usable(b.width), usable(b.height)) {
            (Some(w), Some(h)) => (w, h),
            (Some(w), None) => (w, w * ph / pw),
            (None, Some(h)) => (h * pw / ph, h),
            (None, None) => (pw * 0.75, ph * 0.75),
        };
        let (max_w, max_h) = (self.right() - self.left(), self.top() - self.bottom());
        let fit = (max_w / w).min(max_h / h).min(1.0);
        w *= fit;
        h *= fit;
        if !self.at_top() {
            self.y -= b.space_before.max(0.0);
        }
        if !self.at_top() && self.y - h < self.bottom() {
            self.new_page();
        }
        let dir = resolve(b.dir, "", self.dir);
        let x = line_x(b.align, dir, self.left(), self.right(), w);
        self.draw(Draw::Picture {
            id,
            matrix: upright_matrix(info.orientation, x, self.y - h, w, h),
        });
        self.y -= h + b.space_after.max(0.0);
    }

    fn table(&mut self, t: &TableBlock) {
        let columns = t
            .rows
            .iter()
            .map(|row| row.iter().map(|c| c.span.max(1)).sum::<usize>())
            .max()
            .unwrap_or(0)
            .max(t.widths.len());
        if columns == 0 {
            return;
        }
        let given: Vec<f32> = (0..columns)
            .map(|k| {
                t.widths
                    .get(k)
                    .copied()
                    .filter(|w| w.is_finite() && *w > 0.0)
                    .unwrap_or(0.0)
            })
            .collect();
        let known: f32 = given.iter().sum();
        let unknown = given.iter().filter(|w| **w == 0.0).count();
        let share = if unknown > 0 {
            (if known > 0.0 {
                known / (columns - unknown) as f32
            } else {
                1.0
            })
            .max(0.0001)
        } else {
            0.0
        };
        let weights: Vec<f32> = given
            .iter()
            .map(|w| if *w > 0.0 { *w } else { share })
            .collect();
        let total: f32 = weights.iter().sum();
        let span = self.right() - self.left();
        let widths: Vec<f32> = weights.iter().map(|w| w / total * span).collect();
        let all: String = t
            .rows
            .iter()
            .flatten()
            .map(|c| c.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        let dir = resolve(t.dir, &all, self.dir);
        // Left edge of the cell over columns [from, from + n).
        let (left, right) = (self.left(), self.right());
        let cell_x = |from: usize, n: usize| -> (f32, f32) {
            let before: f32 = widths[..from].iter().sum();
            let w: f32 = widths[from..(from + n).min(columns)].iter().sum();
            match dir {
                Direction::Ltr => (left + before, w),
                Direction::Rtl => (right - before - w, w),
            }
        };
        let size = if t.size.is_finite() {
            t.size.clamp(4.0, 72.0)
        } else {
            10.0
        };
        let mut laid: Vec<Vec<LaidCell>> = Vec::with_capacity(t.rows.len());
        for (r, row) in t.rows.iter().enumerate() {
            let mut from = 0;
            let mut cells = Vec::new();
            for c in row {
                let n = c.span.max(1).min(columns - from.min(columns));
                if from >= columns || n == 0 {
                    break;
                }
                let (x, width) = cell_x(from, n);
                let face = self.face_for(&c.text);
                let inner = (width - 2.0 * CELL_PAD.0).max(size);
                let lines = self.break_lines(face, &c.text, size, inner, false);
                cells.push(LaidCell {
                    x,
                    width,
                    face,
                    lines,
                    bold: c.bold || r < t.header_rows,
                    align: c.align,
                    dir: resolve(c.dir, &c.text, dir),
                });
                from += n;
            }
            laid.push(cells);
        }
        let line_h = self.faces[0].line(size, 1.0).0;
        let header_rows = t.header_rows.min(laid.len());
        let header_h: f32 = laid[..header_rows]
            .iter()
            .map(|cells| row_height(cells, line_h))
            .sum();
        if !self.at_top() {
            self.y -= t.space_before.max(0.0);
        }
        for r in 0..laid.len() {
            let mut from = vec![0usize; laid[r].len()];
            let header = r < header_rows;
            loop {
                let left_over: Vec<usize> = laid[r]
                    .iter()
                    .zip(&from)
                    .map(|(c, f)| c.lines.len().saturating_sub(*f))
                    .collect();
                let needed =
                    left_over.iter().copied().max().unwrap_or(0) as f32 * line_h + 2.0 * CELL_PAD.1;
                let room = self.y - self.bottom();
                let page_room = self.top() - self.bottom() - if header { 0.0 } else { header_h };
                // A row that fits on a page of its own goes there whole; a
                // taller one is broken between its lines.
                if needed > room + 0.01
                    && !self.at_top()
                    && (needed <= page_room || room < line_h + 2.0 * CELL_PAD.1)
                {
                    self.new_page();
                    if !header {
                        self.repeat_header(&laid[..header_rows], line_h, size);
                    }
                    continue;
                }
                let fit = (((self.y - self.bottom() - 2.0 * CELL_PAD.1) / line_h).floor() as usize)
                    .max(1);
                let take: Vec<usize> = left_over.iter().map(|n| (*n).min(fit)).collect();
                let height = self.row_fragment(&laid[r], &from, &take, line_h, size, header);
                self.y -= height;
                for (f, n) in from.iter_mut().zip(&take) {
                    *f += n;
                }
                if laid[r].iter().zip(&from).all(|(c, f)| *f >= c.lines.len()) {
                    break;
                }
                self.new_page();
                if !header {
                    self.repeat_header(&laid[..header_rows], line_h, size);
                }
            }
        }
        self.y -= t.space_after.max(0.0);
    }

    fn repeat_header(&mut self, header: &[Vec<LaidCell>], line_h: f32, size: f32) {
        for cells in header {
            let from = vec![0; cells.len()];
            let take: Vec<usize> = cells.iter().map(|c| c.lines.len()).collect();
            let h = self.row_fragment(cells, &from, &take, line_h, size, true);
            self.y -= h;
        }
    }

    /// Lines `from..from + take` of each cell of a row, with the cells' boxes;
    /// returns the height drawn.
    fn row_fragment(
        &mut self,
        cells: &[LaidCell],
        from: &[usize],
        take: &[usize],
        line_h: f32,
        size: f32,
        header: bool,
    ) -> f32 {
        let height =
            take.iter().copied().max().unwrap_or(0).max(1) as f32 * line_h + 2.0 * CELL_PAD.1;
        let top = self.y;
        for (k, c) in cells.iter().enumerate() {
            let rect = [c.x, top - height, c.width, height];
            if header {
                self.draw(Draw::Fill {
                    rect,
                    color: HEADER_SHADE,
                });
            }
            let baseline_off = self.faces[c.face].line(size, 1.0).1;
            let bounds = (c.x + CELL_PAD.0, c.x + c.width - CELL_PAD.0);
            for (i, (line, last)) in c.lines.iter().skip(from[k]).take(take[k]).enumerate() {
                let baseline = top - CELL_PAD.1 - i as f32 * line_h - baseline_off;
                self.draw_line(
                    c.face, line, *last, bounds, baseline, size, c.align, c.dir, [0.0; 3], c.bold,
                );
            }
            self.draw(Draw::Frame {
                rect,
                grey: BORDER_GREY,
            });
        }
        height
    }
}

fn row_height(cells: &[LaidCell], line_h: f32) -> f32 {
    cells
        .iter()
        .map(|c| c.lines.len())
        .max()
        .unwrap_or(1)
        .max(1) as f32
        * line_h
        + 2.0 * CELL_PAD.1
}

fn real(v: f32) -> Object {
    Object::Real(if v.is_finite() {
        (v * 1000.0).round() / 1000.0
    } else {
        0.0
    })
}

fn op(name: &str, operands: Vec<Object>) -> Operation {
    Operation::new(name, operands)
}

fn rgb(color: [f32; 3]) -> Vec<Object> {
    color.iter().map(|c| real(c.clamp(0.0, 1.0))).collect()
}

/// The page's drawing as a content stream.
fn page_ops(
    draws: &[Draw],
    faces: &[Face],
    subsets: &[Option<FontSubset>],
    pictures: &HashMap<ObjectId, String>,
) -> Vec<Operation> {
    let mut ops = Vec::new();
    for d in draws {
        match d {
            Draw::Text {
                face,
                glyphs,
                x,
                baseline,
                size,
                stretch,
                color,
                bold,
            } => {
                let Some(subset) = subsets.get(*face).and_then(Option::as_ref) else {
                    continue;
                };
                ops.push(op("q", vec![]));
                ops.push(op("rg", rgb(*color)));
                if *bold {
                    ops.push(op("RG", rgb(*color)));
                    ops.push(op("w", vec![real(size * BOLD_STROKE)]));
                    ops.push(op("j", vec![Object::Integer(1)]));
                }
                ops.push(op("BT", vec![]));
                ops.push(op(
                    "Tf",
                    vec![Object::Name(format!("F{face}").into_bytes()), real(*size)],
                ));
                if *bold {
                    ops.push(op("Tr", vec![Object::Integer(2)]));
                }
                show_line(
                    &mut ops,
                    subset,
                    &faces[*face].shaper,
                    &ShownLine {
                        glyphs,
                        matrix: [1.0, 0.0, 0.0, 1.0, *x, *baseline],
                        size: *size,
                        space_stretch: *stretch,
                    },
                );
                ops.push(op("ET", vec![]));
                ops.push(op("Q", vec![]));
            }
            Draw::Line {
                from,
                to,
                width,
                grey,
            } => {
                ops.push(op("q", vec![]));
                ops.push(op("G", vec![real(*grey)]));
                ops.push(op("w", vec![real(*width)]));
                ops.push(op("m", vec![real(from.0), real(from.1)]));
                ops.push(op("l", vec![real(to.0), real(to.1)]));
                ops.push(op("S", vec![]));
                ops.push(op("Q", vec![]));
            }
            Draw::Frame { rect, grey } => {
                ops.push(op("q", vec![]));
                ops.push(op("G", vec![real(*grey)]));
                ops.push(op("w", vec![real(0.5)]));
                ops.push(op("re", rect.iter().map(|v| real(*v)).collect()));
                ops.push(op("S", vec![]));
                ops.push(op("Q", vec![]));
            }
            Draw::Fill { rect, color } => {
                ops.push(op("q", vec![]));
                ops.push(op("rg", rgb(*color)));
                ops.push(op("re", rect.iter().map(|v| real(*v)).collect()));
                ops.push(op("f", vec![]));
                ops.push(op("Q", vec![]));
            }
            Draw::Picture { id, matrix } => {
                let Some(name) = pictures.get(id) else {
                    continue;
                };
                ops.push(op("q", vec![]));
                ops.push(op("cm", matrix.iter().map(|v| real(*v)).collect()));
                ops.push(op("Do", vec![Object::Name(name.clone().into_bytes())]));
                ops.push(op("Q", vec![]));
            }
        }
    }
    ops
}

/// Writes the pages, the catalog and the file's information, and the file.
fn finish(
    mut doc: Document,
    pages: Vec<(f32, f32, Vec<Operation>, Object)>,
    info: &FileInfo,
) -> Result<Vec<u8>> {
    let pages_id = doc.new_object_id();
    let mut kids = Vec::with_capacity(pages.len());
    for (width, height, ops, resources) in pages {
        let bytes = Content { operations: ops }
            .encode()
            .map_err(|e| refuse(&format!("a page could not be written: {e}")))?;
        let mut stream = Stream::new(Dictionary::new(), bytes);
        let _ = stream.compress();
        let contents = doc.add_object(stream);
        let page = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), real(width), real(height)],
            "Contents" => contents,
            "Resources" => resources,
        });
        kids.push(Object::Reference(page));
    }
    let count = kids.len() as i64;
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => kids, "Count" => count }),
    );
    let mut catalog = dictionary! { "Type" => "Catalog", "Pages" => pages_id };
    if let Some(lang) = info.lang.filter(|l| !l.is_empty() && l.len() < 36) {
        catalog.set("Lang", text_string(lang));
    }
    // No `/Direction /R2L`, though an Arabic book turns that way: PDFium
    // (EmbedPDF, Chrome) then reads every line of the file right to left,
    // and an English line comes out with its words backwards.
    if info.title.is_some() {
        catalog.set(
            "ViewerPreferences",
            dictionary! { "DisplayDocTitle" => true },
        );
    }
    let catalog = doc.add_object(catalog);
    let mut about =
        dictionary! { "Producer" => text_string("Warraq"), "Creator" => text_string("Warraq") };
    if let Some(title) = info.title.filter(|t| !t.trim().is_empty()) {
        about.set("Title", text_string(title));
    }
    if let Some(date) = info
        .created
        .filter(|d| d.starts_with("D:") && d.len() <= 30)
    {
        about.set("CreationDate", text_string(date));
        about.set("ModDate", text_string(date));
    }
    let about = doc.add_object(about);
    doc.trailer.set("Root", catalog);
    doc.trailer.set("Info", about);
    let mut out = Vec::new();
    doc.save_to(&mut out)
        .map_err(|e| Error::Io(e.to_string()))?;
    Ok(out)
}

/// A new PDF of `source`'s blocks, typeset on its pages.
pub fn create_document(source: &DocumentSource) -> Result<(Vec<u8>, CreateReport)> {
    let setup = usable_setup(&source.page)?;
    if source.fonts.is_empty() {
        return Err(refuse("a document needs a font to be set in"));
    }
    let mut faces = Vec::with_capacity(source.fonts.len());
    for (k, bytes) in source.fonts.iter().enumerate() {
        let name = source
            .font_names
            .get(k)
            .map(String::as_str)
            .unwrap_or("Font");
        faces.push(Face::new(bytes, name)?);
    }
    // Which way the document runs, for what has no letters of its own.
    let (mut rtl, mut ltr) = (0usize, 0usize);
    for block in source.blocks {
        let (text, dir) = match block {
            Block::Text(b) => (b.text.as_str(), b.dir),
            _ => continue,
        };
        let weight = text.chars().filter(|c| c.is_alphabetic()).count();
        match resolve(dir, text, Direction::Ltr) {
            Direction::Rtl => rtl += weight,
            Direction::Ltr => ltr += weight,
        }
    }
    let dir = if rtl > ltr {
        Direction::Rtl
    } else {
        Direction::Ltr
    };
    let mut t = Typesetter {
        setup,
        faces,
        pages: Vec::new(),
        y: 0.0,
        report: CreateReport::default(),
        doc: Document::with_version("1.7"),
        pictures: HashMap::new(),
        pictures_source: source.pictures,
        dir,
    };
    t.new_page();
    for (k, block) in source.blocks.iter().enumerate() {
        match block {
            Block::Text(b) => {
                let next = if b.keep_with_next {
                    t.first_line(source.blocks.get(k + 1))
                } else {
                    0.0
                };
                t.text(b, next);
            }
            Block::Table(b) => t.table(b),
            Block::Image(b) => t.image(b),
            Block::PageBreak => {
                if !t.at_top() {
                    t.new_page();
                }
            }
            Block::Rule => t.rule(),
        }
    }
    // A break at the very end leaves no empty page behind it.
    if t.pages.len() > 1 && t.pages.last().is_some_and(Vec::is_empty) {
        t.pages.pop();
    }
    let Typesetter {
        mut doc,
        faces,
        pages,
        report,
        pictures,
        ..
    } = t;
    let mut subsets = Vec::with_capacity(faces.len());
    let mut font_ids = Vec::with_capacity(faces.len());
    for face in &faces {
        if face.used.is_empty() {
            subsets.push(None);
            font_ids.push(None);
            continue;
        }
        let subset = FontSubset::build(face.bytes, &face.shaper, &face.used)?;
        let name = if face.name.is_empty() {
            "Font".to_string()
        } else {
            face.name.clone()
        };
        font_ids.push(Some(embed_subset_font(
            &mut doc,
            &face.shaper,
            &subset,
            &name,
        )));
        subsets.push(Some(subset));
    }
    let mut picture_names = HashMap::new();
    for (id, _) in pictures.values().flatten() {
        let next = format!("Im{}", picture_names.len());
        picture_names.entry(*id).or_insert(next);
    }
    let mut fonts = Dictionary::new();
    for (k, id) in font_ids.iter().enumerate() {
        if let Some(id) = id {
            fonts.set(format!("F{k}"), *id);
        }
    }
    let mut xobjects = Dictionary::new();
    for (id, name) in &picture_names {
        xobjects.set(name.as_str(), *id);
    }
    let mut resources = Dictionary::new();
    if !fonts.is_empty() {
        resources.set("Font", fonts);
    }
    if !xobjects.is_empty() {
        resources.set("XObject", xobjects);
    }
    let resources = doc.add_object(resources);
    let written: Vec<(f32, f32, Vec<Operation>, Object)> = pages
        .iter()
        .map(|draws| {
            let ops = page_ops(draws, &faces, &subsets, &picture_names);
            (setup.width, setup.height, ops, Object::Reference(resources))
        })
        .collect();
    let count = written.len();
    let bytes = finish(doc, written, &source.info)?;
    Ok((
        bytes,
        CreateReport {
            pages: count,
            ..report
        },
    ))
}

/// How pictures become pages.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PicturePaper {
    /// Each page the picture's own size, at the resolution it records (96
    /// per inch when it records none).
    Own,
    /// Paper of this size (portrait), turned to suit each picture, with the
    /// picture fitted inside the margin and centred.
    Paper { width: f32, height: f32 },
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PictureSetup {
    pub paper: PicturePaper,
    /// Around the picture, in points (paper only).
    pub margin: f32,
}

/// What making a file of pictures did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PictureReport {
    pub pages: usize,
    /// The pictures (by index) that could not be read, left out.
    pub left_out: Vec<usize>,
}

/// A new PDF with each picture on a page of its own, upright as the camera
/// meant it (EXIF orientation) — a JPEG as it is, without loss.
pub fn create_from_pictures(
    pictures: &[Vec<u8>],
    setup: &PictureSetup,
    info: &FileInfo,
) -> Result<(Vec<u8>, PictureReport)> {
    let mut doc = Document::with_version("1.7");
    let mut pages = Vec::new();
    let mut report = PictureReport::default();
    for (k, bytes) in pictures.iter().enumerate() {
        let placed = picture_info(bytes)
            .and_then(|info| add_picture(&mut doc, bytes).ok().map(|p| (p, info)));
        let Some((picture, pinfo)) = placed else {
            report.left_out.push(k);
            continue;
        };
        let (pw, ph) = pinfo.shown();
        let (pw, ph) = (pw.max(1) as f32, ph.max(1) as f32);
        let (width, height, rect) = match setup.paper {
            PicturePaper::Own => {
                let per_point = pinfo.dpi.unwrap_or(96.0) / 72.0;
                let (mut w, mut h) = (pw / per_point, ph / per_point);
                // Within PDF's limits: shrunk to fit the largest page, grown to the smallest.
                let down = (MAX_SIDE / w).min(MAX_SIDE / h).min(1.0);
                w *= down;
                h *= down;
                let up = (MIN_SIDE / w.min(h)).max(1.0);
                w = (w * up).min(MAX_SIDE);
                h = (h * up).min(MAX_SIDE);
                (w, h, [0.0, 0.0, w, h])
            }
            PicturePaper::Paper { width, height } => {
                let (short, long) = (width.min(height), width.max(height));
                let (short, long) = (
                    short.clamp(MIN_SIDE, MAX_SIDE),
                    long.clamp(MIN_SIDE, MAX_SIDE),
                );
                let (w, h) = if pw > ph {
                    (long, short)
                } else {
                    (short, long)
                };
                let margin = setup.margin.clamp(0.0, short / 4.0);
                let (room_w, room_h) = (w - 2.0 * margin, h - 2.0 * margin);
                let fit = (room_w / pw).min(room_h / ph);
                let (iw, ih) = (pw * fit, ph * fit);
                (w, h, [(w - iw) / 2.0, (h - ih) / 2.0, iw, ih])
            }
        };
        let matrix = upright_matrix(pinfo.orientation, rect[0], rect[1], rect[2], rect[3]);
        let ops = vec![
            op("q", vec![]),
            op("cm", matrix.iter().map(|v| real(*v)).collect()),
            op("Do", vec![Object::Name(b"Im0".to_vec())]),
            op("Q", vec![]),
        ];
        let resources = dictionary! { "XObject" => dictionary! { "Im0" => picture.id } };
        pages.push((width, height, ops, Object::Dictionary(resources)));
    }
    if pages.is_empty() {
        return Err(Error::Edit(
            "E_IMAGE: none of the pictures could be read".into(),
        ));
    }
    report.pages = pages.len();
    Ok((finish(doc, pages, info)?, report))
}
