//! The batch's files on the desktop: the PDFs in a folder the person chose,
//! and each result written beside its original or into a chosen folder —
//! never over a file that is already there.
//!
//! Reads go through `read_file_bytes` like every other file, and are limited
//! to the fs scope the dialog and the drop handler grant. Writes are limited
//! the same way: into a folder chosen in the dialog (the dialog puts it in
//! the scope), or into the folder of a file chosen there — "beside the
//! original", which is the choice of that file's folder the person made by
//! choosing the file. A name is a plain file name, never a path.
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Runtime};
use tauri_plugin_fs::FsExt;

use crate::core_bridge::debug_log;

/// A folder is walked this deep, and no further.
const MAX_DEPTH: usize = 16;
/// The most PDFs listed from one folder.
const MAX_FILES: usize = 10_000;
/// The most entries looked at, PDFs or not: a folder of a million files
/// must not hang the window.
const MAX_ENTRIES: usize = 200_000;
/// "report (2).pdf", "report (3).pdf" … at most this many tries.
const MAX_TRIES: u32 = 1000;

/// A PDF found in a folder.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct FolderPdf {
    pub path: String,
    pub name: String,
    /// Its place under the chosen folder, `/`-separated.
    pub relative: String,
    pub size: u64,
}

fn is_pdf(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("pdf"))
}

/// The PDFs under `root`, in path order: subfolders too when `recursive`,
/// hidden files and folders left out, links not followed.
pub fn list_pdfs(root: &Path, recursive: bool) -> std::io::Result<Vec<FolderPdf>> {
    let mut found = Vec::new();
    let mut entries = 0usize;
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let mut children: Vec<_> = std::fs::read_dir(&dir)?.flatten().collect();
        children.sort_by_key(|e| e.file_name());
        for entry in children {
            entries += 1;
            if entries > MAX_ENTRIES || found.len() >= MAX_FILES {
                return Ok(sorted(found));
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            // `file_type` does not follow a link: a link is neither.
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            if kind.is_dir() {
                if recursive && depth + 1 < MAX_DEPTH {
                    stack.push((path, depth + 1));
                }
            } else if kind.is_file() && is_pdf(&path) {
                let relative = path
                    .strip_prefix(root)
                    .unwrap_or(&path)
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy())
                    .collect::<Vec<_>>()
                    .join("/");
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                found.push(FolderPdf {
                    path: path.to_string_lossy().into_owned(),
                    name,
                    relative,
                    size,
                });
            }
        }
    }
    Ok(sorted(found))
}

fn sorted(mut found: Vec<FolderPdf>) -> Vec<FolderPdf> {
    found.sort_by(|a, b| a.relative.cmp(&b.relative));
    found
}

/// `name` when it is a plain file name: no folder in it, nothing hidden, not
/// empty, not too long for a file system.
pub fn plain_name(name: &str) -> Option<&str> {
    let mut parts = Path::new(name).components();
    let only = matches!(
        (parts.next(), parts.next()),
        (Some(Component::Normal(_)), None)
    );
    let ok = only
        && !name.starts_with('.')
        && !name.contains(['/', '\\', ':', '\0'])
        && name.len() <= 255
        && !name.trim().is_empty();
    ok.then_some(name)
}

/// "report.pdf" as the `n`th try: "report (n).pdf" from the second on.
fn numbered(name: &str, n: u32) -> String {
    if n <= 1 {
        return name.to_string();
    }
    match name.rfind('.') {
        Some(dot) if dot > 0 => format!("{} ({n}){}", &name[..dot], &name[dot..]),
        _ => format!("{name} ({n})"),
    }
}

/// Writes `bytes` to `dir/name`, or to "name (2)", "name (3)" … when a file
/// is there already: a file that exists is never opened for writing. Returns
/// the path written.
pub fn write_new(dir: &Path, name: &str, bytes: &[u8]) -> std::io::Result<PathBuf> {
    let name = plain_name(name).ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "not a plain file name")
    })?;
    for n in 1..=MAX_TRIES {
        let target = dir.join(numbered(name, n));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
        {
            Ok(mut file) => {
                let written = file.write_all(bytes).and_then(|()| file.sync_all());
                if let Err(e) = written {
                    // Half a file is worse than none.
                    drop(file);
                    let _ = std::fs::remove_file(&target);
                    return Err(e);
                }
                return Ok(target);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "no free name for the result",
    ))
}

fn decoded(header: Option<&tauri::http::HeaderValue>) -> Option<String> {
    let raw = header?.to_str().ok()?;
    percent_decode(raw)
}

/// `%XX` escapes back to UTF-8 (the path and name travel in ASCII headers).
pub(crate) fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = text.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The PDFs in a folder chosen in the dialog (which put it in the fs scope).
/// Off the main thread, as a large folder takes a while to walk.
#[tauri::command(async)]
pub fn batch_list_folder<R: Runtime>(
    app: AppHandle<R>,
    path: String,
    recursive: bool,
) -> Result<Vec<FolderPdf>, String> {
    let dir = PathBuf::from(&path);
    if !dir.is_absolute() || !dir.is_dir() {
        return Err(format!("E_SCOPE: not a folder: {path}"));
    }
    if !app.fs_scope().is_allowed(&dir) {
        return Err(format!("E_SCOPE: {path} was not chosen through the dialog"));
    }
    let found = list_pdfs(&dir, recursive).map_err(|e| format!("E_IO: {path}: {e}"))?;
    // The dialog put the folder in the scope with everything under it
    // (`recursive`), so `read_file_bytes` reads what is listed here and
    // nothing more is granted.
    debug_log(format!("batch: {} PDFs in {path}", found.len()));
    Ok(found)
}

/// Writes one result. The body is the file; the headers say where, both
/// percent-encoded: `x-warraq-name`, a plain file name, and either
/// `x-warraq-dir`, a folder chosen in the dialog, or `x-warraq-beside`, a
/// file chosen there (the result goes into its folder). Off the main thread.
#[tauri::command(async)]
pub fn batch_write<R: Runtime>(
    app: AppHandle<R>,
    request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("E_ARGS: the result travels as a raw body".into());
    };
    let headers = request.headers();
    let name = decoded(headers.get("x-warraq-name")).ok_or("E_ARGS: no file name")?;
    let scope = app.fs_scope();
    let dir = if let Some(dir) = decoded(headers.get("x-warraq-dir")) {
        let dir = PathBuf::from(dir);
        if !dir.is_absolute() || !dir.is_dir() || !scope.is_allowed(&dir) {
            return Err(format!(
                "E_SCOPE: {} is not a folder chosen through the dialog",
                dir.display()
            ));
        }
        dir
    } else if let Some(source) = decoded(headers.get("x-warraq-beside")) {
        let source = PathBuf::from(source);
        if !source.is_absolute() || !scope.is_allowed(&source) {
            return Err(format!(
                "E_SCOPE: {} was not chosen through the dialog",
                source.display()
            ));
        }
        source
            .parent()
            .filter(|p| p.is_dir())
            .map(Path::to_path_buf)
            .ok_or("E_SCOPE: the original has no folder")?
    } else {
        return Err("E_ARGS: no folder for the result".into());
    };
    let written = write_new(&dir, &name, bytes).map_err(|e| format!("E_IO: {e}"))?;
    debug_log(format!("batch: wrote {}", written.display()));
    Ok(written.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A folder of its own in the system temporary directory, as `tests/print.rs` uses.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("warraq-batch-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_result_never_goes_over_a_file_that_is_there() {
        let dir = scratch("write");
        std::fs::write(dir.join("report-processed.pdf"), b"original").unwrap();
        let first = write_new(&dir, "report-processed.pdf", b"new one").unwrap();
        assert_eq!(first, dir.join("report-processed (2).pdf"));
        let second = write_new(&dir, "report-processed.pdf", b"another").unwrap();
        assert_eq!(second, dir.join("report-processed (3).pdf"));
        assert_eq!(
            std::fs::read(dir.join("report-processed.pdf")).unwrap(),
            b"original"
        );
        assert_eq!(std::fs::read(first).unwrap(), b"new one");
        let fresh = write_new(&dir, "تقرير.pdf", b"arabic").unwrap();
        assert_eq!(fresh, dir.join("تقرير.pdf"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_name_with_a_folder_in_it_is_refused() {
        for bad in [
            "../x.pdf",
            "a/b.pdf",
            "/etc/passwd",
            "",
            " ",
            ".hidden.pdf",
            "a\\b.pdf",
            "c:x.pdf",
        ] {
            assert_eq!(plain_name(bad), None, "{bad:?}");
        }
        assert_eq!(plain_name("تقرير (2).pdf"), Some("تقرير (2).pdf"));
        let dir = scratch("names");
        assert!(write_new(&dir, "../escape.pdf", b"x").is_err());
        assert!(!dir.parent().unwrap().join("escape.pdf").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_folder_lists_its_pdfs_and_those_below_it_and_nothing_hidden() {
        let dir = scratch("list");
        std::fs::create_dir_all(dir.join("sub/deeper")).unwrap();
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        for file in [
            "b.pdf",
            "a.PDF",
            "notes.txt",
            ".secret.pdf",
            "sub/c.pdf",
            "sub/deeper/d.pdf",
            ".git/e.pdf",
        ] {
            std::fs::write(dir.join(file), b"%PDF-1.7").unwrap();
        }
        let flat: Vec<String> = list_pdfs(&dir, false)
            .unwrap()
            .into_iter()
            .map(|p| p.relative)
            .collect();
        assert_eq!(flat, ["a.PDF", "b.pdf"]);
        let all = list_pdfs(&dir, true).unwrap();
        let relative: Vec<&str> = all.iter().map(|p| p.relative.as_str()).collect();
        assert_eq!(
            relative,
            ["a.PDF", "b.pdf", "sub/c.pdf", "sub/deeper/d.pdf"]
        );
        assert_eq!(all[0].size, 8);
        assert_eq!(all[2].name, "c.pdf");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn numbered_names_keep_their_extension() {
        assert_eq!(numbered("a.pdf", 1), "a.pdf");
        assert_eq!(numbered("a.pdf", 2), "a (2).pdf");
        assert_eq!(numbered("archive", 3), "archive (3)");
        assert_eq!(percent_decode("%D8%AA.pdf").as_deref(), Some("ت.pdf"));
        assert_eq!(percent_decode("%ZZ"), None);
    }
}
