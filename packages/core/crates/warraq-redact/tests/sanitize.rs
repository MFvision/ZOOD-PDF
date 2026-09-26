//! Remove hidden information: every class, defaults, whole rewrite.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod common;

use common::*;
use lopdf::{dictionary, Object, ObjectId, Stream};
use warraq_pdf::{revisions, Pdf};
use warraq_redact::sanitize::{sanitize_and_rewrite, FormMode, SanitizeOptions};

fn js(code: &str) -> Object {
    Object::Dictionary(dictionary! {"S" => "JavaScript", "JS" => Object::string_literal(code)})
}

struct Fixture {
    bytes: Vec<u8>,
}

fn fixture() -> Fixture {
    let mut b = Builder::new();
    // Layers: /on visible, /off hidden; OCMDs with policies and a /VE expression.
    let on = b
        .doc
        .add_object(dictionary! {"Type" => "OCG", "Name" => Object::string_literal("Visible")});
    let off = b
        .doc
        .add_object(dictionary! {"Type" => "OCG", "Name" => Object::string_literal("Hidden")});
    let all_on = b.doc.add_object(
        dictionary! {"Type" => "OCMD", "OCGs" => vec![on.into(), off.into()], "P" => "AllOn"},
    );
    let ve = b
        .doc
        .add_object(dictionary! {"Type" => "OCMD", "VE" => vec!["Not".into(), off.into()]});
    b.catalog.set(
        "OCProperties",
        dictionary! {"OCGs" => vec![on.into(), off.into()], "D" => dictionary! {"OFF" => vec![off.into()], "Order" => vec![on.into(), off.into()]}},
    );
    let hidden_img = b.doc.add_object(Stream::new(
        dictionary! {"Type" => "XObject", "Subtype" => "Image", "Width" => 1, "Height" => 1, "ColorSpace" => "DeviceGray",
            "BitsPerComponent" => 8, "OC" => off},
        vec![0x42],
    ));
    let content = b"BT /F1 12 Tf 72 700 Td (Public text) Tj ET\n\
/OC /L1 BDC BT /F1 12 Tf 72 680 Td (HiddenLayerText) Tj ET 0 0 10 10 re f EMC\n\
/OC /L2 BDC BT /F1 12 Tf 72 660 Td (AllOnPolicyText) Tj ET EMC\n\
/OC /L3 BDC BT /F1 12 Tf 72 640 Td (VisibleByExpression) Tj ET EMC\n\
/OC /L0 BDC BT /F1 12 Tf 72 620 Td (VisibleLayerText) Tj ET EMC\n\
BT /F1 12 Tf 3 Tr 72 600 Td (InvisibleOcrLayer) Tj ET\n\
BT /F1 12 Tf 9000 9000 Td (OffPageText) Tj ET\n\
BT /F1 0.3 Tf 72 580 Td (TinyText) Tj ET\n\
q 10 0 0 10 300 300 cm /HI Do Q\n";
    // Annotations: comment + popup, file attachment, link with a JS chain, widget.
    let popup = b.doc.new_object_id();
    let comment = b.doc.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Text", "Rect" => vec![10.into(), 10.into(), 30.into(), 30.into()],
        "Contents" => Object::string_literal("reviewer comment"), "Popup" => popup,
    });
    b.doc.objects.insert(
        popup,
        Object::Dictionary(
            dictionary! {"Type" => "Annot", "Subtype" => "Popup", "Parent" => comment,
            "Rect" => vec![40.into(), 40.into(), 140.into(), 90.into()]},
        ),
    );
    let ef = b.doc.add_object(Stream::new(
        dictionary! {"Type" => "EmbeddedFile"},
        b"attached secret payload".to_vec(),
    ));
    let fs = b.doc.add_object(dictionary! {"Type" => "Filespec", "F" => Object::string_literal("a.txt"), "EF" => dictionary! {"F" => ef}});
    let attach = b.doc.add_object(
        dictionary! {"Type" => "Annot", "Subtype" => "FileAttachment",
        "Rect" => vec![50.into(), 50.into(), 60.into(), 60.into()], "FS" => fs},
    );
    let js2 = b.doc.add_object(js("app.alert('second')"));
    let js1 = b.doc.add_object(dictionary! {"S" => "JavaScript", "JS" => Object::string_literal("app.alert('first')"), "Next" => js2});
    let link = b.doc.add_object(dictionary! {"Type" => "Annot", "Subtype" => "Link", "Rect" => vec![70.into(), 70.into(), 90.into(), 80.into()],
        "A" => dictionary! {"S" => "URI", "URI" => Object::string_literal("https://example.com"), "Next" => js1}});
    let field = b.doc.add_object(
        dictionary! {"Type" => "Annot", "Subtype" => "Widget", "FT" => "Tx",
        "T" => Object::string_literal("name"), "V" => Object::string_literal("FormValueSecret"),
        "Rect" => vec![100.into(), 100.into(), 200.into(), 120.into()],
        "AA" => dictionary! {"K" => js("AFNumber_Keystroke(2)")}},
    );
    let offlayer_annot = b.doc.add_object(
        dictionary! {"Type" => "Annot", "Subtype" => "Square", "OC" => off,
        "Rect" => vec![300.into(), 100.into(), 320.into(), 120.into()]},
    );
    let page = b.page(
        content,
        dictionary! {
            "Properties" => dictionary! {"L0" => on, "L1" => off, "L2" => all_on, "L3" => ve},
            "XObject" => dictionary! {"HI" => hidden_img},
        },
        vec![
            comment.into(),
            popup.into(),
            attach.into(),
            link.into(),
            field.into(),
            offlayer_annot.into(),
        ],
    );
    let thumb = b.doc.add_object(Stream::new(
        dictionary! {"Width" => 1, "Height" => 1},
        vec![0],
    ));
    if let Ok(Object::Dictionary(p)) = b.doc.get_object_mut(page) {
        p.set("Thumb", thumb);
        p.set("PieceInfo", dictionary! {"App" => dictionary! {"Private" => Object::string_literal("PieceInfoSecret")}});
        p.set("AA", dictionary! {"O" => js("app.alert('page open')")});
    }
    // Document level: OpenAction, AA, names JavaScript + EmbeddedFiles, XMP, outlines, form.
    let xmp = b.doc.add_object(Stream::new(
        dictionary! {"Type" => "Metadata", "Subtype" => "XML"},
        b"<x:xmpmeta><dc:creator>XmpAuthorSecret</dc:creator></x:xmpmeta>".to_vec(),
    ));
    let doc_js = b.doc.add_object(js("this.print()"));
    b.catalog.set("OpenAction", js("app.alert('open')"));
    b.catalog
        .set("AA", dictionary! {"WC" => js("app.alert('close')")});
    b.catalog.set("Metadata", xmp);
    b.catalog.set("Names", dictionary! {
        "JavaScript" => dictionary! {"Names" => vec![Object::string_literal("init"), doc_js.into()]},
        "EmbeddedFiles" => dictionary! {"Names" => vec![Object::string_literal("a.txt"), fs.into()]},
    });
    let item = b.doc.new_object_id();
    let outlines = b.doc.add_object(
        dictionary! {"Type" => "Outlines", "First" => item, "Last" => item, "Count" => 1},
    );
    b.doc.objects.insert(item, Object::Dictionary(dictionary! {"Title" => Object::string_literal("Chapter"), "Parent" => outlines, "Dest" => vec![page.into(), "Fit".into()]}));
    b.catalog.set("Outlines", outlines);
    b.catalog
        .set("AcroForm", dictionary! {"Fields" => vec![field.into()]});
    let info = b.doc.add_object(dictionary! {"Title" => Object::string_literal("InfoTitleSecret"), "Author" => Object::string_literal("Someone")});
    b.doc.trailer.set("Info", info);
    // An orphan object and a second revision.
    b.doc.add_object(Object::string_literal("OrphanSecret"));
    let bytes = b.finish();
    let mut pdf = Pdf::open(bytes, None).unwrap();
    let mut m = std::collections::BTreeMap::new();
    m.insert(
        "Subject".to_string(),
        Some("RevisionOneSubject".to_string()),
    );
    warraq_pdf::metadata::set_info(&mut pdf, &m).unwrap();
    Fixture {
        bytes: pdf.commit().unwrap(),
    }
}

fn annot_subtypes(pdf: &Pdf) -> Vec<String> {
    let p = warraq_pdf::pages::flatten(pdf).unwrap()[0].id;
    let d = pdf.get_dict(p).unwrap();
    match d.get(b"Annots").ok().and_then(|o| pdf.resolve(o)) {
        Some(Object::Array(a)) => a
            .iter()
            .filter_map(|x| pdf.resolve(x).and_then(|o| o.as_dict().ok()))
            .map(|d| {
                String::from_utf8_lossy(d.get(b"Subtype").unwrap().as_name().unwrap()).into_owned()
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn any_dict(pdf: &Pdf, f: impl Fn(&lopdf::Dictionary) -> bool) -> bool {
    pdf.objects().values().any(|o| match o {
        Object::Dictionary(d) => f(d),
        Object::Stream(s) => f(&s.dict),
        _ => false,
    })
}

#[test]
fn defaults_remove_every_class_except_links_and_bookmarks() {
    let fx = fixture();
    assert_eq!(
        revisions::revisions(&fx.bytes, &Default::default()).len(),
        2
    );
    let before = Pdf::open(fx.bytes.clone(), None).unwrap();
    let t = plain(&before);
    for s in [
        "HiddenLayerText",
        "InvisibleOcrLayer",
        "VisibleByExpression",
    ] {
        assert!(t.contains(s), "fixture has {s}: {t}");
    }
    let mut pdf = Pdf::open(fx.bytes, None).unwrap();
    let (out, rep) = sanitize_and_rewrite(&mut pdf, &SanitizeOptions::default()).unwrap();
    let s = Pdf::open(out.clone(), None).unwrap();
    let all = everything(&s);

    // Whole rewrite: one revision, orphans and the old revision's strings gone.
    assert_eq!(revisions::revisions(&out, &Default::default()).len(), 1);
    assert_eq!(rep.earlier_revisions, 1);
    assert!(rep.orphans >= 1);
    for secret in [
        &b"OrphanSecret"[..],
        b"RevisionOneSubject",
        b"InfoTitleSecret",
        b"XmpAuthorSecret",
        b"attached secret payload",
        b"HiddenLayerText",
        b"AllOnPolicyText",
        b"InvisibleOcrLayer",
        b"OffPageText",
        b"TinyText",
        b"FormValueSecret",
        b"PieceInfoSecret",
        b"app.alert",
        b"this.print",
        b"reviewer comment",
        b"AFNumber",
    ] {
        assert!(
            !contains(&all, secret),
            "{} survived",
            String::from_utf8_lossy(secret)
        );
    }
    let text = plain(&s);
    assert!(text.contains("Public text"), "{text}");
    assert!(
        text.contains("VisibleByExpression"),
        "/VE Not(off) is visible: {text}"
    );
    assert!(text.contains("VisibleLayerText"), "{text}");

    assert!(
        s.trailer().get(b"Info").is_err() || matches!(s.trailer().get(b"Info"), Ok(Object::Null))
    );
    assert!(!any_dict(&s, |d| d.has(b"Metadata")
        || d.has(b"PieceInfo")
        || d.has(b"Thumb")
        || d.has(b"AA")
        || d.has(b"OpenAction")));
    assert!(!any_dict(&s, |d| d.has(b"JS")
        || d.get(b"S")
            .is_ok_and(|x| x.as_name().ok() == Some(b"JavaScript"))));
    assert!(!any_dict(&s, |d| d.has(b"EmbeddedFiles")
        || d.get(b"Subtype")
            .is_ok_and(|x| x.as_name().ok() == Some(b"FileAttachment"))));
    // The hidden image (/OC off) is gone; the hidden OCG itself too.
    assert!(!s
        .objects()
        .values()
        .any(|o| o.as_stream().is_ok_and(|st| st.content == [0x42])));
    let page = warraq_pdf::pages::flatten(&s).unwrap()[0].clone();
    let res = s
        .resolve(page.resources.as_ref().unwrap())
        .unwrap()
        .as_dict()
        .unwrap();
    let props = s
        .resolve(res.get(b"Properties").unwrap())
        .unwrap()
        .as_dict()
        .unwrap();
    assert!(
        !props.has(b"L1") && !props.has(b"L2"),
        "hidden layer properties pruned"
    );
    assert!(props.has(b"L0") && props.has(b"L3"));
    assert!(rep.hidden_layers >= 4, "{rep:?}");
    // Bookmarks and links are kept by default; the link lost its script chain.
    assert!(s.catalog().unwrap().has(b"Outlines"));
    let subtypes = annot_subtypes(&s);
    assert_eq!(
        subtypes,
        ["Link", "Widget"],
        "comments, pop-up, attachment and hidden-layer annotation removed"
    );
    let link = s
        .objects()
        .values()
        .filter_map(|o| o.as_dict().ok())
        .find(|d| {
            d.get(b"Subtype")
                .is_ok_and(|x| x.as_name().ok() == Some(b"Link"))
        })
        .unwrap();
    let a = s
        .resolve(link.get(b"A").unwrap())
        .unwrap()
        .as_dict()
        .unwrap();
    assert!(a.has(b"URI") && !a.has(b"Next"));
    // Form value cleared, viewers asked to regenerate appearances.
    let acro = s
        .resolve(s.catalog().unwrap().get(b"AcroForm").unwrap())
        .unwrap()
        .as_dict()
        .unwrap();
    assert_eq!(
        acro.get(b"NeedAppearances").unwrap(),
        &Object::Boolean(true)
    );
    assert!(
        rep.javascript >= 3 && rep.actions >= 3 && rep.attachments >= 2 && rep.comments == 2,
        "{rep:?}"
    );
    assert!(
        rep.hidden_text >= "InvisibleOcrLayer".len() + "OffPageText".len() + "TinyText".len(),
        "{rep:?}"
    );
}

#[test]
fn options_can_keep_classes_and_remove_links_bookmarks() {
    let fx = fixture();
    let mut pdf = Pdf::open(fx.bytes, None).unwrap();
    let opts = SanitizeOptions {
        metadata: false,
        xmp: false,
        javascript: false,
        actions: false,
        attachments: false,
        comments: false,
        forms: FormMode::Keep,
        hidden_layers: false,
        hidden_text: false,
        thumbnails: false,
        piece_info: false,
        links: true,
        bookmarks: true,
    };
    let (out, rep) = sanitize_and_rewrite(&mut pdf, &opts).unwrap();
    let s = Pdf::open(out, None).unwrap();
    let text = plain(&s);
    assert!(text.contains("HiddenLayerText") && text.contains("InvisibleOcrLayer"));
    assert!(!s.catalog().unwrap().has(b"Outlines"));
    assert_eq!(rep.links, 1);
    assert!(!annot_subtypes(&s).contains(&"Link".to_string()));
    assert!(any_dict(&s, |d| d.has(b"JS")));
    assert!(warraq_pdf::metadata::get_info(&s).contains_key("Title"));
}

#[test]
fn flatten_forms_draws_appearances_and_drops_the_form() {
    let mut b = Builder::new();
    let ap = b.doc.add_object(Stream::new(
        dictionary! {"Type" => "XObject", "Subtype" => "Form", "BBox" => vec![0.into(), 0.into(), 100.into(), 20.into()],
            "Resources" => dictionary! {"Font" => dictionary! {"F1" => b.helv}}},
        b"BT /F1 10 Tf 2 5 Td (Flattened value) Tj ET".to_vec(),
    ));
    let field: ObjectId = b.doc.add_object(dictionary! {"Type" => "Annot", "Subtype" => "Widget", "FT" => "Tx",
        "T" => Object::string_literal("f"), "V" => Object::string_literal("Flattened value"),
        "Rect" => vec![100.into(), 100.into(), 200.into(), 120.into()], "AP" => dictionary! {"N" => ap}});
    b.page(
        b"BT /F1 12 Tf 72 700 Td (Body) Tj ET",
        dictionary! {},
        vec![field.into()],
    );
    b.catalog
        .set("AcroForm", dictionary! {"Fields" => vec![field.into()]});
    let mut pdf = Pdf::open(b.finish(), None).unwrap();
    let opts = SanitizeOptions {
        forms: FormMode::Flatten,
        ..SanitizeOptions::default()
    };
    let (out, rep) = sanitize_and_rewrite(&mut pdf, &opts).unwrap();
    assert_eq!(rep.form_fields, 1);
    let s = Pdf::open(out, None).unwrap();
    assert!(!s.catalog().unwrap().has(b"AcroForm"));
    assert!(annot_subtypes(&s).is_empty());
    let text = plain(&s);
    assert!(
        text.contains("Flattened value") && text.contains("Body"),
        "{text}"
    );
}

#[test]
fn sanitize_keeps_encryption() {
    let fx = fixture();
    let pdf = Pdf::open(fx.bytes, None).unwrap();
    let h = warraq_pdf::SecurityHandler::new_aes256("pw", "", &warraq_pdf::PermissionFlags::all())
        .unwrap();
    let enc = pdf.write_full(warraq_pdf::Protection::New(h)).unwrap();
    let mut pdf = Pdf::open(enc, Some("pw")).unwrap();
    let (out, _) = sanitize_and_rewrite(&mut pdf, &SanitizeOptions::default()).unwrap();
    assert_eq!(
        Pdf::open(out.clone(), None).unwrap_err().code(),
        "password_required"
    );
    let s = Pdf::open(out, Some("pw")).unwrap();
    assert!(!plain(&s).contains("HiddenLayerText"));
}
