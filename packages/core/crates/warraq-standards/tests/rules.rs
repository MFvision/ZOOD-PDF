#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
//! One test (at least) per rule: a generated fixture that violates it is reported, and — for
//! repairable rules — `convert` removes the finding without leaving any other error.

mod common;
use common::*;
use std::sync::OnceLock;
use warraq_pdf::lopdf::{Dictionary, Object, Stream, StringFormat};
use warraq_pdf::{PermissionFlags, Protection, SecurityHandler};
use warraq_standards::Profile::{self, A1b, A2b, A2u, A3b, X4};

fn base(p: Profile) -> Vec<u8> {
    static CACHE: OnceLock<std::sync::Mutex<std::collections::HashMap<Profile, Vec<u8>>>> =
        OnceLock::new();
    let m = CACHE.get_or_init(Default::default);
    let mut g = m.lock().unwrap();
    g.entry(p).or_insert_with(|| baseline(p)).clone()
}

#[test]
fn baselines_conform_and_the_office_document_does_not() {
    for p in Profile::ALL {
        let r = validate(&base(p), p);
        assert!(r.conforms(), "{p:?}: {:?}", r.findings);
        assert_eq!(
            r.rules_checked,
            warraq_standards::rules::rules_for(p).count()
        );
        let office = validate(&office_doc(), p);
        assert!(!office.conforms());
    }
}

// ---------------------------------------------------------------- file structure

#[test]
fn file_header() {
    let mut b = b"JUNK\n".to_vec();
    b.extend(base(A2b));
    check(&b, A2b, "file-header", true);
}

#[test]
fn binary_comment() {
    let b = patch(&base(A2b), b"%\xe2\xe3\xcf\xd3", b"%abcd");
    check(&b, A2b, "binary-comment", true);
}

#[test]
fn trailer_id() {
    let b = base(A2b);
    let at = (0..b.len() - 5)
        .rev()
        .find(|i| &b[*i..*i + 5] == b"/ID [")
        .unwrap();
    let end = at + b[at..].iter().position(|c| *c == b']').unwrap() + 1;
    let mut out = b.clone();
    for x in &mut out[at..end] {
        *x = b' ';
    }
    check(&out, A2b, "trailer-id", true);
    check(&out, X4, "trailer-id", true);
}

#[test]
fn no_encryption() {
    let h = SecurityHandler::new_aes256("", "owner", &PermissionFlags::all()).unwrap();
    let enc = warraq_pdf::Pdf::open(base(A2b), None)
        .unwrap()
        .write_full(Protection::New(h))
        .unwrap();
    let r = validate(&enc, A2b);
    assert!(r.has("no-encryption"));
    // Opened with the owner password the converter removes the encryption.
    let c =
        warraq_standards::convert::convert_bytes(enc.clone(), Some("owner"), A2b, &opts()).unwrap();
    assert!(c.after.conforms(), "{:?}", c.after.findings);
    // With restricted permissions and only the user password, conversion is refused.
    let mut perms = PermissionFlags::all();
    perms.modify = false;
    let h = SecurityHandler::new_aes256("", "owner", &perms).unwrap();
    let locked = warraq_pdf::Pdf::open(base(A2b), None)
        .unwrap()
        .write_full(Protection::New(h))
        .unwrap();
    let e = warraq_standards::convert::convert_bytes(locked, None, A2b, &opts()).unwrap_err();
    assert_eq!(e.code(), "permission_denied");
}

#[test]
fn eof_marker() {
    let mut b = base(A2b);
    b.extend_from_slice(b"trailing garbage");
    check(&b, A2b, "eof-marker", true);
}

#[test]
fn xref_syntax() {
    let b = patch(&base(A2b), b"xref\n0 ", b"xref 0 ");
    check(&b, A2b, "xref-syntax", true);
    // PDF/A-1 does not allow cross-reference streams.
    let xs = warraq_pdf::builder::sample_pdf(
        1,
        &warraq_pdf::builder::SampleOptions {
            xref_stream: true,
            ..Default::default()
        },
    )
    .unwrap();
    let r = validate(&xs, A1b);
    assert!(r.of("xref-syntax").any(|f| f.variant == "streams"));
    let out = warraq_standards::convert::convert_bytes(xs, None, A1b, &opts()).unwrap();
    assert!(!out.after.has("xref-syntax"));
}

#[test]
fn linearization() {
    let b = mutate(&base(A2b), |pdf| {
        let lin = pdf.add(Object::Dictionary(d(vec![
            ("Linearized", Object::Integer(1)),
            ("L", Object::Integer(99)),
        ])));
        catalog_mut(pdf, |c| c.set("ZLin", Object::Reference(lin)));
    });
    let r = validate(&b, A2b);
    assert!(r.has("linearization"));
    assert!(
        r.conforms(),
        "a stale linearization dictionary is a warning"
    );
    assert_eq!(r.warning_count(), 1);
    let c = warraq_standards::convert::convert_bytes(b, None, A2b, &opts()).unwrap();
    // The catalog key keeps the dictionary reachable, so it survives; /L is still stale.
    let _ = c;
}

#[test]
fn hex_strings() {
    // In an object of its own: a malformed string must not take the catalog down with it.
    let b = mutate(&base(A2b), |pdf| {
        let o = pdf.add(Object::Dictionary(d(vec![("V", lit("ABCDE"))])));
        catalog_mut(pdf, |c| c.set("ZHex", Object::Reference(o)));
    });
    check(&patch(&b, b"(ABCDE)", b"<ABCDE>"), A2b, "hex-strings", true);
    check(&patch(&b, b"(ABCDE)", b"<ABCDZ>"), A2b, "hex-strings", true);
}

fn with_marked_stream(content: &[u8]) -> Vec<u8> {
    mutate(&base(A2b), |pdf| {
        let s = pdf.add(Object::Stream(Stream::new(
            d(vec![("Marker", name("LenTest"))]),
            content.to_vec(),
        )));
        catalog_mut(pdf, |c| c.set("ZStream", Object::Reference(s)));
    })
}

#[test]
fn stream_length() {
    let b = with_marked_stream(b"0123456789");
    check(
        &patch(
            &b,
            b"/Marker /LenTest/Length 10>>",
            b"/Marker /LenTest/Length 11>>",
        ),
        A2b,
        "stream-length",
        true,
    );
}

#[test]
fn stream_keywords() {
    let b = with_marked_stream(b"0123456789");
    check(
        &patch(
            &b,
            b"stream\n0123456789\nendstream",
            b"stream 0123456789\nendstream",
        ),
        A2b,
        "stream-keywords",
        true,
    );
    check(
        &patch(
            &b,
            b"stream\n0123456789\nendstream",
            b"stream\n0123456789 endstream",
        ),
        A2b,
        "stream-keywords",
        true,
    );
}

#[test]
fn external_streams() {
    let b = mutate(&base(A2b), |pdf| {
        let s = pdf.add(Object::Stream(Stream::new(
            d(vec![("F", lit("data.bin"))]),
            vec![],
        )));
        catalog_mut(pdf, |c| c.set("ZExt", Object::Reference(s)));
    });
    check(&b, A2b, "external-streams", false);
    check(&b, X4, "external-streams", false);
}

#[test]
fn stream_filters_lzw_is_reencoded_losslessly() {
    let content = b"0 0 1 rg 10 10 50 50 re f\nBT /F1 12 Tf 20 20 Td (LZW text) Tj ET\n".repeat(3);
    let b = mutate(&base(A2b), |pdf| {
        let s = pdf.add(Object::Stream(Stream::new(
            d(vec![("Filter", name("LZWDecode"))]),
            lzw(&content),
        )));
        page_mut(pdf, |p| {
            let mut list = match p.get(b"Contents").unwrap().clone() {
                Object::Array(a) => a,
                o => vec![o],
            };
            list.push(Object::Reference(s));
            p.set("Contents", Object::Array(list));
        });
    });
    // The fixture decodes to the original bytes (our encoder is correct).
    let pdf = warraq_pdf::Pdf::open(b.clone(), None).unwrap();
    let lzw_stream = pdf.objects().values().find_map(|o| match o {
        Object::Stream(s) if s.dict.get(b"Filter").ok() == Some(&name("LZWDecode")) => {
            Some(s.clone())
        }
        _ => None,
    });
    assert_eq!(
        warraq_pdf::limits::decode_stream(&lzw_stream.unwrap(), pdf.limits()).unwrap(),
        content
    );
    check(&b, A2b, "stream-filters", true);
    let out = warraq_standards::convert::convert_bytes(b, None, A2b, &opts()).unwrap();
    let pdf = warraq_pdf::Pdf::open(out.bytes, None).unwrap();
    let found = pdf.objects().values().any(|o| matches!(o, Object::Stream(s) if warraq_pdf::limits::decode_stream(s, pdf.limits()).map(|d| d == content).unwrap_or(false)));
    assert!(found, "re-encoded stream keeps its content");
}

#[test]
fn stream_filters_inline_lzw_is_reported() {
    let b = mutate(&base(A2b), |pdf| {
        add_content(
            pdf,
            "q BI /W 1 /H 1 /CS /G /BPC 8 /F /LZW ID \x7f\x00\x20 EI Q",
        )
    });
    let r = validate(&b, A2b);
    assert!(r
        .of("stream-filters")
        .any(|f| f.variant == "inline-lzw" && !f.fixable));
}

#[test]
fn indirect_object_syntax() {
    let b = base(A2b);
    check(
        &patch(&b, b"\nendobj", b" endobj"),
        A2b,
        "indirect-object-syntax",
        true,
    );
    check(
        &patch(&b, b" 0 obj\n", b" 0 obj "),
        A2b,
        "indirect-object-syntax",
        true,
    );
}

#[test]
fn impl_limits_objects() {
    let b = mutate(&base(A2b), |pdf| {
        catalog_mut(pdf, |c| c.set("ZBig", Object::Integer(3_000_000_000)))
    });
    check(&b, A2b, "impl-limits-objects", false);
    let b = mutate(&base(A1b), |pdf| {
        catalog_mut(pdf, |c| c.set("ZReal", Object::Real(40_000.5)))
    });
    check(&b, A1b, "impl-limits-objects", false);
    assert!(
        !validate(&b, A2b).has("impl-limits-objects"),
        "reals up to 3.4e38 are fine in PDF/A-2"
    );
    let long = "N".repeat(130);
    let b = mutate(&base(A2b), |pdf| {
        catalog_mut(pdf, |c| c.set("ZName", name(&long)))
    });
    check(&b, A2b, "impl-limits-objects", false);
    let b = mutate(&base(A2b), |pdf| {
        catalog_mut(pdf, |c| c.set("ZUtf", Object::Name(vec![0xFF, 0xFE])))
    });
    assert!(validate(&b, A2b)
        .of("impl-limits-objects")
        .any(|f| f.variant == "utf8"));
    let b = mutate(&base(A1b), |pdf| {
        catalog_mut(pdf, |c| {
            c.set("ZArr", Object::Array(vec![Object::Integer(1); 9000]))
        })
    });
    assert!(validate(&b, A1b)
        .of("impl-limits-objects")
        .any(|f| f.variant == "array"));
}

#[test]
fn impl_limits_content() {
    let deep = format!("{}{}", "q ".repeat(30), "Q ".repeat(30));
    let b = mutate(&base(A2b), |pdf| add_content(pdf, &deep));
    check(&b, A2b, "impl-limits-content", false);
    let names: Vec<Object> = (0..10).map(|i| name(&format!("C{i}"))).collect();
    let dn = arr(vec![
        name("DeviceN"),
        arr(names),
        name("DeviceGray"),
        Object::Null,
    ]);
    let b = mutate(&base(A1b), |pdf| add_resource(pdf, "ColorSpace", "DN", dn));
    let r = validate(&b, A1b);
    assert!(r.of("impl-limits-content").any(|f| f.variant == "devicen"));
    assert!(!validate(&b, A2b)
        .of("impl-limits-content")
        .any(|f| f.variant == "devicen"));
}

#[test]
fn page_size() {
    let b = mutate(&base(A2b), |pdf| {
        page_mut(pdf, |p| p.set("MediaBox", rect(0.0, 0.0, 20_000.0, 842.0)))
    });
    check(&b, A2b, "page-size", false);
    let b = mutate(&base(A2b), |pdf| {
        page_mut(pdf, |p| p.set("CropBox", rect(0.0, 0.0, 2.0, 2.0)))
    });
    check(&b, A2b, "page-size", false);
}

fn with_layers(cfg: Dictionary) -> impl FnOnce(&mut warraq_pdf::Pdf) {
    move |pdf| {
        let g1 = pdf.add(Object::Dictionary(d(vec![
            ("Type", name("OCG")),
            ("Name", lit("Layer 1")),
        ])));
        let g2 = pdf.add(Object::Dictionary(d(vec![
            ("Type", name("OCG")),
            ("Name", lit("Layer 2")),
        ])));
        let mut cfg = cfg;
        cfg.set("Order", arr(vec![Object::Reference(g1)]));
        let oc = d(vec![
            (
                "OCGs",
                arr(vec![Object::Reference(g1), Object::Reference(g2)]),
            ),
            ("D", Object::Dictionary(cfg)),
        ]);
        catalog_mut(pdf, |c| c.set("OCProperties", Object::Dictionary(oc)));
    }
}

#[test]
fn optional_content() {
    let b = mutate(&base(A1b), with_layers(d(vec![("Name", lit("Default"))])));
    check(&b, A1b, "optional-content", false);
    let b = mutate(&base(A2b), with_layers(d(vec![("AS", arr(vec![]))])));
    let r = validate(&b, A2b);
    let variants: Vec<_> = r.of("optional-content").map(|f| f.variant).collect();
    assert!(
        variants.contains(&"name") && variants.contains(&"as") && variants.contains(&"order"),
        "{variants:?}"
    );
    check(&b, A2b, "optional-content", true);
}

// ---------------------------------------------------------------- metadata

#[test]
fn metadata_present() {
    let b = mutate(&base(A2b), |pdf| {
        catalog_mut(pdf, |c| {
            c.remove(b"Metadata");
        })
    });
    check(&b, A2b, "metadata-present", true);
    check(&b, X4, "metadata-present", true);
}

fn set_metadata(bytes: &[u8], xml: &[u8], compress: bool) -> Vec<u8> {
    mutate(bytes, |pdf| {
        let mut sd = d(vec![("Type", name("Metadata")), ("Subtype", name("XML"))]);
        let data = if compress {
            sd.set("Filter", name("FlateDecode"));
            flate(xml)
        } else {
            xml.to_vec()
        };
        let id = pdf.add(Object::Stream(Stream::new(sd, data)));
        catalog_mut(pdf, |c| c.set("Metadata", Object::Reference(id)));
    })
}

fn current_xmp(bytes: &[u8]) -> String {
    let pdf = warraq_pdf::Pdf::open(bytes.to_vec(), None).unwrap();
    warraq_pdf::metadata::get_xmp(&pdf).unwrap().unwrap()
}

#[test]
fn xmp_well_formed() {
    let b = set_metadata(
        &base(A2b),
        b"<x:xmpmeta xmlns:x='adobe:ns:meta/'><rdf:RDF",
        false,
    );
    check(&b, A2b, "xmp-well-formed", true);
    let xml = current_xmp(&base(A2b)).replace(
        "id=\"W5M0MpCehiHzreSzNTczkc9d\"",
        "id=\"W5M0MpCehiHzreSzNTczkc9d\" bytes=\"4096\"",
    );
    let b = set_metadata(&base(A2b), xml.as_bytes(), false);
    let r = validate(&b, A2b);
    assert!(r.of("xmp-well-formed").any(|f| f.variant == "header"));
    check(&b, A2b, "xmp-well-formed", true);
}

#[test]
fn metadata_no_filter() {
    let xml = current_xmp(&base(A2b));
    let b = set_metadata(&base(A2b), xml.as_bytes(), true);
    check(&b, A2b, "metadata-no-filter", true);
}

#[test]
fn pdfa_identification() {
    // A PDF/A-2b file is not a PDF/A-2u or PDF/A-1b file.
    check(&base(A2b), A2u, "pdfa-identification", true);
    check(&base(A2b), A1b, "pdfa-identification", true);
    let xml = current_xmp(&base(A2b)).replace("<pdfaid:part>2</pdfaid:part>", "");
    check(
        &set_metadata(&base(A2b), xml.as_bytes(), false),
        A2b,
        "pdfa-identification",
        true,
    );
}

#[test]
fn xmp_extension_schemas() {
    let xml = current_xmp(&base(A2b)).replace(
        "</rdf:RDF>",
        "<rdf:Description rdf:about=\"\" xmlns:acme=\"http://example.com/acme/1.0/\"><acme:Project>Z</acme:Project></rdf:Description></rdf:RDF>",
    );
    let b = set_metadata(&base(A2b), xml.as_bytes(), false);
    check(&b, A2b, "xmp-extension-schemas", true);
    // Declared through a PDF/A extension schema: accepted.
    let declared = current_xmp(&base(A2b)).replace(
        "</rdf:RDF>",
        "<rdf:Description rdf:about=\"\" xmlns:pdfaExtension=\"http://www.aiim.org/pdfa/ns/extension/\" xmlns:pdfaSchema=\"http://www.aiim.org/pdfa/ns/schema#\"><pdfaExtension:schemas><rdf:Bag><rdf:li rdf:parseType=\"Resource\"><pdfaSchema:namespaceURI>http://example.com/acme/1.0/</pdfaSchema:namespaceURI><pdfaSchema:prefix>acme</pdfaSchema:prefix></rdf:li></rdf:Bag></pdfaExtension:schemas></rdf:Description><rdf:Description rdf:about=\"\" xmlns:acme=\"http://example.com/acme/1.0/\"><acme:Project>Z</acme:Project></rdf:Description></rdf:RDF>",
    );
    assert!(
        !validate(&set_metadata(&base(A2b), declared.as_bytes(), false), A2b)
            .has("xmp-extension-schemas")
    );
}

#[test]
fn info_xmp_consistency() {
    let b = mutate(&base(A2b), |pdf| {
        let mut m = std::collections::BTreeMap::new();
        m.insert("Title".to_string(), Some("Another title".to_string()));
        warraq_pdf::metadata::set_info(pdf, &m).unwrap();
    });
    check(&b, A2b, "info-xmp-consistency", true);
    let b = mutate(&base(A2b), |pdf| {
        let mut m = std::collections::BTreeMap::new();
        m.insert("ModDate".to_string(), Some("D:19990101000000Z".to_string()));
        warraq_pdf::metadata::set_info(pdf, &m).unwrap();
    });
    let r = validate(&b, A2b);
    assert!(r.of("info-xmp-consistency").any(|f| f.variant == "date"));
    check(&b, A2b, "info-xmp-consistency", true);
}

// ---------------------------------------------------------------- colour

fn replace_intent_profile(bytes: &[u8], profile: Vec<u8>) -> Vec<u8> {
    mutate(bytes, |pdf| {
        let s = pdf.add(Object::Stream(Stream::new(
            d(vec![("N", Object::Integer(3))]),
            profile,
        )));
        let oi = d(vec![
            ("Type", name("OutputIntent")),
            ("S", name("GTS_PDFA1")),
            ("OutputConditionIdentifier", lit("x")),
            ("DestOutputProfile", Object::Reference(s)),
        ]);
        catalog_mut(pdf, |c| {
            c.set("OutputIntents", arr(vec![Object::Dictionary(oi)]))
        });
    })
}

#[test]
fn output_intent() {
    check(
        &replace_intent_profile(&base(A2b), b"not an icc profile".repeat(10)),
        A2b,
        "output-intent",
        true,
    );
    // ICC v4 is fine for PDF/A-2, not for PDF/A-1.
    let mut v4 = warraq_standards::icc::srgb_display().to_vec();
    v4[8] = 4;
    let b = replace_intent_profile(&base(A1b), v4.clone());
    check(&b, A1b, "output-intent", true);
    assert!(!validate(&replace_intent_profile(&base(A2b), v4), A2b).has("output-intent"));
    // Two intents with different profiles.
    let b = mutate(&base(A2b), |pdf| {
        let s = pdf.add(Object::Stream(Stream::new(
            d(vec![("N", Object::Integer(3))]),
            warraq_standards::icc::srgb_display().to_vec(),
        )));
        let oi = d(vec![
            ("Type", name("OutputIntent")),
            ("S", name("GTS_PDFX")),
            ("OutputConditionIdentifier", lit("x")),
            ("DestOutputProfile", Object::Reference(s)),
        ]);
        catalog_mut(pdf, |c| {
            let mut list = match c.get(b"OutputIntents").unwrap().clone() {
                Object::Array(a) => a,
                _ => vec![],
            };
            list.push(Object::Dictionary(oi));
            c.set("OutputIntents", Object::Array(list));
        });
    });
    let r = validate(&b, A2b);
    assert!(r.of("output-intent").any(|f| f.variant == "multiple"));
    check(&b, A2b, "output-intent", true);
}

#[test]
fn icc_based() {
    let b = mutate(&base(A2b), |pdf| {
        let s = pdf.add(Object::Stream(Stream::new(
            d(vec![("N", Object::Integer(4))]),
            warraq_standards::icc::srgb_display().to_vec(),
        )));
        add_resource(
            pdf,
            "ColorSpace",
            "CS0",
            arr(vec![name("ICCBased"), Object::Reference(s)]),
        );
    });
    check(&b, A2b, "icc-based", false);
}

#[test]
fn device_colour() {
    // No output intent at all: DeviceRGB and DeviceGray are uncovered.
    let b = mutate(&base(A2b), |pdf| {
        catalog_mut(pdf, |c| {
            c.remove(b"OutputIntents");
        })
    });
    check(&b, A2b, "device-colour", true);
    // DeviceCMYK under an sRGB intent cannot be repaired.
    let b = mutate(&base(A2b), |pdf| {
        add_content(pdf, "0 0 0 1 k 0 0 10 10 re f")
    });
    let r = validate(&b, A2b);
    assert!(r
        .of("device-colour")
        .any(|f| f.params.get("space").map(String::as_str) == Some("DeviceCMYK") && !f.fixable));
    let c = warraq_standards::convert::convert_bytes(b, None, A2b, &opts()).unwrap();
    assert!(
        c.after.has("device-colour"),
        "CMYK stays reported, never hidden"
    );
    // A DefaultCMYK colour space covers it.
    let b = mutate(&base(A2b), |pdf| {
        let s = pdf.add(Object::Stream(Stream::new(
            d(vec![("N", Object::Integer(3))]),
            warraq_standards::icc::srgb_display().to_vec(),
        )));
        add_resource(
            pdf,
            "ColorSpace",
            "DefaultCMYK",
            arr(vec![name("ICCBased"), Object::Reference(s)]),
        );
        add_content(pdf, "0 0 0 1 k 0 0 10 10 re f");
    });
    assert!(!validate(&b, A2b).has("device-colour"));
    // PDF/X-4 with an RGB output intent: DeviceCMYK uncovered.
    let b = mutate(&base(X4), |pdf| {
        add_content(pdf, "0 0 0 1 k 0 0 10 10 re f")
    });
    check(&b, X4, "device-colour", false);
}

fn gs(pairs: Vec<(&'static str, Object)>) -> impl FnOnce(&mut warraq_pdf::Pdf) {
    move |pdf| {
        let mut g = d(vec![("Type", name("ExtGState"))]);
        for (k, v) in pairs {
            g.set(k, v);
        }
        let id = pdf.add(Object::Dictionary(g));
        add_resource(pdf, "ExtGState", "GS9", Object::Reference(id));
        add_content(pdf, "q /GS9 gs 0 0 10 10 re f Q");
    }
}

#[test]
fn rendering_intent() {
    let b = mutate(&base(A2b), gs(vec![("RI", name("Bogus"))]));
    check(&b, A2b, "rendering-intent", true);
    let b = mutate(&base(A2b), |pdf| add_content(pdf, "/Bogus ri"));
    check(&b, A2b, "rendering-intent", false);
}

#[test]
fn extgstate_transfer() {
    check(
        &mutate(&base(A2b), gs(vec![("TR", name("Identity"))])),
        A2b,
        "extgstate-transfer",
        true,
    );
    check(
        &mutate(&base(A2b), gs(vec![("TR2", name("Identity"))])),
        A2b,
        "extgstate-transfer",
        true,
    );
    assert!(
        !validate(&mutate(&base(A2b), gs(vec![("TR2", name("Default"))])), A2b)
            .has("extgstate-transfer")
    );
}

// ---------------------------------------------------------------- transparency

#[test]
fn transparency_smask() {
    let b = mutate(
        &base(A1b),
        gs(vec![(
            "SMask",
            Object::Dictionary(d(vec![("S", name("Luminosity"))])),
        )]),
    );
    check(&b, A1b, "transparency-smask", false);
    assert!(!validate(&b, A2b).has("transparency-smask"));
    let b = mutate(&base(A1b), |pdf| {
        let m = pdf.add(Object::Stream(Stream::new(
            d(vec![
                ("Type", name("XObject")),
                ("Subtype", name("Image")),
                ("Width", Object::Integer(1)),
                ("Height", Object::Integer(1)),
                ("ColorSpace", name("DeviceGray")),
                ("BitsPerComponent", Object::Integer(8)),
            ]),
            vec![128],
        )));
        let img = pdf.add(Object::Stream(Stream::new(
            d(vec![
                ("Type", name("XObject")),
                ("Subtype", name("Image")),
                ("Width", Object::Integer(1)),
                ("Height", Object::Integer(1)),
                ("ColorSpace", name("DeviceRGB")),
                ("BitsPerComponent", Object::Integer(8)),
                ("SMask", Object::Reference(m)),
            ]),
            vec![1, 2, 3],
        )));
        add_resource(pdf, "XObject", "Im9", Object::Reference(img));
        add_content(pdf, "q 10 0 0 10 0 0 cm /Im9 Do Q");
    });
    let r = validate(&b, A1b);
    assert!(r.of("transparency-smask").any(|f| f.variant == "image"));
    let c = warraq_standards::convert::convert_bytes(b, None, A1b, &opts()).unwrap();
    assert!(
        c.after.has("transparency-smask"),
        "PDF/A-1 transparency is reported, not flattened"
    );
}

#[test]
fn transparency_alpha() {
    check(
        &mutate(&base(A1b), gs(vec![("ca", Object::Real(0.5))])),
        A1b,
        "transparency-alpha",
        false,
    );
    let b = mutate(&base(A1b), |pdf| {
        add_annot(
            pdf,
            d(vec![
                ("Type", name("Annot")),
                ("Subtype", name("Square")),
                ("Rect", rect(10.0, 10.0, 50.0, 50.0)),
                ("F", Object::Integer(4)),
                ("CA", Object::Real(0.5)),
            ]),
        );
    });
    assert!(validate(&b, A1b)
        .of("transparency-alpha")
        .any(|f| f.variant == "annot"));
}

#[test]
fn blend_mode() {
    let b = mutate(&base(A1b), gs(vec![("BM", name("Multiply"))]));
    check(&b, A1b, "blend-mode", false);
    assert!(
        !validate(&mutate(&base(A2b), gs(vec![("BM", name("Multiply"))])), A2b).has("blend-mode")
    );
    check(
        &mutate(&base(A2b), gs(vec![("BM", name("Bogus"))])),
        A2b,
        "blend-mode",
        false,
    );
}

#[test]
fn transparency_group_only_is_removed_for_pdfa1() {
    let group = || {
        Object::Dictionary(d(vec![
            ("Type", name("Group")),
            ("S", name("Transparency")),
            ("CS", name("DeviceRGB")),
        ]))
    };
    let b = mutate(&base(A1b), |pdf| page_mut(pdf, |p| p.set("Group", group())));
    check(&b, A1b, "transparency-group", true);
    // With real transparency as well, the group cannot be removed safely.
    let b = mutate(&b, gs(vec![("ca", Object::Real(0.5))]));
    check(&b, A1b, "transparency-group", false);
}

// ---------------------------------------------------------------- images, xobjects, content

fn image(extra: Vec<(&'static str, Object)>) -> impl FnOnce(&mut warraq_pdf::Pdf) {
    move |pdf| {
        let mut dd = d(vec![
            ("Type", name("XObject")),
            ("Subtype", name("Image")),
            ("Width", Object::Integer(1)),
            ("Height", Object::Integer(1)),
            ("ColorSpace", name("DeviceRGB")),
            ("BitsPerComponent", Object::Integer(8)),
        ]);
        for (k, v) in extra {
            dd.set(k, v);
        }
        let img = pdf.add(Object::Stream(Stream::new(dd, vec![1, 2, 3])));
        add_resource(pdf, "XObject", "Im9", Object::Reference(img));
        add_content(pdf, "q 72 0 0 72 0 0 cm /Im9 Do Q");
    }
}

#[test]
fn image_alternates() {
    check(
        &mutate(&base(A2b), image(vec![("Alternates", arr(vec![]))])),
        A2b,
        "image-alternates",
        true,
    );
}

#[test]
fn image_interpolate() {
    check(
        &mutate(
            &base(A2b),
            image(vec![("Interpolate", Object::Boolean(true))]),
        ),
        A2b,
        "image-interpolate",
        true,
    );
    let b = mutate(&base(A2b), |pdf| {
        add_content(
            pdf,
            "q 10 0 0 10 0 0 cm BI /W 1 /H 1 /CS /RGB /BPC 8 /I true ID \x01\x02\x03 EI Q",
        )
    });
    let r = validate(&b, A2b);
    assert!(r.of("image-interpolate").any(|f| f.variant == "inline"));
    check(&b, A2b, "image-interpolate", true);
}

#[test]
fn opi() {
    let opi = || Object::Dictionary(d(vec![("1.3", Object::Dictionary(Dictionary::new()))]));
    check(
        &mutate(&base(A2b), image(vec![("OPI", opi())])),
        A2b,
        "opi",
        true,
    );
    check(
        &mutate(&base(X4), image(vec![("OPI", opi())])),
        X4,
        "opi",
        true,
    );
}

fn form(extra: Vec<(&'static str, Object)>) -> impl FnOnce(&mut warraq_pdf::Pdf) {
    move |pdf| {
        let mut dd = d(vec![
            ("Type", name("XObject")),
            ("Subtype", name("Form")),
            ("BBox", rect(0.0, 0.0, 10.0, 10.0)),
        ]);
        for (k, v) in extra {
            dd.set(k, v);
        }
        let f = pdf.add(Object::Stream(Stream::new(dd, b"0 0 5 5 re f".to_vec())));
        add_resource(pdf, "XObject", "Fm9", Object::Reference(f));
        add_content(pdf, "/Fm9 Do");
    }
}

#[test]
fn postscript_reference_xobjects() {
    check(
        &mutate(&base(A2b), form(vec![("PS", Object::Reference((1, 0)))])),
        A2b,
        "postscript-reference-xobjects",
        true,
    );
    check(
        &mutate(&base(A2b), form(vec![("Subtype2", name("PS"))])),
        A2b,
        "postscript-reference-xobjects",
        true,
    );
    check(
        &mutate(
            &base(A2b),
            form(vec![(
                "Ref",
                Object::Dictionary(d(vec![("F", lit("other.pdf"))])),
            )]),
        ),
        A2b,
        "postscript-reference-xobjects",
        true,
    );
    let b = mutate(&base(A2b), |pdf| {
        let ps = pdf.add(Object::Stream(Stream::new(
            d(vec![("Type", name("XObject")), ("Subtype", name("PS"))]),
            b"showpage".to_vec(),
        )));
        add_resource(pdf, "XObject", "PS9", Object::Reference(ps));
    });
    check(&b, A2b, "postscript-reference-xobjects", false);
    check(&b, X4, "postscript-reference-xobjects", false);
}

#[test]
fn undefined_operators() {
    check(
        &mutate(&base(A2b), |pdf| add_content(pdf, "1 2 3 frobnicate")),
        A2b,
        "undefined-operators",
        false,
    );
    assert!(!validate(
        &mutate(&base(A2b), |pdf| add_content(pdf, "BX 1 2 3 frobnicate EX")),
        A2b
    )
    .has("undefined-operators"));
}

// ---------------------------------------------------------------- fonts

#[test]
fn font_embedded() {
    for p in Profile::ALL {
        let r = validate(&office_doc(), p);
        let f = r.of("font-embedded").next().unwrap();
        assert_eq!(f.params["font"], "Helvetica");
        assert_eq!(f.params["substitute"], "LiberationSans");
        assert!(r
            .fonts_needed
            .contains(&"LiberationSans-Regular".to_string()));
        check(&office_doc(), p, "font-embedded", true);
    }
    // Without the bundled font, the converter reports instead of pretending.
    let c = warraq_standards::convert::convert_bytes(
        office_doc(),
        None,
        A2b,
        &warraq_standards::ConvertOptions::default(),
    )
    .unwrap();
    assert!(c.after.has("font-embedded"));
    // Symbol has no substitute.
    let mut b = B::new();
    let f = b.add(Object::Dictionary(d(vec![
        ("Type", name("Font")),
        ("Subtype", name("Type1")),
        ("BaseFont", name("Symbol")),
    ])));
    b.page(
        "BT /F1 12 Tf (abc) Tj ET",
        d(vec![(
            "Font",
            Object::Dictionary(d(vec![("F1", Object::Reference(f))])),
        )]),
    );
    check(&b.bytes(), A2b, "font-embedded", false);
}

fn embedded_font_id(bytes: &[u8]) -> warraq_pdf::lopdf::ObjectId {
    let pdf = warraq_pdf::Pdf::open(bytes.to_vec(), None).unwrap();
    *pdf.objects().iter().find(|(_, o)| matches!(o, Object::Dictionary(d) if d.get(b"Subtype").ok() == Some(&name("TrueType")))).unwrap().0
}

#[test]
fn font_widths() {
    let base = base(A2b);
    let fid = embedded_font_id(&base);
    let b = mutate(&base, |pdf| {
        let mut f = pdf.get_dict(fid).unwrap().clone();
        let mut w = match f.get(b"Widths").unwrap() {
            Object::Array(a) => a.clone(),
            _ => panic!(),
        };
        w[40] = Object::Integer(999);
        f.set("Widths", Object::Array(w));
        pdf.set(fid, Object::Dictionary(f));
    });
    check(&b, A2b, "font-widths", true);
}

/// A Type 0 font with a CIDFontType2 (Liberation Sans, Identity) showing glyph ids.
fn cid_doc(gids: &[u16], tounicode: bool, cidtogid: bool, system_info: bool) -> Vec<u8> {
    let ttf = font("LiberationSans");
    let face = ttf_parser::Face::parse(&ttf, 0).unwrap();
    let upem = f64::from(face.units_per_em());
    let mut b = B::new();
    let file = b.add(Object::Stream(Stream::new(
        d(vec![
            ("Length1", Object::Integer(ttf.len() as i64)),
            ("Filter", name("FlateDecode")),
        ]),
        flate(&ttf),
    )));
    let desc = b.add(Object::Dictionary(d(vec![
        ("Type", name("FontDescriptor")),
        ("FontName", name("LiberationSans")),
        ("Flags", Object::Integer(32)),
        ("FontBBox", rect(-200.0, -300.0, 1200.0, 1000.0)),
        ("ItalicAngle", Object::Integer(0)),
        ("Ascent", Object::Integer(905)),
        ("Descent", Object::Integer(-212)),
        ("CapHeight", Object::Integer(716)),
        ("StemV", Object::Integer(80)),
        ("FontFile2", Object::Reference(file)),
    ])));
    let mut w = Vec::new();
    for g in gids {
        let adv = face.glyph_hor_advance(ttf_parser::GlyphId(*g)).unwrap_or(0);
        w.push(Object::Integer(i64::from(*g)));
        w.push(arr(vec![Object::Integer(
            (f64::from(adv) * 1000.0 / upem).round() as i64,
        )]));
    }
    let mut cid = d(vec![
        ("Type", name("Font")),
        ("Subtype", name("CIDFontType2")),
        ("BaseFont", name("LiberationSans")),
        ("FontDescriptor", Object::Reference(desc)),
        ("W", arr(w)),
    ]);
    if system_info {
        cid.set(
            "CIDSystemInfo",
            Object::Dictionary(d(vec![
                ("Registry", lit("Adobe")),
                ("Ordering", lit("Identity")),
                ("Supplement", Object::Integer(0)),
            ])),
        );
    }
    if cidtogid {
        cid.set("CIDToGIDMap", name("Identity"));
    }
    let cid = b.add(Object::Dictionary(cid));
    let mut t0 = d(vec![
        ("Type", name("Font")),
        ("Subtype", name("Type0")),
        ("BaseFont", name("LiberationSans")),
        ("Encoding", name("Identity-H")),
        ("DescendantFonts", arr(vec![Object::Reference(cid)])),
    ]);
    if tounicode {
        let mut m = std::collections::BTreeMap::new();
        for g in gids {
            m.insert(u32::from(*g), "x".to_string());
        }
        let tu = b.add(Object::Stream(Stream::new(
            Dictionary::new(),
            warraq_standards::fonts::write_tounicode(&m, 2),
        )));
        t0.set("ToUnicode", Object::Reference(tu));
    }
    let f = b.add(Object::Dictionary(t0));
    let hex: String = gids.iter().map(|g| format!("{g:04X}")).collect();
    b.page(
        &format!("BT /F1 24 Tf 72 700 Td <{hex}> Tj ET"),
        d(vec![(
            "Font",
            Object::Dictionary(d(vec![("F1", Object::Reference(f))])),
        )]),
    );
    b.bytes()
}

fn gid(ch: char) -> u16 {
    let ttf = font("LiberationSans");
    ttf_parser::Face::parse(&ttf, 0)
        .unwrap()
        .glyph_index(ch)
        .unwrap()
        .0
}

#[test]
fn tounicode() {
    let gids = [gid('Z'), gid('O'), gid('D')];
    let b = cid_doc(&gids, false, true, true);
    check(&b, A2u, "tounicode", true);
    assert!(
        !validate(&b, A2b).has("tounicode"),
        "PDF/A-2b does not need Unicode"
    );
    // The derived map reads back as "ZOD".
    let out = convert_ok(&b, A2u);
    let pdf = warraq_pdf::Pdf::open(out, None).unwrap();
    let cm = pdf.objects().values().find_map(|o| match o {
        Object::Stream(s)
            if String::from_utf8_lossy(
                &warraq_pdf::limits::decode_stream(s, pdf.limits()).unwrap_or_default(),
            )
            .contains("beginbfchar") =>
        {
            Some(warraq_standards::fonts::parse_cmap(
                &warraq_pdf::limits::decode_stream(s, pdf.limits()).unwrap(),
            ))
        }
        _ => None,
    });
    let cm = cm.unwrap();
    let text: String = gids
        .iter()
        .map(|g| cm.uni[&u32::from(*g)].clone())
        .collect();
    assert_eq!(text, "ZOD");
    // Simple fonts with a standard encoding are exempt.
    assert!(!validate(&base(A2u), A2u).has("tounicode"));
}

#[test]
fn notdef() {
    let b = cid_doc(&[gid('A'), 0], true, true, true);
    check(&b, A2b, "notdef", false);
    assert!(!validate(&cid_doc(&[gid('A')], true, true, true), A2b).has("notdef"));
    assert!(
        !validate(&b, A1b).has("notdef"),
        "the .notdef rule is PDF/A-2/3 only"
    );
}

#[test]
fn type3_fonts() {
    let mut b = B::new();
    let t3 = b.add(Object::Dictionary(d(vec![
        ("Type", name("Font")),
        ("Subtype", name("Type3")),
        (
            "FontMatrix",
            arr(vec![
                Object::Real(0.001),
                Object::Integer(0),
                Object::Integer(0),
                Object::Real(0.001),
                Object::Integer(0),
                Object::Integer(0),
            ]),
        ),
    ])));
    b.page(
        "BT /T3 12 Tf (a) Tj ET",
        d(vec![(
            "Font",
            Object::Dictionary(d(vec![("T3", Object::Reference(t3))])),
        )]),
    );
    check(&b.bytes(), A2b, "type3-fonts", false);
}

#[test]
fn cid_fonts() {
    let gids = [gid('A')];
    check(&cid_doc(&gids, true, false, true), A2b, "cid-fonts", true);
    check(&cid_doc(&gids, true, true, false), A2b, "cid-fonts", false);
}

// ---------------------------------------------------------------- annotations

fn annot(sub: &str, extra: Vec<(&'static str, Object)>) -> impl FnOnce(&mut warraq_pdf::Pdf) {
    let sub = sub.to_string();
    move |pdf| {
        let mut a = d(vec![
            ("Type", name("Annot")),
            ("Subtype", name(&sub)),
            ("Rect", rect(100.0, 100.0, 150.0, 140.0)),
            (
                "C",
                arr(vec![
                    Object::Integer(1),
                    Object::Integer(0),
                    Object::Integer(0),
                ]),
            ),
        ]);
        for (k, v) in extra {
            a.set(k, v);
        }
        add_annot(pdf, a);
    }
}

#[test]
fn annot_types() {
    check(
        &mutate(&base(A2b), annot("Sound", vec![("F", Object::Integer(4))])),
        A2b,
        "annot-types",
        true,
    );
    check(
        &mutate(&base(A2b), annot("3D", vec![("F", Object::Integer(4))])),
        A2b,
        "annot-types",
        true,
    );
    let fa = annot("FileAttachment", vec![("F", Object::Integer(4))]);
    check(&mutate(&base(A1b), fa), A1b, "annot-types", true);
}

#[test]
fn annot_flags() {
    let b = mutate(&base(A2b), |pdf| {
        let n = pdf.add(Object::Stream(Stream::new(
            d(vec![
                ("Type", name("XObject")),
                ("Subtype", name("Form")),
                ("BBox", rect(0.0, 0.0, 50.0, 40.0)),
            ]),
            b"0 0 50 40 re S".to_vec(),
        )));
        annot(
            "Square",
            vec![(
                "AP",
                Object::Dictionary(d(vec![("N", Object::Reference(n))])),
            )],
        )(pdf)
    });
    check(&b, A2b, "annot-flags", true);
    // Hidden annotations are removed (they were not visible anyway).
    let b = mutate(&base(A2b), annot("Square", vec![("F", Object::Integer(2))]));
    check(&b, A2b, "annot-flags", true);
}

#[test]
fn annot_appearance() {
    for sub in [
        "Square",
        "Circle",
        "Ink",
        "Highlight",
        "Underline",
        "StrikeOut",
        "Squiggly",
        "Text",
        "Line",
        "Polygon",
    ] {
        let extra = vec![
            ("F", Object::Integer(4)),
            (
                "QuadPoints",
                arr([100.0f32, 140.0, 150.0, 140.0, 100.0, 100.0, 150.0, 100.0]
                    .iter()
                    .map(|v| Object::Real(*v))
                    .collect()),
            ),
            (
                "InkList",
                arr(vec![arr([100.0f32, 100.0, 120.0, 130.0, 150.0, 110.0]
                    .iter()
                    .map(|v| Object::Real(*v))
                    .collect())]),
            ),
            (
                "L",
                arr([100.0f32, 100.0, 150.0, 140.0]
                    .iter()
                    .map(|v| Object::Real(*v))
                    .collect()),
            ),
            (
                "Vertices",
                arr([100.0f32, 100.0, 150.0, 100.0, 125.0, 140.0]
                    .iter()
                    .map(|v| Object::Real(*v))
                    .collect()),
            ),
        ];
        let b = mutate(&base(A2b), annot(sub, extra));
        check(&b, A2b, "annot-appearance", true);
    }
    // FreeText cannot be drawn honestly without its font: reported.
    check(
        &mutate(
            &base(A2b),
            annot(
                "FreeText",
                vec![("F", Object::Integer(4)), ("DA", lit("/Helv 12 Tf 0 g"))],
            ),
        ),
        A2b,
        "annot-appearance",
        false,
    );
    // Extra appearance states (/D) are trimmed (all profiles).
    let b = mutate(&base(A1b), |pdf| {
        let n = pdf.add(Object::Stream(Stream::new(
            d(vec![
                ("Type", name("XObject")),
                ("Subtype", name("Form")),
                ("BBox", rect(0.0, 0.0, 50.0, 40.0)),
            ]),
            b"0 0 50 40 re S".to_vec(),
        )));
        annot(
            "Square",
            vec![
                ("F", Object::Integer(4)),
                (
                    "AP",
                    Object::Dictionary(d(vec![
                        ("N", Object::Reference(n)),
                        ("D", Object::Reference(n)),
                    ])),
                ),
            ],
        )(pdf)
    });
    check(&b, A1b, "annot-appearance", true);
}

// ---------------------------------------------------------------- actions

fn js() -> Object {
    Object::Dictionary(d(vec![
        ("S", name("JavaScript")),
        ("JS", lit("app.alert(1)")),
    ]))
}

#[test]
fn javascript() {
    check(
        &mutate(&base(A2b), |pdf| {
            catalog_mut(pdf, |c| c.set("OpenAction", js()))
        }),
        A2b,
        "javascript",
        true,
    );
    check(
        &mutate(&base(X4), |pdf| {
            catalog_mut(pdf, |c| c.set("OpenAction", js()))
        }),
        X4,
        "javascript",
        true,
    );
    let b = mutate(&base(A2b), |pdf| {
        let tree = d(vec![("Names", arr(vec![lit("x"), js()]))]);
        catalog_mut(pdf, |c| {
            c.set(
                "Names",
                Object::Dictionary(d(vec![("JavaScript", Object::Dictionary(tree))])),
            )
        });
    });
    check(&b, A2b, "javascript", true);
    // A Link whose action chain ends in JavaScript keeps its GoTo.
    let b = mutate(&base(A2b), |pdf| {
        let page = first_page(pdf);
        let goto = d(vec![
            ("S", name("GoTo")),
            ("D", arr(vec![Object::Reference(page), name("Fit")])),
            ("Next", js()),
        ]);
        annot(
            "Link",
            vec![("F", Object::Integer(4)), ("A", Object::Dictionary(goto))],
        )(pdf)
    });
    check(&b, A2b, "javascript", true);
    let out = convert_ok(&b, A2b);
    assert!(String::from_utf8_lossy(&out).contains("/S /GoTo"));
}

#[test]
fn forbidden_actions() {
    let launch = Object::Dictionary(d(vec![("S", name("Launch")), ("F", lit("calc.exe"))]));
    check(
        &mutate(
            &base(A2b),
            annot("Link", vec![("F", Object::Integer(4)), ("A", launch)]),
        ),
        A2b,
        "forbidden-actions",
        true,
    );
    let print = Object::Dictionary(d(vec![("S", name("Named")), ("N", name("Print"))]));
    check(
        &mutate(
            &base(A2b),
            annot("Link", vec![("F", Object::Integer(4)), ("A", print)]),
        ),
        A2b,
        "forbidden-actions",
        true,
    );
    let next = Object::Dictionary(d(vec![("S", name("Named")), ("N", name("NextPage"))]));
    assert!(!validate(
        &mutate(
            &base(A2b),
            annot("Link", vec![("F", Object::Integer(4)), ("A", next)])
        ),
        A2b
    )
    .has("forbidden-actions"));
    let hide = Object::Dictionary(d(vec![("S", name("Hide")), ("T", lit("x"))]));
    check(
        &mutate(
            &base(A2b),
            annot("Link", vec![("F", Object::Integer(4)), ("A", hide)]),
        ),
        A2b,
        "forbidden-actions",
        true,
    );
}

#[test]
fn additional_actions() {
    let aa = || {
        Object::Dictionary(d(vec![(
            "O",
            Object::Dictionary(d(vec![("S", name("GoTo")), ("D", arr(vec![]))])),
        )]))
    };
    let b = mutate(&base(A2b), |pdf| page_mut(pdf, |p| p.set("AA", aa())));
    check(&b, A2b, "additional-actions", true);
    assert!(
        !validate(&b, A1b).has("additional-actions"),
        "PDF/A-1 restricts /AA on widgets and fields only"
    );
    let b = mutate(
        &base(A1b),
        annot(
            "Widget",
            vec![
                ("F", Object::Integer(4)),
                ("FT", name("Tx")),
                ("T", lit("f")),
                ("AA", aa()),
            ],
        ),
    );
    check(&b, A1b, "additional-actions", true);
}

// ---------------------------------------------------------------- forms

#[test]
fn need_appearances() {
    let b = mutate(&base(A2b), |pdf| {
        catalog_mut(pdf, |c| {
            c.set(
                "AcroForm",
                Object::Dictionary(d(vec![
                    ("Fields", arr(vec![])),
                    ("NeedAppearances", Object::Boolean(true)),
                ])),
            )
        })
    });
    check(&b, A2b, "need-appearances", true);
    // A widget without an appearance keeps the finding (it would need the field's font).
    let b = mutate(&base(A2b), |pdf| {
        let w = add_annot(
            pdf,
            d(vec![
                ("Type", name("Annot")),
                ("Subtype", name("Widget")),
                ("FT", name("Tx")),
                ("T", lit("name")),
                ("Rect", rect(10.0, 10.0, 100.0, 30.0)),
                ("F", Object::Integer(4)),
            ]),
        );
        catalog_mut(pdf, |c| {
            c.set(
                "AcroForm",
                Object::Dictionary(d(vec![
                    ("Fields", arr(vec![Object::Reference(w)])),
                    ("NeedAppearances", Object::Boolean(true)),
                ])),
            )
        });
    });
    check(&b, A2b, "need-appearances", false);
}

#[test]
fn xfa() {
    let b = mutate(&base(A2b), |pdf| {
        let n = pdf.add(Object::Stream(Stream::new(
            d(vec![
                ("Type", name("XObject")),
                ("Subtype", name("Form")),
                ("BBox", rect(0.0, 0.0, 90.0, 20.0)),
            ]),
            b"".to_vec(),
        )));
        let w = add_annot(
            pdf,
            d(vec![
                ("Type", name("Annot")),
                ("Subtype", name("Widget")),
                ("FT", name("Tx")),
                ("T", lit("name")),
                ("Rect", rect(10.0, 10.0, 100.0, 30.0)),
                ("F", Object::Integer(4)),
                (
                    "AP",
                    Object::Dictionary(d(vec![("N", Object::Reference(n))])),
                ),
            ]),
        );
        let xfa = pdf.add(Object::Stream(Stream::new(
            Dictionary::new(),
            b"<xdp:xdp/>".to_vec(),
        )));
        catalog_mut(pdf, |c| {
            c.set(
                "AcroForm",
                Object::Dictionary(d(vec![
                    ("Fields", arr(vec![Object::Reference(w)])),
                    ("XFA", Object::Reference(xfa)),
                ])),
            );
            c.set("NeedsRendering", Object::Boolean(true));
        });
    });
    check(&b, A2b, "xfa", true);
    assert!(!validate(&b, A1b).has("xfa"));
}

// ---------------------------------------------------------------- embedded files

fn attach(
    file_bytes: Vec<u8>,
    fname: &str,
    extra: Vec<(&'static str, Object)>,
) -> impl FnOnce(&mut warraq_pdf::Pdf) {
    let fname = fname.to_string();
    move |pdf| {
        let ef = pdf.add(Object::Stream(Stream::new(
            d(vec![("Type", name("EmbeddedFile"))]),
            file_bytes,
        )));
        let mut fs = d(vec![
            ("Type", name("Filespec")),
            ("F", lit(&fname)),
            (
                "EF",
                Object::Dictionary(d(vec![("F", Object::Reference(ef))])),
            ),
        ]);
        for (k, v) in extra {
            fs.set(k, v);
        }
        let fs = pdf.add(Object::Dictionary(fs));
        let tree = d(vec![(
            "Names",
            arr(vec![lit(&fname), Object::Reference(fs)]),
        )]);
        catalog_mut(pdf, |c| {
            c.set(
                "Names",
                Object::Dictionary(d(vec![("EmbeddedFiles", Object::Dictionary(tree))])),
            )
        });
    }
}

#[test]
fn embedded_files() {
    check(
        &mutate(&base(A1b), attach(b"hello".to_vec(), "note.txt", vec![])),
        A1b,
        "embedded-files",
        true,
    );
    // PDF/A-2: only PDF/A-1/2 attachments.
    let b = mutate(&base(A2b), attach(b"hello".to_vec(), "note.txt", vec![]));
    check(&b, A2b, "embedded-files", true);
    assert!(!validate(
        &mutate(&base(A2b), attach(base(A1b), "archive.pdf", vec![])),
        A2b
    )
    .has("embedded-files"));
    // PDF/A-3: any file with an associated-file relationship, MIME type, F and UF, listed in /AF.
    let b = mutate(
        &base(A3b),
        attach(b"<invoice/>".to_vec(), "invoice.xml", vec![]),
    );
    let r = validate(&b, A3b);
    assert!(r.of("embedded-files").any(|f| f.variant == "a3"));
    check(&b, A3b, "embedded-files", true);
    let out = convert_ok(&b, A3b);
    let s = String::from_utf8_lossy(&out);
    assert!(
        s.contains("/AFRelationship /Unspecified") && s.contains("/Subtype /text#2Fxml"),
        "{}",
        &s[..0]
    );
}

// ---------------------------------------------------------------- PDF/X-4

#[test]
fn x4_rules() {
    let a = base(A2b);
    let r = validate(&a, X4);
    for rule in ["x4-version", "x4-output-intent", "x4-boxes", "x4-trapped"] {
        assert!(r.has(rule), "{rule}");
        check(&a, X4, rule, true);
    }
    let x = base(X4);
    let pdf = warraq_pdf::Pdf::open(x.clone(), None).unwrap();
    assert!(pdf.get_dict(first_page(&pdf)).unwrap().has(b"TrimBox"));
    // Both TrimBox and ArtBox.
    let b = mutate(&x, |pdf| {
        page_mut(pdf, |p| p.set("ArtBox", rect(0.0, 0.0, 100.0, 100.0)))
    });
    check(&b, X4, "x4-boxes", true);
    // A box beyond the MediaBox.
    let b = mutate(&x, |pdf| {
        page_mut(pdf, |p| p.set("TrimBox", rect(0.0, 0.0, 900.0, 900.0)))
    });
    check(&b, X4, "x4-boxes", true);
}

#[test]
fn findings_carry_clause_object_and_key() {
    let r = validate(&office_doc(), A2b);
    let f = r.of("font-embedded").next().unwrap();
    assert_eq!(f.clause, "6.2.11.4.1");
    assert_eq!(f.key(), "standards.finding.font-embedded.substitute");
    assert!(f.object_ref().unwrap().ends_with(" 0 R"));
    assert_eq!(f.page, Some(0));
    let r1 = validate(&office_doc(), A1b);
    assert_eq!(r1.of("font-embedded").next().unwrap().clause, "6.3.4");
    let _ = StringFormat::Literal;
}

#[test]
#[ignore = "writes samples for manual inspection (DUMP_DIR)"]
fn dump_sample() {
    let dir = std::env::var("DUMP_DIR").unwrap();
    for p in Profile::ALL {
        std::fs::write(format!("{dir}/office-{}.pdf", p.id()), base(p)).unwrap();
    }
    std::fs::write(format!("{dir}/office.pdf"), office_doc()).unwrap();
}
