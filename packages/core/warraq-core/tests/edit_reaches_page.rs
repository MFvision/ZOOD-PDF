//! An edited paragraph reaches the page and the saved file, and a file saved
//! that way can be edited again through its incremental updates. Found on a
//! real PC (2026-10-27): a ministry's register, its fonts embedded as subsets
//! and its page `/Contents` a reference to an array of streams, took the edit
//! (font added, Undo armed) while the page and the saved file stayed as they
//! were. The register itself is never committed; these are stand-ins.
use lopdf::{dictionary, Document as Lopdf, Object, Stream};
use warraq_core::Document;

fn repo(path: &str) -> Vec<u8> {
    std::fs::read(format!("{}/../../../{path}", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

/// A Word file with embedded subset fonts, its page contents moved into an
/// indirect array the way the register writes them.
fn subset_font_contents_in_an_array() -> Vec<u8> {
    let mut doc = Lopdf::load_mem(&repo(
        "tests/corpus/arabic/realworld/A_worldbank_malpass_g7_briefing_AR_word2016_pdftools.pdf",
    ))
    .unwrap();
    let page = *doc.get_pages().get(&1).unwrap();
    let streams = doc.get_page_contents(page);
    assert!(!streams.is_empty());
    let array = doc.add_object(Object::Array(
        streams.into_iter().map(Object::Reference).collect(),
    ));
    doc.get_dictionary_mut(page)
        .unwrap()
        .set("Contents", Object::Reference(array));
    let mut out = Vec::new();
    doc.save_to(&mut out).unwrap();
    out
}

/// The simplest case: one page, one line in the standard Helvetica.
fn helvetica() -> Vec<u8> {
    let mut doc = Lopdf::with_version("1.7");
    let pages = doc.new_object_id();
    let font = doc.add_object(dictionary! {
        "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica",
    });
    let content = doc.add_object(Stream::new(
        dictionary! {},
        b"BT /F1 14 Tf 72 720 Td (Monthly report for the board) Tj ET".to_vec(),
    ));
    let page = doc.add_object(dictionary! {
        "Type" => "Page", "Parent" => pages, "Contents" => content,
        "Resources" => dictionary! { "Font" => dictionary! { "F1" => font } },
    });
    doc.objects.insert(
        pages,
        Object::Dictionary(dictionary! {
            "Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1,
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
        }),
    );
    let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages });
    doc.trailer.set("Root", catalog);
    let mut out = Vec::new();
    doc.save_to(&mut out).unwrap();
    out
}

fn pixels(doc: &Document) -> Vec<u8> {
    doc.render_page(0, 0.5).unwrap().rgba
}

fn edit_twice(name: &str, pdf: Vec<u8>, first: &str, second: &str, font: &[u8]) {
    let mut doc = Document::open(pdf.clone(), None).unwrap();
    let before = pixels(&doc);
    doc.replace_paragraph(0, 0, first, font).unwrap();
    let saved = doc.save().unwrap();
    assert!(
        saved.starts_with(&pdf),
        "{name}: saved as an incremental update"
    );

    let mut again = Document::open(saved.clone(), None).unwrap();
    let read = again.extract_text(0).unwrap();
    assert!(read.contains(first), "{name}: {first:?} not in {read:?}");
    let edited = pixels(&again);
    assert_ne!(edited, before, "{name}: the saved page must look different");

    // The re-saved file, edited again through its own updates.
    again.replace_paragraph(0, 0, second, font).unwrap();
    let resaved = again.save().unwrap();
    assert!(
        resaved.starts_with(&saved),
        "{name}: a second incremental update"
    );
    let third = Document::open(resaved, None).unwrap();
    let read = third.extract_text(0).unwrap();
    assert!(read.contains(second), "{name}: {second:?} not in {read:?}");
    assert!(!read.contains(first), "{name}: the first edit is replaced");
    assert_ne!(pixels(&third), edited, "{name}: the second edit shows");
}

#[test]
fn an_edit_reaches_a_page_with_subset_fonts_and_contents_in_an_array() {
    edit_twice(
        "subset fonts, contents array",
        subset_font_contents_in_an_array(),
        "فقرة جديدة كتبها الاختبار",
        "صباح الخير يا عالم",
        &repo("tests/fonts/Amiri-Regular.ttf"),
    );
}

#[test]
fn an_edit_reaches_a_simple_helvetica_page() {
    edit_twice(
        "helvetica",
        helvetica(),
        "Quarterly report for the board",
        "Annual report for the board",
        &repo("tests/fonts/Inter-Variable.ttf"),
    );
}
