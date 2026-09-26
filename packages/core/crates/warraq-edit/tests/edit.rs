//! Edit tool proofs on corpus and generated PDFs: every change is an incremental update whose
//! untouched content operators stay byte-identical, and what we write reads back in logical order.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

use std::path::PathBuf;

use lopdf::{dictionary, Document, Object, Stream};
use warraq_edit::content::{parse, partition_ok, reemit};
use warraq_edit::geom::Rect;
use warraq_edit::{images, links, page, text, url};
use warraq_pdf::Pdf;
use warraq_text::{extract_all, plain_text, DocSource, LayoutOptions};

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../..")
}

fn corpus(name: &str) -> Vec<u8> {
    std::fs::read(root().join("tests/corpus/pdf").join(name)).unwrap()
}

fn plain(pdf: &Pdf) -> String {
    let src = DocSource::borrowed(pdf.document());
    plain_text(&extract_all(&src, &LayoutOptions::default()).unwrap())
}

fn commit(pdf: &mut Pdf, original: &[u8]) -> Vec<u8> {
    let bytes = pdf.commit().unwrap();
    assert!(
        bytes.starts_with(original),
        "original bytes must be an exact prefix"
    );
    assert!(bytes.len() > original.len());
    bytes
}

fn strip_marks(s: &str) -> String {
    s.chars()
        .filter(|c| !matches!(*c as u32, 0x064B..=0x065F | 0x0670 | 0x0640))
        .collect()
}

#[test]
fn lexer_round_trips_every_corpus_page_byte_for_byte() {
    let mut pages_seen = 0;
    let dirs = [
        root().join("tests/corpus/pdf"),
        root().join("tests/fixtures"),
    ];
    for dir in dirs {
        for entry in std::fs::read_dir(dir).unwrap() {
            let p = entry.unwrap().path();
            if p.extension().and_then(|e| e.to_str()) != Some("pdf") {
                continue;
            }
            let Ok(pdf) = Pdf::open(std::fs::read(&p).unwrap(), None) else {
                continue;
            };
            for i in 0..page::page_count(&pdf).unwrap() {
                let pc = page::load(&pdf, i).unwrap();
                let c = parse(&pc.data).unwrap();
                assert!(partition_ok(&pc.data, &c), "{p:?} page {i}");
                assert_eq!(reemit(&pc.data, &c), pc.data, "{p:?} page {i}");
                assert!(!c.ops.is_empty());
                pages_seen += 1;
            }
        }
    }
    assert!(pages_seen >= 20, "{pages_seen}");
}

/// Old operators outside `removed` must reappear byte-identical and in order in the new content;
/// the only extra operators allowed among them are position keepers (`[n] TJ`, `T*`, `Tw`, `Tc`).
fn assert_untouched(old: &[u8], removed: &[std::ops::Range<usize>], new: &[u8]) {
    let oc = parse(old).unwrap();
    let kept: Vec<&[u8]> = oc
        .ops
        .iter()
        .filter(|o| {
            !removed
                .iter()
                .any(|r| r.start <= o.span.start && o.span.end <= r.end)
        })
        .map(|o| &old[o.span.clone()])
        .collect();
    let nc = parse(new).unwrap();
    let mut k = 0;
    for o in &nc.ops {
        let b = &new[o.span.clone()];
        if k < kept.len() && b == kept[k] {
            k += 1;
            continue;
        }
        if k >= kept.len() {
            break; // appended drawing
        }
        let ok = matches!(o.operator.as_slice(), b"T*" | b"Tw" | b"Tc")
            || (o.operator == b"TJ"
                && matches!(&o.operands[0].value, warraq_edit::content::Value::Array(a) if a.iter().all(|v| v.num().is_some())))
            || (o.operator == b"q" && o.span.start == 0);
        assert!(ok, "unexpected operator {:?}", String::from_utf8_lossy(b));
    }
    assert_eq!(
        k,
        kept.len(),
        "every untouched operator must survive byte for byte"
    );
}

#[test]
fn edit_arabic_paragraph_reflows_reads_back_and_keeps_other_bytes() {
    let original = corpus("chrome-news-amiri.pdf");
    let mut pdf = Pdf::open(original.clone(), None).unwrap();
    let (pc, sc, planned) = text::plan(&pdf, 0).unwrap();
    let target = planned
        .iter()
        .find(|p| p.block.text.starts_with("وأوضح التقرير"))
        .expect("paragraph listed");
    assert!(target.block.editable, "{:?}", target.block);
    assert_eq!(target.block.dir, "rtl");
    let other = planned
        .iter()
        .find(|p| p.block.text.starts_with("أعلنت وزارة"))
        .unwrap()
        .block
        .text
        .clone();
    let removed: Vec<_> = text::removal_splices(&sc, &target.shows)
        .into_iter()
        .map(|s| s.range)
        .collect();
    let new_text =
        "وأكّدَ التقريرُ الجديدُ أنّ المنصة تعمل بكفاءة عالية، وأن رضا المستفيدين بلغ ٩٥٪ هذا العام.";
    let r = text::replace(
        &mut pdf,
        0,
        target.block.id,
        new_text,
        Some(&target.block.text),
        None,
    )
    .unwrap();
    assert!(r.lines >= 1);
    let bytes = commit(&mut pdf, &original);
    let re = Pdf::open(bytes.clone(), None).unwrap();
    let t = plain(&re);
    assert!(t.contains(new_text), "new text in logical order:\n{t}");
    assert!(!t.contains("وأوضح التقرير السنوي"), "old text removed");
    assert!(t.contains(&other), "neighbouring paragraph intact");
    // Content bytes: every operator outside the removed ones is unchanged.
    let npc = page::load(&re, 0).unwrap();
    assert_untouched(&pc.data, &removed, &npc.data);
    // A font subset (Amiri, the original is a Chrome subset without the new glyphs, or the original
    // itself when it covers them) and never /Direction.
    let tail = String::from_utf8_lossy(&bytes[original.len()..]).into_owned();
    assert!(!tail.contains("/Direction"));
    assert!(!String::from_utf8_lossy(&npc.data).contains("/Direction"));
    if !r.reused_original_font {
        assert!(
            tail.contains("+Amiri-"),
            "embedded subset named after Amiri"
        );
        assert!(tail.contains("/FontFile2"));
    }
    assert!(String::from_utf8_lossy(&npc.data).contains("/ActualText"));
    // No double drawing: every glyph of the new text is shown once, fill only.
    let new_part = &npc.data[npc.data.len() - 200_000.min(npc.data.len())..];
    assert!(!String::from_utf8_lossy(new_part).contains(" 2 Tr"));
}

#[test]
fn tashkeel_text_round_trips_through_an_embedded_amiri_subset() {
    let original = corpus("chrome-tashkeel-amiri.pdf");
    let mut pdf = Pdf::open(original.clone(), None).unwrap();
    let blocks = text::blocks(&pdf, 0).unwrap();
    let b = blocks
        .iter()
        .find(|b| b.editable && b.text.contains("ذَهَبَ"))
        .expect("tashkeel paragraph");
    let new_text = "ذَهَبَ الطَّالِبُ إِلَى المَكْتَبَةِ";
    let r = text::replace(&mut pdf, 0, b.id, new_text, None, None).unwrap();
    let bytes = commit(&mut pdf, &original);
    let re = Pdf::open(bytes, None).unwrap();
    let t = plain(&re);
    assert!(strip_marks(&t).contains(&strip_marks(new_text)), "{t}");
    assert!(t.contains("الطَّالِبُ"), "marks kept in logical order: {t}");
    // Chrome's Amiri subset lacks the new glyphs (and layout tables): a bundled subset is used.
    assert!(!r.reused_original_font);
}

#[test]
fn original_embedded_font_is_reused_when_it_covers_the_new_text() {
    let original = corpus("chrome-english-inter.pdf");
    let mut pdf = Pdf::open(original.clone(), None).unwrap();
    let blocks = text::blocks(&pdf, 0).unwrap();
    let b = blocks
        .iter()
        .find(|b| b.editable && b.text.split(' ').count() > 4)
        .unwrap();
    // Same letters, other order: every glyph exists in Chrome's Inter subset.
    let mut words: Vec<&str> = b.text.split(' ').collect();
    words.reverse();
    let new_text = words.join(" ");
    let r = text::replace(&mut pdf, 0, b.id, &new_text, None, None).unwrap();
    assert!(r.reused_original_font, "{r:?}");
    let bytes = commit(&mut pdf, &original);
    let tail = String::from_utf8_lossy(&bytes[original.len()..]).into_owned();
    assert!(!tail.contains("/FontFile2"), "no new font program");
    let re = Pdf::open(bytes, None).unwrap();
    assert!(plain(&re).contains(&new_text), "{}", plain(&re));
}

#[test]
fn artifacts_are_not_editable_blocks() {
    let pdf = Pdf::open(corpus("synthetic-word-naskh.pdf"), None).unwrap();
    let t = plain(&pdf);
    let blocks = text::blocks(&pdf, 0).unwrap();
    assert!(!blocks.is_empty());
    // The synthetic Word file has /Artifact footers: they appear in extraction, never as blocks.
    let all_blocks: String = blocks
        .iter()
        .map(|b| b.text.clone())
        .collect::<Vec<_>>()
        .join("\n");
    let artifact_lines: Vec<&str> = t
        .lines()
        .filter(|l| !all_blocks.contains(l.trim()))
        .collect();
    assert!(
        !artifact_lines.is_empty(),
        "artifact text exists but is not a block"
    );
}

#[test]
fn add_text_box_arabic_and_english() {
    let original = corpus("chrome-english-inter.pdf");
    let mut pdf = Pdf::open(original.clone(), None).unwrap();
    let style = text::TextStyle {
        size: 14.0,
        line_height: None,
        align: warraq_edit::layout::Align::Start,
        rtl: None,
        family: warraq_edit::fonts::Family::Sans,
        bold: false,
        fill: [0.8, 0.1, 0.1],
    };
    text::add(
        &mut pdf,
        0,
        60.0,
        700.0,
        300.0,
        "مرحبا بكم في زود PDF",
        &style,
    )
    .unwrap();
    text::add(&mut pdf, 0, 60.0, 740.0, 300.0, "Added with ZOOD", &style).unwrap();
    let bytes = commit(&mut pdf, &original);
    let re = Pdf::open(bytes.clone(), None).unwrap();
    let t = plain(&re);
    assert!(t.contains("مرحبا بكم في زود PDF"), "{t}");
    assert!(t.contains("Added with ZOOD"), "{t}");
    let tail = String::from_utf8_lossy(&bytes[original.len()..]).into_owned();
    assert!(tail.contains("+Cairo-Regular") && tail.contains("+Inter-Regular"));
    // Blocks we added are editable blocks themselves.
    let blocks = text::blocks(&re, 0).unwrap();
    let ours = blocks
        .iter()
        .find(|b| b.text.contains("Added with ZOOD"))
        .unwrap();
    assert!(ours.editable);
    assert_eq!(ours.color, "#cc1a1a");
}

fn png_bytes(w: u32, h: u32, rgba: bool) -> Vec<u8> {
    let mut out = Vec::new();
    {
        let mut e = png::Encoder::new(&mut out, w, h);
        e.set_color(if rgba {
            png::ColorType::Rgba
        } else {
            png::ColorType::Rgb
        });
        e.set_depth(png::BitDepth::Eight);
        let mut wr = e.write_header().unwrap();
        let n = (w * h) as usize * if rgba { 4 } else { 3 };
        let data: Vec<u8> = (0..n).map(|i| (i * 37 % 251) as u8).collect();
        wr.write_image_data(&data).unwrap();
    }
    out
}

/// One page (612×792) with an image XObject placed by `q 100 0 0 50 72 600 cm /Im1 Do Q`, an
/// inline image, and some text.
fn picture_pdf() -> Vec<u8> {
    let mut doc = Document::with_version("1.7");
    let pages_id = doc.new_object_id();
    let img = doc.add_object(Stream::new(
        dictionary! {"Type" => "XObject", "Subtype" => "Image", "Width" => 2, "Height" => 1, "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8},
        vec![255, 0, 0, 0, 0, 255],
    ));
    let font = doc.add_object(
        dictionary! {"Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica"},
    );
    let content = b"% keep this comment\nBT /F1 12 Tf 72 720 Td (Title) Tj ET\nq 100 0 0 50 72 600 cm /Im1 Do Q\nq 20 0 0 20 300 300 cm BI /W 1 /H 1 /BPC 8 /CS /G ID \x80 EI Q\n".to_vec();
    let c = doc.add_object(Stream::new(dictionary! {}, content));
    let pg = doc.add_object(dictionary! {
        "Type" => "Page", "Parent" => pages_id, "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
        "Contents" => c,
        "Resources" => dictionary! {"XObject" => dictionary! {"Im1" => img}, "Font" => dictionary! {"F1" => font}},
    });
    doc.objects.insert(
        pages_id,
        Object::Dictionary(
            dictionary! {"Type" => "Pages", "Kids" => vec![pg.into()], "Count" => 1},
        ),
    );
    let cat = doc.add_object(dictionary! {"Type" => "Catalog", "Pages" => pages_id});
    doc.trailer.set("Root", cat);
    let mut out = Vec::new();
    doc.save_to(&mut out).unwrap();
    out
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() < 0.05
}

#[test]
fn pictures_list_move_resize_rotate_crop_replace_delete_add() {
    let original = picture_pdf();
    let mut pdf = Pdf::open(original.clone(), None).unwrap();
    let list = images::list(&pdf, 0).unwrap();
    assert_eq!(list.len(), 2);
    let b = list[0].bbox;
    // top-left coordinates: x 72..172, y 792-650=142..192
    assert!(
        close(b.x0, 72.0) && close(b.x1, 172.0) && close(b.y0, 142.0) && close(b.y1, 192.0),
        "{b:?}"
    );
    assert!(list[1].inline);

    // Move: the cm right before the Do is rewritten in place; nothing else changes.
    let before = page::load(&pdf, 0).unwrap().data;
    let moved = images::transform(
        &mut pdf,
        0,
        0,
        &images::Transform {
            dx: 10.0,
            dy: 20.0,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(
        close(moved.bbox.x0, 82.0) && close(moved.bbox.y0, 162.0),
        "{:?}",
        moved.bbox
    );
    let after = page::load(&pdf, 0).unwrap().data;
    let s = String::from_utf8_lossy(&after);
    assert!(s.contains("q 100 0 0 50 82 580 cm /Im1 Do Q"), "{s}");
    assert_eq!(before.len() - "72 600".len(), after.len() - "82 580".len());
    assert!(s.contains("% keep this comment\nBT /F1 12 Tf 72 720 Td (Title) Tj ET"));

    // Resize into a box.
    let r = images::transform(
        &mut pdf,
        0,
        0,
        &images::Transform {
            bbox: Some(Rect::new(100.0, 100.0, 300.0, 200.0)),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(
        close(r.bbox.x0, 100.0) && close(r.bbox.x1, 300.0) && close(r.bbox.y1, 200.0),
        "{:?}",
        r.bbox
    );
    // Rotate 90° clockwise about the centre: width and height swap.
    let r = images::transform(
        &mut pdf,
        0,
        0,
        &images::Transform {
            rotate: 90.0,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(
        close(r.bbox.width(), 100.0) && close(r.bbox.height(), 200.0),
        "{:?}",
        r.bbox
    );
    assert!(close(r.rotation, 90.0), "{}", r.rotation);
    // Free rotation.
    let r2 = images::transform(
        &mut pdf,
        0,
        0,
        &images::Transform {
            rotate: 30.0,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(close(r2.rotation, 120.0), "{}", r2.rotation);
    let _ = images::transform(
        &mut pdf,
        0,
        0,
        &images::Transform {
            rotate: -120.0,
            ..Default::default()
        },
    )
    .unwrap();
    // Crop to the left half.
    let cur = images::list(&pdf, 0).unwrap()[0].bbox;
    let half = Rect::new(cur.x0, cur.y0, cur.x0 + cur.width() / 2.0, cur.y1);
    let c = images::crop(&mut pdf, 0, 0, half).unwrap();
    assert!(c.crop.is_some());
    assert!(
        close(c.bbox.width(), cur.width() / 2.0),
        "{:?} vs {:?}",
        c.bbox,
        cur
    );
    // Crop again replaces the clip, and moving keeps the crop.
    let m = images::transform(
        &mut pdf,
        0,
        0,
        &images::Transform {
            dx: 5.0,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(m.crop.is_some() && close(m.bbox.x0, c.bbox.x0 + 5.0));
    // Replace with a PNG (with alpha → SMask).
    let rep = images::replace(&mut pdf, 0, 0, &png_bytes(4, 2, true)).unwrap();
    assert_eq!((rep.width, rep.height), (4, 2));
    assert!(rep.name.as_deref().unwrap().starts_with("ZIm"));
    // Delete the inline image.
    images::delete(&mut pdf, 0, 1).unwrap();
    assert_eq!(images::list(&pdf, 0).unwrap().len(), 1);
    // Add a picture.
    let added = images::add(
        &mut pdf,
        0,
        Rect::new(300.0, 400.0, 400.0, 500.0),
        &png_bytes(2, 1, false),
    )
    .unwrap();
    assert!(
        close(added.bbox.width(), 100.0) && close(added.bbox.height(), 50.0),
        "{:?}",
        added.bbox
    );
    let bytes = commit(&mut pdf, &original);
    let re = Pdf::open(bytes, None).unwrap();
    let l = images::list(&re, 0).unwrap();
    assert_eq!(l.len(), 2);
    assert!(plain(&re).contains("Title"));
    let tail = String::from_utf8_lossy(&page::load(&re, 0).unwrap().data).into_owned();
    assert!(
        tail.contains("/SMask")
            || re
                .objects()
                .values()
                .any(|o| matches!(o, Object::Stream(s) if s.dict.has(b"SMask")))
    );
}

#[test]
fn pictures_from_chrome_pdf_and_bad_images() {
    assert!(images::decode_picture(b"GIF89a").is_err());
    assert!(images::decode_picture(b"\x89PNG\r\n\x1a\nbroken").is_err());
    let j = images::decode_picture(&[
        0xFF, 0xD8, 0xFF, 0xC0, 0, 11, 8, 0, 2, 0, 3, 3, 1, 0x11, 0, 0xFF, 0xD9,
    ])
    .unwrap();
    assert_eq!((j.width, j.height), (3, 2));
}

#[test]
fn links_add_list_update_delete_and_spoof_refusal() {
    let original = corpus("chrome-english-inter.pdf");
    let mut pdf = Pdf::open(original.clone(), None).unwrap();
    let before = links::list(&pdf, 0).unwrap().len();
    let bx = Rect::new(72.0, 72.0, 200.0, 90.0);
    links::add(
        &mut pdf,
        0,
        bx,
        &links::Target::Uri("https://zood.sa/ar".into()),
        None,
    )
    .unwrap();
    let l = links::list(&pdf, 0).unwrap();
    assert_eq!(l.len(), before + 1);
    let mine = l.last().unwrap();
    assert_eq!(mine.uri.as_deref(), Some("https://zood.sa/ar"));
    assert!(
        close(mine.bbox.x0, 72.0) && close(mine.bbox.y1, 90.0),
        "{:?}",
        mine.bbox
    );
    assert_eq!(mine.check.as_ref().unwrap().host, "zood.sa");
    // Spoofs.
    let rlo = links::Target::Uri("https://zood.sa/\u{202E}fdp.exe".into());
    assert_eq!(
        links::add(&mut pdf, 0, bx, &rlo, None).unwrap_err().code(),
        "url_refused"
    );
    let js = links::Target::Uri("javascript:alert(1)".into());
    assert_eq!(
        links::add(&mut pdf, 0, bx, &js, None).unwrap_err().code(),
        "url_refused"
    );
    let idn = links::Target::Uri("https://xn--pple-43d.com/".into());
    assert_eq!(
        links::add(&mut pdf, 0, bx, &idn, None).unwrap_err().code(),
        "url_refused"
    );
    assert_eq!(
        links::add(&mut pdf, 0, bx, &idn, Some("apple.com"))
            .unwrap_err()
            .code(),
        "url_refused"
    );
    links::add(&mut pdf, 0, bx, &idn, Some("аpple.com")).unwrap();
    // Update to a go-to link, then delete.
    let id = mine.id;
    links::update(
        &mut pdf,
        0,
        id,
        Some(Rect::new(80.0, 80.0, 180.0, 100.0)),
        Some(&links::Target::Page(0)),
        None,
    )
    .unwrap();
    let l = links::list(&pdf, 0).unwrap();
    assert_eq!(l[id].page, Some(0));
    assert!(l[id].uri.is_none());
    links::delete(&mut pdf, 0, id).unwrap();
    let bytes = commit(&mut pdf, &original);
    let re = Pdf::open(bytes, None).unwrap();
    let l = links::list(&re, 0).unwrap();
    assert_eq!(l.len(), before + 1);
    assert_eq!(l.last().unwrap().check.as_ref().unwrap().verdict, "warn");
    assert_eq!(url::check("https://zood.sa").verdict, "ok");
}

#[test]
fn rpc_surface_and_errors() {
    let mut pdf = Pdf::open(corpus("chrome-news-amiri.pdf"), None).unwrap();
    let v = warraq_edit::api::call(
        &mut pdf,
        "edit.textBlocks",
        &serde_json::json!({"page": 0}),
        &[],
    )
    .unwrap()
    .unwrap();
    assert!(v["blocks"].as_array().unwrap().len() > 3);
    let e = warraq_edit::api::call(
        &mut pdf,
        "edit.textBlocks",
        &serde_json::json!({"page": 99}),
        &[],
    )
    .unwrap()
    .unwrap_err();
    assert_eq!(e.code(), "page_out_of_range");
    let e = warraq_edit::api::call(
        &mut pdf,
        "edit.replaceText",
        &serde_json::json!({"page": 0, "block": 1, "text": "x", "expect": "not the text"}),
        &[],
    )
    .unwrap()
    .unwrap_err();
    assert_eq!(e.code(), "stale");
    assert!(warraq_edit::api::call(&mut pdf, "edit.nope", &serde_json::json!({}), &[]).is_none());
    let c = warraq_edit::api::call_static(
        "edit.checkUrl",
        &serde_json::json!({"url": "https://a.com/\u{2066}"}),
    )
    .unwrap()
    .unwrap();
    assert_eq!(c["verdict"], "reject");
}

#[test]
fn chrome_fixture_used_by_the_ui_spec() {
    let original = std::fs::read(root().join("tests/fixtures/edit-ar.pdf")).unwrap();
    let mut pdf = Pdf::open(original.clone(), None).unwrap();
    let blocks = text::blocks(&pdf, 0).unwrap();
    let first = blocks
        .iter()
        .find(|b| b.text.starts_with("هذه الجملة الأولى"))
        .expect("first sentence");
    assert!(first.editable, "{first:?}");
    assert_eq!(images::list(&pdf, 0).unwrap().len(), 1);
    let new_text = "هذه جملةٌ جديدةٌ مُعدَّلة بالكامل.";
    text::replace(&mut pdf, 0, first.id, new_text, Some(&first.text), None).unwrap();
    let bytes = commit(&mut pdf, &original);
    let re = Pdf::open(bytes, None).unwrap();
    let t = plain(&re);
    assert!(t.contains(new_text), "{t}");
    assert!(
        t.contains("الفقرة الثانية تبقى كما هي دون أي تغيير."),
        "{t}"
    );
}
