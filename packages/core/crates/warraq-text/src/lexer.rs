//! Byte-level lexer for PDF content streams and PostScript-like CMaps.
//!
//! Hostile input: every loop advances `pos` or terminates, nesting is bounded by
//! [`limits::MAX_NESTING`], operand stacks by [`limits::MAX_OPERANDS`].

use crate::limits;

/// A lexical token.
#[derive(Debug, Clone, PartialEq)]
pub enum Token<'a> {
    Num(f64),
    Name(Vec<u8>),
    /// Literal `( … )` string, escapes resolved.
    Str(Vec<u8>),
    /// Hex `< … >` string as bytes (odd digit count padded with 0).
    Hex(Vec<u8>),
    ArrOpen,
    ArrClose,
    DictOpen,
    DictClose,
    ProcOpen,
    ProcClose,
    /// Any other regular-character run (operators, `true`, `begincmap`, …).
    Keyword(&'a [u8]),
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

/// Parse a PDF number leniently (`-.5`, `4.`, `+3`, `--2` → best effort). `None` if not numeric.
pub fn parse_number(s: &[u8]) -> Option<f64> {
    let mut i = 0;
    let mut neg = false;
    while let Some(&c) = s.get(i) {
        if c == b'-' {
            neg = !neg;
        } else if c != b'+' {
            break;
        }
        i += 1;
    }
    let rest = s.get(i..)?;
    if rest.is_empty() {
        return if i > 0 { Some(0.0) } else { None };
    }
    let mut int: f64 = 0.0;
    let mut frac: f64 = 0.0;
    let mut scale = 1.0;
    let mut seen_dot = false;
    let mut digits = 0usize;
    for &c in rest {
        match c {
            b'0'..=b'9' => {
                digits += 1;
                let d = f64::from(c - b'0');
                if seen_dot {
                    scale /= 10.0;
                    frac += d * scale;
                } else {
                    int = int * 10.0 + d;
                }
            }
            b'.' if !seen_dot => seen_dot = true,
            _ => {
                // Trailing garbage: only accept if we already have digits (e.g. "1.2.3").
                if digits == 0 {
                    return None;
                }
                break;
            }
        }
    }
    if digits == 0 && !seen_dot {
        return None;
    }
    let v = int + frac;
    let v = if neg { -v } else { v };
    if v.is_finite() {
        Some(v)
    } else {
        Some(0.0)
    }
}

/// Streaming tokenizer.
pub struct Lexer<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Lexer<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Lexer { data, pos: 0 }
    }

    pub fn pos(&self) -> usize {
        self.pos
    }

    pub fn at_end(&self) -> bool {
        self.pos >= self.data.len()
    }

    fn peek(&self) -> Option<u8> {
        self.data.get(self.pos).copied()
    }

    /// Skip whitespace and comments (the next token starts at [`Lexer::pos`]).
    pub fn skip_ws_and_comments(&mut self) {
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

    /// Skip raw bytes (used after `ID` of inline images): moves past the next
    /// whitespace-delimited `EI` token.
    pub fn skip_inline_image_data(&mut self) {
        // One whitespace byte follows ID.
        if self.peek().is_some_and(is_ws) {
            self.pos += 1;
        }
        let d = self.data;
        let mut i = self.pos;
        while i + 1 < d.len() {
            let is_ei = d.get(i) == Some(&b'E') && d.get(i + 1) == Some(&b'I');
            if is_ei {
                let before_ok = i == 0 || d.get(i - 1).is_some_and(|&b| is_ws(b));
                let after_ok = d.get(i + 2).is_none_or(|&b| is_ws(b) || is_delim(b));
                if before_ok && after_ok {
                    self.pos = i + 2;
                    return;
                }
            }
            i += 1;
        }
        self.pos = d.len();
    }

    fn read_literal(&mut self) -> Vec<u8> {
        // Opening '(' already consumed.
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
                            let mut v: u32 = u32::from(e - b'0');
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

    fn read_hex(&mut self) -> Vec<u8> {
        // Opening '<' already consumed.
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

    fn read_name(&mut self) -> Vec<u8> {
        // '/' already consumed.
        let mut out = Vec::new();
        while let Some(b) = self.peek() {
            if is_ws(b) || is_delim(b) {
                break;
            }
            self.pos += 1;
            if b == b'#' {
                let h1 = self.data.get(self.pos).copied().and_then(hex_val);
                let h2 = self.data.get(self.pos + 1).copied().and_then(hex_val);
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

    /// Next token, or `None` at end of input.
    pub fn next_token(&mut self) -> Option<Token<'a>> {
        self.skip_ws_and_comments();
        let b = self.peek()?;
        self.pos += 1;
        Some(match b {
            b'(' => Token::Str(self.read_literal()),
            b'<' => {
                if self.peek() == Some(b'<') {
                    self.pos += 1;
                    Token::DictOpen
                } else {
                    Token::Hex(self.read_hex())
                }
            }
            b'>' => {
                if self.peek() == Some(b'>') {
                    self.pos += 1;
                }
                Token::DictClose
            }
            b'[' => Token::ArrOpen,
            b']' => Token::ArrClose,
            b'{' => Token::ProcOpen,
            b'}' => Token::ProcClose,
            b')' => Token::Keyword(b")"),
            b'/' => Token::Name(self.read_name()),
            _ => {
                let start = self.pos - 1;
                while let Some(c) = self.peek() {
                    if is_ws(c) || is_delim(c) {
                        break;
                    }
                    self.pos += 1;
                }
                let word = self.data.get(start..self.pos).unwrap_or(&[]);
                match parse_number(word) {
                    Some(n) => Token::Num(n),
                    None => Token::Keyword(word),
                }
            }
        })
    }
}

/// A content-stream operand.
#[derive(Debug, Clone, PartialEq)]
pub enum Operand {
    Num(f64),
    Name(Vec<u8>),
    Str(Vec<u8>),
    Array(Vec<Operand>),
    Dict(Vec<(Vec<u8>, Operand)>),
    Bool(bool),
    Null,
}

impl Operand {
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Operand::Num(n) => Some(*n),
            _ => None,
        }
    }

    pub fn as_name(&self) -> Option<&[u8]> {
        match self {
            Operand::Name(n) => Some(n),
            _ => None,
        }
    }

    /// Look a key up in a dictionary operand.
    pub fn dict_get(&self, key: &[u8]) -> Option<&Operand> {
        match self {
            Operand::Dict(entries) => entries
                .iter()
                .find(|(k, _)| k.as_slice() == key)
                .map(|(_, v)| v),
            _ => None,
        }
    }
}

/// A content-stream operation: operator plus its operands.
#[derive(Debug, Clone, PartialEq)]
pub struct Op {
    pub operator: Vec<u8>,
    pub operands: Vec<Operand>,
}

/// Iterator over the operations of a content stream.
pub struct ContentParser<'a> {
    lex: Lexer<'a>,
}

impl<'a> ContentParser<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        ContentParser {
            lex: Lexer::new(data),
        }
    }

    /// Next operation plus the byte range it occupies in the input (operands through operator;
    /// for inline images `BI … EI`). Bytes between spans are whitespace and comments only, so a
    /// rewriter can copy untouched operations verbatim.
    pub fn next_spanned(&mut self) -> Option<(Op, std::ops::Range<usize>)> {
        self.lex.skip_ws_and_comments();
        let start = self.lex.pos();
        let op = self.next()?;
        Some((op, start..self.lex.pos()))
    }

    fn operand_from(&mut self, tok: Token<'a>, depth: usize) -> Option<Operand> {
        Some(match tok {
            Token::Num(n) => Operand::Num(n),
            Token::Name(n) => Operand::Name(n),
            Token::Str(s) | Token::Hex(s) => Operand::Str(s),
            Token::ArrOpen => Operand::Array(self.read_array(depth + 1)),
            Token::DictOpen => Operand::Dict(self.read_dict(depth + 1)),
            Token::Keyword(b"true") => Operand::Bool(true),
            Token::Keyword(b"false") => Operand::Bool(false),
            Token::Keyword(b"null") => Operand::Null,
            _ => return None,
        })
    }

    fn read_array(&mut self, depth: usize) -> Vec<Operand> {
        let mut out = Vec::new();
        while let Some(tok) = self.lex.next_token() {
            if tok == Token::ArrClose {
                break;
            }
            if depth > limits::MAX_NESTING {
                // Too deep: consume but keep nothing.
                if matches!(tok, Token::ArrOpen | Token::DictOpen) {
                    continue;
                }
                continue;
            }
            if let Some(op) = self.operand_from(tok, depth) {
                if out.len() < limits::MAX_ARRAY_LEN {
                    out.push(op);
                }
            }
        }
        out
    }

    fn read_dict(&mut self, depth: usize) -> Vec<(Vec<u8>, Operand)> {
        let mut out = Vec::new();
        let mut key: Option<Vec<u8>> = None;
        while let Some(tok) = self.lex.next_token() {
            if tok == Token::DictClose {
                break;
            }
            if depth > limits::MAX_NESTING {
                continue;
            }
            match key.take() {
                None => {
                    if let Token::Name(n) = tok {
                        key = Some(n);
                    }
                }
                Some(k) => {
                    let v = self.operand_from(tok, depth).unwrap_or(Operand::Null);
                    if out.len() < limits::MAX_ARRAY_LEN {
                        out.push((k, v));
                    }
                }
            }
        }
        out
    }
}

impl Iterator for ContentParser<'_> {
    type Item = Op;

    fn next(&mut self) -> Option<Op> {
        let mut operands = Vec::new();
        loop {
            let tok = self.lex.next_token()?;
            match tok {
                Token::Keyword(k) if !matches!(k, b"true" | b"false" | b"null") => {
                    if k == b"BI" {
                        // Inline image: skip the dictionary and the binary data.
                        loop {
                            match self.lex.next_token() {
                                None => return None,
                                Some(Token::Keyword(b"ID")) => break,
                                Some(_) => {}
                            }
                        }
                        self.lex.skip_inline_image_data();
                        return Some(Op {
                            operator: b"BI".to_vec(),
                            operands: Vec::new(),
                        });
                    }
                    return Some(Op {
                        operator: k.to_vec(),
                        operands,
                    });
                }
                Token::ArrClose | Token::DictClose | Token::ProcOpen | Token::ProcClose => {}
                other => {
                    if let Some(op) = self.operand_from(other, 0) {
                        if operands.len() < limits::MAX_OPERANDS {
                            operands.push(op);
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing, clippy::panic)]
mod tests {
    use super::*;

    fn ops(s: &str) -> Vec<Op> {
        ContentParser::new(s.as_bytes()).collect()
    }

    #[test]
    fn numbers_are_lenient() {
        assert_eq!(parse_number(b"-.5"), Some(-0.5));
        assert_eq!(parse_number(b"4."), Some(4.0));
        assert_eq!(parse_number(b"+3"), Some(3.0));
        assert_eq!(parse_number(b"--2"), Some(2.0));
        assert_eq!(parse_number(b"1.2.3"), Some(1.2));
        assert_eq!(parse_number(b"Tj"), None);
    }

    #[test]
    fn parses_text_ops() {
        let o =
            ops("BT /F1 12 Tf 1 0 0 1 72 700 Tm (Hello \\(x\\) \\101) Tj [(A) -120 <0041>] TJ ET");
        let names: Vec<_> = o
            .iter()
            .map(|o| String::from_utf8_lossy(&o.operator).to_string())
            .collect();
        assert_eq!(names, ["BT", "Tf", "Tm", "Tj", "TJ", "ET"]);
        assert_eq!(o[3].operands[0], Operand::Str(b"Hello (x) A".to_vec()));
        match &o[4].operands[0] {
            Operand::Array(a) => {
                assert_eq!(a.len(), 3);
                assert_eq!(a[2], Operand::Str(vec![0, 0x41]));
            }
            _ => panic!("not array"),
        }
    }

    #[test]
    fn parses_bdc_dict_and_names_with_escapes() {
        let o = ops("/Span <</ActualText <FEFF0644> /Lang (ar)>> BDC /A#20B BMC EMC");
        assert_eq!(o[0].operator, b"BDC");
        let d = &o[0].operands[1];
        assert_eq!(
            d.dict_get(b"ActualText"),
            Some(&Operand::Str(vec![0xfe, 0xff, 0x06, 0x44]))
        );
        assert_eq!(d.dict_get(b"Lang"), Some(&Operand::Str(b"ar".to_vec())));
        assert_eq!(o[1].operands[0], Operand::Name(b"A B".to_vec()));
    }

    #[test]
    fn skips_inline_images() {
        let o = ops("BI /W 2 /H 2 /BPC 8 ID \x00EI\x01\x02 EI Q");
        assert_eq!(o.len(), 2);
        assert_eq!(o[1].operator, b"Q");
    }

    #[test]
    fn spans_are_byte_faithful() {
        let src =
            b"q  % comment\n1 0 0 1 5 5 cm BT [(A) -12 <0041>] TJ ET BI /W 1 /H 1 ID \x00 EI Q";
        let mut p = ContentParser::new(src);
        let mut got = Vec::new();
        while let Some((op, span)) = p.next_spanned() {
            got.push((op.operator.clone(), src[span].to_vec()));
        }
        let ops: Vec<&[u8]> = got.iter().map(|(_, s)| s.as_slice()).collect();
        assert_eq!(
            ops,
            [
                &b"q"[..],
                b"1 0 0 1 5 5 cm",
                b"BT",
                b"[(A) -12 <0041>] TJ",
                b"ET",
                b"BI /W 1 /H 1 ID \x00 EI",
                b"Q"
            ]
        );
    }

    #[test]
    fn hostile_nesting_and_unterminated() {
        let deep = "[".repeat(10_000) + "1 Tj";
        let _ = ops(&deep);
        let _ = ops("(unterminated \\");
        let _ = ops("<abc");
        let _ = ops("<<<<>>");
    }
}
