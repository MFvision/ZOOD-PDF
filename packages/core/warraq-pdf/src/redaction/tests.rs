//! Redaction at the object level: what each kind of content leaves in the
//! written file. The reader's view of the result (text read back, glyphs
//! of the neighbours where they were) is tested in warraq-core, where the
//! reader is.
use lopdf::content::Content;
use lopdf::Object;

use super::*;
use crate::hidden::tests::{file_of, readable};

fn stream(body: &str) -> String {
    format!("<< /Length {} >>\nstream\n{body}\nendstream", body.len())
}

/// A font every byte of which is half an em wide: its boxes are certain.
const FONT: &str = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /FirstChar 32 /LastChar 126 /Widths [95*500] >>";

fn widths() -> String {
    let w = vec!["500"; 95].join(" ");
    FONT.replace("95*500", &w)
}

/// A page with a line of text, a replacement-text span, a picture, a
/// drawing, a background, a form drawing text, and two comments.
fn fixture() -> Vec<u8> {
    let page = "q 0.95 g 0 0 612 792 re f Q\n\
        BT /F1 12 Tf 72 700 Td (Name: Nadia Haddad here) Tj ET\n\
        /Span <</ActualText (Haddad)>> BDC BT /F1 12 Tf 72 650 Td (Haddad) Tj ET EMC\n\
        q 100 0 0 100 300 400 cm /Im1 Do Q\n\
        q 0 0 1 RG 310 410 m 340 450 l 380 420 l S Q\n\
        /Fm1 Do";
    let pixels = "z".repeat(100);
    file_of(&[
        (1, "<< /Type /Catalog /Pages 2 0 R >>".into()),
        (2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".into()),
        (
            3,
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R \
             /Resources << /Font << /F1 5 0 R >> /XObject << /Im1 6 0 R /Fm1 7 0 R >> >> \
             /Annots [8 0 R 9 0 R] /PieceInfo << /Warraq << /Private (Haddad) >> >> >>"
                .into(),
        ),
        (4, stream(page)),
        (5, widths()),
        (
            6,
            format!(
                "<< /Type /XObject /Subtype /Image /Width 10 /Height 10 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 100 >>\nstream\n{pixels}\nendstream"
            ),
        ),
        (
            7,
            stream("BT /F1 12 Tf 72 500 Td (Secret ABC) Tj ET")
                .replace("<< /Length", "<< /Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Length"),
        ),
        (
            8,
            "<< /Type /Annot /Subtype /FreeText /Rect [60 640 120 670] /Contents (Haddad again) /DA (/Helv 12 Tf) >>".into(),
        ),
        (
            9,
            "<< /Type /Annot /Subtype /Text /Rect [20 20 40 40] /Contents (kept note) >>".into(),
        ),
    ])
}

/// A box in points from the top-left of a 792-point page.
fn mark(x: f32, top: f32, w: f32, h: f32) -> RedactMark {
    RedactMark {
        page: 0,
        rect: [x, top, w, h],
    }
}

/// Every string a page's content shows, in order, joined.
fn shown(doc: &PdfDocument, content: &[u8]) -> String {
    let _ = doc;
    let ops = Content::decode(content).unwrap().operations;
    let mut out = String::new();
    for op in ops {
        for o in op.operands {
            match o {
                Object::String(b, _) => out.push_str(&String::from_utf8_lossy(&b)),
                Object::Array(a) => {
                    for i in a {
                        if let Object::String(b, _) = i {
                            out.push_str(&String::from_utf8_lossy(&b));
                        }
                    }
                }
                _ => {}
            }
        }
        out.push('|');
    }
    out
}

fn page_content(doc: &PdfDocument) -> Vec<u8> {
    let page = doc.page_id(0).unwrap();
    doc.doc.get_page_content(page)
}

#[test]
fn a_word_under_a_mark_is_cut_and_its_neighbours_keep_their_places() {
    let doc = PdfDocument::open(fixture(), None).unwrap();
    // "Haddad" on the first line: 12 characters of 6 pt after x = 72.
    let (bytes, report) = doc
        .redacted(&[mark(144.0, 78.0, 36.0, 16.0)], Some([0.0, 0.0, 0.0]))
        .unwrap();
    assert_eq!(report.glyphs, 6, "{report:?}");
    let after = PdfDocument::open(bytes.clone(), None).unwrap();
    let content = page_content(&after);
    let text = shown(&after, &content);
    assert!(
        text.contains("Name: Nadia | here|") || text.contains("Name: Nadia  here"),
        "{text}"
    );
    // The cut is replaced by its width: six half-em glyphs, -3000.
    let ops = Content::decode(&content).unwrap().operations;
    let tj = ops.iter().find(|o| o.operator == "TJ").unwrap();
    let items = tj.operands[0].as_array().unwrap();
    assert_eq!(items.len(), 3, "{items:?}");
    assert_eq!(items[1].as_float().unwrap(), -3000.0);
    // Nothing of the word in the file, anywhere but the line it was not cut
    // from (the second line, the comment and the private data were not
    // under this mark, but the line on the page is).
    let readable = readable(&bytes);
    assert_eq!(readable.matches("Haddad").count(), 3, "{readable}");
    // A box over the mark.
    assert!(readable.contains("144 698 36 16 re f Q"), "{readable}");
    // Written whole: one revision.
    assert_eq!(crate::hidden::earlier_revisions(&bytes), 0);
}

#[test]
fn replacement_text_annotations_and_private_data_go_with_what_they_held() {
    let doc = PdfDocument::open(fixture(), None).unwrap();
    // "Haddad" on the second line, under its /ActualText, and the comment
    // over it.
    let (bytes, report) = doc
        .redacted(
            &[mark(72.0, 128.0, 36.0, 16.0), mark(144.0, 78.0, 36.0, 16.0)],
            None,
        )
        .unwrap();
    assert_eq!(report.glyphs, 12, "{report:?}");
    assert_eq!(report.annotations, 1, "{report:?}");
    let readable = readable(&bytes);
    assert!(!readable.contains("Haddad"), "{readable}");
    assert!(!readable.contains("ActualText"), "{readable}");
    assert!(readable.contains("kept note"));
    assert!(!readable.contains("PieceInfo"));
}

#[test]
fn pixels_under_a_mark_are_blanked_and_a_drawing_inside_it_goes() {
    let doc = PdfDocument::open(fixture(), None).unwrap();
    // The picture covers (300, 400)–(400, 500); the mark its left half
    // (stored y: 792 - 500 = 292 from the top).
    let (bytes, report) = doc
        .redacted(&[mark(300.0, 292.0, 50.0, 100.0)], None)
        .unwrap();
    assert_eq!(report.images, 1, "{report:?}");
    assert_eq!(
        report.paths, 1,
        "the drawing is mostly under the mark: {report:?}"
    );
    let after = PdfDocument::open(bytes, None).unwrap();
    let page = after.page_id(0).unwrap();
    let resources = after.page_resources(page).unwrap().clone();
    let xobjects = match resources.get(b"XObject").unwrap() {
        Object::Dictionary(d) => d.clone(),
        Object::Reference(r) => after.doc.get_dictionary(*r).unwrap().clone(),
        _ => panic!(),
    };
    // The copy the page draws now: left half zero, right half as it was.
    let content = String::from_utf8_lossy(&page_content(&after)).into_owned();
    let drawn = content.split_whitespace().collect::<Vec<_>>();
    let at = drawn.iter().position(|w| *w == "Do").unwrap();
    let name = drawn[at - 1].trim_start_matches('/');
    let image = after
        .doc
        .get_object(
            xobjects
                .get(name.as_bytes())
                .unwrap()
                .as_reference()
                .unwrap(),
        )
        .unwrap()
        .as_stream()
        .unwrap()
        .decompressed_content()
        .unwrap();
    for (i, v) in image.iter().enumerate() {
        let want = if i % 10 < 5 { 0 } else { b'z' };
        assert_eq!(*v, want, "pixel {i}");
    }
    // The background crosses the mark and stays.
    assert!(content.contains("0 0 612 792 re"));
    assert!(!content.contains("340 450 l"));
}

#[test]
fn text_in_a_form_is_cut_from_a_copy_drawn_in_its_place() {
    let doc = PdfDocument::open(fixture(), None).unwrap();
    // "Secret" at x 72–108, baseline 500.
    let (bytes, report) = doc
        .redacted(&[mark(72.0, 278.0, 36.0, 16.0)], None)
        .unwrap();
    assert_eq!(report.glyphs, 6, "{report:?}");
    let readable = readable(&bytes);
    assert!(!readable.contains("Secret"), "{readable}");
    // What was beside it, kept: " ABC", written back as hex.
    assert!(readable.contains("<20414243>"), "{readable}");
}

#[test]
fn a_protected_file_and_a_mark_off_the_document_are_refused() {
    let doc = PdfDocument::open(fixture(), None).unwrap();
    assert!(matches!(
        doc.redacted(
            &[RedactMark {
                page: 3,
                rect: [0.0, 0.0, 10.0, 10.0]
            }],
            None
        ),
        Err(Error::Page(3))
    ));
    assert!(doc.redacted(&[mark(0.0, 0.0, 0.0, 10.0)], None).is_err());
    let locked = std::fs::read(format!(
        "{}/../../../tests/corpus/arabic/generated/variant-encrypted-aes256.pdf",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap();
    // Its password is in the corpus manifest.
    let doc = PdfDocument::open(locked, Some("warraq")).unwrap();
    assert!(doc.redacted(&[mark(10.0, 10.0, 10.0, 10.0)], None).is_err());
}

#[test]
fn hostile_content_is_redacted_without_a_panic() {
    // Unbalanced and truncated operators, a string never closed, a TJ of
    // junk, a form that draws itself.
    let page = "q q q BT /F1 12 Tf 72 700 Td (abc Tj [ (x) 1e99 <zz> ] TJ ET ) ' Q Q Q Q /Fm1 Do BI /W 4 /H 4 ID xx";
    let bytes = file_of(&[
        (1, "<< /Type /Catalog /Pages 2 0 R >>".into()),
        (2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".into()),
        (
            3,
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R \
             /Resources << /Font << /F1 5 0 R >> /XObject << /Fm1 6 0 R >> >> >>"
                .into(),
        ),
        (4, stream(page)),
        (5, widths()),
        (
            6,
            stream("/Fm1 Do")
                .replace("<< /Length", "<< /Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << /XObject << /Fm1 6 0 R >> >> /Length"),
        ),
    ]);
    let doc = PdfDocument::open(bytes, None).unwrap();
    let _ = doc.redacted(&[mark(0.0, 0.0, 612.0, 792.0)], Some([0.0, 0.0, 0.0]));
}
