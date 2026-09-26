//! One page seen three ways and linked together: the byte-faithful operations (warraq-edit's lexer
//! and scanner: text operators with glyph boxes, picture placements), their marked-content state
//! ([`crate::marked`]) and warraq-text's words in **logical order**. Every text operator is linked
//! to the word its glyphs fall in, which gives each operator a logical rank (so structure order can
//! follow reading order even where content order is visual, as in Chromium's right-to-left runs).

use lopdf::Object;
use warraq_edit::geom::Rect as ERect;
use warraq_edit::page::{load, resources, PageContent};
use warraq_edit::scan::{scan, Scan};
use warraq_pdf::Pdf;
use warraq_text::bidi::Dir;
use warraq_text::geom::Rect;
use warraq_text::model::PageText;
use warraq_text::{extract_pages, DocSource, LayoutOptions};

use crate::error::{A11yError, Result};
use crate::marked::{analyze, named_props, Marks};

/// Maximum words linked per page.
pub const MAX_WORDS: usize = 200_000;
/// Grid cell size (points) of the word index.
const CELL: f64 = 24.0;

/// A word in logical order.
#[derive(Debug, Clone)]
pub struct WordInfo {
    pub text: String,
    /// Top-left page coordinates.
    pub bbox: Rect,
    pub glyphs: Vec<Rect>,
    pub size: f64,
    pub bold: bool,
    pub rtl: bool,
    pub hidden: bool,
    pub artifact: bool,
    /// Paragraph index (page level, logical order).
    pub para: usize,
    pub line: usize,
}

/// A paragraph in logical order.
#[derive(Debug, Clone)]
pub struct ParaInfo {
    pub text: String,
    pub bbox: Rect,
    pub rtl: bool,
    pub lines: usize,
    /// Word indices (into [`PageMap::words`]).
    pub words: std::ops::Range<usize>,
}

/// A page with its operations, marks and words linked.
pub struct PageMap {
    pub index: usize,
    pub pc: PageContent,
    pub scan: Scan,
    pub marks: Marks,
    pub words: Vec<WordInfo>,
    pub paras: Vec<ParaInfo>,
    /// Per `scan.shows` entry: the word most of its glyphs fall in.
    pub show_word: Vec<Option<usize>>,
    /// Per `scan.shows` entry: every word its glyphs fall in, with the glyph count, by word index.
    pub show_votes: Vec<Vec<(usize, usize)>>,
    /// Per `scan.shows` entry: the show draws at least one glyph.
    pub show_visible: Vec<bool>,
    /// Per `scan.shows` entry: all its glyphs are white space.
    pub show_blank: Vec<bool>,
    pub width: f64,
    pub height: f64,
}

/// Extract the logical-order text of `pages` (words with glyph boxes, artifacts included).
pub fn extract(pdf: &Pdf, pages: &[usize]) -> Result<Vec<PageText>> {
    let src = DocSource::borrowed(pdf.document());
    let opts = LayoutOptions {
        glyphs: true,
        include_hidden: true,
        include_artifacts: true,
    };
    extract_pages(&src, pages, &opts).map_err(|e| A11yError::Params(e.to_string()))
}

fn to_text_rect(r: &ERect) -> Rect {
    Rect::new(r.x0, r.y0, r.x1, r.y1)
}

impl PageMap {
    /// Build the map of page `index`; `text` is its extraction (from [`extract`]) when already done.
    pub fn build(pdf: &Pdf, index: usize, text: Option<PageText>) -> Result<PageMap> {
        let pc = load(pdf, index)?;
        let sc = scan(pdf, &pc)?;
        let res = resources(pdf, pc.page_id);
        let named = named_props(pdf, &res);
        let marks = analyze(&sc.content, &named);
        let pt = match text {
            Some(t) => t,
            None => extract(pdf, &[index])?
                .into_iter()
                .next()
                .ok_or_else(|| A11yError::NotFound(format!("page {index}")))?,
        };
        let mut words = Vec::new();
        let mut paras = Vec::new();
        for (pi, p) in pt.paragraphs().enumerate() {
            let start = words.len();
            for (li, l) in p.lines.iter().enumerate() {
                for w in &l.words {
                    if words.len() >= MAX_WORDS {
                        break;
                    }
                    words.push(WordInfo {
                        text: w.text.clone(),
                        bbox: w.bbox,
                        glyphs: w.glyphs.iter().map(|g| g.bbox).collect(),
                        size: w.size,
                        bold: w.bold,
                        rtl: w.dir == Dir::Rtl,
                        hidden: w.hidden,
                        artifact: w.artifact,
                        para: pi,
                        line: li,
                    });
                }
            }
            paras.push(ParaInfo {
                text: p.text.clone(),
                bbox: p.bbox,
                rtl: p.dir == Dir::Rtl,
                lines: p.lines.len(),
                words: start..words.len(),
            });
        }
        let index_grid = Grid::new(&words);
        let mut show_word = Vec::with_capacity(sc.shows.len());
        let mut show_votes = Vec::with_capacity(sc.shows.len());
        let mut show_visible = Vec::with_capacity(sc.shows.len());
        let mut show_blank = Vec::with_capacity(sc.shows.len());
        for s in &sc.shows {
            let mut votes: Vec<(usize, usize)> = Vec::new();
            let mut visible = false;
            for g in &s.glyphs {
                let r = pc.space.rect_to_tl(&g.bbox);
                if !(r.width() > 0.0 || r.height() > 0.0) || !r.is_finite() {
                    continue;
                }
                visible = true;
                let (cx, cy) = r.center();
                if let Some(w) = index_grid.find(&words, cx, cy) {
                    match votes.iter_mut().find(|(k, _)| *k == w) {
                        Some(v) => v.1 += 1,
                        None => votes.push((w, 1)),
                    }
                }
            }
            show_word.push(votes.iter().max_by_key(|(_, n)| *n).map(|(w, _)| *w));
            votes.sort_unstable();
            show_votes.push(votes);
            show_visible.push(visible);
            show_blank.push(s.glyphs.iter().all(|g| g.text.trim().is_empty()));
        }
        Ok(PageMap {
            index,
            width: pt.width,
            height: pt.height,
            pc,
            scan: sc,
            marks,
            words,
            paras,
            show_word,
            show_votes,
            show_visible,
            show_blank,
        })
    }

    /// Page object id.
    pub fn page_id(&self) -> lopdf::ObjectId {
        self.pc.page_id
    }

    /// Top-left box of a user-space rectangle.
    pub fn to_tl(&self, r: &ERect) -> Rect {
        to_text_rect(&self.pc.space.rect_to_tl(r))
    }

    /// Top-left box of a picture placement (its CTM maps the unit square).
    pub fn image_box(&self, i: usize) -> Option<Rect> {
        let im = self.scan.images.get(i)?;
        let r = im.ctm.map_rect(&ERect::new(0.0, 0.0, 1.0, 1.0));
        Some(self.to_tl(&r))
    }

    /// Show index of operation `op`, if it is a text-showing operation.
    pub fn show_at(&self) -> Vec<Option<usize>> {
        let mut v = vec![None; self.scan.content.ops.len()];
        for (si, s) in self.scan.shows.iter().enumerate() {
            if let Some(slot) = v.get_mut(s.op) {
                *slot = Some(si);
            }
        }
        v
    }

    /// Image index of operation `op`, if it places a picture.
    pub fn image_at(&self) -> Vec<Option<usize>> {
        let mut v = vec![None; self.scan.content.ops.len()];
        for (ii, s) in self.scan.images.iter().enumerate() {
            if let Some(slot) = v.get_mut(s.op) {
                *slot = Some(ii);
            }
        }
        v
    }
}

/// Uniform grid of word boxes for point lookups.
struct Grid {
    cols: usize,
    rows: usize,
    cells: Vec<Vec<usize>>,
}

impl Grid {
    fn new(words: &[WordInfo]) -> Grid {
        let (mut w, mut h) = (1.0f64, 1.0f64);
        for x in words {
            if x.bbox.x1.is_finite() && x.bbox.y1.is_finite() {
                w = w.max(x.bbox.x1);
                h = h.max(x.bbox.y1);
            }
        }
        let cols = ((w / CELL).ceil() as usize).clamp(1, 512);
        let rows = ((h / CELL).ceil() as usize).clamp(1, 512);
        let mut cells = vec![Vec::new(); cols * rows];
        for (i, x) in words.iter().enumerate() {
            let b = x.bbox;
            if !(b.x0.is_finite() && b.y0.is_finite() && b.x1.is_finite() && b.y1.is_finite()) {
                continue;
            }
            let c0 = Self::band(b.x0 - 1.0, cols);
            let c1 = Self::band(b.x1 + 1.0, cols);
            let r0 = Self::band(b.y0 - 1.0, rows);
            let r1 = Self::band(b.y1 + 1.0, rows);
            for r in r0..=r1 {
                for c in c0..=c1 {
                    if let Some(cell) = cells.get_mut(r * cols + c) {
                        if cell.len() < 4096 {
                            cell.push(i);
                        }
                    }
                }
            }
        }
        Grid { cols, rows, cells }
    }

    fn band(v: f64, n: usize) -> usize {
        if !v.is_finite() || v <= 0.0 {
            return 0;
        }
        ((v / CELL) as usize).min(n - 1)
    }

    /// The word whose glyph (else word box) contains the point.
    fn find(&self, words: &[WordInfo], x: f64, y: f64) -> Option<usize> {
        let c = Self::band(x, self.cols);
        let r = Self::band(y, self.rows);
        let cell = self.cells.get(r * self.cols + c)?;
        let inside = |b: &Rect, pad: f64| {
            x >= b.x0 - pad && x <= b.x1 + pad && y >= b.y0 - pad && y <= b.y1 + pad
        };
        for &i in cell {
            if let Some(w) = words.get(i) {
                if w.glyphs.iter().any(|g| inside(g, 0.25)) {
                    return Some(i);
                }
            }
        }
        cell.iter()
            .copied()
            .find(|i| words.get(*i).is_some_and(|w| inside(&w.bbox, 0.5)))
    }
}

/// Whether an operation draws something (the checker's "content").
pub fn draws(pm: &PageMap, op: usize, show: Option<usize>) -> bool {
    let Some(o) = pm.scan.content.ops.get(op) else {
        return false;
    };
    if let Some(si) = show {
        return pm.show_visible.get(si).copied().unwrap_or(false);
    }
    matches!(
        o.operator.as_slice(),
        b"S" | b"s" | b"f" | b"F" | b"f*" | b"B" | b"B*" | b"b" | b"b*" | b"sh" | b"BI"
    ) || (o.is(b"Do") && !matches!(o.operands.first().map(|x| &x.value), None))
}

/// Resolved `Do` target kind: image, form, or unknown.
pub fn xobject_kind(pdf: &Pdf, pm: &PageMap, op: usize) -> Option<&'static str> {
    let o = pm.scan.content.ops.get(op)?;
    let name = o.operands.first()?.value.name()?;
    let res = resources(pdf, pm.pc.page_id);
    let (_, obj) = warraq_edit::page::resource(pdf, &res, b"XObject", name)?;
    let Object::Stream(s) = obj else { return None };
    match s.dict.get(b"Subtype").ok()?.as_name().ok()? {
        b"Image" => Some("image"),
        b"Form" => Some("form"),
        _ => None,
    }
}
