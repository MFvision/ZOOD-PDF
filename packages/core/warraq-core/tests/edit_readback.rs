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
