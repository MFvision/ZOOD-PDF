//! Page marks: watermarks, headers and footers, page numbers and Bates
//! numbers, drawn on a range of pages — and listed, replaced and removed
//! again later without touching what the page itself draws.
//!
//! Each mark on each page is one form XObject, drawn in the page's user
//! space and clipped to its crop box, that carries Warraq's private data
//! (`/PieceInfo /Warraq`, PDF 2.0 §14.5): the mark's number, its kind,
//! whether it is in front of the page or behind it, and the settings it was
//! made with, so the interface can show and redo it. The page's own content
//! streams are not changed. Two small streams of Warraq's go round them in
//! `/Contents`:
//!
//! ```text
//! [ before: marks behind the page, then q ]  the page's streams  [ after: Q …, marks in front ]
//! ```
//!
//! Every mark is drawn as a pagination artifact (`/Artifact <</Type
//! /Pagination /Subtype /Watermark>> BDC … EMC`, §14.8.2.2), which is what
//! tells a reader — Warraq's own, a screen reader, Acrobat's reflow — that
//! it is not part of the page's text. Taking the last mark off a page gives
//! it back its `/Contents` and `/Resources` exactly as they were.
//!
//! Text is shaped (`warraq-text`) and written through `show_line`, in an
//! embedded subset of the face the interface passes, so an Arabic header
//! reads back as it was typed.
use lopdf::content::{Content, Operation};
use lopdf::{dictionary, Dictionary, Object, ObjectId, StringFormat};
use warraq_text::{base_direction, Direction, ShapedGlyph, Shaper};

use crate::fonts::{embed_subset_font, FontSubset};
use crate::pagework::name as name_text;
use crate::picture::{add_picture, picture_info, upright_matrix};
use crate::show::{show_line, ShownLine};
use crate::{Error, PdfDocument, Result};

/// What a mark is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MarkKind {
    Watermark,
    Header,
    Footer,
    PageNumber,
    Bates,
}

impl MarkKind {
    pub fn as_str(self) -> &'static str {
        match self {
            MarkKind::Watermark => "watermark",
            MarkKind::Header => "header",
            MarkKind::Footer => "footer",
            MarkKind::PageNumber => "pageNumber",
            MarkKind::Bates => "bates",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        [
            MarkKind::Watermark,
            MarkKind::Header,
            MarkKind::Footer,
            MarkKind::PageNumber,
            MarkKind::Bates,
        ]
        .into_iter()
        .find(|k| k.as_str() == s)
    }

    /// The pagination artifact's subtype (PDF 2.0 Table 363).
    fn subtype(self) -> &'static str {
        match self {
            MarkKind::Watermark => "Watermark",
            MarkKind::Header => "Header",
            MarkKind::Footer => "Footer",
            MarkKind::PageNumber => "PageNum",
            MarkKind::Bates => "Bates",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HAlign {
    Left,
    Center,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VAlign {
    Top,
    Middle,
    Bottom,
}

/// Which way a header's slots run: its "start" is the right-hand side in a
/// right-to-left document.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlotDirection {
    /// From the first strong letter of the slots' own text.
    Auto,
    Rtl,
    Ltr,
}

/// Which digits numbers are written in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Digits {
    Western,
    /// ٠١٢٣٤٥٦٧٨٩
    ArabicIndic,
}

/// How a page number reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NumberFormat {
    /// `1`
    Plain,
    /// `1 / 9`
    OfTotal,
    /// `Page 1 of 9`
    PageOfEnglish,
    /// `صفحة ١ من ٩`
    PageOfArabic,
    /// `iv`
    Roman,
}

impl NumberFormat {
    fn template(self) -> &'static str {
        match self {
            NumberFormat::Plain => "{page}",
            NumberFormat::OfTotal => "{page} / {pages}",
            NumberFormat::PageOfEnglish => "Page {page} of {pages}",
            NumberFormat::PageOfArabic => "صفحة {page} من {pages}",
            NumberFormat::Roman => "{roman}",
        }
    }
}

/// Where a single-text mark goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Anchor {
    pub h: HAlign,
    pub v: VAlign,
}

/// What is drawn: the kinds, each with what it needs.
#[derive(Debug, Clone, PartialEq)]
pub enum MarkContent {
    /// Text (tokens allowed) or a picture, at an anchor or tiled.
    Watermark {
        text: Option<String>,
        /// PNG or JPEG bytes, and its width as a share of the page's.
        image: Option<(Vec<u8>, f32)>,
        anchor: Anchor,
        tiled: bool,
    },
    /// Three slots — start, centre, end — at the top or the bottom.
    Band {
        slots: [String; 3],
        direction: SlotDirection,
    },
    PageNumber {
        format: NumberFormat,
        anchor: Anchor,
        start: u32,
        skip_first: bool,
    },
    Bates {
        prefix: String,
        suffix: String,
        start: u64,
        /// Zero-padded to this many digits.
        width: usize,
        anchor: Anchor,
    },
}

/// One page mark, as the interface asks for it.
#[derive(Debug, Clone, PartialEq)]
pub struct PageMark {
    pub kind: MarkKind,
    pub content: MarkContent,
    /// Points.
    pub size: f32,
    /// RGB, 0–1.
    pub color: [f32; 3],
    /// 0–1.
    pub opacity: f32,
    /// Degrees counter-clockwise, as the page is shown.
    pub rotation: f32,
    /// Distance from the page's edges, in points: across, then up and down.
    pub margin: (f32, f32),
    /// In front of the page's content, or behind it.
    pub front: bool,
    pub digits: Digits,
    /// Replaces `{date}`, already written as the person chose (calendar, digits).
    pub date: String,
    /// Replaces `{file}`.
    pub file_name: String,
    /// The settings as the interface sent them, kept for "replace".
    pub spec: String,
    /// When the mark was made, as a PDF date (`D:YYYYMMDDHHmmSS`).
    pub modified: String,
}

/// A mark in the file, as `list_marks` finds it.
#[derive(Debug, Clone, PartialEq)]
pub struct MarkInfo {
    pub id: u32,
    pub kind: MarkKind,
    pub front: bool,
    pub spec: String,
    /// Pages it is on, 0-based.
    pub pages: Vec<usize>,
}

/// One mark's form on one page.
#[derive(Debug, Clone)]
struct Placed {
    /// Its name in the page's `/XObject` resources.
    name: Vec<u8>,
    form: ObjectId,
    id: u32,
    kind: MarkKind,
    front: bool,
    spec: String,
}

const OURS: &[u8] = b"WarraqMarks";
const PIECE: &[u8] = b"Warraq";
/// No more than this many tiles of a tiled watermark on one page.
const MAX_TILES: usize = 400;

fn parse_err(e: impl std::fmt::Display) -> Error {
    Error::Parse(e.to_string())
}

/// A PDF text string: UTF-16BE with its byte order mark.
fn text_string(text: &str) -> Object {
    let mut bytes = vec![0xFE, 0xFF];
    for unit in text.encode_utf16() {
        bytes.extend(unit.to_be_bytes());
    }
    Object::String(bytes, StringFormat::Hexadecimal)
}

/// `n` in the chosen digits.
pub fn format_number(n: u64, digits: Digits) -> String {
    let s = n.to_string();
    match digits {
        Digits::Western => s,
        Digits::ArabicIndic => s
            .chars()
            .map(|c| char::from_u32(0x0660 + c.to_digit(10).unwrap_or(0)).unwrap_or(c))
            .collect(),
    }
}

/// `n` in lower-case Roman numerals; beyond 3999 in digits.
pub fn roman(n: u64) -> String {
    if n == 0 || n > 3999 {
        return n.to_string();
    }
    let table = [
        (1000, "m"),
        (900, "cm"),
        (500, "d"),
        (400, "cd"),
        (100, "c"),
        (90, "xc"),
        (50, "l"),
        (40, "xl"),
        (10, "x"),
        (9, "ix"),
        (5, "v"),
        (4, "iv"),
        (1, "i"),
    ];
    let mut n = n;
    let mut out = String::new();
    for (value, letters) in table {
        while n >= value {
            out.push_str(letters);
            n -= value;
        }
    }
    out
}

/// Whether a header's text, as it will be drawn, reads right to left: by
/// its first strong letter, and when it has none — a page number alone —
/// by its digits, Arabic-Indic ones being a right-to-left document's.
fn reads_rtl(text: &str) -> bool {
    let strong = text.chars().any(|c| c.is_alphabetic());
    if strong {
        base_direction(text) == Direction::Rtl
    } else {
        text.chars().any(|c| {
            ('\u{0660}'..='\u{0669}').contains(&c) || ('\u{06F0}'..='\u{06F9}').contains(&c)
        })
    }
}

/// The values the tokens of one page take.
struct Tokens<'a> {
    page: u64,
    pages: u64,
    bates: String,
    mark: &'a PageMark,
}

impl Tokens<'_> {
    fn fill(&self, template: &str) -> String {
        let digits = self.mark.digits;
        template
            .replace("{page}", &format_number(self.page, digits))
            .replace("{pages}", &format_number(self.pages, digits))
            .replace("{roman}", &roman(self.page))
            .replace("{date}", &self.mark.date)
            .replace("{file}", &self.mark.file_name)
            .replace("{bates}", &self.bates)
    }
}

/// One text or picture to place on a page, and where.
struct Item {
    text: Option<String>,
    anchor: Anchor,
}

impl PageMark {
    /// What goes on the `k`-th of `range` pages (document page `index`),
    /// out of `total` pages in the file; empty when this page gets nothing.
    fn items(&self, k: usize, index: usize, range: usize, total: usize) -> Vec<Item> {
        let tokens = |page: u64, pages: u64, bates: String| Tokens {
            page,
            pages,
            bates,
            mark: self,
        };
        match &self.content {
            MarkContent::Watermark { text, anchor, .. } => {
                let t = tokens(index as u64 + 1, total as u64, String::new());
                vec![Item {
                    text: text.as_deref().map(|s| t.fill(s)),
                    anchor: *anchor,
                }]
            }
            MarkContent::Band { slots, direction } => {
                let t = tokens(index as u64 + 1, total as u64, String::new());
                let filled: Vec<String> = slots.iter().map(|s| t.fill(s)).collect();
                let rtl = match direction {
                    SlotDirection::Rtl => true,
                    SlotDirection::Ltr => false,
                    SlotDirection::Auto => reads_rtl(&filled.concat()),
                };
                let (start, end) = if rtl {
                    (HAlign::Right, HAlign::Left)
                } else {
                    (HAlign::Left, HAlign::Right)
                };
                let v = if self.kind == MarkKind::Header {
                    VAlign::Top
                } else {
                    VAlign::Bottom
                };
                [start, HAlign::Center, end]
                    .into_iter()
                    .zip(filled)
                    .filter(|(_, s)| !s.trim().is_empty())
                    .map(|(h, s)| Item {
                        text: Some(s),
                        anchor: Anchor { h, v },
                    })
                    .collect()
            }
            MarkContent::PageNumber {
                format,
                anchor,
                start,
                skip_first,
            } => {
                let skipped = usize::from(*skip_first);
                if k < skipped {
                    return vec![];
                }
                let page = *start as u64 + (k - skipped) as u64;
                let pages = *start as u64 + (range - skipped) as u64 - 1;
                vec![Item {
                    text: Some(
                        tokens(page, pages.max(page), String::new()).fill(format.template()),
                    ),
                    anchor: *anchor,
                }]
            }
            MarkContent::Bates {
                prefix,
                suffix,
                start,
                width,
                anchor,
            } => {
                let number = start.saturating_add(k as u64);
                let bates = format!(
                    "{prefix}{:0>width$}{suffix}",
                    format_number(number, Digits::Western),
                    width = (*width).min(20)
                );
                let t = tokens(index as u64 + 1, total as u64, bates);
                vec![Item {
                    text: Some(t.fill("{bates}")),
                    anchor: *anchor,
                }]
            }
        }
    }

    fn picture(&self) -> Option<&(Vec<u8>, f32)> {
        match &self.content {
            MarkContent::Watermark { image, .. } => image.as_ref(),
            _ => None,
        }
    }

    fn tiled(&self) -> bool {
        matches!(self.content, MarkContent::Watermark { tiled: true, .. })
    }
}

/// Where a box of `w`×`h`, turned by `degrees`, has its centre when it is
/// put at `anchor` on an upright page of `page`, `margin` from the edges.
fn centre_at(
    anchor: Anchor,
    w: f32,
    h: f32,
    degrees: f32,
    page: (f32, f32),
    margin: (f32, f32),
) -> (f32, f32) {
    let (s, c) = degrees.to_radians().sin_cos();
    let half_w = (c.abs() * w + s.abs() * h) / 2.0;
    let half_h = (s.abs() * w + c.abs() * h) / 2.0;
    let x = match anchor.h {
        HAlign::Left => margin.0 + half_w,
        HAlign::Center => page.0 / 2.0,
        HAlign::Right => page.0 - margin.0 - half_w,
    };
    let y = match anchor.v {
        VAlign::Top => page.1 - margin.1 - half_h,
        VAlign::Middle => page.1 / 2.0,
        VAlign::Bottom => margin.1 + half_h,
    };
    (x, y)
}

/// Centres of the tiles of a tiled watermark, covering the page. A grid
/// of more than `MAX_TILES` at the tiles' own spacing is spread out evenly
/// until it fits, so small tiles still reach every edge of the page.
fn tile_centres(w: f32, h: f32, degrees: f32, gap: f32, page: (f32, f32)) -> Vec<(f32, f32)> {
    if !(page.0.is_finite() && page.1.is_finite() && page.0 > 0.0 && page.1 > 0.0) {
        return vec![];
    }
    // A page as large as a file may claim, not as large as a float may.
    let page = (page.0.min(1.0e5), page.1.min(1.0e5));
    let (s, c) = degrees.to_radians().sin_cos();
    let mut step_x = (c.abs() * w + s.abs() * h + gap).max(8.0);
    let mut step_y = (s.abs() * w + c.abs() * h + gap).max(8.0);
    loop {
        if let Some(tiles) = tile_grid(step_x, step_y, page) {
            return tiles;
        }
        step_x *= 1.25;
        step_y *= 1.25;
    }
}

/// The brick-wall grid of tile centres at this spacing over the page, or
/// `None` when it has more than `MAX_TILES`.
fn tile_grid(step_x: f32, step_y: f32, page: (f32, f32)) -> Option<Vec<(f32, f32)>> {
    let nx = (page.0 / step_x).ceil() as i64 / 2 + 1;
    let ny = (page.1 / step_y).ceil() as i64 / 2 + 1;
    let mut out = Vec::new();
    for j in -ny..=ny {
        // Every other row shifted by half a step, like a brick wall.
        let shift = if j % 2 == 0 { 0.0 } else { step_x / 2.0 };
        for i in -nx..=nx {
            let x = page.0 / 2.0 + i as f32 * step_x + shift;
            let y = page.1 / 2.0 + j as f32 * step_y;
            if x > -step_x && x < page.0 + step_x && y > -step_y && y < page.1 + step_y {
                out.push((x, y));
                if out.len() > MAX_TILES {
                    return None;
                }
            }
        }
    }
    Some(out)
}

fn real(v: f32) -> Object {
    Object::Real(if v.is_finite() { v } else { 0.0 })
}

fn op(name: &str, operands: Vec<Object>) -> Operation {
    Operation::new(name, operands)
}

fn matrix_op(m: [f32; 6]) -> Operation {
    op("cm", m.iter().map(|v| real(*v)).collect())
}

/// Reads a mark form's private data.
fn placed_of(doc: &lopdf::Document, name: &[u8], form: ObjectId) -> Option<Placed> {
    let stream = doc.get_object(form).ok()?.as_stream().ok()?;
    let resolve = |o: &Object| -> Option<Dictionary> {
        match o {
            Object::Reference(id) => doc.get_dictionary(*id).ok().cloned(),
            Object::Dictionary(d) => Some(d.clone()),
            _ => None,
        }
    };
    let piece = resolve(stream.dict.get(b"PieceInfo").ok()?)?;
    let ours = resolve(piece.get(PIECE).ok()?)?;
    let private = resolve(ours.get(b"Private").ok()?)?;
    let id = private.get(b"Mark").ok()?.as_i64().ok()?;
    let kind =
        MarkKind::parse(std::str::from_utf8(private.get(b"Kind").ok()?.as_name().ok()?).ok()?)?;
    let front = private
        .get(b"Front")
        .ok()
        .and_then(|f| f.as_bool().ok())
        .unwrap_or(true);
    let spec = private
        .get(b"Spec")
        .ok()
        .and_then(|s| s.as_str().ok())
        .map(crate::document::decode_text_string)
        .unwrap_or_default();
    Some(Placed {
        name: name.to_vec(),
        form,
        id: u32::try_from(id).ok()?,
        kind,
        front,
        spec,
    })
}

impl PdfDocument {
    /// Warraq's marks on a page, in the order they were made.
    fn marks_on(&self, page_id: ObjectId) -> Vec<Placed> {
        let Some(resources) = self.page_resources(page_id) else {
            return vec![];
        };
        let group = match resources.get(b"XObject") {
            Ok(Object::Reference(id)) => self.doc.get_dictionary(*id).ok(),
            Ok(Object::Dictionary(d)) => Some(d),
            _ => None,
        };
        let mut out: Vec<Placed> = group
            .into_iter()
            .flat_map(|g| g.iter())
            .filter_map(|(name, value)| {
                let form = value.as_reference().ok()?;
                placed_of(&self.doc, name, form)
            })
            .collect();
        out.sort_by_key(|p| p.id);
        out
    }

    /// Whether page `index` carries any of Warraq's marks.
    pub fn has_marks(&self, index: usize) -> bool {
        self.page_id(index)
            .is_ok_and(|page_id| !self.marks_on(page_id).is_empty())
    }

    /// Every mark in the file, one entry per mark with the pages it is on.
    pub fn list_marks(&self) -> Vec<MarkInfo> {
        let mut out: Vec<MarkInfo> = Vec::new();
        for (index, page_id) in self.pages.iter().enumerate() {
            for placed in self.marks_on(*page_id) {
                match out.iter_mut().find(|m| m.id == placed.id) {
                    Some(mark) => {
                        if mark.pages.last() != Some(&index) {
                            mark.pages.push(index);
                        }
                    }
                    None => out.push(MarkInfo {
                        id: placed.id,
                        kind: placed.kind,
                        front: placed.front,
                        spec: placed.spec,
                        pages: vec![index],
                    }),
                }
            }
        }
        out.sort_by_key(|m| m.id);
        out
    }

    /// Draws `mark` on `pages` (0-based; empty means every page). With
    /// `replace`, marks of the same kind already on those pages go first —
    /// a second header replaces the first rather than printing over it.
    /// `font` is needed for anything with text. Returns the mark's number.
    pub fn add_mark(
        &mut self,
        mark: &PageMark,
        pages: &[usize],
        font: Option<&[u8]>,
        replace: bool,
    ) -> Result<u32> {
        self.place_mark(mark, pages, font, replace, None)
    }

    /// `add_mark`, drawn on page `only` alone — numbered as it would be among
    /// `pages` — for a preview of a long file that does not shape every page.
    pub fn preview_mark(
        &mut self,
        mark: &PageMark,
        pages: &[usize],
        font: Option<&[u8]>,
        replace: bool,
        only: usize,
    ) -> Result<()> {
        self.place_mark(mark, pages, font, replace, Some(only))
            .map(|_| ())
    }

    fn place_mark(
        &mut self,
        mark: &PageMark,
        pages: &[usize],
        font: Option<&[u8]>,
        replace: bool,
        only: Option<usize>,
    ) -> Result<u32> {
        let mut pages: Vec<usize> = if pages.is_empty() {
            (0..self.page_count()).collect()
        } else {
            pages.to_vec()
        };
        pages.sort_unstable();
        pages.dedup();
        if let Some(bad) = pages.iter().find(|p| **p >= self.page_count()) {
            return Err(Error::Page(*bad));
        }
        if !(mark.size.is_finite() && mark.size > 0.0 && mark.size <= 1000.0) {
            return Err(Error::Edit(format!(
                "a mark cannot be {} points",
                mark.size
            )));
        }
        if let Some(only) = only {
            if !pages.contains(&only) {
                return Ok(0);
            }
        }
        if replace {
            let kind = mark.kind;
            let going: Vec<usize> = pages
                .iter()
                .copied()
                .filter(|p| only.is_none_or(|o| o == *p))
                .collect();
            self.remove_marks_where(&going, |p| p.kind == kind)?;
        }
        let id = self.list_marks().iter().map(|m| m.id).max().unwrap_or(0) + 1;
        let total = self.page_count();

        // Every page's items first: one font subset serves them all.
        let items: Vec<Vec<Item>> = pages
            .iter()
            .enumerate()
            .map(|(k, index)| {
                if only.is_none_or(|o| o == *index) {
                    mark.items(k, *index, pages.len(), total)
                } else {
                    vec![]
                }
            })
            .collect();
        let has_text = items
            .iter()
            .flatten()
            .any(|i| i.text.as_deref().is_some_and(|t| !t.trim().is_empty()));
        let shaped = match (has_text, font) {
            (false, _) => None,
            (true, None) => {
                return Err(Error::Font("a mark with text needs a font".into()));
            }
            (true, Some(font)) => {
                let shaper = Shaper::new(font).map_err(|e| Error::Font(e.to_string()))?;
                let glyphs: Vec<Vec<Vec<ShapedGlyph>>> = items
                    .iter()
                    .map(|page| {
                        page.iter()
                            .map(|i| shaper.shape_line(i.text.as_deref().unwrap_or("").trim()))
                            .collect()
                    })
                    .collect();
                let all: Vec<ShapedGlyph> = glyphs.iter().flatten().flatten().cloned().collect();
                let subset = FontSubset::build(font, &shaper, &all)?;
                let font_id = embed_subset_font(&mut self.doc, &shaper, &subset, "WarraqMark");
                Some((shaper, subset, font_id, glyphs))
            }
        };
        // A picture is drawn as it is seen: a photo's EXIF orientation turns
        // its proportions and is drawn with it, the pixels kept as stored.
        let picture = match mark.picture() {
            Some((bytes, share)) => {
                let info = picture_info(bytes);
                let added = add_picture(&mut self.doc, bytes)?;
                let seen = info.map_or((added.width, added.height), |i| i.shown());
                let turn = upright_matrix(info.map_or(1, |i| i.orientation), 0.0, 0.0, 1.0, 1.0);
                Some((added, *share, seen, turn))
            }
            None => None,
        };
        if !has_text && picture.is_none() {
            return Err(Error::Edit("the mark has nothing to draw".into()));
        }
        let state = self.doc.add_object(dictionary! {
            "Type" => "ExtGState",
            "ca" => real(mark.opacity.clamp(0.0, 1.0)),
            "CA" => real(mark.opacity.clamp(0.0, 1.0)),
        });
        let piece = dictionary! {
            PIECE => dictionary! {
                "LastModified" => Object::string_literal(mark.modified.clone()),
                "Private" => dictionary! {
                    "Mark" => id as i64,
                    "Kind" => Object::Name(mark.kind.as_str().as_bytes().to_vec()),
                    "Front" => mark.front,
                    "Spec" => text_string(&mark.spec),
                },
            },
        };

        for (k, index) in pages.iter().enumerate() {
            if items[k].is_empty() {
                continue;
            }
            let frame = self.display_frame(*index)?;
            let upright = frame.shown_size();
            let mut ops = vec![
                op("q", vec![]),
                matrix_op(frame.upright_to_user().0),
                op("gs", vec![Object::Name(b"G".to_vec())]),
                op(
                    "rg",
                    mark.color.iter().map(|v| real(v.clamp(0.0, 1.0))).collect(),
                ),
            ];
            let mut resources = dictionary! {
                "ExtGState" => dictionary! { "G" => state },
            };
            if let Some((shaper, subset, font_id, glyphs)) = &shaped {
                resources.set("Font", dictionary! { "F" => *font_id });
                let metrics = shaper.metrics();
                let ascent = (metrics.ascent / 1000.0).clamp(0.5, 1.0);
                let descent = (metrics.descent / 1000.0).clamp(-0.5, 0.0);
                for (item, glyphs) in items[k].iter().zip(&glyphs[k]) {
                    if glyphs.is_empty() {
                        continue;
                    }
                    let size = mark.size;
                    let width = glyphs.iter().map(|g| g.x_advance).sum::<f32>() * size / 1000.0;
                    let height = (ascent - descent) * size;
                    let centres = if mark.tiled() {
                        tile_centres(width, height, mark.rotation, size * 2.0, upright)
                    } else {
                        vec![centre_at(
                            item.anchor,
                            width,
                            height,
                            mark.rotation,
                            upright,
                            mark.margin,
                        )]
                    };
                    // The baseline, from the middle of the text's box.
                    let baseline = -(ascent + descent) / 2.0 * size;
                    let (s, c) = mark.rotation.to_radians().sin_cos();
                    for (x, y) in centres {
                        ops.push(op("q", vec![]));
                        ops.push(matrix_op([c, s, -s, c, x, y]));
                        ops.push(op("BT", vec![]));
                        ops.push(op("Tf", vec![Object::Name(b"F".to_vec()), real(size)]));
                        show_line(
                            &mut ops,
                            subset,
                            shaper,
                            &ShownLine {
                                glyphs,
                                matrix: [1.0, 0.0, 0.0, 1.0, -width / 2.0, baseline],
                                size,
                                space_stretch: 0.0,
                            },
                        );
                        ops.push(op("ET", vec![]));
                        ops.push(op("Q", vec![]));
                    }
                }
            }
            if let Some((picture, share, (seen_w, seen_h), turn)) = &picture {
                resources.set("XObject", dictionary! { "I" => picture.id });
                let width = upright.0 * share.clamp(0.01, 1.0);
                let height = width * *seen_h as f32 / (*seen_w).max(1) as f32;
                let anchor = items[k].first().map_or(
                    Anchor {
                        h: HAlign::Center,
                        v: VAlign::Middle,
                    },
                    |i| i.anchor,
                );
                let centres = if mark.tiled() {
                    tile_centres(width, height, mark.rotation, width * 0.25, upright)
                } else {
                    vec![centre_at(
                        anchor,
                        width,
                        height,
                        mark.rotation,
                        upright,
                        mark.margin,
                    )]
                };
                let (s, c) = mark.rotation.to_radians().sin_cos();
                for (x, y) in centres {
                    ops.push(op("q", vec![]));
                    ops.push(matrix_op([c, s, -s, c, x, y]));
                    ops.push(matrix_op([
                        width,
                        0.0,
                        0.0,
                        height,
                        -width / 2.0,
                        -height / 2.0,
                    ]));
                    if *turn != [1.0, 0.0, 0.0, 1.0, 0.0, 0.0] {
                        ops.push(matrix_op(*turn));
                    }
                    ops.push(op("Do", vec![Object::Name(b"I".to_vec())]));
                    ops.push(op("Q", vec![]));
                }
            }
            ops.push(op("Q", vec![]));
            let content = Content { operations: ops }
                .encode()
                .map_err(|e| Error::Edit(e.to_string()))?;
            let form = self.new_stream(
                dictionary! {
                    "Type" => "XObject",
                    "Subtype" => "Form",
                    "BBox" => frame.crop.iter().map(|v| real(*v)).collect::<Vec<_>>(),
                    "Resources" => resources,
                    "PieceInfo" => piece.clone(),
                },
                content,
            );
            let page_id = self.page_id(*index)?;
            self.remember_original(page_id)?;
            self.own_resources(page_id)?;
            self.add_xobject(page_id, "WqMark", form)?;
            self.wrap_page(page_id)?;
        }
        Ok(id)
    }

    /// Takes marks off: those numbered in `ids` (all of them when empty) on
    /// `pages` (every page when empty). Returns how many were taken off.
    pub fn remove_marks(&mut self, ids: &[u32], pages: &[usize]) -> Result<usize> {
        let pages: Vec<usize> = if pages.is_empty() {
            (0..self.page_count()).collect()
        } else {
            pages.to_vec()
        };
        self.remove_marks_where(&pages, |p| ids.is_empty() || ids.contains(&p.id))
    }

    fn remove_marks_where(
        &mut self,
        pages: &[usize],
        wanted: impl Fn(&Placed) -> bool,
    ) -> Result<usize> {
        let mut removed = 0;
        for index in pages {
            let page_id = self.page_id(*index)?;
            let going: Vec<Placed> = self
                .marks_on(page_id)
                .into_iter()
                .filter(|p| wanted(p))
                .collect();
            if going.is_empty() {
                continue;
            }
            // The marks are the page's own resources: `add_mark` made them so.
            let group = self.own_xobjects(page_id)?;
            for placed in &going {
                group.remove(&placed.name);
            }
            self.mark_touched(page_id);
            self.wrap_page(page_id)?;
            for placed in &going {
                self.forget(placed.form);
            }
            removed += going.len();
        }
        Ok(removed)
    }

    /// Before the first mark goes on a page: what its `/Contents` and
    /// `/Resources` were, kept in the stream that will go before them, so
    /// the last mark taken off can give them back.
    fn remember_original(&mut self, page_id: ObjectId) -> Result<()> {
        if self.our_streams(page_id).0.is_some() {
            return Ok(());
        }
        let page = self.doc.get_dictionary(page_id).map_err(parse_err)?;
        let contents = page.get(b"Contents").cloned().unwrap_or(Object::Null);
        let resources = page.get(b"Resources").cloned().unwrap_or(Object::Null);
        let before = self.new_stream(
            dictionary! {
                OURS => Object::Name(b"Before".to_vec()),
                "WarraqContents" => contents,
                "WarraqResources" => resources,
            },
            Vec::new(),
        );
        let mut ids = vec![before];
        ids.extend(self.content_ids(page_id));
        self.set_contents(
            page_id,
            Object::Array(ids.into_iter().map(Object::Reference).collect()),
        )
    }

    /// Warraq's before and after streams on a page, if it has them.
    fn our_streams(&self, page_id: ObjectId) -> (Option<ObjectId>, Option<ObjectId>) {
        let mut before = None;
        let mut after = None;
        for id in self.content_ids(page_id) {
            let which = self
                .doc
                .get_object(id)
                .and_then(Object::as_stream)
                .ok()
                .and_then(|s| s.dict.get(OURS).ok())
                .and_then(|n| n.as_name().ok());
            match which {
                Some(b"Before") => before = Some(id),
                Some(b"After") => after = Some(id),
                _ => {}
            }
        }
        (before, after)
    }

    /// Rewrites the two streams around the page's content for the marks it
    /// has now; with none left, gives the page back what it had.
    fn wrap_page(&mut self, page_id: ObjectId) -> Result<()> {
        let marks = self.marks_on(page_id);
        let (before, after) = self.our_streams(page_id);
        let theirs: Vec<ObjectId> = self
            .content_ids(page_id)
            .into_iter()
            .filter(|id| Some(*id) != before && Some(*id) != after)
            .collect();
        // Once a text edit has joined the page's streams into one, marks
        // drawn in it are taken out: the wrap below draws the ones left.
        for id in &theirs {
            self.strip_mark_sequences(*id)?;
        }

        if marks.is_empty() {
            let stored = before.and_then(|b| {
                let dict = &self.doc.get_object(b).ok()?.as_stream().ok()?.dict;
                Some((
                    dict.get(b"WarraqContents").ok()?.clone(),
                    dict.get(b"WarraqResources").ok()?.clone(),
                ))
            });
            let original_ids = stored.as_ref().map(|(contents, _)| match contents {
                Object::Reference(id) => match self.doc.get_object(*id) {
                    Ok(Object::Array(a)) => {
                        a.iter().filter_map(|o| o.as_reference().ok()).collect()
                    }
                    _ => vec![*id],
                },
                Object::Array(a) => a.iter().filter_map(|o| o.as_reference().ok()).collect(),
                _ => vec![],
            });
            let contents = match (&stored, original_ids) {
                (Some((contents, _)), Some(ids)) if ids == theirs => contents.clone(),
                _ if theirs.len() == 1 => Object::Reference(theirs[0]),
                _ => Object::Array(theirs.iter().map(|id| Object::Reference(*id)).collect()),
            };
            self.set_contents(page_id, contents)?;
            if let Some((_, resources)) = stored {
                self.restore_resources(page_id, resources)?;
            }
            for id in [before, after].into_iter().flatten() {
                self.forget(id);
            }
            return Ok(());
        }

        let draw = |p: &Placed| {
            format!(
                "q /Artifact <</Type /Pagination /Subtype /{} /WarraqMark {}>> BDC {} Do EMC Q\n",
                p.kind.subtype(),
                p.id,
                name_text(&p.name)
            )
        };
        let mut head = String::new();
        for p in marks.iter().filter(|p| !p.front) {
            head.push_str(&draw(p));
        }
        head.push_str("q\n");
        // Counted over the page's streams as one: a `q` in one may be closed
        // by a `Q` in the next.
        let open = self.open_saves_in(&theirs)?;
        let mut tail = "Q\n".repeat(open + 1);
        for p in marks.iter().filter(|p| p.front) {
            tail.push_str(&draw(p));
        }
        let before = match before {
            Some(id) => {
                self.set_stream_bytes(id, head.into_bytes())?;
                id
            }
            None => self.new_stream(
                dictionary! { OURS => Object::Name(b"Before".to_vec()) },
                head.into_bytes(),
            ),
        };
        let after = match after {
            Some(id) => {
                self.set_stream_bytes(id, tail.into_bytes())?;
                id
            }
            None => self.new_stream(
                dictionary! { OURS => Object::Name(b"After".to_vec()) },
                tail.into_bytes(),
            ),
        };
        let mut ids = vec![before];
        ids.extend(theirs);
        ids.push(after);
        self.set_contents(
            page_id,
            Object::Array(ids.into_iter().map(Object::Reference).collect()),
        )
    }

    /// Gives the page its original `/Resources` back, if nothing but marks
    /// was added to its own copy since.
    fn restore_resources(&mut self, page_id: ObjectId, original: Object) -> Result<()> {
        let resolve = |o: &Object| -> Dictionary {
            match o {
                Object::Reference(id) => self.doc.get_dictionary(*id).cloned().unwrap_or_default(),
                Object::Dictionary(d) => d.clone(),
                _ => Dictionary::new(),
            }
        };
        let normal = |mut d: Dictionary| -> Dictionary {
            match d.get(b"XObject") {
                Ok(Object::Reference(id)) => {
                    let group = self.doc.get_dictionary(*id).cloned().unwrap_or_default();
                    d.set("XObject", Object::Dictionary(group));
                }
                Ok(Object::Dictionary(g)) if g.is_empty() => {
                    d.remove(b"XObject");
                }
                _ => {}
            }
            if matches!(d.get(b"XObject"), Ok(Object::Dictionary(g)) if g.is_empty()) {
                d.remove(b"XObject");
            }
            d
        };
        let page = self.doc.get_dictionary(page_id).map_err(parse_err)?;
        let current = page.get(b"Resources").cloned().unwrap_or(Object::Null);
        let was = match &original {
            // Inherited: what the page draws with comes from its parent.
            Object::Null => page
                .get(b"Parent")
                .ok()
                .and_then(|p| p.as_reference().ok())
                .and_then(|p| self.doc.get_dictionary(p).ok())
                .and_then(|p| self.inherited(p, b"Resources"))
                .map(resolve)
                .unwrap_or_default(),
            other => resolve(other),
        };
        if normal(resolve(&current)) != normal(was) {
            return Ok(());
        }
        let page = self.doc.get_dictionary_mut(page_id).map_err(parse_err)?;
        match original {
            Object::Null => {
                page.remove(b"Resources");
            }
            other => page.set("Resources", other),
        }
        self.mark_touched(page_id);
        Ok(())
    }

    /// Takes `/Artifact … /WarraqMark n … BDC … EMC` sequences out of a
    /// stream that is not one of Warraq's; leaves it alone if it has none.
    fn strip_mark_sequences(&mut self, id: ObjectId) -> Result<()> {
        let Ok(bytes) = self.stream_bytes(id) else {
            return Ok(());
        };
        if !bytes.windows(10).any(|w| w == b"WarraqMark") {
            return Ok(());
        }
        let ops = crate::lex::lex(&bytes)?;
        let mut cut: Vec<std::ops::Range<usize>> = Vec::new();
        let mut k = 0;
        while k < ops.len() {
            let o = &ops[k];
            let ours = o.is("BDC")
                && o.name(0) == Some(b"Artifact")
                && o.operands
                    .get(1)
                    .is_some_and(|(_, r)| bytes[r.clone()].windows(10).any(|w| w == b"WarraqMark"));
            if !ours {
                k += 1;
                continue;
            }
            let mut depth = 0usize;
            let mut end = None;
            for (j, inner) in ops.iter().enumerate().skip(k) {
                if inner.is("BDC") || inner.is("BMC") {
                    depth += 1;
                } else if inner.is("EMC") {
                    depth = depth.saturating_sub(1);
                    if depth == 0 {
                        end = Some(j);
                        break;
                    }
                }
            }
            let Some(end) = end else { break };
            cut.push(o.range.start..ops[end].range.end);
            k = end + 1;
        }
        if cut.is_empty() {
            return Ok(());
        }
        let mut out = Vec::with_capacity(bytes.len());
        let mut at = 0;
        for r in cut {
            out.extend_from_slice(&bytes[at..r.start]);
            at = r.end;
        }
        out.extend_from_slice(&bytes[at..]);
        self.set_stream_bytes(id, out)
    }
}

/// The frame of a page as shown, for tests elsewhere in the crate.
#[cfg(test)]
pub(crate) fn frame_of(doc: &PdfDocument, index: usize) -> crate::frame::Frame {
    doc.display_frame(index).unwrap()
}

/// The matrix a mark form draws with on an upright page.
#[cfg(test)]
pub(crate) fn upright(doc: &PdfDocument, index: usize) -> crate::text_walk::Matrix {
    doc.display_frame(index).unwrap().upright_to_user()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    const AMIRI: &[u8] = include_bytes!("../../../../tests/fonts/Amiri-Regular.ttf");

    fn corpus(name: &str) -> Vec<u8> {
        std::fs::read(format!(
            "{}/../../../tests/corpus/arabic/generated/{name}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap()
    }

    pub(crate) fn mark(kind: MarkKind, content: MarkContent) -> PageMark {
        PageMark {
            kind,
            content,
            size: 12.0,
            color: [0.2, 0.2, 0.2],
            opacity: 1.0,
            rotation: 0.0,
            margin: (36.0, 24.0),
            front: true,
            digits: Digits::Western,
            date: "2026-09-18".into(),
            file_name: "file.pdf".into(),
            spec: "{\"kind\":\"test\"}".into(),
            modified: "D:20260918120000Z".into(),
        }
    }

    /// A small tiled watermark still covers the whole page — top rows
    /// included — however many tiles it would take at its own spacing: past
    /// the bound the tiles spread out evenly instead of stopping short.
    #[test]
    fn a_small_tiled_watermark_covers_the_whole_page() {
        let a4 = (595.0, 842.0);
        for (w, h, degrees) in [
            (12.0, 8.0, 45.0),   // an 8 pt word, turned
            (40.0, 6.0, 0.0),    // 6 pt CONFIDENTIAL, level
            (30.0, 30.0, 0.0),   // a 5 % picture
            (200.0, 72.0, 45.0), // the default: nothing to spread
        ] {
            let centres = tile_centres(w, h, degrees, h * 2.0, a4);
            assert!(centres.len() <= MAX_TILES, "{}", centres.len());
            let top = centres.iter().map(|c| c.1).fold(f32::MIN, f32::max);
            let bottom = centres.iter().map(|c| c.1).fold(f32::MAX, f32::min);
            let right = centres.iter().map(|c| c.0).fold(f32::MIN, f32::max);
            let left = centres.iter().map(|c| c.0).fold(f32::MAX, f32::min);
            assert!(
                top >= a4.1 * 0.9 && bottom <= a4.1 * 0.1,
                "{w}×{h}: {bottom}..{top}"
            );
            assert!(
                right >= a4.0 * 0.9 && left <= a4.0 * 0.1,
                "{w}×{h}: {left}..{right}"
            );
        }
    }

    #[test]
    fn numbers_come_in_either_digits_and_in_roman() {
        assert_eq!(format_number(2026, Digits::ArabicIndic), "٢٠٢٦");
        assert_eq!(format_number(7, Digits::Western), "7");
        assert_eq!(roman(1994), "mcmxciv");
        assert_eq!(roman(0), "0");
    }

    #[test]
    fn page_numbers_skip_the_first_page_and_count_from_the_start_number() {
        let m = mark(
            MarkKind::PageNumber,
            MarkContent::PageNumber {
                format: NumberFormat::PageOfArabic,
                anchor: Anchor {
                    h: HAlign::Center,
                    v: VAlign::Bottom,
                },
                start: 1,
                skip_first: true,
            },
        );
        let m = PageMark {
            digits: Digits::ArabicIndic,
            ..m
        };
        assert!(m.items(0, 0, 4, 4).is_empty(), "the cover gets no number");
        let texts: Vec<String> = (1..4)
            .map(|k| m.items(k, k, 4, 4)[0].text.clone().unwrap())
            .collect();
        assert_eq!(texts, ["صفحة ١ من ٣", "صفحة ٢ من ٣", "صفحة ٣ من ٣"]);
    }

    #[test]
    fn bates_numbers_are_padded_and_run_across_the_pages() {
        let m = mark(
            MarkKind::Bates,
            MarkContent::Bates {
                prefix: "ABC-".into(),
                suffix: "-X".into(),
                start: 98,
                width: 6,
                anchor: Anchor {
                    h: HAlign::Right,
                    v: VAlign::Bottom,
                },
            },
        );
        assert_eq!(m.items(0, 0, 3, 3)[0].text.as_deref(), Some("ABC-000098-X"));
        assert_eq!(m.items(2, 2, 3, 3)[0].text.as_deref(), Some("ABC-000100-X"));
    }

    #[test]
    fn an_arabic_header_starts_on_the_right() {
        let m = mark(
            MarkKind::Header,
            MarkContent::Band {
                slots: ["التقرير السنوي".into(), String::new(), "{date}".into()],
                direction: SlotDirection::Auto,
            },
        );
        let items = m.items(0, 0, 1, 1);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].anchor.h, HAlign::Right);
        assert_eq!(items[1].anchor.h, HAlign::Left);
        assert_eq!(items[1].text.as_deref(), Some("2026-09-18"));
        let m = mark(
            MarkKind::Footer,
            MarkContent::Band {
                slots: [
                    "Annual report".into(),
                    "{file}".into(),
                    "{page}/{pages}".into(),
                ],
                direction: SlotDirection::Auto,
            },
        );
        let items = m.items(1, 1, 3, 3);
        assert_eq!(
            items[0].anchor,
            Anchor {
                h: HAlign::Left,
                v: VAlign::Bottom
            }
        );
        assert_eq!(items[2].text.as_deref(), Some("2/3"));
    }

    #[test]
    fn a_mark_leaves_the_pages_own_streams_alone_and_comes_off_without_a_trace() {
        let original = corpus("chrome-notonaskh-justified-3pages.pdf");
        let mut doc = PdfDocument::open(original.clone(), None).unwrap();
        let page = doc.page_id(0).unwrap();
        let before_dict = doc.doc.get_dictionary(page).unwrap().clone();
        let streams: Vec<(ObjectId, Vec<u8>)> = doc
            .content_ids(page)
            .into_iter()
            .map(|id| (id, doc.stream_bytes(id).unwrap()))
            .collect();

        let m = mark(
            MarkKind::Watermark,
            MarkContent::Watermark {
                text: Some("مسودة".into()),
                image: None,
                anchor: Anchor {
                    h: HAlign::Center,
                    v: VAlign::Middle,
                },
                tiled: false,
            },
        );
        let id = doc.add_mark(&m, &[], Some(AMIRI), true).unwrap();
        assert_eq!(id, 1);
        let listed = doc.list_marks();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].pages, vec![0, 1, 2]);
        assert_eq!(listed[0].kind, MarkKind::Watermark);
        assert_eq!(listed[0].spec, "{\"kind\":\"test\"}");
        for (sid, bytes) in &streams {
            assert_eq!(
                &doc.stream_bytes(*sid).unwrap(),
                bytes,
                "the page's own stream changed"
            );
        }
        let ids = doc.content_ids(page);
        assert_eq!(ids.len(), streams.len() + 2, "wrapped by two of Warraq's");

        // Saved and reopened, the mark is still found, and comes off.
        let saved = doc.save_incremental().unwrap();
        assert!(saved.starts_with(&original));
        let mut doc = PdfDocument::open(saved, None).unwrap();
        assert_eq!(doc.list_marks().len(), 1);
        assert_eq!(doc.remove_marks(&[], &[]).unwrap(), 3);
        assert!(doc.list_marks().is_empty());
        let after_dict = doc.doc.get_dictionary(page).unwrap().clone();
        assert_eq!(after_dict, before_dict, "the page is as it was");
        for (sid, bytes) in &streams {
            assert_eq!(&doc.stream_bytes(*sid).unwrap(), bytes);
        }
    }

    #[test]
    fn a_second_mark_of_a_kind_replaces_the_first_unless_asked_not_to() {
        let mut doc =
            PdfDocument::open(corpus("chrome-notonaskh-justified-3pages.pdf"), None).unwrap();
        let header = |text: &str| {
            mark(
                MarkKind::Header,
                MarkContent::Band {
                    slots: [text.into(), String::new(), String::new()],
                    direction: SlotDirection::Auto,
                },
            )
        };
        doc.add_mark(&header("الأول"), &[0, 1], Some(AMIRI), true)
            .unwrap();
        doc.add_mark(&header("الثاني"), &[1, 2], Some(AMIRI), true)
            .unwrap();
        let marks = doc.list_marks();
        assert_eq!(marks.len(), 2);
        assert_eq!(
            marks[0].pages,
            vec![0],
            "the first header stays only where it was not replaced"
        );
        assert_eq!(marks[1].pages, vec![1, 2]);
        doc.add_mark(&header("الثالث"), &[2], Some(AMIRI), false)
            .unwrap();
        assert_eq!(doc.list_marks().len(), 3);
        // Taking one mark off leaves the others.
        doc.remove_marks(&[2], &[]).unwrap();
        let left: Vec<u32> = doc.list_marks().iter().map(|m| m.id).collect();
        assert_eq!(left, vec![1, 3]);
    }

    #[test]
    fn an_image_watermark_needs_no_font_and_text_without_one_is_refused() {
        let mut doc =
            PdfDocument::open(corpus("chrome-notonaskh-justified-3pages.pdf"), None).unwrap();
        let picture = crate::picture::tests::png(64, 32);
        let m = mark(
            MarkKind::Watermark,
            MarkContent::Watermark {
                text: None,
                image: Some((picture, 0.5)),
                anchor: Anchor {
                    h: HAlign::Center,
                    v: VAlign::Middle,
                },
                tiled: true,
            },
        );
        doc.add_mark(&m, &[1], None, true).unwrap();
        assert_eq!(doc.list_marks()[0].pages, vec![1]);
        let text = mark(
            MarkKind::Footer,
            MarkContent::Band {
                slots: ["x".into(), String::new(), String::new()],
                direction: SlotDirection::Ltr,
            },
        );
        assert!(doc.add_mark(&text, &[0], None, true).is_err());
        assert!(doc.add_mark(&text, &[9], Some(AMIRI), true).is_err());
    }

    /// A phone photo as a watermark is drawn upright, at the proportions it
    /// is seen at: its stored left half (red) above its right half.
    #[test]
    fn a_turned_photo_watermark_is_drawn_upright() {
        let mut doc =
            PdfDocument::open(corpus("chrome-notonaskh-justified-3pages.pdf"), None).unwrap();
        let m = PageMark {
            rotation: 0.0,
            ..mark(
                MarkKind::Watermark,
                MarkContent::Watermark {
                    text: None,
                    image: Some((crate::picture::tests::turned_photo(), 0.2)),
                    anchor: Anchor {
                        h: HAlign::Center,
                        v: VAlign::Middle,
                    },
                    tiled: false,
                },
            )
        };
        doc.add_mark(&m, &[0], None, true).unwrap();
        let page = doc.page_id(0).unwrap();
        let placed = doc.marks_on(page).remove(0);
        let form = doc
            .doc
            .get_object(placed.form)
            .unwrap()
            .as_stream()
            .unwrap();
        let content = Content::decode(&form.decompressed_content().unwrap()).unwrap();
        // The transform the picture is drawn under: every `cm` before `Do`.
        let mut ctm = crate::text_walk::Matrix::IDENTITY;
        for op in &content.operations {
            match op.operator.as_str() {
                "cm" => {
                    let v: Vec<f32> = op.operands.iter().map(|o| o.as_float().unwrap()).collect();
                    ctm = crate::text_walk::Matrix([v[0], v[1], v[2], v[3], v[4], v[5]]).then(ctm);
                }
                "Do" => break,
                _ => {}
            }
        }
        // User space, y up: red above blue; the drawn box taller than wide.
        let (_, red) = ctm.apply(0.25, 0.5);
        let (_, blue) = ctm.apply(0.75, 0.5);
        assert!(red > blue, "{red} {blue}");
        let (x0, y0) = ctm.apply(0.0, 0.0);
        let (x1, y1) = ctm.apply(1.0, 1.0);
        assert!(
            (y1 - y0).abs() > (x1 - x0).abs() * 1.9,
            "{x0},{y0} {x1},{y1}"
        );
    }

    #[test]
    fn the_upright_frame_puts_a_turned_pages_top_where_the_reader_sees_it() {
        let mut doc =
            PdfDocument::open(corpus("chrome-notonaskh-justified-3pages.pdf"), None).unwrap();
        doc.rotate_pages(&[0], 1).unwrap();
        let frame = frame_of(&doc, 0);
        let (w, h) = frame.shown_size();
        assert!(w > h, "turned a quarter, A4 is shown landscape");
        // The top-left of the upright page is the top-left the reader sees.
        let m = upright(&doc, 0);
        assert_eq!(m.apply(0.0, h), frame.user(0.0, 0.0));
    }
}
