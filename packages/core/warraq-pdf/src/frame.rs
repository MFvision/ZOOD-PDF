//! How a page as it is shown — after its crop box and `/Rotate` — maps onto
//! the user space its content is drawn in.
//!
//! The interface speaks of a page as the reader sees it: points from its
//! top-left corner, x to the right and y down. What is written into the file
//! has to be in user space, where the crop box may start anywhere and the
//! page may be turned. Every tool that places something where the reader
//! pointed (the OCR text layer, page marks, images, links) goes through this.
use lopdf::Object;

use crate::text_walk::Matrix;
use crate::{Error, PdfDocument, Result};

/// The page tree is walked no further up than this for an inherited box; a
/// hostile file can make its `/Parent` chain a loop.
const MAX_PARENTS: usize = 64;

/// The crop box `[x0, y0, x1, y1]` in user space, and the page's `/Rotate`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Frame {
    pub crop: [f32; 4],
    pub turn: i64,
}

impl PdfDocument {
    /// How the page as shown maps onto its user space: its crop box and turn.
    pub(crate) fn display_frame(&self, index: usize) -> Result<Frame> {
        let id = self.page_id(index)?;
        let dict = self
            .doc
            .get_dictionary(id)
            .map_err(|e| Error::Parse(e.to_string()))?;
        let rect = |key: &[u8]| {
            let mut value = dict.get(key).ok().cloned();
            let mut node = dict.get(b"Parent").ok().and_then(|p| p.as_reference().ok());
            let mut steps = 0;
            while value.is_none() && steps < MAX_PARENTS {
                let parent = self.doc.get_dictionary(node?).ok()?;
                value = parent.get(key).ok().cloned();
                node = parent
                    .get(b"Parent")
                    .ok()
                    .and_then(|p| p.as_reference().ok());
                steps += 1;
            }
            let value = match value? {
                Object::Reference(r) => self.doc.get_object(r).ok()?.clone(),
                other => other,
            };
            let v: Vec<f32> = value
                .as_array()
                .ok()?
                .iter()
                .filter_map(|n| n.as_float().ok())
                .filter(|n| n.is_finite())
                .collect();
            (v.len() == 4).then(|| {
                [
                    v[0].min(v[2]),
                    v[1].min(v[3]),
                    v[0].max(v[2]),
                    v[1].max(v[3]),
                ]
            })
        };
        let media = rect(b"MediaBox").unwrap_or([0.0, 0.0, 612.0, 792.0]);
        let crop = rect(b"CropBox").unwrap_or(media);
        let mut crop = [
            crop[0].max(media[0]),
            crop[1].max(media[1]),
            crop[2].min(media[2]),
            crop[3].min(media[3]),
        ];
        // A crop box outside the media box shows nothing; take the media box.
        if crop[2] - crop[0] < 1.0 || crop[3] - crop[1] < 1.0 {
            crop = media;
        }
        Ok(Frame {
            crop,
            turn: self.page_rotation(index)?,
        })
    }
}

impl Frame {
    /// The page's size as shown: width and height in points.
    pub fn shown_size(&self) -> (f32, f32) {
        let [x0, y0, x1, y1] = self.crop;
        let (w, h) = ((x1 - x0).max(1.0), (y1 - y0).max(1.0));
        if self.turn == 90 || self.turn == 270 {
            (h, w)
        } else {
            (w, h)
        }
    }

    /// Where a point of user space is on the page as shown, from its top-left:
    /// the inverse of `user`.
    pub fn shown(&self, ux: f32, uy: f32) -> (f32, f32) {
        let [cx0, cy0, cx1, cy1] = self.crop;
        match self.turn {
            90 => (uy - cy0, ux - cx0),
            180 => (cx1 - ux, uy - cy0),
            270 => (cy1 - uy, cx1 - ux),
            _ => (ux - cx0, cy1 - uy),
        }
    }

    /// A rectangle of user space as shown: `[x0, top, x1, bottom]`.
    pub fn shown_rect(&self, r: [f32; 4]) -> [f32; 4] {
        let (ax, ay) = self.shown(r[0], r[1]);
        let (bx, by) = self.shown(r[2], r[3]);
        [ax.min(bx), ay.min(by), ax.max(bx), ay.max(by)]
    }

    /// A rectangle as shown, `[x0, top, x1, bottom]`, in user space
    /// `[x0, y0, x1, y1]`.
    pub fn user_rect(&self, r: [f32; 4]) -> [f32; 4] {
        let (ax, ay) = self.user(r[0], r[1]);
        let (bx, by) = self.user(r[2], r[3]);
        [ax.min(bx), ay.min(by), ax.max(bx), ay.max(by)]
    }

    /// User space of a point given from the top-left of the page as shown.
    pub fn user(&self, x: f32, y: f32) -> (f32, f32) {
        let [cx0, cy0, cx1, cy1] = self.crop;
        match self.turn {
            90 => (cx0 + y, cy0 + x),
            180 => (cx1 - x, cy0 + y),
            270 => (cx1 - y, cy1 - x),
            _ => (cx0 + x, cy1 - y),
        }
    }

    /// The matrix from the page as shown — points from its top-left corner,
    /// y down — to user space. `display_to_user().invert()` goes back.
    pub fn display_to_user(&self) -> Matrix {
        let (o, x, y) = (
            self.user(0.0, 0.0),
            self.user(1.0, 0.0),
            self.user(0.0, 1.0),
        );
        Matrix([x.0 - o.0, x.1 - o.1, y.0 - o.0, y.1 - o.1, o.0, o.1])
    }

    /// The matrix from the page as shown with y UP — origin at its
    /// bottom-left corner, as a PDF page is drawn — to user space. Drawing
    /// under this is drawing on an upright page of `shown_size()`.
    pub fn upright_to_user(&self) -> Matrix {
        let (_, height) = self.shown_size();
        // (x, y up) is (x, height - y) from the top.
        Matrix([1.0, 0.0, 0.0, -1.0, 0.0, height]).then(self.display_to_user())
    }

    /// The matrix that turns user space `degrees` counter-clockwise, as the
    /// page is shown, about the centre of its crop box. A turn looks the
    /// same way round in user space whatever the page's own `/Rotate`: both
    /// are rotations, and neither mirrors.
    pub fn turn_about_centre(&self, degrees: f32) -> [f32; 6] {
        let [x0, y0, x1, y1] = self.crop;
        let (cx, cy) = ((x0 + x1) / 2.0, (y0 + y1) / 2.0);
        let (s, c) = degrees.to_radians().sin_cos();
        [c, s, -s, c, cx - (c * cx - s * cy), cy - (s * cx + c * cy)]
    }

    /// A text matrix that writes left to right along the page as shown,
    /// starting at (`x`, `baseline`) there, stretched by `stretch`.
    pub fn text_matrix(&self, x: f32, baseline: f32, stretch: f32) -> [f32; 6] {
        // Along the line, and up, in user space, for each turn.
        let (along, up) = match self.turn {
            90 => ((0.0, 1.0), (-1.0, 0.0)),
            180 => ((-1.0, 0.0), (0.0, -1.0)),
            270 => ((0.0, -1.0), (1.0, 0.0)),
            _ => ((1.0, 0.0), (0.0, 1.0)),
        };
        let (e, f) = self.user(x, baseline);
        [along.0 * stretch, along.1 * stretch, up.0, up.1, e, f]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_frame_maps_the_page_as_shown_onto_user_space_for_every_turn() {
        let crop = [0.0, 0.0, 600.0, 800.0];
        let at = |turn, x, y| Frame { crop, turn }.user(x, y);
        // The top-left corner as shown.
        assert_eq!(at(0, 0.0, 0.0), (0.0, 800.0));
        assert_eq!(at(90, 0.0, 0.0), (0.0, 0.0));
        assert_eq!(at(180, 0.0, 0.0), (600.0, 0.0));
        assert_eq!(at(270, 0.0, 0.0), (600.0, 800.0));
        // Shown 90° turned, the page is 800 wide: its top-right corner is the
        // user-space top-left.
        assert_eq!(at(90, 800.0, 0.0), (0.0, 800.0));
        // `shown` undoes `user` for every turn.
        for turn in [0, 90, 180, 270] {
            let frame = Frame {
                crop: [10.0, 20.0, 610.0, 820.0],
                turn,
            };
            for (x, y) in [(0.0, 0.0), (15.0, 40.0), (300.0, 500.0)] {
                let (ux, uy) = frame.user(x, y);
                let (bx, by) = frame.shown(ux, uy);
                assert!(
                    (bx - x).abs() < 1e-3 && (by - y).abs() < 1e-3,
                    "{turn}: {x},{y}"
                );
            }
        }
    }

    #[test]
    fn the_matrices_agree_with_the_point_mapping_for_every_turn_and_offset_crop() {
        for turn in [0, 90, 180, 270] {
            let frame = Frame {
                crop: [20.0, 30.0, 620.0, 830.0],
                turn,
            };
            let (w, h) = frame.shown_size();
            let d = frame.display_to_user();
            let u = frame.upright_to_user();
            for (x, y) in [(0.0, 0.0), (w, 0.0), (0.0, h), (w, h), (10.0, 25.0)] {
                let want = frame.user(x, y);
                let got = d.apply(x, y);
                assert!((want.0 - got.0).abs() < 1e-3 && (want.1 - got.1).abs() < 1e-3);
                // The same point, y measured up from the bottom.
                let got = u.apply(x, h - y);
                assert!((want.0 - got.0).abs() < 1e-3 && (want.1 - got.1).abs() < 1e-3);
            }
        }
    }
}
