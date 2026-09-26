//! Byte-level checks of the file syntax (ISO 19005-1 6.1.2–6.1.8 / ISO 19005-2 6.1.2–6.1.9):
//! header, binary comment, end-of-file marker, cross-reference syntax, object headers, stream
//! keywords and lengths, hexadecimal strings. One linear pass; stream data is skipped.

use crate::lexer::{find, rfind, Lexer, Tok};
use crate::report::{Sink, F};
use warraq_pdf::lopdf::{Object, ObjectId};
use warraq_pdf::Pdf;

fn is_eol(b: u8) -> bool {
    b == b'\n' || b == b'\r'
}

/// Length of the EOL marker starting at `i` (CRLF = 2, CR or LF = 1, else 0).
fn eol_len(buf: &[u8], i: usize) -> usize {
    match (buf.get(i), buf.get(i + 1)) {
        (Some(b'\r'), Some(b'\n')) => 2,
        (Some(b'\r'), _) | (Some(b'\n'), _) => 1,
        _ => 0,
    }
}

/// Header, binary comment and EOF checks.
pub fn header_and_eof(bytes: &[u8], sink: &mut Sink) {
    let ok_header = bytes.len() >= 8
        && bytes.starts_with(b"%PDF-1.")
        && bytes.get(7).is_some_and(u8::is_ascii_digit);
    if !ok_header {
        sink.push(
            F::new(
                "file-header",
                "bad",
                "The file does not start with %PDF-1.n at byte 0",
            )
            .fixable(true),
        );
    }
    // The comment line after the header.
    let line_end = bytes
        .iter()
        .take(1024)
        .position(|b| is_eol(*b))
        .unwrap_or(bytes.len());
    let next = line_end + eol_len(bytes, line_end);
    let comment_ok = bytes.get(next) == Some(&b'%') && {
        let rest = bytes.get(next + 1..).unwrap_or_default();
        let end = rest.iter().position(|b| is_eol(*b)).unwrap_or(rest.len());
        rest.get(..end)
            .unwrap_or_default()
            .iter()
            .filter(|b| **b > 127)
            .count()
            >= 4
    };
    if !comment_ok {
        sink.push(
            F::new(
                "binary-comment",
                "missing",
                "The header is not followed by a comment with four bytes above 127",
            )
            .fixable(true),
        );
    }
    match rfind(bytes, b"%%EOF") {
        None => {
            sink.push(F::new("eof-marker", "missing", "The file has no %%EOF marker").fixable(true))
        }
        Some(p) => {
            let after = bytes.get(p + 5..).unwrap_or_default();
            let ok = after.is_empty() || after == b"\n" || after == b"\r" || after == b"\r\n";
            if !ok {
                sink.push(
                    F::new(
                        "eof-marker",
                        "trailing",
                        "Data follows the last %%EOF marker",
                    )
                    .param("bytes", after.len())
                    .fixable(true),
                );
            }
        }
    }
}

/// Declared /Length of stream object `id`, resolved.
fn declared_length(pdf: &Pdf, id: ObjectId) -> Option<i64> {
    let Some(Object::Stream(s)) = pdf.get(id) else {
        return None;
    };
    let l = s.dict.get(b"Length").ok()?;
    pdf.resolve(l)?.as_i64().ok()
}

/// The token scan: objects, streams, hex strings, xref sections.
pub fn tokens(pdf: &Pdf, sink: &mut Sink) {
    let buf = pdf.bytes();
    let mut lx = Lexer::new(buf);
    // The last two integers (value, start, end) for "N G obj".
    let mut ints: [(i64, usize, usize); 2] = [(0, usize::MAX, 0), (0, usize::MAX, 0)];
    let mut current: Option<ObjectId> = None;
    let mut obj_issues = 0usize;
    while let Some((pos, tok)) = lx.next_tok() {
        match tok {
            Tok::Int(v) => {
                ints = [ints[1], (v, pos, lx.pos)];
            }
            Tok::Kw(b"obj") => {
                let [(num, ns, ne), (gen, gs, ge)] = ints;
                if ns != usize::MAX && gs != usize::MAX && ne <= gs {
                    let id = (
                        u32::try_from(num).unwrap_or(0),
                        u16::try_from(gen).unwrap_or(0),
                    );
                    current = Some(id);
                    let one_space = |a: usize, b: usize| buf.get(a..b) == Some(b" ".as_slice());
                    let preceded = ns == 0 || buf.get(ns - 1).copied().is_some_and(is_eol);
                    let followed = buf.get(lx.pos).copied().is_some_and(is_eol);
                    if !(one_space(ne, gs) && one_space(ge, pos) && preceded && followed)
                        && obj_issues < 1000
                    {
                        obj_issues += 1;
                        sink.push(
                            F::new(
                                "indirect-object-syntax",
                                "header",
                                "The object header is not 'N G obj' on its own line",
                            )
                            .obj(current)
                            .fixable(true),
                        );
                    }
                }
                ints = [(0, usize::MAX, 0), (0, usize::MAX, 0)];
            }
            Tok::Kw(b"endobj") => {
                let preceded = pos > 0 && buf.get(pos - 1).copied().is_some_and(is_eol);
                let after = buf.get(lx.pos).copied();
                let followed = after.is_none_or(is_eol);
                if !(preceded && followed) && obj_issues < 1000 {
                    obj_issues += 1;
                    sink.push(
                        F::new(
                            "indirect-object-syntax",
                            "endobj",
                            "endobj is not on its own line",
                        )
                        .obj(current)
                        .fixable(true),
                    );
                }
                ints = [(0, usize::MAX, 0), (0, usize::MAX, 0)];
            }
            Tok::Kw(b"stream") => {
                let e = eol_len(buf, lx.pos);
                let cr_only = e == 1 && buf.get(lx.pos) == Some(&b'\r');
                if e == 0 || cr_only {
                    sink.push(
                        F::new(
                            "stream-keywords",
                            "stream",
                            "The stream keyword is not followed by CRLF or LF",
                        )
                        .obj(current)
                        .fixable(true),
                    );
                }
                let data_start = lx.pos + e;
                // Trust /Length when `endstream` (after an optional EOL) sits right there: binary
                // data may itself end in CR or LF, so the EOL before `endstream` is ambiguous.
                let declared = current.and_then(|id| declared_length(pdf, id));
                let at_declared = declared.and_then(|d| {
                    let p = data_start.checked_add(usize::try_from(d).ok()?)?;
                    let eol = eol_len(buf, p);
                    (eol > 0 && buf.get(p + eol..)?.starts_with(b"endstream")).then_some(p + eol)
                });
                if let Some(end) = at_declared {
                    lx.pos = end + b"endstream".len();
                    continue;
                }
                let Some(end) = find(buf, b"endstream", data_start) else {
                    break;
                };
                let (eol_before, data_end) = match (
                    end.checked_sub(2).and_then(|i| buf.get(i)),
                    end.checked_sub(1).and_then(|i| buf.get(i)),
                ) {
                    (Some(b'\r'), Some(b'\n')) => (true, end - 2),
                    (_, Some(b'\n')) | (_, Some(b'\r')) => (true, end - 1),
                    _ => (false, end),
                };
                if !eol_before {
                    sink.push(
                        F::new(
                            "stream-keywords",
                            "endstream",
                            "The endstream keyword is not preceded by an end-of-line marker",
                        )
                        .obj(current)
                        .fixable(true),
                    );
                }
                if current.is_some() {
                    if let Some(declared) = declared {
                        let actual = data_end.saturating_sub(data_start) as i64;
                        if declared != actual {
                            sink.push(
                                F::new(
                                    "stream-length",
                                    "mismatch",
                                    format!(
                                        "/Length is {declared} but the stream has {actual} bytes"
                                    ),
                                )
                                .obj(current)
                                .param("declared", declared)
                                .param("actual", actual)
                                .fixable(true),
                            );
                        }
                    }
                }
                lx.pos = end + b"endstream".len();
            }
            Tok::Hex { digits, bad, .. } => {
                if digits % 2 == 1 || bad {
                    sink.push(
                        F::new(
                            "hex-strings",
                            if bad { "chars" } else { "odd" },
                            "A hexadecimal string has an odd number of digits or non-hexadecimal characters",
                        )
                        .obj(current)
                        .fixable(true),
                    );
                }
            }
            Tok::Kw(b"xref") => {
                let e = eol_len(buf, lx.pos);
                let mut ok = e > 0;
                let mut i = lx.pos + e;
                // Subsection header: start SP count EOL.
                let digits = |i: &mut usize| {
                    let s = *i;
                    while buf.get(*i).is_some_and(u8::is_ascii_digit) {
                        *i += 1;
                    }
                    *i > s
                };
                ok &= digits(&mut i);
                ok &= buf.get(i) == Some(&b' ');
                i += 1;
                ok &= digits(&mut i);
                // One optional trailing space is common in the wild but not allowed.
                ok &= eol_len(buf, i) > 0;
                if !ok {
                    sink.push(
                        F::new(
                            "xref-syntax",
                            "header",
                            "The xref keyword and its subsection header are not separated by one end-of-line marker and one space",
                        )
                        .fixable(true),
                    );
                }
                ints = [(0, usize::MAX, 0), (0, usize::MAX, 0)];
            }
            _ => {
                ints = [(0, usize::MAX, 0), (0, usize::MAX, 0)];
            }
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;
    use crate::profile::Profile;

    #[test]
    fn eol_lengths() {
        assert_eq!(eol_len(b"\r\n", 0), 2);
        assert_eq!(eol_len(b"\n", 0), 1);
        assert_eq!(eol_len(b"x", 0), 0);
    }

    #[test]
    fn header_rules() {
        let mut s = Sink::new(Profile::A2b);
        header_and_eof(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\nbody\n%%EOF\n", &mut s);
        assert!(s.finish(false, vec![]).findings.is_empty());
        let mut s = Sink::new(Profile::A2b);
        header_and_eof(b" %PDF-1.7\n%abc\nbody\n%%EOF\nmore", &mut s);
        let r = s.finish(false, vec![]);
        assert!(r.has("file-header") && r.has("binary-comment") && r.has("eof-marker"));
    }
}
