#![allow(dead_code)]
//! Shared helpers for the accessibility tests.

use std::path::PathBuf;

use warraq_a11y::marked::{analyze, named_props};
use warraq_a11y::pagemap::PageMap;
use warraq_edit::content::parse;
use warraq_edit::page::{load, resources};
use warraq_pdf::Pdf;
use warraq_render::{HayroRenderer, PageRenderer};

pub fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../..")
}

pub fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(root().join("tests/fixtures").join(name)).expect("fixture")
}

pub fn corpus(name: &str) -> Vec<u8> {
    std::fs::read(root().join("tests/corpus/pdf").join(name)).expect("corpus file")
}

/// Every page rendered by hayro (RGBA).
pub fn render_all(bytes: &[u8]) -> Vec<(u32, u32, Vec<u8>)> {
    let r = HayroRenderer::new(bytes.to_vec()).expect("render");
    (0..r.page_count())
        .map(|i| {
            let b = r.render(i, 1.0).expect("page");
            (b.width, b.height, b.rgba)
        })
        .collect()
}

/// Operation byte strings of each page's content, without the marked-content operators the
/// auto-tagger inserts (MCID sequences and artifact sequences with their EMC).
pub fn ops_without_tags(pdf: &Pdf, index: usize, drop_inserted: bool) -> Vec<Vec<u8>> {
    let pc = load(pdf, index).expect("page");
    let c = parse(&pc.data).expect("parse");
    let res = resources(pdf, pc.page_id);
    let named = named_props(pdf, &res);
    let m = analyze(&c, &named);
    let mut skip = vec![false; c.ops.len()];
    if drop_inserted {
        for (i, op) in c.ops.iter().enumerate() {
            let mk = &m.ops[i];
            if (op.is(b"BDC") || op.is(b"BMC")) && (mk.opens_mcid.is_some() || mk.opens_artifact) {
                skip[i] = true;
                if let Some(e) = mk.mc_match {
                    skip[e] = true;
                }
            }
        }
    }
    c.ops
        .iter()
        .enumerate()
        .filter(|(i, _)| !skip[*i])
        .map(|(_, op)| pc.data[op.span.clone()].to_vec())
        .collect()
}

/// Visible drawing operations of a page that are neither in an MCID sequence nor an artifact.
pub fn untagged_ops(pdf: &Pdf, index: usize) -> Vec<String> {
    let pm = PageMap::build(pdf, index, None).expect("page map");
    let mut out = Vec::new();
    let show_at = pm.show_at();
    for (i, op) in pm.scan.content.ops.iter().enumerate() {
        let show = show_at[i];
        if !warraq_a11y::pagemap::draws(&pm, i, show) {
            continue;
        }
        let m = &pm.marks.ops[i];
        if m.mcid.is_none() && !m.artifact {
            out.push(String::from_utf8_lossy(&pm.pc.data[op.span.clone()]).into_owned());
        }
    }
    out
}

/// Text without white space (for order comparisons).
pub fn squash(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}
