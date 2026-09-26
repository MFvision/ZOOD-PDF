//! ZOOD PDF (زود PDF) desktop host.
//!
//! The whole interface is the shared web UI (`packages/ui`), served from the bundled `dist`
//! through Tauri's custom protocol. This crate only adds what a webview cannot do alone:
//! native file dialogs and file writes (WKWebView ignores `<input type=file>` and
//! `<a download>`), OS drag-and-drop with correct coordinates, printing, the macOS menu bar
//! and the window title. The PDF engine is the same WebAssembly build as on the web.

pub mod drop;
pub mod host;
pub mod menu_model;
pub mod names;
pub mod native_menu;
pub mod net;
#[cfg(target_os = "macos")]
mod print_macos;
pub mod print_raster;
pub mod trust;

use std::path::PathBuf;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{
    AppHandle, DragDropEvent, Emitter, Manager, Runtime, State, WebviewWindow, WindowEvent,
};
use tauri_plugin_fs::FsExt;

pub const DROP_EVENT: &str = "zood://drop";

/// Commands the web layer may call. Each needs a permission in `capabilities/main.json`
/// (build.rs declares them in the app manifest so none is allowed implicitly).
pub const COMMANDS: &[&str] = &[
    "host_info",
    "app_ready",
    "set_locale",
    "set_menu",
    "print_pdf",
    "suggest_save_path",
    "print_open",
    "print_page",
    "print_close",
    "sign_timestamp",
    "sign_ocsp",
    "sign_fetch_crl",
    "trust_list",
    "trust_add",
    "trust_remove",
];

#[tauri::command]
fn host_info() -> host::HostInfo {
    host::host_info(
        drop::TargetOs::current(),
        host::smoke_flag_set(std::env::var(host::SMOKE_ENV).ok().as_deref()),
    )
}

/// Called by the UI once it has rendered. With `ZOOD_SMOKE_EXIT_ON_READY=1` the app prints
/// `ZOOD_READY` and exits 0 (headless smoke test, see scripts/desktop-smoke.sh).
/// An optional `report` (≤ 4 KiB) is printed as `ZOOD_REPORT …` in smoke mode only.
#[tauri::command]
fn app_ready<R: Runtime>(app: AppHandle<R>, report: Option<String>) {
    if host::smoke_flag_set(std::env::var(host::SMOKE_ENV).ok().as_deref()) {
        if let Some(r) = report {
            let r: String = r.chars().filter(|c| !c.is_control()).take(4096).collect();
            println!("ZOOD_REPORT {r}");
        }
        println!("ZOOD_READY");
        app.exit(0);
    }
}

/// The UI sends its locale; the window title follows ("زود PDF" for Arabic).
#[tauri::command]
fn set_locale<R: Runtime>(window: WebviewWindow<R>, locale: String) -> Result<(), String> {
    let locale: String = locale.chars().take(35).collect();
    window
        .set_title(host::window_title_for_locale(&locale))
        .map_err(|e| e.to_string())
}

/// Builds the native menu bar from the web menu model. Only macOS has an app-wide menu bar
/// that the web toolbar cannot replace; on Windows/Linux the model is validated and `false`
/// is returned (the in-window web menus stay the only menus).
#[tauri::command]
fn set_menu<R: Runtime>(app: AppHandle<R>, model: String) -> Result<bool, String> {
    let mut model = menu_model::parse_menu_model(&model).map_err(|e| e.to_string())?;
    if drop::TargetOs::current() != drop::TargetOs::MacOs {
        return Ok(false);
    }
    let arabic = model.menus.first().is_some_and(|s| {
        s.label
            .chars()
            .any(|c| ('\u{0600}'..='\u{06FF}').contains(&c))
    });
    let (app_name, edit) = if arabic {
        (host::TITLE_AR, "تحرير")
    } else {
        (host::TITLE_EN, "Edit")
    };
    menu_model::ensure_edit_roles(&mut model, edit);
    let menu = native_menu::build_menu(&app, &model, app_name).map_err(|e| e.to_string())?;
    app.set_menu(menu).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Prints PDF bytes (raw IPC body). macOS: PDFKit print panel. Elsewhere the web layer prints
/// 300-dpi page images itself, so this returns an error the UI never triggers.
#[tauri::command]
async fn print_pdf<R: Runtime>(app: AppHandle<R>, request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw PDF bytes".into());
    };
    if bytes.len() > host::MAX_PRINT_BYTES || !host::looks_like_pdf(bytes) {
        return Err("not a printable PDF".into());
    }
    #[cfg(target_os = "macos")]
    {
        let bytes = bytes.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        app.run_on_main_thread(move || {
            let _ = tx.send(print_macos::print_pdf(bytes, host::TITLE_EN));
        })
        .map_err(|e| e.to_string())?;
        rx.recv().map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("native PDF printing is macOS-only; print page images instead".into())
    }
}

/// Starts a print job for Windows/Linux (raw PDF bytes): pages are rendered by warraq-render.
/// Returns the page count.
#[tauri::command]
async fn print_open(
    state: State<'_, print_raster::PrintState>,
    request: Request<'_>,
) -> Result<usize, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw PDF bytes".into());
    };
    if bytes.len() > host::MAX_PRINT_BYTES || !host::looks_like_pdf(bytes) {
        return Err("not a printable PDF".into());
    }
    let bytes = bytes.clone();
    let job = tauri::async_runtime::spawn_blocking(move || print_raster::PrintJob::open(bytes))
        .await
        .map_err(|e| e.to_string())??;
    let pages = job.pages();
    *state.0.lock().map_err(|_| "print state unavailable")? = Some(job);
    Ok(pages)
}

/// PNG of one page of the open print job at `dpi` (clamped to 72-300).
#[tauri::command]
async fn print_page(
    state: State<'_, print_raster::PrintState>,
    index: usize,
    dpi: f32,
) -> Result<Response, String> {
    let shared = state.inner().clone();
    let png = tauri::async_runtime::spawn_blocking(move || {
        let guard = shared
            .0
            .lock()
            .map_err(|_| "print state unavailable".to_owned())?;
        let job = guard.as_ref().ok_or("no print job is open")?;
        job.page_png(index, dpi)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(Response::new(png))
}

#[tauri::command]
fn print_close(state: State<'_, print_raster::PrintState>) -> Result<(), String> {
    *state.0.lock().map_err(|_| "print state unavailable")? = None;
    Ok(())
}

/// Default location + sanitised name for a save dialog: `<Documents>/<safe name>`.
#[tauri::command]
fn suggest_save_path<R: Runtime>(app: AppHandle<R>, name: String) -> String {
    let safe = names::sanitize_file_name(&name);
    match app.path().document_dir() {
        Ok(dir) => dir.join(safe).to_string_lossy().into_owned(),
        Err(_) => safe,
    }
}

/// POSTs an RFC 3161 request (`application/timestamp-query`) to the timestamp authority the
/// user chose, on the user's click (Sign at level B-T or above). Returns the raw reply.
#[tauri::command]
async fn sign_timestamp(url: String, request: Vec<u8>) -> Result<Response, String> {
    let reply = tauri::async_runtime::spawn_blocking(move || {
        net::post_der(
            &url,
            net::TSA_REQUEST,
            net::TSA_REPLY,
            &request,
            &net::HttpConfig::default(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    Ok(Response::new(reply))
}

/// POSTs an OCSP request to a responder named in the certificate and confirmed by the user.
#[tauri::command]
async fn sign_ocsp(url: String, request: Vec<u8>) -> Result<Response, String> {
    let reply = tauri::async_runtime::spawn_blocking(move || {
        net::post_der(
            &url,
            net::OCSP_REQUEST,
            net::OCSP_REPLY,
            &request,
            &net::HttpConfig::default(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    Ok(Response::new(reply))
}

/// GETs a CRL from a distribution point named in the certificate and confirmed by the user.
#[tauri::command]
async fn sign_fetch_crl(url: String) -> Result<Response, String> {
    let reply = tauri::async_runtime::spawn_blocking(move || {
        net::get_crl(&url, &net::HttpConfig::default())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    Ok(Response::new(reply))
}

fn trust_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join(trust::DIR_NAME))
        .map_err(|e| e.to_string())
}

/// The user's trusted certificates (DER), for signature verification.
#[tauri::command]
fn trust_list<R: Runtime>(app: AppHandle<R>) -> Result<Vec<Vec<u8>>, String> {
    trust::list(&trust_dir(&app)?).map_err(|e| e.to_string())
}

#[tauri::command]
fn trust_add<R: Runtime>(app: AppHandle<R>, sha256: String, der: Vec<u8>) -> Result<(), String> {
    trust::add(&trust_dir(&app)?, &sha256, &der).map_err(|e| e.to_string())
}

#[tauri::command]
fn trust_remove<R: Runtime>(app: AppHandle<R>, sha256: String) -> Result<(), String> {
    trust::remove(&trust_dir(&app)?, &sha256).map_err(|e| e.to_string())
}

fn on_drag_drop<R: Runtime>(window: &tauri::Window<R>, event: &DragDropEvent) {
    let DragDropEvent::Drop { paths, position } = event else {
        return;
    };
    let files = drop::dropped_files(paths, |p: &std::path::Path| p.is_file());
    if files.is_empty() {
        return;
    }
    // Dropped files become readable (and writable for "Save") through plugin-fs, exactly like
    // files picked in the open dialog; nothing else on disk does.
    let scope = window.fs_scope();
    for f in &files {
        let _ = scope.allow_file(PathBuf::from(&f.path));
    }
    let scale = window.scale_factor().unwrap_or(1.0);
    let payload = drop::DropPayload {
        files,
        position: drop::drop_position_to_logical(
            position.x,
            position.y,
            scale,
            drop::TargetOs::current(),
        ),
    };
    let _ = window.emit_to(window.label(), DROP_EVENT, payload);
}

pub fn run() {
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(print_raster::PrintState::default())
        .invoke_handler(tauri::generate_handler![
            host_info,
            app_ready,
            set_locale,
            set_menu,
            print_pdf,
            suggest_save_path,
            print_open,
            print_page,
            print_close,
            sign_timestamp,
            sign_ocsp,
            sign_fetch_crl,
            trust_list,
            trust_add,
            trust_remove
        ])
        .on_menu_event(|app, event| {
            let _ = app.emit(
                native_menu::MENU_EVENT,
                serde_json::json!({ "id": event.id().as_ref() }),
            );
        })
        .on_window_event(|window, event| {
            if let WindowEvent::DragDrop(e) = event {
                on_drag_drop(window, e);
            }
        })
        .run(tauri::generate_context!());
    if let Err(e) = result {
        eprintln!("ZOOD PDF failed to start: {e}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn custom_protocol_is_compiled_in() {
        // Known trap: without the feature the binary loads devUrl instead of the bundled UI.
        const { assert!(cfg!(feature = "custom-protocol")) };
        assert!(!tauri::is_dev());
    }

    #[test]
    fn every_command_is_listed_for_the_acl() {
        let src = include_str!("../build.rs");
        for c in super::COMMANDS {
            assert!(
                src.contains(&format!("\"{c}\"")),
                "{c} missing from build.rs"
            );
        }
    }
}
