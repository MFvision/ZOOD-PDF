//! The walk over a page's content that takes out what lies under the marks.
//!
//! The content is read an operation at a time with the bounded lexer
//! (`lex::ops`), keeping each operation's byte range, and the graphics and
//! text state followed as a reader follows it. Only the operations that
//! draw something under a mark are rewritten, spliced in place; every other
//! byte stays as the file had it (inline images included).
//!
//! * **Text.** Each glyph a show operator draws is put in a box — its
//!   advance along the line, the font's ascent and descent across it —
//!   through the text matrix and the transform. A glyph whose box has its
//!   middle under a mark, or two fifths of its area, is cut out of the
//!   string, and an adjustment the width of what was cut is put in its
//!   place, so every glyph after it on the line stays exactly where it was.
//!   A glyph with no advance of its own (a haraka, a mark set over its
//!   letter) goes with the glyph before it. A font whose advances are
//!   guesses (`fonts::Font::unsure`) loses the whole run when any of it is
//!   under a mark. Marked content round a cut glyph loses its properties
//!   bar its `/MCID` — an `/ActualText`, `/Alt` or `/E` there would still
//!   say what was cut.
//! * **Pictures.** An image drawn over a mark is drawn from a copy whose
//!   pixels under the mark are blanked (`pixels`), soft mask too; one that
//!   cannot be read is not drawn at all. An inline image likewise.
//! * **Drawings.** A path painted mostly under a mark — a quarter of its
//!   box, or all of it — is taken out with the operators that built it. A
//!   rule or a background that only crosses the mark stays.
//! * **Forms.** A form XObject drawn over a mark is walked the same way and,
//!   when anything in it changed, drawn from a copy made for this one use:
//!   the original goes on drawing wherever else it is drawn.
//!
//! Everything is bounded: the operations of a stream, the forms walked, the
//! depth they nest to. What cannot be walked within bounds is refused, never
//! left as it was under a mark.
use std::collections::{BTreeSet, HashMap};
use std::ops::Range;
use std::rc::Rc;

use lopdf::content::Content;
use lopdf::{Dictionary, Object, ObjectId, Stream};

use super::fonts::Font;
use super::pixels;
use crate::lex::{ops, Op, Operand};
use crate::text_walk::Matrix;
use crate::{Error, PdfDocument, Result};

/// A box in the page's user space: `[x0, y0, x1, y1]`.
pub(super) type Rect = [f32; 4];

/// Operations read from one stream at most.
const MAX_OPS: usize = 4_000_000;
/// Forms nested inside one another at most.
const MAX_DEPTH: usize = 12;
/// Forms walked for one page at most.
const MAX_FORMS: usize = 2_000;
/// A form's content is not decoded past this.
const MAX_FORM_BYTES: usize = 64 * 1024 * 1024;

/// What was taken out, counted.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(super) struct Counts {
    pub glyphs: usize,
    pub runs: usize,
    pub images: usize,
    pub images_removed: usize,
    pub paths: usize,
}

/// The walk of one content stream.
pub(super) struct Outcome {
    /// The stream rewritten, or `None` when nothing in it changed.
    pub content: Option<Vec<u8>>,
    /// XObjects the rewritten stream draws under new names: to be added to
    /// its resources.
    pub names: Vec<(Vec<u8>, ObjectId)>,
    /// Names whose drawing was redirected or taken out somewhere in the
    /// stream: the resources drop them when nothing draws them any more,
    /// or the original would stay in the file.
    pub dropped: BTreeSet<Vec<u8>>,
    /// Marked-content ids round text that was cut.
    pub mcids: BTreeSet<i64>,
    /// `q` left open at the end.
    pub depth: usize,
}

fn smallest(a: &Rect, b: &Rect) -> Option<Rect> {
    let r = [
        a[0].max(b[0]),
        a[1].max(b[1]),
        a[2].min(b[2]),
        a[3].min(b[3]),
    ];
    (r[2] > r[0] && r[3] > r[1]).then_some(r)
}

fn area(r: &Rect) -> f32 {
    (r[2] - r[0]).max(0.0) * (r[3] - r[1]).max(0.0)
}

pub(super) fn bounds(points: &[(f32, f32)]) -> Rect {
    let mut r = [f32::MAX, f32::MAX, f32::MIN, f32::MIN];
    for &(x, y) in points {
        r = [r[0].min(x), r[1].min(y), r[2].max(x), r[3].max(y)];
    }
    r
}

/// The marks of one page, in its user space.
pub(super) struct Marks<'a>(pub &'a [Rect]);

impl Marks<'_> {
    /// Some of `r` is under a mark.
    pub fn touch(&self, r: &Rect) -> bool {
        self.0.iter().any(|m| smallest(m, r).is_some())
    }

    /// A glyph whose corners are `quad`: its middle under a mark, or two
    /// fifths of its box.
    fn cover_glyph(&self, quad: &[(f32, f32); 4]) -> bool {
        let (cx, cy) = (
            quad.iter().map(|p| p.0).sum::<f32>() / 4.0,
            quad.iter().map(|p| p.1).sum::<f32>() / 4.0,
        );
        let b = bounds(quad);
        let whole = area(&b);
        self.0.iter().any(|m| {
            (m[0]..=m[2]).contains(&cx) && (m[1]..=m[3]).contains(&cy)
                || (whole > 0.0 && smallest(m, &b).is_some_and(|o| area(&o) >= 0.4 * whole))
        })
    }

    /// A path whose box is `b`: a quarter of it under one mark, or all of it
    /// under the marks together. A line, which has no area, is given a point
    /// of thickness.
    fn cover_path(&self, b: &Rect) -> bool {
        let mut b = *b;
        for (lo, hi) in [(0, 2), (1, 3)] {
            if b[hi] - b[lo] < 1.0 {
                let mid = (b[lo] + b[hi]) / 2.0;
                b[lo] = mid - 0.5;
                b[hi] = mid + 0.5;
            }
        }
        let whole = area(&b);
        let under: f32 = self
            .0
            .iter()
            .filter_map(|m| smallest(m, &b))
            .map(|o| area(&o))
            .fold(0.0, f32::max);
        whole > 0.0 && under >= 0.25 * whole
    }
}

/// The graphics state a `q` saves: the transform and the text state.
#[derive(Clone)]
struct Gs {
    ctm: Matrix,
    font: Option<Rc<Font>>,
    size: f32,
    char_spacing: f32,
    word_spacing: f32,
    scale: f32,
    leading: f32,
    rise: f32,
}

/// An open marked-content sequence.
struct Mc {
    /// The `BDC` that opened it (none for `BMC`) and its tag.
    open: Option<(Range<usize>, Vec<u8>)>,
    mcid: Option<i64>,
    cut: bool,
}

fn num(o: &Object) -> Option<f32> {
    match o {
        Object::Integer(i) => Some(*i as f32),
        Object::Real(r) => Some(*r),
        _ => None,
    }
    .filter(|v| v.is_finite())
}

fn translate(x: f32, y: f32) -> Matrix {
    Matrix([1.0, 0.0, 0.0, 1.0, x, y])
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2 + 2);
    s.push('<');
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s.push('>');
    s
}

/// A number as content syntax: no exponent, no needless digits.
fn number_text(v: f32) -> String {
    let s = format!("{:.3}", v);
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s.is_empty() || s == "-0" {
        "0".into()
    } else {
        s.into()
    }
}

/// A content-syntax name, `#`-escaped where it must be.
fn name_text(n: &[u8]) -> String {
    let mut s = String::from("/");
    for &b in n {
        if b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b'+') {
            s.push(b as char);
        } else {
            s.push_str(&format!("#{b:02X}"));
        }
    }
    s
}

pub(super) struct Walker<'a> {
    pub pdf: &'a mut PdfDocument,
    marks: Marks<'a>,
    fonts: HashMap<ObjectId, Rc<Font>>,
    pub counts: Counts,
    forms_left: usize,
    walking: Vec<ObjectId>,
}

impl<'a> Walker<'a> {
    pub fn new(pdf: &'a mut PdfDocument, marks: &'a [Rect]) -> Self {
        Self {
            pdf,
            marks: Marks(marks),
            fonts: HashMap::new(),
            counts: Counts::default(),
            forms_left: MAX_FORMS,
            walking: Vec::new(),
        }
    }

    fn resolve(&self, o: &Object) -> Object {
        match o {
            Object::Reference(id) => self
                .pdf
                .doc
                .get_object(*id)
                .cloned()
                .unwrap_or(Object::Null),
            o => o.clone(),
        }
    }

    /// A resource group (`/Font`, `/XObject`, `/Properties`) of `resources`.
    fn group(&self, resources: &Dictionary, key: &[u8]) -> Dictionary {
        resources
            .get(key)
            .ok()
            .map(|g| self.resolve(g))
            .and_then(|g| g.as_dict().ok().cloned())
            .unwrap_or_default()
    }

    fn font(&mut self, resources: &Dictionary, name: &[u8]) -> Rc<Font> {
        let fonts = self.group(resources, b"Font");
        match fonts.get(name) {
            Ok(Object::Reference(id)) => {
                if let Some(f) = self.fonts.get(id) {
                    return f.clone();
                }
                let font = Rc::new(Font::read(&self.pdf.doc, &Object::Reference(*id)));
                self.fonts.insert(*id, font.clone());
                font
            }
            Ok(o) => Rc::new(Font::read(&self.pdf.doc, o)),
            Err(_) => Rc::new(Font::unknown()),
        }
    }

    /// Walks `content`, drawn with `resources` under `ctm`.
    pub fn walk(
        &mut self,
        content: &[u8],
        resources: &Dictionary,
        ctm: Matrix,
        depth: usize,
    ) -> Result<Outcome> {
        let mut edits: Vec<(Range<usize>, Vec<u8>)> = Vec::new();
        let mut names: Vec<(Vec<u8>, ObjectId)> = Vec::new();
        let mut dropped: BTreeSet<Vec<u8>> = BTreeSet::new();
        let mut mcids = BTreeSet::new();
        let mut gs = Gs {
            ctm,
            font: None,
            size: 0.0,
            char_spacing: 0.0,
            word_spacing: 0.0,
            scale: 1.0,
            leading: 0.0,
            rise: 0.0,
        };
        let mut saved: Vec<Gs> = Vec::new();
        let (mut tm, mut tlm) = (Matrix::IDENTITY, Matrix::IDENTITY);
        let mut mc: Vec<Mc> = Vec::new();
        // The path being built: its operators' ranges, its box, and whether
        // a clip was asked for before it is painted.
        let mut path: Vec<Range<usize>> = Vec::new();
        let mut path_box: Option<Rect> = None;
        let mut clip = false;
        let mut count = 0usize;
        let xobjects = self.group(resources, b"XObject");
        let mut taken: BTreeSet<Vec<u8>> = xobjects.iter().map(|(k, _)| k.clone()).collect();

        for op in ops(content) {
            count += 1;
            if count > MAX_OPS {
                return Err(Error::Edit(
                    "a page's content is too long to redact safely".into(),
                ));
            }
            let name = op.operator.as_slice();
            match name {
                b"q" => saved.push(gs.clone()),
                b"Q" => {
                    if let Some(g) = saved.pop() {
                        gs = g;
                    }
                }
                b"cm" => {
                    if let Some(m) = op.matrix() {
                        gs.ctm = Matrix(m).then(gs.ctm);
                    }
                }
                b"BT" => {
                    tm = Matrix::IDENTITY;
                    tlm = Matrix::IDENTITY;
                }
                b"Tf" => {
                    if let Some(font) = op.name(0) {
                        gs.font = Some(self.font(resources, font));
                    }
                    gs.size = op.number(1).filter(|s| s.is_finite()).unwrap_or(gs.size);
                }
                b"Tc" => gs.char_spacing = op.number(0).unwrap_or(gs.char_spacing),
                b"Tw" => gs.word_spacing = op.number(0).unwrap_or(gs.word_spacing),
                b"Tz" => gs.scale = op.number(0).map(|z| z / 100.0).unwrap_or(gs.scale),
                b"TL" => gs.leading = op.number(0).unwrap_or(gs.leading),
                b"Ts" => gs.rise = op.number(0).unwrap_or(gs.rise),
                b"Td" | b"TD" => {
                    if let (Some(x), Some(y)) = (op.number(0), op.number(1)) {
                        if name == b"TD" {
                            gs.leading = -y;
                        }
                        tlm = translate(x, y).then(tlm);
                        tm = tlm;
                    }
                }
                b"Tm" => {
                    if let Some(m) = op.matrix() {
                        tlm = Matrix(m);
                        tm = tlm;
                    }
                }
                b"T*" => {
                    tlm = translate(0.0, -gs.leading).then(tlm);
                    tm = tlm;
                }
                b"Tj" | b"TJ" | b"'" | b"\"" => {
                    let cut = self.show(&op, content, &mut gs, &mut tm, &mut tlm, &mut edits)?;
                    if cut {
                        for open in mc.iter_mut() {
                            open.cut = true;
                        }
                    }
                }
                b"BMC" => mc.push(Mc {
                    open: None,
                    mcid: None,
                    cut: false,
                }),
                b"BDC" => {
                    let tag = op
                        .name(0)
                        .map(<[u8]>::to_vec)
                        .unwrap_or_else(|| b"Span".to_vec());
                    let mcid = self.mcid(&op, content, resources);
                    mc.push(Mc {
                        open: Some((op.range.clone(), tag)),
                        mcid,
                        cut: false,
                    });
                }
                b"EMC" => {
                    if let Some(closed) = mc.pop() {
                        close(closed, &mut edits, &mut mcids);
                    }
                }
                b"m" | b"l" | b"c" | b"v" | b"y" | b"re" | b"h" => {
                    let numbers: Vec<f32> = op
                        .operands
                        .iter()
                        .filter_map(|(o, _)| match o {
                            Operand::Number(n) if n.is_finite() => Some(*n),
                            _ => None,
                        })
                        .collect();
                    let mut points: Vec<(f32, f32)> = if name == b"re" && numbers.len() == 4 {
                        let [x, y, w, h] = [numbers[0], numbers[1], numbers[2], numbers[3]];
                        vec![(x, y), (x + w, y), (x + w, y + h), (x, y + h)]
                    } else {
                        numbers
                            .as_chunks::<2>()
                            .0
                            .iter()
                            .map(|[x, y]| (*x, *y))
                            .collect()
                    };
                    for p in points.iter_mut() {
                        *p = gs.ctm.apply(p.0, p.1);
                    }
                    if !points.is_empty() {
                        let b = bounds(&points);
                        path_box = Some(match path_box {
                            Some(a) => [
                                a[0].min(b[0]),
                                a[1].min(b[1]),
                                a[2].max(b[2]),
                                a[3].max(b[3]),
                            ],
                            None => b,
                        });
                    }
                    path.push(op.range.clone());
                }
                b"W" | b"W*" => clip = true,
                b"S" | b"s" | b"f" | b"F" | b"f*" | b"B" | b"B*" | b"b" | b"b*" | b"n" => {
                    if name != b"n" && !clip && path_box.is_some_and(|b| self.marks.cover_path(&b))
                    {
                        for range in path.drain(..) {
                            edits.push((range, Vec::new()));
                        }
                        edits.push((op.range.clone(), Vec::new()));
                        self.counts.paths += 1;
                    }
                    path.clear();
                    path_box = None;
                    clip = false;
                }
                b"Do" => {
                    if let Some(x) = op.name(0) {
                        if let Some(drawn) = self.draw(x, &xobjects, resources, gs.ctm, depth)? {
                            dropped.insert(x.to_vec());
                            match drawn {
                                Drawn::Gone => edits.push((op.range.clone(), Vec::new())),
                                Drawn::Copy(id) => {
                                    let fresh = fresh_name(&mut taken);
                                    edits.push((
                                        op.range.clone(),
                                        format!("{} Do", name_text(&fresh)).into_bytes(),
                                    ));
                                    names.push((fresh, id));
                                }
                            }
                        }
                    }
                }
                b"BI" => {
                    let quad = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)]
                        .map(|(x, y)| gs.ctm.apply(x, y));
                    if self.marks.touch(&bounds(&quad)) {
                        let bytes = &content[op.range.clone()];
                        match pixels::paint_inline(bytes, &op, op.range.start, gs.ctm, self.marks.0)
                        {
                            Some(painted) => {
                                self.counts.images += 1;
                                edits.push((op.range.clone(), painted));
                            }
                            None => {
                                self.counts.images_removed += 1;
                                edits.push((op.range.clone(), Vec::new()));
                            }
                        }
                    }
                }
                _ => {}
            }
        }
        // A sequence left open at the end of the stream is closed by no
        // EMC here, but its properties are as telling.
        while let Some(open) = mc.pop() {
            close(open, &mut edits, &mut mcids);
        }
        let depth_left = saved.len();
        if edits.is_empty() {
            return Ok(Outcome {
                content: None,
                names,
                dropped,
                mcids,
                depth: depth_left,
            });
        }
        edits.sort_by_key(|(r, _)| r.start);
        let mut out = Vec::with_capacity(content.len());
        let mut at = 0;
        for (range, with) in edits {
            if range.start < at {
                return Err(Error::Edit(
                    "the page's content could not be rewritten safely".into(),
                ));
            }
            out.extend_from_slice(&content[at..range.start]);
            out.push(b' ');
            out.extend_from_slice(&with);
            out.push(b' ');
            at = range.end;
        }
        out.extend_from_slice(&content[at.min(content.len())..]);
        Ok(Outcome {
            content: Some(out),
            names,
            dropped,
            mcids,
            depth: depth_left,
        })
    }

    /// The `/MCID` of a `BDC`, from its properties written in place or named
    /// in the resources.
    fn mcid(&self, op: &Op, content: &[u8], resources: &Dictionary) -> Option<i64> {
        let props = match op.operands.get(1)? {
            (Operand::Name(n), _) => self
                .group(resources, b"Properties")
                .get(n)
                .ok()
                .map(|p| self.resolve(p))?,
            (_, range) => {
                let parsed =
                    Content::decode(&[&content[range.clone()], b" BMC".as_slice()].concat())
                        .ok()?;
                parsed.operations.first()?.operands.first()?.clone()
            }
        };
        props.as_dict().ok()?.get(b"MCID").ok()?.as_i64().ok()
    }

    /// A show operator: its glyphs placed, the ones under a mark cut, the
    /// pen moved as the reader moves it. True when anything was cut.
    fn show(
        &mut self,
        op: &Op,
        content: &[u8],
        gs: &mut Gs,
        tm: &mut Matrix,
        tlm: &mut Matrix,
        edits: &mut Vec<(Range<usize>, Vec<u8>)>,
    ) -> Result<bool> {
        let name = op.operator.as_slice();
        let Ok(parsed) = Content::decode(&content[op.range.clone()]) else {
            return self.unreadable(op, gs, tm, edits);
        };
        let Some(operation) = parsed.operations.into_iter().next() else {
            return self.unreadable(op, gs, tm, edits);
        };
        let mut prefix = String::new();
        let items: Vec<Object> = match name {
            b"TJ" => match operation.operands.first() {
                Some(Object::Array(a)) => a.clone(),
                _ => return Ok(false),
            },
            b"\"" => {
                let (Some(aw), Some(ac)) = (
                    operation.operands.first().and_then(num),
                    operation.operands.get(1).and_then(num),
                ) else {
                    return Ok(false);
                };
                gs.word_spacing = aw;
                gs.char_spacing = ac;
                prefix = format!("{} Tw {} Tc T* ", number_text(aw), number_text(ac));
                operation.operands.get(2).cloned().into_iter().collect()
            }
            _ => operation.operands.first().cloned().into_iter().collect(),
        };
        if name == b"'" || name == b"\"" {
            *tlm = translate(0.0, -gs.leading).then(*tlm);
            *tm = *tlm;
            if name == b"'" {
                prefix = "T* ".into();
            }
        }
        let font = gs.font.clone().unwrap_or_else(|| Rc::new(Font::unknown()));
        let size = gs.size;
        let along = |adv: f32| -> Matrix {
            if font.vertical {
                translate(0.0, adv)
            } else {
                translate(adv * gs.scale, 0.0)
            }
        };
        // Every glyph: (item, its bytes, advance along the line, cut).
        let mut glyphs: Vec<(usize, Range<usize>, f32, bool)> = Vec::new();
        let mut touched = false;
        for (k, item) in items.iter().enumerate() {
            match item {
                Object::String(bytes, _) => {
                    let mut before_cut = false;
                    for code in font.codes(bytes) {
                        let spacing =
                            gs.char_spacing + if code.space { gs.word_spacing } else { 0.0 };
                        let (quad, adv) = if font.vertical {
                            let trm = Matrix([size, 0.0, 0.0, size, 0.0, gs.rise])
                                .then(*tm)
                                .then(gs.ctm);
                            let q = [(-0.5, -1.1), (0.5, -1.1), (0.5, 0.0), (-0.5, 0.0)]
                                .map(|(x, y)| trm.apply(x, y));
                            (q, -code.advance * size + spacing)
                        } else {
                            let trm = Matrix([size * gs.scale, 0.0, 0.0, size, 0.0, gs.rise])
                                .then(*tm)
                                .then(gs.ctm);
                            let w = code.advance;
                            let q = [
                                (0.0, font.descent),
                                (w, font.descent),
                                (w, font.ascent),
                                (0.0, font.ascent),
                            ]
                            .map(|(x, y)| trm.apply(x, y));
                            (q, code.advance * size + spacing)
                        };
                        if self.marks.touch(&bounds(&quad)) {
                            touched = true;
                        }
                        let cut = if code.advance.abs() < 0.01 {
                            before_cut || self.marks.cover_glyph(&quad)
                        } else {
                            self.marks.cover_glyph(&quad)
                        };
                        before_cut = cut;
                        glyphs.push((k, code.bytes.clone(), adv, cut));
                        *tm = along(adv).then(*tm);
                    }
                }
                other => {
                    if let Some(n) = num(other) {
                        let adv = -n / 1000.0 * size;
                        *tm = along(adv).then(*tm);
                    }
                }
            }
        }
        if font.unsure && touched {
            // Its boxes are guesses: none of the run is trusted to be clear.
            for g in glyphs.iter_mut() {
                g.3 = true;
            }
            self.counts.runs += 1;
        }
        let cut = glyphs.iter().filter(|g| g.3).count();
        if cut == 0 {
            return Ok(false);
        }
        self.counts.glyphs += cut;
        // The run again, with each cut glyph's bytes replaced by the
        // adjustment that moves the pen as far as the glyph did.
        let mut out: Vec<String> = Vec::new();
        let mut pending = 0.0f32;
        let flush = |out: &mut Vec<String>, pending: &mut f32| {
            if pending.abs() > 1e-4 {
                out.push(number_text(*pending));
            }
            *pending = 0.0;
        };
        let mut g = glyphs.iter().peekable();
        for (k, item) in items.iter().enumerate() {
            match item {
                Object::String(bytes, _) => {
                    let mut kept: Vec<u8> = Vec::new();
                    while let Some((_, range, adv, cut)) = g.next_if(|x| x.0 == k) {
                        if *cut {
                            if !kept.is_empty() {
                                flush(&mut out, &mut pending);
                                out.push(hex(&kept));
                                kept.clear();
                            }
                            if size.abs() > 1e-6 {
                                pending += -adv / size * 1000.0;
                            }
                        } else {
                            kept.extend_from_slice(&bytes[range.clone()]);
                        }
                    }
                    if !kept.is_empty() {
                        flush(&mut out, &mut pending);
                        out.push(hex(&kept));
                    }
                }
                other => {
                    if let Some(n) = num(other) {
                        pending += n;
                    }
                }
            }
        }
        flush(&mut out, &mut pending);
        let text = format!("{prefix}[{}] TJ", out.join(" "));
        edits.push((op.range.clone(), text.into_bytes()));
        Ok(true)
    }

    /// A show operator whose operands cannot be read: taken out whole if it
    /// starts anywhere near a mark — its glyphs cannot be placed, so none
    /// can be shown to be clear.
    fn unreadable(
        &mut self,
        op: &Op,
        gs: &Gs,
        tm: &Matrix,
        edits: &mut Vec<(Range<usize>, Vec<u8>)>,
    ) -> Result<bool> {
        let size = gs.size.abs().max(1.0);
        let trm = tm.then(gs.ctm);
        let (x, y) = trm.apply(0.0, 0.0);
        let reach = size * trm.scale().max(1.0) * 50.0;
        if self
            .marks
            .touch(&[x - reach, y - reach, x + reach, y + reach])
        {
            edits.push((op.range.clone(), Vec::new()));
            self.counts.runs += 1;
            return Ok(true);
        }
        Ok(false)
    }

    /// A `Do`: an image or a form drawn over a mark, redrawn from a copy or
    /// not drawn at all. `None` leaves it as it is.
    fn draw(
        &mut self,
        name: &[u8],
        xobjects: &Dictionary,
        resources: &Dictionary,
        ctm: Matrix,
        depth: usize,
    ) -> Result<Option<Drawn>> {
        let Ok(held) = xobjects.get(name) else {
            return Ok(None);
        };
        let id = held.as_reference().ok();
        let Object::Stream(stream) = self.resolve(held) else {
            return Ok(None);
        };
        let subtype = stream
            .dict
            .get(b"Subtype")
            .and_then(Object::as_name)
            .unwrap_or(b"");
        match subtype {
            b"Image" => {
                let quad =
                    [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)].map(|(x, y)| ctm.apply(x, y));
                if !self.marks.touch(&bounds(&quad)) {
                    return Ok(None);
                }
                match pixels::paint_image(&self.pdf.doc, &stream, ctm, self.marks.0) {
                    Some(painted) => {
                        let mut image = painted.image;
                        if let Some(mask) = painted.soft_mask {
                            let mask_id = self.pdf.doc.add_object(mask);
                            image.dict.set("SMask", Object::Reference(mask_id));
                        }
                        if let Some(stencil) = painted.stencil {
                            let stencil_id = self.pdf.doc.add_object(stencil);
                            image.dict.set("Mask", Object::Reference(stencil_id));
                        }
                        self.counts.images += 1;
                        Ok(Some(Drawn::Copy(self.pdf.doc.add_object(image))))
                    }
                    None => {
                        self.counts.images_removed += 1;
                        Ok(Some(Drawn::Gone))
                    }
                }
            }
            b"Form" => self.form(id, stream, resources, ctm, depth),
            _ => Ok(None),
        }
    }

    fn form(
        &mut self,
        id: Option<ObjectId>,
        stream: Stream,
        resources: &Dictionary,
        ctm: Matrix,
        depth: usize,
    ) -> Result<Option<Drawn>> {
        let matrix = stream
            .dict
            .get(b"Matrix")
            .ok()
            .map(|m| self.resolve(m))
            .and_then(|m| {
                let v: Vec<f32> = m.as_array().ok()?.iter().filter_map(num).collect();
                (v.len() == 6).then(|| Matrix([v[0], v[1], v[2], v[3], v[4], v[5]]))
            })
            .unwrap_or(Matrix::IDENTITY);
        let form_ctm = matrix.then(ctm);
        // A form draws nothing outside its box: one clear of every mark
        // has nothing under one.
        let bbox: Option<Vec<f32>> = stream
            .dict
            .get(b"BBox")
            .ok()
            .map(|b| self.resolve(b))
            .and_then(|b| {
                b.as_array()
                    .ok()
                    .map(|a| a.iter().filter_map(num).collect())
            });
        if let Some(b) = bbox.filter(|b| b.len() == 4) {
            let quad = [(b[0], b[1]), (b[2], b[1]), (b[2], b[3]), (b[0], b[3])]
                .map(|(x, y)| form_ctm.apply(x, y));
            if !self.marks.touch(&bounds(&quad)) {
                return Ok(None);
            }
        }
        let cycle = id.is_some_and(|id| self.walking.contains(&id));
        if cycle || depth >= MAX_DEPTH || self.forms_left == 0 {
            // Over a mark and beyond what can be walked: not drawn.
            self.counts.images_removed += 1;
            return Ok(Some(Drawn::Gone));
        }
        self.forms_left -= 1;
        let own = stream
            .dict
            .get(b"Resources")
            .ok()
            .map(|r| self.resolve(r))
            .and_then(|r| r.as_dict().ok().cloned());
        let form_resources = own.clone().unwrap_or_else(|| resources.clone());
        let Ok(bytes) = stream.decompressed_content_with_limit(MAX_FORM_BYTES) else {
            self.counts.images_removed += 1;
            return Ok(Some(Drawn::Gone));
        };
        if let Some(id) = id {
            self.walking.push(id);
        }
        let outcome = self.walk(&bytes, &form_resources, form_ctm, depth + 1);
        if id.is_some() {
            self.walking.pop();
        }
        let outcome = outcome?;
        if outcome.content.is_none() && outcome.names.is_empty() {
            return Ok(None);
        }
        let mut dict = stream.dict.clone();
        for key in [
            b"Filter".as_slice(),
            b"DecodeParms",
            b"Length",
            b"PieceInfo",
            b"Metadata",
            b"LastModified",
        ] {
            dict.remove(key);
        }
        let content = outcome.content.unwrap_or(bytes);
        if !outcome.names.is_empty() || !outcome.dropped.is_empty() {
            let mut res = form_resources;
            let mut group = self.group(&res, b"XObject");
            let still = drawn_names(&content);
            for n in &outcome.dropped {
                if !still.contains(n) {
                    group.remove(n);
                }
            }
            for (n, id) in outcome.names {
                group.set(n, Object::Reference(id));
            }
            res.set("XObject", Object::Dictionary(group));
            dict.set("Resources", Object::Dictionary(res));
        }
        let mut copy = Stream::new(dict, content);
        let _ = copy.compress();
        Ok(Some(Drawn::Copy(self.pdf.doc.add_object(copy))))
    }
}

/// The names a content stream draws with `Do`.
pub(super) fn drawn_names(content: &[u8]) -> BTreeSet<Vec<u8>> {
    ops(content)
        .filter(|op| op.is("Do"))
        .filter_map(|op| op.name(0).map(<[u8]>::to_vec))
        .collect()
}

/// What a `Do` becomes.
enum Drawn {
    /// Not drawn at all.
    Gone,
    /// Drawn from this copy instead.
    Copy(ObjectId),
}

/// A name for a new XObject that the resources do not use yet.
fn fresh_name(taken: &mut BTreeSet<Vec<u8>>) -> Vec<u8> {
    let mut n = 1;
    loop {
        let name = format!("Rd{n}").into_bytes();
        if taken.insert(name.clone()) {
            return name;
        }
        n += 1;
    }
}

/// A sequence that held cut text loses what its properties said of it.
fn close(closed: Mc, edits: &mut Vec<(Range<usize>, Vec<u8>)>, mcids: &mut BTreeSet<i64>) {
    if !closed.cut {
        return;
    }
    if let Some(id) = closed.mcid {
        mcids.insert(id);
    }
    if let Some((range, tag)) = closed.open {
        let text = match closed.mcid {
            Some(id) => format!("{} <</MCID {id}>> BDC", name_text(&tag)),
            None => format!("{} BMC", name_text(&tag)),
        };
        edits.push((range, text.into_bytes()));
    }
}
