//! CMap parsing: ToUnicode CMaps (`bfchar` / `bfrange` incl. the array form and multi-codepoint
//! destinations) and embedded encoding CMaps (`cidchar` / `cidrange`, `codespacerange`,
//! `usecmap`). Ranges are never expanded, so a hostile `<0000> <FFFFFFFF>` costs nothing.

use std::collections::HashMap;

use crate::encoding::glyph_name_to_unicode;
use crate::lexer::{Lexer, Token};
use crate::limits;

#[derive(Debug, Clone, Copy, PartialEq)]
struct CodeRange {
    len: u8,
    lo: [u8; 4],
    hi: [u8; 4],
}

#[derive(Debug, Clone)]
enum UniDst {
    /// Destination string of the first code; the last UTF-16 unit is incremented.
    Base(Vec<u16>),
    /// One destination per code.
    Array(Vec<String>),
}

#[derive(Debug, Clone)]
struct UniRange {
    len: u8,
    lo: u32,
    hi: u32,
    dst: UniDst,
}

#[derive(Debug, Clone, Copy)]
struct CidRange {
    len: u8,
    lo: u32,
    hi: u32,
    cid: u32,
}

/// A parsed CMap. Serves both as ToUnicode map and as code→CID encoding.
#[derive(Debug, Clone, Default)]
pub struct CMap {
    codespace: Vec<CodeRange>,
    uni_char: HashMap<(u8, u32), String>,
    uni_range: Vec<UniRange>,
    cid_char: HashMap<(u8, u32), u32>,
    cid_range: Vec<CidRange>,
    /// Name given to `usecmap`, if any (resolved by the caller for predefined CMaps).
    pub use_cmap: Option<String>,
    /// Writing mode (1 = vertical).
    pub wmode: u8,
    /// Code length most used by mappings (fallback when there is no codespace).
    mapping_len_votes: [usize; 5],
}

fn code_of(bytes: &[u8]) -> Option<(u8, u32)> {
    if bytes.is_empty() || bytes.len() > 4 {
        return None;
    }
    let mut v: u32 = 0;
    for &b in bytes {
        v = v << 8 | u32::from(b);
    }
    Some((bytes.len() as u8, v))
}

/// Decode UTF-16BE code units, dropping NULs and replacing unpaired surrogates.
pub fn utf16_to_string(units: &[u16]) -> String {
    char::decode_utf16(units.iter().copied())
        .map(|r| r.unwrap_or('\u{FFFD}'))
        .filter(|&c| c != '\0')
        .collect()
}

fn bytes_to_u16(bytes: &[u8]) -> Vec<u16> {
    bytes
        .chunks(2)
        .take(limits::MAX_CMAP_DST_UNITS)
        .map(|c| match c {
            [a, b] => u16::from(*a) << 8 | u16::from(*b),
            [a] => u16::from(*a),
            _ => 0,
        })
        .collect()
}

fn dst_string(tok: &Token<'_>) -> Option<String> {
    match tok {
        Token::Hex(b) | Token::Str(b) => Some(utf16_to_string(&bytes_to_u16(b))),
        Token::Name(n) => glyph_name_to_unicode(&String::from_utf8_lossy(n)),
        _ => None,
    }
}

impl CMap {
    /// The predefined `Identity-H` / `Identity-V` CMap: 2-byte codes, CID = code.
    pub fn identity(vertical: bool) -> CMap {
        let mut m = CMap::default();
        m.codespace.push(CodeRange {
            len: 2,
            lo: [0, 0, 0, 0],
            hi: [0xff, 0xff, 0, 0],
        });
        m.cid_range.push(CidRange {
            len: 2,
            lo: 0,
            hi: 0xffff,
            cid: 0,
        });
        m.wmode = u8::from(vertical);
        m
    }

    /// Parse CMap source. Never fails: malformed parts are skipped.
    pub fn parse(data: &[u8]) -> CMap {
        let data = data.get(..limits::MAX_CMAP_BYTES).unwrap_or(data);
        let mut m = CMap::default();
        let mut lex = Lexer::new(data);
        let mut last: Vec<Token<'_>> = Vec::new();
        let mut entries = 0usize;
        while let Some(tok) = lex.next_token() {
            if entries > limits::MAX_CMAP_ENTRIES {
                break;
            }
            match tok {
                Token::Keyword(b"begincodespacerange") => {
                    let toks = collect_until(&mut lex, b"endcodespacerange");
                    for pair in toks.chunks(2) {
                        if let [Token::Hex(lo), Token::Hex(hi)] = pair {
                            m.add_codespace(lo, hi);
                            entries += 1;
                        }
                    }
                }
                Token::Keyword(b"beginbfchar") => {
                    let toks = collect_until(&mut lex, b"endbfchar");
                    for pair in toks.chunks(2) {
                        if let [Token::Hex(src), dst] = pair {
                            if let (Some(code), Some(s)) = (code_of(src), dst_string(dst)) {
                                m.vote(code.0);
                                m.uni_char.insert(code, s);
                                entries += 1;
                            }
                        }
                    }
                }
                Token::Keyword(b"beginbfrange") => {
                    entries += m.parse_bfrange(&mut lex);
                }
                Token::Keyword(b"begincidchar") => {
                    let toks = collect_until(&mut lex, b"endcidchar");
                    for pair in toks.chunks(2) {
                        if let [Token::Hex(src), Token::Num(cid)] = pair {
                            if let Some(code) = code_of(src) {
                                m.vote(code.0);
                                m.cid_char.insert(code, num_u32(*cid));
                                entries += 1;
                            }
                        }
                    }
                }
                Token::Keyword(b"begincidrange") => {
                    let toks = collect_until(&mut lex, b"endcidrange");
                    for tri in toks.chunks(3) {
                        if let [Token::Hex(lo), Token::Hex(hi), Token::Num(cid)] = tri {
                            if let (Some(l), Some(h)) = (code_of(lo), code_of(hi)) {
                                if l.0 == h.0 && l.1 <= h.1 {
                                    m.vote(l.0);
                                    m.cid_range.push(CidRange {
                                        len: l.0,
                                        lo: l.1,
                                        hi: h.1,
                                        cid: num_u32(*cid),
                                    });
                                    entries += 1;
                                }
                            }
                        }
                    }
                }
                Token::Keyword(b"usecmap") => {
                    if let Some(Token::Name(n)) = last.last() {
                        m.use_cmap = Some(String::from_utf8_lossy(n).into_owned());
                    }
                }
                Token::Keyword(b"def") => {
                    if let [.., Token::Name(k), Token::Num(v)] = last.as_slice() {
                        if k.as_slice() == b"WMode" {
                            m.wmode = u8::from(*v >= 1.0);
                        }
                    }
                }
                _ => {}
            }
            if !matches!(tok, Token::Keyword(b"def") | Token::Keyword(b"usecmap")) {
                last.push(tok);
                if last.len() > 4 {
                    last.remove(0);
                }
            } else {
                last.clear();
            }
        }
        m.uni_range.sort_by_key(|r| (r.len, r.lo));
        m.cid_range.sort_by_key(|r| (r.len, r.lo));
        m
    }

    fn vote(&mut self, len: u8) {
        if let Some(v) = self.mapping_len_votes.get_mut(usize::from(len)) {
            *v += 1;
        }
    }

    fn add_codespace(&mut self, lo: &[u8], hi: &[u8]) {
        if lo.is_empty() || lo.len() != hi.len() || lo.len() > 4 {
            return;
        }
        let mut r = CodeRange {
            len: lo.len() as u8,
            lo: [0; 4],
            hi: [0; 4],
        };
        for (i, (a, b)) in lo.iter().zip(hi.iter()).enumerate() {
            if let (Some(l), Some(h)) = (r.lo.get_mut(i), r.hi.get_mut(i)) {
                *l = *a;
                *h = *b;
            }
        }
        self.codespace.push(r);
    }

    fn parse_bfrange(&mut self, lex: &mut Lexer<'_>) -> usize {
        let mut n = 0usize;
        loop {
            let Some(lo_tok) = lex.next_token() else {
                return n;
            };
            let lo = match lo_tok {
                Token::Keyword(b"endbfrange") => return n,
                Token::Hex(b) => b,
                _ => continue,
            };
            let Some(Token::Hex(hi)) = lex.next_token() else {
                return n;
            };
            let Some(dst_tok) = lex.next_token() else {
                return n;
            };
            let (Some(l), Some(h)) = (code_of(&lo), code_of(&hi)) else {
                continue;
            };
            let dst = match dst_tok {
                Token::Hex(b) => Some(UniDst::Base(bytes_to_u16(&b))),
                Token::ArrOpen => {
                    let mut items = Vec::new();
                    while let Some(t) = lex.next_token() {
                        if t == Token::ArrClose {
                            break;
                        }
                        if items.len() < limits::MAX_ARRAY_LEN {
                            items.push(dst_string(&t).unwrap_or_default());
                        }
                    }
                    Some(UniDst::Array(items))
                }
                Token::Keyword(b"endbfrange") => return n,
                _ => None,
            };
            if let Some(dst) = dst {
                if l.0 == h.0 && l.1 <= h.1 {
                    self.vote(l.0);
                    self.uni_range.push(UniRange {
                        len: l.0,
                        lo: l.1,
                        hi: h.1,
                        dst,
                    });
                    n += 1;
                    if n > limits::MAX_CMAP_ENTRIES {
                        return n;
                    }
                }
            }
        }
    }

    /// Merge another CMap's mappings (for `usecmap`); existing entries win.
    pub fn merge_parent(&mut self, parent: &CMap) {
        if self.codespace.is_empty() {
            self.codespace = parent.codespace.clone();
        }
        for (k, v) in &parent.cid_char {
            self.cid_char.entry(*k).or_insert(*v);
        }
        self.cid_range.extend(parent.cid_range.iter().copied());
        self.cid_range.sort_by_key(|r| (r.len, r.lo));
        for (k, v) in &parent.uni_char {
            self.uni_char.entry(*k).or_insert_with(|| v.clone());
        }
        self.uni_range.extend(parent.uni_range.iter().cloned());
        self.uni_range.sort_by_key(|r| (r.len, r.lo));
    }

    pub fn has_codespace(&self) -> bool {
        !self.codespace.is_empty()
    }

    pub fn is_empty(&self) -> bool {
        self.uni_char.is_empty()
            && self.uni_range.is_empty()
            && self.cid_char.is_empty()
            && self.cid_range.is_empty()
    }

    /// Split the next character code from `bytes`: `(code, byte_length)`.
    /// Always consumes at least one byte when `bytes` is non-empty.
    pub fn next_code(&self, bytes: &[u8]) -> (u32, usize) {
        for len in 1..=4usize {
            let Some(prefix) = bytes.get(..len) else {
                break;
            };
            let hit = self.codespace.iter().any(|r| {
                usize::from(r.len) == len
                    && prefix.iter().enumerate().all(|(i, b)| {
                        let lo = r.lo.get(i).copied().unwrap_or(0);
                        let hi = r.hi.get(i).copied().unwrap_or(0xff);
                        *b >= lo && *b <= hi
                    })
            });
            if hit {
                return (code_of(prefix).map(|c| c.1).unwrap_or(0), len);
            }
        }
        // No codespace matched: use the shortest codespace length, else the dominant mapping length.
        let len = self
            .codespace
            .iter()
            .map(|r| usize::from(r.len))
            .min()
            .unwrap_or_else(|| self.dominant_len())
            .clamp(1, 4)
            .min(bytes.len().max(1));
        let prefix = bytes.get(..len).unwrap_or(bytes);
        (code_of(prefix).map(|c| c.1).unwrap_or(0), len.max(1))
    }

    fn dominant_len(&self) -> usize {
        let mut best = 1usize;
        let mut votes = 0usize;
        for (len, v) in self.mapping_len_votes.iter().enumerate() {
            if *v > votes {
                best = len;
                votes = *v;
            }
        }
        best.max(1)
    }

    /// Unicode for a code of `len` bytes.
    pub fn lookup_unicode(&self, code: u32, len: usize) -> Option<String> {
        let len8 = u8::try_from(len).ok()?;
        if let Some(s) = self.uni_char.get(&(len8, code)) {
            return Some(s.clone());
        }
        let r = find_range(&self.uni_range, len8, code, |r| (r.len, r.lo, r.hi))?;
        let off = code - r.lo;
        match &r.dst {
            UniDst::Base(units) => {
                let mut u = units.clone();
                if let Some(last) = u.last_mut() {
                    *last = last.wrapping_add((off & 0xffff) as u16);
                }
                Some(utf16_to_string(&u))
            }
            UniDst::Array(items) => items.get(off as usize).cloned(),
        }
    }

    /// CID for a code of `len` bytes (encoding CMaps).
    pub fn lookup_cid(&self, code: u32, len: usize) -> Option<u32> {
        let len8 = u8::try_from(len).ok()?;
        if let Some(c) = self.cid_char.get(&(len8, code)) {
            return Some(*c);
        }
        let r = find_range(&self.cid_range, len8, code, |r| (r.len, r.lo, r.hi))?;
        Some(r.cid.saturating_add(code - r.lo))
    }
}

/// Binary search over ranges sorted by (len, lo); falls back to a bounded backward scan for
/// overlapping ranges.
fn find_range<T>(
    ranges: &[T],
    len: u8,
    code: u32,
    key: impl Fn(&T) -> (u8, u32, u32),
) -> Option<&T> {
    let idx = ranges.partition_point(|r| {
        let (l, lo, _) = key(r);
        (l, lo) <= (len, code)
    });
    let mut i = idx;
    let mut steps = 0;
    while i > 0 && steps < 64 {
        i -= 1;
        steps += 1;
        let r = ranges.get(i)?;
        let (l, lo, hi) = key(r);
        if l != len {
            return None;
        }
        if code >= lo && code <= hi {
            return Some(r);
        }
    }
    None
}

fn num_u32(n: f64) -> u32 {
    if n.is_finite() && n >= 0.0 {
        n.min(f64::from(u32::MAX)) as u32
    } else {
        0
    }
}

fn collect_until<'a>(lex: &mut Lexer<'a>, end: &[u8]) -> Vec<Token<'a>> {
    let mut out = Vec::new();
    while let Some(t) = lex.next_token() {
        if let Token::Keyword(k) = t {
            if k == end {
                break;
            }
        }
        if out.len() >= limits::MAX_CMAP_ENTRIES * 3 {
            break;
        }
        out.push(t);
    }
    out
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    const TOUNICODE: &str = "/CIDInit /ProcSet findresource begin 12 dict begin begincmap
/CMapName /Adobe-Identity-UCS def /CMapType 2 def
1 begincodespacerange <0000> <FFFF> endcodespacerange
4 beginbfchar
<0001> <0020>
<0037> <0627>
<0543> <0000>
<0100> <06440627>
endbfchar
2 beginbfrange
<0010> <0012> <0661>
<0020> <0022> [<0041> <D83DDE00> <00660066>]
endbfrange
endcmap CMapName currentdict /CMap defineresource pop end end";

    #[test]
    fn bfchar_bfrange_array_and_multi_codepoint() {
        let m = CMap::parse(TOUNICODE.as_bytes());
        assert_eq!(m.lookup_unicode(0x37, 2).as_deref(), Some("ا"));
        assert_eq!(
            m.lookup_unicode(0x543, 2).as_deref(),
            Some(""),
            "U+0000 means no text"
        );
        assert_eq!(m.lookup_unicode(0x100, 2).as_deref(), Some("لا"));
        assert_eq!(m.lookup_unicode(0x11, 2).as_deref(), Some("٢"));
        assert_eq!(m.lookup_unicode(0x12, 2).as_deref(), Some("٣"));
        assert_eq!(m.lookup_unicode(0x13, 2), None);
        assert_eq!(m.lookup_unicode(0x21, 2).as_deref(), Some("😀"));
        assert_eq!(m.lookup_unicode(0x22, 2).as_deref(), Some("ff"));
        assert_eq!(m.next_code(&[0x00, 0x37, 0x01]), (0x37, 2));
    }

    #[test]
    fn one_byte_codespace() {
        let m = CMap::parse(b"1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfchar <9C> <0020> endbfchar 1 beginbfrange <46> <48> <0661> endbfrange");
        assert_eq!(m.next_code(&[0x47, 0x9c]), (0x47, 1));
        assert_eq!(m.lookup_unicode(0x47, 1).as_deref(), Some("٢"));
        assert_eq!(m.lookup_unicode(0x9c, 1).as_deref(), Some(" "));
    }

    #[test]
    fn mixed_width_codespace() {
        let m = CMap::parse(b"2 begincodespacerange <00> <80> <8140> <FFFC> endcodespacerange 1 begincidrange <8140> <817E> 633 endcidrange 1 begincidchar <41> 34 endcidchar");
        assert_eq!(m.next_code(&[0x41, 0x81]), (0x41, 1));
        assert_eq!(m.next_code(&[0x81, 0x41]), (0x8141, 2));
        assert_eq!(m.lookup_cid(0x8141, 2), Some(634));
        assert_eq!(m.lookup_cid(0x41, 1), Some(34));
    }

    #[test]
    fn usecmap_and_wmode() {
        let m = CMap::parse(b"/Identity-H usecmap /WMode 1 def");
        assert_eq!(m.use_cmap.as_deref(), Some("Identity-H"));
        assert_eq!(m.wmode, 1);
    }

    #[test]
    fn huge_ranges_are_not_expanded() {
        let m = CMap::parse(b"1 beginbfrange <00000000> <FFFFFFFF> <0041> endbfrange");
        assert_eq!(m.lookup_unicode(1, 4).as_deref(), Some("B"));
    }

    #[test]
    fn garbage_never_panics() {
        for s in [
            "beginbfrange <00>",
            "beginbfchar <0001>",
            "begincidrange <01> <00> 5 endcidrange",
            "<<>>]][",
        ] {
            let m = CMap::parse(s.as_bytes());
            let _ = m.next_code(&[]);
            let _ = m.next_code(&[1, 2, 3, 4, 5]);
        }
    }
}
