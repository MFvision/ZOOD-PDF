//! PAdES signing as incremental updates.
//!
//! Layout of one signature update (appended to the untouched original bytes):
//! ```text
//! N 0 obj <</Type/Sig/Filter/Adobe.PPKLite/SubFilter/ETSI.CAdES.detached
//!          /ByteRange [0 b c d]          ← fixed-width placeholder, patched in place
//!          /Contents <3082…000000>        ← hex placeholder, NEVER encrypted
//!          /M (D:…) /Reason … /Location … [/Reference [DocMDP|FieldMDP]] …>>
//! ```
//! `b` is the offset of `<`, `c` the offset after `>`, `c + d` the file length: the signature
//! covers everything except the hex string. Strings other than `/Contents` are encrypted with
//! the document key when the document is encrypted (warraq-pdf's writer skips `/Contents` of
//! `/Sig` and `/DocTimeStamp` dictionaries).

use crate::appearance::{self, AppearanceSpec};
use crate::cms;
use crate::error::{Result, SignError};
use crate::hash::{hex_upper, HashAlg};
use crate::limits::MAX_PLACEHOLDER;
use crate::oids;
use crate::pdfobj::{self, name, num, text_string, Edit};
use crate::signer::Signer;
use crate::tsp::{self, TsaRequest};
use lopdf::{Dictionary, Object, ObjectId, Stream, StringFormat};
use warraq_pdf::Pdf;

/// PAdES baseline level.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    /// Basic signature.
    BB,
    /// With a signature timestamp.
    BT,
    /// With validation data (DSS).
    BLT,
    /// With a document timestamp over the validation data.
    BLTA,
}

impl Level {
    /// Parse `B-B`, `B-T`, `B-LT`, `B-LTA`.
    pub fn parse(s: &str) -> Result<Level> {
        match s.to_ascii_uppercase().replace('_', "-").as_str() {
            "B-B" | "BB" => Ok(Level::BB),
            "B-T" | "BT" => Ok(Level::BT),
            "B-LT" | "BLT" => Ok(Level::BLT),
            "B-LTA" | "BLTA" => Ok(Level::BLTA),
            _ => Err(SignError::InvalidArgument(format!(
                "unknown PAdES level {s:?}"
            ))),
        }
    }
}

/// FieldMDP action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LockAction {
    /// Lock every field.
    All,
    /// Lock the listed fields.
    Include,
    /// Lock every field except the listed ones.
    Exclude,
}

impl LockAction {
    /// Name in the PDF.
    pub fn pdf_name(self) -> &'static str {
        match self {
            LockAction::All => "All",
            LockAction::Include => "Include",
            LockAction::Exclude => "Exclude",
        }
    }
    /// Parse.
    pub fn parse(s: &str) -> Result<LockAction> {
        match s {
            "All" | "all" => Ok(LockAction::All),
            "Include" | "include" => Ok(LockAction::Include),
            "Exclude" | "exclude" => Ok(LockAction::Exclude),
            _ => Err(SignError::InvalidArgument(format!(
                "unknown lock action {s:?}"
            ))),
        }
    }
}

/// Field lock (FieldMDP).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FieldLock {
    /// Action.
    pub action: LockAction,
    /// Fully qualified field names.
    pub fields: Vec<String>,
}

/// Options for [`sign`].
#[derive(Debug, Clone)]
pub struct SignOptions {
    /// Existing empty signature field to fill, or name of the new field.
    pub field: Option<String>,
    /// 0-based page for a new field.
    pub page: usize,
    /// Rectangle in default user space; `None` = invisible signature.
    pub rect: Option<[f64; 4]>,
    /// Visible appearance text.
    pub appearance: Option<AppearanceSpec>,
    /// `/Reason`.
    pub reason: Option<String>,
    /// `/Location`.
    pub location: Option<String>,
    /// `/ContactInfo`.
    pub contact_info: Option<String>,
    /// `/Name` (defaults to the certificate's common name).
    pub name: Option<String>,
    /// Target level (B-T and above size the placeholder for a timestamp and return a TSA
    /// request).
    pub level: Level,
    /// Certification signature with DocMDP permissions P (1, 2 or 3).
    pub certify: Option<u8>,
    /// FieldMDP lock written with this signature.
    pub lock: Option<FieldLock>,
    /// Signing time for `/M` (Unix seconds, from the host clock).
    pub time: i64,
    /// Override the `/Contents` size in bytes.
    pub placeholder: Option<usize>,
}

impl Default for SignOptions {
    fn default() -> Self {
        SignOptions {
            field: None,
            page: 0,
            rect: None,
            appearance: None,
            reason: None,
            location: None,
            contact_info: None,
            name: None,
            level: Level::BB,
            certify: None,
            lock: None,
            time: 0,
            placeholder: None,
        }
    }
}

/// Result of signing.
#[derive(Debug, Clone)]
pub struct SignOutput {
    /// The signed file (original bytes are an exact prefix).
    pub bytes: Vec<u8>,
    /// Fully qualified field name.
    pub field: String,
    /// `[0, b, c, d]`.
    pub byte_range: [usize; 4],
    /// Timestamp request for the signature value (levels B-T and above).
    pub tsa_request: Option<TsaRequest>,
    /// Size of the CMS written, and of the placeholder.
    pub cms_len: usize,
    /// Placeholder size in bytes.
    pub placeholder: usize,
}

const BR_MARK: &[u8] = b"/ByteRange [0 9999999999 9999999999 9999999999]";

fn placeholder_byte_range() -> Object {
    Object::Array(vec![
        Object::Integer(0),
        Object::Integer(9_999_999_999),
        Object::Integer(9_999_999_999),
        Object::Integer(9_999_999_999),
    ])
}

fn find(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    hay.get(from..)?
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|p| p + from)
}

/// Locate the byte-range placeholder and the `/Contents` hex string of the signature
/// dictionary appended after `start`. Returns `(byte_range_value_offset, lt, gt)` where
/// `lt`/`gt` are the offsets of `<` and `>`.
fn locate(bytes: &[u8], start: usize, size: usize) -> Result<(usize, usize, usize)> {
    let br = find(bytes, BR_MARK, start)
        .ok_or_else(|| SignError::Crypto("byte-range placeholder not found".into()))?;
    if find(bytes, BR_MARK, br + 1).is_some() {
        return Err(SignError::Crypto(
            "byte-range placeholder is not unique".into(),
        ));
    }
    let key = b"/Contents <";
    let k = find(bytes, key, br)
        .ok_or_else(|| SignError::Crypto("contents placeholder not found".into()))?;
    let lt = k + key.len() - 1;
    let gt = lt + 1 + 2 * size;
    let body = bytes
        .get(lt + 1..gt)
        .ok_or_else(|| SignError::Crypto("contents placeholder truncated".into()))?;
    if !body.iter().all(|b| *b == b'0') || bytes.get(gt) != Some(&b'>') {
        return Err(SignError::Crypto(
            "contents placeholder is not where expected".into(),
        ));
    }
    Ok((br + b"/ByteRange ".len(), lt, gt))
}

/// Patch the byte range in place (same width) and return `[0, b, c, d]`.
fn patch_byte_range(bytes: &mut [u8], br_at: usize, lt: usize, gt: usize) -> Result<[usize; 4]> {
    let c = gt + 1;
    let d = bytes.len() - c;
    let range = [0, lt, c, d];
    let width = BR_MARK.len() - b"/ByteRange ".len();
    let mut text = format!("[0 {} {} {}", range[1], range[2], range[3]).into_bytes();
    if text.len() + 1 > width {
        return Err(SignError::Limit("file too large for the byte range".into()));
    }
    text.resize(width - 1, b' ');
    text.push(b']');
    bytes
        .get_mut(br_at..br_at + width)
        .ok_or_else(|| SignError::Crypto("byte range out of bounds".into()))?
        .copy_from_slice(&text);
    Ok(range)
}

/// Write `cms` as uppercase hex into the placeholder between `lt` and `gt` (zero padded).
pub(crate) fn patch_contents(bytes: &mut [u8], lt: usize, gt: usize, cms: &[u8]) -> Result<()> {
    let hex = hex_upper(cms);
    let slot = bytes
        .get_mut(lt + 1..gt)
        .ok_or_else(|| SignError::Crypto("contents placeholder out of bounds".into()))?;
    if hex.len() > slot.len() {
        return Err(SignError::Limit(format!(
            "the signature ({} bytes) does not fit the reserved space ({} bytes)",
            cms.len(),
            slot.len() / 2
        )));
    }
    slot.fill(b'0');
    slot.get_mut(..hex.len())
        .ok_or_else(|| SignError::Crypto("contents".into()))?
        .copy_from_slice(hex.as_bytes());
    Ok(())
}

/// Digest of the bytes covered by `range`.
pub fn range_digest(bytes: &[u8], range: [usize; 4], hash: HashAlg) -> Result<Vec<u8>> {
    let a = bytes
        .get(range[0]..range[0].saturating_add(range[1]))
        .ok_or_else(|| SignError::InvalidArgument("byte range outside the file".into()))?;
    let b = bytes
        .get(range[2]..range[2].saturating_add(range[3]))
        .ok_or_else(|| SignError::InvalidArgument("byte range outside the file".into()))?;
    Ok(hash.digest_parts(&[a, b]))
}

/// DocMDP permission of the document's certification signature, if any.
pub fn docmdp_permission(pdf: &Pdf) -> Option<u8> {
    let cat = pdf.catalog().ok()?;
    let perms = pdfobj::dict_of(pdf, cat.get(b"Perms").ok()?)?;
    let sig = pdfobj::dict_of(pdf, perms.get(b"DocMDP").ok()?)?;
    Some(docmdp_p_of_sig(pdf, sig).unwrap_or(2))
}

/// `P` from a signature dictionary's DocMDP reference (default 2).
pub fn docmdp_p_of_sig(pdf: &Pdf, sig: &Dictionary) -> Option<u8> {
    let Some(Object::Array(refs)) = pdfobj::get(pdf, sig, b"Reference") else {
        return None;
    };
    for r in refs {
        let Some(rd) = pdfobj::dict_of(pdf, r) else {
            continue;
        };
        if pdfobj::get_name(pdf, rd, b"TransformMethod") == Some(b"DocMDP") {
            let p = pdfobj::get(pdf, rd, b"TransformParams")
                .and_then(|o| match o {
                    Object::Dictionary(d) => pdfobj::get_num(pdf, d, b"P"),
                    _ => None,
                })
                .unwrap_or(2.0);
            return Some(p.clamp(1.0, 3.0) as u8);
        }
    }
    None
}

fn has_signed_fields(pdf: &Pdf) -> bool {
    pdfobj::fields(pdf).iter().any(|f| {
        f.ft.as_deref() == Some(b"Sig")
            && pdf
                .get_dict(f.id)
                .is_some_and(|d| d.get(b"V").is_ok_and(|v| !matches!(v, Object::Null)))
    })
}

fn sig_ref(transform: &str, params: Dictionary) -> Object {
    let mut r = Dictionary::new();
    r.set("Type", name("SigRef"));
    r.set("TransformMethod", name(transform));
    r.set("TransformParams", Object::Dictionary(params));
    Object::Dictionary(r)
}

fn lock_params(lock: &FieldLock) -> Dictionary {
    let mut p = Dictionary::new();
    p.set("Type", name("TransformParams"));
    p.set("Action", name(lock.action.pdf_name()));
    if lock.action != LockAction::All {
        p.set(
            "Fields",
            Object::Array(lock.fields.iter().map(|f| text_string(f)).collect()),
        );
    }
    p.set("V", name("1.2"));
    p
}

/// `/Lock` dictionary of a signature field → FieldLock.
pub fn lock_from_dict(pdf: &Pdf, d: &Dictionary) -> Option<FieldLock> {
    let action =
        LockAction::parse(std::str::from_utf8(pdfobj::get_name(pdf, d, b"Action")?).ok()?).ok()?;
    let fields = match pdfobj::get(pdf, d, b"Fields") {
        Some(Object::Array(a)) => a
            .iter()
            .filter_map(|o| match pdf.resolve(o)? {
                Object::String(s, _) => Some(pdfobj::decode_text(s)),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    };
    Some(FieldLock { action, fields })
}

fn default_placeholder(signer: &dyn Signer, level: Level) -> usize {
    let certs: usize = std::iter::once(signer.certificate())
        .chain(signer.chain().iter())
        .map(|c| c.der.len())
        .sum();
    let ts = if level >= Level::BT { 12 * 1024 } else { 0 };
    (certs + 2048 + ts).div_ceil(1024) * 1024
}

struct Placed {
    field_name: String,
    sig_id: ObjectId,
}

/// Where the new signature goes: an existing empty field or a new one.
fn place_field(
    edit: &mut Edit<'_>,
    field: Option<&str>,
    page: usize,
    rect: Option<[f64; 4]>,
    sig_id: ObjectId,
    appearance_stream: Option<(Object, [f64; 4], i64)>,
    lock: Option<&FieldLock>,
) -> Result<Placed> {
    let pdf = edit.pdf;
    let root = pdf.root_id()?;
    let mut catalog = edit.dict(root)?;
    // AcroForm: direct in the catalog, referenced, or new.
    let (af_ref, mut af) = match catalog.get(b"AcroForm").ok() {
        Some(Object::Reference(id)) => (Some(*id), edit.dict(*id)?),
        Some(Object::Dictionary(d)) => (None, d.clone()),
        _ => (None, Dictionary::new()),
    };
    let existing = pdfobj::fields(pdf);
    let wanted = field.map(str::to_string);
    let target = wanted
        .as_ref()
        .and_then(|n| existing.iter().find(|f| &f.name == n));
    let placed_name;
    let widget_id;
    if let Some(f) = target {
        if f.ft.as_deref() != Some(b"Sig") {
            return Err(SignError::InvalidArgument(format!(
                "field {:?} is not a signature field",
                f.name
            )));
        }
        let fd = edit.dict(f.id)?;
        if fd.get(b"V").is_ok_and(|v| !matches!(v, Object::Null)) {
            return Err(SignError::NotAllowed(format!(
                "field {:?} is already signed",
                f.name
            )));
        }
        let mut fd = fd;
        fd.set("V", Object::Reference(sig_id));
        if let (Some(l), false) = (lock, fd.has(b"Lock")) {
            let mut ld = lock_params(l);
            ld.set("Type", name("SigFieldLock"));
            ld.remove(b"V");
            fd.set("Lock", Object::Dictionary(ld));
        }
        edit.set(f.id, Object::Dictionary(fd));
        widget_id = *f
            .widgets
            .first()
            .ok_or_else(|| SignError::InvalidArgument("signature field without widget".into()))?;
        placed_name = f.name.clone();
        if let Some((ap, _, _)) = appearance_stream {
            let mut wd = edit.dict(widget_id)?;
            let ap_id = edit.add(ap);
            let mut apd = Dictionary::new();
            apd.set("N", Object::Reference(ap_id));
            wd.set("AP", Object::Dictionary(apd));
            edit.set(widget_id, Object::Dictionary(wd));
        }
    } else {
        let names: Vec<&str> = existing.iter().map(|f| f.name.as_str()).collect();
        placed_name = match wanted {
            Some(n) => {
                if n.contains('.') || n.is_empty() {
                    return Err(SignError::InvalidArgument(
                        "field names cannot contain '.'".into(),
                    ));
                }
                n
            }
            None => (1..)
                .map(|i| format!("Signature{i}"))
                .find(|n| !names.contains(&n.as_str()))
                .unwrap_or_else(|| "Signature".into()),
        };
        let pages = warraq_pdf::pages::flatten(pdf)?;
        let pinfo = pages.get(page).ok_or_else(|| {
            SignError::InvalidArgument(format!(
                "page {page} does not exist ({} pages)",
                pages.len()
            ))
        })?;
        let r = rect.unwrap_or([0.0, 0.0, 0.0, 0.0]);
        let mut w = Dictionary::new();
        w.set("FT", name("Sig"));
        w.set("T", text_string(&placed_name));
        w.set("V", Object::Reference(sig_id));
        w.set("Type", name("Annot"));
        w.set("Subtype", name("Widget"));
        // Print + Locked.
        w.set("F", Object::Integer(132));
        w.set("Rect", Object::Array(r.iter().map(|v| num(*v)).collect()));
        w.set("P", Object::Reference(pinfo.id));
        if let Some(l) = lock {
            let mut ld = lock_params(l);
            ld.set("Type", name("SigFieldLock"));
            ld.remove(b"V");
            w.set("Lock", Object::Dictionary(ld));
        }
        let ap = match appearance_stream {
            Some((ap, _, rot)) => {
                if rot != 0 {
                    let mut mk = Dictionary::new();
                    mk.set("R", Object::Integer(rot));
                    w.set("MK", Object::Dictionary(mk));
                }
                ap
            }
            None => Object::Stream(appearance::empty_form()),
        };
        let ap_id = edit.add(ap);
        let mut apd = Dictionary::new();
        apd.set("N", Object::Reference(ap_id));
        w.set("AP", Object::Dictionary(apd));
        let wid = edit.add(Object::Dictionary(w));
        widget_id = wid;
        // Page /Annots.
        let mut page_d = edit.dict(pinfo.id)?;
        match page_d.get(b"Annots").ok().cloned() {
            Some(Object::Reference(aid)) => {
                let mut arr = match edit.get(aid) {
                    Some(Object::Array(a)) => a.clone(),
                    _ => Vec::new(),
                };
                arr.push(Object::Reference(wid));
                edit.set(aid, Object::Array(arr));
            }
            Some(Object::Array(mut a)) => {
                a.push(Object::Reference(wid));
                page_d.set("Annots", Object::Array(a));
                edit.set(pinfo.id, Object::Dictionary(page_d));
            }
            _ => {
                page_d.set("Annots", Object::Array(vec![Object::Reference(wid)]));
                edit.set(pinfo.id, Object::Dictionary(page_d));
            }
        }
        // AcroForm /Fields.
        match af.get(b"Fields").ok().cloned() {
            Some(Object::Reference(fid)) => {
                let mut arr = match edit.get(fid) {
                    Some(Object::Array(a)) => a.clone(),
                    _ => Vec::new(),
                };
                arr.push(Object::Reference(wid));
                edit.set(fid, Object::Array(arr));
            }
            Some(Object::Array(mut a)) => {
                a.push(Object::Reference(wid));
                af.set("Fields", Object::Array(a));
            }
            _ => af.set("Fields", Object::Array(vec![Object::Reference(wid)])),
        }
    }
    let _ = widget_id;
    af.set("SigFlags", Object::Integer(3));
    match af_ref {
        Some(id) => edit.set(id, Object::Dictionary(af)),
        None => {
            catalog.set("AcroForm", Object::Dictionary(af));
        }
    }
    edit.set(root, Object::Dictionary(catalog));
    Ok(Placed {
        field_name: placed_name,
        sig_id,
    })
}

/// Sign `pdf` (PAdES B-B) as one incremental update. For levels B-T and above the result
/// also carries the timestamp request for the signature value; pass the TSA's answer to
/// [`finish`].
pub fn sign(pdf: &Pdf, signer: &dyn Signer, opts: &SignOptions) -> Result<SignOutput> {
    pdf.require("signing", |p| p.fill_forms || p.modify || p.annotate)?;
    if let Some(p) = docmdp_permission(pdf) {
        if p == 1 {
            return Err(SignError::NotAllowed(
                "the document is certified with no changes allowed".into(),
            ));
        }
    }
    if let Some(p) = opts.certify {
        if !(1..=3).contains(&p) {
            return Err(SignError::InvalidArgument(
                "certification level must be 1, 2 or 3".into(),
            ));
        }
        if has_signed_fields(pdf) || docmdp_permission(pdf).is_some() {
            return Err(SignError::NotAllowed(
                "a certification signature must be the first signature in the document".into(),
            ));
        }
    }
    match crate::x509::document_signing_policy(signer.certificate()) {
        crate::x509::EkuVerdict::Accepted(_) => {}
        crate::x509::EkuVerdict::Rejected(why) => return Err(SignError::NotAllowed(why)),
    }
    if opts.time != 0 && !signer.certificate().valid_at(opts.time) {
        return Err(SignError::NotAllowed(
            "the signing certificate is expired or not yet valid".into(),
        ));
    }
    sign_unchecked(pdf, signer, opts)
}

/// [`sign`] without the certificate policy checks (extended key usage, validity). Only for
/// building negative test fixtures; the RPC layer never calls it.
#[doc(hidden)]
pub fn sign_unchecked(pdf: &Pdf, signer: &dyn Signer, opts: &SignOptions) -> Result<SignOutput> {
    let size = opts
        .placeholder
        .unwrap_or_else(|| default_placeholder(signer, opts.level));
    if size == 0 || size > MAX_PLACEHOLDER {
        return Err(SignError::InvalidArgument("placeholder size".into()));
    }
    let mut edit = Edit::new(pdf);
    let sig_id = edit.reserve();
    let signer_name = opts
        .name
        .clone()
        .unwrap_or_else(|| signer.certificate().display_name());
    // Appearance: an existing empty field keeps its own widget rectangle and page.
    let existing = opts.field.as_ref().and_then(|n| {
        pdfobj::fields(pdf)
            .into_iter()
            .find(|f| &f.name == n && f.ft.as_deref() == Some(b"Sig"))
    });
    let (ap_rect, ap_page) = match existing.as_ref().and_then(|f| f.widgets.first().copied()) {
        Some(w) => {
            let wd = pdf.get_dict(w);
            let r = wd.and_then(|d| pdfobj::get_rect(pdf, d, b"Rect"));
            let page = wd
                .and_then(|d| d.get(b"P").ok())
                .and_then(|o| o.as_reference().ok())
                .and_then(|pid| {
                    warraq_pdf::pages::flatten(pdf)
                        .ok()?
                        .iter()
                        .position(|p| p.id == pid)
                })
                .unwrap_or(opts.page);
            (r.or(opts.rect), page)
        }
        None => (opts.rect, opts.page),
    };
    // A field's own /Lock becomes this signature's FieldMDP (ISO 32000-2 12.7.5.5).
    let lock = opts.lock.clone().or_else(|| {
        let f = existing.as_ref()?;
        let fd = pdf.get_dict(f.id)?;
        match pdfobj::get(pdf, fd, b"Lock")? {
            Object::Dictionary(ld) => lock_from_dict(pdf, ld),
            _ => None,
        }
    });
    let ap = match ap_rect {
        Some(r) if (r[2] - r[0]).abs() > 1.0 && (r[3] - r[1]).abs() > 1.0 => {
            let rot = warraq_pdf::pages::flatten(pdf)?
                .get(ap_page)
                .map(|p| p.rotate.rem_euclid(360))
                .unwrap_or(0);
            let spec = opts.appearance.clone().unwrap_or_default();
            let lines = spec.lines_or_default(
                &signer_name,
                opts.time,
                opts.reason.as_deref(),
                opts.location.as_deref(),
            );
            let stream = appearance::build(&mut edit, r, rot, &lines)?;
            Some((Object::Stream(stream), r, rot))
        }
        _ => None,
    };
    let rect = opts.rect.map(|r| {
        [
            r[0].min(r[2]),
            r[1].min(r[3]),
            r[0].max(r[2]),
            r[1].max(r[3]),
        ]
    });
    let placed = place_field(
        &mut edit,
        opts.field.as_deref(),
        opts.page,
        rect,
        sig_id,
        ap,
        lock.as_ref(),
    )?;
    // Signature dictionary.
    let mut sd = Dictionary::new();
    sd.set("Type", name("Sig"));
    sd.set("Filter", name("Adobe.PPKLite"));
    sd.set("SubFilter", name("ETSI.CAdES.detached"));
    sd.set("ByteRange", placeholder_byte_range());
    sd.set(
        "Contents",
        Object::String(vec![0; size], StringFormat::Hexadecimal),
    );
    sd.set("M", text_string(&pdfobj::pdf_date(opts.time)));
    sd.set("Name", text_string(&signer_name));
    if let Some(r) = &opts.reason {
        sd.set("Reason", text_string(r));
    }
    if let Some(l) = &opts.location {
        sd.set("Location", text_string(l));
    }
    if let Some(c) = &opts.contact_info {
        sd.set("ContactInfo", text_string(c));
    }
    let mut refs = Vec::new();
    if let Some(p) = opts.certify {
        let mut tp = Dictionary::new();
        tp.set("Type", name("TransformParams"));
        tp.set("P", Object::Integer(i64::from(p)));
        tp.set("V", name("1.2"));
        refs.push(sig_ref("DocMDP", tp));
    }
    if let Some(l) = &lock {
        refs.push(sig_ref("FieldMDP", lock_params(l)));
    }
    if !refs.is_empty() {
        sd.set("Reference", Object::Array(refs));
    }
    let mut app = Dictionary::new();
    app.set("Name", name("ZOOD PDF"));
    let mut pb = Dictionary::new();
    pb.set("App", Object::Dictionary(app));
    sd.set("Prop_Build", Object::Dictionary(pb));
    edit.set(placed.sig_id, Object::Dictionary(sd));
    if opts.certify.is_some() {
        let root = pdf.root_id()?;
        let mut cat = edit.dict(root)?;
        let mut perms = Dictionary::new();
        perms.set("DocMDP", Object::Reference(placed.sig_id));
        cat.set("Perms", Object::Dictionary(perms));
        edit.set(root, Object::Dictionary(cat));
    }
    let mut bytes = edit.build()?;
    let (br_at, lt, gt) = locate(&bytes, pdf.bytes().len(), size)?;
    let range = patch_byte_range(&mut bytes, br_at, lt, gt)?;
    let hash = signer.digest_algorithm();
    let digest = range_digest(&bytes, range, hash)?;
    let cms_der = cms::build_signed_data(signer, &digest, Vec::new())?;
    patch_contents(&mut bytes, lt, gt, &cms_der)?;
    let tsa_request = if opts.level >= Level::BT {
        let parsed = cms::ParsedCms::parse(&cms_der)?;
        let imprint = HashAlg::Sha256.digest(parsed.signature_value()?);
        Some(tsp::build_request(HashAlg::Sha256, &imprint)?)
    } else {
        None
    };
    Ok(SignOutput {
        bytes,
        field: placed.field_name,
        byte_range: range,
        tsa_request,
        cms_len: cms_der.len(),
        placeholder: size,
    })
}

/// Options for a document timestamp (B-LTA).
#[derive(Debug, Clone, Default)]
pub struct DocTimestampOptions {
    /// Field name (default `DocTimeStamp{n}`).
    pub field: Option<String>,
    /// Placeholder size (default 16 KiB).
    pub placeholder: Option<usize>,
}

/// Append a `/DocTimeStamp` placeholder (`/SubFilter /ETSI.RFC3161`) as an incremental
/// update and return the bytes plus the timestamp request over its byte range. The returned
/// file is *pending* (zero `/Contents`) until [`finish`] fills it with the TSA's token.
pub fn prepare_doc_timestamp(pdf: &Pdf, opts: &DocTimestampOptions) -> Result<SignOutput> {
    pdf.require("adding a document timestamp", |p| {
        p.fill_forms || p.modify || p.annotate
    })?;
    let size = opts.placeholder.unwrap_or(16 * 1024);
    if size == 0 || size > MAX_PLACEHOLDER {
        return Err(SignError::InvalidArgument("placeholder size".into()));
    }
    let mut edit = Edit::new(pdf);
    let sig_id = edit.reserve();
    let existing: Vec<String> = pdfobj::fields(pdf).into_iter().map(|f| f.name).collect();
    let field = opts.field.clone().unwrap_or_else(|| {
        (1..)
            .map(|i| format!("DocTimeStamp{i}"))
            .find(|n| !existing.contains(n))
            .unwrap_or_else(|| "DocTimeStamp".into())
    });
    let placed = place_field(&mut edit, Some(&field), 0, None, sig_id, None, None)?;
    let mut sd = Dictionary::new();
    sd.set("Type", name("DocTimeStamp"));
    sd.set("Filter", name("Adobe.PPKLite"));
    sd.set("SubFilter", name("ETSI.RFC3161"));
    sd.set("ByteRange", placeholder_byte_range());
    sd.set(
        "Contents",
        Object::String(vec![0; size], StringFormat::Hexadecimal),
    );
    edit.set(sig_id, Object::Dictionary(sd));
    let mut bytes = edit.build()?;
    let (br_at, lt, gt) = locate(&bytes, pdf.bytes().len(), size)?;
    let range = patch_byte_range(&mut bytes, br_at, lt, gt)?;
    let digest = range_digest(&bytes, range, HashAlg::Sha256)?;
    let req = tsp::build_request(HashAlg::Sha256, &digest)?;
    Ok(SignOutput {
        bytes,
        field: placed.field_name,
        byte_range: range,
        tsa_request: Some(req),
        cms_len: 0,
        placeholder: size,
    })
}

/// A signature dictionary located in a file (the newest definition of its object).
#[derive(Debug, Clone)]
pub struct SigSlot {
    /// Field name.
    pub field: String,
    /// Signature dictionary object id.
    pub sig_id: ObjectId,
    /// `/ByteRange`.
    pub range: [usize; 4],
    /// `/Contents` bytes.
    pub contents: Vec<u8>,
    /// `/Type` (`Sig` or `DocTimeStamp`).
    pub kind: Vec<u8>,
    /// `/SubFilter`.
    pub sub_filter: Vec<u8>,
}

/// Signature fields with a value, in byte-range order.
pub fn signature_slots(pdf: &Pdf) -> Vec<SigSlot> {
    let mut out = Vec::new();
    for f in pdfobj::fields(pdf) {
        if f.ft.as_deref() != Some(b"Sig") {
            continue;
        }
        let Some(fd) = pdf.get_dict(f.id) else {
            continue;
        };
        let Ok(Object::Reference(sig_id)) = fd.get(b"V") else {
            continue;
        };
        let Some(sd) = pdf.get_dict(*sig_id) else {
            continue;
        };
        let range = match pdfobj::get(pdf, sd, b"ByteRange") {
            Some(Object::Array(a)) if a.len() == 4 => {
                let mut r = [0usize; 4];
                let mut ok = true;
                for (i, slot) in r.iter_mut().enumerate() {
                    match a
                        .get(i)
                        .and_then(|o| o.as_i64().ok())
                        .and_then(|v| usize::try_from(v).ok())
                    {
                        Some(v) => *slot = v,
                        None => ok = false,
                    }
                }
                if !ok {
                    continue;
                }
                r
            }
            _ => continue,
        };
        out.push(SigSlot {
            field: f.name.clone(),
            sig_id: *sig_id,
            range,
            contents: pdfobj::get_bytes(pdf, sd, b"Contents")
                .unwrap_or_default()
                .to_vec(),
            kind: pdfobj::get_name(pdf, sd, b"Type")
                .unwrap_or(b"Sig")
                .to_vec(),
            sub_filter: pdfobj::get_name(pdf, sd, b"SubFilter")
                .unwrap_or_default()
                .to_vec(),
        });
    }
    out.sort_by_key(|s| s.range[2].saturating_add(s.range[3]));
    out
}

/// What [`finish`] completed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Finished {
    /// A signature timestamp was added to the signature in `field`.
    SignatureTimestamp {
        /// Field.
        field: String,
    },
    /// The pending document timestamp in `field` was filled.
    DocumentTimestamp {
        /// Field.
        field: String,
    },
}

/// Complete the pending step with a TSA response: fill a pending document timestamp, or add
/// a signature timestamp (unsigned attribute) to the newest signature. Both rewrite only the
/// `/Contents` hex string in place (which no signature covers), so every byte range stays
/// valid and the file length is unchanged.
pub fn finish(pdf: &Pdf, tsa_response: &[u8]) -> Result<(Vec<u8>, Finished, tsp::TokenCheck)> {
    let slots = signature_slots(pdf);
    let last = slots
        .last()
        .ok_or_else(|| SignError::InvalidArgument("the document has no signature".into()))?;
    let bytes = pdf.bytes();
    let lt = last.range[1];
    let gt = last.range[2].saturating_sub(1);
    if bytes.get(lt) != Some(&b'<') || bytes.get(gt) != Some(&b'>') || last.range[0] != 0 {
        return Err(SignError::InvalidArgument(
            "the newest signature has an unusual layout".into(),
        ));
    }
    let mut out = bytes.to_vec();
    if last.contents.iter().all(|b| *b == 0) {
        if last.kind != b"DocTimeStamp" {
            return Err(SignError::InvalidArgument(
                "pending signature without a value".into(),
            ));
        }
        let digest = range_digest(bytes, last.range, HashAlg::Sha256)?;
        let (token, check) = tsp::accept_response(tsa_response, HashAlg::Sha256, &digest)?;
        patch_contents(&mut out, lt, gt, &token)?;
        return Ok((
            out,
            Finished::DocumentTimestamp {
                field: last.field.clone(),
            },
            check,
        ));
    }
    if last.kind == b"DocTimeStamp" {
        return Err(SignError::InvalidArgument(
            "the document timestamp is already complete".into(),
        ));
    }
    let parsed = cms::ParsedCms::parse(&last.contents)?;
    if parsed
        .unsigned_attr(oids::SIGNATURE_TIMESTAMP_TOKEN)?
        .is_some()
    {
        return Err(SignError::InvalidArgument(
            "the signature already has a timestamp".into(),
        ));
    }
    let imprint = HashAlg::Sha256.digest(parsed.signature_value()?);
    let (token, check) = tsp::accept_response(tsa_response, HashAlg::Sha256, &imprint)?;
    let new_cms = cms::set_unsigned_attr(
        &parsed.der,
        oids::SIGNATURE_TIMESTAMP_TOKEN,
        tsp::token_any(&token)?,
    )?;
    patch_contents(&mut out, lt, gt, &new_cms)?;
    Ok((
        out,
        Finished::SignatureTimestamp {
            field: last.field.clone(),
        },
        check,
    ))
}

/// Validation material for the Document Security Store.
#[derive(Debug, Clone, Default)]
pub struct DssMaterial {
    /// DER certificates.
    pub certs: Vec<Vec<u8>>,
    /// DER OCSPResponse objects.
    pub ocsps: Vec<Vec<u8>>,
    /// DER CRLs.
    pub crls: Vec<Vec<u8>>,
}

fn dss_array(edit: &Edit<'_>, dss: &Dictionary, key: &[u8]) -> Vec<Object> {
    match dss.get(key).ok().and_then(|o| edit.resolve(o)) {
        Some(Object::Array(a)) => a.clone(),
        _ => Vec::new(),
    }
}

/// Append a DSS (B-LT) update: `/DSS << /Certs /OCSPs /CRLs /VRI >>`, merged with any
/// existing DSS. VRI entries (key: uppercase hex SHA-1 of each signature's `/Contents`)
/// list the material added here.
pub fn add_dss(pdf: &Pdf, m: &DssMaterial) -> Result<Vec<u8>> {
    pdf.require("adding validation data", |p| {
        p.fill_forms || p.modify || p.annotate
    })?;
    for c in &m.certs {
        crate::x509::Cert::from_der(c)?;
    }
    for o in &m.ocsps {
        crate::ocsp::parse_response(o)?;
    }
    for c in &m.crls {
        crate::ocsp::parse_crl(c)?;
    }
    let mut edit = Edit::new(pdf);
    let root = pdf.root_id()?;
    let mut cat = edit.dict(root)?;
    let (dss_ref, mut dss) = match cat.get(b"DSS").ok() {
        Some(Object::Reference(id)) => (Some(*id), edit.dict(*id)?),
        Some(Object::Dictionary(d)) => (None, d.clone()),
        _ => (None, Dictionary::new()),
    };
    // Existing streams by content, for de-duplication.
    let existing_digest = |edit: &Edit<'_>, arr: &[Object]| -> Vec<(Vec<u8>, Object)> {
        arr.iter()
            .filter_map(|o| match edit.resolve(o) {
                Some(Object::Stream(s)) => {
                    let data = warraq_pdf::limits::decode_stream(s, pdf.limits()).ok()?;
                    Some((HashAlg::Sha256.digest(&data), o.clone()))
                }
                _ => None,
            })
            .collect()
    };
    let mut added: Vec<(&str, Object)> = Vec::new();
    for (key, items) in [("Certs", &m.certs), ("OCSPs", &m.ocsps), ("CRLs", &m.crls)] {
        let mut arr = dss_array(&edit, &dss, key.as_bytes());
        let known = existing_digest(&edit, &arr);
        for item in items {
            let h = HashAlg::Sha256.digest(item);
            if let Some((_, r)) = known.iter().find(|(d, _)| *d == h) {
                added.push((key, r.clone()));
                continue;
            }
            let mut st = Stream::new(Dictionary::new(), item.clone());
            let _ = st.compress();
            let id = edit.add(Object::Stream(st));
            arr.push(Object::Reference(id));
            added.push((key, Object::Reference(id)));
        }
        if !arr.is_empty() {
            dss.set(key, Object::Array(arr));
        }
    }
    // VRI.
    let mut vri = match dss.get(b"VRI").ok().and_then(|o| edit.resolve(o)) {
        Some(Object::Dictionary(d)) => d.clone(),
        _ => Dictionary::new(),
    };
    for slot in signature_slots(pdf) {
        if slot.contents.iter().all(|b| *b == 0) {
            continue;
        }
        let key = hex_upper(&HashAlg::Sha1.digest(&slot.contents));
        let mut entry = match vri.get(key.as_bytes()).ok().and_then(|o| edit.resolve(o)) {
            Some(Object::Dictionary(d)) => d.clone(),
            _ => Dictionary::new(),
        };
        for (dss_key, vri_key) in [("Certs", "Cert"), ("OCSPs", "OCSP"), ("CRLs", "CRL")] {
            let mut arr = match entry.get(vri_key.as_bytes()).ok() {
                Some(Object::Array(a)) => a.clone(),
                _ => Vec::new(),
            };
            for (k, r) in &added {
                if *k == dss_key && !arr.contains(r) {
                    arr.push(r.clone());
                }
            }
            if !arr.is_empty() {
                entry.set(vri_key, Object::Array(arr));
            }
        }
        vri.set(key.as_bytes().to_vec(), Object::Dictionary(entry));
    }
    if !vri.is_empty() {
        dss.set("VRI", Object::Dictionary(vri));
    }
    dss.set("Type", name("DSS"));
    match dss_ref {
        Some(id) => edit.set(id, Object::Dictionary(dss)),
        None => {
            let id = edit.add(Object::Dictionary(dss));
            cat.set("DSS", Object::Reference(id));
            edit.set(root, Object::Dictionary(cat));
        }
    }
    edit.build()
}
