//! Fuzz the ruling-line reader, table detection and every export writer with arbitrary
//! content-stream bytes on one page (warraq-office).
#![no_main]

use libfuzzer_sys::fuzz_target;
use lopdf::{dictionary, Document, Object, Stream};
use warraq_office::{export, Format};
use warraq_text::LopdfSource;

fuzz_target!(|data: &[u8]| {
    let mut doc = Document::with_version("1.7");
    let f1 = doc.add_object(dictionary! {"Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica"});
    let form_id = doc.new_object_id();
    let res = dictionary! {"Font" => dictionary! {"F1" => f1}, "XObject" => dictionary! {"X1" => form_id}};
    let form = Stream::new(dictionary! {"Subtype" => "Form", "Resources" => res.clone()}, data.to_vec());
    doc.objects.insert(form_id, Object::Stream(form));
    let contents = doc.add_object(Stream::new(dictionary! {}, data.to_vec()));
    let pages_id = doc.new_object_id();
    let page = doc.add_object(dictionary! {
        "Type" => "Page", "Parent" => pages_id, "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
        "Resources" => res, "Contents" => contents,
    });
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {"Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1}),
    );
    let catalog = doc.add_object(dictionary! {"Type" => "Catalog", "Pages" => pages_id});
    doc.trailer.set("Root", catalog);
    let src = LopdfSource::from_document(doc);
    let _ = warraq_office::rules::page_segments(&src, 0);
    for f in [Format::Docx, Format::Xlsx, Format::Pptx, Format::Html, Format::Markdown, Format::Text] {
        let _ = export(&src, f, &serde_json::Value::Null, &[]);
    }
});
