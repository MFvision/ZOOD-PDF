//! The PDF side of digital signatures (ISO 32000-2 §12.8): signature
//! fields, the signature dictionary with room for a signature to be written
//! into, validation data (`/DSS`), and reading back what a file's signatures
//! cover and what changed after them. The cryptography is `warraq-sign`'s.
//!
//! A signature is always an incremental update: the bytes before it stay as
//! they are, the new objects are appended, and `/ByteRange` covers the whole
//! file but the hole where the signature goes. An encrypted file stays
//! encrypted — the update is sealed with its own key, and `/Contents` is left
//! in the clear, as the standard requires (`crate::crypt`).
use std::collections::{BTreeMap, BTreeSet, VecDeque};

use lopdf::content::{Content, Operation};
use lopdf::{dictionary, Dictionary, Object, ObjectId, Stream, StringFormat};
use warraq_text::{base_direction, Direction, ShapedGlyph, Shaper};

use crate::document::decode_text_string;
use crate::fonts::{embed_subset_font, FontSubset};
use crate::show::{show_line, ShownLine};
use crate::{Error, PdfDocument, Result};

/// What the ByteRange is written as before the offsets are known: ten digits
/// each, so the real numbers fit in the same bytes.
const BYTE_RANGE_PLACEHOLDER: &str = "[0 9999999999 9999999999 9999999999]";
const PLACEHOLDER: i64 = 9_999_999_999;
/// Signature field flags: SignaturesExist | AppendOnly (table 225).
const SIG_FLAGS: i64 = 3;
/// Annotation flags Print | Locked.
const WIDGET_FLAGS: i64 = 4 | 128;

/// What kind of signature is added.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SigKind {
    /// An approval signature (the usual kind).
    Approval,
    /// A certification signature, with the changes it permits afterwards
    /// (DocMDP `/P`: 1 none, 2 filling forms and signing, 3 also comments).
    Certification(u8),
    /// A document timestamp (PAdES B-LTA): `/Type /DocTimeStamp`.
    DocTimeStamp,
}

/// A picture of a handwritten signature, RGBA, row by row.
#[derive(Debug, Clone)]
pub struct SigImage {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// What a visible signature shows.
pub struct SigAppearance<'a> {
    /// Lines of text, the first the signer's name; Arabic is shaped.
    pub lines: Vec<String>,
    /// The face to draw them in (a bundled one: Amiri).
    pub font: &'a [u8],
    pub image: Option<SigImage>,
}

pub struct SignatureSpec<'a> {
    /// An existing, unsigned signature field to sign, by its full name;
    /// otherwise a new field is added.
    pub field: Option<String>,
    pub page: usize,
    /// Where it shows, in points from the page's top-left corner as the page
    /// is shown (after `/Rotate`); `None` for an invisible signature.
    pub rect: Option<[f32; 4]>,
    pub appearance: Option<SigAppearance<'a>>,
    pub name: Option<String>,
    pub reason: Option<String>,
    pub location: Option<String>,
    pub contact: Option<String>,
    /// `/M`, a PDF date.
    pub time: Option<String>,
    pub sub_filter: &'a str,
    pub kind: SigKind,
    /// Lock every form field once signed (FieldMDP `/Action /All`).
    pub lock_fields: bool,
    /// Bytes reserved for the signature.
    pub contents_size: usize,
}

/// A file with room for its signature: sign `[0, start) ∪ [end, len)`, then
/// write the signature into the gap with [`Prepared::embed`].
#[derive(Debug, Clone)]
pub struct Prepared {
    pub bytes: Vec<u8>,
    /// Offset of `<`, and just past `>`, of `/Contents`.
    pub start: usize,
    pub end: usize,
}

impl Prepared {
    pub fn byte_range(&self) -> [usize; 4] {
        [0, self.start, self.end, self.bytes.len() - self.end]
    }

    /// The two signed ranges.
    pub fn signed_parts(&self) -> [&[u8]; 2] {
        [&self.bytes[..self.start], &self.bytes[self.end..]]
    }

    /// The largest signature that fits.
    pub fn capacity(&self) -> usize {
        (self.end - self.start - 2) / 2
    }

    /// Writes `signature` (DER) into the gap, in hex, zero-padded.
    pub fn embed(&mut self, signature: &[u8]) -> Result<()> {
        if signature.len() > self.capacity() {
            return Err(Error::Edit(format!(
                "E_SIGN_SPACE: the signature ({} bytes) does not fit the {} reserved",
                signature.len(),
                self.capacity()
            )));
        }
        let hex: Vec<u8> = signature
            .iter()
            .flat_map(|b| format!("{b:02X}").into_bytes())
            .collect();
        self.bytes[self.start + 1..self.start + 1 + hex.len()].copy_from_slice(&hex);
        Ok(())
    }

    /// Finds the last signature placeholder in `bytes` — a file prepared
    /// earlier and handed back by the host, while a timestamp was fetched.
    pub fn find(bytes: Vec<u8>) -> Result<Self> {
        let at = rfind(&bytes, b"/ByteRange [0 ")
            .ok_or_else(|| Error::Edit("no prepared signature".into()))?;
        let close = bytes[at..]
            .iter()
            .position(|b| *b == b']')
            .map(|p| at + p)
            .ok_or_else(|| Error::Edit("no prepared signature".into()))?;
        let text = String::from_utf8_lossy(&bytes[at + b"/ByteRange [".len()..close]).into_owned();
        let numbers: Vec<usize> = text
            .split_whitespace()
            .filter_map(|n| n.parse().ok())
            .collect();
        let [0, start, end, rest] = numbers[..] else {
            return Err(Error::Edit("a malformed prepared signature".into()));
        };
        if end > bytes.len()
            || start >= end
            || end + rest != bytes.len()
            || bytes[start] != b'<'
            || bytes[end - 1] != b'>'
        {
            return Err(Error::Edit("a malformed prepared signature".into()));
        }
        if bytes[start + 1..end - 1].iter().any(|b| *b != b'0') {
            return Err(Error::Edit("the file is already signed there".into()));
        }
        Ok(Self { bytes, start, end })
    }
}

fn find_from(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    haystack
        .get(from..)?
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|p| p + from)
}

fn rfind(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).rposition(|w| w == needle)
}

/// A PDF text string: plain when it is ASCII, UTF-16BE otherwise.
pub(crate) fn text_string(text: &str) -> Object {
    if text.is_ascii() {
        Object::String(text.as_bytes().to_vec(), StringFormat::Literal)
    } else {
        let mut bytes = vec![0xFE, 0xFF];
        bytes.extend(text.encode_utf16().flat_map(u16::to_be_bytes));
        Object::String(bytes, StringFormat::Hexadecimal)
    }
}

/// A signature field, signed or not.
#[derive(Debug, Clone)]
pub struct SigField {
    /// Its full name (`parent.child`).
    pub name: String,
    pub field: ObjectId,
    /// The widget that shows it, and the page (0-based) it is on.
    pub widget: Option<ObjectId>,
    pub page: Option<usize>,
    pub rect: Option<[f32; 4]>,
    /// The signature dictionary, when signed.
    pub value: Option<SigDict>,
    /// Fields its `/Lock` locks once signed: `None` no lock, empty all.
    pub lock: Option<Vec<String>>,
}

/// What a signature dictionary says about itself. `/Contents` is read from
/// the file's bytes at the hole `/ByteRange` leaves, not from here.
#[derive(Debug, Clone, Default)]
pub struct SigDict {
    pub id: Option<ObjectId>,
    pub doc_timestamp: bool,
    pub filter: String,
    pub sub_filter: String,
    pub byte_range: Vec<i64>,
    pub name: Option<String>,
    pub reason: Option<String>,
    pub location: Option<String>,
    pub contact: Option<String>,
    /// `/M` as written.
    pub time: Option<String>,
    /// DocMDP `/P`, for a certification signature.
    pub doc_mdp: Option<u8>,
    /// FieldMDP: `None` no lock; `Some(all, include, exclude)`.
    pub field_mdp: Option<FieldLock>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FieldLock {
    All,
    Include(Vec<String>),
    Exclude(Vec<String>),
}

impl FieldLock {
    pub fn locks(&self, field: &str) -> bool {
        match self {
            FieldLock::All => true,
            FieldLock::Include(names) => names.iter().any(|n| n == field),
            FieldLock::Exclude(names) => !names.iter().any(|n| n == field),
        }
    }
}

impl PdfDocument {
    fn deref_obj<'a>(&'a self, o: &'a Object) -> &'a Object {
        match o {
            Object::Reference(id) => self.doc.get_object(*id).unwrap_or(o),
            _ => o,
        }
    }

    fn catalog_id(&self) -> Result<ObjectId> {
        self.doc
            .trailer
            .get(b"Root")
            .and_then(Object::as_reference)
            .map_err(|e| Error::Parse(format!("no catalog: {e}")))
    }

    fn text_of(&self, dict: &Dictionary, key: &[u8]) -> Option<String> {
        match self.deref_obj(dict.get(key).ok()?) {
            Object::String(bytes, _) => Some(decode_text_string(bytes)),
            Object::Name(n) => Some(String::from_utf8_lossy(n).into_owned()),
            _ => None,
        }
    }

    fn names_of(&self, o: Option<&Object>) -> Vec<String> {
        o.map(|o| self.deref_obj(o))
            .and_then(|o| o.as_array().ok())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|i| match self.deref_obj(i) {
                        Object::String(b, _) => Some(decode_text_string(b)),
                        _ => None,
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    fn lock_of(&self, dict: &Dictionary) -> Option<FieldLock> {
        let action = dict.get(b"Action").ok().map(|a| self.deref_obj(a))?;
        let fields = self.names_of(dict.get(b"Fields").ok());
        Some(match action.as_name().ok()? {
            b"Include" => FieldLock::Include(fields),
            b"Exclude" => FieldLock::Exclude(fields),
            _ => FieldLock::All,
        })
    }

    /// Reads a signature dictionary.
    pub fn sig_dict(&self, id: Option<ObjectId>, dict: &Dictionary) -> SigDict {
        let mut out = SigDict {
            id,
            doc_timestamp: dict.has_type(b"DocTimeStamp"),
            filter: self.text_of(dict, b"Filter").unwrap_or_default(),
            sub_filter: self.text_of(dict, b"SubFilter").unwrap_or_default(),
            byte_range: dict
                .get(b"ByteRange")
                .ok()
                .map(|o| self.deref_obj(o))
                .and_then(|o| o.as_array().ok())
                .map(|a| {
                    a.iter()
                        .filter_map(|n| self.deref_obj(n).as_i64().ok())
                        .collect()
                })
                .unwrap_or_default(),
            name: self.text_of(dict, b"Name"),
            reason: self.text_of(dict, b"Reason"),
            location: self.text_of(dict, b"Location"),
            contact: self.text_of(dict, b"ContactInfo"),
            time: self.text_of(dict, b"M"),
            ..SigDict::default()
        };
        let refs = dict
            .get(b"Reference")
            .ok()
            .map(|r| self.deref_obj(r))
            .and_then(|r| r.as_array().ok())
            .cloned()
            .unwrap_or_default();
        for r in refs.iter().take(16) {
            let Ok(r) = self.deref_obj(r).as_dict() else {
                continue;
            };
            let params = r
                .get(b"TransformParams")
                .ok()
                .map(|p| self.deref_obj(p))
                .and_then(|p| p.as_dict().ok());
            match r
                .get(b"TransformMethod")
                .ok()
                .and_then(|m| m.as_name().ok())
            {
                Some(b"DocMDP") => {
                    let p = params
                        .and_then(|p| p.get(b"P").ok())
                        .and_then(|p| self.deref_obj(p).as_i64().ok())
                        .unwrap_or(2);
                    out.doc_mdp = Some(p.clamp(1, 3) as u8);
                }
                Some(b"FieldMDP") => out.field_mdp = params.and_then(|p| self.lock_of(p)),
                _ => {}
            }
        }
        out
    }

    /// The page each annotation is on.
    fn annotation_pages(&self) -> BTreeMap<ObjectId, usize> {
        let mut out = BTreeMap::new();
        for (i, page) in self.pages.iter().enumerate() {
            let Ok(dict) = self.doc.get_dictionary(*page) else {
                continue;
            };
            if let Some(Object::Array(items)) = dict.get(b"Annots").ok().map(|a| self.deref_obj(a))
            {
                for item in items {
                    if let Ok(id) = item.as_reference() {
                        out.entry(id).or_insert(i);
                    }
                }
            }
        }
        out
    }

    /// Every signature field in the form, signed or not, in field order.
    pub fn signature_fields(&self) -> Vec<SigField> {
        let mut out = Vec::new();
        let Ok(catalog) = self.catalog_id().and_then(|id| {
            self.doc
                .get_dictionary(id)
                .map_err(|e| Error::Parse(e.to_string()))
        }) else {
            return out;
        };
        let Some(form) = catalog
            .get(b"AcroForm")
            .ok()
            .map(|f| self.deref_obj(f))
            .and_then(|f| f.as_dict().ok())
        else {
            return out;
        };
        let pages = self.annotation_pages();
        let roots: Vec<Object> = form
            .get(b"Fields")
            .ok()
            .map(|f| self.deref_obj(f))
            .and_then(|f| f.as_array().ok())
            .cloned()
            .unwrap_or_default();
        // (field, name so far, inherited /FT)
        let mut stack: Vec<(ObjectId, String, Option<Vec<u8>>, usize)> = roots
            .iter()
            .rev()
            .filter_map(|r| r.as_reference().ok())
            .map(|id| (id, String::new(), None, 0))
            .collect();
        let mut seen = BTreeSet::new();
        while let Some((id, prefix, inherited, depth)) = stack.pop() {
            if depth > 32 || !seen.insert(id) || seen.len() > 100_000 {
                continue;
            }
            let Ok(dict) = self.doc.get_dictionary(id) else {
                continue;
            };
            let partial = self.text_of(dict, b"T");
            let name = match (&partial, prefix.is_empty()) {
                (Some(t), true) => t.clone(),
                (Some(t), false) => format!("{prefix}.{t}"),
                (None, _) => prefix.clone(),
            };
            let ft = dict
                .get(b"FT")
                .ok()
                .and_then(|f| f.as_name().ok())
                .map(|n| n.to_vec())
                .or(inherited);
            let kids: Vec<ObjectId> = dict
                .get(b"Kids")
                .ok()
                .map(|k| self.deref_obj(k))
                .and_then(|k| k.as_array().ok())
                .map(|k| k.iter().filter_map(|k| k.as_reference().ok()).collect())
                .unwrap_or_default();
            // Kids that are fields (they have a name) make this a node;
            // kids that are only widgets make it a terminal field.
            let field_kids: Vec<ObjectId> = kids
                .iter()
                .copied()
                .filter(|k| self.doc.get_dictionary(*k).is_ok_and(|d| d.has(b"T")))
                .collect();
            if !field_kids.is_empty() {
                for k in field_kids.into_iter().rev() {
                    stack.push((k, name.clone(), ft.clone(), depth + 1));
                }
                continue;
            }
            if ft.as_deref() != Some(b"Sig") {
                continue;
            }
            let widget = if dict.has_type(b"Annot")
                || dict.get(b"Subtype").ok().and_then(|s| s.as_name().ok()) == Some(b"Widget")
            {
                Some(id)
            } else {
                kids.first().copied()
            };
            let (page, rect) =
                match widget.and_then(|w| self.doc.get_dictionary(w).ok().map(|d| (w, d))) {
                    Some((w, wd)) => (pages.get(&w).copied(), self.rect(wd.get(b"Rect").ok())),
                    None => (None, None),
                };
            let value = match dict.get(b"V").ok() {
                Some(Object::Reference(v)) => self
                    .doc
                    .get_dictionary(*v)
                    .ok()
                    .map(|d| self.sig_dict(Some(*v), d)),
                Some(Object::Dictionary(d)) => Some(self.sig_dict(None, d)),
                _ => None,
            };
            let lock = dict
                .get(b"Lock")
                .ok()
                .map(|l| self.deref_obj(l))
                .and_then(|l| l.as_dict().ok())
                .and_then(|l| self.lock_of(l))
                .map(|l| match l {
                    FieldLock::All => Vec::new(),
                    FieldLock::Include(v) | FieldLock::Exclude(v) => v,
                });
            out.push(SigField {
                name,
                field: id,
                widget,
                page,
                rect,
                value,
                lock,
            });
        }
        out
    }

    /// The certification signature's DocMDP `/P`, if the file is certified.
    pub fn doc_mdp(&self) -> Option<u8> {
        let catalog = self.doc.get_dictionary(self.catalog_id().ok()?).ok()?;
        let perms = self.deref_obj(catalog.get(b"Perms").ok()?).as_dict().ok()?;
        let sig = self.deref_obj(perms.get(b"DocMDP").ok()?).as_dict().ok()?;
        self.sig_dict(None, sig).doc_mdp.or(Some(2))
    }

    /// The page's crop box and rotation.
    fn page_frame(&self, page: usize) -> Result<([f32; 4], i64)> {
        let id = self.page_id(page)?;
        let dict = self
            .doc
            .get_dictionary(id)
            .map_err(|e| Error::Parse(e.to_string()))?;
        let media = self
            .rect(self.inherited(dict, b"MediaBox"))
            .unwrap_or([0.0, 0.0, 612.0, 792.0]);
        let crop = self.rect(self.inherited(dict, b"CropBox")).unwrap_or(media);
        let rotate = match self.inherited(dict, b"Rotate") {
            Some(Object::Integer(r)) => ((*r % 360) + 360) % 360,
            _ => 0,
        };
        Ok((crop, rotate))
    }

    /// Adds a signature field (or takes an empty one), its appearance and a
    /// signature dictionary with room for `contents_size` bytes, and writes
    /// the update: the file, ready for its signature.
    pub fn prepare_signature(&mut self, spec: &SignatureSpec) -> Result<Prepared> {
        let existing = self.signature_fields();
        if let Some(p) = self.doc_mdp() {
            if p == 1 && spec.kind != SigKind::DocTimeStamp {
                return Err(Error::Edit(
                    "E_SIGN_CERTIFIED: the file is certified with no changes allowed".into(),
                ));
            }
        }
        if matches!(spec.kind, SigKind::Certification(_))
            && existing.iter().any(|f| f.value.is_some())
        {
            return Err(Error::Edit(
                "E_SIGN_CERTIFY_FIRST: only the first signature can certify a file".into(),
            ));
        }
        let catalog_id = self.catalog_id()?;
        let target = match &spec.field {
            Some(name) => {
                let field = existing.iter().find(|f| &f.name == name).ok_or_else(|| {
                    Error::Edit(format!("E_SIGN_FIELD: no signature field {name}"))
                })?;
                if field.value.is_some() {
                    return Err(Error::Edit(format!(
                        "E_SIGN_FIELD: {name} is already signed"
                    )));
                }
                Some(field.clone())
            }
            None => None,
        };

        // The signature dictionary.
        let mut sig = Dictionary::new();
        sig.set(
            "Type",
            Object::Name(if spec.kind == SigKind::DocTimeStamp {
                b"DocTimeStamp".to_vec()
            } else {
                b"Sig".to_vec()
            }),
        );
        sig.set("Filter", Object::Name(b"Adobe.PPKLite".to_vec()));
        sig.set(
            "SubFilter",
            Object::Name(spec.sub_filter.as_bytes().to_vec()),
        );
        sig.set(
            "ByteRange",
            Object::Array(vec![
                Object::Integer(0),
                Object::Integer(PLACEHOLDER),
                Object::Integer(PLACEHOLDER),
                Object::Integer(PLACEHOLDER),
            ]),
        );
        sig.set(
            "Contents",
            Object::String(vec![0; spec.contents_size], StringFormat::Hexadecimal),
        );
        if spec.kind != SigKind::DocTimeStamp {
            for (key, value) in [
                ("Name", &spec.name),
                ("Reason", &spec.reason),
                ("Location", &spec.location),
                ("ContactInfo", &spec.contact),
                ("M", &spec.time),
            ] {
                if let Some(v) = value.as_deref().filter(|v| !v.trim().is_empty()) {
                    sig.set(key, text_string(v));
                }
            }
        }
        let mut references = Vec::new();
        if let SigKind::Certification(p) = spec.kind {
            references.push(Object::Dictionary(dictionary! {
                "Type" => "SigRef",
                "TransformMethod" => "DocMDP",
                "TransformParams" => dictionary! { "Type" => "TransformParams", "P" => p.clamp(1, 3) as i64, "V" => "1.2" },
            }));
        }
        // The field's own /Lock, or the person's choice to lock everything.
        let lock = match target.as_ref().and_then(|f| f.lock.clone()) {
            Some(fields) if !fields.is_empty() => Some(dictionary! {
                "Type" => "TransformParams", "Action" => "Include", "V" => "1.2",
                "Fields" => fields.iter().map(|f| text_string(f)).collect::<Vec<_>>(),
            }),
            Some(_) => {
                Some(dictionary! { "Type" => "TransformParams", "Action" => "All", "V" => "1.2" })
            }
            None if spec.lock_fields => {
                Some(dictionary! { "Type" => "TransformParams", "Action" => "All", "V" => "1.2" })
            }
            None => None,
        };
        if let Some(params) = lock.clone() {
            references.push(Object::Dictionary(dictionary! {
                "Type" => "SigRef", "TransformMethod" => "FieldMDP", "TransformParams" => params,
            }));
        }
        if !references.is_empty() {
            sig.set("Reference", Object::Array(references));
        }
        let sig_id = self.doc.add_object(sig);

        // The field and its widget.
        let page = target.as_ref().and_then(|f| f.page).unwrap_or(spec.page);
        let page_id = self.page_id(page)?;
        let (rect, matrix) = match (&target, spec.rect) {
            (Some(f), _) if f.rect.is_some() => {
                let r = f.rect.unwrap_or_default();
                (r, None)
            }
            (_, Some(shown)) => {
                let (r, m) = self.user_rect(page, shown)?;
                (r, Some(m))
            }
            _ => ([0.0; 4], None),
        };
        let visible = rect[2] - rect[0] > 1.0 && rect[3] - rect[1] > 1.0;
        let appearance = match (&spec.appearance, visible) {
            (Some(a), true) => {
                // The box as it is shown: width and height swap on a turned page.
                let (w, h) = match matrix {
                    Some(m) if m[0] == 0.0 => (rect[3] - rect[1], rect[2] - rect[0]),
                    _ => (rect[2] - rect[0], rect[3] - rect[1]),
                };
                Some(self.signature_appearance(a, w, h, matrix)?)
            }
            _ => None,
        };
        let rect_obj = Object::Array(rect.iter().map(|v| Object::Real(*v)).collect());

        match &target {
            Some(field) => {
                let fd = self
                    .doc
                    .get_dictionary_mut(field.field)
                    .map_err(|e| Error::Parse(e.to_string()))?;
                fd.set("V", Object::Reference(sig_id));
                self.mark_touched(field.field);
                if let (Some(ap), Some(w)) = (appearance, field.widget) {
                    let wd = self
                        .doc
                        .get_dictionary_mut(w)
                        .map_err(|e| Error::Parse(e.to_string()))?;
                    wd.set("AP", dictionary! { "N" => ap });
                    self.mark_touched(w);
                }
            }
            None => {
                let name = unique_field_name(&existing, spec.kind);
                let mut widget = dictionary! {
                    "Type" => "Annot",
                    "Subtype" => "Widget",
                    "FT" => "Sig",
                    "T" => text_string(&name),
                    "F" => WIDGET_FLAGS,
                    "Rect" => rect_obj,
                    "P" => page_id,
                    "V" => sig_id,
                };
                if let Some(ap) = appearance {
                    widget.set("AP", dictionary! { "N" => ap });
                }
                if spec.lock_fields && spec.kind != SigKind::DocTimeStamp {
                    widget.set(
                        "Lock",
                        dictionary! { "Type" => "SigFieldLock", "Action" => "All" },
                    );
                }
                let widget_id = self.doc.add_object(widget);
                self.add_to_form(catalog_id, widget_id)?;
                self.add_annotation(page_id, widget_id)?;
            }
        }
        if let SigKind::Certification(_) = spec.kind {
            let catalog = self
                .doc
                .get_dictionary_mut(catalog_id)
                .map_err(|e| Error::Parse(e.to_string()))?;
            catalog.set("Perms", dictionary! { "DocMDP" => sig_id });
            self.mark_touched(catalog_id);
        }

        let bytes = self.save_incremental()?;
        let update_start = self.original_bytes().len();
        let marker = BYTE_RANGE_PLACEHOLDER.as_bytes();
        let br = find_from(&bytes, marker, update_start)
            .ok_or_else(|| Error::Edit("the signature placeholder was not written".into()))?;
        let zeros = vec![b'0'; spec.contents_size * 2];
        let hole = find_from(&bytes, &zeros, update_start)
            .filter(|at| {
                *at > 0 && bytes[at - 1] == b'<' && bytes.get(at + zeros.len()) == Some(&b'>')
            })
            .ok_or_else(|| Error::Edit("the signature's room was not written".into()))?;
        let (start, end) = (hole - 1, hole + zeros.len() + 1);
        let mut prepared = Prepared { bytes, start, end };
        let [a, b, c, d] = prepared.byte_range();
        let mut text = format!("[{a} {b} {c} {d}");
        while text.len() < marker.len() - 1 {
            text.push(' ');
        }
        text.push(']');
        prepared.bytes[br..br + marker.len()].copy_from_slice(text.as_bytes());
        Ok(prepared)
    }

    /// A rectangle on the page as shown (points from the top-left, after
    /// `/Rotate`), in the page's own space; and the matrix that turns an
    /// appearance drawn upright to match the page's rotation.
    fn user_rect(&self, page: usize, shown: [f32; 4]) -> Result<([f32; 4], [f32; 6])> {
        let ([x0, y0, x1, y1], rotate) = self.page_frame(page)?;
        let map = |dx: f32, dy: f32| -> (f32, f32) {
            match rotate {
                90 => (x0 + dy, y0 + dx),
                180 => (x1 - dx, y0 + dy),
                270 => (x1 - dy, y1 - dx),
                _ => (x0 + dx, y1 - dy),
            }
        };
        let (a, b) = map(shown[0], shown[1]);
        let (c, d) = map(shown[2], shown[3]);
        let rect = [a.min(c), b.min(d), a.max(c), b.max(d)];
        let matrix = match rotate {
            90 => [0.0, 1.0, -1.0, 0.0, 0.0, 0.0],
            180 => [-1.0, 0.0, 0.0, -1.0, 0.0, 0.0],
            270 => [0.0, -1.0, 1.0, 0.0, 0.0, 0.0],
            _ => [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
        };
        Ok((rect, matrix))
    }

    fn add_to_form(&mut self, catalog_id: ObjectId, field: ObjectId) -> Result<()> {
        let catalog = self
            .doc
            .get_dictionary(catalog_id)
            .map_err(|e| Error::Parse(e.to_string()))?;
        match catalog.get(b"AcroForm").ok().cloned() {
            Some(Object::Reference(form_id)) => {
                let fields = self
                    .doc
                    .get_dictionary(form_id)
                    .ok()
                    .and_then(|f| f.get(b"Fields").ok().cloned());
                if let Some(Object::Reference(array_id)) = fields {
                    if let Ok(Object::Array(items)) = self.doc.get_object_mut(array_id) {
                        items.push(Object::Reference(field));
                        self.mark_touched(array_id);
                    }
                    let form = self
                        .doc
                        .get_dictionary_mut(form_id)
                        .map_err(|e| Error::Parse(e.to_string()))?;
                    form.set("SigFlags", SIG_FLAGS);
                } else {
                    let form = self
                        .doc
                        .get_dictionary_mut(form_id)
                        .map_err(|e| Error::Parse(e.to_string()))?;
                    let mut items = match form.get(b"Fields") {
                        Ok(Object::Array(a)) => a.clone(),
                        _ => Vec::new(),
                    };
                    items.push(Object::Reference(field));
                    form.set("Fields", items);
                    form.set("SigFlags", SIG_FLAGS);
                }
                self.mark_touched(form_id);
            }
            Some(Object::Dictionary(mut form)) => {
                let mut items = match form.get(b"Fields") {
                    Ok(Object::Array(a)) => a.clone(),
                    Ok(Object::Reference(id)) => self
                        .doc
                        .get_object(*id)
                        .ok()
                        .and_then(|o| o.as_array().ok())
                        .cloned()
                        .unwrap_or_default(),
                    _ => Vec::new(),
                };
                items.push(Object::Reference(field));
                form.set("Fields", items);
                form.set("SigFlags", SIG_FLAGS);
                let catalog = self
                    .doc
                    .get_dictionary_mut(catalog_id)
                    .map_err(|e| Error::Parse(e.to_string()))?;
                catalog.set("AcroForm", form);
                self.mark_touched(catalog_id);
            }
            _ => {
                let form = self.doc.add_object(dictionary! {
                    "Fields" => vec![Object::Reference(field)],
                    "SigFlags" => SIG_FLAGS,
                });
                let catalog = self
                    .doc
                    .get_dictionary_mut(catalog_id)
                    .map_err(|e| Error::Parse(e.to_string()))?;
                catalog.set("AcroForm", form);
                self.mark_touched(catalog_id);
            }
        }
        Ok(())
    }

    fn add_annotation(&mut self, page_id: ObjectId, annot: ObjectId) -> Result<()> {
        let page = self
            .doc
            .get_dictionary(page_id)
            .map_err(|e| Error::Parse(e.to_string()))?;
        match page.get(b"Annots").ok().cloned() {
            Some(Object::Reference(array_id)) => {
                if let Ok(Object::Array(items)) = self.doc.get_object_mut(array_id) {
                    items.push(Object::Reference(annot));
                    self.mark_touched(array_id);
                    return Ok(());
                }
                let page = self
                    .doc
                    .get_dictionary_mut(page_id)
                    .map_err(|e| Error::Parse(e.to_string()))?;
                page.set("Annots", vec![Object::Reference(annot)]);
            }
            Some(Object::Array(mut items)) => {
                items.push(Object::Reference(annot));
                let page = self
                    .doc
                    .get_dictionary_mut(page_id)
                    .map_err(|e| Error::Parse(e.to_string()))?;
                page.set("Annots", items);
            }
            _ => {
                let page = self
                    .doc
                    .get_dictionary_mut(page_id)
                    .map_err(|e| Error::Parse(e.to_string()))?;
                page.set("Annots", vec![Object::Reference(annot)]);
            }
        }
        self.mark_touched(page_id);
        Ok(())
    }

    /// The appearance of a visible signature, `w` × `h` points: the picture
    /// (if any) at the start of the box, the lines beside it, Arabic shaped
    /// and aligned to the right, every line read back as written.
    fn signature_appearance(
        &mut self,
        a: &SigAppearance,
        w: f32,
        h: f32,
        matrix: Option<[f32; 6]>,
    ) -> Result<ObjectId> {
        const PAD: f32 = 3.0;
        let shaper = Shaper::new(a.font).map_err(|e| Error::Font(e.to_string()))?;
        let lines: Vec<(String, Vec<ShapedGlyph>)> = a
            .lines
            .iter()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .take(8)
            .map(|l| {
                let g = shaper.shape_line(&l);
                (l, g)
            })
            .collect();
        let rtl = lines
            .first()
            .is_some_and(|(l, _)| base_direction(l) == Direction::Rtl);
        let mut ops: Vec<Operation> = vec![Operation::new("q", vec![])];
        let mut resources = Dictionary::new();

        // The picture takes up to 40 % of the width, on the start side.
        let mut text_x0 = PAD;
        let mut text_x1 = w - PAD;
        if let Some(image) = &a.image {
            let pixels = image.width as usize * image.height as usize;
            if image.width == 0
                || image.height == 0
                || image.width > 4096
                || image.height > 4096
                || image.rgba.len() != pixels * 4
            {
                return Err(Error::Edit(
                    "E_SIGN_IMAGE: the signature picture is not usable".into(),
                ));
            }
            let area = if lines.is_empty() {
                w - 2.0 * PAD
            } else {
                (w - 2.0 * PAD) * 0.4
            };
            let scale = (area / image.width as f32).min((h - 2.0 * PAD) / image.height as f32);
            let (iw, ih) = (image.width as f32 * scale, image.height as f32 * scale);
            let ix = if rtl { w - PAD - iw } else { PAD };
            let iy = (h - ih) / 2.0;
            if rtl {
                text_x1 = ix - PAD;
            } else {
                text_x0 = ix + iw + PAD;
            }
            let rgb: Vec<u8> = image
                .rgba
                .chunks(4)
                .flat_map(|p| [p[0], p[1], p[2]])
                .collect();
            let alpha: Vec<u8> = image.rgba.chunks(4).map(|p| p[3]).collect();
            let mut smask = Stream::new(
                dictionary! {
                    "Type" => "XObject", "Subtype" => "Image", "Width" => image.width as i64, "Height" => image.height as i64,
                    "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8,
                },
                alpha,
            );
            let _ = smask.compress();
            let smask = self.doc.add_object(smask);
            let mut img = Stream::new(
                dictionary! {
                    "Type" => "XObject", "Subtype" => "Image", "Width" => image.width as i64, "Height" => image.height as i64,
                    "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8, "SMask" => smask,
                },
                rgb,
            );
            let _ = img.compress();
            let img = self.doc.add_object(img);
            resources.set("XObject", dictionary! { "Im1" => img });
            ops.extend([
                Operation::new("q", vec![]),
                Operation::new(
                    "cm",
                    [iw, 0.0, 0.0, ih, ix, iy]
                        .into_iter()
                        .map(Object::Real)
                        .collect(),
                ),
                Operation::new("Do", vec![Object::Name(b"Im1".to_vec())]),
                Operation::new("Q", vec![]),
            ]);
        }

        if !lines.is_empty() {
            let glyphs: Vec<ShapedGlyph> =
                lines.iter().flat_map(|(_, g)| g.iter().cloned()).collect();
            let subset = FontSubset::build(a.font, &shaper, &glyphs)?;
            let font = embed_subset_font(&mut self.doc, &shaper, &subset, "WarraqSignature");
            resources.set("Font", dictionary! { "F1" => font });
            let widths: Vec<f32> = lines
                .iter()
                .map(|(_, g)| g.iter().map(|g| g.x_advance).sum::<f32>() / 1000.0)
                .collect();
            let avail_w = (text_x1 - text_x0).max(1.0);
            let widest = widths.iter().copied().fold(0.0f32, f32::max).max(0.01);
            let n = lines.len() as f32;
            let size = (avail_w / widest)
                .min((h - 2.0 * PAD) / (n * 1.25))
                .clamp(3.0, 14.0);
            let leading = size * 1.25;
            let block = leading * n;
            let mut y = (h + block) / 2.0 - size;
            ops.push(Operation::new("BT", vec![]));
            ops.push(Operation::new("g", vec![0.into()]));
            ops.push(Operation::new(
                "Tf",
                vec![Object::Name(b"F1".to_vec()), Object::Real(size)],
            ));
            for ((text, g), width) in lines.iter().zip(&widths) {
                let line_rtl = base_direction(text) == Direction::Rtl;
                let x = if line_rtl {
                    text_x1 - width * size
                } else {
                    text_x0
                };
                show_line(
                    &mut ops,
                    &subset,
                    &shaper,
                    &ShownLine {
                        glyphs: g,
                        matrix: [1.0, 0.0, 0.0, 1.0, x, y],
                        size,
                        space_stretch: 0.0,
                    },
                );
                y -= leading;
            }
            ops.push(Operation::new("ET", vec![]));
        }
        ops.push(Operation::new("Q", vec![]));
        let content = Content { operations: ops }
            .encode()
            .map_err(|e| Error::Edit(e.to_string()))?;
        let mut dict = dictionary! {
            "Type" => "XObject", "Subtype" => "Form",
            "BBox" => vec![Object::Real(0.0), Object::Real(0.0), Object::Real(w), Object::Real(h)],
            "Resources" => resources,
        };
        if let Some(m) = matrix.filter(|m| *m != [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]) {
            dict.set(
                "Matrix",
                m.iter().map(|v| Object::Real(*v)).collect::<Vec<_>>(),
            );
        }
        let mut stream = Stream::new(dict, content);
        let _ = stream.compress();
        Ok(self.doc.add_object(stream))
    }

    /// Adds validation data to the document security store (`/DSS`, PAdES
    /// B-LT): certificates, OCSP answers and revocation lists, each written
    /// once, and per signature (`vri`: the upper-case hex SHA-1 of its
    /// `/Contents`) which of them are its own.
    pub fn add_dss(&mut self, data: &DssData) -> Result<DssAdded> {
        let catalog_id = self.catalog_id()?;
        let catalog = self
            .doc
            .get_dictionary(catalog_id)
            .map_err(|e| Error::Parse(e.to_string()))?;
        let old = catalog
            .get(b"DSS")
            .ok()
            .map(|d| self.deref_obj(d))
            .and_then(|d| d.as_dict().ok())
            .cloned()
            .unwrap_or_default();
        let existing = |key: &[u8]| -> Vec<(ObjectId, Vec<u8>)> {
            old.get(key)
                .ok()
                .map(|a| self.deref_obj(a))
                .and_then(|a| a.as_array().ok())
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|i| i.as_reference().ok())
                        .filter_map(|id| {
                            let s = self.doc.get_object(id).ok()?.as_stream().ok()?;
                            let bytes = if s.dict.has(b"Filter") {
                                s.decompressed_content().ok()?
                            } else {
                                s.content.clone()
                            };
                            Some((id, bytes))
                        })
                        .collect()
                })
                .unwrap_or_default()
        };
        let before = [existing(b"Certs"), existing(b"OCSPs"), existing(b"CRLs")];
        let mut added = DssAdded::default();
        let mut lists: Vec<Vec<(ObjectId, Vec<u8>)>> = Vec::new();
        for ((items, count), mut list) in [
            (&data.certs, &mut added.certs),
            (&data.ocsps, &mut added.ocsps),
            (&data.crls, &mut added.crls),
        ]
        .into_iter()
        .zip(before)
        {
            for item in items {
                if list.iter().any(|(_, b)| b == item) {
                    continue;
                }
                let mut s = Stream::new(Dictionary::new(), item.clone());
                let _ = s.compress();
                list.push((self.doc.add_object(s), item.clone()));
                *count += 1;
            }
            lists.push(list);
        }
        if added.certs + added.ocsps + added.crls == 0 && data.vri.is_empty() {
            return Ok(added);
        }
        let refs = |list: &Vec<(ObjectId, Vec<u8>)>| -> Vec<Object> {
            list.iter().map(|(id, _)| Object::Reference(*id)).collect()
        };
        let find = |list: &Vec<(ObjectId, Vec<u8>)>, wanted: &[Vec<u8>]| -> Vec<Object> {
            list.iter()
                .filter(|(_, b)| wanted.contains(b))
                .map(|(id, _)| Object::Reference(*id))
                .collect()
        };
        let mut dss = Dictionary::new();
        dss.set("Type", Object::Name(b"DSS".to_vec()));
        let names = [b"Certs".as_slice(), b"OCSPs", b"CRLs"];
        for (name, list) in names.iter().zip(&lists) {
            if !list.is_empty() {
                dss.set(*name, refs(list));
            }
        }
        let mut vri = old
            .get(b"VRI")
            .ok()
            .map(|v| self.deref_obj(v))
            .and_then(|v| v.as_dict().ok())
            .cloned()
            .unwrap_or_default();
        for entry in &data.vri {
            let mut e = Dictionary::new();
            for (key, list, wanted) in [
                ("Cert", &lists[0], &entry.certs),
                ("OCSP", &lists[1], &entry.ocsps),
                ("CRL", &lists[2], &entry.crls),
            ] {
                let found = find(list, wanted);
                if !found.is_empty() {
                    e.set(key, found);
                }
            }
            vri.set(entry.key.as_bytes().to_vec(), e);
        }
        if !vri.is_empty() {
            dss.set("VRI", vri);
        }
        let dss_id = self.doc.add_object(dss);
        let catalog = self
            .doc
            .get_dictionary_mut(catalog_id)
            .map_err(|e| Error::Parse(e.to_string()))?;
        catalog.set("DSS", Object::Reference(dss_id));
        self.mark_touched(catalog_id);
        Ok(added)
    }

    /// Everything in the document security store: certificates, OCSP answers
    /// and revocation lists, as stored.
    pub fn dss(&self) -> DssData {
        let mut out = DssData::default();
        let Some(catalog) = self
            .catalog_id()
            .ok()
            .and_then(|id| self.doc.get_dictionary(id).ok())
        else {
            return out;
        };
        let Some(dss) = catalog
            .get(b"DSS")
            .ok()
            .map(|d| self.deref_obj(d))
            .and_then(|d| d.as_dict().ok())
        else {
            return out;
        };
        for (key, into) in [
            (b"Certs".as_slice(), &mut out.certs),
            (b"OCSPs".as_slice(), &mut out.ocsps),
            (b"CRLs".as_slice(), &mut out.crls),
        ] {
            let items = dss
                .get(key)
                .ok()
                .map(|a| self.deref_obj(a))
                .and_then(|a| a.as_array().ok())
                .cloned()
                .unwrap_or_default();
            for item in items.iter().take(10_000) {
                if let Ok(s) = self.deref_obj(item).as_stream() {
                    let bytes = if s.dict.has(b"Filter") {
                        s.decompressed_content().ok()
                    } else {
                        Some(s.content.clone())
                    };
                    into.extend(bytes);
                }
            }
        }
        out
    }
}

fn unique_field_name(existing: &[SigField], kind: SigKind) -> String {
    let stem = if kind == SigKind::DocTimeStamp {
        "Timestamp"
    } else {
        "Signature"
    };
    (1..)
        .map(|n| format!("{stem}{n}"))
        .find(|name| !existing.iter().any(|f| &f.name == name))
        .expect("an unused name")
}

/// Validation data to add, and which of it belongs to which signature.
#[derive(Debug, Clone, Default)]
pub struct DssData {
    pub certs: Vec<Vec<u8>>,
    pub ocsps: Vec<Vec<u8>>,
    pub crls: Vec<Vec<u8>>,
    pub vri: Vec<VriEntry>,
}

#[derive(Debug, Clone, Default)]
pub struct VriEntry {
    pub key: String,
    pub certs: Vec<Vec<u8>>,
    pub ocsps: Vec<Vec<u8>>,
    pub crls: Vec<Vec<u8>>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DssAdded {
    pub certs: usize,
    pub ocsps: usize,
    pub crls: usize,
}

// ---------------------------------------------------------------- changes

/// What an object is to the document, from the strictest to the most
/// lenient: a change to the first kinds changes what was signed; to the last,
/// only what may be added to a signed file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Role {
    PageContent,
    Pages,
    Catalog,
    Document,
    Annotation,
    Form,
    Signature,
    Dss,
    Info,
}

/// One kind of change made after a signature.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ChangeKind {
    /// Page content, resources or the page tree.
    PageContent,
    /// Catalog entries, actions, outlines, names — anything document-wide.
    Document,
    /// A signature dictionary that already existed was changed.
    SignatureAltered,
    /// A field locked by a signature was changed.
    LockedField,
    /// Comments added, changed or removed.
    Comments,
    /// Form fields filled in.
    FormFill,
    /// Another signature or a document timestamp added.
    Signatures,
    /// Validation data added (`/DSS`).
    ValidationData,
    /// Document information (title, author, producer).
    Metadata,
}

impl ChangeKind {
    pub fn code(self) -> &'static str {
        match self {
            ChangeKind::PageContent => "pageContent",
            ChangeKind::Document => "document",
            ChangeKind::SignatureAltered => "signatureAltered",
            ChangeKind::LockedField => "lockedField",
            ChangeKind::Comments => "comments",
            ChangeKind::FormFill => "formFill",
            ChangeKind::Signatures => "signatures",
            ChangeKind::ValidationData => "validationData",
            ChangeKind::Metadata => "metadata",
        }
    }

    /// Whether this kind of change is allowed after a signature whose
    /// document's DocMDP is `doc_mdp` (`None`: not certified).
    pub fn allowed(self, doc_mdp: Option<u8>, only_timestamps: bool) -> bool {
        match self {
            ChangeKind::ValidationData | ChangeKind::Metadata => true,
            ChangeKind::Signatures => doc_mdp != Some(1) || only_timestamps,
            ChangeKind::FormFill => doc_mdp != Some(1),
            ChangeKind::Comments => matches!(doc_mdp, None | Some(3)),
            ChangeKind::PageContent
            | ChangeKind::Document
            | ChangeKind::SignatureAltered
            | ChangeKind::LockedField => false,
        }
    }
}

/// What changed between a signed revision and the file as it is.
#[derive(Debug, Clone, Default)]
pub struct Changes {
    /// Kinds of change, and how many objects each touched.
    pub kinds: BTreeMap<ChangeKind, usize>,
    /// The signatures added after (their sig dicts are timestamps only).
    pub only_timestamps_added: bool,
}

/// A map from object to its role, walked from the trailer.
fn roles(pdf: &PdfDocument) -> BTreeMap<ObjectId, (Role, Option<String>)> {
    let doc = &pdf.doc;
    let mut out: BTreeMap<ObjectId, (Role, Option<String>)> = BTreeMap::new();
    let mut queue: VecDeque<(Object, Role, Option<String>)> = VecDeque::new();
    if let Ok(root) = doc.trailer.get(b"Root") {
        queue.push_back((root.clone(), Role::Catalog, None));
    }
    if let Ok(info) = doc.trailer.get(b"Info") {
        queue.push_back((info.clone(), Role::Info, None));
    }
    let mut steps = 0usize;
    while let Some((object, pushed, field)) = queue.pop_front() {
        steps += 1;
        if steps > 2_000_000 {
            break;
        }
        let (id, object) = match object {
            Object::Reference(id) => match doc.get_object(id) {
                Ok(o) => (Some(id), o.clone()),
                Err(_) => continue,
            },
            o => (None, o),
        };
        let dict = match &object {
            Object::Dictionary(d) => Some(d.clone()),
            Object::Stream(s) => Some(s.dict.clone()),
            _ => None,
        };
        // An annotation that is a form field's widget belongs to the form;
        // a signature field and what hangs from it, to the signatures.
        let is_sig =
            |d: &Dictionary| d.get(b"FT").ok().and_then(|f| f.as_name().ok()) == Some(b"Sig");
        let (role, field) = match (&dict, pushed) {
            (Some(d), Role::Annotation)
                if d.get(b"Subtype").ok().and_then(|s| s.as_name().ok()) == Some(b"Widget") =>
            {
                (
                    if is_sig(d) {
                        Role::Signature
                    } else {
                        Role::Form
                    },
                    pdf.text_of(d, b"T").or(field),
                )
            }
            (Some(d), Role::Form) if is_sig(d) => (Role::Signature, pdf.text_of(d, b"T").or(field)),
            (Some(d), Role::Form) => (Role::Form, pdf.text_of(d, b"T").or(field)),
            _ => (pushed, field),
        };
        if let Some(id) = id {
            match out.get(&id) {
                Some((r, _)) if *r <= role => continue,
                _ => {}
            }
            out.insert(id, (role, field.clone()));
        }
        let Some(dict) = dict else {
            if let Object::Array(items) = &object {
                for i in items {
                    queue.push_back((i.clone(), role, field.clone()));
                }
            }
            continue;
        };
        for (key, value) in dict.iter() {
            let k = key.as_slice();
            // Back-links: following them would give a parent its child's role.
            if matches!(
                k,
                b"Parent" | b"P" | b"Prev" | b"Next" | b"First" | b"Last" | b"Dest" | b"D"
            ) && role != Role::Document
                && role != Role::Catalog
            {
                continue;
            }
            let next = match (role, k) {
                (Role::Catalog, b"Pages") => Role::Pages,
                (Role::Catalog, b"AcroForm") => Role::Form,
                (Role::Catalog, b"DSS") => Role::Dss,
                (Role::Catalog, b"Metadata") => Role::Info,
                (Role::Catalog, b"Perms") => Role::Signature,
                (Role::Catalog, _) => Role::Document,
                (Role::Pages, b"Kids") => Role::Pages,
                (Role::Pages, b"Annots") => Role::Annotation,
                (Role::Pages, _) => Role::PageContent,
                (r, _) => r,
            };
            queue.push_back((value.clone(), next, field.clone()));
        }
    }
    out
}

/// Annotations in the `then` list and not in `now` (each an `/Annots` array,
/// or a reference to one): a comment removed, or — no less serious than
/// changing the page — a form field's or a signature's widget.
fn removed_annotations(
    signed: &PdfDocument,
    current: &PdfDocument,
    then: Option<&Object>,
    now: Option<&Object>,
) -> Vec<ChangeKind> {
    let refs = |doc: &PdfDocument, o: Option<&Object>| -> BTreeSet<ObjectId> {
        let o = match o {
            Some(Object::Reference(id)) => doc.doc.get_object(*id).ok(),
            other => other,
        };
        o.and_then(|o| o.as_array().ok())
            .map(|a| a.iter().filter_map(|i| i.as_reference().ok()).collect())
            .unwrap_or_default()
    };
    let (before, after) = (refs(signed, then), refs(current, now));
    before
        .difference(&after)
        .map(|id| {
            let widget = signed
                .doc
                .get_dictionary(*id)
                .ok()
                .and_then(|d| d.get(b"Subtype").ok())
                .and_then(|s| s.as_name().ok())
                == Some(b"Widget");
            if widget {
                ChangeKind::Document
            } else {
                ChangeKind::Comments
            }
        })
        .collect()
}

fn storage_only(object: &Object) -> bool {
    matches!(
        object
            .as_stream()
            .ok()
            .and_then(|s| s.dict.get(b"Type").ok())
            .and_then(|t| t.as_name().ok()),
        Some(b"XRef" | b"ObjStm")
    )
}

impl PdfDocument {
    /// What changed in this document since `signed`, an earlier revision of
    /// it (the bytes a signature covers). `locks` are the fields locked by
    /// the signatures made so far.
    pub fn changes_since(&self, signed: &PdfDocument, locks: &[FieldLock]) -> Changes {
        let ours = roles(self);
        let theirs = roles(signed);
        let mut changes = Changes {
            only_timestamps_added: true,
            ..Changes::default()
        };
        let mut add = |kind: ChangeKind| *changes.kinds.entry(kind).or_insert(0) += 1;
        let ids: BTreeSet<ObjectId> = self
            .doc
            .objects
            .keys()
            .chain(signed.doc.objects.keys())
            .copied()
            .collect();
        let mut new_sigs = 0usize;
        let mut new_timestamps = 0usize;
        for id in ids {
            let now = self.doc.objects.get(&id);
            let then = signed.doc.objects.get(&id);
            if now.is_some_and(storage_only) || then.is_some_and(storage_only) {
                continue;
            }
            match (now, then) {
                (Some(a), Some(b)) if crate::rebase::same(a, b) => continue,
                _ => {}
            }
            let role_now = ours.get(&id).cloned();
            let role_then = theirs.get(&id).cloned();
            let (role, field) = match (role_now, role_then) {
                (Some(a), Some(b)) => {
                    if a.0 <= b.0 {
                        a
                    } else {
                        b
                    }
                }
                (Some(a), None) | (None, Some(a)) => a,
                // Nothing reaches it: not part of the document either way.
                (None, None) => continue,
            };
            match role {
                Role::Catalog => {
                    let (Some(a), Some(b)) = (
                        now.and_then(|o| o.as_dict().ok()),
                        then.and_then(|o| o.as_dict().ok()),
                    ) else {
                        add(ChangeKind::Document);
                        continue;
                    };
                    let keys: BTreeSet<Vec<u8>> =
                        a.iter().chain(b.iter()).map(|(k, _)| k.clone()).collect();
                    for key in keys {
                        if a.get(&key).ok() == b.get(&key).ok() {
                            continue;
                        }
                        add(match key.as_slice() {
                            b"DSS" | b"Extensions" => ChangeKind::ValidationData,
                            b"AcroForm" => ChangeKind::FormFill,
                            b"Metadata" => ChangeKind::Metadata,
                            b"Perms" => ChangeKind::SignatureAltered,
                            _ => ChangeKind::Document,
                        });
                    }
                }
                Role::Pages => {
                    // A page whose only change is its annotations list.
                    let (Some(a), Some(b)) = (
                        now.and_then(|o| o.as_dict().ok()),
                        then.and_then(|o| o.as_dict().ok()),
                    ) else {
                        add(ChangeKind::PageContent);
                        continue;
                    };
                    let mut others = a.clone();
                    let mut before = b.clone();
                    others.remove(b"Annots");
                    before.remove(b"Annots");
                    if others != before {
                        add(ChangeKind::PageContent);
                    }
                    // What the annotations list gained is judged by those
                    // annotations themselves; what it lost, here.
                    for kind in removed_annotations(
                        signed,
                        self,
                        b.get(b"Annots").ok(),
                        a.get(b"Annots").ok(),
                    ) {
                        add(kind);
                    }
                }
                Role::PageContent => add(ChangeKind::PageContent),
                Role::Document => add(ChangeKind::Document),
                Role::Annotation => {
                    if now.is_some_and(|o| o.as_array().is_ok())
                        || then.is_some_and(|o| o.as_array().is_ok())
                    {
                        // An /Annots array: judged by its members.
                        for kind in removed_annotations(signed, self, then, now) {
                            add(kind);
                        }
                        continue;
                    }
                    add(ChangeKind::Comments)
                }
                Role::Form => {
                    if field
                        .as_deref()
                        .is_some_and(|f| locks.iter().any(|l| l.locks(f)))
                    {
                        add(ChangeKind::LockedField);
                    } else {
                        add(ChangeKind::FormFill);
                    }
                }
                Role::Signature => {
                    let dict = now.and_then(|o| o.as_dict().ok());
                    let is_sig_dict = dict.is_some_and(|d| d.has(b"ByteRange"));
                    if then.is_some() && is_sig_dict {
                        add(ChangeKind::SignatureAltered);
                    } else {
                        if is_sig_dict {
                            new_sigs += 1;
                            if dict.is_some_and(|d| d.has_type(b"DocTimeStamp")) {
                                new_timestamps += 1;
                            }
                        }
                        add(ChangeKind::Signatures);
                    }
                }
                Role::Dss => add(ChangeKind::ValidationData),
                Role::Info => add(ChangeKind::Metadata),
            }
        }
        changes.only_timestamps_added = new_sigs == new_timestamps;
        changes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const AMIRI: &[u8] = include_bytes!("../../../../tests/fonts/Amiri-Regular.ttf");

    fn corpus(name: &str) -> Vec<u8> {
        std::fs::read(format!(
            "{}/../../../tests/corpus/arabic/{name}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap()
    }

    fn spec<'a>(
        appearance: Option<SigAppearance<'a>>,
        rect: Option<[f32; 4]>,
    ) -> SignatureSpec<'a> {
        SignatureSpec {
            field: None,
            page: 0,
            rect,
            appearance,
            name: Some("محمد التجريبي".into()),
            reason: Some("موافقة".into()),
            location: Some("Riyadh".into()),
            contact: None,
            time: Some("D:20260918200000+03'00'".into()),
            sub_filter: "ETSI.CAdES.detached",
            kind: SigKind::Approval,
            lock_fields: false,
            contents_size: 8192,
        }
    }

    #[test]
    fn a_prepared_signature_leaves_exactly_its_contents_out_of_the_byte_range() {
        for name in [
            "generated/chrome-cairo-mixed-invoice.pdf",
            "generated/variant-objectstreams-xrefstream.pdf",
        ] {
            let original = corpus(name);
            let mut doc = PdfDocument::open(original.clone(), None).unwrap();
            let appearance = SigAppearance {
                lines: vec![
                    "وقّعه: محمد التجريبي".into(),
                    "2026-09-18 20:00 +03:00".into(),
                ],
                font: AMIRI,
                image: Some(SigImage {
                    width: 2,
                    height: 1,
                    rgba: vec![0, 0, 0, 255, 255, 255, 255, 0],
                }),
            };
            let mut prepared = doc
                .prepare_signature(&spec(Some(appearance), Some([300.0, 700.0, 520.0, 780.0])))
                .unwrap();
            assert!(
                prepared.bytes.starts_with(&original),
                "{name}: an incremental update"
            );
            let [a, b, c, d] = prepared.byte_range();
            assert_eq!(a, 0);
            assert_eq!(c + d, prepared.bytes.len());
            assert_eq!(prepared.bytes[b], b'<');
            assert_eq!(prepared.bytes[c - 1], b'>');
            assert!(String::from_utf8_lossy(&prepared.bytes[b - 12..b]).contains("/Contents"));
            let text = String::from_utf8_lossy(&prepared.bytes[original.len()..]).into_owned();
            assert!(
                text.contains(&format!("/ByteRange [0 {b} {c} {d}")),
                "{name}"
            );
            prepared.embed(&[0x30, 0x03, 0x02, 0x01, 0x07]).unwrap();
            assert!(prepared.embed(&vec![1; 9000]).is_err(), "does not fit");

            // Reopened: one signature field, signed, on page 1.
            let back = PdfDocument::open(prepared.bytes.clone(), None).unwrap();
            let fields = back.signature_fields();
            assert_eq!(fields.len(), 1, "{name}");
            let f = &fields[0];
            assert_eq!(f.name, "Signature1");
            assert_eq!(f.page, Some(0));
            let v = f.value.as_ref().unwrap();
            assert_eq!(v.sub_filter, "ETSI.CAdES.detached");
            assert_eq!(v.name.as_deref(), Some("محمد التجريبي"));
            assert_eq!(v.byte_range, vec![a as i64, b as i64, c as i64, d as i64]);
            // And the host can find the room again.
            let again = Prepared::find(
                PdfDocument::open(original.clone(), None)
                    .unwrap()
                    .prepare_signature(&spec(None, None))
                    .unwrap()
                    .bytes,
            )
            .unwrap();
            assert!(again.capacity() >= 8192);
        }
    }

    #[test]
    fn a_protected_file_keeps_its_protection_and_its_contents_in_the_clear() {
        let original = corpus("generated/variant-encrypted-aes256.pdf");
        let mut doc = PdfDocument::open(original.clone(), Some("warraq")).unwrap();
        let prepared = doc.prepare_signature(&spec(None, None)).unwrap();
        assert!(prepared.bytes.starts_with(&original));
        assert!(matches!(
            PdfDocument::open(prepared.bytes.clone(), None),
            Err(Error::Password)
        ));
        let back = PdfDocument::open(prepared.bytes.clone(), Some("warraq")).unwrap();
        let v = back.signature_fields().remove(0).value.unwrap();
        assert_eq!(v.name.as_deref(), Some("محمد التجريبي"), "strings decrypt");
        assert!(
            prepared.bytes[prepared.start + 1..prepared.end - 1]
                .iter()
                .all(|b| *b == b'0'),
            "Contents in the clear"
        );
    }

    #[test]
    fn certification_is_recorded_and_changes_after_it_are_classified() {
        let original = corpus("generated/acroform-pdflib-arabic-fields.pdf");
        let mut doc = PdfDocument::open(original.clone(), None).unwrap();
        let mut s = spec(None, None);
        s.kind = SigKind::Certification(2);
        let prepared = doc.prepare_signature(&s).unwrap();
        let signed = PdfDocument::open(prepared.bytes.clone(), None).unwrap();
        assert_eq!(signed.doc_mdp(), Some(2));
        // A second certification is refused.
        let mut again = PdfDocument::open(prepared.bytes.clone(), None).unwrap();
        assert!(again.prepare_signature(&s).is_err());

        // Filling a field after certifying with P=2 is allowed; drawing on the page is not.
        let mut edited = PdfDocument::open(prepared.bytes.clone(), None).unwrap();
        crate::ops::append_line(
            &mut edited,
            0,
            "سطر أضيف بعد التوقيع",
            AMIRI,
            12.0,
            300.0,
            40.0,
        )
        .unwrap();
        let after = PdfDocument::open(edited.save_incremental().unwrap(), None).unwrap();
        let changes = after.changes_since(&signed, &[]);
        assert!(
            changes.kinds.contains_key(&ChangeKind::PageContent),
            "{:?}",
            changes.kinds
        );
        assert!(!ChangeKind::PageContent.allowed(Some(2), false));

        // A DSS added later is validation data, allowed even under P=1.
        let mut ltv = PdfDocument::open(prepared.bytes.clone(), None).unwrap();
        ltv.add_dss(&DssData {
            certs: vec![vec![0x30, 0x00]],
            ..DssData::default()
        })
        .unwrap();
        let after = PdfDocument::open(ltv.save_incremental().unwrap(), None).unwrap();
        let changes = after.changes_since(&signed, &[]);
        assert_eq!(
            changes.kinds.keys().copied().collect::<Vec<_>>(),
            [ChangeKind::ValidationData],
            "{:?}",
            changes.kinds
        );
        assert!(ChangeKind::ValidationData.allowed(Some(1), false));
        assert_eq!(after.dss().certs, vec![vec![0x30, 0x00]]);
    }
}
