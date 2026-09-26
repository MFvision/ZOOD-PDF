//! Conversion to PDF/A-1b/2b/2u/3b or PDF/X-4. Always a whole rewrite into a NEW file (the
//! original bytes are never touched); the output is validated again and the report says honestly
//! what could not be repaired.

use crate::appearance;
use crate::fonts::{self, FontInfo, SimpleEncoding};
use crate::icc;
use crate::model::{self, dict, get, get_dict, get_name, get_num, num, ref_id, Device, Key};
use crate::profile::Profile;
use crate::report::Report;
use crate::rules::rule;
use crate::validate::{self, forbidden_actions, NAMED_OK};
use crate::xmp::{self, Date};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::io::Write;
use ttf_parser::Face;
use warraq_pdf::limits::decode_stream;
use warraq_pdf::lopdf::{Dictionary, Object, ObjectId, Stream, StringFormat};
use warraq_pdf::{metadata, PasswordKind, Pdf, PdfError, Protection};

/// Conversion options.
#[derive(Debug, Clone, Default)]
pub struct ConvertOptions {
    /// Font programs (TrueType) the converter may embed as metric-compatible substitutes for
    /// non-embedded standard fonts (the UI passes the bundled Liberation fonts it was asked for).
    pub fonts: Vec<Vec<u8>>,
    /// "Now" for ModDate / MetadataDate (wasm has no clock; the UI passes it).
    pub now: Option<Date>,
}

/// One kind of change the converter made.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Action {
    /// Stable id (`embed-font`, `remove-javascript`, …); the UI key is `standards.action.<id>`.
    pub id: &'static str,
    /// Example detail (font name, annotation type, …).
    pub detail: String,
}

/// Result of a conversion.
#[derive(Debug, Clone)]
pub struct Converted {
    /// The new file.
    pub bytes: Vec<u8>,
    /// Validation of the input.
    pub before: Report,
    /// Validation of the output.
    pub after: Report,
    /// Changes made (with counts).
    pub actions: BTreeMap<Action, usize>,
}

struct Ctx {
    profile: Profile,
    actions: BTreeMap<Action, usize>,
}

impl Ctx {
    fn did(&mut self, id: &'static str, detail: impl Into<String>) {
        *self
            .actions
            .entry(Action {
                id,
                detail: detail.into(),
            })
            .or_insert(0) += 1;
    }

    fn applies(&self, rule_id: &str) -> bool {
        rule(rule_id).is_some_and(|r| r.applies(self.profile))
    }
}

fn flate(data: &[u8]) -> Vec<u8> {
    let mut e = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    let _ = e.write_all(data);
    e.finish().unwrap_or_default()
}

fn flate_stream(mut d: Dictionary, data: &[u8]) -> Stream {
    d.set("Filter", Object::Name(b"FlateDecode".to_vec()));
    d.remove(b"DecodeParms");
    Stream::new(d, flate(data))
}

fn name(n: &str) -> Object {
    Object::Name(n.as_bytes().to_vec())
}

/// Convert an opened document to `profile`.
pub fn convert(pdf: &Pdf, profile: Profile, opts: &ConvertOptions) -> Result<Converted, PdfError> {
    if let Some(sec) = pdf.security() {
        if sec.matched != PasswordKind::Owner && !pdf.permissions().modify {
            return Err(PdfError::Permission(
                "converting a protected document needs the owner password".into(),
            ));
        }
    }
    let before = validate::validate(pdf, profile);
    let mut w = Pdf::open_with_limits(pdf.bytes().to_vec(), Some(pdf.password()), *pdf.limits())?;
    let mut c = Ctx {
        profile,
        actions: BTreeMap::new(),
    };
    if pdf.is_encrypted() {
        c.did("remove-encryption", "");
    }
    let a1_transparency_only_groups = profile == Profile::A1b
        && !before.has("transparency-smask")
        && !before.has("transparency-alpha")
        && !before.has("blend-mode");
    generic_pass(&mut w, &mut c, a1_transparency_only_groups)?;
    let intent = output_intent(&mut w, &mut c)?;
    annotations_pass(&mut w, &mut c, intent.default_rgb.clone())?;
    catalog_pass(&mut w, &mut c)?;
    fonts_pass(&mut w, &mut c, opts)?;
    gstate_pass(&mut w, &mut c)?;
    inline_image_pass(&mut w, &mut c)?;
    if let Some(cs) = intent.default_rgb.clone() {
        default_rgb_pass(&mut w, &mut c, cs)?;
    }
    if profile == Profile::X4 {
        boxes_pass(&mut w, &mut c)?;
    }
    metadata_pass(&mut w, &mut c, opts)?;
    w.set_version(profile.output_version());
    let bytes = w.write_full(Protection::Remove)?;
    c.did("rewrite", profile.label());
    let out = Pdf::open(bytes.clone(), None)?;
    let after = validate::validate(&out, profile);
    Ok(Converted {
        bytes,
        before,
        after,
        actions: c.actions,
    })
}

/// Convert bytes (convenience for tests and the CLI).
pub fn convert_bytes(
    bytes: Vec<u8>,
    password: Option<&str>,
    profile: Profile,
    opts: &ConvertOptions,
) -> Result<Converted, PdfError> {
    let pdf = Pdf::open(bytes, password)?;
    convert(&pdf, profile, opts)
}

// ---------------------------------------------------------------- generic pass

/// Apply `f` to every reachable object (cloned); write back the ones it changed.
fn edit_all(
    w: &mut Pdf,
    mut f: impl FnMut(&Pdf, ObjectId, &mut Object) -> bool,
) -> Result<(), PdfError> {
    let ids = w.reachable()?;
    for id in ids {
        let Some(orig) = w.get(id) else { continue };
        let mut o = orig.clone();
        if f(w, id, &mut o) {
            w.set(id, o);
        }
    }
    Ok(())
}

fn filter_names(pdf: &Pdf, d: &Dictionary) -> Vec<Vec<u8>> {
    match get(pdf, d, b"Filter") {
        Some(Object::Name(n)) => vec![n.clone()],
        Some(Object::Array(a)) => a
            .iter()
            .filter_map(|o| pdf.resolve(o)?.as_name().ok().map(<[u8]>::to_vec))
            .collect(),
        _ => Vec::new(),
    }
}

fn params_list(pdf: &Pdf, d: &Dictionary, n: usize) -> Vec<Object> {
    match get(pdf, d, b"DecodeParms") {
        Some(Object::Array(a)) => (0..n)
            .map(|i| a.get(i).cloned().unwrap_or(Object::Null))
            .collect(),
        Some(o @ Object::Dictionary(_)) if n > 0 => {
            let mut v = vec![Object::Null; n];
            if let Some(first) = v.first_mut() {
                *first = o.clone();
            }
            v
        }
        _ => vec![Object::Null; n],
    }
}

/// Re-encode an LZW stream with Flate (the filters after LZW are kept).
fn reencode_lzw(pdf: &Pdf, s: &Stream) -> Option<Stream> {
    let fl = filter_names(pdf, &s.dict);
    let idx = fl.iter().position(|f| f == b"LZWDecode")?;
    let params = params_list(pdf, &s.dict, fl.len());
    // Filters before LZW must not need parameters (lopdf applies one parameter dictionary).
    if params.iter().take(idx).any(|p| !matches!(p, Object::Null)) {
        return None;
    }
    let mut td = Dictionary::new();
    td.set(
        "Filter",
        Object::Array(
            fl.iter()
                .take(idx + 1)
                .map(|f| Object::Name(f.clone()))
                .collect(),
        ),
    );
    if let Some(p @ Object::Dictionary(_)) = params.get(idx) {
        td.set("DecodeParms", p.clone());
    }
    let decoded = decode_stream(&Stream::new(td, s.content.clone()), pdf.limits()).ok()?;
    let rest: Vec<Vec<u8>> = fl.iter().skip(idx + 1).cloned().collect();
    let rest_params: Vec<Object> = params.iter().skip(idx + 1).cloned().collect();
    let mut d = s.dict.clone();
    if rest.is_empty() {
        d.set("Filter", name("FlateDecode"));
        d.remove(b"DecodeParms");
    } else {
        let mut f = vec![name("FlateDecode")];
        f.extend(rest.into_iter().map(Object::Name));
        d.set("Filter", Object::Array(f));
        if rest_params.iter().all(|p| matches!(p, Object::Null)) {
            d.remove(b"DecodeParms");
        } else {
            let mut p = vec![Object::Null];
            p.extend(rest_params);
            d.set("DecodeParms", Object::Array(p));
        }
    }
    Some(Stream::new(d, flate(&decoded)))
}

/// Whether an action object is (or chains to) something PDF/A forbids; returns the action names.
fn bad_action(pdf: &Pdf, p: Profile, a: &Dictionary) -> Option<String> {
    let s = get_name(pdf, a, b"S")?;
    if s == b"JavaScript" || forbidden_actions(p).contains(&s) {
        return Some(String::from_utf8_lossy(s).into_owned());
    }
    if s == b"Named" && !NAMED_OK.contains(&get_name(pdf, a, b"N").unwrap_or_default()) {
        return Some("Named".into());
    }
    None
}

fn generic_pass(w: &mut Pdf, c: &mut Ctx, drop_a1_groups: bool) -> Result<(), PdfError> {
    let p = c.profile;
    let is_a = p.is_pdfa();
    let mut log: Vec<(&'static str, String)> = Vec::new();
    edit_all(w, |pdf, _id, o| {
        let mut changed = false;
        fix_object(pdf, p, is_a, drop_a1_groups, o, 0, &mut changed, &mut log);
        changed
    })?;
    for (id, d) in log {
        c.did(id, d);
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn fix_object(
    pdf: &Pdf,
    p: Profile,
    is_a: bool,
    drop_groups: bool,
    o: &mut Object,
    depth: usize,
    changed: &mut bool,
    log: &mut Vec<(&'static str, String)>,
) {
    if depth > 64 {
        return;
    }
    match o {
        Object::Stream(s) => {
            let fl = filter_names(pdf, &s.dict);
            if is_a && fl.iter().any(|f| f == b"LZWDecode") {
                if let Some(ns) = reencode_lzw(pdf, s) {
                    *s = ns;
                    *changed = true;
                    log.push(("reencode-lzw", String::new()));
                }
            }
            if is_a && s.dict.has_type(b"Metadata") && !filter_names(pdf, &s.dict).is_empty() {
                if let Ok(raw) = decode_stream(s, pdf.limits()) {
                    s.dict.remove(b"Filter");
                    s.dict.remove(b"DecodeParms");
                    s.set_content(raw);
                    *changed = true;
                    log.push(("decompress-metadata", String::new()));
                }
            }
            let sub = get_name(pdf, &s.dict, b"Subtype").map(<[u8]>::to_vec);
            match sub.as_deref() {
                Some(b"Image") => {
                    for k in ["Alternates", "OPI"] {
                        if (is_a || k == "OPI") && s.dict.remove(k.as_bytes()).is_some() {
                            *changed = true;
                            log.push((
                                if k == "OPI" {
                                    "remove-opi"
                                } else {
                                    "remove-alternates"
                                },
                                String::new(),
                            ));
                        }
                    }
                    if is_a
                        && matches!(
                            get(pdf, &s.dict, b"Interpolate"),
                            Some(Object::Boolean(true))
                        )
                    {
                        s.dict.remove(b"Interpolate");
                        *changed = true;
                        log.push(("interpolate-off", String::new()));
                    }
                    if is_a {
                        if let Some(n) = get_name(pdf, &s.dict, b"Intent") {
                            if !model::INTENTS.contains(&n) {
                                s.dict.set("Intent", name("RelativeColorimetric"));
                                *changed = true;
                                log.push(("fix-intent", String::new()));
                            }
                        }
                    }
                }
                Some(b"Form") => {
                    if s.dict.remove(b"OPI").is_some() {
                        *changed = true;
                        log.push(("remove-opi", String::new()));
                    }
                    if get_name(pdf, &s.dict, b"Subtype2") == Some(b"PS") {
                        s.dict.remove(b"Subtype2");
                        *changed = true;
                        log.push(("remove-postscript", String::new()));
                    }
                    if s.dict.remove(b"PS").is_some() {
                        *changed = true;
                        log.push(("remove-postscript", String::new()));
                    }
                    if s.dict.remove(b"Ref").is_some() {
                        *changed = true;
                        log.push(("remove-reference-xobject", String::new()));
                    }
                    if drop_groups {
                        if let Some(g) = get_dict(pdf, &s.dict, b"Group") {
                            if get_name(pdf, g, b"S") == Some(b"Transparency") {
                                s.dict.remove(b"Group");
                                *changed = true;
                                log.push(("remove-transparency-group", String::new()));
                            }
                        }
                    }
                }
                _ => {}
            }
            for (_, v) in s.dict.iter_mut() {
                fix_object(pdf, p, is_a, drop_groups, v, depth + 1, changed, log);
            }
        }
        Object::Dictionary(d) => {
            fix_dict(pdf, p, is_a, drop_groups, d, changed, log);
            for (_, v) in d.iter_mut() {
                fix_object(pdf, p, is_a, drop_groups, v, depth + 1, changed, log);
            }
        }
        Object::Array(a) => {
            for v in a.iter_mut() {
                fix_object(pdf, p, is_a, drop_groups, v, depth + 1, changed, log);
            }
        }
        _ => {}
    }
}

fn is_action_bad(pdf: &Pdf, p: Profile, o: &Object) -> Option<String> {
    let d = dict(pdf, o)?;
    bad_action(pdf, p, d)
}

fn fix_dict(
    pdf: &Pdf,
    p: Profile,
    is_a: bool,
    drop_groups: bool,
    d: &mut Dictionary,
    changed: &mut bool,
    log: &mut Vec<(&'static str, String)>,
) {
    let x4 = p == Profile::X4;
    // Actions held under /A, /OpenAction and /Next.
    for key in ["A", "OpenAction"] {
        if let Ok(o) = d.get(key.as_bytes()) {
            if let Some(n) = is_action_bad(pdf, p, o) {
                if !x4 || n == "JavaScript" {
                    d.remove(key.as_bytes());
                    *changed = true;
                    log.push((
                        if n == "JavaScript" {
                            "remove-javascript"
                        } else {
                            "remove-action"
                        },
                        n,
                    ));
                }
            }
        }
    }
    if let Ok(next) = d.get(b"Next").cloned() {
        match pdf.resolve(&next) {
            Some(Object::Array(items)) => {
                let kept: Vec<Object> = items
                    .iter()
                    .filter(|i| {
                        is_action_bad(pdf, p, i).is_none()
                            || (x4 && is_action_bad(pdf, p, i).as_deref() != Some("JavaScript"))
                    })
                    .cloned()
                    .collect();
                if kept.len() != items.len() {
                    log.push(("remove-action", "Next".into()));
                    *changed = true;
                    if kept.is_empty() {
                        d.remove(b"Next");
                    } else {
                        d.set("Next", Object::Array(kept));
                    }
                }
            }
            Some(_) => {
                if let Some(n) = is_action_bad(pdf, p, &next) {
                    if !x4 || n == "JavaScript" {
                        d.remove(b"Next");
                        *changed = true;
                        log.push((
                            if n == "JavaScript" {
                                "remove-javascript"
                            } else {
                                "remove-action"
                            },
                            n,
                        ));
                    }
                }
            }
            None => {}
        }
    }
    // An action dictionary that is itself forbidden (e.g. an indirect action reached through
    // /Next chains we could not detach): neutralise it into an empty GoTo-less action.
    if let Some(n) = bad_action(pdf, p, d) {
        if !x4 || n == "JavaScript" {
            d.remove(b"JS");
            d.remove(b"F");
            d.remove(b"Win");
            d.remove(b"Next");
            d.set("S", name("GoTo"));
            d.set("D", Object::Array(Vec::new()));
            *changed = true;
            log.push((
                if n == "JavaScript" {
                    "remove-javascript"
                } else {
                    "remove-action"
                },
                n,
            ));
        }
    }
    if d.has(b"AA") && (is_a || x4) {
        // Additional actions are triggers only; with them go any scripts they carried.
        d.remove(b"AA");
        *changed = true;
        log.push(("remove-additional-actions", String::new()));
    }
    if p == Profile::A1b && d.has(b"EF") && (d.has_type(b"Filespec") || d.has(b"F") || d.has(b"UF"))
    {
        d.remove(b"EF");
        *changed = true;
        log.push(("remove-embedded-files", String::new()));
    }
    if matches!(p, Profile::A2b | Profile::A2u)
        && d.has(b"EF")
        && (d.has_type(b"Filespec") || d.has(b"F") || d.has(b"UF"))
    {
        let ok = get_dict(pdf, d, b"EF")
            .and_then(|e| e.get(b"F").or_else(|_| e.get(b"UF")).ok())
            .and_then(|o| model::stream(pdf, o))
            .and_then(|s| model::decoded(pdf, s))
            .is_some_and(|b| validate::embedded_is_pdfa12(&b));
        if !ok {
            d.remove(b"EF");
            *changed = true;
            log.push(("remove-embedded-files", String::new()));
        }
    }
    if p == Profile::A3b && d.has(b"EF") && (d.has_type(b"Filespec") || d.has(b"F") || d.has(b"UF"))
    {
        if !matches!(
            get_name(pdf, d, b"AFRelationship"),
            Some(b"Source")
                | Some(b"Data")
                | Some(b"Alternative")
                | Some(b"Supplement")
                | Some(b"Unspecified")
        ) {
            d.set("AFRelationship", name("Unspecified"));
            *changed = true;
            log.push(("fix-associated-file", String::new()));
        }
        if !d.has(b"UF") {
            if let Ok(f) = d.get(b"F").cloned() {
                let text = pdf
                    .resolve(&f)
                    .and_then(|o| o.as_str().ok())
                    .map(metadata::decode_text)
                    .unwrap_or_default();
                d.set("UF", metadata::encode_text(&text));
                *changed = true;
            }
        }
        if !d.has(b"F") {
            if let Some(uf) = get(pdf, d, b"UF")
                .and_then(|o| o.as_str().ok())
                .map(metadata::decode_text)
            {
                let ascii: String = uf
                    .chars()
                    .map(|ch| {
                        if ch.is_ascii() && !ch.is_ascii_control() {
                            ch
                        } else {
                            '_'
                        }
                    })
                    .collect();
                d.set("F", Object::string_literal(ascii));
                *changed = true;
            }
        }
    }
    // PDF/A-1: a page transparency group without any other transparency.
    if drop_groups && d.has_type(b"Page") {
        if let Some(g) = get_dict(pdf, d, b"Group") {
            if get_name(pdf, g, b"S") == Some(b"Transparency") {
                d.remove(b"Group");
                *changed = true;
                log.push(("remove-transparency-group", String::new()));
            }
        }
    }
}

// ---------------------------------------------------------------- output intent

struct IntentResult {
    /// `[/ICCBased sRGB]` to install as /DefaultRGB when the kept output intent is not RGB.
    default_rgb: Option<Object>,
}

fn icc_stream(w: &mut Pdf, profile: &[u8], n: i64) -> ObjectId {
    let mut d = Dictionary::new();
    d.set("N", Object::Integer(n));
    w.add(Object::Stream(flate_stream(d, profile)))
}

fn output_intent(w: &mut Pdf, c: &mut Ctx) -> Result<IntentResult, PdfError> {
    let root = w.root_id()?;
    let mut cat = w.catalog()?.clone();
    let existing: Vec<Object> = match get(w, &cat, b"OutputIntents") {
        Some(Object::Array(a)) => a.clone(),
        _ => Vec::new(),
    };
    let model = model::build(w);
    let uses_cmyk = model
        .colour_uses
        .iter()
        .any(|u| u.device == Device::Cmyk && !u.defaulted);
    let uses_rgb = model
        .colour_uses
        .iter()
        .any(|u| u.device == Device::Rgb && !u.defaulted);
    if c.profile == Profile::X4 {
        let others: Vec<Object> = existing
            .iter()
            .filter(|o| dict(w, o).is_some_and(|d| get_name(w, d, b"S") != Some(b"GTS_PDFX")))
            .cloned()
            .collect();
        let valid_x: Option<Object> = existing
            .iter()
            .find(|o| {
                dict(w, o).is_some_and(|d| {
                    get_name(w, d, b"S") == Some(b"GTS_PDFX")
                        && d.has(b"OutputConditionIdentifier")
                        && d.get(b"DestOutputProfile")
                            .ok()
                            .and_then(|p| model::stream(w, p))
                            .and_then(|s| model::decoded(w, s))
                            .and_then(|b| icc::parse_header(&b).ok())
                            .is_some_and(|h| &h.class == b"prtr")
                })
            })
            .cloned();
        let x = match valid_x {
            Some(x) => x,
            None => {
                let pid = icc_stream(w, icc::rgb_output(), 3);
                let mut oi = Dictionary::new();
                oi.set("Type", name("OutputIntent"));
                oi.set("S", name("GTS_PDFX"));
                oi.set(
                    "OutputConditionIdentifier",
                    Object::string_literal("Custom"),
                );
                oi.set(
                    "OutputCondition",
                    Object::string_literal("RGB output, sRGB model (ZOOD PDF)"),
                );
                oi.set(
                    "Info",
                    Object::string_literal("RGB output, sRGB model (ZOOD PDF)"),
                );
                oi.set("DestOutputProfile", Object::Reference(pid));
                c.did("add-output-intent", "PDF/X RGB");
                Object::Reference(w.add(Object::Dictionary(oi)))
            }
        };
        let mut all = vec![x];
        all.extend(others);
        cat.set("OutputIntents", Object::Array(all));
        w.set(root, Object::Dictionary(cat));
        return Ok(IntentResult { default_rgb: None });
    }
    // PDF/A: keep a valid existing GTS_PDFA1 intent when it suits the document.
    let a1 = c.profile == Profile::A1b;
    let valid = existing.iter().find_map(|o| {
        let d = dict(w, o)?;
        if get_name(w, d, b"S") != Some(b"GTS_PDFA1") {
            return None;
        }
        let po = d.get(b"DestOutputProfile").ok()?;
        let st = model::stream(w, po)?;
        let h = icc::parse_header(&model::decoded(w, st)?).ok()?;
        let n_ok = get_num(w, &st.dict, b"N").is_none_or(|n| Some(n as u8) == h.components());
        let ok = n_ok
            && matches!(&h.class, b"mntr" | b"prtr")
            && h.major <= if a1 { 3 } else { 4 }
            && h.components().is_some();
        ok.then(|| (o.clone(), h.colour_space))
    });
    let keep = match &valid {
        Some((_, space)) => match space {
            b"RGB " => true,
            b"CMYK" => uses_cmyk || !uses_rgb,
            b"GRAY" => !uses_rgb && !uses_cmyk,
            _ => false,
        },
        None => false,
    };
    let mut default_rgb = None;
    let intent_obj = if let (true, Some((o, space))) = (keep, &valid) {
        if space != b"RGB " && uses_rgb {
            let pid = icc_stream(w, icc::srgb_display(), 3);
            default_rgb = Some(Object::Array(vec![
                name("ICCBased"),
                Object::Reference(pid),
            ]));
            c.did("add-default-rgb", "");
        }
        o.clone()
    } else {
        if uses_cmyk {
            // An sRGB intent cannot cover DeviceCMYK; the validator reports those uses.
            c.did("cmyk-not-covered", "");
        }
        let pid = icc_stream(w, icc::srgb_display(), 3);
        let mut oi = Dictionary::new();
        oi.set("Type", name("OutputIntent"));
        oi.set("S", name("GTS_PDFA1"));
        oi.set(
            "OutputConditionIdentifier",
            Object::string_literal("sRGB IEC61966-2.1"),
        );
        oi.set(
            "RegistryName",
            Object::string_literal("http://www.color.org"),
        );
        oi.set("Info", Object::string_literal("sRGB IEC61966-2.1"));
        oi.set("DestOutputProfile", Object::Reference(pid));
        c.did("add-output-intent", "sRGB");
        Object::Reference(w.add(Object::Dictionary(oi)))
    };
    if existing.len() > 1 || (valid.is_none() && !existing.is_empty()) {
        c.did("replace-output-intents", "");
    }
    let mut cat = w.catalog()?.clone();
    cat.set("OutputIntents", Object::Array(vec![intent_obj]));
    w.set(root, Object::Dictionary(cat));
    Ok(IntentResult { default_rgb })
}

fn default_rgb_pass(w: &mut Pdf, c: &mut Ctx, cs: Object) -> Result<(), PdfError> {
    let mut n = 0;
    edit_all(w, |pdf, _, o| {
        let d = match o {
            Object::Dictionary(d) => d,
            Object::Stream(s) => &mut s.dict,
            _ => return false,
        };
        let Ok(r) = d.get(b"Resources").cloned() else {
            return false;
        };
        match r {
            Object::Dictionary(mut res) => {
                add_default(pdf, &mut res, &cs);
                d.set("Resources", Object::Dictionary(res));
                n += 1;
                true
            }
            _ => false,
        }
    })?;
    // Indirect resource dictionaries.
    let ids: Vec<ObjectId> = w
        .reachable()?
        .into_iter()
        .filter(|id| {
            let is_res = |d: &Dictionary| {
                d.has(b"Font")
                    || d.has(b"XObject")
                    || d.has(b"ExtGState")
                    || d.has(b"ProcSet")
                    || d.has(b"ColorSpace")
                    || d.has(b"Pattern")
                    || d.has(b"Shading")
            };
            matches!(w.get(*id), Some(Object::Dictionary(d)) if is_res(d) && !d.has(b"Type"))
        })
        .collect();
    for id in ids {
        if let Some(Object::Dictionary(d)) = w.get(id) {
            let mut d = d.clone();
            add_default(w, &mut d, &cs);
            w.set(id, Object::Dictionary(d));
            n += 1;
        }
    }
    if n > 0 {
        c.did("add-default-rgb", "");
    }
    Ok(())
}

fn add_default(pdf: &Pdf, res: &mut Dictionary, cs: &Object) {
    let mut spaces = get_dict(pdf, res, b"ColorSpace")
        .cloned()
        .unwrap_or_default();
    if !spaces.has(b"DefaultRGB") {
        spaces.set("DefaultRGB", cs.clone());
    }
    res.set("ColorSpace", Object::Dictionary(spaces));
}

// ---------------------------------------------------------------- annotations

fn annotations_pass(w: &mut Pdf, c: &mut Ctx, default_rgb: Option<Object>) -> Result<(), PdfError> {
    let p = c.profile;
    if !p.is_pdfa() {
        return Ok(());
    }
    let pages = warraq_pdf::pages::flatten(w)?;
    let mut removed: HashSet<ObjectId> = HashSet::new();
    for pg in &pages {
        let Some(pd) = w.get_dict(pg.id) else {
            continue;
        };
        let annots_obj = pd.get(b"Annots").ok().cloned();
        let (annots_holder, list) = match &annots_obj {
            Some(Object::Reference(id)) => match w.get(*id) {
                Some(Object::Array(a)) => (Some(*id), a.clone()),
                _ => continue,
            },
            Some(Object::Array(a)) => (None, a.clone()),
            _ => continue,
        };
        let mut kept = Vec::new();
        for a in list {
            let Some(ad) = dict(w, &a).cloned() else {
                continue;
            };
            let sub = get_name(w, &ad, b"Subtype").unwrap_or_default().to_vec();
            let f = get_num(w, &ad, b"F").map(|v| v as i64).unwrap_or(0);
            let widget = sub == b"Widget";
            let hidden = f & (1 | 2 | 32) != 0;
            if !validate::annot_allowed(p, &sub) || (hidden && !widget) {
                if let Some(id) = ref_id(&a) {
                    removed.insert(id);
                }
                c.did(
                    if hidden {
                        "remove-hidden-annotation"
                    } else {
                        "remove-annotation"
                    },
                    String::from_utf8_lossy(&sub),
                );
                continue;
            }
            kept.push(a);
        }
        // Popups of removed annotations go too.
        let kept: Vec<Object> = kept
            .into_iter()
            .filter(|a| {
                let parent = dict(w, a)
                    .and_then(|d| d.get(b"Parent").ok())
                    .and_then(ref_id);
                !parent.is_some_and(|p| removed.contains(&p))
            })
            .collect();
        match annots_holder {
            Some(id) => w.set(id, Object::Array(kept.clone())),
            None => {
                let mut pd = w.get_dict(pg.id).cloned().unwrap_or_default();
                pd.set("Annots", Object::Array(kept.clone()));
                w.set(pg.id, Object::Dictionary(pd));
            }
        }
        // Flags and appearances of the kept annotations.
        for a in &kept {
            let Some(id) = ref_id(a) else { continue };
            let Some(mut ad) = w.get_dict(id).cloned() else {
                continue;
            };
            let mut changed = false;
            let sub = get_name(w, &ad, b"Subtype").unwrap_or_default().to_vec();
            let popup = sub == b"Popup";
            let f = get_num(w, &ad, b"F").map(|v| v as i64);
            let want_print = !popup || p == Profile::A1b;
            let nf = (f.unwrap_or(0) | if want_print { 4 } else { 0 }) & !(1 | 2 | 32 | 256);
            if f != Some(nf) && (f.is_some() || want_print) {
                ad.set("F", Object::Integer(nf));
                changed = true;
                c.did("fix-annotation-flags", String::from_utf8_lossy(&sub));
            }
            if let Some(mut ap) = get_dict(w, &ad, b"AP").cloned() {
                let extra: Vec<Vec<u8>> = ap
                    .iter()
                    .map(|(k, _)| k.clone())
                    .filter(|k| k.as_slice() != b"N")
                    .collect();
                if !extra.is_empty() {
                    for k in extra {
                        ap.remove(&k);
                    }
                    ad.set("AP", Object::Dictionary(ap));
                    changed = true;
                    c.did("trim-appearance", "");
                }
            }
            if p != Profile::A1b && !popup && sub != b"Link" {
                let has_n = get_dict(w, &ad, b"AP").is_some_and(|ap| ap.has(b"N"));
                if !has_n {
                    if let Some(st) = appearance::build(w, &ad, true, default_rgb.clone()) {
                        let sid = w.add(Object::Stream(flate_stream(st.dict, &st.content)));
                        let mut ap = Dictionary::new();
                        ap.set("N", Object::Reference(sid));
                        ad.set("AP", Object::Dictionary(ap));
                        changed = true;
                        c.did("draw-appearance", String::from_utf8_lossy(&sub));
                    }
                }
            }
            if changed {
                w.set(id, Object::Dictionary(ad));
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------- catalog

fn catalog_pass(w: &mut Pdf, c: &mut Ctx) -> Result<(), PdfError> {
    let p = c.profile;
    let root = w.root_id()?;
    let mut cat = w.catalog()?.clone();
    let mut changed = false;
    // Name trees: JavaScript (every profile), EmbeddedFiles (PDF/A-1).
    let names_ref = cat.get(b"Names").ok().and_then(ref_id);
    if let Some(mut names) = get_dict(w, &cat, b"Names").cloned() {
        let mut nch = false;
        if names.remove(b"JavaScript").is_some() {
            nch = true;
            c.did("remove-javascript", "names");
        }
        if p == Profile::A1b && names.remove(b"EmbeddedFiles").is_some() {
            nch = true;
            c.did("remove-embedded-files", "");
        }
        if nch {
            match names_ref {
                Some(id) => w.set(id, Object::Dictionary(names)),
                None => {
                    cat.set("Names", Object::Dictionary(names));
                    changed = true;
                }
            }
        }
    }
    if p.is_pdfa() && cat.remove(b"NeedsRendering").is_some() {
        changed = true;
        c.did("remove-xfa", "NeedsRendering");
    }
    // AcroForm (direct or indirect).
    let af_ref = cat.get(b"AcroForm").ok().and_then(ref_id);
    if let Some(mut af) = get_dict(w, &cat, b"AcroForm").cloned() {
        let mut af_changed = false;
        if p.is_pdfa() && p != Profile::A1b && af.has(b"XFA") {
            let has_fields =
                matches!(get(w, &af, b"Fields"), Some(Object::Array(a)) if !a.is_empty());
            if has_fields {
                af.remove(b"XFA");
                af_changed = true;
                c.did("remove-xfa", "XFA");
            }
        }
        if p.is_pdfa() && matches!(get(w, &af, b"NeedAppearances"), Some(Object::Boolean(true))) {
            let widgets_ok = model::build(w)
                .annots
                .iter()
                .filter_map(|a| model::annot_dict(w, a))
                .filter(|d| get_name(w, d, b"Subtype") == Some(b"Widget"))
                .all(|d| get_dict(w, d, b"AP").is_some_and(|ap| ap.has(b"N")));
            if widgets_ok {
                af.set("NeedAppearances", Object::Boolean(false));
                af_changed = true;
                c.did("need-appearances-off", "");
            }
        }
        if af_changed {
            match af_ref {
                Some(id) => w.set(id, Object::Dictionary(af)),
                None => {
                    cat.set("AcroForm", Object::Dictionary(af));
                    changed = true;
                }
            }
        }
    }
    // Optional content configurations (PDF/A-2/3).
    if p.is_pdfa() && p != Profile::A1b {
        let oc_ref = cat.get(b"OCProperties").ok().and_then(ref_id);
        if let Some(mut oc) = get_dict(w, &cat, b"OCProperties").cloned() {
            let all: Vec<Object> = match get(w, &oc, b"OCGs") {
                Some(Object::Array(a)) => a.clone(),
                _ => Vec::new(),
            };
            let mut oc_changed = false;
            let mut used_names = HashSet::new();
            let mut fix_cfg = |cfg: &mut Dictionary, dflt: &str, w: &Pdf| {
                let mut ch = false;
                let nm = get(w, cfg, b"Name")
                    .and_then(|o| o.as_str().ok())
                    .map(<[u8]>::to_vec);
                let unique = nm.as_ref().is_some_and(|n| used_names.insert(n.clone()));
                if !unique {
                    let mut candidate = dflt.to_string();
                    let mut i = 2;
                    while !used_names.insert(candidate.as_bytes().to_vec()) {
                        candidate = format!("{dflt} {i}");
                        i += 1;
                    }
                    cfg.set("Name", Object::string_literal(candidate));
                    ch = true;
                }
                if cfg.remove(b"AS").is_some() {
                    ch = true;
                }
                if let Some(Object::Array(order)) = get(w, cfg, b"Order").cloned() {
                    let mut listed = HashSet::new();
                    let mut stack = vec![order.clone()];
                    let mut guard = 0;
                    while let Some(arr) = stack.pop() {
                        guard += 1;
                        if guard > 10_000 {
                            break;
                        }
                        for o in arr {
                            if let Some(id) = ref_id(&o) {
                                listed.insert(id);
                            }
                            if let Some(Object::Array(inner)) = w.resolve(&o) {
                                stack.push(inner.clone());
                            }
                        }
                    }
                    let missing: Vec<Object> = all
                        .iter()
                        .filter(|g| ref_id(g).is_some_and(|id| !listed.contains(&id)))
                        .cloned()
                        .collect();
                    if !missing.is_empty() {
                        let mut order = order;
                        order.extend(missing);
                        cfg.set("Order", Object::Array(order));
                        ch = true;
                    }
                }
                ch
            };
            if let Some(mut d) = get_dict(w, &oc, b"D").cloned() {
                if fix_cfg(&mut d, "Default", w) {
                    oc.set("D", Object::Dictionary(d));
                    oc_changed = true;
                }
            }
            if let Some(Object::Array(cfgs)) = get(w, &oc, b"Configs").cloned() {
                let mut out = Vec::new();
                let mut any = false;
                for (i, co) in cfgs.iter().enumerate() {
                    match dict(w, co).cloned() {
                        Some(mut d) => {
                            if fix_cfg(&mut d, &format!("Configuration {}", i + 1), w) {
                                any = true;
                            }
                            out.push(Object::Dictionary(d));
                        }
                        None => out.push(co.clone()),
                    }
                }
                if any {
                    oc.set("Configs", Object::Array(out));
                    oc_changed = true;
                }
            }
            if oc_changed {
                c.did("fix-optional-content", "");
                match oc_ref {
                    Some(id) => w.set(id, Object::Dictionary(oc)),
                    None => {
                        cat.set("OCProperties", Object::Dictionary(oc));
                        changed = true;
                    }
                }
            }
        }
    }
    // PDF/A-3: every embedded file specification listed in the catalog's /AF.
    if p == Profile::A3b {
        let mut af: Vec<Object> = match get(w, &cat, b"AF") {
            Some(Object::Array(a)) => a.clone(),
            _ => Vec::new(),
        };
        let listed: HashSet<ObjectId> = af.iter().filter_map(ref_id).collect();
        let mut add = Vec::new();
        for (holder, fs) in validate::filespecs(w) {
            let is_self = w.get_dict(holder).is_some_and(|d| d == &fs);
            if is_self && !listed.contains(&holder) {
                add.push(Object::Reference(holder));
            }
        }
        if !add.is_empty() {
            af.extend(add);
            cat.set("AF", Object::Array(af));
            changed = true;
            c.did("fix-associated-file", "AF");
        }
        // MIME types for embedded file streams.
        for (_, fs) in validate::filespecs(w) {
            let fname = get(w, &fs, b"UF")
                .or_else(|| get(w, &fs, b"F"))
                .and_then(|o| o.as_str().ok())
                .map(metadata::decode_text)
                .unwrap_or_default();
            let Some(ef) = get_dict(w, &fs, b"EF").cloned() else {
                continue;
            };
            for key in [b"F".as_slice(), b"UF"] {
                let Some(sid) = ef.get(key).ok().and_then(ref_id) else {
                    continue;
                };
                let Some(Object::Stream(st)) = w.get(sid) else {
                    continue;
                };
                if get_name(w, &st.dict, b"Subtype").is_none() {
                    let mut st = st.clone();
                    st.dict.set(
                        "Subtype",
                        Object::Name(mime_for(&fname).as_bytes().to_vec()),
                    );
                    st.dict.set("Type", name("EmbeddedFile"));
                    w.set(sid, Object::Stream(st));
                    c.did("fix-associated-file", "Subtype");
                }
            }
        }
    }
    if changed {
        w.set(root, Object::Dictionary(cat));
    }
    Ok(())
}

/// MIME type by file extension (the embedded file stream's /Subtype).
pub fn mime_for(file: &str) -> &'static str {
    let ext = file.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "pdf" => "application/pdf",
        "xml" => "text/xml",
        "txt" => "text/plain",
        "csv" => "text/csv",
        "json" => "application/json",
        "html" | "htm" => "text/html",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "tif" | "tiff" => "image/tiff",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

// ---------------------------------------------------------------- fonts

struct Substitute {
    ps: String,
    bytes: Vec<u8>,
}

fn load_substitutes(opts: &ConvertOptions) -> Vec<Substitute> {
    opts.fonts
        .iter()
        .filter_map(|b| {
            let face = Face::parse(b, 0).ok()?;
            let ps = fonts::postscript_name(&face)?;
            Some(Substitute {
                ps,
                bytes: b.clone(),
            })
        })
        .collect()
}

fn reverse_cmap(face: &Face<'_>) -> HashMap<u16, char> {
    let mut out: HashMap<u16, char> = HashMap::new();
    let Some(cmap) = face.tables().cmap else {
        return out;
    };
    for st in cmap.subtables {
        if !st.is_unicode() {
            continue;
        }
        st.codepoints(|cp| {
            if let (Some(g), Some(ch)) = (st.glyph_index(cp), char::from_u32(cp)) {
                if g.0 != 0 {
                    let e = out.entry(g.0).or_insert(ch);
                    if cp < (*e as u32) {
                        *e = ch;
                    }
                }
            }
        });
    }
    out
}

/// Build the ToUnicode entries a font's codes can be mapped with.
fn derive_tounicode(
    pdf: &Pdf,
    fi: &FontInfo<'_>,
    used: Option<&BTreeSet<u32>>,
) -> Option<(BTreeMap<u32, String>, usize)> {
    let sfnt = fonts::sfnt_bytes(pdf, fi);
    let face = sfnt.as_ref().and_then(|b| Face::parse(b, 0).ok());
    let rev = face.as_ref().map(reverse_cmap).unwrap_or_default();
    let mut out = BTreeMap::new();
    // Keep valid entries of an existing map.
    if let Some(bytes) = fi
        .dict
        .get(b"ToUnicode")
        .ok()
        .and_then(|o| model::stream(pdf, o))
        .and_then(|s| model::decoded(pdf, s))
    {
        for (k, v) in fonts::parse_cmap(&bytes).uni {
            if !v.is_empty() && !v.contains(['\u{0}', '\u{FEFF}', '\u{FFFE}']) {
                out.insert(k, v);
            }
        }
    }
    if fi.subtype == "Type0" {
        let face = face.as_ref()?;
        let desc = fi.descendant?;
        let map = fonts::cid_map_bytes(pdf, desc);
        let codes: Vec<u32> = match used {
            Some(u) => u.iter().copied().collect(),
            None => (0..u32::from(face.number_of_glyphs()).min(65_535)).collect(),
        };
        for cid in codes {
            if out.contains_key(&cid) {
                continue;
            }
            let g = fonts::cid_to_gid(pdf, desc, &map, cid);
            if let Some(ch) = u16::try_from(g).ok().and_then(|g| rev.get(&g)) {
                out.insert(cid, ch.to_string());
            }
        }
        return (!out.is_empty()).then_some((out, 2));
    }
    let enc = fonts::simple_encoding(pdf, fi);
    for code in 0u32..256 {
        if out.contains_key(&code) {
            continue;
        }
        let from_name = enc
            .names
            .get(code as usize)
            .and_then(|n| n.as_deref())
            .and_then(fonts::glyph_unicode);
        let from_font = || {
            let face = face.as_ref()?;
            let g = fonts::truetype_glyph(face, &enc, fi.symbolic(), code as u8)?;
            rev.get(&g.0).map(|c| c.to_string())
        };
        if let Some(t) = from_name.or_else(from_font) {
            out.insert(code, t);
        }
    }
    (!out.is_empty()).then_some((out, 1))
}

fn widths_for(
    face: &Face<'_>,
    enc: &SimpleEncoding,
    symbolic: bool,
    first: u8,
    last: u8,
) -> Vec<Object> {
    (first..=last)
        .map(|code| {
            let w = fonts::truetype_glyph(face, enc, symbolic, code)
                .and_then(|g| fonts::advance(face, g))
                .unwrap_or(0.0);
            Object::Integer(w.round() as i64)
        })
        .collect()
}

fn fonts_pass(w: &mut Pdf, c: &mut Ctx, opts: &ConvertOptions) -> Result<(), PdfError> {
    let subs = load_substitutes(opts);
    let m = model::build(w);
    let mut file_cache: HashMap<String, ObjectId> = HashMap::new();
    let keys: Vec<(Key, Option<BTreeSet<u32>>)> = m
        .fonts
        .keys()
        .map(|k| {
            let used = model::font_dict(w, k, true).and_then(|d| {
                let fi = fonts::info(w, d);
                let strings = m.text.get(k)?;
                let mut set = BTreeSet::new();
                for s in strings {
                    set.extend(fonts::codes(w, &fi, s)?);
                }
                Some(set)
            });
            (k.clone(), used)
        })
        .collect();
    for (k, used) in keys {
        let Key::Obj(fid) = k else { continue };
        let Some(d) = w.get_dict(fid).cloned() else {
            continue;
        };
        let (new_dict, extra) = {
            let fi = fonts::info(w, &d);
            let mut nd: Option<Dictionary> = None;
            let mut extra: Vec<(&'static str, Object)> = Vec::new();
            // 1. Embed a metric-compatible substitute for a non-embedded standard font.
            if !fi.embedded()
                && c.applies("font-embedded")
                && matches!(fi.subtype.as_str(), "Type1" | "MMType1" | "TrueType")
            {
                if let Some(ps) = fonts::substitute_for(&fi.base_font) {
                    match subs.iter().find(|s| s.ps == ps) {
                        Some(sub) => {
                            if let Some(built) = embed_substitute(
                                w,
                                &fi,
                                sub,
                                c.profile == Profile::A2u,
                                &file_cache,
                            ) {
                                nd = Some(built.0);
                                extra = built.1;
                                c.did("embed-font", format!("{} → {}", fi.base_font, ps));
                            }
                        }
                        None => c.did("font-not-available", ps),
                    }
                }
            }
            // 2. Widths that disagree with an embedded TrueType program.
            if nd.is_none() && fi.subtype == "TrueType" && c.applies("font-widths") {
                if let Some(bytes) = fonts::sfnt_bytes(w, &fi) {
                    if let Ok(face) = Face::parse(&bytes, 0) {
                        let enc = fonts::simple_encoding(w, &fi);
                        let fc = get_num(w, &d, b"FirstChar")
                            .unwrap_or(0.0)
                            .clamp(0.0, 255.0) as u8;
                        let lc = get_num(w, &d, b"LastChar")
                            .unwrap_or(255.0)
                            .clamp(0.0, 255.0) as u8;
                        let mismatch = used.as_ref().is_some_and(|u| {
                            !validate::width_mismatches(w, &fi, &face, u).is_empty()
                        });
                        if mismatch && lc >= fc {
                            let mut dd = d.clone();
                            let old: Vec<Object> = match get(w, &d, b"Widths") {
                                Some(Object::Array(a)) => a.clone(),
                                _ => Vec::new(),
                            };
                            let computed = widths_for(&face, &enc, fi.symbolic(), fc, lc);
                            // Keep declared widths for codes without a glyph (they are not compared).
                            let merged: Vec<Object> = computed
                                .into_iter()
                                .enumerate()
                                .map(|(i, cw)| {
                                    let code = fc.saturating_add(i as u8);
                                    if fonts::truetype_glyph(&face, &enc, fi.symbolic(), code)
                                        .is_some()
                                    {
                                        cw
                                    } else {
                                        old.get(i).cloned().unwrap_or(Object::Integer(0))
                                    }
                                })
                                .collect();
                            dd.set("FirstChar", Object::Integer(i64::from(fc)));
                            dd.set("LastChar", Object::Integer(i64::from(lc)));
                            dd.set("Widths", Object::Array(merged));
                            nd = Some(dd);
                            c.did("fix-widths", fi.base_font.clone());
                        }
                    }
                }
            }
            // 3. ToUnicode for PDF/A-2u.
            if c.profile == Profile::A2u {
                let cur = nd.clone().unwrap_or_else(|| d.clone());
                let fi2 = fonts::info(w, &cur);
                let has_complete = cur
                    .get(b"ToUnicode")
                    .ok()
                    .and_then(|o| model::stream(w, o))
                    .and_then(|s| model::decoded(w, s))
                    .map(|b| fonts::parse_cmap(&b))
                    .is_some_and(|cm| {
                        !cm.uni
                            .values()
                            .any(|t| t.contains(['\u{0}', '\u{FEFF}', '\u{FFFE}']))
                            && used
                                .as_ref()
                                .is_none_or(|u| u.iter().all(|x| cm.uni.contains_key(x)))
                    });
                if !has_complete && !extra.iter().any(|(k, _)| *k == "ToUnicode") {
                    if let Some((entries, nbytes)) = derive_tounicode(w, &fi2, used.as_ref()) {
                        let st = flate_stream(
                            Dictionary::new(),
                            &fonts::write_tounicode(&entries, nbytes),
                        );
                        extra.push(("ToUnicode", Object::Stream(st)));
                        nd.get_or_insert(cur);
                        c.did("add-tounicode", fi.base_font.clone());
                    }
                }
            }
            // 4. CIDToGIDMap for Type 2 CIDFonts (Identity is the default meaning).
            if fi.subtype == "Type0" {
                if let Some(Object::Array(df)) = get(w, &d, b"DescendantFonts") {
                    if let Some(did) = df.first().and_then(ref_id) {
                        if let Some(dd) = w.get_dict(did) {
                            if get_name(w, dd, b"Subtype") == Some(b"CIDFontType2")
                                && !dd.has(b"CIDToGIDMap")
                                && fi.program.is_some()
                            {
                                extra.push(("__cidtogid", Object::Reference(did)));
                            }
                        }
                    }
                }
            }
            (nd, extra)
        };
        let mut final_dict = new_dict.unwrap_or_else(|| d.clone());
        let mut touched = final_dict != d;
        let mut ps_name: Option<String> = None;
        let mut file_id: Option<ObjectId> = None;
        for (key, obj) in extra {
            match key {
                "__fontfile" => {
                    ps_name = obj
                        .as_str()
                        .ok()
                        .map(|b| String::from_utf8_lossy(b).into_owned());
                }
                "__fontfile_obj" => {
                    let id = match obj {
                        Object::Reference(id) => id,
                        other => w.add(other),
                    };
                    if let Some(ps) = &ps_name {
                        file_cache.insert(ps.clone(), id);
                    }
                    file_id = Some(id);
                }
                "__cidtogid" => {
                    if let Some(did) = ref_id(&obj) {
                        if let Some(mut dd) = w.get_dict(did).cloned() {
                            dd.set("CIDToGIDMap", name("Identity"));
                            w.set(did, Object::Dictionary(dd));
                            c.did("add-cidtogidmap", "");
                        }
                    }
                }
                "FontDescriptor" | "ToUnicode" => {
                    let obj = match (key, obj, file_id) {
                        ("FontDescriptor", Object::Dictionary(mut fd), Some(fid)) => {
                            fd.set("FontFile2", Object::Reference(fid));
                            Object::Dictionary(fd)
                        }
                        (_, o, _) => o,
                    };
                    let id = w.add(obj);
                    final_dict.set(key, Object::Reference(id));
                    touched = true;
                }
                _ => {}
            }
        }
        if touched {
            w.set(fid, Object::Dictionary(final_dict));
        }
    }
    Ok(())
}

/// A TrueType font dictionary embedding `sub` for the simple font `fi`, keeping every code's glyph
/// name (WinAnsi base + Differences) so the text shows the same characters.
fn embed_substitute(
    w: &Pdf,
    fi: &FontInfo<'_>,
    sub: &Substitute,
    tounicode: bool,
    cache: &HashMap<String, ObjectId>,
) -> Option<(Dictionary, Vec<(&'static str, Object)>)> {
    let face = Face::parse(&sub.bytes, 0).ok()?;
    let orig = fonts::simple_encoding(w, fi);
    // Target encoding: WinAnsi + Differences for codes whose glyph differs.
    let mut diffs: Vec<Object> = Vec::new();
    let mut names: Vec<Option<String>> = crate::encodings::WIN_ANSI
        .iter()
        .map(|n| (!n.is_empty()).then(|| (*n).to_string()))
        .collect();
    let mut last_code: Option<usize> = None;
    for (code, want) in orig.names.iter().enumerate() {
        let Some(want) = want else { continue };
        let base = crate::encodings::WIN_ANSI.get(code).copied().unwrap_or("");
        if base == want || !fonts::in_agl(want) {
            continue;
        }
        if last_code.is_none_or(|l| l + 1 != code) {
            diffs.push(Object::Integer(code as i64));
        }
        diffs.push(Object::Name(want.as_bytes().to_vec()));
        last_code = Some(code);
        if let Some(slot) = names.get_mut(code) {
            *slot = Some(want.clone());
        }
    }
    let enc = SimpleEncoding {
        names,
        base: Some("WinAnsiEncoding"),
        has_differences: !diffs.is_empty(),
        differences_in_agl: true,
    };
    let codes: Vec<usize> = orig
        .names
        .iter()
        .enumerate()
        .filter(|(_, n)| n.is_some())
        .map(|(i, _)| i)
        .collect();
    let first = *codes.first().unwrap_or(&32) as u8;
    let last = *codes.last().unwrap_or(&126) as u8;
    let widths = widths_for(&face, &enc, false, first, last);
    let upem = f64::from(face.units_per_em()).max(1.0);
    let sc = |v: f64| Object::Integer((v * 1000.0 / upem).round() as i64);
    let bb = face.global_bounding_box();
    let serif = sub.ps.starts_with("LiberationSerif");
    let mono = sub.ps.starts_with("LiberationMono");
    let italic = face.is_italic() || sub.ps.contains("Italic");
    let bold = face.is_bold() || sub.ps.contains("Bold");
    let flags =
        32 | if serif { 2 } else { 0 } | if mono { 1 } else { 0 } | if italic { 64 } else { 0 };
    // The font program: an existing object for this substitute, or a new stream to add.
    let file = match cache.get(&sub.ps) {
        Some(id) => Object::Reference(*id),
        None => {
            let mut fd = Dictionary::new();
            fd.set("Length1", Object::Integer(sub.bytes.len() as i64));
            Object::Stream(flate_stream(fd, &sub.bytes))
        }
    };
    let mut desc = Dictionary::new();
    desc.set("Type", name("FontDescriptor"));
    desc.set("FontName", Object::Name(sub.ps.as_bytes().to_vec()));
    desc.set("Flags", Object::Integer(flags));
    desc.set(
        "FontBBox",
        Object::Array(vec![
            sc(f64::from(bb.x_min)),
            sc(f64::from(bb.y_min)),
            sc(f64::from(bb.x_max)),
            sc(f64::from(bb.y_max)),
        ]),
    );
    desc.set("ItalicAngle", Object::Real(face.italic_angle()));
    desc.set("Ascent", sc(f64::from(face.ascender())));
    desc.set("Descent", sc(f64::from(face.descender())));
    desc.set(
        "CapHeight",
        sc(f64::from(face.capital_height().unwrap_or(face.ascender()))),
    );
    desc.set("StemV", Object::Integer(if bold { 140 } else { 80 }));
    let mut d = Dictionary::new();
    d.set("Type", name("Font"));
    d.set("Subtype", name("TrueType"));
    d.set("BaseFont", Object::Name(sub.ps.as_bytes().to_vec()));
    d.set("FirstChar", Object::Integer(i64::from(first)));
    d.set("LastChar", Object::Integer(i64::from(last)));
    d.set("Widths", Object::Array(widths));
    if diffs.is_empty() {
        d.set("Encoding", name("WinAnsiEncoding"));
    } else {
        let mut e = Dictionary::new();
        e.set("Type", name("Encoding"));
        e.set("BaseEncoding", name("WinAnsiEncoding"));
        e.set("Differences", Object::Array(diffs));
        d.set("Encoding", Object::Dictionary(e));
    }
    let mut extra: Vec<(&'static str, Object)> = vec![
        (
            "__fontfile",
            Object::String(sub.ps.as_bytes().to_vec(), StringFormat::Literal),
        ),
        ("__fontfile_obj", file),
        ("FontDescriptor", Object::Dictionary(desc)),
    ];
    if tounicode {
        let mut map = BTreeMap::new();
        for (code, n) in enc.names.iter().enumerate() {
            if let Some(t) = n.as_deref().and_then(fonts::glyph_unicode) {
                map.insert(code as u32, t);
            }
        }
        extra.push((
            "ToUnicode",
            Object::Stream(flate_stream(
                Dictionary::new(),
                &fonts::write_tounicode(&map, 1),
            )),
        ));
    }
    Some((d, extra))
}

// ---------------------------------------------------------------- graphics states

fn gstate_pass(w: &mut Pdf, c: &mut Ctx) -> Result<(), PdfError> {
    if !c.profile.is_pdfa() {
        return Ok(());
    }
    let m = model::build(w);
    for k in m.extgstates.keys() {
        let Key::Obj(id) = k else { continue };
        let Some(mut gs) = w.get_dict(*id).cloned() else {
            continue;
        };
        let mut ch = false;
        if gs.remove(b"TR").is_some() {
            ch = true;
        }
        if gs.has(b"TR2") && get_name(w, &gs, b"TR2") != Some(b"Default") {
            gs.set("TR2", name("Default"));
            ch = true;
        }
        if let Some(n) = get_name(w, &gs, b"RI") {
            if !model::INTENTS.contains(&n) {
                gs.set("RI", name("RelativeColorimetric"));
                ch = true;
                c.did("fix-intent", "");
            }
        }
        if ch {
            w.set(*id, Object::Dictionary(gs));
            c.did("remove-transfer", "");
        }
    }
    // Direct graphics-state dictionaries inside resource dictionaries.
    edit_all(w, |pdf, _, o| {
        let d = match o {
            Object::Dictionary(d) => d,
            _ => return false,
        };
        let Some(Object::Dictionary(ext)) = d.get(b"ExtGState").ok().cloned() else {
            return false;
        };
        let mut ext = ext;
        let mut ch = false;
        for (_, v) in ext.iter_mut() {
            if let Object::Dictionary(gs) = v {
                if gs.remove(b"TR").is_some() {
                    ch = true;
                }
                if gs.has(b"TR2") && get_name(pdf, gs, b"TR2") != Some(b"Default") {
                    gs.set("TR2", name("Default"));
                    ch = true;
                }
                if get_name(pdf, gs, b"RI").is_some_and(|n| !model::INTENTS.contains(&n)) {
                    gs.set("RI", name("RelativeColorimetric"));
                    ch = true;
                }
            }
        }
        if ch {
            d.set("ExtGState", Object::Dictionary(ext));
        }
        ch
    })?;
    Ok(())
}

// ---------------------------------------------------------------- inline images

/// `/I true` / `/Interpolate true` inside inline images → `false` (content streams are rewritten).
fn inline_image_pass(w: &mut Pdf, c: &mut Ctx) -> Result<(), PdfError> {
    if !c.profile.is_pdfa() {
        return Ok(());
    }
    let ids = w.reachable()?;
    for id in ids {
        let Some(Object::Stream(s)) = w.get(id) else {
            continue;
        };
        if get_name(w, &s.dict, b"Subtype").is_some_and(|n| n != b"Form") || s.dict.has(b"Length1")
        {
            continue;
        }
        let Ok(data) = decode_stream(s, w.limits()) else {
            continue;
        };
        if crate::lexer::find(&data, b"BI", 0).is_none() {
            continue;
        }
        let mut patches: Vec<(usize, usize)> = Vec::new();
        let mut budget = w.limits().max_content_ops;
        crate::content::parse(&data, &mut budget, |op| {
            if let Some(img) = &op.inline {
                if matches!(
                    img.dict.get(b"I").or_else(|_| img.dict.get(b"Interpolate")),
                    Ok(Object::Boolean(true))
                ) {
                    let (a, b) = img.dict_range;
                    if let Some(seg) = data.get(a..b) {
                        let mut i = 0;
                        while let Some(p) = crate::lexer::find(seg, b"true", i) {
                            patches.push((a + p, a + p + 4));
                            i = p + 4;
                        }
                    }
                }
            }
            true
        });
        if patches.is_empty() {
            continue;
        }
        let mut out = Vec::with_capacity(data.len() + patches.len());
        let mut at = 0;
        for (a, b) in &patches {
            out.extend_from_slice(data.get(at..*a).unwrap_or_default());
            out.extend_from_slice(b"false");
            at = *b;
        }
        out.extend_from_slice(data.get(at..).unwrap_or_default());
        let st = flate_stream(s.dict.clone(), &out);
        w.set(id, Object::Stream(st));
        c.did("interpolate-off", "inline");
    }
    Ok(())
}

// ---------------------------------------------------------------- PDF/X-4 boxes

fn box_of(pdf: &Pdf, d: &Dictionary, key: &[u8]) -> Option<[f64; 4]> {
    let Some(Object::Array(a)) = get(pdf, d, key) else {
        return None;
    };
    let v: Vec<f64> = a
        .iter()
        .filter_map(|o| pdf.resolve(o).and_then(num))
        .collect();
    match v.as_slice() {
        [a, b, c, e] => Some([a.min(*c), b.min(*e), a.max(*c), b.max(*e)]),
        _ => None,
    }
}

fn clip(b: [f64; 4], to: [f64; 4]) -> [f64; 4] {
    [
        b[0].max(to[0]),
        b[1].max(to[1]),
        b[2].min(to[2]),
        b[3].min(to[3]),
    ]
}

fn box_obj(b: [f64; 4]) -> Object {
    Object::Array(b.iter().map(|v| Object::Real(*v as f32)).collect())
}

fn boxes_pass(w: &mut Pdf, c: &mut Ctx) -> Result<(), PdfError> {
    let pages = warraq_pdf::pages::flatten(w)?;
    for p in pages {
        let Some(mut d) = w.get_dict(p.id).cloned() else {
            continue;
        };
        let media = p.media_box;
        let crop = p.crop_box.map(|cb| clip(cb, media)).unwrap_or(media);
        let mut ch = false;
        if box_of(w, &d, b"TrimBox").is_some() && box_of(w, &d, b"ArtBox").is_some() {
            d.remove(b"ArtBox");
            ch = true;
        }
        if box_of(w, &d, b"TrimBox").is_none() && box_of(w, &d, b"ArtBox").is_none() {
            d.set("TrimBox", box_obj(crop));
            ch = true;
            c.did("add-trimbox", "");
        }
        let bleed = box_of(w, &d, b"BleedBox").map(|b| clip(b, media));
        if let Some(b) = bleed {
            d.set("BleedBox", box_obj(b));
            ch = true;
        }
        for key in ["TrimBox", "ArtBox"] {
            if let Some(b) = box_of(w, &d, key.as_bytes()) {
                let mut nb = clip(b, media);
                if let Some(bl) = bleed {
                    nb = clip(nb, bl);
                }
                if nb != b {
                    d.set(key, box_obj(nb));
                    ch = true;
                }
            }
        }
        if ch {
            w.set(p.id, Object::Dictionary(d));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------- metadata

fn uuid() -> String {
    let b: [u8; 16] = warraq_pdf::crypt::random_bytes().unwrap_or([7; 16]);
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "uuid:{}-{}-4{}-a{}-{}",
        h.get(0..8).unwrap_or(""),
        h.get(8..12).unwrap_or(""),
        h.get(13..16).unwrap_or(""),
        h.get(17..20).unwrap_or(""),
        h.get(20..32).unwrap_or("")
    )
}

fn metadata_pass(w: &mut Pdf, c: &mut Ctx, opts: &ConvertOptions) -> Result<(), PdfError> {
    let p = c.profile;
    let info = metadata::get_info(w);
    let old = metadata::get_xmp(w)
        .ok()
        .flatten()
        .and_then(|s| xmp::parse(s.as_bytes()).ok());
    let pick = |xv: Option<String>, ik: &str| -> Option<String> {
        xv.filter(|v| !v.is_empty())
            .or_else(|| info.get(ik).cloned().filter(|v| !v.is_empty()))
    };
    let xget = |ns: &str, l: &str| old.as_ref().and_then(|x| x.get(ns, l).map(str::to_string));
    let author_x = old
        .as_ref()
        .map(|x| x.all(xmp::NS_DC, "creator").join(", "))
        .filter(|s| !s.is_empty());
    let title = pick(xget(xmp::NS_DC, "title"), "Title");
    let author = pick(author_x, "Author");
    let subject = pick(xget(xmp::NS_DC, "description"), "Subject");
    let keywords = pick(xget(xmp::NS_PDF, "Keywords"), "Keywords");
    let creator = pick(xget(xmp::NS_XMP, "CreatorTool"), "Creator");
    let producer =
        pick(xget(xmp::NS_PDF, "Producer"), "Producer").or_else(|| Some("ZOOD PDF".to_string()));
    let date = |xl: &str, ik: &str| {
        xget(xmp::NS_XMP, xl)
            .and_then(|v| Date::parse_xmp(&v))
            .or_else(|| info.get(ik).and_then(|v| Date::parse_pdf(v)))
    };
    let created = date("CreateDate", "CreationDate").or(opts.now);
    let modified = opts
        .now
        .or_else(|| date("ModifyDate", "ModDate"))
        .or(created);
    let trapped = if p == Profile::X4 {
        let cur = w
            .trailer()
            .get(b"Info")
            .ok()
            .and_then(|i| dict(w, i))
            .and_then(|d| get_name(w, d, b"Trapped"))
            .map(<[u8]>::to_vec);
        Some(if cur.as_deref() == Some(b"True") {
            "True"
        } else {
            "False"
        })
    } else {
        None
    };
    let fields = xmp::Fields {
        title: title.clone(),
        author: author.clone(),
        subject: subject.clone(),
        keywords: keywords.clone(),
        creator_tool: creator.clone(),
        producer: producer.clone(),
        create_date: created,
        modify_date: modified,
        pdfa: p.part().zip(p.conformance()),
        pdfx: (p == Profile::X4).then_some("PDF/X-4"),
        trapped,
        document_id: xget(xmp::NS_XMPMM, "DocumentID").or_else(|| Some(uuid())),
        instance_id: Some(uuid()),
    };
    let packet = xmp::write(&fields);
    let mut sd = Dictionary::new();
    sd.set("Type", name("Metadata"));
    sd.set("Subtype", name("XML"));
    let mid = w.add(Object::Stream(Stream::new(sd, packet.into_bytes())));
    let root = w.root_id()?;
    let mut cat = w.catalog()?.clone();
    cat.set("Metadata", Object::Reference(mid));
    w.set(root, Object::Dictionary(cat));
    // Info mirrors XMP exactly.
    let mut d = Dictionary::new();
    let mut put = |k: &str, v: &Option<String>| {
        if let Some(v) = v {
            d.set(k, metadata::encode_text(v));
        }
    };
    put("Title", &title);
    put("Author", &author);
    put("Subject", &subject);
    put("Keywords", &keywords);
    put("Creator", &creator);
    put("Producer", &producer);
    if let Some(cd) = created {
        d.set(
            "CreationDate",
            Object::String(cd.to_pdf().into_bytes(), StringFormat::Literal),
        );
    }
    if let Some(md) = modified {
        d.set(
            "ModDate",
            Object::String(md.to_pdf().into_bytes(), StringFormat::Literal),
        );
    }
    if let Some(t) = trapped {
        d.set("Trapped", name(t));
    }
    let iid = w.add(Object::Dictionary(d));
    w.set_trailer("Info", Object::Reference(iid));
    c.did("write-metadata", p.label());
    Ok(())
}
