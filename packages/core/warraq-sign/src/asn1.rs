//! A minimal DER walker, for the few places a signature must be checked over
//! bytes exactly as they were written: the signed attributes of a CMS signer
//! (re-encoding them can reorder a SET that was not sorted), the "to be
//! signed" part of a certificate, a CRL or an OCSP answer. Typed decoding is
//! `der`'s job; this only finds where things are. Definite lengths only (DER);
//! every length is checked against what is left, so hostile input cannot
//! read past its end.
use crate::{Result, SignError};

/// One tag-length-value: `raw` is the whole encoding, `value` its contents.
#[derive(Debug, Clone, Copy)]
pub struct Tlv<'a> {
    pub tag: u8,
    pub value: &'a [u8],
    pub raw: &'a [u8],
}

fn bad(what: &str) -> SignError {
    SignError::Cms(format!("malformed DER: {what}"))
}

/// The first TLV of `input`, and what follows it.
pub fn read(input: &[u8]) -> Result<(Tlv<'_>, &[u8])> {
    let (&tag, rest) = input.split_first().ok_or_else(|| bad("empty"))?;
    if tag & 0x1f == 0x1f {
        return Err(bad("high tag number"));
    }
    let (&first, mut rest) = rest.split_first().ok_or_else(|| bad("no length"))?;
    let len = if first < 0x80 {
        first as usize
    } else {
        let n = (first & 0x7f) as usize;
        if n == 0 {
            return Err(bad("indefinite length (BER)"));
        }
        if n > 4 || rest.len() < n {
            return Err(bad("length"));
        }
        let mut len = 0usize;
        for &b in &rest[..n] {
            len = (len << 8) | b as usize;
        }
        rest = &rest[n..];
        len
    };
    if rest.len() < len {
        return Err(bad("length past the end"));
    }
    let header = input.len() - rest.len();
    Ok((
        Tlv {
            tag,
            value: &rest[..len],
            raw: &input[..header + len],
        },
        &rest[len..],
    ))
}

/// The TLVs inside a constructed value, in order (at most 100 000).
pub fn children(mut value: &[u8]) -> Result<Vec<Tlv<'_>>> {
    let mut out = Vec::new();
    while !value.is_empty() {
        if out.len() >= 100_000 {
            return Err(bad("too many elements"));
        }
        let (tlv, rest) = read(value)?;
        out.push(tlv);
        value = rest;
    }
    Ok(out)
}

/// The exact bytes of the first TLV of `input`, ignoring what follows — a
/// signature's `/Contents` is padded with zeros after its CMS.
pub fn first_der(input: &[u8]) -> Result<&[u8]> {
    Ok(read(input)?.0.raw)
}

/// DER header for a value of `len` bytes under `tag`.
pub fn header(tag: u8, len: usize) -> Vec<u8> {
    let mut out = vec![tag];
    if len < 0x80 {
        out.push(len as u8);
    } else {
        let bytes: Vec<u8> = (len as u64)
            .to_be_bytes()
            .into_iter()
            .skip_while(|b| *b == 0)
            .collect();
        out.push(0x80 | bytes.len() as u8);
        out.extend(bytes);
    }
    out
}

/// `value` wrapped as a TLV with `tag`.
pub fn wrap(tag: u8, value: &[u8]) -> Vec<u8> {
    let mut out = header(tag, value.len());
    out.extend_from_slice(value);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_short_and_long_lengths_and_refuses_what_runs_past_the_end() {
        let (t, rest) = read(&[0x04, 0x02, 1, 2, 9]).unwrap();
        assert_eq!((t.tag, t.value, rest), (0x04, &[1u8, 2][..], &[9u8][..]));
        let long = wrap(0x04, &[7u8; 300]);
        assert_eq!(&long[..4], &[0x04, 0x82, 0x01, 0x2c]);
        assert_eq!(read(&long).unwrap().0.value.len(), 300);
        assert!(read(&[0x30, 0x05, 1]).is_err());
        assert!(read(&[0x30, 0x80, 0, 0]).is_err(), "BER indefinite length");
        assert!(read(&[0x30, 0x85, 1, 1, 1, 1, 1]).is_err());
        assert!(read(&[]).is_err());
    }

    #[test]
    fn children_walk_a_sequence() {
        let seq = wrap(0x30, &[wrap(0x02, &[1]), wrap(0x05, &[])].concat());
        let (t, _) = read(&seq).unwrap();
        let kids = children(t.value).unwrap();
        assert_eq!(kids.len(), 2);
        assert_eq!(kids[1].raw, &[0x05, 0x00]);
    }
}
