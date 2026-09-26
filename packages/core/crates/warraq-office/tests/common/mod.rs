//! Test helpers: a tiny PDF builder (Amiri, shaped with harfrust, per-word /ActualText, no
//! ToUnicode — the text can only come back through the extractor's logical-order logic), ruling
//! lines, the corpus location and an accuracy metric.
#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::collections::BTreeMap;
use std::path::PathBuf;

use lopdf::{dictionary, Document, Object, Stream};
use warraq_text::shape::{content_stream, shape};

pub fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../..")
        .canonicalize()
        .unwrap()
}

pub fn corpus(name: &str) -> Vec<u8> {
    std::fs::read(repo().join("tests/corpus/pdf").join(name)).unwrap()
}

pub fn truth(name: &str) -> String {
    std::fs::read_to_string(repo().join("tests/corpus/truth").join(name)).unwrap()
}

fn amiri() -> Vec<u8> {
    std::fs::read(repo().join("tests/corpus/fonts/amiri/Amiri-Regular.ttf")).unwrap()
}

/// Page builder: 595 × 842 pt (A4), y measured from the TOP of the page.
pub struct PageBuilder {
    font: Vec<u8>,
    content: Vec<u8>,
    widths: BTreeMap<u32, f64>,
}

impl Default for PageBuilder {
    fn default() -> Self {
        Self::new()
    }
}

impl PageBuilder {
    pub const H: f64 = 842.0;

    pub fn new() -> Self {
        PageBuilder {
            font: amiri(),
            content: Vec::new(),
            widths: BTreeMap::new(),
        }
    }

    /// Draw `text` with its baseline at `top` (from the page top). `right`: right-align at `x`,
    /// else left-align at `x`.
    pub fn text(&mut self, x: f64, top: f64, text: &str, size: f64, right: bool) -> &mut Self {
        let run = shape(text, &self.font, size).unwrap();
        for g in &run.glyphs {
            self.widths.insert(g.glyph_id, g.x_advance / size * 1000.0);
        }
        let x0 = if right { x - run.width } else { x };
        self.content
            .extend(content_stream(&run, "F1", x0, Self::H - top));
        self.content.push(b'\n');
        self
    }

    /// Stroke a line (coordinates from the page top).
    pub fn line(&mut self, x0: f64, t0: f64, x1: f64, t1: f64) -> &mut Self {
        self.content.extend(
            format!(
                "q 0.8 w {x0} {} m {x1} {} l S Q\n",
                Self::H - t0,
                Self::H - t1
            )
            .as_bytes(),
        );
        self
    }

    /// A ruled grid with the given column boundaries (x) and row boundaries (from the top).
    pub fn grid(&mut self, xs: &[f64], tops: &[f64]) -> &mut Self {
        let (x0, x1) = (xs[0], *xs.last().unwrap());
        let (t0, t1) = (tops[0], *tops.last().unwrap());
        for &t in tops {
            self.line(x0, t, x1, t);
        }
        for &x in xs {
            self.line(x, t0, x, t1);
        }
        self
    }
}

/// Build a document from pages.
pub fn build(pages: &[&PageBuilder]) -> Vec<u8> {
    let font = pages[0].font.clone();
    let mut widths = BTreeMap::new();
    for p in pages {
        widths.extend(p.widths.iter().map(|(k, v)| (*k, *v)));
    }
    let mut doc = Document::with_version("1.7");
    let ff = doc.add_object(Stream::new(
        dictionary! {"Length1" => font.len() as i64},
        font,
    ));
    let fd = doc.add_object(dictionary! {
        "Type" => "FontDescriptor", "FontName" => "Amiri-Regular", "Flags" => 4,
        "FontBBox" => vec![(-500).into(), (-700).into(), 1500.into(), 1200.into()], "ItalicAngle" => 0,
        "Ascent" => 1100, "Descent" => -600, "CapHeight" => 700, "StemV" => 80, "FontFile2" => ff,
    });
    let w: Vec<Object> = widths
        .iter()
        .flat_map(|(g, w)| {
            [
                Object::Integer(i64::from(*g)),
                Object::Array(vec![Object::Real(*w as f32)]),
            ]
        })
        .collect();
    let cid = doc.add_object(dictionary! {
        "Type" => "Font", "Subtype" => "CIDFontType2", "BaseFont" => "Amiri-Regular",
        "CIDSystemInfo" => dictionary! {"Registry" => Object::string_literal("Adobe"), "Ordering" => Object::string_literal("Identity"), "Supplement" => 0},
        "FontDescriptor" => fd, "W" => w, "CIDToGIDMap" => "Identity",
    });
    let f1 = doc.add_object(dictionary! {
        "Type" => "Font", "Subtype" => "Type0", "BaseFont" => "Amiri-Regular", "Encoding" => "Identity-H",
        "DescendantFonts" => vec![Object::Reference(cid)],
    });
    let pages_id = doc.new_object_id();
    let mut kids = Vec::new();
    for p in pages {
        let contents = doc.add_object(Stream::new(dictionary! {}, p.content.clone()));
        let page = doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages_id, "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
            "Resources" => dictionary! {"Font" => dictionary! {"F1" => f1}}, "Contents" => contents,
        });
        kids.push(Object::Reference(page));
    }
    let count = kids.len() as i64;
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {"Type" => "Pages", "Kids" => kids, "Count" => count}),
    );
    let catalog = doc.add_object(dictionary! {"Type" => "Catalog", "Pages" => pages_id});
    doc.trailer.set("Root", catalog);
    let mut out = Vec::new();
    doc.save_to(&mut out).unwrap();
    out
}

/// Whitespace-collapsed character accuracy (1 − Levenshtein / truth length), as in the acid gate.
pub fn accuracy(got: &str, truth: &str) -> f64 {
    let norm = |s: &str| -> Vec<char> {
        s.split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .chars()
            .filter(|c| !matches!(c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{061C}' | '\u{FEFF}'))
            .collect()
    };
    let (a, b) = (norm(got), norm(truth));
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut cur = vec![i + 1; b.len() + 1];
        for (j, cb) in b.iter().enumerate() {
            cur[j + 1] = (prev[j] + usize::from(ca != cb))
                .min(prev[j + 1] + 1)
                .min(cur[j] + 1);
        }
        prev = cur;
    }
    1.0 - prev[b.len()] as f64 / b.len().max(1) as f64
}

/// Unzip into a name → bytes map.
pub fn unzip(bytes: &[u8]) -> BTreeMap<String, Vec<u8>> {
    warraq_office::zip::read(bytes, 256 << 20)
        .unwrap()
        .into_iter()
        .collect()
}

/// Parse XML with quick-xml (an independent parser) and fail on any error.
pub fn assert_well_formed(name: &str, xml: &[u8]) {
    let mut r = quick_xml::Reader::from_reader(xml);
    let mut buf = Vec::new();
    let mut depth = 0i64;
    loop {
        match r.read_event_into(&mut buf) {
            Ok(quick_xml::events::Event::Start(_)) => depth += 1,
            Ok(quick_xml::events::Event::End(_)) => depth -= 1,
            Ok(quick_xml::events::Event::Eof) => break,
            Ok(_) => {}
            Err(e) => panic!("{name}: {e}"),
        }
        buf.clear();
    }
    assert_eq!(depth, 0, "{name}: unbalanced");
}

/// Texts of every `tag` element (e.g. `w:t`), and, for each `w:p`, its concatenated text plus
/// the child element names seen inside it.
pub fn texts_of(xml: &[u8], tag: &str) -> Vec<String> {
    let mut r = quick_xml::Reader::from_reader(xml);
    let mut buf = Vec::new();
    let mut out = Vec::new();
    let mut inside = false;
    loop {
        match r.read_event_into(&mut buf).unwrap() {
            quick_xml::events::Event::Start(e) if e.name().as_ref() == tag => {
                inside = true;
                out.push(String::new());
            }
            quick_xml::events::Event::End(e) if e.name().as_ref() == tag => inside = false,
            quick_xml::events::Event::Text(t) if inside => {
                let s = t.xml10_content().into_owned();
                out.last_mut().unwrap().push_str(&s);
            }
            quick_xml::events::Event::GeneralRef(e) if inside => {
                let name = e.as_ref().to_string();
                let ch = match name.as_str() {
                    "amp" => "&",
                    "lt" => "<",
                    "gt" => ">",
                    "quot" => "\"",
                    "#39" | "apos" => "'",
                    _ => "?",
                };
                out.last_mut().unwrap().push_str(ch);
            }
            quick_xml::events::Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    out
}

pub fn unescape(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

/// DOCX paragraphs of our own output: (text, has `<w:bidi/>`, every run holding Arabic has
/// `<w:rtl/>`). Well-formedness is checked separately with quick-xml.
pub fn docx_paragraphs(xml: &str) -> Vec<(String, bool, bool)> {
    let mut out = Vec::new();
    for p in xml.split("<w:p>").skip(1) {
        let body = p.split("</w:p>").next().unwrap_or("");
        let bidi = body.contains("<w:bidi/>");
        let mut text = String::new();
        let mut rtl_ok = true;
        for r in body.split("<w:r>").skip(1) {
            let r = r.split("</w:r>").next().unwrap_or("");
            let t = r
                .split("<w:t xml:space=\"preserve\">")
                .nth(1)
                .and_then(|x| x.split("</w:t>").next())
                .map(unescape)
                .unwrap_or_default();
            if t.chars().any(|c| ('\u{0620}'..='\u{064A}').contains(&c)) && !r.contains("<w:rtl/>")
            {
                rtl_ok = false;
            }
            text.push_str(&t);
        }
        out.push((text, bidi, rtl_ok));
    }
    out
}
