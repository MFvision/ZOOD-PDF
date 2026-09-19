//! PDF/X-4 (ISO 15930-7:2010): a copy of the file for a print shop, and a
//! validator for the rules Warraq implements.
//!
//! The output intent is the printing condition the file is made for, as an
//! ICC output profile. Warraq ships none a press could use: the published
//! characterizations (FOGRA, GRACoL, Japan Color) are not under a licence
//! that lets them be bundled, and a made-up one would describe no real
//! press. The person converting chooses the profile their printer gave
//! them — a `.icc` file of the output (`prtr`) class — and names the
//! condition. Colour is not converted: PDF/X-4 leaves that to the press,
//! and what the file draws in device RGB is made device-independent (sRGB)
//! so the press knows what it meant.
//!
//! Also done: fonts the file does not carry are embedded (bundled faces,
//! said by name); comments and form fields that would print are drawn into
//! the page and taken out, links kept (they do not print); every page gets
//! a trim box (its crop box, unless it has one) and, if asked, a bleed box
//! round it; scripts and automatic actions go; encryption goes; the XMP
//! says PDF/X-4, with the identifiers, dates and `Trapped` it requires. The
//! file is written whole as PDF 1.6.
use std::collections::BTreeSet;

use lopdf::{dictionary, Dictionary, Object, ObjectId, Stream};

use super::fonts::{self, Face};
use super::pdfa::Conversion;
use super::scan::ScanOptions;
use super::{dict_of, icc, md5_hex, name, resolve, uuid_from, xmp, Finding, Findings};
use crate::pagework::open_saves;
use crate::{Error, PdfDocument, Result};

/// Every rule the validator checks, and the part of ISO 15930-7 it is in.
pub const RULES: &[(&str, &str)] = &[
    ("header", "file structure"),
    ("encrypted", "file structure"),
    ("trailerId", "file structure"),
    ("outputIntent", "output intent"),
    ("deviceColour", "colour"),
    ("fontNotEmbedded", "fonts"),
    ("trimBox", "page boxes"),
    ("boxNesting", "page boxes"),
    ("annotationPrints", "annotations"),
    ("javascript", "actions"),
    ("additionalActions", "actions"),
    ("transferFunction", "graphics state"),
    ("postscript", "content"),
    ("metadata", "metadata"),
    ("title", "metadata"),
    ("trapped", "metadata"),
];

fn clause(rule: &str) -> &'static str {
    RULES
        .iter()
        .find(|(k, _)| *k == rule)
        .map(|(_, c)| *c)
        .unwrap_or("-")
}

/// A box of a page, inherited as the page tree says.
fn page_box(pdf: &PdfDocument, page: ObjectId, key: &[u8]) -> Option<[f32; 4]> {
    let dict = pdf.doc.get_dictionary(page).ok()?;
    pdf.rect(pdf.inherited(dict, key))
}

fn inside(inner: [f32; 4], outer: [f32; 4]) -> bool {
    const SLACK: f32 = 0.01;
    inner[0] >= outer[0] - SLACK
        && inner[1] >= outer[1] - SLACK
        && inner[2] <= outer[2] + SLACK
        && inner[3] <= outer[3] + SLACK
}

fn intersects(a: [f32; 4], b: [f32; 4]) -> bool {
    a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]
}

pub struct Options<'a> {
    /// The printer's ICC output profile.
    pub profile: &'a [u8],
    /// The printing condition's name (`OutputConditionIdentifier`); the
    /// profile's own description when not given.
    pub condition: Option<String>,
    pub faces: Vec<Face<'a>>,
    pub now: String,
    pub title: Option<String>,
    /// Bleed round the trim box, in points; 0 for none.
    pub bleed: f32,
}

impl PdfDocument {
    /// Validates this file against PDF/X-4: see `RULES`.
    pub fn pdfx_validate(&self) -> Findings {
        let doc = &self.doc;
        let bytes = self.original_bytes();
        let scan = self.scan_content(ScanOptions::default());
        let mut out = Findings::default();
        let mut fail =
            |rule: &'static str, detail: String, page: Option<usize>, object: Option<ObjectId>| {
                out.push(Finding {
                    clause: clause(rule),
                    rule,
                    detail,
                    page,
                    object,
                })
            };
        if !(bytes.starts_with(b"%PDF-1.")
            && bytes.get(7).is_some_and(|d| (b'0'..=b'6').contains(d)))
        {
            fail(
                "header",
                String::from_utf8_lossy(&bytes[..bytes.len().min(8)]).into_owned(),
                None,
                None,
            );
        }
        if self.was_encrypted() || doc.trailer.has(b"Encrypt") {
            fail("encrypted", String::new(), None, None);
        }
        if !doc.trailer.has(b"ID") {
            fail("trailerId", String::new(), None, None);
        }
        // The output intent.
        let intents: Vec<&Dictionary> = doc
            .catalog()
            .ok()
            .and_then(|c| c.get(b"OutputIntents").ok())
            .map(|o| resolve(doc, o))
            .and_then(|o| o.as_array().ok())
            .map(|a| a.iter().filter_map(|i| dict_of(doc, Some(i))).collect())
            .unwrap_or_default();
        let pdfx: Vec<&&Dictionary> = intents
            .iter()
            .filter(|i| name(i.get(b"S").ok()) == Some(b"GTS_PDFX"))
            .collect();
        let mut space = None;
        match pdfx.as_slice() {
            [one] => {
                if !one.has(b"OutputConditionIdentifier") {
                    fail(
                        "outputIntent",
                        "OutputConditionIdentifier".into(),
                        None,
                        None,
                    );
                }
                let profile = one
                    .get(b"DestOutputProfile")
                    .ok()
                    .map(|p| resolve(doc, p))
                    .and_then(|p| p.as_stream().ok());
                match profile {
                    None => fail("outputIntent", "DestOutputProfile".into(), None, None),
                    Some(s) => {
                        let bytes = s
                            .decompressed_content_with_limit(8 << 20)
                            .ok()
                            .or_else(|| (!s.dict.has(b"Filter")).then(|| s.content.clone()));
                        match bytes.as_deref().and_then(icc::read) {
                            None => fail("outputIntent", "not a profile".into(), None, None),
                            Some(info) => {
                                if info.class != "prtr" {
                                    fail(
                                        "outputIntent",
                                        format!("class {}", info.class),
                                        None,
                                        None,
                                    );
                                }
                                let n = s.dict.get(b"N").ok().and_then(|n| n.as_i64().ok());
                                if n != Some(info.components) {
                                    fail("outputIntent", "N".into(), None, None);
                                }
                                space = Some(info.space);
                            }
                        }
                    }
                }
            }
            [] => fail("outputIntent", String::new(), None, None),
            _ => fail("outputIntent", "more than one".into(), None, None),
        }
        for (page, p) in scan.pages.iter().enumerate() {
            let c = &p.colours;
            if c.bare_rgb && space.as_deref() != Some("RGB ") {
                fail("deviceColour", "DeviceRGB".into(), Some(page), None);
            }
            if c.bare_cmyk && space.as_deref() != Some("CMYK") {
                fail("deviceColour", "DeviceCMYK".into(), Some(page), None);
            }
            if p.transfer {
                fail("transferFunction", String::new(), Some(page), None);
            }
            if p.postscript {
                fail("postscript", String::new(), Some(page), None);
            }
        }
        for font in &scan.fonts {
            let facts = fonts::facts(doc, &font.dict);
            if !facts.embedded() && font.visible {
                fail(
                    "fontNotEmbedded",
                    facts.base_font.clone(),
                    font.pages.iter().next().copied(),
                    font.id,
                );
            }
        }
        // Boxes and what prints inside them.
        for (index, page) in self.pages.iter().enumerate() {
            let media = page_box(self, *page, b"MediaBox").unwrap_or([0.0, 0.0, 612.0, 792.0]);
            let trim = page_box(self, *page, b"TrimBox");
            let art = page_box(self, *page, b"ArtBox");
            let bleed = page_box(self, *page, b"BleedBox");
            let own = self.doc.get_dictionary(*page).ok();
            let has = |k: &[u8]| own.is_some_and(|d| d.has(k));
            if !has(b"TrimBox") && !has(b"ArtBox") {
                fail("trimBox", String::new(), Some(index), Some(*page));
            }
            if has(b"TrimBox") && has(b"ArtBox") {
                fail(
                    "trimBox",
                    "TrimBox and ArtBox".into(),
                    Some(index),
                    Some(*page),
                );
            }
            let outer = bleed.unwrap_or(media);
            if bleed.is_some_and(|b| !inside(b, media)) {
                fail("boxNesting", "BleedBox".into(), Some(index), Some(*page));
            }
            for (label, b) in [("TrimBox", trim), ("ArtBox", art)] {
                if b.is_some_and(|b| !inside(b, outer)) {
                    fail("boxNesting", label.into(), Some(index), Some(*page));
                }
            }
            for (id, annot) in self.page_annotations(*page) {
                let subtype = name(annot.get(b"Subtype").ok()).unwrap_or(b"");
                if matches!(subtype, b"PrinterMark" | b"TrapNet" | b"Link" | b"Popup") {
                    continue;
                }
                let flags = annot
                    .get(b"F")
                    .ok()
                    .and_then(|f| f.as_i64().ok())
                    .unwrap_or(0);
                if flags & 4 == 0 || flags & 2 != 0 {
                    continue;
                }
                if self
                    .rect(annot.get(b"Rect").ok())
                    .is_some_and(|r| intersects(r, outer))
                {
                    fail(
                        "annotationPrints",
                        String::from_utf8_lossy(subtype).into_owned(),
                        Some(index),
                        id,
                    );
                }
            }
        }
        // Actions.
        if doc
            .catalog()
            .ok()
            .and_then(|c| dict_of(doc, c.get(b"Names").ok()))
            .is_some_and(|n| n.has(b"JavaScript"))
        {
            fail("javascript", "Names".into(), None, None);
        }
        for (id, object) in &doc.objects {
            let d = match object {
                Object::Dictionary(d) => d,
                Object::Stream(s) => &s.dict,
                _ => continue,
            };
            if d.has(b"AA") {
                fail("additionalActions", String::new(), None, Some(*id));
            }
            if name(d.get(b"S").ok()) == Some(b"JavaScript") {
                fail("javascript", String::new(), None, Some(*id));
            }
        }
        // Metadata.
        let packet = doc
            .catalog()
            .ok()
            .and_then(|c| c.get(b"Metadata").ok())
            .map(|m| resolve(doc, m))
            .and_then(|m| m.as_stream().ok())
            .map(|s| {
                String::from_utf8_lossy(
                    &s.decompressed_content_with_limit(8 << 20)
                        .unwrap_or_else(|_| s.content.clone()),
                )
                .into_owned()
            });
        match packet {
            None => fail("metadata", "XMP".into(), None, None),
            Some(p) => {
                if xmp::read_property(&p, "pdfxid:GTS_PDFXVersion").as_deref() != Some("PDF/X-4") {
                    fail("metadata", "pdfxid:GTS_PDFXVersion".into(), None, None);
                }
                for prop in [
                    "xmpMM:DocumentID",
                    "xmpMM:VersionID",
                    "xmpMM:RenditionClass",
                    "xmp:CreateDate",
                    "xmp:ModifyDate",
                ] {
                    if xmp::read_property(&p, prop).is_none() {
                        fail("metadata", prop.into(), None, None);
                    }
                }
                if !matches!(
                    xmp::read_property(&p, "pdf:Trapped").as_deref(),
                    Some("True" | "False")
                ) {
                    fail("trapped", "pdf:Trapped".into(), None, None);
                }
            }
        }
        let info = dict_of(doc, doc.trailer.get(b"Info").ok());
        if info
            .and_then(|i| i.get(b"Title").ok())
            .and_then(|t| t.as_str().ok())
            .is_none_or(|t| t.is_empty())
        {
            fail("title", String::new(), None, None);
        }
        if !matches!(
            info.and_then(|i| name(i.get(b"Trapped").ok())),
            Some(b"True" | b"False")
        ) {
            fail("trapped", "Info".into(), None, None);
        }
        out
    }

    /// A PDF/X-4 copy of this document: see the module documentation.
    pub fn to_pdfx(&self, options: &Options<'_>) -> Result<Conversion> {
        if super::is_signed(&self.doc) {
            return Err(Error::Edit("a signed file cannot be written whole".into()));
        }
        let info = icc::read(options.profile)
            .ok_or_else(|| Error::Edit("E_PROFILE: that is not an ICC profile".into()))?;
        if info.class != "prtr" || !info.bidirectional {
            return Err(Error::Edit(format!(
                "E_PROFILE: an output (printer) profile is needed, this one is {}",
                info.class
            )));
        }
        if !matches!(info.space.as_str(), "CMYK" | "GRAY" | "RGB ") {
            return Err(Error::Edit(format!("E_PROFILE: a {} profile", info.space)));
        }
        let mut report = Conversion::default();
        let mut copy = self.detached_copy();
        copy.was_encrypted = false;
        copy.sealer = None;
        for key in [b"Encrypt".as_slice(), b"Prev", b"XRefStm"] {
            copy.doc.trailer.remove(key);
        }
        // Scripts and automatic actions.
        let mut actions = 0;
        for object in copy.doc.objects.values_mut() {
            super::visit_dicts_mut(object, 0, &mut |d| {
                if d.remove(b"AA").is_some() {
                    actions += 1;
                }
                for key in [b"A".as_slice(), b"OpenAction"] {
                    if matches!(d.get(key), Ok(Object::Dictionary(a)) if name(a.get(b"S").ok()) == Some(b"JavaScript"))
                    {
                        d.remove(key);
                        actions += 1;
                    }
                }
            });
        }
        let scripts: Vec<ObjectId> = copy
            .doc
            .objects
            .iter()
            .filter(|(_, o)| {
                o.as_dict()
                    .is_ok_and(|d| name(d.get(b"S").ok()) == Some(b"JavaScript"))
            })
            .map(|(id, _)| *id)
            .collect();
        for object in copy.doc.objects.values_mut() {
            super::visit_dicts_mut(object, 0, &mut |d| {
                for key in [b"A".as_slice(), b"OpenAction", b"Next"] {
                    if matches!(d.get(key), Ok(Object::Reference(id)) if scripts.contains(id)) {
                        d.remove(key);
                    }
                }
            });
        }
        if let Some(names) = copy
            .doc
            .catalog()
            .ok()
            .and_then(|c| c.get(b"Names").ok())
            .and_then(|n| n.as_reference().ok())
        {
            if let Ok(n) = copy.doc.get_dictionary_mut(names) {
                n.remove(b"JavaScript");
            }
        } else if let Ok(Object::Dictionary(n)) =
            copy.doc.catalog_mut().and_then(|c| c.get_mut(b"Names"))
        {
            n.remove(b"JavaScript");
        }
        if actions > 0 {
            report.changes.push(("actions", actions.to_string()));
        }

        // What prints goes into the page.
        let flattened = copy.flatten_printing_annotations();
        if flattened > 0 {
            report
                .changes
                .push(("annotationsFlattened", flattened.to_string()));
        }

        // Fonts.
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
            }
        }

        // The output intent, alone.
        let components = info.components;
        let mut profile = Stream::new(dictionary! { "N" => components }, options.profile.to_vec());
        let _ = profile.compress();
        let profile = copy.doc.add_object(profile);
        let condition = options
            .condition
            .clone()
            .filter(|c| !c.trim().is_empty())
            .or(info.description.clone())
            .unwrap_or_else(|| "Custom".into());
        let intent = copy.doc.add_object(dictionary! {
            "Type" => "OutputIntent",
            "S" => "GTS_PDFX",
            "OutputConditionIdentifier" => lopdf::text_string(&condition),
            "OutputCondition" => lopdf::text_string(&condition),
            "Info" => lopdf::text_string(info.description.as_deref().unwrap_or(&condition)),
            "RegistryName" => Object::string_literal("http://www.color.org"),
            "DestOutputProfile" => profile,
        });
        if let Ok(catalog) = copy.doc.catalog_mut() {
            catalog.set("OutputIntents", vec![Object::Reference(intent)]);
        }
        report.changes.push(("outputIntent", condition.clone()));
        if info.space != "RGB " {
            let rgb = icc::add_profile(&mut copy.doc, icc::SRGB, 3);
            copy.replace_device_space(b"DeviceRGB", rgb);
        }
        if info.space != "CMYK" {
            let cmyk = icc::add_profile(&mut copy.doc, icc::CMYK_SWOP, 4);
            copy.replace_device_space(b"DeviceCMYK", cmyk);
        }
        for object in copy.doc.objects.values_mut() {
            super::visit_dicts_mut(object, 0, &mut |d| {
                if d.has(b"TR") && !d.has(b"FunctionType") && !d.has(b"Subtype") {
                    d.remove(b"TR");
                }
            });
        }

        // Boxes.
        let mut boxes = 0;
        for page in copy.pages.clone() {
            let media = page_box(&copy, page, b"MediaBox").unwrap_or([0.0, 0.0, 612.0, 792.0]);
            let crop = page_box(&copy, page, b"CropBox").unwrap_or(media);
            let clip = |b: [f32; 4]| {
                [
                    b[0].max(media[0]),
                    b[1].max(media[1]),
                    b[2].min(media[2]),
                    b[3].min(media[3]),
                ]
            };
            let own_trim = copy
                .doc
                .get_dictionary(page)
                .ok()
                .is_some_and(|d| d.has(b"TrimBox"));
            let own_art = copy
                .doc
                .get_dictionary(page)
                .ok()
                .is_some_and(|d| d.has(b"ArtBox"));
            let trim = page_box(&copy, page, b"TrimBox")
                .or_else(|| page_box(&copy, page, b"ArtBox"))
                .map(clip)
                .unwrap_or_else(|| clip(crop));
            let bleed = if options.bleed > 0.0 {
                Some(clip([
                    trim[0] - options.bleed,
                    trim[1] - options.bleed,
                    trim[2] + options.bleed,
                    trim[3] + options.bleed,
                ]))
            } else {
                page_box(&copy, page, b"BleedBox").map(|b| {
                    let b = clip(b);
                    [
                        b[0].min(trim[0]),
                        b[1].min(trim[1]),
                        b[2].max(trim[2]),
                        b[3].max(trim[3]),
                    ]
                })
            };
            let r = |b: [f32; 4]| Object::Array(b.iter().map(|v| Object::Real(*v)).collect());
            if let Ok(d) = copy.doc.get_dictionary_mut(page) {
                if own_art && own_trim {
                    d.remove(b"ArtBox");
                }
                if own_art && !own_trim {
                    d.set("ArtBox", r(trim));
                } else {
                    d.set("TrimBox", r(trim));
                }
                if let Some(b) = bleed {
                    d.set("BleedBox", r(b));
                }
                boxes += 1;
            }
        }
        report.changes.push(("trimBox", boxes.to_string()));

        // Metadata.
        let now_iso = xmp::normalise_iso(&options.now)
            .ok_or_else(|| Error::Edit(format!("{} is not a date", options.now)))?;
        let fallback = options.title.clone().or_else(|| Some("Untitled".into()));
        let mut fields = copy.info_fields(fallback.as_deref(), &now_iso);
        let (_, hex) = md5_hex(self.original_bytes());
        fields.document_id = Some(uuid_from(hex.as_bytes()));
        fields.instance_id = Some(uuid_from(format!("{hex}{now_iso}").as_bytes()));
        fields.pdfx = Some("PDF/X-4".into());
        fields.trapped = Some(false);
        if let Some(info_id) = copy
            .doc
            .trailer
            .get(b"Info")
            .ok()
            .and_then(|i| i.as_reference().ok())
        {
            if let Ok(info) = copy.doc.get_dictionary_mut(info_id) {
                info.set("Trapped", Object::Name(b"False".to_vec()));
            }
        }
        copy.set_metadata(&fields, &mut report)?;

        copy.prune_unreachable();
        copy.doc.version = "1.6".into();
        let bytes = copy.write_whole_version()?;
        let reread = PdfDocument::open(bytes.clone(), None)?;
        report.findings = reread.pdfx_validate();
        report.bytes = bytes;
        Ok(report)
    }

    /// Draws every annotation that would print — a comment, a stamp, a form
    /// field — into its page, and takes it out; links and pop-ups stay (they
    /// do not print), and the form's fields go with their widgets. The
    /// page's own streams are kept: the drawing is a stream after them.
    pub(crate) fn flatten_printing_annotations(&mut self) -> usize {
        let mut count = 0;
        for page in self.pages.clone() {
            let annots: Vec<(Option<ObjectId>, Dictionary)> = self
                .page_annotations(page)
                .into_iter()
                .map(|(id, d)| (id, d.clone()))
                .collect();
            let mut drawing = String::new();
            let mut forms: Vec<(ObjectId, [f32; 6])> = vec![];
            let mut gone: BTreeSet<Option<ObjectId>> = BTreeSet::new();
            for (id, annot) in &annots {
                let subtype = name(annot.get(b"Subtype").ok()).unwrap_or(b"");
                if matches!(subtype, b"Link" | b"PrinterMark" | b"TrapNet") {
                    continue;
                }
                if subtype == b"Popup" {
                    gone.insert(*id);
                    continue;
                }
                let flags = annot
                    .get(b"F")
                    .ok()
                    .and_then(|f| f.as_i64().ok())
                    .unwrap_or(0);
                if flags & 4 != 0 && flags & 2 == 0 {
                    if let Some((stream, m)) = self.flattened_placement(annot) {
                        forms.push((stream, m.0));
                    }
                }
                gone.insert(*id);
            }
            if gone.is_empty() {
                continue;
            }
            if !forms.is_empty() {
                let _ = self.own_resources(page);
                for (stream, m) in &forms {
                    let Ok(name) = self.add_xobject(page, "WqFlat", *stream) else {
                        continue;
                    };
                    drawing.push_str(&format!(
                        "q {} {} {} {} {} {} cm /{} Do Q\n",
                        m[0],
                        m[1],
                        m[2],
                        m[3],
                        m[4],
                        m[5],
                        String::from_utf8_lossy(&name)
                    ));
                    count += 1;
                }
                let streams = self.content_ids(page);
                let open: usize = streams
                    .iter()
                    .map(|id| self.stream_bytes(*id).map(|b| open_saves(&b)).unwrap_or(0))
                    .sum();
                let before = self.new_stream(Dictionary::new(), b"q\n".to_vec());
                let mut tail = "\n".to_string();
                tail.push_str(&"Q\n".repeat(open + 1));
                tail.push_str(&drawing);
                let after = self.new_stream(Dictionary::new(), tail.into_bytes());
                let mut contents = vec![Object::Reference(before)];
                contents.extend(streams.iter().map(|id| Object::Reference(*id)));
                contents.push(Object::Reference(after));
                let _ = self.set_contents(page, Object::Array(contents));
            }
            self.keep_annotations(page, |id, _| !gone.contains(&id));
        }
        // The fields' widgets are gone from the pages: the form goes too.
        let had_form = self.doc.catalog().is_ok_and(|c| c.has(b"AcroForm"));
        let widgets_left = self.pages.clone().iter().any(|p| {
            self.page_annotations(*p)
                .iter()
                .any(|(_, a)| name(a.get(b"Subtype").ok()) == Some(b"Widget"))
        });
        if had_form && !widgets_left {
            if let Ok(catalog) = self.doc.catalog_mut() {
                catalog.remove(b"AcroForm");
            }
        }
        count
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const AMIRI: &[u8] = include_bytes!("../../../../../tests/fonts/Amiri-Regular.ttf");
    const INTER: &[u8] =
        include_bytes!("../../../../../tests/fonts/static/Inter-Regular-static.ttf");
    const PRESS: &[u8] = include_bytes!("../../../../../tests/fixtures/icc/test-press-cmyk.icc");

    fn corpus(name: &str) -> Vec<u8> {
        std::fs::read(format!(
            "{}/../../../tests/corpus/arabic/{name}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap()
    }

    fn options(profile: &[u8]) -> Options<'_> {
        Options {
            profile,
            condition: Some("Test press".into()),
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
            bleed: 8.5,
        }
    }

    #[test]
    fn an_arabic_invoice_becomes_pdfx_4() {
        for name in [
            "generated/chrome-cairo-mixed-invoice.pdf",
            "generated/variant-arabic-metadata-outlines-annots.pdf",
            "generated/chrome-windows-arial-tahoma-times.pdf",
        ] {
            let doc = PdfDocument::open(corpus(name), None).unwrap();
            assert!(!doc.pdfx_validate().passed());
            let out = doc.to_pdfx(&options(PRESS)).unwrap();
            assert!(out.findings.passed(), "{name}: {:#?}", out.findings.items);
            let reread = PdfDocument::open(out.bytes.clone(), None).unwrap();
            assert_eq!(reread.page_count(), doc.page_count());
            let page = reread.pages[0];
            let trim = page_box(&reread, page, b"TrimBox").unwrap();
            let bleed = page_box(&reread, page, b"BleedBox").unwrap();
            assert!(inside(trim, bleed));
            assert!(out.bytes.starts_with(b"%PDF-1.6"));
        }
    }

    #[test]
    fn a_monitor_profile_is_not_a_press() {
        let doc =
            PdfDocument::open(corpus("generated/chrome-cairo-mixed-invoice.pdf"), None).unwrap();
        let err = doc.to_pdfx(&options(icc::SRGB)).unwrap_err().to_string();
        assert!(err.contains("E_PROFILE"), "{err}");
        assert!(doc.to_pdfx(&options(b"nothing")).is_err());
    }
}
