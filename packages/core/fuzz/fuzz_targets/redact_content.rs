//! Fuzz the redaction content rewriter (text, paths, inline images, forms, hidden layers,
//! hidden text) and the PII patterns with arbitrary bytes.
#![no_main]

use libfuzzer_sys::fuzz_target;
use lopdf::{dictionary, Document, Object, Stream};
use warraq_redact::content::{HiddenText, Rewriter};
use warraq_redact::patterns::{builtin, scan, Kind};
use warraq_text::geom::{Matrix, Rect};
use warraq_text::LopdfSource;

fuzz_target!(|data: &[u8]| {
    let mut doc = Document::with_version("1.7");
    let f1 = doc.add_object(dictionary! {"Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica"});
    let form_id = doc.new_object_id();
    let res = dictionary! {"Font" => dictionary! {"F1" => f1}, "XObject" => dictionary! {"X" => form_id}};
    doc.objects.insert(
        form_id,
        Object::Stream(Stream::new(dictionary! {"Subtype" => "Form", "Resources" => res.clone()}, data.to_vec())),
    );
    let src = LopdfSource::from_document(doc);
    let mut rw = Rewriter::new(&src, 100);
    rw.set_rects(&[Rect::new(0.0, 0.0, 300.0, 300.0)]);
    rw.set_hidden_text(Some(HiddenText { page_box: Rect::new(0.0, 0.0, 612.0, 792.0), min_size: 1.0 }));
    let _ = rw.rewrite(data, &res, Matrix::IDENTITY);
    if let Ok(text) = std::str::from_utf8(data) {
        let (norm, _) = warraq_text::normalize_for_search(text);
        for k in [Kind::Email, Kind::Phone, Kind::SaudiId, Kind::Iban, Kind::Card, Kind::Date] {
            if let Ok(p) = builtin(k) {
                let _ = scan(&norm, &p, 1000);
            }
        }
    }
});
