//! The displayed page: marks are laid out upright in the visible box (CropBox ∩ MediaBox) as the
//! page is shown, i.e. after `/Rotate`. [`display_to_user`] maps that space (origin bottom-left of
//! the displayed page, y up) to user space; it becomes the mark form's `/Matrix`.

use warraq_edit::geom::{Matrix, Rect};
use warraq_pdf::pages::PageInfo;

use crate::model::{Horizontal, MarkSpec, Vertical};

/// A page as displayed.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Displayed {
    /// Width and height after rotation.
    pub width: f64,
    pub height: f64,
    pub to_user: Matrix,
}

/// Display space of a page with visible box `vb` and rotation `rotate` (0/90/180/270).
pub fn display_to_user(vb: [f64; 4], rotate: i64) -> Displayed {
    let [x0, y0, x1, y1] = vb;
    let (w, h) = (x1 - x0, y1 - y0);
    match rotate.rem_euclid(360) {
        90 => Displayed {
            width: h,
            height: w,
            to_user: Matrix::new(0.0, 1.0, -1.0, 0.0, x1, y0),
        },
        180 => Displayed {
            width: w,
            height: h,
            to_user: Matrix::new(-1.0, 0.0, 0.0, -1.0, x1, y1),
        },
        270 => Displayed {
            width: h,
            height: w,
            to_user: Matrix::new(0.0, -1.0, 1.0, 0.0, x0, y1),
        },
        _ => Displayed {
            width: w,
            height: h,
            to_user: Matrix::new(1.0, 0.0, 0.0, 1.0, x0, y0),
        },
    }
}

/// Displayed geometry of a page.
pub fn displayed(info: &PageInfo) -> Displayed {
    display_to_user(info.visible_box(), info.rotate)
}

/// Rotation of the mark in degrees (counter-clockwise) on a displayed page.
pub fn angle(spec: &MarkSpec, d: &Displayed) -> f64 {
    if spec.diagonal {
        let a = d.height.atan2(d.width).to_degrees();
        // Reading direction follows the text: bottom-left → top-right in both directions.
        if a.is_finite() {
            a
        } else {
            45.0
        }
    } else {
        spec.rotation
    }
}

/// Physical horizontal position: `start` is the right edge in a right-to-left document.
pub fn physical(h: Horizontal, rtl: bool) -> f64 {
    match (h, rtl) {
        (Horizontal::Center, _) => 0.5,
        (Horizontal::Start, false) | (Horizontal::End, true) => 0.0,
        (Horizontal::Start, true) | (Horizontal::End, false) => 1.0,
    }
}

/// Centre of a box of size `bw`×`bh` (the rotated content's bounds) placed in slot `h`/`v`.
pub fn anchor(
    spec: &MarkSpec,
    d: &Displayed,
    h: Horizontal,
    v: Vertical,
    bw: f64,
    bh: f64,
) -> (f64, f64) {
    let m = spec.margin();
    let x = match physical(h, spec.rtl) {
        f if f < 0.25 => m + bw / 2.0,
        f if f > 0.75 => d.width - m - bw / 2.0,
        _ => d.width / 2.0,
    };
    let y = match v {
        Vertical::Top => d.height - m - bh / 2.0,
        Vertical::Middle => d.height / 2.0,
        Vertical::Bottom => m + bh / 2.0,
    };
    (x + spec.offset_x, y + spec.offset_y)
}

/// Matrix that takes `content` (a box in its own space) to be centred at `c`, rotated by `deg`.
pub fn place(content: &Rect, deg: f64, c: (f64, f64)) -> Matrix {
    let (cx, cy) = content.center();
    Matrix::translate(-cx, -cy)
        .then(&Matrix::rotate(deg))
        .then(&Matrix::translate(c.0, c.1))
}

/// Size of `r` rotated by `deg`.
pub fn rotated_size(r: &Rect, deg: f64) -> (f64, f64) {
    let b = Matrix::rotate(deg).map_rect(r);
    (b.width(), b.height())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn close(a: (f64, f64), b: (f64, f64)) -> bool {
        (a.0 - b.0).abs() < 1e-9 && (a.1 - b.1).abs() < 1e-9
    }

    #[test]
    fn displayed_top_left_maps_to_the_visible_corner() {
        let vb = [10.0, 20.0, 110.0, 220.0]; // 100 × 200
                                             // Rotate 0: displayed top-left is the user top-left.
        let d = display_to_user(vb, 0);
        assert!(close(d.to_user.apply(0.0, d.height), (10.0, 220.0)));
        // Rotate 90 (shown clockwise): the displayed top-left is the user's bottom-left corner.
        let d = display_to_user(vb, 90);
        assert_eq!((d.width, d.height), (200.0, 100.0));
        assert!(close(d.to_user.apply(0.0, d.height), (10.0, 20.0)));
        assert!(close(d.to_user.apply(d.width, d.height), (10.0, 220.0)));
        // Rotate 180: displayed top-left is the user bottom-right.
        let d = display_to_user(vb, 180);
        assert!(close(d.to_user.apply(0.0, d.height), (110.0, 20.0)));
        // Rotate 270: displayed top-left is the user top-right.
        let d = display_to_user(vb, 270);
        assert!(close(d.to_user.apply(0.0, d.height), (110.0, 220.0)));
        assert!(close(d.to_user.apply(0.0, 0.0), (10.0, 220.0)));
    }

    #[test]
    fn start_is_right_in_rtl() {
        assert_eq!(physical(Horizontal::Start, true), 1.0);
        assert_eq!(physical(Horizontal::Start, false), 0.0);
        assert_eq!(physical(Horizontal::End, true), 0.0);
    }
}
