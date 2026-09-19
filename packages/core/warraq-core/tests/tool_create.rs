//! Create through `call_static`, the way the interface reaches it: a
//! document of blocks and a file of pictures come out as PDFs whose text
//! Warraq's own reader reads back as it was typed, in reading order, laid
//! out where it should be, and whose pictures are upright.
use serde_json::{json, Value};
use warraq_core::{call_static, Document, Reply};

const AMIRI: &[u8] = include_bytes!("../../../../tests/fonts/Amiri-Regular.ttf");
const INTER: &[u8] = include_bytes!("../../../../tests/fonts/Inter-Variable.ttf");

const A4: (f32, f32) = (595.28, 841.89);
const MARGIN: f32 = 56.0;

fn value(reply: &Reply) -> Value {
    serde_json::from_str(&reply.json).unwrap()
}

/// `create.document` of `blocks`, Amiri as blob 0 and `pictures` after it.
fn document(blocks: Value, pictures: Vec<Vec<u8>>) -> (Vec<u8>, Value) {
    let indices: Vec<usize> = (1..=pictures.len()).collect();
    let mut blobs = vec![AMIRI.to_vec()];
    blobs.extend(pictures);
    let reply = call_static(
        "create.document",
        &json!({
            "page": { "width": A4.0, "height": A4.1, "margins": [MARGIN, MARGIN, MARGIN, MARGIN] },
            "blocks": blocks,
            "fonts": [0],
            "fontNames": ["Amiri"],
            "pictures": indices,
            "title": "تقرير",
            "lang": "ar",
            "created": "D:20260919120000Z",
        })
        .to_string(),
        blobs,
    )
    .unwrap();
    let v = value(&reply);
    (reply.blobs.into_iter().next().unwrap(), v)
}

fn text(pdf: &[u8]) -> Vec<String> {
    let doc = Document::open(pdf.to_vec(), None).unwrap();
    (0..doc.page_count())
        .map(|i| doc.extract_text(i).unwrap())
        .collect()
}

/// A picture of one colour, as PNG.
fn png(width: u32, height: u32, rgb: [u8; 3]) -> Vec<u8> {
    let image = image::RgbImage::from_pixel(width, height, image::Rgb(rgb));
    let mut out = Vec::new();
    image::DynamicImage::ImageRgb8(image)
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .unwrap();
    out
}

/// A JPEG whose left half is red and right half blue, stored `width` wide,
/// with an EXIF block that says to turn it (`orientation`) and a resolution.
fn jpeg(width: u32, height: u32, orientation: u16, dpi: u32) -> Vec<u8> {
    let image = image::RgbImage::from_fn(width, height, |x, _| {
        if x < width / 2 {
            image::Rgb([230, 20, 20])
        } else {
            image::Rgb([20, 20, 230])
        }
    });
    let mut plain = Vec::new();
    image::DynamicImage::ImageRgb8(image)
        .write_to(
            &mut std::io::Cursor::new(&mut plain),
            image::ImageFormat::Jpeg,
        )
        .unwrap();
    // TIFF, big-endian: IFD0 with Orientation, XResolution (a rational
    // after the IFD) and ResolutionUnit = inch.
    let mut tiff = b"MM\0\x2a\0\0\0\x08".to_vec();
    tiff.extend(3u16.to_be_bytes());
    let entry = |tag: u16, kind: u16, count: u32, value: u32| {
        let mut e = tag.to_be_bytes().to_vec();
        e.extend(kind.to_be_bytes());
        e.extend(count.to_be_bytes());
        e.extend(value.to_be_bytes());
        e
    };
    tiff.extend(entry(0x0112, 3, 1, (orientation as u32) << 16));
    tiff.extend(entry(0x011A, 5, 1, 8 + 2 + 3 * 12 + 4));
    tiff.extend(entry(0x0128, 3, 1, 2 << 16));
    tiff.extend(0u32.to_be_bytes());
    tiff.extend(dpi.to_be_bytes());
    tiff.extend(1u32.to_be_bytes());
    let mut app1 = b"Exif\0\0".to_vec();
    app1.extend(tiff);
    let mut out = vec![0xFF, 0xD8, 0xFF, 0xE1];
    out.extend(((app1.len() + 2) as u16).to_be_bytes());
    out.extend(app1);
    out.extend(&plain[2..]);
    out
}

/// The colour of the page at a point, as a share of the way across and down.
fn colour_at(pdf: &[u8], page: usize, fx: f32, fy: f32) -> [u8; 3] {
    let doc = Document::open(pdf.to_vec(), None).unwrap();
    let bitmap = doc.render_page(page, 0.5).unwrap();
    let x = ((bitmap.width as f32 * fx) as u32).min(bitmap.width - 1);
    let y = ((bitmap.height as f32 * fy) as u32).min(bitmap.height - 1);
    let at = ((y * bitmap.width + x) * 4) as usize;
    [bitmap.rgba[at], bitmap.rgba[at + 1], bitmap.rgba[at + 2]]
}

/// Where each picture of a page lands, as `images.list` says (y down).
fn placed(pdf: &[u8], page: usize) -> Vec<[f32; 6]> {
    let reply = call_static(
        "images.list",
        &json!({ "page": page }).to_string(),
        vec![pdf.to_vec()],
    )
    .unwrap();
    value(&reply)["images"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| {
            let m: Vec<f32> = i["matrix"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_f64().unwrap() as f32)
                .collect();
            [m[0], m[1], m[2], m[3], m[4], m[5]]
        })
        .collect()
}

fn reddish(c: [u8; 3]) -> bool {
    c[0] > 150 && c[1] < 110 && c[2] < 110
}

fn bluish(c: [u8; 3]) -> bool {
    c[2] > 150 && c[0] < 110 && c[1] < 110
}

const BODY: &str = "تتحدث هذه الفقرة عن نص عربي طويل بما يكفي ليلتف على أكثر من سطر واحد، وتبقى كلماته بترتيب القراءة كما كتبت تماماً دون أن ينقلب شيء منها.";

#[test]
fn an_arabic_document_reads_back_as_typed_in_reading_order() {
    let (pdf, report) = document(
        json!([
            { "type": "text", "text": "التقرير السنوي", "size": 20, "bold": true, "keepWithNext": true, "spaceAfter": 10 },
            { "type": "text", "text": BODY, "align": "justify" },
            { "type": "text", "text": "The second paragraph is English, left to right.", "dir": "ltr" },
            { "type": "text", "text": "البند الأول", "marker": "•", "indent": 18 },
            { "type": "text", "text": "البند الثاني", "marker": "٢.", "indent": 18 },
            { "type": "rule" },
            { "type": "table", "headerRows": 1, "widths": [2, 1], "rows": [
                [{ "text": "الصنف" }, { "text": "الكمية" }],
                [{ "text": "ورق" }, { "text": "12" }],
            ] },
        ]),
        vec![],
    );
    assert_eq!(report["pages"], 1);
    assert_eq!(report["missingGlyphs"], 0);
    let pages = text(&pdf);
    let page = &pages[0];
    for needle in [
        "التقرير السنوي",
        "The second paragraph is English, left to right.",
        "البند الأول",
        "البند الثاني",
        "الصنف",
        "الكمية",
        "ورق",
    ] {
        assert!(page.contains(needle), "{needle:?} is missing from:\n{page}");
    }
    // The long paragraph wraps, and its words come back in order.
    let joined = page.replace('\n', " ");
    assert!(
        joined.contains(BODY),
        "the paragraph reads back whole:\n{page}"
    );
    assert!(page.find("التقرير").unwrap() < page.find("تتحدث").unwrap());
    assert!(page.find("تتحدث").unwrap() < page.find("The second").unwrap());

    // Arabic lines end at the right margin; the English one starts at the left.
    let doc = Document::open(pdf.clone(), None).unwrap();
    let lines = doc.text_lines(0).unwrap();
    let right = A4.0 - MARGIN;
    let heading = lines.iter().find(|l| l.text.contains("التقرير")).unwrap();
    assert!(
        (heading.x + heading.width - right).abs() < 3.0,
        "heading at the right: {heading:?}"
    );
    let english = lines
        .iter()
        .find(|l| l.text.starts_with("The second"))
        .unwrap();
    assert!(
        (english.x - MARGIN).abs() < 3.0,
        "English at the left: {english:?}"
    );
    // A justified line runs from margin to margin.
    let first = lines.iter().find(|l| l.text.starts_with("تتحدث")).unwrap();
    assert!(
        (first.x - MARGIN).abs() < 3.0 && (first.x + first.width - right).abs() < 3.0,
        "{first:?}"
    );
    // A list item reads with its marker first, the marker hung in the
    // indent: inside the margin, right of the item's text.
    let item = lines
        .iter()
        .find(|l| l.text.contains("البند الأول"))
        .unwrap();
    assert_eq!(item.text, "• البند الأول");
    assert!(item.x + item.width <= right + 0.5, "{item:?}");
    let second = lines
        .iter()
        .find(|l| l.text.contains("البند الثاني"))
        .unwrap();
    assert_eq!(
        second.text, "٢. البند الثاني",
        "the number reads before the item"
    );

    // What the file says about itself.
    let raw = String::from_utf8_lossy(&pdf);
    assert!(raw.contains("/Lang"));
    // PDFium reads every line of an R2L file backwards; it has none.
    assert!(!raw.contains("R2L"));
    // A number cell of a right-to-left table takes the table's direction:
    // aligned to the end is to the left.
    assert!(page.contains("ورق 12"), "{page}");
}

#[test]
fn long_text_flows_onto_further_pages_word_for_word() {
    let paragraphs: Vec<String> = (1..=60)
        .map(|k| format!("الفقرة رقم {k}: {BODY}"))
        .collect();
    let blocks: Vec<Value> = paragraphs
        .iter()
        .map(|p| json!({ "type": "text", "text": p }))
        .collect();
    let (pdf, report) = document(Value::Array(blocks), vec![]);
    let pages = text(&pdf);
    assert!(pages.len() >= 4, "{} pages", pages.len());
    assert_eq!(report["pages"], pages.len());
    let all = pages.join("\n").replace('\n', " ");
    let mut from = 0;
    for p in &paragraphs {
        let at = all[from..]
            .find(p.as_str())
            .unwrap_or_else(|| panic!("{p:?} is missing or out of order"));
        from += at + p.len();
    }
    // Nothing is written below the bottom margin.
    let doc = Document::open(pdf, None).unwrap();
    for i in 0..doc.page_count() {
        for line in doc.text_lines(i).unwrap() {
            assert!(
                line.y + line.height < A4.1 - MARGIN + 12.0,
                "page {i}: {line:?}"
            );
            assert!(line.y > MARGIN - 12.0, "page {i}: {line:?}");
        }
    }
}

#[test]
fn a_table_that_runs_onto_another_page_repeats_its_header() {
    let mut rows = vec![json!([{ "text": "رقم" }, { "text": "الوصف" }, { "text": "المبلغ" }])];
    for k in 1..=80 {
        rows.push(json!([{ "text": k.to_string() }, { "text": format!("بند رقم {k}") }, { "text": format!("{}.00", k * 10) }]));
    }
    let (pdf, _) = document(
        json!([{ "type": "table", "headerRows": 1, "rows": rows }]),
        vec![],
    );
    let pages = text(&pdf);
    assert!(pages.len() >= 2);
    for (i, page) in pages.iter().enumerate() {
        assert!(page.contains("الوصف"), "page {i} has the header:\n{page}");
    }
    let all = pages.join("\n");
    for k in [1, 40, 80] {
        assert!(all.contains(&format!("بند رقم {k}")), "row {k}");
    }
    // Right to left: the first column is on the right, so the header reads
    // in the order of the columns.
    let doc = Document::open(pdf, None).unwrap();
    let lines = doc.text_lines(0).unwrap();
    let header = lines.iter().find(|l| l.text.contains("المبلغ")).unwrap();
    assert_eq!(header.text, "رقم الوصف المبلغ");
    assert!(header.x + header.width > A4.0 - MARGIN - 10.0, "{header:?}");
}

#[test]
fn a_cell_taller_than_a_page_breaks_between_its_lines() {
    let long: String = (1..=400).map(|k| format!("كلمة{k} ")).collect();
    let (pdf, _) = document(
        json!([{ "type": "table", "rows": [[{ "text": long.trim() }, { "text": "قصير" }]] }]),
        vec![],
    );
    let pages = text(&pdf);
    assert!(pages.len() >= 2, "{} pages", pages.len());
    let all = pages.join(" ").replace('\n', " ");
    for k in [1, 200, 400] {
        assert!(all.contains(&format!("كلمة{k}")), "word {k}");
    }
}

#[test]
fn pictures_in_a_document_are_placed_and_one_that_cannot_be_read_is_left_out() {
    let (pdf, report) = document(
        json!([
            { "type": "text", "text": "صورة:" },
            { "type": "image", "index": 0, "width": 200, "align": "center" },
            { "type": "image", "index": 1 },
            { "type": "pageBreak" },
            { "type": "text", "text": "بعد الفاصل" },
        ]),
        vec![png(40, 20, [220, 20, 20]), b"not a picture".to_vec()],
    );
    assert_eq!(report["picturesLeftOut"], 1);
    assert_eq!(report["pages"], 2);
    let pages = text(&pdf);
    assert!(pages[1].contains("بعد الفاصل"));
    // 200 x 100 points, centred under the first line.
    let pictures = placed(&pdf, 0);
    assert_eq!(pictures.len(), 1);
    let m = pictures[0];
    assert!(
        (m[0].abs() - 200.0).abs() < 0.5 && (m[3].abs() - 100.0).abs() < 0.5,
        "{m:?}"
    );
    let left = m[4].min(m[4] + m[0]);
    assert!((left - (A4.0 - 200.0) / 2.0).abs() < 0.5, "centred: {m:?}");
    let middle = m[5] + m[3] / 2.0;
    assert!(reddish(colour_at(&pdf, 0, 0.5, middle / A4.1)), "{m:?}");
}

#[test]
fn a_face_without_the_letters_falls_back_to_one_that_has_them() {
    let reply = call_static(
        "create.document",
        &json!({
            "page": { "width": 612, "height": 792, "margins": [72, 72, 72, 72] },
            "blocks": [
                { "type": "text", "text": "Inter sets the English." },
                { "type": "text", "text": "وأميري العربية" },
                { "type": "text", "text": "漢字 has no face here" },
            ],
            "fonts": [0, 1],
            "fontNames": ["Inter", "Amiri"],
        })
        .to_string(),
        vec![INTER.to_vec(), AMIRI.to_vec()],
    )
    .unwrap();
    let v = value(&reply);
    assert_eq!(v["missingGlyphs"], 2, "the two Han characters");
    let pages = text(&reply.blobs[0]);
    assert!(pages[0].contains("Inter sets the English."));
    assert!(pages[0].contains("وأميري العربية"));
    let raw = String::from_utf8_lossy(&reply.blobs[0]);
    assert!(raw.contains("WARRAQ+Inter") && raw.contains("WARRAQ+Amiri"));
}

#[test]
fn a_photo_goes_in_upright_without_loss_and_pages_take_its_shape() {
    // Stored 80 wide and 40 tall, red then blue across; the camera says to
    // turn it a quarter clockwise, so it is seen 40 wide and 80 tall, red
    // on top.
    let photo = jpeg(80, 40, 6, 144);
    let reply = call_static(
        "create.images",
        &json!({ "paper": "own", "title": "صور" }).to_string(),
        vec![
            photo.clone(),
            png(300, 150, [20, 200, 20]),
            b"broken".to_vec(),
        ],
    )
    .unwrap();
    let v = value(&reply);
    assert_eq!(v["pages"], 2);
    assert_eq!(v["leftOut"], json!([2]));
    let pdf = &reply.blobs[0];
    let doc = Document::open(pdf.clone(), None).unwrap();
    // 144 dpi: 40 x 80 pixels are 20 x 40 points — grown to the one-inch minimum.
    let (w, h) = doc.page_size(0).unwrap();
    assert!(
        (w - 72.0).abs() < 0.5 && (h - 144.0).abs() < 0.5,
        "{w} x {h}"
    );
    // No resolution recorded: 96 per inch.
    let (w, h) = doc.page_size(1).unwrap();
    assert!(
        (w - 225.0).abs() < 0.5 && (h - 112.5).abs() < 0.5,
        "{w} x {h}"
    );
    assert!(reddish(colour_at(pdf, 0, 0.5, 0.2)), "red on top");
    assert!(bluish(colour_at(pdf, 0, 0.5, 0.8)), "blue below");
    // The JPEG's own bytes are in the file.
    let raw = pdf.windows(photo.len()).any(|w| w == photo.as_slice());
    assert!(raw, "the JPEG is kept as it was");
}

#[test]
fn on_paper_each_picture_is_fitted_centred_and_the_page_turned_to_suit_it() {
    let reply = call_static(
        "create.images",
        &json!({ "paper": { "width": A4.0, "height": A4.1 }, "margin": 36 }).to_string(),
        vec![png(400, 200, [220, 20, 20]), png(100, 300, [20, 20, 220])],
    )
    .unwrap();
    let pdf = &reply.blobs[0];
    let doc = Document::open(pdf.clone(), None).unwrap();
    let (w, h) = doc.page_size(0).unwrap();
    assert!(w > h, "a wide picture gets a landscape page");
    let (w, h) = doc.page_size(1).unwrap();
    assert!(h > w, "a tall one a portrait page");
    let m = placed(pdf, 1)[0];
    // 100 x 300 fitted into 523 x 770: 770 tall, centred across.
    assert!((m[3].abs() - (A4.1 - 72.0)).abs() < 0.5, "{m:?}");
    assert!((m[4] + m[0] / 2.0 - A4.0 / 2.0).abs() < 0.5, "{m:?}");
    assert!(bluish(colour_at(pdf, 1, 0.5, 0.5)));
}

#[test]
fn nonsense_is_refused_with_a_reason() {
    let err = call_static(
        "create.document",
        &json!({ "page": { "width": 5, "height": 5 }, "blocks": [], "fonts": [0] }).to_string(),
        vec![AMIRI.to_vec()],
    )
    .unwrap_err()
    .to_string();
    assert!(err.contains("E_CREATE"), "{err}");
    let err = call_static(
        "create.document",
        &json!({ "page": { "width": 600, "height": 800 }, "blocks": [], "fonts": [3] }).to_string(),
        vec![AMIRI.to_vec()],
    )
    .unwrap_err()
    .to_string();
    assert!(err.starts_with("E_ARGS"), "{err}");
    let err = call_static(
        "create.images",
        &json!({ "paper": "own" }).to_string(),
        vec![b"nothing".to_vec()],
    )
    .unwrap_err()
    .to_string();
    assert!(err.contains("E_IMAGE"), "{err}");
}
