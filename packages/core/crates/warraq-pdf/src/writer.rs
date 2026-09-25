//! Cross-reference sections, trailers and whole-file writing.

use crate::crypt::{random_bytes, SecurityHandler};
use crate::error::{PdfError, Result};
use crate::limits::Limits;
use crate::serialize::{write_indirect, write_object};
use lopdf::{Dictionary, Object, ObjectId, Stream, StringFormat};
use std::collections::BTreeMap;
use std::io::Write;

/// Which cross-reference form a file (or its latest section) uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum XrefKind {
    /// Classic `xref` table + `trailer` dictionary.
    Table,
    /// Cross-reference stream (PDF 1.5+).
    Stream,
}

/// One cross-reference entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum XrefRow {
    /// In use at byte offset with generation.
    InUse(usize, u16),
    /// Free: next free object number, generation for re-use.
    Free(u32, u16),
}

/// Group sorted object numbers into `(start, count)` subsections.
fn subsections(rows: &BTreeMap<u32, XrefRow>) -> Vec<(u32, Vec<XrefRow>)> {
    let mut out: Vec<(u32, Vec<XrefRow>)> = Vec::new();
    for (&n, &row) in rows {
        match out.last_mut() {
            Some((start, v)) if *start as usize + v.len() == n as usize => v.push(row),
            _ => out.push((n, vec![row])),
        }
    }
    out
}

/// Append a classic `xref` table and `trailer`, then `startxref`/`%%EOF`.
pub fn write_xref_table(
    out: &mut Vec<u8>,
    rows: &BTreeMap<u32, XrefRow>,
    trailer: &Dictionary,
) -> Result<()> {
    let xref_off = out.len();
    out.extend_from_slice(b"xref\n");
    for (start, rows) in subsections(rows) {
        let _ = writeln!(out, "{} {}", start, rows.len());
        for r in rows {
            match r {
                XrefRow::InUse(off, gen) => {
                    let _ = write!(out, "{:010} {:05} n\r\n", off, gen);
                }
                XrefRow::Free(next, gen) => {
                    let _ = write!(out, "{:010} {:05} f\r\n", next, gen);
                }
            }
        }
    }
    out.extend_from_slice(b"trailer\n");
    write_object(out, &Object::Dictionary(trailer.clone()))?;
    let _ = write!(out, "\nstartxref\n{}\n%%EOF\n", xref_off);
    Ok(())
}

/// Append a cross-reference stream object `xref_id` (its own row is added here), then
/// `startxref`/`%%EOF`. `trailer` supplies Root/Info/ID/Encrypt/Prev/Size.
pub fn write_xref_stream(
    out: &mut Vec<u8>,
    rows: &BTreeMap<u32, XrefRow>,
    trailer: &Dictionary,
    xref_id: ObjectId,
) -> Result<()> {
    let xref_off = out.len();
    let mut rows = rows.clone();
    rows.insert(xref_id.0, XrefRow::InUse(xref_off, xref_id.1));
    let max_off = rows
        .values()
        .map(|r| match r {
            XrefRow::InUse(o, _) => *o as u64,
            XrefRow::Free(n, _) => u64::from(*n),
        })
        .max()
        .unwrap_or(0);
    let mut w2 = 1usize;
    while w2 < 8 && max_off >> (8 * w2) != 0 {
        w2 += 1;
    }
    let mut data = Vec::with_capacity(rows.len() * (3 + w2));
    let mut index = Vec::new();
    for (start, sub) in subsections(&rows) {
        index.push(Object::Integer(i64::from(start)));
        index.push(Object::Integer(sub.len() as i64));
        for r in sub {
            let (t, a, b) = match r {
                XrefRow::InUse(o, g) => (1u8, o as u64, g),
                XrefRow::Free(n, g) => (0u8, u64::from(n), g),
            };
            data.push(t);
            let be = a.to_be_bytes();
            data.extend_from_slice(be.get(8 - w2..).unwrap_or(&be));
            data.extend_from_slice(&b.to_be_bytes());
        }
    }
    let mut enc = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    enc.write_all(&data)
        .map_err(|e| PdfError::Structure(format!("compress xref: {e}")))?;
    let compressed = enc
        .finish()
        .map_err(|e| PdfError::Structure(format!("compress xref: {e}")))?;
    let mut dict = trailer.clone();
    dict.set("Type", Object::Name(b"XRef".to_vec()));
    let size = trailer
        .get(b"Size")
        .and_then(Object::as_i64)
        .unwrap_or(0)
        .max(i64::from(xref_id.0) + 1);
    dict.set("Size", Object::Integer(size));
    dict.set("Index", Object::Array(index));
    dict.set(
        "W",
        Object::Array(vec![
            Object::Integer(1),
            Object::Integer(w2 as i64),
            Object::Integer(2),
        ]),
    );
    dict.set("Filter", Object::Name(b"FlateDecode".to_vec()));
    write_indirect(out, xref_id, &Object::Stream(Stream::new(dict, compressed)))?;
    let _ = write!(out, "startxref\n{}\n%%EOF\n", xref_off);
    Ok(())
}

/// A fresh random `/ID` element.
pub fn new_id_element() -> Result<Object> {
    let r: [u8; 16] = random_bytes()?;
    Ok(Object::String(r.to_vec(), StringFormat::Hexadecimal))
}

/// Write a complete new file from `objects` (plaintext). Used by the full-rewrite path and
/// by the sample builders.
#[allow(clippy::too_many_arguments)]
pub fn write_new_file(
    version: &str,
    objects: &BTreeMap<ObjectId, Object>,
    root: ObjectId,
    info: Option<ObjectId>,
    id: Option<(Object, Object)>,
    security: Option<&SecurityHandler>,
    kind: XrefKind,
    limits: &Limits,
) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    let _ = writeln!(out, "%PDF-{}", version);
    // Binary marker: four raw bytes >= 128 so transfer tools treat the file as binary.
    out.extend_from_slice(&[b'%', 0xE2, 0xE3, 0xCF, 0xD3, b'\n']);
    let mut rows = BTreeMap::new();
    rows.insert(0u32, XrefRow::Free(0, 65535));
    let mut max_num = 0u32;
    for (&oid, obj) in objects {
        let off = out.len();
        if let Some(sec) = security {
            let mut o = obj.clone();
            sec.encrypt_object(oid, &mut o, limits)?;
            write_indirect(&mut out, oid, &o)?;
        } else {
            write_indirect(&mut out, oid, obj)?;
        }
        rows.insert(oid.0, XrefRow::InUse(off, oid.1));
        max_num = max_num.max(oid.0);
    }
    let mut trailer = Dictionary::new();
    let mut next = max_num + 1;
    if let Some(sec) = security {
        let enc_id = (next, 0);
        next += 1;
        let off = out.len();
        write_indirect(&mut out, enc_id, &Object::Dictionary(sec.dict.clone()))?;
        rows.insert(enc_id.0, XrefRow::InUse(off, 0));
        trailer.set("Encrypt", Object::Reference(enc_id));
    }
    trailer.set("Root", Object::Reference(root));
    if let Some(i) = info {
        trailer.set("Info", Object::Reference(i));
    }
    let (a, b) = match id {
        Some(p) => p,
        None => {
            let x = new_id_element()?;
            (x.clone(), x)
        }
    };
    trailer.set("ID", Object::Array(vec![a, b]));
    match kind {
        XrefKind::Table => {
            trailer.set("Size", Object::Integer(i64::from(next)));
            write_xref_table(&mut out, &rows, &trailer)?;
        }
        XrefKind::Stream => {
            trailer.set("Size", Object::Integer(i64::from(next) + 1));
            write_xref_stream(&mut out, &rows, &trailer, (next, 0))?;
        }
    }
    Ok(out)
}
