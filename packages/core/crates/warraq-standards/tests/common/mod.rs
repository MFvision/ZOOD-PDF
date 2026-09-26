#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    dead_code
)]
//! Fixture builders for the Standards tests. Every fixture is generated here (no binary files).

use std::collections::BTreeMap;
use std::io::Write;
use warraq_pdf::limits::Limits;
use warraq_pdf::lopdf::{Dictionary, Object, ObjectId, Stream, StringFormat};
use warraq_pdf::writer::{write_new_file, XrefKind};
use warraq_pdf::{Pdf, Protection};
use warraq_standards::convert::{convert_bytes, ConvertOptions};
use warraq_standards::validate::validate_bytes;
use warraq_standards::{Profile, Report};

pub const CAT: ObjectId = (1, 0);
pub const PAGES: ObjectId = (2, 0);

pub fn name(n: &str) -> Object {
    Object::Name(n.as_bytes().to_vec())
}

pub fn lit(s: &str) -> Object {
    Object::String(s.as_bytes().to_vec(), StringFormat::Literal)
}

pub fn arr(v: Vec<Object>) -> Object {
    Object::Array(v)
}

pub fn rect(a: f32, b: f32, c: f32, d: f32) -> Object {
    arr(vec![
        Object::Real(a),
        Object::Real(b),
        Object::Real(c),
        Object::Real(d),
    ])
}

pub fn d(pairs: Vec<(&str, Object)>) -> Dictionary {
    let mut out = Dictionary::new();
    for (k, v) in pairs {
        out.set(k, v);
    }
    out
}

pub fn flate(data: &[u8]) -> Vec<u8> {
    let mut e = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    e.write_all(data).unwrap();
    e.finish().unwrap()
}

/// A tiny PDF builder: catalog 1 0 R, page tree 2 0 R.
pub struct B {
    pub objs: BTreeMap<ObjectId, Object>,
    next: u32,
    pub version: &'static str,
    pub info: Option<ObjectId>,
    kids: Vec<Object>,
}

impl Default for B {
    fn default() -> Self {
        Self::new()
    }
}

impl B {
    pub fn new() -> B {
        let mut objs = BTreeMap::new();
        objs.insert(
            CAT,
            Object::Dictionary(d(vec![
                ("Type", name("Catalog")),
                ("Pages", Object::Reference(PAGES)),
            ])),
        );
        objs.insert(
            PAGES,
            Object::Dictionary(d(vec![
                ("Type", name("Pages")),
                ("Kids", arr(vec![])),
                ("Count", Object::Integer(0)),
            ])),
        );
        B {
            objs,
            next: 3,
            version: "1.7",
            info: None,
            kids: Vec::new(),
        }
    }

    pub fn add(&mut self, o: Object) -> ObjectId {
        let id = (self.next, 0);
        self.next += 1;
        self.objs.insert(id, o);
        id
    }

    pub fn dict(&mut self, id: ObjectId) -> &mut Dictionary {
        match self.objs.get_mut(&id).unwrap() {
            Object::Dictionary(d) => d,
            Object::Stream(s) => &mut s.dict,
            _ => panic!("not a dict"),
        }
    }

    pub fn cat(&mut self) -> &mut Dictionary {
        self.dict(CAT)
    }

    /// A page drawing `content` with `res`.
    pub fn page(&mut self, content: &str, res: Dictionary) -> ObjectId {
        let c = self.add(Object::Stream(Stream::new(
            Dictionary::new(),
            content.as_bytes().to_vec(),
        )));
        let p = self.add(Object::Dictionary(d(vec![
            ("Type", name("Page")),
            ("Parent", Object::Reference(PAGES)),
            ("MediaBox", rect(0.0, 0.0, 595.0, 842.0)),
            ("Resources", Object::Dictionary(res)),
            ("Contents", Object::Reference(c)),
        ])));
        self.kids.push(Object::Reference(p));
        let kids = self.kids.clone();
        let n = kids.len() as i64;
        let pd = self.dict(PAGES);
        pd.set("Kids", arr(kids));
        pd.set("Count", Object::Integer(n));
        p
    }

    pub fn set_info(&mut self, pairs: Vec<(&str, Object)>) {
        let id = self.add(Object::Dictionary(d(pairs)));
        self.info = Some(id);
    }

    pub fn bytes(&self) -> Vec<u8> {
        write_new_file(
            self.version,
            &self.objs,
            CAT,
            self.info,
            None,
            None,
            XrefKind::Table,
            &Limits::default(),
        )
        .unwrap()
    }
}

/// Resources with Helvetica as /F1.
pub fn helvetica_res(b: &mut B) -> Dictionary {
    let f = b.add(Object::Dictionary(d(vec![
        ("Type", name("Font")),
        ("Subtype", name("Type1")),
        ("BaseFont", name("Helvetica")),
    ])));
    d(vec![(
        "Font",
        Object::Dictionary(d(vec![("F1", Object::Reference(f))])),
    )])
}

/// A typical non-conforming "office" document: unembedded Helvetica, DeviceRGB, no metadata.
pub fn office_doc() -> Vec<u8> {
    let mut b = B::new();
    let res = helvetica_res(&mut b);
    b.page("0.2 0.4 0.8 rg 72 600 200 100 re f\nBT /F1 24 Tf 72 720 Td (Hello \\(World\\) \\222quoted\\224) Tj ET\n", res);
    b.set_info(vec![
        ("Title", lit("Quarterly report")),
        ("Author", lit("Ali")),
        ("CreationDate", lit("D:20240102030405+03'00'")),
    ]);
    b.bytes()
}

/// All 12 bundled Liberation fonts.
pub fn liberation() -> Vec<Vec<u8>> {
    let dir = format!(
        "{}/../../../ui/assets/fonts/liberation",
        env!("CARGO_MANIFEST_DIR")
    );
    let mut out = Vec::new();
    for e in std::fs::read_dir(&dir).unwrap_or_else(|e| panic!("{dir}: {e}")) {
        let p = e.unwrap().path();
        if p.extension().is_some_and(|x| x == "ttf") {
            out.push(std::fs::read(p).unwrap());
        }
    }
    assert_eq!(out.len(), 12);
    out
}

pub fn font(ps: &str) -> Vec<u8> {
    let stem = if ps.contains('-') {
        ps.to_string()
    } else {
        format!("{ps}-Regular")
    };
    std::fs::read(format!(
        "{}/../../../ui/assets/fonts/liberation/{stem}.ttf",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap()
}

pub fn opts() -> ConvertOptions {
    ConvertOptions {
        fonts: liberation(),
        now: warraq_standards::xmp::Date::parse_pdf("D:20260925120000+03'00'"),
    }
}

pub fn validate(bytes: &[u8], p: Profile) -> Report {
    validate_bytes(bytes.to_vec(), None, p).unwrap()
}

/// Convert and require zero errors in the output.
pub fn convert_ok(bytes: &[u8], p: Profile) -> Vec<u8> {
    let c = convert_bytes(bytes.to_vec(), None, p, &opts()).unwrap();
    let errors: Vec<_> = c
        .after
        .findings
        .iter()
        .filter(|f| f.severity == warraq_standards::Severity::Error)
        .map(|f| format!("{} {} {:?} {}", f.rule, f.variant, f.params, f.message))
        .collect();
    assert!(
        errors.is_empty(),
        "{p:?} conversion left errors: {errors:#?}"
    );
    c.bytes
}

/// A conforming document for `p` (the converted office document).
pub fn baseline(p: Profile) -> Vec<u8> {
    convert_ok(&office_doc(), p)
}

/// Open, change with `f`, rewrite (same protection).
pub fn mutate(bytes: &[u8], f: impl FnOnce(&mut Pdf)) -> Vec<u8> {
    let mut pdf = Pdf::open(bytes.to_vec(), None).unwrap();
    f(&mut pdf);
    pdf.write_full(Protection::Keep).unwrap()
}

pub fn catalog_mut(pdf: &mut Pdf, f: impl FnOnce(&mut Dictionary)) {
    let root = pdf.root_id().unwrap();
    let mut c = pdf.catalog().unwrap().clone();
    f(&mut c);
    pdf.set(root, Object::Dictionary(c));
}

pub fn first_page(pdf: &Pdf) -> ObjectId {
    warraq_pdf::pages::flatten(pdf).unwrap()[0].id
}

pub fn page_mut(pdf: &mut Pdf, f: impl FnOnce(&mut Dictionary)) {
    let id = first_page(pdf);
    let mut p = pdf.get_dict(id).unwrap().clone();
    f(&mut p);
    pdf.set(id, Object::Dictionary(p));
}

/// Add resources to page 1 (merged into its resource dictionary).
pub fn add_resource(pdf: &mut Pdf, cat: &str, key: &str, value: Object) {
    let id = first_page(pdf);
    let mut p = pdf.get_dict(id).unwrap().clone();
    let mut res = match p.get(b"Resources").unwrap() {
        Object::Dictionary(r) => r.clone(),
        Object::Reference(r) => pdf.get_dict(*r).unwrap().clone(),
        _ => Dictionary::new(),
    };
    let mut sub = match res.get(cat.as_bytes()) {
        Ok(Object::Dictionary(s)) => s.clone(),
        Ok(Object::Reference(r)) => pdf.get_dict(*r).unwrap().clone(),
        _ => Dictionary::new(),
    };
    sub.set(key, value);
    res.set(cat, Object::Dictionary(sub));
    p.set("Resources", Object::Dictionary(res));
    pdf.set(id, Object::Dictionary(p));
}

/// Append content to page 1.
pub fn add_content(pdf: &mut Pdf, ops: &str) {
    let s = pdf.add(Object::Stream(Stream::new(
        Dictionary::new(),
        ops.as_bytes().to_vec(),
    )));
    page_mut(pdf, |p| {
        let mut list = match p.get(b"Contents").unwrap().clone() {
            Object::Array(a) => a,
            o => vec![o],
        };
        list.push(Object::Reference(s));
        p.set("Contents", Object::Array(list));
    });
}

/// Add an annotation to page 1.
pub fn add_annot(pdf: &mut Pdf, a: Dictionary) -> ObjectId {
    let id = pdf.add(Object::Dictionary(a));
    page_mut(pdf, |p| {
        let mut list = match p.get(b"Annots") {
            Ok(Object::Array(a)) => a.clone(),
            _ => vec![],
        };
        list.push(Object::Reference(id));
        p.set("Annots", Object::Array(list));
    });
    id
}

/// Replace the first occurrence of `from` with `to` (same length) in `bytes`.
pub fn patch(bytes: &[u8], from: &[u8], to: &[u8]) -> Vec<u8> {
    assert_eq!(from.len(), to.len(), "patch must keep the length");
    let pos = bytes
        .windows(from.len())
        .position(|w| w == from)
        .unwrap_or_else(|| panic!("{:?} not found", String::from_utf8_lossy(from)));
    let mut out = bytes.to_vec();
    out[pos..pos + to.len()].copy_from_slice(to);
    out
}

pub fn has(r: &Report, rule: &str) -> bool {
    r.has(rule)
}

/// Assert `rule` is reported for `bytes` under `p`, and (when `fixable`) that conversion fixes it.
pub fn check(bytes: &[u8], p: Profile, rule: &str, fixable: bool) {
    let r = validate(bytes, p);
    assert!(
        r.has(rule),
        "{rule} not reported for {p:?}; got {:?}",
        r.counts
    );
    if fixable {
        assert!(
            r.of(rule).any(|f| f.fixable),
            "{rule} should be marked fixable: {:?}",
            r.of(rule).collect::<Vec<_>>()
        );
        let c = convert_bytes(bytes.to_vec(), None, p, &opts()).unwrap();
        assert!(
            !c.after.has(rule),
            "{rule} not fixed for {p:?}: {:?}",
            c.after.of(rule).collect::<Vec<_>>()
        );
        let errors: Vec<_> = c
            .after
            .findings
            .iter()
            .filter(|f| f.severity == warraq_standards::Severity::Error)
            .map(|f| format!("{} {}", f.rule, f.variant))
            .collect();
        assert!(
            errors.is_empty(),
            "{rule}: conversion left errors {errors:?}"
        );
    } else {
        assert!(
            r.of(rule).all(|f| !f.fixable),
            "{rule} should not be marked fixable"
        );
    }
}

/// Minimal LZW encoder (PDF LZWDecode, EarlyChange 1) for fixtures.
pub fn lzw(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut acc: u64 = 0;
    let mut nbits = 0u32;
    let mut put = |code: u32, width: u32, out: &mut Vec<u8>| {
        acc = (acc << width) | u64::from(code);
        nbits += width;
        while nbits >= 8 {
            out.push((acc >> (nbits - 8)) as u8);
            nbits -= 8;
        }
    };
    let mut dict: std::collections::HashMap<Vec<u8>, u32> =
        (0..256u32).map(|i| (vec![i as u8], i)).collect();
    let mut next = 258u32;
    let mut width = 9u32;
    put(256, width, &mut out);
    let mut w: Vec<u8> = Vec::new();
    for &c in data {
        let mut wc = w.clone();
        wc.push(c);
        if dict.contains_key(&wc) {
            w = wc;
        } else {
            put(dict[&w], width, &mut out);
            dict.insert(wc, next);
            next += 1;
            if next + 1 > (1 << width) && width < 12 {
                width += 1;
            }
            if next >= 4094 {
                put(256, width, &mut out);
                dict = (0..256u32).map(|i| (vec![i as u8], i)).collect();
                next = 258;
                width = 9;
            }
            w = vec![c];
        }
    }
    if !w.is_empty() {
        put(dict[&w], width, &mut out);
    }
    put(257, width, &mut out);
    if nbits > 0 {
        out.push((acc << (8 - nbits)) as u8);
    }
    out
}
