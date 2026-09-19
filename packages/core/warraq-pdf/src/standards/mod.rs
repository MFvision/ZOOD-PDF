//! ISO standards for PDF files: PDF/A (ISO 19005, archiving), PDF/X-4
//! (ISO 15930-7, print), a light preflight, and what the accessibility
//! checker shares with them.
//!
//! Each standard here is a converter — a new file, written whole, never an
//! update of the open one — and a validator for the rules Warraq
//! implements, which reports every failure with its clause, page and object.
//! The validators are honest about their reach: `RULES` lists exactly what
//! each one checks. The reference validator for PDF/A is veraPDF (GPL/MPL,
//! Java); it is not bundled, and nothing here claims to replace it.
pub mod fonts;
pub mod icc;
pub mod pdfa;
pub mod pdfx;
pub mod preflight;
pub mod scan;
pub mod xmp;

use lopdf::{Dictionary, Document, Object, ObjectId};

/// One failed rule.
#[derive(Debug, Clone, PartialEq)]
pub struct Finding {
    /// The standard's clause, e.g. `6.2.11.4.1`.
    pub clause: &'static str,
    /// A stable key the interface words the rule by, e.g. `fontNotEmbedded`.
    pub rule: &'static str,
    /// What failed: a font's name, a key, a value.
    pub detail: String,
    /// The page it is on (0-based), when it is on one.
    pub page: Option<usize>,
    /// The object it is in, when it is one.
    pub object: Option<ObjectId>,
}

/// A validator's findings, a bounded number for each rule, and how many
/// there were in all.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Findings {
    pub items: Vec<Finding>,
    pub total: usize,
}

/// Findings of one rule kept in full; past this they are only counted.
const PER_RULE: usize = 25;

impl Findings {
    pub fn push(&mut self, finding: Finding) {
        self.total += 1;
        let same = self.items.iter().filter(|f| f.rule == finding.rule).count();
        let duplicate = self.items.iter().any(|f| {
            f.rule == finding.rule && f.detail == finding.detail && f.page == finding.page
        });
        if same < PER_RULE && !duplicate {
            self.items.push(finding);
        }
    }

    pub fn fail(
        &mut self,
        clause: &'static str,
        rule: &'static str,
        detail: impl Into<String>,
        page: Option<usize>,
        object: Option<ObjectId>,
    ) {
        self.push(Finding {
            clause,
            rule,
            detail: detail.into(),
            page,
            object,
        });
    }

    pub fn passed(&self) -> bool {
        self.total == 0
    }
}

/// Follows a reference, bounded.
pub(crate) fn resolve<'a>(doc: &'a Document, o: &'a Object) -> &'a Object {
    let mut current = o;
    for _ in 0..8 {
        match current {
            Object::Reference(id) => match doc.get_object(*id) {
                Ok(next) => current = next,
                Err(_) => return current,
            },
            _ => return current,
        }
    }
    current
}

pub(crate) fn dict_of<'a>(doc: &'a Document, o: Option<&'a Object>) -> Option<&'a Dictionary> {
    let o = resolve(doc, o?);
    o.as_dict()
        .ok()
        .or_else(|| o.as_stream().ok().map(|s| &s.dict))
}

pub(crate) fn name(o: Option<&Object>) -> Option<&[u8]> {
    o.and_then(|o| o.as_name().ok())
}

/// Every dictionary in `object`, and in dictionaries and arrays nested in
/// it directly, to a bounded depth, allowed to change them.
pub(crate) fn visit_dicts_mut(
    object: &mut Object,
    depth: usize,
    f: &mut dyn FnMut(&mut Dictionary),
) {
    if depth > 32 {
        return;
    }
    match object {
        Object::Dictionary(d) => {
            f(d);
            d.iter_mut()
                .for_each(|(_, v)| visit_dicts_mut(v, depth + 1, f));
        }
        Object::Stream(s) => {
            f(&mut s.dict);
            s.dict
                .iter_mut()
                .for_each(|(_, v)| visit_dicts_mut(v, depth + 1, f));
        }
        Object::Array(a) => a.iter_mut().for_each(|v| visit_dicts_mut(v, depth + 1, f)),
        _ => {}
    }
}

/// Every array in `object`, nested ones included, allowed to change them.
pub(crate) fn visit_arrays_mut(
    object: &mut Object,
    depth: usize,
    f: &mut dyn FnMut(&mut Vec<Object>),
) {
    if depth > 32 {
        return;
    }
    match object {
        Object::Array(a) => {
            f(a);
            a.iter_mut().for_each(|v| visit_arrays_mut(v, depth + 1, f));
        }
        Object::Dictionary(d) => d
            .iter_mut()
            .for_each(|(_, v)| visit_arrays_mut(v, depth + 1, f)),
        Object::Stream(s) => s
            .dict
            .iter_mut()
            .for_each(|(_, v)| visit_arrays_mut(v, depth + 1, f)),
        _ => {}
    }
}

/// A signature over the file: rewriting it whole would break it.
pub(crate) fn is_signed(doc: &Document) -> bool {
    doc.objects.values().any(|object| {
        object.as_dict().is_ok_and(|d| {
            (d.has_type(b"Sig") || d.has_type(b"DocTimeStamp"))
                && (d.has(b"ByteRange") || d.has(b"Contents"))
        })
    })
}

/// Hex of an MD5, for `/ID` and XMP identifiers.
pub(crate) fn md5_hex(bytes: &[u8]) -> (Vec<u8>, String) {
    use md5::{Digest, Md5};
    let digest = Md5::digest(bytes).to_vec();
    let hex = digest.iter().map(|b| format!("{b:02x}")).collect();
    (digest, hex)
}

/// `uuid:` + an MD5 of `seed`, shaped as a UUID.
pub(crate) fn uuid_from(seed: &[u8]) -> String {
    let (_, h) = md5_hex(seed);
    format!(
        "uuid:{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
}
