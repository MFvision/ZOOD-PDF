//! Read aloud commands (`speech_*`): the OS speech engine from the `zood-speech` crate
//! (AVSpeechSynthesizer on macOS, Windows.Media.SpeechSynthesis on Windows). On Linux there is
//! no native engine: `speech_voices` returns nothing and `host_info.speech` is false, so the
//! interface uses the webview's on-device `speechSynthesis` voices or hides the feature.
//! Events go to the web layer as `zood://speech` `{ id, kind: start|end|error, message? }`.

use std::sync::{Arc, OnceLock};

use tauri::{AppHandle, Emitter, Runtime, State};
use zood_speech::{Emit, Engine, MainRunner, SpeakRequest, Voice};

pub const SPEECH_EVENT: &str = "zood://speech";

/// Created on first use (it needs the app handle for events and the main thread).
#[derive(Default)]
pub struct SpeechState(OnceLock<Option<Arc<dyn Engine>>>);

impl SpeechState {
    fn engine<R: Runtime>(&self, app: &AppHandle<R>) -> Option<Arc<dyn Engine>> {
        self.0
            .get_or_init(|| {
                let events = app.clone();
                let emit: Emit = Arc::new(move |e| {
                    let _ = events.emit(SPEECH_EVENT, e);
                });
                let main_app = app.clone();
                let main: MainRunner = Arc::new(move |f| {
                    let _ = main_app.run_on_main_thread(f);
                });
                zood_speech::engine(emit, main)
            })
            .clone()
    }
}

/// Installed voices, best first (empty where there is no native engine).
#[tauri::command]
pub fn speech_voices<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, SpeechState>,
) -> Result<Vec<Voice>, String> {
    match state.engine(&app) {
        Some(e) => e.voices(),
        None => Ok(Vec::new()),
    }
}

/// Speaks one sentence with the chosen installed voice (rate/pitch 1 = normal, 0.5–2).
#[tauri::command]
pub async fn speech_speak<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, SpeechState>,
    id: u32,
    text: String,
    voice: String,
    rate: f64,
    pitch: f64,
) -> Result<(), String> {
    let req = SpeakRequest::new(&text, &voice, rate, pitch)?;
    let engine = state
        .engine(&app)
        .ok_or("no speech engine on this system")?;
    // Windows synthesises to a stream first (blocking wait): keep it off the async runtime.
    tauri::async_runtime::spawn_blocking(move || engine.speak(id, req))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn speech_pause<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, SpeechState>,
) -> Result<(), String> {
    state.engine(&app).map_or(Ok(()), |e| e.pause())
}

#[tauri::command]
pub fn speech_resume<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, SpeechState>,
) -> Result<(), String> {
    state.engine(&app).map_or(Ok(()), |e| e.resume())
}

#[tauri::command]
pub fn speech_stop<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, SpeechState>,
) -> Result<(), String> {
    state.engine(&app).map_or(Ok(()), |e| e.stop())
}
