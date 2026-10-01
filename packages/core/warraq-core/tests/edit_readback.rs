//! Text Warraq writes reads back as it was typed: a paragraph replaced in
//! the Word export, in Amiri (the editor's default face) and the editor's
//! other faces, and read by the same reader that Edit text, Export, Compare
//! and search use.
use warraq_core::Document;

fn repo(path: &str) -> Vec<u8> {
    std::fs::read(format!("{}/../../../{path}", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

#[test]
fn a_replaced_paragraph_reads_back_word_for_word() {
    let word = repo(
        "tests/corpus/arabic/realworld/A_worldbank_malpass_g7_briefing_AR_word2016_pdftools.pdf",
    );
    // Amiri first, then the editor's other faces.
    for face in [
        "tests/fonts/Amiri-Regular.ttf",
        "tests/fonts/NotoNaskhArabic-Variable.ttf",
        "tests/fonts/Cairo-Variable.ttf",
    ] {
        let font = repo(face);
        for text in [
            "فقرة جديدة كتبها الاختبار",
            "صباح الخير يا عالم",
            "كتب أحمد ثلاث رسائل في يوم واحد",
        ] {
            let mut doc = Document::open(word.clone(), None).unwrap();
            doc.replace_paragraph(0, 0, text, &font).unwrap();
            let read = doc.extract_text(0).unwrap();
            assert!(read.contains(text), "{face}: {text:?} not in {read:?}");
            let again = Document::open(doc.save().unwrap(), None).unwrap();
            let read = again.extract_text(0).unwrap();
            assert!(
                read.contains(text),
                "{face}, after saving: {text:?} not in {read:?}"
            );
        }
    }
}

/// Replacing a paragraph leaves nothing of the old one behind. Chrome draws
/// some glyphs of an Arabic heading as runs of their own, set lower than
/// the line by the font's positioning; two of them (a nūn and a thāʾ of
/// «الفصل الثاني: محرّك النصوص») sat below the paragraph's box by more than
/// the erase allowed, survived, and read back inside the new text and as a
/// line of their own — on the page as well as in the text.
#[test]
fn a_replaced_paragraph_leaves_nothing_of_the_old_one() {
    let pdf = repo("tests/corpus/arabic/generated/chrome-notonaskh-justified-3pages.pdf");
    let before: Vec<String> = Document::open(pdf.clone(), None)
        .unwrap()
        .text_lines(1)
        .unwrap()
        .into_iter()
        .map(|l| l.text)
        .collect();
    for face in [
        "tests/fonts/Amiri-Regular.ttf",
        "tests/fonts/Cairo-Variable.ttf",
        "tests/fonts/Inter-Variable.ttf",
    ] {
        let font = repo(face);
        for text in ["نص جديد كتب في مكانه", "Hello world"] {
            let mut doc = Document::open(pdf.clone(), None).unwrap();
            doc.replace_paragraph(1, 0, text, &font).unwrap();
            let again = Document::open(doc.save().unwrap(), None).unwrap();
            let after: Vec<String> = again
                .text_lines(1)
                .unwrap()
                .into_iter()
                .map(|l| l.text)
                .collect();
            assert_eq!(after[0], text, "{face}: the heading reads as typed");
            assert_eq!(
                after[1..],
                before[1..],
                "{face}: the rest of the page is as it was"
            );
        }
    }
}
