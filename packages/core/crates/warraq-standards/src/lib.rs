//! warraq-standards — the Standards tool of ZOOD PDF.
//!
//! * [`validate`]: our own PDF/A validator (52 rules, each citing its ISO 19005-1/-2/-3 clause) and a
//!   PDF/X-4 subset (ISO 15930-7). veraPDF is GPL/MPL-licensed and therefore not used (ADR 0009).
//! * [`convert`]: PDF/A-1b/2b/2u/3b and PDF/X-4 conversion as a whole rewrite, followed by a
//!   re-validation of the output. What cannot be repaired honestly (e.g. transparency in PDF/A-1,
//!   fonts without a matching bundled font) is reported, never hidden.
//! * [`preflight`]: a summary of fonts, images (effective resolution), colour spaces,
//!   transparency, annotations, forms, JavaScript, encryption and page boxes.
//!
//! Everything is bounded (`warraq_pdf::limits`), nothing panics on hostile input.

pub mod appearance;
pub mod content;
pub mod convert;
pub mod encodings;
pub mod fonts;
pub mod icc;
pub mod json;
pub mod lexer;
pub mod model;
pub mod preflight;
pub mod profile;
pub mod rawscan;
pub mod report;
pub mod rules;
pub mod validate;
pub mod xmp;

pub use convert::{convert, ConvertOptions, Converted};
pub use preflight::preflight;
pub use profile::Profile;
pub use report::{Finding, Report};
pub use rules::{Rule, Severity, RULES};
pub use validate::validate;
