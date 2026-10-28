//! New PDFs from other content (Export / Create): pictures, one to a page,
//! and documents — paragraphs, lists, tables, pictures, rules and text boxes
//! placed on a page — typeset in bundled faces with Arabic shaped by
//! `warraq-text`.
//!
//! The interface reads a Word file, a spreadsheet, a presentation, a web
//! page, Markdown or plain text into [`Block`]s; this lays them out on pages
//! and writes the file. Its text is written as all of Warraq's text is
//! (`show_line`): an embedded subset with a ToUnicode map, and `/ActualText`
//! where the glyphs alone would not read back, so a reader — Warraq's own,
//! PDFium, a screen reader — finds what was typed. Nothing is rasterised: a
//! created page is text and vectors, and the pictures go in as they came (a
//! JPEG unchanged).
//!
//! The layout is a plain one, and says so: one face and size per paragraph,
//! with bold, italic, underline, strike-through, colour and links changing
//! inside it (bold drawn by stroking the glyphs as they are filled, italic
//! by slanting them, both of which read back unchanged); greedy line breaking
//! at spaces; tables as a grid of wrapped cells that break across pages
//! between their lines and repeat their header rows; text boxes (a slide's)
//! placed where they were, their text running over rather than shrinking;
//! headers and footers on every page, with its number. It is not Word's or
//! PowerPoint's layout and does not pretend to be.
use std::collections::HashMap;

use lopdf::content::{Content, Operation};
use lopdf::{dictionary, Dictionary, Document, Object, ObjectId, Stream, StringFormat};
use warraq_text::normalize::mirror_bracket;
use warraq_text::{base_direction, visual_runs_in, Direction, ShapedGlyph, Shaper};

use crate::attachments::text_string;
use crate::fonts::{embed_subset_font, FontSubset};
use crate::picture::{add_picture, add_picture_pages, picture_info, upright_matrix, PictureInfo};
use crate::show::{show_line, ShownLine};
use crate::{Error, Result};

/// Sets a left-to-right stretch apart inside a line (UAX #9 LRI and PDI).
pub const LTR_ISOLATE: char = '\u{2066}';
pub const POP_ISOLATE: char = '\u{2069}';

/// A character that only steers the order of a line and draws nothing.
fn is_bidi_control(c: char) -> bool {
    matches!(c, '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
}

/// PDF's own limit on a page side (Annex C: 14,400 units).
const MAX_SIDE: f32 = 14_400.0;
const MIN_SIDE: f32 = 72.0;
/// Of the text size: how much bolder a bold line's stroke makes it.
const BOLD_STROKE: f32 = 0.035;
/// How far an italic run leans: the tangent of about 11°.
const ITALIC_SLANT: f32 = 0.2;
/// Around the text of a table cell, in points.
const CELL_PAD: (f32, f32) = (4.0, 3.0);
const RULE_GREY: f32 = 0.7;
const BORDER_GREY: f32 = 0.55;
const HEADER_SHADE: [f32; 3] = [0.93, 0.93, 0.94];
/// The app's name, as a made file's /Producer and /Creator say it.
pub const APP_NAME: &str = "ZOOD PDF";
/// In a header or footer, where the page's number goes.
pub const PAGE_NUMBER: char = '\u{E000}';
/// In a header or footer, where the number of pages goes.
pub const PAGE_COUNT: char = '\u{E001}';

/// A page's size and the margins inside it, in points.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PageSetup {
    pub width: f32,
    pub height: f32,
    /// Top, right, bottom, left.
    pub margins: [f32; 4],
    /// From the top edge to the top of the header.
    pub header: f32,
    /// From the bottom edge to the foot of the footer.
    pub footer: f32,
}

impl PageSetup {
    /// A page with the header and footer half an inch from its edges.
    pub fn new(width: f32, height: f32, margins: [f32; 4]) -> Self {
        Self {
            width,
            height,
            margins,
            header: 36.0,
            footer: 36.0,
        }
    }
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

/// A stretch of a paragraph set differently from the rest of it.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct TextRun {
    pub text: String,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub strike: bool,
    /// RGB, 0–1; the paragraph's colour when absent.
    pub color: Option<[f32; 3]>,
    /// An `http:`, `https:` or `mailto:` address the run links to; any
    /// other is left out.
    pub link: Option<String>,
}

/// A paragraph, a heading, a list item or a line of code.
#[derive(Debug, Clone, PartialEq)]
pub struct TextBlock {
    /// `\n` breaks a line without ending the paragraph. Ignored when the
    /// paragraph has `runs`: its text is theirs, one after the other.
    pub text: String,
    pub runs: Vec<TextRun>,
    pub size: f32,
    pub bold: bool,
    pub italic: bool,
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
    /// The face the source names for it (an index into the document's
    /// faces), used when it has every letter; otherwise the first that does.
    pub face: Option<usize>,
}

impl Default for TextBlock {
    fn default() -> Self {
        Self {
            text: String::new(),
            runs: Vec::new(),
            size: 11.0,
            bold: false,
            italic: false,
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
            face: None,
        }
    }
}

impl TextBlock {
    /// What the paragraph says.
    pub fn plain(&self) -> String {
        if self.runs.is_empty() {
            self.text.clone()
        } else {
            self.runs.iter().map(|r| r.text.as_str()).collect()
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
    /// A shade behind the cell.
    pub fill: Option<[f32; 3]>,
    /// The colour of its text; black when absent.
    pub color: Option<[f32; 3]>,
    /// The face the source names for it; the table's when absent.
    pub face: Option<usize>,
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
    /// The face the source names for its cells.
    pub face: Option<usize>,
}

/// A picture of the document: `index` into the pictures handed over, at its
/// size in points when the source gave one, else at 96 per inch, never
/// wider or taller than the room it is in.
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

/// Where a text box's content sits when it is shorter than the box.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameAnchor {
    Top,
    Middle,
    Bottom,
}

/// A box placed on the current page — a slide's text box, shape or
/// picture — with blocks laid out inside it. It does not move the text
/// flowing around it, and its content never starts a page: what does not
/// fit runs over its foot.
#[derive(Debug, Clone, PartialEq)]
pub struct FrameBlock {
    /// From the page's top-left corner, in points, y down.
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub fill: Option<[f32; 3]>,
    /// The outline's colour and width.
    pub line: Option<([f32; 3], f32)>,
    /// Room inside the edges: left, top, right, bottom.
    pub inset: [f32; 4],
    pub anchor: FrameAnchor,
    /// Text, tables, pictures and rules; a frame or page inside a frame is
    /// left out.
    pub blocks: Vec<Block>,
}

/// A new page of its own size (a slide, a landscape section), optionally
/// filled with a colour.
#[derive(Debug, Clone, PartialEq)]
pub struct PageBlock {
    pub page: PageSetup,
    pub background: Option<[f32; 3]>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Block {
    Text(TextBlock),
    Table(TableBlock),
    Image(ImageBlock),
    Frame(FrameBlock),
    Page(PageBlock),
    PageBreak,
    /// A thin line across the text area.
    Rule,
}

/// Everything a document is made from.
pub struct DocumentSource<'a> {
    pub page: PageSetup,
    pub blocks: &'a [Block],
    /// On every page, above the top margin and below the bottom one;
    /// [`PAGE_NUMBER`] and [`PAGE_COUNT`] in their text become numbers.
    pub header: &'a [Block],
    pub footer: &'a [Block],
    /// The faces to set text in: the first for everything it has glyphs
    /// for, the others for paragraphs it does not cover.
    pub fonts: &'a [&'a [u8]],
    /// Names for the faces in the file (`/BaseFont`), in the same order.
    pub font_names: &'a [String],
    /// Pictures for the image blocks: PNG, JPEG, GIF, BMP, WebP or TIFF.
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
    let distance = |d: f32, margin: f32| {
        if d.is_finite() {
            d.clamp(0.0, margin.max(0.0))
        } else {
            (margin / 2.0).max(0.0)
        }
    };
    Ok(PageSetup {
        margins,
        header: distance(page.header, margins[0]),
        footer: distance(page.footer, margins[2]),
        ..*page
    })
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

/// How a stretch of a paragraph is set.
#[derive(Debug, Clone, PartialEq)]
struct Style {
    bold: bool,
    italic: bool,
    underline: bool,
    strike: bool,
    color: [f32; 3],
    /// Into the document's links.
    link: Option<usize>,
}

/// A character and the style it is set in (an index into the paragraph's styles).
type SChar = (char, u16);

/// One line of a paragraph, as broken.
struct Line {
    chars: Vec<SChar>,
    /// It ends a line of the source: not justified.
    last: bool,
}

fn text_of(chars: &[SChar]) -> String {
    chars.iter().map(|c| c.0).collect()
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
        skew: f32,
        /// Stretches of `glyphs` that read as one text (`ShownLine::groups`).
        groups: Vec<(std::ops::Range<usize>, String)>,
    },
    Line {
        from: (f32, f32),
        to: (f32, f32),
        width: f32,
        color: [f32; 3],
    },
    Border {
        rect: [f32; 4],
        color: [f32; 3],
        width: f32,
    },
    Fill {
        rect: [f32; 4],
        color: [f32; 3],
    },
    Picture {
        id: ObjectId,
        matrix: [f32; 6],
    },
    Link {
        rect: [f32; 4],
        uri: usize,
    },
}

impl Draw {
    /// Moved up by `dy` (down when negative).
    fn shift(&mut self, dy: f32) {
        match self {
            Draw::Text { baseline, .. } => *baseline += dy,
            Draw::Line { from, to, .. } => {
                from.1 += dy;
                to.1 += dy;
            }
            Draw::Border { rect, .. } | Draw::Fill { rect, .. } | Draw::Link { rect, .. } => {
                rect[1] += dy
            }
            Draw::Picture { matrix, .. } => matrix[5] += dy,
        }
    }
}

/// A cell of a table row, broken into lines for its column.
struct LaidCell {
    /// Left edge and width of the cell's box.
    x: f32,
    width: f32,
    face: usize,
    lines: Vec<Line>,
    bold: bool,
    align: BlockAlign,
    dir: Direction,
    fill: Option<[f32; 3]>,
    /// Its text's size: the table's, or smaller so its longest word fits.
    size: f32,
    color: [f32; 3],
}

/// The room text flows in: the page inside its margins, or a frame.
#[derive(Debug, Clone, Copy)]
struct Area {
    left: f32,
    right: f32,
    top: f32,
    bottom: f32,
}

fn area_of(setup: &PageSetup) -> Area {
    Area {
        left: setup.margins[3],
        right: setup.width - setup.margins[1],
        top: setup.height - setup.margins[0],
        bottom: setup.margins[2],
    }
}

/// A page being made: its size and what is drawn on it.
struct OutPage {
    setup: PageSetup,
    draws: Vec<Draw>,
}

struct Typesetter<'a> {
    /// The size of the pages the text flows onto next.
    setup: PageSetup,
    faces: Vec<Face<'a>>,
    pages: Vec<OutPage>,
    /// The page drawn on now.
    current: usize,
    area: Area,
    /// Laying out inside a frame: never starting a page.
    framed: bool,
    /// Top of the free space in the area.
    y: f32,
    report: CreateReport,
    doc: Document,
    pictures: HashMap<usize, Option<(ObjectId, PictureInfo)>>,
    pictures_source: &'a [Vec<u8>],
    /// The direction most of the document's text runs in.
    dir: Direction,
    /// The addresses links go to, each once.
    links: Vec<String>,
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

/// Collapses runs of white space into one space, as HTML and Word do; a
/// space keeps the style of the first white space of its run.
fn collapse(text: &[SChar]) -> Vec<SChar> {
    let mut out = Vec::with_capacity(text.len());
    let mut space: Option<u16> = None;
    for &(c, s) in text {
        if c.is_whitespace() && c != '\u{00A0}' {
            if !out.is_empty() && space.is_none() {
                space = Some(s);
            }
        } else {
            if let Some(style) = space.take() {
                out.push((' ', style));
            }
            out.push((c, s));
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

fn is_space(g: &ShapedGlyph) -> bool {
    !g.text.is_empty() && g.text.chars().all(char::is_whitespace)
}

/// An address a link may go to: the web or mail, nothing that runs or opens a file.
fn safe_link(uri: &str) -> Option<String> {
    let uri = uri.trim();
    let lower = uri.to_ascii_lowercase();
    let allowed = ["http://", "https://", "mailto:"]
        .iter()
        .any(|scheme| lower.starts_with(scheme));
    if !allowed || uri.len() > 2048 || uri.chars().any(char::is_control) {
        return None;
    }
    // A URI action's address is seven-bit ASCII: the rest is percent-encoded.
    let mut out = String::with_capacity(uri.len());
    for b in uri.bytes() {
        if b.is_ascii_graphic() {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    Some(out)
}

/// `blocks` with the page's number and the count of pages in their text.
fn numbered(blocks: &[Block], page: usize, pages: usize) -> Vec<Block> {
    let fill = |text: &str| {
        text.replace(PAGE_NUMBER, &page.to_string())
            .replace(PAGE_COUNT, &pages.to_string())
    };
    blocks
        .iter()
        .map(|block| match block {
            Block::Text(t) => {
                let mut t = t.clone();
                t.text = fill(&t.text);
                for run in &mut t.runs {
                    run.text = fill(&run.text);
                }
                Block::Text(t)
            }
            Block::Table(t) => {
                let mut t = t.clone();
                for cell in t.rows.iter_mut().flatten() {
                    cell.text = fill(&cell.text);
                }
                Block::Table(t)
            }
            other => other.clone(),
        })
        .collect()
}

impl<'a> Typesetter<'a> {
    fn top(&self) -> f32 {
        self.area.top
    }
    /// Where the flow must start a new page; inside a frame, nowhere.
    fn bottom(&self) -> f32 {
        if self.framed {
            f32::NEG_INFINITY
        } else {
            self.area.bottom
        }
    }
    fn left(&self) -> f32 {
        self.area.left
    }
    fn right(&self) -> f32 {
        self.area.right
    }
    /// Nothing is in the area yet.
    fn at_top(&self) -> bool {
        self.y >= self.top() - 0.01
    }

    fn new_page(&mut self) {
        if self.framed {
            return;
        }
        self.pages.push(OutPage {
            setup: self.setup,
            draws: Vec::new(),
        });
        self.current = self.pages.len() - 1;
        self.area = area_of(&self.setup);
        self.y = self.top();
    }

    fn draw(&mut self, d: Draw) {
        if let Draw::Text { face, glyphs, .. } = &d {
            self.faces[*face].used.extend(glyphs.iter().cloned());
        }
        if let Some(page) = self.pages.get_mut(self.current) {
            page.draws.push(d);
        }
    }

    fn link(&mut self, uri: &str) -> Option<usize> {
        let uri = safe_link(uri)?;
        if let Some(k) = self.links.iter().position(|l| *l == uri) {
            return Some(k);
        }
        if self.links.len() >= 10_000 {
            return None;
        }
        self.links.push(uri);
        Some(self.links.len() - 1)
    }

    /// `face_for`, the face the source named first when it has every letter.
    fn face_named(&mut self, named: Option<usize>, text: &str) -> usize {
        match named {
            Some(k) if self.faces.get(k).is_some_and(|f| f.shaper.covers(text)) => k,
            _ => self.face_for(text),
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

    /// The paragraph's characters with the styles they are set in; style 0
    /// is the paragraph's own.
    fn styled(&mut self, b: &TextBlock) -> (Vec<SChar>, Vec<Style>) {
        let own = Style {
            bold: b.bold,
            italic: b.italic,
            underline: false,
            strike: false,
            color: b.color,
            link: None,
        };
        let mut styles = vec![own];
        if b.runs.is_empty() {
            return (b.text.chars().map(|c| (c, 0)).collect(), styles);
        }
        let mut chars = Vec::new();
        for run in &b.runs {
            let style = Style {
                bold: b.bold || run.bold,
                italic: b.italic || run.italic,
                underline: run.underline,
                strike: run.strike,
                color: run.color.unwrap_or(b.color),
                link: run.link.as_deref().and_then(|u| self.link(u)),
            };
            let k = match styles.iter().position(|s| *s == style) {
                Some(k) => k,
                None if styles.len() < 4096 => {
                    styles.push(style);
                    styles.len() - 1
                }
                None => 0,
            };
            chars.extend(run.text.chars().map(|c| (c, k as u16)));
        }
        (chars, styles)
    }

    /// `text` broken into lines no wider than `width` at `size`: at spaces,
    /// and inside a word only when the word alone is wider than the line.
    fn break_lines(
        &mut self,
        face: usize,
        text: &[SChar],
        size: f32,
        width: f32,
        preserve: bool,
    ) -> Vec<Line> {
        let scale = size / 1000.0;
        let max = width.max(size);
        let mut out: Vec<Line> = Vec::new();
        for hard in text.split(|c| c.0 == '\n') {
            let start = out.len();
            if preserve {
                let mut source = Vec::with_capacity(hard.len());
                for &(c, s) in hard {
                    match c {
                        '\t' => source.extend([(' ', s); 4]),
                        '\r' => {}
                        _ => source.push((c, s)),
                    }
                }
                self.split_to_fit(face, &source, scale, max, &mut out);
            } else {
                let source = collapse(hard);
                let space = self.faces[face].width(" ") * scale;
                let mut current: Vec<SChar> = Vec::new();
                let mut current_w = 0.0f32;
                let mut gap: Option<SChar> = None;
                let mut i = 0;
                while i < source.len() {
                    if source[i].0 == ' ' {
                        gap = Some(source[i]);
                        i += 1;
                        continue;
                    }
                    let end = source[i..]
                        .iter()
                        .position(|c| c.0 == ' ')
                        .map_or(source.len(), |p| i + p);
                    let word = &source[i..end];
                    i = end;
                    let w = self.faces[face].width(&text_of(word)) * scale;
                    if w > max {
                        if !current.is_empty() {
                            out.push(Line {
                                chars: std::mem::take(&mut current),
                                last: false,
                            });
                        }
                        self.split_to_fit(face, word, scale, max, &mut out);
                        if let Some(last) = out.pop() {
                            current_w = self.faces[face].width(&text_of(&last.chars)) * scale;
                            current = last.chars;
                        }
                    } else if current.is_empty() {
                        current = word.to_vec();
                        current_w = w;
                    } else if current_w + space + w <= max + 0.01 {
                        current.push(gap.unwrap_or((' ', word[0].1)));
                        current.extend_from_slice(word);
                        current_w += space + w;
                    } else {
                        out.push(Line {
                            chars: std::mem::replace(&mut current, word.to_vec()),
                            last: false,
                        });
                        current_w = w;
                    }
                    gap = None;
                }
                if !current.is_empty() {
                    out.push(Line {
                        chars: current,
                        last: false,
                    });
                }
            }
            if out.len() == start {
                out.push(Line {
                    chars: Vec::new(),
                    last: false,
                });
            }
            if let Some(last) = out.last_mut() {
                last.last = true;
            }
        }
        out
    }

    /// A run too long for the line, in pieces that fit, letter by letter.
    fn split_to_fit(
        &mut self,
        face: usize,
        text: &[SChar],
        scale: f32,
        max: f32,
        out: &mut Vec<Line>,
    ) {
        let mut piece: Vec<SChar> = Vec::new();
        let mut piece_w = 0.0f32;
        for &(c, s) in text {
            let mut buf = [0u8; 4];
            let w = self.faces[face].width(c.encode_utf8(&mut buf)) * scale;
            if !piece.is_empty() && piece_w + w > max {
                out.push(Line {
                    chars: std::mem::take(&mut piece),
                    last: false,
                });
                piece_w = 0.0;
            }
            piece.push((c, s));
            piece_w += w;
        }
        if !piece.is_empty() || out.is_empty() {
            out.push(Line {
                chars: piece,
                last: false,
            });
        }
    }

    /// One line of text, shaped and placed in `[left, right]` with its
    /// baseline at `baseline`: each stretch of one style drawn in it, with
    /// its underline, strike-through and link.
    #[allow(clippy::too_many_arguments)]
    fn draw_line(
        &mut self,
        face: usize,
        line: &[SChar],
        last: bool,
        (left, right): (f32, f32),
        baseline: f32,
        size: f32,
        align: BlockAlign,
        dir: Direction,
        styles: &[Style],
    ) {
        if line.iter().all(|c| c.0.is_whitespace()) {
            return;
        }
        let text = text_of(line);
        // The character each byte of the line starts, for the glyphs' offsets.
        let mut char_at = vec![0u32; text.len() + 1];
        for (k, (b, _)) in text.char_indices().enumerate() {
            char_at[b] = k as u32;
        }
        let mut glyphs = self.faces[face].shaper.shape_line_in(&text, Some(dir));
        if glyphs.is_empty() {
            return;
        }
        // A bracket in a right-to-left run is drawn mirrored: "(" shows as
        // ")". Its glyph reads as the shape it shows, as in Word's PDFs, so
        // a reader that puts the line in reading order turns it back and
        // "(FCFS)" never comes out as ")FCFS(".
        let rtl: Vec<std::ops::Range<usize>> = visual_runs_in(&text, Some(dir))
            .into_iter()
            .filter(|r| r.direction == Direction::Rtl)
            .map(|r| r.range)
            .collect();
        for g in &mut glyphs {
            let mut chars = g.text.chars();
            if let (Some(c), None) = (chars.next(), chars.next()) {
                let mirrored = mirror_bracket(c);
                if mirrored != c && rtl.iter().any(|r| r.contains(&g.offset)) {
                    g.text = mirrored.to_string();
                }
            }
        }
        // A left-to-right stretch the source set apart (Word's run that is
        // not right to left: a date range, "(27/01/2026 - 27/01/2027)") is
        // isolated in the text; it reads as one text, in its own order, and
        // the marks that set it apart draw nothing.
        let mut isolates: Vec<(std::ops::Range<usize>, String)> = Vec::new();
        let mut open: Option<usize> = None;
        for (b, c) in text.char_indices() {
            match c {
                LTR_ISOLATE => open = Some(b + c.len_utf8()),
                POP_ISOLATE => {
                    if let Some(start) = open.take() {
                        isolates.push((start..b, text[start..b].to_string()));
                    }
                }
                _ => {}
            }
        }
        // A letter the face has no glyph for is left out rather than drawn
        // as the empty box (.notdef); `face_for` counted it as missing.
        glyphs.retain(|g| {
            !g.text.chars().any(is_bidi_control) && !(g.gid == 0 && !g.text.trim().is_empty())
        });
        let groups: Vec<(std::ops::Range<usize>, String)> = isolates
            .into_iter()
            .filter_map(|(bytes, said)| {
                let first = glyphs.iter().position(|g| bytes.contains(&g.offset))?;
                let last = glyphs.iter().rposition(|g| bytes.contains(&g.offset))?;
                let mut end = last + 1;
                while end < glyphs.len() && glyphs[end].text.is_empty() {
                    end += 1;
                }
                (!said.trim().is_empty()).then_some((first..end, said))
            })
            .collect();
        if glyphs.is_empty() {
            return;
        }
        let scale = size / 1000.0;
        let natural = glyphs.iter().map(|g| g.x_advance).sum::<f32>() * scale;
        let spaces = glyphs.iter().filter(|g| is_space(g)).count();
        let room = right - left;
        let justify = align == BlockAlign::Justify && !last && spaces > 0 && natural < room;
        let (stretch, width) = if justify {
            ((room - natural) / spaces as f32 / scale, room)
        } else {
            (0.0, natural)
        };
        let x = line_x(align, dir, left, right, width);
        // The style of each glyph; a glyph with no text of its own is part
        // of the cluster before it, and never starts a stretch.
        let mut glyph_style = Vec::with_capacity(glyphs.len());
        for (k, g) in glyphs.iter().enumerate() {
            let s = if g.text.is_empty() && k > 0 {
                glyph_style[k - 1]
            } else {
                let c = char_at.get(g.offset).copied().unwrap_or(0) as usize;
                line.get(c).map_or(0, |c| c.1)
            };
            glyph_style.push(s);
        }
        let own = Style {
            bold: false,
            italic: false,
            underline: false,
            strike: false,
            color: [0.0; 3],
            link: None,
        };
        let mut pen = 0.0f32;
        let mut k = 0;
        while k < glyphs.len() {
            let s = glyph_style[k];
            let (start, from) = (k, pen);
            while k < glyphs.len() && glyph_style[k] == s {
                let extra = if is_space(&glyphs[k]) { stretch } else { 0.0 };
                pen += (glyphs[k].x_advance + extra) * scale;
                k += 1;
            }
            let style = styles.get(s as usize).unwrap_or(&own).clone();
            let (x0, x1) = (x + from, x + pen);
            let inside: Vec<(std::ops::Range<usize>, String)> = groups
                .iter()
                .filter(|(r, _)| r.start >= start && r.end <= k)
                .map(|(r, t)| (r.start - start..r.end - start, t.clone()))
                .collect();
            self.draw(Draw::Text {
                face,
                groups: inside,
                glyphs: glyphs[start..k].to_vec(),
                x: x0,
                baseline,
                size,
                stretch,
                color: style.color,
                bold: style.bold,
                skew: if style.italic { ITALIC_SLANT } else { 0.0 },
            });
            let rule = |y: f32| Draw::Line {
                from: (x0, y),
                to: (x1, y),
                width: (size * 0.055).max(0.4),
                color: style.color,
            };
            if style.underline {
                self.draw(rule(baseline - size * 0.12));
            }
            if style.strike {
                self.draw(rule(baseline + size * 0.26));
            }
            if let Some(uri) = style.link {
                self.draw(Draw::Link {
                    rect: [x0, baseline - size * 0.28, x1 - x0, size * 1.15],
                    uri,
                });
            }
        }
    }

    fn text(&mut self, b: &TextBlock, next_line: f32) {
        let (chars, styles) = self.styled(b);
        let plain = text_of(&chars);
        let face = self.face_named(b.face, &plain);
        let dir = resolve(b.dir, &plain, self.dir);
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
        let lines = self.break_lines(face, &chars, size, right - left, b.preserve);
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
        for (k, line) in lines.iter().enumerate() {
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
                &line.chars,
                line.last,
                (left, right),
                baseline,
                size,
                align,
                dir,
                &styles,
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
                    let marker: Vec<SChar> = marker.chars().map(|c| (c, 0)).collect();
                    // Shaped in the paragraph's direction: "٢." reads ".٢" on the page.
                    self.draw_line(
                        mface,
                        &marker,
                        true,
                        x,
                        baseline,
                        size,
                        BlockAlign::Center,
                        dir,
                        &styles[..1],
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
                let face = self.face_named(t.face, &t.plain());
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
            color: [RULE_GREY; 3],
        });
        self.y -= 7.0;
    }

    fn picture(&mut self, index: usize) -> Option<(ObjectId, PictureInfo)> {
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
        // Never larger than the room it is in: the page's text area, or the frame.
        let (max_w, max_h) = (
            (self.right() - self.left()).max(1.0),
            (self.area.top - self.area.bottom).max(1.0),
        );
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
            .max(t.widths.len())
            .min(1000);
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
                let face = self.face_named(c.face.or(t.face), &c.text);
                let inner = (width - 2.0 * CELL_PAD.0).max(1.0);
                // A word is never broken inside a cell, as a spreadsheet never
                // breaks one: a cell whose longest word is wider than it is
                // set smaller, down to half the size, and only a word wider
                // still is split.
                let longest = c
                    .text
                    .split_whitespace()
                    .map(|w| self.faces[face].width(w))
                    .fold(0.0f32, f32::max)
                    * size
                    / 1000.0
                    * if c.bold || r < t.header_rows { 1.04 } else { 1.0 };
                let cell_size = if longest > inner {
                    (size * inner / longest).max(size / 2.0).max(4.0)
                } else {
                    size
                };
                let chars: Vec<SChar> = c.text.chars().map(|ch| (ch, 0)).collect();
                let lines = self.break_lines(face, &chars, cell_size, inner.max(cell_size), false);
                cells.push(LaidCell {
                    x,
                    width,
                    face,
                    lines,
                    bold: c.bold || r < t.header_rows,
                    align: c.align,
                    dir: resolve(c.dir, &c.text, dir),
                    fill: c.fill,
                    size: cell_size,
                    color: c.color.unwrap_or([0.0; 3]),
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
                        self.repeat_header(&laid[..header_rows], line_h);
                    }
                    continue;
                }
                let fit = (((self.y - self.bottom() - 2.0 * CELL_PAD.1) / line_h).floor() as usize)
                    .max(1);
                let take: Vec<usize> = left_over.iter().map(|n| (*n).min(fit)).collect();
                let height = self.row_fragment(&laid[r], &from, &take, line_h, header);
                self.y -= height;
                for (f, n) in from.iter_mut().zip(&take) {
                    *f += n;
                }
                if laid[r].iter().zip(&from).all(|(c, f)| *f >= c.lines.len()) {
                    break;
                }
                self.new_page();
                if !header {
                    self.repeat_header(&laid[..header_rows], line_h);
                }
            }
        }
        self.y -= t.space_after.max(0.0);
    }

    fn repeat_header(&mut self, header: &[Vec<LaidCell>], line_h: f32) {
        for cells in header {
            let from = vec![0; cells.len()];
            let take: Vec<usize> = cells.iter().map(|c| c.lines.len()).collect();
            let h = self.row_fragment(cells, &from, &take, line_h, true);
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
        header: bool,
    ) -> f32 {
        let height =
            take.iter().copied().max().unwrap_or(0).max(1) as f32 * line_h + 2.0 * CELL_PAD.1;
        let top = self.y;
        for (k, c) in cells.iter().enumerate() {
            let style = [Style {
                bold: c.bold,
                italic: false,
                underline: false,
                strike: false,
                color: c.color,
                link: None,
            }];
            let rect = [c.x, top - height, c.width, height];
            if let Some(color) = c.fill.or(header.then_some(HEADER_SHADE)) {
                self.draw(Draw::Fill { rect, color });
            }
            // A smaller cell's lines sit in the middle of the table's.
            let baseline_off = self.faces[c.face].line(c.size, 1.0).1
                + (line_h - self.faces[c.face].line(c.size, 1.0).0) / 2.0;
            let bounds = (c.x + CELL_PAD.0, c.x + c.width - CELL_PAD.0);
            let styles = &style;
            for (i, line) in c.lines.iter().skip(from[k]).take(take[k]).enumerate() {
                let baseline = top - CELL_PAD.1 - i as f32 * line_h - baseline_off;
                self.draw_line(
                    c.face,
                    &line.chars,
                    line.last,
                    bounds,
                    baseline,
                    c.size,
                    c.align,
                    c.dir,
                    styles,
                );
            }
            self.draw(Draw::Border {
                rect,
                color: [BORDER_GREY; 3],
                width: 0.5,
            });
        }
        height
    }

    /// Lays `blocks` out in `area` without ever starting a page, and moves
    /// what was drawn to sit at the area's top, middle or foot.
    fn layout_in(&mut self, area: Area, blocks: &[Block], anchor: FrameAnchor) {
        if !(area.right - area.left).is_finite() || area.right - area.left < 1.0 {
            return;
        }
        let saved = (self.area, self.y, self.framed);
        self.area = area;
        self.y = area.top;
        self.framed = true;
        let start = self.pages.get(self.current).map_or(0, |p| p.draws.len());
        for block in blocks {
            match block {
                Block::Text(b) => self.text(b, 0.0),
                Block::Table(t) => self.table(t),
                Block::Image(i) => self.image(i),
                Block::Rule => self.rule(),
                Block::Frame(_) | Block::Page(_) | Block::PageBreak => {}
            }
        }
        let used = area.top - self.y;
        let slack = (area.top - area.bottom) - used;
        let shift = match anchor {
            FrameAnchor::Top => 0.0,
            FrameAnchor::Middle => slack / 2.0,
            FrameAnchor::Bottom => slack,
        }
        .max(0.0);
        if shift > 0.0 {
            if let Some(page) = self.pages.get_mut(self.current) {
                for d in &mut page.draws[start..] {
                    d.shift(-shift);
                }
            }
        }
        (self.area, self.y, self.framed) = saved;
    }

    fn frame(&mut self, f: &FrameBlock) {
        if self.framed {
            return;
        }
        let page_h = self.pages[self.current].setup.height;
        let (x, top, w, h) = (f.x, page_h - f.y, f.width.max(0.0), f.height.max(0.0));
        if ![x, top, w, h].iter().all(|v| v.is_finite()) {
            return;
        }
        let rect = [x, top - h, w, h];
        if let Some(color) = f.fill {
            self.draw(Draw::Fill { rect, color });
        }
        if let Some((color, width)) = f.line.filter(|l| l.1.is_finite() && l.1 > 0.0) {
            self.draw(Draw::Border {
                rect,
                color,
                width: width.min(72.0),
            });
        }
        let inset = f
            .inset
            .map(|v| if v.is_finite() { v.max(0.0) } else { 0.0 });
        let area = Area {
            left: x + inset[0],
            right: x + w - inset[2],
            top: top - inset[1],
            bottom: top - h + inset[3],
        };
        self.layout_in(area, &f.blocks, f.anchor);
    }

    fn page(&mut self, p: &PageBlock) {
        if self.framed {
            return;
        }
        let Ok(setup) = usable_setup(&p.page) else {
            return;
        };
        self.setup = setup;
        if self.pages[self.current].draws.is_empty() {
            self.pages[self.current].setup = setup;
            self.area = area_of(&setup);
            self.y = self.top();
        } else {
            self.new_page();
        }
        if let Some(color) = p.background {
            self.draw(Draw::Fill {
                rect: [0.0, 0.0, setup.width, setup.height],
                color,
            });
        }
    }

    /// The header and footer on every page, numbered.
    fn furniture(&mut self, header: &[Block], footer: &[Block]) {
        if header.is_empty() && footer.is_empty() {
            return;
        }
        let total = self.pages.len();
        let mut missing = self.report.missing_glyphs;
        for k in 0..total {
            self.current = k;
            let setup = self.pages[k].setup;
            let (left, right) = (setup.margins[3], setup.width - setup.margins[1]);
            if !header.is_empty() {
                let top = setup.height - setup.header;
                let area = Area {
                    left,
                    right,
                    top,
                    bottom: (setup.height - setup.margins[0]).min(top),
                };
                self.layout_in(area, &numbered(header, k + 1, total), FrameAnchor::Top);
            }
            if !footer.is_empty() {
                let bottom = setup.footer;
                let area = Area {
                    left,
                    right,
                    top: setup.margins[2].max(bottom),
                    bottom,
                };
                self.layout_in(area, &numbered(footer, k + 1, total), FrameAnchor::Bottom);
            }
            // The same letters on every page are missing once.
            if k == 0 {
                missing = self.report.missing_glyphs;
            } else {
                self.report.missing_glyphs = missing;
            }
        }
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
                skew,
                groups,
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
                        matrix: [1.0, 0.0, *skew, 1.0, *x, *baseline],
                        size: *size,
                        space_stretch: *stretch,
                        groups,
                    },
                );
                ops.push(op("ET", vec![]));
                ops.push(op("Q", vec![]));
            }
            Draw::Line {
                from,
                to,
                width,
                color,
            } => {
                ops.push(op("q", vec![]));
                ops.push(op("RG", rgb(*color)));
                ops.push(op("w", vec![real(*width)]));
                ops.push(op("m", vec![real(from.0), real(from.1)]));
                ops.push(op("l", vec![real(to.0), real(to.1)]));
                ops.push(op("S", vec![]));
                ops.push(op("Q", vec![]));
            }
            Draw::Border { rect, color, width } => {
                ops.push(op("q", vec![]));
                ops.push(op("RG", rgb(*color)));
                ops.push(op("w", vec![real(*width)]));
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
            Draw::Link { .. } => {}
        }
    }
    ops
}

/// A page ready to be written.
struct PageOut {
    width: f32,
    height: f32,
    ops: Vec<Operation>,
    resources: Object,
    annots: Vec<Dictionary>,
}

/// Writes the pages, the catalog and the file's information, and the file.
fn finish(mut doc: Document, pages: Vec<PageOut>, info: &FileInfo) -> Result<Vec<u8>> {
    let pages_id = doc.new_object_id();
    let mut kids = Vec::with_capacity(pages.len());
    for page in pages {
        let bytes = Content {
            operations: page.ops,
        }
        .encode()
        .map_err(|e| refuse(&format!("a page could not be written: {e}")))?;
        let mut stream = Stream::new(Dictionary::new(), bytes);
        let _ = stream.compress();
        let contents = doc.add_object(stream);
        let page_id = doc.new_object_id();
        let mut dict = dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), real(page.width), real(page.height)],
            "Contents" => contents,
            "Resources" => page.resources,
        };
        if !page.annots.is_empty() {
            let annots: Vec<Object> = page
                .annots
                .into_iter()
                .map(|mut a| {
                    a.set("P", page_id);
                    Object::Reference(doc.add_object(a))
                })
                .collect();
            dict.set("Annots", annots);
        }
        doc.objects.insert(page_id, Object::Dictionary(dict));
        kids.push(Object::Reference(page_id));
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
        dictionary! { "Producer" => text_string(APP_NAME), "Creator" => text_string(APP_NAME) };
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
    let mut count = |text: &str, dir: BlockDir| {
        let weight = text.chars().filter(|c| c.is_alphabetic()).count();
        match resolve(dir, text, Direction::Ltr) {
            Direction::Rtl => rtl += weight,
            Direction::Ltr => ltr += weight,
        }
    };
    for block in source.blocks {
        match block {
            Block::Text(b) => count(&b.plain(), b.dir),
            Block::Frame(f) => {
                for inner in &f.blocks {
                    if let Block::Text(b) = inner {
                        count(&b.plain(), b.dir);
                    }
                }
            }
            _ => {}
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
        current: 0,
        area: area_of(&setup),
        framed: false,
        y: 0.0,
        report: CreateReport::default(),
        doc: Document::with_version("1.7"),
        pictures: HashMap::new(),
        pictures_source: source.pictures,
        dir,
        links: Vec::new(),
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
            Block::Frame(f) => t.frame(f),
            Block::Page(p) => t.page(p),
            Block::PageBreak => {
                if !t.pages[t.current].draws.is_empty() || !t.at_top() {
                    t.new_page();
                }
            }
            Block::Rule => t.rule(),
        }
    }
    // A break at the very end leaves no empty page behind it.
    if t.pages.len() > 1 && t.pages.last().is_some_and(|p| p.draws.is_empty()) {
        t.pages.pop();
        t.current = t.pages.len() - 1;
    }
    t.furniture(source.header, source.footer);
    let Typesetter {
        mut doc,
        faces,
        pages,
        report,
        pictures,
        links,
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
    let written: Vec<PageOut> = pages
        .iter()
        .map(|page| {
            let annots = page
                .draws
                .iter()
                .filter_map(|d| match d {
                    Draw::Link { rect, uri } => Some(link_annotation(rect, &links[*uri])),
                    _ => None,
                })
                .collect();
            PageOut {
                width: page.setup.width,
                height: page.setup.height,
                ops: page_ops(&page.draws, &faces, &subsets, &picture_names),
                resources: Object::Reference(resources),
                annots,
            }
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

/// A link annotation over `rect` (x, y, width, height) to `uri`.
fn link_annotation(rect: &[f32; 4], uri: &str) -> Dictionary {
    dictionary! {
        "Type" => "Annot",
        "Subtype" => "Link",
        "Rect" => vec![real(rect[0]), real(rect[1]), real(rect[0] + rect[2]), real(rect[1] + rect[3])],
        "Border" => vec![0.into(), 0.into(), 0.into()],
        "A" => dictionary! {
            "S" => "URI",
            "URI" => Object::String(uri.as_bytes().to_vec(), StringFormat::Literal),
        },
    }
}

/// How pictures become pages.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PicturePaper {
    /// Each page the picture's own size, at the resolution it records (96
    /// per inch when it records none).
    Own,
    /// Paper of this size, with the picture fitted inside the margin and
    /// centred.
    Paper { width: f32, height: f32 },
}

/// Which way paper is turned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PaperTurn {
    /// Landscape for a picture wider than it is tall, portrait otherwise.
    Auto,
    Portrait,
    Landscape,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PictureSetup {
    pub paper: PicturePaper,
    pub turn: PaperTurn,
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

/// A new PDF with each picture on a page of its own — every page of a
/// multi-page TIFF — upright as the camera meant it (EXIF orientation): a
/// JPEG as it is, a fax TIFF's pages still in their own compression, and
/// everything else without loss.
pub fn create_from_pictures(
    pictures: &[Vec<u8>],
    setup: &PictureSetup,
    info: &FileInfo,
) -> Result<(Vec<u8>, PictureReport)> {
    let mut doc = Document::with_version("1.7");
    let mut pages = Vec::new();
    let mut report = PictureReport::default();
    for (k, bytes) in pictures.iter().enumerate() {
        let placed = add_picture_pages(&mut doc, bytes).unwrap_or_default();
        if placed.is_empty() {
            report.left_out.push(k);
            continue;
        }
        for (picture, pinfo) in placed {
            if pages.len() >= MAX_PICTURE_PAGES {
                break;
            }
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
                    let landscape = match setup.turn {
                        PaperTurn::Auto => pw > ph,
                        PaperTurn::Portrait => false,
                        PaperTurn::Landscape => true,
                    };
                    let (w, h) = if landscape {
                        (long, short)
                    } else {
                        (short, long)
                    };
                    let margin = if setup.margin.is_finite() {
                        setup.margin.clamp(0.0, short / 4.0)
                    } else {
                        0.0
                    };
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
            pages.push(PageOut {
                width,
                height,
                ops,
                resources: Object::Dictionary(resources),
                annots: Vec::new(),
            });
        }
    }
    if pages.is_empty() {
        return Err(Error::Edit(
            "E_IMAGE: none of the pictures could be read".into(),
        ));
    }
    report.pages = pages.len();
    Ok((finish(doc, pages, info)?, report))
}

/// A file of pictures has at most this many pages.
const MAX_PICTURE_PAGES: usize = 5_000;
