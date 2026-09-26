//! Minimal ZIP writer (PKWARE APPNOTE 6.3): stored or deflated entries, UTF-8 names, no ZIP64.
//!
//! Enough for OOXML packages (DOCX/XLSX/PPTX) and for bundling PNG pages. Deflate comes from
//! `miniz_oxide`, CRC-32 from `crc32fast`. Entries and total size are bounded ([`MAX_ENTRIES`],
//! [`MAX_TOTAL`]) so a hostile request cannot grow the archive without limit; ZIP64 is never needed
//! under those bounds.

use crate::error::{OfficeError, Result};

/// Maximum entries in one archive.
pub const MAX_ENTRIES: usize = 10_000;
/// Maximum total uncompressed size of the entries (just under 4 GiB, so no ZIP64).
pub const MAX_TOTAL: usize = 1 << 31;

struct Entry {
    name: Vec<u8>,
    crc: u32,
    compressed: u32,
    size: u32,
    method: u16,
    offset: u32,
}

/// Builds a ZIP archive in memory.
#[derive(Default)]
pub struct ZipWriter {
    out: Vec<u8>,
    entries: Vec<Entry>,
    total: usize,
}

/// Fixed DOS date/time (1980-01-01 00:00) so archives are reproducible.
const DOS_TIME: u16 = 0;
const DOS_DATE: u16 = (1 << 5) | 1;

fn u16le(v: &mut Vec<u8>, x: u16) {
    v.extend_from_slice(&x.to_le_bytes());
}
fn u32le(v: &mut Vec<u8>, x: u32) {
    v.extend_from_slice(&x.to_le_bytes());
}

fn to_u32(n: usize) -> Result<u32> {
    u32::try_from(n).map_err(|_| OfficeError::Limit("zip entry size"))
}

impl ZipWriter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Add a file. `deflate = false` stores it (use for already-compressed data such as PNG).
    pub fn add(&mut self, name: &str, data: &[u8], deflate: bool) -> Result<()> {
        if self.entries.len() >= MAX_ENTRIES {
            return Err(OfficeError::Limit("zip entries"));
        }
        self.total = self.total.saturating_add(data.len());
        if self.total > MAX_TOTAL {
            return Err(OfficeError::Limit("zip size"));
        }
        let name = name.trim_start_matches('/').as_bytes().to_vec();
        if name.is_empty() || name.len() > 0xFFFF {
            return Err(OfficeError::Params("zip entry name".into()));
        }
        let crc = crc32fast::hash(data);
        let deflated = if deflate {
            Some(miniz_oxide::deflate::compress_to_vec(data, 6))
        } else {
            None
        };
        let (method, body): (u16, &[u8]) = match &deflated {
            Some(d) if d.len() < data.len() => (8, d.as_slice()),
            _ => (0, data),
        };
        let offset = to_u32(self.out.len())?;
        let o = &mut self.out;
        u32le(o, 0x0403_4b50);
        u16le(o, 20); // version needed
        u16le(o, 1 << 11); // UTF-8 names
        u16le(o, method);
        u16le(o, DOS_TIME);
        u16le(o, DOS_DATE);
        u32le(o, crc);
        u32le(o, to_u32(body.len())?);
        u32le(o, to_u32(data.len())?);
        u16le(o, name.len() as u16);
        u16le(o, 0);
        o.extend_from_slice(&name);
        o.extend_from_slice(body);
        if self.out.len() > u32::MAX as usize {
            return Err(OfficeError::Limit("zip size"));
        }
        self.entries.push(Entry {
            name,
            crc,
            compressed: to_u32(body.len())?,
            size: to_u32(data.len())?,
            method,
            offset,
        });
        Ok(())
    }

    /// Write the central directory and return the archive.
    pub fn finish(mut self) -> Result<Vec<u8>> {
        let cd_start = to_u32(self.out.len())?;
        for e in &self.entries {
            let o = &mut self.out;
            u32le(o, 0x0201_4b50);
            u16le(o, 20); // version made by
            u16le(o, 20);
            u16le(o, 1 << 11);
            u16le(o, e.method);
            u16le(o, DOS_TIME);
            u16le(o, DOS_DATE);
            u32le(o, e.crc);
            u32le(o, e.compressed);
            u32le(o, e.size);
            u16le(o, e.name.len() as u16);
            u16le(o, 0); // extra
            u16le(o, 0); // comment
            u16le(o, 0); // disk
            u16le(o, 0); // internal attrs
            u32le(o, 0); // external attrs
            u32le(o, e.offset);
            o.extend_from_slice(&e.name);
        }
        let cd_size = to_u32(self.out.len())?.saturating_sub(cd_start);
        let n = u16::try_from(self.entries.len()).map_err(|_| OfficeError::Limit("zip entries"))?;
        let o = &mut self.out;
        u32le(o, 0x0605_4b50);
        u16le(o, 0);
        u16le(o, 0);
        u16le(o, n);
        u16le(o, n);
        u32le(o, cd_size);
        u32le(o, cd_start);
        u16le(o, 0);
        Ok(self.out)
    }
}

/// Read a ZIP produced by any writer (stored/deflated entries, bounded). Returns `(name, data)`.
/// Used by tests and by callers that must inspect packages; never trusts sizes blindly.
pub fn read(zip: &[u8], max_total: usize) -> Result<Vec<(String, Vec<u8>)>> {
    let bad = || OfficeError::Params("not a zip archive".into());
    let rd16 = |p: usize| -> Option<u16> {
        zip.get(p..p.checked_add(2)?)
            .and_then(|b| b.try_into().ok())
            .map(u16::from_le_bytes)
    };
    let rd32 = |p: usize| -> Option<u32> {
        zip.get(p..p.checked_add(4)?)
            .and_then(|b| b.try_into().ok())
            .map(u32::from_le_bytes)
    };
    // End of central directory: scan back at most 64 KiB + 22.
    let min = zip.len().saturating_sub(0xFFFF + 22);
    let mut eocd = None;
    let mut p = zip.len().saturating_sub(22);
    loop {
        if rd32(p) == Some(0x0605_4b50) {
            eocd = Some(p);
            break;
        }
        if p <= min {
            break;
        }
        p -= 1;
    }
    let eocd = eocd.ok_or_else(bad)?;
    let n = usize::from(rd16(eocd + 10).ok_or_else(bad)?);
    let mut cd = rd32(eocd + 16).ok_or_else(bad)? as usize;
    let mut out = Vec::new();
    let mut total = 0usize;
    for _ in 0..n.min(MAX_ENTRIES) {
        if rd32(cd) != Some(0x0201_4b50) {
            return Err(bad());
        }
        let method = rd16(cd + 10).ok_or_else(bad)?;
        let csize = rd32(cd + 20).ok_or_else(bad)? as usize;
        let size = rd32(cd + 24).ok_or_else(bad)? as usize;
        let nlen = usize::from(rd16(cd + 28).ok_or_else(bad)?);
        let xlen = usize::from(rd16(cd + 30).ok_or_else(bad)?);
        let clen = usize::from(rd16(cd + 32).ok_or_else(bad)?);
        let off = rd32(cd + 42).ok_or_else(bad)? as usize;
        let name = String::from_utf8_lossy(
            zip.get(cd.saturating_add(46)..cd.saturating_add(46 + nlen))
                .ok_or_else(bad)?,
        )
        .into_owned();
        cd = cd.saturating_add(46 + nlen + xlen + clen);
        let lnlen = usize::from(rd16(off.saturating_add(26)).ok_or_else(bad)?);
        let lxlen = usize::from(rd16(off.saturating_add(28)).ok_or_else(bad)?);
        let start = off.saturating_add(30 + lnlen + lxlen);
        let body = zip
            .get(start..start.saturating_add(csize))
            .ok_or_else(bad)?;
        total = total.saturating_add(size);
        if total > max_total {
            return Err(OfficeError::Limit("zip size"));
        }
        let data = match method {
            0 => body.to_vec(),
            8 => miniz_oxide::inflate::decompress_to_vec_with_limit(body, size.max(1))
                .map_err(|_| bad())?,
            _ => return Err(OfficeError::Params("unsupported zip method".into())),
        };
        out.push((name, data));
    }
    Ok(out)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_stored_and_deflated_entries() {
        let mut z = ZipWriter::new();
        let text = "مرحبا بالعالم ".repeat(200);
        z.add("word/document.xml", text.as_bytes(), true).unwrap();
        z.add("media/a.png", b"\x89PNG....", false).unwrap();
        z.add("ملف.txt", b"x", true).unwrap();
        let bytes = z.finish().unwrap();
        assert!(bytes.len() < text.len(), "deflate applied");
        let entries = read(&bytes, 1 << 20).unwrap();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].0, "word/document.xml");
        assert_eq!(entries[0].1, text.as_bytes());
        assert_eq!(entries[1].1, b"\x89PNG....");
        assert_eq!(entries[2].0, "ملف.txt");
    }

    #[test]
    fn reader_rejects_garbage_without_panicking() {
        for junk in [
            &b""[..],
            b"PK\x05\x06",
            b"PK\x05\x06\0\0\0\0\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\0\0",
        ] {
            assert!(read(junk, 1 << 20).is_err() || read(junk, 1 << 20).unwrap().is_empty());
        }
    }
}
