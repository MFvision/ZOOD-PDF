//! warraq-redact — true redaction, find & redact, and removal of hidden information.
//!
//! * [`content`]: byte-faithful content-stream rewriter (text, paths, images, forms, shadings,
//!   hidden optional content, hidden text).
//! * [`image`]: decode → clear covered pixels → re-encode.
//! * [`apply`]: `redact.apply` — areas and `/Redact` annotations → content removal, annotation
//!   removal, fill boxes with optional (shaped) overlay text, scrubbing of the removed words from
//!   other strings, and a garbage-collecting whole rewrite with a single revision.
//! * [`find`] / [`patterns`]: Arabic-aware search and PII patterns with validators.
//! * [`sanitize`]: `redact.sanitize` — remove hidden information.
//! * [`ocg`]: optional-content visibility (OCG, OCMD policies, `/VE`).

pub mod apply;
pub mod content;
pub mod error;
pub mod find;
pub mod image;
pub mod ocg;
pub mod patterns;
pub mod sanitize;
mod util;

pub use error::{RedactError, Result};
