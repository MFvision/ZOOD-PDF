//! The document model every reader produces and the layout engine consumes.
//!
//! Units are PDF points (1/72 inch). Text is kept in **logical** order; the layout engine does
//! bidi, shaping and line breaking. Images are stored once in [`Document::images`] and referenced
//! by index.

use crate::image::ImageData;

/// Font family choice. The layout engine falls back per character to a family that has the glyph
/// (Inter has no Arabic; Arabic text in an Inter run is drawn with Cairo).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum Family {
    /// Amiri: Arabic Naskh serif (with Latin).
    Serif,
    /// Cairo: Arabic sans (with Latin).
    #[default]
    Sans,
    /// Inter: Latin sans.
    Latin,
}

impl Family {
    /// Map an Office/HTML font name to one of our families.
    pub fn from_font_name(name: &str) -> Option<Family> {
        let n = name.to_ascii_lowercase();
        if n.is_empty() {
            return None;
        }
        let serif = [
            "times", "serif", "amiri", "traditional arabic", "georgia", "cambria", "garamond",
            "naskh", "book", "simplified arabic", "arabic typesetting", "sakkal",
        ];
        let latin = ["inter", "helvetica", "arial", "calibri", "segoe", "roboto", "verdana"];
        if serif.iter().any(|s| n.contains(s)) {
            Some(Family::Serif)
        } else if latin.iter().any(|s| n.contains(s)) {
            Some(Family::Latin)
        } else if n.contains("cairo") || n.contains("sans") || n.contains("tahoma") {
            Some(Family::Sans)
        } else {
            None
        }
    }
}

/// An sRGB colour.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Color {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

impl Color {
    pub const BLACK: Color = Color { r: 0, g: 0, b: 0 };

    /// Parse `RRGGBB` or `#RRGGBB` (Office `w:color`, HTML).
    pub fn from_hex(s: &str) -> Option<Color> {
        let s = s.trim().trim_start_matches('#');
        if s.len() != 6 || !s.is_ascii() {
            return None;
        }
        let p = |i: usize| s.get(i..i + 2).and_then(|h| u8::from_str_radix(h, 16).ok());
        Some(Color {
            r: p(0)?,
            g: p(2)?,
            b: p(4)?,
        })
    }
}

/// Paragraph / table direction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Dir {
    /// From the first strong character (UAX #9 P2/P3).
    #[default]
    Auto,
    Ltr,
    Rtl,
}

/// Paragraph alignment. `Start`/`End` follow the paragraph direction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Align {
    #[default]
    Start,
    End,
    Center,
    Justify,
    /// Physical left (Office `jc=left` in a left-to-right paragraph).
    Left,
    /// Physical right.
    Right,
}

/// Character style of a run.
#[derive(Debug, Clone, PartialEq)]
pub struct Style {
    pub family: Family,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    /// Size in points.
    pub size: f64,
    pub color: Color,
    /// BCP 47 language (`ar`, `en`, …) when the source says so.
    pub lang: Option<String>,
}

impl Default for Style {
    fn default() -> Self {
        Style {
            family: Family::Sans,
            bold: false,
            italic: false,
            underline: false,
            size: 11.0,
            color: Color::BLACK,
            lang: None,
        }
    }
}

/// A run of text with one style. `\n` inside `text` is a forced line break.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Run {
    pub text: String,
    pub style: Style,
}

impl Run {
    pub fn new(text: impl Into<String>, style: Style) -> Self {
        Run {
            text: text.into(),
            style,
        }
    }
}

/// Numbering style of an ordered list.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum NumberStyle {
    /// Western digits in LTR paragraphs, Arabic-Indic digits (١، ٢، ٣) in RTL paragraphs.
    #[default]
    Auto,
    Decimal,
    ArabicIndic,
    LowerLetter,
    UpperLetter,
    LowerRoman,
    UpperRoman,
    /// أ، ب، ت… (hijāʾī order).
    ArabicLetter,
}

/// List membership of a paragraph.
#[derive(Debug, Clone, PartialEq)]
pub struct ListInfo {
    pub ordered: bool,
    /// Nesting level (0 = outermost).
    pub level: u8,
    /// The item number (1-based) for ordered lists.
    pub number: u32,
    pub style: NumberStyle,
}

/// Paragraph properties.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ParaStyle {
    /// Heading level 1–6, or 0 for body text.
    pub heading: u8,
    pub align: Align,
    pub dir: Dir,
    pub list: Option<ListInfo>,
    /// Extra space before/after in points (`None` = the engine's default for the kind).
    pub space_before: Option<f64>,
    pub space_after: Option<f64>,
    /// Start-side indent in points (quotes, nested content).
    pub indent: f64,
    /// Line height multiplier (1.0 = the font's natural line height).
    pub line_height: f64,
    /// Start this paragraph on a new page.
    pub page_break_before: bool,
    /// Shade behind the paragraph (code blocks).
    pub background: Option<Color>,
}

/// A paragraph: styled runs in logical order.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Paragraph {
    pub runs: Vec<Run>,
    pub style: ParaStyle,
}

impl Paragraph {
    /// The paragraph's text (logical order).
    pub fn text(&self) -> String {
        self.runs.iter().map(|r| r.text.as_str()).collect()
    }

    /// A body paragraph with one run.
    pub fn plain(text: impl Into<String>, style: Style) -> Self {
        Paragraph {
            runs: vec![Run::new(text, style)],
            style: ParaStyle::default(),
        }
    }
}

/// A table cell.
#[derive(Debug, Clone, PartialEq)]
pub struct Cell {
    pub blocks: Vec<Block>,
    pub colspan: u16,
    pub rowspan: u16,
    /// Background shade.
    pub fill: Option<Color>,
}

impl Default for Cell {
    fn default() -> Self {
        Cell {
            blocks: Vec::new(),
            colspan: 1,
            rowspan: 1,
            fill: None,
        }
    }
}

/// A table row.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Row {
    pub cells: Vec<Cell>,
    /// Header row: repeated at the top of every page the table continues on.
    pub header: bool,
}

/// A table. Columns run right to left when `dir` is RTL.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Table {
    pub rows: Vec<Row>,
    /// Relative column widths (any unit); `None` = derived from content.
    pub col_widths: Option<Vec<f64>>,
    pub dir: Dir,
    pub borders: bool,
}

/// A picture in the flow.
#[derive(Debug, Clone, PartialEq)]
pub struct ImageBlock {
    /// Index into [`Document::images`].
    pub image: usize,
    /// Display size in points (scaled down to fit the column).
    pub width: f64,
    pub height: f64,
    /// Alternative text for the /Figure structure element.
    pub alt: String,
    pub align: Align,
}

/// A block of flowing content.
#[derive(Debug, Clone, PartialEq)]
pub enum Block {
    Paragraph(Paragraph),
    Table(Table),
    Image(ImageBlock),
    PageBreak,
}

/// Paper size, margins and orientation of a flow section.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PageSetup {
    pub width: f64,
    pub height: f64,
    /// top, end (right in LTR), bottom, start — stored physically: top, right, bottom, left.
    pub margin_top: f64,
    pub margin_right: f64,
    pub margin_bottom: f64,
    pub margin_left: f64,
}

pub const A4: (f64, f64) = (595.276, 841.89);
pub const LETTER: (f64, f64) = (612.0, 792.0);

impl Default for PageSetup {
    fn default() -> Self {
        PageSetup::with_size(A4.0, A4.1, 72.0)
    }
}

impl PageSetup {
    pub fn with_size(width: f64, height: f64, margin: f64) -> Self {
        PageSetup {
            width,
            height,
            margin_top: margin,
            margin_right: margin,
            margin_bottom: margin,
            margin_left: margin,
        }
    }

    /// Swap width/height when the requested orientation does not match.
    pub fn oriented(mut self, landscape: bool) -> Self {
        if landscape != (self.width > self.height) {
            std::mem::swap(&mut self.width, &mut self.height);
        }
        self
    }

    /// Width available for content.
    pub fn content_width(&self) -> f64 {
        (self.width - self.margin_left - self.margin_right).max(36.0)
    }

    /// Height available for content.
    pub fn content_height(&self) -> f64 {
        (self.height - self.margin_top - self.margin_bottom).max(36.0)
    }
}

/// A box positioned on a fixed page (PowerPoint shapes, full-page pictures).
#[derive(Debug, Clone, PartialEq)]
pub struct Frame {
    /// Top-left corner, points from the page's top-left.
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub content: FrameContent,
}

/// What a frame holds.
#[derive(Debug, Clone, PartialEq)]
pub enum FrameContent {
    /// Text (and tables) flowed inside the frame's width.
    Blocks(Vec<Block>),
    /// A picture stretched to the frame.
    Image { image: usize, alt: String },
}

/// A page with absolutely positioned frames.
#[derive(Debug, Clone, PartialEq)]
pub struct FixedPage {
    pub width: f64,
    pub height: f64,
    pub frames: Vec<Frame>,
    pub background: Option<Color>,
}

/// The content of a section.
#[derive(Debug, Clone, PartialEq)]
pub enum Content {
    /// Flowing blocks paginated on `PageSetup` pages.
    Flow(Vec<Block>),
    /// One PDF page per fixed page.
    Fixed(Vec<FixedPage>),
}

/// A run of pages with one page setup; every section starts on a new page.
#[derive(Debug, Clone, PartialEq)]
pub struct Section {
    pub page: PageSetup,
    pub content: Content,
    /// The source says what paper size it wants (DOCX `w:pgSz`, slides, images). Used by the
    /// "Automatic" page size.
    pub page_from_source: bool,
}

/// A whole document.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Document {
    pub sections: Vec<Section>,
    pub images: Vec<ImageData>,
    /// Document title (Info + XMP-free `/Title`, structure root).
    pub title: Option<String>,
    /// Primary language (`/Lang` of the catalog).
    pub lang: Option<String>,
}

impl Document {
    /// Store an image and return its index.
    pub fn add_image(&mut self, img: ImageData) -> usize {
        self.images.push(img);
        self.images.len() - 1
    }

    /// Append another document's sections (images re-indexed).
    pub fn append(&mut self, mut other: Document) {
        let base = self.images.len();
        self.images.append(&mut other.images);
        for mut s in other.sections {
            match &mut s.content {
                Content::Flow(blocks) => reindex_blocks(blocks, base),
                Content::Fixed(pages) => {
                    for p in pages {
                        for f in &mut p.frames {
                            match &mut f.content {
                                FrameContent::Blocks(b) => reindex_blocks(b, base),
                                FrameContent::Image { image, .. } => *image += base,
                            }
                        }
                    }
                }
            }
            self.sections.push(s);
        }
        if self.lang.is_none() {
            self.lang = other.lang;
        }
        if self.title.is_none() {
            self.title = other.title;
        }
    }
}

fn reindex_blocks(blocks: &mut [Block], base: usize) {
    for b in blocks {
        match b {
            Block::Image(i) => i.image += base,
            Block::Table(t) => {
                for r in &mut t.rows {
                    for c in &mut r.cells {
                        reindex_blocks(&mut c.blocks, base);
                    }
                }
            }
            Block::Paragraph(_) | Block::PageBreak => {}
        }
    }
}
