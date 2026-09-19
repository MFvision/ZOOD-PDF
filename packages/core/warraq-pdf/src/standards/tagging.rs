//! Tagging: the logical structure a screen reader follows (ISO 32000-1
//! §14.7–14.8, PDF/UA-1), written from a plan of each page's blocks in
//! reading order — headings, paragraphs, list items, tables, figures, and
//! what is only decoration (artifacts).
//!
//! The plan says where each block is on the page as shown. Every painting
//! operator of the page's content is given to the block it falls in: text by
//! where its run starts, a picture or a path by its centre. Text in another
//! script than its block's (a Latin brand name in an Arabic paragraph)
//! becomes a `Span` with its own `/Lang`. Paths and pictures outside every
//! figure are artifacts, and so is whatever the file already marked as one
//! (Warraq's page marks among them). The content is rewritten with a
//! marked-content sequence (`BDC … EMC`, with an MCID) around each run of
//! operators with the same owner, opened and closed only where the syntax
//! allows: never inside a path, never across a text object, a `q`/`Q` or a
//! sequence the file had. Nothing is drawn differently.
//!
//! Tagging again starts from nothing: the old tree and its MCIDs go, other
//! marked content (optional content, `/ActualText` spans, artifacts) stays.
use std::collections::{BTreeMap, BTreeSet, HashMap};

use lopdf::content::{Content, Operation};
use lopdf::{dictionary, Dictionary, Document, Object, ObjectId, Stream};

use super::fonts;
use super::{dict_of, name, resolve};
use crate::document::decode_text_string;
use crate::text_walk::Matrix;
use crate::{Error, PdfDocument, Result};

/// Roles a block can have.
pub const ROLES: &[&str] = &[
    "H1", "H2", "H3", "H4", "H5", "H6", "P", "LI", "Table", "Figure", "Caption", "Artifact",
];

/// One block of a page, in the plan.
#[derive(Debug, Clone, PartialEq)]
pub struct Block {
    /// One of `ROLES`.
    pub role: String,
    /// Where it is on the page as shown: `[x0, y0, x1, y1]`, points from
    /// the top-left corner, y down.
    pub rect: [f32; 4],
    /// Its language, when it differs from the document's.
    pub lang: Option<String>,
    /// A figure's alternative text.
    pub alt: Option<String>,
    /// A list item's list: consecutive items of one number are one list.
    pub list: Option<u32>,
    /// A table's cells, row by row, as rects like `rect`; the first row is
    /// its header.
    pub cells: Vec<Vec<[f32; 4]>>,
    /// A header or footer (an artifact of pagination), for `Artifact`.
    pub pagination: bool,
}

impl Block {
    pub fn new(role: &str, rect: [f32; 4]) -> Self {
        Self {
            role: role.into(),
            rect,
            lang: None,
            alt: None,
            list: None,
            cells: vec![],
            pagination: false,
        }
    }
}

/// The whole plan: each page's blocks in reading order.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TagPlan {
    pub pages: Vec<Vec<Block>>,
    /// The document's language (BCP 47), e.g. `ar` or `en`.
    pub lang: String,
    pub title: Option<String>,
}

/// What tagging wrote.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TagReport {
    pub elements: usize,
    pub sequences: usize,
    pub artifacts: usize,
    pub spans: usize,
    pub annotations: usize,
    /// Text runs no block held, given to the nearest one.
    pub nearest: usize,
}

/// Who a run of operators belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Owner {
    Block(usize),
    Cell(usize, usize, usize),
    /// A block's text in another language.
    Span(usize, Option<(usize, usize)>, Script),
    Artifact {
        pagination: bool,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub(crate) enum Script {
    Arabic,
    Latin,
}

impl Script {
    fn lang(self) -> &'static str {
        match self {
            Script::Arabic => "ar",
            Script::Latin => "en",
        }
    }
}

/// The script most of `text`'s letters are in; `None` for digits, marks
/// and punctuation alone.
pub(crate) fn script_of(text: &str) -> Option<Script> {
    let (mut arabic, mut latin) = (0, 0);
    for c in text.chars() {
        match c as u32 {
            0x0600..=0x06FF
            | 0x0750..=0x077F
            | 0x08A0..=0x08FF
            | 0xFB50..=0xFDFF
            | 0xFE70..=0xFEFF
                if c.is_alphabetic() =>
            {
                arabic += 1
            }
            _ if c.is_ascii_alphabetic() || ('\u{C0}'..='\u{24F}').contains(&c) => latin += 1,
            _ => {}
        }
    }
    if arabic == 0 && latin < 2 {
        return None;
    }
    Some(if arabic >= latin {
        Script::Arabic
    } else {
        Script::Latin
    })
}

/// A language tag's script, as far as spans go.
fn script_of_lang(lang: &str) -> Option<Script> {
    let primary = lang.split('-').next().unwrap_or("").to_ascii_lowercase();
    match primary.as_str() {
        "ar" | "fa" | "ur" | "ps" | "ku" | "sd" | "ug" => Some(Script::Arabic),
        "" => None,
        _ => Some(Script::Latin),
    }
}

fn num(o: &Object) -> f32 {
    match o {
        Object::Integer(i) => *i as f32,
        Object::Real(r) if r.is_finite() => *r,
        _ => 0.0,
    }
}

fn matrix(a: &[Object]) -> Matrix {
    Matrix([
        num(&a[0]),
        num(&a[1]),
        num(&a[2]),
        num(&a[3]),
        num(&a[4]),
        num(&a[5]),
    ])
}

fn bbox_of(m: Matrix, r: [f32; 4]) -> [f32; 4] {
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

fn inside(p: (f32, f32), r: [f32; 4], pad: f32) -> bool {
    p.0 >= r[0] - pad && p.0 <= r[2] + pad && p.1 >= r[1] - pad && p.1 <= r[3] + pad
}

fn distance(p: (f32, f32), r: [f32; 4]) -> f32 {
    let dx = (r[0] - p.0).max(0.0).max(p.0 - r[2]);
    let dy = (r[1] - p.1).max(0.0).max(p.1 - r[3]);
    (dx * dx + dy * dy).sqrt()
}

/// A block's tag in the content (`BDC`) and the structure.
fn tag_of(role: &str) -> &str {
    match role {
        "LI" => "LBody",
        r if ROLES.contains(&r) => r,
        _ => "P",
    }
}

/// Where each font resource's text comes from: its dictionary, facts, and
/// whether its codes are two bytes.
struct FontText {
    dict: Dictionary,
    facts: fonts::FontFacts,
    two: bool,
}

/// One page's content, marked.
struct Marked {
    ops: Vec<Operation>,
    /// Each MCID's owner, in order.
    mcids: Vec<Owner>,
    artifacts: usize,
    nearest: usize,
}

struct Marker<'a> {
    doc: &'a Document,
    blocks: &'a [Block],
    /// User space to the page as shown.
    to_shown: Matrix,
    resources: Option<&'a Dictionary>,
    fonts: HashMap<Vec<u8>, Option<FontText>>,
    out: Vec<Operation>,
    mcids: Vec<Owner>,
    /// The sequence Warraq opened, and how deep in the file's own ones.
    open: Option<(Owner, usize)>,
    /// The file's own sequences: kept, and whether an artifact.
    existing: Vec<(bool, bool)>,
    artifacts: usize,
    nearest: usize,
    /// Scripts of the blocks, for spans.
    block_script: Vec<Option<Script>>,
}

impl<'a> Marker<'a> {
    fn close(&mut self) {
        if self.open.take().is_some() {
            self.out.push(Operation::new("EMC", vec![]));
        }
    }

    fn inside_artifact(&self) -> bool {
        self.existing
            .iter()
            .any(|(kept, artifact)| *kept && *artifact)
    }

    fn own(&mut self, owner: Owner) {
        let depth = self.existing.len();
        if self.open == Some((owner, depth)) {
            return;
        }
        self.close();
        // What the file already marked as an artifact stays one.
        if self.inside_artifact() {
            return;
        }
        let op = match owner {
            Owner::Artifact { pagination } => {
                self.artifacts += 1;
                if pagination {
                    Operation::new(
                        "BDC",
                        vec![
                            Object::Name(b"Artifact".to_vec()),
                            Object::Dictionary(dictionary! { "Type" => "Pagination" }),
                        ],
                    )
                } else {
                    Operation::new("BMC", vec![Object::Name(b"Artifact".to_vec())])
                }
            }
            _ => {
                let mcid = self.mcids.len() as i64;
                self.mcids.push(owner);
                let tag = match owner {
                    Owner::Cell(b, r, _) => {
                        if r == 0 && self.blocks[b].cells.len() > 1 {
                            "TH"
                        } else {
                            "TD"
                        }
                    }
                    Owner::Span(..) => "Span",
                    Owner::Block(b) => tag_of(&self.blocks[b].role),
                    Owner::Artifact { .. } => unreachable!(),
                };
                Operation::new(
                    "BDC",
                    vec![
                        Object::Name(tag.as_bytes().to_vec()),
                        Object::Dictionary(dictionary! { "MCID" => mcid }),
                    ],
                )
            }
        };
        self.out.push(op);
        self.open = Some((owner, depth));
    }

    /// The block (and table cell) a point on the page as shown is in.
    fn place(&mut self, p: (f32, f32), text: bool) -> Option<Owner> {
        let found = self
            .blocks
            .iter()
            .position(|b| b.role != "Artifact" && inside(p, b.rect, 1.5));
        let index = match found {
            Some(i) => i,
            // Text no block holds (a box a little off): the nearest one.
            None if text => {
                let best = self
                    .blocks
                    .iter()
                    .enumerate()
                    .filter(|(_, b)| b.role != "Artifact" && b.role != "Figure")
                    .min_by(|a, b| distance(p, a.1.rect).total_cmp(&distance(p, b.1.rect)))?;
                self.nearest += 1;
                best.0
            }
            None => {
                return self
                    .blocks
                    .iter()
                    .find(|b| b.role == "Artifact" && inside(p, b.rect, 1.5))
                    .map(|b| Owner::Artifact {
                        pagination: b.pagination,
                    })
            }
        };
        let block = &self.blocks[index];
        if block.role == "Table" {
            for (r, row) in block.cells.iter().enumerate() {
                for (c, cell) in row.iter().enumerate() {
                    if inside(p, *cell, 1.0) {
                        return Some(Owner::Cell(index, r, c));
                    }
                }
            }
            // Between cells: the nearest one.
            let mut best: Option<(f32, usize, usize)> = None;
            for (r, row) in block.cells.iter().enumerate() {
                for (c, cell) in row.iter().enumerate() {
                    let d = distance(p, *cell);
                    if best.is_none_or(|(bd, _, _)| d < bd) {
                        best = Some((d, r, c));
                    }
                }
            }
            return Some(match best {
                Some((_, r, c)) => Owner::Cell(index, r, c),
                None => Owner::Block(index),
            });
        }
        if block.role == "Artifact" {
            return Some(Owner::Artifact {
                pagination: block.pagination,
            });
        }
        Some(Owner::Block(index))
    }

    fn font(&mut self, resource: &[u8]) -> Option<&FontText> {
        if !self.fonts.contains_key(resource) {
            let found = self
                .resources
                .and_then(|r| dict_of(self.doc, r.get(b"Font").ok()))
                .and_then(|f| dict_of(self.doc, f.get(resource).ok()))
                .map(|dict| {
                    let facts = fonts::facts(self.doc, dict);
                    FontText {
                        dict: dict.clone(),
                        two: facts.subtype == "Type0",
                        facts,
                    }
                });
            self.fonts.insert(resource.to_vec(), found);
        }
        self.fonts.get(resource).and_then(|f| f.as_ref())
    }

    /// The script of what a text-showing operator shows, when it says.
    fn run_script(&mut self, resource: &[u8], op: &Operation) -> Option<Script> {
        let strings: Vec<Vec<u8>> = match op.operator.as_str() {
            "TJ" => op
                .operands
                .first()
                .and_then(|o| o.as_array().ok())
                .map(|a| {
                    a.iter()
                        .filter_map(|s| s.as_str().ok().map(<[u8]>::to_vec))
                        .collect()
                })
                .unwrap_or_default(),
            _ => op
                .operands
                .last()
                .and_then(|o| o.as_str().ok())
                .map(|s| vec![s.to_vec()])
                .unwrap_or_default(),
        };
        let doc = self.doc;
        let font = self.font(resource)?;
        let mut text = String::new();
        for s in strings {
            let codes: Vec<u32> = if font.two {
                s.chunks(2)
                    .map(|p| u32::from(p[0]) << 8 | u32::from(*p.get(1).unwrap_or(&0)))
                    .collect()
            } else {
                s.iter().map(|b| u32::from(*b)).collect()
            };
            for code in codes {
                if let Some(t) = fonts::unicode_of(doc, &font.dict, &font.facts, code) {
                    text.push_str(&t);
                }
            }
        }
        script_of(&text)
    }

    fn walk(&mut self, ops: Vec<Operation>) {
        let mut ctm = Matrix::IDENTITY;
        let mut stack: Vec<Matrix> = vec![];
        let (mut tm, mut tlm) = (Matrix::IDENTITY, Matrix::IDENTITY);
        let (mut leading, mut size, mut rise) = (0.0f32, 0.0f32, 0.0f32);
        let mut font: Vec<u8> = vec![];
        let mut path: Vec<Operation> = vec![];
        let mut path_box: Option<[f32; 4]> = None;
        let extend = |b: &mut Option<[f32; 4]>, p: (f32, f32)| {
            *b = Some(match b {
                None => [p.0, p.1, p.0, p.1],
                Some(r) => [r[0].min(p.0), r[1].min(p.1), r[2].max(p.0), r[3].max(p.1)],
            });
        };
        for op in ops {
            let a = op.operands.clone();
            match op.operator.as_str() {
                "BMC" | "BDC" => {
                    self.close();
                    let tag = a.first().and_then(|t| t.as_name().ok()).unwrap_or(b"");
                    let props = match a.get(1) {
                        Some(Object::Name(n)) => self
                            .resources
                            .and_then(|r| dict_of(self.doc, r.get(b"Properties").ok()))
                            .and_then(|p| dict_of(self.doc, p.get(n).ok())),
                        Some(other) => dict_of(self.doc, Some(other)),
                        None => None,
                    };
                    // The old tagging goes; everything else the file marked stays.
                    let old = props.is_some_and(|p| p.has(b"MCID")) && tag != b"Artifact";
                    self.existing.push((!old, tag == b"Artifact"));
                    if !old {
                        self.out.push(op);
                    }
                }
                // The end of one of the file's own sequences: Warraq's, opened
                // inside it, ends first. An EMC with nothing to end is dropped.
                "EMC" => {
                    if let Some((kept, _)) = self.existing.pop() {
                        self.close();
                        if kept {
                            self.out.push(op);
                        }
                    }
                }
                "q" => {
                    self.close();
                    stack.push(ctm);
                    self.out.push(op);
                }
                "Q" => {
                    self.close();
                    ctm = stack.pop().unwrap_or(Matrix::IDENTITY);
                    self.out.push(op);
                }
                "cm" if a.len() == 6 => {
                    ctm = matrix(&a).then(ctm);
                    self.out.push(op);
                }
                "BT" => {
                    self.close();
                    tm = Matrix::IDENTITY;
                    tlm = tm;
                    self.out.push(op);
                }
                "ET" => {
                    self.close();
                    self.out.push(op);
                }
                "Tf" if a.len() >= 2 => {
                    if let Object::Name(n) = &a[0] {
                        font = n.clone();
                    }
                    size = num(&a[1]);
                    self.out.push(op);
                }
                "TL" if !a.is_empty() => {
                    leading = num(&a[0]);
                    self.out.push(op);
                }
                "Ts" if !a.is_empty() => {
                    rise = num(&a[0]);
                    self.out.push(op);
                }
                "Td" | "TD" if a.len() >= 2 => {
                    if op.operator == "TD" {
                        leading = -num(&a[1]);
                    }
                    tlm = Matrix([1.0, 0.0, 0.0, 1.0, num(&a[0]), num(&a[1])]).then(tlm);
                    tm = tlm;
                    self.out.push(op);
                }
                "Tm" if a.len() == 6 => {
                    tlm = matrix(&a);
                    tm = tlm;
                    self.out.push(op);
                }
                "T*" => {
                    tlm = Matrix([1.0, 0.0, 0.0, 1.0, 0.0, -leading]).then(tlm);
                    tm = tlm;
                    self.out.push(op);
                }
                "Tj" | "TJ" | "'" | "\"" => {
                    if matches!(op.operator.as_str(), "'" | "\"") {
                        tlm = Matrix([1.0, 0.0, 0.0, 1.0, 0.0, -leading]).then(tlm);
                        tm = tlm;
                    }
                    let full = tm.then(ctm);
                    // A point in the middle of the run's first glyph's height.
                    let (x, y) = full.apply(size * 0.25, rise + size * 0.35);
                    let p = self.to_shown.apply(x, y);
                    let owner = match self.place(p, true) {
                        Some(Owner::Block(b)) => {
                            match (self.block_script[b], self.run_script(&font, &op)) {
                                (Some(mine), Some(its)) if mine != its => Owner::Span(b, None, its),
                                _ => Owner::Block(b),
                            }
                        }
                        Some(Owner::Cell(b, r, c)) => {
                            match (self.block_script[b], self.run_script(&font, &op)) {
                                (Some(mine), Some(its)) if mine != its => {
                                    Owner::Span(b, Some((r, c)), its)
                                }
                                _ => Owner::Cell(b, r, c),
                            }
                        }
                        Some(other) => other,
                        None => Owner::Artifact { pagination: false },
                    };
                    self.own(owner);
                    self.out.push(op);
                }
                "m" | "l" if a.len() >= 2 => {
                    extend(
                        &mut path_box,
                        self.to_shown.apply_pair(ctm.apply(num(&a[0]), num(&a[1]))),
                    );
                    path.push(op);
                }
                "c" | "v" | "y" => {
                    for pair in a.chunks(2) {
                        if let [x, y] = pair {
                            extend(
                                &mut path_box,
                                self.to_shown.apply_pair(ctm.apply(num(x), num(y))),
                            );
                        }
                    }
                    path.push(op);
                }
                "re" if a.len() == 4 => {
                    let (x, y, w, h) = (num(&a[0]), num(&a[1]), num(&a[2]), num(&a[3]));
                    let r = bbox_of(ctm.then(self.to_shown), [x, y, x + w, y + h]);
                    extend(&mut path_box, (r[0], r[1]));
                    extend(&mut path_box, (r[2], r[3]));
                    path.push(op);
                }
                "h" => path.push(op),
                "W" | "W*" => path.push(op),
                "S" | "s" | "f" | "F" | "f*" | "B" | "B*" | "b" | "b*" | "n" => {
                    let paints = op.operator != "n";
                    if paints {
                        let owner = path_box
                            .and_then(|r| {
                                let c = ((r[0] + r[2]) / 2.0, (r[1] + r[3]) / 2.0);
                                self.blocks
                                    .iter()
                                    .position(|b| b.role == "Figure" && inside(c, b.rect, 2.0))
                                    .map(Owner::Block)
                            })
                            .unwrap_or(Owner::Artifact { pagination: false });
                        self.own(owner);
                    }
                    // A clipping path (`W n`) paints nothing and stays where it is.
                    self.out.append(&mut path);
                    self.out.push(op);
                    path_box = None;
                }
                "Do" | "BI" | "sh" => {
                    let r = if op.operator == "Do" {
                        let form = a
                            .first()
                            .and_then(|n| n.as_name().ok())
                            .and_then(|n| {
                                self.resources
                                    .and_then(|r| dict_of(self.doc, r.get(b"XObject").ok()))
                                    .and_then(|x| x.get(n).ok())
                            })
                            .map(|o| resolve(self.doc, o))
                            .and_then(|o| o.as_stream().ok());
                        match form {
                            Some(s) if name(s.dict.get(b"Subtype").ok()) == Some(b"Form") => {
                                let bbox: Vec<f32> = s
                                    .dict
                                    .get(b"BBox")
                                    .ok()
                                    .map(|b| resolve(self.doc, b))
                                    .and_then(|b| b.as_array().ok())
                                    .map(|b| b.iter().map(num).collect())
                                    .unwrap_or_default();
                                let m = s
                                    .dict
                                    .get(b"Matrix")
                                    .ok()
                                    .and_then(|m| m.as_array().ok())
                                    .filter(|m| m.len() == 6)
                                    .map(|m| matrix(m))
                                    .unwrap_or(Matrix::IDENTITY);
                                (bbox.len() == 4).then(|| {
                                    bbox_of(
                                        m.then(ctm).then(self.to_shown),
                                        [bbox[0], bbox[1], bbox[2], bbox[3]],
                                    )
                                })
                            }
                            _ => Some(bbox_of(ctm.then(self.to_shown), [0.0, 0.0, 1.0, 1.0])),
                        }
                    } else if op.operator == "BI" {
                        Some(bbox_of(ctm.then(self.to_shown), [0.0, 0.0, 1.0, 1.0]))
                    } else {
                        None
                    };
                    let owner = r
                        .and_then(|r| {
                            let c = ((r[0] + r[2]) / 2.0, (r[1] + r[3]) / 2.0);
                            let figure = self
                                .blocks
                                .iter()
                                .position(|b| b.role == "Figure" && inside(c, b.rect, 2.0));
                            // A form that holds text is read with the block it is in.
                            figure.map(Owner::Block).or_else(|| {
                                let is_form = op.operator == "Do";
                                if is_form {
                                    self.blocks
                                        .iter()
                                        .position(|b| {
                                            b.role != "Artifact"
                                                && b.role != "Figure"
                                                && inside(c, b.rect, 1.0)
                                        })
                                        .map(Owner::Block)
                                } else {
                                    None
                                }
                            })
                        })
                        .unwrap_or(Owner::Artifact { pagination: false });
                    self.own(owner);
                    self.out.push(op);
                }
                _ => {
                    // Path construction continues through these too.
                    if path.is_empty() {
                        self.out.push(op);
                    } else {
                        path.push(op);
                    }
                }
            }
        }
        self.out.append(&mut path);
        self.close();
    }
}

trait ApplyPair {
    fn apply_pair(self, p: (f32, f32)) -> (f32, f32);
}

impl ApplyPair for Matrix {
    fn apply_pair(self, p: (f32, f32)) -> (f32, f32) {
        self.apply(p.0, p.1)
    }
}

/// A structure element being built.
struct Element {
    s: String,
    kids: Vec<Kid>,
    lang: Option<String>,
    alt: Option<String>,
    attrs: Option<Dictionary>,
    page: Option<ObjectId>,
}

enum Kid {
    Mcid(i64),
    Element(usize),
    Annot(ObjectId, ObjectId),
}

impl Element {
    fn new(s: &str, page: Option<ObjectId>) -> Self {
        Self {
            s: s.into(),
            kids: vec![],
            lang: None,
            alt: None,
            attrs: None,
            page,
        }
    }
}

/// The annotation subtypes that are not content (PDF/UA-1 §7.18.1).
fn annotation_role(subtype: &[u8]) -> Option<&'static str> {
    match subtype {
        b"Link" => Some("Link"),
        b"Widget" => Some("Form"),
        b"Popup" | b"PrinterMark" | b"TrapNet" => None,
        _ => Some("Annot"),
    }
}

impl PdfDocument {
    fn root_id(&self) -> Result<ObjectId> {
        self.doc
            .trailer
            .get(b"Root")
            .and_then(|r| r.as_reference())
            .map_err(|_| Error::Parse("no catalog".into()))
    }

    /// Writes the structure the plan describes; see the module documentation.
    pub fn apply_tags(&mut self, plan: &TagPlan) -> Result<TagReport> {
        let mut report = TagReport::default();
        let root_lang = plan.lang.clone();
        let root_script = script_of_lang(&root_lang);
        let mut elements: Vec<Element> = vec![Element::new("Document", None)];
        // ParentTree: each page's MCIDs, each annotation's element.
        let mut parents: Vec<(i64, Object)> = vec![];
        let mut next_key: i64 = 0;
        let mut pending_parent: Vec<(i64, Vec<usize>)> = vec![];
        let mut pending_annot: Vec<(i64, usize)> = vec![];
        let page_ids = self.pages.clone();
        for (index, page_id) in page_ids.iter().enumerate() {
            let blocks: &[Block] = plan.pages.get(index).map(Vec::as_slice).unwrap_or(&[]);
            let frame = self.display_frame(index)?;
            let to_shown = frame.display_to_user().invert().unwrap_or(Matrix::IDENTITY);
            let content = self
                .doc
                .get_page_content_with_limit(*page_id, 64 << 20)
                .map_err(|e| Error::Edit(format!("page {}: {e}", index + 1)))?;
            let ops = Content::decode(&content)
                .map_err(|e| Error::Edit(format!("page {}: {e}", index + 1)))?
                .operations;
            let marked = {
                let page = self
                    .doc
                    .get_dictionary(*page_id)
                    .map_err(|e| Error::Parse(e.to_string()))?;
                let resources = match self.inherited(page, b"Resources") {
                    Some(Object::Reference(id)) => self.doc.get_dictionary(*id).ok(),
                    Some(Object::Dictionary(d)) => Some(d),
                    _ => None,
                };
                let block_script = blocks
                    .iter()
                    .map(|b| b.lang.as_deref().and_then(script_of_lang).or(root_script))
                    .collect();
                let mut marker = Marker {
                    doc: &self.doc,
                    blocks,
                    to_shown,
                    resources,
                    fonts: HashMap::new(),
                    out: Vec::with_capacity(ops.len() + 16),
                    mcids: vec![],
                    open: None,
                    existing: vec![],
                    artifacts: 0,
                    nearest: 0,
                    block_script,
                };
                marker.walk(ops);
                Marked {
                    ops: marker.out,
                    mcids: marker.mcids,
                    artifacts: marker.artifacts,
                    nearest: marker.nearest,
                }
            };
            report.sequences += marked.mcids.len();
            report.artifacts += marked.artifacts;
            report.nearest += marked.nearest;
            let encoded = Content {
                operations: marked.ops,
            }
            .encode()
            .map_err(|e| Error::Edit(e.to_string()))?;
            let mut stream = Stream::new(Dictionary::new(), encoded);
            let _ = stream.compress();
            let contents = self.doc.add_object(stream);

            // The page's elements, in the plan's order.
            let mut block_elem: Vec<Option<usize>> = vec![None; blocks.len()];
            let mut cell_elem: BTreeMap<(usize, usize, usize), usize> = BTreeMap::new();
            let mut current_list: Option<(u32, usize)> = None;
            let page_ref = Some(*page_id);
            for (b, block) in blocks.iter().enumerate() {
                if block.role == "Artifact" {
                    continue;
                }
                let used = marked.mcids.iter().any(|o| match o {
                    Owner::Block(i) | Owner::Cell(i, ..) | Owner::Span(i, ..) => *i == b,
                    _ => false,
                });
                if !used {
                    continue;
                }
                let parent = if block.role == "LI" {
                    let list = block.list.unwrap_or(u32::MAX);
                    let l = match current_list {
                        Some((id, l)) if id == list => l,
                        _ => {
                            elements.push(Element::new("L", page_ref));
                            let l = elements.len() - 1;
                            elements[0].kids.push(Kid::Element(l));
                            current_list = Some((list, l));
                            l
                        }
                    };
                    elements.push(Element::new("LI", page_ref));
                    let li = elements.len() - 1;
                    elements[l].kids.push(Kid::Element(li));
                    li
                } else {
                    current_list = None;
                    0
                };
                let tag = if block.role == "LI" {
                    "LBody"
                } else {
                    tag_of(&block.role)
                };
                let mut e = Element::new(tag, page_ref);
                if block
                    .lang
                    .as_deref()
                    .is_some_and(|l| !l.eq_ignore_ascii_case(&root_lang))
                {
                    e.lang = block.lang.clone();
                }
                if block.role == "Figure" {
                    e.alt = block.alt.clone().filter(|a| !a.trim().is_empty());
                    let r = bbox_of(frame.display_to_user(), block.rect);
                    e.attrs = Some(dictionary! {
                        "O" => "Layout",
                        "BBox" => r.iter().map(|v| Object::Real(*v)).collect::<Vec<_>>(),
                    });
                }
                elements.push(e);
                let id = elements.len() - 1;
                elements[parent].kids.push(Kid::Element(id));
                block_elem[b] = Some(id);
                if block.role == "Table" {
                    for (r, row) in block.cells.iter().enumerate() {
                        elements.push(Element::new("TR", page_ref));
                        let tr = elements.len() - 1;
                        elements[id].kids.push(Kid::Element(tr));
                        for c in 0..row.len() {
                            let header = r == 0 && block.cells.len() > 1;
                            let mut cell = Element::new(if header { "TH" } else { "TD" }, page_ref);
                            if header {
                                cell.attrs =
                                    Some(dictionary! { "O" => "Table", "Scope" => "Column" });
                            }
                            elements.push(cell);
                            let ce = elements.len() - 1;
                            elements[tr].kids.push(Kid::Element(ce));
                            cell_elem.insert((b, r, c), ce);
                        }
                    }
                }
            }
            // MCIDs into their elements, in content order; a span of another
            // script gets an element of its own.
            let mut by_mcid: Vec<usize> = vec![];
            let mut last_span: Option<(Owner, usize)> = None;
            for (mcid, owner) in marked.mcids.iter().enumerate() {
                let mcid = mcid as i64;
                let (holder, span) = match *owner {
                    Owner::Block(b) => (block_elem[b], None),
                    Owner::Cell(b, r, c) => {
                        (cell_elem.get(&(b, r, c)).copied().or(block_elem[b]), None)
                    }
                    Owner::Span(b, cell, script) => {
                        let holder = match cell {
                            Some((r, c)) => cell_elem.get(&(b, r, c)).copied().or(block_elem[b]),
                            None => block_elem[b],
                        };
                        (holder, Some(script))
                    }
                    Owner::Artifact { .. } => (None, None),
                };
                let Some(holder) = holder else {
                    by_mcid.push(0);
                    continue;
                };
                match span {
                    None => {
                        elements[holder].kids.push(Kid::Mcid(mcid));
                        by_mcid.push(holder);
                        last_span = None;
                    }
                    Some(script) => {
                        // Runs of one span next to each other are one element.
                        let span_elem = match last_span {
                            Some((o, e)) if o == *owner => e,
                            _ => {
                                let mut e = Element::new("Span", page_ref);
                                e.lang = Some(script.lang().into());
                                elements.push(e);
                                let e = elements.len() - 1;
                                elements[holder].kids.push(Kid::Element(e));
                                report.spans += 1;
                                e
                            }
                        };
                        elements[span_elem].kids.push(Kid::Mcid(mcid));
                        by_mcid.push(span_elem);
                        last_span = Some((*owner, span_elem));
                    }
                }
            }
            let key = next_key;
            next_key += 1;
            pending_parent.push((key, by_mcid));

            // Annotations: each its own element, inside the block it sits on.
            let annots: Vec<(Option<ObjectId>, Dictionary)> = self
                .page_annotations(*page_id)
                .into_iter()
                .map(|(id, d)| (id, d.clone()))
                .collect();
            for (annot_id, annot) in annots {
                let Some(annot_id) = annot_id else {
                    continue;
                };
                let Some(role) = annotation_role(name(annot.get(b"Subtype").ok()).unwrap_or(b""))
                else {
                    continue;
                };
                let flags = annot
                    .get(b"F")
                    .ok()
                    .and_then(|f| f.as_i64().ok())
                    .unwrap_or(0);
                if flags & 2 != 0 {
                    continue;
                }
                let mut e = Element::new(role, page_ref);
                e.kids.push(Kid::Annot(annot_id, *page_id));
                if let Some(text) = annot
                    .get(b"Contents")
                    .ok()
                    .and_then(|c| c.as_str().ok())
                    .map(decode_text_string)
                    .or_else(|| {
                        annot
                            .get(b"TU")
                            .ok()
                            .and_then(|c| c.as_str().ok())
                            .map(decode_text_string)
                    })
                {
                    if role != "Link" {
                        e.alt = Some(text);
                    }
                }
                elements.push(e);
                let id = elements.len() - 1;
                // Inside the block under its middle, else after the page's blocks.
                let holder = self
                    .rect(annot.get(b"Rect").ok())
                    .map(|r| bbox_of(to_shown, r))
                    .and_then(|r| {
                        let c = ((r[0] + r[2]) / 2.0, (r[1] + r[3]) / 2.0);
                        blocks
                            .iter()
                            .enumerate()
                            .find(|(_, b)| b.role != "Artifact" && inside(c, b.rect, 2.0))
                            .and_then(|(i, _)| block_elem[i])
                    })
                    .unwrap_or(0);
                elements[holder].kids.push(Kid::Element(id));
                let key = next_key;
                next_key += 1;
                pending_annot.push((key, id));
                if let Ok(a) = self.doc.get_dictionary_mut(annot_id) {
                    a.set("StructParent", key);
                }
                self.mark_touched(annot_id);
                report.annotations += 1;
            }

            let page = self
                .doc
                .get_dictionary_mut(*page_id)
                .map_err(|e| Error::Parse(e.to_string()))?;
            page.set("Contents", contents);
            page.set("StructParents", key);
            page.set("Tabs", Object::Name(b"S".to_vec()));
            self.mark_touched(*page_id);
        }

        // Objects for the elements; the tree's root.
        let root_id = self.doc.new_object_id();
        let ids: Vec<ObjectId> = elements.iter().map(|_| self.doc.new_object_id()).collect();
        let parent_of: HashMap<usize, usize> = elements
            .iter()
            .enumerate()
            .flat_map(|(p, e)| {
                e.kids.iter().filter_map(move |k| match k {
                    Kid::Element(c) => Some((*c, p)),
                    _ => None,
                })
            })
            .collect();
        for (i, e) in elements.iter().enumerate() {
            let kids: Vec<Object> = e
                .kids
                .iter()
                .map(|k| match k {
                    Kid::Mcid(m) => Object::Integer(*m),
                    Kid::Element(c) => Object::Reference(ids[*c]),
                    Kid::Annot(a, pg) => Object::Dictionary(dictionary! {
                        "Type" => "OBJR",
                        "Obj" => *a,
                        "Pg" => *pg,
                    }),
                })
                .collect();
            let mut d = dictionary! {
                "Type" => "StructElem",
                "S" => Object::Name(e.s.as_bytes().to_vec()),
                "P" => Object::Reference(parent_of.get(&i).map(|p| ids[*p]).unwrap_or(root_id)),
            };
            if !kids.is_empty() {
                d.set("K", kids);
            }
            if let Some(pg) = e.page {
                d.set("Pg", pg);
            }
            if let Some(l) = &e.lang {
                d.set("Lang", Object::string_literal(l.as_str()));
            }
            if let Some(a) = &e.alt {
                d.set("Alt", lopdf::text_string(a));
            }
            if let Some(a) = &e.attrs {
                d.set("A", Object::Dictionary(a.clone()));
            }
            self.doc.objects.insert(ids[i], Object::Dictionary(d));
        }
        report.elements = elements.len();
        for (key, by_mcid) in pending_parent {
            parents.push((
                key,
                Object::Array(by_mcid.iter().map(|e| Object::Reference(ids[*e])).collect()),
            ));
        }
        for (key, e) in pending_annot {
            parents.push((key, Object::Reference(ids[e])));
        }
        parents.sort_by_key(|(k, _)| *k);
        let nums: Vec<Object> = parents
            .into_iter()
            .flat_map(|(k, v)| [Object::Integer(k), v])
            .collect();
        let parent_tree = self.doc.add_object(dictionary! { "Nums" => nums });
        self.doc.objects.insert(
            root_id,
            Object::Dictionary(dictionary! {
                "Type" => "StructTreeRoot",
                "K" => Object::Reference(ids[0]),
                "ParentTree" => parent_tree,
                "ParentTreeNextKey" => next_key,
            }),
        );
        let catalog_id = self.root_id()?;
        let catalog = self
            .doc
            .get_dictionary_mut(catalog_id)
            .map_err(|e| Error::Parse(e.to_string()))?;
        catalog.set("StructTreeRoot", root_id);
        catalog.set("MarkInfo", dictionary! { "Marked" => true });
        if !root_lang.is_empty() {
            catalog.set("Lang", Object::string_literal(root_lang.as_str()));
        }
        self.mark_touched(catalog_id);
        if let Some(title) = plan.title.as_deref().filter(|t| !t.trim().is_empty()) {
            self.set_title(title)?;
        }
        self.set_display_doc_title()?;
        Ok(report)
    }

    /// The document's title, in its information dictionary and its XMP.
    pub fn set_title(&mut self, title: &str) -> Result<()> {
        match self
            .doc
            .trailer
            .get(b"Info")
            .ok()
            .and_then(|i| i.as_reference().ok())
        {
            Some(id) => {
                if let Ok(info) = self.doc.get_dictionary_mut(id) {
                    info.set("Title", lopdf::text_string(title));
                }
                self.mark_touched(id);
            }
            None => {
                let id = self
                    .doc
                    .add_object(dictionary! { "Title" => lopdf::text_string(title) });
                self.doc.trailer.set("Info", id);
            }
        }
        let catalog_id = self.root_id()?;
        let meta_id = self
            .doc
            .get_dictionary(catalog_id)
            .ok()
            .and_then(|c| c.get(b"Metadata").ok())
            .and_then(|m| m.as_reference().ok());
        if let Some(meta_id) = meta_id {
            let packet = self
                .doc
                .get_object(meta_id)
                .ok()
                .and_then(|o| o.as_stream().ok())
                .map(|s| {
                    s.decompressed_content_with_limit(8 << 20)
                        .unwrap_or_else(|_| s.content.clone())
                })
                .map(|b| String::from_utf8_lossy(&b).into_owned());
            if let Some(updated) = packet.and_then(|p| super::xmp::with_title(&p, title)) {
                if let Ok(Object::Stream(s)) = self.doc.get_object_mut(meta_id) {
                    s.dict.remove(b"Filter");
                    s.dict.remove(b"DecodeParms");
                    s.set_plain_content(updated.into_bytes());
                }
                self.mark_touched(meta_id);
            }
        }
        Ok(())
    }

    /// Viewers show the title, not the file's name (PDF/UA-1 §7.1).
    pub fn set_display_doc_title(&mut self) -> Result<()> {
        let catalog_id = self.root_id()?;
        let prefs = self
            .doc
            .get_dictionary(catalog_id)
            .ok()
            .and_then(|c| c.get(b"ViewerPreferences").ok())
            .cloned();
        match prefs {
            Some(Object::Reference(id)) => {
                if let Ok(p) = self.doc.get_dictionary_mut(id) {
                    p.set("DisplayDocTitle", true);
                }
                self.mark_touched(id);
            }
            other => {
                let mut p = match other {
                    Some(Object::Dictionary(d)) => d,
                    _ => Dictionary::new(),
                };
                p.set("DisplayDocTitle", true);
                if let Ok(c) = self.doc.get_dictionary_mut(catalog_id) {
                    c.set("ViewerPreferences", Object::Dictionary(p));
                }
            }
        }
        self.mark_touched(catalog_id);
        Ok(())
    }

    /// The document's language (BCP 47).
    pub fn set_language(&mut self, lang: &str) -> Result<()> {
        let catalog_id = self.root_id()?;
        if let Ok(c) = self.doc.get_dictionary_mut(catalog_id) {
            c.set("Lang", Object::string_literal(lang));
        }
        self.mark_touched(catalog_id);
        Ok(())
    }

    /// Every page with annotations reads them in structure order.
    pub fn set_tab_order(&mut self) -> usize {
        let mut set = 0;
        for page in self.pages.clone() {
            let needs = self
                .doc
                .get_dictionary(page)
                .ok()
                .is_some_and(|d| d.has(b"Annots") && name(d.get(b"Tabs").ok()) != Some(b"S"));
            if needs {
                if let Ok(d) = self.doc.get_dictionary_mut(page) {
                    d.set("Tabs", Object::Name(b"S".to_vec()));
                }
                self.mark_touched(page);
                set += 1;
            }
        }
        set
    }

    /// Form fields with no tooltip get their name as one: what a screen
    /// reader says for the field.
    pub fn set_field_tooltips(&mut self) -> usize {
        let fields: Vec<ObjectId> = self
            .doc
            .objects
            .iter()
            .filter(|(_, o)| {
                o.as_dict().is_ok_and(|d| {
                    (d.has(b"FT") || name(d.get(b"Subtype").ok()) == Some(b"Widget"))
                        && d.has(b"T")
                        && !d.has(b"TU")
                })
            })
            .map(|(id, _)| *id)
            .collect();
        let mut set = 0;
        for id in fields {
            let Ok(d) = self.doc.get_dictionary_mut(id) else {
                continue;
            };
            let Some(label) = d
                .get(b"T")
                .ok()
                .and_then(|t| t.as_str().ok())
                .map(decode_text_string)
                .map(|t| t.replace(['_', '.'], " ").trim().to_string())
                .filter(|t| !t.is_empty())
            else {
                continue;
            };
            d.set("TU", lopdf::text_string(&label));
            self.mark_touched(id);
            set += 1;
        }
        set
    }

    /// Bookmarks from the headings of the structure tree, for a long
    /// document without any. `0` when it has bookmarks or no headings.
    pub fn bookmarks_from_headings(&mut self) -> usize {
        let catalog_id = match self.root_id() {
            Ok(id) => id,
            Err(_) => return 0,
        };
        if self
            .doc
            .get_dictionary(catalog_id)
            .ok()
            .is_some_and(|c| c.has(b"Outlines"))
        {
            return 0;
        }
        let headings: Vec<(usize, u8, String)> = self
            .structure_leaves()
            .into_iter()
            .filter_map(|l| {
                let level = l
                    .role
                    .strip_prefix('H')
                    .and_then(|n| n.parse::<u8>().ok())?;
                Some((l.page, level.min(2), l.text.clone().unwrap_or_default()))
            })
            .filter(|(_, _, t)| !t.trim().is_empty())
            .take(500)
            .collect();
        if headings.is_empty() {
            return 0;
        }
        let outlines = self.doc.new_object_id();
        let ids: Vec<ObjectId> = headings.iter().map(|_| self.doc.new_object_id()).collect();
        // Level 1 headings at the top; level 2 under the one before them.
        let mut parent_of: Vec<Option<usize>> = vec![];
        let mut last_top: Option<usize> = None;
        for (i, (_, level, _)) in headings.iter().enumerate() {
            if *level <= 1 {
                last_top = Some(i);
                parent_of.push(None);
            } else {
                parent_of.push(last_top);
            }
        }
        let children = |p: Option<usize>| -> Vec<usize> {
            (0..headings.len()).filter(|i| parent_of[*i] == p).collect()
        };
        for (i, (page, _, text)) in headings.iter().enumerate() {
            let siblings = children(parent_of[i]);
            let at = siblings.iter().position(|s| *s == i).unwrap_or(0);
            let mut d = dictionary! {
                "Title" => lopdf::text_string(text.trim()),
                "Parent" => parent_of[i].map(|p| ids[p]).unwrap_or(outlines),
                "Dest" => vec![Object::Reference(self.pages[*page]), Object::Name(b"Fit".to_vec())],
            };
            if at > 0 {
                d.set("Prev", ids[siblings[at - 1]]);
            }
            if let Some(next) = siblings.get(at + 1) {
                d.set("Next", ids[*next]);
            }
            let kids = children(Some(i));
            if let (Some(first), Some(last)) = (kids.first(), kids.last()) {
                d.set("First", ids[*first]);
                d.set("Last", ids[*last]);
                d.set("Count", -(kids.len() as i64));
            }
            self.doc.objects.insert(ids[i], Object::Dictionary(d));
        }
        let top = children(None);
        self.doc.objects.insert(
            outlines,
            Object::Dictionary(dictionary! {
                "Type" => "Outlines",
                "First" => ids[top[0]],
                "Last" => ids[*top.last().unwrap_or(&top[0])],
                "Count" => top.len() as i64,
            }),
        );
        if let Ok(c) = self.doc.get_dictionary_mut(catalog_id) {
            c.set("Outlines", outlines);
        }
        self.mark_touched(catalog_id);
        headings.len()
    }

    /// Sets figures' alternative text, by the id of their element.
    pub fn set_alt_texts(&mut self, alts: &[(ObjectId, String)]) -> usize {
        let mut set = 0;
        for (id, alt) in alts {
            let Ok(d) = self.doc.get_dictionary_mut(*id) else {
                continue;
            };
            if name(d.get(b"Type").ok()).is_some_and(|t| t != b"StructElem") {
                continue;
            }
            if alt.trim().is_empty() {
                d.remove(b"Alt");
            } else {
                d.set("Alt", lopdf::text_string(alt.trim()));
            }
            self.mark_touched(*id);
            set += 1;
        }
        set
    }
}

/// A leaf of an existing structure tree: an element with content of its
/// own, in reading order.
#[derive(Debug, Clone, PartialEq)]
pub struct Leaf {
    pub id: Option<ObjectId>,
    /// Its standard role (through the role map).
    pub role: String,
    pub page: usize,
    pub mcids: Vec<i64>,
    pub alt: Option<String>,
    pub lang: Option<String>,
    /// `/ActualText` or, for headings, filled in by whoever knows the text.
    pub text: Option<String>,
    /// The list it is in, and the table, row and column.
    pub list: Option<u32>,
    pub cell: Option<(u32, usize, usize)>,
}

/// Roles PDF 1.7 defines; anything else goes through the role map.
const STANDARD: &[&str] = &[
    "Document",
    "Part",
    "Art",
    "Sect",
    "Div",
    "BlockQuote",
    "Caption",
    "TOC",
    "TOCI",
    "Index",
    "NonStruct",
    "Private",
    "P",
    "H",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "L",
    "LI",
    "Lbl",
    "LBody",
    "Table",
    "TR",
    "TH",
    "TD",
    "THead",
    "TBody",
    "TFoot",
    "Span",
    "Quote",
    "Note",
    "Reference",
    "BibEntry",
    "Code",
    "Link",
    "Annot",
    "Ruby",
    "RB",
    "RT",
    "RP",
    "Warichu",
    "WT",
    "WP",
    "Figure",
    "Formula",
    "Form",
];

impl PdfDocument {
    /// The structure tree's content-bearing elements in reading order, or
    /// nothing when the file has no tree. Bounded: a hostile tree can loop.
    pub fn structure_leaves(&self) -> Vec<Leaf> {
        let doc = &self.doc;
        let Some(root) = doc
            .catalog()
            .ok()
            .and_then(|c| dict_of(doc, c.get(b"StructTreeRoot").ok()))
        else {
            return vec![];
        };
        let role_map = dict_of(doc, root.get(b"RoleMap").ok());
        let standard = |s: &[u8]| -> String {
            let mut s = s.to_vec();
            for _ in 0..8 {
                let text = String::from_utf8_lossy(&s).into_owned();
                if STANDARD.contains(&text.as_str()) {
                    return text;
                }
                match role_map.and_then(|m| name(m.get(&s).ok())) {
                    Some(next) => s = next.to_vec(),
                    None => break,
                }
            }
            "P".into()
        };
        let pages: HashMap<ObjectId, usize> = self
            .pages
            .iter()
            .enumerate()
            .map(|(i, p)| (*p, i))
            .collect();
        let mut out = vec![];
        let mut seen: BTreeSet<ObjectId> = BTreeSet::new();
        let mut lists = 0u32;
        let mut tables = 0u32;
        struct Ctx {
            page: Option<usize>,
            list: Option<u32>,
            table: Option<u32>,
            row: usize,
            col: usize,
        }
        #[allow(clippy::too_many_arguments)]
        fn visit(
            pdf: &PdfDocument,
            object: &Object,
            depth: usize,
            ctx: &mut Ctx,
            out: &mut Vec<Leaf>,
            seen: &mut BTreeSet<ObjectId>,
            pages: &HashMap<ObjectId, usize>,
            standard: &dyn Fn(&[u8]) -> String,
            lists: &mut u32,
            tables: &mut u32,
        ) {
            let doc = &pdf.doc;
            if depth > 64 || out.len() > 100_000 {
                return;
            }
            let id = object.as_reference().ok();
            if let Some(id) = id {
                if !seen.insert(id) {
                    return;
                }
            }
            let Some(d) = dict_of(doc, Some(object)) else {
                return;
            };
            let role = standard(name(d.get(b"S").ok()).unwrap_or(b"P"));
            let page = d
                .get(b"Pg")
                .ok()
                .and_then(|p| p.as_reference().ok())
                .and_then(|p| pages.get(&p).copied())
                .or(ctx.page);
            let saved = (ctx.page, ctx.list, ctx.table, ctx.row, ctx.col);
            ctx.page = page;
            match role.as_str() {
                "L" => {
                    *lists += 1;
                    ctx.list = Some(*lists);
                }
                "Table" => {
                    *tables += 1;
                    ctx.table = Some(*tables);
                    ctx.row = 0;
                }
                "TR" => ctx.col = 0,
                _ => {}
            }
            let kids: Vec<Object> = match d.get(b"K").map(|k| resolve(doc, k)) {
                Ok(Object::Array(a)) => a.clone(),
                Ok(_) => vec![d.get(b"K").cloned().unwrap_or(Object::Null)],
                Err(_) => vec![],
            };
            let mut leaf = Leaf {
                id,
                role: role.clone(),
                page: page.unwrap_or(0),
                mcids: vec![],
                alt: d
                    .get(b"Alt")
                    .ok()
                    .and_then(|a| a.as_str().ok())
                    .map(decode_text_string),
                lang: d
                    .get(b"Lang")
                    .ok()
                    .and_then(|a| a.as_str().ok())
                    .map(decode_text_string),
                text: d
                    .get(b"ActualText")
                    .ok()
                    .and_then(|a| a.as_str().ok())
                    .map(decode_text_string),
                list: ctx.list,
                cell: match role.as_str() {
                    "TH" | "TD" => ctx.table.map(|t| (t, ctx.row, ctx.col)),
                    _ => None,
                },
            };
            let mut pushed = false;
            for kid in kids {
                match &kid {
                    Object::Integer(m) => leaf.mcids.push(*m),
                    other => {
                        let is_mcr = dict_of(doc, Some(other))
                            .is_some_and(|k| name(k.get(b"Type").ok()) == Some(b"MCR"));
                        if is_mcr {
                            if let Some(m) = dict_of(doc, Some(other))
                                .and_then(|k| k.get(b"MCID").ok())
                                .and_then(|m| m.as_i64().ok())
                            {
                                leaf.mcids.push(m);
                            }
                            continue;
                        }
                        let is_objr = dict_of(doc, Some(other))
                            .is_some_and(|k| name(k.get(b"Type").ok()) == Some(b"OBJR"));
                        if is_objr {
                            continue;
                        }
                        // Content before a child element is read before it.
                        if !leaf.mcids.is_empty() && !pushed {
                            out.push(leaf.clone());
                            leaf.mcids.clear();
                            pushed = true;
                        }
                        visit(
                            pdf,
                            other,
                            depth + 1,
                            ctx,
                            out,
                            seen,
                            pages,
                            standard,
                            lists,
                            tables,
                        );
                    }
                }
            }
            if !leaf.mcids.is_empty() {
                out.push(leaf);
            }
            match role.as_str() {
                "TR" => {
                    ctx.row += 1;
                    let row = ctx.row;
                    (ctx.page, ctx.list, ctx.table) = (saved.0, saved.1, saved.2);
                    ctx.row = row;
                    ctx.col = saved.4;
                }
                "TH" | "TD" => {
                    let (row, col) = (ctx.row, ctx.col + 1);
                    (ctx.page, ctx.list, ctx.table) = (saved.0, saved.1, saved.2);
                    ctx.row = row;
                    ctx.col = col;
                }
                "Table" => {
                    (ctx.page, ctx.list, ctx.table, ctx.row, ctx.col) = saved;
                }
                _ => {
                    let (row, col) = (ctx.row, ctx.col);
                    (ctx.page, ctx.list, ctx.table) = (saved.0, saved.1, saved.2);
                    ctx.row = row;
                    ctx.col = col;
                }
            }
        }
        let mut ctx = Ctx {
            page: None,
            list: None,
            table: None,
            row: 0,
            col: 0,
        };
        if let Ok(k) = root.get(b"K") {
            let kids = match resolve(doc, k) {
                Object::Array(a) => a.clone(),
                _ => vec![k.clone()],
            };
            for kid in kids {
                visit(
                    self,
                    &kid,
                    0,
                    &mut ctx,
                    &mut out,
                    &mut seen,
                    &pages,
                    &standard,
                    &mut lists,
                    &mut tables,
                );
            }
        }
        out
    }

    /// Whether the file says it is tagged: a structure tree, and `Marked`.
    pub fn is_tagged(&self) -> bool {
        self.doc.catalog().ok().is_some_and(|c| {
            c.has(b"StructTreeRoot")
                && dict_of(&self.doc, c.get(b"MarkInfo").ok())
                    .and_then(|m| m.get(b"Marked").ok())
                    .and_then(|m| m.as_bool().ok())
                    == Some(true)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn corpus(name: &str) -> Vec<u8> {
        std::fs::read(format!(
            "{}/../../../tests/corpus/arabic/{name}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap()
    }

    #[test]
    fn scripts_are_told_apart() {
        assert_eq!(script_of("فاتورة ضريبية"), Some(Script::Arabic));
        assert_eq!(script_of("Warraq Pro"), Some(Script::Latin));
        assert_eq!(script_of("1,200.00 | 12"), None);
        assert_eq!(script_of("a"), None);
        assert_eq!(script_of_lang("ar-SA"), Some(Script::Arabic));
        assert_eq!(script_of_lang("en"), Some(Script::Latin));
    }

    #[test]
    fn a_page_is_tagged_and_the_tree_reads_back_in_order() {
        let mut doc =
            PdfDocument::open(corpus("generated/chrome-cairo-mixed-invoice.pdf"), None).unwrap();
        let (w, h) = doc.page_size(0).unwrap();
        // Two blocks: the top third a heading, the rest one paragraph.
        let plan = TagPlan {
            pages: vec![vec![
                Block::new("H1", [0.0, 0.0, w, h / 3.0]),
                Block::new("P", [0.0, h / 3.0, w, h]),
            ]],
            lang: "ar".into(),
            title: Some("فاتورة".into()),
        };
        let report = doc.apply_tags(&plan).unwrap();
        assert!(report.sequences > 0 && report.elements >= 3, "{report:?}");
        let bytes = doc.save_incremental().unwrap();
        let again = PdfDocument::open(bytes, None).unwrap();
        assert!(again.is_tagged());
        let leaves = again.structure_leaves();
        assert_eq!(leaves.first().map(|l| l.role.as_str()), Some("H1"));
        assert!(leaves.iter().any(|l| l.role == "P"));
        // Latin text in the Arabic paragraph is a span in English.
        assert!(report.spans > 0, "{report:?}");
        // Every painting operator is tagged or an artifact.
        let scan = again.scan_content(super::super::scan::ScanOptions::default());
        assert_eq!(scan.pages[0].untagged, 0, "{:?}", scan.pages[0]);
        assert_eq!(again.metadata().title.as_deref(), Some("فاتورة"));
    }

    #[test]
    fn tagging_again_replaces_the_old_tags() {
        let mut doc =
            PdfDocument::open(corpus("generated/chrome-cairo-mixed-invoice.pdf"), None).unwrap();
        let (w, h) = doc.page_size(0).unwrap();
        let one = TagPlan {
            pages: vec![vec![Block::new("P", [0.0, 0.0, w, h])]],
            lang: "ar".into(),
            title: None,
        };
        doc.apply_tags(&one).unwrap();
        let bytes = doc.save_incremental().unwrap();
        let mut doc = PdfDocument::open(bytes, None).unwrap();
        let two = TagPlan {
            pages: vec![vec![
                Block::new("P", [0.0, h / 2.0, w, h]),
                Block::new("H2", [0.0, 0.0, w, h / 2.0]),
            ]],
            lang: "ar".into(),
            title: None,
        };
        doc.apply_tags(&two).unwrap();
        let bytes = doc.save_incremental().unwrap();
        let doc = PdfDocument::open(bytes, None).unwrap();
        let leaves = doc.structure_leaves();
        // The order is the plan's, not the page's.
        assert_eq!(leaves[0].role, "P");
        assert!(leaves.iter().any(|l| l.role == "H2"));
        let content = doc.doc.get_page_content(doc.pages[0]);
        let ops = Content::decode(&content).unwrap().operations;
        let mcids: Vec<i64> = ops
            .iter()
            .filter(|o| o.operator == "BDC")
            .filter_map(|o| {
                o.operands
                    .get(1)
                    .and_then(|p| p.as_dict().ok())
                    .and_then(|p| p.get(b"MCID").ok())
                    .and_then(|m| m.as_i64().ok())
            })
            .collect();
        let unique: BTreeSet<i64> = mcids.iter().copied().collect();
        assert_eq!(unique.len(), mcids.len(), "each MCID once");
        let depth = ops
            .iter()
            .fold((0i32, true), |(d, ok), o| match o.operator.as_str() {
                "BMC" | "BDC" => (d + 1, ok),
                "EMC" => (d - 1, ok && d > 0),
                _ => (d, ok),
            });
        assert!(depth.1 && depth.0 == 0, "balanced marked content");
    }
}
