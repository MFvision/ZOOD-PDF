//! Prepare form and filling, through the operations a host calls: fields of
//! every kind made on a flat Arabic form, read back by `forms.inspect`, filled
//! by `forms.fill`, and each value drawn — Arabic shaped — in the widget's
//! own appearance, so any reader shows it; the original bytes the prefix.
use crate::call_static;

fn fixture(path: &str) -> Vec<u8> {
    std::fs::read(format!("{}/../../../{path}", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

fn json(reply: &crate::tools::Reply) -> serde_json::Value {
    serde_json::from_str(&reply.json).unwrap()
}

/// The text a widget's normal appearance was drawn for (`/WarraqText`).
fn drawn(bytes: &[u8], name: &str) -> Option<String> {
    let doc = lopdf::Document::load_mem(bytes).unwrap();
    for object in doc.objects.values() {
        let Ok(d) = object.as_dict() else { continue };
        let t = d
            .get(b"T")
            .ok()
            .and_then(|t| t.as_str().ok())
            .map(warraq_pdf::document::decode_text_string);
        if t.as_deref() != Some(name) {
            continue;
        }
        let ap = d.get(b"AP").ok()?.as_dict().ok()?.get(b"N").ok()?;
        let stream = doc
            .get_object(ap.as_reference().ok()?)
            .ok()?
            .as_stream()
            .ok()?;
        let text = stream.dict.get(b"WarraqText").ok()?.as_str().ok()?;
        return Some(warraq_pdf::document::decode_text_string(text));
    }
    None
}

#[test]
fn every_kind_of_field_is_made_filled_and_drawn() {
    let flat = fixture("tests/fixtures/forms/ar-invoice.pdf");
    let amiri = fixture("tests/fonts/Amiri-Regular.ttf");
    let fields = serde_json::json!({ "fields": [
        { "page": 0, "kind": "text", "name": "الاسم", "rect": [300, 100, 500, 122], "rtl": true },
        { "page": 0, "kind": "date", "name": "التاريخ", "rect": [300, 130, 500, 152], "rtl": true, "pattern": "dd/mm/yyyy" },
        { "page": 0, "kind": "checkbox", "name": "موافق", "rect": [480, 160, 494, 174] },
        { "page": 0, "kind": "radio", "name": "الدفع", "rect": [480, 180, 494, 194], "options": ["نقدًا"] },
        { "page": 0, "kind": "radio", "name": "الدفع", "rect": [440, 180, 454, 194], "options": ["بطاقة"] },
        { "page": 0, "kind": "choice", "name": "المدينة", "rect": [300, 200, 500, 222], "rtl": true, "options": ["الرياض", "جدة"] },
        { "page": 0, "kind": "signature", "name": "التوقيع", "rect": [300, 240, 500, 280] },
    ] });
    let made = call_static("forms.create", &fields.to_string(), vec![flat.clone()]).unwrap();
    assert_eq!(
        json(&made)["created"],
        serde_json::json!(["الاسم", "التاريخ", "موافق", "الدفع", "المدينة", "التوقيع"])
    );
    let made = made.blobs[0].clone();
    assert!(
        made.starts_with(&flat),
        "an update: the original bytes stay the file's prefix"
    );
    let form = json(&call_static("forms.inspect", "{}", vec![made.clone()]).unwrap());
    let types: Vec<&str> = form["fields"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["type"].as_str().unwrap())
        .collect();
    assert_eq!(
        types,
        ["text", "text", "checkbox", "radio", "choice", "signature"]
    );
    let radio = &form["fields"][3];
    assert_eq!(radio["options"], serde_json::json!(["نقدًا", "بطاقة"]));
    assert_eq!(radio["widgets"].as_array().unwrap().len(), 2);
    assert_eq!(
        form["fields"][4]["options"],
        serde_json::json!(["الرياض", "جدة"])
    );

    let values = serde_json::json!({ "values": [
        { "name": "الاسم", "value": "عبدالرحمن الشمري" },
        { "name": "التاريخ", "value": "01/10/2026" },
        { "name": "موافق", "value": "Yes" },
        { "name": "الدفع", "value": "بطاقة" },
        { "name": "المدينة", "value": "جدة" },
    ] });
    let filled = call_static(
        "forms.fill",
        &values.to_string(),
        vec![made.clone(), amiri.clone()],
    )
    .unwrap();
    let after = filled.blobs[0].clone();
    assert!(after.starts_with(&made), "filling is an update too");
    let form = json(&call_static("forms.inspect", "{}", vec![after.clone()]).unwrap());
    let value = |i: usize| form["fields"][i]["value"].as_str().unwrap().to_string();
    assert_eq!(value(0), "عبدالرحمن الشمري");
    assert_eq!(value(1), "01/10/2026");
    assert_eq!(value(2), "Yes");
    assert_eq!(value(3), "1");
    assert_eq!(value(4), "جدة");
    // Each value drawn into its widget, exactly.
    assert_eq!(drawn(&after, "الاسم").as_deref(), Some("عبدالرحمن الشمري"));
    assert_eq!(drawn(&after, "المدينة").as_deref(), Some("جدة"));
    // A value that is not one of a list's choices, or a field that is not
    // there, is refused and nothing is written.
    let bad = serde_json::json!({ "values": [{ "name": "المدينة", "value": "مكة" }] });
    assert!(call_static(
        "forms.fill",
        &bad.to_string(),
        vec![after.clone(), amiri.clone()]
    )
    .is_err());
    let none = serde_json::json!({ "values": [{ "name": "غير موجود", "value": "x" }] });
    assert!(call_static("forms.fill", &none.to_string(), vec![after, amiri]).is_err());
}
