//! Incremental save: append the changed objects to the ORIGINAL bytes.
//!
//! The brief requires that the file the user opened is never rewritten until
//! they save, and that an edit never corrupts a document it does not fully
//! understand (§15.5). An incremental update is the PDF mechanism for exactly
//! that: the original bytes stay byte-for-byte intact and become the prefix of
//! the new file, so anything we failed to parse survives untouched, and a reader
//! that cannot use our update can still fall back to the previous revision.
use crate::{Error, PdfDocument, Result};
use lopdf::{Dictionary, Object, ObjectId, StringFormat};
use std::collections::BTreeSet;

/// How the previous revision recorded its cross-reference information.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum XrefStyle {
    Table,
    Stream,
}

/// Offset of the last `startxref` value and the style of the section it points at.
pub fn previous_xref(bytes: &[u8]) -> Option<(usize, XrefStyle)> {
    let tail_start = bytes.len().saturating_sub(2048);
    let tail = &bytes[tail_start..];
    let pos = find_last(tail, b"startxref")?;
    let mut i = tail_start + pos + b"startxref".len();
    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    let mut n: usize = 0;
    let mut any = false;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        n = n * 10 + (bytes[i] - b'0') as usize;
        i += 1;
        any = true;
    }
    if !any || n >= bytes.len() {
        return None;
    }
    let style = if bytes[n..].starts_with(b"xref") {
        XrefStyle::Table
    } else {
        XrefStyle::Stream
    };
    Some((n, style))
}

fn find_last(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).rposition(|w| w == needle)
}

/// Write a PDF object. We serialize ourselves rather than reaching into
/// `lopdf`'s private writer, which also lets us guarantee plain decimal reals
/// (PDF forbids exponent notation) and byte-exact stream bodies.
fn write_object(out: &mut Vec<u8>, object: &Object) {
    match object {
        Object::Null => out.extend_from_slice(b"null"),
        Object::Boolean(b) => out.extend_from_slice(if *b { b"true" } else { b"false" }),
        Object::Integer(i) => out.extend_from_slice(i.to_string().as_bytes()),
        Object::Real(r) => out.extend_from_slice(format_real(*r).as_bytes()),
        Object::Name(name) => {
            out.push(b'/');
            for b in name {
                if b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_' | b'+') {
                    out.push(*b);
                } else {
                    out.extend_from_slice(format!("#{b:02X}").as_bytes());
                }
            }
        }
        Object::String(bytes, StringFormat::Hexadecimal) => {
            out.push(b'<');
            out.extend_from_slice(
                bytes
                    .iter()
                    .map(|b| format!("{b:02X}"))
                    .collect::<String>()
                    .as_bytes(),
            );
            out.push(b'>');
        }
        Object::String(bytes, StringFormat::Literal) => {
            out.push(b'(');
            for b in bytes {
                match b {
                    b'(' | b')' | b'\\' => {
                        out.push(b'\\');
                        out.push(*b);
                    }
                    b'\r' => out.extend_from_slice(b"\\r"),
                    _ => out.push(*b),
                }
            }
            out.push(b')');
        }
        Object::Array(items) => {
            out.push(b'[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(b' ');
                }
                write_object(out, item);
            }
            out.push(b']');
        }
        Object::Dictionary(dict) => write_dictionary(out, dict),
        Object::Stream(stream) => {
            let mut dict = stream.dict.clone();
            dict.set("Length", Object::Integer(stream.content.len() as i64));
            write_dictionary(out, &dict);
            out.extend_from_slice(b"\nstream\n");
            out.extend_from_slice(&stream.content);
            out.extend_from_slice(b"\nendstream");
        }
        Object::Reference(id) => out.extend_from_slice(format!("{} {} R", id.0, id.1).as_bytes()),
    }
}

fn write_dictionary(out: &mut Vec<u8>, dict: &Dictionary) {
    out.extend_from_slice(b"<<");
    for (key, value) in dict.iter() {
        out.push(b' ');
        write_object(out, &Object::Name(key.clone()));
        out.push(b' ');
        write_object(out, value);
    }
    out.extend_from_slice(b" >>");
}

/// Plain decimal, never exponent notation, and never a bare trailing dot.
fn format_real(r: f32) -> String {
    if r == r.trunc() && r.abs() < 1e9 {
        return format!("{}", r as i64);
    }
    let s = format!("{r:.5}");
    let s = s.trim_end_matches('0').trim_end_matches('.').to_string();
    if s.is_empty() || s == "-" {
        "0".into()
    } else {
        s
    }
}

fn serialize(id: ObjectId, object: &Object) -> Result<Vec<u8>> {
    let mut out = format!("{} {} obj\n", id.0, id.1).into_bytes();
    write_object(&mut out, object);
    out.extend_from_slice(b"\nendobj\n");
    Ok(out)
}

/// Group ids into consecutive runs, as an xref subsection needs them.
fn runs(ids: &BTreeSet<u32>) -> Vec<(u32, Vec<u32>)> {
    let mut out: Vec<(u32, Vec<u32>)> = vec![];
    for id in ids {
        match out.last_mut() {
            Some((start, v)) if *start + v.len() as u32 == *id => v.push(*id),
            _ => out.push((*id, vec![*id])),
        }
    }
    out
}

impl PdfDocument {
    /// Append the objects changed since `open` to the original bytes.
    ///
    /// An encrypted file stays encrypted: its objects are plaintext in memory,
    /// so each one appended is encrypted again with the file's own key, and the
    /// new trailer names the same `/Encrypt` dictionary — the update opens with
    /// the same passwords and keeps the same permissions. Only a file that
    /// `lopdf`'s handler had to open (no [`crate::crypt::Sealer`]) cannot be
    /// updated, and neither can an original with no usable cross-reference
    /// section; both return `Error::Edit`.
    pub fn save_incremental(&mut self) -> Result<Vec<u8>> {
        if self.was_encrypted && self.sealer.is_none() {
            return Err(Error::Edit(
                "this encrypted document can only be saved as a full rewrite".into(),
            ));
        }
        let (prev, style) = previous_xref(self.original_bytes())
            .ok_or_else(|| Error::Edit("no startxref in the original".into()))?;
        let dirty: BTreeSet<u32> = self.dirty_ids();
        if dirty.is_empty() {
            return Ok(self.original_bytes().to_vec());
        }
        let mut out = self.original_bytes().to_vec();
        if !out.ends_with(b"\n") {
            out.push(b'\n');
        }
        let mut offsets: Vec<(u32, u16, usize)> = vec![];
        for id in &dirty {
            let gen = self
                .doc
                .objects
                .keys()
                .find(|(n, _)| n == id)
                .map(|(_, g)| *g)
                .unwrap_or(0);
            let Ok(object) = self.doc.get_object((*id, gen)) else {
                continue;
            };
            let sealed;
            let object = match &self.sealer {
                Some(sealer) => {
                    sealed = sealer
                        .seal((*id, gen), object)
                        .map_err(|e| Error::Edit(e.to_string()))?;
                    &sealed
                }
                None => object,
            };
            offsets.push((*id, gen, out.len()));
            out.extend_from_slice(&serialize((*id, gen), object)?);
        }
        if offsets.is_empty() {
            return Ok(self.original_bytes().to_vec());
        }
        let written: BTreeSet<u32> = offsets.iter().map(|(id, _, _)| *id).collect();
        let max_id = written.iter().copied().max().unwrap_or(0);
        let size = self.doc.max_id.max(max_id) + 1;
        let mut trailer_refs = self.trailer_refs();
        if let Some(sealer) = &self.sealer {
            let mut entry = Vec::new();
            write_object(&mut entry, sealer.trailer_entry());
            trailer_refs.push_str(" /Encrypt ");
            trailer_refs.push_str(&String::from_utf8_lossy(&entry));
        }
        let xref_offset = out.len();
        match style {
            XrefStyle::Table => {
                out.extend_from_slice(b"xref\n");
                for (start, ids) in runs(&written) {
                    out.extend_from_slice(format!("{} {}\n", start, ids.len()).as_bytes());
                    for id in ids {
                        let (_, gen, off) =
                            offsets.iter().find(|(i, _, _)| *i == id).copied().unwrap();
                        out.extend_from_slice(format!("{off:010} {gen:05} n \n").as_bytes());
                    }
                }
                out.extend_from_slice(format!("trailer\n<< /Size {size}{trailer_refs} /Prev {prev} >>\nstartxref\n{xref_offset}\n%%EOF\n").as_bytes());
            }
            XrefStyle::Stream => {
                // one more object: the cross-reference stream itself
                let xref_id = size;
                let mut rows: Vec<u8> = vec![];
                let mut index: Vec<String> = vec![];
                let mut with_self = written.clone();
                with_self.insert(xref_id);
                for (start, ids) in runs(&with_self) {
                    index.push(format!("{} {}", start, ids.len()));
                    for id in ids {
                        let (off, gen) = if id == xref_id {
                            (xref_offset, 0u16)
                        } else {
                            offsets
                                .iter()
                                .find(|(i, _, _)| *i == id)
                                .map(|(_, g, o)| (*o, *g))
                                .unwrap()
                        };
                        rows.push(1);
                        rows.extend_from_slice(&(off as u32).to_be_bytes());
                        rows.extend_from_slice(&gen.to_be_bytes());
                    }
                }
                let dict = format!(
                    "<< /Type /XRef /Size {} /W [1 4 2] /Index [{}]{} /Prev {} /Length {} >>",
                    xref_id + 1,
                    index.join(" "),
                    trailer_refs,
                    prev,
                    rows.len()
                );
                out.extend_from_slice(format!("{xref_id} 0 obj\n{dict}\nstream\n").as_bytes());
                out.extend_from_slice(&rows);
                out.extend_from_slice(
                    format!("\nendstream\nendobj\nstartxref\n{xref_offset}\n%%EOF\n").as_bytes(),
                );
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const AMIRI: &[u8] = include_bytes!("../../../../tests/fonts/Amiri-Regular.ttf");
    fn corpus(name: &str) -> Vec<u8> {
        std::fs::read(format!(
            "{}/../../../tests/corpus/arabic/generated/{name}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap()
    }

    #[test]
    fn reals_are_written_as_plain_decimals() {
        assert_eq!(format_real(14.0), "14");
        assert_eq!(format_real(-0.5), "-0.5");
        assert_eq!(format_real(1.0e-7), "0");
        assert_eq!(format_real(595.276), "595.276");
    }

    #[test]
    fn objects_round_trip_through_our_serializer() {
        let mut out = vec![];
        write_object(
            &mut out,
            &Object::Array(vec![
                Object::Integer(1),
                Object::Real(2.5),
                Object::Name(b"A B".to_vec()),
                Object::Reference((7, 0)),
                Object::String(b"\xff\x01".to_vec(), StringFormat::Hexadecimal),
            ]),
        );
        assert_eq!(String::from_utf8_lossy(&out), "[1 2.5 /A#20B 7 0 R <FF01>]");
    }

    #[test]
    fn detects_the_previous_xref_style_of_both_corpus_layouts() {
        assert_eq!(
            previous_xref(&corpus("chrome-cairo-mixed-invoice.pdf")).map(|(_, s)| s),
            Some(XrefStyle::Table)
        );
        assert_eq!(
            previous_xref(&corpus("variant-objectstreams-xrefstream.pdf")).map(|(_, s)| s),
            Some(XrefStyle::Stream)
        );
    }

    fn utf16be(text: &str) -> Vec<u8> {
        let mut out = vec![0xFE, 0xFF];
        out.extend(text.encode_utf16().flat_map(u16::to_be_bytes));
        out
    }

    fn set_title(d: &mut PdfDocument, title: &str) {
        let value = Object::String(utf16be(title), StringFormat::Hexadecimal);
        match d.doc.trailer.get(b"Info").and_then(Object::as_reference) {
            Ok(id) => {
                d.doc.get_dictionary_mut(id).unwrap().set("Title", value);
                d.mark_touched(id);
            }
            Err(_) => {
                let id = d.doc.add_object(Dictionary::from_iter([("Title", value)]));
                d.doc.trailer.set("Info", Object::Reference(id));
            }
        }
    }

    /// Every cipher and revision in the corpus: RC4 40 and 128 (R2, R3),
    /// AES-128 (R4, metadata in the clear) and AES-256 (R6), one of them with
    /// an empty user password. The update must be as protected as the file.
    #[test]
    fn an_encrypted_file_stays_encrypted_through_an_incremental_save() {
        let variants = [
            ("variant-encrypted-rc4-40.pdf", "warraq"),
            ("variant-encrypted-rc4-128.pdf", "warraq"),
            ("variant-encrypted-aes128.pdf", "warraq"),
            ("variant-encrypted-aes256.pdf", "warraq"),
            ("variant-encrypted-aes256-owner-only.pdf", ""),
        ];
        let title = "عنوان كتبه وراق في ملف محمي";
        for (name, password) in variants {
            let original = corpus(name);
            let mut d = PdfDocument::open(original.clone(), Some(password)).unwrap();
            crate::ops::append_line(&mut d, 0, "سطر في ملف محمي", AMIRI, 12.0, 300.0, 40.0)
                .unwrap();
            set_title(&mut d, title);
            let bytes = d
                .save_incremental()
                .unwrap_or_else(|e| panic!("{name}: {e}"));
            assert!(
                bytes.starts_with(&original),
                "{name}: the opened bytes stay the prefix"
            );
            let update = &bytes[original.len()..];
            assert!(
                !update.windows(4).any(|w| w == &utf16be(title)[2..6]),
                "{name}: the title is not in the clear"
            );
            if !password.is_empty() {
                assert!(
                    matches!(PdfDocument::open(bytes.clone(), None), Err(Error::Password)),
                    "{name}: still needs its password"
                );
            }
            for key in [password, "warraq-owner"] {
                let back = PdfDocument::open(bytes.clone(), Some(key))
                    .unwrap_or_else(|e| panic!("{name} with {key:?}: {e}"));
                let meta = back.metadata();
                assert!(meta.encrypted, "{name}");
                assert_eq!(meta.title.as_deref(), Some(title), "{name} with {key:?}");
                // The appended content stream decrypts to drawing operators.
                let page = back.doc.get_dictionary(back.page_id(0).unwrap()).unwrap();
                let last = match page.get(b"Contents").unwrap() {
                    Object::Array(items) => items.last().unwrap().as_reference().unwrap(),
                    other => other.as_reference().unwrap(),
                };
                let content = back
                    .doc
                    .get_object(last)
                    .unwrap()
                    .as_stream()
                    .unwrap()
                    .decompressed_content()
                    .unwrap_or_else(|_| {
                        back.doc
                            .get_object(last)
                            .unwrap()
                            .as_stream()
                            .unwrap()
                            .content
                            .clone()
                    });
                assert!(
                    content.windows(2).any(|w| w == b"Tf"),
                    "{name}: the new line's stream reads as operators"
                );
            }
        }
    }

    #[test]
    fn an_incremental_save_keeps_the_original_bytes_as_a_prefix_and_reopens() {
        for name in [
            "chrome-cairo-mixed-invoice.pdf",
            "variant-objectstreams-xrefstream.pdf",
        ] {
            let original = corpus(name);
            let mut d = PdfDocument::open(original.clone(), None).unwrap();
            crate::ops::append_line(
                &mut d,
                0,
                "سطر أضافه وراق بحفظ تزايدي",
                AMIRI,
                12.0,
                540.0,
                40.0,
            )
            .unwrap();
            let bytes = d.save_incremental().unwrap();
            assert!(
                bytes.starts_with(&original),
                "{name}: the original bytes must survive untouched"
            );
            assert!(bytes.len() > original.len());
            let d2 = PdfDocument::open(bytes, None).unwrap();
            assert_eq!(
                d2.page_count(),
                PdfDocument::open(original, None).unwrap().page_count()
            );
            let content = String::from_utf8_lossy(&d2.doc.get_page_content(d2.page_id(0).unwrap()))
                .to_string();
            assert!(
                content.contains("/FW1 12"),
                "{name}: the appended line must be in the reopened revision"
            );
        }
    }

    #[test]
    fn saving_without_edits_returns_the_original_unchanged() {
        let original = corpus("chrome-cairo-mixed-invoice.pdf");
        let mut d = PdfDocument::open(original.clone(), None).unwrap();
        assert_eq!(d.save_incremental().unwrap(), original);
    }
}
