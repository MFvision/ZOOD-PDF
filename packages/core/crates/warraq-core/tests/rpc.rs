#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use serde_json::{json, Value};
use warraq_core::warraq_pdf::builder::{sample_pdf, SampleOptions};
use warraq_core::warraq_pdf::lopdf::{Document as LoDoc, Object};
use warraq_core::{call_static, registry, CoreError, Document, Reply};

fn sample(n: usize) -> Vec<u8> {
    sample_pdf(
        n,
        &SampleOptions {
            with_annotation: true,
            title: Some("Report".into()),
            ..Default::default()
        },
    )
    .unwrap()
}

fn call(doc: &mut Document, m: &str, p: Value) -> Reply {
    doc.call(m, &p, vec![])
        .unwrap_or_else(|e| panic!("{m}: {e}"))
}

fn err(doc: &mut Document, m: &str, p: Value) -> CoreError {
    doc.call(m, &p, vec![]).unwrap_err()
}

#[test]
fn info_reports_everything() {
    let mut d = Document::open(sample(3), None).unwrap();
    let r = call(&mut d, "doc.info", json!({}));
    let j = &r.json;
    assert_eq!(j["pageCount"], 3);
    assert_eq!(j["pages"][0]["width"], 595.0);
    assert_eq!(j["pages"][0]["rotation"], 0);
    assert_eq!(j["encrypted"], false);
    assert_eq!(j["permissions"]["modify"], true);
    assert_eq!(j["version"], "1.4");
    assert_eq!(j["revisions"], 1);
    assert_eq!(j["hasSignatures"], false);
    assert_eq!(j["title"], "Report");
    assert!(j["passwordMatched"].is_null());
}

#[test]
fn errors_are_code_and_message() {
    let e = Document::open(b"hello".to_vec(), None).unwrap_err();
    assert_eq!(e.code, "parse_error");
    assert_eq!(e.to_json()["code"], "parse_error");
    let mut d = Document::open(sample(1), None).unwrap();
    assert_eq!(err(&mut d, "no.such", json!({})).code, "unknown_method");
    assert_eq!(
        err(&mut d, "pages.rotate", json!({"pages": "x"})).code,
        "invalid_params"
    );
    assert_eq!(
        err(&mut d, "pages.rotate", json!({"pages": [5], "degrees": 90})).code,
        "invalid_argument"
    );
    assert_eq!(
        err(
            &mut d,
            "pages.rotate",
            json!({"pages": [0], "degrees": 90, "extra": 1})
        )
        .code,
        "invalid_params"
    );
    assert_eq!(
        call_static("pdf.nope", &json!({}), vec![])
            .unwrap_err()
            .code,
        "unknown_method"
    );
}

#[test]
fn page_methods_append_incremental_updates() {
    let orig = sample(4);
    let mut d = Document::open(orig.clone(), None).unwrap();
    let r = call(&mut d, "pages.rotate", json!({"pages": [0], "degrees": 90}));
    assert_eq!(&r.blobs[0][..orig.len()], &orig[..]);
    assert_eq!(r.json["revisions"], 2);
    let r = call(&mut d, "pages.move", json!({"order": [3, 2, 1, 0]}));
    let r2 = call(&mut d, "pages.move", json!({"pages": [0], "to": 3}));
    assert_eq!(&r2.blobs[0][..r.blobs[0].len()], &r.blobs[0][..]);
    call(&mut d, "pages.delete", json!({"pages": [1]}));
    let r = call(
        &mut d,
        "pages.insertBlank",
        json!({"at": 0, "width": 300, "height": 300}),
    );
    assert_eq!(r.json["pageCount"], 4);
    call(&mut d, "pages.insertBlank", json!({"at": 4}));
    call(
        &mut d,
        "pages.crop",
        json!({"pages": [1], "box": [0, 0, 100, 100]}),
    );
    let other = sample(2);
    let r = d
        .call(
            "pages.insertFrom",
            &json!({"at": 1, "pages": [1]}),
            vec![other],
        )
        .unwrap();
    assert_eq!(r.json["pageCount"], 6);
    let info = call(&mut d, "doc.info", json!({}));
    assert_eq!(info.json["pages"][0]["width"], 300.0);
    assert_eq!(info.json["pages"][2]["width"], 100.0);
    let ex = call(&mut d, "pages.extract", json!({"pages": [1, 2]}));
    let e = Document::open(ex.blobs[0].clone(), None).unwrap();
    assert!(!e.pdf().objects().is_empty());
    let mut e = e;
    assert_eq!(call(&mut e, "doc.info", json!({})).json["pageCount"], 2);
    // Everything saved so far is still a prefix of the final file.
    let fin = call(&mut d, "doc.save", json!({})).blobs.remove(0);
    assert_eq!(&fin[..orig.len()], &orig[..]);
    assert!(LoDoc::load_mem(&fin).is_ok());
}

#[test]
fn metadata_get_set_and_revisions() {
    let orig = sample(1);
    let mut d = Document::open(orig.clone(), None).unwrap();
    let r = call(
        &mut d,
        "doc.metadata.set",
        json!({"info": {"Title": "دليل المستخدم", "Author": null}, "syncXmp": true}),
    );
    assert_eq!(r.json["info"]["Title"], "دليل المستخدم");
    let g = call(&mut d, "doc.metadata.get", json!({}));
    assert_eq!(g.json["info"]["Title"], "دليل المستخدم");
    assert!(g.json["xmp"].as_str().unwrap().contains("دليل المستخدم"));
    let revs = call(&mut d, "doc.revisions", json!({}));
    assert_eq!(revs.json["revisions"].as_array().unwrap().len(), 2);
    let first = call(&mut d, "doc.revisions", json!({"extract": 0}));
    assert_eq!(first.blobs[0], orig);
    assert_eq!(
        err(&mut d, "doc.metadata.set", json!({})).code,
        "invalid_params"
    );
}

#[test]
fn rebase_through_rpc() {
    let orig = sample(2);
    let mut d = Document::open(orig.clone(), None).unwrap();
    let mut lo = LoDoc::load_mem(&orig).unwrap();
    let page = lo.page_iter().next().unwrap();
    let annot = lo
        .get_dictionary(page)
        .unwrap()
        .get(b"Annots")
        .unwrap()
        .as_array()
        .unwrap()[0]
        .as_reference()
        .unwrap();
    lo.get_dictionary_mut(annot)
        .unwrap()
        .set("Contents", Object::string_literal("changed in viewer"));
    let mut edited = Vec::new();
    lo.save_to(&mut edited).unwrap();
    let r = d.call("doc.rebase", &json!({}), vec![edited]).unwrap();
    assert_eq!(r.json["mode"], "incremental");
    assert_eq!(r.json["changed"], json!([[annot.0, annot.1]]));
    assert_eq!(&r.blobs[0][..orig.len()], &orig[..]);
    assert_eq!(call(&mut d, "doc.info", json!({})).json["revisions"], 2);
    assert_eq!(
        d.call("doc.rebase", &json!({}), vec![]).unwrap_err().code,
        "invalid_params"
    );
}

#[test]
fn protect_set_keep_on_update_and_remove() {
    let orig = sample(2);
    let mut d = Document::open(orig, None).unwrap();
    let r = call(
        &mut d,
        "protect.set",
        json!({"userPassword": "افتح", "ownerPassword": "مالك", "permissions": {"modify": false, "copy": false, "assemble": false}}),
    );
    let enc = r.blobs[0].clone();
    assert_eq!(r.json["permissions"]["copy"], false);
    let s = call_static("pdf.isEncrypted", &json!({}), vec![enc.clone()]).unwrap();
    assert_eq!(s.json, json!({"encrypted": true, "needsPassword": true}));
    assert_eq!(
        Document::open(enc.clone(), None).unwrap_err().code,
        "password_required"
    );
    assert_eq!(
        Document::open(enc.clone(), Some("x")).unwrap_err().code,
        "wrong_password"
    );

    // User password: restricted; cannot remove protection without the owner password.
    let mut u = Document::open(enc.clone(), Some("افتح")).unwrap();
    let info = call(&mut u, "doc.info", json!({}));
    assert_eq!(info.json["passwordMatched"], "user");
    assert_eq!(info.json["encryption"]["method"], "AES-256");
    assert_eq!(info.json["permissions"]["modify"], false);
    assert_eq!(
        err(&mut u, "pages.rotate", json!({"pages": [0], "degrees": 90})).code,
        "permission_denied"
    );
    assert_eq!(
        err(&mut u, "protect.remove", json!({})).code,
        "permission_denied"
    );

    // Owner session (the one that set it) keeps protection on appended updates.
    let r = call(&mut d, "pages.rotate", json!({"pages": [0], "degrees": 90}));
    assert_eq!(&r.blobs[0][..enc.len()], &enc[..]);
    let mut u2 = Document::open(r.blobs[0].clone(), Some("افتح")).unwrap();
    assert_eq!(
        call(&mut u2, "doc.info", json!({})).json["pages"][0]["rotation"],
        90
    );

    let r = u
        .call("protect.remove", &json!({"ownerPassword": "مالك"}), vec![])
        .unwrap();
    let mut c = Document::open(r.blobs[0].clone(), None).unwrap();
    assert_eq!(call(&mut c, "doc.info", json!({})).json["encrypted"], false);
    assert_eq!(
        err(&mut c, "protect.remove", json!({})).code,
        "not_encrypted"
    );
}

#[test]
fn static_merge_and_method_list() {
    let r = call_static("pdf.merge", &json!({}), vec![sample(2), sample(3)]).unwrap();
    assert_eq!(r.json["pageCount"], 5);
    assert_eq!(
        call_static("pdf.merge", &json!({}), vec![sample(1)])
            .unwrap_err()
            .code,
        "invalid_params"
    );
    let l = call_static("methods.list", &json!(null), vec![]).unwrap();
    let docs: Vec<String> = serde_json::from_value(l.json["document"].clone()).unwrap();
    for m in [
        "doc.info",
        "doc.save",
        "doc.saveFull",
        "doc.rebase",
        "doc.revisions",
        "doc.metadata.get",
        "doc.metadata.set",
        "pages.rotate",
        "pages.move",
        "pages.delete",
        "pages.insertBlank",
        "pages.insertFrom",
        "pages.extract",
        "pages.crop",
        "protect.set",
        "protect.remove",
    ] {
        assert!(docs.iter().any(|d| d == m), "{m} not registered");
    }
    assert_eq!(
        registry().static_names(),
        vec!["methods.list", "pdf.isEncrypted", "pdf.merge"]
    );
}

#[test]
fn save_full_drops_history() {
    let mut d = Document::open(sample(2), None).unwrap();
    call(&mut d, "pages.rotate", json!({"pages": [0], "degrees": 90}));
    let r = call(&mut d, "doc.saveFull", json!({}));
    assert!(!r.blobs[0].is_empty());
    assert_eq!(call(&mut d, "doc.info", json!({})).json["revisions"], 1);
    assert_eq!(
        call(&mut d, "doc.info", json!({})).json["pages"][0]["rotation"],
        90
    );
}

#[test]
fn guarded_turns_panics_into_errors() {
    let r: Result<(), CoreError> = warraq_core::guarded(|| panic!("boom"));
    assert_eq!(r.unwrap_err().code, "internal_panic");
}

#[cfg(feature = "render")]
#[test]
fn render_png_of_encrypted_document() {
    let mut d = Document::open(sample(1), None).unwrap();
    call(
        &mut d,
        "protect.set",
        json!({"userPassword": "u", "ownerPassword": "o"}),
    );
    let r = call(&mut d, "pages.render", json!({"page": 0, "scale": 0.25}));
    assert_eq!(&r.blobs[0][..8], b"\x89PNG\r\n\x1a\n");
    assert_eq!(r.json["width"], 148);
    assert_eq!(
        err(&mut d, "pages.render", json!({"page": 3})).code,
        "render_error"
    );
}
