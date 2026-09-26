//! Page marks proofs: marks read back in logical order (Arabic, Arabic-Indic digits), are tagged
//! pagination artifacts drawn from form XObjects, stand upright on rotated/cropped pages, are
//! found by search and removed by redaction, are never editable text, and can be listed,
//! updated and removed without touching any other content byte. Every change is an incremental
//! update (the original bytes stay an exact prefix).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic,
    clippy::needless_range_loop
)]

use std::path::PathBuf;

use lopdf::{dictionary, Document, Object, ObjectId, Stream};
use serde_json::{json, Value};
use warraq_marks::api;
use warraq_marks::foreign::{self, ForeignKind};
use warraq_marks::marks;
use warraq_marks::model::MarkSpec;
use warraq_pdf::{pages, Pdf};
use warraq_text::{extract_all, search::search, DocSource, LayoutOptions, PageText};

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../..")
}

/// A document with `n` pages, each with a Helvetica body line "Body text N".
fn doc(n: usize, rotate: i64, crop: Option<[i64; 4]>) -> Vec<u8> {
    let mut d = Document::with_version("1.7");
    let pages_id = d.new_object_id();
    let font = d.add_object(dictionary! {
        "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica", "Encoding" => "WinAnsiEncoding",
    });
    let mut kids = Vec::new();
    for i in 0..n {
        let content = format!("BT /F1 18 Tf 72 700 Td (Body text {}) Tj ET\n", i + 1);
        let c = d.add_object(Stream::new(dictionary! {}, content.into_bytes()));
        let mut page = dictionary! {
            "Type" => "Page", "Parent" => pages_id, "Contents" => c,
            "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
            "Resources" => dictionary! { "Font" => dictionary! { "F1" => font } },
        };
        if rotate != 0 {
            page.set("Rotate", rotate);
        }
        if let Some(b) = crop {
            page.set(
                "CropBox",
                b.iter().map(|v| Object::Integer(*v)).collect::<Vec<_>>(),
            );
        }
        kids.push(Object::Reference(d.add_object(page)));
    }
    d.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => kids, "Count" => n as i64 }),
    );
    let cat = d.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    d.trailer.set("Root", cat);
    let mut out = Vec::new();
    d.save_to(&mut out).unwrap();
    out
}

fn spec(v: Value) -> MarkSpec {
    serde_json::from_value(v).unwrap()
}

fn text_pages(pdf: &Pdf, artifacts: bool) -> Vec<PageText> {
    let src = DocSource::borrowed(pdf.document());
    extract_all(
        &src,
        &LayoutOptions {
            include_artifacts: artifacts,
            ..LayoutOptions::default()
        },
    )
    .unwrap()
}

fn commit(pdf: &mut Pdf, before: &[u8]) -> Vec<u8> {
    let bytes = pdf.commit().unwrap();
    assert!(bytes.starts_with(before), "original bytes must be a prefix");
    assert!(bytes.len() > before.len());
    bytes
}

fn contents_of(pdf: &Pdf, page: usize) -> Object {
    let id = pages::flatten(pdf).unwrap()[page].id;
    pdf.get_dict(id).unwrap().get(b"Contents").unwrap().clone()
}

/// Decoded bytes of every content stream of the page that is not ours.
fn original_streams(pdf: &Pdf, page: usize) -> Vec<(ObjectId, Vec<u8>)> {
    let id = pages::flatten(pdf).unwrap()[page].id;
    warraq_marks::store::contents_ro(pdf, id)
        .iter()
        .filter(|o| warraq_marks::store::classify(pdf, o) == warraq_marks::store::Item::Original)
        .map(|o| {
            let Object::Reference(r) = o else { panic!() };
            let Some(Object::Stream(s)) = pdf.get(*r) else {
                panic!()
            };
            (*r, s.content.clone())
        })
        .collect()
}

const FOOTER_AR: &str = "صفحة {page} من {pages}";

#[test]
fn arabic_page_numbers_read_back_in_logical_order_with_arabic_indic_digits() {
    let original = doc(3, 0, None);
    let mut pdf = Pdf::open(original.clone(), None).unwrap();
    let r = marks::add(
        &mut pdf,
        &spec(json!({ "kind": "pageNumber", "text": FOOTER_AR, "digits": "arabic", "lang": "ar", "rtl": true })),
        None,
        None,
        None,
        None,
    )
    .unwrap();
    assert_eq!(r.pages, vec![0, 1, 2]);
    let bytes = commit(&mut pdf, &original);
    let pdf = Pdf::open(bytes.clone(), None).unwrap();
    let pages = text_pages(&pdf, true);
    for (i, p) in pages.iter().enumerate() {
        let want = format!("صفحة {} من ٣", ["١", "٢", "٣"][i]);
        assert!(p.plain.contains(&want), "page {i}: {:?}", p.plain);
        assert!(p.plain.contains(&format!("Body text {}", i + 1)));
    }
    // Tagged as pagination artifacts: gone when artifacts are excluded.
    for p in text_pages(&pdf, false) {
        assert!(!p.plain.contains("صفحة"), "{:?}", p.plain);
    }
    // Shaped Arabic in an embedded Amiri subset; never /Direction; ActualText per word.
    let s = String::from_utf8_lossy(&bytes);
    assert!(s.contains("+Amiri-Regular"));
    assert!(!s.contains("/Direction"));
    let form = find_form(&pdf, 1);
    let data = String::from_utf8_lossy(&form);
    assert!(data.contains("/ActualText"));
    assert!(!data.contains(" 2 Tr") && !data.contains("\n2 Tr"));
    // Footer is at the bottom, centred.
    let w = pages[1]
        .paragraphs()
        .flat_map(|p| p.lines.iter())
        .flat_map(|l| l.words.iter())
        .find(|w| w.artifact)
        .unwrap();
    assert!(w.bbox.y1 > 842.0 - 60.0, "{:?}", w.bbox);
}

/// Decoded content of the mark form drawn on `page`.
fn find_form(pdf: &Pdf, page: usize) -> Vec<u8> {
    let id = pages::flatten(pdf).unwrap()[page].id;
    let res = warraq_edit::page::resources(pdf, id);
    let Ok(Object::Dictionary(x)) = res.get(b"XObject") else {
        panic!("no XObject resources")
    };
    for (_, v) in x.iter() {
        if let Some(Object::Stream(s)) = pdf.resolve(v) {
            if s.dict.has(b"ZOODMark") {
                return warraq_pdf::limits::decode_stream(s, pdf.limits()).unwrap();
            }
        }
    }
    panic!("no mark form")
}

#[test]
fn search_finds_mark_text_and_redaction_removes_it() {
    let original = doc(3, 0, None);
    let mut pdf = Pdf::open(original.clone(), None).unwrap();
    marks::add(
        &mut pdf,
        &spec(json!({ "kind": "footer", "slots": { "center": FOOTER_AR }, "digits": "arabic", "lang": "ar" })),
        None,
        None,
        None,
        None,
    )
    .unwrap();
    let bytes = commit(&mut pdf, &original);
    let mut pdf = Pdf::open(bytes, None).unwrap();
    // text.search (the RPC the UI uses) finds «صفحة ٢ من ٣» on page 2 only.
    let pages = text_pages(&pdf, true);
    let hits = search(&pages, "صفحة ٢ من ٣");
    assert_eq!(hits.len(), 1, "{hits:?}");
    assert_eq!(hits[0].page, 1);
    // Western digits in the query find it too (search folds digit forms).
    assert_eq!(search(&pages, "صفحة 2 من 3").len(), 1);
    // Redaction: find + apply removes the mark's text from page 2.
    let found = warraq_redact::find::find(
        &pdf,
        &warraq_redact::find::FindOptions {
            query: Some("صفحة ٢ من ٣".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(found.hits.len(), 1);
    let h = &found.hits[0];
    let areas = h
        .rects
        .iter()
        .map(|r| warraq_redact::apply::Area {
            page: h.page,
            rect: warraq_text::geom::Rect::new(r[0], r[1], r[2], r[3]),
            fill: None,
            overlay: None,
        })
        .collect();
    let (out, _) = warraq_redact::apply::apply_and_rewrite(
        &mut pdf,
        &warraq_redact::apply::ApplyOptions {
            areas,
            ..Default::default()
        },
    )
    .unwrap();
    let pdf = Pdf::open(out, None).unwrap();
    let after = text_pages(&pdf, true);
    assert!(!after[1].plain.contains("صفحة"), "{:?}", after[1].plain);
    assert!(after[0].plain.contains("صفحة ١ من ٣"));
    assert!(after[2].plain.contains("صفحة ٣ من ٣"));
    assert!(after[1].plain.contains("Body text 2"));
}

#[test]
fn mark_text_is_never_an_editable_block() {
    let original = doc(1, 0, None);
    let mut pdf = Pdf::open(original.clone(), None).unwrap();
    marks::add(
        &mut pdf,
        &spec(json!({ "kind": "watermark", "text": "سري للغاية", "diagonal": true })),
        None,
        None,
        None,
        None,
    )
    .unwrap();
    let bytes = commit(&mut pdf, &original);
    let pdf = Pdf::open(bytes, None).unwrap();
    assert!(text_pages(&pdf, true)[0].plain.contains("سري للغاية"));
    let blocks = warraq_edit::text::blocks(&pdf, 0).unwrap();
    assert!(blocks.iter().any(|b| b.text.contains("Body text 1")));
    assert!(blocks.iter().all(|b| !b.text.contains("سري")), "{blocks:?}");
}

#[test]
fn diagonal_watermark_has_opacity_rotation_and_artifact_tag() {
    let original = doc(2, 0, None);
    let mut pdf = Pdf::open(original.clone(), None).unwrap();
    marks::add(
        &mut pdf,
        &spec(json!({ "kind": "watermark", "text": "سري", "diagonal": true, "opacity": 0.3, "font": "cairo", "layer": "behind" })),
        None,
        None,
        None,
        None,
    )
    .unwrap();
    let bytes = commit(&mut pdf, &original);
    let pdf = Pdf::open(bytes.clone(), None).unwrap();
    let s = String::from_utf8_lossy(&bytes);
    assert!(s.contains("+Cairo-Regular"));
    // Behind the content: the mark stream comes first.
    let Object::Array(items) = contents_of(&pdf, 0) else {
        panic!("contents array")
    };
    let first = match &items[0] {
        Object::Reference(r) => pdf.get(*r).unwrap().as_stream().unwrap().clone(),
        _ => panic!(),
    };
    let data = warraq_pdf::limits::decode_stream(&first, pdf.limits()).unwrap();
    let data = String::from_utf8_lossy(&data);
    assert!(
        data.contains("/Artifact <</Type /Pagination /Subtype /Watermark"),
        "{data}"
    );
    // Opacity through an ExtGState (both fill and stroke alpha).
    let form = String::from_utf8_lossy(&find_form(&pdf, 0)).to_string();
    assert!(form.starts_with("/ZG1 gs"));
    let has_gs = pdf.objects().values().any(|o| match o {
        Object::Dictionary(d) => match d.get(b"ExtGState") {
            Ok(Object::Dictionary(g)) => match g.get(b"ZG1") {
                Ok(Object::Dictionary(gs)) => {
                    matches!(gs.get(b"ca"), Ok(Object::Real(v)) if (*v - 0.3).abs() < 1e-6)
                        && matches!(gs.get(b"CA"), Ok(Object::Real(v)) if (*v - 0.3).abs() < 1e-6)
                }
                _ => false,
            },
            _ => false,
        },
        _ => false,
    });
    assert!(has_gs);
    // Diagonal: the placement matrix rotates by atan(842/595) ≈ 54.75°.
    let cm_line = form
        .lines()
        .find(|l| l.ends_with(" cm"))
        .unwrap()
        .trim_start_matches("q ");
    let v: Vec<f64> = cm_line
        .split_whitespace()
        .take(6)
        .map(|x| x.parse().unwrap())
        .collect();
    let deg = v[1].atan2(v[0]).to_degrees();
    assert!(
        (deg - (842f64).atan2(595.0).to_degrees()).abs() < 0.1,
        "{deg}"
    );
    assert!(text_pages(&pdf, true)[1].plain.contains("سري"));
}

#[test]
fn marks_stand_upright_in_the_visible_box_of_rotated_and_cropped_pages() {
    for rotate in [0, 90, 180, 270] {
        let crop = [50, 100, 545, 742];
        let original = doc(1, rotate, Some(crop));
        let mut pdf = Pdf::open(original.clone(), None).unwrap();
        marks::add(
            &mut pdf,
            &spec(json!({ "kind": "header", "slots": { "start": "HEADTEXT" }, "margin": 20 })),
            None,
            None,
            None,
            None,
        )
        .unwrap();
        let bytes = commit(&mut pdf, &original);
        let pdf = Pdf::open(bytes, None).unwrap();
        let p = &text_pages(&pdf, true)[0];
        assert!(
            p.plain.contains("HEADTEXT"),
            "rotate {rotate}: {:?}",
            p.plain
        );
        // Word boxes are relative to the visible box's top-left corner (unrotated, y down).
        let w = p
            .paragraphs()
            .flat_map(|p| p.lines.iter())
            .flat_map(|l| l.words.iter())
            .find(|w| w.text.contains("HEADTEXT"))
            .unwrap();
        let (vw, vh) = ((crop[2] - crop[0]) as f64, (crop[3] - crop[1]) as f64);
        let b = w.bbox;
        assert!(
            b.x0 >= -0.5 && b.y0 >= -0.5 && b.x1 <= vw + 0.5 && b.y1 <= vh + 0.5,
            "rotate {rotate}: {b:?} outside the crop box"
        );
        // The displayed top-left corner (start of an LTR header) in unrotated coordinates.
        let near = |x: f64, y: f64| {
            (b.x0 - x).abs().min((b.x1 - x).abs()) < 40.0
                && (b.y0 - y).abs().min((b.y1 - y).abs()) < 40.0
        };
        let ok = match rotate {
            0 => near(0.0, 0.0),
            90 => near(0.0, vh),
            180 => near(vw, vh),
            _ => near(vw, 0.0),
        };
        assert!(
            ok,
            "rotate {rotate}: header at {b:?} is not at the displayed top-left"
        );
    }
}

#[test]
fn list_update_and_remove_leave_every_other_content_byte_identical() {
    let original = doc(3, 0, None);
    let pdf0 = Pdf::open(original.clone(), None).unwrap();
    let before: Vec<Object> = (0..3).map(|i| contents_of(&pdf0, i)).collect();
    let streams_before: Vec<_> = (0..3).map(|i| original_streams(&pdf0, i)).collect();
    let mut pdf = Pdf::open(original.clone(), None).unwrap();
    let a = marks::add(
        &mut pdf,
        &spec(json!({ "kind": "watermark", "text": "DRAFT", "font": "inter", "pages": [0, 2] })),
        None,
        None,
        None,
        None,
    )
    .unwrap();
    let b = marks::add(
        &mut pdf,
        &spec(json!({ "kind": "footer", "slots": { "end": "Page {page} of {pages}" } })),
        None,
        None,
        None,
        None,
    )
    .unwrap();
    let bytes = commit(&mut pdf, &original);
    let mut pdf = Pdf::open(bytes.clone(), None).unwrap();
    let listed = marks::list(&pdf).unwrap();
    assert_eq!(listed.len(), 2);
    let la = listed.iter().find(|m| m.id == a.id).unwrap();
    assert_eq!(la.pages, vec![0, 2]);
    assert_eq!(la.spec["text"], "DRAFT");
    assert_eq!(
        listed.iter().find(|m| m.id == b.id).unwrap().pages,
        vec![0, 1, 2]
    );
    // Our marks are never listed as foreign ones.
    assert!(foreign::list(&pdf).unwrap().is_empty());
    for i in 0..3 {
        assert_eq!(original_streams(&pdf, i), streams_before[i], "page {i}");
    }
    // Update: same id, new text; the original streams are still the same objects and bytes.
    let mut s2 = la.spec.clone();
    s2["text"] = json!("FINAL");
    marks::update(&mut pdf, &a.id, &spec(s2), None, None).unwrap();
    let bytes2 = commit(&mut pdf, &bytes);
    let mut pdf = Pdf::open(bytes2.clone(), None).unwrap();
    let t = text_pages(&pdf, true);
    assert!(t[0].plain.contains("FINAL") && !t[0].plain.contains("DRAFT"));
    assert!(t[1].plain.contains("Page 2 of 3") && !t[1].plain.contains("FINAL"));
    assert_eq!(marks::list(&pdf).unwrap().len(), 2);
    // Remove the footer: other bytes identical, the footer is gone.
    marks::remove(&mut pdf, &b.id).unwrap();
    let bytes3 = commit(&mut pdf, &bytes2);
    let mut pdf = Pdf::open(bytes3.clone(), None).unwrap();
    let t = text_pages(&pdf, true);
    assert!(!t.iter().any(|p| p.plain.contains("Page 2 of 3")));
    assert!(t[2].plain.contains("FINAL") && t[2].plain.contains("Body text 3"));
    for i in 0..3 {
        assert_eq!(original_streams(&pdf, i), streams_before[i], "page {i}");
    }
    // Remove the last mark: /Contents is exactly what it was.
    marks::remove(&mut pdf, &a.id).unwrap();
    let bytes4 = commit(&mut pdf, &bytes3);
    let pdf = Pdf::open(bytes4, None).unwrap();
    for i in 0..3 {
        assert_eq!(contents_of(&pdf, i), before[i], "page {i}");
    }
    assert!(marks::list(&pdf).unwrap().is_empty());
    assert!(matches!(
        marks::remove(&mut Pdf::open(bytes3.clone(), None).unwrap(), "zm-nope"),
        Err(warraq_marks::MarkError::NotFound(_))
    ));
}

#[test]
fn picture_watermark_png_behind_and_kept_on_update() {
    let original = doc(2, 90, None);
    let png = std::fs::read(root().join("tests/fixtures/logo.png")).unwrap();
    let mut pdf = Pdf::open(original.clone(), None).unwrap();
    let r = marks::add(
        &mut pdf,
        &spec(json!({ "kind": "watermark", "picture": true, "scale": 0.4, "opacity": 0.5, "layer": "behind" })),
        Some(&png),
        None,
        None,
        None,
    )
    .unwrap();
    let bytes = commit(&mut pdf, &original);
    let mut pdf = Pdf::open(bytes.clone(), None).unwrap();
    let form = String::from_utf8_lossy(&find_form(&pdf, 1)).to_string();
    assert!(form.contains("/ZI1 Do"), "{form}");
    let images = pdf
        .objects()
        .values()
        .filter(|o| matches!(o, Object::Stream(s) if matches!(s.dict.get(b"Subtype"), Ok(Object::Name(n)) if n == b"Image") && s.dict.has(b"SMask")))
        .count();
    assert_eq!(images, 1, "one picture shared by both pages");
    // Update without a new picture keeps it.
    let mut s = marks::list(&pdf).unwrap()[0].spec.clone();
    s["opacity"] = json!(0.8);
    // An edit preview (one page, no new picture) keeps the picture too.
    let mut preview = Pdf::open(bytes.clone(), None).unwrap();
    let p = marks::update(&mut preview, &r.id, &spec(s.clone()), None, Some(&[1])).unwrap();
    assert_eq!(p.pages, vec![1]);
    marks::update(&mut pdf, &r.id, &spec(s.clone()), None, None).unwrap();
    let bytes2 = commit(&mut pdf, &bytes);
    let pdf = Pdf::open(bytes2, None).unwrap();
    assert!(String::from_utf8_lossy(&find_form(&pdf, 0)).contains("/ZI1 Do"));
    // A picture mark without a picture is refused.
    let mut fresh = Pdf::open(original, None).unwrap();
    assert!(marks::add(&mut fresh, &spec(s), None, None, None, None).is_err());
    assert!(marks::add(
        &mut fresh,
        &spec(json!({ "kind": "watermark", "picture": true })),
        Some(b"not a picture"),
        None,
        None,
        None
    )
    .is_err());
}

#[test]
fn bates_numbers_count_the_marked_pages() {
    let original = doc(4, 0, None);
    let mut pdf = Pdf::open(original.clone(), None).unwrap();
    marks::add(
        &mut pdf,
        &spec(json!({ "kind": "bates", "pages": [1, 2, 3], "bates": { "prefix": "ZD-", "start": 5, "digits": 4 } })),
        None,
        None,
        None,
        None,
    )
    .unwrap();
    marks::add(
        &mut pdf,
        &spec(json!({ "kind": "bates", "vertical": "top", "digits": "arabic", "bates": { "prefix": "ملف-", "start": 1, "digits": 3 } })),
        None,
        None,
        None,
        None,
    )
    .unwrap();
    let bytes = commit(&mut pdf, &original);
    let pdf = Pdf::open(bytes, None).unwrap();
    let t = text_pages(&pdf, true);
    assert!(!t[0].plain.contains("ZD-"));
    for (i, want) in [(1, "ZD-0005"), (2, "ZD-0006"), (3, "ZD-0007")] {
        assert!(t[i].plain.contains(want), "page {i}: {:?}", t[i].plain);
    }
    for (i, want) in ["ملف-٠٠١", "ملف-٠٠٢", "ملف-٠٠٣", "ملف-٠٠٤"]
        .iter()
        .enumerate()
    {
        assert!(t[i].plain.contains(want), "page {i}: {:?}", t[i].plain);
    }
}

#[test]
fn preview_draws_only_the_asked_page_but_numbers_like_the_real_thing() {
    let original = doc(3, 0, None);
    let mut pdf = Pdf::open(original, None).unwrap();
    let r = marks::add(
        &mut pdf,
        &spec(json!({ "kind": "bates", "bates": { "start": 10, "digits": 2 } })),
        None,
        Some(&[2]),
        None,
        None,
    )
    .unwrap();
    assert_eq!(r.pages, vec![2]);
    let t = text_pages(&pdf, true);
    assert!(t[2].plain.contains("12"));
    assert!(!t[0].plain.contains("10"));
}

#[test]
fn tokens_date_hijri_file_and_time() {
    let original = doc(1, 0, None);
    let mut pdf = Pdf::open(original, None).unwrap();
    marks::add(
        &mut pdf,
        &spec(json!({ "kind": "header", "slots": { "start": "{file}", "center": "{hijri}", "end": "{date} {time}" },
            "digits": "arabic", "lang": "ar", "rtl": true, "fileName": "تقرير-الربع.pdf",
            "now": { "year": 2026, "month": 9, "day": 26, "hour": 14, "minute": 30 } })),
        None,
        None,
        None,
        None,
    )
    .unwrap();
    let t = &text_pages(&pdf, true)[0].plain;
    assert!(t.contains("تقرير-الربع.pdf"), "{t}");
    assert!(t.contains("١٤٤٨/٤/١٥ هـ"), "{t}");
    assert!(t.contains("٢٦/٩/٢٠٢٦"), "{t}");
    assert!(t.contains("١٤:٣٠"), "{t}");
}

/// A page with an Acrobat-style watermark (artifact + form with /ADBE_CompoundType) and an
/// Acrobat-style footer whose artifact changes state without its own q … Q (not removable).
fn acrobat_doc(safe_footer: bool) -> Vec<u8> {
    let mut d = Document::with_version("1.7");
    let pages_id = d.new_object_id();
    let font = d.add_object(dictionary! {
        "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica", "Encoding" => "WinAnsiEncoding",
    });
    let fm = d.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject", "Subtype" => "Form", "BBox" => vec![0.into(), 0.into(), 300.into(), 100.into()],
            "Resources" => dictionary! { "Font" => dictionary! { "F1" => font } },
            "PieceInfo" => dictionary! { "ADBE_CompoundType" => dictionary! { "Private" => "Watermark", "DocSettings" => font } },
        },
        b"BT /F1 40 Tf 0 20 Td (CONFIDENTIAL) Tj ET".to_vec(),
    ));
    let footer = if safe_footer {
        "/Artifact <</Type /Pagination /Subtype /Footer>> BDC q BT /F1 9 Tf 72 30 Td (Footer words) Tj ET Q EMC\n"
    } else {
        "/Artifact <</Type /Pagination /Subtype /Footer>> BDC BT /F1 9 Tf 72 30 Td (Footer words) Tj ET EMC\n"
    };
    let content = format!(
        "BT /F1 18 Tf 72 700 Td (Body text 1) Tj ET\nq /Artifact <</Subtype /Watermark /Type /Pagination >>BDC 0.7071 0.7071 -0.7071 0.7071 200 300 cm /Fm0 Do EMC Q\n{footer}BT /F1 12 Tf 72 600 Td (After) Tj ET\n"
    );
    let c = d.add_object(Stream::new(dictionary! {}, content.into_bytes()));
    let page = d.add_object(dictionary! {
        "Type" => "Page", "Parent" => pages_id, "Contents" => c,
        "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
        "Resources" => dictionary! { "Font" => dictionary! { "F1" => font }, "XObject" => dictionary! { "Fm0" => fm } },
    });
    d.objects.insert(
        pages_id,
        Object::Dictionary(
            dictionary! { "Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1 },
        ),
    );
    let cat = d.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    d.trailer.set("Root", cat);
    let mut out = Vec::new();
    d.save_to(&mut out).unwrap();
    out
}

#[test]
fn acrobat_style_marks_are_listed_and_removed_when_safe() {
    let original = acrobat_doc(false);
    let mut pdf = Pdf::open(original.clone(), None).unwrap();
    let f = foreign::list(&pdf).unwrap();
    let wm = f.iter().find(|m| m.kind == ForeignKind::Watermark).unwrap();
    assert!(wm.removable && wm.acrobat, "{f:?}");
    assert_eq!(wm.pages, vec![0]);
    let foot = f.iter().find(|m| m.kind == ForeignKind::Footer).unwrap();
    assert!(!foot.removable, "state changes outside q … Q: {f:?}");
    // Through the RPC: the unsafe footer is refused, the watermark removed.
    let e = api::call(
        &mut pdf,
        "marks.remove",
        &json!({ "id": "foreign:footer" }),
        &[],
    )
    .unwrap()
    .unwrap_err();
    assert_eq!(e.code(), "not_removable");
    let r = api::call(
        &mut pdf,
        "marks.remove",
        &json!({ "id": "foreign:watermark" }),
        &[],
    )
    .unwrap()
    .unwrap();
    assert_eq!(r["removed"], 1);
    let bytes = commit(&mut pdf, &original);
    let pdf = Pdf::open(bytes, None).unwrap();
    let t = &text_pages(&pdf, true)[0].plain;
    assert!(!t.contains("CONFIDENTIAL"), "{t}");
    assert!(t.contains("Body text 1") && t.contains("After") && t.contains("Footer words"));
    // Only the watermark bytes went: the rest of the content is byte-identical.
    let pc = warraq_edit::page::load(&pdf, 0).unwrap();
    let old = String::from_utf8_lossy(&original).to_string();
    let new = String::from_utf8_lossy(&pc.data).to_string();
    assert!(old.contains(&new.replace("\n\n", "\nq /Artifact <</Subtype /Watermark /Type /Pagination >>BDC 0.7071 0.7071 -0.7071 0.7071 200 300 cm /Fm0 Do EMC Q\n")), "{new}");

    // A footer wrapped in its own q … Q is removable.
    let mut pdf = Pdf::open(acrobat_doc(true), None).unwrap();
    let f = foreign::list(&pdf).unwrap();
    assert!(f.iter().all(|m| m.removable), "{f:?}");
    foreign::remove(&mut pdf, ForeignKind::Footer).unwrap();
    let t = &text_pages(&pdf, true)[0].plain;
    assert!(!t.contains("Footer words") && t.contains("CONFIDENTIAL"));
}

#[test]
fn encrypted_documents_stay_encrypted() {
    let path = root().join("tests/corpus/pdf/encrypted/chrome-tashkeel-amiri-aes-256.pdf");
    let original = std::fs::read(path).unwrap();
    let mut pdf = Pdf::open(original.clone(), Some("كلمة-سر")).unwrap();
    marks::add(
        &mut pdf,
        &spec(json!({ "kind": "footer", "slots": { "center": FOOTER_AR }, "digits": "arabic" })),
        None,
        None,
        None,
        None,
    )
    .unwrap();
    let bytes = commit(&mut pdf, &original);
    assert!(Pdf::open(bytes.clone(), None).is_err());
    let pdf = Pdf::open(bytes, Some("كلمة-سر")).unwrap();
    assert!(pdf.is_encrypted());
    assert!(text_pages(&pdf, true)[0].plain.contains("صفحة ١ من"));
    assert_eq!(marks::list(&pdf).unwrap().len(), 1);
}

#[test]
fn rpc_surface_and_errors() {
    let original = doc(2, 0, None);
    let mut pdf = Pdf::open(original, None).unwrap();
    let r = api::call(
        &mut pdf,
        "marks.add",
        &json!({ "mark": { "kind": "pageNumber" } }),
        &[],
    )
    .unwrap()
    .unwrap();
    assert!(r["id"].as_str().unwrap().starts_with("zm"));
    let l = api::call(&mut pdf, "marks.list", &Value::Null, &[])
        .unwrap()
        .unwrap();
    assert_eq!(l["marks"].as_array().unwrap().len(), 1);
    assert_eq!(l["foreign"].as_array().unwrap().len(), 0);
    let bad = |p: Value| {
        api::call(
            &mut Pdf::open(doc(1, 0, None), None).unwrap(),
            "marks.add",
            &p,
            &[],
        )
        .unwrap()
        .unwrap_err()
        .code()
    };
    assert_eq!(
        bad(json!({ "mark": { "kind": "pageNumber", "pages": [5] } })),
        "page_out_of_range"
    );
    assert_eq!(
        bad(json!({ "mark": { "kind": "watermark" } })),
        "invalid_params"
    );
    assert_eq!(
        bad(json!({ "mark": { "kind": "watermark", "text": "x", "size": 1e9 } })),
        "invalid_params"
    );
    assert_eq!(
        bad(json!({ "mark": { "kind": "pageNumber" }, "extra": 1 })),
        "invalid_params"
    );
    assert!(api::call(&mut pdf, "marks.nope", &Value::Null, &[]).is_none());
    assert_eq!(
        api::call(
            &mut pdf,
            "marks.remove",
            &json!({ "id": "foreign:bogus" }),
            &[]
        )
        .unwrap()
        .unwrap_err()
        .code(),
        "not_found"
    );
}
