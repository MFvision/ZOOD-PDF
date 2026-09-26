//! Affine matrices (PDF row-vector convention) and page coordinate conversion.
//!
//! The RPC uses the same coordinates as `text.extract`: points relative to the top-left corner of
//! the page's visible box (CropBox, else MediaBox), y growing downwards, page `/Rotate` not applied.

use serde::{Deserialize, Serialize};

/// `[a b c d e f]`: a point `(x, y)` maps to `(a x + c y + e, b x + d y + f)`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Matrix {
    pub a: f64,
    pub b: f64,
    pub c: f64,
    pub d: f64,
    pub e: f64,
    pub f: f64,
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

    pub fn new(a: f64, b: f64, c: f64, d: f64, e: f64, f: f64) -> Matrix {
        Matrix { a, b, c, d, e, f }
    }

    pub fn from_slice(v: &[f64]) -> Option<Matrix> {
        match v {
            [a, b, c, d, e, f] => Some(Matrix::new(*a, *b, *c, *d, *e, *f)),
            _ => None,
        }
    }

    pub fn translate(x: f64, y: f64) -> Matrix {
        Matrix::new(1.0, 0.0, 0.0, 1.0, x, y)
    }

    pub fn scale(sx: f64, sy: f64) -> Matrix {
        Matrix::new(sx, 0.0, 0.0, sy, 0.0, 0.0)
    }

    /// Counter-clockwise rotation (y up) by `deg` degrees.
    pub fn rotate(deg: f64) -> Matrix {
        let (s, c) = deg.to_radians().sin_cos();
        // Snap exact quarter turns.
        let snap = |v: f64| if v.abs() < 1e-12 { 0.0 } else { v };
        Matrix::new(snap(c), snap(s), snap(-s), snap(c), 0.0, 0.0)
    }

    /// `self` applied first, then `o` (i.e. the matrix product `self × o`).
    pub fn then(&self, o: &Matrix) -> Matrix {
        Matrix {
            a: self.a * o.a + self.b * o.c,
            b: self.a * o.b + self.b * o.d,
            c: self.c * o.a + self.d * o.c,
            d: self.c * o.b + self.d * o.d,
            e: self.e * o.a + self.f * o.c + o.e,
            f: self.e * o.b + self.f * o.d + o.f,
        }
    }

    pub fn apply(&self, x: f64, y: f64) -> (f64, f64) {
        (
            self.a * x + self.c * y + self.e,
            self.b * x + self.d * y + self.f,
        )
    }

    pub fn det(&self) -> f64 {
        self.a * self.d - self.b * self.c
    }

    pub fn invert(&self) -> Option<Matrix> {
        let det = self.det();
        if !det.is_finite() || det.abs() < 1e-12 {
            return None;
        }
        let a = self.d / det;
        let b = -self.b / det;
        let c = -self.c / det;
        let d = self.a / det;
        let e = -(self.e * a + self.f * c);
        let f = -(self.e * b + self.f * d);
        Some(Matrix::new(a, b, c, d, e, f))
    }

    pub fn is_finite(&self) -> bool {
        [self.a, self.b, self.c, self.d, self.e, self.f]
            .iter()
            .all(|v| v.is_finite())
    }

    pub fn to_array(&self) -> [f64; 6] {
        [self.a, self.b, self.c, self.d, self.e, self.f]
    }

    /// Bounding box of the image of `r`.
    pub fn map_rect(&self, r: &Rect) -> Rect {
        let pts = [
            self.apply(r.x0, r.y0),
            self.apply(r.x1, r.y0),
            self.apply(r.x1, r.y1),
            self.apply(r.x0, r.y1),
        ];
        Rect::bounding(&pts)
    }

    /// Rotation angle of the x axis in degrees (counter-clockwise, y up), 0..360.
    pub fn angle(&self) -> f64 {
        self.b.atan2(self.a).to_degrees().rem_euclid(360.0)
    }
}

/// Axis-aligned rectangle.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
pub struct Rect {
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
}

impl Rect {
    pub fn new(x0: f64, y0: f64, x1: f64, y1: f64) -> Rect {
        Rect {
            x0: x0.min(x1),
            y0: y0.min(y1),
            x1: x0.max(x1),
            y1: y0.max(y1),
        }
    }

    pub fn from_array(v: [f64; 4]) -> Rect {
        Rect::new(v[0], v[1], v[2], v[3])
    }

    pub fn bounding(pts: &[(f64, f64)]) -> Rect {
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

    pub fn width(&self) -> f64 {
        self.x1 - self.x0
    }

    pub fn height(&self) -> f64 {
        self.y1 - self.y0
    }

    pub fn center(&self) -> (f64, f64) {
        ((self.x0 + self.x1) / 2.0, (self.y0 + self.y1) / 2.0)
    }

    pub fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x0 && x <= self.x1 && y >= self.y0 && y <= self.y1
    }

    pub fn union(&self, o: &Rect) -> Rect {
        Rect::new(
            self.x0.min(o.x0),
            self.y0.min(o.y0),
            self.x1.max(o.x1),
            self.y1.max(o.y1),
        )
    }

    pub fn intersect(&self, o: &Rect) -> Option<Rect> {
        let r = Rect {
            x0: self.x0.max(o.x0),
            y0: self.y0.max(o.y0),
            x1: self.x1.min(o.x1),
            y1: self.y1.min(o.y1),
        };
        (r.x1 > r.x0 && r.y1 > r.y0).then_some(r)
    }

    pub fn expand(&self, dx: f64, dy: f64) -> Rect {
        Rect::new(self.x0 - dx, self.y0 - dy, self.x1 + dx, self.y1 + dy)
    }

    pub fn is_finite(&self) -> bool {
        [self.x0, self.y0, self.x1, self.y1]
            .iter()
            .all(|v| v.is_finite())
    }

    /// Rounded to 1/100 pt for stable JSON.
    pub fn rounded(&self) -> Rect {
        let r = |v: f64| (v * 100.0).round() / 100.0;
        Rect {
            x0: r(self.x0),
            y0: r(self.y0),
            x1: r(self.x1),
            y1: r(self.y1),
        }
    }

    pub fn to_array(&self) -> [f64; 4] {
        [self.x0, self.y0, self.x1, self.y1]
    }
}

/// Conversion between PDF user space (y up) and the RPC's top-left space of a page.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PageSpace {
    /// Visible box `[x0 y0 x1 y1]` in user space.
    pub vbox: [f64; 4],
}

impl PageSpace {
    pub fn width(&self) -> f64 {
        self.vbox[2] - self.vbox[0]
    }

    pub fn height(&self) -> f64 {
        self.vbox[3] - self.vbox[1]
    }

    /// User-space point → top-left point.
    pub fn to_tl(&self, x: f64, y: f64) -> (f64, f64) {
        (x - self.vbox[0], self.vbox[3] - y)
    }

    /// Top-left point → user-space point.
    pub fn to_user(&self, x: f64, y: f64) -> (f64, f64) {
        (x + self.vbox[0], self.vbox[3] - y)
    }

    pub fn rect_to_tl(&self, r: &Rect) -> Rect {
        let (a, b) = self.to_tl(r.x0, r.y0);
        let (c, d) = self.to_tl(r.x1, r.y1);
        Rect::new(a, b, c, d)
    }

    pub fn rect_to_user(&self, r: &Rect) -> Rect {
        let (a, b) = self.to_user(r.x0, r.y0);
        let (c, d) = self.to_user(r.x1, r.y1);
        Rect::new(a, b, c, d)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn inverse_and_composition() {
        let m = Matrix::new(2.0, 0.5, -1.0, 3.0, 10.0, 20.0);
        let i = m.invert().unwrap();
        let id = m.then(&i);
        for (x, y) in [
            (id.a, 1.0),
            (id.d, 1.0),
            (id.b, 0.0),
            (id.c, 0.0),
            (id.e, 0.0),
            (id.f, 0.0),
        ] {
            assert!((x - y).abs() < 1e-9);
        }
        // then: self first.
        let t = Matrix::scale(2.0, 2.0).then(&Matrix::translate(5.0, 0.0));
        assert_eq!(t.apply(1.0, 1.0), (7.0, 2.0));
        let r = Matrix::rotate(90.0);
        let (x, y) = r.apply(1.0, 0.0);
        assert!(x.abs() < 1e-12 && (y - 1.0).abs() < 1e-12);
        assert!(Matrix::new(0.0, 0.0, 0.0, 0.0, 1.0, 1.0).invert().is_none());
    }

    #[test]
    fn page_space_round_trip() {
        let s = PageSpace {
            vbox: [10.0, 20.0, 610.0, 820.0],
        };
        assert_eq!(s.to_tl(10.0, 820.0), (0.0, 0.0));
        assert_eq!(s.to_user(0.0, 800.0), (10.0, 20.0));
    }
}
