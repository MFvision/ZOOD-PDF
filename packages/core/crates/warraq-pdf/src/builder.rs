//! Small generated documents: blank documents for "extract"/"merge", and sample files used
//! by tests, fuzz seeds and the wasm smoke test.

use crate::crypt::SecurityHandler;
use crate::error::Result;
use crate::limits::Limits;
use crate::writer::{write_new_file, XrefKind};
use lopdf::{Dictionary, Object, ObjectId, Stream, StringFormat};
use std::collections::BTreeMap;

/// Options for [`sample_pdf`].
#[derive(Debug, Clone, Default)]
pub struct SampleOptions {
    /// Write a cross-reference stream instead of a table.
    pub xref_stream: bool,
    /// Flate-compress the page content streams.
    pub compress: bool,
    /// Encrypt the output with this handler.
    pub security: Option<SecurityHandler>,
    /// `/Title` in the Info dictionary.
    pub title: Option<String>,
    /// Add one text annotation to page 1.
    pub with_annotation: bool,
    /// First `/ID` element (R2–R4 keys depend on it; must match the handler's `id0`).
    pub id0: Option<Vec<u8>>,
}

fn name(n: &str) -> Object {
    Object::Name(n.as_bytes().to_vec())
}

fn real_box(w: f32, h: f32) -> Object {
    Object::Array(vec![
        Object::Integer(0),
        Object::Integer(0),
        Object::Real(w),
        Object::Real(h),
    ])
}

/// A document with `pages` A4 pages, each showing "Page N" and a filled rectangle.
pub fn sample_pdf(pages: usize, opts: &SampleOptions) -> Result<Vec<u8>> {
    let mut objects: BTreeMap<ObjectId, Object> = BTreeMap::new();
    let catalog: ObjectId = (1, 0);
    let pages_id: ObjectId = (2, 0);
    let font: ObjectId = (3, 0);
    let info: ObjectId = (4, 0);
    let mut next = 5u32;
    let mut font_d = Dictionary::new();
    font_d.set("Type", name("Font"));
    font_d.set("Subtype", name("Type1"));
    font_d.set("BaseFont", name("Helvetica"));
    objects.insert(font, Object::Dictionary(font_d));
    let mut kids = Vec::new();
    for i in 0..pages {
        let page: ObjectId = (next, 0);
        let content: ObjectId = (next + 1, 0);
        next += 2;
        let ops = format!(
            "0.2 0.4 0.8 rg 72 600 200 100 re f\nBT /F1 24 Tf 72 720 Td (Page {}) Tj ET\n",
            i + 1
        );
        let mut st = Stream::new(Dictionary::new(), ops.into_bytes());
        if opts.compress {
            let _ = st.compress();
        }
        objects.insert(content, Object::Stream(st));
        let mut res = Dictionary::new();
        let mut fonts = Dictionary::new();
        fonts.set("F1", Object::Reference(font));
        res.set("Font", Object::Dictionary(fonts));
        let mut p = Dictionary::new();
        p.set("Type", name("Page"));
        p.set("Parent", Object::Reference(pages_id));
        p.set("Resources", Object::Dictionary(res));
        p.set("Contents", Object::Reference(content));
        if i == 0 && opts.with_annotation {
            let annot: ObjectId = (next, 0);
            next += 1;
            let mut a = Dictionary::new();
            a.set("Type", name("Annot"));
            a.set("Subtype", name("Text"));
            a.set(
                "Rect",
                Object::Array(vec![100.into(), 100.into(), 120.into(), 120.into()]),
            );
            a.set("Contents", Object::string_literal("original note"));
            a.set("P", Object::Reference(page));
            objects.insert(annot, Object::Dictionary(a));
            p.set("Annots", Object::Array(vec![Object::Reference(annot)]));
        }
        objects.insert(page, Object::Dictionary(p));
        kids.push(Object::Reference(page));
    }
    let mut pd = Dictionary::new();
    pd.set("Type", name("Pages"));
    pd.set("Count", Object::Integer(pages as i64));
    pd.set("Kids", Object::Array(kids));
    pd.set("MediaBox", real_box(595.0, 842.0));
    objects.insert(pages_id, Object::Dictionary(pd));
    let mut cat = Dictionary::new();
    cat.set("Type", name("Catalog"));
    cat.set("Pages", Object::Reference(pages_id));
    objects.insert(catalog, Object::Dictionary(cat));
    let mut inf = Dictionary::new();
    if let Some(t) = &opts.title {
        inf.set(
            "Title",
            Object::String(t.clone().into_bytes(), StringFormat::Literal),
        );
    }
    inf.set("Producer", Object::string_literal("ZOOD PDF"));
    objects.insert(info, Object::Dictionary(inf));
    write_new_file(
        if opts.xref_stream { "1.7" } else { "1.4" },
        &objects,
        catalog,
        Some(info),
        opts.id0.as_ref().map(|i| {
            let o = Object::String(i.clone(), StringFormat::Hexadecimal);
            (o.clone(), o)
        }),
        opts.security.as_ref(),
        if opts.xref_stream {
            XrefKind::Stream
        } else {
            XrefKind::Table
        },
        &Limits::default(),
    )
}

/// A valid document with an empty page tree (used as the base for extract/merge).
pub fn empty_pdf() -> Result<Vec<u8>> {
    sample_pdf(0, &SampleOptions::default())
}
