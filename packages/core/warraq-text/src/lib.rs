//! Global text engine, Arabic-first: bidi, shaping, normalization, search and
//! logical-order reconstruction of positioned glyphs.
//!
//! Everything here is pure Rust and compiles to native and wasm32 identically.
pub mod bidi;
pub mod extract;
pub mod normalize;
pub mod search;
pub mod shape;

pub use bidi::{base_direction, visual_runs, Direction, VisualRun};
pub use extract::{reconstruct_lines, PositionedGlyph, TextLine};
pub use normalize::{
    fold_presentation_forms, normalize_for_search, strip_marks, SearchNormalization,
};
pub use search::{find_in_lines, Match};
pub use shape::{ShapedGlyph, Shaper};
