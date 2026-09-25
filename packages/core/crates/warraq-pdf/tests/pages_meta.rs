#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod common;
use common::*;
use std::collections::BTreeMap;
use warraq_pdf::builder::{sample_pdf, SampleOptions};
use warraq_pdf::lopdf::{dictionary, Document, Object, Stream};
use warraq_pdf::{metadata, pages, revisions, Limits, Pdf};

/// A file with a nested page tree whose pages inherit MediaBox/Resources/Rotate.
fn nested() -> Vec<u8> {
    let mut doc = Document::with_version("1.5");
    let pages_id = doc.new_object_id();
    let mid = doc.new_object_id();
    let font = doc.add_object(
        dictionary! {"Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica"},
    );
    let mut kids_mid = vec![];
    let mut kids_root = vec![];
    for i in 1..=4 {
        let c = doc.add_object(Stream::new(
            dictionary! {},
            format!("BT /F1 20 Tf 50 50 Td (Page {i}) Tj ET").into_bytes(),
        ));
        let parent = if i <= 2 { mid } else { pages_id };
        let p = doc.add_object(dictionary! {"Type" => "Page", "Parent" => parent, "Contents" => c});
        if i <= 2 {
            kids_mid.push(Object::Reference(p));
        } else {
            kids_root.push(Object::Reference(p));
        }
    }
    doc.objects.insert(
        mid,
        Object::Dictionary(dictionary! {
            "Type" => "Pages", "Parent" => pages_id, "Kids" => kids_mid, "Count" => 2,
            "Rotate" => 90,
        }),
    );
    let mut root_kids = vec![Object::Reference(mid)];
    root_kids.extend(kids_root);
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages", "Kids" => root_kids, "Count" => 4,
            "MediaBox" => vec![0.into(), 0.into(), 300.into(), 400.into()],
            "Resources" => dictionary! {"Font" => dictionary! {"F1" => font}},
        }),
    );
    let cat = doc.add_object(dictionary! {"Type" => "Catalog", "Pages" => pages_id});
    doc.trailer.set("Root", cat);
    let mut out = Vec::new();
    doc.save_to(&mut out).unwrap();
    out
}

fn texts(pdf: &Pdf) -> Vec<String> {
    (0..pages::count(pdf).unwrap())
        .map(|i| {
            let t = page_text(pdf, i);
            let s = t.find("(Page ").unwrap();
            t[s + 6..s + 7].to_string()
        })
        .collect()
}

#[test]
fn flatten_resolves_inherited_attributes() {
    let pdf = Pdf::open(nested(), None).unwrap();
    let p = pages::flatten(&pdf).unwrap();
    assert_eq!(p.len(), 4);
    assert_eq!(p[0].rotate, 90);
    assert_eq!(p[2].rotate, 0);
    assert_eq!(p[3].media_box, [0.0, 0.0, 300.0, 400.0]);
    assert!(p[1].resources.is_some());
    assert_eq!(texts(&pdf), vec!["1", "2", "3", "4"]);
}

#[test]
fn reorder_delete_insert_keep_inherited_attributes_and_prefix() {
    let orig = nested();
    let mut pdf = Pdf::open(orig.clone(), None).unwrap();
    pages::reorder(&mut pdf, &[3, 0, 2, 1]).unwrap();
    let out = pdf.commit().unwrap();
    assert_eq!(&out[..orig.len()], &orig[..]);
    assert_eq!(texts(&pdf), vec!["4", "1", "3", "2"]);
    let p = pages::flatten(&pdf).unwrap();
    assert_eq!(p[1].rotate, 90, "inherited rotation materialised");
    assert_eq!(p[1].media_box, [0.0, 0.0, 300.0, 400.0]);
    assert!(page_text(&pdf, 0).contains("F1"));
    // Independent reader agrees.
    let d = Document::load_mem(&out).unwrap();
    assert_eq!(d.get_pages().len(), 4);

    pages::delete(&mut pdf, &[0, 2]).unwrap();
    pdf.commit().unwrap();
    assert_eq!(texts(&pdf), vec!["1", "2"]);
    assert!(
        pages::delete(&mut pdf, &[0, 1]).is_err(),
        "cannot delete every page"
    );

    pages::move_to(&mut pdf, &[1], 0).unwrap();
    pdf.commit().unwrap();
    assert_eq!(texts(&pdf), vec!["2", "1"]);

    let id = pages::insert_blank(&mut pdf, 1, 200.0, 100.0).unwrap();
    pdf.commit().unwrap();
    let p = pages::flatten(&pdf).unwrap();
    assert_eq!(p.len(), 3);
    assert_eq!(p[1].id, id);
    assert_eq!(p[1].size(), (200.0, 100.0));
    assert_eq!(
        revisions::revisions(pdf.bytes(), &Limits::default()).len(),
        5
    );
}

#[test]
fn rotate_and_crop() {
    let mut pdf = Pdf::open(nested(), None).unwrap();
    pages::rotate(&mut pdf, &[0, 3], -90).unwrap();
    pages::crop(&mut pdf, &[3], [10.0, 20.0, 110.0, 220.0]).unwrap();
    assert!(pages::rotate(&mut pdf, &[0], 45).is_err());
    assert!(pages::crop(&mut pdf, &[0], [10.0, 10.0, 5.0, 20.0]).is_err());
    assert!(pages::rotate(&mut pdf, &[9], 90).is_err());
    pdf.commit().unwrap();
    let p = pages::flatten(&pdf).unwrap();
    assert_eq!(p[0].rotate, 0);
    assert_eq!(p[3].rotate, 270);
    assert_eq!(p[3].size(), (100.0, 200.0));
}

#[test]
fn insert_from_other_document_deep_copies() {
    let mut pdf = Pdf::open(nested(), None).unwrap();
    let other = Pdf::open(
        sample_pdf(
            3,
            &SampleOptions {
                with_annotation: true,
                ..Default::default()
            },
        )
        .unwrap(),
        None,
    )
    .unwrap();
    let ids = pages::insert_from(&mut pdf, &other, &[0, 2], 1).unwrap();
    assert_eq!(ids.len(), 2);
    let out = pdf.commit().unwrap();
    let re = Pdf::open(out, None).unwrap();
    assert_eq!(texts(&re), vec!["1", "1", "3", "2", "3", "4"]);
    // The copied annotation came along and points at its new page.
    let d = re.get_dict(ids[0]).unwrap();
    let annot = d.get(b"Annots").unwrap().as_array().unwrap()[0]
        .as_reference()
        .unwrap();
    assert_eq!(
        re.get_dict(annot)
            .unwrap()
            .get(b"P")
            .unwrap()
            .as_reference()
            .unwrap(),
        ids[0]
    );
}

#[test]
fn extract_and_merge_make_new_documents() {
    let src = Pdf::open(nested(), None).unwrap();
    let ex = pages::extract(&src, &[3, 1]).unwrap();
    let e = Pdf::open(ex, None).unwrap();
    assert_eq!(texts(&e), vec!["4", "2"]);
    assert_eq!(pages::flatten(&e).unwrap()[1].rotate, 90);
    let a = Pdf::open(sample_pdf(2, &SampleOptions::default()).unwrap(), None).unwrap();
    let merged = pages::merge(&[src, a]).unwrap();
    let m = Pdf::open(merged, None).unwrap();
    assert_eq!(texts(&m), vec!["1", "2", "3", "4", "1", "2"]);
}

#[test]
fn info_and_xmp_round_trip_with_arabic() {
    let orig = sample_pdf(
        1,
        &SampleOptions {
            title: Some("Old".into()),
            ..Default::default()
        },
    )
    .unwrap();
    let mut pdf = Pdf::open(orig, None).unwrap();
    assert_eq!(title(&pdf).as_deref(), Some("Old"));
    let mut m = BTreeMap::new();
    m.insert("Title".to_string(), Some("تقرير الربع الأول".to_string()));
    m.insert("Author".to_string(), Some("زود".to_string()));
    m.insert("Producer".to_string(), None);
    metadata::set_info(&mut pdf, &m).unwrap();
    let info = metadata::get_info(&pdf);
    metadata::set_xmp(&mut pdf, &metadata::xmp_from_info(&info)).unwrap();
    let out = pdf.commit().unwrap();
    let re = Pdf::open(out.clone(), None).unwrap();
    let info = metadata::get_info(&re);
    assert_eq!(info["Title"], "تقرير الربع الأول");
    assert_eq!(info["Author"], "زود");
    assert!(!info.contains_key("Producer"));
    let xmp = metadata::get_xmp(&re).unwrap().unwrap();
    assert!(xmp.contains("تقرير الربع الأول"));
    let script = r#"
import sys, pypdf
r = pypdf.PdfReader(sys.argv[1])
sys.stdout.buffer.write(r.metadata.title.encode("utf-8"))
"#;
    if let Some(o) = python(script, &out) {
        assert_eq!(o, "تقرير الربع الأول");
    }
    let mut bad = BTreeMap::new();
    bad.insert("Bad Key".to_string(), Some("x".to_string()));
    assert!(metadata::set_info(&mut pdf, &bad).is_err());
}

#[test]
fn revisions_list_and_extract() {
    let orig = sample_pdf(2, &SampleOptions::default()).unwrap();
    let mut pdf = Pdf::open(orig.clone(), None).unwrap();
    pages::rotate(&mut pdf, &[0], 90).unwrap();
    let r1 = pdf.commit().unwrap();
    pages::rotate(&mut pdf, &[1], 180).unwrap();
    let r2 = pdf.commit().unwrap();
    let l = Limits::default();
    let revs = revisions::revisions(&r2, &l);
    assert_eq!(revs.len(), 3);
    assert_eq!(revs[0].end, orig.len());
    assert_eq!(revs[1].end, r1.len());
    assert_eq!(revs[2].end, r2.len());
    let first = revisions::revision_bytes(&r2, 0, &l).unwrap();
    assert_eq!(first, &orig[..]);
    let old = Pdf::open(
        revisions::revision_bytes(&r2, 1, &l).unwrap().to_vec(),
        None,
    )
    .unwrap();
    assert_eq!(pages::flatten(&old).unwrap()[0].rotate, 90);
    assert_eq!(pages::flatten(&old).unwrap()[1].rotate, 0);
    assert!(revisions::revision_bytes(&r2, 3, &l).is_err());
}
