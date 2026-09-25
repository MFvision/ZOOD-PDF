//! Readers: source files → [`Document`]. Each reader is bounded (see [`crate::limits`]) and
//! returns errors as values.

pub mod csv;
pub mod docx;
pub mod html;
pub mod images;
pub mod markdown;
pub mod pptx;
pub mod text;
pub mod tiff;
pub mod xlsx;
pub mod xml;
pub mod zip;

use crate::error::{CreateError, Result};
use crate::model::{Document, Family, PageSetup, Style};

/// Options shared by readers.
#[derive(Debug, Clone)]
pub struct ReadOptions {
    /// Page setup for flowing content when the source has none.
    pub page: PageSetup,
    /// Direction of neutral content (UI locale is Arabic).
    pub default_rtl: bool,
    /// Base style for text without formatting.
    pub base: Style,
}

impl Default for ReadOptions {
    fn default() -> Self {
        ReadOptions {
            page: PageSetup::default(),
            default_rtl: false,
            base: Style {
                family: Family::Sans,
                size: 11.0,
                ..Style::default()
            },
        }
    }
}

/// A recognised input format.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Docx,
    Xlsx,
    Pptx,
    Html,
    Markdown,
    Text,
    Csv,
    Jpeg,
    Png,
    Tiff,
}

impl Format {
    pub fn as_str(self) -> &'static str {
        match self {
            Format::Docx => "docx",
            Format::Xlsx => "xlsx",
            Format::Pptx => "pptx",
            Format::Html => "html",
            Format::Markdown => "markdown",
            Format::Text => "text",
            Format::Csv => "csv",
            Format::Jpeg => "jpeg",
            Format::Png => "png",
            Format::Tiff => "tiff",
        }
    }

    /// Parse an explicit type from the RPC (`"docx"`, `"md"`, a MIME type…).
    pub fn from_hint(h: &str) -> Option<Format> {
        let h = h.trim().to_ascii_lowercase();
        let h = h.rsplit('.').next().unwrap_or(&h).to_string();
        Some(match h.as_str() {
            "docx" | "vnd.openxmlformats-officedocument.wordprocessingml.document" => Format::Docx,
            "xlsx" | "vnd.openxmlformats-officedocument.spreadsheetml.sheet" => Format::Xlsx,
            "pptx" | "vnd.openxmlformats-officedocument.presentationml.presentation" => {
                Format::Pptx
            }
            "html" | "htm" | "xhtml" | "text/html" => Format::Html,
            "md" | "markdown" | "text/markdown" => Format::Markdown,
            "txt" | "text" | "text/plain" => Format::Text,
            "csv" | "tsv" | "text/csv" => Format::Csv,
            "jpg" | "jpeg" | "image/jpeg" => Format::Jpeg,
            "png" | "image/png" => Format::Png,
            "tif" | "tiff" | "image/tiff" => Format::Tiff,
            _ => return None,
        })
    }
}

/// Recognise a file from its bytes (magic numbers and zip contents), falling back to its name.
pub fn detect(name: &str, bytes: &[u8]) -> Result<Format> {
    if let Some(kind) = crate::image::sniff(bytes) {
        return match kind {
            "jpeg" => Ok(Format::Jpeg),
            "png" => Ok(Format::Png),
            "tiff" => Ok(Format::Tiff),
            other => Err(CreateError::Unsupported(format!("{other} pictures"))),
        };
    }
    if bytes.starts_with(b"%PDF-") {
        return Err(CreateError::Unsupported(
            "PDF (open it or use Combine instead)".into(),
        ));
    }
    if bytes.starts_with(b"PK\x03\x04") || bytes.starts_with(b"PK\x05\x06") {
        let z = zip::Zip::open(bytes)?;
        if z.has("word/document.xml") {
            return Ok(Format::Docx);
        }
        if z.has("xl/workbook.xml") {
            return Ok(Format::Xlsx);
        }
        if z.has("ppt/presentation.xml") {
            return Ok(Format::Pptx);
        }
        return Err(CreateError::Unsupported("zip archive".into()));
    }
    if bytes.starts_with(&[0xD0, 0xCF, 0x11, 0xE0]) {
        return Err(CreateError::Unsupported(
            "legacy Office file (.doc/.xls/.ppt): save it as .docx/.xlsx/.pptx".into(),
        ));
    }
    if let Some(f) = Format::from_hint(name) {
        if matches!(
            f,
            Format::Docx | Format::Xlsx | Format::Pptx | Format::Jpeg | Format::Png | Format::Tiff
        ) {
            return Err(CreateError::malformed(format!(
                "{name} is not a valid {}",
                f.as_str()
            )));
        }
        return Ok(f);
    }
    // Unknown name: text-like content is read as text, HTML if it looks like it.
    let head = String::from_utf8_lossy(bytes.get(..bytes.len().min(512)).unwrap_or(&[]))
        .to_ascii_lowercase();
    if head.contains("<!doctype html") || head.contains("<html") {
        return Ok(Format::Html);
    }
    if std::str::from_utf8(bytes).is_ok() {
        return Ok(Format::Text);
    }
    Err(CreateError::Unsupported(format!(
        "unknown file type: {name}"
    )))
}

/// Decode text bytes: UTF-8 (with or without BOM), UTF-16 with BOM; lossy otherwise.
pub fn decode_text(bytes: &[u8]) -> String {
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(rest).into_owned();
    }
    let utf16 = |le: bool, b: &[u8]| {
        let units: Vec<u16> = b
            .chunks_exact(2)
            .map(|c| {
                let a = [
                    c.first().copied().unwrap_or(0),
                    c.get(1).copied().unwrap_or(0),
                ];
                if le {
                    u16::from_le_bytes(a)
                } else {
                    u16::from_be_bytes(a)
                }
            })
            .collect();
        String::from_utf16_lossy(&units)
    };
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        return utf16(true, rest);
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        return utf16(false, rest);
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        // Legacy Arabic Windows-1256 is common for old .txt/.csv files.
        Err(_) => windows_1256(bytes),
    }
}

/// Windows-1256 (Arabic) to UTF-8.
fn windows_1256(bytes: &[u8]) -> String {
    const HIGH: [u16; 128] = [
        0x20AC, 0x067E, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0679,
        0x2039, 0x0152, 0x0686, 0x0698, 0x0688, 0x06AF, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022,
        0x2013, 0x2014, 0x06A9, 0x2122, 0x0691, 0x203A, 0x0153, 0x200C, 0x200D, 0x06BA, 0x00A0,
        0x060C, 0x00A2, 0x00A3, 0x00A4, 0x00A5, 0x00A6, 0x00A7, 0x00A8, 0x00A9, 0x06BE, 0x00AB,
        0x00AC, 0x00AD, 0x00AE, 0x00AF, 0x00B0, 0x00B1, 0x00B2, 0x00B3, 0x00B4, 0x00B5, 0x00B6,
        0x00B7, 0x00B8, 0x00B9, 0x061B, 0x00BB, 0x00BC, 0x00BD, 0x00BE, 0x061F, 0x06C1, 0x0621,
        0x0622, 0x0623, 0x0624, 0x0625, 0x0626, 0x0627, 0x0628, 0x0629, 0x062A, 0x062B, 0x062C,
        0x062D, 0x062E, 0x062F, 0x0630, 0x0631, 0x0632, 0x0633, 0x0634, 0x0635, 0x0636, 0x00D7,
        0x0637, 0x0638, 0x0639, 0x063A, 0x0640, 0x0641, 0x0642, 0x0643, 0x00E0, 0x0644, 0x00E2,
        0x0645, 0x0646, 0x0647, 0x0648, 0x00E7, 0x00E8, 0x00E9, 0x00EA, 0x00EB, 0x0649, 0x064A,
        0x00EE, 0x00EF, 0x064B, 0x064C, 0x064D, 0x064E, 0x00F4, 0x064F, 0x0650, 0x00F7, 0x0651,
        0x00F9, 0x0652, 0x00FB, 0x00FC, 0x200E, 0x200F, 0x06D2,
    ];
    bytes
        .iter()
        .map(|&b| {
            if b < 0x80 {
                char::from(b)
            } else {
                HIGH.get(usize::from(b - 0x80))
                    .and_then(|&u| char::from_u32(u32::from(u)))
                    .unwrap_or('\u{FFFD}')
            }
        })
        .collect()
}

/// Read one file into a document.
pub fn read(format: Format, name: &str, bytes: &[u8], opts: &ReadOptions) -> Result<Document> {
    let mut doc = match format {
        Format::Docx => docx::read(bytes, opts)?,
        Format::Xlsx => xlsx::read(bytes, opts)?,
        Format::Pptx => pptx::read(bytes, opts)?,
        Format::Html => html::read(&decode_text(bytes), opts)?,
        Format::Markdown => markdown::read(&decode_text(bytes), opts)?,
        Format::Text => text::read(&decode_text(bytes), opts)?,
        Format::Csv => csv::read(&decode_text(bytes), name, opts)?,
        Format::Jpeg | Format::Png => images::read_picture(bytes, name)?,
        Format::Tiff => images::read_tiff(bytes, name)?,
    };
    if doc.title.is_none() {
        let stem = name.rsplit(['/', '\\']).next().unwrap_or(name);
        let stem = stem.rsplit_once('.').map_or(stem, |(a, _)| a);
        if !stem.is_empty() {
            doc.title = Some(stem.chars().take(200).collect());
        }
    }
    Ok(doc)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn detection() {
        assert_eq!(detect("a.md", b"# hi").unwrap(), Format::Markdown);
        assert_eq!(detect("x", b"<!DOCTYPE html><p>").unwrap(), Format::Html);
        assert_eq!(detect("x", "نص".as_bytes()).unwrap(), Format::Text);
        assert_eq!(detect("a.csv", b"a,b").unwrap(), Format::Csv);
        assert_eq!(
            detect("a.pdf", b"%PDF-1.7").unwrap_err().code(),
            "unsupported_format"
        );
        assert_eq!(
            detect("a.docx", b"hello").unwrap_err().code(),
            "malformed_input"
        );
    }

    #[test]
    fn text_decoding() {
        assert_eq!(decode_text(b"\xEF\xBB\xBFabc"), "abc");
        assert_eq!(decode_text(&[0xFF, 0xFE, 0x28, 0x06]), "ب");
        assert_eq!(decode_text(&[0xC8, 0xC7, 0xC8]), "باب");
    }
}
