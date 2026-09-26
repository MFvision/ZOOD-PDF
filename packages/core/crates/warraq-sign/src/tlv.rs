//! Minimal, bounded ASN.1 TLV walker. Used where the exact input bytes matter (signed
//! attributes and TBS certificates are verified over their ORIGINAL encoding, not over a
//! re-encoding) and to normalise BER (indefinite lengths, constructed strings — common in
//! Windows-made PKCS#12 files and some CMS producers) to DER before the typed decoders run.
//!
//! Only single-byte tags are accepted (every structure we read uses tag numbers < 31).

use crate::error::{Result, SignError};
use crate::limits::MAX_ASN1_DEPTH;

/// One TLV element.
#[derive(Debug, Clone, Copy)]
pub struct Tlv<'a> {
    /// The identifier octet.
    pub tag: u8,
    /// Content octets.
    pub content: &'a [u8],
    /// The whole element (header + content).
    pub raw: &'a [u8],
}

fn bad(msg: &str) -> SignError {
    SignError::Malformed(format!("ASN.1: {msg}"))
}

/// Header: `(tag, content_len or None for indefinite, header_len)`.
fn header(input: &[u8]) -> Result<(u8, Option<usize>, usize)> {
    let tag = *input.first().ok_or_else(|| bad("truncated tag"))?;
    if tag & 0x1F == 0x1F {
        return Err(bad("multi-byte tags are not supported"));
    }
    let l0 = *input.get(1).ok_or_else(|| bad("truncated length"))?;
    if l0 < 0x80 {
        return Ok((tag, Some(usize::from(l0)), 2));
    }
    if l0 == 0x80 {
        return Ok((tag, None, 2));
    }
    let n = usize::from(l0 & 0x7F);
    if n > 4 {
        return Err(bad("length too large"));
    }
    let mut len = 0usize;
    for i in 0..n {
        let b = *input.get(2 + i).ok_or_else(|| bad("truncated length"))?;
        len = (len << 8) | usize::from(b);
    }
    Ok((tag, Some(len), 2 + n))
}

/// Read one DER element (definite length) from the front of `input`; returns it and the rest.
pub fn read(input: &[u8]) -> Result<(Tlv<'_>, &[u8])> {
    let (tag, len, hl) = header(input)?;
    let len = len.ok_or_else(|| bad("indefinite length in DER"))?;
    let end = hl.checked_add(len).ok_or_else(|| bad("length overflow"))?;
    let raw = input
        .get(..end)
        .ok_or_else(|| bad("element longer than input"))?;
    let content = raw.get(hl..).ok_or_else(|| bad("truncated"))?;
    Ok((
        Tlv { tag, content, raw },
        input.get(end..).unwrap_or_default(),
    ))
}

/// All child elements of a constructed element's content.
pub fn children(mut content: &[u8]) -> Result<Vec<Tlv<'_>>> {
    let mut out = Vec::new();
    while !content.is_empty() {
        let (t, rest) = read(content)?;
        out.push(t);
        if out.len() > 100_000 {
            return Err(bad("too many elements"));
        }
        content = rest;
    }
    Ok(out)
}

/// Length in bytes of the first element (DER or BER), e.g. to strip the zero padding after
/// a CMS blob in `/Contents`.
pub fn element_len(input: &[u8]) -> Result<usize> {
    let mut sink = Vec::new();
    let (_, used) = ber_element(input, 0, &mut sink, true)?;
    Ok(used)
}

fn push_len(out: &mut Vec<u8>, len: usize) {
    if len < 0x80 {
        out.push(len as u8);
    } else {
        let bytes = (len as u64).to_be_bytes();
        let skip = bytes.iter().take_while(|b| **b == 0).count();
        let tail = bytes.get(skip..).unwrap_or_default();
        out.push(0x80 | tail.len() as u8);
        out.extend_from_slice(tail);
    }
}

/// Encode `tag` + DER length + `content`.
pub fn encode(tag: u8, content: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(content.len() + 6);
    out.push(tag);
    push_len(&mut out, content.len());
    out.extend_from_slice(content);
    out
}

/// Universal string/octet types that BER may encode as constructed.
fn is_string_tag(tag_number: u8) -> bool {
    matches!(
        tag_number,
        0x04 | 0x0C | 0x12 | 0x13 | 0x14 | 0x16 | 0x1A | 0x1E
    )
}

/// Parse one BER element at `input`, append its DER form to `out` (unless `measure_only`),
/// return `(content bytes when primitive-string-flattening is needed, bytes consumed)`.
fn ber_element(
    input: &[u8],
    depth: usize,
    out: &mut Vec<u8>,
    measure_only: bool,
) -> Result<(Vec<u8>, usize)> {
    if depth > MAX_ASN1_DEPTH {
        return Err(bad("nesting too deep"));
    }
    let (tag, len, hl) = header(input)?;
    let constructed = tag & 0x20 != 0;
    let universal = tag & 0xC0 == 0;
    let body = input.get(hl..).ok_or_else(|| bad("truncated"))?;
    if !constructed {
        let len = len.ok_or_else(|| bad("indefinite primitive"))?;
        let content = body
            .get(..len)
            .ok_or_else(|| bad("element longer than input"))?;
        if !measure_only {
            out.push(tag);
            push_len(out, len);
            out.extend_from_slice(content);
        }
        return Ok((content.to_vec(), hl + len));
    }
    // Constructed: walk children.
    let limit = match len {
        Some(l) => Some(
            body.get(..l)
                .ok_or_else(|| bad("element longer than input"))?,
        ),
        None => None,
    };
    let mut pos = 0usize;
    let mut inner = Vec::new();
    let mut flat = Vec::new();
    let flatten = universal && is_string_tag(tag & 0x1F);
    loop {
        let rest = match limit {
            Some(l) => {
                if pos >= l.len() {
                    break;
                }
                l.get(pos..).unwrap_or_default()
            }
            None => {
                let r = body.get(pos..).ok_or_else(|| bad("truncated"))?;
                if r.starts_with(&[0, 0]) {
                    pos += 2;
                    break;
                }
                if r.is_empty() {
                    return Err(bad("missing end-of-contents"));
                }
                r
            }
        };
        let (content, used) = ber_element(rest, depth + 1, &mut inner, measure_only || flatten)?;
        if flatten {
            flat.extend_from_slice(&content);
        }
        pos += used;
    }
    if !measure_only {
        if flatten {
            out.push(tag & !0x20);
            push_len(out, flat.len());
            out.extend_from_slice(&flat);
        } else {
            out.push(tag);
            push_len(out, inner.len());
            out.extend_from_slice(&inner);
        }
    }
    Ok((flat, hl + pos))
}

/// Convert one BER element (the first in `input`) to DER; trailing bytes are ignored.
/// SET OF ordering is not changed (the typed decoders sort).
pub fn ber_to_der(input: &[u8]) -> Result<Vec<u8>> {
    let mut out = Vec::with_capacity(input.len());
    ber_element(input, 0, &mut out, false)?;
    Ok(out)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    #[test]
    fn reads_der_and_children() {
        let seq = [0x30, 0x06, 0x02, 0x01, 0x05, 0x04, 0x01, 0xAA];
        let (t, rest) = read(&seq).unwrap();
        assert_eq!(t.tag, 0x30);
        assert!(rest.is_empty());
        let kids = children(t.content).unwrap();
        assert_eq!(kids.len(), 2);
        assert_eq!(kids[1].content, &[0xAA]);
    }

    #[test]
    fn ber_indefinite_and_constructed_strings_become_der() {
        // SEQUENCE (indefinite) { OCTET STRING constructed (indefinite) { 04 01 41, 04 01 42 } }
        let ber = [
            0x30, 0x80, 0x24, 0x80, 0x04, 0x01, 0x41, 0x04, 0x01, 0x42, 0x00, 0x00, 0x00, 0x00,
            0xFF,
        ];
        let der = ber_to_der(&ber).unwrap();
        assert_eq!(der, vec![0x30, 0x04, 0x04, 0x02, 0x41, 0x42]);
        assert_eq!(element_len(&ber).unwrap(), 14);
    }

    #[test]
    fn hostile_inputs_error_without_panic() {
        for bad_input in [
            &[][..],
            &[0x30],
            &[0x30, 0x85, 1, 1, 1, 1, 1],
            &[0x30, 0x80],
            &[0x1F, 0x01, 0x00],
            &[0x30, 0x10, 0x00],
        ] {
            assert!(ber_to_der(bad_input).is_err());
            let _ = read(bad_input);
        }
        // Deep nesting is refused.
        let mut deep = Vec::new();
        for _ in 0..200 {
            deep.extend_from_slice(&[0x30, 0x80]);
        }
        assert!(ber_to_der(&deep).is_err());
    }
}
