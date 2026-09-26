#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
//! Round trips: corpus-like generated documents → convert → validate → zero errors for every
//! profile the document can honestly reach; every finding marked "fixable" before conversion is
//! gone afterwards. `tests/corpus` (when present) is converted too.

mod common;
use common::*;
use warraq_pdf::builder::{sample_pdf, SampleOptions};
use warraq_pdf::lopdf::{Dictionary, Object, Stream};
use warraq_pdf::{PermissionFlags, Protection, SecurityHandler};
use warraq_standards::convert::convert_bytes;
use warraq_standards::{Profile, Severity};

/// Everything a typical office/scanner/form document carries.
fn kitchen_sink() -> Vec<u8> {
    let mut b = B::new();
    let helv = helvetica_res(&mut b);
    // Page 1: text, RGB image with Interpolate, gray image, LZW content, JS link, highlight.
    let img = b.add(Object::Stream(Stream::new(
        d(vec![
            ("Type", name("XObject")),
            ("Subtype", name("Image")),
            ("Width", Object::Integer(2)),
            ("Height", Object::Integer(2)),
            ("ColorSpace", name("DeviceRGB")),
            ("BitsPerComponent", Object::Integer(8)),
            ("Interpolate", Object::Boolean(true)),
            ("Filter", name("FlateDecode")),
        ]),
        flate(&[255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]),
    )));
    let gray = b.add(Object::Stream(Stream::new(
        d(vec![
            ("Type", name("XObject")),
            ("Subtype", name("Image")),
            ("Width", Object::Integer(2)),
            ("Height", Object::Integer(1)),
            ("ColorSpace", name("DeviceGray")),
            ("BitsPerComponent", Object::Integer(8)),
        ]),
        vec![0, 255],
    )));
    let times = b.add(Object::Dictionary(d(vec![
        ("Type", name("Font")),
        ("Subtype", name("Type1")),
        ("BaseFont", name("Times-Bold")),
        ("Encoding", name("WinAnsiEncoding")),
    ])));
    let courier = b.add(Object::Dictionary(d(vec![
        ("Type", name("Font")),
        ("Subtype", name("TrueType")),
        ("BaseFont", name("CourierNewPSMT")),
        ("Encoding", name("WinAnsiEncoding")),
        ("FirstChar", Object::Integer(32)),
        ("LastChar", Object::Integer(126)),
        ("Widths", arr(vec![Object::Integer(600); 95])),
    ])));
    let mut res = helv;
    if let Ok(Object::Dictionary(f)) = res.get(b"Font").cloned() {
        let mut f = f;
        f.set("F2", Object::Reference(times));
        f.set("F3", Object::Reference(courier));
        res.set("Font", Object::Dictionary(f));
    }
    res.set(
        "XObject",
        Object::Dictionary(d(vec![
            ("Im1", Object::Reference(img)),
            ("Im2", Object::Reference(gray)),
        ])),
    );
    let p1 = b.page(
        "BT /F1 18 Tf 72 760 Td (Invoice No. 42) Tj ET\nBT /F2 12 Tf 72 740 Td (Bold heading) Tj ET\nBT /F3 10 Tf 72 720 Td (mono 123) Tj ET\nq 144 0 0 144 72 500 cm /Im1 Do Q\nq 72 0 0 36 300 500 cm /Im2 Do Q\n0.5 g 72 400 100 20 re f\n",
        res,
    );
    let lzw_c = b.add(Object::Stream(Stream::new(
        d(vec![("Filter", name("LZWDecode"))]),
        lzw(b"0 0 1 RG 72 380 m 300 380 l S\n"),
    )));
    {
        let pd = b.dict(p1);
        let c = pd.get(b"Contents").unwrap().clone();
        pd.set("Contents", arr(vec![c, Object::Reference(lzw_c)]));
    }
    let js = Object::Dictionary(d(vec![
        ("S", name("JavaScript")),
        ("JS", lit("this.print()")),
    ]));
    let link = b.add(Object::Dictionary(d(vec![
        ("Type", name("Annot")),
        ("Subtype", name("Link")),
        ("Rect", rect(72.0, 755.0, 250.0, 780.0)),
        (
            "A",
            Object::Dictionary(d(vec![
                ("S", name("URI")),
                ("URI", lit("https://example.com")),
                ("Next", js.clone()),
            ])),
        ),
    ])));
    let hl = b.add(Object::Dictionary(d(vec![
        ("Type", name("Annot")),
        ("Subtype", name("Highlight")),
        ("Rect", rect(70.0, 735.0, 200.0, 755.0)),
        (
            "QuadPoints",
            arr([70.0f32, 755.0, 200.0, 755.0, 70.0, 735.0, 200.0, 735.0]
                .iter()
                .map(|v| Object::Real(*v))
                .collect()),
        ),
        (
            "C",
            arr(vec![
                Object::Integer(1),
                Object::Integer(1),
                Object::Integer(0),
            ]),
        ),
    ])));
    let note = b.add(Object::Dictionary(d(vec![
        ("Type", name("Annot")),
        ("Subtype", name("Text")),
        ("Rect", rect(400.0, 700.0, 420.0, 720.0)),
        ("Contents", lit("check")),
        ("F", Object::Integer(0)),
    ])));
    let popup = b.add(Object::Dictionary(d(vec![
        ("Type", name("Annot")),
        ("Subtype", name("Popup")),
        ("Rect", rect(420.0, 600.0, 520.0, 700.0)),
        ("Parent", Object::Reference(note)),
    ])));
    b.dict(note).set("Popup", Object::Reference(popup));
    let hidden = b.add(Object::Dictionary(d(vec![
        ("Type", name("Annot")),
        ("Subtype", name("Square")),
        ("Rect", rect(10.0, 10.0, 20.0, 20.0)),
        ("F", Object::Integer(2)),
    ])));
    let sound = b.add(Object::Dictionary(d(vec![
        ("Type", name("Annot")),
        ("Subtype", name("Sound")),
        ("Rect", rect(30.0, 10.0, 40.0, 20.0)),
    ])));
    // Page 2: a form with a text field (with appearance) and NeedAppearances, inherited resources.
    let helv2 = helvetica_res(&mut b);
    let p2 = b.page("BT /F1 12 Tf 72 700 Td (Name:) Tj ET\n", helv2);
    let ap = b.add(Object::Stream(Stream::new(
        d(vec![
            ("Type", name("XObject")),
            ("Subtype", name("Form")),
            ("BBox", rect(0.0, 0.0, 200.0, 20.0)),
        ]),
        b"0 0 1 rg 0 0 200 20 re S".to_vec(),
    )));
    let field = b.add(Object::Dictionary(d(vec![
        ("Type", name("Annot")),
        ("Subtype", name("Widget")),
        ("FT", name("Tx")),
        ("T", lit("name")),
        ("V", lit("Ali")),
        ("Rect", rect(120.0, 695.0, 320.0, 715.0)),
        ("F", Object::Integer(4)),
        ("P", Object::Reference(p2)),
        (
            "AP",
            Object::Dictionary(d(vec![
                ("N", Object::Reference(ap)),
                ("D", Object::Reference(ap)),
            ])),
        ),
        ("AA", Object::Dictionary(d(vec![("K", js.clone())]))),
    ])));
    b.dict(p1).set(
        "Annots",
        arr(vec![
            Object::Reference(link),
            Object::Reference(hl),
            Object::Reference(note),
            Object::Reference(popup),
            Object::Reference(hidden),
            Object::Reference(sound),
        ]),
    );
    b.dict(p2)
        .set("Annots", arr(vec![Object::Reference(field)]));
    b.dict(p2)
        .set("AA", Object::Dictionary(d(vec![("O", js.clone())])));
    let cat = b.cat();
    cat.set(
        "AcroForm",
        Object::Dictionary(d(vec![
            ("Fields", arr(vec![Object::Reference(field)])),
            ("NeedAppearances", Object::Boolean(true)),
        ])),
    );
    cat.set("OpenAction", js);
    cat.set(
        "Names",
        Object::Dictionary(d(vec![(
            "JavaScript",
            Object::Dictionary(d(vec![(
                "Names",
                arr(vec![
                    lit("init"),
                    Object::Dictionary(d(vec![("S", name("JavaScript")), ("JS", lit("1"))])),
                ]),
            )])),
        )])),
    );
    b.set_info(vec![
        ("Title", lit("Kitchen sink")),
        ("Producer", lit("A generator")),
        ("ModDate", lit("D:20250101")),
    ]);
    b.bytes()
}

fn assert_round_trip(name: &str, bytes: &[u8], p: Profile, password: Option<&str>) {
    let c = convert_bytes(bytes.to_vec(), password, p, &opts())
        .unwrap_or_else(|e| panic!("{name} {p:?}: {e}"));
    let errors: Vec<String> = c
        .after
        .findings
        .iter()
        .filter(|f| f.severity == Severity::Error)
        .map(|f| format!("{} {} {:?}", f.rule, f.variant, f.params))
        .collect();
    assert!(
        errors.is_empty(),
        "{name} → {p:?} left errors: {errors:#?}\nactions: {:?}",
        c.actions
    );
    // Re-open the output independently: same verdict.
    let again = validate(&c.bytes, p);
    assert!(
        again.conforms(),
        "{name} {p:?} reopened: {:?}",
        again.findings
    );
    // Output identifies itself.
    let s = String::from_utf8_lossy(&c.bytes);
    match (p.part(), p.conformance()) {
        (Some(part), Some(conf)) => {
            assert!(s.contains(&format!("<pdfaid:part>{part}</pdfaid:part>")));
            assert!(s.contains(&format!("<pdfaid:conformance>{conf}</pdfaid:conformance>")));
            assert!(s.contains("/GTS_PDFA1"));
        }
        _ => assert!(s.contains("PDF/X-4") && s.contains("/GTS_PDFX")),
    }
}

#[test]
fn kitchen_sink_reaches_every_profile() {
    let src = kitchen_sink();
    let before = validate(&src, Profile::A2b);
    for rule in [
        "font-embedded",
        "javascript",
        "stream-filters",
        "image-interpolate",
        "annot-types",
        "annot-flags",
        "annot-appearance",
        "additional-actions",
        "need-appearances",
        "metadata-present",
        "device-colour",
    ] {
        assert!(before.has(rule), "fixture should violate {rule}");
    }
    for p in Profile::ALL {
        if p == Profile::A1b {
            // A-1 cannot draw the highlight (it needs a Multiply blend): honestly reported.
            let c = convert_bytes(src.clone(), None, p, &opts()).unwrap();
            let errors: Vec<_> = c
                .after
                .findings
                .iter()
                .filter(|f| f.severity == Severity::Error)
                .map(|f| f.rule)
                .collect();
            assert!(
                errors.is_empty(),
                "A-1 does not require appearances: {errors:?}"
            );
            continue;
        }
        assert_round_trip("kitchen-sink", &src, p, None);
    }
    // The converted text field keeps its value and its (only /N) appearance; JS is gone.
    let out = convert_bytes(src, None, Profile::A2b, &opts()).unwrap();
    let s = String::from_utf8_lossy(&out.bytes);
    assert!(!s.contains("/JavaScript") && !s.contains("this.print"));
    assert!(
        s.contains("/URI (https://example.com)"),
        "the link survives without its script"
    );
    assert!(s.contains("/V (Ali)"));
    assert!(!s.contains("/Sound"));
    assert!(out
        .actions
        .keys()
        .any(|a| a.id == "embed-font" && a.detail.contains("Times-Bold")));
    assert!(out
        .actions
        .keys()
        .any(|a| a.id == "embed-font" && a.detail.contains("CourierNewPSMT")));
}

#[test]
fn generated_samples_round_trip() {
    let docs: Vec<(&str, Vec<u8>)> = vec![
        ("office", office_doc()),
        (
            "sample-table",
            sample_pdf(
                3,
                &SampleOptions {
                    with_annotation: true,
                    title: Some("Report".into()),
                    ..Default::default()
                },
            )
            .unwrap(),
        ),
        (
            "sample-xref-stream",
            sample_pdf(
                2,
                &SampleOptions {
                    xref_stream: true,
                    compress: true,
                    ..Default::default()
                },
            )
            .unwrap(),
        ),
    ];
    for (name, bytes) in &docs {
        for p in Profile::ALL {
            assert_round_trip(name, bytes, p, None);
        }
    }
}

#[test]
fn incremental_updates_and_encryption_round_trip() {
    // An original with one incremental update (rotate) on top.
    let mut pdf = warraq_pdf::Pdf::open(office_doc(), None).unwrap();
    warraq_pdf::pages::rotate(&mut pdf, &[0], 90).unwrap();
    let updated = pdf.commit().unwrap();
    for p in Profile::ALL {
        assert_round_trip("updated", &updated, p, None);
    }
    // Encrypted with an Arabic owner password.
    let h = SecurityHandler::new_aes256("", "كلمة-سر", &PermissionFlags::all()).unwrap();
    let enc = warraq_pdf::Pdf::open(office_doc(), None)
        .unwrap()
        .write_full(Protection::New(h))
        .unwrap();
    assert_round_trip("encrypted", &enc, Profile::A2b, Some("كلمة-سر"));
}

#[test]
fn layers_and_attachments_round_trip() {
    let mut b = B::new();
    let res = helvetica_res(&mut b);
    b.page("/OC /L1 BDC BT /F1 12 Tf 72 700 Td (layer) Tj ET EMC", res);
    let g1 = b.add(Object::Dictionary(d(vec![
        ("Type", name("OCG")),
        ("Name", lit("Arabic")),
    ])));
    let g2 = b.add(Object::Dictionary(d(vec![
        ("Type", name("OCG")),
        ("Name", lit("English")),
    ])));
    let ef = b.add(Object::Stream(Stream::new(
        d(vec![("Type", name("EmbeddedFile"))]),
        b"a,b\n1,2\n".to_vec(),
    )));
    let fs = b.add(Object::Dictionary(d(vec![
        ("Type", name("Filespec")),
        ("F", lit("data.csv")),
        (
            "EF",
            Object::Dictionary(d(vec![("F", Object::Reference(ef))])),
        ),
    ])));
    let cat = b.cat();
    cat.set(
        "OCProperties",
        Object::Dictionary(d(vec![
            (
                "OCGs",
                arr(vec![Object::Reference(g1), Object::Reference(g2)]),
            ),
            (
                "D",
                Object::Dictionary(d(vec![
                    ("Order", arr(vec![Object::Reference(g1)])),
                    ("AS", arr(vec![])),
                ])),
            ),
        ])),
    );
    cat.set(
        "Names",
        Object::Dictionary(d(vec![(
            "EmbeddedFiles",
            Object::Dictionary(d(vec![(
                "Names",
                arr(vec![lit("data.csv"), Object::Reference(fs)]),
            )])),
        )])),
    );
    let src = b.bytes();
    for p in [Profile::A2b, Profile::A2u, Profile::A3b, Profile::X4] {
        assert_round_trip("layers+attachment", &src, p, None);
    }
    // PDF/A-3 keeps the CSV (as an associated file); PDF/A-2 drops it (not PDF/A).
    let a3 = convert_bytes(src.clone(), None, Profile::A3b, &opts()).unwrap();
    assert!(String::from_utf8_lossy(&a3.bytes).contains("/Subtype /text#2Fcsv"));
    let a2 = convert_bytes(src.clone(), None, Profile::A2b, &opts()).unwrap();
    assert!(a2.actions.keys().any(|a| a.id == "remove-embedded-files"));
    // PDF/A-1 cannot have layers: reported, not hidden.
    let a1 = convert_bytes(src, None, Profile::A1b, &opts()).unwrap();
    assert!(a1.after.has("optional-content"));
}

#[test]
fn fixable_findings_are_fixed() {
    for (name, bytes) in [("kitchen", kitchen_sink()), ("office", office_doc())] {
        for p in Profile::ALL {
            let c = convert_bytes(bytes.clone(), None, p, &opts()).unwrap();
            for f in c
                .before
                .findings
                .iter()
                .filter(|f| f.fixable && f.severity == Severity::Error)
            {
                assert!(
                    !c.after.of(f.rule).any(|g| g.variant == f.variant
                        && g.object.is_some() == f.object.is_some()
                        && g.params == f.params),
                    "{name} {p:?}: fixable {} {} survived",
                    f.rule,
                    f.variant
                );
            }
        }
    }
}

/// Chromium/Skia-made fixtures (subset CID TrueType fonts, Type 3 Arabic fonts) used by the e2e specs.
#[test]
fn chrome_fixtures_round_trip() {
    for name in ["sample-en.pdf", "sample-ar.pdf"] {
        let bytes = std::fs::read(format!(
            "{}/../../../../tests/fixtures/{name}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap();
        for p in Profile::ALL {
            let before = validate(&bytes, p);
            assert!(!before.conforms(), "{name} is not {p:?} before conversion");
            if std::env::var("STD_VERBOSE").is_ok() {
                eprintln!("{name} {p:?} before: {:?}", before.counts);
                let c = convert_bytes(bytes.clone(), None, p, &opts()).unwrap();
                eprintln!(
                    "{name} {p:?} after: {:?}\n{:#?}",
                    c.after.counts,
                    c.after
                        .findings
                        .iter()
                        .filter(|f| f.severity == Severity::Error)
                        .collect::<Vec<_>>()
                );
                continue;
            }
            assert_round_trip(name, &bytes, p, None);
        }
    }
}

/// The generated Arabic corpus (tests/corpus, when present): conversion never fails and every
/// finding the converter claims it can fix is gone.
#[test]
fn corpus_converts() {
    let dir = format!("{}/../../../../tests/corpus", env!("CARGO_MANIFEST_DIR"));
    let Ok(entries) = std::fs::read_dir(&dir) else {
        eprintln!("skipping: no tests/corpus");
        return;
    };
    let mut files = Vec::new();
    let mut stack: Vec<std::path::PathBuf> =
        entries.filter_map(|e| e.ok().map(|e| e.path())).collect();
    while let Some(p) = stack.pop() {
        if p.is_dir() {
            if let Ok(rd) = std::fs::read_dir(&p) {
                stack.extend(rd.filter_map(|e| e.ok().map(|e| e.path())));
            }
        } else if p.extension().is_some_and(|x| x == "pdf") {
            files.push(p);
        }
    }
    files.sort();
    let mut converted = 0;
    for f in files.iter().take(60) {
        let bytes = std::fs::read(f).unwrap();
        let Ok(pdf) = warraq_pdf::Pdf::open(bytes.clone(), None) else {
            continue; // encrypted variants without their password
        };
        drop(pdf);
        let c = convert_bytes(bytes, None, Profile::A2b, &opts())
            .unwrap_or_else(|e| panic!("{}: {e}", f.display()));
        for x in c
            .after
            .findings
            .iter()
            .filter(|x| x.severity == Severity::Error)
        {
            assert!(
                !x.fixable,
                "{}: {} {} is marked fixable but survived conversion",
                f.display(),
                x.rule,
                x.variant
            );
        }
        converted += 1;
    }
    eprintln!("corpus: converted {converted} of {} files", files.len());
    let _ = Dictionary::new();
}
