//! Output model: page → blocks → paragraphs → lines → words (→ glyphs), all in logical order.
//!
//! Coordinates are PDF points relative to the top-left corner of the page's visible box
//! (CropBox, else MediaBox), y growing downwards, page `/Rotate` not applied.

use serde::Serialize;

use crate::bidi::Dir;
use crate::geom::Rect;

/// One glyph unit (a glyph, or an `/ActualText` span) with its text.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct GlyphBox {
    pub text: String,
    pub bbox: Rect,
}

/// A word in logical order.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Word {
    pub text: String,
    pub bbox: Rect,
    pub dir: Dir,
    /// Invisible text (render mode 3), e.g. an OCR layer.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub hidden: bool,
    /// Pagination artifact (header, footer, watermark).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub artifact: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub bold: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
    /// Font size in points.
    pub size: f64,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub glyphs: Vec<GlyphBox>,
}

/// A line in logical order.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Line {
    pub text: String,
    pub bbox: Rect,
    pub dir: Dir,
    pub words: Vec<Word>,
}

/// A paragraph.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Paragraph {
    pub text: String,
    pub bbox: Rect,
    pub dir: Dir,
    pub lines: Vec<Line>,
}

/// A layout block (column cell / region) holding paragraphs.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Block {
    pub bbox: Rect,
    pub dir: Dir,
    pub paragraphs: Vec<Paragraph>,
}

/// Mapping of a run of the page's plain text to a rectangle (for search hits).
#[derive(Debug, Clone, PartialEq)]
pub struct TextSpan {
    /// Char offsets `[start, end)` in [`PageText::plain`].
    pub start: usize,
    pub end: usize,
    pub bbox: Rect,
    pub rtl: bool,
    /// Line number on the page (hits are merged per line).
    pub line: usize,
}

/// Text of one page.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PageText {
    /// 0-based page index.
    pub page: usize,
    pub width: f64,
    pub height: f64,
    pub blocks: Vec<Block>,
    /// Logical-order plain text (paragraphs separated by `\n`).
    #[serde(skip)]
    pub plain: String,
    #[serde(skip)]
    pub spans: Vec<TextSpan>,
}

impl PageText {
    /// Iterate over all paragraphs in reading order.
    pub fn paragraphs(&self) -> impl Iterator<Item = &Paragraph> {
        self.blocks.iter().flat_map(|b| b.paragraphs.iter())
    }
}
