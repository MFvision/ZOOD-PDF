//! wasm-bindgen exports mirroring `packages/core/API.md`.
use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub fn version() -> String {
    crate::version()
}

#[wasm_bindgen(getter_with_clone)]
pub struct RenderedPage {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

#[wasm_bindgen(getter_with_clone)]
pub struct TextLine {
    pub text: String,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub direction: String,
}

#[wasm_bindgen(getter_with_clone)]
pub struct ParagraphInfo {
    /// Index of this paragraph on the page, for `replace_paragraph`.
    pub index: usize,
    pub text: String,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub direction: String,
    /// "start" | "end" | "center" | "justify"
    pub alignment: String,
    pub font_size: f32,
    pub line_count: usize,
}

#[wasm_bindgen]
pub struct Document(crate::Document);

fn js_err(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

#[wasm_bindgen]
impl Document {
    pub fn open(bytes: &[u8], password: Option<String>) -> Result<Document, JsError> {
        crate::Document::open(bytes.to_vec(), password.as_deref())
            .map(Document)
            .map_err(js_err)
    }
    pub fn page_count(&self) -> usize {
        self.0.page_count()
    }
    pub fn page_size(&self, index: usize) -> Result<Vec<f32>, JsError> {
        let (w, h) = self.0.page_size(index).map_err(js_err)?;
        Ok(vec![w, h])
    }
    pub fn render_page(&self, index: usize, scale: f32) -> Result<RenderedPage, JsError> {
        let b = self.0.render_page(index, scale).map_err(js_err)?;
        Ok(RenderedPage {
            width: b.width,
            height: b.height,
            rgba: b.rgba,
        })
    }
    pub fn extract_text(&self, index: usize) -> Result<String, JsError> {
        self.0.extract_text(index).map_err(js_err)
    }
    pub fn text_lines(&self, index: usize) -> Result<Vec<TextLine>, JsError> {
        Ok(self
            .0
            .text_lines(index)
            .map_err(js_err)?
            .into_iter()
            .map(|l| TextLine {
                text: l.text,
                x: l.x,
                y: l.y,
                width: l.width,
                height: l.height,
                direction: if l.direction == warraq_text::Direction::Rtl {
                    "rtl".into()
                } else {
                    "ltr".into()
                },
            })
            .collect())
    }
    pub fn search(&self, query: &str) -> Vec<u32> {
        self.0.search(query).into_iter().map(|i| i as u32).collect()
    }
    pub fn metadata(&self) -> String {
        serde_json::to_string(&self.0.metadata()).unwrap_or_else(|_| "{}".into())
    }

    /// Paragraphs of a page in device space, for hit-testing an editor click.
    pub fn paragraphs(&self, index: usize) -> Result<Vec<ParagraphInfo>, JsError> {
        use warraq_text::Alignment;
        Ok(self
            .0
            .paragraphs(index)
            .map_err(js_err)?
            .into_iter()
            .enumerate()
            .map(|(i, p)| ParagraphInfo {
                index: i,
                text: p.text,
                x: p.bbox.0,
                y: p.bbox.1,
                width: p.bbox.2,
                height: p.bbox.3,
                direction: if p.direction == warraq_text::Direction::Rtl {
                    "rtl".into()
                } else {
                    "ltr".into()
                },
                alignment: match p.alignment {
                    Alignment::Start => "start",
                    Alignment::End => "end",
                    Alignment::Center => "center",
                    Alignment::Justify => "justify",
                }
                .into(),
                font_size: p.font_size,
                line_count: p.lines.len(),
            })
            .collect())
    }

    /// Draw a new line of text at a point on the page, in the bundled `font`.
    ///
    /// `x` and `y` are points from the top-left corner — the same frame
    /// `paragraphs` reports — and `x` is where the line starts, so an Arabic
    /// run grows leftwards from it and a Latin one rightwards.
    pub fn add_text(
        &mut self,
        index: usize,
        x: f32,
        y: f32,
        size: f32,
        text: &str,
        font: &[u8],
    ) -> Result<(), JsError> {
        self.0
            .add_text(index, x, y, size, text, font)
            .map_err(js_err)
    }

    /// Replace a paragraph with reflowed, shaped text. `font` is a face from the
    /// bundled fallback chain. The returned JSON reports whether a substitution
    /// happened, whether the text had to be shrunk to fit its box and whether it
    /// still overflows, so the UI can warn the user instead of silently spoiling
    /// the page.
    pub fn replace_paragraph(
        &mut self,
        index: usize,
        para_index: usize,
        new_text: &str,
        font: &[u8],
    ) -> Result<String, JsError> {
        let r = self
            .0
            .replace_paragraph(index, para_index, new_text, font)
            .map_err(js_err)?;
        serde_json::to_string(&r).map_err(js_err)
    }

    /// Bytes of the edited document: an incremental update on top of the
    /// original wherever that is possible.
    pub fn save(&mut self) -> Result<Vec<u8>, JsError> {
        self.0.save().map_err(js_err)
    }
}
