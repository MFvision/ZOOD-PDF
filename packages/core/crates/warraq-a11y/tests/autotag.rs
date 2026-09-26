//! Auto-tagging proofs: an untagged Chromium-made Arabic + English file becomes a tagged PDF whose
//! structure (headings, paragraphs, list, table, figure, link, per-span language) reads in logical
//! order, every drawn glyph is in an MCID or an artifact, pages render to identical pixels, and
//! every original content operator is byte-identical (only marked-content operators are added).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

mod common;

use common::*;
use warraq_a11y::autotag::{autotag, Options};
use warraq_a11y::structure::{list, Item};
use warraq_pdf::Pdf;
use warraq_text::{extract_pages, DocSource, LayoutOptions};

fn tag(bytes: &[u8], opts: &Options) -> (Vec<u8>, warraq_a11y::autotag::Report) {
    let mut pdf = Pdf::open(bytes.to_vec(), None).unwrap();
    let report = autotag(&mut pdf, opts).unwrap();
    let out = pdf.commit().unwrap();
    assert!(out.starts_with(bytes), "incremental update: original bytes are a prefix");
    (out, report)
}

fn by_role<'a>(items: &'a [Item], role: &str) -> Vec<&'a Item> {
    items.iter().filter(|e| e.role == role).collect()
}

/// Logical-order text of the document without artifacts (headers/footers).
fn logical_text(pdf: &Pdf) -> String {
    let src = DocSource::borrowed(pdf.document());
    let n = warraq_pdf::pages::count(pdf).unwrap();
    let pages: Vec<usize> = (0..n).collect();
    let opts = LayoutOptions {
        glyphs: false,
        include_hidden: true,
        include_artifacts: false,
    };
    extract_pages(&src, &pages, &opts)
        .unwrap()
        .iter()
        .flat_map(|p| p.paragraphs().map(|x| x.text.clone()).collect::<Vec<_>>())
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn untagged_chromium_arabic_file_is_tagged_in_logical_order() {
    let original = fixture("a11y-ar.pdf");
    assert!(!String::from_utf8_lossy(&original).contains("StructTreeRoot"));
    let (out, report) = tag(
        &original,
        &Options {
            title: Some("تقرير إمكانية الوصول".into()),
            ..Options::default()
        },
    );
    assert_eq!(report.pages, 2);
    assert_eq!(report.lang.as_deref(), Some("ar"));
    assert!(report.skipped_pages.is_empty());

    let pdf = Pdf::open(out.clone(), None).unwrap();
    let l = list(&pdf).unwrap();
    assert!(l.tagged && l.marked);
    assert_eq!(l.lang.as_deref(), Some("ar"));
    assert_eq!(l.title.as_deref(), Some("تقرير إمكانية الوصول"));
    assert!(l.display_doc_title);
    let els = &l.elements;
    let roles: Vec<&str> = els.iter().map(|e| e.role.as_str()).collect();
    println!("{roles:?}");
    for e in els {
        println!("{}{} {:?} {:?}", "  ".repeat(e.depth), e.role, e.lang, e.text);
    }
    assert_eq!(els[0].role, "Document");

    // Headings by relative size: H1 then H2 on page 1, H2 on page 2.
    let h1 = by_role(els, "H1");
    assert_eq!(h1.len(), 1);
    assert_eq!(h1[0].text, "تقرير إمكانية الوصول");
    let h2: Vec<&str> = by_role(els, "H2").iter().map(|e| e.text.as_str()).collect();
    assert_eq!(h2, vec!["مقدمة", "الخلاصة"]);

    // Paragraphs; the English one carries /Lang en; «PDF» inside Arabic is a Span with /Lang en.
    let ps = by_role(els, "P");
    let en = ps
        .iter()
        .find(|p| p.text.starts_with("This paragraph"))
        .expect("English paragraph");
    assert_eq!(en.lang.as_deref(), Some("en"));
    let mixed = ps
        .iter()
        .find(|p| p.text.starts_with("يشرح"))
        .expect("mixed paragraph");
    assert_eq!(mixed.lang, None, "Arabic paragraph inherits the document language");
    assert_eq!(
        squash(&mixed.text),
        squash("يشرح هذا المستند كيف يقرأ قارئ الشاشة ملف PDF بترتيب صحيح.")
    );
    let spans = by_role(els, "Span");
    assert!(
        spans.iter().any(|s| s.text == "PDF" && s.lang.as_deref() == Some("en")),
        "per-span language"
    );

    // List with Arabic-Indic labels: L > LI > (Lbl, LBody), three items; a bulleted list on page 2.
    let lists = by_role(els, "L");
    assert_eq!(lists.len(), 2);
    let lis = by_role(els, "LI");
    assert_eq!(lis.len(), 5);
    let lbls: Vec<&str> = by_role(els, "Lbl").iter().map(|e| e.text.as_str()).collect();
    assert_eq!(lbls, vec!["١.", "٢.", "٣.", "•", "•"]);
    assert_eq!(by_role(els, "LBody")[0].text, "البند الأول في القائمة");

    // Table: TR × 3, TH with /Scope in the first row, TD below, cells in logical (right-to-left) order.
    assert_eq!(by_role(els, "Table").len(), 1);
    assert_eq!(by_role(els, "TR").len(), 3);
    let th: Vec<&str> = by_role(els, "TH").iter().map(|e| e.text.as_str()).collect();
    assert_eq!(th, vec!["المدينة", "السكان"]);
    let td: Vec<&str> = by_role(els, "TD").iter().map(|e| e.text.as_str()).collect();
    assert_eq!(td, vec!["الرياض", "٧٠٠٠", "جدة", "٤٠٠٠"]);
    let raw = String::from_utf8_lossy(&out);
    assert!(raw.contains("/Scope /Column"));

    // Figure with a box, no alt yet; link with its words and an OBJR.
    let figs = by_role(els, "Figure");
    assert_eq!(figs.len(), 1);
    assert!(figs[0].bbox.is_some());
    assert!(figs[0].alt.is_none());
    assert!(raw.contains("/BBox"));
    let links = by_role(els, "Link");
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].text, "موقع المثال");
    assert_eq!(links[0].annotations, 1);
    assert!(raw.contains("/StructParent "));
    assert!(raw.contains("/Tabs /S"));

    // The running footer is an artifact, not structure.
    assert!(!els.iter().any(|e| e.text.contains("زود PDF")));
    for p in 0..2 {
        let data = warraq_edit::page::load(&pdf, p).unwrap().data;
        let text = String::from_utf8_lossy(&data);
        assert!(text.contains("/Artifact <</Type /Pagination /Subtype /Footer>> BDC"), "page {p}");
    }

    // Every drawn glyph, picture and path is in an MCID sequence or an artifact.
    for p in 0..2 {
        let u = untagged_ops(&pdf, p);
        assert!(u.is_empty(), "page {p}: untagged content {u:?}");
    }

    // Structure order = logical reading order.
    let tops: Vec<String> = els
        .iter()
        .filter(|e| e.depth == 1)
        .map(|e| e.text.clone())
        .collect();
    assert_eq!(squash(&tops.join("")), squash(&logical_text(&pdf).replace("تقرير الوصول — زود PDF", "")));

    // Pixels: identical renders.
    assert_eq!(render_all(&original), render_all(&out));

    // Content bytes: every original operator is unchanged; only marked content was added.
    let before = Pdf::open(original.clone(), None).unwrap();
    for p in 0..2 {
        assert_eq!(
            ops_without_tags(&before, p, true),
            ops_without_tags(&pdf, p, true),
            "page {p}"
        );
    }
}

#[test]
fn retag_keeps_pixels_on_chromium_tagged_corpus() {
    for name in ["chrome-table-cairo.pdf", "chrome-mixed-naskh.pdf", "chrome-lists-cairo.pdf"] {
        let original = corpus(name);
        let (out, report) = tag(
            &original,
            &Options {
                retag: true,
                ..Options::default()
            },
        );
        assert!(report.mcids > 0, "{name}");
        let pdf = Pdf::open(out.clone(), None).unwrap();
        let n = warraq_pdf::pages::count(&pdf).unwrap();
        for p in 0..n {
            let u = untagged_ops(&pdf, p);
            assert!(u.is_empty(), "{name} page {p}: {u:?}");
        }
        assert_eq!(render_all(&original), render_all(&out), "{name}");
        let l = list(&pdf).unwrap();
        assert!(l.tagged && l.marked, "{name}");
        if name.contains("table") {
            assert!(l.elements.iter().any(|e| e.role == "Table"), "{name}");
            assert!(l.elements.iter().any(|e| e.role == "TH"), "{name}");
        }
        if name.contains("lists") {
            assert!(l.elements.iter().any(|e| e.role == "LI"), "{name}");
        }
    }
}

#[test]
fn untagged_corpus_files_keep_pixels_and_get_fully_tagged() {
    for name in [
        "synthetic-word-naskh.pdf",
        "synthetic-libreoffice-naskh.pdf",
        "synthetic-amiri-kerning.pdf",
        "synthetic-simple-fonts.pdf",
    ] {
        let original = corpus(name);
        let (out, _) = tag(&original, &Options::default());
        let pdf = Pdf::open(out.clone(), None).unwrap();
        let n = warraq_pdf::pages::count(&pdf).unwrap();
        for p in 0..n {
            let u = untagged_ops(&pdf, p);
            assert!(u.is_empty(), "{name} page {p}: {u:?}");
        }
        assert_eq!(render_all(&original), render_all(&out), "{name}");
        let before = Pdf::open(original.clone(), None).unwrap();
        for p in 0..n {
            assert_eq!(
                ops_without_tags(&before, p, true),
                ops_without_tags(&pdf, p, true),
                "{name} page {p}"
            );
        }
    }
}

#[test]
fn partially_tagged_documents_keep_their_tags() {
    // Tag once, then add untagged content (a new page from another file) and tag again.
    let original = fixture("a11y-ar.pdf");
    let (tagged, _) = tag(&original, &Options::default());
    let first = list(&Pdf::open(tagged.clone(), None).unwrap()).unwrap();
    let mut pdf = Pdf::open(tagged.clone(), None).unwrap();
    let other = Pdf::open(corpus("synthetic-word-naskh.pdf"), None).unwrap();
    warraq_pdf::pages::insert_from(&mut pdf, &other, &[0], 2).unwrap();
    let with_page = pdf.commit().unwrap();
    let (out, report) = tag(&with_page, &Options::default());
    assert!(report.mcids > 0);
    let pdf = Pdf::open(out, None).unwrap();
    let second = list(&pdf).unwrap();
    // The earlier elements are still there, in the same order, with the same ids.
    let ids = |l: &warraq_a11y::structure::Listing| -> Vec<Option<u32>> {
        l.elements.iter().map(|e| e.id).collect()
    };
    let a = ids(&first);
    let b = ids(&second);
    assert_eq!(&b[..a.len()], &a[..]);
    assert!(b.len() > a.len());
    for p in 0..3 {
        assert!(untagged_ops(&pdf, p).is_empty(), "page {p}");
    }
}
