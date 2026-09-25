//! Semantic comparison of (decrypted) objects, used by `rebase` to decide which objects a
//! whole-file writer actually changed. Formatting differences are ignored: key order,
//! literal vs hex strings, `1` vs `1.0`, stream `/Length`, and re-compression (streams
//! whose decoded contents are identical compare equal).

use crate::limits::{decode_stream, Limits};
use lopdf::{Dictionary, Object};

const STREAM_FORMAT_KEYS: &[&[u8]] = &[b"Length", b"Filter", b"DecodeParms", b"DL"];

fn num(o: &Object) -> Option<f64> {
    match o {
        Object::Integer(i) => Some(*i as f64),
        Object::Real(r) => Some(f64::from(*r)),
        _ => None,
    }
}

fn dict_eq(
    a: &Dictionary,
    b: &Dictionary,
    ignore: &[&[u8]],
    limits: &Limits,
    depth: usize,
) -> bool {
    let keep = |k: &Vec<u8>| !ignore.contains(&k.as_slice());
    let ka = a.iter().filter(|(k, _)| keep(k)).count();
    let kb = b.iter().filter(|(k, _)| keep(k)).count();
    if ka != kb {
        return false;
    }
    a.iter()
        .filter(|(k, _)| keep(k))
        .all(|(k, va)| match b.get(k) {
            Ok(vb) => eq(va, vb, limits, depth + 1),
            Err(_) => false,
        })
}

fn eq(a: &Object, b: &Object, limits: &Limits, depth: usize) -> bool {
    if depth > limits.max_depth {
        return false;
    }
    match (a, b) {
        (Object::Null, Object::Null) => true,
        (Object::Boolean(x), Object::Boolean(y)) => x == y,
        (Object::Integer(x), Object::Integer(y)) => x == y,
        (Object::Integer(_) | Object::Real(_), Object::Integer(_) | Object::Real(_)) => {
            match (num(a), num(b)) {
                (Some(x), Some(y)) => (x - y).abs() <= 1e-4 * x.abs().max(1.0),
                _ => false,
            }
        }
        (Object::Name(x), Object::Name(y)) => x == y,
        (Object::String(x, _), Object::String(y, _)) => x == y,
        (Object::Reference(x), Object::Reference(y)) => x == y,
        (Object::Array(x), Object::Array(y)) => {
            x.len() == y.len()
                && x.iter()
                    .zip(y.iter())
                    .all(|(p, q)| eq(p, q, limits, depth + 1))
        }
        (Object::Dictionary(x), Object::Dictionary(y)) => dict_eq(x, y, &[], limits, depth),
        (Object::Stream(x), Object::Stream(y)) => {
            if x.content == y.content && dict_eq(&x.dict, &y.dict, &[b"Length"], limits, depth) {
                return true;
            }
            if !dict_eq(&x.dict, &y.dict, STREAM_FORMAT_KEYS, limits, depth) {
                return false;
            }
            match (decode_stream(x, limits), decode_stream(y, limits)) {
                (Ok(p), Ok(q)) => p == q,
                _ => false,
            }
        }
        _ => false,
    }
}

/// Whether two objects are the same PDF value.
pub fn objects_equal(a: &Object, b: &Object, limits: &Limits) -> bool {
    eq(a, b, limits, 0)
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
    use lopdf::{dictionary, Stream, StringFormat};

    #[test]
    fn formatting_differences_are_equal() {
        let l = Limits::default();
        let a = Object::Dictionary(dictionary! {"A" => 1, "B" => Object::string_literal("x")});
        let b = Object::Dictionary(dictionary! {
            "B" => Object::String(b"x".to_vec(), StringFormat::Hexadecimal),
            "A" => Object::Real(1.0),
        });
        assert!(objects_equal(&a, &b, &l));
        let c = Object::Dictionary(dictionary! {"A" => 2, "B" => Object::string_literal("x")});
        assert!(!objects_equal(&a, &c, &l));
    }

    #[test]
    fn recompressed_stream_is_equal_changed_stream_is_not() {
        let l = Limits::default();
        let body = "q Q\n".repeat(200) + "1";
        let plain = Stream::new(dictionary! {"Length" => 5}, body.clone().into_bytes());
        let mut zipped = plain.clone();
        zipped.compress().unwrap();
        assert!(zipped.dict.has(b"Filter"));
        assert!(objects_equal(
            &Object::Stream(plain.clone()),
            &Object::Stream(zipped),
            &l
        ));
        let other = Stream::new(dictionary! {}, (body + "2").into_bytes());
        assert!(!objects_equal(
            &Object::Stream(plain),
            &Object::Stream(other),
            &l
        ));
    }
}
