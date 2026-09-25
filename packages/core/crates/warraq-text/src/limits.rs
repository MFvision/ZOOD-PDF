//! Hard bounds for hostile input. Every loop over input-derived data in this crate is bounded by
//! one of these (or by the input length). They mirror `warraq_pdf::limits` and will be unified
//! when the crates are integrated.

/// Maximum decoded size of one page's content (or one form XObject), in bytes.
pub const MAX_CONTENT_BYTES: usize = 64 * 1024 * 1024;
/// Maximum number of operators interpreted per page (including nested forms).
pub const MAX_OPS_PER_PAGE: usize = 4_000_000;
/// Maximum operands kept on the operand stack; extra operands are discarded.
pub const MAX_OPERANDS: usize = 4096;
/// Maximum nesting of arrays/dictionaries inside a content stream or CMap.
pub const MAX_NESTING: usize = 32;
/// Maximum number of elements in one array/dictionary operand.
pub const MAX_ARRAY_LEN: usize = 1_000_000;
/// Maximum nesting depth of form XObjects (`Do`).
pub const MAX_FORM_DEPTH: usize = 12;
/// Maximum depth of `q` (graphics state save) nesting; deeper saves are ignored.
pub const MAX_GSTATE_DEPTH: usize = 256;
/// Maximum depth of marked-content nesting that is tracked.
pub const MAX_MARKED_DEPTH: usize = 256;
/// Maximum glyphs produced for one page.
pub const MAX_GLYPHS_PER_PAGE: usize = 1_000_000;
/// Maximum mappings (chars + ranges) read from one CMap.
pub const MAX_CMAP_ENTRIES: usize = 200_000;
/// Maximum size of a CMap stream that is parsed.
pub const MAX_CMAP_BYTES: usize = 8 * 1024 * 1024;
/// Maximum UTF-16 code units in one CMap destination string.
pub const MAX_CMAP_DST_UNITS: usize = 64;
/// Maximum entries in a `/W` or `/Widths` array that are honoured.
pub const MAX_WIDTH_ENTRIES: usize = 200_000;
/// Maximum distinct fonts cached per document.
pub const MAX_FONTS: usize = 4096;
/// Maximum characters of `/ActualText` honoured.
pub const MAX_ACTUAL_TEXT: usize = 65_536;
/// Maximum recursion depth of the XY-cut layout.
pub const MAX_LAYOUT_DEPTH: usize = 48;
/// Maximum search hits returned.
pub const MAX_SEARCH_HITS: usize = 100_000;
/// Maximum text length accepted by the shaper, in bytes.
pub const MAX_SHAPE_BYTES: usize = 1024 * 1024;
