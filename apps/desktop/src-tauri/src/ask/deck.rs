//! "Make me a presentation": the island writes the slides with the local
//! model and builds the PowerPoint file itself (`ask/deck.ts`); here it is
//! saved in Documents › ZOOD PDF, never over a file already there, and
//! opened in the app the system opens presentations with.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime};

/// The biggest presentation saved: a few slides of text and pictures drawn
/// by the island are well under this.
const MOST_BYTES: usize = 40 * 1024 * 1024;

/// A title made a file name: no path parts, no characters a system refuses.
pub fn file_name(title: &str) -> String {
    let clean: String = title
        .chars()
        .filter(|c| !c.is_control() && !"/\\:*?\"<>|".contains(*c))
        .take(80)
        .collect();
    let clean = clean.trim().trim_matches('.').trim();
    let stem = if clean.is_empty() {
        "Presentation"
    } else {
        clean
    };
    format!("{stem}.pptx")
}

/// `path`, or "name (2).pptx", "name (3).pptx"… when it is taken.
fn free(path: &Path) -> PathBuf {
    if !path.exists() {
        return path.to_path_buf();
    }
    let parent = path.parent().unwrap_or(Path::new(""));
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    (2..10_000)
        .map(|n| parent.join(format!("{stem} ({n}).pptx")))
        .find(|p| !p.exists())
        .unwrap_or_else(|| path.to_path_buf())
}

/// Whether `bytes` look like a PowerPoint file: a zip, within the size.
pub fn looks_right(bytes: &[u8]) -> bool {
    bytes.len() <= MOST_BYTES && bytes.starts_with(b"PK\x03\x04")
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
    if !looks_right(bytes) {
        return Err("E_ARGS: that is not a presentation".into());
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
    let path = free(&folder.join(file_name(&title)));
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
    fn only_a_zip_within_the_size_is_saved() {
        assert!(looks_right(b"PK\x03\x04rest"));
        assert!(!looks_right(b"MZ\x90\x00"));
        assert!(!looks_right(b""));
    }
}
