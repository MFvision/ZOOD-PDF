//! Hostile structure trees and content: cycles, shared elements, very deep nesting, huge kid
//! arrays, RoleMap loops, nonsense MCIDs, unbalanced marked content. Everything returns a value
//! or an error in bounded time; nothing panics; truncated trees are never written back.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

mod common;

use std::time::{Duration, Instant};

use common::*;
use lopdf::{dictionary, Document, Object, ObjectId, Stream};
use warraq_a11y::autotag::{autotag, Options};
use warraq_a11y::check::{check, fix};
use warraq_a11y::structure::list;
use warraq_a11y::tree::{Tree, MAX_DEPTH};
use warraq_a11y::{edit, A11yError};
use warraq_pdf::Pdf;

/// A one-page document whose catalog gets `extra` entries; `build` adds objects and returns the
/// StructTreeRoot dictionary.
fn doc(
    content: &[u8],
    build: impl FnOnce(&mut Document, ObjectId) -> lopdf::Dictionary,
) -> Vec<u8> {
    let mut d = Document::with_version("1.7");
    let pages_id = d.new_object_id();
    let font = d.add_object(dictionary! {
        "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica",
    });
    let cs = d.add_object(Stream::new(dictionary! {}, content.to_vec()));
    let page = d.add_object(dictionary! {
        "Type" => "Page", "Parent" => pages_id,
        "MediaBox" => vec![0.into(), 0.into(), 300.into(), 300.into()],
        "Resources" => dictionary! { "Font" => dictionary! { "F1" => font } },
        "Contents" => cs,
        "StructParents" => 0,
    });
    d.objects.insert(
        pages_id,
        Object::Dictionary(
            dictionary! { "Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1 },
        ),
    );
    let root = build(&mut d, page);
    let root_id = d.add_object(root);
    let cat = d.add_object(dictionary! {
        "Type" => "Catalog", "Pages" => pages_id, "StructTreeRoot" => root_id,
        "MarkInfo" => dictionary! { "Marked" => true },
    });
    d.trailer.set("Root", cat);
    let mut out = Vec::new();
    d.save_to(&mut out).unwrap();
    out
}

const TEXT: &[u8] = b"/P <</MCID 0>> BDC BT /F1 12 Tf 20 200 Td (Hello) Tj ET EMC BT /F1 12 Tf 20 100 Td (World) Tj ET";

fn exercise(bytes: Vec<u8>) -> Duration {
    let t = Instant::now();
    let Ok(pdf) = Pdf::open(bytes.clone(), None) else {
        return t.elapsed();
    };
    let tree = Tree::read(&pdf);
    assert!(tree.elems.len() <= warraq_a11y::tree::MAX_ELEMS);
    let _ = list(&pdf);
    let _ = check(&pdf);
    let mut p2 = Pdf::open(bytes.clone(), None).unwrap();
    let _ = autotag(&mut p2, &Options::default());
    let mut p3 = Pdf::open(bytes.clone(), None).unwrap();
    let _ = fix(&mut p3, &[], Some("t"));
    let mut p4 = Pdf::open(bytes, None).unwrap();
    if let Some(id) = list(&p4)
        .ok()
        .and_then(|l| l.elements.iter().find_map(|e| e.id))
    {
        let _ = edit::move_to(&mut p4, id, 0);
        let _ = edit::merge_next(&mut p4, id);
        let _ = edit::split(&mut p4, id, None);
        let _ = edit::decorative(&mut p4, id);
    }
    t.elapsed()
}

#[test]
fn cycles_and_shared_elements() {
    let bytes = doc(TEXT, |d, page| {
        let a = d.new_object_id();
        let b = d.new_object_id();
        d.objects.insert(a, Object::Dictionary(dictionary! { "S" => "P", "Pg" => page, "K" => vec![Object::Integer(0), b.into(), a.into()] }));
        d.objects.insert(
            b,
            Object::Dictionary(dictionary! { "S" => "Span", "K" => vec![a.into(), b.into()] }),
        );
        dictionary! { "Type" => "StructTreeRoot", "K" => vec![a.into(), a.into(), b.into()] }
    });
    let pdf = Pdf::open(bytes.clone(), None).unwrap();
    let t = Tree::read(&pdf);
    assert_eq!(t.elems.len(), 2, "each element read once");
    let l = list(&pdf).unwrap();
    assert!(l.elements.len() <= 2);
    assert!(exercise(bytes) < Duration::from_secs(20));
}

#[test]
fn very_deep_nesting_is_truncated_and_never_rewritten() {
    let bytes = doc(TEXT, |d, page| {
        let n = 5_000;
        let ids: Vec<ObjectId> = (0..n).map(|_| d.new_object_id()).collect();
        for (i, id) in ids.iter().enumerate() {
            let k: Object = match ids.get(i + 1) {
                Some(next) => (*next).into(),
                None => Object::Integer(0),
            };
            d.objects.insert(
                *id,
                Object::Dictionary(dictionary! { "S" => "Div", "Pg" => page, "K" => k }),
            );
        }
        dictionary! { "Type" => "StructTreeRoot", "K" => ids[0] }
    });
    let pdf = Pdf::open(bytes.clone(), None).unwrap();
    let t = Tree::read(&pdf);
    assert!(t.truncated);
    assert!(t.elems.len() <= MAX_DEPTH + 1);
    let mut p = Pdf::open(bytes.clone(), None).unwrap();
    assert!(matches!(
        autotag(&mut p, &Options::default()),
        Err(A11yError::Limit(_))
    ));
    let id = list(&p).unwrap().elements[0].id.unwrap();
    assert!(matches!(
        edit::set_type(&mut p, id, "P"),
        Err(A11yError::Limit(_))
    ));
    assert!(exercise(bytes) < Duration::from_secs(20));
}

#[test]
fn huge_kid_arrays_and_nonsense_kids() {
    let bytes = doc(TEXT, |d, page| {
        let mut kids: Vec<Object> = Vec::new();
        for i in 0..150_000i64 {
            kids.push(Object::Integer(i));
        }
        kids.push(Object::Integer(-5));
        kids.push(Object::Integer(i64::MAX));
        kids.push(Object::string_literal("junk"));
        kids.push(Object::Dictionary(
            dictionary! { "Type" => "MCR", "MCID" => -1 },
        ));
        kids.push(Object::Dictionary(
            dictionary! { "Type" => "OBJR", "Obj" => 12345 },
        ));
        let p = d.add_object(dictionary! { "S" => "P", "Pg" => page, "K" => kids });
        dictionary! { "Type" => "StructTreeRoot", "K" => vec![p.into(), Object::Null, Object::Real(1.5)],
        "ParentTree" => dictionary! { "Nums" => vec![Object::Integer(0)] } }
    });
    let pdf = Pdf::open(bytes.clone(), None).unwrap();
    let t = Tree::read(&pdf);
    assert!(t.truncated, "kid arrays beyond the bound are truncated");
    assert!(exercise(bytes) < Duration::from_secs(30));
}

#[test]
fn role_map_loops_and_parent_tree_cycles() {
    let bytes = doc(TEXT, |d, page| {
        let pt_kid = d.new_object_id();
        d.objects.insert(
            pt_kid,
            Object::Dictionary(dictionary! { "Kids" => vec![pt_kid.into()] }),
        );
        let p = d.add_object(dictionary! { "S" => "Loop1", "Pg" => page, "K" => 0 });
        dictionary! {
            "Type" => "StructTreeRoot", "K" => p,
            "RoleMap" => dictionary! { "Loop1" => "Loop2", "Loop2" => "Loop1", "Self" => "Self" },
            "ParentTree" => dictionary! { "Kids" => vec![pt_kid.into(), pt_kid.into()] },
        }
    });
    let pdf = Pdf::open(bytes.clone(), None).unwrap();
    let t = Tree::read(&pdf);
    assert!(!t.is_standard("Loop1"));
    let r = check(&pdf).unwrap();
    assert!(r.counts.contains_key("role-map"));
    assert!(exercise(bytes) < Duration::from_secs(20));
}

#[test]
fn unbalanced_marked_content_is_left_alone() {
    let content = b"EMC EMC /P <</MCID 99999999999>> BDC BT /F1 12 Tf 20 200 Td (Hi) Tj /Span BDC ET BT (Lo) Tj EMC q q q BDC";
    let bytes = doc(content, |_, _| dictionary! { "Type" => "StructTreeRoot" });
    assert!(exercise(bytes.clone()) < Duration::from_secs(20));
    let mut p = Pdf::open(bytes, None).unwrap();
    // Tagging succeeds; content it cannot wrap safely stays as it is (the checker reports it).
    let _ = autotag(&mut p, &Options::default()).unwrap();
    let out = p.commit().unwrap();
    let _ = check(&Pdf::open(out, None).unwrap()).unwrap();
}

#[test]
fn mutated_tagged_files_never_panic() {
    let base = {
        let mut p = Pdf::open(fixture("a11y-ar.pdf"), None).unwrap();
        autotag(&mut p, &Options::default()).unwrap();
        p.commit().unwrap()
    };
    let cases: usize = std::env::var("WARRAQ_A11Y_SMOKE_CASES")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(60);
    let mut seed: u64 = 0x5eed_a11a;
    let tail_start = fixture("a11y-ar.pdf").len();
    for case in 0..cases {
        let mut b = base.clone();
        // Mutate the appended structure (the incremental update) mostly, sometimes anywhere.
        for _ in 0..(1 + case % 8) {
            seed = seed
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            let span = if case % 3 == 0 {
                b.len()
            } else {
                b.len() - tail_start
            };
            let off = if case % 3 == 0 { 0 } else { tail_start };
            let pos = off + (seed >> 33) as usize % span.max(1);
            let v = (seed >> 13) as u8;
            if let Some(x) = b.get_mut(pos) {
                *x = match case % 4 {
                    0 => v,
                    1 => b'0' + v % 10,
                    2 => b"[]<>/()R "[usize::from(v) % 9],
                    _ => x.wrapping_add(1),
                };
            }
        }
        let t = exercise(b);
        assert!(t < Duration::from_secs(30), "case {case} took {t:?}");
    }
}
