//! Put away, after the owner's "Stow": ZOOD keeps the Desktop and the
//! Downloads folder tidy with the person's own rules.
//!
//! A rule is a few file types and/or words in a name, and one folder (or
//! the Bin, after some days). Every little while the top level of the
//! Desktop and of Downloads (each can be turned off) is looked at: a file
//! that arrived after Put away was turned on, and has stayed still for the
//! wait the person chose (two minutes by default), goes into the folder of
//! the first rule that fits it. Never deeper: a rule has one folder. Folders,
//! shortcuts, hidden files, apps and downloads still coming in are left
//! alone (`ask::tidy::left_alone`), and nothing is ever overwritten (a taken
//! name gets " 2", as the Finder does). Destinations are inside the
//! person's own user folder only.
//!
//! After each batch the drop zone at the top of the screen says how many
//! went where, with Undo and Show (`sort.rs`, `DropZone.tsx`). Undo puts the
//! last batch back (from a Mac's Bin too; Windows keeps binned files in its
//! Recycle Bin, where they can be restored). Every move is also written to a
//! plain text log the person can open.
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use crate::ring::log;

const SETTINGS_FILE: &str = "putaway.json";
const LOG_FILE: &str = "putaway.log";
const UNDO_FILE: &str = "putaway-undo.json";
/// How often the folders are looked at.
const TICK: Duration = Duration::from_secs(30);
/// The most files one look moves; the rest wait for the next.
const MAX_MOVES: usize = 200;
/// The most rules kept.
const MAX_RULES: usize = 40;
const DAY: u64 = 24 * 60 * 60;

/// One rule: what it takes, and where it puts it.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Rule {
    /// The card's name ("Fonts").
    pub name: String,
    /// The card's symbol (the interface's).
    pub icon: String,
    /// File types, without the dot ("otf").
    pub exts: Vec<String>,
    /// Words in a file's name ("screenshot").
    pub words: Vec<String>,
    /// The folder; empty when the rule bins.
    pub to: String,
    /// Into the Bin instead, after this many days.
    pub bin: bool,
    pub bin_days: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub on: bool,
    pub desktop: bool,
    pub downloads: bool,
    /// How long a file stays still before it is put away, in minutes.
    pub wait_minutes: u32,
    /// What ZOOD makes (a conversion on the drop zone) follows the rules too.
    pub made_follow: bool,
    /// When Put away was turned on (seconds since 1970): only files that
    /// arrived after are moved, until "Put away the ones already there".
    pub since: u64,
    pub rules: Vec<Rule>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            on: false,
            desktop: true,
            downloads: true,
            wait_minutes: 2,
            made_follow: false,
            since: 0,
            rules: Vec::new(),
        }
    }
}

/// One move of the last batch, for Undo.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Step {
    pub from: PathBuf,
    /// Where it is now; for a file binned on Windows, where it was.
    pub to: PathBuf,
    pub binned: bool,
}

/// What a batch did, for the zone's note.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Batch {
    pub count: usize,
    /// How many went to each rule's place, in the rules' order.
    pub places: Vec<(String, usize)>,
    /// One of the files, to show in its folder.
    pub show: Option<String>,
}

static SETTINGS: Mutex<Option<Settings>> = Mutex::new(None);
/// What ZOOD made lately (a tile's conversions): left where it is unless
/// "converted files follow the rules" is on.
static MADE: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());
const MAX_MADE: usize = 500;
static WATCHING: AtomicBool = AtomicBool::new(false);

fn data_dir<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    let _ = std::fs::create_dir_all(&dir);
    Some(dir)
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn secs(time: std::io::Result<SystemTime>) -> Option<u64> {
    time.ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs())
}

pub fn settings<R: Runtime>(app: &AppHandle<R>) -> Settings {
    if let Ok(mut kept) = SETTINGS.lock() {
        if let Some(settings) = kept.as_ref() {
            return settings.clone();
        }
        let read = data_dir(app)
            .and_then(|dir| std::fs::read_to_string(dir.join(SETTINGS_FILE)).ok())
            .and_then(|text| serde_json::from_str::<Settings>(&text).ok())
            .unwrap_or_default();
        *kept = Some(read.clone());
        return read;
    }
    Settings::default()
}

/// Is `path` a place a rule may put files: a folder inside the person's own
/// user folder (not the user folder itself, and not ZOOD's own data)?
pub fn may_put_in(path: &Path, home: &Path, data: Option<&Path>) -> bool {
    path.is_absolute()
        && path != home
        && path.starts_with(home)
        && !path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        && data.is_none_or(|d| !path.starts_with(d))
}

fn clean(mut settings: Settings, home: &Path, data: Option<&Path>) -> Settings {
    settings.wait_minutes = settings.wait_minutes.clamp(1, 60);
    settings.rules.truncate(MAX_RULES);
    for rule in &mut settings.rules {
        rule.name = rule.name.chars().take(60).collect();
        rule.exts = rule
            .exts
            .iter()
            .map(|e| e.trim().trim_start_matches('.').to_lowercase())
            .filter(|e| !e.is_empty() && e.len() <= 12 && e.chars().all(char::is_alphanumeric))
            .take(40)
            .collect();
        rule.words = rule
            .words
            .iter()
            .map(|w| w.trim().to_lowercase())
            .filter(|w| !w.is_empty())
            .map(|w| w.chars().take(40).collect())
            .take(20)
            .collect();
        rule.bin_days = rule.bin_days.clamp(1, 365);
        if !rule.bin && !may_put_in(Path::new(&rule.to), home, data) {
            rule.to = String::new();
        }
    }
    settings
}

/// The first rule that takes a file of this name, if any (a rule with no
/// folder takes nothing, unless it bins).
pub fn rule_for<'a>(name: &str, rules: &'a [Rule]) -> Option<&'a Rule> {
    let lower = name.to_lowercase();
    let ext = Path::new(&lower)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_string();
    rules.iter().find(|rule| {
        (rule.bin || !rule.to.is_empty())
            && (rule.exts.contains(&ext) || rule.words.iter().any(|w| lower.contains(w.as_str())))
    })
}

/// A free name in `dir` for `name`: itself, or "name 2.ext", "name 3.ext" …
pub fn free_name(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let path = Path::new(name);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or(name);
    let ext = path.extension().and_then(|e| e.to_str());
    (2..10_000)
        .map(|n| match ext {
            Some(ext) => dir.join(format!("{stem} {n}.{ext}")),
            None => dir.join(format!("{stem} {n}")),
        })
        .find(|p| !p.exists())
        .unwrap_or(first)
}

/// A file in a watched folder, as the look sees it.
#[derive(Clone, Debug)]
pub struct Seen {
    pub path: PathBuf,
    /// When it arrived (made, or put in the folder), and last changed.
    pub arrived: u64,
    pub changed: u64,
}

/// Of the files seen, the ones to put away now, each with its rule.
pub fn due<'a>(
    seen: &[Seen],
    settings: &'a Settings,
    now: u64,
    old_ones_too: bool,
) -> Vec<(PathBuf, &'a Rule)> {
    let wait = u64::from(settings.wait_minutes) * 60;
    seen.iter()
        .filter_map(|file| {
            let name = file.path.file_name()?.to_str()?;
            if crate::ask::tidy::left_alone(name) {
                return None;
            }
            let rule = rule_for(name, &settings.rules)?;
            if !old_ones_too && file.arrived < settings.since {
                return None;
            }
            let still = if rule.bin {
                u64::from(rule.bin_days) * DAY
            } else {
                wait
            };
            let quiet_since = file.changed.max(file.arrived);
            (now.saturating_sub(quiet_since) >= still).then(|| (file.path.clone(), rule))
        })
        .take(MAX_MOVES)
        .collect()
}

fn look_at(folder: &Path) -> Vec<Seen> {
    let Ok(read) = std::fs::read_dir(folder) else {
        return Vec::new();
    };
    read.flatten()
        .take(5000)
        .filter_map(|entry| {
            // Files only: no folders, no links, no app bundles.
            let meta = std::fs::symlink_metadata(entry.path()).ok()?;
            if !meta.is_file() {
                return None;
            }
            let changed = secs(meta.modified())?;
            // When it landed here: its birth on this disk (a download keeps
            // the server's date as its last change, not as its birth).
            let arrived = secs(meta.created()).unwrap_or(changed);
            Some(Seen {
                path: entry.path(),
                arrived,
                changed,
            })
        })
        .collect()
}

#[cfg(target_os = "windows")]
fn to_bin(path: &Path) -> Option<PathBuf> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::{
        SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FO_DELETE,
        SHFILEOPSTRUCTW,
    };
    // A list of paths, each ended by a NUL, the list by another.
    let from: Vec<u16> = path.as_os_str().encode_wide().chain([0, 0]).collect();
    let mut op = SHFILEOPSTRUCTW {
        wFunc: FO_DELETE,
        pFrom: PCWSTR(from.as_ptr()),
        fFlags: (FOF_ALLOWUNDO.0 | FOF_NOCONFIRMATION.0 | FOF_SILENT.0 | FOF_NOERRORUI.0) as u16,
        ..Default::default()
    };
    // SAFETY: `from` is double-NUL ended and outlives the call; no window.
    let failed = unsafe { SHFileOperationW(&mut op) } != 0 || op.fAnyOperationsAborted.as_bool();
    (!failed && !path.exists()).then(|| path.to_path_buf())
}

#[cfg(target_os = "macos")]
fn to_bin(path: &Path) -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    let bin = home.join(".Trash");
    let to = free_name(&bin, path.file_name()?.to_str()?);
    std::fs::rename(path, &to).ok().map(|_| to)
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn to_bin(_path: &Path) -> Option<PathBuf> {
    None
}

fn write_log(dir: &Path, lines: &[String]) {
    use std::io::Write;
    if lines.is_empty() {
        return;
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(LOG_FILE))
    {
        for line in lines {
            let _ = writeln!(file, "{line}");
        }
    }
}

/// Puts away what is due; returns what it did.
pub fn put_away<R: Runtime>(app: &AppHandle<R>, old_ones_too: bool) -> Batch {
    let settings = settings(app);
    let (Some(data), Ok(home)) = (data_dir(app), app.path().home_dir()) else {
        return Batch::default();
    };
    let mut folders = Vec::new();
    if settings.desktop {
        folders.extend(app.path().desktop_dir().ok());
    }
    if settings.downloads {
        folders.extend(app.path().download_dir().ok());
    }
    let mut seen: Vec<Seen> = folders.iter().flat_map(|f| look_at(f)).collect();
    if !settings.made_follow {
        if let Ok(made) = MADE.lock() {
            seen.retain(|file| !made.contains(&file.path));
        }
    }
    let now = now_secs();
    let mut steps: Vec<Step> = Vec::new();
    let mut lines = Vec::new();
    let mut batch = Batch::default();
    let stamp = chrono::Local::now().format("%Y-%m-%d %H:%M");
    for (from, rule) in due(&seen, &settings, now, old_ones_too) {
        let Some(name) = from.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let step = if rule.bin {
            to_bin(&from).map(|to| Step {
                from: from.clone(),
                binned: true,
                to,
            })
        } else {
            let dir = PathBuf::from(&rule.to);
            if !may_put_in(&dir, &home, Some(&data)) || from.parent() == Some(dir.as_path()) {
                continue;
            }
            if std::fs::create_dir_all(&dir).is_err() {
                continue;
            }
            let to = free_name(&dir, name);
            // A file in use, or on another disk, is skipped (it is tried again later).
            std::fs::rename(&from, &to).ok().map(|_| Step {
                from: from.clone(),
                binned: false,
                to,
            })
        };
        let Some(step) = step else {
            continue;
        };
        lines.push(format!(
            "{stamp}  {}  ->  {}",
            step.from.display(),
            if step.binned {
                "Bin".to_string()
            } else {
                step.to.display().to_string()
            }
        ));
        match batch.places.iter_mut().find(|(n, _)| *n == rule.name) {
            Some((_, count)) => *count += 1,
            None => batch.places.push((rule.name.clone(), 1)),
        }
        if !step.binned {
            batch.show = Some(step.to.to_string_lossy().into_owned());
        }
        steps.push(step);
    }
    batch.count = steps.len();
    if batch.count > 0 {
        write_log(&data, &lines);
        if let Ok(text) = serde_json::to_string(&steps) {
            let _ = std::fs::write(data.join(UNDO_FILE), text);
        }
        log(&format!("put away {} files", batch.count));
    }
    batch
}

/// Puts the last batch back; returns how many went back, and how many wait
/// in Windows' Recycle Bin.
pub fn undo_last<R: Runtime>(app: &AppHandle<R>) -> (usize, usize) {
    let Some(data) = data_dir(app) else {
        return (0, 0);
    };
    let file = data.join(UNDO_FILE);
    let steps: Vec<Step> = std::fs::read_to_string(&file)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    let mut back = 0;
    let mut in_bin = 0;
    let mut lines = Vec::new();
    let stamp = chrono::Local::now().format("%Y-%m-%d %H:%M");
    for step in steps.iter().rev() {
        if step.binned && cfg!(target_os = "windows") {
            in_bin += 1;
            continue;
        }
        if step.to.exists() && !step.from.exists() && std::fs::rename(&step.to, &step.from).is_ok()
        {
            back += 1;
            lines.push(format!("{stamp}  undo  {}", step.from.display()));
        }
    }
    write_log(&data, &lines);
    let _ = std::fs::remove_file(file);
    (back, in_bin)
}

/// ZOOD made these files.
pub fn made(paths: &[PathBuf]) {
    if let Ok(mut all) = MADE.lock() {
        all.extend(paths.iter().cloned());
        let over = all.len().saturating_sub(MAX_MADE);
        all.drain(..over);
    }
}

/// Looks every little while, while Put away is on. Started once.
pub fn start<R: Runtime>(app: &AppHandle<R>) {
    if WATCHING.swap(true, Ordering::Relaxed) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(TICK);
        if !settings(&app).on {
            continue;
        }
        let batch = put_away(&app, false);
        if batch.count > 0 {
            crate::sort::tell_put_away(&app, &batch);
        }
    });
}

/* ------------------------------------------------------------- commands */

#[tauri::command(async)]
pub fn putaway_get<R: Runtime>(app: AppHandle<R>) -> Settings {
    settings(&app)
}

#[tauri::command]
pub fn putaway_set<R: Runtime>(app: AppHandle<R>, settings: Settings) -> Result<Settings, String> {
    let home = app.path().home_dir().map_err(|e| format!("E_IO: {e}"))?;
    let data = data_dir(&app);
    let before = self::settings(&app);
    let mut next = clean(settings, &home, data.as_deref());
    // Turned on now: only files that arrive from now on.
    next.since = if next.on && !before.on {
        now_secs()
    } else {
        before.since
    };
    let dir = data.ok_or_else(|| "E_IO: no data folder".to_string())?;
    let text = serde_json::to_string_pretty(&next).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(SETTINGS_FILE), text).map_err(|e| format!("E_IO: {e}"))?;
    if let Ok(mut kept) = SETTINGS.lock() {
        *kept = Some(next.clone());
    }
    if next.on {
        // Its note needs the zone's window.
        crate::sort::prepare_window(&app);
    }
    Ok(next)
}

/// The person's folders, for the default rules and the folder cards.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Places {
    pub home: String,
    pub documents: String,
    pub pictures: String,
    pub videos: String,
    pub music: String,
    pub desktop: String,
    pub downloads: String,
}

#[tauri::command(async)]
pub fn putaway_places<R: Runtime>(app: AppHandle<R>) -> Result<Places, String> {
    let path = app.path();
    let s = |p: tauri::Result<PathBuf>| {
        p.map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default()
    };
    Ok(Places {
        home: s(path.home_dir()),
        documents: s(path.document_dir()),
        pictures: s(path.picture_dir()),
        videos: s(path.video_dir()),
        music: s(path.audio_dir()),
        desktop: s(path.desktop_dir()),
        downloads: s(path.download_dir()),
    })
}

/// "Put away the ones already there": once, the files that arrived before too.
#[tauri::command]
pub async fn putaway_now<R: Runtime>(app: AppHandle<R>) -> Result<Batch, String> {
    let done = app.clone();
    let batch = tauri::async_runtime::spawn_blocking(move || put_away(&done, true))
        .await
        .map_err(|e| format!("E_IO: {e}"))?;
    if batch.count > 0 {
        crate::sort::tell_put_away(&app, &batch);
    }
    Ok(batch)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Undone {
    pub back: usize,
    pub in_bin: usize,
}

#[tauri::command]
pub async fn putaway_undo<R: Runtime>(app: AppHandle<R>) -> Result<Undone, String> {
    let (back, in_bin) = tauri::async_runtime::spawn_blocking(move || undo_last(&app))
        .await
        .map_err(|e| format!("E_IO: {e}"))?;
    Ok(Undone { back, in_bin })
}

/// Shows a file Put away moved, in its folder (only one of the last batch).
#[tauri::command(async)]
pub fn putaway_show<R: Runtime>(app: AppHandle<R>, path: String) -> Result<(), String> {
    let data = data_dir(&app).ok_or_else(|| "E_IO: no data folder".to_string())?;
    let steps: Vec<Step> = std::fs::read_to_string(data.join(UNDO_FILE))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    let file = steps
        .into_iter()
        .find(|s| !s.binned && s.to == Path::new(&path))
        .ok_or_else(|| "E_SCOPE: not moved by Put away".to_string())?;
    crate::shelf::reveal(&file.to)
}

/// Opens the plain text log of every move, shown in its folder.
#[tauri::command(async)]
pub fn putaway_log<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let data = data_dir(&app).ok_or_else(|| "E_IO: no data folder".to_string())?;
    let file = data.join(LOG_FILE);
    if !file.exists() {
        std::fs::write(&file, "").map_err(|e| format!("E_IO: {e}"))?;
    }
    crate::shelf::reveal(&file)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(name: &str, exts: &[&str], words: &[&str], to: &str) -> Rule {
        Rule {
            name: name.into(),
            exts: exts.iter().map(|s| s.to_string()).collect(),
            words: words.iter().map(|s| s.to_string()).collect(),
            to: to.into(),
            ..Rule::default()
        }
    }

    #[test]
    fn the_first_rule_that_fits_takes_the_file() {
        let rules = vec![
            rule(
                "Screenshots",
                &[],
                &["screenshot", "لقطة شاشة"],
                "/h/Pictures/Screenshots",
            ),
            rule("Images", &["png", "jpg"], &[], "/h/Pictures"),
            rule("Fonts", &["otf"], &[], "/h/Documents/Fonts"),
            rule("Nowhere", &["zip"], &[], ""),
        ];
        assert_eq!(
            rule_for("Screenshot 2026-10-26.png", &rules).unwrap().name,
            "Screenshots"
        );
        assert_eq!(
            rule_for("لقطة شاشة ١.png", &rules).unwrap().name,
            "Screenshots"
        );
        assert_eq!(rule_for("photo.PNG", &rules).unwrap().name, "Images");
        assert_eq!(rule_for("Inter.otf", &rules).unwrap().name, "Fonts");
        assert!(rule_for("notes.md", &rules).is_none());
        // A rule with no folder takes nothing.
        assert!(rule_for("a.zip", &rules).is_none());
    }

    #[test]
    fn a_taken_name_gets_a_number_like_the_finder() {
        let dir = std::env::temp_dir().join(format!("zood-putaway-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(free_name(&dir, "a.pdf"), dir.join("a.pdf"));
        std::fs::write(dir.join("a.pdf"), b"x").unwrap();
        assert_eq!(free_name(&dir, "a.pdf"), dir.join("a 2.pdf"));
        std::fs::write(dir.join("a 2.pdf"), b"x").unwrap();
        assert_eq!(free_name(&dir, "a.pdf"), dir.join("a 3.pdf"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_still_files_that_came_after_and_never_the_left_alone() {
        let settings = Settings {
            on: true,
            wait_minutes: 2,
            since: 1000,
            rules: vec![
                rule("Docs", &["pdf"], &[], "/h/Documents/Inbox"),
                Rule {
                    bin: true,
                    bin_days: 2,
                    ..rule("Shots", &[], &["screenshot"], "")
                },
            ],
            ..Settings::default()
        };
        let seen = |name: &str, arrived: u64, changed: u64| Seen {
            path: PathBuf::from(format!("/h/Desktop/{name}")),
            arrived,
            changed,
        };
        let now = 10_000;
        let files = vec![
            seen("old.pdf", 500, 500),        // before Put away was on
            seen("new.pdf", 2000, 2000),      // still for long enough
            seen("busy.pdf", 2000, now - 30), // still changing
            seen("a.pdf.crdownload", 2000, 2000),
            seen("link.lnk", 2000, 2000),
            seen("Screenshot 1.png", 2000, 2000), // the Bin waits two days
        ];
        let names = |list: Vec<(PathBuf, &Rule)>| {
            list.into_iter()
                .map(|(p, _)| p.file_name().unwrap().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
        };
        assert_eq!(names(due(&files, &settings, now, false)), vec!["new.pdf"]);
        assert_eq!(
            names(due(&files, &settings, now, true)),
            vec!["old.pdf", "new.pdf"]
        );
        let later = 2000 + 3 * DAY;
        assert!(
            names(due(&files, &settings, later, false)).contains(&"Screenshot 1.png".to_string())
        );
    }

    #[test]
    fn rules_only_put_inside_the_user_folder() {
        // Absolute on every system: C:\ on Windows, / elsewhere.
        let root = PathBuf::from(if cfg!(windows) { "C:\\" } else { "/" });
        let home = root.join("home").join("me");
        let data = home.join(".local").join("share").join("zood");
        let home = home.as_path();
        let data = data.as_path();
        assert!(may_put_in(
            &home.join("Documents").join("Fonts"),
            home,
            Some(data)
        ));
        assert!(!may_put_in(home, home, Some(data)));
        assert!(!may_put_in(&root.join("etc"), home, Some(data)));
        assert!(!may_put_in(&home.join("..").join("root"), home, Some(data)));
        assert!(!may_put_in(Path::new("Documents"), home, Some(data)));
        assert!(!may_put_in(&data.join("x"), home, Some(data)));
    }
}
