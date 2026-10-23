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
pub mod arrival;
pub mod ask;
pub mod batch;
pub mod cloud;
pub mod core_bridge;
pub mod decide;
pub mod doc_window;
pub mod fonts;
pub mod library;
pub mod menu;
pub mod neural;
pub mod presence;
pub mod print;
pub mod profile;
pub mod quick;
pub mod recent;
pub mod remote;
pub mod ring;
pub mod share;
pub mod shell_menu;
pub mod signing;
pub mod speech;
pub mod system;
pub mod updates;

/// Event sent to the webview when files are dropped on the window.
/// Payload: [`FileDropPayload`]. Every dropped path is added to the fs scope
/// before the event is emitted, so `read_file_bytes` accepts it afterwards.
pub const FILE_DROP_EVENT: &str = "warraq://file-drop";

/// Event sent while files are dragged over the window, so the interface can
/// show where they would go: the webview sees none of the HTML drag events.
/// Payload: [`FileDragPayload`].
pub const FILE_DRAG_EVENT: &str = "warraq://file-drag";

/// Event sent when a PDF was opened from outside while the app is already
/// running — double-clicked in Explorer, or "Open with" — so the window that
/// is open takes it instead of a second window starting. No payload: the
/// interface claims the file with `startup_file`, the same as at boot, so a
/// file that arrives before the interface listens is not lost.
pub const OPEN_FILE_EVENT: &str = "warraq://open-file";

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

/// A PDF named on the command line: `warraq-desktop report.pdf`, which is how
/// Explorer opens a double-clicked PDF. It is handed to the UI once, when it
/// boots — or, when a second launch passed it on, when `OPEN_FILE_EVENT`
/// says so. It is also the only way to exercise the whole desktop path —
/// window, webview, core — without a person at the screen, which is what
/// `WARRAQ_DEBUG=1` then reports on stdout.
struct StartupFile(Mutex<Option<String>>);

/// The tool the waiting file opens at (Fill & sign, for a quick "Sign"),
/// claimed once like the file.
struct StartupTool(Mutex<Option<String>>);

/// The first existing file among a launch's arguments (after the program's
/// own name), a relative one taken from where that launch started. Put in the
/// file scope: a file named on the command line is as explicit a choice as
/// one picked in the dialog.
fn file_in_args<R: Runtime>(
    app: &AppHandle<R>,
    args: impl IntoIterator<Item = std::ffi::OsString>,
    cwd: Option<&std::path::Path>,
) -> Option<PathBuf> {
    let path = args
        .into_iter()
        .skip(1)
        .map(PathBuf::from)
        .map(|path| match cwd {
            Some(cwd) if path.is_relative() => cwd.join(path),
            _ => path,
        })
        .find(|path| path.is_file())?;
    if let Err(e) = app.fs_scope().allow_file(&path) {
        eprintln!("warraq: cannot allow {}: {e}", path.display());
    }
    Some(path)
}

/// A second launch of the app (the person double-clicked another PDF): its
/// file goes to the window already open, which comes to the front, and the
/// second process exits (tauri-plugin-single-instance).
fn second_launch<R: Runtime>(app: &AppHandle<R>, args: Vec<String>, cwd: String) {
    let cwd = PathBuf::from(cwd);
    // A quick tool picked in the file manager: a small window of its own,
    // not the editor (src/quick.rs).
    if let Some(request) = quick::parse(&args, Some(&cwd)) {
        core_bridge::debug_log(format!("second launch quick = {request:?}"));
        quick::request(app, request);
        return;
    }
    let file = file_in_args(app, args.into_iter().map(Into::into), Some(&cwd));
    core_bridge::debug_log(format!("second launch file = {file:?}"));
    open_in_editor(app, file);
}

/// Brings the editor to the front (opening it if this run started for a
/// quick tool only) and hands it `file`, if any.
fn open_in_editor<R: Runtime>(app: &AppHandle<R>, file: Option<PathBuf>) {
    open_in_editor_at(app, file, None);
}

/// `open_in_editor`, with the editor's tool to open the file at.
pub(crate) fn open_in_editor_at<R: Runtime>(
    app: &AppHandle<R>,
    file: Option<PathBuf>,
    tool: Option<&str>,
) {
    let fresh = app.get_webview_window("main").is_none();
    quick::show_editor(app);
    let Some(file) = file else { return };
    if let Some(slot) = app.try_state::<StartupTool>() {
        if let Ok(mut slot) = slot.0.lock() {
            *slot = tool.map(str::to_string);
        }
    }
    if let Some(slot) = app.try_state::<StartupFile>() {
        if let Ok(mut slot) = slot.0.lock() {
            *slot = Some(file.to_string_lossy().into_owned());
        }
    }
    // A window just made claims the file as it boots.
    if !fresh {
        let _ = app.emit_to("main", OPEN_FILE_EVENT, ());
    }
}

/// Opens a quick tool's result in the editor ("Open" beside a result), or a
/// file at the editor's tool for a quick tool that is the editor's (Sign).
#[tauri::command]
async fn quick_open_in_editor<R: Runtime>(
    app: AppHandle<R>,
    path: String,
    tool: Option<String>,
) -> Result<(), String> {
    let file = PathBuf::from(&path);
    if !file.is_absolute() || !file.is_file() || !app.fs_scope().is_allowed(&file) {
        return Err(format!("E_SCOPE: {path} is not a result of this run"));
    }
    // "Sign" from the quick window: the file opens at Fill & sign.
    let tool = quick::EDITOR_TOOLS
        .iter()
        .find(|(quick_tool, _)| tool.as_deref() == Some(*quick_tool))
        .map(|(_, editor)| *editor);
    open_in_editor_at(&app, Some(file), tool);
    Ok(())
}

/// The waiting file, consumed on the first call so a reload does not reopen it.
#[tauri::command]
fn startup_file<R: Runtime>(
    app: AppHandle<R>,
    window: tauri::WebviewWindow<R>,
    state: State<'_, StartupFile>,
) -> Option<String> {
    // A document window has a file of its own (doc_window.rs).
    if doc_window::is_doc_window(window.label()) {
        return doc_window::take(&app, window.label());
    }
    let path = state.0.lock().ok().and_then(|mut slot| slot.take());
    core_bridge::debug_log(format!("startup file = {path:?}"));
    path
}

/// The tool the waiting file opens at, consumed like the file.
#[tauri::command]
fn startup_tool(state: State<'_, StartupTool>) -> Option<String> {
    state.0.lock().ok().and_then(|mut slot| slot.take())
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
    // An e-mail address is opened without `attach` fields (`safe_uri`).
    let Some(url) = warraq_core::safe_uri(&url) else {
        return Err("E_LINK: only web and e-mail addresses are opened".into());
    };
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
/// Off the main thread, so a large file does not freeze every window.
#[tauri::command(async)]
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
        // First, so a second launch hands its file over before anything else
        // of it starts.
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            second_launch(app, args, cwd)
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // Updates from the stable channel on GitHub (src/updates.rs).
        .plugin(tauri_plugin_updater::Builder::new().build())
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
        .manage(decide::DecideState::default())
        .manage(ask::tidy::TidyState::default())
        .manage(neural::NeuralState::default())
        .manage(profile::ProfileState::default())
        .manage(fonts::FontState::default())
        .manage(recent::RecentState::default())
        .manage(updates::UpdateState::default())
        .manage(remote::RemoteState::default())
        .manage(ask::AskState::default())
        .on_menu_event(|app, event| match event.id().as_ref() {
            ring::TRAY_OPEN => {
                quick::show_editor(app);
            }
            ring::TRAY_QUIT => app.exit(0),
            id if presence::on_menu(app, id) => {}
            id => menu::forward(app, id),
        })
        // Points warraq-render at the bundled PDFium and starts the core thread
        // before the window can invoke anything (see `core_bridge`).
        .setup(|app| {
            let bridge = core_bridge::setup(app.handle());
            println!("warraq: core engine = {}", bridge.engine());
            app.manage(bridge);

            app.manage(quick::QuickState::default());
            // Finder's "Quick PDF tools" service (src/shell_menu.rs).
            #[cfg(target_os = "macos")]
            {
                let handle = app.handle().clone();
                shell_menu::services::register(move |files| {
                    quick::request(&handle, quick::QuickRequest { tool: None, files });
                });
            }

            // Started for a quick tool: its window only, no editor. Otherwise
            // the editor (`create: false` in tauri.conf.json, so that a quick
            // launch never flashes it).
            let args: Vec<String> = std::env::args_os()
                .map(|a| a.to_string_lossy().into_owned())
                .collect();
            // Started at sign-in to keep the quick tools ready: no window,
            // only the tray icon and the ring (src/ring.rs).
            let hidden = args.iter().skip(1).any(|a| a == ring::BACKGROUND_FLAG);
            ring::start(app.handle(), hidden);
            ask::start(app.handle());
            presence::start(app.handle());
            #[cfg(target_os = "macos")]
            if hidden {
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }
            let quick = quick::parse(&args, None);
            let startup = if let Some(request) = quick {
                core_bridge::debug_log(format!("command line quick = {request:?}"));
                quick::request(app.handle(), request);
                None
            } else if hidden {
                None
            } else {
                quick::show_editor(app.handle());
                file_in_args(app.handle(), std::env::args_os(), None)
            };
            core_bridge::debug_log(format!("command line file = {startup:?}"));

            app.manage(StartupTool(Mutex::new(None)));
            app.manage(doc_window::DocWindowFiles::default());
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
            startup_tool,
            doc_window::open_document_window,
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
            ai::ai_count_tokens,
            ai::ai_cancel,
            decide::ai_decide,
            decide::ai_decide_warm,
            profile::profile_get,
            profile::profile_set,
            profile::profile_delete,
            fonts::font_installed,
            recent::recent_remember,
            recent::recent_path,
            recent::recent_forget,
            updates::update_check,
            updates::update_install,
            quick::quick_job,
            quick::quick_close,
            quick_open_in_editor,
            shell_menu::shell_menu_set,
            shell_menu::shell_menu_state,
            ring::ring_pick,
            ring::ring_phone,
            ring::ring_take,
            ring::ring_done,
            ring::ring_configure,
            ring::ring_settings,
            remote::remote_start,
            remote::remote_stop,
            remote::remote_status,
            remote::remote_pc_control,
            remote::remote_forget,
            remote::remote_clipboard,
            ask::ask_configure,
            ask::access::ask_access,
            ask::access::ask_allow,
            ask::ask_pause,
            ask::ask_settings,
            ask::ask_resize,
            ask::ask_hide,
            ask::ask_stop,
            ask::ask_notch,
            ask::ask_type_instead,
            ask::ask_point,
            ask::ask_point_last,
            ask::ask_guide_end,
            ask::ask_island_aside,
            ask::guide::ask_look_again,
            ask::guide::ask_watch_clicks,
            ask::guide::ask_click,
            ask::book::ask_book,
            ask::book::ask_command,
            ask::book::ask_command_stop,
            ask::book::ask_relay_reply,
            ask::book::ask_open_editor,
            ask::controls::ask_controls,
            presence::presence_ask,
            presence::presence_settings,
            presence::presence_configure,
            ask::ask_transcribe,
            ask::ask_think,
            ask::ask_moment,
            ask::ask_run_tool,
            ask::tidy::ask_tidy_plan,
            ask::tidy::ask_tidy_apply,
            ask::tidy::ask_tidy_last,
            ask::tidy::ask_tidy_undo,
            ask::ask_open,
            ask::ask_type,
            ask::ask_paste,
            ask::ask_shortcut,
            ask::ask_copy,
            ask::ask_undo,
            ask::ask_window_png,
            remote::remote_give,
            arrival::arrival_last,
            remote::remote_send,
            remote::remote_fullscreen,
            share::share_prepare,
            share::share_email,
            speech::speech_engine,
            speech::speech_voices,
            speech::speech_speak,
            speech::speech_stop,
            speech::speech_pause,
            speech::speech_resume,
            speech::speech_open_settings,
            neural::speech_neural_voices,
            neural::speech_neural_download,
            neural::speech_neural_cancel_download,
            neural::speech_neural_delete,
            neural::speech_synthesize,
            system::system_user_name,
            system::open_default_apps,
        ])
        .on_window_event(|window, event| {
            // The last window of a run that is not kept in the background
            // ends it: the ring's hidden window must not keep it alive.
            if let WindowEvent::Destroyed = event {
                let app = window.app_handle();
                let others = app
                    .webview_windows()
                    .keys()
                    .any(|label| label != window.label() && label != ring::LABEL);
                if !others && !ring::background() {
                    app.exit(0);
                }
                return;
            }
            let WindowEvent::DragDrop(drag) = event else {
                return;
            };
            // Files let go on the ring (src/ring.rs).
            if window.label() == ring::LABEL {
                let at = match drag {
                    DragDropEvent::Enter { position, .. }
                    | DragDropEvent::Over { position }
                    | DragDropEvent::Drop { position, .. } => Some(logical(window, position)),
                    _ => None,
                };
                ring::on_drag(window, drag, at);
                return;
            }
            // Forward OS file drops to the webview, after allowing the dropped
            // files in the fs scope (a drop is as explicit a choice as a dialog).
            match drag {
                DragDropEvent::Enter { paths, position } => {
                    let files = paths.iter().any(|p| p.is_file());
                    ring::log("files dragged over the main window");
                    DRAGGING_FILES.store(files, std::sync::atomic::Ordering::Relaxed);
                    if files {
                        let (x, y) = logical(window, position);
                        let _ = window.emit_to(
                            window.label(),
                            FILE_DRAG_EVENT,
                            FileDragPayload { kind: "over", x, y },
                        );
                    }
                }
                DragDropEvent::Over { position } => {
                    if DRAGGING_FILES.load(std::sync::atomic::Ordering::Relaxed) {
                        let (x, y) = logical(window, position);
                        let _ = window.emit_to(
                            window.label(),
                            FILE_DRAG_EVENT,
                            FileDragPayload { kind: "over", x, y },
                        );
                    }
                }
                DragDropEvent::Leave => {
                    DRAGGING_FILES.store(false, std::sync::atomic::Ordering::Relaxed);
                    let _ = window.emit_to(
                        window.label(),
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
                    let _ = window.emit_to(
                        window.label(),
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
                        let _ = window.emit_to(
                            window.label(),
                            FILE_DROP_EVENT,
                            FileDropPayload { paths: files, x, y },
                        );
                    }
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Warraq")
        .run(|app, event| {
            // Kept ready in the background: closing the last window does not
            // end the app (the tray's Quit does).
            if let tauri::RunEvent::ExitRequested {
                api, code: None, ..
            } = &event
            {
                if ring::background() {
                    api.prevent_exit();
                }
            }
            // The Dock icon clicked when only a quick window was open (or none):
            // the editor comes.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } = event
            {
                quick::show_editor(app);
            }
            // Quit must not reach the C++ static destructors: ggml-metal's
            // device destructor asserts that no model is still loaded, and the
            // core, decide and AI threads still hold theirs, so Quit (Cmd+Q,
            // the menu, the tray) aborted with a crash report. exit() runs its
            // handlers newest first, so one registered now, after those
            // destructors, runs before them and ends the process. Tauri's own
            // cleanup and an update's restart still happen before exit().
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Exit = event {
                extern "C" fn end_now() {
                    use std::io::Write;
                    let _ = std::io::stdout().flush();
                    let _ = std::io::stderr().flush();
                    unsafe { libc::_exit(0) };
                }
                unsafe { libc::atexit(end_now) };
            }
            let _ = (app, event);
        });
}
