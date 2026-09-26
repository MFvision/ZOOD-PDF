//! Fuzz Page marks: arbitrary bytes as a page's content stream (pagination artifacts, Acrobat
//! compound forms, our own marks) through listing, foreign-mark removal and adding a mark; and as
//! a whole file through `marks.list`. Must never panic.
#![no_main]

use libfuzzer_sys::fuzz_target;
use lopdf::{dictionary, Document, Object, Stream};
use serde_json::{json, Value};
use warraq_marks::api;
use warraq_pdf::Pdf;

fn doc(content: &[u8]) -> Option<Vec<u8>> {
    let mut d = Document::with_version("1.7");
    let pages_id = d.new_object_id();
    let fm = d.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject", "Subtype" => "Form", "BBox" => vec![0.into(), 0.into(), 10.into(), 10.into()],
            "PieceInfo" => dictionary! { "ADBE_CompoundType" => dictionary! { "Private" => "Watermark" } },
        },
        b"0 0 1 1 re f".to_vec(),
    ));
    let c = d.add_object(Stream::new(dictionary! {}, content.to_vec()));
    let pg = d.add_object(dictionary! {
        "Type" => "Page", "Parent" => pages_id, "MediaBox" => vec![0.into(), 0.into(), 200.into(), 200.into()],
        "Contents" => c,
        "Resources" => dictionary! { "XObject" => dictionary! {"Fm0" => fm} },
    });
    d.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {"Type" => "Pages", "Kids" => vec![pg.into()], "Count" => 1}),
    );
    let cat = d.add_object(dictionary! {"Type" => "Catalog", "Pages" => pages_id});
    d.trailer.set("Root", cat);
    let mut out = Vec::new();
    d.save_to(&mut out).ok()?;
    Some(out)
}

fuzz_target!(|data: &[u8]| {
    if let Some(bytes) = doc(data) {
        if let Ok(mut pdf) = Pdf::open(bytes, None) {
            let _ = api::call(&mut pdf, "marks.list", &Value::Null, &[]);
            let _ = api::call(&mut pdf, "marks.remove", &json!({ "id": "foreign:watermark" }), &[]);
            let _ = api::call(&mut pdf, "marks.add", &json!({ "mark": { "kind": "pageNumber" } }), &[]);
            let _ = api::call(&mut pdf, "marks.list", &Value::Null, &[]);
        }
    }
    if let Ok(mut pdf) = Pdf::open(data.to_vec(), None) {
        let _ = api::call(&mut pdf, "marks.list", &Value::Null, &[]);
    }
});
