//! PDF/A (ISO 19005): a copy of the file made for archiving, and a
//! validator for the rules Warraq implements.
//!
//! Levels: PDF/A-2b and PDF/A-2u (ISO 19005-2), PDF/A-3b (ISO 19005-3: any
//! file may be attached, with its relationship said), and PDF/A-1b
//! (ISO 19005-1), for files with no transparency, no layers and no JPEG
//! 2000, which PDF 1.4 cannot carry.
//!
//! What conversion does, in order: decrypts (PDF/A forbids encryption);
//! takes out scripts, automatic actions, forbidden action types and XFA;
//! embeds every font the file does not carry, with a bundled face in its
//! place (and says which); gives each font a ToUnicode where its own program
//! can say what its glyphs are (for -u); adds an sRGB output intent (or
//! keeps the file's own), and makes device colours the intent does not cover
//! device-independent with a default colour space; re-encodes LZW as Flate;
//! draws an appearance for annotations that lack one and sets them to print;
//! drops embedded files a level does not allow; writes XMP metadata with
//! the PDF/A identification, in step with the document information; and
//! writes the whole file anew, with nothing of its earlier revisions. The
//! copy is then read back and validated, and the result is part of the
//! report.
use std::collections::{BTreeMap, BTreeSet};

use lopdf::{dictionary, Dictionary, Document, Object, ObjectId, Stream};
use skrifa::raw::TableProvider;

use super::fonts::{self, Face, Program};
use super::scan::{all_colours, Scan, ScanOptions};
use super::{dict_of, icc, md5_hex, name, resolve, visit_arrays_mut, visit_dicts_mut, xmp};
use super::{Finding, Findings};
use crate::document::decode_text_string;
use crate::{Error, PdfDocument, Result};

/// A PDF/A level.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    A1b,
    A2b,
    A2u,
    A3b,
}

impl Level {
    pub fn parse(s: &str) -> Option<Level> {
        match s {
            "1b" => Some(Level::A1b),
            "2b" => Some(Level::A2b),
            "2u" => Some(Level::A2u),
            "3b" => Some(Level::A3b),
            _ => None,
        }
    }

    pub fn key(self) -> &'static str {
        match self {
            Level::A1b => "1b",
            Level::A2b => "2b",
            Level::A2u => "2u",
            Level::A3b => "3b",
        }
    }

    pub fn part(self) -> u8 {
        match self {
            Level::A1b => 1,
            Level::A2b | Level::A2u => 2,
            Level::A3b => 3,
        }
    }

    pub fn conformance(self) -> &'static str {
        match self {
            Level::A2u => "U",
            _ => "B",
        }
    }

    fn unicode(self) -> bool {
        self == Level::A2u
    }

    fn one(self) -> bool {
        self == Level::A1b
    }
}

/// Every rule the validator checks: its key, its clause in ISO 19005-2
/// (and -3, which numbers them the same), and in ISO 19005-1.
pub const RULES: &[(&str, &str, &str)] = &[
    ("header", "6.1.2", "6.1.2"),
    ("trailerId", "6.1.3", "6.1.3"),
    ("encrypted", "6.1.3", "6.1.3"),
    ("afterEof", "6.1.3", "6.1.3"),
    ("crossReferenceStream", "-", "6.1.4"),
    ("externalStream", "6.1.7.1", "6.1.7"),
    ("forbiddenFilter", "6.1.7.2", "6.1.10"),
    ("limits", "6.1.13", "6.1.12"),
    ("outputIntent", "6.2.3", "6.2.2"),
    ("deviceColour", "6.2.4.3", "6.2.3.3"),
    ("iccProfile", "6.2.4.2", "6.2.3.2"),
    ("overprint", "6.2.4.2", "-"),
    ("transparency", "6.2.10", "6.4"),
    ("blendMode", "6.2.10", "6.4"),
    ("transferFunction", "6.2.5", "6.2.8"),
    ("halftone", "6.2.5", "6.2.8"),
    ("renderingIntent", "6.2.5", "6.2.9"),
    ("imageAlternates", "6.2.8", "6.2.4"),
    ("opi", "6.2.8", "6.2.4"),
    ("interpolate", "6.2.8", "6.2.4"),
    ("bitsPerComponent", "6.2.8", "6.2.4"),
    ("referenceXObject", "6.2.9", "6.2.6"),
    ("postscript", "6.2.9", "6.2.7"),
    ("unknownOperator", "6.2.2", "6.2.10"),
    ("unreadableContent", "6.2.2", "6.2.10"),
    ("fontNotEmbedded", "6.2.11.4.1", "6.3.4"),
    ("glyphMissing", "6.2.11.4.1", "6.3.5"),
    ("cidSet", "6.2.11.4.2", "6.3.5"),
    ("widthMismatch", "6.2.11.5", "6.3.6"),
    ("trueTypeEncoding", "6.2.11.6", "6.3.7"),
    ("cidToGidMap", "6.2.11.3.2", "6.3.3.2"),
    ("noUnicode", "6.2.11.7.2", "-"),
    ("annotationType", "6.3.1", "6.5.2"),
    ("annotationFlags", "6.3.2", "6.5.3"),
    ("annotationAppearance", "6.3.3", "6.5.3"),
    ("annotationOpacity", "-", "6.5.3"),
    ("action", "6.5.1", "6.6.1"),
    ("namedAction", "6.5.1", "6.6.1"),
    ("additionalActions", "6.5.2", "6.6.2"),
    ("javascript", "6.5.1", "6.6.1"),
    ("needAppearances", "6.4.1", "6.9"),
    ("xfa", "6.4.2", "-"),
    ("metadataMissing", "6.6.2.1", "6.7.2"),
    ("metadataFiltered", "6.6.2.1", "6.7.2"),
    ("pdfaIdentification", "6.6.4", "6.7.11"),
    ("metadataMismatch", "6.6.2.3", "6.7.3"),
    ("embeddedFile", "6.8", "6.1.11"),
    ("associatedFile", "6.8", "-"),
    ("optionalContent", "6.9", "6.1.13"),
    ("alternatePresentations", "6.10", "-"),
    ("presSteps", "6.10", "-"),
    ("permissions", "6.1.12", "-"),
];

/// The clause of `rule` at `level`.
pub fn clause(rule: &str, level: Level) -> &'static str {
    RULES
        .iter()
        .find(|(key, _, _)| *key == rule)
        .map(|(_, two, one)| if level.one() { *one } else { *two })
        .unwrap_or("-")
}

const FORBIDDEN_ACTIONS: &[&[u8]] = &[
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
    b"JavaScript",
    b"SetState",
    b"NOP",
];

const ACTION_TYPES: &[&[u8]] = &[
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
    b"NOP",
];

const NAMED_ALLOWED: &[&[u8]] = &[b"NextPage", b"PrevPage", b"FirstPage", b"LastPage"];

const STANDARD_BLEND: &[&str] = &[
    "Normal",
    "Compatible",
    "Multiply",
    "Screen",
    "Overlay",
    "Darken",
    "Lighten",
    "ColorDodge",
    "ColorBurn",
    "HardLight",
    "SoftLight",
    "Difference",
    "Exclusion",
    "Hue",
    "Saturation",
    "Color",
    "Luminosity",
];

const INTENTS: &[&str] = &[
    "RelativeColorimetric",
    "AbsoluteColorimetric",
    "Perceptual",
    "Saturation",
];

/// Annotation types PDF/A-1 allows (ISO 19005-1 §6.5.2).
const A1_ANNOTATIONS: &[&[u8]] = &[
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

/// Annotation types ISO 32000-1 defines.
const KNOWN_ANNOTATIONS: &[&[u8]] = &[
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
    b"Sound",
    b"Movie",
    b"Widget",
    b"Screen",
    b"PrinterMark",
    b"TrapNet",
    b"Watermark",
    b"3D",
    b"Redact",
];

/// The output intent a validator reads: its profile and what it describes.
struct Intent {
    profile: ObjectId,
    info: icc::IccInfo,
}

fn pdfa_intent(doc: &Document) -> (Option<Intent>, Vec<ObjectId>, bool) {
    let Ok(catalog) = doc.catalog() else {
        return (None, vec![], false);
    };
    let intents = catalog
        .get(b"OutputIntents")
        .ok()
        .map(|o| resolve(doc, o))
        .and_then(|o| o.as_array().ok())
        .cloned()
        .unwrap_or_default();
    let mut profiles = vec![];
    let mut found = None;
    let mut present = false;
    for intent in &intents {
        let Some(d) = dict_of(doc, Some(intent)) else {
            continue;
        };
        let profile = d
            .get(b"DestOutputProfile")
            .ok()
            .and_then(|p| p.as_reference().ok());
        if let Some(p) = profile {
            profiles.push(p);
        }
        if name(d.get(b"S").ok()) == Some(b"GTS_PDFA1") {
            present = true;
            if let Some(p) = profile {
                let bytes = doc
                    .get_object(p)
                    .ok()
                    .and_then(|o| o.as_stream().ok())
                    .and_then(|s| {
                        s.decompressed_content_with_limit(8 << 20)
                            .ok()
                            .or_else(|| (!s.dict.has(b"Filter")).then(|| s.content.clone()))
                    });
                if let Some(info) = bytes.as_deref().and_then(icc::read) {
                    found = Some(Intent { profile: p, info });
                }
            }
        }
    }
    (found, profiles, present)
}

fn text_of(o: Option<&Object>) -> Option<String> {
    o.and_then(|o| o.as_str().ok()).map(decode_text_string)
}

/// A page's index by its object, for findings on annotations.
fn page_of(doc: &PdfDocument) -> BTreeMap<ObjectId, usize> {
    doc.pages
        .iter()
        .enumerate()
        .map(|(i, id)| (*id, i))
        .collect()
}

impl PdfDocument {
    /// Validates this file against `level`: see `RULES` for what is checked.
    pub fn pdfa_validate(&self, level: Level) -> Findings {
        let scan = self.scan_content(ScanOptions::default());
        validate(self, level, &scan)
    }
}

fn validate(pdf: &PdfDocument, level: Level, scan: &Scan) -> Findings {
    let doc = &pdf.doc;
    let bytes = pdf.original_bytes();
    let mut out = Findings::default();
    let c = |rule: &'static str| clause(rule, level);
    let mut fail =
        |rule: &'static str, detail: String, page: Option<usize>, object: Option<ObjectId>| {
            out.push(Finding {
                clause: c(rule),
                rule,
                detail,
                page,
                object,
            });
        };

    // File structure.
    let header_ok = bytes.starts_with(b"%PDF-1.")
        && bytes.get(7).is_some_and(|d| (b'0'..=b'7').contains(d))
        && {
            let first_eol = bytes.iter().position(|b| *b == b'\n' || *b == b'\r');
            first_eol.is_some_and(|at| {
                let mut i = at;
                while bytes.get(i).is_some_and(|b| *b == b'\n' || *b == b'\r') {
                    i += 1;
                }
                bytes.get(i) == Some(&b'%')
                    && bytes
                        .get(i + 1..i + 5)
                        .is_some_and(|w| w.iter().all(|b| *b >= 128))
            })
        };
    if !header_ok {
        fail("header", String::new(), None, None);
    }
    if !doc.trailer.has(b"ID") {
        fail("trailerId", String::new(), None, None);
    }
    if pdf.was_encrypted() || doc.trailer.has(b"Encrypt") {
        fail("encrypted", String::new(), None, None);
    }
    if let Some(at) = bytes.windows(5).rposition(|w| w == b"%%EOF") {
        let tail = &bytes[at + 5..];
        if tail.len() > 2 || tail.iter().any(|b| *b != b'\n' && *b != b'\r') {
            fail("afterEof", format!("{} bytes", tail.len()), None, None);
        }
    }
    if level.one()
        && (bytes.windows(7).any(|w| w == b"/ObjStm")
            || bytes
                .windows(10)
                .any(|w| w == b"/Type/XRef" || w == b"/Type /XRe"))
    {
        fail("crossReferenceStream", String::new(), None, None);
    }

    // Objects: streams, limits, actions.
    if doc.objects.len() > 8_388_607 {
        fail("limits", "objects".into(), None, None);
    }
    for (id, object) in &doc.objects {
        if let Object::Stream(s) = object {
            for key in [b"F".as_slice(), b"FFilter", b"FDecodeParms"] {
                if s.dict.has(key) {
                    fail(
                        "externalStream",
                        String::from_utf8_lossy(key).into_owned(),
                        None,
                        Some(*id),
                    );
                }
            }
            let filters: Vec<Vec<u8>> = match s.dict.get(b"Filter").map(|f| resolve(doc, f)) {
                Ok(Object::Name(n)) => vec![n.clone()],
                Ok(Object::Array(a)) => a
                    .iter()
                    .filter_map(|n| n.as_name().ok().map(<[u8]>::to_vec))
                    .collect(),
                _ => vec![],
            };
            for f in &filters {
                if f == b"LZWDecode" || f == b"Crypt" || (level.one() && f == b"JPXDecode") {
                    fail(
                        "forbiddenFilter",
                        String::from_utf8_lossy(f).into_owned(),
                        None,
                        Some(*id),
                    );
                }
            }
        }
        check_limits(
            object,
            level,
            &mut |detail| fail("limits", detail, None, Some(*id)),
            0,
        );
    }
    let pages = page_of(pdf);
    for (id, object) in &doc.objects {
        let dict = match object {
            Object::Dictionary(d) => d,
            Object::Stream(s) => &s.dict,
            _ => continue,
        };
        visit_action(doc, dict, 0, &mut |action| {
            let s = name(action.get(b"S").ok()).unwrap_or(b"");
            if FORBIDDEN_ACTIONS.contains(&s) {
                let rule = if s == b"JavaScript" {
                    "javascript"
                } else {
                    "action"
                };
                fail(
                    rule,
                    String::from_utf8_lossy(s).into_owned(),
                    None,
                    Some(*id),
                );
            } else if s == b"Named" {
                let n = name(action.get(b"N").ok()).unwrap_or(b"");
                if !NAMED_ALLOWED.contains(&n) {
                    fail(
                        "namedAction",
                        String::from_utf8_lossy(n).into_owned(),
                        None,
                        Some(*id),
                    );
                }
            }
        });
        if dict.has(b"AA") {
            let kind = if dict.has_type(b"Catalog") {
                "catalog".to_string()
            } else if dict.has_type(b"Page") {
                "page".to_string()
            } else {
                name(dict.get(b"Subtype").ok())
                    .or_else(|| name(dict.get(b"FT").ok()))
                    .map(|n| String::from_utf8_lossy(n).into_owned())
                    .unwrap_or_default()
            };
            fail("additionalActions", kind, pages.get(id).copied(), Some(*id));
        }
        if dict.has_type(b"Page") && dict.has(b"PresSteps") && !level.one() {
            fail(
                "presSteps",
                String::new(),
                pages.get(id).copied(),
                Some(*id),
            );
        }
    }

    // Catalog.
    if let Ok(catalog) = doc.catalog() {
        if let Some(names) = dict_of(doc, catalog.get(b"Names").ok()) {
            if names.has(b"JavaScript") {
                fail("javascript", "Names".into(), None, None);
            }
            if names.has(b"AlternatePresentations") && !level.one() {
                fail("alternatePresentations", String::new(), None, None);
            }
            if names.has(b"EmbeddedFiles") {
                check_embedded_files(pdf, level, &mut fail);
            }
        }
        if let Some(form) = dict_of(doc, catalog.get(b"AcroForm").ok()) {
            if form
                .get(b"NeedAppearances")
                .ok()
                .and_then(|v| v.as_bool().ok())
                == Some(true)
            {
                fail("needAppearances", String::new(), None, None);
            }
            if form.has(b"XFA") && !level.one() {
                fail("xfa", String::new(), None, None);
            }
        }
        if catalog
            .get(b"NeedsRendering")
            .ok()
            .and_then(|v| v.as_bool().ok())
            == Some(true)
        {
            fail("xfa", "NeedsRendering".into(), None, None);
        }
        if let Some(perms) = dict_of(doc, catalog.get(b"Perms").ok()) {
            for (key, _) in perms.iter() {
                if key != b"UR3" && key != b"DocMDP" && !level.one() {
                    fail(
                        "permissions",
                        String::from_utf8_lossy(key).into_owned(),
                        None,
                        None,
                    );
                }
            }
        }
        if let Some(oc) = dict_of(doc, catalog.get(b"OCProperties").ok()) {
            if level.one() {
                fail("optionalContent", String::new(), None, None);
            } else {
                check_optional_content(doc, oc, &mut fail);
            }
        }
        check_metadata(pdf, level, catalog, &mut fail);
    }

    // Colour.
    let (intent, profiles, present) = pdfa_intent(doc);
    if profiles.len() > 1 && profiles.iter().any(|p| *p != profiles[0]) {
        fail("outputIntent", "several profiles".into(), None, None);
    }
    match &intent {
        Some(i) => {
            if !matches!(i.info.class.as_str(), "mntr" | "prtr") {
                fail(
                    "outputIntent",
                    format!("class {}", i.info.class),
                    None,
                    Some(i.profile),
                );
            }
            if level.one() && i.info.major > 2 {
                fail(
                    "outputIntent",
                    format!("ICC v{}", i.info.major),
                    None,
                    Some(i.profile),
                );
            }
            let n = doc
                .get_object(i.profile)
                .ok()
                .and_then(|o| o.as_stream().ok())
                .and_then(|s| s.dict.get(b"N").ok())
                .and_then(|n| n.as_i64().ok());
            if n != Some(i.info.components) {
                fail("outputIntent", "N".into(), None, Some(i.profile));
            }
        }
        None if present => fail("outputIntent", "profile".into(), None, None),
        None => {}
    }
    let intent_space = intent.as_ref().map(|i| i.info.space.clone());
    for (page, p) in scan.pages.iter().enumerate() {
        let c = &p.colours;
        if c.bare_rgb && intent_space.as_deref() != Some("RGB ") {
            fail("deviceColour", "DeviceRGB".into(), Some(page), None);
        }
        if c.bare_cmyk && intent_space.as_deref() != Some("CMYK") {
            fail("deviceColour", "DeviceCMYK".into(), Some(page), None);
        }
        if c.bare_gray && intent_space.is_none() {
            fail("deviceColour", "DeviceGray".into(), Some(page), None);
        }
        if p.overprint_mode_1 && (c.cmyk && !c.bare_cmyk) {
            fail("overprint", "OPM 1".into(), Some(page), None);
        }
        if level.one() {
            for kind in &p.transparency {
                fail("transparency", (*kind).to_string(), Some(page), None);
            }
        } else {
            for mode in &p.blend_modes {
                if !STANDARD_BLEND.contains(&mode.as_str()) {
                    fail("blendMode", mode.clone(), Some(page), None);
                }
            }
        }
        if p.transfer {
            fail("transferFunction", String::new(), Some(page), None);
        }
        if p.halftone_bad {
            fail("halftone", String::new(), Some(page), None);
        }
        for intent in &p.intents {
            if !INTENTS.contains(&intent.as_str()) {
                fail("renderingIntent", intent.clone(), Some(page), None);
            }
        }
        if p.reference_xobject {
            fail("referenceXObject", String::new(), Some(page), None);
        }
        if p.postscript {
            fail("postscript", String::new(), Some(page), None);
        }
        for op in &p.unknown_ops {
            fail("unknownOperator", op.clone(), Some(page), None);
        }
        if p.unreadable {
            fail("unreadableContent", String::new(), Some(page), None);
        }
        if p.max_saves > 28 {
            fail(
                "limits",
                format!("q nesting {}", p.max_saves),
                Some(page),
                None,
            );
        }
        let spots = c.device_n.len();
        if spots > if level.one() { 8 } else { 32 } {
            fail("limits", format!("{spots} colourants"), Some(page), None);
        }
    }
    let colours = all_colours(scan);
    for id in &colours.icc {
        let Some(stream) = doc.get_object(*id).ok().and_then(|o| o.as_stream().ok()) else {
            fail("iccProfile", String::new(), None, Some(*id));
            continue;
        };
        let bytes = stream
            .decompressed_content_with_limit(8 << 20)
            .ok()
            .or_else(|| (!stream.dict.has(b"Filter")).then(|| stream.content.clone()));
        match bytes.as_deref().and_then(icc::read) {
            None => fail("iccProfile", "not a profile".into(), None, Some(*id)),
            Some(info) => {
                let n = stream.dict.get(b"N").ok().and_then(|n| n.as_i64().ok());
                if n != Some(info.components) {
                    fail("iccProfile", "N".into(), None, Some(*id));
                }
                if (level.one() && info.major > 2) || info.major > 4 {
                    fail(
                        "iccProfile",
                        format!("ICC v{}", info.major),
                        None,
                        Some(*id),
                    );
                }
            }
        }
    }
    for image in &scan.images {
        if image.alternates {
            fail("imageAlternates", String::new(), Some(image.page), image.id);
        }
        if image.opi {
            fail("opi", String::new(), Some(image.page), image.id);
        }
        if image.interpolate {
            fail("interpolate", String::new(), Some(image.page), image.id);
        }
        let jpx = image.filters.iter().any(|f| f == "JPXDecode");
        if !jpx && !image.mask && !matches!(image.bits, 1 | 2 | 4 | 8 | 16) {
            fail(
                "bitsPerComponent",
                image.bits.to_string(),
                Some(image.page),
                image.id,
            );
        }
        if level.one() && image.bits == 16 {
            fail("bitsPerComponent", "16".into(), Some(image.page), image.id);
        }
    }

    // Fonts.
    for font in &scan.fonts {
        let facts = fonts::facts(doc, &font.dict);
        let page = font.pages.iter().next().copied();
        let label = if facts.base_font.is_empty() {
            facts.subtype.clone()
        } else {
            facts.base_font.clone()
        };
        if !facts.embedded() {
            if font.visible {
                fail("fontNotEmbedded", label.clone(), page, font.id);
            }
            continue;
        }
        if facts.cid_subtype.as_deref() == Some("CIDFontType2") {
            let map_ok = doc_descendant(doc, &font.dict).is_some_and(|d| {
                match d.get(b"CIDToGIDMap").map(|m| resolve(doc, m)) {
                    Ok(Object::Name(n)) => n == b"Identity",
                    Ok(Object::Stream(_)) => true,
                    _ => false,
                }
            });
            if !map_ok {
                fail("cidToGidMap", label.clone(), page, font.id);
            }
        }
        if let Some((Program::TrueType, program_id)) = facts.program {
            let program = doc
                .get_object(program_id)
                .ok()
                .and_then(|o| o.as_stream().ok())
                .and_then(|s| {
                    s.decompressed_content_with_limit(32 << 20)
                        .ok()
                        .or_else(|| (!s.dict.has(b"Filter")).then(|| s.content.clone()))
                });
            if let Some(program) = program {
                let mut missing = 0;
                let mut wrong_width = None;
                for code in &font.codes {
                    match fonts::truetype_glyph(doc, &font.dict, &facts, &program, *code) {
                        None => missing += 1,
                        Some(gid) => {
                            if wrong_width.is_none() {
                                if let (Some(dict_w), Some(prog_w)) = (
                                    fonts::dictionary_width(doc, &font.dict, &facts, *code),
                                    fonts::glyph_width(&program, gid),
                                ) {
                                    if (dict_w - prog_w).abs() > 1.0 && dict_w != 0.0 {
                                        wrong_width = Some((*code, dict_w, prog_w));
                                    }
                                }
                            }
                        }
                    }
                }
                if missing > 0 {
                    fail("glyphMissing", format!("{label}: {missing}"), page, font.id);
                }
                if let Some((code, a, b)) = wrong_width {
                    fail(
                        "widthMismatch",
                        format!("{label}: code {code}, {a} ≠ {b}"),
                        page,
                        font.id,
                    );
                }
                if facts.subtype == "TrueType" {
                    check_truetype_encoding(
                        doc, &font.dict, &facts, &program, &label, page, font.id, &mut fail,
                    );
                }
                if facts.subtype == "Type0" {
                    if let Some(desc) = facts.descriptor.and_then(|d| doc.get_dictionary(d).ok()) {
                        let set = desc.get(b"CIDSet").ok().map(|s| resolve(doc, s));
                        match set {
                            Some(Object::Stream(s)) => {
                                if !cid_set_complete(s, &program) {
                                    fail("cidSet", label.clone(), page, font.id);
                                }
                            }
                            _ if level.one() && label.get(6..7) == Some("+") => {
                                fail("cidSet", label.clone(), page, font.id);
                            }
                            _ => {}
                        }
                    }
                }
            }
        }
        if level.unicode() {
            let unmapped = fonts::unmapped_codes(doc, font, &facts);
            if !unmapped.is_empty() {
                fail(
                    "noUnicode",
                    format!("{label}: {}", unmapped.len()),
                    page,
                    font.id,
                );
            }
        }
    }

    // Annotations.
    for (index, page_id) in pdf.pages.iter().enumerate() {
        for (annot_id, annot) in pdf.page_annotations(*page_id) {
            let subtype = name(annot.get(b"Subtype").ok()).unwrap_or(b"");
            let label = String::from_utf8_lossy(subtype).into_owned();
            let allowed = if level.one() {
                A1_ANNOTATIONS.contains(&subtype)
            } else {
                KNOWN_ANNOTATIONS.contains(&subtype)
                    && !matches!(subtype, b"3D" | b"Sound" | b"Screen" | b"Movie")
            };
            if !allowed {
                fail("annotationType", label.clone(), Some(index), annot_id);
                continue;
            }
            if subtype != b"Popup" {
                match annot.get(b"F").ok().and_then(|f| f.as_i64().ok()) {
                    None => fail("annotationFlags", label.clone(), Some(index), annot_id),
                    Some(f) if f & 4 == 0 || f & (1 | 2 | 32 | 256) != 0 => {
                        fail("annotationFlags", label.clone(), Some(index), annot_id)
                    }
                    _ => {}
                }
            }
            let rect = pdf.rect(annot.get(b"Rect").ok());
            let zero = rect.is_some_and(|r| r[2] - r[0] <= 0.0 || r[3] - r[1] <= 0.0);
            let ap = dict_of(doc, annot.get(b"AP").ok());
            if !matches!(subtype, b"Popup" | b"Link") && !zero {
                match ap {
                    None => fail("annotationAppearance", label.clone(), Some(index), annot_id),
                    Some(ap) => {
                        if ap.iter().any(|(k, _)| k != b"N") {
                            fail(
                                "annotationAppearance",
                                format!("{label}: D/R"),
                                Some(index),
                                annot_id,
                            );
                        }
                        let n = ap.get(b"N").ok().map(|n| resolve(doc, n));
                        let is_btn =
                            subtype == b"Widget" && field_type(doc, annot) == Some(b"Btn".to_vec());
                        match n {
                            None => {
                                fail("annotationAppearance", label.clone(), Some(index), annot_id)
                            }
                            Some(Object::Stream(_)) if is_btn => fail(
                                "annotationAppearance",
                                format!("{label}: Btn"),
                                Some(index),
                                annot_id,
                            ),
                            _ => {}
                        }
                    }
                }
            }
            if subtype == b"Widget" && (annot.has(b"A") || annot.has(b"AA")) && !level.one() {
                fail("action", "Widget".into(), Some(index), annot_id);
            }
            if level.one()
                && annot
                    .get(b"CA")
                    .ok()
                    .and_then(|v| v.as_float().ok())
                    .is_some_and(|v| v < 1.0)
            {
                fail("annotationOpacity", label.clone(), Some(index), annot_id);
            }
        }
        if let Ok(page) = doc.get_dictionary(*page_id) {
            let media = pdf.rect(pdf.inherited(page, b"MediaBox"));
            if let Some(m) = media {
                let (w, h) = (m[2] - m[0], m[3] - m[1]);
                if !(3.0..=14400.0).contains(&w) || !(3.0..=14400.0).contains(&h) {
                    fail(
                        "limits",
                        format!("page {w} × {h}"),
                        Some(index),
                        Some(*page_id),
                    );
                }
            }
        }
    }
    if scan.truncated {
        fail(
            "unreadableContent",
            "too large to read whole".into(),
            None,
            None,
        );
    }
    out
}

fn doc_descendant<'a>(doc: &'a Document, font: &'a Dictionary) -> Option<&'a Dictionary> {
    let kids = resolve(doc, font.get(b"DescendantFonts").ok()?)
        .as_array()
        .ok()?;
    dict_of(doc, kids.first())
}

fn field_type(doc: &Document, annot: &Dictionary) -> Option<Vec<u8>> {
    let mut d = annot;
    for _ in 0..32 {
        if let Some(ft) = name(d.get(b"FT").ok()) {
            return Some(ft.to_vec());
        }
        d = dict_of(doc, d.get(b"Parent").ok())?;
    }
    None
}

/// Whether a CIDSet names every glyph the program has.
fn cid_set_complete(set: &Stream, program: &[u8]) -> bool {
    let bits = set
        .decompressed_content_with_limit(1 << 20)
        .unwrap_or_else(|_| set.content.clone());
    let Ok(face) = skrifa::FontRef::new(program) else {
        return false;
    };
    let Ok(maxp) = face.maxp() else {
        return false;
    };
    let glyphs = maxp.num_glyphs() as usize;
    (0..glyphs).all(|g| bits.get(g / 8).is_some_and(|b| b & (0x80 >> (g % 8)) != 0))
}

#[allow(clippy::too_many_arguments)]
fn check_truetype_encoding(
    doc: &Document,
    font: &Dictionary,
    facts: &fonts::FontFacts,
    program: &[u8],
    label: &str,
    page: Option<usize>,
    id: Option<ObjectId>,
    fail: &mut dyn FnMut(&'static str, String, Option<usize>, Option<ObjectId>),
) {
    let Ok(face) = skrifa::FontRef::new(program) else {
        return;
    };
    let records: Vec<(u16, u16)> = face
        .cmap()
        .map(|c| {
            c.encoding_records()
                .iter()
                .map(|r| (r.platform_id() as u16, r.encoding_id()))
                .collect()
        })
        .unwrap_or_default();
    if facts.symbolic {
        if font.has(b"Encoding") {
            fail("trueTypeEncoding", format!("{label}: Encoding"), page, id);
        }
        if records.len() != 1 && !records.contains(&(3, 0)) {
            fail("trueTypeEncoding", format!("{label}: cmap"), page, id);
        }
    } else {
        let base_ok = |n: &[u8]| n == b"WinAnsiEncoding" || n == b"MacRomanEncoding";
        let ok = match font.get(b"Encoding").map(|e| resolve(doc, e)) {
            Ok(Object::Name(n)) => base_ok(n),
            Ok(Object::Dictionary(d)) => {
                name(d.get(b"BaseEncoding").ok()).is_some_and(base_ok)
                    && (!d.has(b"Differences") || records.contains(&(3, 1)))
            }
            _ => false,
        };
        if !ok {
            fail("trueTypeEncoding", format!("{label}: Encoding"), page, id);
        }
        if !records.contains(&(3, 1)) && !records.contains(&(1, 0)) {
            fail("trueTypeEncoding", format!("{label}: cmap"), page, id);
        }
    }
}

fn check_limits(object: &Object, level: Level, fail: &mut dyn FnMut(String), depth: usize) {
    if depth > 32 {
        return;
    }
    match object {
        Object::Integer(i) if *i > i64::from(i32::MAX) || *i < i64::from(i32::MIN) => {
            fail(format!("integer {i}"))
        }
        Object::Real(r) if level.one() && r.abs() > 32767.0 => fail(format!("real {r}")),
        Object::String(s, _) if s.len() > 32767 => fail(format!("string of {} bytes", s.len())),
        Object::Name(n) if n.len() > 127 => fail(format!("name of {} bytes", n.len())),
        Object::Array(a) => {
            if level.one() && a.len() > 8191 {
                fail(format!("array of {}", a.len()));
            }
            a.iter()
                .for_each(|o| check_limits(o, level, fail, depth + 1));
        }
        Object::Dictionary(d) => {
            if level.one() && d.len() > 4095 {
                fail(format!("dictionary of {}", d.len()));
            }
            d.iter().for_each(|(k, o)| {
                if k.len() > 127 {
                    fail(format!("name of {} bytes", k.len()));
                }
                check_limits(o, level, fail, depth + 1)
            });
        }
        Object::Stream(s) => s
            .dict
            .iter()
            .for_each(|(_, o)| check_limits(o, level, fail, depth + 1)),
        _ => {}
    }
}

/// Calls `f` on every action dictionary in `dict`: `/A`, `/OpenAction`,
/// the actions an `/AA` holds, and each `/Next` in a chain.
fn visit_action(doc: &Document, dict: &Dictionary, depth: usize, f: &mut dyn FnMut(&Dictionary)) {
    if depth > 16 {
        return;
    }
    if name(dict.get(b"S").ok()).is_some_and(|s| ACTION_TYPES.contains(&s))
        && (dict.has_type(b"Action") || !dict.has(b"Type"))
        && (dict.has(b"Type") || depth > 0)
    {
        f(dict);
    }
    for key in [b"A".as_slice(), b"OpenAction", b"Next"] {
        match dict.get(key).map(|o| resolve(doc, o)) {
            Ok(Object::Dictionary(d)) => visit_action(doc, d, depth + 1, f),
            Ok(Object::Array(a)) if key == b"Next" => {
                for item in a {
                    if let Some(d) = dict_of(doc, Some(item)) {
                        visit_action(doc, d, depth + 1, f);
                    }
                }
            }
            _ => {}
        }
    }
    if let Some(aa) = dict_of(doc, dict.get(b"AA").ok()) {
        for (_, action) in aa.iter() {
            if let Some(d) = dict_of(doc, Some(action)) {
                visit_action(doc, d, depth + 1, f);
            }
        }
    }
}

fn check_optional_content(
    doc: &Document,
    oc: &Dictionary,
    fail: &mut dyn FnMut(&'static str, String, Option<usize>, Option<ObjectId>),
) {
    let groups: Vec<ObjectId> = oc
        .get(b"OCGs")
        .ok()
        .map(|o| resolve(doc, o))
        .and_then(|o| o.as_array().ok())
        .map(|a| a.iter().filter_map(|g| g.as_reference().ok()).collect())
        .unwrap_or_default();
    for g in &groups {
        if doc.get_dictionary(*g).ok().is_some_and(|d| !d.has(b"Name")) {
            fail("optionalContent", "OCG Name".into(), None, Some(*g));
        }
    }
    let mut configs: Vec<&Dictionary> = dict_of(doc, oc.get(b"D").ok()).into_iter().collect();
    if let Ok(list) = oc.get(b"Configs").map(|c| resolve(doc, c)) {
        if let Ok(list) = list.as_array() {
            configs.extend(list.iter().filter_map(|c| dict_of(doc, Some(c))));
        }
    }
    let mut names = BTreeSet::new();
    for config in configs {
        match text_of(config.get(b"Name").ok()) {
            None => fail("optionalContent", "configuration Name".into(), None, None),
            Some(n) => {
                if !names.insert(n.clone()) {
                    fail("optionalContent", format!("{n} twice"), None, None);
                }
            }
        }
        if config.has(b"AS") {
            fail("optionalContent", "AS".into(), None, None);
        }
        if let Some(order) = config.get(b"Order").ok().map(|o| resolve(doc, o)) {
            let mut listed = BTreeSet::new();
            collect_refs(doc, order, &mut listed, 0);
            if groups.iter().any(|g| !listed.contains(g)) {
                fail("optionalContent", "Order".into(), None, None);
            }
        }
    }
}

fn collect_refs(doc: &Document, o: &Object, out: &mut BTreeSet<ObjectId>, depth: usize) {
    if depth > 16 {
        return;
    }
    match o {
        Object::Reference(id) => {
            out.insert(*id);
            if let Ok(Object::Array(a)) = doc.get_object(*id) {
                for x in a {
                    collect_refs(doc, x, out, depth + 1);
                }
            }
        }
        Object::Array(a) => a.iter().for_each(|x| collect_refs(doc, x, out, depth + 1)),
        _ => {}
    }
}

fn check_metadata(
    pdf: &PdfDocument,
    level: Level,
    catalog: &Dictionary,
    fail: &mut dyn FnMut(&'static str, String, Option<usize>, Option<ObjectId>),
) {
    let doc = &pdf.doc;
    let Some(stream) = catalog
        .get(b"Metadata")
        .ok()
        .map(|m| resolve(doc, m))
        .and_then(|m| m.as_stream().ok())
    else {
        fail("metadataMissing", String::new(), None, None);
        return;
    };
    if stream.dict.has(b"Filter") {
        fail("metadataFiltered", String::new(), None, None);
    }
    let bytes = stream
        .decompressed_content_with_limit(8 << 20)
        .unwrap_or_else(|_| stream.content.clone());
    let packet = String::from_utf8_lossy(&bytes).into_owned();
    let part = xmp::read_property(&packet, "pdfaid:part");
    let conformance = xmp::read_property(&packet, "pdfaid:conformance");
    if part.as_deref() != Some(&level.part().to_string())
        || conformance.as_deref().map(str::to_uppercase).as_deref() != Some(level.conformance())
    {
        fail(
            "pdfaIdentification",
            format!(
                "{}{}",
                part.unwrap_or_else(|| "?".into()),
                conformance.unwrap_or_else(|| "?".into()).to_lowercase()
            ),
            None,
            None,
        );
    }
    let Some(info) = dict_of(doc, doc.trailer.get(b"Info").ok()) else {
        return;
    };
    let pairs: [(&[u8], &str); 6] = [
        (b"Title", "dc:title"),
        (b"Author", "dc:creator"),
        (b"Subject", "dc:description"),
        (b"Keywords", "pdf:Keywords"),
        (b"Creator", "xmp:CreatorTool"),
        (b"Producer", "pdf:Producer"),
    ];
    for (key, property) in pairs {
        if let Some(value) = text_of(info.get(key).ok()) {
            if value.is_empty() {
                continue;
            }
            if xmp::read_property(&packet, property).as_deref() != Some(value.as_str()) {
                fail(
                    "metadataMismatch",
                    String::from_utf8_lossy(key).into_owned(),
                    None,
                    None,
                );
            }
        }
    }
    for (key, property) in [
        (b"CreationDate".as_slice(), "xmp:CreateDate"),
        (b"ModDate", "xmp:ModifyDate"),
    ] {
        if let Some(raw) = info.get(key).ok().and_then(|v| v.as_str().ok()) {
            let a = xmp::pdf_date_to_iso(raw);
            let b = xmp::read_property(&packet, property).and_then(|v| xmp::normalise_iso(&v));
            if a.is_none() || a != b {
                fail(
                    "metadataMismatch",
                    String::from_utf8_lossy(key).into_owned(),
                    None,
                    None,
                );
            }
        }
    }
    let _ = pdf;
}

fn embedded_bytes(doc: &Document, spec: &Dictionary) -> Option<(Option<ObjectId>, Vec<u8>)> {
    let ef = dict_of(doc, spec.get(b"EF").ok())?;
    let file = ef.get(b"F").ok().or_else(|| ef.get(b"UF").ok())?;
    let id = file.as_reference().ok();
    let s = resolve(doc, file).as_stream().ok()?;
    let bytes = s
        .decompressed_content_with_limit(64 << 20)
        .ok()
        .or_else(|| (!s.dict.has(b"Filter")).then(|| s.content.clone()))?;
    Some((id, bytes))
}

fn is_pdfa(bytes: &[u8]) -> bool {
    bytes.starts_with(b"%PDF") && bytes.windows(11).any(|w| w == b"pdfaid:part")
}

fn check_embedded_files(
    pdf: &PdfDocument,
    level: Level,
    fail: &mut dyn FnMut(&'static str, String, Option<usize>, Option<ObjectId>),
) {
    let doc = &pdf.doc;
    let Some(root) = pdf.names_root(b"EmbeddedFiles") else {
        return;
    };
    for (key, value) in pdf.name_tree_entries(root) {
        let label = decode_text_string(&key);
        let Some(spec) = dict_of(doc, Some(&value)) else {
            continue;
        };
        match level {
            Level::A1b => fail("embeddedFile", label, None, value.as_reference().ok()),
            Level::A2b | Level::A2u => {
                if !embedded_bytes(doc, spec).is_some_and(|(_, b)| is_pdfa(&b)) {
                    fail("embeddedFile", label, None, value.as_reference().ok());
                }
            }
            Level::A3b => {
                if !spec.has(b"AFRelationship") {
                    fail(
                        "associatedFile",
                        label.clone(),
                        None,
                        value.as_reference().ok(),
                    );
                }
                if !spec.has(b"F") || !spec.has(b"UF") {
                    fail(
                        "associatedFile",
                        format!("{label}: F/UF"),
                        None,
                        value.as_reference().ok(),
                    );
                }
                let stream_ok = dict_of(doc, spec.get(b"EF").ok())
                    .and_then(|ef| dict_of(doc, ef.get(b"F").ok()))
                    .is_some_and(|s| s.has(b"Subtype"));
                if !stream_ok {
                    fail(
                        "associatedFile",
                        format!("{label}: MIME"),
                        None,
                        value.as_reference().ok(),
                    );
                }
            }
        }
    }
}

/// What converting to PDF/A changed, for the report.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Conversion {
    pub bytes: Vec<u8>,
    /// Fonts the file did not carry, and the face embedded for each.
    pub substituted: Vec<fonts::Substitution>,
    /// Fonts given a ToUnicode from their own program.
    pub unicode_added: Vec<String>,
    /// What was taken out or changed, by kind, with a count or a name.
    pub changes: Vec<(&'static str, String)>,
    /// The copy, read back and validated.
    pub findings: Findings,
}

/// Why a file is not converted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    /// Rewriting it would break its signature.
    Signed,
    /// PDF/A-1 has no transparency, no layers, no JPEG 2000 and no 16-bit images.
    NotForLevel(Vec<&'static str>),
}

pub struct Options<'a> {
    pub level: Level,
    /// Faces to embed for fonts the file does not carry.
    pub faces: Vec<Face<'a>>,
    /// Now, ISO 8601: the copy's modification date.
    pub now: String,
    /// A title for a file that has none (PDF/A does not require one, but
    /// the XMP is written from it when it is there).
    pub title: Option<String>,
}

impl PdfDocument {
    /// Why this file cannot become PDF/A at `level`, if it cannot.
    pub fn pdfa_refusal(&self, level: Level) -> Option<Refusal> {
        if super::is_signed(&self.doc) {
            return Some(Refusal::Signed);
        }
        if level.one() {
            let scan = self.scan_content(ScanOptions::default());
            let mut why = vec![];
            if scan.pages.iter().any(|p| !p.transparency.is_empty()) {
                why.push("transparency");
            }
            if self.doc.catalog().is_ok_and(|c| c.has(b"OCProperties")) {
                why.push("layers");
            }
            if scan
                .images
                .iter()
                .any(|i| i.filters.iter().any(|f| f == "JPXDecode"))
            {
                why.push("jpeg2000");
            }
            if scan.images.iter().any(|i| i.bits == 16) {
                why.push("deepImages");
            }
            if !why.is_empty() {
                return Some(Refusal::NotForLevel(why));
            }
        }
        None
    }

    /// A PDF/A copy of this document: see the module documentation.
    pub fn to_pdfa(&self, options: &Options<'_>) -> Result<Conversion> {
        if let Some(refusal) = self.pdfa_refusal(options.level) {
            return Err(Error::Edit(format!("not convertible: {refusal:?}")));
        }
        let level = options.level;
        let mut report = Conversion::default();
        let mut copy = self.detached_copy();
        copy.was_encrypted = false;
        copy.sealer = None;
        for key in [b"Encrypt".as_slice(), b"Prev", b"XRefStm"] {
            copy.doc.trailer.remove(key);
        }

        remove_actions(&mut copy, level, &mut report);
        copy.fix_forms(&mut report);
        copy.fix_catalog(level, &mut report);
        copy.fix_streams(&mut report);
        copy.fix_embedded_files(level, &options.now, &mut report);

        // Fonts, from what the content shows.
        let scan = copy.scan_content(ScanOptions::default());
        let mut serial = 0;
        for font in &scan.fonts {
            let facts = fonts::facts(&copy.doc, &font.dict);
            if !facts.embedded() && font.visible {
                serial += 1;
                match fonts::substitute(&mut copy.doc, font, &options.faces, serial) {
                    Ok(s) => report.substituted.push(s),
                    Err(e) => report
                        .changes
                        .push(("fontNotReplaced", format!("{}: {e}", facts.base_font))),
                }
                continue;
            }
            copy.fix_font_dictionary(font, &facts, &mut report);
            // A CIDSet PDF/A-2 would have to vouch for: PDF/A-2 lets it go.
            if !level.one() {
                if let Some(desc) = facts.descriptor {
                    if let Ok(d) = copy.doc.get_dictionary_mut(desc) {
                        d.remove(b"CIDSet");
                    }
                }
            } else if facts.cid_subtype.as_deref() == Some("CIDFontType2") {
                copy.add_cid_set(&facts);
            }
            if level.unicode() && facts.program.is_some() {
                let unmapped = fonts::unmapped_codes(&copy.doc, font, &facts);
                if unmapped.is_empty() {
                    continue;
                }
                let program = match facts.program {
                    Some((Program::TrueType, id)) => copy
                        .doc
                        .get_object(id)
                        .ok()
                        .and_then(|o| o.as_stream().ok())
                        .and_then(|s| s.decompressed_content_with_limit(32 << 20).ok()),
                    _ => None,
                };
                let map = program
                    .as_deref()
                    .and_then(|p| fonts::tounicode_from_program(&copy.doc, font, &facts, p));
                match (map, font.id) {
                    (Some(map), Some(id)) => {
                        let mut s = Stream::new(Dictionary::new(), map);
                        let _ = s.compress();
                        let tu = copy.doc.add_object(s);
                        if let Ok(d) = copy.doc.get_dictionary_mut(id) {
                            d.set("ToUnicode", tu);
                            report.unicode_added.push(facts.base_font.clone());
                        }
                    }
                    _ => report.changes.push(("noUnicode", facts.base_font.clone())),
                }
            }
        }

        // Colour: the output intent, and device colour it does not cover.
        copy.set_output_intent(level, &mut report);
        copy.fix_annotations(level, &mut report);
        copy.fix_graphics_states();
        copy.write_metadata(level, options, &mut report)?;

        copy.prune_unreachable();
        let bytes = copy.write_whole(level)?;
        let reread = PdfDocument::open(bytes.clone(), None)?;
        report.findings = reread.pdfa_validate(level);
        report.bytes = bytes;
        Ok(report)
    }

    /// Writes the file whole, as PDF/A wants it laid out: the header's
    /// binary comment, a cross-reference table, a file identifier.
    pub(crate) fn write_whole(&mut self, level: Level) -> Result<Vec<u8>> {
        self.doc.version = if level.one() {
            "1.4".into()
        } else {
            "1.7".into()
        };
        self.write_whole_version()
    }

    pub(crate) fn write_whole_version(&mut self) -> Result<Vec<u8>> {
        self.doc.binary_mark = vec![0xE2, 0xE3, 0xCF, 0xD3];
        self.doc.reference_table.cross_reference_type = lopdf::xref::XrefType::CrossReferenceTable;
        if !self.doc.trailer.has(b"ID") {
            let (digest, _) = md5_hex(self.original_bytes());
            let id = Object::String(digest, lopdf::StringFormat::Hexadecimal);
            self.doc
                .trailer
                .set("ID", Object::Array(vec![id.clone(), id]));
        }
        let mut out = Vec::new();
        self.doc
            .save_to(&mut out)
            .map_err(|e| Error::Io(e.to_string()))?;
        Ok(out)
    }

    /// What an embedded font's dictionary gets wrong and can be put right
    /// without changing how it looks: a CIDFontType2 with no
    /// `CIDToGIDMap` (which readers take as Identity) says so, and widths
    /// that differ from the program's by a rounding (up to 10/1000 em)
    /// become the program's.
    fn fix_font_dictionary(
        &mut self,
        font: &super::scan::FontUse,
        facts: &fonts::FontFacts,
        report: &mut Conversion,
    ) {
        if facts.cid_subtype.as_deref() == Some("CIDFontType2") {
            let kid = self
                .doc
                .get_object(font.id.unwrap_or((0, 0)))
                .ok()
                .and_then(|o| o.as_dict().ok())
                .and_then(|d| d.get(b"DescendantFonts").ok())
                .map(|k| resolve(&self.doc, k))
                .and_then(|k| k.as_array().ok())
                .and_then(|k| k.first())
                .and_then(|k| k.as_reference().ok());
            if let Some(kid) = kid {
                if let Ok(d) = self.doc.get_dictionary_mut(kid) {
                    if !d.has(b"CIDToGIDMap") {
                        d.set("CIDToGIDMap", Object::Name(b"Identity".to_vec()));
                        report
                            .changes
                            .push(("cidToGidMap", facts.base_font.clone()));
                    }
                }
            }
        }
        let (Some(id), Some((Program::TrueType, program_id)), "TrueType") =
            (font.id, facts.program, facts.subtype.as_str())
        else {
            return;
        };
        let Some(program) = self
            .doc
            .get_object(program_id)
            .ok()
            .and_then(|o| o.as_stream().ok())
            .and_then(|s| s.decompressed_content_with_limit(32 << 20).ok())
        else {
            return;
        };
        let first = font
            .dict
            .get(b"FirstChar")
            .ok()
            .and_then(|f| f.as_i64().ok())
            .unwrap_or(0);
        let mut fixes: Vec<(usize, i64)> = vec![];
        for code in &font.codes {
            let Some(gid) = fonts::truetype_glyph(&self.doc, &font.dict, facts, &program, *code)
            else {
                continue;
            };
            let (Some(dict_w), Some(prog_w)) = (
                fonts::dictionary_width(&self.doc, &font.dict, facts, *code),
                fonts::glyph_width(&program, gid),
            ) else {
                continue;
            };
            let diff = (dict_w - prog_w).abs();
            if diff > 1.0 && diff <= 10.0 && i64::from(*code) >= first {
                fixes.push(((i64::from(*code) - first) as usize, prog_w.round() as i64));
            }
        }
        if fixes.is_empty() {
            return;
        }
        let widths_ref = font
            .dict
            .get(b"Widths")
            .ok()
            .and_then(|w| w.as_reference().ok());
        let apply = |widths: &mut Vec<Object>| {
            for (k, w) in &fixes {
                if let Some(slot) = widths.get_mut(*k) {
                    *slot = Object::Integer(*w);
                }
            }
        };
        match widths_ref {
            Some(wid) => {
                if let Ok(Object::Array(widths)) = self.doc.get_object_mut(wid) {
                    apply(widths);
                }
            }
            None => {
                if let Ok(Object::Array(widths)) = self
                    .doc
                    .get_dictionary_mut(id)
                    .and_then(|d| d.get_mut(b"Widths"))
                {
                    apply(widths);
                }
            }
        }
        report.changes.push(("widths", facts.base_font.clone()));
    }

    fn add_cid_set(&mut self, facts: &fonts::FontFacts) {
        let (Some(desc), Some((Program::TrueType, program))) = (facts.descriptor, facts.program)
        else {
            return;
        };
        let glyphs = self
            .doc
            .get_object(program)
            .ok()
            .and_then(|o| o.as_stream().ok())
            .and_then(|s| s.decompressed_content_with_limit(32 << 20).ok())
            .and_then(|p| {
                let face = skrifa::FontRef::new(&p).ok()?;
                Some(face.maxp().ok()?.num_glyphs() as usize)
            });
        let Some(glyphs) = glyphs else {
            return;
        };
        let mut bits = vec![0u8; glyphs.div_ceil(8)];
        for g in 0..glyphs {
            bits[g / 8] |= 0x80 >> (g % 8);
        }
        let mut s = Stream::new(Dictionary::new(), bits);
        let _ = s.compress();
        let set = self.doc.add_object(s);
        if let Ok(d) = self.doc.get_dictionary_mut(desc) {
            d.set("CIDSet", set);
        }
    }

    fn fix_forms(&mut self, report: &mut Conversion) {
        let Some(form_id) = self
            .doc
            .catalog()
            .ok()
            .and_then(|c| c.get(b"AcroForm").ok())
            .and_then(|f| f.as_reference().ok())
        else {
            if let Ok(catalog) = self.doc.catalog_mut() {
                if let Ok(Object::Dictionary(form)) = catalog.get_mut(b"AcroForm") {
                    if form.remove(b"XFA").is_some() {
                        report.changes.push(("xfa", String::new()));
                    }
                    form.remove(b"NeedAppearances");
                }
            }
            return;
        };
        if let Ok(form) = self.doc.get_dictionary_mut(form_id) {
            if form.remove(b"XFA").is_some() {
                report.changes.push(("xfa", String::new()));
            }
            form.remove(b"NeedAppearances");
        }
    }

    fn fix_catalog(&mut self, level: Level, report: &mut Conversion) {
        let names_id = self
            .doc
            .catalog()
            .ok()
            .and_then(|c| c.get(b"Names").ok())
            .and_then(|n| n.as_reference().ok());
        let strip_names = |names: &mut Dictionary, report: &mut Conversion| {
            if names.remove(b"JavaScript").is_some() {
                report.changes.push(("javascript", String::new()));
            }
            if names.remove(b"AlternatePresentations").is_some() {
                report
                    .changes
                    .push(("alternatePresentations", String::new()));
            }
        };
        if let Some(id) = names_id {
            if let Ok(names) = self.doc.get_dictionary_mut(id) {
                strip_names(names, report);
            }
        }
        if let Ok(catalog) = self.doc.catalog_mut() {
            if let Ok(Object::Dictionary(names)) = catalog.get_mut(b"Names") {
                strip_names(names, report);
            }
            catalog.remove(b"NeedsRendering");
            if level.one() {
                // Checked by `pdfa_refusal`: nothing is there to lose.
                catalog.remove(b"OCProperties");
            }
            if let Ok(Object::Dictionary(perms)) = catalog.get_mut(b"Perms") {
                let keys: Vec<Vec<u8>> = perms
                    .iter()
                    .map(|(k, _)| k.clone())
                    .filter(|k| k != b"UR3" && k != b"DocMDP")
                    .collect();
                for k in keys {
                    perms.remove(&k);
                }
            }
        }
        for page in self.pages.clone() {
            if let Ok(d) = self.doc.get_dictionary_mut(page) {
                d.remove(b"PresSteps");
            }
        }
        if !level.one() {
            self.fix_optional_content(report);
        }
    }

    fn fix_optional_content(&mut self, report: &mut Conversion) {
        let doc = &self.doc;
        let Some(oc_obj) = doc
            .catalog()
            .ok()
            .and_then(|c| c.get(b"OCProperties").ok())
            .cloned()
        else {
            return;
        };
        let Some(oc) = dict_of(doc, Some(&oc_obj)).cloned() else {
            return;
        };
        let groups: Vec<ObjectId> = oc
            .get(b"OCGs")
            .ok()
            .map(|o| resolve(doc, o))
            .and_then(|o| o.as_array().ok())
            .map(|a| a.iter().filter_map(|g| g.as_reference().ok()).collect())
            .unwrap_or_default();
        for g in &groups {
            if let Ok(d) = self.doc.get_dictionary_mut(*g) {
                if !d.has(b"Name") {
                    d.set("Name", Object::string_literal("Layer"));
                }
            }
        }
        let mut oc = oc;
        let fix_config = |config: &mut Dictionary, n: usize, doc: &Document| {
            if !config.has(b"Name") {
                config.set("Name", Object::string_literal(format!("Configuration {n}")));
            }
            config.remove(b"AS");
            if let Ok(order) = config.get(b"Order") {
                let mut listed = BTreeSet::new();
                collect_refs(doc, order, &mut listed, 0);
                let missing: Vec<Object> = groups
                    .iter()
                    .filter(|g| !listed.contains(g))
                    .map(|g| Object::Reference(*g))
                    .collect();
                if !missing.is_empty() {
                    if let Ok(Object::Array(order)) = config.get_mut(b"Order") {
                        order.extend(missing);
                    }
                }
            }
        };
        let doc_snapshot = self.doc.clone();
        match oc.get_mut(b"D") {
            Ok(Object::Dictionary(d)) => fix_config(d, 0, &doc_snapshot),
            Ok(Object::Reference(id)) => {
                let id = *id;
                if let Ok(d) = self.doc.get_dictionary_mut(id) {
                    fix_config(d, 0, &doc_snapshot);
                }
            }
            _ => {}
        }
        if let Ok(Object::Array(configs)) = oc.get_mut(b"Configs") {
            for (n, c) in configs.iter_mut().enumerate() {
                match c {
                    Object::Dictionary(d) => fix_config(d, n + 1, &doc_snapshot),
                    Object::Reference(id) => {
                        let id = *id;
                        if let Ok(d) = self.doc.get_dictionary_mut(id) {
                            fix_config(d, n + 1, &doc_snapshot);
                        }
                    }
                    _ => {}
                }
            }
        }
        match oc_obj {
            Object::Reference(id) => {
                self.doc.objects.insert(id, Object::Dictionary(oc));
            }
            _ => {
                if let Ok(catalog) = self.doc.catalog_mut() {
                    catalog.set("OCProperties", Object::Dictionary(oc));
                }
            }
        }
        let _ = report;
    }

    /// External streams, LZW and crypt filters: none may stay.
    fn fix_streams(&mut self, report: &mut Conversion) {
        let mut lzw = 0;
        let mut external = 0;
        for object in self.doc.objects.values_mut() {
            let Object::Stream(s) = object else {
                continue;
            };
            for key in [b"F".as_slice(), b"FFilter", b"FDecodeParms"] {
                if s.dict.remove(key).is_some() {
                    external += 1;
                }
            }
            let filters: Vec<Vec<u8>> = match s.dict.get(b"Filter") {
                Ok(Object::Name(n)) => vec![n.clone()],
                Ok(Object::Array(a)) => a
                    .iter()
                    .filter_map(|n| n.as_name().ok().map(<[u8]>::to_vec))
                    .collect(),
                _ => vec![],
            };
            let has_lzw = filters.iter().any(|f| f == b"LZWDecode" || f == b"Crypt");
            let decodable = filters
                .iter()
                .all(|f| matches!(f.as_slice(), b"LZWDecode" | b"FlateDecode" | b"Crypt"));
            if has_lzw && decodable {
                if let Ok(plain) = s.decompressed_content_with_limit(256 << 20) {
                    s.dict.remove(b"Filter");
                    s.dict.remove(b"DecodeParms");
                    s.set_plain_content(plain);
                    let _ = s.compress();
                    lzw += 1;
                }
            }
        }
        if lzw > 0 {
            report.changes.push(("lzw", lzw.to_string()));
        }
        if external > 0 {
            report
                .changes
                .push(("externalStream", external.to_string()));
        }
    }

    fn fix_embedded_files(&mut self, level: Level, now: &str, report: &mut Conversion) {
        let Some(root) = self.names_root(b"EmbeddedFiles").cloned() else {
            // File attachment annotations with no name tree.
            if level != Level::A3b {
                self.drop_file_attachments(level, report);
            }
            return;
        };
        let entries = self.name_tree_entries(&root);
        let mut kept: Vec<Object> = vec![];
        let mut specs: Vec<ObjectId> = vec![];
        for (key, value) in entries {
            let label = decode_text_string(&key);
            let keep = match level {
                Level::A1b => false,
                Level::A2b | Level::A2u => dict_of(&self.doc, Some(&value))
                    .and_then(|spec| embedded_bytes(&self.doc, spec))
                    .is_some_and(|(_, b)| is_pdfa(&b)),
                Level::A3b => true,
            };
            if keep {
                kept.push(Object::String(key, lopdf::StringFormat::Literal));
                kept.push(value.clone());
                if let Ok(id) = value.as_reference() {
                    specs.push(id);
                }
            } else {
                report.changes.push(("embeddedFile", label));
            }
        }
        let tree = if kept.is_empty() {
            None
        } else {
            Some(Object::Dictionary(dictionary! { "Names" => kept }))
        };
        self.set_names_entry(b"EmbeddedFiles", tree);
        if level == Level::A3b {
            for spec in &specs {
                self.associate(*spec, now);
            }
            if let Ok(catalog) = self.doc.catalog_mut() {
                let mut af: Vec<Object> = match catalog.get(b"AF") {
                    Ok(Object::Array(a)) => a.clone(),
                    _ => vec![],
                };
                for spec in &specs {
                    if !af.contains(&Object::Reference(*spec)) {
                        af.push(Object::Reference(*spec));
                    }
                }
                if !af.is_empty() {
                    catalog.set("AF", af);
                }
            }
            // Attachments on pages are associated with their page.
            for page in self.pages.clone() {
                let specs: Vec<ObjectId> = self
                    .page_annotations(page)
                    .into_iter()
                    .filter(|(_, a)| name(a.get(b"Subtype").ok()) == Some(b"FileAttachment"))
                    .filter_map(|(_, a)| a.get(b"FS").ok().and_then(|f| f.as_reference().ok()))
                    .collect();
                for spec in specs {
                    self.associate(spec, now);
                }
            }
        } else {
            self.drop_file_attachments(level, report);
        }
    }

    /// What PDF/A-3 wants of an associated file: its relationship, both
    /// names, a MIME type and a modification date.
    fn associate(&mut self, spec: ObjectId, now: &str) {
        let Ok(d) = self.doc.get_dictionary(spec).cloned() else {
            return;
        };
        let file_name = text_of(d.get(b"UF").ok())
            .or_else(|| text_of(d.get(b"F").ok()))
            .unwrap_or_else(|| "attachment".into());
        let stream_id = dict_of(&self.doc, d.get(b"EF").ok())
            .and_then(|ef| ef.get(b"F").ok())
            .and_then(|f| f.as_reference().ok());
        if let Ok(d) = self.doc.get_dictionary_mut(spec) {
            if !d.has(b"AFRelationship") {
                d.set("AFRelationship", Object::Name(b"Unspecified".to_vec()));
            }
            if !d.has(b"UF") {
                d.set("UF", lopdf::text_string(&file_name));
            }
            if !d.has(b"F") {
                d.set("F", lopdf::text_string(&file_name));
            }
            if !d.has(b"Type") {
                d.set("Type", Object::Name(b"Filespec".to_vec()));
            }
        }
        if let Some(sid) = stream_id {
            if let Ok(Object::Stream(s)) = self.doc.get_object_mut(sid) {
                if !s.dict.has(b"Subtype") {
                    s.dict.set(
                        "Subtype",
                        Object::Name(mime_for(&file_name).as_bytes().to_vec()),
                    );
                }
                if !s.dict.has(b"Type") {
                    s.dict.set("Type", Object::Name(b"EmbeddedFile".to_vec()));
                }
                let has_date = match s.dict.get(b"Params") {
                    Ok(Object::Dictionary(p)) => p.has(b"ModDate"),
                    _ => false,
                };
                if !has_date {
                    let mut params = match s.dict.get(b"Params") {
                        Ok(Object::Dictionary(p)) => p.clone(),
                        _ => Dictionary::new(),
                    };
                    if let Some(date) = xmp::iso_to_pdf_date(now) {
                        params.set("ModDate", Object::string_literal(date));
                    }
                    s.dict.set("Params", Object::Dictionary(params));
                }
            }
        }
    }

    fn drop_file_attachments(&mut self, level: Level, report: &mut Conversion) {
        for page in self.pages.clone() {
            let annots = self.page_annotations(page);
            let mut drop = BTreeSet::new();
            for (id, a) in &annots {
                if name(a.get(b"Subtype").ok()) != Some(b"FileAttachment") {
                    continue;
                }
                let keep = level != Level::A1b
                    && dict_of(&self.doc, a.get(b"FS").ok())
                        .and_then(|spec| embedded_bytes(&self.doc, spec))
                        .is_some_and(|(_, b)| is_pdfa(&b));
                if !keep {
                    if let Some(id) = id {
                        drop.insert(*id);
                    }
                    report.changes.push((
                        "embeddedFile",
                        text_of(a.get(b"Contents").ok()).unwrap_or_default(),
                    ));
                }
            }
            if !drop.is_empty() {
                self.keep_annotations(page, |id, _| id.is_none_or(|id| !drop.contains(&id)));
            }
        }
    }

    /// The page's `/Annots`, written again with what `keep` keeps.
    pub(crate) fn keep_annotations(
        &mut self,
        page: ObjectId,
        keep: impl Fn(Option<ObjectId>, &Dictionary) -> bool,
    ) {
        let kept: Vec<Object> = {
            let Ok(dict) = self.doc.get_dictionary(page) else {
                return;
            };
            let Some(Ok(annots)) = dict
                .get(b"Annots")
                .ok()
                .map(|o| resolve(&self.doc, o))
                .map(|o| o.as_array())
            else {
                return;
            };
            annots
                .iter()
                .filter(|a| {
                    let id = a.as_reference().ok();
                    dict_of(&self.doc, Some(a)).is_some_and(|d| keep(id, d))
                })
                .cloned()
                .collect()
        };
        if let Ok(d) = self.doc.get_dictionary_mut(page) {
            if kept.is_empty() {
                d.remove(b"Annots");
            } else {
                d.set("Annots", Object::Array(kept));
            }
        }
    }

    /// Sets (or removes) an entry of the catalog's `/Names`.
    fn set_names_entry(&mut self, key: &[u8], value: Option<Object>) {
        let names_ref = self
            .doc
            .catalog()
            .ok()
            .and_then(|c| c.get(b"Names").ok())
            .and_then(|n| n.as_reference().ok());
        let apply = |names: &mut Dictionary| match &value {
            Some(v) => names.set(key.to_vec(), v.clone()),
            None => {
                names.remove(key);
            }
        };
        if let Some(id) = names_ref {
            if let Ok(names) = self.doc.get_dictionary_mut(id) {
                apply(names);
            }
        } else if let Ok(catalog) = self.doc.catalog_mut() {
            match catalog.get_mut(b"Names") {
                Ok(Object::Dictionary(names)) => apply(names),
                _ => {
                    if value.is_some() {
                        let mut names = Dictionary::new();
                        apply(&mut names);
                        catalog.set("Names", Object::Dictionary(names));
                    }
                }
            }
        }
    }

    /// The output intent: the file's own PDF/A one if it is sound, else one
    /// made from its PDF/X intent's profile, else sRGB. Device colour the
    /// intent does not describe gets a default colour space.
    fn set_output_intent(&mut self, level: Level, report: &mut Conversion) {
        let (intent, _, _) = pdfa_intent(&self.doc);
        let usable = intent.filter(|i| {
            matches!(i.info.class.as_str(), "mntr" | "prtr")
                && (!level.one() || i.info.major <= 2)
                && matches!(i.info.space.as_str(), "RGB " | "CMYK" | "GRAY")
        });
        let (profile, space) = match usable {
            Some(i) => (i.profile, i.info.space),
            None => {
                // A PDF/X intent's profile can serve (PDF/A-2 §6.2.3).
                let pdfx = self
                    .doc
                    .catalog()
                    .ok()
                    .and_then(|c| c.get(b"OutputIntents").ok())
                    .map(|o| resolve(&self.doc, o))
                    .and_then(|o| o.as_array().ok())
                    .and_then(|a| {
                        a.iter().find_map(|i| {
                            let d = dict_of(&self.doc, Some(i))?;
                            let p = d.get(b"DestOutputProfile").ok()?.as_reference().ok()?;
                            let s = self.doc.get_object(p).ok()?.as_stream().ok()?;
                            let info =
                                icc::read(&s.decompressed_content_with_limit(8 << 20).ok()?)?;
                            (matches!(info.class.as_str(), "prtr" | "mntr")
                                && (!level.one() || info.major <= 2))
                                .then_some((p, info.space))
                        })
                    });
                match pdfx {
                    Some(found) => found,
                    None => (
                        icc::add_profile(&mut self.doc, icc::SRGB, 3),
                        "RGB ".to_string(),
                    ),
                }
            }
        };
        let intent = self.doc.add_object(dictionary! {
            "Type" => "OutputIntent",
            "S" => "GTS_PDFA1",
            "OutputConditionIdentifier" => Object::string_literal(if space == "RGB " { "sRGB IEC61966-2.1" } else { "Custom" }),
            "RegistryName" => Object::string_literal("http://www.color.org"),
            "Info" => Object::string_literal(if space == "RGB " { "sRGB IEC61966-2.1" } else { "Output profile" }),
            "DestOutputProfile" => profile,
        });
        // One profile for every intent that names one (§6.2.3).
        let mut intents: Vec<Object> = vec![Object::Reference(intent)];
        if let Some(existing) = self
            .doc
            .catalog()
            .ok()
            .and_then(|c| c.get(b"OutputIntents").ok())
            .map(|o| resolve(&self.doc, o))
            .and_then(|o| o.as_array().ok())
            .cloned()
        {
            for i in existing {
                let Some(d) = dict_of(&self.doc, Some(&i)) else {
                    continue;
                };
                let s = name(d.get(b"S").ok());
                let p = d
                    .get(b"DestOutputProfile")
                    .ok()
                    .and_then(|p| p.as_reference().ok());
                if s != Some(b"GTS_PDFA1") && (p.is_none() || p == Some(profile)) {
                    intents.push(i);
                }
            }
        }
        if let Ok(catalog) = self.doc.catalog_mut() {
            catalog.set("OutputIntents", intents);
        }
        let mut added = vec![];
        if space != "CMYK" {
            let cmyk = icc::add_profile(&mut self.doc, icc::CMYK_SWOP, 4);
            self.replace_device_space(b"DeviceCMYK", cmyk);
            added.push("CMYK");
        }
        if space != "RGB " {
            let rgb = icc::add_profile(&mut self.doc, icc::SRGB, 3);
            self.replace_device_space(b"DeviceRGB", rgb);
            added.push("RGB");
        }
        report.changes.push((
            "outputIntent",
            if space == "RGB " {
                "sRGB".into()
            } else {
                space.trim().to_string()
            },
        ));
        let _ = added;
    }

    /// Makes device space `device` (`DeviceRGB` or `DeviceCMYK`) mean the
    /// profile `profile`: named in images, shadings, groups, alternates and
    /// resources, it becomes `[/ICCBased profile]`; set by operators, the
    /// default colour space every resource dictionary gets says so.
    pub(crate) fn replace_device_space(&mut self, device: &[u8], profile: ObjectId) {
        let space = icc::icc_space(profile);
        let default_key: &[u8] = if device == b"DeviceRGB" {
            b"DefaultRGB"
        } else {
            b"DefaultCMYK"
        };
        let ids: Vec<ObjectId> = self.doc.objects.keys().copied().collect();
        // Resource dictionaries held as their own objects.
        let mut resource_ids: BTreeSet<ObjectId> = BTreeSet::new();
        for object in self.doc.objects.values() {
            let d = match object {
                Object::Dictionary(d) => d,
                Object::Stream(s) => &s.dict,
                _ => continue,
            };
            if let Ok(Object::Reference(r)) = d.get(b"Resources") {
                resource_ids.insert(*r);
            }
        }
        for id in ids {
            let is_resources = resource_ids.contains(&id);
            let Some(object) = self.doc.objects.get_mut(&id) else {
                continue;
            };
            // Explicit uses.
            visit_dicts_mut(object, 0, &mut |d| {
                for key in [b"ColorSpace".as_slice(), b"CS"] {
                    let is_device = matches!(d.get(key), Ok(Object::Name(n)) if n == device);
                    if is_device {
                        d.set(key.to_vec(), space.clone());
                    }
                }
            });
            visit_arrays_mut(object, 0, &mut |a| {
                let family = a.first().and_then(|f| f.as_name().ok()).map(<[u8]>::to_vec);
                let slot = match family.as_deref() {
                    Some(b"Separation") | Some(b"DeviceN") => 2,
                    Some(b"Indexed") => 1,
                    _ => return,
                };
                if matches!(a.get(slot), Some(Object::Name(n)) if n == device) {
                    a[slot] = space.clone();
                }
            });
            // Operators and inline images: the default space.
            let add_default = |d: &mut Dictionary| {
                let mut spaces = match d.get(b"ColorSpace") {
                    Ok(Object::Dictionary(s)) => s.clone(),
                    Ok(Object::Reference(_)) => return,
                    _ => Dictionary::new(),
                };
                if !spaces.has(default_key) {
                    spaces.set(default_key.to_vec(), space.clone());
                    d.set("ColorSpace", Object::Dictionary(spaces));
                }
            };
            if is_resources {
                if let Object::Dictionary(d) = object {
                    add_default(d);
                }
            }
            visit_dicts_mut(object, 0, &mut |d| {
                if let Ok(Object::Dictionary(res)) = d.get_mut(b"Resources") {
                    add_default(res);
                }
            });
            // A form with no resources of its own is read with none: it
            // gets the default space in resources of its own.
            if let Object::Stream(s) = object {
                if name(s.dict.get(b"Subtype").ok()) == Some(b"Form") && !s.dict.has(b"Resources") {
                    let mut res = Dictionary::new();
                    add_default(&mut res);
                    s.dict.set("Resources", Object::Dictionary(res));
                }
            }
        }
        // Colour-space dictionaries held as their own objects.
        let spaces_ids: Vec<ObjectId> = self
            .doc
            .objects
            .values()
            .filter_map(|o| match o {
                Object::Dictionary(d) => d.get(b"ColorSpace").ok()?.as_reference().ok(),
                _ => None,
            })
            .collect();
        for id in spaces_ids {
            if let Ok(d) = self.doc.get_dictionary_mut(id) {
                if !d.has(default_key) {
                    d.set(default_key.to_vec(), space.clone());
                }
            }
        }
    }

    /// Graphics states PDF/A would refuse: overprint mode 1 means nothing
    /// for an ICC-based CMYK space (PDF/A-2 §6.2.4.2), so overprinting is in
    /// mode 0; transfer functions go, `TR2` becomes `/Default`, halftones
    /// other than types 1 and 5 go (§6.2.5), and so do unknown intents.
    fn fix_graphics_states(&mut self) {
        fn fix(d: &mut Dictionary) {
            let op = d
                .get(b"OP")
                .ok()
                .and_then(|v| v.as_bool().ok())
                .unwrap_or(false);
            if op && d.get(b"OPM").ok().and_then(|v| v.as_i64().ok()) == Some(1) {
                d.set("OPM", 0);
            }
            d.remove(b"TR");
            if d.get(b"TR2")
                .ok()
                .and_then(|v| v.as_name().ok())
                .is_some_and(|n| n != b"Default")
                || matches!(d.get(b"TR2"), Ok(o) if o.as_name().is_err())
            {
                d.set("TR2", Object::Name(b"Default".to_vec()));
            }
            let bad_ht = match d.get(b"HT") {
                Ok(Object::Dictionary(h)) => {
                    h.has(b"HalftoneName")
                        || !matches!(
                            h.get(b"HalftoneType").ok().and_then(|t| t.as_i64().ok()),
                            Some(1 | 5)
                        )
                }
                Ok(Object::Name(n)) => n != b"Default",
                Ok(_) => true,
                Err(_) => false,
            };
            if bad_ht {
                d.remove(b"HT");
            }
            if name(d.get(b"RI").ok())
                .is_some_and(|ri| !INTENTS.contains(&String::from_utf8_lossy(ri).as_ref()))
            {
                d.remove(b"RI");
            }
        }
        // The graphics states each resource dictionary lists.
        let mut states: BTreeSet<ObjectId> = BTreeSet::new();
        let mut groups: BTreeSet<ObjectId> = BTreeSet::new();
        for object in self.doc.objects.values_mut() {
            visit_dicts_mut(object, 0, &mut |d| match d.get_mut(b"ExtGState") {
                Ok(Object::Dictionary(group)) => {
                    for (_, v) in group.iter_mut() {
                        match v {
                            Object::Reference(id) => {
                                states.insert(*id);
                            }
                            Object::Dictionary(state) => fix(state),
                            _ => {}
                        }
                    }
                }
                Ok(Object::Reference(id)) => {
                    groups.insert(*id);
                }
                _ => {}
            });
        }
        for id in groups {
            if let Ok(group) = self.doc.get_dictionary_mut(id) {
                for (_, v) in group.iter_mut() {
                    match v {
                        Object::Reference(id) => {
                            states.insert(*id);
                        }
                        Object::Dictionary(state) => fix(state),
                        _ => {}
                    }
                }
            }
        }
        for id in states {
            if let Ok(state) = self.doc.get_dictionary_mut(id) {
                fix(state);
            }
        }
        // Images that name an intent no one knows.
        for object in self.doc.objects.values_mut() {
            if let Object::Stream(s) = object {
                if name(s.dict.get(b"Intent").ok())
                    .is_some_and(|ri| !INTENTS.contains(&String::from_utf8_lossy(ri).as_ref()))
                {
                    s.dict.remove(b"Intent");
                }
                s.dict.remove(b"Alternates");
                s.dict.remove(b"OPI");
                if s.dict
                    .get(b"Interpolate")
                    .ok()
                    .and_then(|v| v.as_bool().ok())
                    == Some(true)
                {
                    s.dict.set("Interpolate", false);
                }
            }
        }
    }

    fn fix_annotations(&mut self, level: Level, report: &mut Conversion) {
        let mut removed = 0usize;
        let mut drawn = 0usize;
        for page in self.pages.clone() {
            let annots: Vec<(Option<ObjectId>, Dictionary)> = self
                .page_annotations(page)
                .into_iter()
                .map(|(id, d)| (id, d.clone()))
                .collect();
            let mut drop: BTreeSet<Option<ObjectId>> = BTreeSet::new();
            let mut drop_direct = false;
            for (id, annot) in annots {
                let subtype = name(annot.get(b"Subtype").ok()).unwrap_or(b"").to_vec();
                let allowed = if level.one() {
                    A1_ANNOTATIONS.contains(&subtype.as_slice())
                } else {
                    KNOWN_ANNOTATIONS.contains(&subtype.as_slice())
                        && !matches!(subtype.as_slice(), b"3D" | b"Sound" | b"Screen" | b"Movie")
                };
                let flags = annot
                    .get(b"F")
                    .ok()
                    .and_then(|f| f.as_i64().ok())
                    .unwrap_or(0);
                // Hidden ones show nothing: gone rather than shown.
                let hidden = flags & (1 | 2 | 32) != 0;
                if !allowed || (hidden && subtype != b"Popup") {
                    drop.insert(id);
                    drop_direct |= id.is_none();
                    removed += 1;
                    continue;
                }
                let Some(id) = id else {
                    continue;
                };
                let mut d = annot.clone();
                if subtype != b"Popup" {
                    d.set("F", (flags | 4) & !(1 | 2 | 32 | 256));
                }
                if level.one() && d.has(b"CA") {
                    d.set("CA", 1.0);
                }
                if subtype == b"Widget" {
                    d.remove(b"A");
                    d.remove(b"AA");
                }
                // Appearances: only the normal one.
                let rect = self.rect(d.get(b"Rect").ok());
                let zero = rect.is_none_or(|r| r[2] - r[0] <= 0.0 || r[3] - r[1] <= 0.0);
                let needs = !matches!(subtype.as_slice(), b"Popup" | b"Link") && !zero;
                let ap = dict_of(&self.doc, d.get(b"AP").ok()).cloned();
                match ap {
                    Some(ap) => {
                        let mut ap2 = Dictionary::new();
                        if let Ok(n) = ap.get(b"N") {
                            let is_btn = subtype == b"Widget"
                                && field_type(&self.doc, &d) == Some(b"Btn".to_vec());
                            let n_is_stream = resolve(&self.doc, n).as_stream().is_ok();
                            if is_btn && n_is_stream {
                                let state = name(d.get(b"AS").ok())
                                    .map(<[u8]>::to_vec)
                                    .unwrap_or_else(|| b"On".to_vec());
                                ap2.set(
                                    "N",
                                    Object::Dictionary(dictionary! { state.clone() => n.clone() }),
                                );
                                d.set("AS", Object::Name(state));
                            } else {
                                ap2.set("N", n.clone());
                            }
                            d.set("AP", Object::Dictionary(ap2));
                        } else if needs {
                            match self.draw_appearance(&d, level) {
                                Some(stream) => {
                                    d.set("AP", Object::Dictionary(dictionary! { "N" => stream }));
                                    drawn += 1;
                                }
                                None => {
                                    drop.insert(Some(id));
                                    removed += 1;
                                    continue;
                                }
                            }
                        }
                    }
                    None if needs => match self.draw_appearance(&d, level) {
                        Some(stream) => {
                            d.set("AP", Object::Dictionary(dictionary! { "N" => stream }));
                            drawn += 1;
                        }
                        None => {
                            drop.insert(Some(id));
                            removed += 1;
                            continue;
                        }
                    },
                    None => {}
                }
                self.doc.objects.insert(id, Object::Dictionary(d));
            }
            if !drop.is_empty() {
                self.keep_annotations(page, |id, _| {
                    !drop.contains(&id) || (id.is_none() && !drop_direct)
                });
            }
        }
        if removed > 0 {
            report
                .changes
                .push(("annotationsRemoved", removed.to_string()));
        }
        if drawn > 0 {
            report.changes.push(("appearancesDrawn", drawn.to_string()));
        }
    }

    /// An appearance for an annotation that has none, drawn from what it
    /// says it is: its rectangle, colour, border and geometry.
    fn draw_appearance(&mut self, annot: &Dictionary, level: Level) -> Option<ObjectId> {
        let rect = self.rect(annot.get(b"Rect").ok())?;
        let subtype = name(annot.get(b"Subtype").ok())?.to_vec();
        let nums = |key: &[u8]| -> Vec<f32> {
            annot
                .get(key)
                .ok()
                .map(|o| resolve(&self.doc, o))
                .and_then(|o| o.as_array().ok())
                .map(|a| a.iter().filter_map(|n| n.as_float().ok()).collect())
                .unwrap_or_default()
        };
        let colour = |values: &[f32], stroke: bool| -> String {
            let v: Vec<String> = values.iter().map(|x| format!("{x:.3}")).collect();
            match values.len() {
                1 => format!("{} {}", v[0], if stroke { "G" } else { "g" }),
                3 => format!("{} {}", v.join(" "), if stroke { "RG" } else { "rg" }),
                4 => format!("{} {}", v.join(" "), if stroke { "K" } else { "k" }),
                _ => String::new(),
            }
        };
        let c = nums(b"C");
        let ic = nums(b"IC");
        let width = dict_of(&self.doc, annot.get(b"BS").ok())
            .and_then(|bs| bs.get(b"W").ok())
            .and_then(|w| w.as_float().ok())
            .or_else(|| nums(b"Border").get(2).copied())
            .unwrap_or(1.0)
            .max(0.0);
        let stroke = if c.is_empty() {
            "0 G".to_string()
        } else {
            colour(&c, true)
        };
        let [x0, y0, x1, y1] = rect;
        let h = width / 2.0;
        let mut ops = format!("q {width:.3} w {stroke} ");
        let mut resources = Dictionary::new();
        match subtype.as_slice() {
            b"Square" => {
                if !ic.is_empty() {
                    ops.push_str(&format!("{} ", colour(&ic, false)));
                }
                ops.push_str(&format!(
                    "{:.3} {:.3} {:.3} {:.3} re {}",
                    x0 + h,
                    y0 + h,
                    (x1 - x0 - width).max(0.0),
                    (y1 - y0 - width).max(0.0),
                    if ic.is_empty() { "S" } else { "B" }
                ));
            }
            b"Circle" => {
                if !ic.is_empty() {
                    ops.push_str(&format!("{} ", colour(&ic, false)));
                }
                let (cx, cy) = ((x0 + x1) / 2.0, (y0 + y1) / 2.0);
                let (rx, ry) = (
                    ((x1 - x0) / 2.0 - h).max(0.0),
                    ((y1 - y0) / 2.0 - h).max(0.0),
                );
                let k = 0.552_284_8;
                ops.push_str(&format!(
                    "{:.3} {:.3} m {:.3} {:.3} {:.3} {:.3} {:.3} {:.3} c {:.3} {:.3} {:.3} {:.3} {:.3} {:.3} c {:.3} {:.3} {:.3} {:.3} {:.3} {:.3} c {:.3} {:.3} {:.3} {:.3} {:.3} {:.3} c {}",
                    cx + rx, cy,
                    cx + rx, cy + k * ry, cx + k * rx, cy + ry, cx, cy + ry,
                    cx - k * rx, cy + ry, cx - rx, cy + k * ry, cx - rx, cy,
                    cx - rx, cy - k * ry, cx - k * rx, cy - ry, cx, cy - ry,
                    cx + k * rx, cy - ry, cx + rx, cy - k * ry, cx + rx, cy,
                    if ic.is_empty() { "S" } else { "B" }
                ));
            }
            b"Line" => {
                let l = nums(b"L");
                if l.len() != 4 {
                    return None;
                }
                ops.push_str(&format!(
                    "{:.3} {:.3} m {:.3} {:.3} l S",
                    l[0], l[1], l[2], l[3]
                ));
            }
            b"Ink" => {
                let lists = annot
                    .get(b"InkList")
                    .ok()
                    .map(|o| resolve(&self.doc, o))
                    .and_then(|o| o.as_array().ok())?
                    .clone();
                ops.push_str("1 J 1 j ");
                for list in lists {
                    let pts: Vec<f32> = resolve(&self.doc, &list)
                        .as_array()
                        .ok()?
                        .iter()
                        .filter_map(|n| n.as_float().ok())
                        .collect();
                    for (k, p) in pts.chunks(2).enumerate() {
                        if let [x, y] = p {
                            ops.push_str(&format!(
                                "{x:.3} {y:.3} {} ",
                                if k == 0 { "m" } else { "l" }
                            ));
                        }
                    }
                    ops.push_str("S ");
                }
            }
            b"Polygon" | b"PolyLine" => {
                let v = nums(b"Vertices");
                if v.len() < 4 {
                    return None;
                }
                for (k, p) in v.chunks(2).enumerate() {
                    if let [x, y] = p {
                        ops.push_str(&format!(
                            "{x:.3} {y:.3} {} ",
                            if k == 0 { "m" } else { "l" }
                        ));
                    }
                }
                ops.push_str(if subtype == b"Polygon" { "h S" } else { "S" });
            }
            b"Underline" | b"StrikeOut" | b"Highlight" | b"Squiggly" => {
                let q = nums(b"QuadPoints");
                if q.len() < 8 {
                    return None;
                }
                if subtype == b"Highlight" {
                    // PDF/A-1 has no blending: a highlight would hide its text.
                    if level.one() {
                        return None;
                    }
                    let gs = self
                        .doc
                        .add_object(dictionary! { "Type" => "ExtGState", "BM" => "Multiply" });
                    resources.set("ExtGState", dictionary! { "G0" => gs });
                    let fill = if c.is_empty() {
                        "1 1 0 rg".to_string()
                    } else {
                        colour(&c, false)
                    };
                    ops.push_str(&format!("/G0 gs {fill} "));
                }
                for quad in q.chunks(8) {
                    if quad.len() < 8 {
                        break;
                    }
                    let xs = [quad[0], quad[2], quad[4], quad[6]];
                    let ys = [quad[1], quad[3], quad[5], quad[7]];
                    let (qx0, qx1) = (
                        xs.iter().cloned().fold(f32::MAX, f32::min),
                        xs.iter().cloned().fold(f32::MIN, f32::max),
                    );
                    let (qy0, qy1) = (
                        ys.iter().cloned().fold(f32::MAX, f32::min),
                        ys.iter().cloned().fold(f32::MIN, f32::max),
                    );
                    match subtype.as_slice() {
                        b"Highlight" => ops.push_str(&format!(
                            "{qx0:.3} {qy0:.3} {:.3} {:.3} re f ",
                            qx1 - qx0,
                            qy1 - qy0
                        )),
                        b"StrikeOut" => {
                            let y = (qy0 + qy1) / 2.0;
                            ops.push_str(&format!("{qx0:.3} {y:.3} m {qx1:.3} {y:.3} l S "));
                        }
                        _ => {
                            let y = qy0 + (qy1 - qy0) * 0.08;
                            ops.push_str(&format!("{qx0:.3} {y:.3} m {qx1:.3} {y:.3} l S "));
                        }
                    }
                }
            }
            b"Text" => {
                // A note: a small page of paper at the top of its box.
                let size = 18.0f32.min(x1 - x0).min(y1 - y0).max(4.0);
                let fill = if c.is_empty() {
                    "1 0.85 0.2 rg".to_string()
                } else {
                    colour(&c, false)
                };
                let top = y1;
                ops = format!(
                    "q 0.6 w 0.25 G {fill} {x0:.3} {:.3} {size:.3} {size:.3} re B {:.3} {:.3} m {:.3} {:.3} l {:.3} {:.3} m {:.3} {:.3} l {:.3} {:.3} m {:.3} {:.3} l S",
                    top - size,
                    x0 + size * 0.2, top - size * 0.3, x0 + size * 0.8, top - size * 0.3,
                    x0 + size * 0.2, top - size * 0.5, x0 + size * 0.8, top - size * 0.5,
                    x0 + size * 0.2, top - size * 0.7, x0 + size * 0.6, top - size * 0.7,
                );
            }
            // A field with no appearance shows nothing in most readers.
            b"Widget" => ops = "q".into(),
            _ => return None,
        }
        ops.push_str(" Q");
        let stream = Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Form",
                "BBox" => vec![x0.into(), y0.into(), x1.into(), y1.into()],
                "Resources" => resources,
            },
            ops.into_bytes(),
        );
        Some(self.doc.add_object(stream))
    }

    fn write_metadata(
        &mut self,
        level: Level,
        options: &Options<'_>,
        report: &mut Conversion,
    ) -> Result<()> {
        let now_iso = xmp::normalise_iso(&options.now)
            .ok_or_else(|| Error::Edit(format!("{} is not a date", options.now)))?;
        let fields = self.info_fields(options.title.as_deref(), &now_iso);
        let mut fields = fields;
        fields.pdfa = Some((level.part(), level.conformance().to_string()));
        self.set_metadata(&fields, report)
    }

    /// Document information, tidied for a copy made now: the title (or
    /// `fallback`), the dates in step, Warraq as the producer.
    pub(crate) fn info_fields(&mut self, fallback: Option<&str>, now_iso: &str) -> xmp::XmpFields {
        let info_id = self
            .doc
            .trailer
            .get(b"Info")
            .ok()
            .and_then(|i| i.as_reference().ok());
        let mut info = dict_of(&self.doc, self.doc.trailer.get(b"Info").ok())
            .cloned()
            .unwrap_or_default();
        let text = |info: &Dictionary, k: &[u8]| {
            text_of(info.get(k).ok()).filter(|t| !t.trim().is_empty())
        };
        let title = text(&info, b"Title").or_else(|| fallback.map(str::to_string));
        let created = info
            .get(b"CreationDate")
            .ok()
            .and_then(|d| d.as_str().ok())
            .and_then(xmp::pdf_date_to_iso)
            .unwrap_or_else(|| now_iso.to_string());
        let fields = xmp::XmpFields {
            title: title.clone(),
            author: text(&info, b"Author"),
            subject: text(&info, b"Subject"),
            keywords: text(&info, b"Keywords"),
            creator_tool: text(&info, b"Creator"),
            producer: Some("ورّاق".into()),
            created: Some(created.clone()),
            modified: Some(now_iso.to_string()),
            ..Default::default()
        };
        for (key, value) in [
            (b"Title".as_slice(), &fields.title),
            (b"Author", &fields.author),
            (b"Subject", &fields.subject),
            (b"Keywords", &fields.keywords),
            (b"Creator", &fields.creator_tool),
            (b"Producer", &fields.producer),
        ] {
            match value {
                Some(v) => info.set(key.to_vec(), lopdf::text_string(v)),
                None => {
                    info.remove(key);
                }
            }
        }
        if let Some(d) = xmp::iso_to_pdf_date(&created) {
            info.set("CreationDate", Object::string_literal(d));
        }
        if let Some(d) = xmp::iso_to_pdf_date(now_iso) {
            info.set("ModDate", Object::string_literal(d));
        }
        if name(info.get(b"Trapped").ok()) == Some(b"Unknown") {
            info.remove(b"Trapped");
        }
        match info_id {
            Some(id) => {
                self.doc.objects.insert(id, Object::Dictionary(info));
            }
            None => {
                let id = self.doc.add_object(info);
                self.doc.trailer.set("Info", id);
            }
        }
        fields
    }

    /// A new XMP packet in the catalog, unfiltered.
    pub(crate) fn set_metadata(
        &mut self,
        fields: &xmp::XmpFields,
        report: &mut Conversion,
    ) -> Result<()> {
        let stream = Stream::new(
            dictionary! { "Type" => "Metadata", "Subtype" => "XML" },
            xmp::packet(fields),
        );
        let id = self.doc.add_object(stream);
        self.doc
            .catalog_mut()
            .map_err(|e| Error::Parse(e.to_string()))?
            .set("Metadata", id);
        report.changes.push(("metadata", String::new()));
        Ok(())
    }
}

fn mime_for(file: &str) -> &'static str {
    let lower = file.to_ascii_lowercase();
    let ext = lower.rsplit('.').next().unwrap_or("");
    match ext {
        "pdf" => "application/pdf",
        "xml" => "text/xml",
        "txt" => "text/plain",
        "csv" => "text/csv",
        "json" => "application/json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "html" | "htm" => "text/html",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

/// Scripts and automatic actions go; forbidden actions go from wherever
/// they are; named actions other than page moves go.
fn remove_actions(copy: &mut PdfDocument, level: Level, report: &mut Conversion) {
    let mut removed = 0usize;
    let forbidden = |d: &Dictionary| {
        let s = name(d.get(b"S").ok()).unwrap_or(b"");
        FORBIDDEN_ACTIONS.contains(&s)
            || (s == b"Named" && !NAMED_ALLOWED.contains(&name(d.get(b"N").ok()).unwrap_or(b"")))
    };
    // Actions held as their own objects.
    let own: BTreeSet<ObjectId> = copy
        .doc
        .objects
        .iter()
        .filter(|(_, o)| {
            o.as_dict().is_ok_and(|d| {
                name(d.get(b"S").ok()).is_some_and(|s| ACTION_TYPES.contains(&s)) && forbidden(d)
            })
        })
        .map(|(id, _)| *id)
        .collect();
    for object in copy.doc.objects.values_mut() {
        visit_dicts_mut(object, 0, &mut |d| {
            if d.remove(b"AA").is_some() {
                removed += 1;
            }
            for key in [b"A".as_slice(), b"OpenAction"] {
                let drop = match d.get(key) {
                    Ok(Object::Dictionary(a)) => forbidden(a),
                    Ok(Object::Reference(id)) => own.contains(id),
                    _ => false,
                };
                if drop {
                    d.remove(key);
                    removed += 1;
                }
            }
            // A chain keeps only its allowed links.
            if let Ok(Object::Array(next)) = d.get_mut(b"Next") {
                next.retain(|a| match a {
                    Object::Dictionary(a) => !forbidden(a),
                    Object::Reference(id) => !own.contains(id),
                    _ => true,
                });
            }
            if matches!(d.get(b"Next"), Ok(Object::Dictionary(a)) if forbidden(a))
                || matches!(d.get(b"Next"), Ok(Object::Reference(id)) if own.contains(id))
            {
                d.remove(b"Next");
            }
        });
    }
    if let Ok(form) = copy.doc.catalog().and_then(|c| c.get(b"AcroForm")).cloned() {
        match form {
            Object::Reference(id) => {
                if let Ok(f) = copy.doc.get_dictionary_mut(id) {
                    f.remove(b"CO");
                }
            }
            Object::Dictionary(_) => {
                if let Ok(Object::Dictionary(f)) =
                    copy.doc.catalog_mut().and_then(|c| c.get_mut(b"AcroForm"))
                {
                    f.remove(b"CO");
                }
            }
            _ => {}
        }
    }
    let _ = level;
    if removed > 0 {
        report.changes.push(("actions", removed.to_string()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const AMIRI: &[u8] = include_bytes!("../../../../../tests/fonts/Amiri-Regular.ttf");
    const INTER: &[u8] =
        include_bytes!("../../../../../tests/fonts/static/Inter-Regular-static.ttf");

    fn corpus(name: &str) -> Vec<u8> {
        std::fs::read(format!(
            "{}/../../../tests/corpus/arabic/{name}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap()
    }

    fn options(level: Level) -> Options<'static> {
        Options {
            level,
            faces: vec![
                Face {
                    name: "Inter",
                    data: INTER,
                    serif: false,
                },
                Face {
                    name: "Amiri",
                    data: AMIRI,
                    serif: true,
                },
            ],
            now: "2026-09-19T10:00:00Z".into(),
            title: Some("Test".into()),
        }
    }

    fn rules(f: &Findings) -> Vec<&'static str> {
        let mut r: Vec<_> = f.items.iter().map(|i| i.rule).collect();
        r.sort();
        r.dedup();
        r
    }

    #[test]
    fn an_ordinary_file_fails_and_says_why() {
        let doc = PdfDocument::open(
            corpus("generated/chrome-notonaskh-justified-3pages.pdf"),
            None,
        )
        .unwrap();
        let findings = doc.pdfa_validate(Level::A2b);
        let r = rules(&findings);
        assert!(
            r.contains(&"metadataMissing") || r.contains(&"pdfaIdentification"),
            "{r:?}"
        );
        assert!(
            r.contains(&"deviceColour") || r.contains(&"outputIntent"),
            "{r:?}"
        );
        assert!(
            findings.items.iter().all(|f| f.clause != "-"),
            "{:?}",
            findings.items
        );
    }

    #[test]
    fn arabic_files_convert_to_pdfa_2b_and_validate() {
        for name in [
            "generated/chrome-notonaskh-justified-3pages.pdf",
            "generated/raw-amiri-cid-identity-tounicode.pdf",
            "generated/chrome-cairo-mixed-invoice.pdf",
            "realworld/A_worldbank_malpass_g7_briefing_AR_word2016_pdftools.pdf",
            "generated/variant-arabic-metadata-outlines-annots.pdf",
        ] {
            let doc = PdfDocument::open(corpus(name), None).unwrap();
            let out = doc.to_pdfa(&options(Level::A2b)).unwrap();
            assert!(out.findings.passed(), "{name}: {:#?}", out.findings.items);
            let reread = PdfDocument::open(out.bytes.clone(), None).unwrap();
            assert_eq!(reread.page_count(), doc.page_count(), "{name}");
            assert!(
                out.bytes.starts_with(b"%PDF-1.7\n%\xE2\xE3\xCF\xD3"),
                "{name}"
            );
        }
    }

    #[test]
    fn a_file_with_fonts_it_does_not_carry_gets_them_embedded() {
        let doc = PdfDocument::open(
            corpus("generated/chrome-windows-arial-tahoma-times.pdf"),
            None,
        )
        .unwrap();
        let before = doc.pdfa_validate(Level::A2b);
        let out = doc.to_pdfa(&options(Level::A2b)).unwrap();
        assert!(out.findings.passed(), "{:#?}", out.findings.items);
        if rules(&before).contains(&"fontNotEmbedded") {
            assert!(!out.substituted.is_empty());
        }
    }

    #[test]
    fn pdfa_2u_needs_unicode_for_every_code() {
        let doc = PdfDocument::open(
            corpus("generated/raw-amiri-cid-identity-tounicode.pdf"),
            None,
        )
        .unwrap();
        let out = doc.to_pdfa(&options(Level::A2u)).unwrap();
        assert!(out.findings.passed(), "{:#?}", out.findings.items);
        let reread = PdfDocument::open(out.bytes, None).unwrap();
        let catalog = reread.doc.catalog().unwrap();
        let meta = resolve(&reread.doc, catalog.get(b"Metadata").unwrap())
            .as_stream()
            .unwrap();
        let packet = String::from_utf8_lossy(&meta.content).into_owned();
        assert_eq!(
            xmp::read_property(&packet, "pdfaid:conformance").as_deref(),
            Some("U")
        );
    }

    #[test]
    fn pdfa_3b_keeps_attachments_and_says_what_they_are() {
        let doc =
            PdfDocument::open(corpus("generated/chrome-cairo-mixed-invoice.pdf"), None).unwrap();
        let out = doc.to_pdfa(&options(Level::A3b)).unwrap();
        assert!(out.findings.passed(), "{:#?}", out.findings.items);
    }

    #[test]
    fn pdfa_1b_is_written_as_pdf_1_4() {
        let doc = PdfDocument::open(
            corpus("generated/raw-amiri-cid-identity-tounicode.pdf"),
            None,
        )
        .unwrap();
        match doc.pdfa_refusal(Level::A1b) {
            None => {
                let out = doc.to_pdfa(&options(Level::A1b)).unwrap();
                assert!(out.findings.passed(), "{:#?}", out.findings.items);
                assert!(out.bytes.starts_with(b"%PDF-1.4"));
            }
            Some(r) => panic!("refused: {r:?}"),
        }
    }

    #[test]
    fn scripts_and_hidden_things_are_taken_out() {
        let bytes = std::fs::read(format!(
            "{}/../../../tests/fixtures/hidden/everything.pdf",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap();
        let doc = PdfDocument::open(bytes, None).unwrap();
        let before = doc.pdfa_validate(Level::A2b);
        assert!(
            rules(&before).contains(&"javascript"),
            "{:?}",
            rules(&before)
        );
        let out = doc.to_pdfa(&options(Level::A2b)).unwrap();
        assert!(out.findings.passed(), "{:#?}", out.findings.items);
        let text = crate::hidden::tests::readable(&out.bytes);
        assert!(!text.contains("DOCJS-SECRET"));
        assert!(!text.contains("OPENACTION-SECRET"));
    }

    #[test]
    fn an_encrypted_file_comes_out_unencrypted() {
        let doc = PdfDocument::open(
            corpus("generated/variant-encrypted-aes256.pdf"),
            Some("warraq"),
        )
        .unwrap();
        assert!(rules(&doc.pdfa_validate(Level::A2b)).contains(&"encrypted"));
        let out = doc.to_pdfa(&options(Level::A2b)).unwrap();
        assert!(out.findings.passed(), "{:#?}", out.findings.items);
        assert!(PdfDocument::open(out.bytes, None).is_ok());
    }

    /// Every Arabic file in the corpus, at every level: converted, read
    /// back, validated. Slow in a debug build; run it with
    /// `cargo test --release -p warraq-pdf whole_corpus -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn the_whole_corpus_converts_at_every_level() {
        let dir = format!(
            "{}/../../../tests/corpus/arabic/",
            env!("CARGO_MANIFEST_DIR")
        );
        let mut names: Vec<String> = vec![];
        for sub in ["generated", "realworld"] {
            for e in std::fs::read_dir(format!("{dir}{sub}")).unwrap() {
                let p = e.unwrap().path();
                if p.extension().is_some_and(|x| x == "pdf") {
                    names.push(format!(
                        "{sub}/{}",
                        p.file_name().unwrap().to_string_lossy()
                    ));
                }
            }
        }
        names.sort();
        let mut failed = vec![];
        let mut refused = vec![];
        let mut converted = 0;
        for level in [Level::A2b, Level::A2u, Level::A3b, Level::A1b] {
            for name in &names {
                let bytes = std::fs::read(format!("{dir}{name}")).unwrap();
                let password = (name.contains("encrypted") && !name.contains("owner-only"))
                    .then_some("warraq");
                let doc = PdfDocument::open(bytes, password).unwrap();
                if let Some(why) = doc.pdfa_refusal(level) {
                    refused.push(format!("{} {name}: {why:?}", level.key()));
                    continue;
                }
                let out = doc.to_pdfa(&options(level)).unwrap();
                converted += 1;
                let reread = PdfDocument::open(out.bytes, None).unwrap();
                assert_eq!(reread.page_count(), doc.page_count(), "{name}");
                if !out.findings.passed() {
                    failed.push(format!(
                        "{} {name}: {:?}",
                        level.key(),
                        out.findings
                            .items
                            .iter()
                            .map(|i| format!("{} {}", i.rule, i.detail))
                            .collect::<Vec<_>>()
                    ));
                }
            }
        }
        println!(
            "converted {converted}; refused {}; failed {}",
            refused.len(),
            failed.len()
        );
        for r in &refused {
            println!("  refused {r}");
        }
        for f in &failed {
            println!("  failed {f}");
        }
        // A Chinese font the file does not carry, named by a GB1 CMap: its
        // codes cannot be turned into characters, so nothing can stand in.
        let known = |f: &String| f.contains("B_baytalhekma") && f.contains("fontNotEmbedded");
        assert!(failed.iter().all(known), "{failed:#?}");
    }
}
