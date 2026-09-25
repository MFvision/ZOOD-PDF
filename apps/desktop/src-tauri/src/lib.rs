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
#[cfg(target_os = "macos")]
mod print_macos;

use std::path::PathBuf;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, DragDropEvent, Emitter, Manager, Runtime, WebviewWindow, WindowEvent};
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
];

#[tauri::command]
fn host_info() -> host::HostInfo {
    host::host_info(drop::TargetOs::current())
}

/// Called by the UI once it has rendered. With `ZOOD_SMOKE_EXIT_ON_READY=1` the app prints
/// `ZOOD_READY` and exits 0 (headless smoke test, see scripts/desktop-smoke.sh).
#[tauri::command]
fn app_ready<R: Runtime>(app: AppHandle<R>) {
    if host::smoke_flag_set(std::env::var(host::SMOKE_ENV).ok().as_deref()) {
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

/// Default location + sanitised name for a save dialog: `<Documents>/<safe name>`.
#[tauri::command]
fn suggest_save_path<R: Runtime>(app: AppHandle<R>, name: String) -> String {
    let safe = names::sanitize_file_name(&name);
    match app.path().document_dir() {
        Ok(dir) => dir.join(safe).to_string_lossy().into_owned(),
        Err(_) => safe,
    }
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
        .invoke_handler(tauri::generate_handler![
            host_info,
            app_ready,
            set_locale,
            set_menu,
            print_pdf,
            suggest_save_path
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
