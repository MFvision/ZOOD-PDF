//! Editing a paragraph in the font it is already set in. The owner edited a
//! slide and the replaced text came back in Amiri whatever it had been set
//! in. When the new text uses only letters the document's own subset has,
//! it is drawn with that very font resource — nothing embedded, the same
//! size and colour — and each paragraph says what face it is in, so a host
//! can find a matching font when it is not.
use warraq_core::{CoreError, Document};
use warraq_pdf::{FaceClass, OriginalFace};

const AMIRI: &[u8] = include_bytes!("../../../../tests/fonts/Amiri-Regular.ttf");
const INTER: &[u8] = include_bytes!("../../../../tests/fonts/static/Inter-Regular-static.ttf");

/// A one-page A4 file in Helvetica drawing `content`.
fn pdf(content: &str) -> Vec<u8> {
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>".to_string(),
        format!("<< /Length {} >>\nstream\n{content}\nendstream", content.len()),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>".to_string(),
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

/// A page whose one paragraph is set in an embedded SUBSET font the file
/// calls `ABCDEF+Montserrat-SemiBold`, in blue: what a slide exported from
/// a design tool carries. The subset has the letters of `text` and no others.
fn subset_page(text: &str) -> Vec<u8> {
    let mut doc = Document::open(pdf("0.2 0.3 0.9 rg"), None).unwrap();
    doc.add_text_in_color(0, 60.0, 100.0, 14.0, text, INTER, Some([0.2, 0.3, 0.9]))
        .unwrap();
    let mut raw = lopdf::Document::load_mem(&doc.save().unwrap()).unwrap();
    for object in raw.objects.values_mut() {
        let Ok(dict) = object.as_dict_mut() else {
            continue;
        };
        for key in ["BaseFont", "FontName"] {
            if dict
                .get(key.as_bytes())
                .is_ok_and(|n| n.as_name().is_ok_and(|n| n.starts_with(b"WARRAQ+")))
            {
                dict.set(
                    key,
                    lopdf::Object::Name(b"ABCDEF+Montserrat-SemiBold".to_vec()),
                );
            }
        }
    }
    let mut out = vec![];
    raw.save_to(&mut out).unwrap();
    out
}

fn texts(doc: &Document) -> Vec<String> {
    doc.paragraphs(0)
        .unwrap()
        .into_iter()
        .map(|p| p.text)
        .collect()
}

/// How many font dictionaries the file holds, and its last text object.
fn fonts_and_last_text(bytes: &[u8]) -> (usize, String) {
    let raw = lopdf::Document::load_mem(bytes).unwrap();
    let fonts = raw
        .objects
        .values()
        .filter_map(|o| o.as_dict().ok())
        .filter(|d| {
            d.get(b"Type")
                .is_ok_and(|t| t.as_name().ok() == Some(b"Font"))
        })
        .count();
    let page = *raw.get_pages().get(&1).unwrap();
    let content = String::from_utf8_lossy(&raw.get_page_content(page)).to_string();
    let last = content[content.rfind("BT").unwrap().saturating_sub(40)..].to_string();
    (fonts, last)
}

#[test]
fn each_paragraph_says_what_face_it_is_set_in() {
    let doc = Document::open(subset_page("Meeting Intelligence quarterly"), None).unwrap();
    let fonts = doc.paragraph_fonts(0).unwrap();
    assert_eq!(fonts.len(), 1);
    assert_eq!(
        fonts[0].face,
        Some(OriginalFace {
            family: "Montserrat".into(),
            weight: 600,
            italic: false,
            class: FaceClass::Sans,
        })
    );
    assert!(fonts[0].own_font, "its own font draws its own text");

    let doc = Document::open(
        pdf("BT /F1 14 Tf 60 700 Td (Personal Assistant) Tj ET"),
        None,
    )
    .unwrap();
    assert_eq!(
        doc.paragraph_fonts(0).unwrap()[0].face,
        Some(OriginalFace {
            family: "Helvetica".into(),
            weight: 700,
            italic: false,
            class: FaceClass::Sans,
        })
    );
}

#[test]
fn letters_the_subset_has_are_drawn_with_the_documents_own_font() {
    let original = subset_page("Meeting Intelligence quarterly");
    let (fonts_before, before) = fonts_and_last_text(&original);
    let mut doc = Document::open(original, None).unwrap();
    let size_before = doc.paragraphs(0).unwrap()[0].font_size;
    // No font given: the paragraph's own.
    let r = doc.replace_paragraph(0, 0, "Meeting gently", &[]).unwrap();
    assert!(!r.font_substituted, "nothing was substituted");
    assert!(!r.shrunk && !r.overflowed);
    assert_eq!(r.font_size, 14.0, "the size the paragraph was set in");
    let saved = doc.save().unwrap();

    let again = Document::open(saved.clone(), None).unwrap();
    assert_eq!(texts(&again), ["Meeting gently".to_string()]);
    assert_eq!(again.paragraphs(0).unwrap()[0].font_size, size_before);
    let (fonts_after, after) = fonts_and_last_text(&saved);
    assert_eq!(
        fonts_after, fonts_before,
        "no font object was added to the file"
    );
    // The same resource the paragraph used, at its size, in its colour.
    let resource = before
        .split_whitespace()
        .find(|t| t.starts_with("/FW"))
        .expect("the page's own font resource");
    assert!(after.contains(&format!("{resource} 14 Tf")), "{after}");
    assert!(after.contains("0.2 0.3 0.9 rg"), "{after}");
    // The face is still the document's.
    assert_eq!(
        again.paragraph_fonts(0).unwrap()[0]
            .face
            .as_ref()
            .map(|f| f.family.as_str()),
        Some("Montserrat")
    );
}

#[test]
fn a_letter_the_subset_lacks_leaves_the_page_alone_and_says_so() {
    let original = subset_page("Meeting Intelligence quarterly");
    let mut doc = Document::open(original, None).unwrap();
    // No b, o or x in the subset.
    let refused = doc.replace_paragraph(0, 0, "Meeting box", &[]);
    assert!(matches!(refused, Err(CoreError::OwnFont)), "{refused:?}");
    assert_eq!(
        refused.unwrap_err().to_string().split(':').next(),
        Some("E_OWN_FONT")
    );
    assert_eq!(
        texts(&doc),
        ["Meeting Intelligence quarterly".to_string()],
        "nothing was changed"
    );
    // The host falls through to a font of its own, and is told so.
    let r = doc.replace_paragraph(0, 0, "Meeting box", AMIRI).unwrap();
    assert!(r.font_substituted);
    let again = Document::open(doc.save().unwrap(), None).unwrap();
    assert_eq!(texts(&again), ["Meeting box".to_string()]);
}

#[test]
fn a_standard_font_is_reused_by_its_encoding() {
    let mut doc = Document::open(
        pdf("1 0 0 rg\nBT /F1 14 Tf 60 700 Td (Personal Assistant) Tj ET\nBT /F1 14 Tf 60 600 Td (Kept as it is) Tj ET"),
        None,
    )
    .unwrap();
    assert!(doc.paragraph_fonts(0).unwrap().iter().all(|f| f.own_font));
    let at = texts(&doc)
        .iter()
        .position(|t| t == "Personal Assistant")
        .unwrap();
    // Letters the paragraph never used: the font is whole, so they are there.
    let r = doc
        .replace_paragraph(0, at, "My Aid (26) – é", &[])
        .unwrap();
    assert!(!r.font_substituted);
    let saved = doc.save().unwrap();
    let again = Document::open(saved.clone(), None).unwrap();
    let mut found = texts(&again);
    found.sort();
    assert_eq!(
        found,
        ["Kept as it is", "My Aid (26) – é"].map(String::from)
    );
    let (fonts, last) = fonts_and_last_text(&saved);
    assert_eq!(fonts, 1, "Helvetica alone, as before");
    assert!(
        last.contains("/F1 14 Tf") && last.contains("1 0 0 rg"),
        "{last}"
    );
}

#[test]
fn text_too_long_for_its_box_is_shrunk_and_says_so() {
    let mut doc = Document::open(pdf("BT /F1 14 Tf 60 700 Td (Short) Tj ET"), None).unwrap();
    let r = doc
        .replace_paragraph(0, 0, "Considerably longer than the box it was in", &[])
        .unwrap();
    assert!(r.shrunk, "one line's box cannot hold it at 14 points");
    assert!(r.font_size < 14.0);
}

#[test]
fn arabic_never_uses_the_documents_own_font() {
    let bytes = std::fs::read(format!(
        "{}/../../../tests/corpus/arabic/generated/raw-amiri-cid-identity-tounicode.pdf",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap();
    let mut doc = Document::open(bytes, None).unwrap();
    let fonts = doc.paragraph_fonts(0).unwrap();
    assert!(!fonts.is_empty());
    assert!(
        fonts.iter().all(|f| !f.own_font),
        "a subset cannot say which joining form goes where"
    );
    assert_eq!(
        fonts[0].face.as_ref().map(|f| (f.family.as_str(), f.class)),
        Some(("Amiri", FaceClass::Serif))
    );
    // Not even for Latin text typed into an Arabic paragraph.
    for text in ["نص جديد", "Latin"] {
        assert!(matches!(
            doc.replace_paragraph(0, 0, text, &[]),
            Err(CoreError::OwnFont)
        ));
    }
    // It goes on being shaped and embedded.
    let r = doc.replace_paragraph(0, 0, "نص جديد", AMIRI).unwrap();
    assert!(r.font_substituted);
}

/// Writes `tests/fixtures/edit/own-font-subset.pdf`, the page the browser
/// test edits (`apps/web/e2e/edit-font.spec.ts`): one blue line in an
/// embedded subset the file calls Montserrat SemiBold (the glyphs are
/// Inter's — what matters is that the subset has those letters and no
/// others). Run by hand when the fixture must change:
/// `cargo test -p warraq-core --test edit_own_font -- --ignored`.
#[test]
#[ignore = "writes the browser test's fixture"]
fn write_the_fixture() {
    let path = format!(
        "{}/../../../tests/fixtures/edit/own-font-subset.pdf",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::create_dir_all(std::path::Path::new(&path).parent().unwrap()).unwrap();
    std::fs::write(path, subset_page("Meeting Intelligence quarterly")).unwrap();
}
