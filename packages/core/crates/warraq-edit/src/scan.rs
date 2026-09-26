//! A page-level interpreter over the byte-faithful operations: records every text-showing operator
//! (with glyph boxes, advance, font, colour, artifact/hidden flags and its `BT`) and every image
//! placement (image XObject `Do` or inline image, with the CTM). Form XObjects are not entered:
//! their content (page marks, stamps) is not editable here.

use std::collections::HashMap;
use std::rc::Rc;

use lopdf::{Object, ObjectId};
use warraq_pdf::Pdf;
use warraq_text::font::{Font, FontKey};
use warraq_text::DocSource;

use crate::content::{parse, Content, Value};
use crate::error::Result;
use crate::geom::{Matrix, Rect};
use crate::page::{resource, resources, PageContent};

/// Maximum depth of `q` nesting tracked.
const MAX_Q: usize = 256;
/// Maximum glyphs recorded per page.
const MAX_GLYPHS: usize = 1_000_000;

/// One shown glyph (user space box).
#[derive(Debug, Clone, PartialEq)]
pub struct ScanGlyph {
    pub text: String,
    pub bbox: Rect,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShowKind {
    Tj,
    TJ,
    /// `'`
    Quote,
    /// `"`
    DQuote,
}

/// A text-showing operator.
#[derive(Debug, Clone)]
pub struct ShowOp {
    /// Index into [`Scan::content`]`.ops`.
    pub op: usize,
    pub kind: ShowKind,
    pub glyphs: Vec<ScanGlyph>,
    /// Horizontal advance of the text matrix in unscaled text space (what a number-only `TJ`
    /// must reproduce: `n = -advance * 1000 / size`).
    pub advance: f64,
    pub size: f64,
    pub vertical: bool,
    /// Index of the enclosing `BT`.
    pub bt: Option<usize>,
    pub artifact: bool,
    pub hidden: bool,
    /// Font resource name and object.
    pub font_name: Vec<u8>,
    pub font_id: Option<ObjectId>,
    pub font_base: String,
    pub bold: bool,
    pub italic: bool,
    /// Fill colour as RGB 0..1.
    pub fill: [f64; 3],
}

/// An image placement.
#[derive(Debug, Clone, PartialEq)]
pub struct ImageUse {
    pub op: usize,
    /// XObject resource name (None for inline images).
    pub name: Option<Vec<u8>>,
    pub xobject: Option<ObjectId>,
    /// CTM at the `Do`: maps the unit square to user space.
    pub ctm: Matrix,
    pub width: i64,
    pub height: i64,
}

/// `BT`…`ET` pair.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BtRange {
    pub bt: usize,
    pub et: Option<usize>,
}

/// Result of scanning a page.
#[derive(Debug, Clone)]
pub struct Scan {
    pub content: Content,
    pub shows: Vec<ShowOp>,
    pub bts: Vec<BtRange>,
    pub images: Vec<ImageUse>,
}

#[derive(Clone)]
struct GState {
    ctm: Matrix,
    font: Option<Rc<Font>>,
    font_name: Vec<u8>,
    font_id: Option<ObjectId>,
    font_base: String,
    size: f64,
    tc: f64,
    tw: f64,
    th: f64,
    tl: f64,
    rise: f64,
    mode: i64,
    fill: [f64; 3],
}

fn cmyk(c: f64, m: f64, y: f64, k: f64) -> [f64; 3] {
    [
        (1.0 - c) * (1.0 - k),
        (1.0 - m) * (1.0 - k),
        (1.0 - y) * (1.0 - k),
    ]
}

fn colour(n: &[f64]) -> Option<[f64; 3]> {
    let c = |v: f64| v.clamp(0.0, 1.0);
    match n {
        [g] => Some([c(*g); 3]),
        [r, g, b] => Some([c(*r), c(*g), c(*b)]),
        [cc, m, y, k] => Some(cmyk(c(*cc), c(*m), c(*y), c(*k))),
        _ => None,
    }
}

fn int_of(pdf: &Pdf, o: Option<&Object>) -> i64 {
    match o.and_then(|o| pdf.resolve(o)) {
        Some(Object::Integer(i)) => *i,
        Some(Object::Real(r)) => *r as i64,
        _ => 0,
    }
}

/// Scan page content.
pub fn scan(pdf: &Pdf, pc: &PageContent) -> Result<Scan> {
    let content = parse(&pc.data)?;
    let res = resources(pdf, pc.page_id);
    let src = DocSource::borrowed(pdf.document());
    let mut fonts: HashMap<FontKey, Rc<Font>> = HashMap::new();
    let mut gs = GState {
        ctm: Matrix::IDENTITY,
        font: None,
        font_name: Vec::new(),
        font_id: None,
        font_base: String::new(),
        size: 0.0,
        tc: 0.0,
        tw: 0.0,
        th: 1.0,
        tl: 0.0,
        rise: 0.0,
        mode: 0,
        fill: [0.0; 3],
    };
    let mut stack: Vec<GState> = Vec::new();
    let mut tm = Matrix::IDENTITY;
    let mut tlm = Matrix::IDENTITY;
    let mut marked: Vec<bool> = Vec::new();
    let mut shows = Vec::new();
    let mut bts: Vec<BtRange> = Vec::new();
    let mut images = Vec::new();
    let mut cur_bt: Option<usize> = None;
    let mut glyph_count = 0usize;

    for (i, op) in content.ops.iter().enumerate() {
        let nums = op.nums();
        let o = &op.operands;
        match op.operator.as_slice() {
            b"q" => {
                if stack.len() < MAX_Q {
                    stack.push(gs.clone());
                }
            }
            b"Q" => {
                if let Some(s) = stack.pop() {
                    gs = s;
                }
            }
            b"cm" => {
                if let Some(m) = Matrix::from_slice(&nums) {
                    if m.is_finite() {
                        gs.ctm = m.then(&gs.ctm);
                    }
                }
            }
            b"g" | b"rg" | b"k" | b"sc" | b"scn" => {
                if let Some(c) = colour(&nums) {
                    gs.fill = c;
                }
            }
            b"BT" => {
                tm = Matrix::IDENTITY;
                tlm = Matrix::IDENTITY;
                cur_bt = Some(i);
                bts.push(BtRange { bt: i, et: None });
            }
            b"ET" => {
                if let Some(last) = bts.last_mut() {
                    if last.et.is_none() {
                        last.et = Some(i);
                    }
                }
                cur_bt = None;
            }
            b"Tf" => {
                if let (Some(Value::Name(n)), Some(sz)) = (o.first().map(|x| &x.value), nums.last())
                {
                    gs.size = *sz;
                    gs.font_name = n.clone();
                    gs.font_id = None;
                    gs.font_base.clear();
                    gs.font = match resource(pdf, &res, b"Font", n) {
                        Some((id, Object::Dictionary(d))) => {
                            gs.font_id = id;
                            if let Ok(Object::Name(b)) = d.get(b"BaseFont") {
                                gs.font_base = String::from_utf8_lossy(b).into_owned();
                            }
                            let entry = id.map(Object::Reference).unwrap_or(Object::Null);
                            let key = Font::key_for(&entry, d);
                            let f = fonts
                                .entry(key)
                                .or_insert_with(|| Rc::new(Font::load(&src, key, d)))
                                .clone();
                            Some(f)
                        }
                        _ => Some(Rc::new(Font::fallback())),
                    };
                }
            }
            b"Tc" => gs.tc = nums.first().copied().unwrap_or(0.0),
            b"Tw" => gs.tw = nums.first().copied().unwrap_or(0.0),
            b"Tz" => gs.th = nums.first().copied().unwrap_or(100.0) / 100.0,
            b"TL" => gs.tl = nums.first().copied().unwrap_or(0.0),
            b"Ts" => gs.rise = nums.first().copied().unwrap_or(0.0),
            b"Tr" => gs.mode = nums.first().copied().unwrap_or(0.0) as i64,
            b"Td" | b"TD" => {
                if let [tx, ty] = nums.as_slice() {
                    if op.is(b"TD") {
                        gs.tl = -ty;
                    }
                    tlm = Matrix::translate(*tx, *ty).then(&tlm);
                    tm = tlm;
                }
            }
            b"Tm" => {
                if let Some(m) = Matrix::from_slice(&nums) {
                    tlm = m;
                    tm = m;
                }
            }
            b"T*" => {
                tlm = Matrix::translate(0.0, -gs.tl).then(&tlm);
                tm = tlm;
            }
            b"Tj" | b"TJ" | b"'" | b"\"" => {
                let kind = match op.operator.as_slice() {
                    b"Tj" => ShowKind::Tj,
                    b"TJ" => ShowKind::TJ,
                    b"'" => ShowKind::Quote,
                    _ => ShowKind::DQuote,
                };
                if matches!(kind, ShowKind::Quote | ShowKind::DQuote) {
                    if kind == ShowKind::DQuote {
                        if let [aw, ac, ..] = nums.as_slice() {
                            gs.tw = *aw;
                            gs.tc = *ac;
                        }
                    }
                    tlm = Matrix::translate(0.0, -gs.tl).then(&tlm);
                    tm = tlm;
                }
                let items: Vec<&Value> = match (kind, o.last().map(|x| &x.value)) {
                    (ShowKind::TJ, Some(Value::Array(a))) => a.iter().collect(),
                    (_, Some(v @ Value::Str(_))) => vec![v],
                    _ => Vec::new(),
                };
                let mut show = ShowOp {
                    op: i,
                    kind,
                    glyphs: Vec::new(),
                    advance: 0.0,
                    size: gs.size,
                    vertical: gs.font.as_ref().is_some_and(|f| f.vertical),
                    bt: cur_bt,
                    artifact: marked.iter().any(|a| *a),
                    hidden: gs.mode == 3 || gs.mode == 7,
                    font_name: gs.font_name.clone(),
                    font_id: gs.font_id,
                    font_base: gs.font_base.clone(),
                    bold: gs.font.as_ref().is_some_and(|f| f.bold) || gs.mode == 2,
                    italic: gs.font.as_ref().is_some_and(|f| f.italic),
                    fill: gs.fill,
                };
                let start_tm = tm;
                for item in items {
                    match item {
                        Value::Num(n) => {
                            let adj = -n / 1000.0 * gs.size;
                            tm = if show.vertical {
                                Matrix::translate(0.0, adj).then(&tm)
                            } else {
                                Matrix::translate(adj * gs.th, 0.0).then(&tm)
                            };
                        }
                        Value::Str(s) => {
                            let Some(font) = gs.font.clone() else {
                                continue;
                            };
                            for d in font.decode(s) {
                                let trm =
                                    Matrix::new(gs.size * gs.th, 0.0, 0.0, gs.size, 0.0, gs.rise)
                                        .then(&tm)
                                        .then(&gs.ctm);
                                let (x0, x1, y0, y1) = if font.vertical {
                                    (-0.5, 0.5, -1.0, 0.0)
                                } else {
                                    (0.0, d.width, font.descent, font.ascent)
                                };
                                if glyph_count < MAX_GLYPHS {
                                    glyph_count += 1;
                                    show.glyphs.push(ScanGlyph {
                                        text: d.text.clone(),
                                        bbox: trm.map_rect(&Rect::new(x0, y0, x1, y1)),
                                    });
                                }
                                let ws = if d.word_space { gs.tw } else { 0.0 };
                                tm = if font.vertical {
                                    Matrix::translate(0.0, -gs.size + gs.tc + ws).then(&tm)
                                } else {
                                    Matrix::translate((d.width * gs.size + gs.tc + ws) * gs.th, 0.0)
                                        .then(&tm)
                                };
                            }
                        }
                        _ => {}
                    }
                }
                // Advance in text space (before Tz): the x offset from start to end divided by th.
                let inv = start_tm.invert();
                show.advance = match inv {
                    Some(inv) => {
                        let (x, _) = tm.then(&inv).apply(0.0, 0.0);
                        if gs.th.abs() > 1e-9 {
                            x / gs.th
                        } else {
                            0.0
                        }
                    }
                    None => 0.0,
                };
                shows.push(show);
            }
            b"BMC" | b"BDC" => {
                let tag = o.first().and_then(|x| x.value.name()).unwrap_or(b"");
                if marked.len() < 256 {
                    marked.push(tag == b"Artifact");
                } else {
                    marked.push(false);
                }
            }
            b"EMC" => {
                marked.pop();
            }
            b"Do" => {
                if let Some(Value::Name(n)) = o.first().map(|x| &x.value) {
                    if let Some((id, Object::Stream(s))) = resource(pdf, &res, b"XObject", n) {
                        let is_image = matches!(s.dict.get(b"Subtype"), Ok(Object::Name(t)) if t.as_slice() == b"Image");
                        if is_image {
                            images.push(ImageUse {
                                op: i,
                                name: Some(n.clone()),
                                xobject: id,
                                ctm: gs.ctm,
                                width: int_of(pdf, s.dict.get(b"Width").ok()),
                                height: int_of(pdf, s.dict.get(b"Height").ok()),
                            });
                        }
                    }
                }
            }
            b"BI" => {
                let dim = |k1: &[u8], k2: &[u8]| -> i64 {
                    op.inline
                        .as_ref()
                        .and_then(|inl| {
                            inl.dict
                                .iter()
                                .find(|(k, _)| k.as_slice() == k1 || k.as_slice() == k2)
                                .and_then(|(_, v)| v.num())
                        })
                        .unwrap_or(0.0) as i64
                };
                images.push(ImageUse {
                    op: i,
                    name: None,
                    xobject: None,
                    ctm: gs.ctm,
                    width: dim(b"W", b"Width"),
                    height: dim(b"H", b"Height"),
                });
            }
            _ => {}
        }
    }
    Ok(Scan {
        content,
        shows,
        bts,
        images,
    })
}
