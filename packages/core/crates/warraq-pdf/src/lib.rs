//! warraq-pdf — the PDF object layer of the ZOOD PDF engine.
//!
//! * [`limits`]: bounds for everything input-driven.
//! * [`Pdf`]: hostile-input loader (xref reconstruction via lopdf, own decryption),
//!   incremental updates that keep the original bytes as an exact prefix, and a
//!   garbage-collecting full rewrite.
//! * [`crypt`]: own Standard security handler (R2–R6, user/owner passwords, AES-256 writer).
//! * [`rebase`]: turn a whole-file rewrite (PDFium) into an incremental update on the original.
//! * [`revisions`], [`pages`], [`metadata`]: tools used by the Organize/Protect UI.

pub mod builder;
pub mod compare;
pub mod crypt;
pub mod error;
pub mod limits;
pub mod metadata;
pub mod pages;
mod pdf;
pub mod rebase;
pub mod revisions;
pub mod serialize;
pub mod writer;
mod xrefscan;

pub use crypt::{PasswordKind, PermissionFlags, SecurityHandler};
pub use error::{PdfError, Result};
pub use limits::Limits;
pub use lopdf;
pub use pdf::{Pdf, Protection};
pub use writer::XrefKind;
