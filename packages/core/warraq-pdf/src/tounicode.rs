//! ToUnicode CMap parsing (bfchar and bfrange, 1- and 2-byte codes).
use std::collections::BTreeMap;

fn hex(s: &str) -> Vec<u8> {
    let s = s.trim_matches(|c| c == '<' || c == '>');
    (0..s.len())
        .step_by(2)
        .filter_map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok())
        .collect()
}

fn utf16(b: &[u8]) -> String {
    let u: Vec<u16> = b
        .chunks(2)
        .map(|c| u16::from_be_bytes([c[0], *c.get(1).unwrap_or(&0)]))
        .collect();
    String::from_utf16_lossy(&u)
}

fn code_of(b: &[u8]) -> Option<u32> {
    match b.len() {
        1 => Some(b[0] as u32),
        2 => Some(u16::from_be_bytes([b[0], b[1]]) as u32),
        _ => None,
    }
}

/// Parse a ToUnicode CMap stream into code → text. Codes are 1 or 2 bytes wide.
pub fn parse(cmap: &[u8]) -> BTreeMap<u32, String> {
    let text = String::from_utf8_lossy(cmap);
    let toks: Vec<&str> = text.split_whitespace().collect();
    let mut map = BTreeMap::new();
    let mut i = 0;
    while i < toks.len() {
        match toks[i] {
            "beginbfchar" => {
                i += 1;
                while i + 1 < toks.len() && toks[i] != "endbfchar" {
                    if let Some(code) = code_of(&hex(toks[i])) {
                        map.insert(code, utf16(&hex(toks[i + 1])));
                    }
                    i += 2;
                }
            }
            "beginbfrange" => {
                i += 1;
                while i + 2 < toks.len() && toks[i] != "endbfrange" {
                    let (lo, hi) = (code_of(&hex(toks[i])), code_of(&hex(toks[i + 1])));
                    if toks[i + 2].starts_with('[') {
                        // array form: <lo> <hi> [<dst1> <dst2> ...]
                        let mut j = i + 2;
                        let mut dsts = vec![];
                        while j < toks.len() && !toks[j].ends_with(']') {
                            let t = toks[j].trim_start_matches('[');
                            if !t.is_empty() {
                                dsts.push(utf16(&hex(t)));
                            }
                            j += 1;
                        }
                        if j < toks.len() {
                            let t = toks[j].trim_start_matches('[').trim_end_matches(']');
                            if !t.is_empty() {
                                dsts.push(utf16(&hex(t)));
                            }
                        }
                        if let (Some(lo), Some(_)) = (lo, hi) {
                            for (k, d) in dsts.into_iter().enumerate() {
                                map.insert(lo + k as u32, d);
                            }
                        }
                        i = j + 1;
                    } else {
                        if let (Some(lo), Some(hi)) = (lo, hi) {
                            let dst = hex(toks[i + 2]);
                            for (k, code) in (lo..=hi.min(lo + 65535)).enumerate() {
                                let mut d = dst.clone();
                                if let Some(last) = d.last_mut() {
                                    *last = last.wrapping_add(k as u8);
                                }
                                map.insert(code, utf16(&d));
                            }
                        }
                        i += 3;
                    }
                }
            }
            _ => i += 1,
        }
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_bfchar_and_bfrange_forms() {
        let m = parse(b"1 begincodespacerange <0000> <FFFF> endcodespacerange 2 beginbfchar <0001> <0644> <0002> <06440627> endbfchar 1 beginbfrange <0010> <0012> <0041> endbfrange 1 beginbfrange <0020> <0021> [<0062> <0063>] endbfrange endcmap");
        assert_eq!(m[&1], "ل");
        assert_eq!(m[&2], "لا");
        assert_eq!(m[&0x12], "C");
        assert_eq!(m[&0x21], "c");
    }
}
