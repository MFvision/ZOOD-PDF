//! PDF object model, fonts and text operations for Warraq (read, modify, write).
pub mod appearance;
pub mod attachments;
pub mod compress;
pub mod create;
pub mod crypt;
pub mod document;
pub mod fonts;
pub mod forms;
mod frame;
pub mod hidden;
pub mod images;
pub mod incremental;
pub mod layers;
mod lex;
pub mod links;
pub mod marked;
pub mod marks;
pub mod ocr;
pub mod ops;
pub mod outline;
pub mod pages;
mod pagework;
pub mod picture;
mod rebase;
pub mod redaction;
mod show;
pub mod signature;
pub mod standards;
pub mod text_walk;
pub mod textless;
pub mod tiff;
pub mod tounicode;

pub use appearance::{needs_shaping, AppearanceReport};
pub use attachments::{Attachment, AttachmentPlace};
pub use compress::{CompressOptions, CompressReport, Refusal};
pub use document::{Metadata, PdfDocument};
pub use fonts::{embed_subset_font, FontSubset};
pub use hidden::{Detail, Finding, Hidden, HiddenReport};
pub use images::PlacedImage;
pub use incremental::{previous_xref, XrefStyle};
pub use layers::{Layer, LayerNode, Layers};
/// For the fuzzer (`packages/core/fuzz`): the content lexer's promises.
#[doc(hidden)]
pub use lex::ranges_hold as lex_ranges_hold;
pub use links::{allowed_uri, LinkInfo, LinkTarget};
pub use marks::{
    Anchor, Digits, HAlign, MarkContent, MarkInfo, MarkKind, NumberFormat, PageMark, SlotDirection,
    VAlign,
};
pub use ocr::{OcrPage, OcrReport, OcrWord};
pub use ops::{append_line, append_line_in_color, erase_area, replace_paragraph, replace_word};
pub use outline::Bookmark;
pub use pages::{combine, Margins};
pub use redaction::{RedactMark, RedactReport};
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
