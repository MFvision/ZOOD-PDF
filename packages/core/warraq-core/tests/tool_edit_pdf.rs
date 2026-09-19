//! Edit PDF — pictures and links — through `Document::call`, the way the
//! editor reaches them: every change shows at once, survives a save and a
//! reopen, and leaves the page's text as it was.
use serde_json::{json, Value};
use warraq_core::{call_static, Document, Reply};

fn corpus(name: &str) -> Vec<u8> {
    std::fs::read(format!(
        "{}/../../../tests/corpus/arabic/{name}",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap()
}

const THREE: &str = "generated/chrome-notonaskh-justified-3pages.pdf";

fn value(reply: &Reply) -> Value {
    serde_json::from_str(&reply.json).unwrap()
}

fn png(width: u32, height: u32, rgb: [u8; 3]) -> Vec<u8> {
    let mut out = Vec::new();
    image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(width, height, image::Rgb(rgb)))
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .unwrap();
    out
}

fn matrix(v: &Value) -> Vec<f32> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|n| n.as_f64().unwrap() as f32)
        .collect()
}

fn close(a: &[f32], b: &[f32]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| (x - y).abs() < 0.05)
}

/// The colour of the page at a point as shown (scale 1).
fn pixel(doc: &Document, page: usize, x: f32, y: f32) -> [u8; 3] {
    let b = doc.render_page(page, 1.0).unwrap();
    let k = ((y as u32 * b.width + x as u32) * 4) as usize;
    [b.rgba[k], b.rgba[k + 1], b.rgba[k + 2]]
}

#[test]
fn a_picture_is_placed_moved_turned_cropped_replaced_and_deleted() {
    let mut doc = Document::open(corpus(THREE), None).unwrap();
    let text = doc.extract_text(0).unwrap();
    let at = json!([120, 0, 0, -60, 300, 700]);
    let reply = doc
        .call(
            "images.add",
            &json!({ "page": 0, "matrix": at }).to_string(),
            vec![png(40, 20, [220, 20, 20])],
        )
        .unwrap();
    let id = value(&reply)["id"].as_str().unwrap().to_string();
    // Shows at once: red where it was put.
    let p = pixel(&doc, 0, 360.0, 670.0);
    assert!(p[0] > 180 && p[1] < 80, "{p:?}");

    let moved = [240.0, 0.0, 0.0, -120.0, 100.0, 300.0];
    let reply = doc
        .call(
            "images.transform",
            &json!({ "page": 0, "id": id, "matrix": moved }).to_string(),
            vec![],
        )
        .unwrap();
    let images = value(&reply)["images"].clone();
    assert!(close(&matrix(&images[0]["matrix"]), &moved));
    let p = pixel(&doc, 0, 220.0, 240.0);
    assert!(p[0] > 180 && p[1] < 80, "moved: {p:?}");

    // Turned a quarter, and its left half cropped away.
    let id = images[0]["id"].as_str().unwrap().to_string();
    let turned = [0.0, 240.0, 120.0, 0.0, 160.0, 120.0];
    let reply = doc
        .call(
            "images.transform",
            &json!({ "page": 0, "id": id, "matrix": turned, "clip": [0.5, 0, 1, 1] }).to_string(),
            vec![],
        )
        .unwrap();
    let images = value(&reply)["images"].clone();
    assert!(close(&matrix(&images[0]["matrix"]), &turned));
    assert!(close(&matrix(&images[0]["clip"]), &[0.5, 0.0, 1.0, 1.0]));

    // Replaced with a blue one, then saved, reopened, and deleted.
    let id = images[0]["id"].as_str().unwrap().to_string();
    doc.call(
        "images.replace",
        &json!({ "page": 0, "id": id }).to_string(),
        vec![png(10, 10, [20, 20, 220])],
    )
    .unwrap();
    let saved = doc.save().unwrap();
    let listed = value(
        &call_static(
            "images.list",
            &json!({ "page": 0 }).to_string(),
            vec![saved.clone()],
        )
        .unwrap(),
    );
    assert_eq!(listed["images"][0]["pixels"], json!([10, 10]));
    let mut doc = Document::open(saved, None).unwrap();
    assert_eq!(
        doc.extract_text(0).unwrap(),
        text,
        "the page's text is untouched"
    );
    let id = listed["images"][0]["id"].as_str().unwrap().to_string();
    let reply = doc
        .call(
            "images.delete",
            &json!({ "page": 0, "id": id }).to_string(),
            vec![],
        )
        .unwrap();
    assert!(value(&reply)["images"].as_array().unwrap().is_empty());
}

#[test]
fn a_scans_own_picture_is_moved_in_place() {
    let original = corpus("generated/scan-arial-200dpi-bilevel.pdf");
    let mut doc = Document::open(original.clone(), None).unwrap();
    let listed = value(&doc.call("images.list", r#"{"page":0}"#, vec![]).unwrap());
    let image = &listed["images"][0];
    let m = matrix(&image["matrix"]);
    let half = [m[0] / 2.0, 0.0, 0.0, m[3] / 2.0, m[4], m[5] + m[3] / 2.0];
    doc.call(
        "images.transform",
        &json!({ "page": 0, "id": image["id"], "matrix": half }).to_string(),
        vec![],
    )
    .unwrap();
    let saved = doc.save().unwrap();
    assert!(saved.starts_with(&original), "an incremental update");
    let listed = value(&call_static("images.list", r#"{"page":0}"#, vec![saved]).unwrap());
    assert!(close(&matrix(&listed["images"][0]["matrix"]), &half));
}

#[test]
fn links_to_an_address_and_to_a_page_are_added_moved_and_removed() {
    let mut doc = Document::open(corpus(THREE), None).unwrap();
    let reply = doc
        .call(
            "links.add",
            &json!({ "page": 0, "rect": [72, 80, 200, 18], "to": { "uri": "https://warraq.example/دليل" } }).to_string(),
            vec![],
        )
        .unwrap();
    let web = value(&reply)["id"].as_str().unwrap().to_string();
    doc.call(
        "links.add",
        &json!({ "page": 0, "rect": [72, 120, 90, 18], "to": { "page": 2 } }).to_string(),
        vec![],
    )
    .unwrap();
    assert!(doc
        .call(
            "links.add",
            &json!({ "page": 0, "rect": [0, 0, 10, 10], "to": { "uri": "javascript:alert(1)" } })
                .to_string(),
            vec![],
        )
        .is_err());

    let saved = doc.save().unwrap();
    let listed = value(&call_static("links.list", r#"{"page":0}"#, vec![saved.clone()]).unwrap());
    let links = listed["links"].as_array().unwrap();
    assert_eq!(links.len(), 2);
    assert_eq!(
        links[0]["to"]["uri"],
        "https://warraq.example/%D8%AF%D9%84%D9%8A%D9%84"
    );
    assert_eq!(links[1]["to"]["page"], 2);
    assert!(close(
        &matrix(&links[1]["rect"]),
        &[72.0, 120.0, 90.0, 18.0]
    ));

    let mut doc = Document::open(saved, None).unwrap();
    doc.call(
        "links.update",
        &json!({ "page": 0, "id": web, "rect": [300, 300, 50, 20], "to": { "page": 1 } })
            .to_string(),
        vec![],
    )
    .unwrap();
    let reply = doc
        .call(
            "links.remove",
            &json!({ "page": 0, "id": links[1]["id"] }).to_string(),
            vec![],
        )
        .unwrap();
    let links = value(&reply)["links"].clone();
    assert_eq!(links.as_array().unwrap().len(), 1);
    assert_eq!(links[0]["to"]["page"], 1);
}
