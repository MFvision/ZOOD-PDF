//! warraq-edit — the Edit tool of the ZOOD PDF engine.
//!
//! * [`content`]: byte-faithful content-stream lexer/rewriter (untouched bytes stay identical).
//! * [`page`]: page content access (streams, segments), writing edits back as new stream objects,
//!   appending drawing in a clean graphics state, resources.
//! * [`scan`]: interpreter recording text-showing operators with glyph boxes, and image placements.
//! * [`text`]: editable text blocks (from warraq-text's logical-order layout), replace with reflow,
//!   add text.
//! * [`layout`] + [`fonts`]: line breaking (UAX #14), bidi, harfrust shaping, embedded font subsets
//!   (original font when it covers the text, else bundled Amiri/Cairo/Inter), per-word `/ActualText`.
//! * [`images`]: list/move/resize/rotate/crop/replace/delete/add pictures.
//! * [`links`] + [`url`]: link annotations; bidi-spoof and look-alike host checks.
//! * [`api`]: the JSON RPC surface (`edit.*`) registered by warraq-core.
//!
//! Every mutating function only records changes on the [`warraq_pdf::Pdf`]; the caller commits them
//! as one incremental update.

pub mod api;
pub mod content;
pub mod error;
pub mod fonts;
pub mod geom;
pub mod images;
pub mod layout;
pub mod links;
pub mod page;
pub mod scan;
pub mod text;
pub mod url;

pub use error::{EditError, Result};
