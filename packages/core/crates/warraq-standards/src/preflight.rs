//! Preflight: a summary of what a document contains, independent of any target standard.

use crate::fonts;
use crate::icc;
use crate::model::{self, dict, get, get_dict, get_name, get_num, name_str, num, Key};
use crate::xmp;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use warraq_pdf::lopdf::{Object, ObjectId};
use warraq_pdf::{metadata, Pdf};

/// Most page-box rows reported.
const MAX_BOX_PAGES: usize = 500;
/// Most images listed.
const MAX_IMAGES: usize = 500;
/// Most fonts listed.
const MAX_FONTS: usize = 500;

fn r(id: ObjectId) -> String {
    format!("{} {} R", id.0, id.1)
}

fn family(pdf: &Pdf, cs: &Object) -> String {
    match pdf.resolve(cs) {
        Some(Object::Name(n)) => name_str(n),
        Some(Object::Array(a)) => a
            .first()
            .and_then(|o| pdf.resolve(o))
            .and_then(|o| o.as_name().ok())
            .map(name_str)
            .unwrap_or_default(),
        _ => String::new(),
    }
}

fn boxes(pdf: &Pdf, id: ObjectId) -> Map<String, Value> {
    let mut m = Map::new();
    for key in ["MediaBox", "CropBox", "BleedBox", "TrimBox", "ArtBox"] {
        let mut cur = pdf.get_dict(id);
        let mut depth = 0;
        while let Some(d) = cur {
            if let Some(Object::Array(a)) = get(pdf, d, key.as_bytes()) {
                let v: Vec<f64> = a
                    .iter()
                    .filter_map(|o| pdf.resolve(o).and_then(num))
                    .collect();
                if v.len() == 4 {
                    let lower = match key {
                        "MediaBox" => "mediaBox",
                        "CropBox" => "cropBox",
                        "BleedBox" => "bleedBox",
                        "TrimBox" => "trimBox",
                        _ => "artBox",
                    };
                    m.insert(lower.into(), json!(v));
                }
                break;
            }
            if !matches!(key, "MediaBox" | "CropBox") || depth > 64 {
                break;
            }
            depth += 1;
            cur = get_dict(pdf, d, b"Parent");
        }
    }
    m
}

/// Summarise a document.
pub fn preflight(pdf: &Pdf) -> Value {
    let m = model::build(pdf);
    // Fonts.
    let mut fonts_out = Vec::new();
    for (k, page) in m.fonts.iter().take(MAX_FONTS) {
        let Some(d) = model::font_dict(pdf, k, true) else {
            continue;
        };
        let fi = fonts::info(pdf, d);
        let encoding = match get(pdf, d, b"Encoding") {
            Some(Object::Name(n)) => name_str(n),
            Some(Object::Dictionary(e)) => get_name(pdf, e, b"BaseEncoding")
                .map(|n| format!("{} + Differences", name_str(n)))
                .unwrap_or_else(|| "Differences".into()),
            Some(Object::Stream(_)) => "embedded CMap".into(),
            _ => String::new(),
        };
        let subtype = match fi.descendant.and_then(|dd| get_name(pdf, dd, b"Subtype")) {
            Some(s) => format!("{} ({})", fi.subtype, name_str(s)),
            None => fi.subtype.clone(),
        };
        fonts_out.push(json!({
            "object": ref_id_of(k),
            "name": fi.base_font,
            "type": subtype,
            "embedded": fi.embedded(),
            "subset": fi.is_subset(),
            "program": fi.program.map(|(key, _)| key),
            "encoding": encoding,
            "toUnicode": d.has(b"ToUnicode"),
            "firstPage": page.map(|p| p + 1),
            "substitute": if fi.embedded() { None } else { fonts::substitute_for(&fi.base_font) },
        }));
    }
    // Images.
    let mut images = Vec::new();
    for (id, page) in m.images.iter().take(MAX_IMAGES) {
        let Some(Object::Stream(s)) = pdf.get(*id) else {
            continue;
        };
        let d = &s.dict;
        let dpis: Vec<f64> = m
            .placements
            .get(id)
            .map(|v| v.iter().map(|p| p.dpi.0.min(p.dpi.1)).collect())
            .unwrap_or_default();
        let min = dpis.iter().copied().fold(f64::INFINITY, f64::min);
        let max = dpis.iter().copied().fold(0.0, f64::max);
        let filters = match get(pdf, d, b"Filter") {
            Some(Object::Name(n)) => vec![name_str(n)],
            Some(Object::Array(a)) => a
                .iter()
                .filter_map(|o| o.as_name().ok().map(name_str))
                .collect(),
            _ => Vec::new(),
        };
        images.push(json!({
            "object": r(*id),
            "width": get_num(pdf, d, b"Width"),
            "height": get_num(pdf, d, b"Height"),
            "bitsPerComponent": get_num(pdf, d, b"BitsPerComponent"),
            "colourSpace": d.get(b"ColorSpace").ok().map(|cs| family(pdf, cs)),
            "imageMask": matches!(get(pdf, d, b"ImageMask"), Some(Object::Boolean(true))),
            "filters": filters,
            "softMask": d.has(b"SMask"),
            "interpolate": matches!(get(pdf, d, b"Interpolate"), Some(Object::Boolean(true))),
            "placements": dpis.len(),
            "minDpi": if dpis.is_empty() { None } else { Some((min * 10.0).round() / 10.0) },
            "maxDpi": if dpis.is_empty() { None } else { Some((max * 10.0).round() / 10.0) },
            "firstPage": page.map(|p| p + 1),
        }));
    }
    // Colour spaces.
    let mut spaces: BTreeMap<String, usize> = BTreeMap::new();
    for (_, _, cs) in &m.colour_spaces {
        let f = family(pdf, cs);
        if !f.is_empty() {
            *spaces.entry(f).or_insert(0) += 1;
        }
    }
    let mut device_uses: BTreeMap<&str, usize> = BTreeMap::new();
    for u in &m.colour_uses {
        *device_uses.entry(u.device.name()).or_insert(0) += 1;
    }
    // Transparency.
    let mut soft = 0usize;
    let mut alpha = 0usize;
    let mut blends: BTreeMap<String, usize> = BTreeMap::new();
    for k in m.extgstates.keys() {
        let gs = match k {
            Key::Obj(id) => pdf.get_dict(*id),
            Key::Direct(..) => None,
        };
        let Some(gs) = gs else { continue };
        if gs
            .get(b"SMask")
            .ok()
            .and_then(|o| pdf.resolve(o))
            .is_some_and(|o| o.as_name().ok() != Some(b"None"))
        {
            soft += 1;
        }
        if ["CA", "ca"]
            .iter()
            .any(|k| get_num(pdf, gs, k.as_bytes()).is_some_and(|v| v < 1.0))
        {
            alpha += 1;
        }
        if let Some(n) = get_name(pdf, gs, b"BM") {
            if n != b"Normal" && n != b"Compatible" {
                *blends.entry(name_str(n)).or_insert(0) += 1;
            }
        }
    }
    let image_smasks = m
        .images
        .keys()
        .filter(|id| pdf.get_dict(**id).is_some_and(|d| d.has(b"SMask")))
        .count();
    let mut groups = 0usize;
    for id in m.pages.iter().map(|p| p.id).chain(m.forms.keys().copied()) {
        if pdf
            .get_dict(id)
            .and_then(|d| get_dict(pdf, d, b"Group"))
            .is_some_and(|g| get_name(pdf, g, b"S") == Some(b"Transparency"))
        {
            groups += 1;
        }
    }
    // Annotations.
    let mut annots: BTreeMap<String, usize> = BTreeMap::new();
    for a in &m.annots {
        let t = model::annot_dict(pdf, a)
            .and_then(|d| get_name(pdf, d, b"Subtype"))
            .map(name_str)
            .unwrap_or_else(|| "?".into());
        *annots.entry(t).or_insert(0) += 1;
    }
    // Forms, JavaScript, catalog facts.
    let cat = pdf.catalog().ok();
    let af = cat.and_then(|c| get_dict(pdf, c, b"AcroForm"));
    let mut fields = 0usize;
    if let Some(Object::Array(top)) = af.and_then(|a| get(pdf, a, b"Fields")) {
        let mut stack: Vec<&Object> = top.iter().collect();
        while let Some(o) = stack.pop() {
            fields += 1;
            if fields > 100_000 {
                break;
            }
            if let Some(Object::Array(kids)) = dict(pdf, o).and_then(|d| get(pdf, d, b"Kids")) {
                // Kids that are fields (have /T) count; pure widgets do not.
                for k in kids {
                    if dict(pdf, k).is_some_and(|d| d.has(b"T")) {
                        stack.push(k);
                    }
                }
            }
        }
    }
    let mut js = 0usize;
    for id in pdf.reachable().unwrap_or_default() {
        if let Some(d) = pdf.get_dict(id) {
            if get_name(pdf, d, b"S") == Some(b"JavaScript") {
                js += 1;
            }
        }
    }
    let js_tree = cat
        .and_then(|c| get_dict(pdf, c, b"Names"))
        .is_some_and(|n| n.has(b"JavaScript"));
    let open_js = cat
        .and_then(|c| c.get(b"OpenAction").ok())
        .and_then(|o| dict(pdf, o))
        .is_some_and(|d| get_name(pdf, d, b"S") == Some(b"JavaScript"));
    let mut intents = Vec::new();
    if let Some(Object::Array(ois)) = cat.and_then(|c| get(pdf, c, b"OutputIntents")) {
        for o in ois {
            let Some(d) = dict(pdf, o) else { continue };
            let h = d
                .get(b"DestOutputProfile")
                .ok()
                .and_then(|p| model::stream(pdf, p))
                .and_then(|s| model::decoded(pdf, s))
                .and_then(|b| icc::parse_header(&b).ok());
            intents.push(json!({
                "subtype": get_name(pdf, d, b"S").map(name_str),
                "identifier": get(pdf, d, b"OutputConditionIdentifier").and_then(|o| o.as_str().ok()).map(metadata::decode_text),
                "colourSpace": h.as_ref().map(|h| h.space_str()),
                "profileClass": h.as_ref().map(|h| h.class_str()),
                "iccVersion": h.as_ref().map(|h| format!("{}.{}", h.major, h.minor)),
            }));
        }
    }
    let xmp = metadata::get_xmp(pdf)
        .ok()
        .flatten()
        .and_then(|s| xmp::parse(s.as_bytes()).ok());
    let pdfa = xmp.as_ref().and_then(|x| {
        let p = x.get(xmp::NS_PDFAID, "part")?;
        Some(format!(
            "PDF/A-{}{}",
            p,
            x.get(xmp::NS_PDFAID, "conformance")
                .unwrap_or("")
                .to_ascii_lowercase()
        ))
    });
    let pdfx = xmp
        .as_ref()
        .and_then(|x| x.get(xmp::NS_PDFXID, "GTS_PDFXVersion").map(str::to_string));
    let page_boxes: Vec<Value> = m
        .pages
        .iter()
        .take(MAX_BOX_PAGES)
        .enumerate()
        .map(|(i, p)| {
            let mut b = boxes(pdf, p.id);
            b.insert("page".into(), json!(i + 1));
            b.insert("rotate".into(), json!(p.rotate));
            Value::Object(b)
        })
        .collect();
    let encryption = pdf.security().map(|s| {
        json!({
            "revision": s.r,
            "matched": s.matched.as_str(),
        })
    });
    json!({
        "version": pdf.version(),
        "pageCount": m.pages.len(),
        "encrypted": pdf.is_encrypted(),
        "encryption": encryption,
        "tagged": cat.and_then(|c| get_dict(pdf, c, b"MarkInfo")).is_some_and(|mi| matches!(get(pdf, mi, b"Marked"), Some(Object::Boolean(true)))),
        "language": cat.and_then(|c| get(pdf, c, b"Lang")).and_then(|o| o.as_str().ok()).map(metadata::decode_text),
        "claims": { "pdfa": pdfa, "pdfx": pdfx },
        "outputIntents": intents,
        "fonts": fonts_out,
        "fontCount": m.fonts.len(),
        "images": images,
        "imageCount": m.images.len(),
        "inlineImages": m.inline_images.len(),
        "colourSpaces": spaces,
        "deviceColourUses": device_uses,
        "transparency": {
            "softMasks": soft + image_smasks,
            "constantAlpha": alpha,
            "blendModes": blends,
            "groups": groups,
            "used": soft + image_smasks + alpha + blends.len() > 0 || groups > 0,
        },
        "annotations": annots,
        "forms": {
            "fields": fields,
            "xfa": af.is_some_and(|a| a.has(b"XFA")),
            "needAppearances": af.is_some_and(|a| matches!(get(pdf, a, b"NeedAppearances"), Some(Object::Boolean(true)))),
        },
        "javascript": { "actions": js, "nameTree": js_tree, "openAction": open_js },
        "embeddedFiles": crate::validate::filespecs(pdf).len(),
        "optionalContent": cat.is_some_and(|c| c.has(b"OCProperties")),
        "pageBoxes": page_boxes,
        "incomplete": m.incomplete,
    })
}

fn ref_id_of(k: &Key) -> Option<String> {
    match k {
        Key::Obj(id) => Some(r(*id)),
        Key::Direct(..) => None,
    }
}
