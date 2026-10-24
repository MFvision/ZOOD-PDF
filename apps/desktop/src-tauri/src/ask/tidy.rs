//! Ask ZOOD tidies a folder: "organize my Downloads", "رتب سطح المكتب".
//!
//! A tidy is planned first (`ask_tidy_plan`) and shown as a preview; only
//! the plan the host made and kept is carried out (`ask_tidy_apply`), so the
//! interface can never name a file to move. Files are only moved or renamed,
//! never deleted or overwritten, never out of the folder they are in (into a
//! folder inside it at most), and only the files directly in it: folders and
//! what is inside them stay where they are. Every move is written to a
//! journal as it is made, and `ask_tidy_undo` puts each file back and removes
//! the folders the tidy made, if they are empty again.
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::{DateTime, Local};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, State};

use super::AskState;

/// The most files one tidy moves.
const MAX_MOVES: usize = 2000;
/// A PDF is read for "invoice" words only up to this size.
const READ_PDF_BYTES: u64 = 20 << 20;

/// Where to tidy.
#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Place {
    Downloads,
    Desktop,
    Documents,
    /// The files selected in File Explorer or Finder (or the folder selected).
    Selection,
}

/// How to tidy.
#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum How {
    /// Into a folder per kind: PDFs, pictures, documents…
    Type,
    /// Into a folder per month the file was last changed: "2026-10".
    Month,
    /// Each name starts with the day it was last changed: "2026-10-21 name.pdf".
    Date,
    /// Invoices and receipts gathered into one folder.
    Invoices,
}

/// The kinds a tidy by type sorts into.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Kind {
    Pdf,
    Images,
    Documents,
    Spreadsheets,
    Presentations,
    Archives,
    Audio,
    Video,
    Installers,
}

/// The folder names, in the person's language (the interface's words).
#[derive(Deserialize, Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Names {
    pub pdf: String,
    pub images: String,
    pub documents: String,
    pub spreadsheets: String,
    pub presentations: String,
    pub archives: String,
    pub audio: String,
    pub video: String,
    pub installers: String,
    pub invoices: String,
}

impl Names {
    fn of(&self, kind: Kind) -> &str {
        match kind {
            Kind::Pdf => &self.pdf,
            Kind::Images => &self.images,
            Kind::Documents => &self.documents,
            Kind::Spreadsheets => &self.spreadsheets,
            Kind::Presentations => &self.presentations,
            Kind::Archives => &self.archives,
            Kind::Audio => &self.audio,
            Kind::Video => &self.video,
            Kind::Installers => &self.installers,
        }
    }
}

pub fn kind_of(path: &Path) -> Option<Kind> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "pdf" => Kind::Pdf,
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "heic" | "heif" | "bmp" | "tif" | "tiff"
        | "svg" => Kind::Images,
        "doc" | "docx" | "odt" | "rtf" | "txt" | "md" | "pages" => Kind::Documents,
        "xls" | "xlsx" | "ods" | "csv" | "numbers" => Kind::Spreadsheets,
        "ppt" | "pptx" | "odp" | "key" => Kind::Presentations,
        "zip" | "rar" | "7z" | "tar" | "gz" | "tgz" | "bz2" | "xz" => Kind::Archives,
        "mp3" | "m4a" | "wav" | "aac" | "ogg" | "flac" | "opus" => Kind::Audio,
        "mp4" | "mov" | "mkv" | "avi" | "webm" | "m4v" => Kind::Video,
        "exe" | "msi" | "dmg" | "pkg" | "appx" | "msix" => Kind::Installers,
        _ => return None,
    })
}

/// Files a tidy leaves alone: hidden ones, the system's, downloads still
/// coming in, and shortcuts (they belong where the person put them).
pub fn left_alone(name: &str) -> bool {
    let lower = name.to_lowercase();
    name.starts_with('.')
        || name.starts_with('~')
        || lower == "desktop.ini"
        || lower == "thumbs.db"
        || [
            ".crdownload",
            ".part",
            ".partial",
            ".download",
            ".tmp",
            ".lnk",
            ".url",
            ".webloc",
            ".desktop",
            ".alias",
        ]
        .iter()
        .any(|ext| lower.ends_with(ext))
}

/// Words that make a file an invoice or a receipt, in its name or its first page.
const INVOICE_WORDS: &[&str] = &[
    "invoice",
    "receipt",
    "bill",
    "inv-",
    "inv_",
    "فاتورة",
    "فواتير",
    "ﻓﺎﺗﻮرة",
    "إيصال",
    "ايصال",
    "سند قبض",
    "tax invoice",
];

pub fn names_an_invoice(text: &str) -> bool {
    let lower = text.to_lowercase();
    INVOICE_WORDS.iter().any(|word| lower.contains(word))
}

/// "2026-10-21 ", "2026_10_21", "20261021": a name that already starts with a date.
pub fn starts_with_date(name: &str) -> bool {
    let digits: String = name.chars().take(10).collect();
    let b = digits.as_bytes();
    let dashed = b.len() >= 10
        && b[..4].iter().all(u8::is_ascii_digit)
        && matches!(b[4], b'-' | b'_' | b'.')
        && b[5..7].iter().all(u8::is_ascii_digit)
        && matches!(b[7], b'-' | b'_' | b'.')
        && b[8..10].iter().all(u8::is_ascii_digit);
    let packed = b.len() >= 8 && b[..8].iter().all(u8::is_ascii_digit) && b[..2] == *b"20";
    dashed || packed
}

/// A file the plan may move.
#[derive(Clone, Debug)]
pub struct Entry {
    pub path: PathBuf,
    /// Last changed, as the person's calendar has it: "2026-10-21".
    pub day: String,
    pub invoice: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Move {
    pub from: PathBuf,
    pub to: PathBuf,
}

/// The moves of a tidy of `folder`, before anything is touched. A target
/// already taken (or taken by an earlier move of the same plan) gets " (2)".
pub fn plan_moves(folder: &Path, entries: &[Entry], how: How, names: &Names) -> Vec<Move> {
    let mut taken: HashSet<PathBuf> = HashSet::new();
    let mut moves = Vec::new();
    for entry in entries {
        if moves.len() >= MAX_MOVES {
            break;
        }
        let Some(name) = entry.path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let target = match how {
            How::Type => match kind_of(&entry.path) {
                Some(kind) => folder.join(safe_folder(names.of(kind))).join(name),
                None => continue,
            },
            How::Month => folder.join(&entry.day[..7.min(entry.day.len())]).join(name),
            How::Date => {
                if starts_with_date(name) {
                    continue;
                }
                folder.join(format!("{} {name}", entry.day))
            }
            How::Invoices => {
                if !entry.invoice {
                    continue;
                }
                folder.join(safe_folder(&names.invoices)).join(name)
            }
        };
        if target == entry.path {
            continue;
        }
        let target = free_name(&target, &taken);
        taken.insert(target.clone());
        moves.push(Move {
            from: entry.path.clone(),
            to: target,
        });
    }
    moves
}

/// A folder name the interface gave, made a single safe path part.
pub(crate) fn safe_folder(name: &str) -> String {
    let clean: String = name
        .chars()
        .filter(|c| !c.is_control() && !"/\\:*?\"<>|".contains(*c))
        .take(60)
        .collect();
    let clean = clean.trim().trim_matches('.').to_string();
    if clean.is_empty() {
        "ZOOD".to_string()
    } else {
        clean
    }
}

/// `path`, or "name (2).ext", "name (3).ext"… when it is taken on disk or in `taken`.
pub(crate) fn free_name(path: &Path, taken: &HashSet<PathBuf>) -> PathBuf {
    let free = |p: &Path| !p.exists() && !taken.contains(p);
    if free(path) {
        return path.to_path_buf();
    }
    let parent = path.parent().unwrap_or(Path::new(""));
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    (2..10_000)
        .map(|n| parent.join(format!("{stem} ({n}){ext}")))
        .find(|p| free(p))
        .unwrap_or_else(|| path.to_path_buf())
}

/// The day a file was last changed, on this computer's calendar.
pub(crate) fn day_of(meta: &std::fs::Metadata) -> String {
    let time = meta
        .modified()
        .unwrap_or_else(|_| std::time::SystemTime::now());
    let local: DateTime<Local> = time.into();
    local.format("%Y-%m-%d").to_string()
}

fn pdf_says_invoice(path: &Path, size: u64) -> bool {
    if size > READ_PDF_BYTES {
        return false;
    }
    let Ok(bytes) = std::fs::read(path) else {
        return false;
    };
    let Ok(doc) = warraq_core::Document::open(bytes, None) else {
        return false;
    };
    doc.extract_text(0)
        .map(|text| names_an_invoice(&text))
        .unwrap_or(false)
}

/// The files of a tidy: the ones directly in `folder`, or only `only` when
/// the person selected files there.
fn entries(folder: &Path, only: Option<&[PathBuf]>, how: How) -> Result<(Vec<Entry>, u32), String> {
    let mut skipped = 0;
    let mut found = Vec::new();
    let paths: Vec<PathBuf> = match only {
        Some(files) => files.to_vec(),
        None => std::fs::read_dir(folder)
            .map_err(|e| format!("E_IO: {}: {e}", folder.display()))?
            .flatten()
            .map(|entry| entry.path())
            .collect(),
    };
    for path in paths {
        if found.len() >= MAX_MOVES {
            break;
        }
        // Never through a link, never a folder, only what is directly in the folder.
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if !meta.is_file() || path.parent() != Some(folder) {
            continue;
        }
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        if left_alone(&name) {
            skipped += 1;
            continue;
        }
        let invoice = how == How::Invoices
            && (names_an_invoice(&name)
                || (kind_of(&path) == Some(Kind::Pdf) && pdf_says_invoice(&path, meta.len())));
        found.push(Entry {
            day: day_of(&meta),
            path,
            invoice,
        });
    }
    found.sort_by(|a, b| a.path.cmp(&b.path));
    Ok((found, skipped))
}

#[derive(Deserialize, Clone, Debug)]
pub struct TidyRequest {
    pub place: Place,
    pub how: How,
    pub names: Names,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TidyPreview {
    pub folder: String,
    /// The folder's own name, as the preview says it.
    pub folder_name: String,
    pub how: How,
    /// Each move as names: "report.pdf" → "PDFs/report.pdf".
    pub moves: Vec<(String, String)>,
    pub count: usize,
}

/// The journal of the last tidy, kept until it is undone.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
struct Journal {
    folder: PathBuf,
    moves: Vec<Move>,
    /// Folders the tidy made, removed again on undo when empty.
    made: Vec<PathBuf>,
}

#[derive(Default)]
pub struct TidyState {
    planned: Mutex<Option<(PathBuf, Vec<Move>)>>,
}

fn journal_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("E_IO: no data directory: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("E_IO: {e}"))?;
    Ok(dir.join("tidy-undo.json"))
}

/// The folder a place is, and the selected files when the place is them.
fn place_folder<R: Runtime>(
    app: &AppHandle<R>,
    ask: &AskState,
    place: Place,
) -> Result<(PathBuf, Option<Vec<PathBuf>>), String> {
    let path = app.path();
    let none = |what: &str| format!("E_TIDY: this computer has no {what} folder");
    match place {
        Place::Downloads => Ok((path.download_dir().map_err(|_| none("Downloads"))?, None)),
        Place::Desktop => Ok((path.desktop_dir().map_err(|_| none("Desktop"))?, None)),
        Place::Documents => Ok((path.document_dir().map_err(|_| none("Documents"))?, None)),
        Place::Selection => {
            let files = ask
                .moment
                .lock()
                .ok()
                .and_then(|m| m.files.clone())
                .unwrap_or_default();
            match files.as_slice() {
                [] => Err("E_TIDY: nothing is selected".to_string()),
                [one] if one.is_dir() => Ok((one.clone(), None)),
                [first, ..] => {
                    let folder = first
                        .parent()
                        .ok_or_else(|| "E_TIDY: the selection has no folder".to_string())?
                        .to_path_buf();
                    let same: Vec<PathBuf> = files
                        .iter()
                        .filter(|f| f.parent() == Some(folder.as_path()))
                        .cloned()
                        .collect();
                    Ok((folder, Some(same)))
                }
            }
        }
    }
}

/// The folder may be tidied: an ordinary folder inside the person's home.
pub(crate) fn may_tidy<R: Runtime>(app: &AppHandle<R>, folder: &Path) -> Result<(), String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|_| "E_TIDY: no home folder".to_string())?;
    let real = std::fs::canonicalize(folder).map_err(|e| format!("E_IO: {e}"))?;
    let home = std::fs::canonicalize(home).map_err(|e| format!("E_IO: {e}"))?;
    if real == home || !real.starts_with(&home) {
        return Err("E_TIDY: ZOOD only tidies folders inside your own user folder".to_string());
    }
    Ok(())
}

fn shown(folder: &Path, path: &Path) -> String {
    path.strip_prefix(folder)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

/// Plans a tidy and keeps the plan; nothing is moved yet.
#[tauri::command]
pub async fn ask_tidy_plan<R: Runtime>(
    app: AppHandle<R>,
    ask: State<'_, AskState>,
    tidy: State<'_, TidyState>,
    request: TidyRequest,
) -> Result<TidyPreview, String> {
    let (folder, only) = place_folder(&app, &ask, request.place)?;
    may_tidy(&app, &folder)?;
    let how = request.how;
    let names = request.names.clone();
    let scan_folder = folder.clone();
    let moves = tauri::async_runtime::spawn_blocking(move || {
        let (entries, _skipped) = entries(&scan_folder, only.as_deref(), how)?;
        Ok::<_, String>(plan_moves(&scan_folder, &entries, how, &names))
    })
    .await
    .map_err(|e| format!("E_IO: {e}"))??;
    let preview = TidyPreview {
        folder: folder.to_string_lossy().into_owned(),
        folder_name: folder
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        how,
        moves: moves
            .iter()
            .map(|m| (shown(&folder, &m.from), shown(&folder, &m.to)))
            .collect(),
        count: moves.len(),
    };
    *tidy.planned.lock().unwrap_or_else(|e| e.into_inner()) = Some((folder, moves));
    Ok(preview)
}

/// Carries out the plan the host kept, one move at a time, each written down
/// before the next; returns how many files were moved.
#[tauri::command]
pub async fn ask_tidy_apply<R: Runtime>(
    app: AppHandle<R>,
    tidy: State<'_, TidyState>,
) -> Result<usize, String> {
    let (folder, moves) = tidy
        .planned
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take()
        .ok_or_else(|| "E_TIDY: there is no tidy to do".to_string())?;
    may_tidy(&app, &folder)?;
    let journal = journal_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || apply(&folder, &moves, &journal))
        .await
        .map_err(|e| format!("E_IO: {e}"))?
}

pub fn apply(folder: &Path, moves: &[Move], journal_file: &Path) -> Result<usize, String> {
    let mut journal = Journal {
        folder: folder.to_path_buf(),
        ..Journal::default()
    };
    let write = |journal: &Journal| {
        let text = serde_json::to_string(journal).map_err(|e| e.to_string())?;
        std::fs::write(journal_file, text).map_err(|e| format!("E_IO: {e}"))
    };
    for step in moves {
        // The plan is checked again: inside the folder, one level down at most, nothing overwritten.
        let inside = |p: &Path| {
            p.parent() == Some(folder) || p.parent().and_then(Path::parent) == Some(folder)
        };
        if step.from.parent() != Some(folder) || !inside(&step.to) || step.to.exists() {
            continue;
        }
        let Ok(meta) = std::fs::symlink_metadata(&step.from) else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        if let Some(parent) = step.to.parent() {
            if !parent.exists() {
                std::fs::create_dir(parent).map_err(|e| format!("E_IO: {e}"))?;
                journal.made.push(parent.to_path_buf());
            }
        }
        // A file in use (Windows) is skipped, not the whole tidy.
        if std::fs::rename(&step.from, &step.to).is_ok() {
            journal.moves.push(step.clone());
            write(&journal)?;
        }
    }
    write(&journal)?;
    Ok(journal.moves.len())
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TidyDone {
    pub folder: String,
    pub count: usize,
}

/// The last tidy that can be undone, if any.
#[tauri::command]
pub fn ask_tidy_last<R: Runtime>(app: AppHandle<R>) -> Result<Option<TidyDone>, String> {
    let file = journal_path(&app)?;
    let Ok(text) = std::fs::read_to_string(&file) else {
        return Ok(None);
    };
    let journal: Journal = serde_json::from_str(&text).map_err(|e| format!("E_IO: {e}"))?;
    Ok((!journal.moves.is_empty()).then(|| TidyDone {
        folder: journal.folder.to_string_lossy().into_owned(),
        count: journal.moves.len(),
    }))
}

/// Puts back every file of the last tidy; returns how many went back.
#[tauri::command]
pub async fn ask_tidy_undo<R: Runtime>(app: AppHandle<R>) -> Result<usize, String> {
    let file = journal_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || undo(&file))
        .await
        .map_err(|e| format!("E_IO: {e}"))?
}

pub fn undo(journal_file: &Path) -> Result<usize, String> {
    let text = std::fs::read_to_string(journal_file)
        .map_err(|_| "E_TIDY: there is nothing to undo".to_string())?;
    let journal: Journal = serde_json::from_str(&text).map_err(|e| format!("E_IO: {e}"))?;
    let mut back = 0;
    for step in journal.moves.iter().rev() {
        if step.to.exists() && !step.from.exists() && std::fs::rename(&step.to, &step.from).is_ok()
        {
            back += 1;
        }
    }
    for dir in journal.made.iter().rev() {
        // Only when empty: something the person put there since stays.
        let _ = std::fs::remove_dir(dir);
    }
    std::fs::remove_file(journal_file).map_err(|e| format!("E_IO: {e}"))?;
    Ok(back)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names() -> Names {
        Names {
            pdf: "PDFs".into(),
            images: "Pictures".into(),
            documents: "Documents".into(),
            spreadsheets: "Spreadsheets".into(),
            presentations: "Presentations".into(),
            archives: "Archives".into(),
            audio: "Audio".into(),
            video: "Video".into(),
            installers: "Installers".into(),
            invoices: "Invoices".into(),
        }
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("zood-tidy-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn entry(folder: &Path, name: &str, day: &str, invoice: bool) -> Entry {
        Entry {
            path: folder.join(name),
            day: day.into(),
            invoice,
        }
    }

    #[test]
    fn files_are_sorted_by_kind_and_unknown_ones_stay() {
        let f = Path::new("/home/me/Downloads");
        let moves = plan_moves(
            f,
            &[
                entry(f, "a.pdf", "2026-10-21", false),
                entry(f, "b.PNG", "2026-10-21", false),
                entry(f, "c.weird", "2026-10-21", false),
            ],
            How::Type,
            &names(),
        );
        assert_eq!(moves.len(), 2);
        assert_eq!(moves[0].to, f.join("PDFs").join("a.pdf"));
        assert_eq!(moves[1].to, f.join("Pictures").join("b.PNG"));
    }

    #[test]
    fn months_and_dates_come_from_the_day() {
        let f = Path::new("/x");
        let by_month = plan_moves(
            f,
            &[entry(f, "a.pdf", "2026-03-09", false)],
            How::Month,
            &names(),
        );
        assert_eq!(by_month[0].to, f.join("2026-03").join("a.pdf"));
        let by_date = plan_moves(
            f,
            &[
                entry(f, "a.pdf", "2026-03-09", false),
                entry(f, "2025-01-01 old.pdf", "2026-03-09", false),
            ],
            How::Date,
            &names(),
        );
        assert_eq!(by_date.len(), 1);
        assert_eq!(by_date[0].to, f.join("2026-03-09 a.pdf"));
    }

    #[test]
    fn invoices_only_and_no_two_files_get_one_name() {
        let f = Path::new("/nowhere-zood");
        let moves = plan_moves(
            f,
            &[
                entry(f, "invoice.pdf", "2026-01-01", true),
                entry(f, "letter.pdf", "2026-01-01", false),
            ],
            How::Invoices,
            &names(),
        );
        assert_eq!(moves.len(), 1);
        assert_eq!(moves[0].to, f.join("Invoices").join("invoice.pdf"));
        let twice = plan_moves(
            f,
            &[
                entry(f, "a.pdf", "2026-01-01", false),
                entry(f, "a.pdf", "2026-01-01", false),
            ],
            How::Month,
            &names(),
        );
        assert_eq!(twice[1].to, f.join("2026-01").join("a (2).pdf"));
    }

    #[test]
    fn what_is_left_alone() {
        for name in [
            ".DS_Store",
            "desktop.ini",
            "x.crdownload",
            "Word.lnk",
            "~$draft.docx",
        ] {
            assert!(left_alone(name), "{name}");
        }
        assert!(!left_alone("report.pdf"));
        assert!(names_an_invoice("Tax Invoice #12"));
        assert!(names_an_invoice("فاتورة ضريبية"));
        assert!(!names_an_invoice("contract.pdf"));
        assert!(starts_with_date("2026-10-21 x.pdf"));
        assert!(starts_with_date("20261021_scan.pdf"));
        assert!(!starts_with_date("report 2026.pdf"));
    }

    #[test]
    fn a_folder_name_from_outside_cannot_climb() {
        assert_eq!(safe_folder("../../etc"), "etc");
        assert_eq!(safe_folder("a/b"), "ab");
        assert_eq!(safe_folder(".."), "ZOOD");
        assert_eq!(safe_folder("الفواتير"), "الفواتير");
    }

    #[test]
    fn a_tidy_is_done_and_undone_on_disk() {
        let folder = scratch("apply");
        for name in ["a.pdf", "b.png", "invoice 7.pdf", "keep.weird"] {
            std::fs::write(folder.join(name), name).unwrap();
        }
        std::fs::create_dir(folder.join("sub")).unwrap();
        let (found, _) = entries(&folder, None, How::Type).unwrap();
        assert_eq!(found.len(), 4, "the folder inside is not a file to move");
        let moves = plan_moves(&folder, &found, How::Type, &names());
        assert_eq!(moves.len(), 3);
        let journal = folder.join("journal.json");
        // A move the interface could have slipped in, out of the folder, is not done.
        let mut tampered = moves.clone();
        tampered.push(Move {
            from: folder.join("keep.weird"),
            to: std::env::temp_dir().join("zood-escape.weird"),
        });
        assert_eq!(apply(&folder, &tampered, &journal).unwrap(), 3);
        assert!(folder.join("PDFs").join("a.pdf").exists());
        assert!(folder.join("keep.weird").exists());
        assert!(!std::env::temp_dir().join("zood-escape.weird").exists());
        assert_eq!(undo(&journal).unwrap(), 3);
        assert!(folder.join("a.pdf").exists());
        assert!(folder.join("b.png").exists());
        assert!(
            !folder.join("PDFs").exists(),
            "the folder the tidy made is gone"
        );
        assert!(!journal.exists());
        let _ = std::fs::remove_dir_all(&folder);
    }

    #[test]
    fn nothing_is_overwritten() {
        let folder = scratch("clash");
        std::fs::write(folder.join("a.pdf"), "new").unwrap();
        std::fs::create_dir(folder.join("PDFs")).unwrap();
        std::fs::write(folder.join("PDFs").join("a.pdf"), "old").unwrap();
        let (found, _) = entries(&folder, None, How::Type).unwrap();
        let moves = plan_moves(&folder, &found, How::Type, &names());
        assert_eq!(moves[0].to, folder.join("PDFs").join("a (2).pdf"));
        apply(&folder, &moves, &folder.join("j.json")).unwrap();
        assert_eq!(
            std::fs::read_to_string(folder.join("PDFs").join("a.pdf")).unwrap(),
            "old"
        );
        let _ = std::fs::remove_dir_all(&folder);
    }
}
