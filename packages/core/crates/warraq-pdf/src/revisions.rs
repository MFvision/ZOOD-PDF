//! Incremental revisions: every `startxref N %%EOF` ends one revision. Revision `k` is the
//! byte prefix up to and including its `%%EOF` line — exactly the file as it was saved then.
//!
//! Linearized files carry a first-page trailer with its own `%%EOF` that is not a separate
//! revision; when the first object is a linearization dictionary, that boundary is merged.

use crate::error::{PdfError, Result};
use crate::limits::Limits;

/// One revision boundary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Revision {
    /// 0-based revision number (0 = the original file).
    pub index: usize,
    /// Byte length of the file at this revision (end of the `%%EOF` line).
    pub end: usize,
    /// The `startxref` value of this revision.
    pub startxref: Option<usize>,
}

fn parse_startxref(before: &[u8]) -> Option<usize> {
    let pos = before.windows(9).rposition(|w| w == b"startxref")?;
    let rest = before.get(pos + 9..)?;
    let digits: Vec<u8> = rest
        .iter()
        .skip_while(|b| b.is_ascii_whitespace())
        .take_while(|b| b.is_ascii_digit())
        .copied()
        .collect();
    if digits.is_empty() || digits.len() > 12 {
        return None;
    }
    std::str::from_utf8(&digits).ok()?.parse().ok()
}

/// List the revisions of `bytes`.
pub fn revisions(bytes: &[u8], limits: &Limits) -> Vec<Revision> {
    let mut out = Vec::new();
    let mut i = 0;
    while let Some(rel) = bytes
        .get(i..)
        .and_then(|s| s.windows(5).position(|w| w == b"%%EOF"))
    {
        let pos = i + rel;
        let mut end = pos + 5;
        match (bytes.get(end), bytes.get(end + 1)) {
            (Some(b'\r'), Some(b'\n')) => end += 2,
            (Some(b'\r' | b'\n'), _) => end += 1,
            _ => {}
        }
        let window = bytes.get(pos.saturating_sub(64)..pos).unwrap_or_default();
        if let Some(sx) = parse_startxref(window) {
            out.push(Revision {
                index: 0,
                end,
                startxref: Some(sx),
            });
            if out.len() >= limits.max_revisions {
                break;
            }
        }
        i = pos + 5;
    }
    let head = bytes.get(..bytes.len().min(1024)).unwrap_or(bytes);
    let linearized = head.windows(11).any(|w| w == b"/Linearized");
    if linearized && out.len() >= 2 {
        out.remove(0);
    }
    for (k, r) in out.iter_mut().enumerate() {
        r.index = k;
    }
    out
}

/// The bytes of revision `index` (a prefix of `bytes`).
pub fn revision_bytes<'a>(bytes: &'a [u8], index: usize, limits: &Limits) -> Result<&'a [u8]> {
    let revs = revisions(bytes, limits);
    let r = revs.get(index).ok_or_else(|| {
        PdfError::InvalidArgument(format!(
            "revision {index} does not exist ({} revisions)",
            revs.len()
        ))
    })?;
    bytes
        .get(..r.end)
        .ok_or_else(|| PdfError::Structure("revision end past file end".into()))
}
