//! Warraq core façade: the one API every host uses (native and WASM).
use serde::Serialize;
use warraq_pdf::PdfDocument;
use warraq_render::RenderDoc;
use warraq_text::{find_in_lines, reconstruct_lines, SearchNormalization, TextLine};

#[cfg(target_arch = "wasm32")]
pub mod wasm;

pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error("{0}")]
    Pdf(#[from] warraq_pdf::Error),
    #[error("{0}")]
    Render(#[from] warraq_render::RenderError),
}

#[derive(Debug, Clone, Serialize)]
pub struct Metadata {
    pub title: Option<String>,
    pub author: Option<String>,
    pub producer: Option<String>,
    pub creator: Option<String>,
    pub pages: usize,
    pub encrypted: bool,
    pub engine: &'static str,
}

pub struct Document {
    pdf: PdfDocument,
    render: Box<dyn RenderDoc>,
    lines_cache: std::cell::RefCell<std::collections::HashMap<usize, Vec<TextLine>>>,
}

impl Document {
    pub fn open(bytes: Vec<u8>, password: Option<&str>) -> Result<Self, CoreError> {
        let render = warraq_render::open(bytes.clone(), password)?;
        let pdf = PdfDocument::open(bytes, password)?;
        Ok(Self {
            pdf,
            render,
            lines_cache: Default::default(),
        })
    }

    pub fn page_count(&self) -> usize {
        self.pdf.page_count().max(self.render.page_count())
    }

    pub fn page_size(&self, index: usize) -> Result<(f32, f32), CoreError> {
        Ok(self
            .render
            .page_size(index)
            .or_else(|_| self.pdf.page_size(index))?)
    }

    pub fn render_page(
        &self,
        index: usize,
        scale: f32,
    ) -> Result<warraq_render::Bitmap, CoreError> {
        Ok(self.render.render(index, scale.clamp(0.05, 8.0))?)
    }

    pub fn text_lines(&self, index: usize) -> Result<Vec<TextLine>, CoreError> {
        if let Some(l) = self.lines_cache.borrow().get(&index) {
            return Ok(l.clone());
        }
        let glyphs = self.render.glyphs(index)?;
        let lines = reconstruct_lines(&glyphs);
        self.lines_cache.borrow_mut().insert(index, lines.clone());
        Ok(lines)
    }

    pub fn extract_text(&self, index: usize) -> Result<String, CoreError> {
        Ok(self
            .text_lines(index)?
            .iter()
            .map(|l| l.text.as_str())
            .collect::<Vec<_>>()
            .join("\n"))
    }

    /// Page indices containing `query` (Arabic-aware normalization).
    pub fn search(&self, query: &str) -> Vec<usize> {
        let opts = SearchNormalization::default();
        (0..self.page_count())
            .filter(|i| {
                let lines: Vec<String> = self
                    .text_lines(*i)
                    .map(|l| l.into_iter().map(|t| t.text).collect())
                    .unwrap_or_default();
                !find_in_lines(&lines, query, &opts).is_empty()
            })
            .collect()
    }

    pub fn metadata(&self) -> Metadata {
        let m = self.pdf.metadata();
        Metadata {
            title: m.title,
            author: m.author,
            producer: m.producer,
            creator: m.creator,
            pages: self.page_count(),
            encrypted: m.encrypted,
            engine: if cfg!(feature = "pdfium") {
                "pdfium+hayro"
            } else {
                "hayro"
            },
        }
    }

    pub fn pdf_mut(&mut self) -> &mut PdfDocument {
        self.lines_cache.borrow_mut().clear();
        &mut self.pdf
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn corpus(name: &str) -> Vec<u8> {
        std::fs::read(format!(
            "{}/../../../tests/corpus/arabic/generated/{name}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap()
    }

    #[test]
    fn extracts_logical_order_text_from_the_ideal_corpus_file() {
        let d = Document::open(corpus("raw-amiri-cid-identity-tounicode.pdf"), None).unwrap();
        let text = d.extract_text(0).unwrap();
        let truth = std::fs::read_to_string(format!(
            "{}/../../../tests/corpus/arabic/truth/raw-amiri-cid-identity-tounicode.txt",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap();
        for line in truth.lines().take(4) {
            assert!(text.contains(line), "missing {line:?} in:\n{text}");
        }
        assert_eq!(d.search("الفاتورة"), vec![0]);
        assert_eq!(d.search("فاتوره"), vec![0], "taa marbuta / haa unified");
        assert!(d.search("لا يوجد").is_empty());
    }

    #[test]
    fn chrome_skia_file_with_presentation_form_tounicode_reads_logically() {
        let d = Document::open(corpus("chrome-cairo-mixed-invoice.pdf"), None).unwrap();
        let text = d.extract_text(0).unwrap();
        assert!(text.contains("فاتورة ضريبية مبسطة"), "{text}");
        assert!(text.contains("رقم الفاتورة: INV-2026-0042"), "{text}");
        let m = d.metadata();
        assert_eq!(m.pages, 1);
    }
}
