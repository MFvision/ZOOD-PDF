//! Bounds for everything that is driven by input bytes. Every loop, recursion and
//! allocation whose size comes from a PDF is checked against one of these numbers.
//!
//! The defaults are chosen for a browser tab (wasm32 has a 4 GiB address space) and a
//! desktop app alike. Callers may tighten them (the smoke fuzz test does).

use crate::error::{PdfError, Result};

/// Largest input file accepted (1 GiB).
pub const MAX_FILE_SIZE: usize = 1 << 30;
/// Largest number of indirect objects in one document.
pub const MAX_OBJECTS: usize = 4_000_000;
/// Deepest nesting of arrays/dictionaries/page-tree levels we walk recursively.
pub const MAX_DEPTH: usize = 256;
/// Largest decoded size of any single stream (512 MiB).
pub const MAX_DECODE_SIZE: usize = 512 << 20;
/// Largest decoded/encoded ratio of a single stream before we call it a zip bomb.
pub const MAX_DECODE_RATIO: usize = 1_100;
/// Decoded size every stream may reach regardless of the ratio (small streams can have
/// huge ratios legitimately, e.g. a flat white image).
pub const DECODE_RATIO_FLOOR: usize = 16 << 20;
/// Largest number of content-stream operators processed per page.
pub const MAX_CONTENT_OPS: usize = 5_000_000;
/// Largest number of pages in a page tree.
pub const MAX_PAGES: usize = 200_000;
/// Largest number of incremental revisions we enumerate.
pub const MAX_REVISIONS: usize = 10_000;
/// Files larger than this are saved by a whole rewrite rather than an incremental update
/// (SPEC §1: "files > 150 MB are whole rewrites").
pub const FULL_REWRITE_THRESHOLD: usize = 150 * 1_000_000;

/// Runtime-adjustable limits. `Limits::default()` uses the constants above.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    /// See [`MAX_FILE_SIZE`].
    pub max_file_size: usize,
    /// See [`MAX_OBJECTS`].
    pub max_objects: usize,
    /// See [`MAX_DEPTH`].
    pub max_depth: usize,
    /// See [`MAX_DECODE_SIZE`].
    pub max_decode_size: usize,
    /// See [`MAX_DECODE_RATIO`].
    pub max_decode_ratio: usize,
    /// See [`DECODE_RATIO_FLOOR`].
    pub decode_ratio_floor: usize,
    /// See [`MAX_CONTENT_OPS`].
    pub max_content_ops: usize,
    /// See [`MAX_PAGES`].
    pub max_pages: usize,
    /// See [`MAX_REVISIONS`].
    pub max_revisions: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            max_file_size: MAX_FILE_SIZE,
            max_objects: MAX_OBJECTS,
            max_depth: MAX_DEPTH,
            max_decode_size: MAX_DECODE_SIZE,
            max_decode_ratio: MAX_DECODE_RATIO,
            decode_ratio_floor: DECODE_RATIO_FLOOR,
            max_content_ops: MAX_CONTENT_OPS,
            max_pages: MAX_PAGES,
            max_revisions: MAX_REVISIONS,
        }
    }
}

impl Limits {
    /// Reject inputs larger than `max_file_size`.
    pub fn check_file_size(&self, len: usize) -> Result<()> {
        if len > self.max_file_size {
            return Err(PdfError::Limit(format!(
                "file is {len} bytes, the maximum is {}",
                self.max_file_size
            )));
        }
        Ok(())
    }

    /// The largest decoded size allowed for a stream whose encoded size is `encoded_len`:
    /// `min(max_decode_size, max(encoded_len * ratio, floor))`.
    pub fn decode_cap(&self, encoded_len: usize) -> usize {
        encoded_len
            .saturating_mul(self.max_decode_ratio)
            .max(self.decode_ratio_floor)
            .min(self.max_decode_size)
    }

    /// Fail when a recursion reached `depth`.
    pub fn check_depth(&self, depth: usize) -> Result<()> {
        if depth > self.max_depth {
            return Err(PdfError::Limit(format!(
                "nesting deeper than {}",
                self.max_depth
            )));
        }
        Ok(())
    }
}

/// Decode a stream's content (all standard filters lopdf knows) with the zip-bomb caps.
/// Returns the raw bytes when the stream has no filter.
pub fn decode_stream(stream: &lopdf::Stream, limits: &Limits) -> Result<Vec<u8>> {
    if stream.filters().map(|f| f.is_empty()).unwrap_or(true) {
        return Ok(stream.content.clone());
    }
    let cap = limits.decode_cap(stream.content.len());
    stream
        .decompressed_content_with_limit(cap)
        .map_err(|e| PdfError::Limit(format!("stream decode failed or exceeded {cap} bytes: {e}")))
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
mod tests {
    use super::*;
    use lopdf::{dictionary, Stream};
    use std::io::Write;

    #[test]
    fn decode_cap_uses_ratio_floor_and_max() {
        let l = Limits::default();
        assert_eq!(l.decode_cap(0), DECODE_RATIO_FLOOR);
        assert_eq!(l.decode_cap(100_000), 100_000 * MAX_DECODE_RATIO);
        assert_eq!(l.decode_cap(usize::MAX), MAX_DECODE_SIZE);
    }

    #[test]
    fn file_size_limit() {
        let l = Limits {
            max_file_size: 10,
            ..Limits::default()
        };
        assert!(l.check_file_size(10).is_ok());
        assert_eq!(l.check_file_size(11).unwrap_err().code(), "limit_exceeded");
    }

    #[test]
    fn zip_bomb_is_refused() {
        // 64 MiB of zeros compresses to ~64 KiB: ratio ~1000 but above the tightened floor.
        let mut enc = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::best());
        let chunk = vec![0u8; 1 << 20];
        for _ in 0..64 {
            enc.write_all(&chunk).unwrap();
        }
        let data = enc.finish().unwrap();
        let s = Stream::new(dictionary! {"Filter" => "FlateDecode"}, data);
        let tight = Limits {
            decode_ratio_floor: 1 << 20,
            max_decode_ratio: 100,
            ..Limits::default()
        };
        assert!(decode_stream(&s, &tight).is_err());
        let ok = decode_stream(&s, &Limits::default()).unwrap();
        assert_eq!(ok.len(), 64 << 20);
    }
}
