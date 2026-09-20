//! Artifacts in Warraq's reading. What another program marks `/Artifact` —
//! Word's and LibreOffice's running heads, footers and page numbers — is
//! text on the page like any other: search finds it, and Find and redact
//! must, or a name or an e-mail in a letterhead footer stays in the file
//! after the person redacted "every" match. Only Warraq's own page marks
//! are kept out of the page's text (Edit, Export, Compare), and even those
//! are found for redaction.
use serde_json::{json, Value};
use warraq_core::{call_static, Document};

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

/// A letter as Word's tagged "Save as PDF" writes it: the footer, with an
/// address and an e-mail, is a pagination artifact.
fn letter() -> Vec<u8> {
    pdf(concat!(
        "/Artifact <</Type /Pagination /Subtype /Footer>> BDC\n",
        "BT /F1 10 Tf 72 40 Td (Nadia Haddad, nadia@example.sa) Tj ET\nEMC\n",
        "/P <</MCID 0>> BDC\n",
        "BT /F1 12 Tf 72 700 Td (The body of the letter.) Tj ET\nEMC\n",
    ))
}

fn find(doc: &mut Document, args: Value) -> Vec<String> {
    let reply = doc.call("redact.find", &args.to_string(), vec![]).unwrap();
    let v: Value = serde_json::from_str(&reply.json).unwrap();
    v["matches"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["text"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn another_programs_footer_is_read_searched_and_found_for_redaction() {
    let mut doc = Document::open(letter(), None).unwrap();
    let text = doc.extract_text(0).unwrap();
    assert!(text.contains("The body of the letter."), "{text:?}");
    assert!(text.contains("nadia@example.sa"), "{text:?}");
    assert_eq!(doc.search("Haddad"), [0]);
    assert_eq!(
        find(&mut doc, json!({ "patterns": ["email"] })),
        ["nadia@example.sa"]
    );
    assert_eq!(find(&mut doc, json!({ "query": "Haddad" })), ["Haddad"]);
}

/// Warraq's own marks stay out of the page's text — a diagonal DRAFT
/// would split every line it crosses — but a name in a header Warraq drew
/// is still found for redaction, and by search.
#[test]
fn warraqs_own_marks_are_left_out_of_the_text_but_found_for_redaction() {
    let marked = call_static(
        "marks.add",
        &json!({
            "mark": { "kind": "header", "slots": ["Prepared by Salem Otaibi", "", ""], "size": 11 },
            "pages": [], "fontBlob": 1,
        })
        .to_string(),
        vec![letter(), AMIRI.to_vec()],
    )
    .unwrap()
    .blobs
    .remove(0);
    let mut doc = Document::open(marked, None).unwrap();
    let text = doc.extract_text(0).unwrap();
    assert!(!text.contains("Salem"), "{text:?}");
    assert!(text.contains("nadia@example.sa"), "{text:?}");
    let marks: Vec<String> = doc
        .mark_lines(0)
        .unwrap()
        .into_iter()
        .map(|l| l.text)
        .collect();
    assert_eq!(marks, ["Prepared by Salem Otaibi"]);
    assert_eq!(find(&mut doc, json!({ "query": "Otaibi" })), ["Otaibi"]);
    assert_eq!(doc.search("Otaibi"), [0]);
}
