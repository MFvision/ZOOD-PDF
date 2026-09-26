//! Page geometry from content streams: the bounding box of what a page paints (Trim margins)
//! and where each image XObject is placed (Compress picks a target resolution from the
//! placement size). Text boxes come from warraq-text's interpreter (real font metrics); paths,
//! images and form XObjects are walked here with the CTM. Bounded by operator count, form
//! depth and a cycle check; never panics.

use std::collections::HashMap;
use warraq_pdf::limits::decode_stream;
use warraq_pdf::lopdf::{Dictionary, Object, ObjectId};
use warraq_pdf::pages::PageInfo;
use warraq_pdf::Pdf;
use warraq_text::geom::Matrix;
use warraq_text::interp::Interpreter;
use warraq_text::lexer::{ContentParser, Operand};
use warraq_text::source::DocSource;

/// Most operators walked per page (including nested forms).
const MAX_OPS: usize = 5_000_000;
/// Deepest form XObject nesting walked.
const MAX_FORM_DEPTH: usize = 12;
/// Largest decoded content handled per page.
const MAX_CONTENT: usize = 64 << 20;

/// An axis-aligned box `[x0, y0, x1, y1]` accumulator.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct BBox(pub Option<[f64; 4]>);

impl BBox {
    pub fn add(&mut self, x: f64, y: f64) {
        if !(x.is_finite() && y.is_finite()) {
            return;
        }
        self.0 = Some(match self.0 {
            None => [x, y, x, y],
            Some([a, b, c, d]) => [a.min(x), b.min(y), c.max(x), d.max(y)],
        });
    }
    pub fn union(&mut self, o: &BBox) {
        if let Some([a, b, c, d]) = o.0 {
            self.add(a, b);
            self.add(c, d);
        }
    }
}

/// What a page paints.
#[derive(Debug, Default, Clone)]
pub struct Geometry {
    /// Union of painted text, paths (except white fills) and images, in default user space.
    pub bbox: BBox,
    /// Largest placement size (points, width × height) of each image XObject on the page.
    pub images: HashMap<ObjectId, (f64, f64)>,
}

#[derive(Clone)]
struct GState {
    ctm: Matrix,
    fill_white: bool,
    stroke_white: bool,
    line_width: f64,
}

/// Decoded, concatenated `/Contents` of a page.
pub fn page_content(pdf: &Pdf, page: &PageInfo) -> Vec<u8> {
    let mut out = Vec::new();
    let Some(d) = pdf.get_dict(page.id) else {
        return out;
    };
    let Some(contents) = d.get(b"Contents").ok().and_then(|c| pdf.resolve(c)) else {
        return out;
    };
    let items: Vec<&Object> = match contents {
        Object::Array(a) => a.iter().take(10_000).collect(),
        other => vec![other],
    };
    for it in items {
        if let Some(Object::Stream(s)) = pdf.resolve(it) {
            if let Ok(data) = decode_stream(s, pdf.limits()) {
                if out.len() + data.len() > MAX_CONTENT {
                    break;
                }
                out.extend_from_slice(&data);
                out.push(b'\n');
            }
        }
    }
    out
}

fn resources_of(pdf: &Pdf, o: Option<&Object>) -> Dictionary {
    o.and_then(|o| pdf.resolve(o))
        .and_then(|o| o.as_dict().ok())
        .cloned()
        .unwrap_or_default()
}

fn nums(ops: &[Operand]) -> Vec<f64> {
    ops.iter().filter_map(Operand::as_f64).collect()
}

fn all_eq(v: &[f64], x: f64) -> bool {
    !v.is_empty() && v.iter().all(|n| (n - x).abs() < 1e-6)
}

struct Walker<'a> {
    pdf: &'a Pdf,
    ops: usize,
    forms: Vec<ObjectId>,
    geo: Geometry,
}

impl Walker<'_> {
    fn add_quad(&mut self, ctm: &Matrix) {
        for (x, y) in [(0.0, 0.0), (1.0, 0.0), (0.0, 1.0), (1.0, 1.0)] {
            let (px, py) = ctm.apply(x, y);
            self.geo.bbox.add(px, py);
        }
    }

    fn run(&mut self, content: &[u8], resources: &Dictionary, initial: GState, depth: usize) {
        let mut gs = initial;
        let mut stack: Vec<GState> = Vec::new();
        let mut path = BBox::default();
        for op in ContentParser::new(content) {
            self.ops += 1;
            if self.ops > MAX_OPS {
                return;
            }
            let o = op.operands.as_slice();
            let pt = |x: f64, y: f64, path: &mut BBox| {
                let (px, py) = gs.ctm.apply(x, y);
                path.add(px, py);
            };
            match op.operator.as_slice() {
                b"q" => {
                    if stack.len() < 256 {
                        stack.push(gs.clone());
                    }
                }
                b"Q" => {
                    if let Some(s) = stack.pop() {
                        gs = s;
                    }
                }
                b"cm" => {
                    if let [a, b, c, d, e, f] = nums(o).as_slice() {
                        gs.ctm = Matrix::new(*a, *b, *c, *d, *e, *f).then(&gs.ctm);
                    }
                }
                b"w" => gs.line_width = nums(o).first().copied().unwrap_or(1.0).abs(),
                b"g" => gs.fill_white = all_eq(&nums(o), 1.0),
                b"rg" => gs.fill_white = all_eq(&nums(o), 1.0),
                b"k" => gs.fill_white = all_eq(&nums(o), 0.0) && nums(o).len() == 4,
                b"G" => gs.stroke_white = all_eq(&nums(o), 1.0),
                b"RG" => gs.stroke_white = all_eq(&nums(o), 1.0),
                b"K" => gs.stroke_white = all_eq(&nums(o), 0.0) && nums(o).len() == 4,
                b"sc" | b"scn" => {
                    let n = nums(o);
                    gs.fill_white = matches!(n.len(), 1 | 3) && all_eq(&n, 1.0);
                }
                b"SC" | b"SCN" => {
                    let n = nums(o);
                    gs.stroke_white = matches!(n.len(), 1 | 3) && all_eq(&n, 1.0);
                }
                b"cs" => gs.fill_white = false,
                b"CS" => gs.stroke_white = false,
                b"m" | b"l" => {
                    if let [x, y] = nums(o).as_slice() {
                        pt(*x, *y, &mut path);
                    }
                }
                b"c" => {
                    let n = nums(o);
                    for p in n.chunks_exact(2) {
                        if let [x, y] = p {
                            pt(*x, *y, &mut path);
                        }
                    }
                }
                b"v" | b"y" => {
                    let n = nums(o);
                    for p in n.chunks_exact(2) {
                        if let [x, y] = p {
                            pt(*x, *y, &mut path);
                        }
                    }
                }
                b"re" => {
                    if let [x, y, w, h] = nums(o).as_slice() {
                        pt(*x, *y, &mut path);
                        pt(x + w, y + h, &mut path);
                        pt(x + w, *y, &mut path);
                        pt(*x, y + h, &mut path);
                    }
                }
                paint @ (b"S" | b"s" | b"f" | b"F" | b"f*" | b"B" | b"B*" | b"b" | b"b*") => {
                    let stroke = matches!(paint, b"S" | b"s" | b"B" | b"B*" | b"b" | b"b*");
                    let fill = !matches!(paint, b"S" | b"s");
                    let visible = (stroke && !gs.stroke_white) || (fill && !gs.fill_white);
                    if visible {
                        if let (true, Some([a, b, c, d])) = (stroke, path.0) {
                            // Half the line width, scaled by the CTM, around stroked paths.
                            let (sx, sy) =
                                gs.ctm.apply_vec(gs.line_width / 2.0, gs.line_width / 2.0);
                            let r = sx.abs().max(sy.abs()).min(50.0);
                            path.0 = Some([a - r, b - r, c + r, d + r]);
                        }
                        self.geo.bbox.union(&path);
                    }
                    path = BBox::default();
                }
                b"n" => path = BBox::default(),
                b"BI" => {
                    let ctm = gs.ctm;
                    self.add_quad(&ctm);
                }
                b"Do" => {
                    if let Some(Operand::Name(n)) = o.first() {
                        self.xobject(resources, n, &gs, depth);
                    }
                }
                _ => {}
            }
        }
    }

    fn xobject(&mut self, resources: &Dictionary, name: &[u8], gs: &GState, depth: usize) {
        let pdf = self.pdf;
        let Some(xo) = resources
            .get(b"XObject")
            .ok()
            .and_then(|o| pdf.resolve(o))
            .and_then(|o| o.as_dict().ok())
        else {
            return;
        };
        let Some(id) = xo.get(name).ok().and_then(|o| o.as_reference().ok()) else {
            return;
        };
        let Some(Object::Stream(s)) = pdf.get(id) else {
            return;
        };
        match s.dict.get(b"Subtype").and_then(Object::as_name) {
            Ok(b"Image") => {
                let m = gs.ctm;
                self.add_quad(&m);
                let w = (m.a * m.a + m.b * m.b).sqrt();
                let h = (m.c * m.c + m.d * m.d).sqrt();
                let e = self.geo.images.entry(id).or_insert((0.0, 0.0));
                e.0 = e.0.max(w);
                e.1 = e.1.max(h);
            }
            Ok(b"Form") => {
                if depth >= MAX_FORM_DEPTH || self.forms.contains(&id) {
                    return;
                }
                let Ok(data) = decode_stream(s, pdf.limits()) else {
                    return;
                };
                let matrix = match s.dict.get(b"Matrix").ok().and_then(|o| pdf.resolve(o)) {
                    Some(Object::Array(a)) => {
                        let v: Vec<f64> = a
                            .iter()
                            .filter_map(|o| match pdf.resolve(o) {
                                Some(Object::Integer(i)) => Some(*i as f64),
                                Some(Object::Real(r)) => Some(f64::from(*r)),
                                _ => None,
                            })
                            .collect();
                        match v.as_slice() {
                            [a, b, c, d, e, f] => Matrix::new(*a, *b, *c, *d, *e, *f),
                            _ => Matrix::IDENTITY,
                        }
                    }
                    _ => Matrix::IDENTITY,
                };
                let res = match s.dict.get(b"Resources") {
                    Ok(r) => resources_of(pdf, Some(r)),
                    Err(_) => resources.clone(),
                };
                let mut inner = gs.clone();
                inner.ctm = matrix.then(&gs.ctm);
                self.forms.push(id);
                self.run(&data, &res, inner, depth + 1);
                self.forms.pop();
            }
            _ => {}
        }
    }
}

/// Walk one page. `text` adds the boxes of visible glyphs (needs font metrics: slower).
pub fn page_geometry(pdf: &Pdf, page: &PageInfo, text: bool) -> Geometry {
    let content = page_content(pdf, page);
    let resources = resources_of(pdf, page.resources.as_ref());
    let mut w = Walker {
        pdf,
        ops: 0,
        forms: Vec::new(),
        geo: Geometry::default(),
    };
    w.run(
        &content,
        &resources,
        GState {
            ctm: Matrix::IDENTITY,
            fill_white: false,
            stroke_white: false,
            line_width: 1.0,
        },
        0,
    );
    let mut geo = w.geo;
    if text {
        let src = DocSource::borrowed(pdf.document());
        let mut interp = Interpreter::new(&src);
        for g in interp.run_content(&content, &resources) {
            if g.hidden || g.text.trim().is_empty() {
                continue;
            }
            let b = g.bbox;
            geo.bbox.add(b.x0, b.y0);
            geo.bbox.add(b.x1, b.y1);
        }
    }
    geo
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
mod tests {
    use super::*;
    use warraq_pdf::builder::{sample_pdf, SampleOptions};
    use warraq_pdf::pages;

    #[test]
    fn sample_page_box_covers_rectangle_and_text() {
        // sample: "72 600 200 100 re f" and "Page N" at 72 720 in 24pt Helvetica
        let pdf = Pdf::open(sample_pdf(1, &SampleOptions::default()).unwrap(), None).unwrap();
        let p = &pages::flatten(&pdf).unwrap()[0];
        let g = page_geometry(&pdf, p, false);
        assert_eq!(g.bbox.0, Some([72.0, 600.0, 272.0, 700.0]));
        let g = page_geometry(&pdf, p, true);
        let [x0, y0, x1, y1] = g.bbox.0.unwrap();
        assert_eq!((x0, y0, x1), (72.0, 600.0, 272.0));
        assert!(y1 > 735.0 && y1 < 750.0, "{y1}");
    }

    #[test]
    fn hostile_content_is_bounded() {
        let pdf = Pdf::open(sample_pdf(1, &SampleOptions::default()).unwrap(), None).unwrap();
        let mut w = Walker {
            pdf: &pdf,
            ops: 0,
            forms: vec![],
            geo: Geometry::default(),
        };
        let st = GState {
            ctm: Matrix::IDENTITY,
            fill_white: false,
            stroke_white: false,
            line_width: 1.0,
        };
        let junk = "q ".repeat(100_000)
            + &"1e308 1e308 m 1e308 1e308 l S ".repeat(1000)
            + "/X Do BI ID xx EI";
        w.run(junk.as_bytes(), &Dictionary::new(), st, 0);
        assert!(w.geo.bbox.0.is_some());
    }
}
