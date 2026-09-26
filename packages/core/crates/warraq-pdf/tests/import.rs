//! Combine / Extract / Split: bookmarks, form fields and page labels travel with the pages.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod common;

use common::{page_text, python};
use warraq_pdf::builder::{sample_pdf, SampleOptions};
use warraq_pdf::import::{import_pages, ImportOptions};
use warraq_pdf::lopdf::{Dictionary, Object, StringFormat};
use warraq_pdf::outline::{self, text_string, Dest, NewItem};
use warraq_pdf::{pages, Pdf};

fn item(title: &str, page: warraq_pdf::lopdf::ObjectId, children: Vec<NewItem>) -> NewItem {
    NewItem {
        title: text_string(title),
        dest: Some(Dest { page, view: vec![] }),
        children,
    }
}

/// `n` pages with bookmarks "Chapter k" on every other page (Arabic title on the first), a text
/// field named `name` with its widget on page 1, and roman page labels.
fn rich(n: usize, field: &str) -> Vec<u8> {
    let mut pdf = Pdf::open(sample_pdf(n, &SampleOptions::default()).unwrap(), None).unwrap();
    let list = pages::flatten(&pdf).unwrap();
    let mut items = Vec::new();
    for (k, p) in list.iter().enumerate().step_by(2) {
        let title = if k == 0 {
            "الفصل الأول".to_string()
        } else {
            format!("Chapter {}", k + 1)
        };
        let child = item(&format!("Section {}.1", k + 1), p.id, vec![]);
        items.push(item(&title, p.id, vec![child]));
    }
    outline::append_outline(&mut pdf, &items).unwrap();
    // A text field whose widget sits on page 1.
    let page0 = list[0].id;
    let mut w = Dictionary::new();
    w.set("Type", Object::Name(b"Annot".to_vec()));
    w.set("Subtype", Object::Name(b"Widget".to_vec()));
    w.set("FT", Object::Name(b"Tx".to_vec()));
    w.set(
        "T",
        Object::String(field.as_bytes().to_vec(), StringFormat::Literal),
    );
    w.set(
        "Rect",
        Object::Array(vec![50.into(), 50.into(), 200.into(), 80.into()]),
    );
    w.set("P", Object::Reference(page0));
    let wid = pdf.add(Object::Dictionary(w));
    let mut pd = pdf.get_dict(page0).unwrap().clone();
    pd.set("Annots", Object::Array(vec![Object::Reference(wid)]));
    pdf.set(page0, Object::Dictionary(pd));
    let mut form = Dictionary::new();
    form.set("Fields", Object::Array(vec![Object::Reference(wid)]));
    let fid = pdf.add(Object::Dictionary(form));
    let root = pdf.root_id().unwrap();
    let mut cat = pdf.get_dict(root).unwrap().clone();
    cat.set("AcroForm", Object::Reference(fid));
    pdf.set(root, Object::Dictionary(cat));
    let mut roman = Dictionary::new();
    roman.set("S", Object::Name(b"r".to_vec()));
    outline::write_page_labels(&mut pdf, &[(0, roman)]).unwrap();
    pdf.commit().unwrap()
}

fn titles(items: &[outline::OutlineItem]) -> Vec<String> {
    items.iter().map(|i| i.title_text()).collect()
}

fn page_index(pdf: &Pdf, dest: &Option<Dest>) -> Option<usize> {
    let d = dest.as_ref()?;
    pages::flatten(pdf)
        .unwrap()
        .iter()
        .position(|p| p.id == d.page)
}

fn field_names(pdf: &Pdf) -> Vec<String> {
    let cat = pdf.catalog().unwrap();
    let form = pdf
        .resolve(cat.get(b"AcroForm").unwrap())
        .unwrap()
        .as_dict()
        .unwrap();
    form.get(b"Fields")
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .map(|f| {
            let d = pdf.get_dict(f.as_reference().unwrap()).unwrap();
            outline::decode_text(d.get(b"T").unwrap().as_str().unwrap())
        })
        .collect()
}

#[test]
fn outline_reads_every_destination_form() {
    let pdf = Pdf::open(rich(4, "name"), None).unwrap();
    let o = outline::read_outline(&pdf).unwrap();
    assert_eq!(titles(&o), vec!["الفصل الأول", "Chapter 3"]);
    assert_eq!(page_index(&pdf, &o[1].dest), Some(2));
    assert_eq!(titles(&o[1].children), vec!["Section 3.1"]);
    // pypdf agrees (outline written by us is readable elsewhere)
    if let Some(out) = python(
        "import sys,pypdf;r=pypdf.PdfReader(sys.argv[1]);print([ (o.title, r.get_destination_page_number(o)) for o in r.outline if not isinstance(o,list)])",
        pdf.bytes(),
    ) {
        assert!(out.contains("('Chapter 3', 2)"), "{out}");
        assert!(out.contains("الفصل الأول"), "{out}");
    }
}

#[test]
fn named_and_goto_destinations_resolve() {
    let mut pdf = Pdf::open(sample_pdf(3, &SampleOptions::default()).unwrap(), None).unwrap();
    let p2 = pages::flatten(&pdf).unwrap()[2].id;
    // /Names /Dests name tree + an outline item using a named destination and a GoTo action.
    let mut tree = Dictionary::new();
    tree.set(
        "Names",
        Object::Array(vec![
            Object::String(b"third".to_vec(), StringFormat::Literal),
            Object::Array(vec![Object::Reference(p2), Object::Name(b"Fit".to_vec())]),
        ]),
    );
    let tree_id = pdf.add(Object::Dictionary(tree));
    let mut names = Dictionary::new();
    names.set("Dests", Object::Reference(tree_id));
    let root = pdf.root_id().unwrap();
    let mut cat = pdf.get_dict(root).unwrap().clone();
    cat.set("Names", Object::Dictionary(names));
    pdf.set(root, Object::Dictionary(cat));
    outline::append_outline(&mut pdf, &[item("x", p2, vec![])]).unwrap();
    // rewrite the item to a GoTo action with a named destination
    let o = outline::read_outline(&pdf).unwrap();
    assert_eq!(o.len(), 1);
    let named = outline::resolve_dest(
        &pdf,
        &Object::String(b"third".to_vec(), StringFormat::Literal),
    )
    .unwrap();
    assert_eq!(named.page, p2);
    let mut action = Dictionary::new();
    action.set("S", Object::Name(b"GoTo".to_vec()));
    action.set(
        "D",
        Object::String(b"third".to_vec(), StringFormat::Literal),
    );
    let mut holder = Dictionary::new();
    holder.set("D", Object::Dictionary(action.clone()));
    assert_eq!(
        outline::resolve_dest(&pdf, &Object::Dictionary(holder))
            .unwrap()
            .page,
        p2
    );
    // unknown names and remote destinations resolve to nothing
    assert!(outline::resolve_dest(
        &pdf,
        &Object::String(b"nope".to_vec(), StringFormat::Literal)
    )
    .is_none());
    assert!(outline::resolve_dest(
        &pdf,
        &Object::Array(vec![Object::Integer(0), Object::Name(b"Fit".to_vec())])
    )
    .is_none());
}

#[test]
fn merge_nests_each_files_outline_renames_fields_and_keeps_labels() {
    let a = Pdf::open(rich(3, "name"), None).unwrap();
    let b = Pdf::open(rich(2, "name"), None).unwrap();
    let plain = Pdf::open(sample_pdf(1, &SampleOptions::default()).unwrap(), None).unwrap();
    let out = pages::merge_titled(&[
        (&a, Some("a.pdf".into())),
        (&b, Some("ب.pdf".into())),
        (&plain, Some("plain.pdf".into())),
    ])
    .unwrap();
    let m = Pdf::open(out.clone(), None).unwrap();
    assert_eq!(pages::count(&m).unwrap(), 6);
    let o = outline::read_outline(&m).unwrap();
    assert_eq!(titles(&o), vec!["a.pdf", "ب.pdf", "plain.pdf"]);
    assert_eq!(page_index(&m, &o[0].dest), Some(0));
    assert_eq!(page_index(&m, &o[1].dest), Some(3));
    assert_eq!(page_index(&m, &o[2].dest), Some(5));
    assert_eq!(titles(&o[0].children), vec!["الفصل الأول", "Chapter 3"]);
    assert_eq!(page_index(&m, &o[0].children[1].dest), Some(2));
    assert_eq!(page_index(&m, &o[1].children[0].dest), Some(3));
    // fields: both files had "name"; the second is renamed
    assert_eq!(field_names(&m), vec!["name", "name_2"]);
    // labels: roman per file, then decimal for the unlabeled file
    let labels = outline::read_page_labels(&m);
    let starts: Vec<i64> = labels.iter().map(|(k, _)| *k).collect();
    assert_eq!(starts, vec![0, 3, 5]);
    assert_eq!(labels[1].1.get(b"S").unwrap().as_name().unwrap(), b"r");
    assert_eq!(labels[2].1.get(b"S").unwrap().as_name().unwrap(), b"D");
    if let Some(out) = python(
        "import sys,pypdf;r=pypdf.PdfReader(sys.argv[1]);print(r.page_labels);print(sorted(r.get_fields().keys()))",
        &out,
    ) {
        assert!(out.contains("['i', 'ii', 'iii', 'i', 'ii', '1']"), "{out}");
        assert!(out.contains("['name', 'name_2']"), "{out}");
    }
}

#[test]
fn extract_keeps_only_bookmarks_of_extracted_pages() {
    let src = Pdf::open(rich(4, "f"), None).unwrap();
    let ex = Pdf::open(pages::extract(&src, &[2, 3]).unwrap(), None).unwrap();
    let o = outline::read_outline(&ex).unwrap();
    assert_eq!(titles(&o), vec!["Chapter 3"]);
    assert_eq!(page_index(&ex, &o[0].dest), Some(0));
    assert!(page_text(&ex, 0).contains("Page 3"));
    // no widget came along, so no form
    assert!(ex.catalog().unwrap().get(b"AcroForm").is_err());
}

#[test]
fn incremental_insert_appends_outline_entry_and_fields() {
    let orig = sample_pdf(2, &SampleOptions::default()).unwrap();
    let mut dst = Pdf::open(orig.clone(), None).unwrap();
    let src = Pdf::open(rich(2, "email"), None).unwrap();
    let opts = ImportOptions {
        outline_title: Some("added.pdf".into()),
        ..ImportOptions::default()
    };
    let ids = import_pages(&mut dst, &src, &[0, 1], 1, &opts).unwrap();
    assert_eq!(ids.len(), 2);
    let out = dst.commit().unwrap();
    assert!(
        out.starts_with(&orig),
        "incremental update keeps the original bytes"
    );
    let re = Pdf::open(out, None).unwrap();
    assert_eq!(pages::count(&re).unwrap(), 4);
    let o = outline::read_outline(&re).unwrap();
    assert_eq!(titles(&o), vec!["added.pdf"]);
    assert_eq!(page_index(&re, &o[0].dest), Some(1));
    assert_eq!(field_names(&re), vec!["email"]);
    // inserted in the middle: labels are not touched
    assert!(outline::read_page_labels(&re).is_empty());
}

#[test]
fn hostile_outline_cycles_and_depth_terminate() {
    let mut pdf = Pdf::open(sample_pdf(1, &SampleOptions::default()).unwrap(), None).unwrap();
    let p0 = pages::flatten(&pdf).unwrap()[0].id;
    outline::append_outline(&mut pdf, &[item("a", p0, vec![]), item("b", p0, vec![])]).unwrap();
    let o = outline::read_outline(&pdf).unwrap();
    assert_eq!(o.len(), 2);
    // make the second item point back at the first (Next cycle) and at itself as First
    let root = pdf.root_id().unwrap();
    let ol = pdf
        .get_dict(root)
        .unwrap()
        .get(b"Outlines")
        .unwrap()
        .as_reference()
        .unwrap();
    let first = pdf
        .get_dict(ol)
        .unwrap()
        .get(b"First")
        .unwrap()
        .as_reference()
        .unwrap();
    let last = pdf
        .get_dict(ol)
        .unwrap()
        .get(b"Last")
        .unwrap()
        .as_reference()
        .unwrap();
    let mut d = pdf.get_dict(last).unwrap().clone();
    d.set("Next", Object::Reference(first));
    d.set("First", Object::Reference(last));
    pdf.set(last, Object::Dictionary(d));
    let o = outline::read_outline(&pdf).unwrap();
    assert_eq!(o.len(), 2);
    assert!(o[1].children.is_empty());
}
