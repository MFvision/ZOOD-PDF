//! True redaction: text, images, paths, annotations, widgets, /Redact marks, strings elsewhere,
//! earlier revisions, encryption.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod common;

use common::*;
use lopdf::{dictionary, Object, Stream, StringFormat};
use std::io::Write;
use warraq_pdf::{revisions, Pdf, PermissionFlags, Protection, SecurityHandler};
use warraq_redact::apply::{apply_and_rewrite, ApplyOptions, Area};
use warraq_redact::find::{find, FindOptions};
use warraq_redact::patterns::Kind;
use warraq_text::geom::Rect;

fn flate(data: &[u8]) -> Vec<u8> {
    let mut e = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    e.write_all(data).unwrap();
    e.finish().unwrap()
}

/// Latin fixture: secret text, two images, a filled path, annotations, a widget, title,
/// bookmark — and a second (incremental) revision on top.
fn latin_fixture() -> Vec<u8> {
    let mut b = Builder::new();
    let im1 = b.doc.add_object(Stream::new(
        dictionary! {"Type" => "XObject", "Subtype" => "Image", "Width" => 10, "Height" => 10,
        "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8, "Filter" => "FlateDecode"},
        flate(&[0xFF; 100]),
    ));
    let im2 = b.doc.add_object(Stream::new(
        dictionary! {"Type" => "XObject", "Subtype" => "Image", "Width" => 4, "Height" => 4,
        "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8},
        vec![0x80; 48],
    ));
    let content = b"BT /F1 12 Tf 72 700 Td (Name: Ahmed Secretvalue) Tj ET\n\
BT /F1 12 Tf 72 680 Td (Keep this line) Tj ET\n\
q 100 0 0 100 300 400 cm /Im1 Do Q\n\
q 50 0 0 50 100 400 cm /Im2 Do Q\n\
0 0 1 rg 72 300 200 20 re f\n";
    let note = b.doc.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "FreeText", "Rect" => vec![200.into(), 695.into(), 260.into(), 715.into()],
        "Contents" => Object::string_literal("Secretvalue note"), "DA" => Object::string_literal("/Helv 10 Tf 0 g"),
    });
    let far = b.doc.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Text", "Rect" => vec![500.into(), 100.into(), 520.into(), 120.into()],
        "Contents" => Object::string_literal("see Secretvalue later"),
    });
    let widget = b.doc.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Widget", "FT" => "Tx", "T" => Object::string_literal("name"),
        "V" => Object::string_literal("Secretvalue"), "Rect" => vec![150.into(), 690.into(), 240.into(), 712.into()],
    });
    let page = b.page(
        content,
        dictionary! {"XObject" => dictionary! {"Im1" => im1, "Im2" => im2}},
        vec![note.into(), far.into(), widget.into()],
    );
    let outline_item = b.doc.new_object_id();
    let outlines = b.doc.add_object(dictionary! {"Type" => "Outlines", "First" => outline_item, "Last" => outline_item, "Count" => 1});
    b.doc.objects.insert(
        outline_item,
        Object::Dictionary(dictionary! {"Title" => Object::string_literal("Secretvalue chapter"), "Parent" => outlines,
            "Dest" => vec![page.into(), "Fit".into()]}),
    );
    b.catalog.set("Outlines", outlines);
    b.catalog
        .set("AcroForm", dictionary! {"Fields" => vec![widget.into()]});
    let info = b
        .doc
        .add_object(dictionary! {"Title" => Object::string_literal("Report for Secretvalue")});
    b.doc.trailer.set("Info", info);
    let bytes = b.finish();
    // Second revision: a harmless change appended incrementally.
    let mut pdf = Pdf::open(bytes, None).unwrap();
    let mut m = std::collections::BTreeMap::new();
    m.insert("Author".to_string(), Some("Tester".to_string()));
    warraq_pdf::metadata::set_info(&mut pdf, &m).unwrap();
    pdf.commit().unwrap()
}

fn find_query(pdf: &Pdf, q: &str) -> Vec<warraq_redact::find::FindHit> {
    find(
        pdf,
        &FindOptions {
            query: Some(q.into()),
            ..Default::default()
        },
    )
    .unwrap()
    .hits
}

fn areas_of(hits: &[warraq_redact::find::FindHit]) -> Vec<Area> {
    hits.iter()
        .flat_map(|h| {
            h.rects.iter().map(move |r| Area {
                page: h.page,
                rect: Rect::new(r[0], r[1], r[2], r[3]),
                fill: None,
                overlay: None,
            })
        })
        .collect()
}

#[test]
fn text_is_removed_from_content_revisions_and_strings() {
    let bytes = latin_fixture();
    assert!(contains(&bytes, b"Secretvalue"));
    assert_eq!(revisions::revisions(&bytes, &Default::default()).len(), 2);
    let mut pdf = Pdf::open(bytes, None).unwrap();
    let hits = find_query(&pdf, "secretvalue");
    assert_eq!(hits.len(), 1, "{hits:?}");
    let mut areas = areas_of(&hits);
    // Part of image 1 (left half), all of image 2, part of the blue bar.
    areas.push(Area {
        page: 0,
        rect: Rect::new(290.0, 390.0, 350.0, 510.0),
        fill: None,
        overlay: None,
    });
    areas.push(Area {
        page: 0,
        rect: Rect::new(90.0, 390.0, 160.0, 460.0),
        fill: None,
        overlay: None,
    });
    areas.push(Area {
        page: 0,
        rect: Rect::new(100.0, 290.0, 150.0, 330.0),
        fill: None,
        overlay: None,
    });
    let (out, rep) = apply_and_rewrite(
        &mut pdf,
        &ApplyOptions {
            areas,
            ..Default::default()
        },
    )
    .unwrap();

    assert_eq!(
        revisions::revisions(&out, &Default::default()).len(),
        1,
        "one revision"
    );
    let red = Pdf::open(out.clone(), None).unwrap();
    let all = everything(&red);
    assert!(!contains(&all, b"Secretvalue"), "nowhere in the file");
    assert!(!contains(&all, b"ecretvalu"));
    assert!(!contains(&all, &utf16_bytes("Secretvalue")));
    let text = plain(&red);
    assert!(text.contains("Name: Ahmed"), "{text}");
    assert!(text.contains("Keep this line"), "{text}");
    assert!(!text.contains("Secret"), "{text}");
    assert!(find_query(&red, "secretvalue").is_empty());

    assert_eq!(rep.content.glyphs_removed, "Secretvalue".len());
    assert_eq!(rep.content.images_redacted, 1);
    assert_eq!(rep.content.images_removed, 1);
    assert_eq!(rep.content.paths_clipped, 1);
    assert_eq!(
        rep.annotations_removed, 2,
        "free text + widget overlap the area"
    );
    assert_eq!(rep.fields_removed, 1);
    assert!(
        rep.strings_scrubbed >= 3,
        "title, far note, bookmark: {rep:?}"
    );

    // The far annotation survives with its contents scrubbed; the widget and field are gone.
    let info = warraq_pdf::metadata::get_info(&red);
    assert_eq!(info.get("Title").map(String::as_str), Some("Report for "));
    let annots: Vec<_> = red
        .objects()
        .values()
        .filter_map(|o| o.as_dict().ok())
        .filter(|d| {
            d.has(b"Subtype")
                && d.get(b"Type")
                    .is_ok_and(|t| t.as_name().ok() == Some(b"Annot"))
        })
        .collect();
    assert_eq!(annots.len(), 1);
    let fields = red
        .catalog()
        .unwrap()
        .get(b"AcroForm")
        .and_then(|a| red.resolve(a).unwrap().as_dict().cloned())
        .unwrap();
    assert_eq!(fields.get(b"Fields").unwrap().as_array().unwrap().len(), 0);

    // Image 1: redacted copy with the covered columns cleared; image 2 gone.
    let images: Vec<&Stream> = red
        .objects()
        .values()
        .filter_map(|o| o.as_stream().ok())
        .filter(|s| {
            s.dict
                .get(b"Subtype")
                .is_ok_and(|t| t.as_name().ok() == Some(b"Image"))
        })
        .collect();
    assert_eq!(images.len(), 1);
    let px = images[0].decompressed_content().unwrap();
    assert_eq!(px.len(), 100);
    for row in 0..10 {
        assert!(
            px[row * 10..row * 10 + 5].iter().all(|&v| v == 0),
            "row {row}"
        );
        assert!(
            px[row * 10 + 5..row * 10 + 10].iter().all(|&v| v == 0xFF),
            "row {row}"
        );
    }
}

fn arabic_fixture() -> Vec<u8> {
    let mut b = Builder::new();
    let mut c = b.arabic("كتب محمد بن عبدالله الرسالة", 540.0, 700.0, 18.0);
    c.extend(b.arabic("وقرأها محمد في المساء", 540.0, 660.0, 18.0));
    c.extend(b.arabic("سطر لا يتغير", 540.0, 620.0, 18.0));
    b.page(&c, dictionary! {}, vec![]);
    b.finish()
}

#[test]
fn arabic_word_found_with_tashkeel_is_removed() {
    let mut pdf = Pdf::open(arabic_fixture(), None).unwrap();
    let before = plain(&pdf);
    assert!(before.contains("محمد"), "{before}");
    let hits = find_query(&pdf, "مُحَمَّد");
    assert_eq!(hits.len(), 2, "{hits:?}");
    let (out, rep) = apply_and_rewrite(
        &mut pdf,
        &ApplyOptions {
            areas: areas_of(&hits),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(rep.content.glyphs_removed > 0);
    assert!(rep.content.actual_text_cleared >= 2, "{rep:?}");
    let red = Pdf::open(out, None).unwrap();
    let text = plain(&red);
    assert!(!text.contains("محمد"), "{text}");
    assert!(text.contains("عبدالله"), "{text}");
    assert!(text.contains("سطر لا يتغير"), "{text}");
    assert!(find_query(&red, "محمد").is_empty());
    let all = everything(&red);
    assert!(!contains(&all, &utf16_bytes("محمد")));
    assert!(!contains(&all, "محمد".as_bytes()));
}

#[test]
fn redact_annotations_become_true_removal() {
    let bytes = latin_fixture();
    let pdf0 = Pdf::open(bytes.clone(), None).unwrap();
    let hit = &find_query(&pdf0, "Secretvalue")[0];
    let r = hit.rects[0];
    // Add a /Redact mark like EmbedPDF's (QuadPoints: x1 y1 x2 y2 x3 y3 x4 y4 = UL UR LL LR).
    let mut pdf = Pdf::open(bytes, None).unwrap();
    let quad: Vec<Object> = [r[0], r[3], r[2], r[3], r[0], r[1], r[2], r[1]]
        .iter()
        .map(|v| Object::Real(*v as f32))
        .collect();
    let mark = pdf.add(Object::Dictionary(dictionary! {
        "Type" => "Annot", "Subtype" => "Redact", "Rect" => vec![r[0].into(), r[1].into(), r[2].into(), r[3].into()],
        "QuadPoints" => quad, "IC" => vec![1.into(), 0.into(), 0.into()],
        "OverlayText" => Object::String(b"REDACTED".to_vec(), StringFormat::Literal),
    }));
    let page = warraq_pdf::pages::flatten(&pdf).unwrap()[0].id;
    let mut pd = pdf.get_dict(page).unwrap().clone();
    let mut annots = pd.get(b"Annots").unwrap().as_array().unwrap().clone();
    annots.push(mark.into());
    pd.set("Annots", annots);
    pdf.set(page, Object::Dictionary(pd));
    let marked = pdf.commit().unwrap();

    let mut pdf = Pdf::open(marked, None).unwrap();
    let (out, rep) = apply_and_rewrite(
        &mut pdf,
        &ApplyOptions {
            use_annotations: true,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(rep.redact_annotations, 1);
    let red = Pdf::open(out, None).unwrap();
    assert!(!contains(&everything(&red), b"Secretvalue"));
    let text = plain(&red);
    assert!(text.contains("REDACTED"), "overlay text drawn: {text}");
    assert!(!red.objects().values().any(|o| o.as_dict().is_ok_and(|d| d
        .get(b"Subtype")
        .is_ok_and(|s| s.as_name().ok() == Some(b"Redact")))));
    // Red fill box drawn.
    let content = String::from_utf8_lossy(&everything(&red)).to_string();
    assert!(content.contains("1 0 0 rg"), "fill colour from /IC");
}

#[test]
fn overlay_text_in_arabic_needs_a_font_and_is_shaped() {
    let mut pdf = Pdf::open(arabic_fixture(), None).unwrap();
    let hits = find_query(&pdf, "محمد");
    let opts = ApplyOptions {
        areas: areas_of(&hits),
        overlay_text: Some("محجوب".into()),
        ..Default::default()
    };
    let err =
        apply_and_rewrite(&mut Pdf::open(arabic_fixture(), None).unwrap(), &opts).unwrap_err();
    assert_eq!(err.code(), "font_required");
    let opts = ApplyOptions {
        font: Some(amiri()),
        ..opts
    };
    let (out, _) = apply_and_rewrite(&mut pdf, &opts).unwrap();
    let red = Pdf::open(out, None).unwrap();
    let text = plain(&red);
    assert_eq!(text.matches("محجوب").count(), 2, "{text}");
    assert!(!text.contains("محمد"));
}

#[test]
fn encrypted_documents_stay_encrypted() {
    let pdf = Pdf::open(latin_fixture(), None).unwrap();
    let h = SecurityHandler::new_aes256("user-pw", "owner-pw", &PermissionFlags::all()).unwrap();
    let enc = pdf.write_full(Protection::New(h)).unwrap();
    assert!(Pdf::open(enc.clone(), None).is_err());
    let mut pdf = Pdf::open(enc, Some("owner-pw")).unwrap();
    let hits = find_query(&pdf, "Secretvalue");
    let (out, _) = apply_and_rewrite(
        &mut pdf,
        &ApplyOptions {
            areas: areas_of(&hits),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(
        Pdf::open(out.clone(), None).unwrap_err().code(),
        "password_required"
    );
    let red = Pdf::open(out, Some("user-pw")).unwrap();
    assert!(red.is_encrypted());
    assert!(!plain(&red).contains("Secretvalue"));
}

#[test]
fn user_password_without_modify_right_is_refused() {
    let pdf = Pdf::open(latin_fixture(), None).unwrap();
    let perms = PermissionFlags {
        modify: false,
        ..PermissionFlags::all()
    };
    let h = SecurityHandler::new_aes256("u", "o", &perms).unwrap();
    let enc = pdf.write_full(Protection::New(h)).unwrap();
    let mut pdf = Pdf::open(enc, Some("u")).unwrap();
    let areas = vec![Area {
        page: 0,
        rect: Rect::new(0.0, 0.0, 10.0, 10.0),
        fill: None,
        overlay: None,
    }];
    let e = apply_and_rewrite(
        &mut pdf,
        &ApplyOptions {
            areas,
            ..Default::default()
        },
    )
    .unwrap_err();
    assert_eq!(e.code(), "permission_denied");
}

#[test]
fn patterns_find_and_redact_personal_data() {
    let mut b = Builder::new();
    let mut c = b"BT /F1 11 Tf 72 700 Td (Contact: sara.k@example.com today) Tj ET\n\
BT /F1 11 Tf 72 680 Td (National ID 1010101010 and not 1000000009) Tj ET\n\
BT /F1 11 Tf 72 660 Td (IBAN SA03 8000 0000 6080 1016 7519 end) Tj ET\n\
BT /F1 11 Tf 72 640 Td (Card 4111 1111 1111 1111 exp) Tj ET\n\
BT /F1 11 Tf 72 620 Td (Mobile 050-123-4567 or +966 55 123 4567) Tj ET\n\
BT /F1 11 Tf 72 600 Td (Date 15/01/2024 ok) Tj ET\n"
        .to_vec();
    c.extend(b.arabic(
        "رقم الإقامة ٢٠٠٠٠٠٠٠٠٦ والجوال ٠٥٠١٢٣٤٥٦٧",
        540.0,
        560.0,
        16.0,
    ));
    c.extend(b.arabic("التاريخ ١٥ رمضان ١٤٤٥هـ", 540.0, 530.0, 16.0));
    b.page(&c, dictionary! {}, vec![]);
    let mut pdf = Pdf::open(b.finish(), None).unwrap();
    let r = find(
        &pdf,
        &FindOptions {
            patterns: vec![
                Kind::Email,
                Kind::SaudiId,
                Kind::Iban,
                Kind::Card,
                Kind::Phone,
                Kind::Date,
            ],
            ..Default::default()
        },
    )
    .unwrap();
    let kinds = |k: Kind| {
        r.hits
            .iter()
            .filter(|h| h.kind == k)
            .map(|h| h.text.clone())
            .collect::<Vec<_>>()
    };
    assert_eq!(kinds(Kind::Email), ["sara.k@example.com"]);
    let ids = kinds(Kind::SaudiId);
    assert!(ids.contains(&"1010101010".to_string()), "{ids:?}");
    assert!(ids.iter().any(|t| t.contains("٢٠٠٠٠٠٠٠٠٦")), "{ids:?}");
    assert_eq!(ids.len(), 2, "1000000009 fails the check digit");
    assert_eq!(kinds(Kind::Iban), ["SA03 8000 0000 6080 1016 7519"]);
    assert_eq!(kinds(Kind::Card), ["4111 1111 1111 1111"]);
    let phones = kinds(Kind::Phone);
    assert!(phones.contains(&"050-123-4567".to_string()), "{phones:?}");
    assert!(
        phones.contains(&"+966 55 123 4567".to_string()),
        "{phones:?}"
    );
    assert!(
        phones.iter().any(|t| t.contains("٠٥٠١٢٣٤٥٦٧")),
        "{phones:?}"
    );
    let dates = kinds(Kind::Date);
    assert!(dates.contains(&"15/01/2024".to_string()), "{dates:?}");
    assert!(dates.iter().any(|t| t.contains("رمضان")), "{dates:?}");
    for h in &r.hits {
        assert!(!h.rects.is_empty() && h.rects.len() == h.view_rects.len());
    }

    let (out, _) = apply_and_rewrite(
        &mut pdf,
        &ApplyOptions {
            areas: areas_of(&r.hits),
            ..Default::default()
        },
    )
    .unwrap();
    let red = Pdf::open(out, None).unwrap();
    let text = plain(&red);
    for gone in [
        "sara.k@example.com",
        "1010101010",
        "SA03",
        "4111",
        "050-123",
        "15/01/2024",
        "٢٠٠٠٠٠٠٠٠٦",
        "رمضان",
    ] {
        assert!(!text.contains(gone), "{gone} in {text}");
    }
    assert!(text.contains("1000000009"), "invalid ID kept: {text}");
    assert!(text.contains("Contact:"), "{text}");
}

#[test]
fn custom_regex_and_bad_patterns() {
    let mut b = Builder::new();
    b.page(
        b"BT /F1 11 Tf 72 700 Td (Invoice INV-2024 and INV-2025) Tj ET",
        dictionary! {},
        vec![],
    );
    let pdf = Pdf::open(b.finish(), None).unwrap();
    let r = find(
        &pdf,
        &FindOptions {
            regex: Some(r"INV-\d{4}".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(r.hits.len(), 2);
    assert_eq!(r.hits[0].text, "INV-2024");
    let e = find(
        &pdf,
        &FindOptions {
            regex: Some("(".into()),
            ..Default::default()
        },
    )
    .unwrap_err();
    assert_eq!(e.code(), "invalid_pattern");
    let e = find(&pdf, &FindOptions::default()).unwrap_err();
    assert_eq!(e.code(), "invalid_params");
}

#[test]
fn inline_images_and_forms_are_redacted() {
    let mut b = Builder::new();
    let form = b.doc.add_object(Stream::new(
        dictionary! {"Type" => "XObject", "Subtype" => "Form", "BBox" => vec![0.into(), 0.into(), 300.into(), 50.into()],
            "Resources" => dictionary! {"Font" => dictionary! {"F1" => b.helv}}},
        b"BT /F1 12 Tf 10 10 Td (FormSecret visible) Tj ET".to_vec(),
    ));
    let content = b"q 1 0 0 1 72 500 cm /Fm1 Do Q\nq 1 0 0 1 72 600 cm /Fm1 Do Q\nq 40 0 0 40 300 300 cm BI /W 4 /H 4 /BPC 8 /CS /G ID \xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff EI Q";
    b.page(
        content,
        dictionary! {"XObject" => dictionary! {"Fm1" => form}},
        vec![],
    );
    let mut pdf = Pdf::open(b.finish(), None).unwrap();
    let hits = find_query(&pdf, "FormSecret");
    assert_eq!(hits.len(), 2);
    // Only the lower occurrence + the left half of the inline image.
    let lower: Vec<_> = hits.into_iter().filter(|h| h.rects[0][1] < 550.0).collect();
    let mut areas = areas_of(&lower);
    areas.push(Area {
        page: 0,
        rect: Rect::new(290.0, 290.0, 320.0, 350.0),
        fill: None,
        overlay: None,
    });
    let (out, rep) = apply_and_rewrite(
        &mut pdf,
        &ApplyOptions {
            areas,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(rep.content.forms_rewritten, 1);
    assert_eq!(rep.content.inline_images_redacted, 1);
    let red = Pdf::open(out, None).unwrap();
    let text = plain(&red);
    assert_eq!(
        text.matches("FormSecret").count(),
        1,
        "the shared form keeps the other use: {text}"
    );
    assert_eq!(text.matches("visible").count(), 2, "{text}");
    let all = String::from_utf8_lossy(&everything(&red)).to_string();
    assert!(
        all.contains("/F /AHx ID 0000FFFF0000FFFF0000FFFF0000FFFF> EI"),
        "left half of inline image cleared"
    );
}

#[test]
fn undecodable_images_are_removed_and_reported() {
    let mut b = Builder::new();
    let jbig = b.doc.add_object(Stream::new(
        dictionary! {"Type" => "XObject", "Subtype" => "Image", "Width" => 8, "Height" => 8,
        "ColorSpace" => "DeviceGray", "BitsPerComponent" => 1, "Filter" => "JBIG2Decode"},
        vec![1, 2, 3],
    ));
    b.page(
        b"q 100 0 0 100 100 100 cm /J Do Q",
        dictionary! {"XObject" => dictionary! {"J" => jbig}},
        vec![],
    );
    let mut pdf = Pdf::open(b.finish(), None).unwrap();
    let areas = vec![Area {
        page: 0,
        rect: Rect::new(100.0, 100.0, 120.0, 120.0),
        fill: None,
        overlay: None,
    }];
    let (out, rep) = apply_and_rewrite(
        &mut pdf,
        &ApplyOptions {
            areas,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(rep.content.images_removed, 1);
    assert!(!rep.content.undecodable.is_empty());
    let red = Pdf::open(out, None).unwrap();
    assert!(!red
        .objects()
        .values()
        .any(|o| o.as_stream().is_ok_and(|s| s.dict.has(b"Width"))));
}

#[test]
fn jpeg_images_are_decoded_and_cleared() {
    // A 16×16 grey baseline JPEG (all white) made by hand with the zune encoder is not
    // available; use a tiny known-good JPEG from the corpus generator if present.
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/white16.jpg");
    let Ok(jpg) = std::fs::read(path) else { return };
    let mut b = Builder::new();
    let im = b.doc.add_object(Stream::new(
        dictionary! {"Type" => "XObject", "Subtype" => "Image", "Width" => 16, "Height" => 16,
        "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8, "Filter" => "DCTDecode"},
        jpg,
    ));
    b.page(
        b"q 160 0 0 160 100 100 cm /I Do Q",
        dictionary! {"XObject" => dictionary! {"I" => im}},
        vec![],
    );
    let mut pdf = Pdf::open(b.finish(), None).unwrap();
    let areas = vec![Area {
        page: 0,
        rect: Rect::new(90.0, 180.0, 300.0, 300.0),
        fill: None,
        overlay: None,
    }];
    let (out, rep) = apply_and_rewrite(
        &mut pdf,
        &ApplyOptions {
            areas,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(rep.content.images_redacted, 1);
    let red = Pdf::open(out, None).unwrap();
    let s = red
        .objects()
        .values()
        .filter_map(|o| o.as_stream().ok())
        .find(|s| s.dict.has(b"Width"))
        .unwrap();
    let px = s.decompressed_content().unwrap();
    assert_eq!(px.len(), 256);
    assert!(px[..16 * 8].iter().all(|&v| v == 0), "top half cleared");
    assert!(px[16 * 8..].iter().all(|&v| v > 200), "bottom half white");
}
