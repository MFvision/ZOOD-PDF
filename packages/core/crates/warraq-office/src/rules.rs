//! Ruling lines of a page: axis-aligned stroked segments and thin filled rectangles, read from the
//! content stream (and form XObjects) with the warraq-text content lexer.
//!
//! Coordinates are the same as warraq-text's model: PDF points relative to the top-left corner of
//! the visible page box, y growing downwards, `/Rotate` not applied.
//!
//! Hostile input: operations per page, path points, graphics-state depth and form nesting are
//! bounded; nothing panics.

use lopdf::{Dictionary, Object, ObjectId};
use warraq_text::geom::Matrix;
use warraq_text::lexer::{ContentParser, Operand};
use warraq_text::source::{as_number, dict_get, resolve, resolve_dict, stream_data};
use warraq_text::ContentSource;

use crate::error::Result;

/// Maximum operations interpreted per page (including forms).
pub const MAX_OPS: usize = 2_000_000;
/// Maximum segments kept per page.
pub const MAX_SEGMENTS: usize = 20_000;
/// Maximum points in one path.
const MAX_PATH_POINTS: usize = 100_000;
const MAX_DEPTH: usize = 8;
const MAX_GSTATE: usize = 256;
/// A filled rectangle thinner than this (points) is a rule.
const THIN: f64 = 3.0;
/// Shortest segment kept (points).
const MIN_LEN: f64 = 3.0;

/// An axis-aligned ruling segment.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Segment {
    /// `true`: horizontal (constant y); `false`: vertical (constant x).
    pub horizontal: bool,
    /// The constant coordinate (y for horizontal, x for vertical).
    pub pos: f64,
    /// Start and end along the segment (`a0 ≤ a1`).
    pub a0: f64,
    pub a1: f64,
}

#[derive(Clone, Copy)]
enum PathEl {
    Move(f64, f64),
    Line(f64, f64),
    Close,
    Rect(f64, f64, f64, f64),
    /// A curve ends here (not a straight edge).
    Curve(f64, f64),
}

struct Ctx<'a, S: ContentSource + ?Sized> {
    src: &'a S,
    page_box: [f64; 4],
    ops: usize,
    out: Vec<Segment>,
    forms: Vec<ObjectId>,
}

/// Ruling segments of page `index`.
pub fn page_segments<S: ContentSource + ?Sized>(src: &S, index: usize) -> Result<Vec<Segment>> {
    let content = src.page_content(index)?;
    let resources = src.page_resources(index)?;
    let page_box = src.page_box(index)?;
    let mut cx = Ctx {
        src,
        page_box,
        ops: 0,
        out: Vec::new(),
        forms: Vec::new(),
    };
    cx.run(&content, &resources, Matrix::IDENTITY, 0);
    Ok(cx.out)
}

/// Segments from a raw content stream (for tests and fuzzing): no resources, page box given.
pub fn content_segments(content: &[u8], page_box: [f64; 4]) -> Vec<Segment> {
    struct Empty;
    impl ContentSource for Empty {
        fn page_count(&self) -> usize {
            0
        }
        fn page_content(&self, i: usize) -> warraq_text::Result<Vec<u8>> {
            Err(warraq_text::TextError::PageOutOfRange(i))
        }
        fn page_resources(&self, i: usize) -> warraq_text::Result<Dictionary> {
            Err(warraq_text::TextError::PageOutOfRange(i))
        }
        fn page_box(&self, i: usize) -> warraq_text::Result<[f64; 4]> {
            Err(warraq_text::TextError::PageOutOfRange(i))
        }
        fn object(&self, _id: ObjectId) -> Option<&Object> {
            None
        }
    }
    let mut cx = Ctx {
        src: &Empty,
        page_box,
        ops: 0,
        out: Vec::new(),
        forms: Vec::new(),
    };
    cx.run(content, &Dictionary::new(), Matrix::IDENTITY, 0);
    cx.out
}

fn nums(o: &[Operand]) -> Option<Vec<f64>> {
    o.iter().map(Operand::as_f64).collect()
}

impl<S: ContentSource + ?Sized> Ctx<'_, S> {
    fn to_page(&self, m: &Matrix, x: f64, y: f64) -> (f64, f64) {
        let (px, py) = m.apply(x, y);
        let [bx0, _, _, by1] = self.page_box;
        (px - bx0, by1 - py)
    }

    fn push(&mut self, s: Segment) {
        if self.out.len() < MAX_SEGMENTS && s.a1 - s.a0 >= MIN_LEN && s.pos.is_finite() {
            self.out.push(s);
        }
    }

    fn edge(&mut self, a: (f64, f64), b: (f64, f64)) {
        let (dx, dy) = ((b.0 - a.0).abs(), (b.1 - a.1).abs());
        if dy <= 0.8 && dx > dy {
            self.push(Segment {
                horizontal: true,
                pos: (a.1 + b.1) / 2.0,
                a0: a.0.min(b.0),
                a1: a.0.max(b.0),
            });
        } else if dx <= 0.8 && dy > dx {
            self.push(Segment {
                horizontal: false,
                pos: (a.0 + b.0) / 2.0,
                a0: a.1.min(b.1),
                a1: a.1.max(b.1),
            });
        }
    }

    /// A filled (or stroked) axis-aligned box in page coordinates.
    fn filled_box(&mut self, x0: f64, y0: f64, x1: f64, y1: f64) {
        let (w, h) = (x1 - x0, y1 - y0);
        if h <= THIN && w > h {
            self.push(Segment {
                horizontal: true,
                pos: (y0 + y1) / 2.0,
                a0: x0,
                a1: x1,
            });
        } else if w <= THIN && h > w {
            self.push(Segment {
                horizontal: false,
                pos: (x0 + x1) / 2.0,
                a0: y0,
                a1: y1,
            });
        }
    }

    fn paint(&mut self, path: &[PathEl], m: &Matrix, stroke: bool, fill: bool) {
        let mut start: Option<(f64, f64)> = None;
        let mut cur: Option<(f64, f64)> = None;
        let mut poly: Vec<(f64, f64)> = Vec::new();
        let flush_poly = |this: &mut Self, poly: &mut Vec<(f64, f64)>| {
            // A filled closed polygon with 4-5 points that is an axis-aligned box.
            if fill && (4..=5).contains(&poly.len()) {
                let xs = poly.iter().map(|p| p.0);
                let ys = poly.iter().map(|p| p.1);
                let (x0, x1) = (
                    xs.clone().fold(f64::MAX, f64::min),
                    xs.fold(f64::MIN, f64::max),
                );
                let (y0, y1) = (
                    ys.clone().fold(f64::MAX, f64::min),
                    ys.fold(f64::MIN, f64::max),
                );
                let boxy = poly.iter().all(|p| {
                    ((p.0 - x0).abs() < 0.5 || (p.0 - x1).abs() < 0.5)
                        && ((p.1 - y0).abs() < 0.5 || (p.1 - y1).abs() < 0.5)
                });
                if boxy {
                    this.filled_box(x0, y0, x1, y1);
                }
            }
            poly.clear();
        };
        for el in path {
            match *el {
                PathEl::Move(x, y) => {
                    flush_poly(self, &mut poly);
                    let p = self.to_page(m, x, y);
                    start = Some(p);
                    cur = Some(p);
                    poly.push(p);
                }
                PathEl::Line(x, y) => {
                    let p = self.to_page(m, x, y);
                    if let (Some(c), true) = (cur, stroke) {
                        self.edge(c, p);
                    }
                    cur = Some(p);
                    if poly.len() < 8 {
                        poly.push(p);
                    }
                }
                PathEl::Curve(x, y) => {
                    let p = self.to_page(m, x, y);
                    cur = Some(p);
                    // A curve disqualifies the polygon as a box: pad it past the 5-point limit.
                    poly.resize(poly.len().max(6), p);
                }
                PathEl::Close => {
                    if let (Some(c), Some(s), true) = (cur, start, stroke) {
                        self.edge(c, s);
                    }
                    cur = start;
                }
                PathEl::Rect(x, y, w, h) => {
                    flush_poly(self, &mut poly);
                    let pts = [
                        self.to_page(m, x, y),
                        self.to_page(m, x + w, y),
                        self.to_page(m, x + w, y + h),
                        self.to_page(m, x, y + h),
                    ];
                    if stroke {
                        for i in 0..4 {
                            if let (Some(a), Some(b)) = (pts.get(i), pts.get((i + 1) % 4)) {
                                self.edge(*a, *b);
                            }
                        }
                    }
                    if fill {
                        poly.extend_from_slice(&pts);
                        flush_poly(self, &mut poly);
                    }
                    start = pts.first().copied();
                    cur = start;
                }
            }
        }
        flush_poly(self, &mut poly);
    }

    fn run(&mut self, content: &[u8], resources: &Dictionary, ctm0: Matrix, depth: usize) {
        let mut ctm = ctm0;
        let mut stack: Vec<Matrix> = Vec::new();
        let mut path: Vec<PathEl> = Vec::new();
        let mut in_text = false;
        for op in ContentParser::new(content) {
            self.ops += 1;
            if self.ops > MAX_OPS {
                return;
            }
            let o = &op.operands;
            match op.operator.as_slice() {
                b"q" => {
                    if stack.len() < MAX_GSTATE {
                        stack.push(ctm);
                    }
                }
                b"Q" => {
                    if let Some(m) = stack.pop() {
                        ctm = m;
                    }
                }
                b"cm" => {
                    if let Some([a, b, c, d, e, f]) = nums(o).as_deref() {
                        ctm = Matrix::new(*a, *b, *c, *d, *e, *f).then(&ctm);
                    }
                }
                b"BT" => in_text = true,
                b"ET" => in_text = false,
                b"m" | b"l" | b"c" | b"v" | b"y" | b"re"
                    if path.len() < MAX_PATH_POINTS && !in_text =>
                {
                    let v = nums(o).unwrap_or_default();
                    let el = match (op.operator.as_slice(), v.as_slice()) {
                        (b"m", [x, y]) => Some(PathEl::Move(*x, *y)),
                        (b"l", [x, y]) => Some(PathEl::Line(*x, *y)),
                        (b"c", [.., x, y]) | (b"v", [.., x, y]) | (b"y", [.., x, y]) => {
                            Some(PathEl::Curve(*x, *y))
                        }
                        (b"re", [x, y, w, h]) => Some(PathEl::Rect(*x, *y, *w, *h)),
                        _ => None,
                    };
                    if let Some(el) = el {
                        path.push(el);
                    }
                }
                b"h" => path.push(PathEl::Close),
                b"S" | b"s" | b"f" | b"F" | b"f*" | b"B" | b"B*" | b"b" | b"b*" => {
                    let k = op.operator.as_slice();
                    let mut p = std::mem::take(&mut path);
                    if matches!(k, b"s" | b"b" | b"b*") {
                        p.push(PathEl::Close);
                    }
                    let stroke = matches!(k, b"S" | b"s" | b"B" | b"B*" | b"b" | b"b*");
                    let fill = !matches!(k, b"S" | b"s");
                    self.paint(&p, &ctm, stroke, fill);
                }
                b"n" => path.clear(),
                b"Do" => {
                    if let Some(Operand::Name(n)) = o.first() {
                        self.form(resources, n, &ctm, depth);
                    }
                }
                _ => {}
            }
        }
    }

    fn form(&mut self, resources: &Dictionary, name: &[u8], ctm: &Matrix, depth: usize) {
        if depth >= MAX_DEPTH {
            return;
        }
        let src = self.src;
        let Some(xobjs) = dict_get(src, resources, b"XObject").and_then(|o| resolve_dict(src, o))
        else {
            return;
        };
        let Ok(entry) = xobjs.get(name) else { return };
        let id = match entry {
            Object::Reference(id) => Some(*id),
            _ => None,
        };
        if id.is_some_and(|id| self.forms.contains(&id)) {
            return;
        }
        let Some(Object::Stream(stream)) = resolve(src, entry) else {
            return;
        };
        if !matches!(stream.dict.get(b"Subtype"), Ok(Object::Name(n)) if n.as_slice() == b"Form") {
            return;
        }
        let m = match dict_get(src, &stream.dict, b"Matrix") {
            Some(Object::Array(a)) => {
                let v: Vec<f64> = a
                    .iter()
                    .filter_map(|x| resolve(src, x).and_then(as_number))
                    .collect();
                match v.as_slice() {
                    [a, b, c, d, e, f] => Matrix::new(*a, *b, *c, *d, *e, *f),
                    _ => Matrix::IDENTITY,
                }
            }
            _ => Matrix::IDENTITY,
        };
        let Ok(data) = stream_data(stream) else {
            return;
        };
        let res = dict_get(src, &stream.dict, b"Resources")
            .and_then(|o| resolve_dict(src, o))
            .cloned()
            .unwrap_or_else(|| resources.clone());
        if let Some(id) = id {
            self.forms.push(id);
        }
        self.run(&data, &res, m.then(ctm), depth + 1);
        if id.is_some() {
            self.forms.pop();
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    const PAGE: [f64; 4] = [0.0, 0.0, 600.0, 800.0];

    #[test]
    fn stroked_lines_and_rects() {
        let s = content_segments(b"1 w 100 700 m 300 700 l S 50 50 100 20 re S", PAGE);
        assert_eq!(s.len(), 5);
        assert!(
            s[0].horizontal
                && (s[0].pos - 100.0).abs() < 1e-9
                && s[0].a0 == 100.0
                && s[0].a1 == 300.0
        );
        assert_eq!(s.iter().filter(|x| x.horizontal).count(), 3);
    }

    #[test]
    fn thin_filled_rects_are_rules_and_big_fills_are_not() {
        // Chrome style: a flipped CTM and 1-unit rectangles.
        let s = content_segments(
            b".24 0 0 -.24 0 800 cm q 3.125 0 0 3.125 0 0 cm 642 70 1 40 re f 502 70 141 1 re f 10 10 300 300 re f Q",
            PAGE,
        );
        assert_eq!(s.len(), 2);
        let v = s.iter().find(|x| !x.horizontal).unwrap();
        assert!((v.pos - 642.5 * 0.75).abs() < 0.01, "{v:?}");
        assert!(
            (v.a0 - 52.5).abs() < 0.01 && (v.a1 - 82.5).abs() < 0.01,
            "{v:?}"
        );
    }

    #[test]
    fn text_curves_and_clips_are_ignored() {
        let s = content_segments(
            b"BT 10 10 m ET 0 0 m 10 10 20 20 30 0 c S 0 0 100 100 re W n",
            PAGE,
        );
        assert!(s.is_empty(), "{s:?}");
    }

    #[test]
    fn hostile_streams_do_not_panic() {
        for c in [
            &b"re re re f"[..],
            b"1e308 1e308 m 1e308 -1e308 l S",
            b"q q q Q Q Q Q Q cm cm",
            b"(unterminated",
        ] {
            let _ = content_segments(c, PAGE);
        }
    }
}
