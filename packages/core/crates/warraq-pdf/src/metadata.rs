//! Document metadata: the trailer `/Info` dictionary and the catalog's XMP `/Metadata`.

use crate::error::{PdfError, Result};
use crate::limits::decode_stream;
use crate::Pdf;
use lopdf::{Dictionary, Object, Stream, StringFormat};
use std::collections::BTreeMap;

/// Encode a text string: PDFDocEncoding-compatible ASCII as a literal, anything else
/// (Arabic!) as UTF-16BE with BOM.
pub fn encode_text(s: &str) -> Object {
    if s.bytes().all(|b| (0x20..0x7F).contains(&b)) {
        Object::String(s.as_bytes().to_vec(), StringFormat::Literal)
    } else {
        let mut v = vec![0xFE, 0xFF];
        for u in s.encode_utf16() {
            v.extend_from_slice(&u.to_be_bytes());
        }
        Object::String(v, StringFormat::Hexadecimal)
    }
}

/// Decode a text string (UTF-16BE/LE with BOM, UTF-8 with BOM, or PDFDocEncoding).
pub fn decode_text(bytes: &[u8]) -> String {
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(rest).into_owned();
    }
    lopdf::decode_text_string(&Object::String(bytes.to_vec(), StringFormat::Literal))
        .unwrap_or_else(|_| bytes.iter().map(|b| char::from(*b)).collect())
}

fn info_dict(pdf: &Pdf) -> Option<&Dictionary> {
    match pdf.trailer().get(b"Info").ok()? {
        Object::Reference(id) => pdf.get_dict(*id),
        Object::Dictionary(d) => Some(d),
        _ => None,
    }
}

/// All string entries of `/Info`, decoded.
pub fn get_info(pdf: &Pdf) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    if let Some(d) = info_dict(pdf) {
        for (k, v) in d.iter() {
            if let Some(Object::String(s, _)) = pdf.resolve(v) {
                out.insert(String::from_utf8_lossy(k).into_owned(), decode_text(s));
            }
        }
    }
    out
}

/// Set (`Some(non-empty)`) or remove (`None` / empty) `/Info` entries.
pub fn set_info(pdf: &mut Pdf, changes: &BTreeMap<String, Option<String>>) -> Result<()> {
    pdf.require("changing document properties", |p| p.modify)?;
    for k in changes.keys() {
        if k.is_empty() || k.len() > 127 || !k.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return Err(PdfError::InvalidArgument(format!("bad Info key {k:?}")));
        }
    }
    let mut d = info_dict(pdf).cloned().unwrap_or_default();
    for (k, v) in changes {
        match v {
            Some(s) if !s.is_empty() => d.set(k.as_bytes().to_vec(), encode_text(s)),
            _ => {
                d.remove(k.as_bytes());
            }
        }
    }
    match pdf.trailer().get(b"Info") {
        Ok(Object::Reference(id)) if pdf.get(*id).is_some() => {
            let id = *id;
            pdf.set(id, Object::Dictionary(d));
        }
        _ => {
            let id = pdf.add(Object::Dictionary(d));
            pdf.set_trailer("Info", Object::Reference(id));
        }
    }
    Ok(())
}

/// The XMP packet of the catalog's `/Metadata` stream, if any.
pub fn get_xmp(pdf: &Pdf) -> Result<Option<String>> {
    let Ok(m) = pdf.catalog()?.get(b"Metadata") else {
        return Ok(None);
    };
    match pdf.resolve(m) {
        Some(Object::Stream(s)) => {
            let bytes = decode_stream(s, pdf.limits())?;
            Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
        }
        _ => Ok(None),
    }
}

/// Replace the XMP packet (stored uncompressed so it stays readable by indexers).
pub fn set_xmp(pdf: &mut Pdf, xmp: &str) -> Result<()> {
    pdf.require("changing document metadata", |p| p.modify)?;
    let mut sd = Dictionary::new();
    sd.set("Type", Object::Name(b"Metadata".to_vec()));
    sd.set("Subtype", Object::Name(b"XML".to_vec()));
    let stream = Object::Stream(Stream::new(sd, xmp.as_bytes().to_vec()));
    let root = pdf.root_id()?;
    let existing = match pdf.catalog()?.get(b"Metadata") {
        Ok(Object::Reference(id)) if matches!(pdf.get(*id), Some(Object::Stream(_))) => Some(*id),
        _ => None,
    };
    match existing {
        Some(id) => pdf.set(id, stream),
        None => {
            let id = pdf.add(stream);
            let mut cat = pdf.catalog()?.clone();
            cat.set("Metadata", Object::Reference(id));
            pdf.set(root, Object::Dictionary(cat));
        }
    }
    Ok(())
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// A minimal XMP packet mirroring the main Info fields (Dublin Core + PDF schema).
pub fn xmp_from_info(info: &BTreeMap<String, String>) -> String {
    let get = |k: &str| info.get(k).map(|v| xml_escape(v));
    let mut body = String::new();
    if let Some(t) = get("Title") {
        body.push_str(&format!(
            "<dc:title><rdf:Alt><rdf:li xml:lang=\"x-default\">{t}</rdf:li></rdf:Alt></dc:title>"
        ));
    }
    if let Some(a) = get("Author") {
        body.push_str(&format!(
            "<dc:creator><rdf:Seq><rdf:li>{a}</rdf:li></rdf:Seq></dc:creator>"
        ));
    }
    if let Some(s) = get("Subject") {
        body.push_str(&format!(
            "<dc:description><rdf:Alt><rdf:li xml:lang=\"x-default\">{s}</rdf:li></rdf:Alt></dc:description>"
        ));
    }
    if let Some(k) = get("Keywords") {
        body.push_str(&format!("<pdf:Keywords>{k}</pdf:Keywords>"));
    }
    if let Some(p) = get("Producer") {
        body.push_str(&format!("<pdf:Producer>{p}</pdf:Producer>"));
    }
    if let Some(c) = get("Creator") {
        body.push_str(&format!("<xmp:CreatorTool>{c}</xmp:CreatorTool>"));
    }
    format!(
        "<?xpacket begin=\"\u{feff}\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description rdf:about=\"\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:pdf=\"http://ns.adobe.com/pdf/1.3/\" xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\">{body}</rdf:Description></rdf:RDF></x:xmpmeta>\n<?xpacket end=\"w\"?>"
    )
}
