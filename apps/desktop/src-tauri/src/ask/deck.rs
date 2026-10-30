//! "Make me a presentation": the island writes the slides with the local
//! model and builds the PowerPoint file itself (`ask/deck.ts`); here it is
//! saved in Documents › ZOOD PDF, never over a file already there, and
//! opened in the app the system opens presentations with. An answer kept as
//! a PDF or a Word file (`ask/answerFile.ts`) is saved the same way.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime};

/// The biggest presentation saved: a few slides of text and pictures drawn
/// by the island are well under this.
const MOST_BYTES: usize = 40 * 1024 * 1024;

/// What the island saves: a presentation, a PDF or a Word file.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Pptx,
    Pdf,
    Docx,
}

impl Kind {
    /// From the `x-warraq-kind` header; a presentation when there is none.
    pub fn from_header(value: Option<&str>) -> Option<Kind> {
        match value.unwrap_or("pptx") {
            "pptx" => Some(Kind::Pptx),
            "pdf" => Some(Kind::Pdf),
            "docx" => Some(Kind::Docx),
            _ => None,
        }
    }

    fn extension(self) -> &'static str {
        match self {
            Kind::Pptx => "pptx",
            Kind::Pdf => "pdf",
            Kind::Docx => "docx",
        }
    }

    fn fallback(self) -> &'static str {
        match self {
            Kind::Pptx => "Presentation",
            Kind::Pdf | Kind::Docx => "Answer",
        }
    }
}

/// A title made a file name: no path parts, no characters a system refuses.
pub fn file_name(title: &str) -> String {
    file_name_for(title, Kind::Pptx)
}

/// A title made the name of a file of `kind`.
pub fn file_name_for(title: &str, kind: Kind) -> String {
    let clean: String = title
        .chars()
        .filter(|c| !c.is_control() && !"/\\:*?\"<>|".contains(*c))
        .take(80)
        .collect();
    let clean = clean.trim().trim_matches('.').trim();
    let stem = if clean.is_empty() {
        kind.fallback()
    } else {
        clean
    };
    format!("{stem}.{}", kind.extension())
}

/// `path`, or "name (2).pptx", "name (3).pptx"… when it is taken.
fn free(path: &Path) -> PathBuf {
    let extension = path
        .extension()
        .map(|e| e.to_string_lossy().into_owned())
        .unwrap_or_default();
    if !path.exists() {
        return path.to_path_buf();
    }
    let parent = path.parent().unwrap_or(Path::new(""));
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    (2..10_000)
        .map(|n| parent.join(format!("{stem} ({n}).{extension}")))
        .find(|p| !p.exists())
        .unwrap_or_else(|| path.to_path_buf())
}

/// Whether `bytes` look like a PowerPoint file: a zip, within the size.
pub fn looks_right(bytes: &[u8]) -> bool {
    looks_like(bytes, Kind::Pptx)
}

/// Whether `bytes` look like a file of `kind`: a zip (PowerPoint, Word) or
/// a PDF, within the size.
pub fn looks_like(bytes: &[u8], kind: Kind) -> bool {
    bytes.len() <= MOST_BYTES
        && match kind {
            Kind::Pptx | Kind::Docx => bytes.starts_with(b"PK\x03\x04"),
            Kind::Pdf => bytes.starts_with(b"%PDF-"),
        }
}

/// Saves the presentation the island built and opens it. The body is the
/// file; `x-warraq-name` (percent-encoded) its title. Returns the path.
#[tauri::command(async)]
pub fn ask_save_deck<R: Runtime>(
    app: AppHandle<R>,
    request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("E_ARGS: the presentation travels as a raw body".into());
    };
    let kind = Kind::from_header(
        request
            .headers()
            .get("x-warraq-kind")
            .and_then(|value| value.to_str().ok()),
    )
    .ok_or("E_ARGS: Ask ZOOD saves presentations, PDFs and Word files")?;
    if !looks_like(bytes, kind) {
        return Err("E_ARGS: that is not the file it says it is".into());
    }
    let title = request
        .headers()
        .get("x-warraq-name")
        .and_then(|value| value.to_str().ok())
        .and_then(crate::batch::percent_decode)
        .unwrap_or_default();
    let folder = app
        .path()
        .document_dir()
        .map_err(|e| format!("E_IO: no Documents folder: {e}"))?
        .join("ZOOD PDF");
    std::fs::create_dir_all(&folder).map_err(|e| format!("E_IO: {e}"))?;
    let path = free(&folder.join(file_name_for(&title, kind)));
    std::fs::write(&path, bytes).map_err(|e| format!("E_IO: {e}"))?;
    let shown = path.to_string_lossy().into_owned();
    let mut child = crate::opener(&shown)
        .spawn()
        .map_err(|e| format!("E_IO: saved, but it could not be opened: {e}"))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(shown)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_title_becomes_a_safe_file_name() {
        assert_eq!(
            file_name("Q3 results: sales/marketing"),
            "Q3 results salesmarketing.pptx"
        );
        assert_eq!(file_name("  ..  "), "Presentation.pptx");
        assert_eq!(file_name("خطة المشروع"), "خطة المشروع.pptx");
        assert_eq!(file_name("../../etc/passwd"), "etcpasswd.pptx");
    }

    #[test]
    fn an_answer_is_saved_as_a_pdf_or_a_word_file() {
        assert_eq!(Kind::from_header(None), Some(Kind::Pptx));
        assert_eq!(Kind::from_header(Some("pdf")), Some(Kind::Pdf));
        assert_eq!(Kind::from_header(Some("exe")), None);
        assert_eq!(file_name_for("Company hub", Kind::Pdf), "Company hub.pdf");
        assert_eq!(file_name_for(" / ", Kind::Docx), "Answer.docx");
        assert!(looks_like(b"%PDF-1.7\n", Kind::Pdf));
        assert!(!looks_like(b"PK\x03\x04", Kind::Pdf));
        assert!(looks_like(b"PK\x03\x04", Kind::Docx));
        assert!(!looks_like(b"%PDF-1.7", Kind::Docx));
    }

    #[test]
    fn only_a_zip_within_the_size_is_saved() {
        assert!(looks_right(b"PK\x03\x04rest"));
        assert!(!looks_right(b"MZ\x90\x00"));
        assert!(!looks_right(b""));
    }
}
