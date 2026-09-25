//! Bounds for everything driven by input bytes: zip bombs, XML depth/size, image dimensions,
//! table sizes and page counts. Every reader loop is checked against one of these.

use crate::error::{CreateError, Result};

/// Largest single input file (256 MiB).
pub const MAX_INPUT_BYTES: usize = 256 << 20;
/// Largest number of input files in one call.
pub const MAX_FILES: usize = 500;
/// Largest number of entries in a zip central directory.
pub const MAX_ZIP_ENTRIES: usize = 20_000;
/// Largest uncompressed size of one zip entry (128 MiB).
pub const MAX_ZIP_ENTRY: usize = 128 << 20;
/// Largest total uncompressed bytes read from one zip (512 MiB).
pub const MAX_ZIP_TOTAL: usize = 512 << 20;
/// Largest compression ratio of an entry before we call it a zip bomb (tiny entries excepted).
pub const MAX_ZIP_RATIO: usize = 200;
/// Entries may inflate to this size regardless of the ratio.
pub const ZIP_RATIO_FLOOR: usize = 1 << 20;
/// Largest number of XML nodes in one part.
pub const MAX_XML_NODES: usize = 4_000_000;
/// Deepest XML nesting.
pub const MAX_XML_DEPTH: usize = 256;
/// Largest number of pixels in one image (100 megapixels).
pub const MAX_IMAGE_PIXELS: u64 = 100_000_000;
/// Largest width or height of one image in pixels.
pub const MAX_IMAGE_SIDE: u32 = 65_000;
/// Largest number of pages in a TIFF.
pub const MAX_TIFF_PAGES: usize = 2_000;
/// Largest number of table cells in one document.
pub const MAX_CELLS: usize = 1_000_000;
/// Largest number of columns rendered for one table.
pub const MAX_COLUMNS: usize = 256;
/// Largest number of output pages.
pub const MAX_PAGES: usize = 20_000;
/// Largest number of blocks (paragraphs, tables, images) in one document.
pub const MAX_BLOCKS: usize = 2_000_000;
/// Largest text size of a single paragraph in bytes.
pub const MAX_PARAGRAPH_BYTES: usize = 1 << 20;
/// Deepest nesting of lists/tables/quotes in readers.
pub const MAX_NESTING: usize = 32;

/// Fail with `limit_exceeded` when `n > max`.
pub fn check(n: usize, max: usize, what: &str) -> Result<()> {
    if n > max {
        return Err(CreateError::limit(format!("{what}: {n} > {max}")));
    }
    Ok(())
}

/// Validate image dimensions before any pixel buffer is allocated.
pub fn check_image(width: u32, height: u32) -> Result<()> {
    if width == 0 || height == 0 {
        return Err(CreateError::malformed("image has no pixels"));
    }
    if width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE {
        return Err(CreateError::limit(format!(
            "image is {width}×{height} pixels (largest side {MAX_IMAGE_SIDE})"
        )));
    }
    if u64::from(width) * u64::from(height) > MAX_IMAGE_PIXELS {
        return Err(CreateError::limit(format!(
            "image is {width}×{height} pixels (more than {MAX_IMAGE_PIXELS})"
        )));
    }
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn image_bombs_are_refused_before_allocation() {
        assert!(check_image(1, 1).is_ok());
        assert_eq!(check_image(0, 5).unwrap_err().code(), "malformed_input");
        assert_eq!(check_image(65_001, 1).unwrap_err().code(), "limit_exceeded");
        assert_eq!(
            check_image(60_000, 60_000).unwrap_err().code(),
            "limit_exceeded"
        );
        assert!(check(3, 2, "x").is_err());
    }
}
