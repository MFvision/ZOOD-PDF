//! A content-stream lexer that remembers where each operation is.
//!
//! `lopdf` decodes a content stream into operations and encodes them back,
//! but the round trip is not faithful: an inline image it cannot read is
//! dropped, and one it can is written back as a stream object, which is not
//! content syntax. An edit that rewrites a whole stream through it can lose
//! a picture elsewhere on the page. So the editors that change one operation
//! — move an image, delete it, take a page mark out — find it here, with its
//! byte range, and splice new bytes into the stream in its place. Every other
//! byte of the stream stays as the file had it.
//!
//! The lexer never panics, and every range it gives lies inside the stream,
//! runs forwards, and starts where the operation before it ended or later:
//! what it cannot read it skips a byte at a time. Content streams come from
//! hostile files, so it is bounded too — nesting, operands per operation,
//! and, in `lex`, which keeps what it reads, the operations and operands
//! kept from one stream. `ops` reads one operation at a time and keeps
//! nothing.
use crate::{Error, Result};

/// Nested arrays and dictionaries deeper than this are skipped, not followed.
const MAX_NESTING: usize = 64;
/// Operands kept per operation; a real operator takes at most a handful.
const MAX_OPERANDS: usize = 64;
/// Operations and operands `lex` keeps from one stream (some 100 MB at
/// most): a stream that needs more is refused rather than read.
pub(crate) const MAX_TOKENS: usize = 1 << 21;

/// One operand, as far as the editors need to know it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Operand {
    Number(f32),
    Name(Vec<u8>),
    /// A string, array, dictionary or keyword: its bytes are in `range`.
    Other,
}

/// An operator's name, kept in place: every real one is one to three
/// bytes. A longer word is kept as nothing, so it matches no operator.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) struct Operator {
    bytes: [u8; 3],
    len: u8,
}

impl Operator {
    fn new(run: &[u8]) -> Self {
        let mut bytes = [0; 3];
        if run.len() > bytes.len() {
            return Self { bytes, len: 0 };
        }
        bytes[..run.len()].copy_from_slice(run);
        Self {
            bytes,
            len: run.len() as u8,
        }
    }

    pub fn as_slice(&self) -> &[u8] {
        &self.bytes[..self.len as usize]
    }
}

impl std::fmt::Debug for Operator {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", String::from_utf8_lossy(self.as_slice()))
    }
}

/// One operation and the bytes it spans, its operands included.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Op {
    pub operator: Operator,
    pub operands: Vec<(Operand, std::ops::Range<usize>)>,
    /// From the first operand (or the operator) to the end of the operator —
    /// for an inline image, from `BI` to the end of `EI`.
    pub range: std::ops::Range<usize>,
}

impl Op {
    pub fn is(&self, operator: &str) -> bool {
        self.operator.as_slice() == operator.as_bytes()
    }

    pub fn number(&self, k: usize) -> Option<f32> {
        match self.operands.get(k)? {
            (Operand::Number(n), _) => Some(*n),
            _ => None,
        }
    }

    pub fn name(&self, k: usize) -> Option<&[u8]> {
        match self.operands.get(k)? {
            (Operand::Name(n), _) => Some(n),
            _ => None,
        }
    }

    /// The six numbers of a `cm`, or `None` if they are not six numbers.
    pub fn matrix(&self) -> Option<[f32; 6]> {
        if self.operands.len() != 6 {
            return None;
        }
        let mut m = [0.0; 6];
        for (k, v) in m.iter_mut().enumerate() {
            *v = self.number(k).filter(|n| n.is_finite())?;
        }
        Some(m)
    }
}

fn is_space(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\r' | b'\n' | b'\x0c' | b'\0')
}

fn is_delimiter(b: u8) -> bool {
    matches!(
        b,
        b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'/' | b'%'
    )
}

fn is_regular(b: u8) -> bool {
    !is_space(b) && !is_delimiter(b)
}

struct Lexer<'a> {
    s: &'a [u8],
    i: usize,
}

impl<'a> Lexer<'a> {
    fn skip_space(&mut self) {
        while self.i < self.s.len() {
            let b = self.s[self.i];
            if is_space(b) {
                self.i += 1;
            } else if b == b'%' {
                while self.i < self.s.len() && !matches!(self.s[self.i], b'\r' | b'\n') {
                    self.i += 1;
                }
            } else {
                break;
            }
        }
    }

    fn regular_run(&mut self) -> &'a [u8] {
        let start = self.i;
        while self.i < self.s.len() && is_regular(self.s[self.i]) {
            self.i += 1;
        }
        &self.s[start..self.i]
    }

    /// `( … )` with balanced parentheses and backslash escapes. A string the
    /// stream ends inside ends with the stream — an escape in its last byte
    /// too, which would otherwise step one past the end.
    fn literal_string(&mut self) {
        let mut depth = 0usize;
        while self.i < self.s.len() {
            match self.s[self.i] {
                b'\\' => self.i += 1,
                b'(' => depth += 1,
                b')' => {
                    depth = depth.saturating_sub(1);
                    if depth == 0 {
                        self.i += 1;
                        return;
                    }
                }
                _ => {}
            }
            self.i += 1;
        }
        self.i = self.i.min(self.s.len());
    }

    fn hex_string(&mut self) {
        while self.i < self.s.len() && self.s[self.i] != b'>' {
            self.i += 1;
        }
        self.i = (self.i + 1).min(self.s.len());
    }

    fn name(&mut self) -> Vec<u8> {
        self.i += 1;
        let raw = self.regular_run();
        let mut out = Vec::with_capacity(raw.len());
        let mut k = 0;
        while k < raw.len() {
            if raw[k] == b'#' && k + 2 < raw.len() {
                let hex = std::str::from_utf8(&raw[k + 1..k + 3]).ok();
                if let Some(v) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                    out.push(v);
                    k += 3;
                    continue;
                }
            }
            out.push(raw[k]);
            k += 1;
        }
        out
    }

    /// One operand or operator. `None` at the end of the stream.
    fn token(&mut self, depth: usize) -> Option<Token> {
        self.skip_space();
        let b = *self.s.get(self.i)?;
        let kind = match b {
            b'/' => Token::Operand(Operand::Name(self.name())),
            b'(' => {
                self.literal_string();
                Token::Operand(Operand::Other)
            }
            b'<' if self.s.get(self.i + 1) == Some(&b'<') => {
                self.i += 2;
                self.nested(b">>", depth);
                Token::Operand(Operand::Other)
            }
            b'<' => {
                self.hex_string();
                Token::Operand(Operand::Other)
            }
            b'[' => {
                self.i += 1;
                self.nested(b"]", depth);
                Token::Operand(Operand::Other)
            }
            // Stray closers and braces: skipped, a byte at a time.
            b']' | b'>' | b')' | b'{' | b'}' => {
                self.i += 1;
                Token::Junk
            }
            _ => {
                let run = self.regular_run();
                if run.is_empty() {
                    self.i += 1;
                    Token::Junk
                } else if let Some(n) = number(run) {
                    Token::Operand(Operand::Number(n))
                } else if matches!(run, b"true" | b"false" | b"null") {
                    Token::Operand(Operand::Other)
                } else {
                    Token::Operator(Operator::new(run))
                }
            }
        };
        Some(kind)
    }

    /// Skips the inside of an array or dictionary up to its `close`.
    fn nested(&mut self, close: &[u8], depth: usize) {
        if depth >= MAX_NESTING {
            // Too deep to follow: take everything to the closer on trust.
            while self.i < self.s.len() && !self.s[self.i..].starts_with(close) {
                self.i += 1;
            }
            self.i = (self.i + close.len()).min(self.s.len());
            return;
        }
        loop {
            self.skip_space();
            if self.i >= self.s.len() {
                return;
            }
            if self.s[self.i..].starts_with(close) {
                self.i += close.len();
                return;
            }
            let before = self.i;
            if self.token(depth + 1).is_none() {
                return;
            }
            if self.i == before {
                self.i += 1;
            }
        }
    }

    /// After `BI`: the image's dictionary up to `ID`, its data, and `EI`.
    fn inline_image(&mut self) -> Vec<(Operand, std::ops::Range<usize>)> {
        let mut operands = Vec::new();
        loop {
            self.skip_space();
            let start = self.i;
            match self.token(0) {
                None => return operands,
                Some(Token::Operator(op)) if op.as_slice() == b"ID" => break,
                Some(Token::Operand(o)) if operands.len() < MAX_OPERANDS => {
                    operands.push((o, start..self.i))
                }
                Some(_) => {}
            }
        }
        // One white-space byte ends `ID`; the data follows.
        self.i = (self.i + 1).min(self.s.len());
        let data_start = self.i;
        // With no filter the data's length is known; the search for `EI`
        // starts after it, so image bytes that happen to spell EI do not end
        // it early.
        if let Some(len) = unfiltered_length(&operands) {
            self.i = after_data(data_start, len, self.s.len());
        }
        while self.i + 1 < self.s.len() {
            let at = self.i;
            let before_ok = at == 0 || is_space(self.s[at - 1]);
            let after_ok = self.s.get(at + 2).is_none_or(|b| !is_regular(*b));
            if before_ok && &self.s[at..at + 2] == b"EI" && after_ok {
                self.i = at + 2;
                return operands;
            }
            self.i += 1;
        }
        self.i = self.s.len();
        operands
    }
}

enum Token {
    Operand(Operand),
    Operator(Operator),
    Junk,
}

fn number(run: &[u8]) -> Option<f32> {
    let first = *run.first()?;
    if !(first.is_ascii_digit() || matches!(first, b'+' | b'-' | b'.')) {
        return None;
    }
    if !run
        .iter()
        .all(|b| b.is_ascii_digit() || matches!(b, b'+' | b'-' | b'.'))
    {
        return None;
    }
    std::str::from_utf8(run).ok()?.parse::<f32>().ok()
}

/// Where an inline image's data ends: `len` bytes after `start`, and never
/// past the stream's `total` — nor, on a 32-bit target, wrapped round to
/// before `start`, which would send the lexer back over what it has read.
fn after_data(start: usize, len: usize, total: usize) -> usize {
    start.checked_add(len).map_or(total, |end| end.min(total))
}

/// Bytes of an unfiltered inline image, from its width, height, components
/// and bits; `None` when it has a filter or the numbers are not all there.
fn unfiltered_length(operands: &[(Operand, std::ops::Range<usize>)]) -> Option<usize> {
    let get = |short: &[u8], long: &[u8]| {
        operands.windows(2).find_map(|w| match (&w[0].0, &w[1].0) {
            (Operand::Name(k), v) if k == short || k == long => Some(v.clone()),
            _ => None,
        })
    };
    if get(b"F", b"Filter").is_some() {
        return None;
    }
    let n = |o: Option<Operand>| match o {
        Some(Operand::Number(v)) if (0.0..1.0e6).contains(&v) => Some(v as usize),
        _ => None,
    };
    let width = n(get(b"W", b"Width"))?;
    let height = n(get(b"H", b"Height"))?;
    let bits = n(get(b"BPC", b"BitsPerComponent")).unwrap_or(1);
    // No reader draws any other depth: there is no length to trust.
    if !matches!(bits, 1 | 2 | 4 | 8 | 16) {
        return None;
    }
    let mask = matches!(get(b"IM", b"ImageMask"), Some(Operand::Other));
    let components = if mask {
        1
    } else {
        match get(b"CS", b"ColorSpace")? {
            Operand::Name(cs) => match cs.as_slice() {
                b"G" | b"DeviceGray" | b"I" | b"Indexed" => 1,
                b"RGB" | b"DeviceRGB" => 3,
                b"CMYK" | b"DeviceCMYK" => 4,
                _ => return None,
            },
            _ => return None,
        }
    };
    let row = (width.checked_mul(components)?.checked_mul(bits)?).div_ceil(8);
    row.checked_mul(height)
}

/// The operations of `content`, one at a time and in order, each with its
/// byte range. Nothing is kept from one to the next.
pub(crate) fn ops(content: &[u8]) -> Ops<'_> {
    Ops {
        lexer: Lexer { s: content, i: 0 },
        operands: Vec::new(),
    }
}

pub(crate) struct Ops<'a> {
    lexer: Lexer<'a>,
    operands: Vec<(Operand, std::ops::Range<usize>)>,
}

impl Iterator for Ops<'_> {
    type Item = Op;

    fn next(&mut self) -> Option<Op> {
        let lexer = &mut self.lexer;
        loop {
            lexer.skip_space();
            let start = lexer.i;
            let op = match lexer.token(0)? {
                Token::Operand(o) => {
                    if self.operands.len() < MAX_OPERANDS {
                        self.operands.push((o, start..lexer.i));
                    }
                    None
                }
                Token::Operator(operator) if operator.as_slice() == b"BI" => {
                    // What came before `BI` belongs to no operation.
                    self.operands.clear();
                    let dict = lexer.inline_image();
                    Some(Op {
                        operator,
                        operands: dict,
                        range: start..lexer.i.max(start),
                    })
                }
                Token::Operator(operator) => {
                    let from = self.operands.first().map_or(start, |(_, r)| r.start);
                    Some(Op {
                        operator,
                        operands: std::mem::take(&mut self.operands),
                        range: from..lexer.i,
                    })
                }
                Token::Junk => {
                    self.operands.clear();
                    None
                }
            };
            // Always forwards, whatever a token claimed.
            if lexer.i <= start {
                lexer.i = start + 1;
            }
            if op.is_some() {
                return op;
            }
        }
    }
}

/// Every operation of `content`, in order, with its byte range; refused
/// when the stream holds more than `MAX_TOKENS` operations and operands.
pub(crate) fn lex(content: &[u8]) -> Result<Vec<Op>> {
    let mut out = Vec::new();
    let mut tokens = 0usize;
    for op in ops(content) {
        tokens += 1 + op.operands.len();
        if tokens > MAX_TOKENS {
            return Err(Error::Edit(
                "the page's content is too long to read for editing".into(),
            ));
        }
        out.push(op);
    }
    Ok(out)
}

/// For the fuzzer: whether the lexer keeps its promises on `content` —
/// every range inside the stream and running forwards, operations in order.
#[doc(hidden)]
pub fn ranges_hold(content: &[u8]) -> bool {
    let inside = |r: &std::ops::Range<usize>| r.start <= r.end && r.end <= content.len();
    let mut last_end = 0;
    for op in ops(content) {
        if !inside(&op.range)
            || op.range.start < last_end
            || !op.operands.iter().all(|(_, r)| inside(r))
        {
            return false;
        }
        last_end = op.range.end;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn operations_carry_their_operands_and_exact_byte_ranges() {
        let s = b"q 1 0 0 1 10 20 cm /Im0 Do Q\n(a (b) \\) c) Tj [<00ab> -20 (x)] TJ";
        let ops = lex(s).unwrap();
        let names: Vec<&[u8]> = ops.iter().map(|o| o.operator.as_slice()).collect();
        assert_eq!(names, [&b"q"[..], b"cm", b"Do", b"Q", b"Tj", b"TJ"]);
        assert_eq!(ops[1].matrix(), Some([1.0, 0.0, 0.0, 1.0, 10.0, 20.0]));
        assert_eq!(&s[ops[2].range.clone()], b"/Im0 Do");
        assert_eq!(ops[2].name(0), Some(&b"Im0"[..]));
        assert_eq!(&s[ops[4].range.clone()], b"(a (b) \\) c) Tj");
    }

    #[test]
    fn an_inline_image_is_one_operation_even_when_its_data_spells_ei() {
        // 2×1 RGB, unfiltered: six bytes, the middle two of which read "EI".
        let mut s = b"q BI /W 2 /H 1 /BPC 8 /CS /RGB ID ".to_vec();
        s.extend_from_slice(b"a EI b");
        s.extend_from_slice(b" EI Q /X Do");
        let ops = lex(&s).unwrap();
        let names: Vec<&[u8]> = ops.iter().map(|o| o.operator.as_slice()).collect();
        assert_eq!(names, [&b"q"[..], b"BI", b"Q", b"Do"]);
        assert!(s[ops[1].range.clone()].ends_with(b"a EI b EI"));
    }

    #[test]
    fn garbage_is_skipped_without_panicking() {
        for s in [
            &b"<<<<<<<<"[..],
            b"((((((",
            b"]]]>>>}}",
            b"/#zz /# 1 2 3",
            b"BI /W 9999999999 /H 3 ID",
            b"[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[",
            b"longword another 1 2 muchtoolong",
        ] {
            assert_sane(s, &lex(s).unwrap());
        }
        let deep = "[".repeat(10_000);
        assert_sane(deep.as_bytes(), &lex(deep.as_bytes()).unwrap());
        // A word longer than any operator matches none.
        assert!(lex(b"1 0 0 1 0 0 cmxx").unwrap()[0]
            .operator
            .as_slice()
            .is_empty());
    }

    /// Every range lies inside the stream and runs forwards, and each
    /// operation starts where the one before ended or later: the editors
    /// slice the stream with them.
    fn assert_sane(s: &[u8], ops: &[Op]) {
        let mut last_end = 0;
        for op in ops {
            let r = &op.range;
            assert!(
                r.start <= r.end && r.end <= s.len(),
                "{r:?} in {} bytes",
                s.len()
            );
            assert!(r.start >= last_end, "{r:?} starts before {last_end}");
            for (_, o) in &op.operands {
                assert!(
                    o.start <= o.end && o.end <= s.len(),
                    "{o:?} in {} bytes",
                    s.len()
                );
            }
            last_end = r.end;
        }
        assert!(ranges_hold(s));
    }

    #[test]
    fn a_backslash_at_the_very_end_stays_inside_the_stream() {
        for s in [
            &b"BI (\\"[..],
            b"q BI /W 1 /H 1 (\\",
            b"(\\",
            b"[(\\",
            b"(a\\",
            b"BI /W 1 ID",
            b"BI",
        ] {
            assert_sane(s, &lex(s).unwrap());
        }
    }

    #[test]
    fn an_inline_image_of_impossible_bits_is_not_measured() {
        // 16 × 1 of 524416 bits a component: 2^32 − 256 bytes over 4095
        // rows, which wraps a 32-bit index back before the image.
        let s = b"BI /W 16 /H 4095 /BPC 524416 /CS /G ID ";
        let lexer_ops = lex(s).unwrap();
        assert_eq!(unfiltered_length(&lexer_ops[0].operands), None);
        // Only 1, 2, 4, 8 and 16 bits are real.
        let s = b"BI /W 16 /H 4 /BPC 8 /CS /G ID ";
        assert_eq!(unfiltered_length(&lex(s).unwrap()[0].operands), Some(64));
    }

    #[test]
    fn a_length_past_the_end_of_memory_does_not_wrap() {
        assert_eq!(after_data(usize::MAX - 10, 100, 50), 50);
        assert_eq!(after_data(10, 20, 50), 30);
        assert_eq!(after_data(10, 100, 50), 50);
    }

    /// A stream of nothing but `q` is two bytes an operation: kept whole it
    /// would take some thirty times its size. `lex` refuses it past its
    /// bound; `ops` walks it keeping nothing.
    #[test]
    fn a_stream_of_too_many_operations_is_refused_not_kept() {
        let s = b"q\n".repeat(MAX_TOKENS + 1);
        assert!(lex(&s).is_err());
        assert_eq!(ops(&s).count(), MAX_TOKENS + 1);
        let s = b"q\n".repeat(1000);
        assert_eq!(lex(&s).unwrap().len(), 1000);
    }
}
