//! Every reader on generated fixtures (`scripts/create-fixtures.py`): created PDF → warraq-text
//! → the source text in logical order; pictures and TIFF pages; invariants of the output.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod common;

use common::*;
use warraq_create::CreateOptions;

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(format!(
        "{}/../../../../tests/fixtures/create/{name}",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap()
}

fn truth(name: &str) -> String {
    String::from_utf8(fixture(&format!("{name}.truth.txt"))).unwrap()
}

fn check(name: &str) -> (Vec<u8>, String) {
    let bytes = fixture(name);
    let pdf = one(&[(name, &bytes)], &opts());
    dump(&pdf, name);
    assert_pdf_invariants(&pdf);
    let text = plain_text(&pdf);
    (pdf, text)
}

/// Flow text must come back in logical order (as a subsequence of the extraction); table rows
/// ("| a | b" lines) must come back completely with each cell's words together; nothing else.
fn assert_words(name: &str, text: &str) {
    let t = truth(name);
    let got = words(text);
    let cells = |l: &str| -> Vec<String> {
        l.trim_start_matches("| ")
            .split(" | ")
            .map(str::to_string)
            .collect()
    };
    let mut all: Vec<String> = t.lines().flat_map(&cells).flat_map(|c| words(&c)).collect();
    let mut sorted = got.clone();
    sorted.sort();
    all.sort();
    assert_eq!(sorted, all, "{name}: same words\n{text}");
    let flow: Vec<String> = t
        .lines()
        .filter(|l| !l.starts_with("| "))
        .flat_map(words)
        .collect();
    let mut it = got.iter();
    for w in &flow {
        assert!(
            it.any(|g| g == w),
            "{name}: flow word {w:?} out of logical order\n{text}"
        );
    }
    for row in t.lines().filter(|l| l.starts_with("| ")) {
        for cell in cells(row) {
            let cw = words(&cell);
            if cw.len() > 1 {
                assert!(
                    got.windows(cw.len()).any(|w| w == cw.as_slice()),
                    "{name}: cell {cell:?} split\n{text}"
                );
            }
        }
    }
}

#[test]
fn docx_arabic_english_table_list_picture() {
    let (pdf, text) = check("report.docx");
    assert_words("report.docx", &text);
    assert_eq!(page_count(&pdf), 2, "page break");
    let content = all_content(&pdf);
    assert!(
        content.contains("/Figure <</MCID"),
        "picture tagged as Figure"
    );
    let (roles, alts) = struct_roles(&pdf);
    for r in [
        "Document", "H1", "P", "L", "LI", "Lbl", "LBody", "Table", "TR", "TD", "Figure",
    ] {
        assert!(roles.iter().any(|x| x == r), "{r} in {roles:?}");
    }
    assert_eq!(alts.len(), 1, "one Figure with /Alt");
    assert!(content.contains("/H1 <</MCID"));
    assert!(content.contains("/LBody <</MCID"));
}

#[test]
fn xlsx_sheets_as_tables() {
    let (_, text) = check("sales.xlsx");
    assert_words("sales.xlsx", &text);
}

#[test]
fn pptx_one_page_per_slide() {
    let (pdf, text) = check("deck.pptx");
    assert_eq!(page_count(&pdf), 2);
    assert_words("deck.pptx", &text);
    let d = lopdf::Document::load_mem(&pdf).unwrap();
    let (_, p0) = d.get_pages().into_iter().next().unwrap();
    let mb = d
        .get_dictionary(p0)
        .unwrap()
        .get(b"MediaBox")
        .unwrap()
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(mb[2].as_float().unwrap(), 720.0);
    assert_eq!(mb[3].as_float().unwrap(), 540.0);
}

#[test]
fn markdown_html_csv_text() {
    for name in ["guide.md", "page.html", "data.csv", "notes.txt"] {
        let (_, text) = check(name);
        assert_words(name, &text);
    }
}

#[test]
fn pictures_and_multi_page_tiff() {
    let (pdf, _) = check("photo.jpg");
    assert_eq!(page_count(&pdf), 1);
    // 300×200 px at 150 dpi = 144×96 pt.
    assert!(String::from_utf8_lossy(&pdf).contains("/DCTDecode"));
    let (pdf, _) = check("logo.png");
    assert!(String::from_utf8_lossy(&pdf).contains("/SMask"));
    let (pdf, _) = check("scan.tif");
    assert_eq!(page_count(&pdf), 3);
    let raw = String::from_utf8_lossy(&pdf);
    assert!(raw.contains("/CCITTFaxDecode"), "G4 passed through");
    // Page 1: the black square is black in the middle and white at the corner (polarity).
    let bmp = render(&pdf, 0);
    let px = |x: u32, y: u32| {
        let i = ((y * bmp.width + x) * 4) as usize;
        bmp.rgba[i]
    };
    assert_eq!((bmp.width, bmp.height), (144, 108), "400×300 px at 200 dpi");
    assert!(px(72, 54) < 60, "centre is black");
    assert!(px(5, 5) > 200, "corner is white");
    // Page 2 (LZW RGB): red top-left quadrant.
    let bmp = render(&pdf, 1);
    let i = ((10 * bmp.width + 10) * 4) as usize;
    assert!(bmp.rgba[i] > 200 && bmp.rgba[i + 1] < 60);
    // Page 3 (Deflate gray): black bottom half.
    let bmp = render(&pdf, 2);
    let i = (((bmp.height - 5) * bmp.width + 10) * 4) as usize;
    assert!(bmp.rgba[i] < 60);
}

#[test]
fn everything_merged_into_one_pdf() {
    let names = [
        "report.docx",
        "sales.xlsx",
        "deck.pptx",
        "guide.md",
        "scan.tif",
        "photo.jpg",
    ];
    let files: Vec<(&str, Vec<u8>)> = names.iter().map(|n| (*n, fixture(n))).collect();
    let refs: Vec<(&str, &[u8])> = files.iter().map(|(n, b)| (*n, b.as_slice())).collect();
    let pdf = one(
        &refs,
        &CreateOptions {
            page_numbers: true,
            ..opts()
        },
    );
    assert_pdf_invariants(&pdf);
    assert_eq!(
        page_count(&pdf),
        2 + 2 + 2 + 1 + 3 + 1,
        "docx 2, xlsx 2 (two sheets), pptx 2, md 1, tiff 3, jpeg 1"
    );
}
