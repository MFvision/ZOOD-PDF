//! Global text engine, Arabic-first: bidi, shaping, normalization, search and
//! logical-order reconstruction of positioned glyphs.
//!
//! Everything here is pure Rust and compiles to native and wasm32 identically.
pub mod bidi;
pub mod extract;
pub mod glyphshape;
pub mod normalize;
pub mod paragraph;
pub mod search;
pub mod shape;

pub use bidi::{base_direction, visual_runs, visual_runs_in, Direction, VisualRun};
pub use extract::{
    clusters_to_logical, clusters_to_logical_mapped, reconstruct_lines, with_actual_text,
    PositionedGlyph, TextLine, Turned,
};
pub use glyphshape::{best_match, Descriptor, Form, MarkCluster, ShapeSampler, MAX_DISTANCE};
pub use normalize::{
    fold_presentation_forms, normalize_for_search, strip_marks, SearchNormalization,
};
pub use paragraph::{
    detect_paragraphs, layout_paragraph, Alignment, LaidOutLine, LayoutBox, LayoutStyle, Paragraph,
};
pub use search::{find_in_lines, Match};
pub use shape::{clusters, ShapedGlyph, Shaper};
