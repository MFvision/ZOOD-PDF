//! Shared helpers for warraq-create integration tests.
#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use lopdf::{Document, Object};
use serde_json::json;
use warraq_create::model::{
    Align, Block, Content, Dir, Document as Model, Family, PageSetup, ParaStyle, Paragraph, Run,
    Section, Style,
};
use warraq_create::{create, CreateOptions, FileSpec};
use warraq_text::{call, LopdfSource};

pub fn opts() -> CreateOptions {
    CreateOptions {
        merge: true,
        ..CreateOptions::default()
    }
}

pub fn one(files: &[(&str, &[u8])], o: &CreateOptions) -> Vec<u8> {
    let specs: Vec<(FileSpec, Vec<u8>)> = files
        .iter()
        .map(|(n, b)| {
            (
                FileSpec {
                    name: (*n).into(),
                    kind: None,
                },
                b.to_vec(),
            )
        })
        .collect();
    let mut out = create(&specs, o).unwrap();
    assert_eq!(out.len(), 1);
    out.remove(0).bytes
}

pub fn plain_text(pdf: &[u8]) -> String {
    let src = LopdfSource::open(pdf, None).unwrap();
    let r = call(&src, "text.plain", &json!({})).unwrap().unwrap();
    r["text"].as_str().unwrap().to_string()
}

pub fn words(s: &str) -> Vec<String> {
    s.split_whitespace().map(str::to_string).collect()
}

pub fn page_count(pdf: &[u8]) -> usize {
    Document::load_mem(pdf).unwrap().get_pages().len()
}

pub fn all_content(pdf: &[u8]) -> String {
    let d = Document::load_mem(pdf).unwrap();
    let mut s = String::new();
    for (_, id) in d.get_pages() {
        s.push_str(&String::from_utf8_lossy(&d.get_page_content(id)));
    }
    s
}

/// (BaseFont, decoded FontFile2 length) of every embedded font.
pub fn embedded_fonts(pdf: &[u8]) -> Vec<(String, usize)> {
    let d = Document::load_mem(pdf).unwrap();
    let mut out = Vec::new();
    for (_, o) in d.objects.iter() {
        if let Object::Dictionary(fd) = o {
            if fd.get(b"Type").and_then(|t| t.as_name()).ok() == Some(b"FontDescriptor") {
                let name = String::from_utf8_lossy(fd.get(b"FontName").unwrap().as_name().unwrap()).into_owned();
                let ff = fd.get(b"FontFile2").unwrap().as_reference().unwrap();
                let st = d.get_object(ff).unwrap().as_stream().unwrap();
                let len = st.decompressed_content().unwrap().len();
                out.push((name, len));
            }
        }
    }
    out
}

/// Invariants of every created PDF: lopdf reloads it, no `/Direction`, tagged, fonts subset.
pub fn assert_pdf_invariants(pdf: &[u8]) {
    let raw = String::from_utf8_lossy(pdf);
    assert!(!raw.contains("/Direction"), "never write /Direction");
    let d = Document::load_mem(pdf).unwrap();
    let cat = d.catalog().unwrap();
    assert!(cat.get(b"StructTreeRoot").is_ok(), "tagged");
    assert!(cat.get(b"MarkInfo").is_ok());
    assert!(cat.get(b"Lang").is_ok());
    let content = all_content(pdf);
    assert!(!content.contains("/Direction"));
    assert!(content.contains("/MCID"));
    for (name, _) in embedded_fonts(pdf) {
        assert_eq!(name.as_bytes().get(6), Some(&b'+'), "{name}");
    }
}

pub fn justified_doc(text: &str) -> Model {
    Model {
        sections: vec![Section {
            page: PageSetup::default(),
            content: Content::Flow(vec![Block::Paragraph(Paragraph {
                runs: vec![Run::new(
                    text,
                    Style {
                        family: Family::Serif,
                        size: 14.0,
                        ..Style::default()
                    },
                )],
                style: ParaStyle {
                    align: Align::Justify,
                    dir: Dir::Rtl,
                    ..ParaStyle::default()
                },
            })]),
            page_from_source: false,
        }],
        lang: Some("ar".into()),
        ..Model::default()
    }
}

/// Render page `i` at 1× with hayro.
pub fn render(pdf: &[u8], i: usize) -> warraq_render::Bitmap {
    use warraq_render::PageRenderer;
    warraq_render::HayroRenderer::new(pdf.to_vec())
        .unwrap()
        .render(i, 1.0)
        .unwrap()
}

/// Write PNGs of every page to `$WARRAQ_CREATE_DUMP/<name>-<i>.png` when the variable is set.
pub fn dump(pdf: &[u8], name: &str) {
    let Ok(dir) = std::env::var("WARRAQ_CREATE_DUMP") else {
        return;
    };
    for i in 0..page_count(pdf) {
        let png = render(pdf, i).to_png().unwrap();
        std::fs::write(format!("{dir}/{name}-{i}.png"), png).unwrap();
    }
    std::fs::write(format!("{dir}/{name}.pdf"), pdf).unwrap();
}
