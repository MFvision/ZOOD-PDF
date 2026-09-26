//! Scan & OCR in the engine: the invisible text layer written over page images
//! (`ocr.addTextLayer`) and new PDFs made from scanned images (`ocr.createPdf`).
//! Recognition itself (tesseract.js) and image preprocessing run in the UI (ADR 0016).

mod create;
mod font;
mod jpeg;
mod layer;

pub use create::{create_pdf, CreateParams, NewPage, MAX_PAGES, MAX_PIXELS, MAX_SIDE};
pub use font::glyphless_font;
pub use jpeg::{jpeg_info, JpegInfo};
pub use layer::{add_text_layer, is_rtl, ImageFrame, LayerStats, OcrWord, MAX_WORDS};
