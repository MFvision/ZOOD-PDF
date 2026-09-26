//! Pictures placed on a page: list (image XObject `Do` and inline images with their CTM-derived
//! boxes), move / resize / rotate (by rewriting the `cm` right before the picture when it is the
//! canonical `q … cm <picture> Q`, else by wrapping the picture in `q X cm … Q`), crop (a clip
//! rectangle in the picture's own unit square), replace (new JPEG/PNG XObject), delete, add.
//!
//! Pictures inside form XObjects (stamps, page marks) are not listed.

use lopdf::{Dictionary, Object, ObjectId, Stream};
use serde::Serialize;
use warraq_pdf::Pdf;

use crate::content::{fmt_name, fmt_num, Op, Splice};
use crate::error::{EditError, Result};
use crate::geom::{Matrix, Rect};
use crate::page::{add_resource, load, new_stream, write, PageContent};
use crate::scan::{scan, ImageUse, Scan};

/// Maximum decoded picture size (pixels).
pub const MAX_PIXELS: u64 = 64 * 1024 * 1024;

/// A listed picture (top-left page coordinates).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImageInfo {
    pub id: usize,
    /// Visible box (after cropping), top-left coordinates.
    pub bbox: Rect,
    /// Placement matrix of the full picture's unit square, top-left coordinates
    /// (`[a b c d e f]` with y down).
    pub matrix: [f64; 6],
    /// Crop in the picture's unit square `[x0 y0 x1 y1]` (y up), if cropped.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub crop: Option<[f64; 4]>,
    /// Rotation, degrees clockwise as seen on the page.
    pub rotation: f64,
    pub width: i64,
    pub height: i64,
    pub inline: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// Where a picture sits in the operators.
#[derive(Debug, Clone)]
struct Group {
    start: usize,
    end: usize,
    /// `re` op index and unit rect of our crop wrapper.
    crop: Option<(usize, Rect)>,
    /// `cm` op index when the canonical `q … cm group Q` form holds.
    cm: Option<usize>,
}

fn is(ops: &[Op], i: Option<usize>, name: &[u8]) -> bool {
    i.and_then(|i| ops.get(i))
        .is_some_and(|o| o.operator == name)
}

fn group(sc: &Scan, img: &ImageUse) -> Group {
    let ops = &sc.content.ops;
    let i = img.op;
    let mut g = Group {
        start: i,
        end: i,
        crop: None,
        cm: None,
    };
    let crop_form = i >= 4
        && is(ops, Some(i - 4), b"q")
        && is(ops, Some(i - 3), b"re")
        && (is(ops, Some(i - 2), b"W") || is(ops, Some(i - 2), b"W*"))
        && is(ops, Some(i - 1), b"n")
        && is(ops, Some(i + 1), b"Q");
    if crop_form {
        if let Some(re) = ops.get(i - 3) {
            if let [x, y, w, h] = re.nums().as_slice() {
                g.crop = Some((i - 3, Rect::new(*x, *y, x + w, y + h)));
                g.start = i - 4;
                g.end = i + 1;
            }
        }
    }
    if g.start >= 1 && is(ops, Some(g.start - 1), b"cm") && is(ops, Some(g.end + 1), b"Q") {
        g.cm = Some(g.start - 1);
    }
    g
}

fn unit() -> Rect {
    Rect::new(0.0, 0.0, 1.0, 1.0)
}

fn visible(img: &ImageUse, g: &Group) -> Rect {
    img.ctm.map_rect(&g.crop.map(|c| c.1).unwrap_or_else(unit))
}

/// The CTM that maps top-left coordinates' y-down flip for display.
fn to_tl_matrix(pc: &PageContent, m: &Matrix) -> [f64; 6] {
    let flip = Matrix::new(1.0, 0.0, 0.0, -1.0, -pc.space.vbox[0], pc.space.vbox[3]);
    m.then(&flip).to_array()
}

fn load_scan(pdf: &Pdf, index: usize) -> Result<(PageContent, Scan)> {
    let pc = load(pdf, index)?;
    let sc = scan(pdf, &pc)?;
    Ok((pc, sc))
}

fn info(pc: &PageContent, sc: &Scan, id: usize, img: &ImageUse) -> ImageInfo {
    let g = group(sc, img);
    ImageInfo {
        id,
        bbox: pc.space.rect_to_tl(&visible(img, &g)).rounded(),
        matrix: to_tl_matrix(pc, &img.ctm),
        crop: g.crop.map(|c| c.1.to_array()),
        rotation: ((360.0 - img.ctm.angle()) % 360.0 * 100.0).round() / 100.0,
        width: img.width,
        height: img.height,
        inline: img.name.is_none(),
        name: img
            .name
            .as_ref()
            .map(|n| String::from_utf8_lossy(n).into_owned()),
    }
}

/// List the pictures of page `index`.
pub fn list(pdf: &Pdf, index: usize) -> Result<Vec<ImageInfo>> {
    let (pc, sc) = load_scan(pdf, index)?;
    Ok(sc
        .images
        .iter()
        .enumerate()
        .map(|(i, img)| info(&pc, &sc, i, img))
        .collect())
}

fn find(sc: &Scan, id: usize) -> Result<&ImageUse> {
    sc.images
        .get(id)
        .ok_or_else(|| EditError::NotFound(format!("picture {id}")))
}

fn cm_bytes(m: &Matrix) -> String {
    m.to_array()
        .iter()
        .map(|v| fmt_num(*v))
        .collect::<Vec<_>>()
        .join(" ")
        + " cm"
}

fn span(sc: &Scan, g: &Group) -> std::ops::Range<usize> {
    let ops = &sc.content.ops;
    let s = ops.get(g.start).map_or(0, |o| o.span.start);
    let e = ops.get(g.end).map_or(s, |o| o.span.end);
    s..e
}

/// A change of placement.
#[derive(Debug, Clone, Default)]
pub struct Transform {
    /// Move by (top-left coordinates).
    pub dx: f64,
    pub dy: f64,
    /// Fit the visible box into this box (top-left coordinates).
    pub bbox: Option<Rect>,
    /// Rotate clockwise (as seen) about the visible box's centre, degrees.
    pub rotate: f64,
}

/// Move / resize / rotate picture `id`.
pub fn transform(pdf: &mut Pdf, index: usize, id: usize, t: &Transform) -> Result<ImageInfo> {
    let (pc, sc) = load_scan(pdf, index)?;
    let img = find(&sc, id)?.clone();
    let g = group(&sc, &img);
    let c = img.ctm;
    let mut n = c;
    if let Some(target) = t.bbox {
        let tgt = pc.space.rect_to_user(&target);
        let cur = n.map_rect(&g.crop.map(|x| x.1).unwrap_or_else(unit));
        if cur.width() < 1e-6
            || cur.height() < 1e-6
            || tgt.width() < 0.5
            || tgt.height() < 0.5
            || !tgt.is_finite()
        {
            return Err(EditError::Params("picture box too small".into()));
        }
        let m = Matrix::translate(-cur.x0, -cur.y0)
            .then(&Matrix::scale(
                tgt.width() / cur.width(),
                tgt.height() / cur.height(),
            ))
            .then(&Matrix::translate(tgt.x0, tgt.y0));
        n = n.then(&m);
    }
    if t.rotate.abs() > 1e-9 {
        let vis = n.map_rect(&g.crop.map(|x| x.1).unwrap_or_else(unit));
        let (cx, cy) = vis.center();
        n = n
            .then(&Matrix::translate(-cx, -cy))
            .then(&Matrix::rotate(-t.rotate))
            .then(&Matrix::translate(cx, cy));
    }
    if t.dx != 0.0 || t.dy != 0.0 {
        n = n.then(&Matrix::translate(t.dx, -t.dy));
    }
    if !n.is_finite() {
        return Err(EditError::Params("non-finite placement".into()));
    }
    let inv = c
        .invert()
        .ok_or_else(|| EditError::NotEditable("picture has a degenerate placement".into()))?;
    let x = n.then(&inv);
    let ops = &sc.content.ops;
    let splice = match g.cm.and_then(|i| ops.get(i)) {
        Some(cm) => {
            let b = Matrix::from_slice(&cm.nums()).unwrap_or(Matrix::IDENTITY);
            Splice {
                range: cm.span.clone(),
                with: cm_bytes(&x.then(&b)).into_bytes(),
            }
        }
        None => {
            let r = span(&sc, &g);
            let mut w = format!("q {} ", cm_bytes(&x)).into_bytes();
            w.extend_from_slice(pc.data.get(r.clone()).unwrap_or(&[]));
            w.extend_from_slice(b" Q");
            Splice { range: r, with: w }
        }
    };
    write(pdf, &pc, &[splice], None)?;
    list(pdf, index)?
        .into_iter()
        .nth(id)
        .ok_or_else(|| EditError::NotFound(format!("picture {id}")))
}

/// Crop picture `id` to `bbox` (top-left coordinates, intersected with the picture).
pub fn crop(pdf: &mut Pdf, index: usize, id: usize, bbox: Rect) -> Result<ImageInfo> {
    let (pc, sc) = load_scan(pdf, index)?;
    let img = find(&sc, id)?.clone();
    let g = group(&sc, &img);
    let inv = img
        .ctm
        .invert()
        .ok_or_else(|| EditError::NotEditable("picture has a degenerate placement".into()))?;
    let u = inv
        .map_rect(&pc.space.rect_to_user(&bbox))
        .intersect(&unit())
        .ok_or_else(|| EditError::Params("crop box is outside the picture".into()))?;
    let re = format!(
        "{} {} {} {} re",
        fmt_num(u.x0),
        fmt_num(u.y0),
        fmt_num(u.width()),
        fmt_num(u.height())
    );
    let ops = &sc.content.ops;
    let splice = match g.crop.and_then(|(i, _)| ops.get(i)) {
        Some(op) => Splice {
            range: op.span.clone(),
            with: re.into_bytes(),
        },
        None => {
            let op = ops
                .get(img.op)
                .ok_or_else(|| EditError::NotFound("picture operator".into()))?;
            let mut w = format!("q {re} W n ").into_bytes();
            w.extend_from_slice(pc.data.get(op.span.clone()).unwrap_or(&[]));
            w.extend_from_slice(b" Q");
            Splice {
                range: op.span.clone(),
                with: w,
            }
        }
    };
    write(pdf, &pc, &[splice], None)?;
    list(pdf, index)?
        .into_iter()
        .nth(id)
        .ok_or_else(|| EditError::NotFound(format!("picture {id}")))
}

/// Delete picture `id`.
pub fn delete(pdf: &mut Pdf, index: usize, id: usize) -> Result<()> {
    let (pc, sc) = load_scan(pdf, index)?;
    let img = find(&sc, id)?.clone();
    let g = group(&sc, &img);
    write(
        pdf,
        &pc,
        &[Splice {
            range: span(&sc, &g),
            with: Vec::new(),
        }],
        None,
    )
}

/// A decoded picture ready to become an image XObject.
#[derive(Debug, Clone)]
pub struct Picture {
    pub width: u32,
    pub height: u32,
    dict: Dictionary,
    data: Vec<u8>,
    compress: bool,
    smask: Option<Vec<u8>>,
}

/// JPEG header facts.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct JpegInfo {
    pub width: u32,
    pub height: u32,
    pub components: u8,
    pub adobe: bool,
}

/// Read the size and components of a JPEG (bounded marker walk; no decoding).
pub fn jpeg_info(b: &[u8]) -> Option<JpegInfo> {
    if b.get(0..2)? != [0xFF, 0xD8] {
        return None;
    }
    let mut i = 2usize;
    let mut adobe = false;
    let mut steps = 0;
    while i + 3 < b.len() && steps < 10_000 {
        steps += 1;
        if *b.get(i)? != 0xFF {
            return None;
        }
        let mut m = *b.get(i + 1)?;
        while m == 0xFF {
            i += 1;
            m = *b.get(i + 1)?;
        }
        i += 2;
        if matches!(m, 0x01 | 0xD0..=0xD7) {
            continue;
        }
        if m == 0xD9 || m == 0xDA {
            return None;
        }
        let len = usize::from(u16::from_be_bytes([*b.get(i)?, *b.get(i + 1)?]));
        if len < 2 {
            return None;
        }
        let seg = b.get(i + 2..i + len)?;
        if m == 0xEE && seg.starts_with(b"Adobe") {
            adobe = true;
        }
        if matches!(m, 0xC0..=0xCF) && !matches!(m, 0xC4 | 0xC8 | 0xCC) {
            let height = u32::from(u16::from_be_bytes([*seg.get(1)?, *seg.get(2)?]));
            let width = u32::from(u16::from_be_bytes([*seg.get(3)?, *seg.get(4)?]));
            let components = *seg.get(5)?;
            if width == 0 || height == 0 || !matches!(components, 1 | 3 | 4) {
                return None;
            }
            return Some(JpegInfo {
                width,
                height,
                components,
                adobe,
            });
        }
        i += len;
    }
    None
}

fn image_dict(w: u32, h: u32, cs: &[u8]) -> Dictionary {
    let mut d = Dictionary::new();
    d.set("Type", Object::Name(b"XObject".to_vec()));
    d.set("Subtype", Object::Name(b"Image".to_vec()));
    d.set("Width", i64::from(w));
    d.set("Height", i64::from(h));
    d.set("ColorSpace", Object::Name(cs.to_vec()));
    d.set("BitsPerComponent", 8);
    d
}

/// Decode a JPEG or PNG file.
pub fn decode_picture(bytes: &[u8]) -> Result<Picture> {
    if let Some(j) = jpeg_info(bytes) {
        if u64::from(j.width) * u64::from(j.height) > MAX_PIXELS {
            return Err(EditError::Image("picture too large".into()));
        }
        let cs: &[u8] = match j.components {
            1 => b"DeviceGray",
            4 => b"DeviceCMYK",
            _ => b"DeviceRGB",
        };
        let mut d = image_dict(j.width, j.height, cs);
        d.set("Filter", Object::Name(b"DCTDecode".to_vec()));
        if j.components == 4 && j.adobe {
            d.set(
                "Decode",
                Object::Array(
                    [1, 0, 1, 0, 1, 0, 1, 0]
                        .iter()
                        .map(|v| Object::Integer(*v))
                        .collect(),
                ),
            );
        }
        return Ok(Picture {
            width: j.width,
            height: j.height,
            dict: d,
            data: bytes.to_vec(),
            compress: false,
            smask: None,
        });
    }
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        let limits = png::Limits {
            bytes: 256 * 1024 * 1024,
        };
        let mut dec = png::Decoder::new_with_limits(std::io::Cursor::new(bytes), limits);
        dec.set_transformations(png::Transformations::normalize_to_color8());
        let mut reader = dec
            .read_info()
            .map_err(|e| EditError::Image(format!("png: {e}")))?;
        let (w, h) = reader.info().size();
        if w == 0 || h == 0 || u64::from(w) * u64::from(h) > MAX_PIXELS {
            return Err(EditError::Image("picture too large or empty".into()));
        }
        let size = reader
            .output_buffer_size()
            .ok_or_else(|| EditError::Image("png too large".into()))?;
        let mut buf = vec![0u8; size];
        let out = reader
            .next_frame(&mut buf)
            .map_err(|e| EditError::Image(format!("png: {e}")))?;
        buf.truncate(out.buffer_size());
        let (ct, _) = reader.output_color_type();
        let (chan, alpha, cs): (usize, bool, &[u8]) = match ct {
            png::ColorType::Grayscale => (1, false, b"DeviceGray"),
            png::ColorType::GrayscaleAlpha => (2, true, b"DeviceGray"),
            png::ColorType::Rgb => (3, false, b"DeviceRGB"),
            png::ColorType::Rgba => (4, true, b"DeviceRGB"),
            png::ColorType::Indexed => {
                return Err(EditError::Image("indexed png not expanded".into()))
            }
        };
        let px = (w as usize) * (h as usize);
        if buf.len() < px * chan {
            return Err(EditError::Image("png data too short".into()));
        }
        let (data, smask) = if alpha {
            let colour = chan - 1;
            let mut c = Vec::with_capacity(px * colour);
            let mut a = Vec::with_capacity(px);
            for p in buf.chunks_exact(chan).take(px) {
                c.extend_from_slice(p.get(..colour).unwrap_or(&[]));
                a.push(p.get(colour).copied().unwrap_or(255));
            }
            let opaque = a.iter().all(|v| *v == 255);
            (c, (!opaque).then_some(a))
        } else {
            buf.truncate(px * chan);
            (buf, None)
        };
        return Ok(Picture {
            width: w,
            height: h,
            dict: image_dict(w, h, cs),
            data,
            compress: true,
            smask,
        });
    }
    Err(EditError::Image(
        "only JPEG and PNG pictures are supported".into(),
    ))
}

fn add_xobject(pdf: &mut Pdf, page_id: ObjectId, p: &Picture) -> Result<Vec<u8>> {
    let mut dict = p.dict.clone();
    if let Some(a) = &p.smask {
        let sm = new_stream(pdf, image_dict(p.width, p.height, b"DeviceGray"), a)?;
        dict.set("SMask", Object::Reference(sm));
    }
    let id = if p.compress {
        new_stream(pdf, dict, &p.data)?
    } else {
        pdf.add(Object::Stream(Stream::new(dict, p.data.clone())))
    };
    add_resource(pdf, page_id, b"XObject", "ZIm", Object::Reference(id))
}

/// Largest box with the picture's aspect ratio centred inside `r`.
fn fit(r: &Rect, w: u32, h: u32) -> Rect {
    let ar = f64::from(w.max(1)) / f64::from(h.max(1));
    let (bw, bh) = (r.width(), r.height());
    let (fw, fh) = if bw / bh.max(1e-9) > ar {
        (bh * ar, bh)
    } else {
        (bw, bw / ar)
    };
    let (cx, cy) = r.center();
    Rect::new(cx - fw / 2.0, cy - fh / 2.0, cx + fw / 2.0, cy + fh / 2.0)
}

/// Replace picture `id` by `bytes` (JPEG/PNG), fitted into its visible box.
pub fn replace(pdf: &mut Pdf, index: usize, id: usize, bytes: &[u8]) -> Result<ImageInfo> {
    let pic = decode_picture(bytes)?;
    let (pc, sc) = load_scan(pdf, index)?;
    let img = find(&sc, id)?.clone();
    let g = group(&sc, &img);
    let r = span(&sc, &g);
    let vis = visible(&img, &g);
    let name = add_xobject(pdf, pc.page_id, &pic)?;
    let tgt = fit(&vis, pic.width, pic.height);
    let n = Matrix::new(tgt.width(), 0.0, 0.0, tgt.height(), tgt.x0, tgt.y0);
    // The group is drawn under the CTM that was current at the picture (a crop wrapper does not
    // change it): map the new placement through its inverse.
    let inv = img
        .ctm
        .invert()
        .ok_or_else(|| EditError::NotEditable("picture has a degenerate placement".into()))?;
    let x = n.then(&inv);
    let w = format!("q {} {} Do Q", cm_bytes(&x), fmt_name(&name)).into_bytes();
    write(pdf, &pc, &[Splice { range: r, with: w }], None)?;
    list(pdf, index)?
        .into_iter()
        .nth(id)
        .ok_or_else(|| EditError::NotFound(format!("picture {id}")))
}

/// Add a picture into `bbox` (top-left coordinates; the picture keeps its aspect ratio).
pub fn add(pdf: &mut Pdf, index: usize, bbox: Rect, bytes: &[u8]) -> Result<ImageInfo> {
    let pic = decode_picture(bytes)?;
    let pc = load(pdf, index)?;
    if !bbox.is_finite() || bbox.width() < 0.5 || bbox.height() < 0.5 {
        return Err(EditError::Params("picture box too small".into()));
    }
    let tgt = fit(&pc.space.rect_to_user(&bbox), pic.width, pic.height);
    let name = add_xobject(pdf, pc.page_id, &pic)?;
    let n = Matrix::new(tgt.width(), 0.0, 0.0, tgt.height(), tgt.x0, tgt.y0);
    let w = format!("q {} {} Do Q\n", cm_bytes(&n), fmt_name(&name)).into_bytes();
    write(pdf, &pc, &[], Some(&w))?;
    let all = list(pdf, index)?;
    all.into_iter()
        .last()
        .ok_or_else(|| EditError::NotFound("added picture".into()))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn jpeg_header() {
        // SOI, APP0 (len 4), SOF0: len 11, precision 8, h=2, w=3, 3 comps.
        let j = [
            0xFF, 0xD8, 0xFF, 0xE0, 0, 4, 0, 0, 0xFF, 0xC0, 0, 11, 8, 0, 2, 0, 3, 3, 1, 0x11, 0,
            0xFF, 0xD9,
        ];
        assert_eq!(
            jpeg_info(&j),
            Some(JpegInfo {
                width: 3,
                height: 2,
                components: 3,
                adobe: false
            })
        );
        assert_eq!(jpeg_info(&[0xFF, 0xD8, 0xFF]), None);
        assert_eq!(jpeg_info(b"nope"), None);
    }

    #[test]
    fn fit_keeps_aspect() {
        let r = fit(&Rect::new(0.0, 0.0, 100.0, 100.0), 200, 100);
        assert!((r.width() - 100.0).abs() < 1e-9 && (r.height() - 50.0).abs() < 1e-9);
    }
}
