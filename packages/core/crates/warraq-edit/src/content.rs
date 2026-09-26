//! Byte-faithful content-stream lexer and rewriter.
//!
//! [`parse`] splits a content stream into operations whose byte spans, together with the gaps
//! between them (whitespace and comments), partition the input exactly: re-emitting every
//! span and gap reproduces the input byte for byte. [`rewrite`] replaces chosen operations
//! and leaves every other byte — number formats, whitespace, comments, junk — untouched, so an
//! edit changes only the edited operators.
//!
//! Hostile input: every loop advances or stops; operands per operation, nesting and the number of
//! operations are bounded; nothing panics.

use std::ops::Range;

use warraq_text::lexer::parse_number;

use crate::error::{EditError, Result};

/// Maximum operations kept per content stream.
pub const MAX_OPS: usize = 4_000_000;
/// Maximum operands kept per operation (the span still covers the extras).
pub const MAX_OPERANDS: usize = 4096;
/// Maximum array/dictionary nesting that is parsed into values.
pub const MAX_NESTING: usize = 32;
/// Maximum elements kept in one array/dictionary value.
pub const MAX_ELEMENTS: usize = 1_000_000;

/// A parsed operand value.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Num(f64),
    Name(Vec<u8>),
    /// Literal or hex string, decoded.
    Str(Vec<u8>),
    Array(Vec<Value>),
    Dict(Vec<(Vec<u8>, Value)>),
    Bool(bool),
    Null,
    /// A stray token (`)`, `}`, unknown keyword inside an array, …).
    Junk,
}

impl Value {
    pub fn num(&self) -> Option<f64> {
        match self {
            Value::Num(n) => Some(*n),
            _ => None,
        }
    }

    pub fn name(&self) -> Option<&[u8]> {
        match self {
            Value::Name(n) => Some(n),
            _ => None,
        }
    }

    /// Dictionary lookup.
    pub fn get(&self, key: &[u8]) -> Option<&Value> {
        match self {
            Value::Dict(d) => d.iter().find(|(k, _)| k.as_slice() == key).map(|(_, v)| v),
            _ => None,
        }
    }
}

/// An operand with its byte span.
#[derive(Debug, Clone, PartialEq)]
pub struct Operand {
    pub span: Range<usize>,
    pub value: Value,
}

/// One operation: operands followed by an operator.
#[derive(Debug, Clone, PartialEq)]
pub struct Op {
    /// From the first byte of the first operand (or junk token) to the end of the operator.
    pub span: Range<usize>,
    /// The operator keyword (`Tj`, `cm`, `BI` for a whole inline image, …).
    pub operator: Vec<u8>,
    pub operands: Vec<Operand>,
    /// Inline images (`BI … ID data EI`): the dictionary entries and the data range.
    pub inline: Option<InlineImage>,
}

/// An inline image.
#[derive(Debug, Clone, PartialEq)]
pub struct InlineImage {
    pub dict: Vec<(Vec<u8>, Value)>,
    pub data: Range<usize>,
}

impl Op {
    /// Numeric operands (non-numbers skipped).
    pub fn nums(&self) -> Vec<f64> {
        self.operands.iter().filter_map(|o| o.value.num()).collect()
    }

    pub fn is(&self, name: &[u8]) -> bool {
        self.operator == name
    }
}

/// Operations of a stream; spans are increasing and non-overlapping.
#[derive(Debug, Clone, Default)]
pub struct Content {
    pub ops: Vec<Op>,
    /// Bytes after the last operation that do not form one (operands without operator).
    pub trailing: Range<usize>,
}

fn is_ws(b: u8) -> bool {
    matches!(b, 0 | b'\t' | b'\n' | 0x0c | b'\r' | b' ')
}

fn is_delim(b: u8) -> bool {
    matches!(
        b,
        b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'/' | b'%'
    )
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Num(f64),
    Name(Vec<u8>),
    Str(Vec<u8>),
    ArrOpen,
    ArrClose,
    DictOpen,
    DictClose,
    Stray,
    Keyword(Range<usize>),
}

struct Lexer<'a> {
    d: &'a [u8],
    pos: usize,
}

impl<'a> Lexer<'a> {
    fn peek(&self) -> Option<u8> {
        self.d.get(self.pos).copied()
    }

    fn skip_gap(&mut self) {
        while let Some(b) = self.peek() {
            if is_ws(b) {
                self.pos += 1;
            } else if b == b'%' {
                while let Some(c) = self.peek() {
                    if c == b'\n' || c == b'\r' {
                        break;
                    }
                    self.pos += 1;
                }
            } else {
                break;
            }
        }
    }

    fn literal(&mut self) -> Vec<u8> {
        let mut out = Vec::new();
        let mut depth = 1usize;
        while let Some(b) = self.peek() {
            self.pos += 1;
            match b {
                b'(' => {
                    depth += 1;
                    out.push(b);
                }
                b')' => {
                    depth -= 1;
                    if depth == 0 {
                        return out;
                    }
                    out.push(b);
                }
                b'\\' => {
                    let Some(e) = self.peek() else { break };
                    self.pos += 1;
                    match e {
                        b'n' => out.push(b'\n'),
                        b'r' => out.push(b'\r'),
                        b't' => out.push(b'\t'),
                        b'b' => out.push(8),
                        b'f' => out.push(12),
                        b'\r' => {
                            if self.peek() == Some(b'\n') {
                                self.pos += 1;
                            }
                        }
                        b'\n' => {}
                        b'0'..=b'7' => {
                            let mut v = u32::from(e - b'0');
                            for _ in 0..2 {
                                match self.peek() {
                                    Some(c @ b'0'..=b'7') => {
                                        v = v * 8 + u32::from(c - b'0');
                                        self.pos += 1;
                                    }
                                    _ => break,
                                }
                            }
                            out.push((v & 0xff) as u8);
                        }
                        other => out.push(other),
                    }
                }
                _ => out.push(b),
            }
        }
        out
    }

    fn hex(&mut self) -> Vec<u8> {
        let mut out = Vec::new();
        let mut hi: Option<u8> = None;
        while let Some(b) = self.peek() {
            self.pos += 1;
            if b == b'>' {
                break;
            }
            if let Some(v) = hex_val(b) {
                match hi.take() {
                    Some(h) => out.push(h << 4 | v),
                    None => hi = Some(v),
                }
            }
        }
        if let Some(h) = hi {
            out.push(h << 4);
        }
        out
    }

    fn name(&mut self) -> Vec<u8> {
        let mut out = Vec::new();
        while let Some(b) = self.peek() {
            if is_ws(b) || is_delim(b) {
                break;
            }
            self.pos += 1;
            if b == b'#' {
                let h1 = self.d.get(self.pos).copied().and_then(hex_val);
                let h2 = self.d.get(self.pos + 1).copied().and_then(hex_val);
                if let (Some(a), Some(c)) = (h1, h2) {
                    out.push(a << 4 | c);
                    self.pos += 2;
                    continue;
                }
            }
            out.push(b);
        }
        out
    }

    /// Next token and its span; `None` at the end. Call `skip_gap` first.
    fn token(&mut self) -> Option<(Tok, Range<usize>)> {
        let start = self.pos;
        let b = self.peek()?;
        self.pos += 1;
        let t = match b {
            b'(' => Tok::Str(self.literal()),
            b'<' => {
                if self.peek() == Some(b'<') {
                    self.pos += 1;
                    Tok::DictOpen
                } else {
                    Tok::Str(self.hex())
                }
            }
            b'>' => {
                if self.peek() == Some(b'>') {
                    self.pos += 1;
                    Tok::DictClose
                } else {
                    Tok::Stray
                }
            }
            b'[' => Tok::ArrOpen,
            b']' => Tok::ArrClose,
            b'{' | b'}' | b')' => Tok::Stray,
            b'/' => Tok::Name(self.name()),
            _ => {
                while let Some(c) = self.peek() {
                    if is_ws(c) || is_delim(c) {
                        break;
                    }
                    self.pos += 1;
                }
                let word = self.d.get(start..self.pos).unwrap_or(&[]);
                match parse_number(word) {
                    Some(n) if !word.iter().any(|c| c.is_ascii_alphabetic()) => Tok::Num(n),
                    _ => Tok::Keyword(start..self.pos),
                }
            }
        };
        Some((t, start..self.pos))
    }

    fn keyword(&self, r: &Range<usize>) -> &'a [u8] {
        self.d.get(r.clone()).unwrap_or(&[])
    }

    /// Parse a value starting with `tok`; nested arrays/dicts consume their tokens.
    fn value(&mut self, tok: Tok, span: Range<usize>, depth: usize) -> Operand {
        if depth >= MAX_NESTING && matches!(tok, Tok::ArrOpen | Tok::DictOpen) {
            // Too deep: consume the nested structure iteratively (no recursion).
            let mut level = 1usize;
            loop {
                self.skip_gap();
                let Some((t, _)) = self.token() else { break };
                match t {
                    Tok::ArrOpen | Tok::DictOpen => level += 1,
                    Tok::ArrClose | Tok::DictClose => {
                        level -= 1;
                        if level == 0 {
                            break;
                        }
                    }
                    _ => {}
                }
            }
            return Operand {
                span: span.start..self.pos,
                value: Value::Junk,
            };
        }
        let value = match tok {
            Tok::Num(n) => Value::Num(n),
            Tok::Name(n) => Value::Name(n),
            Tok::Str(s) => Value::Str(s),
            Tok::ArrOpen => Value::Array(self.array(depth + 1)),
            Tok::DictOpen => Value::Dict(self.dict(depth + 1)),
            Tok::Keyword(r) => match self.keyword(&r) {
                b"true" => Value::Bool(true),
                b"false" => Value::Bool(false),
                b"null" => Value::Null,
                _ => Value::Junk,
            },
            _ => Value::Junk,
        };
        Operand {
            span: span.start..self.pos,
            value,
        }
    }

    fn array(&mut self, depth: usize) -> Vec<Value> {
        let mut out = Vec::new();
        loop {
            self.skip_gap();
            let Some((tok, span)) = self.token() else {
                break;
            };
            if tok == Tok::ArrClose {
                break;
            }
            let v = self.value(tok, span, depth);
            if depth <= MAX_NESTING && out.len() < MAX_ELEMENTS {
                out.push(v.value);
            }
        }
        out
    }

    fn dict(&mut self, depth: usize) -> Vec<(Vec<u8>, Value)> {
        let mut out = Vec::new();
        let mut key: Option<Vec<u8>> = None;
        loop {
            self.skip_gap();
            let Some((tok, span)) = self.token() else {
                break;
            };
            if tok == Tok::DictClose {
                break;
            }
            match key.take() {
                None => {
                    if let Tok::Name(n) = tok {
                        key = Some(n);
                    } else {
                        // Consume a nested value that is not a key.
                        let _ = self.value(tok, span, depth);
                    }
                }
                Some(k) => {
                    let v = self.value(tok, span, depth);
                    if depth <= MAX_NESTING && out.len() < MAX_ELEMENTS {
                        out.push((k, v.value));
                    }
                }
            }
        }
        out
    }

    /// After `ID`: skip one whitespace byte, find `EI` delimited by whitespace. Returns the data range.
    fn inline_data(&mut self) -> Range<usize> {
        if self.peek().is_some_and(is_ws) {
            self.pos += 1;
        }
        let start = self.pos;
        let d = self.d;
        let mut i = self.pos;
        while i + 1 < d.len() {
            if d.get(i) == Some(&b'E') && d.get(i + 1) == Some(&b'I') {
                let before = i == 0 || d.get(i - 1).is_some_and(|&b| is_ws(b));
                let after = d.get(i + 2).is_none_or(|&b| is_ws(b) || is_delim(b));
                if before && after {
                    self.pos = i + 2;
                    let end = if i > start { i - 1 } else { start };
                    return start..end.max(start);
                }
            }
            i += 1;
        }
        self.pos = d.len();
        start..d.len()
    }
}

/// Split `data` into operations. Spans and gaps partition the input exactly.
pub fn parse(data: &[u8]) -> Result<Content> {
    let mut lx = Lexer { d: data, pos: 0 };
    let mut ops = Vec::new();
    let mut operands: Vec<Operand> = Vec::new();
    let mut start: Option<usize> = None;
    loop {
        lx.skip_gap();
        let Some((tok, span)) = lx.token() else {
            break;
        };
        let op_start = *start.get_or_insert(span.start);
        if let Tok::Keyword(r) = &tok {
            let kw = lx.keyword(r);
            if !matches!(kw, b"true" | b"false" | b"null") {
                if ops.len() >= MAX_OPS {
                    return Err(EditError::Limit("operators per content stream".into()));
                }
                let operator = kw.to_vec();
                let mut inline = None;
                if kw == b"BI" {
                    // Dictionary up to ID, then raw data up to EI.
                    let mut dict = Vec::new();
                    let mut key: Option<Vec<u8>> = None;
                    loop {
                        lx.skip_gap();
                        let Some((t, s)) = lx.token() else { break };
                        if let Tok::Keyword(kr) = &t {
                            if lx.keyword(kr) == b"ID" {
                                let data = lx.inline_data();
                                inline = Some(InlineImage {
                                    dict: std::mem::take(&mut dict),
                                    data,
                                });
                                break;
                            }
                        }
                        match key.take() {
                            None => {
                                if let Tok::Name(n) = t {
                                    key = Some(n);
                                }
                            }
                            Some(k) => {
                                let v = lx.value(t, s, 0);
                                if dict.len() < 256 {
                                    dict.push((k, v.value));
                                }
                            }
                        }
                    }
                    if inline.is_none() {
                        inline = Some(InlineImage {
                            dict,
                            data: lx.pos..lx.pos,
                        });
                    }
                }
                ops.push(Op {
                    span: op_start..lx.pos,
                    operator,
                    operands: std::mem::take(&mut operands),
                    inline,
                });
                start = None;
                continue;
            }
        }
        let v = lx.value(tok, span, 0);
        if operands.len() < MAX_OPERANDS {
            operands.push(v);
        }
    }
    let trailing = match start {
        Some(s) => s..data.len(),
        None => data.len()..data.len(),
    };
    Ok(Content { ops, trailing })
}

/// A replacement of the bytes of one or more consecutive operations.
#[derive(Debug, Clone, PartialEq)]
pub struct Splice {
    pub range: Range<usize>,
    pub with: Vec<u8>,
}

/// Apply non-overlapping splices (any order) to `data`. Overlapping splices are an error.
pub fn rewrite(data: &[u8], splices: &[Splice]) -> Result<Vec<u8>> {
    let mut sorted: Vec<&Splice> = splices.iter().collect();
    sorted.sort_by_key(|s| (s.range.start, s.range.end));
    let mut out = Vec::with_capacity(data.len());
    let mut pos = 0usize;
    for s in sorted {
        if s.range.start < pos || s.range.end < s.range.start || s.range.end > data.len() {
            return Err(EditError::Params(
                "overlapping or out-of-range content edit".into(),
            ));
        }
        out.extend_from_slice(data.get(pos..s.range.start).unwrap_or(&[]));
        out.extend_from_slice(&s.with);
        pos = s.range.end;
    }
    out.extend_from_slice(data.get(pos..).unwrap_or(&[]));
    Ok(out)
}

/// Re-emit the content from its operations and gaps (identity; used to prove the partition).
pub fn reemit(data: &[u8], c: &Content) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    let mut pos = 0usize;
    for op in &c.ops {
        out.extend_from_slice(data.get(pos..op.span.start).unwrap_or(&[]));
        out.extend_from_slice(data.get(op.span.clone()).unwrap_or(&[]));
        pos = op.span.end;
    }
    out.extend_from_slice(data.get(pos..).unwrap_or(&[]));
    out
}

/// Check the partition invariant: spans increasing, in bounds, and every gap is only
/// whitespace/comments. Returns false on violation (tests and fuzzing).
pub fn partition_ok(data: &[u8], c: &Content) -> bool {
    let mut pos = 0usize;
    for op in &c.ops {
        if op.span.start < pos || op.span.end < op.span.start || op.span.end > data.len() {
            return false;
        }
        if !gap_ok(data.get(pos..op.span.start).unwrap_or(&[])) {
            return false;
        }
        pos = op.span.end;
    }
    let tail_end = if c.trailing.is_empty() {
        data.len()
    } else {
        c.trailing.start
    };
    tail_end >= pos && gap_ok(data.get(pos..tail_end).unwrap_or(&[]))
}

fn gap_ok(g: &[u8]) -> bool {
    let mut in_comment = false;
    for &b in g {
        if in_comment {
            if b == b'\n' || b == b'\r' {
                in_comment = false;
            }
        } else if b == b'%' {
            in_comment = true;
        } else if !is_ws(b) {
            return false;
        }
    }
    true
}

/// Format a number for writing into content streams (≤ 4 decimals, no exponent).
pub fn fmt_num(v: f64) -> String {
    if !v.is_finite() {
        return "0".into();
    }
    let r = (v * 10_000.0).round() / 10_000.0;
    if r == r.trunc() && r.abs() < 1e15 {
        format!("{}", r as i64)
    } else {
        let s = format!("{r:.4}");
        let s = s.trim_end_matches('0').trim_end_matches('.');
        if s == "-0" {
            "0".into()
        } else {
            s.to_string()
        }
    }
}

/// Write a PDF name (`/Name`) with `#xx` escapes.
pub fn fmt_name(n: &[u8]) -> String {
    let mut s = String::from("/");
    for &b in n {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'+') {
            s.push(char::from(b));
        } else {
            s.push_str(&format!("#{b:02X}"));
        }
    }
    s
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing, clippy::panic)]
mod tests {
    use super::*;

    fn names(c: &Content) -> Vec<String> {
        c.ops
            .iter()
            .map(|o| String::from_utf8_lossy(&o.operator).into_owned())
            .collect()
    }

    #[test]
    fn partition_and_identity_round_trip() {
        let src = b"  % comment\r\n1 0 0 1 72.50 700. cm q BT /F1 12 Tf [(A\\)b) -120.0 <0041 42>] TJ ET\n%x\nQ /Im1 Do  ";
        let c = parse(src).unwrap();
        assert_eq!(names(&c), ["cm", "q", "BT", "Tf", "TJ", "ET", "Q", "Do"]);
        assert!(partition_ok(src, &c));
        assert_eq!(reemit(src, &c), src.to_vec());
        assert_eq!(rewrite(src, &[]).unwrap(), src.to_vec());
        assert_eq!(c.ops[0].nums(), vec![1.0, 0.0, 0.0, 1.0, 72.5, 700.0]);
        // Operand spans keep the original number format.
        assert_eq!(&src[c.ops[0].operands[4].span.clone()], b"72.50");
    }

    #[test]
    fn rewrite_changes_only_the_edited_operator() {
        let src = b"BT /F1 12 Tf 10 20 Td (keep) Tj  (drop)  Tj ET";
        let c = parse(src).unwrap();
        let drop = &c.ops[4];
        assert_eq!(drop.operator, b"Tj");
        let out = rewrite(
            src,
            &[Splice {
                range: drop.span.clone(),
                with: b"[-500] TJ".to_vec(),
            }],
        )
        .unwrap();
        assert_eq!(
            out,
            b"BT /F1 12 Tf 10 20 Td (keep) Tj  [-500] TJ ET".to_vec()
        );
    }

    #[test]
    fn inline_images_are_one_operation() {
        let src = b"q 10 0 0 10 0 0 cm BI /W 2 /H 1 /BPC 8 /CS /G ID \x00EI\xff EI Q";
        let c = parse(src).unwrap();
        assert_eq!(names(&c), ["q", "cm", "BI", "Q"]);
        let bi = &c.ops[2];
        let inl = bi.inline.as_ref().unwrap();
        assert_eq!(&src[inl.data.clone()], b"\x00EI\xff");
        assert_eq!(inl.dict.len(), 4);
        assert!(partition_ok(src, &c));
        assert_eq!(reemit(src, &c), src.to_vec());
    }

    #[test]
    fn dicts_arrays_and_marked_content() {
        let src = b"/Span <</ActualText <FEFF0644> /MCID 3>> BDC EMC";
        let c = parse(src).unwrap();
        assert_eq!(names(&c), ["BDC", "EMC"]);
        let d = &c.ops[0].operands[1].value;
        assert_eq!(d.get(b"MCID"), Some(&Value::Num(3.0)));
        assert_eq!(
            d.get(b"ActualText"),
            Some(&Value::Str(vec![0xfe, 0xff, 6, 0x44]))
        );
    }

    #[test]
    fn hostile_input_is_bounded() {
        for src in [
            b"[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[1 Tj".to_vec(),
            b"(unterminated \\".to_vec(),
            b"<abc".to_vec(),
            b"<<<<>> >> ) } { BI /W".to_vec(),
            b"1 2 3".to_vec(),
            vec![b'['; 100_000],
            b"BI ID".to_vec(),
        ] {
            let c = parse(&src).unwrap();
            assert!(
                partition_ok(&src, &c),
                "{:?}",
                String::from_utf8_lossy(&src)
            );
            assert_eq!(reemit(&src, &c), src);
        }
    }

    #[test]
    fn overlapping_splices_are_refused() {
        let s = [
            Splice {
                range: 0..4,
                with: vec![],
            },
            Splice {
                range: 2..6,
                with: vec![],
            },
        ];
        assert!(rewrite(b"0123456789", &s).is_err());
    }

    #[test]
    fn number_formatting() {
        assert_eq!(fmt_num(1.0), "1");
        assert_eq!(fmt_num(-0.00001), "0");
        assert_eq!(fmt_num(12.345678), "12.3457");
        assert_eq!(fmt_num(f64::NAN), "0");
        assert_eq!(fmt_name(b"ZE 1"), "/ZE#201");
    }
}
