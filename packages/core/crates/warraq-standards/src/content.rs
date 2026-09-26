//! Content-stream parsing: operators with their operands (as lopdf objects) and inline images.
//! Bounded: operand stacks, nesting and the total number of operators are capped.

use crate::lexer::{find, is_ws, Lexer, Tok};
use warraq_pdf::lopdf::{Dictionary, Object, StringFormat};

/// Most operands kept for one operator (extra operands are dropped from the front).
const MAX_OPERANDS: usize = 4096;
/// Deepest array/dictionary nesting inside content operands.
const MAX_NEST: usize = 32;

/// An inline image (`BI … ID … EI`).
#[derive(Debug, Clone)]
pub struct InlineImage {
    /// The image dictionary (abbreviated keys as written).
    pub dict: Dictionary,
    /// Byte range of the dictionary (after `BI`, up to `ID`).
    pub dict_range: (usize, usize),
    /// Byte range of the image data.
    pub data: (usize, usize),
}

/// One operator.
#[derive(Debug, Clone)]
pub struct Op<'a> {
    /// Operator keyword.
    pub op: &'a [u8],
    /// Operands in order.
    pub operands: Vec<Object>,
    /// Offset of the operator.
    pub pos: usize,
    /// For `BI`: the inline image.
    pub inline: Option<InlineImage>,
}

/// Every operator defined by ISO 32000-1 (Annex A) plus the PDF 2.0 additions none; used by the
/// `undefined-operators` rule (outside BX/EX compatibility sections).
pub const OPERATORS: &[&[u8]] = &[
    b"b", b"B", b"b*", b"B*", b"BDC", b"BI", b"BMC", b"BT", b"BX", b"c", b"cm", b"CS", b"cs", b"d",
    b"d0", b"d1", b"Do", b"DP", b"EI", b"EMC", b"ET", b"EX", b"f", b"F", b"f*", b"G", b"g", b"gs",
    b"h", b"i", b"ID", b"j", b"J", b"K", b"k", b"l", b"m", b"M", b"MP", b"n", b"q", b"Q", b"re",
    b"RG", b"rg", b"ri", b"s", b"S", b"SC", b"sc", b"SCN", b"scn", b"sh", b"T*", b"Tc", b"Td",
    b"TD", b"Tf", b"Tj", b"TJ", b"TL", b"Tm", b"Tr", b"Ts", b"Tw", b"Tz", b"v", b"w", b"W", b"W*",
    b"y", b"'", b"\"",
];

/// Whether `op` is a defined operator.
pub fn is_defined(op: &[u8]) -> bool {
    OPERATORS.contains(&op)
}

enum Frame {
    Arr(Vec<Object>),
    Dict(Dictionary, Option<Vec<u8>>),
}

fn tok_to_obj(t: Tok<'_>) -> Option<Object> {
    Some(match t {
        Tok::Int(i) => Object::Integer(i),
        Tok::Real(r) => Object::Real(r as f32),
        Tok::Name(n) => Object::Name(n),
        Tok::Str(s) => Object::String(s, StringFormat::Literal),
        Tok::Hex { bytes, .. } => Object::String(bytes, StringFormat::Hexadecimal),
        Tok::Kw(b"true") => Object::Boolean(true),
        Tok::Kw(b"false") => Object::Boolean(false),
        Tok::Kw(b"null") => Object::Null,
        _ => return None,
    })
}

/// Parse `buf`, calling `f` for every operator. Stops (returning `false`) when `budget` operators
/// have been produced or `f` returns `false`.
pub fn parse<'a>(buf: &'a [u8], budget: &mut usize, mut f: impl FnMut(Op<'a>) -> bool) -> bool {
    let mut lx = Lexer::new(buf);
    let mut operands: Vec<Object> = Vec::new();
    let mut stack: Vec<Frame> = Vec::new();
    while let Some((pos, tok)) = lx.next_tok() {
        // Composite operands.
        match tok {
            Tok::ArrOpen => {
                if stack.len() < MAX_NEST {
                    stack.push(Frame::Arr(Vec::new()));
                }
                continue;
            }
            Tok::DictOpen => {
                if stack.len() < MAX_NEST {
                    stack.push(Frame::Dict(Dictionary::new(), None));
                }
                continue;
            }
            Tok::ArrClose | Tok::DictClose => {
                let done = match stack.pop() {
                    Some(Frame::Arr(a)) => Object::Array(a),
                    Some(Frame::Dict(d, _)) => Object::Dictionary(d),
                    None => continue,
                };
                push_value(&mut stack, &mut operands, done);
                continue;
            }
            Tok::Brace => continue,
            _ => {}
        }
        if let Tok::Kw(k) = tok {
            if !matches!(k, b"true" | b"false" | b"null") {
                if !stack.is_empty() {
                    // Keyword inside an array/dict: malformed; drop the composite.
                    stack.clear();
                }
                if *budget == 0 {
                    return false;
                }
                *budget -= 1;
                let mut op = Op {
                    op: k,
                    operands: std::mem::take(&mut operands),
                    pos,
                    inline: None,
                };
                if k == b"BI" {
                    match inline_image(&mut lx) {
                        Some(img) => op.inline = Some(img),
                        None => return true, // unterminated inline image ends the stream
                    }
                }
                if !f(op) {
                    return false;
                }
                continue;
            }
        }
        if let Some(o) = tok_to_obj(tok) {
            push_value(&mut stack, &mut operands, o);
        }
    }
    true
}

fn push_value(stack: &mut [Frame], operands: &mut Vec<Object>, o: Object) {
    match stack.last_mut() {
        Some(Frame::Arr(a)) => {
            if a.len() < MAX_OPERANDS {
                a.push(o);
            }
        }
        Some(Frame::Dict(d, key)) => match key.take() {
            Some(k) => d.set(k, o),
            None => {
                if let Object::Name(n) = o {
                    *key = Some(n);
                }
            }
        },
        None => {
            if operands.len() >= MAX_OPERANDS {
                operands.remove(0);
            }
            operands.push(o);
        }
    }
}

/// After `BI`: key/value pairs up to `ID`, one white-space byte, data up to `EI`.
fn inline_image(lx: &mut Lexer<'_>) -> Option<InlineImage> {
    let dict_start = lx.pos;
    let mut dict = Dictionary::new();
    let mut key: Option<Vec<u8>> = None;
    let mut nested: Vec<Frame> = Vec::new();
    let mut scratch: Vec<Object> = Vec::new();
    let dict_end;
    loop {
        let (pos, t) = lx.next_tok()?;
        match t {
            Tok::Kw(b"ID") if nested.is_empty() => {
                dict_end = pos;
                break;
            }
            Tok::ArrOpen => nested.push(Frame::Arr(Vec::new())),
            Tok::DictOpen => nested.push(Frame::Dict(Dictionary::new(), None)),
            Tok::ArrClose | Tok::DictClose => {
                let v = match nested.pop() {
                    Some(Frame::Arr(a)) => Object::Array(a),
                    Some(Frame::Dict(d, _)) => Object::Dictionary(d),
                    None => continue,
                };
                if nested.is_empty() {
                    if let Some(k) = key.take() {
                        dict.set(k, v);
                    }
                } else {
                    push_value(&mut nested, &mut scratch, v);
                }
            }
            Tok::Kw(b"EI") => return None,
            other => {
                let Some(o) = tok_to_obj(other) else { continue };
                if !nested.is_empty() {
                    push_value(&mut nested, &mut scratch, o);
                } else if let Some(k) = key.take() {
                    dict.set(k, o);
                } else if let Object::Name(n) = o {
                    key = Some(n);
                }
            }
        }
        if nested.len() > MAX_NEST {
            return None;
        }
    }
    // Exactly one white-space byte separates ID from the data.
    let mut data_start = lx.pos;
    if lx.buf.get(data_start).copied().is_some_and(is_ws) {
        data_start += 1;
    }
    let declared = ["L", "Length"]
        .iter()
        .find_map(|k| dict.get(k.as_bytes()).ok().and_then(|o| o.as_i64().ok()))
        .and_then(|l| usize::try_from(l).ok());
    let data_end = match declared {
        Some(l) if data_start.checked_add(l).is_some_and(|e| e <= lx.buf.len()) => data_start + l,
        _ => {
            // Search "EI" preceded by white space and followed by white space or the end.
            let mut from = data_start;
            loop {
                let at = find(lx.buf, b"EI", from)?;
                let before = at.checked_sub(1).and_then(|i| lx.buf.get(i)).copied();
                let after = lx.buf.get(at + 2).copied();
                if before.is_some_and(is_ws) && after.is_none_or(is_ws) {
                    break at.saturating_sub(1).max(data_start);
                }
                from = at + 2;
            }
        }
    };
    // Continue after EI.
    let ei = find(lx.buf, b"EI", data_end)?;
    lx.pos = ei + 2;
    Some(InlineImage {
        dict,
        dict_range: (dict_start, dict_end),
        data: (data_start, data_end),
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    fn ops(s: &[u8]) -> Vec<(String, Vec<Object>)> {
        let mut out = Vec::new();
        let mut budget = 1000;
        parse(s, &mut budget, |op| {
            out.push((String::from_utf8_lossy(op.op).into_owned(), op.operands));
            true
        });
        out
    }

    #[test]
    fn operators_and_operands() {
        let v = ops(b"q 1 0 0 1 10 20 cm /F1 12 Tf [(a) -20 (b)] TJ /P <</MCID 3>> BDC EMC Q");
        let names: Vec<_> = v.iter().map(|(o, _)| o.as_str()).collect();
        assert_eq!(names, ["q", "cm", "Tf", "TJ", "BDC", "EMC", "Q"]);
        assert_eq!(v[1].1.len(), 6);
        assert_eq!(v[2].1[0], Object::Name(b"F1".to_vec()));
        assert!(matches!(&v[3].1[0], Object::Array(a) if a.len() == 3));
        assert!(matches!(&v[4].1[1], Object::Dictionary(d) if d.get(b"MCID").is_ok()));
    }

    #[test]
    fn inline_images_are_skipped_with_their_dict() {
        let s = b"q BI /W 2 /H 1 /CS /RGB /BPC 8 /I true ID \x00EI\xffEI\x01\x02 EI Q 0 g";
        let mut imgs = Vec::new();
        let mut names = Vec::new();
        let mut budget = 100;
        parse(s, &mut budget, |op| {
            names.push(String::from_utf8_lossy(op.op).into_owned());
            if let Some(i) = op.inline {
                imgs.push(i);
            }
            true
        });
        assert_eq!(names, ["q", "BI", "Q", "g"]);
        assert_eq!(imgs[0].dict.get(b"I").unwrap(), &Object::Boolean(true));
        assert_eq!(imgs[0].dict.get(b"W").unwrap(), &Object::Integer(2));
    }

    #[test]
    fn budget_and_garbage() {
        let mut budget = 2;
        let mut n = 0;
        assert!(!parse(b"q q q q", &mut budget, |_| {
            n += 1;
            true
        }));
        assert_eq!(n, 2);
        for s in [
            &b"BI /W 1 ID"[..],
            b"[[[[[[",
            b"<< /A [1 2 >> Tj",
            b"BI ID EI",
            b"]]>> Q",
        ] {
            let _ = ops(s);
        }
    }
}
