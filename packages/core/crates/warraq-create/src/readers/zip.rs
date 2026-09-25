//! Minimal bounded zip reader for OOXML packages (stored and deflate entries).
//!
//! Bounds: at most [`limits::MAX_ZIP_ENTRIES`] entries; each entry inflates to at most
//! min([`limits::MAX_ZIP_ENTRY`], max(compressed × [`limits::MAX_ZIP_RATIO`],
//! [`limits::ZIP_RATIO_FLOOR`])) bytes (zip bombs stop at the cap, whatever the header claims);
//! all entries read from one archive together stay under [`limits::MAX_ZIP_TOTAL`]. Encrypted and
//! ZIP64 archives are refused.

use std::cell::Cell;
use std::collections::HashMap;

use crate::error::{CreateError, Result};
use crate::limits;

#[derive(Debug, Clone, Copy)]
struct Entry {
    method: u16,
    csize: usize,
    local: usize,
    encrypted: bool,
}

/// An open archive.
#[derive(Debug)]
pub struct Zip<'a> {
    bytes: &'a [u8],
    entries: HashMap<String, Entry>,
    names: Vec<String>,
    total: Cell<usize>,
}

fn u16_at(b: &[u8], i: usize) -> Result<u16> {
    Ok(u16::from_le_bytes([
        *b.get(i).ok_or_else(|| CreateError::malformed("zip: truncated"))?,
        *b.get(i + 1).ok_or_else(|| CreateError::malformed("zip: truncated"))?,
    ]))
}

fn u32_at(b: &[u8], i: usize) -> Result<u32> {
    Ok(u32::from(u16_at(b, i)?) | (u32::from(u16_at(b, i + 2)?) << 16))
}

/// Normalise a part name: no leading slash, forward slashes, lower case (OPC names are
/// case-insensitive).
pub fn norm(name: &str) -> String {
    name.trim_start_matches('/').replace('\\', "/").to_lowercase()
}

impl<'a> Zip<'a> {
    /// Parse the central directory.
    pub fn open(bytes: &'a [u8]) -> Result<Zip<'a>> {
        limits::check(bytes.len(), limits::MAX_INPUT_BYTES, "zip size")?;
        let min = bytes.len().saturating_sub(22 + 65_535);
        let mut eocd = None;
        let mut i = bytes.len().saturating_sub(22);
        loop {
            if bytes.get(i..i + 4) == Some(b"PK\x05\x06") {
                eocd = Some(i);
                break;
            }
            if i == 0 || i <= min {
                break;
            }
            i -= 1;
        }
        let e = eocd.ok_or_else(|| CreateError::malformed("zip: no end of central directory"))?;
        let count = usize::from(u16_at(bytes, e + 10)?);
        let cd_off = u32_at(bytes, e + 16)? as usize;
        if count == 0xFFFF || cd_off == 0xFFFF_FFFF {
            return Err(CreateError::Unsupported("ZIP64 archives".into()));
        }
        limits::check(count, limits::MAX_ZIP_ENTRIES, "zip entries")?;
        let mut entries = HashMap::with_capacity(count);
        let mut names = Vec::with_capacity(count);
        let mut p = cd_off;
        for _ in 0..count {
            if bytes.get(p..p + 4) != Some(b"PK\x01\x02") {
                return Err(CreateError::malformed("zip: bad central directory"));
            }
            let flags = u16_at(bytes, p + 8)?;
            let method = u16_at(bytes, p + 10)?;
            let csize = u32_at(bytes, p + 20)? as usize;
            let usize_ = u32_at(bytes, p + 24)? as usize;
            let nlen = usize::from(u16_at(bytes, p + 28)?);
            let xlen = usize::from(u16_at(bytes, p + 30)?);
            let clen = usize::from(u16_at(bytes, p + 32)?);
            let local = u32_at(bytes, p + 42)? as usize;
            if csize == 0xFFFF_FFFF || usize_ == 0xFFFF_FFFF || local == 0xFFFF_FFFF {
                return Err(CreateError::Unsupported("ZIP64 archives".into()));
            }
            let name = bytes
                .get(p + 46..p + 46 + nlen)
                .ok_or_else(|| CreateError::malformed("zip: truncated name"))?;
            let name = norm(&String::from_utf8_lossy(name));
            names.push(name.clone());
            entries.insert(
                name,
                Entry {
                    method,
                    csize,
                    local,
                    encrypted: flags & 1 == 1,
                },
            );
            p = p + 46 + nlen + xlen + clen;
        }
        Ok(Zip {
            bytes,
            entries,
            names,
            total: Cell::new(0),
        })
    }

    /// Does the archive contain `name`?
    pub fn has(&self, name: &str) -> bool {
        self.entries.contains_key(&norm(name))
    }

    /// Entry names (normalised).
    pub fn names(&self) -> &[String] {
        &self.names
    }

    /// Read and inflate one entry.
    pub fn read(&self, name: &str) -> Result<Vec<u8>> {
        let e = *self
            .entries
            .get(&norm(name))
            .ok_or_else(|| CreateError::malformed(format!("zip: missing part {name}")))?;
        if e.encrypted {
            return Err(CreateError::Unsupported("encrypted (password-protected) file".into()));
        }
        let b = self.bytes;
        if b.get(e.local..e.local + 4) != Some(b"PK\x03\x04") {
            return Err(CreateError::malformed("zip: bad local header"));
        }
        let nlen = usize::from(u16_at(b, e.local + 26)?);
        let xlen = usize::from(u16_at(b, e.local + 28)?);
        let start = e.local + 30 + nlen + xlen;
        let data = b
            .get(start..start.saturating_add(e.csize))
            .ok_or_else(|| CreateError::malformed("zip: entry out of range"))?;
        let remaining = limits::MAX_ZIP_TOTAL.saturating_sub(self.total.get());
        let cap = e
            .csize
            .saturating_mul(limits::MAX_ZIP_RATIO)
            .max(limits::ZIP_RATIO_FLOOR)
            .min(limits::MAX_ZIP_ENTRY)
            .min(remaining);
        let out = match e.method {
            0 => {
                if data.len() > cap {
                    return Err(CreateError::limit("zip entry too large"));
                }
                data.to_vec()
            }
            8 => miniz_oxide::inflate::decompress_to_vec_with_limit(data, cap).map_err(|err| {
                if matches!(err.status, miniz_oxide::inflate::TINFLStatus::HasMoreOutput) {
                    CreateError::limit(format!("zip entry {name} inflates beyond {cap} bytes"))
                } else {
                    CreateError::malformed(format!("zip entry {name} is damaged"))
                }
            })?,
            m => return Err(CreateError::Unsupported(format!("zip compression method {m}"))),
        };
        self.total.set(self.total.get() + out.len());
        Ok(out)
    }

    /// Read an entry as UTF-8 text (lossy).
    pub fn text(&self, name: &str) -> Result<String> {
        let b = self.read(name)?;
        Ok(super::decode_text(&b))
    }
}

/// Build a zip in memory (stored entries, or deflated with `deflate`) — for tests and fuzz seeds.
pub fn build(entries: &[(&str, &[u8])], deflate: bool) -> Vec<u8> {
    let mut out = Vec::new();
    let mut cd = Vec::new();
    for (name, data) in entries {
        let (method, payload) = if deflate {
            (8u16, miniz_oxide::deflate::compress_to_vec(data, 6))
        } else {
            (0u16, data.to_vec())
        };
        let off = out.len() as u32;
        let hdr = |v: &mut Vec<u8>| {
            v.extend_from_slice(&method.to_le_bytes());
            v.extend_from_slice(&[0, 0, 0, 0]); // time, date
            v.extend_from_slice(&0u32.to_le_bytes()); // crc (not checked)
            v.extend_from_slice(&(payload.len() as u32).to_le_bytes());
            v.extend_from_slice(&(data.len() as u32).to_le_bytes());
            v.extend_from_slice(&(name.len() as u16).to_le_bytes());
            v.extend_from_slice(&0u16.to_le_bytes());
        };
        out.extend_from_slice(b"PK\x03\x04\x14\x00\x00\x00");
        hdr(&mut out);
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(&payload);
        cd.extend_from_slice(b"PK\x01\x02\x14\x00\x14\x00\x00\x00");
        hdr(&mut cd);
        cd.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        cd.extend_from_slice(&off.to_le_bytes());
        cd.extend_from_slice(name.as_bytes());
    }
    let cd_off = out.len() as u32;
    out.extend_from_slice(&cd);
    out.extend_from_slice(b"PK\x05\x06\0\0\0\0");
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(cd.len() as u32).to_le_bytes());
    out.extend_from_slice(&cd_off.to_le_bytes());
    out.extend_from_slice(&[0, 0]);
    out
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    #[test]
    fn stored_and_deflated_entries() {
        for deflate in [false, true] {
            let z = build(&[("Word/Document.xml", b"<w/>"), ("a.txt", "نص".as_bytes())], deflate);
            let zip = Zip::open(&z).unwrap();
            assert!(zip.has("/word/document.xml"));
            assert_eq!(zip.read("word/document.xml").unwrap(), b"<w/>");
            assert_eq!(zip.text("a.txt").unwrap(), "نص");
            assert!(zip.read("missing").is_err());
        }
    }

    #[test]
    fn zip_bomb_stops_at_the_cap() {
        // 64 MiB of zeros deflates to ~64 KiB: ratio ~1000 > 200, above the 1 MiB floor.
        let big = vec![0u8; 64 << 20];
        let z = build(&[("bomb.xml", &big)], true);
        let zip = Zip::open(&z).unwrap();
        assert_eq!(zip.read("bomb.xml").unwrap_err().code(), "limit_exceeded");
    }

    #[test]
    fn garbage_is_an_error() {
        assert!(Zip::open(b"PK\x03\x04garbage").is_err());
        let mut z = build(&[("a", b"x")], false);
        let n = z.len();
        z[n - 6] = 0xFF; // corrupt central directory offset
        assert!(Zip::open(&z).is_err());
    }
}
