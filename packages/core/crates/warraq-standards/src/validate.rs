//! The validator: every rule of [`crate::rules::RULES`] that applies to the target profile.

use crate::fonts::{self, FontInfo};
use crate::icc;
use crate::model::{
    self, dict, get, get_dict, get_name, get_num, name_str, num, ref_id, Device, Key, Model,
};
use crate::profile::Profile;
use crate::rawscan;
use crate::report::{Report, Sink, F};
use crate::xmp::{self, Date, Xmp};
use std::collections::{BTreeSet, HashSet};
use ttf_parser::{Face, GlyphId};
use warraq_pdf::lopdf::{Dictionary, Object, ObjectId, Stream};
use warraq_pdf::{metadata, PasswordKind, Pdf};

/// Annotation types defined by PDF 1.4 (PDF/A-1) minus FileAttachment, Sound and Movie.
const A1_ANNOTS: &[&[u8]] = &[
    b"Text",
    b"Link",
    b"FreeText",
    b"Line",
    b"Square",
    b"Circle",
    b"Highlight",
    b"Underline",
    b"Squiggly",
    b"StrikeOut",
    b"Stamp",
    b"Ink",
    b"Popup",
    b"Widget",
    b"PrinterMark",
    b"TrapNet",
];
/// Annotation types of ISO 32000-1 minus 3D, Sound, Screen and Movie (PDF/A-2/3).
const A2_ANNOTS: &[&[u8]] = &[
    b"Text",
    b"Link",
    b"FreeText",
    b"Line",
    b"Square",
    b"Circle",
    b"Polygon",
    b"PolyLine",
    b"Highlight",
    b"Underline",
    b"Squiggly",
    b"StrikeOut",
    b"Stamp",
    b"Caret",
    b"Ink",
    b"Popup",
    b"FileAttachment",
    b"Widget",
    b"PrinterMark",
    b"TrapNet",
    b"Watermark",
    b"Redact",
];
/// Standard blend modes (ISO 32000-1 11.3.5).
pub const BLEND_MODES: &[&[u8]] = &[
    b"Normal",
    b"Compatible",
    b"Multiply",
    b"Screen",
    b"Overlay",
    b"Darken",
    b"Lighten",
    b"ColorDodge",
    b"ColorBurn",
    b"HardLight",
    b"SoftLight",
    b"Difference",
    b"Exclusion",
    b"Hue",
    b"Saturation",
    b"Color",
    b"Luminosity",
];
/// Every action type name (used to recognise action dictionaries by /S).
const ACTIONS: &[&[u8]] = &[
    b"GoTo",
    b"GoToR",
    b"GoToE",
    b"Launch",
    b"Thread",
    b"URI",
    b"Sound",
    b"Movie",
    b"Hide",
    b"Named",
    b"SubmitForm",
    b"ResetForm",
    b"ImportData",
    b"JavaScript",
    b"SetOCGState",
    b"Rendition",
    b"Trans",
    b"GoTo3DView",
    b"SetState",
    b"NoOp",
    b"RichMediaExecute",
];
/// Named actions PDF/A allows.
pub const NAMED_OK: &[&[u8]] = &[b"NextPage", b"PrevPage", b"FirstPage", b"LastPage"];
/// Annotation types for which the converter can draw an appearance.
pub const DRAWABLE: &[&[u8]] = &[
    b"Square",
    b"Circle",
    b"Line",
    b"Ink",
    b"Polygon",
    b"PolyLine",
    b"Highlight",
    b"Underline",
    b"StrikeOut",
    b"Squiggly",
    b"Text",
];

/// Forbidden action types for a profile (JavaScript is its own rule).
pub fn forbidden_actions(p: Profile) -> &'static [&'static [u8]] {
    if p == Profile::A1b {
        &[
            b"Launch",
            b"Sound",
            b"Movie",
            b"ResetForm",
            b"ImportData",
            b"Hide",
            b"SetState",
            b"NoOp",
            b"SetOCGState",
            b"Rendition",
            b"Trans",
            b"GoTo3DView",
            b"RichMediaExecute",
            b"GoToE",
        ]
    } else {
        &[
            b"Launch",
            b"Sound",
            b"Movie",
            b"ResetForm",
            b"ImportData",
            b"Hide",
            b"SetOCGState",
            b"Rendition",
            b"Trans",
            b"GoTo3DView",
            b"SetState",
            b"NoOp",
            b"RichMediaExecute",
        ]
    }
}

/// Whether an annotation subtype is allowed.
pub fn annot_allowed(p: Profile, subtype: &[u8]) -> bool {
    match p {
        Profile::A1b => A1_ANNOTS.contains(&subtype),
        Profile::X4 => true,
        _ => A2_ANNOTS.contains(&subtype),
    }
}

/// The output intent relevant to a profile.
#[derive(Debug, Clone)]
pub struct Intent {
    /// Parsed header of its DestOutputProfile.
    pub header: Option<icc::IccHeader>,
    /// Profile stream id.
    pub profile_id: Option<ObjectId>,
}

/// The PDF/A (GTS_PDFA1) or PDF/X (GTS_PDFX) output intent, if any with a valid profile.
pub fn intent(pdf: &Pdf, subtype: &[u8]) -> Option<Intent> {
    let cat = pdf.catalog().ok()?;
    let Some(Object::Array(ois)) = get(pdf, cat, b"OutputIntents") else {
        return None;
    };
    for o in ois {
        let Some(d) = dict(pdf, o) else { continue };
        if get_name(pdf, d, b"S") != Some(subtype) {
            continue;
        }
        let po = d.get(b"DestOutputProfile").ok();
        let header = po
            .and_then(|p| model::stream(pdf, p))
            .and_then(|s| model::decoded(pdf, s))
            .and_then(|b| icc::parse_header(&b).ok());
        return Some(Intent {
            header,
            profile_id: po.and_then(ref_id),
        });
    }
    None
}

/// Visit every direct/nested dictionary and value of `obj` (bounded depth).
fn walk(obj: &Object, depth: usize, f: &mut dyn FnMut(&Object, Option<&Stream>, usize)) {
    if depth > 64 {
        return;
    }
    f(obj, None, depth);
    match obj {
        Object::Array(a) => {
            for o in a {
                walk(o, depth + 1, f);
            }
        }
        Object::Dictionary(d) => {
            for (_, v) in d.iter() {
                walk(v, depth + 1, f);
            }
        }
        Object::Stream(s) => {
            f(&Object::Dictionary(Dictionary::new()), Some(s), depth);
            for (_, v) in s.dict.iter() {
                walk(v, depth + 1, f);
            }
        }
        _ => {}
    }
}

fn filters(pdf: &Pdf, d: &Dictionary) -> Vec<Vec<u8>> {
    match get(pdf, d, b"Filter") {
        Some(Object::Name(n)) => vec![n.clone()],
        Some(Object::Array(a)) => a
            .iter()
            .filter_map(|o| pdf.resolve(o)?.as_name().ok().map(<[u8]>::to_vec))
            .collect(),
        _ => Vec::new(),
    }
}

struct Ctx<'a> {
    pdf: &'a Pdf,
    p: Profile,
    m: &'a Model,
    oi: Option<Intent>,
}

/// Validate an opened document against `profile`.
pub fn validate(pdf: &Pdf, profile: Profile) -> Report {
    let mut sink = Sink::new(profile);
    rawscan::header_and_eof(pdf.bytes(), &mut sink);
    rawscan::tokens(pdf, &mut sink);
    let m = model::build(pdf);
    let oi = intent(
        pdf,
        if profile == Profile::X4 {
            b"GTS_PDFX"
        } else {
            b"GTS_PDFA1"
        },
    );
    let c = Ctx {
        pdf,
        p: profile,
        m: &m,
        oi,
    };
    structure(&c, &mut sink);
    objects(&c, &mut sink);
    metadata_rules(&c, &mut sink);
    colour(&c, &mut sink);
    transparency_and_xobjects(&c, &mut sink);
    let needed = font_rules(&c, &mut sink);
    annotations(&c, &mut sink);
    catalog_rules(&c, &mut sink);
    pages(&c, &mut sink);
    // PDF/A-1: a transparency group is removable only when nothing else uses transparency.
    if profile == Profile::A1b
        && ["transparency-smask", "transparency-alpha", "blend-mode"]
            .iter()
            .all(|r| sink.count(r) == 0)
    {
        sink.mark_fixable("transparency-group", true);
    }
    sink.finish(m.incomplete, needed)
}

/// Open `bytes` (optionally with a password) and validate.
pub fn validate_bytes(
    bytes: Vec<u8>,
    password: Option<&str>,
    profile: Profile,
) -> warraq_pdf::Result<Report> {
    let pdf = Pdf::open(bytes, password)?;
    Ok(validate(&pdf, profile))
}

// ---------------------------------------------------------------- file structure

fn structure(c: &Ctx<'_>, s: &mut Sink) {
    let pdf = c.pdf;
    let id_ok = matches!(pdf.trailer().get(b"ID"), Ok(Object::Array(a)) if a.len() == 2 && a.iter().all(|x| matches!(x, Object::String(..))));
    if !id_ok {
        s.push(F::new("trailer-id", "missing", "The trailer has no /ID").fixable(true));
    }
    if let Some(sec) = pdf.security() {
        s.push(
            F::new("no-encryption", "encrypted", "The file is encrypted")
                .fixable(sec.matched == PasswordKind::Owner || pdf.permissions().modify),
        );
    }
    if c.p == Profile::A1b {
        let objstm = pdf.objects().values().any(|o| matches!(o, Object::Stream(st) if st.dict.has_type(b"ObjStm") || st.dict.has_type(b"XRef")));
        if pdf.xref_kind() == warraq_pdf::XrefKind::Stream || objstm {
            s.push(
                F::new(
                    "xref-syntax",
                    "streams",
                    "PDF/A-1 does not allow cross-reference streams or object streams",
                )
                .fixable(true),
            );
        }
    }
    let len = pdf.bytes().len() as i64;
    for (id, o) in pdf.objects() {
        if let Object::Dictionary(d) = o {
            if d.has(b"Linearized") {
                let l = get_num(pdf, d, b"L").map(|v| v as i64);
                if l != Some(len) {
                    s.push(
                        F::new(
                            "linearization",
                            "stale",
                            "The linearization dictionary no longer describes the file",
                        )
                        .obj(Some(*id))
                        .fixable(true),
                    );
                }
            }
        }
    }
    let count = pdf.objects().len();
    if count > 8_388_607 {
        s.push(
            F::new(
                "impl-limits-objects",
                "objects",
                "More than 8,388,607 indirect objects",
            )
            .param("value", count),
        );
    }
}

/// Generic checks over every reachable object.
fn objects(c: &Ctx<'_>, s: &mut Sink) {
    let pdf = c.pdf;
    let a1 = c.p == Profile::A1b;
    let ids = pdf.reachable().unwrap_or_default();
    let forbidden = forbidden_actions(c.p);
    for id in ids {
        let Some(obj) = pdf.get(id) else { continue };
        let holder = Some(id);
        walk(obj, 0, &mut |o, st, _| match (o, st) {
            (_, Some(stm)) => stream_checks(c, s, id, stm),
            (Object::Integer(i), _) => {
                if *i > i64::from(i32::MAX) || *i < i64::from(i32::MIN) {
                    s.push(
                        F::new(
                            "impl-limits-objects",
                            "integer",
                            "An integer is outside ±2^31",
                        )
                        .obj(holder)
                        .param("value", i),
                    );
                }
            }
            (Object::Real(r), _) => {
                if a1 && f64::from(*r).abs() > 32_767.0 {
                    s.push(
                        F::new(
                            "impl-limits-objects",
                            "real",
                            "A real number exceeds ±32,767 (PDF/A-1)",
                        )
                        .obj(holder)
                        .param("value", r),
                    );
                }
            }
            (Object::String(b, _), _) => {
                let max = if a1 { 65_535 } else { 32_767 };
                if b.len() > max {
                    s.push(
                        F::new(
                            "impl-limits-objects",
                            "string",
                            "A string is longer than the limit",
                        )
                        .obj(holder)
                        .param("value", b.len())
                        .param("max", max),
                    );
                }
            }
            (Object::Name(n), _) => {
                if n.len() > 127 {
                    s.push(
                        F::new(
                            "impl-limits-objects",
                            "name",
                            "A name is longer than 127 bytes",
                        )
                        .obj(holder)
                        .param("value", n.len()),
                    );
                }
                if !a1 && std::str::from_utf8(n).is_err() {
                    s.push(
                        F::new("impl-limits-objects", "utf8", "A name is not valid UTF-8")
                            .obj(holder),
                    );
                }
            }
            (Object::Array(a), _) => {
                if a1 && a.len() > 8191 {
                    s.push(
                        F::new(
                            "impl-limits-objects",
                            "array",
                            "An array has more than 8,191 elements (PDF/A-1)",
                        )
                        .obj(holder)
                        .param("value", a.len()),
                    );
                }
            }
            (Object::Dictionary(d), _) => {
                if a1 && d.len() > 4095 {
                    s.push(
                        F::new(
                            "impl-limits-objects",
                            "dict",
                            "A dictionary has more than 4,095 entries (PDF/A-1)",
                        )
                        .obj(holder)
                        .param("value", d.len()),
                    );
                }
                dict_checks(c, s, id, d, forbidden);
            }
            _ => {}
        });
    }
}

fn stream_checks(c: &Ctx<'_>, s: &mut Sink, id: ObjectId, st: &Stream) {
    let pdf = c.pdf;
    let d = &st.dict;
    let holder = Some(id);
    for k in ["F", "FFilter", "FDecodeParms"] {
        if d.has(k.as_bytes()) {
            s.push(
                F::new(
                    "external-streams",
                    "key",
                    "A stream refers to external data",
                )
                .obj(holder)
                .param("key", k),
            );
        }
    }
    let fl = filters(pdf, d);
    if fl.iter().any(|f| f == b"LZWDecode") {
        s.push(
            F::new(
                "stream-filters",
                "lzw",
                "A stream uses the LZWDecode filter",
            )
            .obj(holder)
            .fixable(true),
        );
    }
    if fl.iter().any(|f| f == b"Crypt") && c.p != Profile::A1b {
        let identity = match get(pdf, d, b"DecodeParms") {
            Some(Object::Dictionary(p)) => {
                get_name(pdf, p, b"Name").is_none_or(|n| n == b"Identity")
            }
            Some(Object::Array(a)) => a
                .iter()
                .filter_map(|o| dict(pdf, o))
                .all(|p| get_name(pdf, p, b"Name").is_none_or(|n| n == b"Identity")),
            _ => true,
        };
        if !identity {
            s.push(
                F::new(
                    "stream-filters",
                    "crypt",
                    "A stream uses a Crypt filter other than Identity",
                )
                .obj(holder),
            );
        }
    }
    if d.has_type(b"Metadata") && !fl.is_empty() {
        s.push(
            F::new(
                "metadata-no-filter",
                "filter",
                "A metadata stream is compressed",
            )
            .obj(holder)
            .fixable(true),
        );
    }
    match get_name(pdf, d, b"Subtype") {
        Some(b"Image") => {
            if d.has(b"Alternates") {
                s.push(
                    F::new("image-alternates", "alternates", "An image has /Alternates")
                        .obj(holder)
                        .fixable(true),
                );
            }
            if d.has(b"OPI") {
                s.push(
                    F::new("opi", "image", "An image has /OPI")
                        .obj(holder)
                        .fixable(true),
                );
            }
            if matches!(get(pdf, d, b"Interpolate"), Some(Object::Boolean(true))) {
                s.push(
                    F::new(
                        "image-interpolate",
                        "image",
                        "An image sets /Interpolate true",
                    )
                    .obj(holder)
                    .fixable(true),
                );
            }
            if let Some(n) = get_name(pdf, d, b"Intent") {
                if !model::INTENTS.contains(&n) {
                    s.push(
                        F::new(
                            "rendering-intent",
                            "image",
                            "An image has a non-standard rendering intent",
                        )
                        .obj(holder)
                        .param("value", name_str(n))
                        .fixable(true),
                    );
                }
            }
            if c.p == Profile::A1b {
                if d.has(b"SMask") {
                    s.push(
                        F::new(
                            "transparency-smask",
                            "image",
                            "An image has a soft mask (/SMask)",
                        )
                        .obj(holder),
                    );
                }
                if get_num(pdf, d, b"SMaskInData").is_some_and(|v| v != 0.0) {
                    s.push(
                        F::new(
                            "transparency-smask",
                            "jpx",
                            "A JPEG 2000 image carries its own soft mask (/SMaskInData)",
                        )
                        .obj(holder),
                    );
                }
            }
        }
        Some(b"Form") => {
            if d.has(b"OPI") {
                s.push(
                    F::new("opi", "form", "A form XObject has /OPI")
                        .obj(holder)
                        .fixable(true),
                );
            }
            if get_name(pdf, d, b"Subtype2") == Some(b"PS") || d.has(b"PS") {
                s.push(
                    F::new(
                        "postscript-reference-xobjects",
                        "form-ps",
                        "A form XObject carries PostScript (/Subtype2 /PS or /PS)",
                    )
                    .obj(holder)
                    .fixable(true),
                );
            }
            if d.has(b"Ref") {
                s.push(
                    F::new(
                        "postscript-reference-xobjects",
                        "ref",
                        "A reference XObject (/Ref) points to another file",
                    )
                    .obj(holder)
                    .fixable(true),
                );
            }
            if c.p == Profile::A1b {
                if let Some(g) = get_dict(pdf, d, b"Group") {
                    if get_name(pdf, g, b"S") == Some(b"Transparency") {
                        s.push(
                            F::new(
                                "transparency-group",
                                "form",
                                "A form XObject is a transparency group",
                            )
                            .obj(holder),
                        );
                    }
                }
            }
        }
        Some(b"PS") => {
            s.push(
                F::new(
                    "postscript-reference-xobjects",
                    "ps",
                    "A PostScript XObject is present",
                )
                .obj(holder),
            );
        }
        _ => {}
    }
}

fn is_field(d: &Dictionary) -> bool {
    d.has(b"FT") || (d.has(b"T") && (d.has(b"Kids") || d.has(b"Parent")))
}

fn dict_checks(c: &Ctx<'_>, s: &mut Sink, id: ObjectId, d: &Dictionary, forbidden: &[&[u8]]) {
    let pdf = c.pdf;
    let holder = Some(id);
    // Actions.
    if let Some(sn) = get_name(pdf, d, b"S") {
        if ACTIONS.contains(&sn) && (d.has_type(b"Action") || !d.has(b"Type")) {
            if sn == b"JavaScript" {
                s.push(
                    F::new("javascript", "action", "A JavaScript action is present")
                        .obj(holder)
                        .fixable(true),
                );
            } else if forbidden.contains(&sn) {
                s.push(
                    F::new(
                        "forbidden-actions",
                        "type",
                        "A forbidden action type is used",
                    )
                    .obj(holder)
                    .param("value", name_str(sn))
                    .fixable(true),
                );
            } else if sn == b"Named" {
                let n = get_name(pdf, d, b"N").unwrap_or_default();
                if !NAMED_OK.contains(&n) {
                    s.push(
                        F::new(
                            "forbidden-actions",
                            "named",
                            "A named action other than page navigation is used",
                        )
                        .obj(holder)
                        .param("value", name_str(n))
                        .fixable(true),
                    );
                }
            }
        }
    }
    // Additional actions.
    if d.has(b"AA") {
        let widget = get_name(pdf, d, b"Subtype") == Some(b"Widget");
        let catalog_or_page = d.has_type(b"Catalog") || d.has_type(b"Page");
        if widget || is_field(d) || (catalog_or_page && c.p != Profile::A1b) {
            s.push(
                F::new(
                    "additional-actions",
                    "aa",
                    "An additional-actions dictionary (/AA) is present",
                )
                .obj(holder)
                .fixable(true),
            );
        }
    }
    // Page transparency group (PDF/A-1).
    if c.p == Profile::A1b && d.has_type(b"Page") {
        if let Some(g) = get_dict(pdf, d, b"Group") {
            if get_name(pdf, g, b"S") == Some(b"Transparency") {
                s.push(
                    F::new(
                        "transparency-group",
                        "page",
                        "A page is a transparency group",
                    )
                    .obj(holder),
                );
            }
        }
    }
    // Embedded files in PDF/A-1.
    if c.p == Profile::A1b
        && d.has(b"EF")
        && (d.has_type(b"Filespec") || d.has(b"F") || d.has(b"UF"))
    {
        s.push(
            F::new(
                "embedded-files",
                "a1",
                "PDF/A-1 does not allow embedded files",
            )
            .obj(holder)
            .fixable(true),
        );
    }
}

// ---------------------------------------------------------------- metadata

fn catalog_xmp(pdf: &Pdf) -> (Option<ObjectId>, Option<Result<Xmp, String>>) {
    let Ok(cat) = pdf.catalog() else {
        return (None, None);
    };
    let Ok(mo) = cat.get(b"Metadata") else {
        return (None, None);
    };
    let Some(st) = model::stream(pdf, mo) else {
        return (ref_id(mo), Some(Err("/Metadata is not a stream".into())));
    };
    let parsed = match model::decoded(pdf, st) {
        Some(b) => xmp::parse(&b),
        None => Err("the metadata stream cannot be decoded".into()),
    };
    (ref_id(mo), Some(parsed))
}

fn metadata_rules(c: &Ctx<'_>, s: &mut Sink) {
    let pdf = c.pdf;
    let (mid, parsed) = catalog_xmp(pdf);
    let x = match parsed {
        None => {
            s.push(
                F::new(
                    "metadata-present",
                    "missing",
                    "The catalog has no XMP metadata stream",
                )
                .fixable(true),
            );
            None
        }
        Some(Err(e)) => {
            s.push(
                F::new(
                    "xmp-well-formed",
                    "parse",
                    "The XMP metadata is not well-formed",
                )
                .obj(mid)
                .param("detail", e)
                .fixable(true),
            );
            None
        }
        Some(Ok(x)) => Some(x),
    };
    let info = metadata::get_info(pdf);
    if let Some(x) = &x {
        if let Some(h) = x.header_issue {
            s.push(
                F::new(
                    "xmp-well-formed",
                    "header",
                    "The XMP packet header uses a deprecated attribute",
                )
                .obj(mid)
                .param("value", h)
                .fixable(true),
            );
        }
        if let (Some(part), Some(conf)) = (c.p.part(), c.p.conformance()) {
            let got_part = x.get(xmp::NS_PDFAID, "part");
            let got_conf = x.get(xmp::NS_PDFAID, "conformance");
            if got_part != Some(part.to_string().as_str()) || got_conf != Some(conf) {
                s.push(
                    F::new(
                        "pdfa-identification",
                        if got_part.is_none() {
                            "missing"
                        } else {
                            "mismatch"
                        },
                        "The XMP PDF/A identification does not match the target",
                    )
                    .obj(mid)
                    .param("part", got_part.unwrap_or("-"))
                    .param("conformance", got_conf.unwrap_or("-"))
                    .param("expected", format!("{part}{}", conf))
                    .fixable(true),
                );
            }
            for ns in x.undeclared_namespaces() {
                s.push(
                    F::new(
                        "xmp-extension-schemas",
                        "undeclared",
                        "XMP uses a schema without a PDF/A extension schema",
                    )
                    .obj(mid)
                    .param("namespace", ns)
                    .fixable(true),
                );
            }
        }
        if c.p.is_pdfa() {
            info_consistency(c, s, x, &info, mid);
        } else {
            let v = x.get(xmp::NS_PDFXID, "GTS_PDFXVersion").unwrap_or("");
            if !v.starts_with("PDF/X-4") {
                s.push(
                    F::new(
                        "x4-version",
                        "missing",
                        "XMP does not declare GTS_PDFXVersion PDF/X-4",
                    )
                    .obj(mid)
                    .param("value", v)
                    .fixable(true),
                );
            }
        }
    } else if c.p.is_pdfa() {
        s.push(
            F::new(
                "pdfa-identification",
                "missing",
                "No PDF/A identification (no readable XMP)",
            )
            .fixable(true),
        );
        // Info entries without any XMP counterpart.
        for k in [
            "Title",
            "Author",
            "Subject",
            "Keywords",
            "Creator",
            "Producer",
            "CreationDate",
            "ModDate",
        ] {
            if info.get(k).is_some_and(|v| !v.is_empty()) {
                s.push(
                    F::new(
                        "info-xmp-consistency",
                        "missing",
                        "A document information entry has no XMP counterpart",
                    )
                    .param("key", k)
                    .fixable(true),
                );
            }
        }
    } else {
        s.push(
            F::new(
                "x4-version",
                "missing",
                "XMP does not declare GTS_PDFXVersion PDF/X-4",
            )
            .fixable(true),
        );
    }
    if c.p == Profile::X4 {
        let trapped = pdf
            .trailer()
            .get(b"Info")
            .ok()
            .and_then(|i| dict(pdf, i))
            .and_then(|d| get_name(pdf, d, b"Trapped"));
        let ok = matches!(trapped, Some(b"True") | Some(b"False"));
        let xmp_t = x
            .as_ref()
            .and_then(|x| x.get(xmp::NS_PDF, "Trapped").map(str::to_string));
        let agree = match (&xmp_t, trapped) {
            (Some(t), Some(n)) => t.as_bytes() == n,
            (None, _) => true,
            _ => false,
        };
        if !ok || !agree {
            s.push(
                F::new(
                    "x4-trapped",
                    "missing",
                    "/Trapped is not True or False (or disagrees with XMP)",
                )
                .fixable(true),
            );
        }
    }
}

fn info_consistency(
    c: &Ctx<'_>,
    s: &mut Sink,
    x: &Xmp,
    info: &std::collections::BTreeMap<String, String>,
    mid: Option<ObjectId>,
) {
    let _ = c;
    let pairs: [(&str, &str, &str); 6] = [
        ("Title", xmp::NS_DC, "title"),
        ("Author", xmp::NS_DC, "creator"),
        ("Subject", xmp::NS_DC, "description"),
        ("Keywords", xmp::NS_PDF, "Keywords"),
        ("Creator", xmp::NS_XMP, "CreatorTool"),
        ("Producer", xmp::NS_PDF, "Producer"),
    ];
    for (k, ns, local) in pairs {
        let Some(v) = info.get(k).filter(|v| !v.is_empty()) else {
            continue;
        };
        let xv = if k == "Author" {
            let all = x.all(ns, local);
            (!all.is_empty()).then(|| all.join(", "))
        } else {
            x.get(ns, local).map(str::to_string)
        };
        if xv.as_deref() != Some(v.as_str()) {
            s.push(
                F::new(
                    "info-xmp-consistency",
                    "text",
                    "A document information entry differs from XMP",
                )
                .obj(mid)
                .param("key", k)
                .fixable(true),
            );
        }
    }
    for (k, local) in [("CreationDate", "CreateDate"), ("ModDate", "ModifyDate")] {
        let Some(v) = info.get(k).filter(|v| !v.is_empty()) else {
            continue;
        };
        let a = Date::parse_pdf(v);
        let b = x.get(xmp::NS_XMP, local).and_then(Date::parse_xmp);
        let same = match (a, b) {
            (Some(a), Some(b)) => a.instant() == b.instant(),
            _ => false,
        };
        if !same {
            s.push(
                F::new(
                    "info-xmp-consistency",
                    "date",
                    "A date in the document information differs from XMP",
                )
                .obj(mid)
                .param("key", k)
                .fixable(true),
            );
        }
    }
}

// ---------------------------------------------------------------- colour

fn check_icc_stream(c: &Ctx<'_>, st: &Stream) -> Result<icc::IccHeader, String> {
    let bytes = model::decoded(c.pdf, st).ok_or("the profile cannot be decoded")?;
    let h = icc::parse_header(&bytes).map_err(str::to_string)?;
    if c.p == Profile::A1b && h.major >= 4 {
        return Err(format!(
            "ICC version {}.{} is not allowed in PDF/A-1",
            h.major, h.minor
        ));
    }
    if h.major > 4 {
        return Err(format!(
            "ICC version {} is newer than PDF supports",
            h.major
        ));
    }
    if let Some(n) = get_num(c.pdf, &st.dict, b"N") {
        if Some(n as u8) != h.components() {
            return Err(format!(
                "/N {} does not match the profile's {} colour space",
                n,
                h.space_str()
            ));
        }
    }
    Ok(h)
}

fn colour(c: &Ctx<'_>, s: &mut Sink) {
    let pdf = c.pdf;
    // Output intents.
    let cat = pdf.catalog().ok();
    let ois: Vec<&Dictionary> = match cat.and_then(|d| get(pdf, d, b"OutputIntents")) {
        Some(Object::Array(a)) => a.iter().filter_map(|o| dict(pdf, o)).collect(),
        _ => Vec::new(),
    };
    let mut profiles = BTreeSet::new();
    for d in &ois {
        if let Ok(p) = d.get(b"DestOutputProfile") {
            profiles.insert(ref_id(p));
        }
    }
    if c.p.is_pdfa() {
        if profiles.len() > 1 {
            s.push(
                F::new(
                    "output-intent",
                    "multiple",
                    "Output intents use different destination profiles",
                )
                .fixable(true),
            );
        }
        for d in ois
            .iter()
            .filter(|d| get_name(pdf, d, b"S") == Some(b"GTS_PDFA1"))
        {
            let po = d.get(b"DestOutputProfile").ok();
            let Some(st) = po.and_then(|p| model::stream(pdf, p)) else {
                s.push(
                    F::new(
                        "output-intent",
                        "no-profile",
                        "The PDF/A output intent has no destination profile",
                    )
                    .fixable(true),
                );
                continue;
            };
            match check_icc_stream(c, st) {
                Err(e) => s.push(
                    F::new(
                        "output-intent",
                        "bad-profile",
                        "The output intent's ICC profile is not valid",
                    )
                    .obj(po.and_then(ref_id))
                    .param("detail", e)
                    .fixable(true),
                ),
                Ok(h) => {
                    if !matches!(&h.class, b"mntr" | b"prtr") {
                        s.push(
                            F::new(
                                "output-intent",
                                "class",
                                "The output intent's profile is not an output or monitor profile",
                            )
                            .obj(po.and_then(ref_id))
                            .param("value", h.class_str())
                            .fixable(true),
                        );
                    }
                }
            }
        }
    } else {
        let x: Vec<&&Dictionary> = ois
            .iter()
            .filter(|d| get_name(pdf, d, b"S") == Some(b"GTS_PDFX"))
            .collect();
        if x.len() != 1 {
            s.push(
                F::new(
                    "x4-output-intent",
                    if x.is_empty() { "missing" } else { "multiple" },
                    "There must be exactly one GTS_PDFX output intent",
                )
                .fixable(true),
            );
        }
        for d in x {
            if !d.has(b"OutputConditionIdentifier") {
                s.push(
                    F::new(
                        "x4-output-intent",
                        "identifier",
                        "The output intent has no OutputConditionIdentifier",
                    )
                    .fixable(true),
                );
            }
            match d.get(b"DestOutputProfile").ok().and_then(|p| model::stream(pdf, p)) {
                None => s.push(F::new("x4-output-intent", "no-profile", "The output intent does not embed its ICC profile (PDF/X-4p is not supported)").fixable(true)),
                Some(st) => match check_icc_stream(c, st) {
                    Err(e) => s.push(F::new("x4-output-intent", "bad-profile", "The output intent's ICC profile is not valid").param("detail", e).fixable(true)),
                    Ok(h) => {
                        if &h.class != b"prtr" {
                            s.push(F::new("x4-output-intent", "class", "The PDF/X output intent's profile is not an output-device profile").param("value", h.class_str()).fixable(true));
                        }
                    }
                },
            }
        }
    }
    // Device colour.
    let oi_space =
        c.oi.as_ref()
            .and_then(|i| i.header.as_ref())
            .map(|h| h.colour_space);
    for u in &c.m.colour_uses {
        if u.defaulted {
            continue;
        }
        let ok = match (u.device, oi_space.as_ref()) {
            (Device::Rgb, Some(b"RGB ")) => true,
            (Device::Cmyk, Some(b"CMYK")) => true,
            (Device::Gray, Some(_)) => true,
            (Device::Gray, None) => c.p == Profile::X4,
            _ => false,
        };
        if !ok {
            let fixable = !matches!(u.device, Device::Cmyk);
            s.push(
                F::new(
                    "device-colour",
                    "uncovered",
                    "A device colour space is used without a matching output intent",
                )
                .obj(Some(u.holder))
                .page(u.page)
                .param("space", u.device.name())
                .fixable(fixable),
            );
        }
    }
    // ICCBased colour spaces and DeviceN sizes.
    let mut seen = HashSet::new();
    for (holder, page, cs) in &c.m.colour_spaces {
        icc_based(c, s, cs, *holder, *page, &mut seen, 0);
    }
    // Graphics states.
    for (k, page) in &c.m.extgstates {
        let Some(gs) = gs_dict(pdf, k) else { continue };
        let obj = Some(k.holder());
        if gs.has(b"TR") {
            s.push(
                F::new(
                    "extgstate-transfer",
                    "tr",
                    "A graphics state has a transfer function (/TR)",
                )
                .obj(obj)
                .page(*page)
                .fixable(true),
            );
        }
        if let Ok(tr2) = gs.get(b"TR2") {
            if pdf.resolve(tr2).and_then(|o| o.as_name().ok()) != Some(b"Default") {
                s.push(
                    F::new(
                        "extgstate-transfer",
                        "tr2",
                        "A graphics state has a transfer function (/TR2)",
                    )
                    .obj(obj)
                    .page(*page)
                    .fixable(true),
                );
            }
        }
        if let Some(n) = get_name(pdf, gs, b"RI") {
            if !model::INTENTS.contains(&n) {
                s.push(
                    F::new(
                        "rendering-intent",
                        "gs",
                        "A graphics state has a non-standard rendering intent",
                    )
                    .obj(obj)
                    .page(*page)
                    .param("value", name_str(n))
                    .fixable(true),
                );
            }
        }
    }
    for i in &c.m.bad_ri {
        s.push(
            F::new(
                "rendering-intent",
                "operator",
                "The ri operator uses a non-standard rendering intent",
            )
            .obj(Some(i.holder))
            .page(i.page)
            .param("value", &i.what),
        );
    }
}

fn gs_dict<'a>(pdf: &'a Pdf, k: &Key) -> Option<&'a Dictionary> {
    match k {
        Key::Obj(id) => pdf.get_dict(*id),
        Key::Direct(holder, name) => {
            let hd = pdf.get_dict(*holder)?;
            let res =
                get_dict(pdf, hd, b"Resources").or_else(|| model::page_resources(pdf, *holder))?;
            get_dict(pdf, res, b"ExtGState")?
                .get(name)
                .ok()
                .and_then(|o| dict(pdf, o))
        }
    }
}

fn icc_based(
    c: &Ctx<'_>,
    s: &mut Sink,
    cs: &Object,
    holder: ObjectId,
    page: Option<usize>,
    seen: &mut HashSet<ObjectId>,
    depth: usize,
) {
    let pdf = c.pdf;
    if depth > 8 {
        return;
    }
    if let Some(id) = ref_id(cs) {
        if !seen.insert(id) {
            return;
        }
    }
    let Some(Object::Array(a)) = pdf.resolve(cs) else {
        return;
    };
    let family = a
        .first()
        .and_then(|o| pdf.resolve(o))
        .and_then(|o| o.as_name().ok())
        .unwrap_or_default();
    match family {
        b"ICCBased" => {
            let po = a.get(1);
            match po.and_then(|p| model::stream(pdf, p)) {
                None => s.push(
                    F::new(
                        "icc-based",
                        "missing",
                        "An ICCBased colour space has no profile stream",
                    )
                    .obj(Some(holder))
                    .page(page),
                ),
                Some(st) => {
                    if let Err(e) = check_icc_stream(c, st) {
                        s.push(
                            F::new(
                                "icc-based",
                                "bad",
                                "An ICCBased colour space embeds an invalid profile",
                            )
                            .obj(po.and_then(ref_id).or(Some(holder)))
                            .page(page)
                            .param("detail", e),
                        );
                    }
                }
            }
        }
        b"Indexed" | b"Pattern" => {
            if let Some(b) = a.get(1) {
                icc_based(c, s, b, holder, page, seen, depth + 1);
            }
        }
        b"Separation" | b"DeviceN" => {
            if family == b"DeviceN" {
                let n = match a.get(1).and_then(|o| pdf.resolve(o)) {
                    Some(Object::Array(names)) => names.len(),
                    _ => 0,
                };
                let max = if c.p == Profile::A1b { 8 } else { 32 };
                if n > max {
                    s.push(
                        F::new(
                            "impl-limits-content",
                            "devicen",
                            "A DeviceN colour space has too many colourants",
                        )
                        .obj(Some(holder))
                        .page(page)
                        .param("value", n)
                        .param("max", max),
                    );
                }
            }
            if let Some(b) = a.get(2) {
                icc_based(c, s, b, holder, page, seen, depth + 1);
            }
        }
        _ => {}
    }
}

// ---------------------------------------------------------------- transparency, xobjects, content

fn transparency_and_xobjects(c: &Ctx<'_>, s: &mut Sink) {
    let pdf = c.pdf;
    let a1 = c.p == Profile::A1b;
    for (k, page) in &c.m.extgstates {
        let Some(gs) = gs_dict(pdf, k) else { continue };
        let obj = Some(k.holder());
        if a1 {
            if let Ok(sm) = gs.get(b"SMask") {
                if pdf.resolve(sm).and_then(|o| o.as_name().ok()) != Some(b"None") {
                    s.push(
                        F::new(
                            "transparency-smask",
                            "gs",
                            "A graphics state sets a soft mask",
                        )
                        .obj(obj)
                        .page(*page),
                    );
                }
            }
            for key in ["CA", "ca"] {
                if get_num(pdf, gs, key.as_bytes()).is_some_and(|v| v < 1.0) {
                    s.push(
                        F::new(
                            "transparency-alpha",
                            "gs",
                            "A graphics state sets constant alpha below 1.0",
                        )
                        .obj(obj)
                        .page(*page)
                        .param("key", key),
                    );
                }
            }
        }
        let bms: Vec<Vec<u8>> = match get(pdf, gs, b"BM") {
            Some(Object::Name(n)) => vec![n.clone()],
            Some(Object::Array(a)) => a
                .iter()
                .filter_map(|o| o.as_name().ok().map(<[u8]>::to_vec))
                .collect(),
            _ => Vec::new(),
        };
        for bm in bms {
            let ok = if a1 {
                bm == b"Normal" || bm == b"Compatible"
            } else {
                BLEND_MODES.contains(&bm.as_slice())
            };
            if !ok {
                s.push(
                    F::new(
                        "blend-mode",
                        if a1 { "a1" } else { "unknown" },
                        "A graphics state uses a blend mode that is not allowed",
                    )
                    .obj(obj)
                    .page(*page)
                    .param("value", name_str(&bm)),
                );
            }
        }
    }
    for i in &c.m.inline_images {
        let d = &i.dict;
        if matches!(
            d.get(b"I").or_else(|_| d.get(b"Interpolate")),
            Ok(Object::Boolean(true))
        ) {
            s.push(
                F::new(
                    "image-interpolate",
                    "inline",
                    "An inline image sets /Interpolate true",
                )
                .obj(Some(i.holder))
                .page(i.page)
                .fixable(true),
            );
        }
        let fl: Vec<Vec<u8>> = match d.get(b"F").or_else(|_| d.get(b"Filter")) {
            Ok(Object::Name(n)) => vec![n.clone()],
            Ok(Object::Array(a)) => a
                .iter()
                .filter_map(|o| o.as_name().ok().map(<[u8]>::to_vec))
                .collect(),
            _ => Vec::new(),
        };
        if fl.iter().any(|f| f == b"LZW" || f == b"LZWDecode") {
            s.push(
                F::new(
                    "stream-filters",
                    "inline-lzw",
                    "An inline image uses the LZW filter",
                )
                .obj(Some(i.holder))
                .page(i.page),
            );
        }
        if let Ok(Object::Name(n)) = d.get(b"Intent") {
            if !model::INTENTS.contains(&n.as_slice()) {
                s.push(
                    F::new(
                        "rendering-intent",
                        "inline",
                        "An inline image has a non-standard rendering intent",
                    )
                    .obj(Some(i.holder))
                    .page(i.page)
                    .param("value", name_str(n)),
                );
            }
        }
    }
    for u in &c.m.unknown_ops {
        s.push(
            F::new(
                "undefined-operators",
                "op",
                "A content stream uses an undefined operator",
            )
            .obj(Some(u.holder))
            .page(u.page)
            .param("value", &u.what),
        );
    }
    for q in &c.m.deep_q {
        s.push(
            F::new(
                "impl-limits-content",
                "q",
                "Graphics states are nested more than 28 deep",
            )
            .obj(Some(q.holder))
            .page(q.page),
        );
    }
}

// ---------------------------------------------------------------- fonts

/// Text codes the document shows with a font.
fn used_codes(c: &Ctx<'_>, k: &Key, fi: &FontInfo<'_>) -> Option<BTreeSet<u32>> {
    let strings = c.m.text.get(k)?;
    let mut out = BTreeSet::new();
    for st in strings {
        out.extend(fonts::codes(c.pdf, fi, st)?);
    }
    Some(out)
}

/// Whether a ToUnicode map could be derived for a font (the converter's condition).
pub fn tounicode_derivable(pdf: &Pdf, fi: &FontInfo<'_>) -> bool {
    if fi.subtype == "Type0" {
        let identity = matches!(get(pdf, fi.dict, b"Encoding"), Some(Object::Name(n)) if n == b"Identity-H" || n == b"Identity-V");
        return identity && fonts::sfnt_bytes(pdf, fi).is_some();
    }
    let enc = fonts::simple_encoding(pdf, fi);
    enc.names
        .iter()
        .flatten()
        .any(|n| fonts::glyph_unicode(n).is_some())
        || fonts::sfnt_bytes(pdf, fi).is_some()
}

fn font_rules(c: &Ctx<'_>, s: &mut Sink) -> Vec<String> {
    let pdf = c.pdf;
    let mut needed = BTreeSet::new();
    for (k, page) in &c.m.fonts {
        let Some(d) = model::font_dict(pdf, k, true) else {
            continue;
        };
        let fi = fonts::info(pdf, d);
        let obj = Some(k.holder());
        let page = *page;
        let name = fi.base_font.clone();
        // font-embedded
        if !fi.embedded() {
            let sub = fonts::substitute_for(&name);
            let simple = matches!(fi.subtype.as_str(), "Type1" | "MMType1" | "TrueType");
            let fixable = simple && sub.is_some();
            if fixable {
                if let Some(p) = sub {
                    needed.insert(fonts::substitute_file(p));
                }
            }
            s.push(
                F::new(
                    "font-embedded",
                    if fixable { "substitute" } else { "missing" },
                    "A font program is not embedded",
                )
                .obj(obj)
                .page(page)
                .param("font", &name)
                .param("substitute", sub.unwrap_or(""))
                .fixable(fixable),
            );
        }
        if fi.is_type3() {
            type3(c, s, &fi, obj, page);
        }
        if fi.subtype == "Type0" {
            cid_font(c, s, &fi, obj, page);
        }
        let sfnt = fonts::sfnt_bytes(pdf, &fi);
        let face = sfnt.as_ref().and_then(|b| Face::parse(b, 0).ok());
        let used = used_codes(c, k, &fi);
        // font-widths: glyphs shown by text only
        if let (Some(face), Some(used)) = (&face, &used) {
            widths(c, s, &fi, face, used, obj, page);
        }
        // notdef
        if let (Some(face), Some(used)) = (&face, &used) {
            let mut bad = Vec::new();
            if fi.subtype == "TrueType" {
                let enc = fonts::simple_encoding(pdf, &fi);
                for code in used.iter().take(4096) {
                    if fonts::truetype_glyph(face, &enc, fi.symbolic(), *code as u8).is_none() {
                        bad.push(*code);
                    }
                }
            } else if fi.subtype == "Type0" {
                if let Some(desc) = fi.descendant {
                    let map = fonts::cid_map_bytes(pdf, desc);
                    let n = u32::from(face.number_of_glyphs());
                    for code in used.iter().take(65_536) {
                        let g = fonts::cid_to_gid(pdf, desc, &map, *code);
                        if g == 0 || g >= n {
                            bad.push(*code);
                        }
                    }
                }
            }
            if let Some(first) = bad.first() {
                s.push(
                    F::new("notdef", "glyph", "Text uses the .notdef glyph")
                        .obj(obj)
                        .page(page)
                        .param("font", &name)
                        .param("code", format!("{first:#X}"))
                        .param("count", bad.len()),
                );
            }
        }
        if fi.is_type3() {
            if let (Some(used), Some(procs)) = (&used, get_dict(pdf, d, b"CharProcs")) {
                let enc = fonts::simple_encoding(pdf, &fi);
                let missing = used
                    .iter()
                    .filter(|c| {
                        let n = enc.names.get(**c as usize).and_then(|n| n.as_deref());
                        n.is_none_or(|n| !procs.has(n.as_bytes()))
                    })
                    .count();
                if missing > 0 {
                    s.push(
                        F::new(
                            "notdef",
                            "type3",
                            "Text uses a Type 3 glyph that does not exist",
                        )
                        .obj(obj)
                        .page(page)
                        .param("font", &name)
                        .param("count", missing),
                    );
                }
            }
        }
        // tounicode (PDF/A-2u)
        if c.p == Profile::A2u {
            tounicode(c, s, &fi, used.as_ref(), obj, page);
        }
    }
    needed.into_iter().collect()
}

/// Width mismatches `(code, declared, program)` for the codes text actually shows with a
/// TrueType/OpenType font (ISO 19005-2 6.2.11.5 covers glyphs referenced by text-showing
/// operators). Shared with the converter so detection and repair agree.
pub fn width_mismatches(
    pdf: &Pdf,
    fi: &FontInfo<'_>,
    face: &Face<'_>,
    used: &BTreeSet<u32>,
) -> Vec<(u32, f64, f64)> {
    let mut out = Vec::new();
    if fi.subtype == "TrueType" || matches!(fi.subtype.as_str(), "Type1" | "MMType1") {
        let enc = fonts::simple_encoding(pdf, fi);
        for &code in used.iter().filter(|c| **c < 256) {
            let code8 = code as u8;
            let Some(g) = fonts::truetype_glyph(face, &enc, fi.symbolic(), code8) else {
                continue;
            };
            let (Some(want), Some(got)) = (
                fonts::advance(face, g),
                fonts::declared_width(pdf, fi, code8),
            ) else {
                continue;
            };
            if (want - got).abs() > 1.0 {
                out.push((code, got, want));
            }
        }
    } else if let Some(desc) = fi.descendant {
        // Codes are CIDs only for the Identity CMaps.
        if !matches!(get(pdf, fi.dict, b"Encoding"), Some(Object::Name(n)) if n == b"Identity-H" || n == b"Identity-V")
        {
            return out;
        }
        let map = fonts::cid_map_bytes(pdf, desc);
        let dw = get_num(pdf, desc, b"DW").unwrap_or(1000.0);
        let declared: std::collections::HashMap<u32, f64> =
            fonts::cid_widths(pdf, desc, 65_536).into_iter().collect();
        for &cid in used.iter().take(65_536) {
            let g = fonts::cid_to_gid(pdf, desc, &map, cid);
            if g == 0 || g >= u32::from(face.number_of_glyphs()) {
                continue;
            }
            let Some(want) = fonts::advance(face, GlyphId(g as u16)) else {
                continue;
            };
            let got = declared.get(&cid).copied().unwrap_or(dw);
            if (want - got).abs() > 1.0 {
                out.push((cid, got, want));
            }
        }
    }
    out
}

fn widths(
    c: &Ctx<'_>,
    s: &mut Sink,
    fi: &FontInfo<'_>,
    face: &Face<'_>,
    used: &BTreeSet<u32>,
    obj: Option<ObjectId>,
    page: Option<usize>,
) {
    let list = width_mismatches(c.pdf, fi, face, used);
    let bad = list.len();
    if let Some((code, got, want)) = list.first().copied() {
        s.push(
            F::new(
                "font-widths",
                "mismatch",
                "Declared glyph widths differ from the embedded font program",
            )
            .obj(obj)
            .page(page)
            .param("font", &fi.base_font)
            .param("code", format!("{code:#X}"))
            .param("declared", format!("{got:.0}"))
            .param("program", format!("{want:.0}"))
            .param("count", bad)
            .fixable(fi.subtype == "TrueType"),
        );
    }
}

fn tounicode(
    c: &Ctx<'_>,
    s: &mut Sink,
    fi: &FontInfo<'_>,
    used: Option<&BTreeSet<u32>>,
    obj: Option<ObjectId>,
    page: Option<usize>,
) {
    let pdf = c.pdf;
    let tu = fi
        .dict
        .get(b"ToUnicode")
        .ok()
        .and_then(|o| model::stream(pdf, o))
        .and_then(|st| model::decoded(pdf, st));
    match tu {
        Some(bytes) => {
            let cm = fonts::parse_cmap(&bytes);
            let bad_value = cm
                .uni
                .values()
                .any(|t| t.contains(['\u{0}', '\u{FEFF}', '\u{FFFE}']));
            let unmapped = used
                .map(|u| u.iter().filter(|c| !cm.uni.contains_key(c)).count())
                .unwrap_or(0);
            if bad_value || unmapped > 0 {
                s.push(
                    F::new(
                        "tounicode",
                        "incomplete",
                        "The ToUnicode map misses used codes or maps to U+0000/FEFF/FFFE",
                    )
                    .obj(obj)
                    .page(page)
                    .param("font", &fi.base_font)
                    .param("count", unmapped)
                    .fixable(tounicode_derivable(pdf, fi)),
                );
            }
        }
        None => {
            // Exempt: standard encodings / AGL Differences for non-symbolic simple fonts.
            let exempt = if fi.subtype == "Type0" {
                let ord = fi
                    .descendant
                    .and_then(|d| get_dict(pdf, d, b"CIDSystemInfo"))
                    .and_then(|i| get(pdf, i, b"Ordering"))
                    .and_then(|o| o.as_str().ok().map(<[u8]>::to_vec));
                let named_cmap = matches!(get(pdf, fi.dict, b"Encoding"), Some(Object::Name(n)) if !n.starts_with(b"Identity"));
                named_cmap
                    && matches!(
                        ord.as_deref(),
                        Some(b"GB1") | Some(b"CNS1") | Some(b"Japan1") | Some(b"Korea1")
                    )
            } else if fi.is_type3() {
                let enc = fonts::simple_encoding(pdf, fi);
                enc.has_differences && enc.differences_in_agl
            } else {
                let enc = fonts::simple_encoding(pdf, fi);
                let std_named = matches!(get(pdf, fi.dict, b"Encoding"), Some(Object::Name(n)) if n == b"WinAnsiEncoding" || n == b"MacRomanEncoding" || n == b"MacExpertEncoding");
                let dict_enc =
                    matches!(get(pdf, fi.dict, b"Encoding"), Some(Object::Dictionary(_)));
                std_named
                    || (dict_enc && enc.base.is_some() && enc.differences_in_agl)
                    || (dict_enc && enc.has_differences && enc.differences_in_agl)
            };
            if !exempt {
                s.push(
                    F::new(
                        "tounicode",
                        "missing",
                        "A font has no ToUnicode map and no standard encoding",
                    )
                    .obj(obj)
                    .page(page)
                    .param("font", &fi.base_font)
                    .fixable(tounicode_derivable(pdf, fi)),
                );
            }
        }
    }
}

fn type3(c: &Ctx<'_>, s: &mut Sink, fi: &FontInfo<'_>, obj: Option<ObjectId>, page: Option<usize>) {
    let pdf = c.pdf;
    let d = fi.dict;
    let mut missing = Vec::new();
    for k in [
        "FontBBox",
        "FontMatrix",
        "CharProcs",
        "Encoding",
        "FirstChar",
        "LastChar",
        "Widths",
    ] {
        if !d.has(k.as_bytes()) {
            missing.push(k);
        }
    }
    if let Some(Object::Array(m)) = get(pdf, d, b"FontMatrix") {
        let v: Vec<f64> = m
            .iter()
            .filter_map(|o| pdf.resolve(o).and_then(num))
            .collect();
        let invertible =
            matches!(v.as_slice(), [a, b, cc, dd, _, _] if (a * dd - b * cc).abs() > 1e-12);
        if !invertible {
            missing.push("FontMatrix (invertible)");
        }
    }
    if let Some(procs) = get_dict(pdf, d, b"CharProcs") {
        if procs.iter().any(|(_, v)| model::stream(pdf, v).is_none()) {
            missing.push("CharProcs (streams)");
        }
    }
    if !missing.is_empty() {
        s.push(
            F::new("type3-fonts", "incomplete", "A Type 3 font is incomplete")
                .obj(obj)
                .page(page)
                .param("font", &fi.base_font)
                .param("keys", missing.join(", ")),
        );
    }
}

fn cid_font(
    c: &Ctx<'_>,
    s: &mut Sink,
    fi: &FontInfo<'_>,
    obj: Option<ObjectId>,
    page: Option<usize>,
) {
    let pdf = c.pdf;
    let Some(desc) = fi.descendant else {
        s.push(
            F::new(
                "cid-fonts",
                "descendant",
                "A Type 0 font has no descendant CIDFont",
            )
            .obj(obj)
            .page(page)
            .param("font", &fi.base_font),
        );
        return;
    };
    let info = get_dict(pdf, desc, b"CIDSystemInfo");
    let ro = info.map(|i| {
        let g = |k: &[u8]| {
            get(pdf, i, k)
                .and_then(|o| o.as_str().ok())
                .map(|b| String::from_utf8_lossy(b).into_owned())
                .unwrap_or_default()
        };
        (g(b"Registry"), g(b"Ordering"))
    });
    match (get(pdf, fi.dict, b"Encoding"), &ro) {
        (_, None) => s.push(
            F::new("cid-fonts", "system-info", "A CIDFont has no CIDSystemInfo")
                .obj(obj)
                .page(page)
                .param("font", &fi.base_font),
        ),
        (Some(Object::Stream(st)), Some((r, o))) => {
            if let Some(cm) = model::decoded(pdf, st).map(|b| fonts::parse_cmap(&b)) {
                if let Some((cr, co)) = &cm.registry_ordering {
                    if cr != r || co != o {
                        s.push(
                            F::new(
                                "cid-fonts",
                                "mismatch",
                                "The CMap's CIDSystemInfo differs from the CIDFont's",
                            )
                            .obj(obj)
                            .page(page)
                            .param("font", &fi.base_font),
                        );
                    }
                }
            }
        }
        (Some(Object::Name(n)), Some((r, o))) if !n.starts_with(b"Identity") => {
            // Predefined CMaps: registry Adobe with the CMap's ordering family.
            let name = String::from_utf8_lossy(n);
            let expected = if name.starts_with("UniGB") || name.starts_with("GB") {
                Some("GB1")
            } else if name.starts_with("UniCNS")
                || name.starts_with("B5")
                || name.starts_with("ETen")
                || name.starts_with("CNS")
                || name.starts_with("HKscs")
            {
                Some("CNS1")
            } else if name.starts_with("UniJIS")
                || name.starts_with("90")
                || name.starts_with("83pv")
                || name.starts_with("Ext")
                || name.starts_with("H")
                || name.starts_with("V")
                || name.starts_with("Add")
                || name.starts_with("EUC")
                || name.starts_with("RKSJ")
            {
                Some("Japan1")
            } else if name.starts_with("UniKS") || name.starts_with("KSC") {
                Some("Korea1")
            } else {
                None
            };
            if let Some(e) = expected {
                if r != "Adobe" || o != e {
                    s.push(
                        F::new(
                            "cid-fonts",
                            "mismatch",
                            "The CMap's CIDSystemInfo differs from the CIDFont's",
                        )
                        .obj(obj)
                        .page(page)
                        .param("font", &fi.base_font),
                    );
                }
            }
        }
        _ => {}
    }
    if get_name(pdf, desc, b"Subtype") == Some(b"CIDFontType2")
        && fi.program.is_some()
        && !desc.has(b"CIDToGIDMap")
    {
        s.push(
            F::new(
                "cid-fonts",
                "cidtogid",
                "A Type 2 CIDFont has no /CIDToGIDMap",
            )
            .obj(obj)
            .page(page)
            .param("font", &fi.base_font)
            .fixable(true),
        );
    }
}

// ---------------------------------------------------------------- annotations

fn annotations(c: &Ctx<'_>, s: &mut Sink) {
    let pdf = c.pdf;
    for a in &c.m.annots {
        let Some(d) = model::annot_dict(pdf, a) else {
            continue;
        };
        let obj = a.id.or(Some(a.page_id));
        let page = Some(a.page);
        let sub = get_name(pdf, d, b"Subtype").unwrap_or_default();
        if !annot_allowed(c.p, sub) {
            s.push(
                F::new("annot-types", "type", "This annotation type is not allowed")
                    .obj(obj)
                    .page(page)
                    .param("value", name_str(sub))
                    .fixable(true),
            );
            continue; // the converter removes it; its other problems do not matter
        }
        let popup = sub == b"Popup";
        let f = get_num(pdf, d, b"F").map(|v| v as i64);
        match f {
            None => {
                if !popup || c.p == Profile::A1b {
                    s.push(
                        F::new(
                            "annot-flags",
                            "missing",
                            "An annotation has no /F flags (it would not print)",
                        )
                        .obj(obj)
                        .page(page)
                        .param("type", name_str(sub))
                        .fixable(true),
                    );
                }
            }
            Some(f) => {
                let print = f & 4 != 0;
                let hidden = f & (1 | 2 | 32 | 256) != 0;
                if (!print && (!popup || c.p == Profile::A1b)) || hidden {
                    s.push(
                        F::new(
                            "annot-flags",
                            "flags",
                            "An annotation is hidden or not printable",
                        )
                        .obj(obj)
                        .page(page)
                        .param("type", name_str(sub))
                        .param("value", f)
                        .fixable(true),
                    );
                }
            }
        }
        if c.p == Profile::A1b && get_num(pdf, d, b"CA").is_some_and(|v| v < 1.0) {
            s.push(
                F::new(
                    "transparency-alpha",
                    "annot",
                    "An annotation has constant alpha below 1.0",
                )
                .obj(obj)
                .page(page),
            );
        }
        let ap = get_dict(pdf, d, b"AP");
        if let Some(ap) = ap {
            if ap.iter().any(|(k, _)| k.as_slice() != b"N") {
                s.push(
                    F::new(
                        "annot-appearance",
                        "extra",
                        "An appearance dictionary has entries other than /N",
                    )
                    .obj(obj)
                    .page(page)
                    .fixable(true),
                );
            }
        }
        if c.p != Profile::A1b && !popup && sub != b"Link" {
            let zero = match get(pdf, d, b"Rect") {
                Some(Object::Array(r)) => {
                    let v: Vec<f64> = r
                        .iter()
                        .filter_map(|o| pdf.resolve(o).and_then(num))
                        .collect();
                    matches!(v.as_slice(), [x0, y0, x1, y1] if (x1 - x0).abs() < 1e-9 || (y1 - y0).abs() < 1e-9)
                }
                _ => false,
            };
            let n = ap.and_then(|ap| get(pdf, ap, b"N"));
            if n.is_none() && !zero {
                let drawable = DRAWABLE.contains(&sub);
                s.push(
                    F::new(
                        "annot-appearance",
                        "missing",
                        "An annotation has no normal appearance stream",
                    )
                    .obj(obj)
                    .page(page)
                    .param("type", name_str(sub))
                    .fixable(drawable),
                );
            }
            if sub == b"Widget" {
                let btn = field_type(pdf, d) == Some(b"Btn".to_vec());
                if btn && !matches!(n, Some(Object::Dictionary(_)) | None) {
                    s.push(
                        F::new(
                            "annot-appearance",
                            "btn",
                            "A button widget's /N is not a dictionary of states",
                        )
                        .obj(obj)
                        .page(page),
                    );
                }
            }
        }
    }
}

fn field_type(pdf: &Pdf, d: &Dictionary) -> Option<Vec<u8>> {
    let mut cur = d;
    for _ in 0..32 {
        if let Some(n) = get_name(pdf, cur, b"FT") {
            return Some(n.to_vec());
        }
        cur = get_dict(pdf, cur, b"Parent")?;
    }
    None
}

// ---------------------------------------------------------------- catalog-level rules

fn catalog_rules(c: &Ctx<'_>, s: &mut Sink) {
    let pdf = c.pdf;
    let Ok(cat) = pdf.catalog() else { return };
    let root = pdf.root_id().ok();
    // JavaScript name tree and scripted open action.
    if let Some(names) = get_dict(pdf, cat, b"Names") {
        if names.has(b"JavaScript") {
            s.push(
                F::new(
                    "javascript",
                    "names",
                    "The document has a JavaScript name tree",
                )
                .obj(root)
                .fixable(true),
            );
        }
        if names.has(b"EmbeddedFiles") && c.p == Profile::A1b {
            s.push(
                F::new(
                    "embedded-files",
                    "a1",
                    "PDF/A-1 does not allow embedded files",
                )
                .obj(root)
                .fixable(true),
            );
        }
    }
    // Forms.
    if let Some(af) = get_dict(pdf, cat, b"AcroForm") {
        if matches!(
            get(pdf, af, b"NeedAppearances"),
            Some(Object::Boolean(true))
        ) {
            let all_have =
                c.m.annots
                    .iter()
                    .filter_map(|a| model::annot_dict(pdf, a))
                    .filter(|d| get_name(pdf, d, b"Subtype") == Some(b"Widget"))
                    .all(|d| get_dict(pdf, d, b"AP").is_some_and(|ap| ap.has(b"N")));
            s.push(
                F::new(
                    "need-appearances",
                    "true",
                    "The form asks viewers to regenerate appearances (/NeedAppearances true)",
                )
                .obj(root)
                .fixable(all_have),
            );
        }
        if af.has(b"XFA") {
            let has_fields =
                matches!(get(pdf, af, b"Fields"), Some(Object::Array(a)) if !a.is_empty());
            s.push(
                F::new("xfa", "xfa", "The document contains an XFA form")
                    .obj(root)
                    .fixable(has_fields),
            );
        }
    }
    if matches!(
        get(pdf, cat, b"NeedsRendering"),
        Some(Object::Boolean(true))
    ) {
        s.push(
            F::new("xfa", "needs-rendering", "The catalog sets /NeedsRendering")
                .obj(root)
                .fixable(true),
        );
    }
    // Optional content.
    if let Some(oc) = get_dict(pdf, cat, b"OCProperties") {
        if c.p == Profile::A1b {
            s.push(
                F::new(
                    "optional-content",
                    "a1",
                    "PDF/A-1 does not allow optional content (layers)",
                )
                .obj(root),
            );
        } else if c.p.is_pdfa() {
            let all: Vec<ObjectId> = match get(pdf, oc, b"OCGs") {
                Some(Object::Array(a)) => a.iter().filter_map(ref_id).collect(),
                _ => Vec::new(),
            };
            let mut configs: Vec<&Dictionary> = Vec::new();
            if let Some(d) = get_dict(pdf, oc, b"D") {
                configs.push(d);
            }
            if let Some(Object::Array(a)) = get(pdf, oc, b"Configs") {
                configs.extend(a.iter().filter_map(|o| dict(pdf, o)));
            }
            let mut names = HashSet::new();
            for cfg in configs {
                let name = get(pdf, cfg, b"Name")
                    .and_then(|o| o.as_str().ok())
                    .map(<[u8]>::to_vec);
                match name {
                    None => s.push(
                        F::new(
                            "optional-content",
                            "name",
                            "An optional content configuration has no /Name",
                        )
                        .obj(root)
                        .fixable(true),
                    ),
                    Some(n) => {
                        if !names.insert(n) {
                            s.push(
                                F::new(
                                    "optional-content",
                                    "unique",
                                    "Two optional content configurations share a name",
                                )
                                .obj(root)
                                .fixable(true),
                            );
                        }
                    }
                }
                if cfg.has(b"AS") {
                    s.push(
                        F::new(
                            "optional-content",
                            "as",
                            "An optional content configuration has /AS",
                        )
                        .obj(root)
                        .fixable(true),
                    );
                }
                if let Some(Object::Array(order)) = get(pdf, cfg, b"Order") {
                    let mut listed = HashSet::new();
                    collect_refs(pdf, order, &mut listed, 0);
                    if all.iter().any(|g| !listed.contains(g)) {
                        s.push(
                            F::new(
                                "optional-content",
                                "order",
                                "/Order does not list every optional content group",
                            )
                            .obj(root)
                            .fixable(true),
                        );
                    }
                }
            }
        }
    }
    if c.p.is_pdfa() && c.p != Profile::A1b {
        embedded_files(c, s, cat);
    }
}

fn collect_refs(pdf: &Pdf, a: &[Object], out: &mut HashSet<ObjectId>, depth: usize) {
    if depth > 32 {
        return;
    }
    for o in a {
        if let Some(id) = ref_id(o) {
            out.insert(id);
        }
        if let Some(Object::Array(inner)) = pdf.resolve(o) {
            collect_refs(pdf, inner, out, depth + 1);
        }
    }
}

/// Every file specification with /EF reachable from the document (bounded).
pub fn filespecs(pdf: &Pdf) -> Vec<(ObjectId, Dictionary)> {
    let mut out = Vec::new();
    for id in pdf.reachable().unwrap_or_default() {
        let Some(o) = pdf.get(id) else { continue };
        walk(o, 0, &mut |x, _, _| {
            if let Object::Dictionary(d) = x {
                if d.has(b"EF") && out.len() < 10_000 {
                    out.push((id, d.clone()));
                }
            }
        });
    }
    out
}

/// Whether bytes are a PDF/A-1 or PDF/A-2 file (by its XMP identification).
pub fn embedded_is_pdfa12(bytes: &[u8]) -> bool {
    if !bytes.starts_with(b"%PDF-") {
        return false;
    }
    let Ok(p) = Pdf::open(bytes.to_vec(), None) else {
        return false;
    };
    let Ok(Some(x)) = metadata::get_xmp(&p) else {
        return false;
    };
    xmp::parse(x.as_bytes())
        .ok()
        .and_then(|x| x.get(xmp::NS_PDFAID, "part").map(str::to_string))
        .is_some_and(|p| p == "1" || p == "2")
}

fn embedded_files(c: &Ctx<'_>, s: &mut Sink, cat: &Dictionary) {
    let pdf = c.pdf;
    let af: HashSet<ObjectId> = match get(pdf, cat, b"AF") {
        Some(Object::Array(a)) => a.iter().filter_map(ref_id).collect(),
        _ => HashSet::new(),
    };
    for (holder, fs) in filespecs(pdf) {
        let ef = get_dict(pdf, &fs, b"EF");
        let st = ef
            .and_then(|e| e.get(b"F").or_else(|_| e.get(b"UF")).ok())
            .and_then(|o| model::stream(pdf, o));
        let name = get(pdf, &fs, b"UF")
            .or_else(|| get(pdf, &fs, b"F"))
            .and_then(|o| o.as_str().ok())
            .map(metadata::decode_text)
            .unwrap_or_default();
        match c.p {
            Profile::A2b | Profile::A2u => {
                let ok = st
                    .and_then(|st| model::decoded(pdf, st))
                    .is_some_and(|b| embedded_is_pdfa12(&b));
                if !ok {
                    s.push(
                        F::new(
                            "embedded-files",
                            "a2",
                            "An embedded file is not a PDF/A-1 or PDF/A-2 document",
                        )
                        .obj(Some(holder))
                        .param("file", &name)
                        .fixable(true),
                    );
                }
            }
            Profile::A3b => {
                let rel = get_name(pdf, &fs, b"AFRelationship");
                let rel_ok = matches!(
                    rel,
                    Some(b"Source")
                        | Some(b"Data")
                        | Some(b"Alternative")
                        | Some(b"Supplement")
                        | Some(b"Unspecified")
                );
                let mime = st.is_some_and(|st| get_name(pdf, &st.dict, b"Subtype").is_some());
                let names = fs.has(b"F") && fs.has(b"UF");
                let listed = af.contains(&holder) || !af.is_empty() && fs_ref_in(pdf, &af, &fs);
                if !(rel_ok && mime && names && listed) {
                    let mut missing = Vec::new();
                    if !rel_ok {
                        missing.push("AFRelationship");
                    }
                    if !mime {
                        missing.push("Subtype");
                    }
                    if !names {
                        missing.push("F/UF");
                    }
                    if !listed {
                        missing.push("AF");
                    }
                    s.push(
                        F::new(
                            "embedded-files",
                            "a3",
                            "An embedded file lacks the PDF/A-3 associated-file entries",
                        )
                        .obj(Some(holder))
                        .param("file", &name)
                        .param("keys", missing.join(", "))
                        .fixable(true),
                    );
                }
            }
            _ => {}
        }
    }
}

fn fs_ref_in(pdf: &Pdf, af: &HashSet<ObjectId>, fs: &Dictionary) -> bool {
    af.iter()
        .any(|id| pdf.get_dict(*id).is_some_and(|d| d == fs))
}

// ---------------------------------------------------------------- pages

fn page_boxes(pdf: &Pdf, id: ObjectId) -> Vec<(&'static str, [f64; 4])> {
    let mut out = Vec::new();
    for key in ["MediaBox", "CropBox", "BleedBox", "TrimBox", "ArtBox"] {
        let mut cur = pdf.get_dict(id);
        let mut depth = 0;
        while let Some(d) = cur {
            if let Some(Object::Array(a)) = get(pdf, d, key.as_bytes()) {
                let v: Vec<f64> = a
                    .iter()
                    .filter_map(|o| pdf.resolve(o).and_then(num))
                    .collect();
                if let [x0, y0, x1, y1] = v.as_slice() {
                    out.push((key, [x0.min(*x1), y0.min(*y1), x0.max(*x1), y0.max(*y1)]));
                }
                break;
            }
            // Only MediaBox, CropBox (and Resources, Rotate) are inheritable.
            if !matches!(key, "MediaBox" | "CropBox") || depth > 64 {
                break;
            }
            depth += 1;
            cur = get_dict(pdf, d, b"Parent");
        }
    }
    out
}

fn within(inner: &[f64; 4], outer: &[f64; 4]) -> bool {
    let e = 0.01;
    inner[0] >= outer[0] - e
        && inner[1] >= outer[1] - e
        && inner[2] <= outer[2] + e
        && inner[3] <= outer[3] + e
}

fn pages(c: &Ctx<'_>, s: &mut Sink) {
    let pdf = c.pdf;
    for (i, p) in c.m.pages.iter().enumerate() {
        let boxes = page_boxes(pdf, p.id);
        let unit = pdf
            .get_dict(p.id)
            .and_then(|d| get_num(pdf, d, b"UserUnit"))
            .unwrap_or(1.0);
        for (k, b) in &boxes {
            let (w, h) = ((b[2] - b[0]) * unit, (b[3] - b[1]) * unit);
            if w < 3.0 || h < 3.0 || w > 14_400.0 || h > 14_400.0 {
                s.push(
                    F::new(
                        "page-size",
                        "size",
                        "A page boundary is smaller than 3 or larger than 14,400 units",
                    )
                    .obj(Some(p.id))
                    .page(Some(i))
                    .param("box", k)
                    .param("width", format!("{w:.0}"))
                    .param("height", format!("{h:.0}")),
                );
            }
        }
        if c.p == Profile::X4 {
            let get_box = |k: &str| boxes.iter().find(|(n, _)| *n == k).map(|(_, b)| *b);
            let media = get_box("MediaBox").unwrap_or(p.media_box);
            let trim = get_box("TrimBox");
            let art = get_box("ArtBox");
            let bleed = get_box("BleedBox");
            if trim.is_none() == art.is_none() {
                s.push(
                    F::new(
                        "x4-boxes",
                        if trim.is_none() { "no-trim" } else { "both" },
                        "A page needs exactly one of TrimBox and ArtBox",
                    )
                    .obj(Some(p.id))
                    .page(Some(i))
                    .fixable(true),
                );
            }
            for (k, b) in [("TrimBox", trim), ("ArtBox", art), ("BleedBox", bleed)] {
                if let Some(b) = b {
                    if !within(&b, &media) {
                        s.push(
                            F::new(
                                "x4-boxes",
                                "outside",
                                "A page box extends beyond the MediaBox",
                            )
                            .obj(Some(p.id))
                            .page(Some(i))
                            .param("box", k)
                            .fixable(true),
                        );
                    }
                }
            }
            if let (Some(t), Some(b)) = (trim, bleed) {
                if !within(&t, &b) {
                    s.push(
                        F::new(
                            "x4-boxes",
                            "bleed",
                            "The TrimBox extends beyond the BleedBox",
                        )
                        .obj(Some(p.id))
                        .page(Some(i))
                        .fixable(true),
                    );
                }
            }
        }
    }
}
