//! Prepare form: finding where a flat form expects input (`detect`), making
//! real fields there (`fields`), and giving them formats, validations and
//! calculations that every reader runs — as Acrobat's own JavaScript — and
//! that Warraq runs without a JavaScript engine (`script`, `run`).
pub mod detect;
pub mod expr;
pub mod fields;
pub mod format;
pub mod hijri;
pub mod run;
pub mod script;

pub use detect::{detect, PageInput, Proposal, Rule};
pub use expr::{parse_expression, ExprError};
pub use fields::{
    format_scripts, ActionsChange, ActionsError, CalcSpec, FieldKind, FormField, FormReport,
    FormatSpec, NewField, Place, ScriptNote, Widget, Xfa,
};
pub use format::{NumberSpec, Shown};
pub use run::{recalculate, FieldState, Outcome, Rejection};
pub use script::{parse as parse_script, SimpleOp, Unsupported};
