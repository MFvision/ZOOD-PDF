//! Serialisation of lopdf objects to PDF syntax. Own writer (lopdf's is private) so that
//! we control exactly which bytes are appended in incremental updates.

use crate::error::{PdfError, Result};
use lopdf::{Dictionary, Object, ObjectId, StringFormat};
use std::io::Write;

const MAX_WRITE_DEPTH: usize = 512;

fn is_regular_name_byte(b: u8) -> bool {
    (0x21..=0x7E).contains(&b) && !b"()<>[]{}/%#".contains(&b)
}

/// Write a real number without exponent, trimmed of trailing zeros.
fn write_real(out: &mut Vec<u8>, r: f32) {
    if !r.is_finite() {
        out.push(b'0');
        return;
    }
    if r.fract() == 0.0 && r.abs() < 1e15 {
        let _ = write!(out, "{}", r as i64);
        return;
    }
    let s = format!("{:.6}", r);
    let s = s.trim_end_matches('0').trim_end_matches('.');
    out.extend_from_slice(if s.is_empty() || s == "-" {
        b"0"
    } else {
        s.as_bytes()
    });
}

fn write_name(out: &mut Vec<u8>, name: &[u8]) {
    out.push(b'/');
    for &b in name {
        if is_regular_name_byte(b) {
            out.push(b);
        } else {
            let _ = write!(out, "#{:02X}", b);
        }
    }
}

fn write_string(out: &mut Vec<u8>, s: &[u8], format: StringFormat) {
    match format {
        StringFormat::Hexadecimal => {
            out.push(b'<');
            for b in s {
                let _ = write!(out, "{:02X}", b);
            }
            out.push(b'>');
        }
        StringFormat::Literal => {
            out.push(b'(');
            for &b in s {
                match b {
                    b'(' | b')' | b'\\' => {
                        out.push(b'\\');
                        out.push(b);
                    }
                    b'\r' => out.extend_from_slice(b"\\r"),
                    b'\n' => out.extend_from_slice(b"\\n"),
                    _ => out.push(b),
                }
            }
            out.push(b')');
        }
    }
}

fn write_dict(out: &mut Vec<u8>, d: &Dictionary, depth: usize) -> Result<()> {
    out.extend_from_slice(b"<<");
    for (k, v) in d.iter() {
        write_name(out, k);
        out.push(b' ');
        write_object_depth(out, v, depth + 1)?;
    }
    out.extend_from_slice(b">>");
    Ok(())
}

fn write_object_depth(out: &mut Vec<u8>, obj: &Object, depth: usize) -> Result<()> {
    if depth > MAX_WRITE_DEPTH {
        return Err(PdfError::Limit("object nesting too deep to write".into()));
    }
    match obj {
        Object::Null => out.extend_from_slice(b"null"),
        Object::Boolean(b) => out.extend_from_slice(if *b { b"true" } else { b"false" }),
        Object::Integer(i) => {
            let _ = write!(out, "{i}");
        }
        Object::Real(r) => write_real(out, *r),
        Object::Name(n) => write_name(out, n),
        Object::String(s, f) => write_string(out, s, *f),
        Object::Array(a) => {
            out.push(b'[');
            for (i, o) in a.iter().enumerate() {
                if i > 0 {
                    out.push(b' ');
                }
                write_object_depth(out, o, depth + 1)?;
            }
            out.push(b']');
        }
        Object::Dictionary(d) => write_dict(out, d, depth)?,
        Object::Stream(s) => {
            let mut dict = s.dict.clone();
            dict.set("Length", Object::Integer(s.content.len() as i64));
            write_dict(out, &dict, depth)?;
            out.extend_from_slice(b"\nstream\n");
            out.extend_from_slice(&s.content);
            out.extend_from_slice(b"\nendstream");
        }
        Object::Reference((n, g)) => {
            let _ = write!(out, "{n} {g} R");
        }
    }
    Ok(())
}

/// Append the PDF syntax of a direct object.
pub fn write_object(out: &mut Vec<u8>, obj: &Object) -> Result<()> {
    write_object_depth(out, obj, 0)
}

/// Append `N G obj … endobj` and return nothing; the caller records `out.len()` before.
pub fn write_indirect(out: &mut Vec<u8>, id: ObjectId, obj: &Object) -> Result<()> {
    let _ = writeln!(out, "{} {} obj", id.0, id.1);
    write_object(out, obj)?;
    out.extend_from_slice(b"\nendobj\n");
    Ok(())
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
    use lopdf::{dictionary, Stream};

    fn s(o: &Object) -> String {
        let mut v = Vec::new();
        write_object(&mut v, o).unwrap();
        String::from_utf8_lossy(&v).into_owned()
    }

    #[test]
    fn writes_basic_objects() {
        assert_eq!(s(&Object::Integer(-3)), "-3");
        assert_eq!(s(&Object::Real(1.5)), "1.5");
        assert_eq!(s(&Object::Real(2.0)), "2");
        assert_eq!(s(&Object::Real(0.25)), "0.25");
        assert_eq!(s(&Object::Name(b"A B#".to_vec())), "/A#20B#23");
        assert_eq!(s(&Object::string_literal("a(b)\\")), "(a\\(b\\)\\\\)");
        assert_eq!(
            s(&Object::String(vec![0xFE, 0xFF], StringFormat::Hexadecimal)),
            "<FEFF>"
        );
        assert_eq!(s(&Object::Reference((4, 1))), "4 1 R");
        assert_eq!(
            s(&Object::Dictionary(
                dictionary! {"A" => 1, "B" => vec![Object::Null, true.into()]}
            )),
            "<</A 1/B [null true]>>"
        );
    }

    #[test]
    fn stream_length_is_rewritten() {
        let st = Stream::new(dictionary! {"Length" => 99}, b"abc".to_vec());
        assert_eq!(
            s(&Object::Stream(st)),
            "<</Length 3>>\nstream\nabc\nendstream"
        );
    }

    #[test]
    fn written_objects_parse_back_with_lopdf() {
        let obj = Object::Dictionary(dictionary! {
            "Name" => Object::Name(b"x y".to_vec()),
            "S" => Object::string_literal("(\r\n)"),
            "R" => Object::Real(-0.5),
        });
        let mut v = b"%PDF-1.7\n".to_vec();
        let off = v.len();
        write_indirect(&mut v, (1, 0), &obj).unwrap();
        let xref = v.len();
        v.extend_from_slice(
            format!(
                "xref\n0 2\n0000000000 65535 f \n{:010} 00000 n \ntrailer\n<</Size 2/Root 1 0 R>>\nstartxref\n{}\n%%EOF\n",
                off, xref
            )
            .as_bytes(),
        );
        let doc = lopdf::Document::load_mem(&v).unwrap();
        let back = doc.get_object((1, 0)).unwrap().as_dict().unwrap();
        assert_eq!(back.get(b"Name").unwrap().as_name().unwrap(), b"x y");
        assert_eq!(back.get(b"S").unwrap().as_str().unwrap(), b"(\r\n)");
    }
}
