//! `font.check`: a font a host found for an edit is looked over before any
//! text is set in it.
use warraq_core::call_static;

const AMIRI: &[u8] = include_bytes!("../../../../tests/fonts/Amiri-Regular.ttf");
const INTER: &[u8] = include_bytes!("../../../../tests/fonts/static/Inter-Regular-static.ttf");

fn check(args: serde_json::Value, font: &[u8]) -> serde_json::Value {
    let reply = call_static("font.check", &args.to_string(), vec![font.to_vec()]).unwrap();
    serde_json::from_str(&reply.json).unwrap()
}

#[test]
fn a_font_of_the_family_with_every_glyph_is_usable() {
    let got = check(
        serde_json::json!({ "text": "Meeting box", "family": "inter" }),
        INTER,
    );
    assert_eq!(got["usable"], true, "{got}");
    assert_eq!(got["reason"], serde_json::Value::Null);
    assert_eq!(got["family"], "Inter");
    assert_eq!(got["weight"], 400);
    assert_eq!(got["italic"], false);
    // Amiri draws Arabic and Latin both.
    assert_eq!(
        check(serde_json::json!({ "text": "فاتورة Invoice 2026" }), AMIRI)["usable"],
        true
    );
}

#[test]
fn a_font_without_the_letters_or_of_another_family_is_refused_with_the_reason() {
    // Inter has no Arabic: the text would be drawn as empty boxes.
    let got = check(serde_json::json!({ "text": "فاتورة" }), INTER);
    assert_eq!(
        (got["usable"].clone(), got["reason"].clone()),
        (false.into(), "missing-glyphs".into())
    );
    let got = check(
        serde_json::json!({ "text": "x", "family": "Montserrat" }),
        INTER,
    );
    assert_eq!(got["reason"], "other-family");
}

#[test]
fn what_is_not_a_font_is_refused_and_never_a_panic() {
    for rubbish in [
        &b""[..],
        b"<!doctype html><title>Not found</title>",
        b"%PDF-1.7",
        &AMIRI[..300],
        &[0u8, 1, 0, 0, 0xFF, 0xFF, 0, 0, 0, 0, 0, 0][..],
    ] {
        let got = check(serde_json::json!({ "text": "x" }), rubbish);
        assert_eq!(got["usable"], false, "{got}");
        assert_eq!(got["reason"], "not-a-font", "{got}");
    }
    assert!(call_static("font.check", "{}", vec![]).is_err());
    assert!(call_static("font.nothing", "{}", vec![]).is_err());
    assert!(call_static("font.check", "not json", vec![AMIRI.to_vec()]).is_err());
}
