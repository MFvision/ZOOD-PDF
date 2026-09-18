//! Warraq desktop shell.
//!
//! A thin Tauri 2 host around the shared web UI (`@warraq/ui`, served from
//! `apps/web/dist`). The host only provides what a browser cannot: native file
//! dialogs, file reads/writes limited to paths the user picked, OS
//! drag-and-drop, and commands into the natively linked `warraq-core`.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, DragDropEvent, Emitter, Manager, Runtime, State, WindowEvent};
use tauri_plugin_fs::FsExt;

pub mod core_bridge;
pub mod print;

/// Event sent to the webview when files are dropped on the window.
/// Payload: [`FileDropPayload`]. Every dropped path is added to the fs scope
/// before the event is emitted, so `read_file_bytes` accepts it afterwards.
pub const FILE_DROP_EVENT: &str = "warraq://file-drop";

#[derive(Clone, Serialize)]
pub struct FileDropPayload {
    pub paths: Vec<String>,
}

/// A PDF named on the command line: `warraq-desktop report.pdf`. It is handed
/// to the UI once, when it boots, and is also the only way to exercise the
/// whole desktop path — window, webview, core — without a person at the
/// screen, which is what `WARRAQ_DEBUG=1` then reports on stdout.
struct StartupFile(Mutex<Option<String>>);

/// The startup file, consumed on the first call so a reload does not reopen it.
#[tauri::command]
fn startup_file(state: State<'_, StartupFile>) -> Option<String> {
    let path = state.0.lock().ok().and_then(|mut slot| slot.take());
    core_bridge::debug_log(format!("startup file = {path:?}"));
    path
}

/// A line from the interface into the `WARRAQ_DEBUG` log: what EmbedPDF did in
/// the webview — a document opened, pages drawn, an error — which the host
/// cannot see for itself. Silent unless `WARRAQ_DEBUG` is set.
#[tauri::command]
fn ui_log(message: String) {
    core_bridge::debug_log(format!("ui: {message}"));
}

/// Version of the natively linked core, so the UI can show that the desktop
/// build and the WASM build carry the same `warraq-core`.
#[tauri::command]
fn core_version() -> String {
    warraq_core::version()
}

/// Reads a whole file and returns its bytes as a raw IPC response (an
/// `ArrayBuffer` on the JS side; no JSON array of numbers for multi-megabyte
/// PDFs). Only paths the user chose through the dialog plugin, or dropped on
/// the window, are in the fs scope; anything else is refused with `E_SCOPE`.
#[tauri::command]
fn read_file_bytes<R: Runtime>(
    app: AppHandle<R>,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    let path = std::path::PathBuf::from(path);
    if !path.is_absolute() {
        return Err(format!(
            "E_SCOPE: path must be absolute: {}",
            path.display()
        ));
    }
    if !app.fs_scope().is_allowed(&path) {
        let refused = format!(
            "E_SCOPE: {} was not chosen through the file dialog or dropped on the window",
            path.display()
        );
        core_bridge::debug_log(&refused);
        return Err(refused);
    }
    let read = std::fs::read(&path);
    core_bridge::debug_log(format!(
        "read {} -> {}",
        path.display(),
        match &read {
            Ok(bytes) => format!("{} bytes", bytes.len()),
            Err(e) => e.to_string(),
        }
    ));
    read.map(tauri::ipc::Response::new)
        .map_err(|e| format!("E_IO: {}: {e}", path.display()))
}

/// Builds and runs the Tauri application.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // Points warraq-render at the bundled PDFium and starts the core thread
        // before the window can invoke anything (see `core_bridge`).
        .setup(|app| {
            let bridge = core_bridge::setup(app.handle());
            println!("warraq: core engine = {}", bridge.engine());
            app.manage(bridge);

            // A file named on the command line is as explicit a choice as one
            // picked in the dialog, so it joins the same scope.
            let startup = std::env::args_os()
                .skip(1)
                .map(PathBuf::from)
                .find(|path| path.is_file());
            if let Some(path) = &startup {
                if let Err(e) = app.fs_scope().allow_file(path) {
                    eprintln!("warraq: cannot allow {}: {e}", path.display());
                }
            }
            core_bridge::debug_log(format!("command line file = {startup:?}"));

            app.manage(StartupFile(Mutex::new(
                startup.map(|path| path.to_string_lossy().into_owned()),
            )));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            core_version,
            read_file_bytes,
            startup_file,
            ui_log,
            core_bridge::core_engine,
            core_bridge::doc_open,
            core_bridge::doc_close,
            core_bridge::doc_page_count,
            core_bridge::doc_page_size,
            core_bridge::doc_render_page,
            core_bridge::doc_extract_text,
            core_bridge::doc_text_lines,
            core_bridge::doc_search,
            core_bridge::doc_metadata,
            core_bridge::doc_paragraphs,
            core_bridge::doc_replace_paragraph,
            core_bridge::doc_add_text,
            core_bridge::doc_save,
            core_bridge::core_call,
            print::print_available,
            print::print_pdf,
        ])
        .on_window_event(|window, event| {
            // Forward OS file drops to the webview, after allowing the dropped
            // files in the fs scope (a drop is as explicit a choice as a dialog).
            if let WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) = event {
                let scope = window.app_handle().fs_scope();
                let files: Vec<String> = paths
                    .iter()
                    .filter(|p| p.is_file())
                    .map(|p| {
                        if let Err(e) = scope.allow_file(p) {
                            eprintln!("warraq: cannot allow dropped file {}: {e}", p.display());
                        }
                        p.to_string_lossy().into_owned()
                    })
                    .collect();
                if !files.is_empty() {
                    let _ = window.emit(FILE_DROP_EVENT, FileDropPayload { paths: files });
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Warraq");
}
