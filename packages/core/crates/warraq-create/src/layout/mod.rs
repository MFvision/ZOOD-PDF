//! The layout engine: document model → pages of positioned items + a structure tree.
//!
//! Blocks are first *composed* into boxes (lines, pictures, table rows) for a column width, then
//! the boxes are *placed* on pages. Widow/orphan control and "keep heading with next" are
//! expressed as `keep_with_next` links between boxes; table header rows are repeated on every
//! page a table continues on (as pagination artifacts). Every box knows the structure element
//! (P, H1–H6, L/LI/Lbl/LBody, Table/TR/TH/TD, Figure) its content belongs to.

pub mod text;

use crate::error::{CreateError, Result};
use crate::limits;
use crate::model::{
    Align, Block, Color, Content, Dir, Document, FixedPage, FrameContent, ImageBlock, ListInfo,
    NumberStyle, PageSetup, ParaStyle, Paragraph, Run, Style, Table,
};
use text::{break_lines, place_line, shape_paragraph, Line, Piece};

/// Who a drawn item belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tag {
    /// Structure element index in [`Layout::elems`].
    Elem(usize),
    /// Pagination artifact (borders, repeated headers, page numbers).
    Artifact,
}

/// A drawn item. Coordinates are PDF user space (origin bottom-left, points).
#[derive(Debug, Clone, PartialEq)]
pub enum Item {
    /// A shaped piece; `(x, y)` is the pen position on the baseline.
    Text {
        x: f64,
        y: f64,
        piece: Piece,
        tag: Tag,
    },
    /// A picture filling the rectangle.
    Image {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        image: usize,
        tag: Tag,
    },
    /// A filled rectangle (artifact).
    Rect {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        color: Color,
    },
    /// A stroked line (artifact).
    Rule {
        x1: f64,
        y1: f64,
        x2: f64,
        y2: f64,
        width: f64,
        color: Color,
    },
}

/// One output page.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Page {
    pub width: f64,
    pub height: f64,
    pub items: Vec<Item>,
}

/// A structure element (tagged PDF).
#[derive(Debug, Clone, PartialEq)]
pub struct Elem {
    pub role: &'static str,
    pub parent: usize,
    pub kids: Vec<usize>,
    pub alt: Option<String>,
    pub lang: Option<String>,
}

/// The result of layout.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Layout {
    pub pages: Vec<Page>,
    /// `elems[0]` is the `Document` root.
    pub elems: Vec<Elem>,
}

/// Layout options.
#[derive(Debug, Clone, Default)]
pub struct Options {
    /// Direction of `Dir::Auto` content without strong letters (the UI locale).
    pub default_rtl: bool,
    /// Add "Page n of N" footers (artifacts).
    pub page_numbers: bool,
    /// Write page numbers in Arabic (`صفحة ١ من ٣`).
    pub arabic_numbers: bool,
}

const CELL_PAD: f64 = 4.0;
const LIST_STEP: f64 = 20.0;
const BORDER: Color = Color {
    r: 0x99,
    g: 0x99,
    b: 0x99,
};

/// What a box draws.
#[derive(Debug, Clone, PartialEq)]
enum Kind {
    /// A line of text at `x` (from the column's left) with its baseline `ascent` below the top.
    Line {
        line: Line,
        x: f64,
        tag: Tag,
        label: Option<(f64, Line, Tag)>,
        background: Option<(f64, f64, Color)>,
    },
    Image {
        x: f64,
        w: f64,
        image: usize,
        tag: Tag,
    },
    Row(Row),
    Space,
}

#[derive(Debug, Clone, PartialEq)]
struct RowCell {
    x: f64,
    w: f64,
    content: Vec<LBox>,
    fill: Option<Color>,
    /// Height of the drawn cell (spans).
    h: f64,
}

#[derive(Debug, Clone, PartialEq)]
struct Row {
    table: usize,
    header: bool,
    borders: bool,
    cells: Vec<RowCell>,
}

#[derive(Debug, Clone, PartialEq)]
struct LBox {
    h: f64,
    kind: Kind,
    keep_with_next: bool,
    /// Discarded at the top of a page.
    gap_before: f64,
    /// Start a new page before this box.
    break_before: bool,
}

impl LBox {
    fn space(h: f64) -> LBox {
        LBox {
            h,
            kind: Kind::Space,
            keep_with_next: false,
            gap_before: 0.0,
            break_before: false,
        }
    }
}

struct Composer<'a> {
    doc: &'a Document,
    opts: &'a Options,
    elems: Vec<Elem>,
    tables: usize,
    /// Stack of open lists: (level, L element, last LI element).
    lists: Vec<(u8, usize, Option<usize>)>,
    /// Page content height (rows taller than this are split).
    max_h: f64,
    blocks: usize,
}

impl<'a> Composer<'a> {
    fn elem(&mut self, role: &'static str, parent: usize) -> usize {
        self.elem_with(role, parent, None, None)
    }

    fn elem_with(
        &mut self,
        role: &'static str,
        parent: usize,
        alt: Option<String>,
        lang: Option<String>,
    ) -> usize {
        let id = self.elems.len();
        self.elems.push(Elem {
            role,
            parent,
            kids: Vec::new(),
            alt,
            lang,
        });
        if let Some(p) = self.elems.get_mut(parent) {
            p.kids.push(id);
        }
        id
    }

    fn close_lists(&mut self) {
        self.lists.clear();
    }

    /// Compose a sequence of blocks for a column `width` wide.
    fn blocks(
        &mut self,
        blocks: &[Block],
        width: f64,
        parent: usize,
        depth: usize,
    ) -> Result<Vec<LBox>> {
        if depth > limits::MAX_NESTING {
            return Err(CreateError::limit("nesting depth"));
        }
        let mut out = Vec::new();
        let mut pending_break = false;
        for b in blocks {
            self.blocks += 1;
            limits::check(self.blocks, limits::MAX_BLOCKS, "blocks")?;
            let mut boxes = match b {
                Block::Paragraph(p) => self.paragraph(p, width, parent)?,
                Block::Table(t) => {
                    self.close_lists();
                    self.table(t, width, parent, depth)?
                }
                Block::Image(i) => {
                    self.close_lists();
                    self.image(i, width, parent)
                }
                Block::PageBreak => {
                    pending_break = true;
                    continue;
                }
            };
            if pending_break {
                if let Some(first) = boxes.first_mut() {
                    first.break_before = true;
                    pending_break = false;
                }
            }
            out.append(&mut boxes);
        }
        if pending_break {
            let mut s = LBox::space(0.0);
            s.break_before = true;
            out.push(s);
        }
        self.close_lists();
        Ok(out)
    }

    fn paragraph(&mut self, p: &Paragraph, width: f64, parent: usize) -> Result<Vec<LBox>> {
        let st = &p.style;
        // Structure: list items go under L/LI, others straight under the parent.
        let (body_parent, label_tag) = match &st.list {
            Some(li) => {
                let (lbody, lbl) = self.list_item(li, parent);
                (lbody, Some(lbl))
            }
            None => {
                self.close_lists();
                (parent, None)
            }
        };
        let role = match (st.heading, &st.list) {
            (_, Some(_)) => "LBody",
            (1, _) => "H1",
            (2, _) => "H2",
            (3, _) => "H3",
            (4, _) => "H4",
            (5, _) => "H5",
            (6, _) => "H6",
            _ => "P",
        };
        let text = p.text();
        let rtl = text::base_rtl(st.dir, &text, self.opts.default_rtl);
        let lang = p
            .runs
            .iter()
            .find_map(|r| r.style.lang.clone())
            .or_else(|| Some(if rtl { "ar".into() } else { "en".into() }));
        let elem = if role == "LBody" {
            // LBody was created by list_item; record the language on it.
            if let Some(e) = self.elems.get_mut(body_parent) {
                e.lang = lang;
            }
            body_parent
        } else {
            self.elem_with(role, body_parent, None, lang)
        };
        let list_indent = st
            .list
            .as_ref()
            .map_or(0.0, |l| LIST_STEP * (f64::from(l.level.min(8)) + 1.0));
        let start_indent = (st.indent.max(0.0) + list_indent).min(width * 0.6);
        let avail = (width - start_indent).max(12.0);
        let shaped = shape_paragraph(p, self.opts.default_rtl)?;
        let lines = break_lines(&shaped, avail)?;
        let n = lines.len();
        let factor = if st.line_height > 0.1 {
            st.line_height.min(5.0)
        } else {
            1.0
        };
        let (def_before, def_after) = match st.heading {
            1 => (18.0, 8.0),
            2 => (14.0, 6.0),
            3..=6 => (10.0, 4.0),
            _ if st.list.is_some() => (0.0, 3.0),
            _ => (0.0, 6.0),
        };
        let mut out = Vec::with_capacity(n + 1);
        for (k, (pieces, hard)) in lines.into_iter().enumerate() {
            let justify = st.align == Align::Justify && !hard;
            let mut line = if pieces.is_empty() {
                empty_line(&shaped.empty_style)?
            } else {
                place_line(pieces, rtl, avail, justify)?
            };
            line.ascent *= factor;
            let free = (avail - line.width).max(0.0);
            let off = match (st.align, rtl) {
                (Align::Center, _) => free / 2.0,
                (Align::Left, _) | (Align::Start | Align::Justify, false) | (Align::End, true) => {
                    0.0
                }
                _ => free,
            };
            let x = if rtl { off } else { start_indent + off };
            let label = if k == 0 {
                match (&st.list, label_tag) {
                    (Some(li), Some(lt)) => {
                        let l = label_line(li, rtl, &shaped.empty_style)?;
                        // The label sits in the gutter on the start side of the text.
                        let lx = if rtl {
                            width - start_indent + LIST_STEP - l.width
                        } else {
                            start_indent - LIST_STEP
                        };
                        let lx = if rtl {
                            lx.min(width - l.width)
                        } else {
                            lx.max(0.0)
                        };
                        Some((lx, l, Tag::Elem(lt)))
                    }
                    _ => None,
                }
            } else {
                None
            };
            let h = line.height();
            out.push(LBox {
                h,
                kind: Kind::Line {
                    line,
                    x,
                    tag: Tag::Elem(elem),
                    label,
                    background: st
                        .background
                        .map(|c| (if rtl { 0.0 } else { start_indent }, avail, c)),
                },
                // Orphans (first two lines) and widows (last two lines) stay together;
                // headings stay with what follows.
                keep_with_next: (n > 1 && (k == 0 || k + 2 == n)) || (st.heading > 0 && k + 1 == n),
                gap_before: if k == 0 {
                    st.space_before.unwrap_or(def_before)
                } else {
                    0.0
                },
                break_before: k == 0 && st.page_break_before,
            });
        }
        let after = st.space_after.unwrap_or(def_after);
        if after > 0.0 {
            let mut s = LBox::space(after);
            s.keep_with_next = st.heading > 0;
            out.push(s);
        }
        Ok(out)
    }

    /// Structure for a list item: returns (LBody, Lbl) element ids.
    fn list_item(&mut self, li: &ListInfo, parent: usize) -> (usize, usize) {
        // Pop deeper or same-level-but-different lists.
        while self.lists.last().is_some_and(|(lvl, _, _)| *lvl > li.level) {
            self.lists.pop();
        }
        let need_new = self.lists.last().is_none_or(|(lvl, _, _)| *lvl != li.level);
        if need_new {
            let lparent = self
                .lists
                .last()
                .and_then(|(_, _, last_li)| *last_li)
                .unwrap_or(parent);
            let l = self.elem("L", lparent);
            self.lists.push((li.level, l, None));
        }
        let l = self.lists.last().map_or(parent, |x| x.1);
        let item = self.elem("LI", l);
        if let Some(top) = self.lists.last_mut() {
            top.2 = Some(item);
        }
        let lbl = self.elem("Lbl", item);
        let body = self.elem("LBody", item);
        (body, lbl)
    }

    fn image(&mut self, ib: &ImageBlock, width: f64, parent: usize) -> Vec<LBox> {
        let alt = if ib.alt.trim().is_empty() {
            "image".to_string()
        } else {
            ib.alt.clone()
        };
        let elem = self.elem_with("Figure", parent, Some(alt), None);
        let (mut w, mut h) = (ib.width.max(1.0), ib.height.max(1.0));
        if w > width {
            h *= width / w;
            w = width;
        }
        let max_h = self.max_h * 0.95;
        if h > max_h {
            w *= max_h / h;
            h = max_h;
        }
        let x = match ib.align {
            Align::Left | Align::Start => 0.0,
            Align::Right | Align::End => width - w,
            _ => (width - w) / 2.0,
        };
        let x = if self.opts.default_rtl && ib.align == Align::Start {
            width - w
        } else {
            x
        };
        vec![
            LBox {
                h,
                kind: Kind::Image {
                    x,
                    w,
                    image: ib.image,
                    tag: Tag::Elem(elem),
                },
                keep_with_next: false,
                gap_before: 4.0,
                break_before: false,
            },
            LBox::space(6.0),
        ]
    }

    fn table(&mut self, t: &Table, width: f64, parent: usize, depth: usize) -> Result<Vec<LBox>> {
        let table_id = self.tables;
        self.tables += 1;
        let elem = self.elem("Table", parent);
        // Grid placement with row/col spans.
        let mut occupied: Vec<Vec<bool>> = Vec::new();
        let mut placed: Vec<(usize, usize, usize, usize, &crate::model::Cell)> = Vec::new();
        let mut ncols = 0usize;
        let mut cells = 0usize;
        for (r, row) in t.rows.iter().enumerate() {
            if occupied.len() <= r {
                occupied.resize(r + 1, Vec::new());
            }
            let mut c = 0usize;
            for cell in &row.cells {
                cells += 1;
                limits::check(cells, limits::MAX_CELLS, "table cells")?;
                while occupied
                    .get(r)
                    .and_then(|o| o.get(c))
                    .copied()
                    .unwrap_or(false)
                {
                    c += 1;
                }
                let cs = usize::from(cell.colspan.max(1));
                let rs = usize::from(cell.rowspan.max(1)).min(t.rows.len() - r);
                if c + cs > limits::MAX_COLUMNS {
                    break;
                }
                for rr in r..r + rs {
                    if occupied.len() <= rr {
                        occupied.resize(rr + 1, Vec::new());
                    }
                    if let Some(o) = occupied.get_mut(rr) {
                        if o.len() < c + cs {
                            o.resize(c + cs, false);
                        }
                        for cc in c..c + cs {
                            if let Some(x) = o.get_mut(cc) {
                                *x = true;
                            }
                        }
                    }
                }
                placed.push((r, c, cs, rs, cell));
                ncols = ncols.max(c + cs);
                c += cs;
            }
        }
        if ncols == 0 {
            return Ok(Vec::new());
        }
        let rtl = match t.dir {
            Dir::Rtl => true,
            Dir::Ltr => false,
            Dir::Auto => {
                let mut txt = String::new();
                for (_, _, _, _, cell) in placed.iter().take(50) {
                    for b in &cell.blocks {
                        if let Block::Paragraph(p) = b {
                            txt.push_str(&p.text());
                            txt.push(' ');
                        }
                    }
                }
                text::base_rtl(Dir::Auto, &txt, self.opts.default_rtl)
            }
        };
        let widths = self.column_widths(t, &placed, ncols, width)?;
        let col_left = |c: usize, span: usize| -> (f64, f64) {
            let before: f64 = widths.iter().take(c).sum();
            let w: f64 = widths.iter().skip(c).take(span).sum();
            if rtl {
                (width - before - w, w)
            } else {
                (before, w)
            }
        };
        // Compose cells row by row.
        let nrows = t.rows.len();
        let mut rows: Vec<Row> = (0..nrows)
            .map(|r| Row {
                table: table_id,
                header: t.rows.get(r).is_some_and(|x| x.header),
                borders: t.borders,
                cells: Vec::new(),
            })
            .collect();
        let mut heights = vec![0.0f64; nrows];
        let mut spans: Vec<(usize, usize, usize, f64)> = Vec::new(); // (row, rs, cell idx, need)
        let mut tr_elems: Vec<usize> = Vec::with_capacity(nrows);
        for _ in 0..nrows {
            tr_elems.push(self.elem("TR", elem));
        }
        for (r, c, cs, rs, cell) in placed {
            let (x, w) = col_left(c, cs);
            let header = t.rows.get(r).is_some_and(|x| x.header);
            let tr = tr_elems.get(r).copied().unwrap_or(elem);
            let td = self.elem(if header { "TH" } else { "TD" }, tr);
            let inner = (w - 2.0 * CELL_PAD).max(8.0);
            let saved = std::mem::take(&mut self.lists);
            let mut content = self.blocks(&cell.blocks, inner, td, depth + 1)?;
            self.lists = saved;
            // Trailing spacing inside a cell is padding enough.
            while content
                .last()
                .is_some_and(|b| matches!(b.kind, Kind::Space))
            {
                content.pop();
            }
            let need: f64 =
                content.iter().map(|b| b.h + b.gap_before).sum::<f64>() + 2.0 * CELL_PAD;
            let idx = rows.get(r).map_or(0, |row| row.cells.len());
            if let Some(row) = rows.get_mut(r) {
                row.cells.push(RowCell {
                    x,
                    w,
                    content,
                    fill: cell.fill,
                    h: 0.0,
                });
            }
            if rs == 1 {
                if let Some(h) = heights.get_mut(r) {
                    *h = h.max(need);
                }
            } else {
                spans.push((r, rs, idx, need));
            }
        }
        for h in &mut heights {
            *h = h.max(2.0 * CELL_PAD + 8.0);
        }
        for &(r, rs, _, need) in &spans {
            let have: f64 = heights.iter().skip(r).take(rs).sum();
            if need > have {
                if let Some(h) = heights.get_mut(r + rs - 1) {
                    *h += need - have;
                }
            }
        }
        // Cell heights (spans cover several rows).
        for (r, row) in rows.iter_mut().enumerate() {
            let rh = heights.get(r).copied().unwrap_or(0.0);
            for (i, cell) in row.cells.iter_mut().enumerate() {
                cell.h = spans
                    .iter()
                    .find(|s| s.0 == r && s.2 == i)
                    .map_or(rh, |s| heights.iter().skip(r).take(s.1).sum());
            }
        }
        let mut out = Vec::new();
        for (r, row) in rows.into_iter().enumerate() {
            let h = heights.get(r).copied().unwrap_or(0.0);
            for part in split_row(row, h, self.max_h) {
                out.push(part);
            }
        }
        if let Some(first) = out.first_mut() {
            first.gap_before = 4.0;
        }
        // Keep header rows with the first body row.
        let headers = t.rows.iter().take_while(|r| r.header).count();
        for b in out.iter_mut().take(headers) {
            b.keep_with_next = true;
        }
        out.push(LBox::space(8.0));
        Ok(out)
    }

    fn column_widths(
        &self,
        t: &Table,
        placed: &[(usize, usize, usize, usize, &crate::model::Cell)],
        ncols: usize,
        width: f64,
    ) -> Result<Vec<f64>> {
        if let Some(cw) = &t.col_widths {
            let cw: Vec<f64> = cw
                .iter()
                .map(|w| if w.is_finite() { w.max(0.0) } else { 0.0 })
                .collect();
            let sum: f64 = cw.iter().take(ncols).sum();
            if cw.len() >= ncols && sum > 0.0 {
                let mut out: Vec<f64> = cw.iter().take(ncols).map(|w| w / sum * width).collect();
                let min = (width / ncols as f64).min(12.0);
                for w in &mut out {
                    *w = w.max(min);
                }
                let s: f64 = out.iter().sum();
                return Ok(out.into_iter().map(|w| w / s * width).collect());
            }
        }
        let mut min = vec![2.0 * CELL_PAD + 6.0; ncols];
        let mut max = vec![2.0 * CELL_PAD + 6.0; ncols];
        for (_, c, cs, _, cell) in placed {
            if *cs != 1 {
                continue;
            }
            let (mut mx, mut mn) = (0.0f64, 0.0f64);
            for b in &cell.blocks {
                match b {
                    Block::Paragraph(p) => {
                        let sp = shape_paragraph(p, self.opts.default_rtl)?;
                        let (w, widest) = text::measure(&sp);
                        mx = mx.max(w);
                        mn = mn.max(widest);
                    }
                    Block::Image(i) => {
                        mx = mx.max(i.width);
                        mn = mn.max(i.width.min(60.0));
                    }
                    Block::Table(_) => {
                        mx = mx.max(width / ncols as f64);
                        mn = mn.max(40.0);
                    }
                    Block::PageBreak => {}
                }
            }
            if let Some(m) = max.get_mut(*c) {
                *m = m.max(mx + 2.0 * CELL_PAD + 1.0);
            }
            if let Some(m) = min.get_mut(*c) {
                *m = m.max(mn + 2.0 * CELL_PAD + 1.0);
            }
        }
        let smax: f64 = max.iter().sum();
        let smin: f64 = min.iter().sum();
        let out: Vec<f64> = if smax <= width {
            max.iter().map(|m| m + (width - smax) * m / smax).collect()
        } else if smin <= width {
            let span = (smax - smin).max(1e-6);
            min.iter()
                .zip(&max)
                .map(|(a, b)| a + (width - smin) * (b - a) / span)
                .collect()
        } else {
            min.iter().map(|m| m * width / smin).collect()
        };
        Ok(out)
    }
}

/// Split a row taller than `max_h` into continuation rows (cell contents cut between boxes).
fn split_row(row: Row, h: f64, max_h: f64) -> Vec<LBox> {
    let limit = (max_h - 2.0 * CELL_PAD).max(20.0);
    if h <= max_h {
        return vec![LBox {
            h,
            kind: Kind::Row(row),
            keep_with_next: false,
            gap_before: 0.0,
            break_before: false,
        }];
    }
    let mut queues: Vec<std::collections::VecDeque<LBox>> = row
        .cells
        .iter()
        .map(|c| c.content.iter().cloned().collect())
        .collect();
    let mut out = Vec::new();
    let mut guard = 0;
    while queues.iter().any(|q| !q.is_empty()) && guard < 10_000 {
        guard += 1;
        let mut cells = Vec::new();
        let mut part_h: f64 = 0.0;
        for (cell, q) in row.cells.iter().zip(queues.iter_mut()) {
            let mut used = 0.0;
            let mut content = Vec::new();
            while let Some(b) = q.front() {
                let bh = b.h + b.gap_before;
                if used + bh > limit && !content.is_empty() {
                    break;
                }
                used += bh;
                if let Some(b) = q.pop_front() {
                    content.push(b);
                }
            }
            part_h = part_h.max(used + 2.0 * CELL_PAD);
            cells.push(RowCell {
                x: cell.x,
                w: cell.w,
                content,
                fill: cell.fill,
                h: 0.0,
            });
        }
        for c in &mut cells {
            c.h = part_h;
        }
        out.push(LBox {
            h: part_h,
            kind: Kind::Row(Row {
                table: row.table,
                header: row.header,
                borders: row.borders,
                cells,
            }),
            keep_with_next: false,
            gap_before: 0.0,
            break_before: false,
        });
    }
    out
}

fn empty_line(style: &Style) -> Result<Line> {
    let fid = crate::fonts::FontId::for_family(style.family, style.bold);
    let f = crate::fonts::font(fid)?;
    let s = f.scale(style.size.clamp(1.0, 400.0));
    Ok(Line {
        pieces: Vec::new(),
        width: 0.0,
        ascent: f.ascender * s,
        descent: -f.descender * s + f.line_gap * s,
        last: true,
    })
}

const ARABIC_LETTERS: [char; 28] = [
    'أ', 'ب', 'ت', 'ث', 'ج', 'ح', 'خ', 'د', 'ذ', 'ر', 'ز', 'س', 'ش', 'ص', 'ض', 'ط', 'ظ', 'ع', 'غ',
    'ف', 'ق', 'ك', 'ل', 'م', 'ن', 'ه', 'و', 'ي',
];

fn roman(mut n: u32) -> String {
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
    let mut s = String::new();
    for (v, r) in table {
        while n >= v && s.len() < 40 {
            s.push_str(r);
            n -= v;
        }
    }
    s
}

fn letters(n: u32, alphabet: &[char]) -> String {
    let len = alphabet.len() as u32;
    if n == 0 || len == 0 {
        return String::new();
    }
    let idx = ((n - 1) % len) as usize;
    let reps = ((n - 1) / len + 1).min(5) as usize;
    alphabet
        .get(idx)
        .map(|c| c.to_string().repeat(reps))
        .unwrap_or_default()
}

/// Western digits → Arabic-Indic digits.
pub fn arabic_indic(s: &str) -> String {
    s.chars()
        .map(|c| match c.to_digit(10) {
            Some(d) => char::from_u32(0x0660 + d).unwrap_or(c),
            None => c,
        })
        .collect()
}

/// The label of a list item ("•", "3.", "٣.", "ج.", "iv.").
pub fn list_label(li: &ListInfo, rtl: bool) -> String {
    if !li.ordered {
        return match li.level % 3 {
            1 => "◦".into(),
            2 => "▪".into(),
            _ => "•".into(),
        };
    }
    let n = li.number.min(1_000_000);
    let body = match li.style {
        NumberStyle::Auto if rtl => arabic_indic(&n.to_string()),
        NumberStyle::Auto | NumberStyle::Decimal => n.to_string(),
        NumberStyle::ArabicIndic => arabic_indic(&n.to_string()),
        NumberStyle::LowerLetter => letters(n, &('a'..='z').collect::<Vec<_>>()),
        NumberStyle::UpperLetter => letters(n, &('A'..='Z').collect::<Vec<_>>()),
        NumberStyle::LowerRoman => roman(n),
        NumberStyle::UpperRoman => roman(n).to_uppercase(),
        NumberStyle::ArabicLetter => letters(n, &ARABIC_LETTERS),
    };
    format!("{body}.")
}

fn label_line(li: &ListInfo, rtl: bool, style: &Style) -> Result<Line> {
    let mut st = style.clone();
    st.underline = false;
    st.italic = false;
    let p = Paragraph {
        runs: vec![Run::new(list_label(li, rtl), st)],
        style: ParaStyle {
            dir: if rtl { Dir::Rtl } else { Dir::Ltr },
            ..ParaStyle::default()
        },
    };
    let shaped = shape_paragraph(&p, rtl)?;
    let pieces = break_lines(&shaped, 10_000.0)?
        .into_iter()
        .flat_map(|(l, _)| l)
        .collect();
    place_line(pieces, rtl, 10_000.0, false)
}

/// Places boxes on pages.
struct Placer<'a> {
    pages: Vec<Page>,
    setup: PageSetup,
    y: f64,
    fresh: bool,
    /// Header rows of the table being placed (repeated after page breaks).
    headers: Vec<LBox>,
    header_table: Option<usize>,
    doc: &'a Document,
}

impl Placer<'_> {
    fn new_page(&mut self) -> Result<()> {
        limits::check(self.pages.len() + 1, limits::MAX_PAGES, "pages")?;
        self.pages.push(Page {
            width: self.setup.width,
            height: self.setup.height,
            items: Vec::new(),
        });
        self.y = self.setup.margin_top;
        self.fresh = true;
        Ok(())
    }

    fn bottom(&self) -> f64 {
        self.setup.height - self.setup.margin_bottom
    }

    fn page(&mut self) -> Option<&mut Page> {
        self.pages.last_mut()
    }

    fn place_all(&mut self, boxes: &[LBox]) -> Result<()> {
        let x0 = self.setup.margin_left;
        let content_h = self.setup.content_height();
        for (i, b) in boxes.iter().enumerate() {
            if b.break_before && !self.fresh {
                self.new_page()?;
            }
            // Track header rows for repetition.
            if let Kind::Row(row) = &b.kind {
                if row.header {
                    if self.header_table != Some(row.table) {
                        self.headers.clear();
                        self.header_table = Some(row.table);
                    }
                    self.headers.push(b.clone());
                } else if self.header_table != Some(row.table) {
                    self.headers.clear();
                    self.header_table = None;
                }
            } else if !matches!(b.kind, Kind::Space) {
                self.headers.clear();
                self.header_table = None;
            }
            let gap = if self.fresh { 0.0 } else { b.gap_before };
            // Height of the keep-together chain starting here.
            let mut chain = b.h + gap;
            let mut j = i;
            while boxes.get(j).is_some_and(|x| x.keep_with_next) && j < i + 8 {
                j += 1;
                if let Some(n) = boxes.get(j) {
                    chain += n.h + n.gap_before;
                }
            }
            let fits = self.y + chain <= self.bottom() + 0.01;
            let fits_alone = self.y + gap + b.h <= self.bottom() + 0.01;
            if (!fits && chain <= content_h && !self.fresh) || (!fits_alone && !self.fresh) {
                if matches!(b.kind, Kind::Space) {
                    // Spacing at a page end is dropped.
                    continue;
                }
                self.new_page()?;
                if let Kind::Row(row) = &b.kind {
                    if !row.header && self.header_table == Some(row.table) {
                        let hs = self.headers.clone();
                        for h in &hs {
                            self.emit(h, x0, true)?;
                        }
                    }
                }
            } else {
                self.y += gap;
            }
            if matches!(b.kind, Kind::Space) && self.fresh {
                continue;
            }
            self.emit(b, x0, false)?;
        }
        Ok(())
    }

    /// Draw one box at the cursor and advance it.
    fn emit(&mut self, b: &LBox, x0: f64, artifact: bool) -> Result<()> {
        let top = self.y;
        let height = self.setup.height;
        let mut items = Vec::new();
        draw_box(b, x0, top, height, artifact, &mut items, 0);
        if let Some(p) = self.page() {
            p.items.extend(items);
        }
        self.y = top + b.h;
        if !matches!(b.kind, Kind::Space) {
            self.fresh = false;
        }
        let _ = self.doc;
        Ok(())
    }
}

/// Draw a box whose top-left is `(x0, top)` (top measured from the page top).
fn draw_box(
    b: &LBox,
    x0: f64,
    top: f64,
    page_h: f64,
    artifact: bool,
    out: &mut Vec<Item>,
    depth: usize,
) {
    let tag_of = |t: Tag| if artifact { Tag::Artifact } else { t };
    match &b.kind {
        Kind::Space => {}
        Kind::Line {
            line,
            x,
            tag,
            label,
            background,
        } => {
            let baseline = page_h - (top + line.ascent);
            if let Some((bx, bw, c)) = background {
                out.push(Item::Rect {
                    x: x0 + bx - 2.0,
                    y: page_h - top - b.h,
                    w: bw + 4.0,
                    h: b.h,
                    color: *c,
                });
            }
            if let Some((lx, l, lt)) = label {
                for (px, p) in &l.pieces {
                    out.push(Item::Text {
                        x: x0 + lx + px,
                        y: baseline,
                        piece: p.clone(),
                        tag: tag_of(*lt),
                    });
                }
            }
            for (px, p) in &line.pieces {
                let x = x0 + x + px;
                if p.underline && !p.space {
                    let w = (p.size / 18.0).max(0.4);
                    out.push(Item::Rule {
                        x1: x,
                        y1: baseline - p.size * 0.12,
                        x2: x + p.width + p.extra,
                        y2: baseline - p.size * 0.12,
                        width: w,
                        color: p.color,
                    });
                }
                out.push(Item::Text {
                    x,
                    y: baseline,
                    piece: p.clone(),
                    tag: tag_of(*tag),
                });
            }
        }
        Kind::Image { x, w, image, tag } => out.push(Item::Image {
            x: x0 + x,
            y: page_h - top - b.h,
            w: *w,
            h: b.h,
            image: *image,
            tag: tag_of(*tag),
        }),
        Kind::Row(row) => {
            if depth > limits::MAX_NESTING {
                return;
            }
            for c in &row.cells {
                let cx = x0 + c.x;
                let y_bottom = page_h - top - c.h;
                if let Some(fill) = c.fill.or(if row.header {
                    Some(Color {
                        r: 0xF0,
                        g: 0xF0,
                        b: 0xF0,
                    })
                } else {
                    None
                }) {
                    out.push(Item::Rect {
                        x: cx,
                        y: y_bottom,
                        w: c.w,
                        h: c.h,
                        color: fill,
                    });
                }
                if row.borders {
                    let yt = page_h - top;
                    for (x1, y1, x2, y2) in [
                        (cx, yt, cx + c.w, yt),
                        (cx, y_bottom, cx + c.w, y_bottom),
                        (cx, yt, cx, y_bottom),
                        (cx + c.w, yt, cx + c.w, y_bottom),
                    ] {
                        out.push(Item::Rule {
                            x1,
                            y1,
                            x2,
                            y2,
                            width: 0.5,
                            color: BORDER,
                        });
                    }
                }
                let mut y = top + CELL_PAD;
                for inner in &c.content {
                    y += inner.gap_before;
                    draw_box(inner, cx + CELL_PAD, y, page_h, artifact, out, depth + 1);
                    y += inner.h;
                }
            }
        }
    }
}

/// Lay out a whole document.
pub fn layout(doc: &Document, opts: &Options) -> Result<Layout> {
    let mut comp = Composer {
        doc,
        opts,
        elems: vec![Elem {
            role: "Document",
            parent: 0,
            kids: Vec::new(),
            alt: None,
            lang: doc.lang.clone(),
        }],
        tables: 0,
        lists: Vec::new(),
        max_h: 700.0,
        blocks: 0,
    };
    let mut pages: Vec<Page> = Vec::new();
    for section in &doc.sections {
        match &section.content {
            Content::Flow(blocks) => {
                let setup = sane_setup(section.page);
                comp.max_h = setup.content_height();
                let boxes = comp.blocks(blocks, setup.content_width(), 0, 0)?;
                let mut placer = Placer {
                    pages: Vec::new(),
                    setup,
                    y: 0.0,
                    fresh: true,
                    headers: Vec::new(),
                    header_table: None,
                    doc: comp.doc,
                };
                placer.new_page()?;
                placer.place_all(&boxes)?;
                pages.append(&mut placer.pages);
            }
            Content::Fixed(fixed) => {
                for fp in fixed {
                    limits::check(pages.len() + 1, limits::MAX_PAGES, "pages")?;
                    pages.push(fixed_page(&mut comp, fp)?);
                }
            }
        }
        limits::check(pages.len(), limits::MAX_PAGES, "pages")?;
    }
    if pages.is_empty() {
        let s = PageSetup::default();
        pages.push(Page {
            width: s.width,
            height: s.height,
            items: Vec::new(),
        });
    }
    if opts.page_numbers {
        add_page_numbers(&mut pages, opts)?;
    }
    Ok(Layout {
        pages,
        elems: comp.elems,
    })
}

fn sane_setup(mut s: PageSetup) -> PageSetup {
    let fix = |v: f64, d: f64, lo: f64, hi: f64| if v.is_finite() { v.clamp(lo, hi) } else { d };
    s.width = fix(s.width, 595.0, 72.0, 14_400.0);
    s.height = fix(s.height, 842.0, 72.0, 14_400.0);
    let mw = s.width / 3.0;
    let mh = s.height / 3.0;
    s.margin_left = fix(s.margin_left, 72.0, 0.0, mw);
    s.margin_right = fix(s.margin_right, 72.0, 0.0, mw);
    s.margin_top = fix(s.margin_top, 72.0, 0.0, mh);
    s.margin_bottom = fix(s.margin_bottom, 72.0, 0.0, mh);
    s
}

fn fixed_page(comp: &mut Composer, fp: &FixedPage) -> Result<Page> {
    let fix = |v: f64, d: f64| {
        if v.is_finite() {
            v.clamp(3.0, 14_400.0)
        } else {
            d
        }
    };
    let (pw, ph) = (fix(fp.width, 595.0), fix(fp.height, 842.0));
    let mut page = Page {
        width: pw,
        height: ph,
        items: Vec::new(),
    };
    if let Some(bg) = fp.background {
        page.items.push(Item::Rect {
            x: 0.0,
            y: 0.0,
            w: pw,
            h: ph,
            color: bg,
        });
    }
    comp.max_h = ph;
    for fr in &fp.frames {
        let ok = |v: f64| v.is_finite();
        if !(ok(fr.x) && ok(fr.y) && ok(fr.width) && ok(fr.height)) {
            continue;
        }
        match &fr.content {
            FrameContent::Image { image, alt } => {
                let alt = if alt.trim().is_empty() {
                    "image".to_string()
                } else {
                    alt.clone()
                };
                let e = comp.elem_with("Figure", 0, Some(alt), None);
                page.items.push(Item::Image {
                    x: fr.x,
                    y: ph - fr.y - fr.height,
                    w: fr.width.max(0.1),
                    h: fr.height.max(0.1),
                    image: *image,
                    tag: Tag::Elem(e),
                });
            }
            FrameContent::Blocks(blocks) => {
                let boxes = comp.blocks(blocks, fr.width.max(12.0), 0, 0)?;
                let mut y = fr.y;
                for b in &boxes {
                    y += b.gap_before;
                    draw_box(b, fr.x, y, ph, false, &mut page.items, 0);
                    y += b.h;
                }
            }
        }
    }
    Ok(page)
}

fn add_page_numbers(pages: &mut [Page], opts: &Options) -> Result<()> {
    let total = pages.len();
    for (i, page) in pages.iter_mut().enumerate() {
        let (text, rtl) = if opts.arabic_numbers {
            (
                format!(
                    "صفحة {} من {}",
                    arabic_indic(&(i + 1).to_string()),
                    arabic_indic(&total.to_string())
                ),
                true,
            )
        } else {
            (format!("Page {} of {}", i + 1, total), false)
        };
        let style = Style {
            size: 9.0,
            color: Color {
                r: 0x55,
                g: 0x55,
                b: 0x55,
            },
            lang: Some(if rtl { "ar".into() } else { "en".into() }),
            ..Style::default()
        };
        let p = Paragraph {
            runs: vec![Run::new(text, style)],
            style: ParaStyle {
                dir: if rtl { Dir::Rtl } else { Dir::Ltr },
                ..ParaStyle::default()
            },
        };
        let shaped = shape_paragraph(&p, rtl)?;
        let pieces = break_lines(&shaped, 10_000.0)?
            .into_iter()
            .flat_map(|(l, _)| l)
            .collect();
        let line = place_line(pieces, rtl, 10_000.0, false)?;
        let x = (page.width - line.width) / 2.0;
        let y = 28.0f64.min(page.height / 10.0);
        for (px, piece) in line.pieces {
            page.items.push(Item::Text {
                x: x + px,
                y,
                piece,
                tag: Tag::Artifact,
            });
        }
    }
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;
    use crate::model::{Cell, Row as MRow, Section};

    fn body(text: &str) -> Block {
        Block::Paragraph(Paragraph::plain(text, Style::default()))
    }

    fn doc(blocks: Vec<Block>) -> Document {
        Document {
            sections: vec![Section {
                page: PageSetup::default(),
                content: Content::Flow(blocks),
                page_from_source: false,
            }],
            ..Document::default()
        }
    }

    fn texts(page: &Page) -> Vec<String> {
        page.items
            .iter()
            .filter_map(|i| match i {
                Item::Text { piece, .. } if !piece.space => Some(piece.text.clone()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn labels() {
        let li = |ordered, number, style| ListInfo {
            ordered,
            level: 0,
            number,
            style,
        };
        assert_eq!(list_label(&li(true, 3, NumberStyle::Auto), false), "3.");
        assert_eq!(list_label(&li(true, 12, NumberStyle::Auto), true), "١٢.");
        assert_eq!(
            list_label(&li(true, 3, NumberStyle::ArabicLetter), true),
            "ت."
        );
        assert_eq!(
            list_label(&li(true, 4, NumberStyle::UpperRoman), false),
            "IV."
        );
        assert_eq!(
            list_label(&li(true, 28, NumberStyle::LowerLetter), false),
            "bb."
        );
        assert_eq!(list_label(&li(false, 1, NumberStyle::Auto), false), "•");
    }

    #[test]
    fn paragraphs_paginate_with_widow_orphan_control() {
        let long = "word ".repeat(400);
        let blocks: Vec<Block> = (0..6).map(|_| body(&long)).collect();
        let l = layout(&doc(blocks), &Options::default()).unwrap();
        assert!(l.pages.len() >= 3, "{} pages", l.pages.len());
        // Every page's text stays inside the margins.
        for p in &l.pages {
            for it in &p.items {
                if let Item::Text { y, .. } = it {
                    assert!(*y >= 72.0 - 1.0 && *y <= p.height - 72.0, "y={y}");
                }
            }
        }
        // No page starts or ends with a single line of a multi-line paragraph: count baselines.
        let lines_on = |p: &Page| {
            let mut ys: Vec<i64> = p
                .items
                .iter()
                .filter_map(|i| match i {
                    Item::Text { y, .. } => Some(*y as i64),
                    _ => None,
                })
                .collect();
            ys.dedup();
            ys.len()
        };
        for p in &l.pages {
            assert!(lines_on(p) >= 2);
        }
    }

    #[test]
    fn heading_is_kept_with_next_paragraph() {
        let filler = "filler text ".repeat(250);
        let mut h = Paragraph::plain(
            "Heading",
            Style {
                size: 20.0,
                bold: true,
                ..Style::default()
            },
        );
        h.style.heading = 1;
        // Fill most of the page, then a heading, then a paragraph.
        let blocks = vec![
            body(&filler),
            body(&filler),
            Block::Paragraph(h),
            body(&"after ".repeat(80)),
        ];
        let l = layout(&doc(blocks), &Options::default()).unwrap();
        let page_of = |needle: &str| {
            l.pages
                .iter()
                .position(|p| texts(p).iter().any(|t| t == needle))
                .unwrap()
        };
        assert_eq!(page_of("Heading"), page_of("after"));
        assert!(l.elems.iter().any(|e| e.role == "H1"));
    }

    #[test]
    fn rtl_table_mirrors_columns_and_repeats_header() {
        let cell = |t: &str| Cell {
            blocks: vec![body(t)],
            ..Cell::default()
        };
        let mut rows = vec![MRow {
            cells: vec![cell("الاسم"), cell("المدينة")],
            header: true,
        }];
        for i in 0..120 {
            rows.push(MRow {
                cells: vec![cell(&format!("سطر{i}")), cell("الرياض")],
                header: false,
            });
        }
        let t = Table {
            rows,
            col_widths: None,
            dir: Dir::Rtl,
            borders: true,
        };
        let l = layout(&doc(vec![Block::Table(t)]), &Options::default()).unwrap();
        assert!(l.pages.len() >= 2);
        // Header text appears on every page (repeated as artifact on later pages).
        for p in &l.pages {
            assert!(texts(p).iter().any(|t| t == "الاسم"), "header on every page");
        }
        // Column 0 is on the right in an RTL table.
        let x_of = |needle: &str| {
            l.pages[0]
                .items
                .iter()
                .find_map(|i| match i {
                    Item::Text { x, piece, .. } if piece.text == needle => Some(*x),
                    _ => None,
                })
                .unwrap()
        };
        assert!(x_of("الاسم") > x_of("المدينة"));
        let roles: Vec<&str> = l.elems.iter().map(|e| e.role).collect();
        for r in ["Table", "TR", "TH", "TD", "P"] {
            assert!(roles.contains(&r), "{r}");
        }
        // Repeated headers are artifacts.
        let later_header = l.pages[1].items.iter().find_map(|i| match i {
            Item::Text { piece, tag, .. } if piece.text == "الاسم" => Some(*tag),
            _ => None,
        });
        assert_eq!(later_header, Some(Tag::Artifact));
    }

    #[test]
    fn lists_get_structure_and_arabic_numbers() {
        let item = |t: &str, n| {
            let mut p = Paragraph::plain(t, Style::default());
            p.style.list = Some(ListInfo {
                ordered: true,
                level: 0,
                number: n,
                style: NumberStyle::Auto,
            });
            Block::Paragraph(p)
        };
        let l = layout(
            &doc(vec![item("البند الأول", 1), item("البند الثاني", 2)]),
            &Options::default(),
        )
        .unwrap();
        let t = texts(&l.pages[0]);
        assert!(
            t.iter().any(|x| x == "١") && t.iter().any(|x| x == "٢"),
            "{t:?}"
        );
        let roles: Vec<&str> = l.elems.iter().map(|e| e.role).collect();
        assert_eq!(roles.iter().filter(|r| **r == "L").count(), 1);
        assert_eq!(roles.iter().filter(|r| **r == "LI").count(), 2);
    }

    #[test]
    fn page_numbers_in_arabic() {
        let opts = Options {
            page_numbers: true,
            arabic_numbers: true,
            default_rtl: true,
        };
        let l = layout(&doc(vec![body("نص"), Block::PageBreak, body("نص")]), &opts).unwrap();
        assert_eq!(l.pages.len(), 2);
        let t = texts(&l.pages[1]);
        assert!(t.iter().any(|x| x == "٢"), "{t:?}");
    }
}
