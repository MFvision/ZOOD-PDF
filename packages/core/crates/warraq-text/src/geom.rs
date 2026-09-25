//! Minimal 2-D geometry: affine matrices in PDF order and axis-aligned rectangles.

use serde::Serialize;

/// A PDF transformation matrix `[a b c d e f]` (row-vector convention: `p' = p × M`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Matrix {
    pub a: f64,
    pub b: f64,
    pub c: f64,
    pub d: f64,
    pub e: f64,
    pub f: f64,
}

impl Default for Matrix {
    fn default() -> Self {
        Self::IDENTITY
    }
}

impl Matrix {
    pub const IDENTITY: Matrix = Matrix {
        a: 1.0,
        b: 0.0,
        c: 0.0,
        d: 1.0,
        e: 0.0,
        f: 0.0,
    };

    pub fn new(a: f64, b: f64, c: f64, d: f64, e: f64, f: f64) -> Self {
        let m = Matrix { a, b, c, d, e, f };
        if m.is_finite() {
            m
        } else {
            Matrix::IDENTITY
        }
    }

    pub fn translate(tx: f64, ty: f64) -> Self {
        Matrix::new(1.0, 0.0, 0.0, 1.0, tx, ty)
    }

    /// `self × other` — apply `self` first, then `other`.
    pub fn then(&self, o: &Matrix) -> Matrix {
        Matrix::new(
            self.a * o.a + self.b * o.c,
            self.a * o.b + self.b * o.d,
            self.c * o.a + self.d * o.c,
            self.c * o.b + self.d * o.d,
            self.e * o.a + self.f * o.c + o.e,
            self.e * o.b + self.f * o.d + o.f,
        )
    }

    pub fn apply(&self, x: f64, y: f64) -> (f64, f64) {
        (
            x * self.a + y * self.c + self.e,
            x * self.b + y * self.d + self.f,
        )
    }

    /// Transform a vector (no translation).
    pub fn apply_vec(&self, x: f64, y: f64) -> (f64, f64) {
        (x * self.a + y * self.c, x * self.b + y * self.d)
    }

    pub fn is_finite(&self) -> bool {
        [self.a, self.b, self.c, self.d, self.e, self.f]
            .iter()
            .all(|v| v.is_finite())
    }
}

/// Axis-aligned rectangle `x0 ≤ x1`, `y0 ≤ y1`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Default)]
pub struct Rect {
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
}

impl Rect {
    pub fn new(x0: f64, y0: f64, x1: f64, y1: f64) -> Self {
        Rect {
            x0: x0.min(x1),
            y0: y0.min(y1),
            x1: x0.max(x1),
            y1: y0.max(y1),
        }
    }

    pub fn from_points(pts: &[(f64, f64)]) -> Self {
        let mut r = Rect {
            x0: f64::MAX,
            y0: f64::MAX,
            x1: f64::MIN,
            y1: f64::MIN,
        };
        for &(x, y) in pts {
            r.x0 = r.x0.min(x);
            r.y0 = r.y0.min(y);
            r.x1 = r.x1.max(x);
            r.y1 = r.y1.max(y);
        }
        if r.x0 > r.x1 {
            Rect::default()
        } else {
            r
        }
    }

    pub fn union(&self, o: &Rect) -> Rect {
        Rect {
            x0: self.x0.min(o.x0),
            y0: self.y0.min(o.y0),
            x1: self.x1.max(o.x1),
            y1: self.y1.max(o.y1),
        }
    }

    pub fn width(&self) -> f64 {
        self.x1 - self.x0
    }

    pub fn height(&self) -> f64 {
        self.y1 - self.y0
    }

    pub fn cx(&self) -> f64 {
        (self.x0 + self.x1) / 2.0
    }

    pub fn cy(&self) -> f64 {
        (self.y0 + self.y1) / 2.0
    }

    /// Length of the overlap of the x-projections (0 when disjoint).
    pub fn x_overlap(&self, o: &Rect) -> f64 {
        (self.x1.min(o.x1) - self.x0.max(o.x0)).max(0.0)
    }

    /// Length of the overlap of the y-projections (0 when disjoint).
    pub fn y_overlap(&self, o: &Rect) -> f64 {
        (self.y1.min(o.y1) - self.y0.max(o.y0)).max(0.0)
    }

    /// Round to 1/100 pt for stable JSON.
    pub fn rounded(&self) -> Rect {
        let r = |v: f64| (v * 100.0).round() / 100.0;
        Rect {
            x0: r(self.x0),
            y0: r(self.y0),
            x1: r(self.x1),
            y1: r(self.y1),
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    #[test]
    fn matrix_concat_order() {
        let scale = Matrix::new(2.0, 0.0, 0.0, 2.0, 0.0, 0.0);
        let tr = Matrix::translate(10.0, 5.0);
        // scale first then translate
        assert_eq!(scale.then(&tr).apply(1.0, 1.0), (12.0, 7.0));
        // translate first then scale
        assert_eq!(tr.then(&scale).apply(1.0, 1.0), (22.0, 12.0));
    }

    #[test]
    fn non_finite_matrix_becomes_identity() {
        assert_eq!(
            Matrix::new(f64::NAN, 0.0, 0.0, 1.0, 0.0, 0.0),
            Matrix::IDENTITY
        );
    }

    #[test]
    fn rect_overlaps() {
        let a = Rect::new(0.0, 0.0, 10.0, 10.0);
        let b = Rect::new(5.0, 8.0, 20.0, 30.0);
        assert_eq!(a.x_overlap(&b), 5.0);
        assert_eq!(a.y_overlap(&b), 2.0);
        assert_eq!(a.union(&b), Rect::new(0.0, 0.0, 20.0, 30.0));
    }
}
