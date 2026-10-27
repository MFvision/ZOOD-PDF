//! Natural voices for reading aloud on Windows, run on the device.
//!
//! Windows' own offline voices (Hamed, Naayf) sound mechanical, and a
//! webview offers nothing better. Here the app downloads a Piper voice — a
//! small neural model, ONNX — once, on the person's click, and speaks with
//! it through ONNX Runtime (the `ort` crate): about twenty times faster than
//! real time on an ordinary PC. Arabic is written without its vowels, so a
//! second small model (libtashkeel's, compiled in) puts them back first, and
//! the app's own rules (`arabic.rs`) turn the vowelled text into the sounds
//! the voice was trained on — in place of espeak-ng, which is GPL.
//!
//! Nothing here reaches the network except `speech_neural_download`, which
//! fetches the two files the catalogue (`voices.json`) names from Hugging
//! Face, through the same checked download as the on-device AI model
//! (`ai::open_download`), and keeps them only once their size and SHA-256
//! match. The interface reads with these voices when `speech_engine` says
//! `neural` (`packages/ui/src/speech/engines.ts`).

pub mod arabic;
#[cfg(target_os = "windows")]
pub mod piper;
#[cfg(target_os = "windows")]
pub mod tashkeel;

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::core_bridge::debug_log;

/// Whether this build can speak with the natural voices.
pub const AVAILABLE: bool = cfg!(target_os = "windows");

const VOICES_JSON: &str = include_str!("voices.json");

#[derive(Deserialize, Clone, Debug)]
pub struct VoiceFile {
    pub file: String,
    pub url: String,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Deserialize, Clone, Debug)]
pub struct VoiceSpec {
    pub id: String,
    pub name: String,
    pub lang: String,
    pub model: VoiceFile,
    pub config: VoiceFile,
}

#[derive(Deserialize)]
struct Catalogue {
    voices: Vec<VoiceSpec>,
}

fn catalogue() -> &'static [VoiceSpec] {
    static LIST: OnceLock<Catalogue> = OnceLock::new();
    &LIST
        .get_or_init(|| serde_json::from_str(VOICES_JSON).expect("voices.json is well formed"))
        .voices
}

pub fn voice_spec(id: &str) -> Result<&'static VoiceSpec, String> {
    catalogue()
        .iter()
        .find(|voice| voice.id == id)
        .ok_or_else(|| format!("E_ARGS: there is no natural voice called {id:?}"))
}

/// The folder the voices live in, in the app's own data directory.
fn voices_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("E_IO: no data directory for this app: {e}"))?;
    let dir = base.join("voices");
    std::fs::create_dir_all(&dir).map_err(|e| format!("E_IO: {}: {e}", dir.display()))?;
    Ok(dir)
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// Whether `path` is the file the catalogue describes: its size, and the
/// digest the download wrote beside it once it had checked it.
fn is_verified(path: &Path, spec: &VoiceFile) -> bool {
    std::fs::metadata(path).is_ok_and(|m| m.len() == spec.bytes)
        && std::fs::read_to_string(with_suffix(path, ".sha256"))
            .is_ok_and(|kept| kept.trim() == spec.sha256)
}

fn is_ready(dir: &Path, voice: &VoiceSpec) -> bool {
    is_verified(&dir.join(&voice.model.file), &voice.model)
        && is_verified(&dir.join(&voice.config.file), &voice.config)
}

/* ---------------------------------------------------------------- state */

struct Downloading {
    received: u64,
    cancel: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct NeuralState {
    downloads: Mutex<HashMap<String, Downloading>>,
    #[cfg(target_os = "windows")]
    engine: Mutex<Option<engine::Engine>>,
}

/// One natural voice, as the interface lists it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NeuralVoice {
    pub id: String,
    pub name: String,
    pub lang: String,
    /// Its download size, both files.
    pub bytes: u64,
    /// `ready`, `missing` or `downloading`.
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub received: Option<u64>,
}

/// The natural voices this build can use, and whether each is downloaded.
/// None where the app reads with the system's engine instead.
// Off the main thread on Windows, where it draws every window (`stall.rs`).
#[cfg_attr(windows, tauri::command(async))]
#[cfg_attr(not(windows), tauri::command)]
pub fn speech_neural_voices<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, NeuralState>,
) -> Result<Vec<NeuralVoice>, String> {
    if !AVAILABLE {
        return Ok(Vec::new());
    }
    let dir = voices_dir(&app)?;
    let downloads = state.downloads.lock().unwrap_or_else(|e| e.into_inner());
    Ok(catalogue()
        .iter()
        .map(|voice| {
            let downloading = downloads.get(&voice.id);
            NeuralVoice {
                id: voice.id.clone(),
                name: voice.name.clone(),
                lang: voice.lang.clone(),
                bytes: voice.model.bytes + voice.config.bytes,
                state: if downloading.is_some() {
                    "downloading"
                } else if is_ready(&dir, voice) {
                    "ready"
                } else {
                    "missing"
                },
                received: downloading.map(|d| d.received),
            }
        })
        .collect())
}

/* ------------------------------------------------------------- download */

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadEvent {
    id: String,
    received: u64,
    total: u64,
}

pub const DOWNLOAD_EVENT: &str = "warraq://speech-download";
const PROGRESS_EVERY: u64 = 1 << 20;

/// One file into `dir`: streamed into `.part`, hashed as it goes, renamed
/// into place only once its size and digest match. `done` is what came
/// before it, for the progress shown.
fn fetch<R: Runtime>(
    app: &AppHandle<R>,
    state: &NeuralState,
    voice: &VoiceSpec,
    file: &VoiceFile,
    dir: &Path,
    done: u64,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let target = dir.join(&file.file);
    let part = with_suffix(&target, ".part");
    let result = (|| {
        let mut response = crate::ai::open_download(&file.url)?;
        let mut body = response.body_mut().as_reader();
        let mut out =
            std::fs::File::create(&part).map_err(|e| format!("E_IO: {}: {e}", part.display()))?;
        let mut hasher = Sha256::new();
        let mut received: u64 = 0;
        let mut announced: u64 = 0;
        let mut buffer = vec![0u8; 256 * 1024];
        let total = voice.model.bytes + voice.config.bytes;
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err("E_CANCELLED: the download was stopped".to_string());
            }
            let n = body.read(&mut buffer).map_err(|e| format!("E_NET: {e}"))?;
            if n == 0 {
                break;
            }
            received += n as u64;
            if received > file.bytes {
                return Err("E_VERIFY: the file is larger than the catalogue says".to_string());
            }
            hasher.update(&buffer[..n]);
            out.write_all(&buffer[..n])
                .map_err(|e| format!("E_IO: {e}"))?;
            if received - announced >= PROGRESS_EVERY || received == file.bytes {
                announced = received;
                if let Some(entry) = state
                    .downloads
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .get_mut(&voice.id)
                {
                    entry.received = done + received;
                }
                let _ = app.emit(
                    DOWNLOAD_EVENT,
                    DownloadEvent {
                        id: voice.id.clone(),
                        received: done + received,
                        total,
                    },
                );
            }
        }
        out.sync_all().map_err(|e| format!("E_IO: {e}"))?;
        drop(out);
        let digest = hex::encode(hasher.finalize());
        if received != file.bytes || digest != file.sha256 {
            return Err(format!(
                "E_VERIFY: the download did not match the catalogue (size {received}, sha256 {}…)",
                &digest[..12]
            ));
        }
        std::fs::write(with_suffix(&target, ".sha256"), &digest)
            .map_err(|e| format!("E_IO: {e}"))?;
        std::fs::rename(&part, &target).map_err(|e| format!("E_IO: {e}"))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&part);
    }
    result
}

/// Downloads a natural voice, on the person's click: its settings file, then
/// the model. Progress goes to the interface as `warraq://speech-download`.
#[tauri::command]
pub async fn speech_neural_download<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, NeuralState>,
    id: String,
) -> Result<(), String> {
    if !AVAILABLE {
        return Err("E_SPEECH: this build reads with the system's voices".into());
    }
    let voice = voice_spec(&id)?.clone();
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut downloads = state.downloads.lock().unwrap_or_else(|e| e.into_inner());
        if downloads.contains_key(&id) {
            return Err("E_BUSY: this voice is already being downloaded".to_string());
        }
        downloads.insert(
            id.clone(),
            Downloading {
                received: 0,
                cancel: cancel.clone(),
            },
        );
    }
    let handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<NeuralState>();
        let dir = voices_dir(&handle)?;
        let config = (!is_verified(&dir.join(&voice.config.file), &voice.config))
            .then(|| fetch(&handle, &state, &voice, &voice.config, &dir, 0, &cancel));
        config.unwrap_or(Ok(()))?;
        if is_verified(&dir.join(&voice.model.file), &voice.model) {
            return Ok(());
        }
        fetch(
            &handle,
            &state,
            &voice,
            &voice.model,
            &dir,
            voice.config.bytes,
            &cancel,
        )
    })
    .await
    .map_err(|e| format!("E_IO: {e}"))
    .and_then(|r| r);
    debug_log(format!("speech: download of {id} -> {result:?}"));
    state
        .downloads
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&id);
    result
}

#[tauri::command]
pub fn speech_neural_cancel_download(state: State<'_, NeuralState>, id: String) {
    if let Some(download) = state
        .downloads
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&id)
    {
        download.cancel.store(true, Ordering::Relaxed);
    }
}

/// Deletes a downloaded voice, and lets go of it if it is loaded.
// Off the main thread on Windows, where it draws every window (`stall.rs`).
#[cfg_attr(windows, tauri::command(async))]
#[cfg_attr(not(windows), tauri::command)]
pub fn speech_neural_delete<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, NeuralState>,
    id: String,
) -> Result<(), String> {
    let voice = voice_spec(&id)?;
    #[cfg(target_os = "windows")]
    if let Some(engine) = state
        .engine
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_mut()
    {
        engine.unload(&id);
    }
    #[cfg(not(target_os = "windows"))]
    let _ = &state;
    let dir = voices_dir(&app)?;
    for file in [&voice.model, &voice.config] {
        let path = dir.join(&file.file);
        for path in [
            with_suffix(&path, ".sha256"),
            with_suffix(&path, ".part"),
            path,
        ] {
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("E_IO: {}: {e}", path.display())),
            }
        }
    }
    Ok(())
}

/* ------------------------------------------------------------- speaking */

/// The longest text one call speaks: the interface sends a sentence at a
/// time, so this only bounds a runaway call.
const TEXT_LIMIT: usize = 4000;

/// Speaks `text` in the natural voice `voice` at `rate` (1 normal, 0.5 to
/// 2) and answers with the sound as a WAV file, which the webview plays.
#[tauri::command]
pub async fn speech_synthesize<R: Runtime>(
    app: AppHandle<R>,
    voice: String,
    text: String,
    rate: f32,
) -> Result<tauri::ipc::Response, String> {
    let text: String = text.chars().take(TEXT_LIMIT).collect();
    #[cfg(target_os = "windows")]
    {
        let spec = voice_spec(&voice)?;
        let dir = voices_dir(&app)?;
        if !is_ready(&dir, spec) {
            return Err("E_SPEECH: this voice is not downloaded".into());
        }
        let handle = app.clone();
        let wav = tauri::async_runtime::spawn_blocking(move || {
            let state = handle.state::<NeuralState>();
            let mut engine = state.engine.lock().unwrap_or_else(|e| e.into_inner());
            engine
                .get_or_insert_with(engine::Engine::default)
                .speak(spec, &dir, &text, rate)
        })
        .await
        .map_err(|e| format!("E_SPEECH: {e}"))??;
        Ok(tauri::ipc::Response::new(wav))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, voice, text, rate);
        Err("E_SPEECH: this build reads with the system's voices".into())
    }
}

/// Where the phonemes of a long text are cut, so each piece the voice reads
/// stays short: at a punctuation mark once a piece is this long, at a space
/// once it is half again as long.
const PIECE: usize = 300;

/// `phonemes` in pieces the voice reads one at a time.
pub fn pieces(phonemes: &[char]) -> Vec<&[char]> {
    let mut out = Vec::new();
    let mut start = 0;
    for (i, c) in phonemes.iter().enumerate() {
        let len = i + 1 - start;
        let cut = (len >= PIECE && matches!(c, ',' | '.' | '!' | '?'))
            || (len >= PIECE * 3 / 2 && *c == ' ')
            || len >= PIECE * 2;
        if cut {
            out.push(&phonemes[start..=i]);
            start = i + 1;
        }
    }
    if start < phonemes.len() {
        out.push(&phonemes[start..]);
    }
    out
}

#[cfg(target_os = "windows")]
mod engine {
    use std::path::Path;

    use ort::session::Session;

    use super::{arabic, piper, tashkeel, VoiceSpec};

    /// The models in memory: the diacritizer, and the one voice last used.
    #[derive(Default)]
    pub struct Engine {
        tashkeel: Option<Session>,
        voice: Option<(String, piper::Voice)>,
    }

    impl Engine {
        pub fn unload(&mut self, id: &str) {
            if self.voice.as_ref().is_some_and(|(loaded, _)| loaded == id) {
                self.voice = None;
            }
        }

        pub fn speak(
            &mut self,
            spec: &VoiceSpec,
            dir: &Path,
            text: &str,
            rate: f32,
        ) -> Result<Vec<u8>, String> {
            if self.voice.as_ref().is_none_or(|(id, _)| *id != spec.id) {
                self.voice = None;
                let voice =
                    piper::Voice::load(&dir.join(&spec.model.file), &dir.join(&spec.config.file))?;
                self.voice = Some((spec.id.clone(), voice));
            }
            let Some((_, voice)) = self.voice.as_mut() else {
                return Err("E_SPEECH: the voice did not load".into());
            };
            let tashkeel = match self.tashkeel.as_mut() {
                Some(session) => session,
                None => self.tashkeel.insert(
                    piper::session_builder()?
                        .commit_from_memory(tashkeel::MODEL)
                        .map_err(|e| format!("E_SPEECH: {e}"))?,
                ),
            };
            let vowelled = tashkeel::diacritize(tashkeel, &arabic::spell_numbers(text))?;
            let phonemes = arabic::phonemize(&vowelled);
            let mut samples = Vec::new();
            for piece in super::pieces(&phonemes) {
                samples.extend(voice.speak(piece, rate)?);
            }
            Ok(piper::wav(&samples, voice.sample_rate))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_catalogue_pins_each_voice_to_hugging_face_with_its_checksums() {
        assert!(!catalogue().is_empty());
        for voice in catalogue() {
            for file in [&voice.model, &voice.config] {
                assert!(file
                    .url
                    .starts_with("https://huggingface.co/rhasspy/piper-voices/resolve/"));
                assert!(file.url.ends_with(&file.file));
                assert_eq!(file.sha256.len(), 64);
                assert!(file.bytes > 0);
            }
            assert_eq!(voice.config.file, format!("{}.json", voice.model.file));
        }
    }

    #[test]
    fn long_text_is_read_in_pieces_cut_at_its_pauses() {
        let short: Vec<char> = "salaːm.".chars().collect();
        assert_eq!(pieces(&short), vec![&short[..]]);
        let mut long: Vec<char> = "a".repeat(PIECE).chars().collect();
        long.push(',');
        long.extend("bcd".chars());
        let cut = pieces(&long);
        assert_eq!(cut.len(), 2);
        assert_eq!(*cut[0].last().unwrap(), ',');
        let endless: Vec<char> = "a".repeat(PIECE * 5).chars().collect();
        assert!(pieces(&endless).iter().all(|p| p.len() <= PIECE * 2));
        assert_eq!(pieces(&endless).concat(), endless);
    }
}
