//! Page marks: watermarks, headers and footers, page numbers and Bates
//! numbers (`warraq_pdf::marks`). The tool works on the file as it stands —
//! the view on screen is EmbedPDF's — so every operation takes the PDF and
//! the add and remove give back a new one, written as an incremental update
//! (sealed with the file's own key when it is protected).
use serde::Deserialize;
use warraq_pdf::{
    Anchor, Digits, HAlign, MarkContent, MarkKind, NumberFormat, PageMark, PdfDocument,
    SlotDirection, VAlign,
};

use super::{args, Reply};
use crate::{CoreError, Document};

/// A mark as the interface describes it; `spec` is kept in the file as sent.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Spec {
    kind: String,
    #[serde(default)]
    text: Option<String>,
    /// The picture's width as a share of the page's, for an image watermark.
    #[serde(default)]
    image_width: Option<f32>,
    #[serde(default = "centre")]
    position: String,
    #[serde(default)]
    slots: Option<[String; 3]>,
    #[serde(default)]
    direction: Option<String>,
    #[serde(default)]
    format: Option<String>,
    #[serde(default = "one")]
    start: u64,
    #[serde(default)]
    skip_first: bool,
    #[serde(default)]
    prefix: String,
    #[serde(default)]
    suffix: String,
    /// Bates numbers are zero-padded to this many digits.
    #[serde(default = "six")]
    width: usize,
    #[serde(default = "twelve")]
    size: f32,
    #[serde(default)]
    color: Option<String>,
    #[serde(default = "one_f")]
    opacity: f32,
    #[serde(default)]
    rotation: f32,
    #[serde(default = "margin")]
    margin_x: f32,
    #[serde(default = "margin")]
    margin_y: f32,
    #[serde(default = "yes")]
    front: bool,
    /// `western` or `arabic` (Arabic-Indic).
    #[serde(default)]
    numerals: Option<String>,
    #[serde(default)]
    date: String,
    #[serde(default)]
    file_name: String,
    #[serde(default)]
    modified: String,
}

fn centre() -> String {
    "center".into()
}
fn one() -> u64 {
    1
}
fn one_f() -> f32 {
    1.0
}
fn six() -> usize {
    6
}
fn twelve() -> f32 {
    12.0
}
fn margin() -> f32 {
    36.0
}
fn yes() -> bool {
    true
}

fn bad(what: &str) -> CoreError {
    CoreError::Args(what.into())
}

fn anchor(position: &str) -> Result<Anchor, CoreError> {
    let (v, h) = match position {
        "topLeft" => (VAlign::Top, HAlign::Left),
        "top" => (VAlign::Top, HAlign::Center),
        "topRight" => (VAlign::Top, HAlign::Right),
        "left" => (VAlign::Middle, HAlign::Left),
        "center" | "tiled" => (VAlign::Middle, HAlign::Center),
        "right" => (VAlign::Middle, HAlign::Right),
        "bottomLeft" => (VAlign::Bottom, HAlign::Left),
        "bottom" => (VAlign::Bottom, HAlign::Center),
        "bottomRight" => (VAlign::Bottom, HAlign::Right),
        other => return Err(bad(&format!("no position called {other}"))),
    };
    Ok(Anchor { h, v })
}

/// `#rrggbb` as RGB from 0 to 1; black when it is not one.
fn colour(hex: Option<&str>) -> [f32; 3] {
    let Some(hex) = hex
        .and_then(|h| h.strip_prefix('#'))
        .filter(|h| h.len() == 6)
    else {
        return [0.0, 0.0, 0.0];
    };
    let channel = |k: usize| {
        u8::from_str_radix(hex.get(k..k + 2).unwrap_or("00"), 16).unwrap_or(0) as f32 / 255.0
    };
    [channel(0), channel(2), channel(4)]
}

impl Spec {
    fn into_mark(self, json: String, image: Option<Vec<u8>>) -> Result<PageMark, CoreError> {
        let kind = MarkKind::parse(&self.kind).ok_or_else(|| bad("no such kind of mark"))?;
        let at = anchor(&self.position)?;
        let content = match kind {
            MarkKind::Watermark => MarkContent::Watermark {
                text: self.text.filter(|t| !t.trim().is_empty()),
                image: image.map(|bytes| (bytes, self.image_width.unwrap_or(0.4))),
                anchor: at,
                tiled: self.position == "tiled",
            },
            MarkKind::Header | MarkKind::Footer => MarkContent::Band {
                slots: self
                    .slots
                    .ok_or_else(|| bad("a header or footer needs its slots"))?,
                direction: match self.direction.as_deref() {
                    Some("rtl") => SlotDirection::Rtl,
                    Some("ltr") => SlotDirection::Ltr,
                    _ => SlotDirection::Auto,
                },
            },
            MarkKind::PageNumber => MarkContent::PageNumber {
                format: match self.format.as_deref().unwrap_or("plain") {
                    "plain" => NumberFormat::Plain,
                    "ofTotal" => NumberFormat::OfTotal,
                    "pageOfEnglish" => NumberFormat::PageOfEnglish,
                    "pageOfArabic" => NumberFormat::PageOfArabic,
                    "roman" => NumberFormat::Roman,
                    other => return Err(bad(&format!("no number format called {other}"))),
                },
                anchor: at,
                start: u32::try_from(self.start).map_err(|_| bad("the start number is too big"))?,
                skip_first: self.skip_first,
            },
            MarkKind::Bates => MarkContent::Bates {
                prefix: self.prefix,
                suffix: self.suffix,
                start: self.start,
                width: self.width,
                anchor: at,
            },
        };
        Ok(PageMark {
            kind,
            content,
            size: self.size,
            color: colour(self.color.as_deref()),
            opacity: self.opacity,
            rotation: if self.rotation.is_finite() {
                self.rotation
            } else {
                0.0
            },
            margin: (
                self.margin_x.clamp(0.0, 500.0),
                self.margin_y.clamp(0.0, 500.0),
            ),
            front: self.front,
            digits: if self.numerals.as_deref() == Some("arabic") {
                Digits::ArabicIndic
            } else {
                Digits::Western
            },
            date: self.date,
            file_name: self.file_name,
            spec: json,
            modified: self.modified,
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Add {
    #[serde(default)]
    password: Option<String>,
    mark: serde_json::Value,
    /// 0-based; absent or empty is every page.
    #[serde(default)]
    pages: Vec<usize>,
    /// Marks of the same kind on these pages go first.
    #[serde(default = "yes")]
    replace: bool,
    /// Which blob is the font and which the picture (the PDF is blob 0).
    #[serde(default)]
    font_blob: Option<usize>,
    #[serde(default)]
    image_blob: Option<usize>,
    /// Preview only: the page to draw, and at what scale.
    #[serde(default)]
    page: usize,
    #[serde(default = "one_f")]
    scale: f32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Remove {
    #[serde(default)]
    password: Option<String>,
    #[serde(default)]
    ids: Vec<u32>,
    #[serde(default)]
    pages: Vec<usize>,
}

#[derive(Deserialize)]
struct Read {
    #[serde(default)]
    password: Option<String>,
    #[serde(default)]
    page: usize,
}

/// The file after a change, as an update of the bytes it came as.
fn updated(doc: &mut PdfDocument) -> Result<Vec<u8>, CoreError> {
    Ok(match doc.save_incremental() {
        Ok(bytes) => bytes,
        // Never trade a file's protection for a page mark.
        Err(e) if doc.was_encrypted() => return Err(e.into()),
        Err(_) => doc.save_to_vec()?,
    })
}

/// Opens the PDF and makes the mark `a` asks for.
fn marked(a: &Add, blobs: &[Vec<u8>], preview: bool) -> Result<(PdfDocument, u32), CoreError> {
    let pdf = blobs.first().ok_or_else(|| bad("marks take the PDF"))?;
    let blob = |k: Option<usize>| k.and_then(|k| blobs.get(k).filter(|_| k > 0));
    let json = a.mark.to_string();
    let spec: Spec = serde_json::from_value(a.mark.clone()).map_err(|e| bad(&e.to_string()))?;
    let mark = spec.into_mark(json, blob(a.image_blob).cloned())?;
    let mut doc = PdfDocument::open(pdf.clone(), a.password.as_deref())?;
    let font = blob(a.font_blob).map(Vec::as_slice);
    if preview {
        doc.preview_mark(&mark, &a.pages, font, a.replace, a.page)?;
        return Ok((doc, 0));
    }
    let id = doc.add_mark(&mark, &a.pages, font, a.replace)?;
    Ok((doc, id))
}

pub fn call_static(name: &str, json: &str, blobs: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    match name {
        // blobs: the PDF, then the font and the picture as `fontBlob` and
        // `imageBlob` say.
        "add" => {
            let a: Add = args(json)?;
            let (mut doc, id) = marked(&a, &blobs, false)?;
            let bytes = updated(&mut doc)?;
            Ok(Reply::of(&serde_json::json!({ "id": id }))?.with_blob(bytes))
        }
        // The same, drawn on one page rather than saved: RGBA pixels, as
        // `render_page` gives them, of the page the mark is being made on.
        "preview" => {
            let a: Add = args(json)?;
            let (doc, _) = marked(&a, &blobs, true)?;
            let one = doc.extract_pages(&[a.page])?;
            let page = warraq_render::open(one, None)?.render(0, a.scale.clamp(0.05, 4.0))?;
            Ok(
                Reply::of(&serde_json::json!({ "width": page.width, "height": page.height }))?
                    .with_blob(page.rgba),
            )
        }
        "list" => {
            let a: Read = args(json)?;
            let pdf = blobs
                .into_iter()
                .next()
                .ok_or_else(|| bad("marks take the PDF"))?;
            let doc = PdfDocument::open(pdf, a.password.as_deref())?;
            let marks: Vec<serde_json::Value> = doc
                .list_marks()
                .into_iter()
                .map(|m| {
                    serde_json::json!({
                        "id": m.id,
                        "kind": m.kind.as_str(),
                        "front": m.front,
                        // What the interface sent, back as it was.
                        "spec": serde_json::from_str::<serde_json::Value>(&m.spec).unwrap_or(serde_json::Value::Null),
                        "pages": m.pages,
                    })
                })
                .collect();
            Reply::of(&serde_json::json!({ "marks": marks }))
        }
        "remove" => {
            let a: Remove = args(json)?;
            let pdf = blobs
                .into_iter()
                .next()
                .ok_or_else(|| bad("marks take the PDF"))?;
            let mut doc = PdfDocument::open(pdf.clone(), a.password.as_deref())?;
            let removed = doc.remove_marks(&a.ids, &a.pages)?;
            let bytes = if removed == 0 {
                pdf
            } else {
                updated(&mut doc)?
            };
            Ok(Reply::of(&serde_json::json!({ "removed": removed }))?.with_blob(bytes))
        }
        // What a page's marks say, and what the page says without them, as
        // Warraq's reader reads each.
        "text" => {
            let a: Read = args(json)?;
            let pdf = blobs
                .into_iter()
                .next()
                .ok_or_else(|| bad("marks take the PDF"))?;
            let doc = Document::open(pdf, a.password.as_deref())?;
            let join = |lines: Vec<warraq_text::TextLine>| {
                lines
                    .into_iter()
                    .map(|l| l.text)
                    .collect::<Vec<_>>()
                    .join("\n")
            };
            Reply::of(&serde_json::json!({
                "marks": join(doc.artifact_lines(a.page)?),
                "page": join(doc.text_lines(a.page)?),
            }))
        }
        _ => Err(CoreError::UnknownOp(format!("marks.{name}"))),
    }
}
