//! warraq-a11y — the Accessibility tool of the ZOOD PDF engine.
//!
//! * [`tree`]: the structure tree — bounded reader (cycles, depth, size) and a writer that rewrites
//!   changed elements only and rebuilds `/ParentTree`.
//! * [`marked`]: marked content per operation (MCIDs, artifacts, matching pairs) and where new
//!   sequences can be placed so they nest.
//! * [`pagemap`]: operations ↔ logical-order words (reading order for right-to-left content).
//! * [`classify`]: headings, list labels (Arabic-Indic numbering, Arabic bullets), pagination.
//! * [`autotag`]: tagging untagged content without moving pixels (insertions only).
//! * [`structure`]: the tree as the UI lists it (types, text in logical order, boxes, alt, lang).
//! * [`edit`]: reading order, types, alt text, language, decorative, merge/split, title.
//! * [`check`]: a PDF/UA-style checker (Matterhorn-inspired subset, not a certified validator) with
//!   automatic fixes.
//! * [`api`]: the JSON RPC surface (`a11y.*`) registered by warraq-core.
//!
//! Mutating functions only record changes on the [`warraq_pdf::Pdf`]; the caller commits them as one
//! incremental update.

pub mod api;
pub mod autotag;
pub mod check;
pub mod classify;
pub mod edit;
pub mod error;
pub mod lang;
pub mod marked;
pub mod meta;
pub mod pagemap;
pub mod rewrite;
pub mod structure;
pub mod tree;

pub use error::{A11yError, Result};
