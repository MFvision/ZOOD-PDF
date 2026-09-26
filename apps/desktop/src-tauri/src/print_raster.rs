//! Windows/Linux printing: pages rendered as 300-dpi PNGs by the engine's `warraq-render`
//! (hayro), printed by the webview from an image-only document. (macOS uses PDFKit.)
//!
//! The web layer calls `print_open` with the PDF bytes, then `print_page` for each page, then
//! `print_close`. One job at a time; everything is bounded.

use std::sync::{Arc, Mutex};
use warraq_pdf::{Pdf, Protection};
use warraq_render::{HayroRenderer, PageRenderer};

pub const PRINT_DPI: f32 = 300.0;
pub const MIN_DPI: f32 = 72.0;
pub const MAX_PAGES: usize = 2000;

pub struct PrintJob {
    renderer: HayroRenderer,
    pages: usize,
}

/// Tauri state: the current print job (one at a time).
#[derive(Default, Clone)]
pub struct PrintState(pub Arc<Mutex<Option<PrintJob>>>);

/// Clamp the requested resolution to [72, 300] dpi and convert to a render scale (1.0 = 72 dpi).
pub fn scale_for_dpi(dpi: f32) -> f32 {
    let dpi = if dpi.is_finite() { dpi } else { PRINT_DPI };
    dpi.clamp(MIN_DPI, PRINT_DPI) / 72.0
}

impl PrintJob {
    /// Opens a document for printing. Encrypted files that open without a password (empty user
    /// password) are decrypted in memory by warraq-pdf's own handler before hayro sees them.
    pub fn open(bytes: Vec<u8>) -> Result<Self, String> {
        let pdf = Pdf::open(bytes.clone(), None).map_err(|e| e.to_string())?;
        let plain = if pdf.is_encrypted() {
            pdf.write_full(Protection::Remove)
                .map_err(|e| e.to_string())?
        } else {
            bytes
        };
        drop(pdf);
        let renderer = HayroRenderer::new(plain).map_err(|e| e.to_string())?;
        let pages = renderer.page_count();
        if pages == 0 {
            return Err("the document has no pages".into());
        }
        if pages > MAX_PAGES {
            return Err(format!(
                "too many pages to print at once ({pages} > {MAX_PAGES})"
            ));
        }
        Ok(Self { renderer, pages })
    }

    pub fn pages(&self) -> usize {
        self.pages
    }

    /// PNG of page `index` (0-based) at `dpi`.
    pub fn page_png(&self, index: usize, dpi: f32) -> Result<Vec<u8>, String> {
        if index >= self.pages {
            return Err(format!("page {index} does not exist"));
        }
        let bmp = self
            .renderer
            .render(index, scale_for_dpi(dpi))
            .map_err(|e| e.to_string())?;
        bmp.to_png().map_err(|e| e.to_string())
    }
}

#[cfg(test)]
pub(crate) fn sample_pdf(pages: usize) -> Vec<u8> {
    // Minimal valid PDF with `pages` US-Letter pages, each with a filled rectangle.
    let mut objs: Vec<String> = vec![
        "<< /Type /Catalog /Pages 2 0 R >>".into(),
        String::new(), // pages, filled below
    ];
    let mut kids = Vec::new();
    for i in 0..pages {
        let page_id = objs.len() + 1;
        let content_id = page_id + 1;
        kids.push(format!("{page_id} 0 R"));
        objs.push(format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents {content_id} 0 R >>"
        ));
        let stream = format!("0 0 0 rg {} 600 100 100 re f", 72 + i * 10);
        objs.push(format!(
            "<< /Length {} >>\nstream\n{stream}\nendstream",
            stream.len()
        ));
    }
    if let Some(p) = objs.get_mut(1) {
        *p = format!(
            "<< /Type /Pages /Kids [{}] /Count {pages} >>",
            kids.join(" ")
        );
    }
    let mut out = b"%PDF-1.7\n".to_vec();
    let mut offsets = Vec::new();
    for (i, o) in objs.iter().enumerate() {
        offsets.push(out.len());
        out.extend_from_slice(format!("{} 0 obj\n{o}\nendobj\n", i + 1).as_bytes());
    }
    let xref = out.len();
    out.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", objs.len() + 1).as_bytes());
    for off in offsets {
        out.extend_from_slice(format!("{off:010} 00000 n \n").as_bytes());
    }
    out.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
            objs.len() + 1
        )
        .as_bytes(),
    );
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png_size(png: &[u8]) -> (u32, u32) {
        let be = |r: std::ops::Range<usize>| {
            png.get(r)
                .and_then(|b| <[u8; 4]>::try_from(b).ok())
                .map(u32::from_be_bytes)
                .unwrap_or(0)
        };
        (be(16..20), be(20..24))
    }

    #[test]
    fn dpi_is_clamped_to_72_300() {
        assert!((scale_for_dpi(300.0) - 300.0 / 72.0).abs() < 1e-6);
        assert!((scale_for_dpi(10_000.0) - 300.0 / 72.0).abs() < 1e-6);
        assert!((scale_for_dpi(1.0) - 1.0).abs() < 1e-6);
        assert!((scale_for_dpi(f32::NAN) - 300.0 / 72.0).abs() < 1e-6);
    }

    #[test]
    fn renders_letter_pages_at_300_dpi() {
        let job = PrintJob::open(sample_pdf(2));
        let Ok(job) = job else {
            unreachable!("open failed: {:?}", job.err())
        };
        assert_eq!(job.pages(), 2);
        let png = job.page_png(1, PRINT_DPI).unwrap_or_default();
        assert!(png.starts_with(b"\x89PNG"));
        // 8.5 × 11 in at 300 dpi (±1 px: f32 scale rounding).
        let (w, h) = png_size(&png);
        assert!(w.abs_diff(2550) <= 1 && h.abs_diff(3300) <= 1, "{w}×{h}");
        assert!(job.page_png(2, PRINT_DPI).is_err());
    }

    #[test]
    fn rejects_garbage() {
        assert!(PrintJob::open(b"not a pdf".to_vec()).is_err());
        assert!(PrintJob::open(Vec::new()).is_err());
    }
}
