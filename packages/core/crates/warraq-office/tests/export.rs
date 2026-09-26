//! Export proofs on the Arabic corpus and on generated tables.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod common;

use common::*;
use serde_json::json;
use warraq_office::{export, Format};
use warraq_text::DocSource;

fn run(bytes: Vec<u8>, format: Format, params: serde_json::Value) -> (serde_json::Value, Vec<u8>) {
    let pdf = warraq_pdf::Pdf::open(bytes, None).unwrap();
    let src = DocSource::borrowed(pdf.document());
    export(&src, format, &params, &[]).unwrap()
}

const ARABIC: &[&str] = &[
    "chrome-news-amiri",
    "chrome-news-cairo-type3",
    "chrome-mixed-naskh",
    "chrome-hard-bidi-naskh",
    "chrome-two-column-naskh",
    "chrome-table-cairo",
    "chrome-bold-naskh",
    "chrome-tashkeel-amiri",
    "chrome-lists-cairo",
    "chrome-urdu-nastaliq",
    "chrome-persian-vazirmatn",
    "synthetic-word-naskh",
    "synthetic-libreoffice-naskh",
];

#[test]
fn text_export_of_the_arabic_corpus_equals_the_logical_truth() {
    for id in ARABIC {
        let (meta, bytes) = run(corpus(&format!("{id}.pdf")), Format::Text, json!({}));
        assert_eq!(meta["extension"], "txt");
        let got = String::from_utf8(bytes).unwrap();
        let acc = accuracy(&got, &truth(&format!("{id}.txt")));
        // The acid gate's floor is 99.80 %.
        assert!(acc >= 0.998, "{id}: {:.2}%\n{got}", acc * 100.0);
    }
}

#[test]
fn docx_has_bidi_arabic_paragraphs_in_logical_order() {
    for id in [
        "chrome-news-amiri",
        "chrome-mixed-naskh",
        "synthetic-word-naskh",
        "chrome-tashkeel-amiri",
    ] {
        let (meta, bytes) = run(
            corpus(&format!("{id}.pdf")),
            Format::Docx,
            json!({"title": "تقرير"}),
        );
        assert_eq!(meta["extension"], "docx");
        let files = unzip(&bytes);
        for part in [
            "[Content_Types].xml",
            "_rels/.rels",
            "word/document.xml",
            "word/_rels/document.xml.rels",
            "word/styles.xml",
            "docProps/core.xml",
            "docProps/app.xml",
        ] {
            let x = files
                .get(part)
                .unwrap_or_else(|| panic!("{id}: missing {part}"));
            assert_well_formed(part, x);
        }
        let xml = String::from_utf8(files["word/document.xml"].clone()).unwrap();
        let paras = docx_paragraphs(&xml);
        let mut arabic = 0;
        for (text, bidi, rtl_ok) in &paras {
            let ar = text
                .chars()
                .filter(|c| ('\u{0620}'..='\u{064A}').contains(c))
                .count();
            let latin = text.chars().filter(|c| c.is_ascii_alphabetic()).count();
            if ar > latin {
                arabic += 1;
                assert!(bidi, "{id}: Arabic paragraph without <w:bidi/>: {text}");
            }
            assert!(rtl_ok, "{id}: Arabic run without <w:rtl/>: {text}");
        }
        assert!(arabic > 0, "{id}: no Arabic paragraphs");
        let all: Vec<String> = paras
            .into_iter()
            .map(|p| p.0)
            .filter(|t| !t.is_empty())
            .collect();
        let acc = accuracy(&all.join("\n"), &truth(&format!("{id}.txt")));
        assert!(
            acc >= 0.99,
            "{id}: document.xml text {:.2}%\n{}",
            acc * 100.0,
            all.join("\n")
        );
        assert!(
            xml.contains("w:bidi=\"ar-SA\""),
            "{id}: complex-script language"
        );
        let core = String::from_utf8(files["docProps/core.xml"].clone()).unwrap();
        assert!(core.contains("<dc:title>تقرير</dc:title>"));
    }
}

/// A generated Arabic invoice table: header row, Arabic names, Western and Arabic-Indic numbers.
fn arabic_table_pdf() -> Vec<u8> {
    let mut p = PageBuilder::new();
    p.text(545.0, 80.0, "فاتورة الشراء", 20.0, true);
    // Columns right to left: البند | الكمية | السعر
    let xs = [100.0, 250.0, 400.0, 545.0];
    let tops = [100.0, 130.0, 160.0, 190.0, 220.0];
    p.grid(&xs, &tops);
    let rows: [[&str; 3]; 4] = [
        ["البند", "الكمية", "السعر"],
        ["قلم", "12", "٣٥٠"],
        ["دفتر ملاحظات", "٧", "1500"],
        ["حقيبة", "3", "42.5"],
    ];
    for (r, row) in rows.iter().enumerate() {
        let base = tops[r] + 21.0;
        for (c, text) in row.iter().enumerate() {
            // column c counted from the right
            let right = xs[3 - c] - 8.0;
            p.text(right, base, text, 12.0, true);
        }
    }
    p.text(545.0, 260.0, "شكرًا لتعاملكم معنا.", 12.0, true);
    build(&[&p])
}

#[test]
fn xlsx_of_a_generated_arabic_table_has_the_right_cells() {
    let (meta, bytes) = run(
        arabic_table_pdf(),
        Format::Xlsx,
        json!({"sheetNames": {"table": "جدول"}}),
    );
    assert_eq!(meta["tables"], 1);
    let files = unzip(&bytes);
    for (name, x) in &files {
        if name.ends_with(".xml") || name.ends_with(".rels") {
            assert_well_formed(name, x);
        }
    }
    let wb = String::from_utf8(files["xl/workbook.xml"].clone()).unwrap();
    assert!(wb.contains("name=\"جدول 1\""), "{wb}");
    let sheet = String::from_utf8(files["xl/worksheets/sheet1.xml"].clone()).unwrap();
    assert!(sheet.contains("rightToLeft=\"1\""), "RTL sheet view");
    let strings: Vec<String> = texts_of(&files["xl/sharedStrings.xml"], "t");
    let cell = |r: &str| -> String {
        let c = sheet
            .split(&format!("<c r=\"{r}\""))
            .nth(1)
            .unwrap_or_else(|| panic!("no cell {r}: {sheet}"));
        let c = c.split("</c>").next().unwrap();
        let v: String = c
            .split("<v>")
            .nth(1)
            .unwrap()
            .split("</v>")
            .next()
            .unwrap()
            .to_string();
        if c.contains("t=\"s\"") {
            strings[v.parse::<usize>().unwrap()].clone()
        } else {
            v
        }
    };
    // Column A is the first column in reading order (the rightmost one).
    assert_eq!(cell("A1"), "البند");
    assert_eq!(cell("B1"), "الكمية");
    assert_eq!(cell("C1"), "السعر");
    assert_eq!(cell("A2"), "قلم");
    assert_eq!(cell("B2"), "12");
    assert_eq!(cell("C2"), "350");
    assert_eq!(cell("A3"), "دفتر ملاحظات");
    assert_eq!(cell("B3"), "7");
    assert_eq!(cell("C3"), "1500");
    assert_eq!(cell("C4"), "42.5");
}

#[test]
fn docx_and_html_keep_the_table_structure() {
    let (_, docx) = run(arabic_table_pdf(), Format::Docx, json!({}));
    let xml = String::from_utf8(unzip(&docx)["word/document.xml"].clone()).unwrap();
    assert_eq!(xml.matches("<w:tbl>").count(), 1);
    assert!(xml.contains("<w:bidiVisual/>"));
    assert_eq!(xml.matches("<w:tr>").count(), 4);
    assert_eq!(xml.matches("<w:gridCol ").count(), 3);
    // the title stays a paragraph before the table, the thanks line after it
    let t = xml.find("<w:tbl>").unwrap();
    assert!(xml[..t].contains("فاتورة"));
    assert!(xml[t..].contains("شكرًا"));

    let (_, html) = run(arabic_table_pdf(), Format::Html, json!({"title": "فاتورة"}));
    let html = String::from_utf8(html).unwrap();
    assert!(html.starts_with("<!DOCTYPE html>"));
    assert!(html.contains("<html lang=\"ar\" dir=\"rtl\">"));
    assert!(html.contains("<table dir=\"rtl\">"));
    assert!(
        html.contains("<th>البند</th><th>الكمية</th><th>السعر</th>"),
        "{html}"
    );
    assert!(!html.contains("<script"));
    assert!(
        html.contains("<h1 dir=\"rtl\">فاتورة الشراء</h1>"),
        "{html}"
    );

    let (_, md) = run(arabic_table_pdf(), Format::Markdown, json!({}));
    let md = String::from_utf8(md).unwrap();
    assert!(md.contains("# فاتورة الشراء"), "{md}");
    assert!(md.contains("| البند | الكمية | السعر |"), "{md}");
    assert!(md.contains("| --- | --- | --- |"));
}

#[test]
fn merged_cells_become_spans() {
    let mut p = PageBuilder::new();
    // 3 columns, header cell spanning the two left-most columns (no rule between them in row 0).
    let xs = [100.0, 250.0, 400.0, 545.0];
    let tops = [100.0, 130.0, 160.0, 190.0];
    for &t in &tops {
        p.line(xs[0], t, xs[3], t);
    }
    for &x in &[xs[0], xs[2], xs[3]] {
        p.line(x, tops[0], x, tops[3]);
    }
    p.line(xs[1], tops[1], xs[1], tops[3]);
    p.text(537.0, 121.0, "الاسم", 12.0, true);
    p.text(392.0, 121.0, "العنوان", 12.0, true);
    for (r, base) in [151.0, 181.0].iter().enumerate() {
        p.text(
            537.0,
            *base,
            if r == 0 { "سارة" } else { "علي" },
            12.0,
            true,
        );
        p.text(392.0, *base, "الرياض", 12.0, true);
        p.text(242.0, *base, "12345", 12.0, true);
    }
    let bytes = build(&[&p]);
    let (_, xlsx) = run(bytes.clone(), Format::Xlsx, json!({}));
    let files = unzip(&xlsx);
    let sheet = String::from_utf8(files["xl/worksheets/sheet1.xml"].clone()).unwrap();
    assert!(sheet.contains("<mergeCell ref=\"B1:C1\"/>"), "{sheet}");
    let (_, docx) = run(bytes, Format::Docx, json!({}));
    let xml = String::from_utf8(unzip(&docx)["word/document.xml"].clone()).unwrap();
    assert!(xml.contains("<w:gridSpan w:val=\"2\"/>"), "{xml}");
}

#[test]
fn chrome_table_corpus_file_becomes_a_spreadsheet() {
    let (meta, bytes) = run(corpus("chrome-table-cairo.pdf"), Format::Xlsx, json!({}));
    assert_eq!(meta["tables"], 1, "{meta}");
    let files = unzip(&bytes);
    let sheet = String::from_utf8(files["xl/worksheets/sheet1.xml"].clone()).unwrap();
    let strings = texts_of(&files["xl/sharedStrings.xml"], "t");
    assert!(sheet.contains("rightToLeft=\"1\""));
    assert_eq!(sheet.matches("<row ").count(), 5, "{sheet}");
    assert_eq!(strings[0], "المنتج", "{strings:?}");
    assert!(strings.contains(&"سعر الوحدة".to_string()), "{strings:?}");
    assert!(strings.contains(&"حاسوب محمول".to_string()), "{strings:?}");
    assert!(sheet.contains("<c r=\"D2\"><v>13500</v></c>"), "{sheet}");
    assert!(sheet.contains("<c r=\"B5\"><v>10</v></c>"), "{sheet}");
}

#[test]
fn two_column_prose_is_not_a_table() {
    for id in [
        "chrome-two-column-naskh",
        "chrome-news-amiri",
        "chrome-lists-cairo",
        "chrome-english-inter",
    ] {
        let (meta, _) = run(corpus(&format!("{id}.pdf")), Format::Docx, json!({}));
        assert_eq!(meta["tables"], 0, "{id}");
    }
}

#[test]
fn pptx_has_one_slide_per_page_with_positioned_text() {
    let (meta, bytes) = run(corpus("synthetic-word-naskh.pdf"), Format::Pptx, json!({}));
    assert_eq!(meta["pages"], 2);
    let files = unzip(&bytes);
    for part in [
        "[Content_Types].xml",
        "ppt/presentation.xml",
        "ppt/_rels/presentation.xml.rels",
        "ppt/slideMasters/slideMaster1.xml",
        "ppt/slideLayouts/slideLayout1.xml",
        "ppt/theme/theme1.xml",
        "ppt/slides/slide1.xml",
        "ppt/slides/slide2.xml",
        "ppt/slides/_rels/slide1.xml.rels",
    ] {
        assert_well_formed(
            part,
            files.get(part).unwrap_or_else(|| panic!("missing {part}")),
        );
    }
    let s1 = String::from_utf8(files["ppt/slides/slide1.xml"].clone()).unwrap();
    assert!(s1.contains("rtl=\"1\""));
    assert!(s1.contains("lang=\"ar-SA\""));
    assert!(!files.contains_key("ppt/slides/slide3.xml"));
}

#[test]
fn page_ranges_and_bad_params() {
    let (meta, _) = run(
        corpus("synthetic-word-naskh.pdf"),
        Format::Text,
        json!({"pages": [1]}),
    );
    assert_eq!(meta["pages"], 1);
    let pdf = warraq_pdf::Pdf::open(corpus("synthetic-word-naskh.pdf"), None).unwrap();
    let src = DocSource::borrowed(pdf.document());
    for bad in [
        json!({"pages": [9]}),
        json!({"pages": "x"}),
        json!({"pages": {"from": 5, "to": 7}}),
        json!({"pages": []}),
    ] {
        assert!(export(&src, Format::Docx, &bad, &[]).is_err(), "{bad}");
    }
}

/// Independent readers (python-docx, openpyxl, python-pptx; MIT/BSD, test-only). Skipped when
/// they are not installed.
#[test]
fn python_office_readers_open_our_files() {
    let ok = std::process::Command::new("python3")
        .args(["-c", "import docx, openpyxl, pptx"])
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !ok {
        eprintln!("SKIP: python-docx/openpyxl/python-pptx not installed");
        return;
    }
    let dir = std::env::temp_dir().join(format!("warraq-office-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let table = arabic_table_pdf();
    let (_, d) = run(corpus("chrome-news-amiri.pdf"), Format::Docx, json!({}));
    let (_, x) = run(table.clone(), Format::Xlsx, json!({}));
    let (_, p) = run(corpus("synthetic-word-naskh.pdf"), Format::Pptx, json!({}));
    let (_, t) = run(table, Format::Docx, json!({}));
    std::fs::write(dir.join("a.docx"), d).unwrap();
    std::fs::write(dir.join("t.docx"), t).unwrap();
    std::fs::write(dir.join("a.xlsx"), x).unwrap();
    std::fs::write(dir.join("a.pptx"), p).unwrap();
    let script = r#"
import sys, docx, openpyxl, pptx
d = sys.argv[1]
doc = docx.Document(d + '/a.docx')
text = '\n'.join(p.text for p in doc.paragraphs)
assert 'الذكاء' in text or len(text) > 50, text
t = docx.Document(d + '/t.docx')
tbl = t.tables[0]
assert tbl.cell(0, 0).text == 'البند', tbl.cell(0, 0).text
wb = openpyxl.load_workbook(d + '/a.xlsx')
ws = wb.worksheets[0]
assert ws.sheet_view.rightToLeft
assert ws['A1'].value == 'البند', ws['A1'].value
assert ws['C3'].value == 1500, ws['C3'].value
pr = pptx.Presentation(d + '/a.pptx')
assert len(pr.slides) == 2
assert any(s.has_text_frame and s.text_frame.text for s in pr.slides[0].shapes)
print('ok')
"#;
    let out = std::process::Command::new("python3")
        .args(["-c", script, dir.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "python readers failed:\n{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let _ = std::fs::remove_dir_all(&dir);
}
