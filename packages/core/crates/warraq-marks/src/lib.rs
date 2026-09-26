//! warraq-marks — the Page marks tool of the ZOOD PDF engine: watermarks (text or picture),
//! headers/footers, page numbers and Bates numbers.
//!
//! * [`model`]: the mark (`marks.add` params, also stored in the PDF for listing and editing).
//! * [`tokens`] + [`hijri`]: `{page}`, `{pages}`, `{date}`, `{hijri}` (own table-based Umm al-Qura),
//!   `{time}`, `{file}`, `{bates}` with Latin or Arabic-Indic digits.
//! * [`geom`]: the displayed page (CropBox, `/Rotate`) so marks stand upright where they are seen.
//! * [`draw`]: shaping via warraq-edit's layout (harfrust, per-word `/ActualText`, fill only,
//!   never `/Direction`), bundled font subsets, ExtGState opacity, form XObjects, pagination
//!   artifacts.
//! * [`store`] + [`marks`]: how marks live in a page, list/add/update/remove without rewriting
//!   any content stream.
//! * [`foreign`]: other applications' pagination artifacts (Acrobat `/ADBE_CompoundType`),
//!   listed and removed through warraq-edit's byte-faithful rewriter when that is safe.
//! * [`api`]: the JSON RPC surface (`marks.*`) registered by warraq-core.

pub mod api;
pub mod draw;
pub mod error;
pub mod foreign;
pub mod geom;
pub mod hijri;
mod hijri_table;
pub mod marks;
pub mod model;
pub mod store;
pub mod tokens;

pub use error::{MarkError, Result};
