//! Organize / Combine / Compress RPC methods.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use serde_json::{json, Value};
use warraq_core::ops::image::{jpeg_encode, Raster};
use warraq_core::warraq_pdf::builder::{sample_pdf, SampleOptions};
use warraq_core::warraq_pdf::lopdf::{Dictionary, Object, Stream};
use warraq_core::warraq_pdf::outline::{self, text_string, Dest, NewItem};
use warraq_core::warraq_pdf::{pages, Pdf};
use warraq_core::{call_static, Document, Reply};
use warraq_render::{HayroRenderer, PageRenderer};

fn sample(n: usize) -> Vec<u8> {
    sample_pdf(n, &SampleOptions::default()).unwrap()
}

fn call(doc: &mut Document, m: &str, p: Value, blobs: Vec<Vec<u8>>) -> Reply {
    doc.call(m, &p, blobs)
        .unwrap_or_else(|e| panic!("{m}: {e}"))
}

fn page_texts(bytes: &[u8]) -> Vec<String> {
    let pdf = Pdf::open(bytes.to_vec(), None).unwrap();
    pages::flatten(&pdf)
        .unwrap()
        .iter()
        .map(|p| {
            let c = warraq_core::ops::geometry::page_content(&pdf, p);
            let s = String::from_utf8_lossy(&c).into_owned();
            s.split('(')
                .nth(1)
                .and_then(|x| x.split(')').next())
                .unwrap_or("")
                .to_string()
        })
        .collect()
}

fn photo(w: u32, h: u32) -> Raster {
    // Smooth gradients plus mild texture: photo-like, compresses like a photo.
    let mut pixels = Vec::with_capacity((w * h * 3) as usize);
    for y in 0..h {
        for x in 0..w {
            let t = ((x * 7 + y * 13) % 17) as u8;
            pixels.extend_from_slice(&[
                (x * 200 / w) as u8 + t,
                (y * 200 / h) as u8 + t,
                ((x + y) * 100 / (w + h)) as u8 + 60,
            ]);
        }
    }
    Raster {
        width: w,
        height: h,
        channels: 3,
        pixels,
    }
}

fn png(w: u32, h: u32, alpha: bool) -> Vec<u8> {
    let mut out = Vec::new();
    {
        let mut e = png::Encoder::new(&mut out, w, h);
        e.set_color(if alpha {
            png::ColorType::Rgba
        } else {
            png::ColorType::Rgb
        });
        e.set_depth(png::BitDepth::Eight);
        let mut wr = e.write_header().unwrap();
        let mut data = Vec::new();
        for y in 0..h {
            for x in 0..w {
                data.extend_from_slice(&[x as u8, y as u8, 99]);
                if alpha {
                    data.push(if y < h / 2 { 128 } else { 255 });
                }
            }
        }
        wr.write_image_data(&data).unwrap();
    }
    out
}

#[test]
fn boxes_report_media_crop_and_rotation() {
    let mut d = Document::open(sample(2), None).unwrap();
    call(
        &mut d,
        "pages.crop",
        json!({"pages": [1], "box": [10, 20, 300, 400]}),
        vec![],
    );
    call(
        &mut d,
        "pages.rotate",
        json!({"pages": [1], "degrees": 90}),
        vec![],
    );
    let r = call(&mut d, "pages.boxes", json!({}), vec![]);
    let p = &r.json["pages"];
    assert_eq!(p[0]["mediaBox"], json!([0.0, 0.0, 595.0, 842.0]));
    assert!(p[0]["cropBox"].is_null());
    assert_eq!(p[1]["cropBox"], json!([10.0, 20.0, 300.0, 400.0]));
    assert_eq!(p[1]["rotate"], 90);
}

#[test]
fn insert_jpeg_page_embeds_the_file_unchanged() {
    let orig = sample(2);
    let mut d = Document::open(orig.clone(), None).unwrap();
    let jpeg = jpeg_encode(&photo(300, 200), 85).unwrap();
    let r = call(
        &mut d,
        "pages.insertImage",
        json!({"at": 1}),
        vec![jpeg.clone()],
    );
    assert_eq!(r.json["pageCount"], 3);
    assert_eq!(r.json["imageWidth"], 300);
    let out = &r.blobs[0];
    assert!(out.starts_with(&orig), "incremental");
    assert!(
        out.windows(jpeg.len()).any(|w| w == jpeg.as_slice()),
        "DCTDecode passthrough"
    );
    let pdf = Pdf::open(out.clone(), None).unwrap();
    let pg = &pages::flatten(&pdf).unwrap()[1];
    assert_eq!(
        pg.media_box,
        [0.0, 0.0, 595.0, 842.0],
        "size of the neighbour page"
    );
    // the picture is centred and fills the width
    let geo = warraq_core::ops::geometry::page_geometry(&pdf, pg, false);
    let [x0, y0, x1, y1] = geo.bbox.0.unwrap();
    assert!((x0 - 0.0).abs() < 0.01 && (x1 - 595.0).abs() < 0.01);
    assert!(((y0 + y1) / 2.0 - 421.0).abs() < 0.01);
    assert!((y1 - y0 - 595.0 * 200.0 / 300.0).abs() < 0.01);
    // it renders
    let bmp = HayroRenderer::new(out.clone())
        .unwrap()
        .render(1, 0.5)
        .unwrap();
    assert!(bmp.non_white_pixels() > 10_000);
}

#[test]
fn insert_png_with_alpha_adds_a_soft_mask() {
    let mut d = Document::open(sample(1), None).unwrap();
    let r = call(
        &mut d,
        "pages.insertImage",
        json!({"at": 0, "width": 200, "height": 100, "margin": 10}),
        vec![png(40, 20, true)],
    );
    let pdf = Pdf::open(r.blobs[0].clone(), None).unwrap();
    let pg = &pages::flatten(&pdf).unwrap()[0];
    assert_eq!(pg.media_box, [0.0, 0.0, 200.0, 100.0]);
    let img = pdf
        .objects()
        .values()
        .find_map(|o| match o {
            Object::Stream(s) if s.dict.has(b"SMask") => Some(s.clone()),
            _ => None,
        })
        .expect("image with SMask");
    assert_eq!(
        img.dict.get(b"Filter").unwrap().as_name().unwrap(),
        b"FlateDecode"
    );
    // errors
    let e = d
        .call(
            "pages.insertImage",
            &json!({"at": 0}),
            vec![b"GIF89a....".to_vec()],
        )
        .unwrap_err();
    assert_eq!(e.code, "unsupported_image");
    let e = d
        .call("pages.insertImage", &json!({"at": 0}), vec![])
        .unwrap_err();
    assert_eq!(e.code, "invalid_params");
}

#[test]
fn trim_margins_sets_crop_box_to_the_content() {
    let orig = sample(2);
    let mut d = Document::open(orig.clone(), None).unwrap();
    let dry = call(
        &mut d,
        "pages.trimMargins",
        json!({"pages": [0], "dryRun": true}),
        vec![],
    );
    assert!(dry.blobs.is_empty());
    let b = dry.json["boxes"][0]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_f64().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(&b[..3], &[72.0, 600.0, 272.0]);
    assert!(b[3] > 735.0 && b[3] < 750.0, "{b:?}");
    let r = call(
        &mut d,
        "pages.trimMargins",
        json!({"pages": [0, 1], "margin": 12}),
        vec![],
    );
    let out = &r.blobs[0];
    assert!(out.starts_with(&orig));
    let pdf = Pdf::open(out.clone(), None).unwrap();
    let c = pages::flatten(&pdf).unwrap()[1].crop_box.unwrap();
    assert_eq!([c[0], c[1], c[2]], [60.0, 588.0, 284.0]);
    // a blank page has nothing to trim
    call(&mut d, "pages.insertBlank", json!({"at": 0}), vec![]);
    let e = d
        .call("pages.trimMargins", &json!({"pages": [0]}), vec![])
        .unwrap_err();
    assert_eq!(e.code, "nothing_to_trim");
}

#[test]
fn replace_swaps_one_page_in_one_update() {
    let orig = sample(3);
    let mut d = Document::open(orig.clone(), None).unwrap();
    let other = sample_pdf(
        2,
        &SampleOptions {
            compress: true,
            ..Default::default()
        },
    )
    .unwrap();
    let r = call(
        &mut d,
        "pages.replace",
        json!({"page": 1, "sourcePage": 1}),
        vec![other],
    );
    assert_eq!(r.json["pageCount"], 3);
    assert_eq!(r.json["revisions"], 2, "one incremental update");
    assert!(r.blobs[0].starts_with(&orig));
    assert_eq!(page_texts(&r.blobs[0]), vec!["Page 1", "Page 2", "Page 3"]);
    let pdf = Pdf::open(r.blobs[0].clone(), None).unwrap();
    let ids: Vec<_> = pages::flatten(&pdf).unwrap().iter().map(|p| p.id).collect();
    let before: Vec<_> = pages::flatten(&Pdf::open(orig, None).unwrap())
        .unwrap()
        .iter()
        .map(|p| p.id)
        .collect();
    assert_eq!(ids[0], before[0]);
    assert_ne!(ids[1], before[1], "page 2 is the new page");
    assert_eq!(ids[2], before[2]);
}

#[test]
fn combine_inserts_files_with_one_bookmark_each() {
    let orig = sample(2);
    let mut d = Document::open(orig.clone(), None).unwrap();
    let r = call(
        &mut d,
        "pages.combine",
        json!({"at": 1, "files": [{"title": "one.pdf"}, {"title": "اثنان.pdf"}]}),
        vec![sample(1), sample(3)],
    );
    assert_eq!(r.json["pageCount"], 6);
    assert_eq!(r.json["inserted"], 4);
    assert!(r.blobs[0].starts_with(&orig));
    assert_eq!(
        page_texts(&r.blobs[0]),
        vec!["Page 1", "Page 1", "Page 1", "Page 2", "Page 3", "Page 2"]
    );
    let pdf = Pdf::open(r.blobs[0].clone(), None).unwrap();
    let o = outline::read_outline(&pdf).unwrap();
    let t: Vec<_> = o.iter().map(|i| i.title_text()).collect();
    assert_eq!(t, vec!["one.pdf", "اثنان.pdf"]);
    let ids: Vec<_> = pages::flatten(&pdf).unwrap().iter().map(|p| p.id).collect();
    assert_eq!(o[0].dest.as_ref().unwrap().page, ids[1]);
    assert_eq!(o[1].dest.as_ref().unwrap().page, ids[2]);
}

fn with_bookmarks(n: usize, at: &[usize]) -> Vec<u8> {
    let mut pdf = Pdf::open(sample(n), None).unwrap();
    let list = pages::flatten(&pdf).unwrap();
    let items: Vec<NewItem> = at
        .iter()
        .map(|&i| NewItem {
            title: text_string(&format!("Part {}", i + 1)),
            dest: Some(Dest {
                page: list[i].id,
                view: vec![],
            }),
            children: vec![],
        })
        .collect();
    outline::append_outline(&mut pdf, &items).unwrap();
    pdf.commit().unwrap()
}

#[test]
fn split_every_ranges_and_bookmarks() {
    let mut d = Document::open(with_bookmarks(5, &[1, 3]), None).unwrap();
    let r = call(&mut d, "pages.split", json!({"every": 2}), vec![]);
    assert_eq!(r.blobs.len(), 3);
    assert_eq!(page_texts(&r.blobs[2]), vec!["Page 5"]);
    assert_eq!(r.json["parts"][1]["pages"], json!([2, 3]));
    let r = call(
        &mut d,
        "pages.split",
        json!({"ranges": [[0, 0], [2, 4]]}),
        vec![],
    );
    assert_eq!(r.blobs.len(), 2);
    assert_eq!(page_texts(&r.blobs[1]), vec!["Page 3", "Page 4", "Page 5"]);
    let r = call(&mut d, "pages.split", json!({"bookmarks": true}), vec![]);
    // pages before the first bookmark, then one file per bookmark
    assert_eq!(r.blobs.len(), 3);
    assert_eq!(page_texts(&r.blobs[0]), vec!["Page 1"]);
    assert_eq!(page_texts(&r.blobs[1]), vec!["Page 2", "Page 3"]);
    assert_eq!(r.json["parts"][1]["title"], "Part 2");
    // each part keeps its own bookmark
    let part = Pdf::open(r.blobs[2].clone(), None).unwrap();
    assert_eq!(
        outline::read_outline(&part).unwrap()[0].title_text(),
        "Part 4"
    );
    // errors
    for bad in [
        json!({"every": 0}),
        json!({"ranges": [[3, 1]]}),
        json!({"ranges": [[0, 9]]}),
        json!({}),
        json!({"every": 2, "bookmarks": true}),
    ] {
        let e = d.call("pages.split", &bad, vec![]).unwrap_err();
        assert!(
            e.code == "invalid_params" || e.code == "invalid_argument",
            "{bad}: {e:?}"
        );
    }
    let mut plain = Document::open(sample(2), None).unwrap();
    assert_eq!(
        plain
            .call("pages.split", &json!({"bookmarks": true}), vec![])
            .unwrap_err()
            .code,
        "no_bookmarks"
    );
}

#[test]
fn merge_titles_nest_bookmarks_per_file() {
    let r = call_static(
        "pdf.merge",
        &json!({"titles": ["a.pdf", "b.pdf"]}),
        vec![with_bookmarks(3, &[2]), sample(2)],
    )
    .unwrap();
    assert_eq!(r.json["pageCount"], 5);
    let pdf = Pdf::open(r.blobs[0].clone(), None).unwrap();
    let o = outline::read_outline(&pdf).unwrap();
    let t: Vec<_> = o.iter().map(|i| i.title_text()).collect();
    assert_eq!(t, vec!["a.pdf", "b.pdf"]);
    assert_eq!(o[0].children[0].title_text(), "Part 3");
}

// ---------------------------------------------------------------- compress

/// One page: the sample text + rectangle, a 1600×1200 JPEG photo placed at 240×180 pt
/// (480 dpi), a 900×600 lossless photo at 150×100 pt (432 dpi), a small picture with a soft
/// mask, an uncompressed extra content stream, two identical font programs and a thumbnail.
fn heavy() -> Vec<u8> {
    let mut pdf = Pdf::open(sample(1), None).unwrap();
    let pg = pages::flatten(&pdf).unwrap()[0].clone();
    let jpeg = jpeg_encode(&photo(1600, 1200), 92).unwrap();
    let img = |w: u32, h: u32, filter: Option<&str>, data: Vec<u8>| {
        let mut d = Dictionary::new();
        d.set("Type", Object::Name(b"XObject".to_vec()));
        d.set("Subtype", Object::Name(b"Image".to_vec()));
        d.set("Width", Object::Integer(w.into()));
        d.set("Height", Object::Integer(h.into()));
        d.set("ColorSpace", Object::Name(b"DeviceRGB".to_vec()));
        d.set("BitsPerComponent", Object::Integer(8));
        if let Some(f) = filter {
            d.set("Filter", Object::Name(f.as_bytes().to_vec()));
        }
        Stream::new(d, data)
    };
    let im1 = pdf.add(Object::Stream(img(1600, 1200, Some("DCTDecode"), jpeg)));
    let raw = photo(900, 600).pixels;
    let im2 = pdf.add(Object::Stream(img(
        900,
        600,
        Some("FlateDecode"),
        warraq_core::ops::image::deflate(&raw, 6).unwrap(),
    )));
    let mask = {
        let mut d = Dictionary::new();
        d.set("Subtype", Object::Name(b"Image".to_vec()));
        d.set("Width", Object::Integer(8));
        d.set("Height", Object::Integer(8));
        d.set("ColorSpace", Object::Name(b"DeviceGray".to_vec()));
        d.set("BitsPerComponent", Object::Integer(8));
        pdf.add(Object::Stream(Stream::new(d, vec![200; 64])))
    };
    let mut s3 = img(400, 400, None, photo(400, 400).pixels);
    s3.dict.set("SMask", Object::Reference(mask));
    let im3 = pdf.add(Object::Stream(s3));
    let font_program = vec![b'F'; 30_000];
    let ff1 = pdf.add(Object::Stream(Stream::new(
        Dictionary::new(),
        font_program.clone(),
    )));
    let ff2 = pdf.add(Object::Stream(Stream::new(Dictionary::new(), font_program)));
    let thumb = pdf.add(Object::Stream(img(10, 10, None, vec![0; 300])));
    let extra = pdf.add(Object::Stream(Stream::new(
        Dictionary::new(),
        b"q 240 0 0 180 300 100 cm /Im1 Do Q q 150 0 0 100 60 400 cm /Im2 Do Q q 20 0 0 20 500 500 cm /Im3 Do Q\n".to_vec(),
    )));
    let mut d = pdf.get_dict(pg.id).unwrap().clone();
    let first = d.get(b"Contents").unwrap().clone();
    d.set(
        "Contents",
        Object::Array(vec![first, Object::Reference(extra)]),
    );
    let mut res = match pg.resources.clone().unwrap() {
        Object::Dictionary(r) => r,
        _ => panic!(),
    };
    let mut xo = Dictionary::new();
    xo.set("Im1", Object::Reference(im1));
    xo.set("Im2", Object::Reference(im2));
    xo.set("Im3", Object::Reference(im3));
    res.set("XObject", Object::Dictionary(xo));
    let mut fonts = Dictionary::new();
    fonts.set("FF1", Object::Reference(ff1));
    fonts.set("FF2", Object::Reference(ff2));
    res.set("Unused", Object::Dictionary(fonts));
    d.set("Resources", Object::Dictionary(res));
    d.set("Thumb", Object::Reference(thumb));
    d.set("PieceInfo", Object::Dictionary(Dictionary::new()));
    pdf.set(pg.id, Object::Dictionary(d));
    pdf.commit().unwrap()
}

fn mean_diff(a: &[u8], b: &[u8]) -> f64 {
    let n = a.len().min(b.len());
    let s: u64 = a
        .iter()
        .zip(b)
        .take(n)
        .map(|(x, y)| u64::from(x.abs_diff(*y)))
        .sum();
    s as f64 / n as f64
}

fn image_widths(bytes: &[u8]) -> Vec<i64> {
    let pdf = Pdf::open(bytes.to_vec(), None).unwrap();
    let mut v: Vec<i64> = pdf
        .objects()
        .values()
        .filter_map(|o| match o {
            Object::Stream(s)
                if s.dict.get(b"Subtype").and_then(Object::as_name).ok() == Some(b"Image") =>
            {
                s.dict.get(b"Width").ok().and_then(|w| w.as_i64().ok())
            }
            _ => None,
        })
        .collect();
    v.sort_unstable();
    v
}

#[test]
fn compress_balanced_downsamples_dedupes_and_still_renders() {
    let orig = heavy();
    let mut d = Document::open(orig.clone(), None).unwrap();
    let r = call(
        &mut d,
        "doc.compress",
        json!({"preset": "balanced"}),
        vec![],
    );
    let out = &r.blobs[0];
    let j = &r.json;
    assert_eq!(j["before"], orig.len());
    assert_eq!(j["after"], out.len());
    assert!(
        out.len() * 3 < orig.len(),
        "{} vs {}",
        out.len(),
        orig.len()
    );
    assert_eq!(j["images"]["recompressed"], 2);
    assert_eq!(
        j["images"]["skipped"],
        json!([{ "reason": "mask", "count": 2 }])
    );
    assert!(j["duplicatesRemoved"].as_u64().unwrap() >= 1);
    assert!(j["streamsCompressed"].as_u64().unwrap() >= 1);
    // 1600 px at 240 pt → 150 dpi = 500 px; 900×600 px at 150×100 pt → 314×209 px
    assert_eq!(image_widths(out), vec![8, 10, 314, 400, 500]);
    // the open document is untouched: compress makes a new file
    let info = call(&mut d, "doc.info", json!({}), vec![]);
    assert_eq!(info.json["byteLength"], orig.len());
    // object streams + xref stream; readable
    let text = String::from_utf8_lossy(out);
    assert!(text.contains("/ObjStm") && text.contains("/XRef"));
    // renders like the original
    let a = HayroRenderer::new(orig).unwrap().render(0, 1.0).unwrap();
    let b = HayroRenderer::new(out.clone())
        .unwrap()
        .render(0, 1.0)
        .unwrap();
    assert_eq!((a.width, a.height), (b.width, b.height));
    let diff = mean_diff(&a.rgba, &b.rgba);
    assert!(diff < 1.5, "mean pixel difference {diff}");
}

#[test]
fn compress_presets_order_and_smallest_drops_extras() {
    let orig = heavy();
    let mut d = Document::open(orig.clone(), None).unwrap();
    let high = call(&mut d, "doc.compress", json!({"preset": "high"}), vec![]);
    let small = call(
        &mut d,
        "doc.compress",
        json!({"preset": "smallest"}),
        vec![],
    );
    let bal = call(&mut d, "doc.compress", json!({}), vec![]);
    let (h, b, s) = (
        high.blobs[0].len(),
        bal.blobs[0].len(),
        small.blobs[0].len(),
    );
    assert!(
        s < b && b < h && h < orig.len(),
        "{s} {b} {h} {}",
        orig.len()
    );
    // high quality: 300 dpi target, 1.5× tolerance: the 432-dpi lossless picture stays as it
    // is (lossless), the 480-dpi JPEG goes to 300 dpi
    assert_eq!(image_widths(&high.blobs[0]), vec![8, 10, 400, 900, 1000]);
    let hp = Pdf::open(high.blobs[0].clone(), None).unwrap();
    assert!(hp.objects().values().any(|o| matches!(o, Object::Stream(s) if s.dict.get(b"Width").ok().and_then(|w| w.as_i64().ok()) == Some(900) && s.dict.get(b"Filter").ok().and_then(|f| f.as_name().ok()) == Some(b"FlateDecode"))));
    let sp = Pdf::open(small.blobs[0].clone(), None).unwrap();
    let p = pages::flatten(&sp).unwrap()[0].id;
    assert!(!sp.get_dict(p).unwrap().has(b"Thumb"));
    assert!(!sp.get_dict(p).unwrap().has(b"PieceInfo"));
    assert!(small.json["extrasRemoved"].as_u64().unwrap() >= 2);
    let a = HayroRenderer::new(orig).unwrap().render(0, 1.0).unwrap();
    let b = HayroRenderer::new(small.blobs[0].clone())
        .unwrap()
        .render(0, 1.0)
        .unwrap();
    let diff = mean_diff(&a.rgba, &b.rgba);
    assert!(diff < 3.0, "mean pixel difference {diff}");
    assert_eq!(
        d.call("doc.compress", &json!({"preset": "tiny"}), vec![])
            .unwrap_err()
            .code,
        "invalid_params"
    );
}

#[test]
fn compress_keeps_protection_and_survives_hostile_images() {
    use warraq_core::warraq_pdf::crypt::PermissionFlags;
    use warraq_core::warraq_pdf::{Protection, SecurityHandler};
    let h = SecurityHandler::new_aes256("pw", "", &PermissionFlags::default()).unwrap();
    let enc = Pdf::open(heavy(), None)
        .unwrap()
        .write_full(Protection::New(h))
        .unwrap();
    let mut d = Document::open(enc, Some("pw")).unwrap();
    let r = call(&mut d, "doc.compress", json!({}), vec![]);
    assert!(Pdf::open(r.blobs[0].clone(), None).is_err());
    assert!(Pdf::open(r.blobs[0].clone(), Some("pw")).is_ok());
    // corrupt picture data: reported, not fatal
    let mut pdf = Pdf::open(heavy(), None).unwrap();
    let ids: Vec<_> = pdf.objects().keys().copied().collect();
    for id in ids {
        if let Some(Object::Stream(s)) = pdf.get(id).cloned() {
            if s.dict.get(b"Filter").ok().and_then(|f| f.as_name().ok()) == Some(b"DCTDecode") {
                let mut s = s.clone();
                s.content.truncate(300);
                pdf.set(id, Object::Stream(s));
            }
        }
    }
    let bytes = pdf.commit().unwrap();
    let mut d = Document::open(bytes, None).unwrap();
    let r = call(
        &mut d,
        "doc.compress",
        json!({"preset": "smallest"}),
        vec![],
    );
    let skipped = r.json["images"]["skipped"].as_array().unwrap();
    assert!(
        skipped.iter().any(|s| s["reason"] == "corrupt"),
        "{skipped:?}"
    );
}
