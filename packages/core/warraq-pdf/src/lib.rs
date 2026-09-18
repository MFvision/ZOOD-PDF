//! PDF object model, fonts and text operations for Warraq (read, modify, write).
pub mod appearance;
pub mod compress;
pub mod crypt;
pub mod document;
pub mod fonts;
pub mod incremental;
pub mod ocr;
pub mod ops;
pub mod pages;
pub mod text_walk;
pub mod tounicode;

pub use appearance::{needs_shaping, AppearanceReport};
pub use compress::{CompressOptions, CompressReport, Refusal};
pub use document::{Metadata, PdfDocument};
pub use fonts::{embed_subset_font, FontSubset};
pub use incremental::{previous_xref, XrefStyle};
pub use ocr::{OcrPage, OcrReport, OcrWord};
pub use ops::{append_line, erase_area, replace_paragraph, replace_word};
pub use pages::combine;
pub use text_walk::{locate_show_runs, Matrix, ShowRun};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("E_PARSE: {0}")]
    Parse(String),
    #[error("E_PASSWORD: the document is encrypted and the password is missing or wrong")]
    Password,
    #[error("E_PAGE: page index {0} out of range")]
    Page(usize),
    #[error("E_FONT: {0}")]
    Font(String),
    #[error("E_EDIT: {0}")]
    Edit(String),
    #[error("E_IO: {0}")]
    Io(String),
}

pub type Result<T> = std::result::Result<T, Error>;
