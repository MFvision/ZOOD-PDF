//! Rasterization behind one trait, plus a glyph device for text extraction.
//!
//! Backends: `hayro` (pure Rust, default, compiles to wasm32) and `pdfium`
//! (feature `pdfium`, native; the reference rasterizer per ADR-0003).
pub mod hayro_backend;
#[cfg(feature = "pdfium")]
pub mod pdfium_backend;

use warraq_text::PositionedGlyph;

#[derive(Debug, thiserror::Error)]
pub enum RenderError {
    #[error("E_PARSE: {0}")]
    Parse(String),
    #[error("E_PASSWORD: the document is encrypted; password missing or wrong")]
    Password,
    #[error("E_PAGE: page index {0} out of range")]
    Page(usize),
    #[error("E_RENDER: {0}")]
    Render(String),
}

/// RGBA8 bitmap, row-major, alpha premultiplied over an opaque white background.
#[derive(Debug, Clone)]
pub struct Bitmap {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

pub trait RenderDoc {
    fn page_count(&self) -> usize;
    /// Page size in points after rotation.
    fn page_size(&self, index: usize) -> Result<(f32, f32), RenderError>;
    fn render(&self, index: usize, scale: f32) -> Result<Bitmap, RenderError>;
    /// Positioned glyphs of a page in content order (page space, y down, points).
    fn glyphs(&self, index: usize) -> Result<Vec<PositionedGlyph>, RenderError>;
}

pub fn open(bytes: Vec<u8>, password: Option<&str>) -> Result<Box<dyn RenderDoc>, RenderError> {
    #[cfg(feature = "pdfium")]
    {
        if let Ok(d) = pdfium_backend::PdfiumDoc::open(bytes.clone(), password) {
            return Ok(Box::new(d));
        }
    }
    Ok(Box::new(hayro_backend::HayroDoc::open(bytes, password)?))
}
