//! Byte-faithful content-stream rewriter used by redaction and by "remove hidden information".
//!
//! The stream is split into operations with their exact byte ranges (`ContentParser::next_spanned`
//! from warraq-text, the same lexer the text extractor uses). Operations that are not affected are
//! copied verbatim; affected ones are replaced:
//!
//! * **Text** (`Tj TJ ' "`): every glyph whose box overlaps a redaction area (≥ 20 % of the glyph
//!   box, or its origin inside the area for zero-area marks such as tashkeel), every glyph inside
//!   hidden optional content, and — when asked — invisible (`Tr 3/7`), off-page or tiny glyphs are
//!   removed. The operation is rewritten as a `TJ` array whose numeric adjustments equal the removed
//!   glyphs' advances, so every remaining glyph keeps its exact position. `/ActualText`, `/Alt`
//!   and `/E` of marked content that lost glyphs are dropped (`BDC` → `BMC`).
//! * **Paths**: painted paths fully inside an area are removed; partly covered ones are painted
//!   through an exclusion clip (`q … W* n … Q`, one clip per area so overlapping areas stay
//!   excluded); clipping paths are kept as clips.
//! * **Images**: fully covered images are removed; partly covered ones are decoded, the covered
//!   pixels cleared and the image re-encoded as a new object (see [`crate::image`]); images that
//!   cannot be decoded safely are removed and reported. Inline images likewise.
//! * **Form XObjects** are rewritten recursively into new objects (the original may be shared).
//! * **Shadings** (`sh`) are painted through the exclusion clip.
//!
//! Everything is bounded: operators per stream, form depth, `q` depth, image sizes.

use std::collections::{HashMap, HashSet};
use std::ops::Range;
use std::rc::Rc;

use lopdf::{Dictionary, Object, ObjectId};
use serde::Serialize;
use warraq_text::font::{Font, FontKey};
use warraq_text::geom::{Matrix, Rect};
use warraq_text::lexer::{ContentParser, Op, Operand};
use warraq_text::source::{dict_get, resolve, resolve_dict, stream_data, ContentSource};

use crate::image::{redact_inline, redact_xobject, Outcome};
use crate::ocg::OcState;
use crate::util::{
    contains, flate_stream, hex_string, intersects, invert, matrix_ops, name_of, num, overlap_area,
    transform_rect,
};

/// Operators processed per content stream (including nested forms).
pub const MAX_OPS: usize = 5_000_000;
/// Form XObject nesting examined.
pub const MAX_FORM_DEPTH: usize = 12;
/// Saved graphics states tracked.
pub const MAX_Q_DEPTH: usize = 256;
/// Fraction of a glyph box that must be covered for the glyph to be removed.
pub const GLYPH_COVERAGE: f64 = 0.2;

/// "Hidden text" heuristics for sanitising.
#[derive(Debug, Clone, Copy)]
pub struct HiddenText {
    /// Glyphs whose box does not touch this box (the page's crop box) are removed.
    pub page_box: Rect,
    /// Glyphs whose effective size is below this (points) are removed.
    pub min_size: f64,
}

/// What the rewriter removed.
#[derive(Debug, Default, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContentReport {
    pub glyphs_removed: usize,
    pub hidden_glyphs_removed: usize,
    pub actual_text_cleared: usize,
    pub paths_removed: usize,
    pub paths_clipped: usize,
    pub shadings_clipped: usize,
    pub images_redacted: usize,
    pub images_removed: usize,
    pub inline_images_redacted: usize,
    pub inline_images_removed: usize,
    pub forms_rewritten: usize,
    pub hidden_layer_items_removed: usize,
    /// Content not examined because a limit was hit (it was dropped, not kept).
    pub truncated: bool,
    /// Why images had to be removed instead of redacted.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub undecodable: Vec<String>,
}

impl ContentReport {
    /// Anything removed at all.
    pub fn any(&self) -> bool {
        *self != ContentReport::default()
    }

    /// Add another report.
    pub fn add(&mut self, o: &ContentReport) {
        self.glyphs_removed += o.glyphs_removed;
        self.hidden_glyphs_removed += o.hidden_glyphs_removed;
        self.actual_text_cleared += o.actual_text_cleared;
        self.paths_removed += o.paths_removed;
        self.paths_clipped += o.paths_clipped;
        self.shadings_clipped += o.shadings_clipped;
        self.images_redacted += o.images_redacted;
        self.images_removed += o.images_removed;
        self.inline_images_redacted += o.inline_images_redacted;
        self.inline_images_removed += o.inline_images_removed;
        self.forms_rewritten += o.forms_rewritten;
        self.hidden_layer_items_removed += o.hidden_layer_items_removed;
        self.truncated |= o.truncated;
        for u in &o.undecodable {
            if self.undecodable.len() < 32 && !self.undecodable.contains(u) {
                self.undecodable.push(u.clone());
            }
        }
    }
}

/// A rewritten content stream.
#[derive(Debug)]
pub struct Rewritten {
    /// The new content (the input bytes when nothing changed).
    pub content: Vec<u8>,
    pub changed: bool,
    /// New `/XObject` resources (name → new object) the content refers to.
    pub additions: Vec<(Vec<u8>, ObjectId)>,
    /// `/XObject` names the new content still draws (entries not in here must be dropped from
    /// the resources, or a removed image would survive in the file).
    pub used: HashSet<Vec<u8>>,
    /// `/Properties` names the new content still refers to.
    pub used_props: HashSet<Vec<u8>>,
    /// `q` operators left open at the end.
    pub open_q: usize,
}

#[derive(Clone)]
struct GState {
    ctm: Matrix,
    font: Option<Rc<Font>>,
    size: f64,
    tc: f64,
    tw: f64,
    th: f64,
    tl: f64,
    rise: f64,
    mode: i64,
    lw: f64,
}

impl GState {
    fn new(ctm: Matrix) -> Self {
        GState {
            ctm,
            font: None,
            size: 0.0,
            tc: 0.0,
            tw: 0.0,
            th: 1.0,
            tl: 0.0,
            rise: 0.0,
            mode: 0,
            lw: 1.0,
        }
    }
}

enum Piece {
    Keep(Range<usize>),
    New(Vec<u8>),
    Drop,
}

struct Mark {
    /// Piece index of a BDC whose properties carry /ActualText, /Alt or /E.
    bdc: Option<usize>,
    tag: Vec<u8>,
    glyph_removed: bool,
    /// This BDC opened a hidden optional-content section (its BDC/EMC pair is dropped).
    hidden_start: Option<usize>,
}

#[derive(Default)]
struct PathAcc {
    /// Construction operations (m l c v y h re).
    ranges: Vec<Range<usize>>,
    /// Piece indices of construction and clip operations.
    pieces: Vec<usize>,
    bbox: Option<Rect>,
    clip: Option<Vec<u8>>,
}

impl PathAcc {
    fn add_points(&mut self, ctm: &Matrix, pts: &[(f64, f64)]) {
        let t: Vec<(f64, f64)> = pts.iter().map(|&(x, y)| ctm.apply(x, y)).collect();
        let r = Rect::from_points(&t);
        self.bbox = Some(self.bbox.map_or(r, |b| b.union(&r)));
    }
}

enum TjItem {
    Bytes(Vec<u8>),
    Adj(f64),
}

fn push_bytes(items: &mut Vec<TjItem>, b: &[u8]) {
    if let Some(TjItem::Bytes(last)) = items.last_mut() {
        last.extend_from_slice(b);
    } else {
        items.push(TjItem::Bytes(b.to_vec()));
    }
}

fn push_adj(items: &mut Vec<TjItem>, v: f64) {
    if !v.is_finite() || v == 0.0 {
        return;
    }
    if let Some(TjItem::Adj(last)) = items.last_mut() {
        *last += v;
    } else {
        items.push(TjItem::Adj(v));
    }
}

fn tj_bytes(items: &[TjItem]) -> Vec<u8> {
    let mut s = String::from("[");
    for (i, it) in items.iter().enumerate() {
        if i > 0 {
            s.push(' ');
        }
        match it {
            TjItem::Bytes(b) => s.push_str(&hex_string(b)),
            TjItem::Adj(v) => s.push_str(&num(*v)),
        }
    }
    s.push_str("] TJ");
    s.into_bytes()
}

fn nums(ops: &[Operand]) -> Vec<f64> {
    ops.iter().filter_map(Operand::as_f64).collect()
}

/// Exclusion clip for `rects` (page space) under `ctm`: `inv cm (BIG re R re W* n)… ctm cm`.
fn exclusion_clip(ctm: &Matrix, rects: &[Rect]) -> Option<String> {
    let inv = invert(ctm)?;
    let mut s = format!("{} cm ", matrix_ops(&inv));
    for r in rects {
        s.push_str(&format!(
            "-100000 -100000 300000 300000 re {} {} {} {} re W* n ",
            num(r.x0),
            num(r.y0),
            num(r.x1 - r.x0),
            num(r.y1 - r.y0)
        ));
    }
    s.push_str(&format!("{} cm ", matrix_ops(ctm)));
    Some(s)
}

/// Keep only the `/XObject` entries the rewritten content still draws.
pub fn prune_xobjects(x: &mut Dictionary, used: &HashSet<Vec<u8>>) {
    let drop: Vec<Vec<u8>> = x
        .iter()
        .map(|(k, _)| k.clone())
        .filter(|k| !used.contains(k))
        .collect();
    for k in drop {
        x.remove(&k);
    }
}

/// The content rewriter. One per document (fonts are cached).
pub struct Rewriter<'s, S: ContentSource + ?Sized> {
    src: &'s S,
    rects: Vec<Rect>,
    hidden_text: Option<HiddenText>,
    oc: Option<OcState>,
    fonts: HashMap<FontKey, Rc<Font>>,
    /// What was removed so far.
    pub report: ContentReport,
    next_num: u32,
    /// Objects created by the rewrite (new images, new forms).
    pub new_objects: Vec<(ObjectId, Object)>,
    ops: usize,
    forms: Vec<ObjectId>,
}

impl<'s, S: ContentSource + ?Sized> Rewriter<'s, S> {
    /// `first_free` is the first unused object number of the document.
    pub fn new(src: &'s S, first_free: u32) -> Self {
        Rewriter {
            src,
            rects: Vec::new(),
            hidden_text: None,
            oc: None,
            fonts: HashMap::new(),
            report: ContentReport::default(),
            next_num: first_free.max(1),
            new_objects: Vec::new(),
            ops: 0,
            forms: Vec::new(),
        }
    }

    /// Redaction areas (page space) for the next [`Rewriter::rewrite`].
    pub fn set_rects(&mut self, rects: &[Rect]) {
        self.rects = rects
            .iter()
            .copied()
            .filter(crate::util::valid_rect)
            .collect();
    }

    /// Hidden-text heuristics for the next rewrite (`None` = keep hidden text).
    pub fn set_hidden_text(&mut self, h: Option<HiddenText>) {
        self.hidden_text = h;
    }

    /// Optional-content state: content in hidden layers is removed.
    pub fn set_oc(&mut self, oc: Option<OcState>) {
        self.oc = oc;
    }

    /// Next free object number after the rewrite.
    pub fn next_number(&self) -> u32 {
        self.next_num
    }

    fn alloc(&mut self, obj: Object) -> ObjectId {
        let id = (self.next_num, 0);
        self.next_num = self.next_num.saturating_add(1);
        self.new_objects.push((id, obj));
        id
    }

    fn font_for(&mut self, resources: &Dictionary, name: &[u8]) -> Option<Rc<Font>> {
        let src = self.src;
        let fonts = dict_get(src, resources, b"Font").and_then(|o| resolve_dict(src, o))?;
        let entry = fonts.get(name).ok()?;
        let dict = resolve_dict(src, entry)?;
        let key = Font::key_for(entry, dict);
        if let Some(f) = self.fonts.get(&key) {
            return Some(f.clone());
        }
        let f = Rc::new(Font::load(src, key, dict));
        if self.fonts.len() < 4096 {
            self.fonts.insert(key, f.clone());
        }
        Some(f)
    }

    fn oc_hidden(&self, oc: Option<&Object>) -> bool {
        match (&self.oc, oc) {
            (Some(st), Some(o)) => st.is_hidden(self.src, o),
            _ => false,
        }
    }

    /// Rewrite page content (`ctm` = identity for pages).
    pub fn rewrite(&mut self, content: &[u8], resources: &Dictionary, ctm: Matrix) -> Rewritten {
        self.ops = 0;
        self.forms.clear();
        self.walk(content, resources, GState::new(ctm), 0)
    }

    fn walk(
        &mut self,
        content: &[u8],
        resources: &Dictionary,
        initial: GState,
        depth: usize,
    ) -> Rewritten {
        let mut pieces: Vec<Piece> = Vec::new();
        let mut gs = initial;
        let mut stack: Vec<GState> = Vec::new();
        let mut qdepth = 0usize;
        let mut tm = Matrix::IDENTITY;
        let mut tlm = Matrix::IDENTITY;
        let mut marks: Vec<Mark> = Vec::new();
        let mut hidden_level: Option<usize> = None;
        let mut path = PathAcc::default();
        let mut changed = false;
        let mut additions: Vec<(Vec<u8>, ObjectId)> = Vec::new();
        let mut used: HashSet<Vec<u8>> = HashSet::new();
        let mut used_props: HashSet<Vec<u8>> = HashSet::new();
        let mut used_names: HashSet<Vec<u8>> = HashSet::new();
        let mut parser = ContentParser::new(content);

        while let Some((op, span)) = parser.next_spanned() {
            self.ops += 1;
            if self.ops > MAX_OPS {
                // Never keep content we did not examine.
                self.report.truncated = true;
                changed = true;
                break;
            }
            let o = op.operands.as_slice();
            let in_hidden = hidden_level.is_some();
            let idx = pieces.len();
            let bytes = content.get(span.clone()).unwrap_or(&[]);
            match op.operator.as_slice() {
                b"q" => {
                    if stack.len() < MAX_Q_DEPTH {
                        stack.push(gs.clone());
                    }
                    qdepth += 1;
                    pieces.push(Piece::Keep(span));
                }
                b"Q" => {
                    if let Some(s) = stack.pop() {
                        gs = s;
                    }
                    qdepth = qdepth.saturating_sub(1);
                    pieces.push(Piece::Keep(span));
                }
                b"cm" => {
                    if let [a, b, c, d, e, f] = nums(o).as_slice() {
                        gs.ctm = Matrix::new(*a, *b, *c, *d, *e, *f).then(&gs.ctm);
                    }
                    pieces.push(Piece::Keep(span));
                }
                b"w" => {
                    gs.lw = nums(o).first().copied().unwrap_or(1.0).abs();
                    pieces.push(Piece::Keep(span));
                }
                b"BT" => {
                    tm = Matrix::IDENTITY;
                    tlm = Matrix::IDENTITY;
                    pieces.push(Piece::Keep(span));
                }
                b"Tf" => {
                    if let [Operand::Name(n), size] = o {
                        gs.font = self
                            .font_for(resources, n)
                            .or_else(|| Some(Rc::new(Font::fallback())));
                        gs.size = size.as_f64().unwrap_or(0.0);
                    }
                    pieces.push(Piece::Keep(span));
                }
                b"Tc" => {
                    gs.tc = nums(o).first().copied().unwrap_or(0.0);
                    pieces.push(Piece::Keep(span));
                }
                b"Tw" => {
                    gs.tw = nums(o).first().copied().unwrap_or(0.0);
                    pieces.push(Piece::Keep(span));
                }
                b"Tz" => {
                    gs.th = nums(o).first().copied().unwrap_or(100.0) / 100.0;
                    pieces.push(Piece::Keep(span));
                }
                b"TL" => {
                    gs.tl = nums(o).first().copied().unwrap_or(0.0);
                    pieces.push(Piece::Keep(span));
                }
                b"Ts" => {
                    gs.rise = nums(o).first().copied().unwrap_or(0.0);
                    pieces.push(Piece::Keep(span));
                }
                b"Tr" => {
                    gs.mode = nums(o).first().copied().unwrap_or(0.0) as i64;
                    pieces.push(Piece::Keep(span));
                }
                b"Td" | b"TD" => {
                    if let [tx, ty] = nums(o).as_slice() {
                        if op.operator == b"TD" {
                            gs.tl = -ty;
                        }
                        tlm = Matrix::translate(*tx, *ty).then(&tlm);
                        tm = tlm;
                    }
                    pieces.push(Piece::Keep(span));
                }
                b"Tm" => {
                    if let [a, b, c, d, e, f] = nums(o).as_slice() {
                        tlm = Matrix::new(*a, *b, *c, *d, *e, *f);
                        tm = tlm;
                    }
                    pieces.push(Piece::Keep(span));
                }
                b"T*" => {
                    tlm = Matrix::translate(0.0, -gs.tl).then(&tlm);
                    tm = tlm;
                    pieces.push(Piece::Keep(span));
                }
                b"Tj" | b"'" | b"\"" | b"TJ" => {
                    let mut prefix = String::new();
                    if op.operator == b"'" || op.operator == b"\"" {
                        if op.operator == b"\"" {
                            if let [aw, ac, _] = o {
                                gs.tw = aw.as_f64().unwrap_or(0.0);
                                gs.tc = ac.as_f64().unwrap_or(0.0);
                                prefix = format!("{} Tw {} Tc ", num(gs.tw), num(gs.tc));
                            }
                        }
                        prefix.push_str("T* ");
                        tlm = Matrix::translate(0.0, -gs.tl).then(&tlm);
                        tm = tlm;
                    }
                    let mut items = Vec::new();
                    let mut removed = 0usize;
                    let strings: Vec<&Operand> = match op.operator.as_slice() {
                        b"TJ" => match o.first() {
                            Some(Operand::Array(a)) => a.iter().collect(),
                            _ => Vec::new(),
                        },
                        b"\"" => o.get(2).into_iter().collect(),
                        _ => o.first().into_iter().collect(),
                    };
                    for item in strings {
                        match item {
                            Operand::Str(s) => {
                                removed +=
                                    self.show(&gs, &mut tm, s, &mut items, in_hidden, &mut marks);
                            }
                            Operand::Num(n) if op.operator == b"TJ" => {
                                let adj = -n / 1000.0 * gs.size;
                                let vertical = gs.font.as_ref().is_some_and(|f| f.vertical);
                                tm = if vertical {
                                    Matrix::translate(0.0, adj).then(&tm)
                                } else {
                                    Matrix::translate(adj * gs.th, 0.0).then(&tm)
                                };
                                push_adj(&mut items, *n);
                            }
                            _ => {}
                        }
                    }
                    if removed > 0 {
                        let mut out = prefix.into_bytes();
                        out.extend(tj_bytes(&items));
                        pieces.push(Piece::New(out));
                        changed = true;
                    } else {
                        pieces.push(Piece::Keep(span));
                    }
                }
                b"m" | b"l" => {
                    if let [x, y] = nums(o).as_slice() {
                        path.add_points(&gs.ctm, &[(*x, *y)]);
                    }
                    path.ranges.push(span.clone());
                    path.pieces.push(idx);
                    pieces.push(Piece::Keep(span));
                }
                b"c" | b"v" | b"y" => {
                    let v = nums(o);
                    let pts: Vec<(f64, f64)> = v
                        .chunks(2)
                        .filter_map(|c| match c {
                            [x, y] => Some((*x, *y)),
                            _ => None,
                        })
                        .collect();
                    path.add_points(&gs.ctm, &pts);
                    path.ranges.push(span.clone());
                    path.pieces.push(idx);
                    pieces.push(Piece::Keep(span));
                }
                b"re" => {
                    if let [x, y, w, h] = nums(o).as_slice() {
                        path.add_points(
                            &gs.ctm,
                            &[(*x, *y), (x + w, *y), (x + w, y + h), (*x, y + h)],
                        );
                    }
                    path.ranges.push(span.clone());
                    path.pieces.push(idx);
                    pieces.push(Piece::Keep(span));
                }
                b"h" => {
                    path.ranges.push(span.clone());
                    path.pieces.push(idx);
                    pieces.push(Piece::Keep(span));
                }
                b"W" | b"W*" => {
                    path.clip = Some(op.operator.clone());
                    path.pieces.push(idx);
                    pieces.push(Piece::Keep(span));
                }
                b"S" | b"s" | b"f" | b"F" | b"f*" | b"B" | b"B*" | b"b" | b"b*" | b"n" => {
                    let acc = std::mem::take(&mut path);
                    let action = self.paint(&op, &gs, &acc, in_hidden);
                    pieces.push(Piece::Keep(span));
                    if let Some(action) = action {
                        changed = true;
                        let path_src: Vec<u8> = acc
                            .ranges
                            .iter()
                            .flat_map(|r| {
                                let mut v = content.get(r.clone()).unwrap_or(&[]).to_vec();
                                v.push(b' ');
                                v
                            })
                            .collect();
                        let clip_again = acc.clip.as_ref().map(|c| {
                            let mut v = path_src.clone();
                            v.extend_from_slice(c);
                            v.extend_from_slice(b" n");
                            v
                        });
                        for p in &acc.pieces {
                            if let Some(slot) = pieces.get_mut(*p) {
                                *slot = Piece::Drop;
                            }
                        }
                        let new = match action {
                            PaintAction::Remove => clip_again.unwrap_or_default(),
                            PaintAction::Clip(prefix) => {
                                let mut v = b"q ".to_vec();
                                v.extend_from_slice(prefix.as_bytes());
                                v.extend_from_slice(&path_src);
                                v.extend_from_slice(&op.operator);
                                v.extend_from_slice(b" Q");
                                if let Some(c) = clip_again {
                                    v.push(b' ');
                                    v.extend(c);
                                }
                                v
                            }
                        };
                        if let Some(slot) = pieces.get_mut(idx) {
                            *slot = if new.is_empty() {
                                Piece::Drop
                            } else {
                                Piece::New(new)
                            };
                        }
                    }
                }
                b"sh" => {
                    if in_hidden {
                        self.report.hidden_layer_items_removed += 1;
                        pieces.push(Piece::Drop);
                        changed = true;
                    } else if !self.rects.is_empty() {
                        match exclusion_clip(&gs.ctm, &self.rects.clone()) {
                            Some(clip) => {
                                let mut v = b"q ".to_vec();
                                v.extend_from_slice(clip.as_bytes());
                                v.extend_from_slice(bytes);
                                v.extend_from_slice(b" Q");
                                pieces.push(Piece::New(v));
                            }
                            None => pieces.push(Piece::Drop),
                        }
                        self.report.shadings_clipped += 1;
                        changed = true;
                    } else {
                        pieces.push(Piece::Keep(span));
                    }
                }
                b"Do" => {
                    let name = match o.first() {
                        Some(Operand::Name(n)) => n.clone(),
                        _ => {
                            pieces.push(Piece::Keep(span));
                            continue;
                        }
                    };
                    match self.do_xobject(resources, &name, &gs, in_hidden, depth, &mut used_names)
                    {
                        DoAction::Keep => {
                            used.insert(name.clone());
                            pieces.push(Piece::Keep(span));
                        }
                        DoAction::Drop => {
                            pieces.push(Piece::Drop);
                            changed = true;
                        }
                        DoAction::Replace(new_name, id) => {
                            let mut v = b"/".to_vec();
                            v.extend_from_slice(&new_name);
                            v.extend_from_slice(b" Do");
                            pieces.push(Piece::New(v));
                            used.insert(new_name.clone());
                            additions.push((new_name, id));
                            changed = true;
                        }
                    }
                }
                b"BI" => {
                    let bbox = transform_rect(&gs.ctm, &Rect::new(0.0, 0.0, 1.0, 1.0));
                    let hits: Vec<Rect> = self
                        .rects
                        .iter()
                        .filter(|r| intersects(r, &bbox))
                        .copied()
                        .collect();
                    if in_hidden {
                        self.report.hidden_layer_items_removed += 1;
                        pieces.push(Piece::Drop);
                        changed = true;
                    } else if hits.is_empty() {
                        pieces.push(Piece::Keep(span));
                    } else if hits.iter().any(|r| contains(r, &bbox)) {
                        self.report.inline_images_removed += 1;
                        pieces.push(Piece::Drop);
                        changed = true;
                    } else {
                        match redact_inline(self.src, resources, bytes, &gs.ctm, &hits) {
                            Some(new) => {
                                self.report.inline_images_redacted += 1;
                                pieces.push(Piece::New(new));
                            }
                            None => {
                                self.report.inline_images_removed += 1;
                                pieces.push(Piece::Drop);
                            }
                        }
                        changed = true;
                    }
                }
                b"BMC" => {
                    let tag = o
                        .first()
                        .and_then(Operand::as_name)
                        .unwrap_or(b"Span")
                        .to_vec();
                    marks.push(Mark {
                        bdc: None,
                        tag,
                        glyph_removed: false,
                        hidden_start: None,
                    });
                    pieces.push(Piece::Keep(span));
                }
                b"BDC" => {
                    let tag = o
                        .first()
                        .and_then(Operand::as_name)
                        .unwrap_or(b"Span")
                        .to_vec();
                    let props = self.bdc_props(resources, o.get(1));
                    let mut bdc = None;
                    let was_hidden = hidden_level.is_some();
                    if let Some(p) = &props {
                        if tag == b"OC"
                            && hidden_level.is_none()
                            && self.oc_hidden(Some(&Object::Dictionary(p.clone())))
                        {
                            hidden_level = Some(marks.len());
                            self.report.hidden_layer_items_removed += 1;
                        }
                        if [&b"ActualText"[..], b"Alt", b"E"].iter().any(|k| p.has(k)) {
                            bdc = Some(idx);
                        }
                    }
                    // `/OC /name BDC` refers to an OCG/OCMD object: evaluate the reference itself.
                    if tag == b"OC" && hidden_level.is_none() {
                        if let Some(Operand::Name(n)) = o.get(1) {
                            let r = self.property_entry(resources, n);
                            if self.oc_hidden(r.as_ref()) {
                                hidden_level = Some(marks.len());
                                self.report.hidden_layer_items_removed += 1;
                            }
                        }
                    }
                    let hidden_start = (!was_hidden && hidden_level.is_some()).then_some(idx);
                    if hidden_start.is_none() {
                        if let Some(Operand::Name(n)) = o.get(1) {
                            used_props.insert(n.clone());
                        }
                    }
                    marks.push(Mark {
                        bdc,
                        tag,
                        glyph_removed: false,
                        hidden_start,
                    });
                    pieces.push(Piece::Keep(span));
                }
                b"EMC" => {
                    if let Some(m) = marks.pop() {
                        if let (Some(p), true) = (m.bdc, m.glyph_removed) {
                            if let Some(slot) = pieces.get_mut(p) {
                                let mut v = b"/".to_vec();
                                v.extend_from_slice(&m.tag);
                                v.extend_from_slice(b" BMC");
                                *slot = Piece::New(v);
                                self.report.actual_text_cleared += 1;
                                changed = true;
                            }
                        }
                        if hidden_level == Some(marks.len()) {
                            hidden_level = None;
                        }
                        if let Some(start) = m.hidden_start {
                            if let Some(slot) = pieces.get_mut(start) {
                                *slot = Piece::Drop;
                            }
                            pieces.push(Piece::Drop);
                            changed = true;
                            continue;
                        }
                    }
                    pieces.push(Piece::Keep(span));
                }
                _ => pieces.push(Piece::Keep(span)),
            }
        }
        // Unclosed marked content that lost glyphs.
        for m in marks {
            if let Some(start) = m.hidden_start {
                if let Some(slot) = pieces.get_mut(start) {
                    *slot = Piece::Drop;
                    changed = true;
                }
            }
            if let (Some(p), true) = (m.bdc, m.glyph_removed) {
                if let Some(slot) = pieces.get_mut(p) {
                    let mut v = b"/".to_vec();
                    v.extend_from_slice(&m.tag);
                    v.extend_from_slice(b" BMC");
                    *slot = Piece::New(v);
                    self.report.actual_text_cleared += 1;
                    changed = true;
                }
            }
        }
        if !changed && additions.is_empty() {
            return Rewritten {
                content: content.to_vec(),
                changed: false,
                additions,
                used,
                used_props,
                open_q: qdepth,
            };
        }
        let mut out = Vec::with_capacity(content.len());
        for p in &pieces {
            let b: &[u8] = match p {
                Piece::Keep(r) => content.get(r.clone()).unwrap_or(&[]),
                Piece::New(v) => v,
                Piece::Drop => continue,
            };
            if !out.is_empty() {
                out.push(b'\n');
            }
            out.extend_from_slice(b);
        }
        Rewritten {
            content: out,
            changed: true,
            additions,
            used,
            used_props,
            open_q: qdepth,
        }
    }

    /// Properties of a BDC operand: an inline dictionary or a named `/Properties` resource.
    fn bdc_props(&self, resources: &Dictionary, op: Option<&Operand>) -> Option<Dictionary> {
        match op? {
            Operand::Dict(entries) => {
                let mut d = Dictionary::new();
                for (k, v) in entries {
                    let o = match v {
                        Operand::Str(s) => Object::String(s.clone(), lopdf::StringFormat::Literal),
                        Operand::Name(n) => Object::Name(n.clone()),
                        Operand::Num(n) => Object::Real(*n as f32),
                        _ => Object::Null,
                    };
                    d.set(k.clone(), o);
                }
                Some(d)
            }
            Operand::Name(n) => {
                let e = self.property_entry(resources, n)?;
                resolve_dict(self.src, &e).cloned()
            }
            _ => None,
        }
    }

    fn property_entry(&self, resources: &Dictionary, name: &[u8]) -> Option<Object> {
        let src = self.src;
        let props = dict_get(src, resources, b"Properties").and_then(|o| resolve_dict(src, o))?;
        props.get(name).ok().cloned()
    }

    /// Show a string; removed glyphs become TJ adjustments. Returns the number removed.
    fn show(
        &mut self,
        gs: &GState,
        tm: &mut Matrix,
        bytes: &[u8],
        items: &mut Vec<TjItem>,
        in_hidden: bool,
        marks: &mut [Mark],
    ) -> usize {
        let Some(font) = gs.font.clone() else {
            push_bytes(items, bytes);
            return 0;
        };
        let mut removed = 0usize;
        let mut off = 0usize;
        for d in font.decode(bytes) {
            let len = d.len.max(1);
            let code_bytes = bytes.get(off..off + len).unwrap_or(&[]);
            off += len;
            let trm = Matrix::new(gs.size * gs.th, 0.0, 0.0, gs.size, 0.0, gs.rise)
                .then(tm)
                .then(&gs.ctm);
            let (x0, x1, y0, y1) = if font.vertical {
                (-0.5, 0.5, -1.0, 0.0)
            } else {
                (0.0, d.width, font.descent, font.ascent)
            };
            let bbox = Rect::from_points(&[
                trm.apply(x0, y0),
                trm.apply(x1, y0),
                trm.apply(x1, y1),
                trm.apply(x0, y1),
            ]);
            let origin = trm.apply(0.0, 0.0);
            let (vx, vy) = trm.apply_vec(0.0, 1.0);
            let eff_size = (vx * vx + vy * vy).sqrt();
            let area = bbox.width() * bbox.height();
            let in_area = self.rects.iter().any(|r| {
                if area > 1e-6 {
                    overlap_area(r, &bbox) >= GLYPH_COVERAGE * area
                } else {
                    origin.0 >= r.x0 && origin.0 <= r.x1 && origin.1 >= r.y0 && origin.1 <= r.y1
                }
            });
            let hidden = self.hidden_text.is_some_and(|h| {
                gs.mode == 3
                    || gs.mode == 7
                    || !(intersects(&h.page_box, &bbox)
                        || (area <= 1e-6
                            && origin.0 >= h.page_box.x0
                            && origin.0 <= h.page_box.x1
                            && origin.1 >= h.page_box.y0
                            && origin.1 <= h.page_box.y1))
                    || (eff_size > 0.0 && eff_size < h.min_size)
            });
            let ws = if d.word_space { gs.tw } else { 0.0 };
            let remove = in_hidden || in_area || hidden;
            if font.vertical {
                let ty = -gs.size + gs.tc + ws;
                *tm = Matrix::translate(0.0, ty).then(tm);
                if remove {
                    if gs.size != 0.0 {
                        push_adj(items, -ty * 1000.0 / gs.size);
                    }
                } else {
                    push_bytes(items, code_bytes);
                }
            } else {
                let tx = (d.width * gs.size + gs.tc + ws) * gs.th;
                *tm = Matrix::translate(tx, 0.0).then(tm);
                if remove {
                    if gs.size != 0.0 {
                        push_adj(items, -(d.width * gs.size + gs.tc + ws) * 1000.0 / gs.size);
                    }
                } else {
                    push_bytes(items, code_bytes);
                }
            }
            if remove {
                removed += 1;
                if in_area && !in_hidden {
                    self.report.glyphs_removed += 1;
                } else {
                    self.report.hidden_glyphs_removed += 1;
                }
                for m in marks.iter_mut() {
                    m.glyph_removed = true;
                }
            }
        }
        removed
    }

    fn paint(
        &mut self,
        op: &Op,
        gs: &GState,
        acc: &PathAcc,
        in_hidden: bool,
    ) -> Option<PaintAction> {
        if op.operator == b"n" {
            return None;
        }
        if in_hidden {
            self.report.hidden_layer_items_removed += 1;
            return Some(PaintAction::Remove);
        }
        let mut bbox = acc.bbox?;
        if matches!(
            op.operator.as_slice(),
            b"S" | b"s" | b"B" | b"B*" | b"b" | b"b*"
        ) {
            let scale = (gs.ctm.a * gs.ctm.d - gs.ctm.b * gs.ctm.c).abs().sqrt();
            let e = (gs.lw.max(1.0) * scale / 2.0).min(1e4);
            bbox = Rect::new(bbox.x0 - e, bbox.y0 - e, bbox.x1 + e, bbox.y1 + e);
        }
        let hits: Vec<Rect> = self
            .rects
            .iter()
            .filter(|r| intersects(r, &bbox))
            .copied()
            .collect();
        if hits.is_empty() {
            return None;
        }
        if hits.iter().any(|r| contains(r, &bbox)) {
            self.report.paths_removed += 1;
            return Some(PaintAction::Remove);
        }
        match exclusion_clip(&gs.ctm, &hits) {
            Some(c) => {
                self.report.paths_clipped += 1;
                Some(PaintAction::Clip(c))
            }
            None => {
                self.report.paths_removed += 1;
                Some(PaintAction::Remove)
            }
        }
    }

    fn fresh_name(&self, resources: &Dictionary, used: &mut HashSet<Vec<u8>>) -> Vec<u8> {
        let src = self.src;
        let existing = dict_get(src, resources, b"XObject").and_then(|o| resolve_dict(src, o));
        for i in 0..1_000_000u32 {
            let n = format!("WqRd{i}").into_bytes();
            if existing.is_some_and(|d| d.has(&n)) || used.contains(&n) {
                continue;
            }
            used.insert(n.clone());
            return n;
        }
        b"WqRdX".to_vec()
    }

    fn do_xobject(
        &mut self,
        resources: &Dictionary,
        name: &[u8],
        gs: &GState,
        in_hidden: bool,
        depth: usize,
        used: &mut HashSet<Vec<u8>>,
    ) -> DoAction {
        let src = self.src;
        let Some(xobjs) = dict_get(src, resources, b"XObject").and_then(|o| resolve_dict(src, o))
        else {
            return DoAction::Keep;
        };
        let Ok(entry) = xobjs.get(name) else {
            return DoAction::Keep;
        };
        let id = entry.as_reference().ok();
        let Some(Object::Stream(stream)) = resolve(src, entry) else {
            return DoAction::Keep;
        };
        let sub = name_of(&stream.dict, b"Subtype").unwrap_or(b"");
        let oc = stream.dict.get(b"OC").ok();
        if in_hidden || self.oc_hidden(oc) {
            self.report.hidden_layer_items_removed += 1;
            return DoAction::Drop;
        }
        match sub {
            b"Image" => {
                let bbox = transform_rect(&gs.ctm, &Rect::new(0.0, 0.0, 1.0, 1.0));
                let hits: Vec<Rect> = self
                    .rects
                    .iter()
                    .filter(|r| intersects(r, &bbox))
                    .copied()
                    .collect();
                if hits.is_empty() {
                    return DoAction::Keep;
                }
                if hits.iter().any(|r| contains(r, &bbox)) {
                    self.report.images_removed += 1;
                    return DoAction::Drop;
                }
                match redact_xobject(src, stream, &gs.ctm, &hits) {
                    Outcome::Redacted { mut dict, data } => {
                        // A soft mask carries the image's shape: redact it too.
                        if let Some(Object::Stream(mask)) =
                            dict.get(b"SMask").ok().and_then(|o| resolve(src, o))
                        {
                            match redact_xobject(src, mask, &gs.ctm, &hits) {
                                Outcome::Redacted {
                                    dict: md,
                                    data: mdata,
                                } => {
                                    let mid = self.alloc(Object::Stream(flate_stream(md, &mdata)));
                                    dict.set("SMask", Object::Reference(mid));
                                }
                                Outcome::Undecodable(_) => {
                                    dict.remove(b"SMask");
                                }
                            }
                        }
                        let new_id = self.alloc(Object::Stream(flate_stream(dict, &data)));
                        self.report.images_redacted += 1;
                        DoAction::Replace(self.fresh_name(resources, used), new_id)
                    }
                    Outcome::Undecodable(why) => {
                        self.report.images_removed += 1;
                        if !self.report.undecodable.iter().any(|u| u == why) {
                            self.report.undecodable.push(why.to_string());
                        }
                        DoAction::Drop
                    }
                }
            }
            b"Form" => {
                let m = match dict_get(src, &stream.dict, b"Matrix") {
                    Some(Object::Array(a)) => {
                        let v: Vec<f64> = a
                            .iter()
                            .filter_map(|x| resolve(src, x).and_then(crate::util::number))
                            .collect();
                        match v.as_slice() {
                            [a, b, c, d, e, f] => Matrix::new(*a, *b, *c, *d, *e, *f),
                            _ => Matrix::IDENTITY,
                        }
                    }
                    _ => Matrix::IDENTITY,
                };
                let inner_ctm = m.then(&gs.ctm);
                let cyclic = id.is_some_and(|i| self.forms.contains(&i));
                if depth + 1 >= MAX_FORM_DEPTH || cyclic {
                    // Not examined: drop it if it could draw into a redaction area.
                    let bbox = match dict_get(src, &stream.dict, b"BBox") {
                        Some(Object::Array(a)) => {
                            let v: Vec<f64> = a
                                .iter()
                                .filter_map(|x| resolve(src, x).and_then(crate::util::number))
                                .collect();
                            match v.as_slice() {
                                [x0, y0, x1, y1] => {
                                    transform_rect(&inner_ctm, &Rect::new(*x0, *y0, *x1, *y1))
                                }
                                _ => return DoAction::Drop,
                            }
                        }
                        _ => return DoAction::Drop,
                    };
                    if self.rects.iter().any(|r| intersects(r, &bbox)) || self.hidden_text.is_some()
                    {
                        self.report.truncated = true;
                        return DoAction::Drop;
                    }
                    return DoAction::Keep;
                }
                let Ok(data) = stream_data(stream) else {
                    return if self.rects.is_empty() {
                        DoAction::Keep
                    } else {
                        DoAction::Drop
                    };
                };
                let form_res =
                    dict_get(src, &stream.dict, b"Resources").and_then(|o| resolve_dict(src, o));
                let res_used = form_res.unwrap_or(resources);
                if let Some(i) = id {
                    self.forms.push(i);
                }
                let mut inner = gs.clone();
                inner.ctm = inner_ctm;
                let rw = self.walk(&data, res_used, inner, depth + 1);
                if id.is_some() {
                    self.forms.pop();
                }
                if !rw.changed {
                    return DoAction::Keep;
                }
                let mut dict = stream.dict.clone();
                let mut res = res_used.clone();
                let mut x = res
                    .get(b"XObject")
                    .ok()
                    .and_then(|o| resolve_dict(src, o))
                    .cloned()
                    .unwrap_or_default();
                for (n, nid) in &rw.additions {
                    x.set(n.clone(), Object::Reference(*nid));
                }
                prune_xobjects(&mut x, &rw.used);
                res.set("XObject", Object::Dictionary(x));
                dict.set("Resources", Object::Dictionary(res));
                let new_id = self.alloc(Object::Stream(flate_stream(dict, &rw.content)));
                self.report.forms_rewritten += 1;
                DoAction::Replace(self.fresh_name(resources, used), new_id)
            }
            _ => DoAction::Keep,
        }
    }
}

enum PaintAction {
    Remove,
    Clip(String),
}

enum DoAction {
    Keep,
    Drop,
    Replace(Vec<u8>, ObjectId),
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;
    use lopdf::{dictionary, Document};
    use warraq_text::LopdfSource;

    fn fixture() -> (LopdfSource, Dictionary) {
        let mut doc = Document::with_version("1.7");
        let f1 = doc.add_object(dictionary! {
            "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica", "Encoding" => "WinAnsiEncoding",
        });
        let res = dictionary! { "Font" => dictionary! {"F1" => f1} };
        (LopdfSource::from_document(doc), res)
    }

    fn texts(src: &LopdfSource, content: &[u8], res: &Dictionary) -> String {
        let mut it = warraq_text::interp::Interpreter::new(src);
        it.run_content(content, res)
            .iter()
            .map(|g| g.text.clone())
            .collect()
    }

    fn origins(src: &LopdfSource, content: &[u8], res: &Dictionary) -> Vec<(String, f64)> {
        let mut it = warraq_text::interp::Interpreter::new(src);
        it.run_content(content, res)
            .iter()
            .map(|g| (g.text.clone(), g.origin.0))
            .collect()
    }

    #[test]
    fn removes_covered_glyphs_and_keeps_positions() {
        let (src, res) = fixture();
        let c = b"BT /F1 10 Tf 100 700 Td (Hello World) Tj ET";
        let before = origins(&src, c, &res);
        let mut rw = Rewriter::new(&src, 100);
        // "World" starts at x ≈ 100 + width("Hello ").
        let wx = before.iter().find(|(t, _)| t == "W").unwrap().1;
        rw.set_rects(&[Rect::new(wx - 0.5, 695.0, 200.0, 712.0)]);
        let out = rw.rewrite(c, &res, Matrix::IDENTITY);
        assert!(out.changed);
        let s = String::from_utf8_lossy(&out.content).to_string();
        assert!(!s.contains("World"), "{s}");
        assert_eq!(texts(&src, &out.content, &res).trim_end(), "Hello");
        let after = origins(&src, &out.content, &res);
        assert_eq!(after.len(), 6);
        for ((t, x), (u, orig)) in after.iter().zip(before.iter()) {
            assert_eq!(t, u);
            assert!((orig - x).abs() < 1e-3, "{t} moved {orig} → {x}");
        }
        assert_eq!(rw.report.glyphs_removed, 5);
    }

    #[test]
    fn untouched_content_is_byte_identical() {
        let (src, res) = fixture();
        let c =
            b"q 1 0 0 1 0 0 cm BT /F1 10 Tf 100 700 Td (Hello) Tj ET Q % comment\n0 0 10 10 re f";
        let mut rw = Rewriter::new(&src, 100);
        rw.set_rects(&[Rect::new(300.0, 300.0, 400.0, 400.0)]);
        let out = rw.rewrite(c, &res, Matrix::IDENTITY);
        assert!(!out.changed);
        assert_eq!(out.content, c);
    }

    #[test]
    fn quote_operators_keep_line_moves() {
        let (src, res) = fixture();
        let c = b"BT /F1 10 Tf 12 TL 100 700 Td (AAA) Tj (BBB) ' 2 1 (CCC) \" (DDD) ' ET";
        let mut rw = Rewriter::new(&src, 100);
        rw.set_rects(&[Rect::new(90.0, 684.0, 200.0, 690.0)]); // the BBB line (y = 688)
        let out = rw.rewrite(c, &res, Matrix::IDENTITY);
        let g = {
            let mut it = warraq_text::interp::Interpreter::new(&src);
            it.run_content(&out.content, &res)
        };
        let t: String = g.iter().map(|g| g.text.clone()).collect();
        assert_eq!(t, "AAACCCDDD");
        let c_line = g.iter().find(|g| g.text == "C").unwrap();
        assert!((c_line.origin.1 - 676.0).abs() < 1e-6);
        let d_line = g.iter().find(|g| g.text == "D").unwrap();
        assert!((d_line.origin.1 - 664.0).abs() < 1e-6);
    }

    #[test]
    fn actual_text_is_dropped_when_glyphs_go() {
        let (src, res) = fixture();
        let c = b"BT /F1 10 Tf 100 700 Td /Span <</ActualText (Secret)>> BDC (Secret) Tj EMC (Keep) Tj ET";
        let mut rw = Rewriter::new(&src, 100);
        rw.set_rects(&[Rect::new(95.0, 690.0, 127.0, 715.0)]);
        let out = rw.rewrite(c, &res, Matrix::IDENTITY);
        let s = String::from_utf8_lossy(&out.content).to_string();
        assert!(!s.contains("Secret"), "{s}");
        assert!(s.contains("/Span BMC"));
        assert_eq!(rw.report.actual_text_cleared, 1);
        assert!(texts(&src, &out.content, &res).contains("Keep"));
    }

    #[test]
    fn paths_are_removed_or_clipped() {
        let (src, res) = fixture();
        let c = b"10 10 20 20 re f 0 0 500 500 re f 100 100 m 200 200 l S 0 0 50 50 re W n";
        let mut rw = Rewriter::new(&src, 100);
        rw.set_rects(&[Rect::new(0.0, 0.0, 40.0, 40.0)]);
        let out = rw.rewrite(c, &res, Matrix::IDENTITY);
        let s = String::from_utf8_lossy(&out.content).replace('\n', " ");
        assert!(!s.contains("10 10 20 20 re"), "{s}");
        assert!(s.contains("W* n"), "{s}");
        assert!(s.contains("100 100 m 200 200 l S"), "{s}");
        assert!(s.contains("0 0 50 50 re W n"), "{s}");
        assert_eq!(rw.report.paths_removed, 1);
        assert_eq!(rw.report.paths_clipped, 1);
    }

    #[test]
    fn hidden_text_heuristics() {
        let (src, res) = fixture();
        let c = b"BT /F1 10 Tf 3 Tr 100 700 Td (Ghost) Tj 0 Tr (Seen) Tj ET BT /F1 10 Tf 5000 5000 Td (Off) Tj ET BT /F1 0.2 Tf 100 100 Td (Tiny) Tj ET";
        let mut rw = Rewriter::new(&src, 100);
        rw.set_hidden_text(Some(HiddenText {
            page_box: Rect::new(0.0, 0.0, 612.0, 792.0),
            min_size: 1.0,
        }));
        let out = rw.rewrite(c, &res, Matrix::IDENTITY);
        assert_eq!(texts(&src, &out.content, &res), "Seen");
        assert_eq!(rw.report.hidden_glyphs_removed, 5 + 3 + 4);
    }

    #[test]
    fn hostile_content_does_not_panic() {
        let (src, res) = fixture();
        let mut rw = Rewriter::new(&src, 100);
        rw.set_rects(&[Rect::new(0.0, 0.0, 1000.0, 1000.0)]);
        for c in [
            &b"BT /F1 10 Tf [(A) 1e308 (B)] TJ"[..],
            b"q q q Q Q Q Q Q cm cm 1 2 re",
            b"BI /W 99999999 /H 1 ID xx EI",
            b"/OC /x BDC EMC EMC EMC",
            b"( unterminated",
            b"[[[[[[[[[[",
        ] {
            let _ = rw.rewrite(c, &res, Matrix::IDENTITY);
        }
    }
}
