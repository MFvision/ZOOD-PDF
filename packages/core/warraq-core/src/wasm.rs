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
}
