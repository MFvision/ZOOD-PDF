//! Updates from GitHub (docs/updates.md). The app asks the stable channel —
//! one fixed release, `updates-stable`, whose `latest.json` names the newest
//! version released to users — whether there is something newer than itself.
//! The test builds published on every run of the Windows workflow are never
//! on that channel: a version reaches it only through the "Release to users"
//! workflow, after it was tried.
//!
//! An update is installed only when its signature matches the public key in
//! tauri.conf.json (`plugins.updater.pubkey`); the private key lives in the
//! repository's secrets, nowhere else. The interface asks first, always:
//! `update_check` says what there is, `update_install` installs what the
//! last check found and restarts into it.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_updater::{Update, UpdaterExt};

/// The update the last check found, kept until the person installs it.
#[derive(Default)]
pub struct UpdateState(Mutex<Option<Update>>);

/// How many documents each window holds with unsaved changes, by window
/// label, so "Update now" can warn before the restart closes them all.
#[derive(Default)]
pub struct UnsavedState(pub(crate) Mutex<HashMap<String, u32>>);

/// Each window says how many of its documents have unsaved changes whenever
/// that number changes.
#[tauri::command]
pub fn unsaved_report(window: WebviewWindow, state: State<'_, UnsavedState>, count: u32) {
    if let Ok(mut counts) = state.0.lock() {
        if count == 0 {
            counts.remove(window.label());
        } else {
            counts.insert(window.label().to_string(), count.min(MAX_TABS_PER_WINDOW));
        }
    }
}

/// Documents with unsaved changes across every open window.
#[tauri::command]
pub fn unsaved_total(app: AppHandle, state: State<'_, UnsavedState>) -> u32 {
    let Ok(mut counts) = state.0.lock() else {
        return 0;
    };
    total_open(&mut counts, |label| app.get_webview_window(label).is_some())
}

/// A window never reports more documents than it can hold tabs.
const MAX_TABS_PER_WINDOW: u32 = 64;

/// The sum over windows still open; a closed window's entry is dropped.
pub(crate) fn total_open(counts: &mut HashMap<String, u32>, open: impl Fn(&str) -> bool) -> u32 {
    counts.retain(|label, _| open(label));
    counts.values().fold(0u32, |sum, n| sum.saturating_add(*n))
}

/// What the interface shows about an update.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    /// The release notes, when the release has any.
    pub notes: Option<String>,
}

/// Download progress, sent as `update-progress` while an update downloads.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    pub downloaded: u64,
    /// Unknown when the server does not say how large the file is.
    pub total: Option<u64>,
}

pub const PROGRESS_EVENT: &str = "update-progress";

/// How long asking the channel, and downloading the update, may take before
/// they are given up: a stalled connection fails instead of hanging forever.
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30 * 60);

fn info(update: &Update) -> UpdateInfo {
    UpdateInfo {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        notes: update
            .body
            .as_ref()
            .map(|body| body.trim().to_string())
            .filter(|body| !body.is_empty()),
    }
}

/// Asks the stable channel for a newer version. `None` when this is the
/// newest; an error (`E_UPDATE: …`) when the channel could not be read.
#[tauri::command]
pub async fn update_check(
    app: AppHandle,
    state: State<'_, UpdateState>,
) -> Result<Option<UpdateInfo>, String> {
    // The Store updates its own copy, and its rules forbid an app updating
    // itself (src/packaged.rs): this copy never finds an update.
    if crate::packaged::is_packaged() {
        return Ok(None);
    }
    let updater = app
        .updater_builder()
        .timeout(CHECK_TIMEOUT)
        .build()
        .map_err(|e| format!("E_UPDATE: {e}"))?;
    let found = updater
        .check()
        .await
        .map_err(|e| format!("E_UPDATE: {e}"))?;
    let shown = found.as_ref().map(info);
    *state.0.lock().map_err(|e| format!("E_UPDATE: {e}"))? = found;
    Ok(shown)
}

/// Downloads the update the last check found, checks its signature, installs
/// it and restarts into it. On Windows the installer closes the app itself.
/// The update stays kept until it is installed, so a failed download can be
/// tried again.
#[tauri::command]
pub async fn update_install(app: AppHandle, state: State<'_, UpdateState>) -> Result<(), String> {
    let mut update = state
        .0
        .lock()
        .map_err(|e| format!("E_UPDATE: {e}"))?
        .clone()
        .ok_or_else(|| "E_UPDATE: no update to install".to_string())?;
    update.timeout = Some(DOWNLOAD_TIMEOUT);
    let mut downloaded = 0u64;
    let progress = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = progress.emit(PROGRESS_EVENT, UpdateProgress { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(|e| format!("E_UPDATE: {e}"))?;
    if let Ok(mut kept) = state.0.lock() {
        *kept = None;
    }
    crate::core_bridge::debug_log(format!("update {} installed, restarting", update.version));
    // `request_restart`, not `restart`: it goes through `RunEvent::Exit`,
    // where the macOS Quit fix in lib.rs must still run.
    app.request_restart();
    Ok(())
}

#[cfg(test)]
mod unsaved_tests {
    use super::*;

    #[test]
    fn counts_only_windows_still_open() {
        let mut counts = HashMap::from([
            ("main".to_string(), 2),
            ("doc-1".to_string(), 1),
            ("doc-2".to_string(), 3),
        ]);
        assert_eq!(total_open(&mut counts, |label| label != "doc-2"), 3);
        assert!(!counts.contains_key("doc-2"));
        assert_eq!(total_open(&mut HashMap::new(), |_| true), 0);
    }
}
