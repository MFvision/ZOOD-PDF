//! Fuzz the text interpreter + layout with arbitrary content-stream bytes.
#![no_main]

use libfuzzer_sys::fuzz_target;
use lopdf::{dictionary, Document, Object, Stream};
use warraq_text::interp::Interpreter;
use warraq_text::layout::{layout_page, LayoutOptions};
use warraq_text::LopdfSource;

fuzz_target!(|data: &[u8]| {
    let mut doc = Document::with_version("1.7");
    let f1 = doc.add_object(dictionary! {"Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica"});
    let tu = doc.add_object(Stream::new(
        dictionary! {},
        b"1 begincodespacerange <0000> <FFFF> endcodespacerange 1 beginbfrange <0000> <FFFF> <0600> endbfrange".to_vec(),
    ));
    let desc = doc.add_object(dictionary! {"Subtype" => "CIDFontType2"});
    let f2 = doc.add_object(dictionary! {
        "Type" => "Font", "Subtype" => "Type0", "Encoding" => "Identity-H",
        "DescendantFonts" => vec![Object::Reference(desc)], "ToUnicode" => tu,
    });
    let form_id = doc.new_object_id();
    let res = dictionary! {"Font" => dictionary! {"F1" => f1, "F2" => f2}, "XObject" => dictionary! {"X1" => form_id}};
    // The form draws the same fuzzed bytes (bounded recursion + cycle detection).
    let form = Stream::new(dictionary! {"Subtype" => "Form", "Resources" => res.clone()}, data.to_vec());
    doc.objects.insert(form_id, Object::Stream(form));
    let src = LopdfSource::from_document(doc);
    let mut it = Interpreter::new(&src);
    let glyphs = it.run_content(data, &res);
    let page = layout_page(0, glyphs, [0.0, 0.0, 612.0, 792.0], &LayoutOptions { glyphs: true, ..Default::default() });
    let _ = warraq_text::search(std::slice::from_ref(&page), "ال");
});
