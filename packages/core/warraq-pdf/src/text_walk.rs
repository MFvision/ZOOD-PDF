//! A minimal content-stream interpreter for TEXT POSITIONING only.
//!
//! It tracks the graphics CTM and the PDF text state so that every text-showing
//! operator can be located in page space. That is what an editor needs in order
//! to say "this run belongs to the paragraph the user clicked".
use lopdf::content::Operation;
use lopdf::Object;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Matrix(pub [f32; 6]);

impl Matrix {
    pub const IDENTITY: Matrix = Matrix([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);

    /// Concatenation in PDF order: apply `self` first, then `other`.
    pub fn then(self, other: Matrix) -> Matrix {
        let (a, b) = (self.0, other.0);
        Matrix([
            a[0] * b[0] + a[1] * b[2],
            a[0] * b[1] + a[1] * b[3],
            a[2] * b[0] + a[3] * b[2],
            a[2] * b[1] + a[3] * b[3],
            a[4] * b[0] + a[5] * b[2] + b[4],
            a[4] * b[1] + a[5] * b[3] + b[5],
        ])
    }

    pub fn apply(self, x: f32, y: f32) -> (f32, f32) {
        let m = self.0;
        (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])
    }

    /// Inverse of the affine matrix, or `None` when it is degenerate.
    pub fn invert(self) -> Option<Matrix> {
        let m = self.0;
        let det = m[0] * m[3] - m[1] * m[2];
        if det.abs() < 1e-9 {
            return None;
        }
        Some(Matrix([
            m[3] / det,
            -m[1] / det,
            -m[2] / det,
            m[0] / det,
            (m[2] * m[5] - m[3] * m[4]) / det,
            (m[1] * m[4] - m[0] * m[5]) / det,
        ]))
    }

    /// Uniform scale factor of the matrix (for font size in page units).
    pub fn scale(self) -> f32 {
        let m = self.0;
        ((m[0] * m[0] + m[1] * m[1]).sqrt() + (m[2] * m[2] + m[3] * m[3]).sqrt()) / 2.0
    }
}

/// One text-showing operator located in page space.
#[derive(Debug, Clone, PartialEq)]
pub struct ShowRun {
    /// Index into the operation list the walker was given.
    pub op_index: usize,
    /// Pen origin in page space (PDF user space, y up).
    pub x: f32,
    pub y: f32,
    /// Font size in page units.
    pub size: f32,
    /// Resource name of the font in effect.
    pub font: Vec<u8>,
}

fn num(o: &Object) -> f32 {
    match o {
        Object::Integer(i) => *i as f32,
        Object::Real(r) => *r,
        _ => 0.0,
    }
}

/// The transform still in effect after the last operator.
///
/// Content streams are often left unbalanced — Skia (Chrome, Google Docs) opens
/// the page with `q <scale> 0 0 -<scale> 0 <height> cm` and never closes it — so
/// anything appended inherits that transform unless it is undone first.
pub fn final_ctm(ops: &[Operation]) -> Matrix {
    let mut ctm = Matrix::IDENTITY;
    let mut stack: Vec<Matrix> = vec![];
    for op in ops {
        let a = &op.operands;
        match op.operator.as_str() {
            "q" => stack.push(ctm),
            "Q" => ctm = stack.pop().unwrap_or(Matrix::IDENTITY),
            "cm" if a.len() >= 6 => {
                ctm = Matrix([
                    num(&a[0]),
                    num(&a[1]),
                    num(&a[2]),
                    num(&a[3]),
                    num(&a[4]),
                    num(&a[5]),
                ])
                .then(ctm)
            }
            _ => {}
        }
    }
    ctm
}

/// How many `q` a content stream leaves unclosed.
///
/// The dangling save carries more than a transform. A clip path set inside the
/// same `q` survives too, and it silently swallows anything drawn afterwards:
/// on a Chrome-generated page, appended text simply never appeared, in the
/// render or in the extracted text. Popping the stack restores both.
pub fn unbalanced_q(ops: &[Operation]) -> usize {
    let mut depth = 0usize;
    for op in ops {
        match op.operator.as_str() {
            "q" => depth += 1,
            "Q" => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    depth
}

/// Locate every text-showing operator (`Tj`, `TJ`, `'`, `"`) in page space.
///
/// Glyph advances are not computed (that needs the font's widths); the origin,
/// size and font resource are enough to assign a run to a paragraph box.
pub fn locate_show_runs(ops: &[Operation]) -> Vec<ShowRun> {
    let mut out = vec![];
    let mut ctm = Matrix::IDENTITY;
    let mut stack: Vec<Matrix> = vec![];
    let mut tm = Matrix::IDENTITY;
    let mut tlm = Matrix::IDENTITY;
    let mut leading = 0.0f32;
    let mut size = 0.0f32;
    let mut font: Vec<u8> = vec![];
    for (i, op) in ops.iter().enumerate() {
        let a = &op.operands;
        match op.operator.as_str() {
            "q" => stack.push(ctm),
            "Q" => ctm = stack.pop().unwrap_or(Matrix::IDENTITY),
            "cm" if a.len() >= 6 => {
                ctm = Matrix([
                    num(&a[0]),
                    num(&a[1]),
                    num(&a[2]),
                    num(&a[3]),
                    num(&a[4]),
                    num(&a[5]),
                ])
                .then(ctm);
            }
            "BT" => {
                tm = Matrix::IDENTITY;
                tlm = tm;
            }
            "Tf" if a.len() >= 2 => {
                if let Object::Name(n) = &a[0] {
                    font = n.clone();
                }
                size = num(&a[1]);
            }
            "TL" if !a.is_empty() => leading = num(&a[0]),
            "Td" if a.len() >= 2 => {
                tlm = Matrix([1.0, 0.0, 0.0, 1.0, num(&a[0]), num(&a[1])]).then(tlm);
                tm = tlm;
            }
            "TD" if a.len() >= 2 => {
                leading = -num(&a[1]);
                tlm = Matrix([1.0, 0.0, 0.0, 1.0, num(&a[0]), num(&a[1])]).then(tlm);
                tm = tlm;
            }
            "Tm" if a.len() >= 6 => {
                tlm = Matrix([
                    num(&a[0]),
                    num(&a[1]),
                    num(&a[2]),
                    num(&a[3]),
                    num(&a[4]),
                    num(&a[5]),
                ]);
                tm = tlm;
            }
            "T*" => {
                tlm = Matrix([1.0, 0.0, 0.0, 1.0, 0.0, -leading]).then(tlm);
                tm = tlm;
            }
            "Tj" | "TJ" | "'" | "\"" => {
                if matches!(op.operator.as_str(), "'" | "\"") {
                    tlm = Matrix([1.0, 0.0, 0.0, 1.0, 0.0, -leading]).then(tlm);
                    tm = tlm;
                }
                let full = tm.then(ctm);
                let (x, y) = full.apply(0.0, 0.0);
                out.push(ShowRun {
                    op_index: i,
                    x,
                    y,
                    size: size * full.scale(),
                    font: font.clone(),
                });
            }
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::content::Content;

    fn ops(src: &[u8]) -> Vec<Operation> {
        Content::decode(src).unwrap().operations
    }

    #[test]
    fn tm_td_and_tstar_place_runs_in_page_space() {
        let runs = locate_show_runs(&ops(
            b"BT /F1 12 Tf 14 TL 1 0 0 1 100 700 Tm (a) Tj 0 -20 Td (b) Tj T* (c) Tj ET",
        ));
        assert_eq!(runs.len(), 3);
        assert_eq!((runs[0].x, runs[0].y, runs[0].size), (100.0, 700.0, 12.0));
        assert_eq!((runs[1].x, runs[1].y), (100.0, 680.0));
        assert_eq!((runs[2].x, runs[2].y), (100.0, 666.0));
        assert_eq!(runs[0].font, b"F1".to_vec());
    }

    #[test]
    fn ctm_scales_position_and_font_size_and_q_restores_it() {
        let runs = locate_show_runs(&ops(b"q 2 0 0 2 10 10 cm BT /F1 10 Tf 1 0 0 1 5 5 Tm (a) Tj ET Q BT /F1 10 Tf 1 0 0 1 5 5 Tm (b) Tj ET"));
        assert_eq!((runs[0].x, runs[0].y, runs[0].size), (20.0, 20.0, 20.0));
        assert_eq!((runs[1].x, runs[1].y, runs[1].size), (5.0, 5.0, 10.0));
    }

    #[test]
    fn final_ctm_reports_an_unbalanced_page_transform_and_inverts_it() {
        let page = ops(b"q 0.75 0 0 -0.75 0 842 cm BT /F1 12 Tf 1 0 0 1 10 10 Tm (a) Tj ET");
        let ctm = final_ctm(&page);
        assert_eq!(ctm, Matrix([0.75, 0.0, 0.0, -0.75, 0.0, 842.0]));
        let inv = ctm.invert().unwrap();
        // applying the inverse then the transform must return the original point
        let (x, y) = inv.then(ctm).apply(100.0, 700.0);
        assert!(
            (x - 100.0).abs() < 0.01 && (y - 700.0).abs() < 0.01,
            "got {x},{y}"
        );
        assert_eq!(final_ctm(&ops(b"q 2 0 0 2 0 0 cm Q")), Matrix::IDENTITY);
    }

    #[test]
    fn quote_operators_advance_a_line_before_showing() {
        let runs = locate_show_runs(&ops(
            b"BT /F1 12 Tf 16 TL 1 0 0 1 50 500 Tm (a) ' (b) Tj ET",
        ));
        assert_eq!((runs[0].x, runs[0].y), (50.0, 484.0));
        assert_eq!((runs[1].x, runs[1].y), (50.0, 484.0));
    }
}
