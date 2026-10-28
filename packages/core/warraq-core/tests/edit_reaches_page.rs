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

/// The register's other half: the whole page is a picture, its words in
/// the picture too, with the same words again as text on top. Erasing the
/// text left the picture's words, and the new line was drawn over them.
/// Here the picture is white with dark bars where the line's letters are.
fn words_in_the_picture_too() -> Vec<u8> {
    let (w, h) = (612usize, 792usize);
    let mut rgb = vec![255u8; w * h * 3];
    // The line runs from x 72 to about 350, baseline 720 (PDF space): rows 60..76 from the top.
    for row in 60..76 {
        for col in 72..340 {
            if (col / 3) % 2 == 0 {
                let i = (row * w + col) * 3;
                rgb[i..i + 3].copy_from_slice(&[20, 20, 20]);
            }
        }
    }
    let mut doc = Lopdf::with_version("1.7");
    let pages = doc.new_object_id();
    let font = doc.add_object(dictionary! {
        "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica",
    });
    let image = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject", "Subtype" => "Image", "Width" => w as i64, "Height" => h as i64,
            "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8,
        },
        rgb,
    ));
    let content = doc.add_object(Stream::new(
        dictionary! {},
        b"q 612 0 0 792 0 0 cm /Im0 Do Q BT /F1 20 Tf 72 720 Td (National Number : 7053514423) Tj ET"
            .to_vec(),
    ));
    let page = doc.add_object(dictionary! {
        "Type" => "Page", "Parent" => pages, "Contents" => content,
        "Resources" => dictionary! {
            "Font" => dictionary! { "F1" => font },
            "XObject" => dictionary! { "Im0" => image },
        },
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

/// Dark pixels in a box of the page drawn at 1 px per point (top-left origin).
fn dark_in(doc: &Document, (x0, y0, x1, y1): (usize, usize, usize, usize)) -> usize {
    let bitmap = doc.render_page(0, 1.0).unwrap();
    let mut dark = 0;
    for y in y0..y1 {
        for x in x0..x1 {
            let i = (y * bitmap.width as usize + x) * 4;
            if bitmap.rgba[i] < 128 {
                dark += 1;
            }
        }
    }
    dark
}

#[test]
fn words_that_are_also_in_the_picture_are_covered() {
    let mut doc = Document::open(words_in_the_picture_too(), None).unwrap();
    // The far end of the line, where the short new text does not reach.
    let tail = (250, 58, 340, 78);
    assert!(dark_in(&doc, tail) > 300, "the stand-in draws its words");
    doc.replace_paragraph(0, 0, "No 1", &repo("tests/fonts/Inter-Variable.ttf"))
        .unwrap();
    let again = Document::open(doc.save().unwrap(), None).unwrap();
    assert!(again.extract_text(0).unwrap().contains("No 1"));
    let left = dark_in(&again, tail);
    assert!(
        left < 20,
        "{left} dark pixels of the old words are still there"
    );
}
