//! Quick tools: PDF work done from the file manager without opening the
//! editor — the owner's ask after Filee (github.com/KnifeLemon/Filee, MIT),
//! whose idea this follows; none of its code is used here.
//!
//! The person right-clicks files in Explorer or Finder and picks a tool
//! (compress, to Word, to pictures, OCR, combine, protect, rotate, make a
//! PDF of a picture or an Office file). The app starts — or the copy already
//! running is told, through the single-instance plugin — with
//!
//! ```text
//! warraq-desktop --quick [--tool=<id>] <file> [<file> …]
//! ```
//!
//! and opens a small window of its own, not the editor: the files, the tool
//! (or the tools to choose from), its few options and a Run button. Results
//! are written beside the originals by the batch's own writer
//! (`batch_write`), never over a file. The window runs the same steps as the
//! batch (`packages/ui/src/batch/steps.ts`) through the same core.
//!
//! Explorer starts one process per selected file; requests that arrive close
//! together for the same tool are gathered into one window (`GATHER`), so
//! "Combine" on five files is one window with five files.
//!
//! Every file named here is put in the file scope: picking it in the file
//! manager is as explicit a choice as picking it in the open panel.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_fs::FsExt;

pub const QUICK_FLAG: &str = "--quick";
const TOOL_PREFIX: &str = "--tool=";
/// The tools a menu entry may name; the window offers them all when none is named.
pub const TOOLS: &[&str] = &[
    "compress", "word", "images", "ocr", "combine", "protect", "rotate", "extract", "topdf",
];
/// More than anyone selects by hand; a bound on what one request holds.
const MAX_FILES: usize = 500;
/// How long requests for the same tool are gathered before the window opens.
const GATHER: Duration = Duration::from_millis(450);
const WINDOW_PREFIX: &str = "quick-";

/// One quick request, as parsed from a launch's arguments.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QuickRequest {
    pub tool: Option<String>,
    pub files: Vec<PathBuf>,
}

/// What a quick window works on, handed to it once it asks (`quick_job`).
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct QuickJob {
    pub tool: Option<String>,
    pub files: Vec<QuickFile>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct QuickFile {
    pub name: String,
    pub path: String,
    pub size: u64,
}

#[derive(Default)]
pub struct QuickState {
    /// Requests being gathered, by tool ("" for none).
    gathering: Mutex<HashMap<String, Vec<PathBuf>>>,
    /// Each open quick window's job, by window label.
    jobs: Mutex<HashMap<String, QuickJob>>,
    next: AtomicU32,
}

/// The quick request in a launch's arguments (after the program's own name),
/// or `None` when the launch is not one. Relative paths are taken from `cwd`;
/// names that are not existing files, and a tool not in [`TOOLS`], are
/// dropped. A request with no file left is still one (the window says so).
pub fn parse(args: &[String], cwd: Option<&Path>) -> Option<QuickRequest> {
    let mut rest = args.iter().skip(1).skip_while(|a| a.as_str() != QUICK_FLAG);
    rest.next()?;
    let mut tool = None;
    let mut files = Vec::new();
    for arg in rest {
        if let Some(id) = arg.strip_prefix(TOOL_PREFIX) {
            tool = TOOLS.iter().find(|t| **t == id).map(|t| t.to_string());
            continue;
        }
        if arg.starts_with("--") || files.len() >= MAX_FILES {
            continue;
        }
        let path = PathBuf::from(arg);
        let path = match cwd {
            Some(cwd) if path.is_relative() => cwd.join(path),
            _ => path,
        };
        if path.is_file() && !files.contains(&path) {
            files.push(path);
        }
    }
    Some(QuickRequest { tool, files })
}

/// Takes a request: its files go in the file scope, and a window opens once
/// requests for the same tool stop arriving.
pub fn request<R: Runtime>(app: &AppHandle<R>, request: QuickRequest) {
    let scope = app.fs_scope();
    for file in &request.files {
        if let Err(e) = scope.allow_file(file) {
            eprintln!("warraq: cannot allow {}: {e}", file.display());
        }
    }
    let Some(state) = app.try_state::<QuickState>() else {
        return;
    };
    let key = request.tool.clone().unwrap_or_default();
    let first = {
        let Ok(mut gathering) = state.gathering.lock() else {
            return;
        };
        let first = !gathering.contains_key(&key);
        let files = gathering.entry(key.clone()).or_default();
        for file in request.files {
            if files.len() < MAX_FILES && !files.contains(&file) {
                files.push(file);
            }
        }
        first
    };
    if !first {
        return;
    }
    let app = app.clone();
    // A thread of its own: building a window from an event handler of the
    // main thread can deadlock on Windows.
    std::thread::spawn(move || {
        std::thread::sleep(GATHER);
        let Some(state) = app.try_state::<QuickState>() else {
            return;
        };
        let files = state
            .gathering
            .lock()
            .ok()
            .and_then(|mut gathering| gathering.remove(&key))
            .unwrap_or_default();
        let tool = (!key.is_empty()).then_some(key);
        if let Err(e) = open_window(&app, &state, tool, files) {
            eprintln!("warraq: cannot open the quick tools window: {e}");
        }
    });
}

fn job_of(tool: Option<String>, files: Vec<PathBuf>) -> QuickJob {
    QuickJob {
        tool,
        files: files
            .into_iter()
            .map(|path| QuickFile {
                name: path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                size: std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0),
                path: path.to_string_lossy().into_owned(),
            })
            .collect(),
    }
}

fn open_window<R: Runtime>(
    app: &AppHandle<R>,
    state: &QuickState,
    tool: Option<String>,
    files: Vec<PathBuf>,
) -> tauri::Result<WebviewWindow<R>> {
    let label = format!(
        "{WINDOW_PREFIX}{}",
        state.next.fetch_add(1, Ordering::Relaxed)
    );
    if let Ok(mut jobs) = state.jobs.lock() {
        jobs.insert(label.clone(), job_of(tool, files));
    }
    let window =
        WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html?quick=1".into()))
            .title("أدوات PDF السريعة — محرر PDF")
            .inner_size(480.0, 600.0)
            .min_inner_size(400.0, 460.0)
            .center()
            .always_on_top(true)
            .focused(true)
            .build()?;
    let _ = window.set_focus();
    Ok(window)
}

/// The job of the quick window asking, kept for a reload of that window.
#[tauri::command]
pub fn quick_job<R: Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, QuickState>,
) -> Option<QuickJob> {
    state.jobs.lock().ok()?.get(window.label()).cloned()
}

/// The editor, created now if this run started for a quick tool only, and
/// brought to the front.
pub fn show_editor<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    let window = match app.get_webview_window("main") {
        Some(window) => window,
        None => {
            let config = app
                .config()
                .app
                .windows
                .iter()
                .find(|w| w.label == "main")?
                .clone();
            WebviewWindowBuilder::from_config(app, &config)
                .and_then(|builder| builder.build())
                .map_err(|e| eprintln!("warraq: cannot open the editor window: {e}"))
                .ok()?
        }
    };
    // A run started in the background has no Dock icon until the editor comes.
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    Some(window)
}

/// Closes the quick window asking; its job is forgotten. When it was the only
/// window, the app ends with it, as it started for it alone.
#[tauri::command]
pub fn quick_close<R: Runtime>(window: WebviewWindow<R>, state: State<'_, QuickState>) {
    if let Ok(mut jobs) = state.jobs.lock() {
        jobs.remove(window.label());
    }
    let _ = window.close();
}

/// Is `label` a quick window's?
pub fn is_quick_window(label: &str) -> bool {
    label.starts_with(WINDOW_PREFIX)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        std::iter::once("warraq-desktop")
            .chain(list.iter().copied())
            .map(String::from)
            .collect()
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("warraq-quick-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn an_ordinary_launch_is_not_a_quick_one() {
        assert_eq!(parse(&args(&[]), None), None);
        assert_eq!(parse(&args(&["report.pdf"]), None), None);
    }

    #[test]
    fn a_quick_launch_names_its_tool_and_its_files() {
        let dir = scratch("parse");
        std::fs::write(dir.join("أ.pdf"), b"%PDF").unwrap();
        std::fs::write(dir.join("b.pdf"), b"%PDF").unwrap();
        let request = parse(
            &args(&[
                "--quick",
                "--tool=compress",
                "أ.pdf",
                "missing.pdf",
                "b.pdf",
                "أ.pdf",
            ]),
            Some(&dir),
        )
        .unwrap();
        assert_eq!(request.tool.as_deref(), Some("compress"));
        assert_eq!(request.files, vec![dir.join("أ.pdf"), dir.join("b.pdf")]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_unknown_tool_and_other_flags_are_ignored() {
        let request = parse(&args(&["--quick", "--tool=format-disk", "--verbose"]), None).unwrap();
        assert_eq!(
            request,
            QuickRequest {
                tool: None,
                files: vec![]
            }
        );
    }

    #[test]
    fn a_job_carries_each_file_name_and_size() {
        let dir = scratch("job");
        std::fs::write(dir.join("تقرير.pdf"), b"%PDF-1.7").unwrap();
        let job = job_of(Some("word".into()), vec![dir.join("تقرير.pdf")]);
        assert_eq!(job.files[0].name, "تقرير.pdf");
        assert_eq!(job.files[0].size, 8);
        assert!(job.files[0].path.ends_with("تقرير.pdf"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn quick_windows_are_told_apart_from_the_editor() {
        assert!(is_quick_window("quick-0"));
        assert!(!is_quick_window("main"));
    }
}
