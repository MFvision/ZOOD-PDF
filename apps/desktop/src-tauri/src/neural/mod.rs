//! Natural voices for reading aloud and for Ask ZOOD's answers, run on the
//! device, on Windows and on a Mac.
//!
//! Windows' own offline voices (Hamed, Naayf, David) sound mechanical, a
//! webview offers nothing better, and a Mac without its Premium voices
//! downloaded reads in a flat compact one. Here the app downloads a pack of
//! neural voices once, on the person's click, and speaks with them through
//! ONNX Runtime (the `ort` crate):
//!
//! - Supertonic 3 (`supertonic.rs`): one model, ten voices, each reading
//!   Arabic and English straight from the letters, about four times faster
//!   than real time on four ordinary cores. The one offered first.
//! - Kareem, a Piper voice (`piper.rs`) for Arabic: Arabic is written
//!   without its vowels, so a small model (libtashkeel's, compiled in) puts
//!   them back first, and the app's own rules (`arabic.rs`) turn the
//!   vowelled text into the sounds the voice was trained on — in place of
//!   espeak-ng, which is GPL.
//!
//! Nothing here reaches the network except `speech_neural_download`, which
//! fetches the files the catalogue (`voices.json`) names from Hugging Face,
//! through the same checked download as the on-device AI model
//! (`ai::open_download`), and keeps each only once its size and SHA-256
//! match. The interface reads with these voices when the host lists them
//! (`packages/ui/src/speech/engines.ts`).

pub mod arabic;
#[cfg(any(target_os = "windows", target_os = "macos", test))]
pub mod piper;
#[cfg(any(target_os = "windows", target_os = "macos", test))]
pub mod stretch;
#[cfg(any(target_os = "windows", target_os = "macos", test))]
pub mod supertonic;
#[cfg(any(target_os = "windows", target_os = "macos", test))]
pub mod tashkeel;

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::core_bridge::debug_log;

/// Whether this build can speak with the natural voices.
pub const AVAILABLE: bool = cfg!(any(target_os = "windows", target_os = "macos"));

const VOICES_JSON: &str = include_str!("voices.json");

#[derive(Deserialize, Clone, Debug)]
pub struct VoiceFile {
    pub file: String,
    pub url: String,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    Piper,
    Supertonic,
}

/// One voice of a pack, as the catalogue writes it.
#[derive(Deserialize, Clone, Debug)]
pub struct PackVoice {
    pub id: String,
    pub name: String,
    /// Supertonic: the voice's style file, one of the pack's files.
    #[serde(default)]
    pub style: Option<String>,
    pub langs: Vec<String>,
}

/// What one download brings: files, and the voices they speak.
#[derive(Deserialize, Clone, Debug)]
pub struct PackSpec {
    pub id: String,
    pub name: String,
    pub engine: Engine,
    /// The pack's own folder under the voices folder; none keeps its files
    /// beside the others' (Kareem, as earlier versions kept it).
    #[serde(default)]
    pub folder: Option<String>,
    pub files: Vec<VoiceFile>,
    pub voices: Vec<PackVoice>,
}

impl PackSpec {
    pub fn bytes(&self) -> u64 {
        self.files.iter().map(|f| f.bytes).sum()
    }

    #[cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]
    fn file(&self, name: &str) -> Option<&VoiceFile> {
        self.files.iter().find(|f| f.file == name)
    }
}

/// A voice in one language, as the interface lists it: a Supertonic voice
/// once for Arabic and once for English (`st-f1-ar`, `st-f1-en`); a voice
/// of one language under the pack's own id for it (`ar-kareem`).
#[derive(Clone, Debug, PartialEq)]
pub struct Speaker {
    pub id: String,
    pub name: String,
    pub lang: String,
    pub pack: String,
    pub style: Option<String>,
}

#[derive(Deserialize)]
struct Catalogue {
    packs: Vec<PackSpec>,
}

fn catalogue() -> &'static [PackSpec] {
    static LIST: OnceLock<Catalogue> = OnceLock::new();
    &LIST
        .get_or_init(|| serde_json::from_str(VOICES_JSON).expect("voices.json is well formed"))
        .packs
}

pub fn pack_spec(id: &str) -> Result<&'static PackSpec, String> {
    catalogue()
        .iter()
        .find(|pack| pack.id == id)
        .ok_or_else(|| format!("E_ARGS: there is no voice pack called {id:?}"))
}

/// Every voice in every language, in the catalogue's order.
pub fn speakers() -> Vec<Speaker> {
    let mut out = Vec::new();
    for pack in catalogue() {
        for voice in &pack.voices {
            for lang in &voice.langs {
                out.push(Speaker {
                    id: if voice.langs.len() == 1 {
                        voice.id.clone()
                    } else {
                        format!("{}-{lang}", voice.id)
                    },
                    name: voice.name.clone(),
                    lang: lang.clone(),
                    pack: pack.id.clone(),
                    style: voice.style.clone(),
                });
            }
        }
    }
    out
}

pub fn speaker(id: &str) -> Result<Speaker, String> {
    speakers()
        .into_iter()
        .find(|s| s.id == id)
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

/// The folder a pack's files are kept in.
fn pack_dir(voices: &Path, pack: &PackSpec) -> Result<PathBuf, String> {
    let Some(folder) = &pack.folder else {
        return Ok(voices.to_path_buf());
    };
    let dir = voices.join(folder);
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

fn is_ready(dir: &Path, pack: &PackSpec) -> bool {
    pack.files
        .iter()
        .all(|file| is_verified(&dir.join(&file.file), file))
}

/* ---------------------------------------------------------------- state */

struct Downloading {
    received: u64,
    cancel: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct NeuralState {
    downloads: Mutex<HashMap<String, Downloading>>,
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    engine: Mutex<Option<engine::Engine>>,
}

/// One voice of a pack in one language, as the interface lists it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NeuralVoice {
    pub id: String,
    pub name: String,
    pub lang: String,
}

/// One pack, as the interface lists it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NeuralPack {
    pub id: String,
    pub name: String,
    /// Its download size, every file.
    pub bytes: u64,
    /// `ready`, `missing` or `downloading`.
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub received: Option<u64>,
    pub voices: Vec<NeuralVoice>,
}

/// The voice packs this build can use, and whether each is downloaded.
/// None where the app reads with the webview's voices only.
// Off the main thread on Windows, where it draws every window (`stall.rs`).
#[cfg_attr(windows, tauri::command(async))]
#[cfg_attr(not(windows), tauri::command)]
pub fn speech_neural_voices<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, NeuralState>,
) -> Result<Vec<NeuralPack>, String> {
    if !AVAILABLE {
        return Ok(Vec::new());
    }
    let voices = voices_dir(&app)?;
    let downloads = state.downloads.lock().unwrap_or_else(|e| e.into_inner());
    let speakers = speakers();
    catalogue()
        .iter()
        .map(|pack| {
            let downloading = downloads.get(&pack.id);
            let dir = pack_dir(&voices, pack)?;
            Ok(NeuralPack {
                id: pack.id.clone(),
                name: pack.name.clone(),
                bytes: pack.bytes(),
                state: if downloading.is_some() {
                    "downloading"
                } else if is_ready(&dir, pack) {
                    "ready"
                } else {
                    "missing"
                },
                received: downloading.map(|d| d.received),
                voices: speakers
                    .iter()
                    .filter(|s| s.pack == pack.id)
                    .map(|s| NeuralVoice {
                        id: s.id.clone(),
                        name: s.name.clone(),
                        lang: s.lang.clone(),
                    })
                    .collect(),
            })
        })
        .collect()
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
/// How long a voice's download may go without a byte before it is given up.
const STALL: std::time::Duration = std::time::Duration::from_secs(60);

/// One file into `dir`: streamed into `.part`, hashed as it goes, renamed
/// into place only once its size and digest match. `done` is what came
/// before it in the pack, for the progress shown.
#[allow(clippy::too_many_arguments)]
fn fetch<R: Runtime>(
    app: &AppHandle<R>,
    state: &NeuralState,
    pack: &PackSpec,
    file: &VoiceFile,
    dir: &Path,
    done: u64,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let target = dir.join(&file.file);
    let part = with_suffix(&target, ".part");
    let result = (|| {
        let response = crate::ai::open_download(&file.url)?;
        let mut out =
            std::fs::File::create(&part).map_err(|e| format!("E_IO: {}: {e}", part.display()))?;
        let mut hasher = Sha256::new();
        let mut received: u64 = 0;
        let mut announced: u64 = 0;
        let total = pack.bytes();
        // On a thread of its own, as the model's: a connection that stops
        // answering is given up, and Stop works while it waits.
        let body = response.into_body().into_reader();
        crate::ai::read_body(body, cancel, STALL, |buffer| {
            let n = buffer.len();
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
                    .get_mut(&pack.id)
                {
                    entry.received = done + received;
                }
                let _ = app.emit(
                    DOWNLOAD_EVENT,
                    DownloadEvent {
                        id: pack.id.clone(),
                        received: done + received,
                        total,
                    },
                );
            }
            Ok(())
        })?;
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

/// Downloads a voice pack, on the person's click: each file it does not
/// have yet, smallest first. Progress goes to the interface as
/// `warraq://speech-download`.
#[tauri::command]
pub async fn speech_neural_download<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, NeuralState>,
    id: String,
) -> Result<(), String> {
    if !AVAILABLE {
        return Err("E_SPEECH: this build reads with the system's voices".into());
    }
    let pack = pack_spec(&id)?.clone();
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
        let dir = pack_dir(&voices_dir(&handle)?, &pack)?;
        let mut files: Vec<&VoiceFile> = pack.files.iter().collect();
        files.sort_by_key(|f| f.bytes);
        let mut done = 0;
        for file in files {
            if !is_verified(&dir.join(&file.file), file) {
                fetch(&handle, &state, &pack, file, &dir, done, &cancel)?;
            }
            done += file.bytes;
        }
        Ok(())
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

/// Deletes a downloaded pack, and lets go of it if it is loaded.
// Off the main thread on Windows, where it draws every window (`stall.rs`).
#[cfg_attr(windows, tauri::command(async))]
#[cfg_attr(not(windows), tauri::command)]
pub fn speech_neural_delete<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, NeuralState>,
    id: String,
) -> Result<(), String> {
    let pack = pack_spec(&id)?;
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    if let Some(engine) = state
        .engine
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_mut()
    {
        engine.unload(&id);
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let _ = &state;
    let dir = pack_dir(&voices_dir(&app)?, pack)?;
    for file in &pack.files {
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
    if pack.folder.is_some() {
        let _ = std::fs::remove_dir(&dir);
    }
    Ok(())
}

/* ------------------------------------------------------------- speaking */

/// The longest text one call speaks: the interface sends a sentence at a
/// time, so this only bounds a runaway call.
const TEXT_LIMIT: usize = 4000;

/// Speaks `text` in the natural voice `voice` (an id the packs list) at
/// `rate` (1 normal, 0.5 to 3) and answers with the sound as a WAV file,
/// which the webview plays.
#[tauri::command]
pub async fn speech_synthesize<R: Runtime>(
    app: AppHandle<R>,
    voice: String,
    text: String,
    rate: f32,
) -> Result<tauri::ipc::Response, String> {
    let text: String = text.chars().take(TEXT_LIMIT).collect();
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        let speaker = speaker(&voice)?;
        let pack = pack_spec(&speaker.pack)?;
        let dir = pack_dir(&voices_dir(&app)?, pack)?;
        if !is_ready(&dir, pack) {
            return Err("E_SPEECH: this voice is not downloaded".into());
        }
        let handle = app.clone();
        let wav = tauri::async_runtime::spawn_blocking(move || {
            let state = handle.state::<NeuralState>();
            let mut engine = state.engine.lock().unwrap_or_else(|e| e.into_inner());
            engine
                .get_or_insert_with(engine::Engine::default)
                .speak(pack, &speaker, &dir, &text, rate)
        })
        .await
        .map_err(|e| format!("E_SPEECH: {e}"))??;
        Ok(tauri::ipc::Response::new(wav))
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
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

#[cfg(any(target_os = "windows", target_os = "macos"))]
mod engine {
    use std::collections::HashMap;
    use std::path::Path;

    use ort::session::Session;

    use super::{arabic, piper, stretch, supertonic, tashkeel, Engine as Kind, PackSpec, Speaker};

    /// The models in memory: the diacritizer, the Piper voice last used,
    /// and the Supertonic model with the voices it has read in.
    #[derive(Default)]
    pub struct Engine {
        tashkeel: Option<Session>,
        piper: Option<(String, piper::Voice)>,
        supertonic: Option<(
            String,
            supertonic::Model,
            HashMap<String, supertonic::Style>,
        )>,
    }

    impl Engine {
        /// Lets go of whatever `pack` loaded.
        pub fn unload(&mut self, pack: &str) {
            if self.piper.as_ref().is_some_and(|(id, _)| id == pack) {
                self.piper = None;
            }
            if self
                .supertonic
                .as_ref()
                .is_some_and(|(id, _, _)| id == pack)
            {
                self.supertonic = None;
            }
        }

        pub fn speak(
            &mut self,
            pack: &PackSpec,
            speaker: &Speaker,
            dir: &Path,
            text: &str,
            rate: f32,
        ) -> Result<Vec<u8>, String> {
            match pack.engine {
                Kind::Supertonic => self.speak_supertonic(pack, speaker, dir, text, rate),
                Kind::Piper => self.speak_piper(pack, dir, text, rate),
            }
        }

        fn speak_supertonic(
            &mut self,
            pack: &PackSpec,
            speaker: &Speaker,
            dir: &Path,
            text: &str,
            rate: f32,
        ) -> Result<Vec<u8>, String> {
            if self
                .supertonic
                .as_ref()
                .is_none_or(|(id, _, _)| *id != pack.id)
            {
                self.supertonic = None;
                let model = supertonic::Model::load(dir)?;
                self.supertonic = Some((pack.id.clone(), model, HashMap::new()));
            }
            let Some((_, model, styles)) = self.supertonic.as_mut() else {
                return Err("E_SPEECH: the voice did not load".into());
            };
            let style_file = speaker
                .style
                .as_deref()
                .ok_or("E_SPEECH: this voice has no style")?;
            if !styles.contains_key(style_file) {
                styles.insert(
                    style_file.to_string(),
                    supertonic::Style::load(&dir.join(style_file))?,
                );
            }
            let style = &styles[style_file];
            // Numbers are read as words in Arabic by the app's own rules;
            // the model reads English ones itself.
            let text = if speaker.lang == "ar" {
                arabic::spell_numbers(text)
            } else {
                text.to_string()
            };
            // Past the speed the voice stays clear at, its sound is played faster.
            let (voice_rate, quicker) = stretch::split(rate);
            let samples = model.speak(&text, &speaker.lang, style, voice_rate)?;
            let samples = stretch::faster(&samples, quicker, model.sample_rate);
            Ok(piper::wav(&supertonic::to_pcm(&samples), model.sample_rate))
        }

        fn speak_piper(
            &mut self,
            pack: &PackSpec,
            dir: &Path,
            text: &str,
            rate: f32,
        ) -> Result<Vec<u8>, String> {
            let model = pack
                .files
                .iter()
                .find(|f| f.file.ends_with(".onnx"))
                .ok_or("E_SPEECH: the pack has no model")?;
            let config = pack
                .file(&format!("{}.json", model.file))
                .ok_or("E_SPEECH: the pack has no settings")?;
            if self.piper.as_ref().is_none_or(|(id, _)| *id != pack.id) {
                self.piper = None;
                let voice = piper::Voice::load(&dir.join(&model.file), &dir.join(&config.file))?;
                self.piper = Some((pack.id.clone(), voice));
            }
            let Some((_, voice)) = self.piper.as_mut() else {
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
            let (voice_rate, quicker) = stretch::split(rate);
            let mut samples = Vec::new();
            for piece in super::pieces(&phonemes) {
                samples.extend(voice.speak(piece, voice_rate)?);
            }
            if quicker > 1.0 {
                let sound: Vec<f32> = samples.iter().map(|s| f32::from(*s) / 32768.0).collect();
                samples = supertonic::to_pcm(&stretch::faster(&sound, quicker, voice.sample_rate));
            }
            Ok(piper::wav(&samples, voice.sample_rate))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_catalogue_pins_each_pack_to_hugging_face_with_its_checksums() {
        assert!(!catalogue().is_empty());
        for pack in catalogue() {
            assert!(!pack.files.is_empty() && !pack.voices.is_empty());
            for file in &pack.files {
                assert!(file.url.starts_with("https://huggingface.co/"));
                // Pinned to one revision, never a branch that moves.
                let revision = file
                    .url
                    .split("/resolve/")
                    .nth(1)
                    .unwrap()
                    .split('/')
                    .next()
                    .unwrap();
                assert_eq!(revision.len(), 40, "{}", file.url);
                assert!(file.url.ends_with(&file.file));
                assert_eq!(file.sha256.len(), 64);
                assert!(file.bytes > 0);
            }
            let mut names: Vec<_> = pack.files.iter().map(|f| &f.file).collect();
            names.sort();
            names.dedup();
            assert_eq!(
                names.len(),
                pack.files.len(),
                "{}: one file per name",
                pack.id
            );
            for voice in &pack.voices {
                if let Some(style) = &voice.style {
                    assert!(pack.file(style).is_some(), "{}: {style}", voice.id);
                }
            }
            if pack.engine == Engine::Supertonic {
                assert!(pack.folder.is_some());
                for name in [
                    "duration_predictor.onnx",
                    "text_encoder.onnx",
                    "vector_estimator.onnx",
                    "vocoder.onnx",
                    "tts.json",
                    "unicode_indexer.json",
                ] {
                    assert!(pack.file(name).is_some(), "{name}");
                }
            }
        }
        // The first pack, the one offered first, reads both languages.
        let first = &catalogue()[0];
        assert_eq!(first.engine, Engine::Supertonic);
        assert!(first.voices.iter().all(|v| v.langs == ["ar", "en"]));
    }

    #[test]
    fn each_voice_is_listed_once_a_language_and_kareem_keeps_its_id() {
        let all = speakers();
        let mut ids: Vec<_> = all.iter().map(|s| s.id.clone()).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), all.len());
        let kareem = speaker("ar-kareem").unwrap();
        assert_eq!(
            (kareem.lang.as_str(), kareem.pack.as_str()),
            ("ar", "kareem")
        );
        let sara = speaker("st-f1-en").unwrap();
        assert_eq!(
            (sara.lang.as_str(), sara.style.as_deref()),
            ("en", Some("F1.json"))
        );
        assert_eq!(speaker("st-f1-ar").unwrap().lang, "ar");
        assert!(speaker("st-f1").is_err());
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
