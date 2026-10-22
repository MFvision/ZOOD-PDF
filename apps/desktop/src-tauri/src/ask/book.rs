//! Ask ZOOD's command book, between the island and the editor window.
//!
//! Inside ZOOD PDF, Do it for me and Show me do not look at the screen: the
//! island asks the editor window for its commands (every menu item, as the
//! menu shows it) and sends it the steps to run, one at a time, the way the
//! menu would run them (`packages/ui/src/shell/askBridge.ts`,
//! `packages/ui/src/ask/book.ts`). The island and the editor are two
//! webviews, so each question goes out as an event to the editor in front
//! and comes back through `ask_relay_reply`, matched by its number.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Runtime};
use tokio::sync::oneshot;

use crate::doc_window::focused_editor;

/// Ask the editor for its commands. Payload: `{ request }`.
pub const BOOK_EVENT: &str = "ask://book";
/// Run one step. Payload: `{ request, step, mode }`.
pub const COMMAND_EVENT: &str = "ask://command";
/// Stop the step waiting for the person's click (Show me).
pub const COMMAND_STOP_EVENT: &str = "ask://command-stop";

/// How long the editor has to list its commands.
const BOOK_WAITS: Duration = Duration::from_millis(2500);
/// How long a step Do it for me runs may take.
const DO_WAITS: Duration = Duration::from_secs(10);
/// How long Show me waits for the person's click (the editor stops it first).
const SHOW_WAITS: Duration = Duration::from_secs(5 * 60 + 5);

static NEXT: AtomicU64 = AtomicU64::new(1);
static WAITING: Mutex<Option<HashMap<u64, oneshot::Sender<Value>>>> = Mutex::new(None);

/// Sends `event` to the editor in front and waits for its answer.
async fn ask_editor<R: Runtime>(
    app: &AppHandle<R>,
    event: &str,
    mut payload: Value,
    waits: Duration,
) -> Result<Value, String> {
    let editor = focused_editor(app).ok_or("E_ASK: ZOOD PDF has no window open")?;
    let request = NEXT.fetch_add(1, Ordering::Relaxed);
    let (send, answer) = oneshot::channel();
    WAITING
        .lock()
        .map_err(|e| e.to_string())?
        .get_or_insert_with(HashMap::new)
        .insert(request, send);
    payload["request"] = json!(request);
    let forget = || {
        if let Ok(mut waiting) = WAITING.lock() {
            if let Some(waiting) = waiting.as_mut() {
                waiting.remove(&request);
            }
        }
    };
    if let Err(e) = app.emit_to(editor.as_str(), event, payload) {
        forget();
        return Err(format!("E_ASK: {e}"));
    }
    match tokio::time::timeout(waits, answer).await {
        Ok(Ok(value)) => Ok(value),
        _ => {
            forget();
            Err("E_ASK: ZOOD PDF did not answer".to_string())
        }
    }
}

/// The editor's commands: `{ entries: [{ id, label, menu, enabled }] }`.
#[tauri::command]
pub async fn ask_book<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    ask_editor(&app, BOOK_EVENT, json!({}), BOOK_WAITS).await
}

/// Runs one step in the editor (`mode` "do"), or lights its button and
/// waits for the person to click it ("show"). Answers `{ ran, reason? }`.
#[tauri::command]
pub async fn ask_command<R: Runtime>(
    app: AppHandle<R>,
    step: Value,
    mode: String,
) -> Result<Value, String> {
    let mode = if mode == "show" { "show" } else { "do" };
    let waits = if mode == "show" { SHOW_WAITS } else { DO_WAITS };
    ask_editor(
        &app,
        COMMAND_EVENT,
        json!({ "step": step, "mode": mode }),
        waits,
    )
    .await
}

/// Ends a Show me step that waits for a click.
#[tauri::command]
pub fn ask_command_stop<R: Runtime>(app: AppHandle<R>) {
    if let Some(editor) = focused_editor(&app) {
        let _ = app.emit_to(editor.as_str(), COMMAND_STOP_EVENT, ());
    }
}

/// The editor's answer to `request`.
#[tauri::command]
pub fn ask_relay_reply(request: u64, answer: Value) {
    let send = WAITING
        .lock()
        .ok()
        .and_then(|mut waiting| waiting.as_mut().and_then(|w| w.remove(&request)));
    if let Some(send) = send {
        let _ = send.send(answer);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_answer_reaches_the_one_waiting_for_it() {
        let (send, mut answer) = oneshot::channel();
        WAITING
            .lock()
            .unwrap()
            .get_or_insert_with(HashMap::new)
            .insert(9_000_001, send);
        ask_relay_reply(9_000_002, json!({ "ran": false }));
        assert!(answer.try_recv().is_err());
        ask_relay_reply(9_000_001, json!({ "ran": true }));
        assert_eq!(answer.try_recv().unwrap(), json!({ "ran": true }));
        // Answered once: a second answer finds nobody.
        ask_relay_reply(9_000_001, json!({ "ran": true }));
    }
}
