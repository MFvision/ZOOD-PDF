//! The export model: pages of paragraphs (with bold/italic runs, direction, language and heading
//! level) and tables (cells with spans, in logical column order), built from warraq-text's
//! logical-order extraction plus table detection.

use serde::Serialize;
use warraq_text::bidi::Dir;
use warraq_text::geom::Rect;
use warraq_text::{ContentSource, LayoutOptions, PageText};

use crate::error::Result;
use crate::rules::page_segments;
use crate::table::{aligned_grids, ruled_grids, Grid, WordBox};
use crate::xml::{dir_of, guess_lang};

/// A run of text with one formatting.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Run {
    pub text: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub bold: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub italic: bool,
}

/// A paragraph in logical order.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Para {
    pub text: String,
    pub runs: Vec<Run>,
    pub dir: Dir,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
    /// 0 = body text, 1–3 = heading level.
    pub heading: u8,
    /// Median font size (points).
    pub size: f64,
    pub bbox: Rect,
}

/// A table cell (logical column order: column 0 is the first column in reading direction).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Cell {
    pub row: usize,
    pub col: usize,
    pub rowspan: usize,
    pub colspan: usize,
    pub text: String,
    pub dir: Dir,
    pub bold: bool,
    pub bbox: Rect,
}

/// A table.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Table {
    pub rows: usize,
    pub cols: usize,
    /// Column widths in points, logical order.
    pub widths: Vec<f64>,
    pub cells: Vec<Cell>,
    pub dir: Dir,
    pub ruled: bool,
    pub bbox: Rect,
}

impl Table {
    /// The cell whose top-left (logical) slot is `(row, col)`.
    pub fn cell(&self, row: usize, col: usize) -> Option<&Cell> {
        self.cells.iter().find(|c| c.row == row && c.col == col)
    }
    /// True when `(row, col)` is covered by a span starting elsewhere.
    pub fn covered(&self, row: usize, col: usize) -> Option<&Cell> {
        self.cells.iter().find(|c| {
            (c.row..c.row + c.rowspan).contains(&row)
                && (c.col..c.col + c.colspan).contains(&col)
                && !(c.row == row && c.col == col)
        })
    }
}

/// A page item in reading order.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Item {
    Para(Para),
    Table(Table),
}

/// One exported page.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ExportPage {
    /// 0-based page index in the source document.
    pub index: usize,
    pub width: f64,
    pub height: f64,
    pub items: Vec<Item>,
    /// Logical-order plain text of the page (exactly warraq-text's).
    #[serde(skip)]
    pub plain: String,
}

/// The whole export model.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ExportDoc {
    pub title: Option<String>,
    pub pages: Vec<ExportPage>,
    /// Main direction of the document (majority of paragraphs).
    pub dir: Dir,
    /// Main language guessed from the script.
    pub lang: Option<String>,
}

impl ExportDoc {
    pub fn tables(&self) -> impl Iterator<Item = &Table> {
        self.pages.iter().flat_map(|p| {
            p.items.iter().filter_map(|i| match i {
                Item::Table(t) => Some(t),
                Item::Para(_) => None,
            })
        })
    }
}

/// Flattened word reference.
struct W<'a> {
    text: &'a str,
    bbox: Rect,
    size: f64,
    bold: bool,
    italic: bool,
    para: usize,
    line: usize,
    seq: usize,
}

/// Build the export model for `pages` (0-based).
pub fn build<S: ContentSource + ?Sized>(
    src: &S,
    pages: &[usize],
    title: Option<String>,
) -> Result<ExportDoc> {
    let texts = warraq_text::extract_pages(src, pages, &LayoutOptions::default())?;
    let mut segs = Vec::with_capacity(texts.len());
    for &p in pages {
        segs.push(page_segments(src, p).unwrap_or_default());
    }
    Ok(build_from(texts, &segs, title))
}

/// Build the model from extracted pages and their ruling segments (one entry per page).
pub fn build_from(
    texts: Vec<PageText>,
    segs: &[Vec<crate::rules::Segment>],
    title: Option<String>,
) -> ExportDoc {
    // Body size: the most common (character-weighted) font size of the document.
    let mut hist: Vec<(f64, usize)> = Vec::new();
    for p in &texts {
        for para in p.paragraphs() {
            for l in &para.lines {
                for w in &l.words {
                    let s = (w.size * 2.0).round() / 2.0;
                    let n = w.text.chars().count();
                    if let Some(e) = hist.iter_mut().find(|(k, _)| *k == s) {
                        e.1 += n;
                    } else if hist.len() < 4096 {
                        hist.push((s, n));
                    }
                }
            }
        }
    }
    let body = hist
        .iter()
        .max_by_key(|(_, n)| *n)
        .map_or(12.0, |(s, _)| *s)
        .max(1.0);

    let mut pages = Vec::with_capacity(texts.len());
    let (mut rtl, mut ltr) = (0usize, 0usize);
    let mut all_text = String::new();
    for (k, page) in texts.into_iter().enumerate() {
        let empty = Vec::new();
        let page_segs = segs.get(k).unwrap_or(&empty);
        let p = build_page(page, page_segs, body);
        for it in &p.items {
            if let Item::Para(para) = it {
                match para.dir {
                    Dir::Rtl => rtl += para.text.chars().count(),
                    Dir::Ltr => ltr += para.text.chars().count(),
                }
                if all_text.len() < 100_000 {
                    all_text.push_str(&para.text);
                    all_text.push(' ');
                }
            }
        }
        pages.push(p);
    }
    ExportDoc {
        title,
        pages,
        dir: if rtl > ltr { Dir::Rtl } else { Dir::Ltr },
        lang: guess_lang(&all_text).map(str::to_string),
    }
}

fn heading_level(size: f64, body: f64, text: &str, lines: usize) -> u8 {
    let short = lines <= 2 && text.chars().count() <= 120;
    if !short || text.trim().is_empty() {
        return 0;
    }
    let r = size / body;
    if r >= 1.6 {
        1
    } else if r >= 1.3 {
        2
    } else if r >= 1.15 {
        3
    } else {
        0
    }
}

fn runs_of(words: &[&W]) -> Vec<Run> {
    let mut runs: Vec<Run> = Vec::new();
    let mut prev_line: Option<(usize, usize)> = None;
    for w in words {
        let sep = prev_line.is_some();
        prev_line = Some((w.para, w.line));
        match runs.last_mut() {
            Some(r) if r.bold == w.bold && r.italic == w.italic => {
                if sep {
                    r.text.push(' ');
                }
                r.text.push_str(w.text);
            }
            Some(r) => {
                if sep {
                    r.text.push(' ');
                }
                runs.push(Run {
                    text: w.text.to_string(),
                    bold: w.bold,
                    italic: w.italic,
                });
            }
            None => runs.push(Run {
                text: w.text.to_string(),
                bold: w.bold,
                italic: w.italic,
            }),
        }
    }
    runs
}

fn median(mut v: Vec<f64>) -> f64 {
    v.retain(|x| x.is_finite());
    v.sort_by(f64::total_cmp);
    v.get(v.len() / 2).copied().unwrap_or(0.0)
}

fn build_page(page: PageText, segs: &[crate::rules::Segment], body: f64) -> ExportPage {
    // Flatten words in logical reading order.
    let mut words: Vec<W> = Vec::new();
    let paras: Vec<&warraq_text::model::Paragraph> = page.paragraphs().collect();
    for (pi, para) in paras.iter().enumerate() {
        for (li, line) in para.lines.iter().enumerate() {
            for w in &line.words {
                words.push(W {
                    text: &w.text,
                    bbox: w.bbox,
                    size: w.size,
                    bold: w.bold,
                    italic: w.italic,
                    para: pi,
                    line: li,
                    seq: words.len(),
                });
            }
        }
    }
    // Tables: ruled first, then aligned among the remaining words.
    let mut grids: Vec<Grid> = ruled_grids(segs);
    // Keep only ruled grids that contain text.
    grids.retain(|g| {
        let b = g.bbox();
        words.iter().any(|w| {
            let (x, y) = (w.bbox.cx(), w.bbox.cy());
            x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1
        })
    });
    let exclude: Vec<Rect> = grids.iter().map(Grid::bbox).collect();
    let boxes: Vec<WordBox> = words
        .iter()
        .map(|w| WordBox {
            bbox: w.bbox,
            size: w.size,
            id: w.seq,
        })
        .collect();
    grids.extend(aligned_grids(&boxes, &exclude));

    // Assign words to (grid, cell).
    let mut owner: Vec<Option<(usize, usize)>> = vec![None; words.len()];
    for (wi, w) in words.iter().enumerate() {
        let (x, y) = (w.bbox.cx(), w.bbox.cy());
        for (gi, g) in grids.iter().enumerate() {
            if let Some(ci) = g.cell_at(x, y) {
                if let Some(o) = owner.get_mut(wi) {
                    *o = Some((gi, ci));
                }
                break;
            }
        }
    }
    // Build tables.
    let mut tables: Vec<Option<Table>> = grids
        .iter()
        .enumerate()
        .map(|(gi, g)| Some(make_table(g, gi, &words, &owner)))
        .collect();

    // Items in reading order: paragraphs minus table words; a table where its first word was.
    let mut items = Vec::new();
    for (pi, para) in paras.iter().enumerate() {
        let mut outside: Vec<&W> = Vec::new();
        let mut any_inside = false;
        for (wi, w) in words.iter().enumerate().filter(|(_, w)| w.para == pi) {
            match owner.get(wi).copied().flatten() {
                Some((gi, _)) => {
                    any_inside = true;
                    if let Some(t) = tables.get_mut(gi).and_then(Option::take) {
                        if !outside.is_empty() {
                            items.push(Item::Para(make_para(&outside, para, body, false)));
                            outside.clear();
                        }
                        items.push(Item::Table(t));
                    }
                }
                None => outside.push(w),
            }
        }
        if !outside.is_empty() {
            items.push(Item::Para(make_para(&outside, para, body, !any_inside)));
        }
    }
    ExportPage {
        index: page.page,
        width: page.width,
        height: page.height,
        items,
        plain: page.plain,
    }
}

fn make_para(ws: &[&W], para: &warraq_text::model::Paragraph, body: f64, whole: bool) -> Para {
    let runs = runs_of(ws);
    // A paragraph kept whole uses the extractor's exact text.
    let text = if whole {
        para.text.clone()
    } else {
        runs.iter().map(|r| r.text.as_str()).collect()
    };
    let size = median(ws.iter().map(|w| w.size).collect());
    let bbox = ws
        .iter()
        .map(|w| w.bbox)
        .reduce(|a, b| a.union(&b))
        .unwrap_or_default();
    let lines = {
        let mut l: Vec<usize> = ws.iter().map(|w| w.line).collect();
        l.dedup();
        l.len()
    };
    Para {
        heading: heading_level(size, body, &text, lines),
        dir: if whole { para.dir } else { dir_of(&text) },
        lang: guess_lang(&text).map(str::to_string),
        runs,
        text,
        size,
        bbox,
    }
}

fn make_table(g: &Grid, gi: usize, words: &[W], owner: &[Option<(usize, usize)>]) -> Table {
    let cols = g.cols();
    let mut cells: Vec<Cell> = Vec::with_capacity(g.cells.len());
    let mut all = String::new();
    for (ci, gc) in g.cells.iter().enumerate() {
        let mut ws: Vec<&W> = words
            .iter()
            .enumerate()
            .filter(|(wi, _)| owner.get(*wi).copied().flatten() == Some((gi, ci)))
            .map(|(_, w)| w)
            .collect();
        // Visual lines top to bottom, logical order (sequence) within a line.
        ws.sort_by(|a, b| a.bbox.cy().total_cmp(&b.bbox.cy()));
        let mut lines: Vec<Vec<&W>> = Vec::new();
        for w in ws {
            match lines.last_mut() {
                Some(l)
                    if l.first().is_some_and(|f| {
                        (w.bbox.cy() - f.bbox.cy()).abs() < 0.5 * f.bbox.height().max(1.0)
                    }) =>
                {
                    l.push(w)
                }
                _ => lines.push(vec![w]),
            }
        }
        let mut text = String::new();
        let mut bold = true;
        let mut n = 0;
        for l in &mut lines {
            l.sort_by_key(|w| w.seq);
            for w in l.iter() {
                if !text.is_empty() {
                    text.push(' ');
                }
                text.push_str(w.text);
                bold &= w.bold;
                n += 1;
            }
        }
        all.push_str(&text);
        all.push(' ');
        cells.push(Cell {
            row: gc.row,
            col: gc.col,
            rowspan: gc.rowspan,
            colspan: gc.colspan,
            dir: dir_of(&text),
            bold: bold && n > 0,
            bbox: g.cell_rect(gc),
            text,
        });
    }
    let dir = dir_of(&all);
    let mut widths: Vec<f64> =
        g.xs.windows(2)
            .map(|w| match w {
                [a, b] => b - a,
                _ => 0.0,
            })
            .collect();
    if dir == Dir::Rtl {
        // Logical column 0 is the rightmost one.
        for c in &mut cells {
            c.col = cols.saturating_sub(c.col + c.colspan);
        }
        widths.reverse();
    }
    cells.sort_by_key(|c| (c.row, c.col));
    Table {
        rows: g.rows(),
        cols,
        widths,
        cells,
        dir,
        ruled: g.ruled,
        bbox: g.bbox(),
    }
}
