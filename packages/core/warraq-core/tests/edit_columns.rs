//! Editing a page set in columns. A slide with cards side by side, a table:
//! everything on one baseline used to be one line, so four headings were one
//! "sentence" and replacing a word in one redrew all four as a single run —
//! in black, whatever colour they had been. Each column is a paragraph of
//! its own now, and what replaces it keeps its colour.
use warraq_core::Document;

const AMIRI: &[u8] = include_bytes!("../../../../tests/fonts/Amiri-Regular.ttf");

/// A one-page A4 file in Helvetica drawing `content`.
fn pdf(content: &str) -> Vec<u8> {
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>".to_string(),
        format!("<< /Length {} >>\nstream\n{content}\nendstream", content.len()),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>".to_string(),
    ];
    let mut out = String::from("%PDF-1.7\n");
    let mut offsets = vec![];
    for (i, body) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.push_str(&format!("{} 0 obj\n{body}\nendobj\n", i + 1));
    }
    let xref = out.len();
    out.push_str(&format!(
        "xref\n0 {}\n0000000000 65535 f \n",
        objects.len() + 1
    ));
    for offset in offsets {
        out.push_str(&format!("{offset:010} 00000 n \n"));
    }
    out.push_str(&format!(
        "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
        objects.len() + 1
    ));
    out.into_bytes()
}

/// Two cards on a dark slide, in white: a heading over two lines, twice.
const CARDS: &str = "0.1 0.1 0.12 rg 0 0 595 842 re f\n\
1 1 1 rg\n\
BT /F1 14 Tf 60 700 Td (Personal Assistant) Tj ET\n\
BT /F1 14 Tf 320 700 Td (Meeting Intelligence) Tj ET\n\
BT /F1 11 Tf 60 655 Td (Agenda and reminders) Tj ET\n\
BT /F1 11 Tf 320 655 Td (Capture and summaries) Tj ET\n\
BT /F1 11 Tf 60 641 Td (Planning and notes) Tj ET\n\
BT /F1 11 Tf 320 641 Td (Actions and follow-up) Tj ET";

fn texts(doc: &Document) -> Vec<String> {
    doc.paragraphs(0)
        .unwrap()
        .into_iter()
        .map(|p| p.text)
        .collect()
}

#[test]
fn each_column_is_a_paragraph_of_its_own() {
    let doc = Document::open(pdf(CARDS), None).unwrap();
    let mut found = texts(&doc);
    found.sort();
    assert_eq!(
        found,
        [
            "Agenda and reminders Planning and notes",
            "Capture and summaries Actions and follow-up",
            "Meeting Intelligence",
            "Personal Assistant",
        ]
        .map(String::from),
        "a heading and a body in each card, and nothing across the two"
    );
}

#[test]
fn replacing_one_card_leaves_its_neighbour_and_keeps_the_colour() {
    let mut doc = Document::open(pdf(CARDS), None).unwrap();
    let at = texts(&doc)
        .iter()
        .position(|t| t == "Personal Assistant")
        .unwrap();
    doc.replace_paragraph(0, at, "Family Assistant", AMIRI)
        .unwrap();
    let saved = doc.save().unwrap();
    let again = Document::open(saved.clone(), None).unwrap();
    let mut found = texts(&again);
    found.sort();
    assert_eq!(
        found,
        [
            "Agenda and reminders Planning and notes",
            "Capture and summaries Actions and follow-up",
            "Family Assistant",
            "Meeting Intelligence",
        ]
        .map(String::from),
        "only the one heading changed"
    );
    // What was drawn in its place is set in the white the heading had.
    let raw = lopdf::Document::load_mem(&saved).unwrap();
    let page = *raw.get_pages().get(&1).unwrap();
    let content = String::from_utf8_lossy(&raw.get_page_content(page)).to_string();
    let drawn = &content[content.rfind("BT").unwrap().saturating_sub(24)..];
    assert!(
        drawn.contains("1 1 1 rg"),
        "the replacement repeats the heading's colour before it is shown: {drawn}"
    );
}

#[test]
fn columns_drawn_by_one_operator_stay_one_line() {
    // One operator shows both halves, a wide space apart: blanking "its"
    // operator for either half would take the other with it, so the line is
    // kept whole and is one paragraph, as before.
    let doc = Document::open(
        pdf("BT /F1 14 Tf 60 700 Td [(Left) -15000 (Right)] TJ ET"),
        None,
    )
    .unwrap();
    assert_eq!(texts(&doc), ["Left Right".to_string()]);
}
