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

pub mod ai;
pub mod batch;
pub mod cloud;
pub mod core_bridge;
pub mod library;
pub mod menu;
pub mod print;
pub mod profile;
pub mod signing;

/// Event sent to the webview when files are dropped on the window.
/// Payload: [`FileDropPayload`]. Every dropped path is added to the fs scope
/// before the event is emitted, so `read_file_bytes` accepts it afterwards.
pub const FILE_DROP_EVENT: &str = "warraq://file-drop";

/// Event sent while files are dragged over the window, so the interface can
/// show where they would go: the webview sees none of the HTML drag events.
/// Payload: [`FileDragPayload`].
pub const FILE_DRAG_EVENT: &str = "warraq://file-drag";

#[derive(Clone, Serialize)]
pub struct FileDropPayload {
    pub paths: Vec<String>,
    /// Where the files were let go, in CSS pixels from the webview's corner.
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Serialize)]
pub struct FileDragPayload {
    /// `over` while files are over the window (with where), `leave` when they
    /// have gone.
    pub kind: &'static str,
    pub x: f64,
    pub y: f64,
}

/// A drag position in CSS pixels. Tauri labels it physical, but only on
/// Windows is it (wry's WebView2 handler maps it with `ScreenToClient`); on
/// macOS wry passes NSView points and on Linux GTK widget coordinates, both
/// already logical — scaling those halved every position on a Retina Mac.
fn logical<R: Runtime>(window: &tauri::Window<R>, at: &tauri::PhysicalPosition<f64>) -> (f64, f64) {
    if cfg!(target_os = "windows") {
        let at = at.to_logical::<f64>(window.scale_factor().unwrap_or(1.0));
        (at.x, at.y)
    } else {
        (at.x, at.y)
    }
}

/// Whether the drag now over the window carries files: text, links and
/// in-app drags carry none, and get no overlay.
static DRAGGING_FILES: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

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

/// A check the interface runs by itself once the startup file is open, named
/// by `WARRAQ_SELFCHECK` and only with `WARRAQ_DEBUG` set: `ocr` reads the
/// file with Scan & OCR, `ocr-clean` cleans it up first, `batch:<folder>`
/// runs a batch over the PDFs in that folder and writes each result beside
/// its original. It is how recognition and the batch inside this webview —
/// Tesseract's worker and WebAssembly under the host's security policy, the
/// batch's reads and writes through this host — are checked from the log,
/// without a person at the screen. `None` in every ordinary run.
#[tauri::command]
fn debug_selfcheck<R: Runtime>(app: AppHandle<R>) -> Option<String> {
    std::env::var_os("WARRAQ_DEBUG")?;
    let check = std::env::var("WARRAQ_SELFCHECK").ok()?;
    if let Some(folder) = check.strip_prefix("batch:") {
        // Named by whoever started the check: as if chosen in the panel.
        let dir = PathBuf::from(folder);
        let allowed = dir.is_absolute()
            && dir.is_dir()
            && app.fs_scope().allow_directory(&dir, false).is_ok();
        return allowed.then_some(check);
    }
    matches!(check.as_str(), "ocr" | "ocr-clean").then_some(check)
}

/// Opens a web or e-mail address in the system's browser or mail app, once
/// the person has confirmed it in the interface (`links/openLink.ts`). The
/// address is checked again here — only `http`, `https` and `mailto` — and
/// handed to the system's opener as one argument, never through a shell.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    let url = url.trim().to_string();
    if !warraq_core::allowed_uri(&url) {
        return Err("E_LINK: only web and e-mail addresses are opened".into());
    }
    let mut child = opener(&url).spawn().map_err(|e| format!("E_LINK: {e}"))?;
    // Reaped once the opener hands the address over and exits.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

fn opener(url: &str) -> std::process::Command {
    #[cfg(target_os = "macos")]
    let (program, before): (&str, &[&str]) = ("/usr/bin/open", &[]);
    #[cfg(target_os = "windows")]
    let (program, before): (&str, &[&str]) = ("rundll32", &["url.dll,FileProtocolHandler"]);
    #[cfg(all(unix, not(target_os = "macos")))]
    let (program, before): (&str, &[&str]) = ("xdg-open", &[]);
    let mut command = std::process::Command::new(program);
    command.args(before).arg(url);
    command
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

/// Builds and runs the Tauri application. On iOS and Android (Tauri 2's
/// mobile targets, not built yet: docs/STATUS.md) this is the app's entry
/// point, as `main` is on the desktop.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // The macOS menu bar is the UI's model (src/menu.rs); until the UI
        // sends it, Tauri's default menu stands in.
        .manage(menu::MenuState::default())
        // Cloud drives: the sign-in under way and the system's credential store.
        .manage(cloud::CloudState::default())
        // The Library's walks under way, and its folder watcher.
        .manage(library::LibraryState::default())
        // The on-device model: its downloads and its engine thread; and the
        // person's details for filling forms, in the system's credential store.
        .manage(ai::AiState::default())
        .manage(profile::ProfileState::default())
        .on_menu_event(|app, event| menu::forward(app, event.id().as_ref()))
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
            debug_selfcheck,
            open_url,
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
            print::print_mode,
            print::print_pdf,
            print::print_webview,
            signing::net_exchange,
            signing::pkcs11_certificates,
            signing::pkcs11_sign,
            cloud::cloud_auth_listen,
            cloud::cloud_auth_wait,
            cloud::cloud_auth_cancel,
            cloud::cloud_token,
            cloud::cloud_has_session,
            cloud::cloud_forget,
            cloud::cloud_http,
            menu::set_menu,
            batch::batch_list_folder,
            batch::batch_write,
            library::library_scan_start,
            library::library_scan_stop,
            library::library_read_file,
            library::library_stat,
            library::library_index_path,
            library::library_index_save,
            library::library_index_load,
            library::library_index_list,
            library::library_index_delete,
            library::library_watch_start,
            library::library_watch_stop,
            ai::ai_model_status,
            ai::ai_model_download,
            ai::ai_model_cancel_download,
            ai::ai_model_delete,
            ai::ai_runtime,
            ai::ai_memory_bytes,
            ai::ai_generate,
            ai::ai_cancel,
            profile::profile_get,
            profile::profile_set,
            profile::profile_delete,
        ])
        .on_window_event(|window, event| {
            // Forward OS file drops to the webview, after allowing the dropped
            // files in the fs scope (a drop is as explicit a choice as a dialog).
            let WindowEvent::DragDrop(drag) = event else {
                return;
            };
            match drag {
                DragDropEvent::Enter { paths, position } => {
                    let files = paths.iter().any(|p| p.is_file());
                    DRAGGING_FILES.store(files, std::sync::atomic::Ordering::Relaxed);
                    if files {
                        let (x, y) = logical(window, position);
                        let _ =
                            window.emit(FILE_DRAG_EVENT, FileDragPayload { kind: "over", x, y });
                    }
                }
                DragDropEvent::Over { position } => {
                    if DRAGGING_FILES.load(std::sync::atomic::Ordering::Relaxed) {
                        let (x, y) = logical(window, position);
                        let _ =
                            window.emit(FILE_DRAG_EVENT, FileDragPayload { kind: "over", x, y });
                    }
                }
                DragDropEvent::Leave => {
                    DRAGGING_FILES.store(false, std::sync::atomic::Ordering::Relaxed);
                    let _ = window.emit(
                        FILE_DRAG_EVENT,
                        FileDragPayload {
                            kind: "leave",
                            x: 0.0,
                            y: 0.0,
                        },
                    );
                }
                DragDropEvent::Drop { paths, position } => {
                    DRAGGING_FILES.store(false, std::sync::atomic::Ordering::Relaxed);
                    let _ = window.emit(
                        FILE_DRAG_EVENT,
                        FileDragPayload {
                            kind: "leave",
                            x: 0.0,
                            y: 0.0,
                        },
                    );
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
                        let (x, y) = logical(window, position);
                        let _ =
                            window.emit(FILE_DROP_EVENT, FileDropPayload { paths: files, x, y });
                    }
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Warraq");
}
