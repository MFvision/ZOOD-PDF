//! Prepare form through `call_static`, the way every host reaches it: fields
//! found on a flat Arabic form, made real, given a total that sums them and a
//! format, filled, recalculated and drawn — and every step survives a save
//! and a reopen.
use serde_json::{json, Value};
use warraq_core::{call_static, Document, Reply};

fn repo() -> String {
    format!("{}/../../..", env!("CARGO_MANIFEST_DIR"))
}

fn corpus(name: &str) -> Vec<u8> {
    std::fs::read(format!("{}/tests/corpus/arabic/{name}", repo())).unwrap()
}

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(format!("{}/tests/fixtures/forms/{name}", repo())).unwrap()
}

fn amiri() -> Vec<u8> {
    std::fs::read(format!("{}/tests/fonts/Amiri-Regular.ttf", repo())).unwrap()
}

fn json_of(reply: &Reply) -> Value {
    serde_json::from_str(&reply.json).unwrap()
}

const FLAT: &str = "generated/chrome-notosansarabic-form-layout.pdf";

#[test]
fn the_labelled_forms_are_found_well() {
    // The numbers STATUS reports; a floor under them, so a change that makes
    // detection worse fails here.
    let (rows, totals) = warraq_core::tools::forms_eval::evaluate(&repo());
    let t = &totals.0;
    for row in &rows {
        assert!(
            row.recall() >= 0.8,
            "{}: recall {}; missed {:?}",
            row.file,
            row.recall(),
            row.misses
        );
        assert!(
            row.precision() >= 0.8,
            "{}: precision {}; extra {:?}",
            row.file,
            row.precision(),
            row.extras
        );
    }
    assert!(t.truth >= 90, "the labelled set has {} fields", t.truth);
    assert!(t.precision() >= 0.95, "precision {}", t.precision());
    assert!(t.recall() >= 0.95, "recall {}", t.recall());
    assert!(t.type_rate() >= 0.95, "type {}", t.type_rate());
    assert!(t.name_rate() >= 0.95, "name {}", t.name_rate());
}

#[test]
fn a_document_that_is_no_form_gets_no_proposals() {
    for name in [
        "realworld/A_worldbank_malpass_g7_briefing_AR_word2016_pdftools.pdf",
        "generated/chrome-cairo-mixed-invoice.pdf",
        "generated/raw-amiri-cid-identity-tounicode.pdf",
    ] {
        let reply = call_static("forms.detect", "{}", vec![corpus(name)]).unwrap();
        let pages = json_of(&reply)["pages"].as_array().unwrap().clone();
        let found: usize = pages
            .iter()
            .map(|p| p["fields"].as_array().unwrap().len())
            .sum();
        assert_eq!(found, 0, "{name}: {pages:?}");
    }
}

#[test]
fn detect_accept_fill_and_total_on_a_flat_arabic_form() {
    // 1. Detect.
    let reply = call_static("forms.detect", r#"{"pages":[0]}"#, vec![corpus(FLAT)]).unwrap();
    let found = json_of(&reply)["pages"][0]["fields"]
        .as_array()
        .unwrap()
        .clone();
    let names: Vec<&str> = found.iter().map(|f| f["name"].as_str().unwrap()).collect();
    for want in [
        "الاسم الكامل",
        "رقم الهوية",
        "تاريخ الميلاد",
        "الجنسية",
        "الجنس/ذكر",
        "التوقيع",
    ] {
        assert!(names.contains(&want), "{want} in {names:?}");
    }
    let birth = found.iter().find(|f| f["name"] == "تاريخ الميلاد").unwrap();
    assert_eq!(birth["kind"], "date");
    assert_eq!(birth["rtl"], true);

    // 2. Accept every proposal, and two more places for numbers.
    let mut accepted: Vec<Value> = found
        .iter()
        .map(|f| {
            json!({
                "page": 0, "kind": f["kind"], "name": f["name"], "tooltip": f["tooltip"],
                "rect": f["rect"], "rtl": f["rtl"], "pattern": f["pattern"],
            })
        })
        .collect();
    for (name, x) in [("الرسوم", 60.0), ("الغرامة", 160.0), ("الإجمالي", 260.0)]
    {
        accepted.push(json!({ "page": 0, "kind": "text", "name": name, "tooltip": name, "rect": [x, 700.0, x + 90.0, 720.0], "rtl": true }));
    }
    let reply = call_static(
        "forms.create",
        &json!({ "fields": accepted }).to_string(),
        vec![corpus(FLAT)],
    )
    .unwrap();
    assert_eq!(
        json_of(&reply)["created"].as_array().unwrap().len(),
        found.len() + 3
    );
    let with_fields = reply.blobs[0].clone();
    assert!(
        with_fields.starts_with(&corpus(FLAT)),
        "an update of the file"
    );

    // 3. The total sums the two, in riyals, in Arabic-Indic digits.
    let args = json!({ "fields": [{
        "name": "الإجمالي",
        "calculate": { "op": "SUM", "fields": ["الرسوم", "الغرامة"] },
        "format": { "kind": "number", "decimals": 2, "separator": 0, "currency": " ر.س", "arabic": true },
    }, {
        "name": "الرسوم", "range": { "min": 0 },
    }]});
    let reply = call_static(
        "forms.set_actions",
        &args.to_string(),
        vec![with_fields, amiri()],
    )
    .unwrap();
    assert_eq!(json_of(&reply)["ok"], true, "{}", reply.json);
    let with_total = reply.blobs[0].clone();

    // 4. Inspect: the scripts are there, Warraq runs them all, nothing else.
    let reply = call_static("forms.inspect", "{}", vec![with_total.clone()]).unwrap();
    let form = json_of(&reply);
    assert_eq!(form["xfa"], "none");
    assert_eq!(form["order"], json!(["الإجمالي"]));
    assert_eq!(form["notRun"], json!([]));
    let total = form["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["name"] == "الإجمالي")
        .unwrap()
        .clone();
    assert_eq!(total["calculate"]["op"], "SUM");
    assert_eq!(total["format"]["currency"], " ر.س");
    assert_eq!(total["supported"], true);
    let fields: Vec<Value> = form["fields"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| {
            let value = match f["name"].as_str().unwrap() {
                "الرسوم" => "1500",
                "الغرامة" => "٢٥٠٫٥",
                _ => f["value"].as_str().unwrap(),
            };
            json!({
                "name": f["name"], "value": value,
                "keystroke": f["scripts"]["keystroke"], "format": f["scripts"]["format"],
                "validate": f["scripts"]["validate"], "calculate": f["scripts"]["calculate"],
            })
        })
        .collect();

    // 5. Filling a number recalculates the total, as a reader would.
    let reply = call_static(
        "forms.recalculate",
        &json!({ "fields": fields, "order": form["order"], "changed": "الغرامة" }).to_string(),
        vec![],
    )
    .unwrap();
    let out = json_of(&reply);
    assert_eq!(out["rejected"], Value::Null);
    assert_eq!(out["values"]["الإجمالي"], "1750.5");
    assert_eq!(out["shown"]["الإجمالي"]["text"], "١٬٧٥٠٫٥٠ ر.س");

    // A negative fee is refused by its range, and nothing is recalculated.
    let mut negative = fields.clone();
    for f in &mut negative {
        if f["name"] == "الرسوم" {
            f["value"] = json!("-5");
        }
    }
    let reply = call_static(
        "forms.recalculate",
        &json!({ "fields": negative, "order": form["order"], "changed": "الرسوم" }).to_string(),
        vec![],
    )
    .unwrap();
    let out = json_of(&reply);
    assert_eq!(out["rejected"]["kind"], "range");
    assert_eq!(out["values"], json!({}));

    // 6. The expression language is checked before it is written.
    let reply = call_static(
        "forms.check_expression",
        &json!({ "expression": "الرسوم + «الغرامة» × ٢", "fields": ["الرسوم", "الغرامة"] })
            .to_string(),
        vec![],
    )
    .unwrap();
    assert_eq!(json_of(&reply)["ok"], true);
    let reply = call_static(
        "forms.check_expression",
        &json!({ "expression": "الرسوم + الضريبة", "fields": ["الرسوم", "الغرامة"] }).to_string(),
        vec![],
    )
    .unwrap();
    let out = json_of(&reply);
    assert_eq!(out["ok"], false);
    assert_eq!(out["error"]["kind"], "unknownField");
    assert_eq!(out["error"]["name"], "الضريبة");

    // 7. The file reopens with every field.
    let doc = Document::open(with_total, None).unwrap();
    assert_eq!(doc.form().fields.len(), found.len() + 3);
}

#[test]
fn a_cycle_and_a_missing_field_are_answered_not_thrown() {
    let fields = json!({ "fields": [
        { "page": 0, "kind": "text", "name": "a", "rect": [50, 50, 150, 70] },
        { "page": 0, "kind": "text", "name": "b", "rect": [50, 80, 150, 100] },
    ]});
    let reply = call_static("forms.create", &fields.to_string(), vec![corpus(FLAT)]).unwrap();
    let pdf = reply.blobs[0].clone();
    let args = json!({ "fields": [
        { "name": "a", "calculate": { "expression": "b + 1" } },
        { "name": "b", "calculate": { "expression": "a * 2" } },
    ]});
    let reply = call_static(
        "forms.set_actions",
        &args.to_string(),
        vec![pdf.clone(), amiri()],
    )
    .unwrap();
    assert_eq!(json_of(&reply)["error"]["kind"], "cycle");
    assert!(reply.blobs.is_empty(), "nothing written");
    let args = json!({ "fields": [{ "name": "nope", "range": { "max": 3 } }] });
    let reply = call_static("forms.set_actions", &args.to_string(), vec![pdf, amiri()]).unwrap();
    assert_eq!(json_of(&reply)["error"]["kind"], "noField");
}

#[test]
fn drop_xfa_leaves_a_form_without_xfa_as_it_was() {
    // The XFA itself is told apart and dropped in warraq-pdf's own tests.
    let mut doc = warraq_pdf::PdfDocument::open(
        corpus("realworld/F_pdfjs15546_rtl_acroform_textfields_arabic_digits_acrobat.pdf"),
        None,
    )
    .unwrap();
    let form = doc.form();
    assert_eq!(form.xfa, warraq_pdf::forms::Xfa::None);
    let reply = call_static("forms.drop_xfa", "{}", vec![doc.save_to_vec().unwrap()]).unwrap();
    assert_eq!(json_of(&reply)["dropped"], false);
}

#[test]
fn every_labelled_file_opens_and_detects_quickly() {
    for name in [
        "ar-table-form.pdf",
        "ar-invoice.pdf",
        "en-form.pdf",
        "ar-survey-cairo.pdf",
    ] {
        let started = std::time::Instant::now();
        let reply = call_static("forms.detect", "{}", vec![fixture(name)]).unwrap();
        assert!(
            json_of(&reply)["pages"][0]["fields"]
                .as_array()
                .unwrap()
                .len()
                > 3
        );
        assert!(
            started.elapsed().as_secs() < 20,
            "{name} took {:?}",
            started.elapsed()
        );
    }
}
