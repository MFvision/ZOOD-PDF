//! The on-device model: llama.cpp in the host, the "On this device" provider
//! of the AI tool.
//!
//! Nothing here reaches the network except `ai_model_download`, which runs
//! only when the person presses the download button in the interface, fetches
//! the one file the catalogue names — from Hugging Face, following its
//! redirect to Hugging Face's own CDN and nowhere else — and keeps it only
//! once its size and SHA-256 match what the catalogue says. The catalogue is
//! the interface's own `models.json`, compiled in, so the two can never name
//! different files.
//!
//! Generation runs on a thread of its own that owns the loaded model (a
//! gigabyte, loaded once and kept), takes one request at a time, and sends
//! each token to the webview as it is sampled (`warraq://ai-token`). A request
//! is stopped by its id (`ai_cancel`). Metal on the Mac; the CPU elsewhere.
use std::collections::HashMap;
use std::io::{Read, Write};
use std::num::NonZeroU32;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::{AddBos, LlamaChatMessage, LlamaModel};
use llama_cpp_2::sampling::LlamaSampler;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::core_bridge::debug_log;

/* ----------------------------------------------------------- catalogue */

/// The interface's catalogue, shared verbatim.
const MODELS_JSON: &str = include_str!("../../../../packages/ui/src/ai/device/models.json");

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ModelSpec {
    pub id: String,
    pub name: String,
    pub file: String,
    pub url: String,
    pub sha256: String,
    pub bytes: u64,
}

#[derive(Deserialize)]
struct Catalogue {
    hosts: Vec<String>,
    models: Vec<ModelSpec>,
}

fn catalogue() -> &'static Catalogue {
    static LIST: OnceLock<Catalogue> = OnceLock::new();
    LIST.get_or_init(|| serde_json::from_str(MODELS_JSON).expect("models.json is well formed"))
}

pub fn model_spec(id: &str) -> Result<&'static ModelSpec, String> {
    catalogue()
        .models
        .iter()
        .find(|model| model.id == id)
        .ok_or_else(|| format!("E_ARGS: there is no on-device model called {id:?}"))
}

/// `host` is one the catalogue allows: `huggingface.co`, or a name under `hf.co`.
pub fn allowed_host(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    catalogue().hosts.iter().any(|pattern| {
        let pattern = pattern.trim_start_matches("https://");
        match pattern.strip_prefix("*.") {
            Some(domain) => host
                .strip_suffix(domain)
                .and_then(|label| label.strip_suffix('.'))
                .is_some_and(|label| !label.is_empty()),
            None => host == pattern,
        }
    })
}

/// The folder the models live in: the app's own data directory.
pub fn models_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("E_IO: no data directory for this app: {e}"))?;
    let dir = base.join("models");
    std::fs::create_dir_all(&dir).map_err(|e| format!("E_IO: {}: {e}", dir.display()))?;
    Ok(dir)
}

/* ---------------------------------------------------------------- state */

/// A download under way: its progress and its stop flag.
struct Downloading {
    received: u64,
    total: u64,
    cancel: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct AiState {
    downloads: Mutex<HashMap<String, Downloading>>,
    /// Requests under way, by id, each with the flag that stops it.
    requests: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// The engine thread, started on the first request.
    engine: Mutex<Option<mpsc::Sender<Job>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    pub state: &'static str,
    pub bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub received: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
}

/// Whether `path` is the model the catalogue describes: size first (cheap),
/// then the digest, which the download wrote beside it when it was checked.
pub fn is_verified(path: &Path, spec: &ModelSpec) -> bool {
    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    if size != spec.bytes {
        return false;
    }
    std::fs::read_to_string(path.with_extension("gguf.sha256"))
        .map(|kept| kept.trim() == spec.sha256)
        .unwrap_or(false)
}

#[tauri::command]
pub fn ai_model_status<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AiState>,
    id: String,
) -> Result<ModelStatus, String> {
    let spec = model_spec(&id)?;
    if let Some(download) = state
        .downloads
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&id)
    {
        return Ok(ModelStatus {
            state: "downloading",
            bytes: 0,
            received: Some(download.received),
            total: Some(download.total),
        });
    }
    let path = models_dir(&app)?.join(&spec.file);
    Ok(if is_verified(&path, spec) {
        ModelStatus {
            state: "ready",
            bytes: spec.bytes,
            received: None,
            total: None,
        }
    } else {
        ModelStatus {
            state: "missing",
            bytes: 0,
            received: None,
            total: None,
        }
    })
}

#[tauri::command]
pub fn ai_model_delete<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AiState>,
    id: String,
) -> Result<(), String> {
    let spec = model_spec(&id)?;
    // The loaded copy goes too: the file is unlinked, and a model held open
    // would keep answering from a file the person believes gone. Dropping
    // the sender ends the engine thread.
    state
        .engine
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take();
    let path = models_dir(&app)?.join(&spec.file);
    for file in [
        path.clone(),
        path.with_extension("gguf.sha256"),
        path.with_extension("gguf.part"),
    ] {
        match std::fs::remove_file(&file) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("E_IO: {}: {e}", file.display())),
        }
    }
    Ok(())
}

/// Where the model runs: "metal" on the Mac, "cpu" elsewhere.
#[tauri::command]
pub fn ai_runtime() -> &'static str {
    if cfg!(target_os = "macos") {
        "metal"
    } else {
        "cpu"
    }
}

/// This machine's memory in bytes, so the interface offers the smaller
/// model where the larger would not fit; 0 where it cannot be read.
#[tauri::command]
pub fn ai_memory_bytes() -> u64 {
    total_memory().unwrap_or(0)
}

#[cfg(target_os = "macos")]
fn total_memory() -> Option<u64> {
    let mut size: u64 = 0;
    let mut len = std::mem::size_of::<u64>();
    let name = c"hw.memsize";
    // SAFETY: sysctlbyname writes at most `len` bytes into `size`, whose
    // address and length are handed over together.
    let result = unsafe {
        libc::sysctlbyname(
            name.as_ptr(),
            (&mut size as *mut u64).cast(),
            &mut len,
            std::ptr::null_mut(),
            0,
        )
    };
    (result == 0).then_some(size)
}

#[cfg(target_os = "windows")]
fn total_memory() -> Option<u64> {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    let mut status = MEMORYSTATUSEX {
        dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
        dwMemoryLoad: 0,
        ullTotalPhys: 0,
        ullAvailPhys: 0,
        ullTotalPageFile: 0,
        ullAvailPageFile: 0,
        ullTotalVirtual: 0,
        ullAvailVirtual: 0,
        ullAvailExtendedVirtual: 0,
    };
    // SAFETY: the struct is sized as the call expects, by its own length field.
    (unsafe { GlobalMemoryStatusEx(&mut status) } != 0).then_some(status.ullTotalPhys)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn total_memory() -> Option<u64> {
    let info = std::fs::read_to_string("/proc/meminfo").ok()?;
    let line = info.lines().find(|line| line.starts_with("MemTotal:"))?;
    let kb: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
    Some(kb * 1024)
}

/* ------------------------------------------------------------- download */

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadEvent {
    id: String,
    received: u64,
    total: u64,
}

pub const DOWNLOAD_EVENT: &str = "warraq://ai-download";
const REDIRECTS: usize = 5;
const PROGRESS_EVERY: u64 = 1 << 20;

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(20)))
        .timeout_global(Some(Duration::from_secs(6 * 60 * 60)))
        .timeout_recv_response(Some(Duration::from_secs(120)))
        // Followed here, so each hop is checked against the catalogue's hosts.
        .max_redirects(0)
        .http_status_as_error(false)
        .user_agent("Warraq")
        .build()
        .into()
}

/// A GET of `url`, following redirects only to the catalogue's hosts.
fn open_download(url: &str) -> Result<ureq::http::Response<ureq::Body>, String> {
    let agent = agent();
    let mut url = url.to_string();
    for _ in 0..=REDIRECTS {
        let uri: ureq::http::Uri = url
            .parse()
            .map_err(|_| format!("E_NET: bad address {url}"))?;
        let host = uri.host().unwrap_or("");
        if uri.scheme_str() != Some("https") || !allowed_host(host) {
            return Err(format!("E_NET: {host} is not one of the model's hosts"));
        }
        let response = agent.get(&url).call().map_err(|e| format!("E_NET: {e}"))?;
        let status = response.status().as_u16();
        if (300..400).contains(&status) {
            let next = response
                .headers()
                .get("location")
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| "E_NET: a redirect without a location".to_string())?;
            url = next.to_string();
            continue;
        }
        if status != 200 {
            return Err(format!("E_NET: the server answered {status}"));
        }
        return Ok(response);
    }
    Err("E_NET: too many redirects".to_string())
}

/// The download itself, on a blocking thread: streamed into `.part`, hashed
/// as it goes, and renamed into place only once the size and the digest
/// match. A stopped or failed download leaves nothing behind.
fn download_model<R: Runtime>(
    app: &AppHandle<R>,
    state: &AiState,
    spec: &ModelSpec,
    cancel: Arc<AtomicBool>,
) -> Result<(), String> {
    let dir = models_dir(app)?;
    let target = dir.join(&spec.file);
    let part = target.with_extension("gguf.part");
    let result = stream_download(app, state, spec, &cancel, &target, &part);
    if result.is_err() {
        let _ = std::fs::remove_file(&part);
        let _ = std::fs::remove_file(target.with_extension("gguf.sha256"));
    }
    debug_log(format!("ai: download of {} -> {result:?}", spec.id));
    result
}

/// The body of `download_model`: everything that can fail, so a failure
/// anywhere in it is cleaned up in one place.
fn stream_download<R: Runtime>(
    app: &AppHandle<R>,
    state: &AiState,
    spec: &ModelSpec,
    cancel: &AtomicBool,
    target: &Path,
    part: &Path,
) -> Result<(), String> {
    let mut response = open_download(&spec.url)?;
    let mut body = response.body_mut().as_reader();
    let mut file =
        std::fs::File::create(part).map_err(|e| format!("E_IO: {}: {e}", part.display()))?;
    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    let mut announced: u64 = 0;
    let mut buffer = vec![0u8; 256 * 1024];
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("E_CANCELLED: the download was stopped".to_string());
        }
        let n = body.read(&mut buffer).map_err(|e| format!("E_NET: {e}"))?;
        if n == 0 {
            break;
        }
        received += n as u64;
        if received > spec.bytes {
            return Err("E_VERIFY: the file is larger than the catalogue says".to_string());
        }
        hasher.update(&buffer[..n]);
        file.write_all(&buffer[..n])
            .map_err(|e| format!("E_IO: {e}"))?;
        if received - announced >= PROGRESS_EVERY {
            announced = received;
            if let Some(entry) = state
                .downloads
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get_mut(&spec.id)
            {
                entry.received = received;
            }
            let _ = app.emit(
                DOWNLOAD_EVENT,
                DownloadEvent {
                    id: spec.id.clone(),
                    received,
                    total: spec.bytes,
                },
            );
        }
    }
    file.sync_all().map_err(|e| format!("E_IO: {e}"))?;
    drop(file);
    let digest = hex::encode(hasher.finalize());
    if received != spec.bytes || digest != spec.sha256 {
        return Err(format!(
            "E_VERIFY: the download did not match the catalogue (size {received}, sha256 {}…)",
            &digest[..12]
        ));
    }
    std::fs::write(target.with_extension("gguf.sha256"), &digest)
        .map_err(|e| format!("E_IO: {e}"))?;
    std::fs::rename(part, target).map_err(|e| format!("E_IO: {e}"))?;
    let _ = app.emit(
        DOWNLOAD_EVENT,
        DownloadEvent {
            id: spec.id.clone(),
            received,
            total: spec.bytes,
        },
    );
    Ok(())
}

#[tauri::command]
pub async fn ai_model_download<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AiState>,
    id: String,
) -> Result<(), String> {
    let spec = model_spec(&id)?.clone();
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut downloads = state.downloads.lock().unwrap_or_else(|e| e.into_inner());
        if downloads.contains_key(&id) {
            return Err("E_BUSY: this model is already being downloaded".to_string());
        }
        downloads.insert(
            id.clone(),
            Downloading {
                received: 0,
                total: spec.bytes,
                cancel: cancel.clone(),
            },
        );
    }
    let handle = app.clone();
    let state_handle: AppHandle<R> = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = state_handle.state::<AiState>();
        download_model(&handle, &state, &spec, cancel)
    })
    .await
    .map_err(|e| format!("E_IO: {e}"))?;
    state
        .downloads
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&id);
    result
}

#[tauri::command]
pub fn ai_model_cancel_download(state: State<'_, AiState>, id: String) {
    if let Some(download) = state
        .downloads
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&id)
    {
        download.cancel.store(true, Ordering::Relaxed);
    }
}

/* ------------------------------------------------------------ generation */

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub role: String,
    pub content: String,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GenerateRequest {
    pub id: String,
    pub model: String,
    pub messages: Vec<Message>,
    #[serde(default)]
    pub grammar: Option<String>,
    pub max_tokens: u32,
    /// The window this request runs in, in tokens; the interface chooses it
    /// from the machine's memory (`contextTokensFor`). `DEFAULT_CONTEXT` when
    /// not given, and always kept inside what the engine allows.
    #[serde(default)]
    pub context_tokens: Option<u32>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Generated {
    pub text: String,
    pub cut_off: bool,
    pub tokens: u32,
    pub ms: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TokenEvent {
    id: String,
    text: String,
}

pub const TOKEN_EVENT: &str = "warraq://ai-token";
/// The window when a request names none: what the interface budgets its
/// text against on a machine whose memory it does not know.
pub const DEFAULT_CONTEXT: u32 = 4096;
/// The widest window a request may ask for. Qwen2.5 was trained on 32k; past
/// 16k a laptop spends minutes reading the prompt.
pub const MAX_CONTEXT: u32 = 16_384;
const MIN_CONTEXT: u32 = 2048;

/// The window a request runs in: what it asked for, inside the engine's bounds.
pub fn context_for(request: &GenerateRequest) -> u32 {
    request
        .context_tokens
        .unwrap_or(DEFAULT_CONTEXT)
        .clamp(MIN_CONTEXT, MAX_CONTEXT)
}
const BATCH: usize = 512;

/// The loaded model, on the engine's own thread.
pub struct Engine {
    backend: LlamaBackend,
    model: LlamaModel,
    path: PathBuf,
}

impl Engine {
    /// Loads the model at `path`: onto the GPU on the Mac, into memory elsewhere.
    pub fn load(path: &Path) -> Result<Self, String> {
        Self::load_with(path, cfg!(target_os = "macos").then_some(1000))
    }

    /// Loads the model with no layer on the graphics processor. The app never
    /// does; the measuring example does, on a Mac, to see what a machine
    /// without Metal makes of the same model.
    pub fn load_on_processor(path: &Path) -> Result<Self, String> {
        Self::load_with(path, Some(0))
    }

    fn load_with(path: &Path, gpu_layers: Option<u32>) -> Result<Self, String> {
        let mut backend = LlamaBackend::init().map_err(|e| format!("E_AI: {e}"))?;
        backend.void_logs();
        let params = match gpu_layers {
            Some(layers) => LlamaModelParams::default().with_n_gpu_layers(layers),
            None => LlamaModelParams::default(),
        };
        let model = LlamaModel::load_from_file(&backend, path, &params)
            .map_err(|e| format!("E_AI: cannot load the model: {e}"))?;
        Ok(Self {
            backend,
            model,
            path: path.to_path_buf(),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// How many tokens `text` is for this model: what a document is measured
    /// with, so a budget is the model's own count and not a guess from the
    /// number of characters.
    pub fn count_tokens(&self, text: &str) -> Result<usize, String> {
        self.model
            .str_to_token(text, AddBos::Never)
            .map(|tokens| tokens.len())
            .map_err(|e| format!("E_AI: {e}"))
    }

    /// Answers `request`, handing each token to `emit` as it is sampled,
    /// until the model ends, `max_tokens` is reached, or `cancel` is set.
    pub fn generate(
        &self,
        request: &GenerateRequest,
        cancel: &AtomicBool,
        mut emit: impl FnMut(&str),
    ) -> Result<Generated, String> {
        let started = Instant::now();
        let model = &self.model;
        let template = model
            .chat_template(None)
            .map_err(|e| format!("E_AI: the model has no chat template: {e}"))?;
        let chat: Vec<LlamaChatMessage> = request
            .messages
            .iter()
            .map(|m| {
                LlamaChatMessage::new(m.role.clone(), m.content.clone())
                    .map_err(|e| format!("E_AI: {e}"))
            })
            .collect::<Result<_, _>>()?;
        let prompt = model
            .apply_chat_template(&template, &chat, true)
            .map_err(|e| format!("E_AI: {e}"))?;
        let tokens = model
            .str_to_token(&prompt, AddBos::Always)
            .map_err(|e| format!("E_AI: {e}"))?;
        let context = context_for(request);
        let max_tokens = request.max_tokens.clamp(1, context / 2);
        if tokens.len() as u64 + u64::from(max_tokens) > u64::from(context) {
            return Err(format!(
                "E_TOO_LONG: the request is {} tokens; the window holds {} with the reply",
                tokens.len(),
                context - max_tokens
            ));
        }
        let threads = std::thread::available_parallelism()
            .map(|n| n.get().min(8) as i32)
            .unwrap_or(4);
        let params = LlamaContextParams::default()
            .with_n_ctx(NonZeroU32::new(context))
            .with_n_batch(BATCH as u32)
            .with_n_threads(threads)
            .with_n_threads_batch(threads);
        let mut ctx = model
            .new_context(&self.backend, params)
            .map_err(|e| format!("E_AI: {e}"))?;

        // The prompt, in batches, with logits asked of its last token only.
        let mut batch = LlamaBatch::new(BATCH, 1);
        let last = tokens.len() - 1;
        for (start, chunk) in tokens
            .chunks(BATCH)
            .enumerate()
            .map(|(i, c)| (i * BATCH, c))
        {
            // Reading a long prompt takes the CPU a while: Stop is heard between its batches too.
            if cancel.load(Ordering::Relaxed) {
                return Err("E_CANCELLED: stopped".to_string());
            }
            batch.clear();
            for (offset, token) in chunk.iter().enumerate() {
                let pos = start + offset;
                batch
                    .add(*token, pos as i32, &[0], pos == last)
                    .map_err(|e| format!("E_AI: {e}"))?;
            }
            ctx.decode(&mut batch).map_err(|e| format!("E_AI: {e}"))?;
        }

        let mut samplers = Vec::new();
        if let Some(grammar) = &request.grammar {
            samplers.push(
                LlamaSampler::grammar(model, grammar, "root")
                    .map_err(|e| format!("E_AI: bad grammar: {e}"))?,
            );
            samplers.push(LlamaSampler::greedy());
        } else {
            // A small model falls into saying one line over and over until
            // its reply runs out (measured: a 95-page statute "summarized" as
            // one sentence fifty times). What it has just written is made a
            // little less likely, and going on with a run of words it has
            // already written — beyond a citation's length — much less (DRY).
            // Only the reply is looked at, so quoting the document is free.
            samplers.push(LlamaSampler::penalties(model.n_vocab(), 128, 1.1, 0.0, 0.0));
            samplers.push(LlamaSampler::dry(
                model,
                0.8,
                1.75,
                6,
                1024,
                ["\n", ":", "\"", "*"],
            ));
            samplers.push(LlamaSampler::top_k(40));
            samplers.push(LlamaSampler::top_p(0.9, 1));
            samplers.push(LlamaSampler::temp(0.3));
            samplers.push(LlamaSampler::dist(42));
        }
        let mut sampler = LlamaSampler::chain_simple(samplers);

        let mut decoder = encoding_rs::UTF_8.new_decoder();
        let mut text = String::new();
        let mut produced = 0u32;
        let mut cut_off = false;
        let mut pos = tokens.len() as i32;
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err("E_CANCELLED: stopped".to_string());
            }
            let token = sampler.sample(&ctx, -1);
            if model.is_eog_token(token) {
                break;
            }
            let piece = model
                .token_to_piece(token, &mut decoder, false, None)
                .map_err(|e| format!("E_AI: {e}"))?;
            if !piece.is_empty() {
                text.push_str(&piece);
                emit(&piece);
            }
            produced += 1;
            if produced >= max_tokens {
                cut_off = true;
                break;
            }
            batch.clear();
            batch
                .add(token, pos, &[0], true)
                .map_err(|e| format!("E_AI: {e}"))?;
            ctx.decode(&mut batch).map_err(|e| format!("E_AI: {e}"))?;
            pos += 1;
        }
        Ok(Generated {
            text,
            cut_off,
            tokens: produced,
            ms: started.elapsed().as_millis() as u64,
        })
    }
}

/// What the engine thread is asked: an answer, or a count of tokens.
enum Work {
    Generate {
        request: GenerateRequest,
        cancel: Arc<AtomicBool>,
        token: Box<dyn Fn(&str) + Send>,
        reply: mpsc::Sender<Result<Generated, String>>,
    },
    Count {
        text: String,
        reply: mpsc::Sender<Result<usize, String>>,
    },
}

/// One piece of work for the engine thread, and the model file it is for.
struct Job {
    path: PathBuf,
    work: Work,
}

/// The engine thread: loads the model named by the first job — and again
/// only when a job names another file — and does one job at a time.
fn engine_thread(jobs: mpsc::Receiver<Job>) {
    let mut engine: Option<Engine> = None;
    for job in jobs {
        if engine.as_ref().is_none_or(|e| e.path() != job.path) {
            engine = None;
            match Engine::load(&job.path) {
                Ok(loaded) => engine = Some(loaded),
                Err(e) => {
                    match job.work {
                        Work::Generate { reply, .. } => drop(reply.send(Err(e))),
                        Work::Count { reply, .. } => drop(reply.send(Err(e))),
                    }
                    continue;
                }
            }
        }
        let Some(loaded) = engine.as_ref() else {
            continue;
        };
        match job.work {
            Work::Generate {
                request,
                cancel,
                token,
                reply,
            } => {
                let result = loaded.generate(&request, &cancel, |piece| token(piece));
                let _ = reply.send(result);
            }
            Work::Count { text, reply } => {
                let _ = reply.send(loaded.count_tokens(&text));
            }
        }
    }
}

/// The channel to the engine thread, started on first use.
fn engine_sender(state: &AiState) -> mpsc::Sender<Job> {
    let mut engine = state.engine.lock().unwrap_or_else(|e| e.into_inner());
    engine
        .get_or_insert_with(|| {
            let (tx, rx) = mpsc::channel();
            std::thread::Builder::new()
                .name("warraq-ai".into())
                .spawn(move || engine_thread(rx))
                .expect("engine thread");
            tx
        })
        .clone()
}

/// The longest text one count is asked of: far more than a window holds.
const COUNT_LIMIT: usize = 400_000;

/// How many tokens `text` is for the model `model` — the interface measures
/// a document's text with it before cutting it to the window.
#[tauri::command]
pub async fn ai_count_tokens<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AiState>,
    model: String,
    text: String,
) -> Result<usize, String> {
    if text.len() > COUNT_LIMIT {
        return Err("E_TOO_LONG: too much text to count at once".to_string());
    }
    let spec = model_spec(&model)?;
    let path = models_dir(&app)?.join(&spec.file);
    if !is_verified(&path, spec) {
        return Err("E_MODEL_MISSING: the on-device model is not downloaded".to_string());
    }
    let (reply, answer) = mpsc::channel();
    engine_sender(&state)
        .send(Job {
            path,
            work: Work::Count { text, reply },
        })
        .map_err(|_| "E_AI: the engine has stopped".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        answer
            .recv()
            .unwrap_or_else(|_| Err("E_AI: the engine has stopped".to_string()))
    })
    .await
    .map_err(|e| format!("E_AI: {e}"))?
}

#[tauri::command]
pub async fn ai_generate<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AiState>,
    request: GenerateRequest,
) -> Result<Generated, String> {
    let spec = model_spec(&request.model)?;
    let path = models_dir(&app)?.join(&spec.file);
    if !is_verified(&path, spec) {
        return Err("E_MODEL_MISSING: the on-device model is not downloaded".to_string());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    state
        .requests
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(request.id.clone(), cancel.clone());
    let sender = engine_sender(&state);
    let (reply, answer) = mpsc::channel();
    let id = request.id.clone();
    let handle = app.clone();
    let event_id = id.clone();
    let job = Job {
        path,
        work: Work::Generate {
            request,
            cancel,
            token: Box::new(move |piece| {
                let _ = handle.emit(
                    TOKEN_EVENT,
                    TokenEvent {
                        id: event_id.clone(),
                        text: piece.to_string(),
                    },
                );
            }),
            reply,
        },
    };
    sender
        .send(job)
        .map_err(|_| "E_AI: the engine has stopped".to_string())?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        answer
            .recv()
            .unwrap_or_else(|_| Err("E_AI: the engine has stopped".to_string()))
    })
    .await
    .map_err(|e| format!("E_AI: {e}"))?;
    state
        .requests
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&id);
    result
}

#[tauri::command]
pub fn ai_cancel(state: State<'_, AiState>, id: String) {
    if let Some(flag) = state
        .requests
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&id)
    {
        flag.store(true, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_catalogue_names_both_models_with_their_checksums() {
        let list = catalogue();
        assert_eq!(list.models.len(), 2);
        for model in &list.models {
            assert_eq!(model.sha256.len(), 64, "{}", model.id);
            assert!(model.sha256.bytes().all(|b| b.is_ascii_hexdigit()));
            assert!(model.bytes > 100_000_000);
            assert!(model.url.starts_with("https://huggingface.co/Qwen/"));
            assert!(model.file.ends_with(".gguf"));
        }
        assert!(model_spec("qwen2.5-1.5b").is_ok());
        assert!(model_spec("gpt-4").is_err());
    }

    #[test]
    fn only_hugging_face_and_its_cdn_are_followed() {
        assert!(allowed_host("huggingface.co"));
        assert!(allowed_host("cdn-lfs.hf.co"));
        assert!(allowed_host("us.aws.cdn.hf.co"));
        assert!(!allowed_host("hf.co"));
        assert!(!allowed_host("evil-hf.co"));
        assert!(!allowed_host("huggingface.co.example.com"));
        assert!(!allowed_host("localhost"));
    }

    #[test]
    fn a_file_is_verified_by_its_size_and_the_digest_kept_beside_it() {
        let dir = std::env::temp_dir().join(format!("warraq-ai-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let spec = ModelSpec {
            id: "t".into(),
            name: "t".into(),
            file: "t.gguf".into(),
            url: String::new(),
            sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad".into(),
            bytes: 3,
        };
        let path = dir.join("t.gguf");
        std::fs::write(&path, b"abc").unwrap();
        assert!(!is_verified(&path, &spec), "no digest beside it");
        std::fs::write(path.with_extension("gguf.sha256"), &spec.sha256).unwrap();
        assert!(is_verified(&path, &spec));
        std::fs::write(&path, b"abcd").unwrap();
        assert!(!is_verified(&path, &spec), "wrong size");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_request_runs_in_the_window_it_names_inside_the_engines_bounds() {
        let request = |context_tokens| GenerateRequest {
            id: "t".into(),
            model: "t".into(),
            messages: Vec::new(),
            grammar: None,
            max_tokens: 16,
            context_tokens,
        };
        assert_eq!(context_for(&request(None)), DEFAULT_CONTEXT);
        assert_eq!(context_for(&request(Some(8192))), 8192);
        assert_eq!(context_for(&request(Some(1))), 2048);
        assert_eq!(context_for(&request(Some(u32::MAX))), MAX_CONTEXT);
        // The interface's own words: an older one that names no window still parses.
        let parsed: GenerateRequest = serde_json::from_str(
            r#"{"id":"1","model":"qwen2.5-0.5b","messages":[{"role":"user","content":"x"}],"maxTokens":8}"#,
        )
        .unwrap();
        assert_eq!(parsed.context_tokens, None);
        let named: GenerateRequest = serde_json::from_str(
            r#"{"id":"1","model":"qwen2.5-0.5b","messages":[],"grammar":null,"maxTokens":8,"contextTokens":8192}"#,
        )
        .unwrap();
        assert_eq!(context_for(&named), 8192);
    }

    /// The real model, once by hand: `WARRAQ_MODEL=path/to/model.gguf cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn the_real_model_answers_and_stops_when_asked() {
        let path = PathBuf::from(std::env::var("WARRAQ_MODEL").expect("WARRAQ_MODEL"));
        let engine = Engine::load(&path).unwrap();
        let request = GenerateRequest {
            id: "t".into(),
            model: "t".into(),
            messages: vec![Message {
                role: "user".into(),
                content: "Say hello in one word.".into(),
            }],
            grammar: None,
            max_tokens: 16,
            context_tokens: None,
        };
        let mut pieces = Vec::new();
        let done = engine
            .generate(&request, &AtomicBool::new(false), |p| {
                pieces.push(p.to_string())
            })
            .unwrap();
        assert!(!done.text.trim().is_empty());
        assert_eq!(pieces.concat(), done.text);
        let stopped = engine.generate(&request, &AtomicBool::new(true), |_| {});
        assert!(stopped.unwrap_err().starts_with("E_CANCELLED"));
        // The model's own count of a text, and its refusal of a request over the window it was given.
        assert!(engine.count_tokens("Say hello in one word.").unwrap() >= 5);
        let long = GenerateRequest {
            messages: vec![Message {
                role: "user".into(),
                content: "كلمة ".repeat(3000),
            }],
            context_tokens: Some(2048),
            ..request.clone()
        };
        let refused = engine.generate(&long, &AtomicBool::new(false), |_| {});
        assert!(refused.unwrap_err().starts_with("E_TOO_LONG"));
    }
}
