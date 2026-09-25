//! warraq-render — page rasterisation for the ZOOD PDF engine.
//!
//! * `hayro` feature (default): pure-Rust rasteriser [`HayroRenderer`] (hayro, MIT/Apache-2.0).
//! * `pdfium` feature (off): [`pdfium::PdfiumRenderer`] binds a system `libpdfium` at runtime
//!   through `pdfium-render`. Not built in CI (no libpdfium on the build machines).
//!
//! Encrypted files: pass decrypted bytes (warraq-core renders from an in-memory decrypted
//! rewrite, so the user's password handling stays in one place — warraq-pdf's handler).

/// Errors from rendering.
#[derive(Debug, thiserror::Error)]
pub enum RenderError {
    /// The renderer could not parse the document.
    #[error("cannot render this document: {0}")]
    Load(String),
    /// Page index out of range.
    #[error("page {0} does not exist")]
    NoSuchPage(usize),
    /// Scale or output size out of range.
    #[error("invalid render size: {0}")]
    Size(String),
    /// PNG encoding failed.
    #[error("png encoding failed: {0}")]
    Encode(String),
    /// The backend is not available in this build.
    #[error("renderer unavailable: {0}")]
    Unavailable(String),
}

/// Largest output side in pixels (bounds memory: 10000² × 4 = 400 MB worst case).
pub const MAX_SIDE: f32 = 10_000.0;

/// An RGBA8 (non-premultiplied) bitmap.
#[derive(Debug, Clone)]
pub struct Bitmap {
    /// Width in pixels.
    pub width: u32,
    /// Height in pixels.
    pub height: u32,
    /// `width * height * 4` bytes, row-major, top row first.
    pub rgba: Vec<u8>,
}

impl Bitmap {
    /// Count of pixels that are not (near) white.
    pub fn non_white_pixels(&self) -> usize {
        self.rgba
            .chunks_exact(4)
            .filter(|p| p.iter().take(3).any(|c| *c < 240))
            .count()
    }

    /// Encode as PNG.
    #[cfg(any(feature = "hayro", feature = "pdfium"))]
    pub fn to_png(&self) -> Result<Vec<u8>, RenderError> {
        let mut out = Vec::new();
        {
            let mut enc = png::Encoder::new(&mut out, self.width, self.height);
            enc.set_color(png::ColorType::Rgba);
            enc.set_depth(png::BitDepth::Eight);
            let mut w = enc
                .write_header()
                .map_err(|e| RenderError::Encode(e.to_string()))?;
            w.write_image_data(&self.rgba)
                .map_err(|e| RenderError::Encode(e.to_string()))?;
        }
        Ok(out)
    }
}

/// A page rasteriser backend.
pub trait PageRenderer {
    /// Number of pages.
    fn page_count(&self) -> usize;
    /// Render page `index` (0-based) at `scale` (1.0 = 72 dpi) on a white background.
    fn render(&self, index: usize, scale: f32) -> Result<Bitmap, RenderError>;
}

fn check_size(w: f32, h: f32, scale: f32) -> Result<(), RenderError> {
    if !(scale.is_finite() && scale > 0.0 && scale <= 16.0) {
        return Err(RenderError::Size(format!(
            "scale {scale} must be in (0, 16]"
        )));
    }
    let (pw, ph) = (w * scale, h * scale);
    if !(pw.is_finite() && ph.is_finite()) || pw < 1.0 || ph < 1.0 || pw > MAX_SIDE || ph > MAX_SIDE
    {
        return Err(RenderError::Size(format!("{pw}×{ph} pixels")));
    }
    Ok(())
}

/// hayro-based renderer.
#[cfg(feature = "hayro")]
pub struct HayroRenderer {
    pdf: hayro::hayro_syntax::Pdf,
}

#[cfg(feature = "hayro")]
impl HayroRenderer {
    /// Parse `bytes` (must be unencrypted or have an empty user password).
    pub fn new(bytes: Vec<u8>) -> Result<Self, RenderError> {
        let pdf = hayro::hayro_syntax::Pdf::new(bytes)
            .map_err(|e| RenderError::Load(format!("{e:?}")))?;
        Ok(HayroRenderer { pdf })
    }
}

#[cfg(feature = "hayro")]
impl PageRenderer for HayroRenderer {
    fn page_count(&self) -> usize {
        self.pdf.pages().len()
    }

    fn render(&self, index: usize, scale: f32) -> Result<Bitmap, RenderError> {
        use hayro::vello_cpu::color::palette::css::WHITE;
        let pages = self.pdf.pages();
        let page = pages.get(index).ok_or(RenderError::NoSuchPage(index))?;
        let (w, h) = page.render_dimensions();
        check_size(w, h, scale)?;
        let cache = hayro::RenderCache::new();
        let settings = hayro::RenderSettings {
            x_scale: scale,
            y_scale: scale,
            bg_color: WHITE,
            ..Default::default()
        };
        let pix = hayro::render(
            page,
            &cache,
            &hayro::hayro_interpret::InterpreterSettings::default(),
            &settings,
        );
        let (width, height) = (u32::from(pix.width()), u32::from(pix.height()));
        let rgba: Vec<u8> = pix
            .take_unpremultiplied()
            .into_iter()
            .flat_map(|p| [p.r, p.g, p.b, p.a])
            .collect();
        Ok(Bitmap {
            width,
            height,
            rgba,
        })
    }
}

/// Native PDFium backend (feature `pdfium`). Binds `libpdfium` from the system at runtime.
#[cfg(feature = "pdfium")]
pub mod pdfium {
    use super::{check_size, Bitmap, PageRenderer, RenderError};
    use pdfium_render::prelude::*;

    /// A document opened with PDFium.
    pub struct PdfiumRenderer {
        pdfium: Pdfium,
        bytes: Vec<u8>,
    }

    impl PdfiumRenderer {
        /// Bind the system PDFium library and keep `bytes` for rendering.
        pub fn new(bytes: Vec<u8>) -> Result<Self, RenderError> {
            let bindings = Pdfium::bind_to_system_library()
                .map_err(|e| RenderError::Unavailable(format!("libpdfium not found: {e}")))?;
            Ok(PdfiumRenderer {
                pdfium: Pdfium::new(bindings),
                bytes,
            })
        }

        fn doc(&self) -> Result<PdfDocument<'_>, RenderError> {
            self.pdfium
                .load_pdf_from_byte_slice(&self.bytes, None)
                .map_err(|e| RenderError::Load(e.to_string()))
        }
    }

    impl PageRenderer for PdfiumRenderer {
        fn page_count(&self) -> usize {
            self.doc().map(|d| d.pages().len() as usize).unwrap_or(0)
        }

        fn render(&self, index: usize, scale: f32) -> Result<Bitmap, RenderError> {
            let doc = self.doc()?;
            let idx = u16::try_from(index).map_err(|_| RenderError::NoSuchPage(index))?;
            let page = doc
                .pages()
                .get(idx)
                .map_err(|_| RenderError::NoSuchPage(index))?;
            check_size(page.width().value, page.height().value, scale)?;
            let cfg = PdfRenderConfig::new().scale_page_by_factor(scale);
            let bmp = page
                .render_with_config(&cfg)
                .map_err(|e| RenderError::Load(e.to_string()))?;
            Ok(Bitmap {
                width: bmp.width() as u32,
                height: bmp.height() as u32,
                rgba: bmp.as_rgba_bytes(),
            })
        }
    }
}

#[cfg(all(test, feature = "hayro"))]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
mod tests {
    use super::*;
    use warraq_pdf::builder::{sample_pdf, SampleOptions};

    #[test]
    fn renders_generated_page_with_ink() {
        let bytes = sample_pdf(2, &SampleOptions::default()).unwrap();
        let r = HayroRenderer::new(bytes).unwrap();
        assert_eq!(r.page_count(), 2);
        let bmp = r.render(0, 0.5).unwrap();
        assert_eq!((bmp.width, bmp.height), (297, 421));
        assert_eq!(bmp.rgba.len(), (bmp.width * bmp.height * 4) as usize);
        // The sample draws a 200×100 pt blue rectangle: ≈ 100×50 px at 0.5×.
        let ink = bmp.non_white_pixels();
        assert!(
            ink > 4_000,
            "expected the blue box and text, got {ink} ink pixels"
        );
        // Top-left corner stays white.
        assert_eq!(&bmp.rgba[..4], &[255, 255, 255, 255]);
        let png = bmp.to_png().unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    }

    #[test]
    fn bad_input_and_sizes_are_errors() {
        assert!(HayroRenderer::new(b"garbage".to_vec()).is_err());
        let r = HayroRenderer::new(sample_pdf(1, &SampleOptions::default()).unwrap()).unwrap();
        assert!(matches!(r.render(5, 1.0), Err(RenderError::NoSuchPage(5))));
        assert!(r.render(0, 0.0).is_err());
        assert!(r.render(0, 100.0).is_err());
        assert!(r.render(0, f32::NAN).is_err());
    }
}
