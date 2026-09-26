//! Small helpers: geometry, number formatting, object access, stream building.

use lopdf::{Dictionary, Object, Stream};
use std::io::Write;
use warraq_text::geom::{Matrix, Rect};

/// Inverse of an affine matrix, `None` when (nearly) singular.
pub fn invert(m: &Matrix) -> Option<Matrix> {
    let det = m.a * m.d - m.b * m.c;
    if !det.is_finite() || det.abs() < 1e-12 {
        return None;
    }
    let a = m.d / det;
    let b = -m.b / det;
    let c = -m.c / det;
    let d = m.a / det;
    let e = -(m.e * a + m.f * c);
    let f = -(m.e * b + m.f * d);
    let r = Matrix::new(a, b, c, d, e, f);
    r.is_finite().then_some(r)
}

/// Bounding box of `r` transformed by `m`.
pub fn transform_rect(m: &Matrix, r: &Rect) -> Rect {
    Rect::from_points(&[
        m.apply(r.x0, r.y0),
        m.apply(r.x1, r.y0),
        m.apply(r.x1, r.y1),
        m.apply(r.x0, r.y1),
    ])
}

/// Area of the intersection of two rectangles (0 when disjoint).
pub fn overlap_area(a: &Rect, b: &Rect) -> f64 {
    let w = a.x1.min(b.x1) - a.x0.max(b.x0);
    let h = a.y1.min(b.y1) - a.y0.max(b.y0);
    if w > 0.0 && h > 0.0 {
        w * h
    } else {
        0.0
    }
}

/// The rectangles overlap with a positive area.
pub fn intersects(a: &Rect, b: &Rect) -> bool {
    overlap_area(a, b) > 0.0
}

/// `inner` lies inside `outer` (with a small tolerance).
pub fn contains(outer: &Rect, inner: &Rect) -> bool {
    let t = 0.01;
    inner.x0 >= outer.x0 - t
        && inner.y0 >= outer.y0 - t
        && inner.x1 <= outer.x1 + t
        && inner.y1 <= outer.y1 + t
}

/// A finite, non-degenerate rectangle.
pub fn valid_rect(r: &Rect) -> bool {
    [r.x0, r.y0, r.x1, r.y1].iter().all(|v| v.is_finite()) && r.x1 > r.x0 && r.y1 > r.y0
}

/// Compact number for content streams (at most 4 decimals, no exponent).
pub fn num(v: f64) -> String {
    if !v.is_finite() {
        return "0".into();
    }
    let r = (v * 10_000.0).round() / 10_000.0;
    if r == r.trunc() && r.abs() < 1e15 {
        format!("{}", r as i64)
    } else {
        let s = format!("{r:.4}");
        let s = s.trim_end_matches('0').trim_end_matches('.');
        if s.is_empty() || s == "-" {
            "0".into()
        } else {
            s.to_string()
        }
    }
}

/// `a b c d e f` of a matrix.
pub fn matrix_ops(m: &Matrix) -> String {
    format!(
        "{} {} {} {} {} {}",
        num(m.a),
        num(m.b),
        num(m.c),
        num(m.d),
        num(m.e),
        num(m.f)
    )
}

/// `<hex>` string operand.
pub fn hex_string(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2 + 2);
    s.push('<');
    for b in bytes {
        s.push_str(&format!("{b:02X}"));
    }
    s.push('>');
    s
}

/// Numeric value of a direct object.
pub fn number(o: &Object) -> Option<f64> {
    match o {
        Object::Integer(i) => Some(*i as f64),
        Object::Real(r) => {
            let v = f64::from(*r);
            v.is_finite().then_some(v)
        }
        _ => None,
    }
}

/// Deflate `data` into a new stream with `dict` (Filter/DecodeParms/Length replaced).
pub fn flate_stream(mut dict: Dictionary, data: &[u8]) -> Stream {
    dict.remove(b"Filter");
    dict.remove(b"DecodeParms");
    dict.remove(b"Length");
    dict.remove(b"DL");
    let mut enc = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    let compressed = enc.write_all(data).ok().and_then(|_| enc.finish().ok());
    match compressed {
        Some(c) => {
            dict.set("Filter", Object::Name(b"FlateDecode".to_vec()));
            Stream::new(dict, c)
        }
        None => Stream::new(dict, data.to_vec()),
    }
}

/// Name of a `/Subtype` or `/Type` entry.
pub fn name_of<'a>(d: &'a Dictionary, key: &[u8]) -> Option<&'a [u8]> {
    match d.get(key) {
        Ok(Object::Name(n)) => Some(n.as_slice()),
        _ => None,
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn inverse_round_trips() {
        let m = Matrix::new(2.0, 0.5, -1.0, 3.0, 10.0, 20.0);
        let i = invert(&m).unwrap();
        let p = m.then(&i);
        assert!((p.a - 1.0).abs() < 1e-9 && p.b.abs() < 1e-9 && p.e.abs() < 1e-9);
        assert!(invert(&Matrix::new(0.0, 0.0, 0.0, 0.0, 1.0, 1.0)).is_none());
    }

    #[test]
    fn numbers_are_compact() {
        assert_eq!(num(1.0), "1");
        assert_eq!(num(-0.25), "-0.25");
        assert_eq!(num(1.0 / 3.0), "0.3333");
        assert_eq!(num(f64::NAN), "0");
        assert_eq!(hex_string(&[0, 0xab]), "<00AB>");
    }
}
