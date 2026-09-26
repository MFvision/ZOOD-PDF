//! Fixture builder for the redaction tests: real PDFs written with lopdf.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    dead_code
)]

use lopdf::{dictionary, Dictionary, Document, Object, ObjectId, Stream, StringFormat};
use warraq_pdf::limits::decode_stream;
use warraq_pdf::Pdf;
use warraq_text::shape::{content_stream, shape};

pub fn amiri() -> Vec<u8> {
    std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../../tests/corpus/fonts/amiri/Amiri-Regular.ttf"
    ))
    .unwrap()
}

pub fn utf16(s: &str) -> Object {
    let mut v = vec![0xFE, 0xFF];
    for u in s.encode_utf16() {
        v.extend_from_slice(&u.to_be_bytes());
    }
    Object::String(v, StringFormat::Hexadecimal)
}

/// A document under construction: one font set, pages added with raw content.
pub struct Builder {
    pub doc: Document,
    pub pages_id: ObjectId,
    pub kids: Vec<Object>,
    pub helv: ObjectId,
    pub amiri: Option<(ObjectId, Vec<(u32, f64)>)>,
    pub catalog: Dictionary,
}

impl Builder {
    pub fn new() -> Self {
        let mut doc = Document::with_version("1.7");
        let pages_id = doc.new_object_id();
        let helv = doc.add_object(dictionary! {
            "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica", "Encoding" => "WinAnsiEncoding",
        });
        Builder {
            doc,
            pages_id,
            kids: Vec::new(),
            helv,
            amiri: None,
            catalog: dictionary! {"Type" => "Catalog"},
        }
    }

    /// Shaped Arabic line (Amiri Identity-H, ToUnicode-less, per-word ActualText).
    pub fn arabic(&mut self, text: &str, x_right: f64, y: f64, size: f64) -> Vec<u8> {
        let font = amiri();
        let run = shape(text, &font, size).unwrap();
        let widths = &mut self.amiri.get_or_insert_with(|| ((0, 0), Vec::new())).1;
        for g in &run.glyphs {
            widths.push((g.glyph_id, g.x_advance / size * 1000.0));
        }
        content_stream(&run, "AR", x_right - run.width, y)
    }

    fn amiri_font(&mut self) -> Option<ObjectId> {
        let (_, widths) = self.amiri.clone()?;
        let font = amiri();
        let ff = self.doc.add_object(Stream::new(
            dictionary! {"Length1" => font.len() as i64},
            font,
        ));
        let fd = self.doc.add_object(dictionary! {
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
        let cid = self.doc.add_object(dictionary! {
            "Type" => "Font", "Subtype" => "CIDFontType2", "BaseFont" => "Amiri-Regular",
            "CIDSystemInfo" => dictionary! {"Registry" => Object::string_literal("Adobe"), "Ordering" => Object::string_literal("Identity"), "Supplement" => 0},
            "FontDescriptor" => fd, "W" => w, "CIDToGIDMap" => "Identity",
        });
        Some(self.doc.add_object(dictionary! {
            "Type" => "Font", "Subtype" => "Type0", "BaseFont" => "Amiri-Regular", "Encoding" => "Identity-H",
            "DescendantFonts" => vec![Object::Reference(cid)],
        }))
    }

    /// Add a page with `content` and extra resources/annotations.
    pub fn page(&mut self, content: &[u8], extra_res: Dictionary, annots: Vec<Object>) -> ObjectId {
        let c = self
            .doc
            .add_object(Stream::new(dictionary! {}, content.to_vec()));
        let mut res = dictionary! {"Font" => dictionary! {"F1" => self.helv}};
        for (k, v) in extra_res.iter() {
            res.set(k.clone(), v.clone());
        }
        let mut page = dictionary! {
            "Type" => "Page", "Parent" => self.pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
            "Resources" => res, "Contents" => c,
        };
        if !annots.is_empty() {
            page.set("Annots", Object::Array(annots));
        }
        let id = self.doc.add_object(page);
        self.kids.push(id.into());
        id
    }

    pub fn finish(mut self) -> Vec<u8> {
        if let Some(fid) = self.amiri_font() {
            // Patch every page's /AR font resource.
            for k in self.kids.clone() {
                let id = k.as_reference().unwrap();
                if let Ok(Object::Dictionary(p)) = self.doc.get_object_mut(id) {
                    if let Ok(Object::Dictionary(res)) = p.get_mut(b"Resources") {
                        if let Ok(Object::Dictionary(f)) = res.get_mut(b"Font") {
                            f.set("AR", fid);
                        }
                    }
                }
            }
        }
        let n = self.kids.len() as i64;
        self.doc.objects.insert(
            self.pages_id,
            Object::Dictionary(
                dictionary! {"Type" => "Pages", "Kids" => self.kids.clone(), "Count" => n},
            ),
        );
        let mut cat = self.catalog.clone();
        cat.set("Pages", self.pages_id);
        let cat_id = self.doc.add_object(cat);
        self.doc.trailer.set("Root", cat_id);
        let mut out = Vec::new();
        self.doc.save_to(&mut out).unwrap();
        out
    }
}

impl Default for Builder {
    fn default() -> Self {
        Self::new()
    }
}

/// All decoded stream contents plus the raw bytes of every object (for "nowhere in the file").
pub fn everything(pdf: &Pdf) -> Vec<u8> {
    let mut out = pdf.bytes().to_vec();
    for o in pdf.objects().values() {
        if let Object::Stream(s) = o {
            if let Ok(d) = decode_stream(s, pdf.limits()) {
                out.extend(d);
            }
        }
    }
    out
}

pub fn contains(hay: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && hay.windows(needle.len()).any(|w| w == needle)
}

pub fn plain(pdf: &Pdf) -> String {
    let src = warraq_text::DocSource::borrowed(pdf.document());
    let pages = warraq_text::extract_all(&src, &warraq_text::LayoutOptions::default()).unwrap();
    warraq_text::plain_text(&pages)
}

pub fn utf16_bytes(s: &str) -> Vec<u8> {
    s.encode_utf16().flat_map(|u| u.to_be_bytes()).collect()
}
