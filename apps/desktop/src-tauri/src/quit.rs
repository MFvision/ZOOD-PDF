//! Quit, asked first. The application menu's Quit (and Cmd+Q) is the app's
//! own item, not the system's: that one ends the app at once, and a stray
//! click on it, while a big file made the Mac slow, closed ZOOD with its
//! documents open and no word said (0.4.26). Now, while documents are open,
//! a dialog of the system's own asks — so it is asked even while the page is
//! too busy to answer — unless the person chose "Don't ask again". Unsaved
//! changes are always asked about.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, State, WebviewWindow};

use crate::updates::{total_open, UnsavedState};

const FILE: &str = "quit.json";

/// How many documents each window has open, by window label.
#[derive(Default)]
pub struct OpenState(Mutex<HashMap<String, u32>>);

/// Each window says how many documents it has open whenever that changes.
#[tauri::command]
pub fn open_report(window: WebviewWindow, state: State<'_, OpenState>, count: u32) {
    if let Ok(mut counts) = state.0.lock() {
        if count == 0 {
            counts.remove(window.label());
        } else {
            counts.insert(window.label().to_string(), count.min(64));
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuitSettings {
    ask_when_open: bool,
}

impl Default for QuitSettings {
    fn default() -> Self {
        QuitSettings {
            ask_when_open: true,
        }
    }
}

fn load<R: Runtime>(app: &AppHandle<R>) -> QuitSettings {
    app.path()
        .app_data_dir()
        .ok()
        .and_then(|dir| std::fs::read_to_string(dir.join(FILE)).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn store<R: Runtime>(app: &AppHandle<R>, settings: QuitSettings) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("E_IO: {e}"))?;
    let text = serde_json::to_string(&settings).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(FILE), text).map_err(|e| format!("E_IO: {e}"))
}

/// Settings › General: whether Quit asks while documents are open.
#[tauri::command]
pub fn quit_ask_get(app: AppHandle) -> bool {
    load(&app).ask_when_open
}

#[tauri::command]
pub fn quit_ask_set(app: AppHandle, on: bool) -> Result<bool, String> {
    store(&app, QuitSettings { ask_when_open: on })?;
    Ok(on)
}

fn total<R: Runtime>(app: &AppHandle<R>, counts: &Mutex<HashMap<String, u32>>) -> u32 {
    counts
        .lock()
        .map(|mut counts| total_open(&mut counts, |label| app.get_webview_window(label).is_some()))
        .unwrap_or(0)
}

/// What Quit says first, if anything.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Ask {
    Nothing,
    /// Documents open, nothing unsaved: Quit, Don't Ask Again, Cancel.
    Open(u32),
    /// Unsaved changes: Quit Anyway or Cancel, always.
    Unsaved(u32),
}

fn what_to_ask(open: u32, unsaved: u32, ask_when_open: bool) -> Ask {
    if unsaved > 0 {
        Ask::Unsaved(unsaved)
    } else if open > 0 && ask_when_open {
        Ask::Open(open)
    } else {
        Ask::Nothing
    }
}

fn turn_asking_off<R: Runtime>(app: &AppHandle<R>) {
    let _ = store(
        app,
        QuitSettings {
            ask_when_open: false,
        },
    );
}

/// Quit from the menu or Cmd+Q.
pub fn quit_asking<R: Runtime>(app: &AppHandle<R>) {
    use tauri_plugin_dialog::{
        DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
    };

    let unsaved = app
        .try_state::<UnsavedState>()
        .map(|state| total(app, &state.0))
        .unwrap_or(0);
    let open = app
        .try_state::<OpenState>()
        .map(|state| total(app, &state.0))
        .unwrap_or(0);
    let handle = app.clone();
    match what_to_ask(open, unsaved, load(app).ask_when_open) {
        Ask::Nothing => app.exit(0),
        Ask::Unsaved(count) => {
            let words = crate::menu::quit_words(count, true);
            app.dialog()
                .message(words.message)
                .title(words.title)
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::OkCancelCustom(
                    words.quit,
                    words.cancel,
                ))
                .show(move |quit| {
                    if quit {
                        handle.exit(0);
                    }
                });
        }
        Ask::Open(count) => {
            let words = crate::menu::quit_words(count, false);
            let (quit, never) = (words.quit.clone(), words.never.clone());
            app.dialog()
                .message(words.message)
                .title(words.title)
                .kind(MessageDialogKind::Info)
                .buttons(MessageDialogButtons::YesNoCancelCustom(
                    words.quit,
                    words.never,
                    words.cancel,
                ))
                .show_with_result(move |answer| match answer {
                    MessageDialogResult::Yes => handle.exit(0),
                    MessageDialogResult::Custom(label) if label == quit => handle.exit(0),
                    MessageDialogResult::No => {
                        turn_asking_off(&handle);
                        handle.exit(0);
                    }
                    MessageDialogResult::Custom(label) if label == never => {
                        turn_asking_off(&handle);
                        handle.exit(0);
                    }
                    _ => {}
                });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsaved_changes_are_always_asked_about_open_documents_only_when_chosen() {
        assert_eq!(what_to_ask(0, 0, true), Ask::Nothing);
        assert_eq!(what_to_ask(2, 0, true), Ask::Open(2));
        assert_eq!(what_to_ask(2, 0, false), Ask::Nothing);
        assert_eq!(what_to_ask(2, 1, false), Ask::Unsaved(1));
        assert_eq!(what_to_ask(0, 1, true), Ask::Unsaved(1));
    }

    #[test]
    fn asking_is_on_until_turned_off() {
        assert!(QuitSettings::default().ask_when_open);
        let off: QuitSettings = serde_json::from_str(r#"{"askWhenOpen":false}"#).unwrap();
        assert!(!off.ask_when_open);
    }
}
