//! A bold paragraph redrawn in a face without a bold (the bundled faces have
//! one weight) is drawn heavier, outlined in its own colour, rather than come
//! back regular; a regular paragraph is not.
use warraq_core::Document;

const AMIRI: &[u8] = include_bytes!("../../../../tests/fonts/Amiri-Regular.ttf");
const FILE: &str = "../../../tests/corpus/arabic/generated/chrome-windows-arial-tahoma-times.pdf";

/// How many times the first page's content turns on fill-and-stroke text.
fn outlined(saved: &[u8]) -> usize {
    let raw = lopdf::Document::load_mem(saved).unwrap();
    let page = *raw.get_pages().get(&1).unwrap();
    String::from_utf8_lossy(&raw.get_page_content(page))
        .matches("2 Tr")
        .count()
}

#[test]
fn a_bold_paragraph_stays_bold_in_a_regular_face() {
    let original = std::fs::read(FILE).unwrap();
    let doc = Document::open(original.clone(), None).unwrap();
    let fonts = doc.paragraph_fonts(0).unwrap();
    let bold = fonts
        .iter()
        .position(|f| f.face.as_ref().is_some_and(|face| face.weight >= 600));
    let regular = fonts
        .iter()
        .position(|f| f.face.as_ref().is_some_and(|face| face.weight < 600));
    let (Some(bold), Some(regular)) = (bold, regular) else {
        panic!("the file should have a bold and a regular paragraph: {fonts:?}");
    };

    let mut doc = Document::open(original.clone(), None).unwrap();
    doc.replace_paragraph(0, bold, "Bold heading", AMIRI)
        .unwrap();
    let saved = doc.save().unwrap();
    assert_eq!(outlined(&saved), 1, "the bold paragraph is outlined");

    let mut doc = Document::open(original.clone(), None).unwrap();
    doc.replace_paragraph(0, regular, "Plain text", AMIRI)
        .unwrap();
    let saved = doc.save().unwrap();
    assert_eq!(outlined(&saved), 0, "a regular paragraph is not");
}
