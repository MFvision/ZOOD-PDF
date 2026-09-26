//! Normal appearance streams for simple annotation types that arrive without one (PDF/A-2/3 require
//! an appearance for every annotation except Popup and Link). Only geometry the annotation itself
//! defines is drawn: rectangles, ellipses, lines, ink paths, polygons, text markup and a note icon.
//! Types whose look depends on fonts or external data (FreeText, Stamp, widgets) are not drawn.

use crate::model::{get, get_dict, get_name, num};
use std::fmt::Write as _;
use warraq_pdf::lopdf::{Dictionary, Object, Stream};
use warraq_pdf::Pdf;

fn nums(pdf: &Pdf, o: Option<&Object>) -> Vec<f64> {
    match o.and_then(|o| pdf.resolve(o)) {
        Some(Object::Array(a)) => a
            .iter()
            .filter_map(|x| pdf.resolve(x).and_then(num))
            .collect(),
        _ => Vec::new(),
    }
}

fn f(v: f64) -> String {
    let s = format!("{v:.3}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s.is_empty() || s == "-0" {
        "0".into()
    } else {
        s.to_string()
    }
}

/// RGB for an annotation colour array (gray, RGB, or CMYK converted naively).
fn rgb(c: &[f64]) -> Option<(f64, f64, f64)> {
    match c {
        [g] => Some((*g, *g, *g)),
        [r, g, b] => Some((*r, *g, *b)),
        [c, m, y, k] => Some((
            (1.0 - c) * (1.0 - k),
            (1.0 - m) * (1.0 - k),
            (1.0 - y) * (1.0 - k),
        )),
        _ => None,
    }
}

fn colour(op: &str, c: (f64, f64, f64)) -> String {
    format!(
        "{} {} {} {op}\n",
        f(c.0.clamp(0.0, 1.0)),
        f(c.1.clamp(0.0, 1.0)),
        f(c.2.clamp(0.0, 1.0))
    )
}

/// Build the /N appearance stream for annotation `d`, or `None` if its type is not drawable.
/// `allow_multiply`: text highlights use a Multiply blend (not allowed in PDF/A-1).
pub fn build(
    pdf: &Pdf,
    d: &Dictionary,
    allow_multiply: bool,
    default_rgb: Option<Object>,
) -> Option<Stream> {
    let sub = get_name(pdf, d, b"Subtype")?;
    let rect = nums(pdf, d.get(b"Rect").ok());
    let [x0, y0, x1, y1] = rect.as_slice() else {
        return None;
    };
    let (x0, y0, x1, y1) = (x0.min(*x1), y0.min(*y1), x0.max(*x1), y0.max(*y1));
    let (w, h) = (x1 - x0, y1 - y0);
    if !(w.is_finite() && h.is_finite()) || w <= 0.0 || h <= 0.0 {
        return None;
    }
    let stroke = rgb(&nums(pdf, d.get(b"C").ok())).unwrap_or((0.0, 0.0, 0.0));
    let fill = rgb(&nums(pdf, d.get(b"IC").ok()));
    let bw = get_dict(pdf, d, b"BS")
        .and_then(|bs| get(pdf, bs, b"W"))
        .and_then(num)
        .or_else(|| nums(pdf, d.get(b"Border").ok()).get(2).copied())
        .unwrap_or(1.0)
        .clamp(0.0, 100.0);
    // Coordinates relative to the rectangle's lower-left corner.
    let pt = |x: f64, y: f64| format!("{} {}", f(x - x0), f(y - y0));
    let mut s = String::from("q\n");
    let mut resources = Dictionary::new();
    match sub {
        b"Square" | b"Circle" => {
            let i = bw / 2.0;
            let (rx, ry, rw, rh) = (i, i, (w - bw).max(0.0), (h - bw).max(0.0));
            let _ = writeln!(s, "{}{} w", colour("RG", stroke), f(bw));
            if let Some(fc) = fill {
                s.push_str(&colour("rg", fc));
            }
            if sub == b"Square" {
                let _ = writeln!(s, "{} {} {} {} re", f(rx), f(ry), f(rw), f(rh));
            } else {
                let (cx, cy, a, b) = (rx + rw / 2.0, ry + rh / 2.0, rw / 2.0, rh / 2.0);
                let k = 0.552_284_75;
                let _ = writeln!(s, "{} {} m", f(cx + a), f(cy));
                let _ = writeln!(
                    s,
                    "{} {} {} {} {} {} c",
                    f(cx + a),
                    f(cy + b * k),
                    f(cx + a * k),
                    f(cy + b),
                    f(cx),
                    f(cy + b)
                );
                let _ = writeln!(
                    s,
                    "{} {} {} {} {} {} c",
                    f(cx - a * k),
                    f(cy + b),
                    f(cx - a),
                    f(cy + b * k),
                    f(cx - a),
                    f(cy)
                );
                let _ = writeln!(
                    s,
                    "{} {} {} {} {} {} c",
                    f(cx - a),
                    f(cy - b * k),
                    f(cx - a * k),
                    f(cy - b),
                    f(cx),
                    f(cy - b)
                );
                let _ = writeln!(
                    s,
                    "{} {} {} {} {} {} c",
                    f(cx + a * k),
                    f(cy - b),
                    f(cx + a),
                    f(cy - b * k),
                    f(cx + a),
                    f(cy)
                );
            }
            s.push_str(if fill.is_some() { "B\n" } else { "S\n" });
        }
        b"Line" => {
            let l = nums(pdf, d.get(b"L").ok());
            let [a, b, c, e] = l.as_slice() else {
                return None;
            };
            let _ = write!(
                s,
                "{}{} w 1 J\n{} m {} l S\n",
                colour("RG", stroke),
                f(bw),
                pt(*a, *b),
                pt(*c, *e)
            );
        }
        b"Ink" => {
            let Some(Object::Array(list)) = get(pdf, d, b"InkList") else {
                return None;
            };
            let _ = writeln!(s, "{}{} w 1 J 1 j", colour("RG", stroke), f(bw));
            for path in list.iter().take(10_000) {
                let v = nums(pdf, Some(path));
                for (i, p) in v.chunks_exact(2).enumerate() {
                    let (Some(x), Some(y)) = (p.first(), p.get(1)) else {
                        continue;
                    };
                    let _ = writeln!(s, "{} {}", pt(*x, *y), if i == 0 { "m" } else { "l" });
                }
                s.push_str("S\n");
            }
        }
        b"Polygon" | b"PolyLine" => {
            let v = nums(pdf, d.get(b"Vertices").ok());
            if v.len() < 4 {
                return None;
            }
            let _ = writeln!(s, "{}{} w 1 j", colour("RG", stroke), f(bw));
            if let Some(fc) = fill {
                s.push_str(&colour("rg", fc));
            }
            for (i, p) in v.chunks_exact(2).enumerate() {
                let (Some(x), Some(y)) = (p.first(), p.get(1)) else {
                    continue;
                };
                let _ = writeln!(s, "{} {}", pt(*x, *y), if i == 0 { "m" } else { "l" });
            }
            s.push_str(match (sub, fill.is_some()) {
                (b"Polygon", true) => "b\n",
                (b"Polygon", false) => "s\n",
                _ => "S\n",
            });
        }
        b"Highlight" | b"Underline" | b"StrikeOut" | b"Squiggly" => {
            let q = nums(pdf, d.get(b"QuadPoints").ok());
            if q.len() < 8 {
                return None;
            }
            if sub == b"Highlight" {
                if !allow_multiply {
                    return None;
                }
                let mut gs = Dictionary::new();
                gs.set("Type", Object::Name(b"ExtGState".to_vec()));
                gs.set("BM", Object::Name(b"Multiply".to_vec()));
                let mut ext = Dictionary::new();
                ext.set("GS0", Object::Dictionary(gs));
                resources.set("ExtGState", Object::Dictionary(ext));
                let hl = rgb(&nums(pdf, d.get(b"C").ok())).unwrap_or((1.0, 1.0, 0.0));
                let _ = write!(s, "/GS0 gs\n{}", colour("rg", hl));
            } else {
                let _ = write!(s, "{}", colour("RG", stroke));
            }
            for quad in q.chunks_exact(8).take(10_000) {
                let [ax, ay, bx, by, cx, cy, dx, dy] = quad else {
                    continue;
                };
                let height = ((ax - cx).powi(2) + (ay - cy).powi(2)).sqrt().max(1.0);
                match sub {
                    b"Highlight" => {
                        let _ = writeln!(
                            s,
                            "{} m {} l {} l {} l h f",
                            pt(*ax, *ay),
                            pt(*bx, *by),
                            pt(*dx, *dy),
                            pt(*cx, *cy)
                        );
                    }
                    b"Underline" => {
                        let t = height / 14.0;
                        let off = height * 0.08;
                        let _ = writeln!(
                            s,
                            "{} w {} m {} l S",
                            f(t),
                            pt(*cx, cy + off),
                            pt(*dx, dy + off)
                        );
                    }
                    b"StrikeOut" => {
                        let t = height / 14.0;
                        let _ = writeln!(
                            s,
                            "{} w {} m {} l S",
                            f(t),
                            pt((ax + cx) / 2.0, (ay + cy) / 2.0),
                            pt((bx + dx) / 2.0, (by + dy) / 2.0)
                        );
                    }
                    _ => {
                        let t = height / 20.0;
                        let amp = height / 12.0;
                        let len = ((dx - cx).powi(2) + (dy - cy).powi(2)).sqrt();
                        let steps = ((len / (amp * 2.0)).ceil() as usize).clamp(1, 2000);
                        let _ = writeln!(s, "{} w {} m", f(t), pt(*cx, cy + amp));
                        for i in 1..=steps {
                            let tt = i as f64 / steps as f64;
                            let yoff = if i % 2 == 1 { 0.0 } else { amp * 2.0 };
                            let _ = writeln!(
                                s,
                                "{} l",
                                pt(cx + (dx - cx) * tt, cy + (dy - cy) * tt + yoff)
                            );
                        }
                        s.push_str("S\n");
                    }
                }
            }
        }
        b"Text" => {
            // A note icon: filled page with three lines.
            let c = rgb(&nums(pdf, d.get(b"C").ok())).unwrap_or((1.0, 0.85, 0.2));
            let (iw, ih) = (w.min(20.0), h.min(20.0));
            let _ = write!(
                s,
                "{}0 0 0 RG 0.6 w\n0.5 0.5 {} {} re B\n",
                colour("rg", c),
                f(iw - 1.0),
                f(ih - 1.0)
            );
            for i in 1..=3 {
                let y = ih * (0.25 * f64::from(i));
                let _ = writeln!(s, "{} {} m {} {} l S", f(iw * 0.2), f(y), f(iw * 0.8), f(y));
            }
        }
        _ => return None,
    }
    s.push_str("Q\n");
    if let Some(cs) = default_rgb {
        let mut c = Dictionary::new();
        c.set("DefaultRGB", cs);
        resources.set("ColorSpace", Object::Dictionary(c));
    }
    let mut sd = Dictionary::new();
    sd.set("Type", Object::Name(b"XObject".to_vec()));
    sd.set("Subtype", Object::Name(b"Form".to_vec()));
    sd.set(
        "BBox",
        Object::Array(vec![
            Object::Integer(0),
            Object::Integer(0),
            Object::Real(w as f32),
            Object::Real(h as f32),
        ]),
    );
    sd.set("Resources", Object::Dictionary(resources));
    Some(Stream::new(sd, s.into_bytes()))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    #[test]
    fn number_format() {
        assert_eq!(f(1.0), "1");
        assert_eq!(f(0.5), "0.5");
        assert_eq!(f(-0.0001), "0");
        assert_eq!(rgb(&[0.0, 0.0, 0.0, 1.0]), Some((0.0, 0.0, 0.0)));
    }
}
