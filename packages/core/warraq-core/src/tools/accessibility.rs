//! Accessibility: the reading order a screen reader follows, tagged into the
//! file (`warraq_pdf::standards::tagging`), and a checker for what PDF/UA-1
//! and WCAG ask of a file (`warraq_pdf::standards::access`).
//!
//! `plan` proposes each page's blocks in reading order. For a tagged file it
//! is the file's own structure, placed on the page where its content is
//! drawn; otherwise it is built from Warraq's reading: paragraphs, headings
//! by their size, list items by their markers, tables by the columns their
//! lines share, pictures as figures, and running heads and page numbers as
//! artifacts. The interface shows it, lets the person reorder and relabel
//! it, and sends it back to `tag`, which writes it as an update of the file.
use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};
use serde_json::json;
use warraq_pdf::standards::scan::ScanOptions;
use warraq_pdf::standards::tagging::{self, script_of, Block, Leaf, Script, TagPlan};
use warraq_pdf::Matrix;
use warraq_text::{detect_paragraphs, TextLine};

use super::{args, Reply};
use crate::{CoreError, Document};

/// A block as the interface sees it: `tagging::Block` with its text.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BlockJson {
    pub role: String,
    pub rect: [f32; 4],
    #[serde(default)]
    pub lang: Option<String>,
    #[serde(default)]
    pub alt: Option<String>,
    #[serde(default)]
    pub list: Option<u32>,
    #[serde(default)]
    pub cells: Vec<Vec<[f32; 4]>>,
    #[serde(default)]
    pub pagination: bool,
    /// What it says, for the list; not written anywhere.
    #[serde(default)]
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageJson {
    pub width: f32,
    pub height: f32,
    pub blocks: Vec<BlockJson>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanJson {
    pub lang: String,
    #[serde(default)]
    pub title: Option<String>,
    pub pages: Vec<PageJson>,
}

impl From<&BlockJson> for Block {
    fn from(b: &BlockJson) -> Self {
        Block {
            role: if tagging::ROLES.contains(&b.role.as_str()) {
                b.role.clone()
            } else {
                "P".into()
            },
            rect: b.rect,
            lang: b.lang.clone(),
            alt: b.alt.clone(),
            list: b.list,
            cells: b.cells.clone(),
            pagination: b.pagination,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Open {
    #[serde(default)]
    password: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Tag {
    #[serde(default)]
    password: Option<String>,
    plan: PlanJson,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fix {
    #[serde(default)]
    password: Option<String>,
    fixes: Vec<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    lang: Option<String>,
}

#[derive(Deserialize)]
struct Alt {
    id: String,
    alt: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Alts {
    #[serde(default)]
    password: Option<String>,
    alts: Vec<Alt>,
}

/// A table read from a tree: its page, its block, and its cells' boxes by
/// row and column.
type TableCells = (usize, usize, BTreeMap<(usize, usize), [f32; 4]>);

/// Pages beyond which a document wants bookmarks.
const LONG: usize = 20;
/// Pages read to build a plan; past this the rest are left as they are.
const MAX_PAGES: usize = 2000;

fn union(a: Option<[f32; 4]>, b: [f32; 4]) -> [f32; 4] {
    match a {
        None => b,
        Some(a) => [
            a[0].min(b[0]),
            a[1].min(b[1]),
            a[2].max(b[2]),
            a[3].max(b[3]),
        ],
    }
}

fn line_rect(l: &TextLine) -> [f32; 4] {
    [l.x, l.y, l.x + l.width, l.y + l.height]
}

fn transformed(m: Matrix, r: [f32; 4]) -> [f32; 4] {
    let pts = [
        m.apply(r[0], r[1]),
        m.apply(r[2], r[1]),
        m.apply(r[0], r[3]),
        m.apply(r[2], r[3]),
    ];
    let mut out = [f32::MAX, f32::MAX, f32::MIN, f32::MIN];
    for (x, y) in pts {
        out[0] = out[0].min(x);
        out[1] = out[1].min(y);
        out[2] = out[2].max(x);
        out[3] = out[3].max(y);
    }
    out
}

fn centre_in(r: [f32; 4], outer: [f32; 4]) -> bool {
    let (x, y) = ((r[0] + r[2]) / 2.0, (r[1] + r[3]) / 2.0);
    x >= outer[0] - 1.0 && x <= outer[2] + 1.0 && y >= outer[1] - 1.0 && y <= outer[3] + 1.0
}

/// Whether a line starts a list item: a bullet, or a number or letter
/// followed by `.`, `)`, `-` or `،` — Western, Arabic-Indic or Persian
/// digits, Latin or Arabic letters.
pub fn list_marker(text: &str) -> bool {
    let t = text.trim_start();
    let mut chars = t.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if "•◦▪▫●○■□‣⁃–—-*·✓✔➢►".contains(first) {
        return chars.next().is_some_and(char::is_whitespace);
    }
    let body = t.strip_prefix('(').unwrap_or(t);
    let head: String = body
        .chars()
        .take_while(|c| c.is_numeric() || c.is_alphabetic())
        .take(4)
        .collect();
    if head.is_empty() {
        return false;
    }
    let numeric = head.chars().all(char::is_numeric);
    let letter = head.chars().count() == 1 && head.chars().all(char::is_alphabetic);
    if !numeric && !letter {
        return false;
    }
    let rest = &body[head.len()..];
    let mut rest = rest.chars();
    matches!(rest.next(), Some('.' | ')' | '-' | '–' | '،' | ':'))
        && rest.next().is_some_and(char::is_whitespace)
}

/// A block's own language, when nearly all its letters (four in five) are
/// in another script than the document's; a word or a name in another
/// script is a span, which tagging finds by itself.
fn block_lang(text: &str, doc_lang: &str) -> Option<String> {
    let (mut arabic, mut latin) = (0usize, 0usize);
    for c in text.chars().filter(|c| c.is_alphabetic()) {
        match script_of(&c.to_string().repeat(2)) {
            Some(Script::Arabic) => arabic += 1,
            Some(Script::Latin) => latin += 1,
            None => {}
        }
    }
    match doc_lang {
        "ar" if latin >= 4 * arabic.max(1) && latin >= 2 => Some("en".into()),
        "en" if arabic >= 4 * latin.max(1) => Some("ar".into()),
        _ => None,
    }
}

/// Digits, whatever their script, as one sign: running heads that differ
/// only by their page number are the same.
fn without_digits(text: &str) -> String {
    text.chars()
        .map(|c| if c.is_numeric() { '#' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// A page number: nothing but digits and the words round one.
fn page_label(text: &str) -> bool {
    let words: Vec<&str> = text.split_whitespace().collect();
    !words.is_empty()
        && words.len() <= 4
        && text.chars().any(char::is_numeric)
        && words.iter().all(|w| {
            w.chars().all(|c| c.is_numeric() || "-–—/|.()".contains(c))
                || matches!(
                    w.to_lowercase().as_str(),
                    "page" | "of" | "صفحة" | "الصفحة" | "من" | "p."
                )
        })
}

/// Columns a table's lines share: the gaps between each line's characters
/// wider than `min_gap`, kept where most lines have one.
fn columns(rows: &[&TextLine]) -> Vec<(f32, f32)> {
    let mut gaps: Vec<Vec<(f32, f32)>> = vec![];
    for line in rows {
        let mut spans: Vec<(f32, f32)> = line.spans.iter().copied().filter(|s| s.1 > s.0).collect();
        spans.sort_by(|a, b| a.0.total_cmp(&b.0));
        let min_gap = (line.height * 1.2).max(12.0);
        let mut line_gaps = vec![];
        for w in spans.windows(2) {
            if w[1].0 - w[0].1 > min_gap {
                line_gaps.push((w[0].1, w[1].0));
            }
        }
        gaps.push(line_gaps);
    }
    // A boundary is a gap most rows share (their gaps overlap it).
    let mut boundaries: Vec<(f32, f32)> = vec![];
    for g in gaps.iter().flatten() {
        let shared = gaps
            .iter()
            .filter(|row| row.iter().any(|o| o.0 < g.1 && g.0 < o.1))
            .count();
        let overlaps_known = boundaries.iter().any(|b| b.0 < g.1 && g.0 < b.1);
        if shared * 10 >= rows.len() * 6 && !overlaps_known {
            // The part of the gap every sharing row leaves empty.
            let mut span = *g;
            for row in &gaps {
                if let Some(o) = row.iter().find(|o| o.0 < span.1 && span.0 < o.1) {
                    span = (span.0.max(o.0), span.1.min(o.1));
                }
            }
            if span.1 > span.0 {
                boundaries.push(span);
            }
        }
    }
    boundaries.sort_by(|a, b| a.0.total_cmp(&b.0));
    boundaries
}

impl Document {
    /// Each MCID of page `index` placed on the page as shown: text by its
    /// glyphs, pictures and paths by what the content scan saw.
    fn mcid_boxes(
        &self,
        index: usize,
        scan_boxes: &BTreeMap<i64, [f32; 4]>,
    ) -> HashMap<i64, [f32; 4]> {
        let mut out: HashMap<i64, [f32; 4]> = HashMap::new();
        if let (Ok((glyphs, marked)), Some(sequences)) = (
            self.render.marked_glyphs(index),
            self.pdf.marked_content(index),
        ) {
            let paired = sequences.len() == marked.tags.len()
                && sequences.iter().zip(&marked.tags).all(|(s, t)| &s.tag == t);
            if paired {
                for (g, inside) in glyphs.iter().zip(&marked.inside) {
                    let Some(mcid) = inside
                        .iter()
                        .rev()
                        .find_map(|k| sequences.get(*k as usize).and_then(|s| s.mcid))
                    else {
                        continue;
                    };
                    let w = if g.advance > 0.0 {
                        g.advance
                    } else {
                        g.size * 0.5
                    };
                    let r = [g.x, g.y - g.size * 0.8, g.x + w, g.y + g.size * 0.2];
                    let old = out.get(&mcid).copied();
                    out.insert(mcid, union(old, r));
                }
            }
        }
        if let Ok(m) = self.pdf.shown_from_user(index) {
            for (mcid, r) in scan_boxes {
                let r = transformed(m, *r);
                let old = out.get(mcid).copied();
                out.insert(*mcid, union(old, r));
            }
        }
        out
    }

    /// The text drawn inside `rect`: whole lines whose middle is in it, or,
    /// for a narrower box (a table cell), the characters of a line drawn
    /// inside it.
    fn text_in(lines: &[TextLine], rect: [f32; 4]) -> String {
        let mut parts = vec![];
        for l in lines {
            let mid = l.y + l.height / 2.0;
            if mid < rect[1] - 1.0 || mid > rect[3] + 1.0 {
                continue;
            }
            if centre_in(line_rect(l), rect) || l.spans.len() != l.text.chars().count() {
                if centre_in(line_rect(l), rect) {
                    parts.push(l.text.clone());
                }
                continue;
            }
            let chars: String = l
                .text
                .chars()
                .zip(&l.spans)
                .filter(|(_, s)| {
                    let x = (s.0 + s.1) / 2.0;
                    x >= rect[0] - 1.0 && x <= rect[2] + 1.0
                })
                .map(|(c, _)| c)
                .collect();
            let chars = chars.trim().to_string();
            if !chars.is_empty() {
                parts.push(chars);
            }
        }
        parts.join(" ")
    }

    /// The plan: the file's own structure where it can be placed, else one
    /// built from Warraq's reading.
    pub fn accessibility_plan(&self) -> Result<(PlanJson, &'static str), CoreError> {
        if self.pdf.is_tagged() {
            if let Some(plan) = self.plan_from_structure()? {
                return Ok((plan, "structure"));
            }
        }
        Ok((self.plan_from_reading()?, "reading"))
    }

    fn page_lines(&self, pages: usize) -> Result<Vec<Vec<TextLine>>, CoreError> {
        (0..pages).map(|i| self.text_lines(i)).collect()
    }

    fn document_lang(lines: &[Vec<TextLine>]) -> String {
        let (mut arabic, mut latin) = (0usize, 0usize);
        for l in lines.iter().flatten() {
            match script_of(&l.text) {
                Some(Script::Arabic) => arabic += l.text.chars().count(),
                Some(Script::Latin) => latin += l.text.chars().count(),
                None => {}
            }
        }
        if latin > arabic { "en" } else { "ar" }.into()
    }

    fn plan_from_structure(&self) -> Result<Option<PlanJson>, CoreError> {
        let pages = self.page_count().min(MAX_PAGES);
        let leaves = self.pdf.structure_leaves();
        if leaves.is_empty() {
            return Ok(None);
        }
        let scan = self.pdf.scan_content(ScanOptions::default());
        let lines = self.page_lines(pages)?;
        let mut boxes: Vec<HashMap<i64, [f32; 4]>> = vec![];
        for i in 0..pages {
            let empty = BTreeMap::new();
            let scan_boxes = scan.pages.get(i).map(|p| &p.mcid_boxes).unwrap_or(&empty);
            boxes.push(self.mcid_boxes(i, scan_boxes));
        }
        let mut out: Vec<PageJson> = (0..pages)
            .map(|i| {
                let (width, height) = self.page_size(i).unwrap_or((612.0, 792.0));
                PageJson {
                    width,
                    height,
                    blocks: vec![],
                }
            })
            .collect();
        let (mut placed, mut total) = (0usize, 0usize);
        // Tables: their cells gathered by table, row and column.
        let mut tables: BTreeMap<u32, TableCells> = BTreeMap::new();
        let mut last: Option<(usize, Option<(u32, u16)>)> = None;
        for leaf in &leaves {
            total += 1;
            if leaf.page >= pages {
                continue;
            }
            let Some(rect) = leaf
                .mcids
                .iter()
                .filter_map(|m| boxes[leaf.page].get(m))
                .fold(None, |acc: Option<[f32; 4]>, r| Some(union(acc, *r)))
            else {
                continue;
            };
            placed += 1;
            if let Some((t, r, c)) = leaf.cell {
                let page_blocks = &mut out[leaf.page].blocks;
                let entry = tables.entry(t).or_insert_with(|| {
                    page_blocks.push(BlockJson {
                        role: "Table".into(),
                        rect,
                        lang: None,
                        alt: None,
                        list: None,
                        cells: vec![],
                        pagination: false,
                        text: String::new(),
                    });
                    (leaf.page, page_blocks.len() - 1, BTreeMap::new())
                });
                let old = entry.2.get(&(r, c)).copied();
                entry.2.insert((r, c), union(old, rect));
                continue;
            }
            // A table's own content, outside its cells (its rules), is not a block.
            if matches!(
                leaf.role.as_str(),
                "Table" | "TR" | "THead" | "TBody" | "TFoot"
            ) {
                continue;
            }
            let role = leaf_role(leaf);
            let key = leaf.id;
            // A leaf split around a child element is one block.
            if let Some((page, Some(k))) = last {
                if page == leaf.page && Some(k) == key {
                    if let Some(b) = out[page].blocks.last_mut() {
                        b.rect = union(Some(b.rect), rect);
                        continue;
                    }
                }
            }
            out[leaf.page].blocks.push(BlockJson {
                role,
                rect,
                lang: leaf.lang.clone(),
                alt: leaf.alt.clone(),
                list: leaf.list,
                cells: vec![],
                pagination: false,
                text: String::new(),
            });
            last = Some((leaf.page, key));
        }
        // Too little of the tree could be placed to trust it.
        if placed * 2 < total || placed == 0 {
            return Ok(None);
        }
        for (_, (page, at, cells)) in tables {
            let rows = cells.keys().map(|(r, _)| *r).max().map_or(0, |r| r + 1);
            let mut grid: Vec<Vec<[f32; 4]>> = vec![vec![]; rows];
            let mut rect: Option<[f32; 4]> = None;
            for ((r, _), cell) in &cells {
                grid[*r].push(*cell);
                rect = Some(union(rect, *cell));
            }
            grid.retain(|row| !row.is_empty());
            if let Some(b) = out[page].blocks.get_mut(at) {
                b.cells = grid;
                b.rect = rect.unwrap_or(b.rect);
            }
        }
        for (i, page) in out.iter_mut().enumerate() {
            for b in &mut page.blocks {
                b.text = Self::text_in(&lines[i], b.rect);
            }
        }
        Ok(Some(PlanJson {
            lang: self
                .pdf
                .document_language()
                .unwrap_or_else(|| Self::document_lang(&lines)),
            title: self.pdf.metadata().title.filter(|t| !t.trim().is_empty()),
            pages: out,
        }))
    }

    fn plan_from_reading(&self) -> Result<PlanJson, CoreError> {
        let pages = self.page_count().min(MAX_PAGES);
        let lines = self.page_lines(pages)?;
        let lang = Self::document_lang(&lines);
        let scan = self.pdf.scan_content(ScanOptions::default());

        // Running heads and page numbers: at the top or bottom of the page,
        // the same (but for digits) on more than one page, or a page label.
        let band = |y: f32, h: f32, height: f32| -> Option<bool> {
            let mid = y + h / 2.0;
            if mid < height * 0.08 {
                Some(true)
            } else if mid > height * 0.92 {
                Some(false)
            } else {
                None
            }
        };
        let mut seen: HashMap<(bool, String), usize> = HashMap::new();
        for (i, page) in lines.iter().enumerate() {
            let (_, height) = self.page_size(i)?;
            let mut here = std::collections::HashSet::new();
            for l in page {
                if let Some(top) = band(l.y, l.height, height) {
                    here.insert((top, without_digits(&l.text)));
                }
            }
            for k in here {
                *seen.entry(k).or_default() += 1;
            }
        }

        // Body size: what most of the text is set in.
        let mut sizes: Vec<(f32, usize)> = vec![];
        let mut per_page: Vec<Vec<(warraq_text::Paragraph, bool)>> = vec![];
        let mut pagination: Vec<Vec<usize>> = vec![];
        for (i, page) in lines.iter().enumerate() {
            let (_, height) = self.page_size(i)?;
            let running: Vec<usize> = page
                .iter()
                .enumerate()
                .filter(|(_, l)| {
                    band(l.y, l.height, height).is_some_and(|top| {
                        page_label(&l.text)
                            || seen
                                .get(&(top, without_digits(&l.text)))
                                .is_some_and(|n| *n > 1)
                    })
                })
                .map(|(k, _)| k)
                .collect();
            // Text running up the margin (a disclosure stamp, a watermark
            // along the edge) is not part of what the page says.
            let (width, _) = self.page_size(i)?;
            let stamps: Vec<usize> = page
                .iter()
                .enumerate()
                .filter(|(_, l)| {
                    l.height > l.width * 2.5 && (l.x + l.width < width * 0.12 || l.x > width * 0.88)
                })
                .map(|(k, _)| k)
                .collect();
            let running: Vec<usize> = running.into_iter().chain(stamps.iter().copied()).collect();
            let kept: Vec<TextLine> = page
                .iter()
                .enumerate()
                .filter(|(k, _)| !running.contains(k))
                .map(|(_, l)| l.clone())
                .collect();
            let paragraphs = detect_paragraphs(&kept);
            for p in &paragraphs {
                // Sizes of text set along the page, not up it.
                if p.bbox.2 >= p.bbox.3 {
                    sizes.push((p.font_size, p.text.chars().count()));
                }
            }
            // Map paragraph line indices back to the page's lines.
            let index: Vec<usize> = (0..page.len()).filter(|k| !running.contains(k)).collect();
            per_page.push(
                paragraphs
                    .into_iter()
                    .map(|mut p| {
                        p.lines = p.lines.iter().map(|k| index[*k]).collect();
                        (p, false)
                    })
                    .collect(),
            );
            pagination.push(running);
        }
        sizes.sort_by(|a, b| a.0.total_cmp(&b.0));
        let body = {
            let total: usize = sizes.iter().map(|s| s.1).sum();
            let mut acc = 0;
            sizes
                .iter()
                .find(|s| {
                    acc += s.1;
                    acc * 2 >= total
                })
                .map(|s| s.0)
                .unwrap_or(12.0)
        };
        // Heading levels by size, largest first, at most three.
        let mut heading_sizes: Vec<f32> = sizes
            .iter()
            .filter(|s| s.0 >= body * 1.2)
            .map(|s| (s.0 * 2.0).round() / 2.0)
            .collect();
        heading_sizes.sort_by(|a, b| b.total_cmp(a));
        heading_sizes.dedup();
        heading_sizes.truncate(3);

        let mut out = vec![];
        let mut list_id = 0u32;
        for (i, page) in lines.iter().enumerate() {
            let (width, height) = self.page_size(i)?;
            let mut blocks: Vec<(f32, BlockJson)> = vec![];
            // Tables first: consecutive lines that share columns.
            let mut in_table = vec![false; page.len()];
            let mut k = 0;
            while k < page.len() {
                let mut end = k;
                while end + 1 < page.len()
                    && (page[end + 1].y - page[end].y).abs() < page[end].height * 3.0
                {
                    end += 1;
                }
                let run: Vec<&TextLine> = page[k..=end].iter().collect();
                let cols = if run.len() >= 2 {
                    columns(&run)
                } else {
                    vec![]
                };
                if cols.is_empty() || pagination[i].iter().any(|p| (k..=end).contains(p)) {
                    k = end + 1;
                    continue;
                }
                // Rows: the lines whose gaps meet the columns.
                let left = run.iter().map(|l| l.x).fold(f32::MAX, f32::min);
                let right = run.iter().map(|l| l.x + l.width).fold(f32::MIN, f32::max);
                let mut edges = vec![left];
                for c in &cols {
                    edges.push((c.0 + c.1) / 2.0);
                }
                edges.push(right);
                let rtl = run
                    .iter()
                    .filter(|l| l.direction == warraq_text::Direction::Rtl)
                    .count()
                    * 2
                    > run.len();
                let mut cells = vec![];
                let mut rect: Option<[f32; 4]> = None;
                for l in &run {
                    let mut row: Vec<[f32; 4]> = edges
                        .windows(2)
                        .map(|e| [e[0], l.y, e[1], l.y + l.height])
                        .collect();
                    if rtl {
                        row.reverse();
                    }
                    rect = Some(union(rect, line_rect(l)));
                    cells.push(row);
                }
                for t in in_table.iter_mut().take(end + 1).skip(k) {
                    *t = true;
                }
                let rect = rect.unwrap_or([0.0; 4]);
                blocks.push((
                    rect[1],
                    BlockJson {
                        role: "Table".into(),
                        rect,
                        lang: None,
                        alt: None,
                        list: None,
                        cells,
                        pagination: false,
                        text: run
                            .iter()
                            .map(|l| l.text.as_str())
                            .collect::<Vec<_>>()
                            .join(" "),
                    },
                ));
                k = end + 1;
            }
            // Paragraphs, headings and list items, in reading order.
            let mut previous_list = false;
            for (p, _) in &per_page[i] {
                let own: Vec<usize> = p.lines.iter().copied().filter(|k| !in_table[*k]).collect();
                if own.is_empty() {
                    continue;
                }
                let text: String = own
                    .iter()
                    .map(|k| page[*k].text.as_str())
                    .collect::<Vec<_>>()
                    .join(" ");
                let rect_of = |ks: &[usize]| {
                    ks.iter()
                        .fold(None, |acc, k| Some(union(acc, line_rect(&page[*k]))))
                        .unwrap_or([0.0; 4])
                };
                let block_lang = block_lang(&text, &lang);
                if list_marker(&page[own[0]].text) {
                    if !previous_list {
                        list_id += 1;
                    }
                    // One item per marked line, with the lines after it.
                    let mut items: Vec<Vec<usize>> = vec![];
                    for k in &own {
                        if list_marker(&page[*k].text) || items.is_empty() {
                            items.push(vec![*k]);
                        } else if let Some(last) = items.last_mut() {
                            last.push(*k);
                        }
                    }
                    for item in items {
                        let rect = rect_of(&item);
                        blocks.push((
                            rect[1],
                            BlockJson {
                                role: "LI".into(),
                                rect,
                                lang: block_lang.clone(),
                                alt: None,
                                list: Some(list_id),
                                cells: vec![],
                                pagination: false,
                                text: item
                                    .iter()
                                    .map(|k| page[*k].text.as_str())
                                    .collect::<Vec<_>>()
                                    .join(" "),
                            },
                        ));
                    }
                    previous_list = true;
                    continue;
                }
                previous_list = false;
                let size = (p.font_size * 2.0).round() / 2.0;
                let along = p.bbox.2 >= p.bbox.3;
                let role = match heading_sizes.iter().position(|h| (*h - size).abs() < 0.26) {
                    Some(level) if along && own.len() <= 3 && text.chars().count() <= 160 => {
                        format!("H{}", level + 1)
                    }
                    _ => "P".into(),
                };
                let rect = rect_of(&own);
                blocks.push((
                    rect[1],
                    BlockJson {
                        role,
                        rect,
                        lang: block_lang,
                        alt: None,
                        list: None,
                        cells: vec![],
                        pagination: false,
                        text,
                    },
                ));
            }
            // Keep reading order: tables where their first line was.
            blocks.sort_by(|a, b| {
                let first = |blk: &BlockJson| {
                    page.iter()
                        .position(|l| centre_in(line_rect(l), blk.rect))
                        .unwrap_or(usize::MAX)
                };
                first(&a.1).cmp(&first(&b.1))
            });
            let mut blocks: Vec<BlockJson> = blocks.into_iter().map(|(_, b)| b).collect();
            // Pictures: figures, in the text where they stand.
            let shown = self.pdf.shown_from_user(i).ok();
            let mut figures: Vec<[f32; 4]> = vec![];
            for image in scan
                .images
                .iter()
                .filter(|im| im.page == i && !im.in_annotation)
            {
                let Some(m) = shown else { break };
                let r = transformed(m, image.bbox);
                let (w, h) = (r[2] - r[0], r[3] - r[1]);
                // Too small to mean anything, or a scanned page under its text.
                if w < 12.0 || h < 12.0 || (w * h > width * height * 0.8 && !page.is_empty()) {
                    continue;
                }
                match figures
                    .iter_mut()
                    .find(|f| centre_in(r, **f) || centre_in(**f, r))
                {
                    Some(f) => *f = union(Some(*f), r),
                    None => figures.push(r),
                }
            }
            for f in figures {
                let at = blocks
                    .iter()
                    .position(|b| b.rect[1] > f[1])
                    .unwrap_or(blocks.len());
                blocks.insert(
                    at,
                    BlockJson {
                        role: "Figure".into(),
                        rect: f,
                        lang: None,
                        alt: None,
                        list: None,
                        cells: vec![],
                        pagination: false,
                        text: String::new(),
                    },
                );
            }
            for k in &pagination[i] {
                let l = &page[*k];
                blocks.push(BlockJson {
                    role: "Artifact".into(),
                    rect: line_rect(l),
                    lang: None,
                    alt: None,
                    list: None,
                    cells: vec![],
                    // A running head or page number; a stamp up the margin is not.
                    pagination: l.width >= l.height,
                    text: l.text.clone(),
                });
            }
            out.push(PageJson {
                width,
                height,
                blocks,
            });
        }
        let title = self
            .pdf
            .metadata()
            .title
            .filter(|t| !t.trim().is_empty())
            .or_else(|| {
                out.iter()
                    .flat_map(|p| p.blocks.iter())
                    .find(|b| b.role == "H1")
                    .map(|b| b.text.chars().take(120).collect())
            });
        Ok(PlanJson {
            lang,
            title,
            pages: out,
        })
    }
}

fn leaf_role(leaf: &Leaf) -> String {
    match leaf.role.as_str() {
        "H" => "H1".into(),
        r @ ("H1" | "H2" | "H3" | "H4" | "H5" | "H6" | "Figure" | "Caption") => r.into(),
        "LI" | "LBody" | "Lbl" => "LI".into(),
        _ => "P".into(),
    }
}

fn check_json(c: &warraq_pdf::standards::access::Check) -> serde_json::Value {
    json!({
        "id": c.id,
        "clause": c.clause,
        "wcag": c.wcag,
        "status": c.status.key(),
        "detail": c.detail,
        "pages": c.pages,
        "fix": c.fix,
    })
}

pub fn call_static(name: &str, json: &str, blobs: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let pdf = blobs
        .into_iter()
        .next()
        .ok_or_else(|| CoreError::Args(format!("accessibility.{name} takes the PDF")))?;
    match name {
        "plan" => {
            let a: Open = args(json)?;
            let doc = Document::open(pdf, a.password.as_deref())?;
            let (plan, source) = doc.accessibility_plan()?;
            Reply::of(&json!({ "source": source, "tagged": doc.pdf.is_tagged(), "plan": plan }))
        }
        "tag" => {
            let a: Tag = args(json)?;
            let mut doc = Document::open(pdf, a.password.as_deref())?;
            let plan = TagPlan {
                pages: a
                    .plan
                    .pages
                    .iter()
                    .map(|p| p.blocks.iter().map(Block::from).collect())
                    .collect(),
                lang: a.plan.lang.clone(),
                title: a.plan.title.clone(),
            };
            let pdf = doc.pdf_mut();
            let report = pdf.apply_tags(&plan)?;
            // A long document gets bookmarks from its headings, if it has none.
            let mut bookmarks = 0;
            if pdf.page_count() > LONG {
                let headings: Vec<(usize, u8, String)> = a
                    .plan
                    .pages
                    .iter()
                    .enumerate()
                    .flat_map(|(i, p)| {
                        p.blocks.iter().filter_map(move |b| {
                            let level = b.role.strip_prefix('H')?.parse::<u8>().ok()?;
                            Some((i, level, b.text.clone()))
                        })
                    })
                    .collect();
                bookmarks = pdf.add_bookmarks(&headings);
            }
            let bytes = doc.save()?;
            Ok(Reply::of(&json!({
                "elements": report.elements,
                "sequences": report.sequences,
                "artifacts": report.artifacts,
                "spans": report.spans,
                "annotations": report.annotations,
                "bookmarks": bookmarks,
            }))?
            .with_blob(bytes))
        }
        "check" => {
            let a: Open = args(json)?;
            let doc = warraq_pdf::PdfDocument::open(pdf, a.password.as_deref())?;
            let checks = doc.accessibility_check();
            Reply::of(&json!({ "checks": checks.iter().map(check_json).collect::<Vec<_>>() }))
        }
        "fix" => {
            let a: Fix = args(json)?;
            let mut doc = Document::open(pdf, a.password.as_deref())?;
            let mut applied = serde_json::Map::new();
            // What a fix needs to know that the file does not say.
            let (plan, _) = if a
                .fixes
                .iter()
                .any(|f| f == "bookmarks" || f == "language" || f == "title")
            {
                doc.accessibility_plan()?
            } else {
                (
                    PlanJson {
                        lang: String::new(),
                        title: None,
                        pages: vec![],
                    },
                    "",
                )
            };
            for fix in &a.fixes {
                let pdf = doc.pdf_mut();
                let done = match fix.as_str() {
                    "title" => {
                        let title = a
                            .title
                            .clone()
                            .or(plan.title.clone())
                            .filter(|t| !t.trim().is_empty());
                        match title {
                            Some(t) => pdf.set_title(&t).map(|_| 1)?,
                            None => 0,
                        }
                    }
                    "displayTitle" => pdf.set_display_doc_title().map(|_| 1)?,
                    "language" => {
                        let lang = a.lang.clone().unwrap_or(plan.lang.clone());
                        pdf.set_language(&lang).map(|_| 1)?
                    }
                    "tabOrder" => pdf.set_tab_order(),
                    "fieldTooltips" => pdf.set_field_tooltips(),
                    "bookmarks" => {
                        let headings: Vec<(usize, u8, String)> = plan
                            .pages
                            .iter()
                            .enumerate()
                            .flat_map(|(i, p)| {
                                p.blocks.iter().filter_map(move |b| {
                                    let level = b.role.strip_prefix('H')?.parse::<u8>().ok()?;
                                    Some((i, level, b.text.clone()))
                                })
                            })
                            .collect();
                        pdf.add_bookmarks(&headings)
                    }
                    other => return Err(CoreError::Args(format!("no fix called {other}"))),
                };
                applied.insert(fix.clone(), json!(done));
            }
            let bytes = doc.save()?;
            Ok(Reply::of(&json!({ "applied": applied }))?.with_blob(bytes))
        }
        "figures" => {
            let a: Open = args(json)?;
            let doc = Document::open(pdf, a.password.as_deref())?;
            let scan = doc.pdf.scan_content(ScanOptions::default());
            let mut boxes: HashMap<usize, HashMap<i64, [f32; 4]>> = HashMap::new();
            let mut figures = vec![];
            for leaf in doc
                .pdf
                .structure_leaves()
                .iter()
                .filter(|l| l.role == "Figure")
            {
                let Some(id) = leaf.id else { continue };
                let page_boxes = boxes.entry(leaf.page).or_insert_with(|| {
                    let empty = BTreeMap::new();
                    let scan_boxes = scan
                        .pages
                        .get(leaf.page)
                        .map(|p| &p.mcid_boxes)
                        .unwrap_or(&empty);
                    doc.mcid_boxes(leaf.page, scan_boxes)
                });
                let rect = leaf
                    .mcids
                    .iter()
                    .filter_map(|m| page_boxes.get(m))
                    .fold(None, |acc: Option<[f32; 4]>, r| Some(union(acc, *r)));
                figures.push(json!({
                    "id": format!("{} {}", id.0, id.1),
                    "page": leaf.page,
                    "rect": rect,
                    "alt": leaf.alt,
                }));
            }
            Reply::of(&json!({ "figures": figures }))
        }
        "alt" => {
            let a: Alts = args(json)?;
            let mut doc = Document::open(pdf, a.password.as_deref())?;
            let alts: Vec<((u32, u16), String)> = a
                .alts
                .iter()
                .filter_map(|x| {
                    let (n, g) = x.id.split_once(' ')?;
                    Some(((n.parse().ok()?, g.parse().ok()?), x.alt.clone()))
                })
                .collect();
            let set = doc.pdf_mut().set_alt_texts(&alts);
            let bytes = doc.save()?;
            Ok(Reply::of(&json!({ "set": set }))?.with_blob(bytes))
        }
        _ => Err(CoreError::UnknownOp(format!("accessibility.{name}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn corpus(name: &str) -> Vec<u8> {
        std::fs::read(format!(
            "{}/../../../tests/corpus/arabic/{name}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap()
    }

    fn answer(reply: &Reply) -> Value {
        serde_json::from_str(&reply.json).unwrap()
    }

    #[test]
    fn list_markers_in_both_scripts() {
        for yes in [
            "• بند",
            "1. first",
            "١. أولاً",
            "۲) دوم",
            "(3) third",
            "أ) البند",
            "a. item",
            "- dash",
        ] {
            assert!(list_marker(yes), "{yes}");
        }
        for no in ["2026 was", "رقم 5", "1,200.00", "Warraq", "", "-5 degrees"] {
            assert!(!list_marker(no), "{no}");
        }
        assert!(page_label("- 3 -") && page_label("صفحة ٣ من ١٠") && page_label("Page 2 of 9"));
        assert!(!page_label("الفصل الأول"));
    }

    #[test]
    fn an_arabic_invoice_is_planned_tagged_and_checked() {
        let pdf = corpus("generated/coretext-sfarabic-mixed-invoice.pdf");
        let plan = answer(&call_static("plan", "{}", vec![pdf.clone()]).unwrap());
        assert_eq!(plan["source"], "reading");
        assert_eq!(plan["plan"]["lang"], "ar");
        let blocks = plan["plan"]["pages"][0]["blocks"].as_array().unwrap();
        assert!(blocks.len() >= 3, "{blocks:?}");
        let before = answer(&call_static("check", "{}", vec![pdf.clone()]).unwrap());
        let status = |v: &Value, id: &str| -> String {
            v["checks"]
                .as_array()
                .unwrap()
                .iter()
                .find(|c| c["id"] == id)
                .unwrap()["status"]
                .as_str()
                .unwrap()
                .to_string()
        };
        assert_eq!(status(&before, "tagged"), "failed");
        let tagged = call_static(
            "tag",
            &json!({ "plan": plan["plan"] }).to_string(),
            vec![pdf.clone()],
        )
        .unwrap();
        let bytes = tagged.blobs[0].clone();
        assert!(bytes.starts_with(&pdf), "an update of the file");
        let after = answer(&call_static("check", "{}", vec![bytes.clone()]).unwrap());
        for id in ["tagged", "untagged", "language", "displayTitle"] {
            assert_eq!(status(&after, id), "passed", "{id}: {after}");
        }
        // The tagged file's plan is its own structure, in the order given.
        let again = answer(&call_static("plan", "{}", vec![bytes.clone()]).unwrap());
        assert_eq!(again["source"], "structure");
        let roles = |v: &Value| -> Vec<String> {
            v["plan"]["pages"][0]["blocks"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|b| b["role"] != "Artifact")
                .map(|b| b["role"].as_str().unwrap().to_string())
                .collect()
        };
        assert_eq!(roles(&again), roles(&plan));
        // And it reads the same as before.
        let read = |b: Vec<u8>| Document::open(b, None).unwrap().extract_text(0).unwrap();
        assert_eq!(read(bytes), read(pdf));
    }

    /// Tagging adds marks to the content and draws nothing differently:
    /// every page renders to the same pixels.
    #[test]
    fn tagged_pages_render_the_same() {
        for name in [
            "generated/coretext-sfarabic-mixed-invoice.pdf",
            "generated/chrome-cairo-mixed-invoice.pdf",
            "realworld/A_worldbank_malpass_g7_briefing_AR_word2016_pdftools.pdf",
        ] {
            let pdf = corpus(name);
            let plan =
                answer(&call_static("plan", "{}", vec![pdf.clone()]).unwrap())["plan"].clone();
            let tagged = call_static(
                "tag",
                &json!({ "plan": plan }).to_string(),
                vec![pdf.clone()],
            )
            .unwrap();
            let (before, after) = (
                Document::open(pdf, None).unwrap(),
                Document::open(tagged.blobs[0].clone(), None).unwrap(),
            );
            for page in 0..before.page_count() {
                let (a, b) = (
                    before.render_page(page, 1.0).unwrap(),
                    after.render_page(page, 1.0).unwrap(),
                );
                let differ = a
                    .rgba
                    .chunks(4)
                    .zip(b.rgba.chunks(4))
                    .filter(|(x, y)| x != y)
                    .count();
                assert!(
                    a.rgba == b.rgba,
                    "{name} page {}: {differ} pixels of {}",
                    page + 1,
                    a.rgba.len() / 4
                );
            }
        }
    }

    #[test]
    fn reordering_the_plan_changes_the_tree() {
        let pdf = corpus("generated/coretext-sfarabic-mixed-invoice.pdf");
        let mut plan =
            answer(&call_static("plan", "{}", vec![pdf.clone()]).unwrap())["plan"].clone();
        let blocks = plan["pages"][0]["blocks"].as_array_mut().unwrap();
        let first = blocks.remove(0);
        blocks.push(first.clone());
        let tagged = call_static("tag", &json!({ "plan": plan }).to_string(), vec![pdf]).unwrap();
        let again = answer(&call_static("plan", "{}", vec![tagged.blobs[0].clone()]).unwrap());
        let last = again["plan"]["pages"][0]["blocks"]
            .as_array()
            .unwrap()
            .iter()
            .rfind(|b| b["role"] != "Artifact")
            .unwrap()
            .clone();
        assert_eq!(last["role"], first["role"]);
        assert_eq!(last["text"], first["text"]);
    }

    #[test]
    fn fixes_and_alt_text() {
        let pdf = corpus("generated/coretext-sfarabic-mixed-invoice.pdf");
        let fixed = call_static(
            "fix",
            r#"{"fixes": ["title", "displayTitle", "language"], "title": "فاتورة"}"#,
            vec![pdf],
        )
        .unwrap();
        let bytes = fixed.blobs[0].clone();
        let checks = answer(&call_static("check", "{}", vec![bytes.clone()]).unwrap());
        for id in ["title", "displayTitle", "language"] {
            let c = checks["checks"]
                .as_array()
                .unwrap()
                .iter()
                .find(|c| c["id"] == id)
                .unwrap();
            assert_eq!(c["status"], "passed", "{id}");
        }
    }

    #[test]
    fn a_scanned_picture_becomes_a_figure_that_takes_its_text() {
        let pdf = corpus("generated/scan-notonaskh-300dpi-skewed-jpeg.pdf");
        let plan = answer(&call_static("plan", "{}", vec![pdf.clone()]).unwrap())["plan"].clone();
        let blocks = plan["pages"][0]["blocks"].as_array().unwrap();
        assert!(blocks.iter().any(|b| b["role"] == "Figure"), "{blocks:?}");
        let tagged = call_static("tag", &json!({ "plan": plan }).to_string(), vec![pdf])
            .unwrap()
            .blobs[0]
            .clone();
        let status = |bytes: &[u8]| -> String {
            let checks = answer(&call_static("check", "{}", vec![bytes.to_vec()]).unwrap());
            checks["checks"]
                .as_array()
                .unwrap()
                .iter()
                .find(|c| c["id"] == "altText")
                .unwrap()["status"]
                .as_str()
                .unwrap()
                .to_string()
        };
        assert_eq!(status(&tagged), "failed");
        let figures = answer(&call_static("figures", "{}", vec![tagged.clone()]).unwrap());
        let list = figures["figures"].as_array().unwrap();
        assert_eq!(list.len(), 2, "one a page: {figures}");
        assert!(list.iter().all(|f| f["rect"].is_array()), "{figures}");
        let alts: Vec<Value> = list
            .iter()
            .map(|f| json!({ "id": f["id"], "alt": "صفحة ممسوحة من كتاب" }))
            .collect();
        let with_alt = call_static("alt", &json!({ "alts": alts }).to_string(), vec![tagged])
            .unwrap()
            .blobs[0]
            .clone();
        // Present now; whether it says what the picture shows is a person's call.
        assert_eq!(status(&with_alt), "manual");
        let figures = answer(&call_static("figures", "{}", vec![with_alt]).unwrap());
        assert_eq!(figures["figures"][0]["alt"], "صفحة ممسوحة من كتاب");
    }

    /// Every corpus file: planned, tagged, and then rendered, read and
    /// checked. Slow in a debug build; run it with
    /// `cargo test --release -p warraq-core every_corpus_file_tags -- --ignored`.
    #[test]
    #[ignore]
    fn every_corpus_file_tags_without_a_change_on_the_page() {
        let dir = format!(
            "{}/../../../tests/corpus/arabic/",
            env!("CARGO_MANIFEST_DIR")
        );
        let mut done = 0;
        for sub in ["generated", "realworld"] {
            for entry in std::fs::read_dir(format!("{dir}{sub}")).unwrap() {
                let path = entry.unwrap().path();
                let name = path.file_name().unwrap().to_string_lossy().to_string();
                if !name.ends_with(".pdf")
                    || name.contains("encrypted")
                    || name.starts_with("perf-")
                {
                    continue;
                }
                let pdf = std::fs::read(&path).unwrap();
                let plan =
                    answer(&call_static("plan", "{}", vec![pdf.clone()]).unwrap())["plan"].clone();
                let tagged = call_static(
                    "tag",
                    &json!({ "plan": plan }).to_string(),
                    vec![pdf.clone()],
                )
                .unwrap_or_else(|e| panic!("{name}: {e}"));
                let bytes = tagged.blobs[0].clone();
                let (before, after) = (
                    Document::open(pdf, None).unwrap(),
                    Document::open(bytes.clone(), None).unwrap(),
                );
                for page in 0..before.page_count().min(12) {
                    let (a, b) = (
                        before.render_page(page, 0.5).unwrap(),
                        after.render_page(page, 0.5).unwrap(),
                    );
                    // An annotation tagging touches (`/StructParent`) is written
                    // anew, and lopdf keeps its reals as f32: a rectangle edge
                    // can move by a millionth of a point, and flip the
                    // antialiasing of a pixel. PDFium reads reals as f32 anyway.
                    let differ = a
                        .rgba
                        .chunks(4)
                        .zip(b.rgba.chunks(4))
                        .filter(|(x, y)| x != y)
                        .count();
                    assert!(
                        differ <= 2,
                        "{name} page {}: {differ} pixels differ",
                        page + 1
                    );
                    assert_eq!(
                        before.extract_text(page).unwrap(),
                        after.extract_text(page).unwrap(),
                        "{name} page {}",
                        page + 1
                    );
                }
                let checks = answer(&call_static("check", "{}", vec![bytes]).unwrap());
                for id in ["tagged", "untagged", "language"] {
                    let c = checks["checks"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|c| c["id"] == id)
                        .unwrap();
                    assert_eq!(c["status"], "passed", "{name}: {c}");
                }
                done += 1;
            }
        }
        println!("{done} files tagged");
    }
}
