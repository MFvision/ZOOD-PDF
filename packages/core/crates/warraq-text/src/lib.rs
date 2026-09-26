//! warraq-text — the Arabic-first text engine of ZOOD PDF.
//!
//! * [`interp`] interprets content streams into positioned glyph units (fonts, CMaps,
//!   ActualText, artifacts, fill+stroke de-duplication).
//! * [`layout`] turns glyphs into words, lines, paragraphs and blocks in **logical order**
//!   (columns by XY-cut, bidi with the W5 fix, the Nastaliq ordering rule).
//! * [`normalize`] / [`search`] implement Arabic-aware search with rectangles.
//! * [`shape`] shapes Arabic for writing into PDFs (harfrust) with per-word `/ActualText`.
//! * [`api`] exposes `text.extract`, `text.search` and `text.plain` for the RPC layer.
//!
//! The PDF object layer is reached only through [`ContentSource`], so the crate can be backed
//! by `warraq-pdf`'s decrypted document; [`LopdfSource`] is the stand-alone implementation.

pub mod api;
pub mod bidi;
pub mod cmap;
pub mod encoding;
pub mod error;
pub mod font;
pub mod geom;
pub mod interp;
pub mod layout;
pub mod lexer;
pub mod limits;
pub mod model;
pub mod normalize;
pub mod search;
pub mod shape;
pub mod source;

pub use api::{call, extract_all, extract_pages, plain_text, METHODS};
pub use error::{Result, TextError};
pub use layout::LayoutOptions;
pub use model::PageText;
pub use normalize::normalize_for_search;
pub use search::{search, Hit};
pub use shape::{actual_text_spans, shape, ShapedRun};
pub use source::{ContentSource, DocSource, LopdfSource};
