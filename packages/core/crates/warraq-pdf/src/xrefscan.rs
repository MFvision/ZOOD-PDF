//! Own walk of the cross-reference chain, for two things lopdf does not do:
//!
//! * lopdf ignores free (`f` / type 0) entries, so an object freed by a later incremental
//!   update "comes back" from an older section. We collect the object numbers whose newest
//!   entry is free.
//! * When no usable trailer survives (truncated file), we synthesise one by locating the
//!   catalog, so lopdf's own reconstruction can run.

use crate::limits::{decode_stream, Limits};
use lopdf::{Document, Object};
use std::collections::{BTreeMap, HashSet};

fn skip_ws(b: &[u8], mut i: usize) -> usize {
    while let Some(c) = b.get(i) {
        if c.is_ascii_whitespace() {
            i += 1;
        } else if *c == b'%' {
            while let Some(c) = b.get(i) {
                if *c == b'\n' || *c == b'\r' {
                    break;
                }
                i += 1;
            }
        } else {
            break;
        }
    }
    i
}

fn read_uint(b: &[u8], i: usize) -> Option<(u64, usize)> {
    let mut j = i;
    let mut v: u64 = 0;
    while let Some(c) = b.get(j) {
        if !c.is_ascii_digit() || j - i >= 19 {
            break;
        }
        v = v * 10 + u64::from(c - b'0');
        j += 1;
    }
    (j > i).then_some((v, j))
}

/// Find `/Key <int>` inside `region` (top-level keys of a small trailer dictionary).
fn find_int_key(region: &[u8], key: &[u8]) -> Option<u64> {
    let mut i = 0;
    while let Some(rel) = region
        .get(i..)
        .and_then(|s| s.windows(key.len()).position(|w| w == key))
    {
        let pos = i + rel + key.len();
        // The key must end here (next byte not a regular name character).
        if region.get(pos).is_some_and(|c| c.is_ascii_alphanumeric()) {
            i = pos;
            continue;
        }
        let j = skip_ws(region, pos);
        return read_uint(region, j).map(|(v, _)| v);
    }
    None
}

enum Section {
    Table {
        entries: Vec<(u32, bool)>,
        prev: Option<u64>,
        xref_stm: Option<u64>,
    },
    Stream {
        entries: Vec<(u32, bool)>,
        prev: Option<u64>,
    },
}

fn parse_table(b: &[u8], mut i: usize, limits: &Limits) -> Option<Section> {
    i += 4; // "xref"
    let mut entries = Vec::new();
    loop {
        i = skip_ws(b, i);
        if b.get(i..)?.starts_with(b"trailer") {
            break;
        }
        let (start, j) = read_uint(b, i)?;
        let j = skip_ws(b, j);
        let (count, j) = read_uint(b, j)?;
        i = j;
        if count as usize > limits.max_objects
            || entries.len() + count as usize > limits.max_objects
        {
            return None;
        }
        for k in 0..count {
            i = skip_ws(b, i);
            let (_off, j) = read_uint(b, i)?;
            let j = skip_ws(b, j);
            let (_gen, j) = read_uint(b, j)?;
            let j = skip_ws(b, j);
            let kind = *b.get(j)?;
            i = j + 1;
            let num = u32::try_from(start.checked_add(k)?).ok()?;
            match kind {
                b'n' => entries.push((num, false)),
                b'f' => entries.push((num, true)),
                _ => return None,
            }
        }
    }
    let tail = b.get(i..(i + 4096).min(b.len()))?;
    let end = tail
        .windows(9)
        .position(|w| w == b"startxref")
        .unwrap_or(tail.len());
    let region = tail.get(..end)?;
    Some(Section::Table {
        entries,
        prev: find_int_key(region, b"/Prev"),
        xref_stm: find_int_key(region, b"/XRefStm"),
    })
}

fn parse_stream(b: &[u8], i: usize, doc: &Document, limits: &Limits) -> Option<Section> {
    let (num, j) = read_uint(b, i)?;
    let j = skip_ws(b, j);
    let (gen, _) = read_uint(b, j)?;
    let id = (u32::try_from(num).ok()?, u16::try_from(gen).ok()?);
    let Some(Object::Stream(s)) = doc.objects.get(&id) else {
        return None;
    };
    if !s.dict.has_type(b"XRef") {
        return None;
    }
    let data = decode_stream(s, limits).ok()?;
    let w: Vec<usize> = s
        .dict
        .get(b"W")
        .ok()?
        .as_array()
        .ok()?
        .iter()
        .map(|o| o.as_i64().ok().and_then(|v| usize::try_from(v).ok()))
        .collect::<Option<Vec<_>>>()?;
    let (w0, w1, w2) = (*w.first()?, *w.get(1)?, *w.get(2)?);
    if w0 > 8 || w1 > 8 || w2 > 8 {
        return None;
    }
    let row = w0 + w1 + w2;
    if row == 0 {
        return None;
    }
    let size = s.dict.get(b"Size").ok()?.as_i64().ok()?;
    let index: Vec<i64> = match s.dict.get(b"Index") {
        Ok(Object::Array(a)) => a.iter().filter_map(|o| o.as_i64().ok()).collect(),
        _ => vec![0, size],
    };
    let mut entries = Vec::new();
    let mut pos = 0usize;
    for pair in index.chunks(2) {
        let (Some(&start), Some(&count)) = (pair.first(), pair.get(1)) else {
            break;
        };
        if start < 0 || count < 0 || count as usize > limits.max_objects {
            return None;
        }
        for k in 0..count {
            let r = data.get(pos..pos + row)?;
            pos += row;
            let t = if w0 == 0 {
                1
            } else {
                r.get(..w0)?
                    .iter()
                    .fold(0u64, |a, c| (a << 8) | u64::from(*c))
            };
            let n = u32::try_from(start + k).ok()?;
            entries.push((n, t == 0));
        }
    }
    let prev = s
        .dict
        .get(b"Prev")
        .ok()
        .and_then(|o| o.as_i64().ok())
        .and_then(|v| u64::try_from(v).ok());
    Some(Section::Stream { entries, prev })
}

/// Object numbers whose newest cross-reference entry is "free".
pub fn freed_numbers(bytes: &[u8], start: usize, doc: &Document, limits: &Limits) -> HashSet<u32> {
    let mut status: BTreeMap<u32, bool> = BTreeMap::new();
    let mut seen = HashSet::new();
    let mut next = Some(start as u64);
    let mut hops = 0;
    while let Some(off) = next.take() {
        hops += 1;
        if hops > limits.max_revisions || !seen.insert(off) {
            break;
        }
        let Ok(off) = usize::try_from(off) else { break };
        let i = skip_ws(bytes, off);
        let section = if bytes.get(i..).is_some_and(|s| s.starts_with(b"xref")) {
            parse_table(bytes, i, limits)
        } else {
            parse_stream(bytes, i, doc, limits)
        };
        let mut record = |entries: Vec<(u32, bool)>| {
            for (n, free) in entries {
                status.entry(n).or_insert(free);
            }
        };
        match section {
            Some(Section::Table {
                entries,
                prev,
                xref_stm,
            }) => {
                // Hybrid file: the stream's entries win over the table's free placeholders.
                if let Some(x) = xref_stm.and_then(|x| usize::try_from(x).ok()) {
                    if let Some(Section::Stream { entries: se, .. }) =
                        parse_stream(bytes, skip_ws(bytes, x), doc, limits)
                    {
                        record(se);
                    }
                }
                record(entries);
                next = prev;
            }
            Some(Section::Stream { entries, prev }) => {
                record(entries);
                next = prev;
            }
            None => break,
        }
    }
    status
        .into_iter()
        .filter(|(n, free)| *free && *n != 0)
        .map(|(n, _)| n)
        .collect()
}

/// A copy of `bytes` with a synthetic trailer pointing at the last catalog object, or
/// `None` when no catalog can be found.
pub fn with_synthetic_trailer(bytes: &[u8]) -> Option<Vec<u8>> {
    let pat = b"/Catalog";
    let pos = bytes.windows(pat.len()).rposition(|w| w == pat)?;
    // Walk back to the `N G obj` header that owns it.
    let head = bytes.get(..pos)?;
    let obj = head.windows(3).rposition(|w| w == b"obj")?;
    let before = head.get(..obj)?;
    // before ends with "N G " ; parse backwards.
    let mut k = before.len();
    let mut nums = Vec::new();
    for _ in 0..2 {
        while k > 0 && before.get(k - 1).is_some_and(|c| c.is_ascii_whitespace()) {
            k -= 1;
        }
        let end = k;
        while k > 0 && before.get(k - 1).is_some_and(|c| c.is_ascii_digit()) {
            k -= 1;
        }
        let s = std::str::from_utf8(before.get(k..end)?).ok()?;
        nums.push(s.parse::<u32>().ok()?);
    }
    let (gen, num) = (nums.first()?, nums.get(1)?);
    let mut out = bytes.to_vec();
    out.extend_from_slice(
        format!("\ntrailer\n<</Root {num} {gen} R>>\nstartxref\n0\n%%EOF\n").as_bytes(),
    );
    Some(out)
}
