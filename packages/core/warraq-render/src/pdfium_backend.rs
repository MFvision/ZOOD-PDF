//! PDFium backend (native). Rendering only; glyphs come from the hayro device so
//! that text behaves identically on every target.
use crate::{Bitmap, RenderDoc, RenderError};
use pdfium_render::prelude::*;
use std::sync::OnceLock;
use warraq_text::PositionedGlyph;

static PDFIUM: OnceLock<Option<Pdfium>> = OnceLock::new();

fn pdfium() -> Option<&'static Pdfium> {
    PDFIUM
        .get_or_init(|| {
            let dir = std::env::var("PDFIUM_LIB_DIR").unwrap_or_else(|_| ".".into());
            Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path(&dir))
                .or_else(|_| Pdfium::bind_to_system_library())
                .ok()
                .map(Pdfium::new)
        })
        .as_ref()
}

pub struct PdfiumDoc {
    bytes: Vec<u8>,
    password: Option<String>,
    text: crate::hayro_backend::HayroDoc,
}

impl PdfiumDoc {
    pub fn open(bytes: Vec<u8>, password: Option<&str>) -> Result<Self, RenderError> {
        let p = pdfium().ok_or_else(|| {
            RenderError::Render("PDFium library not found (set PDFIUM_LIB_DIR)".into())
        })?;
        p.load_pdf_from_byte_slice(&bytes, password)
            .map_err(|e| match e {
                PdfiumError::PdfiumLibraryInternalError(PdfiumInternalError::PasswordError) => {
                    RenderError::Password
                }
                e => RenderError::Parse(format!("{e:?}")),
            })?;
        let text = crate::hayro_backend::HayroDoc::open(bytes.clone(), password)?;
        Ok(Self {
            bytes,
            password: password.map(String::from),
            text,
        })
    }
    fn doc(&self) -> Result<PdfDocument<'_>, RenderError> {
        pdfium()
            .unwrap()
            .load_pdf_from_byte_slice(&self.bytes, self.password.as_deref())
            .map_err(|e| RenderError::Parse(format!("{e:?}")))
    }
}

impl RenderDoc for PdfiumDoc {
    fn page_count(&self) -> usize {
        self.doc().map(|d| d.pages().len() as usize).unwrap_or(0)
    }
    fn page_size(&self, index: usize) -> Result<(f32, f32), RenderError> {
        let d = self.doc()?;
        let p = d
            .pages()
            .get(index as i32)
            .map_err(|_| RenderError::Page(index))?;
        Ok((p.width().value, p.height().value))
    }
    fn render(&self, index: usize, scale: f32) -> Result<Bitmap, RenderError> {
        let d = self.doc()?;
        let p = d
            .pages()
            .get(index as i32)
            .map_err(|_| RenderError::Page(index))?;
        // Refused before PDFium allocates anything (`MAX_PIXELS`).
        crate::bitmap_size(p.width().value, p.height().value, scale)?;
        let w = (p.width().value * scale).floor().max(1.0) as i32;
        let img = p
            .render_with_config(&PdfRenderConfig::new().set_target_width(w))
            .map_err(|e| RenderError::Render(format!("{e:?}")))?
            .as_image()
            .map_err(|e| RenderError::Render(format!("{e:?}")))?
            .to_rgba8();
        Ok(Bitmap {
            width: img.width(),
            height: img.height(),
            rgba: img.into_raw(),
        })
    }
    fn glyphs(&self, index: usize) -> Result<Vec<PositionedGlyph>, RenderError> {
        self.text.glyphs(index)
    }
    fn marked_glyphs(
        &self,
        index: usize,
    ) -> Result<(Vec<PositionedGlyph>, crate::MarkedGlyphs), RenderError> {
        self.text.marked_glyphs(index)
    }
    fn drawing(&self, index: usize) -> Result<crate::Drawing, RenderError> {
        self.text.drawing(index)
    }
}
