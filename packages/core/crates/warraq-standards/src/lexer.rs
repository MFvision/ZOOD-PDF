//! A small, bounded PDF tokenizer used for (1) the raw-file syntax checks (hex strings, stream and
//! object keywords) and (2) content streams (operators, inline images). Hostile input: every loop
//! advances `pos`, nothing recurses, and no token is larger than the input.

/// A token. Byte positions are offsets into the lexer's buffer.
#[derive(Debug, Clone, PartialEq)]
pub enum Tok<'a> {
    /// Integer.
    Int(i64),
    /// Real (or an integer too large for i64).
    Real(f64),
    /// Name (after `#xx` decoding). `raw_len` is the encoded length without the slash.
    Name(Vec<u8>),
    /// Literal string (escapes decoded).
    Str(Vec<u8>),
    /// Hexadecimal string: decoded bytes, number of hex digits, whether a non-hex character
    /// (other than white space) appeared.
    Hex {
        /// Decoded bytes (odd digit count: last nibble padded with 0).
        bytes: Vec<u8>,
        /// Number of hexadecimal digits.
        digits: usize,
        /// A character other than a hex digit or white space appeared.
        bad: bool,
    },
    /// `[`
    ArrOpen,
    /// `]`
    ArrClose,
    /// `<<`
    DictOpen,
    /// `>>`
    DictClose,
    /// `{` or `}` (PostScript calculator functions; ignored by callers).
    Brace,
    /// A keyword / operator (`obj`, `BT`, `true`, …).
    Kw(&'a [u8]),
}

/// PDF white space.
pub fn is_ws(b: u8) -> bool {
    matches!(b, 0 | 9 | 10 | 12 | 13 | 32)
}

/// PDF delimiter.
pub fn is_delim(b: u8) -> bool {
    matches!(
        b,
        b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'/' | b'%'
    )
}

fn is_regular(b: u8) -> bool {
    !is_ws(b) && !is_delim(b)
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Tokenizer over a byte buffer.
#[derive(Debug, Clone)]
pub struct Lexer<'a> {
    /// The input.
    pub buf: &'a [u8],
    /// Current position.
    pub pos: usize,
}

impl<'a> Lexer<'a> {
    /// Lexer at position 0.
    pub fn new(buf: &'a [u8]) -> Self {
        Lexer { buf, pos: 0 }
    }

    fn peek(&self) -> Option<u8> {
        self.buf.get(self.pos).copied()
    }

    fn at(&self, i: usize) -> Option<u8> {
        self.buf.get(i).copied()
    }

    /// Skip white space and comments.
    pub fn skip_ws(&mut self) {
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

    /// Next token with its start offset, or `None` at the end of input.
    pub fn next_tok(&mut self) -> Option<(usize, Tok<'a>)> {
        self.skip_ws();
        let start = self.pos;
        let b = self.peek()?;
        let tok = match b {
            b'[' => {
                self.pos += 1;
                Tok::ArrOpen
            }
            b']' => {
                self.pos += 1;
                Tok::ArrClose
            }
            b'{' | b'}' => {
                self.pos += 1;
                Tok::Brace
            }
            b'<' => {
                if self.at(self.pos + 1) == Some(b'<') {
                    self.pos += 2;
                    Tok::DictOpen
                } else {
                    self.pos += 1;
                    self.hex()
                }
            }
            b'>' => {
                if self.at(self.pos + 1) == Some(b'>') {
                    self.pos += 2;
                    Tok::DictClose
                } else {
                    // Stray '>': skip it as a one-byte keyword.
                    self.pos += 1;
                    Tok::Kw(self.buf.get(start..self.pos).unwrap_or_default())
                }
            }
            b'(' => {
                self.pos += 1;
                self.literal()
            }
            b')' => {
                self.pos += 1;
                Tok::Kw(self.buf.get(start..self.pos).unwrap_or_default())
            }
            b'/' => {
                self.pos += 1;
                self.name()
            }
            _ => {
                while self.peek().is_some_and(is_regular) {
                    self.pos += 1;
                }
                let word = self.buf.get(start..self.pos).unwrap_or_default();
                number(word).unwrap_or(Tok::Kw(word))
            }
        };
        Some((start, tok))
    }

    fn hex(&mut self) -> Tok<'a> {
        let mut bytes = Vec::new();
        let mut digits = 0usize;
        let mut bad = false;
        let mut hi: Option<u8> = None;
        while let Some(c) = self.peek() {
            self.pos += 1;
            if c == b'>' {
                break;
            }
            if let Some(v) = hex_val(c) {
                digits += 1;
                match hi.take() {
                    Some(h) => bytes.push(h << 4 | v),
                    None => hi = Some(v),
                }
            } else if !is_ws(c) {
                bad = true;
            }
        }
        if let Some(h) = hi {
            bytes.push(h << 4);
        }
        Tok::Hex { bytes, digits, bad }
    }

    fn literal(&mut self) -> Tok<'a> {
        let mut out = Vec::new();
        let mut depth = 1usize;
        while let Some(c) = self.peek() {
            self.pos += 1;
            match c {
                b'(' => {
                    depth += 1;
                    out.push(c);
                }
                b')' => {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                    out.push(c);
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
                                    Some(d @ b'0'..=b'7') => {
                                        self.pos += 1;
                                        v = v * 8 + u32::from(d - b'0');
                                    }
                                    _ => break,
                                }
                            }
                            out.push((v & 0xFF) as u8);
                        }
                        other => out.push(other),
                    }
                }
                _ => out.push(c),
            }
        }
        Tok::Str(out)
    }

    fn name(&mut self) -> Tok<'a> {
        let mut out = Vec::new();
        while let Some(c) = self.peek() {
            if !is_regular(c) {
                break;
            }
            self.pos += 1;
            if c == b'#' {
                let h = self.peek().and_then(hex_val);
                let l = self.at(self.pos + 1).and_then(hex_val);
                if let (Some(h), Some(l)) = (h, l) {
                    self.pos += 2;
                    out.push(h << 4 | l);
                    continue;
                }
            }
            out.push(c);
        }
        Tok::Name(out)
    }
}

/// Parse a numeric token (`12`, `-3.5`, `.5`, `+7`).
fn number(word: &[u8]) -> Option<Tok<'static>> {
    let s = std::str::from_utf8(word).ok()?;
    let body = s.strip_prefix(['+', '-']).unwrap_or(s);
    if body.is_empty() || !body.bytes().all(|c| c.is_ascii_digit() || c == b'.') {
        return None;
    }
    if body.bytes().filter(|c| *c == b'.').count() > 1 || body == "." {
        return None;
    }
    if !body.contains('.') {
        if let Ok(i) = s.parse::<i64>() {
            return Some(Tok::Int(i));
        }
    }
    let norm = if body.ends_with('.') {
        format!("{s}0")
    } else {
        s.to_string()
    };
    let norm = norm.replace("-.", "-0.").replace("+.", "0.");
    let norm = if norm.starts_with('.') {
        format!("0{norm}")
    } else {
        norm
    };
    norm.parse::<f64>().ok().map(Tok::Real)
}

/// Find `needle` in `hay` starting at `from` (naive, linear in practice for PDF keywords).
pub fn find(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    let first = *needle.first()?;
    let mut i = from;
    while i + needle.len() <= hay.len() {
        let rel = hay.get(i..)?.iter().position(|b| *b == first)?;
        i += rel;
        if hay.get(i..i + needle.len()) == Some(needle) {
            return Some(i);
        }
        i += 1;
    }
    None
}

/// Find the last occurrence of `needle` in `hay`.
pub fn rfind(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.len() > hay.len() {
        return None;
    }
    (0..=hay.len() - needle.len())
        .rev()
        .find(|&i| hay.get(i..i + needle.len()) == Some(needle))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    fn toks(s: &[u8]) -> Vec<Tok<'_>> {
        let mut l = Lexer::new(s);
        let mut v = Vec::new();
        while let Some((_, t)) = l.next_tok() {
            v.push(t);
        }
        v
    }

    #[test]
    fn tokens() {
        let t = toks(
            b"1 0 obj <</A#20B -3.5 /C (a\\(b\\)c\\101) /D <4142 3>>> [true .5] endobj % c\n+7 4.",
        );
        assert_eq!(t[0], Tok::Int(1));
        assert_eq!(t[2], Tok::Kw(b"obj"));
        assert_eq!(t[3], Tok::DictOpen);
        assert_eq!(t[4], Tok::Name(b"A B".to_vec()));
        assert_eq!(t[5], Tok::Real(-3.5));
        assert_eq!(t[7], Tok::Str(b"a(b)cA".to_vec()));
        assert_eq!(
            t[9],
            Tok::Hex {
                bytes: vec![0x41, 0x42, 0x30],
                digits: 5,
                bad: false
            }
        );
        assert_eq!(t[10], Tok::DictClose);
        assert_eq!(t[12], Tok::Kw(b"true"));
        assert_eq!(t[13], Tok::Real(0.5));
        assert_eq!(t[15], Tok::Kw(b"endobj"));
        assert_eq!(t[16], Tok::Int(7));
        assert_eq!(t[17], Tok::Real(4.0));
    }

    #[test]
    fn bad_hex_and_unterminated_input_end() {
        let t = toks(b"<41 zz>");
        assert!(matches!(t[0], Tok::Hex { bad: true, .. }));
        // Unterminated string / hex / name at the end: no panic, input consumed.
        for s in [&b"(abc"[..], b"<414", b"/", b"(\\", b"<<", b"-", b"1.2.3"] {
            let _ = toks(s);
        }
        assert_eq!(find(b"abcabc", b"ca", 0), Some(2));
        assert_eq!(rfind(b"abcabc", b"ab"), Some(3));
        assert_eq!(find(b"ab", b"abc", 0), None);
    }
}
