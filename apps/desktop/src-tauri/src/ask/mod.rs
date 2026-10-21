//! Ask ZOOD: hold a shortcut, say what you want in Arabic or English, let go.
//!
//! Everything runs on this computer, on the same llama.cpp engine as the AI
//! tool (`ai.rs`): a small model that hears turns the words into text, and
//! the model the person chose — one that also reads pictures, or the
//! lighter text one — decides what to do. No account, no key, no network.
//!
//! The moment the keys go down the microphone starts (`ear.rs`), a picture
//! of the screen under the pointer is taken when the chosen model can read
//! it (`eye.rs`), and the files selected in File Explorer or Finder are
//! noted; then the island shows — a small window at the top of that screen
//! (`packages/ui/src/ask/`), never focused, so what the person was working
//! in keeps the keyboard. When the keys come up the island asks for the
//! words (`ask_transcribe`), then for a decision (`ask_think`), and does
//! what was decided only through the commands below, each one narrow:
//! a quick tool on the selected files, a Library file opened, saved details
//! typed where the cursor is, a point on the screen shown. Nothing is kept
//! once the island is gone.
//!
//! A key tapped on its own (`tap.rs`) asks without speaking: tapped twice,
//! the window in front is read and a reply is drafted in the person's way
//! of writing and pasted where their cursor is (`hands.rs`), never sent;
//! tapped once, the island takes the keyboard for a typed request. Both
//! need only the model that decides: one that reads pictures sees the
//! window, a text one is given the window's words, read by the island.

pub mod ear;
pub mod eye;
pub mod hands;
pub mod tap;

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Runtime, State, WebviewUrl,
    WebviewWindowBuilder,
};
use tauri_plugin_fs::FsExt;

use crate::ai::{self, AiState, GenerateRequest, Generated, Media, Message, MEDIA_MARKER};
use crate::core_bridge::debug_log;

pub const LABEL: &str = "ask";
pub const POINT_LABEL: &str = "ask-point";
/// Hold to speak, unless Settings chose other keys.
pub const SHORTCUT: &str = "CommandOrControl+Shift+Space";
/// The keys went down: listening. Payload: [`Listening`].
pub const LISTEN_EVENT: &str = "ask://listen";
/// How loud the person is, 0..1, while listening.
pub const LEVEL_EVENT: &str = "ask://level";
/// The keys came up. Payload: [`Heard`].
pub const HEARD_EVENT: &str = "ask://heard";
/// The point to show. Payload: [`Point`].
pub const POINT_EVENT: &str = "ask://point";
/// The tap key was tapped. Payload: [`Tapped`].
pub const TAP_EVENT: &str = "ask://tap";
/// Shorter than this is a tap, not a question.
const SHORTEST: f32 = 0.4;
/// The island's width, in the window's own units.
const ISLAND_WIDTH: f64 = 460.0;
/// How long a point stays on the screen.
const POINT_STAYS: Duration = Duration::from_secs(8);
/// The most characters typed for one detail.
const MAX_TYPED: usize = 500;

/// What the moment of asking held, for this one question.
#[derive(Default)]
struct Moment {
    files: Option<Vec<PathBuf>>,
    screen: Option<eye::Screen>,
    sound: Option<ear::Sound>,
    /// The monitor the pointer was on, as Tauri places windows.
    monitor: Option<(PhysicalPosition<i32>, PhysicalSize<u32>, f64)>,
    front: focus::Front,
    /// The app and title of the window in front, for a tap.
    window: Option<(String, String)>,
    /// That window, sharp enough to read its words (RGB).
    sharp: Option<(u32, u32, Vec<u8>)>,
    /// The island has the keyboard, for a typed request.
    typing: bool,
}

#[derive(Default)]
pub struct AskState {
    moment: Mutex<Moment>,
    recording: Mutex<Option<ear::Recording>>,
    settings: Mutex<Settings>,
}

/// Ask ZOOD's settings, kept beside the app's data so a start in the
/// background (no interface) listens for the keys too.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Settings {
    pub enabled: bool,
    pub shortcut: String,
    /// The chosen model reads pictures and the person lets it see the screen.
    pub sees: bool,
    /// The tap key is watched: twice drafts a reply, once opens typing.
    #[serde(default)]
    pub taps: bool,
    /// `right-main` (right Ctrl, right Command), `right-alt` or `right-shift`.
    #[serde(default)]
    pub tap_key: String,
    /// One tap opens the typing box; off, only double taps count.
    #[serde(default = "yes")]
    pub tap_to_type: bool,
}

fn yes() -> bool {
    true
}

/// How Settings asks for the taps.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TapChoice {
    pub on: bool,
    #[serde(default)]
    pub key: String,
    #[serde(default = "yes")]
    pub to_type: bool,
}

const SETTINGS_FILE: &str = "ask.json";

fn settings_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    Some(app.path().app_data_dir().ok()?.join(SETTINGS_FILE))
}

/// At start: the keys go on if Ask ZOOD was on.
pub fn start<R: Runtime>(app: &AppHandle<R>) {
    let saved: Settings = settings_path(app)
        .and_then(|path| std::fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    if saved.enabled || saved.taps {
        let state = app.state::<AskState>();
        let taps = TapChoice {
            on: saved.taps,
            key: saved.tap_key.clone(),
            to_type: saved.tap_to_type,
        };
        if let Err(e) = ask_configure(
            app.clone(),
            state,
            saved.enabled,
            Some(saved.shortcut),
            saved.sees,
            Some(taps),
        ) {
            debug_log(format!("ask: {e}"));
        }
    }
}

/// Ask ZOOD's settings as the host holds them.
#[tauri::command]
pub fn ask_settings(state: State<'_, AskState>) -> Settings {
    let settings = state
        .settings
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    Settings {
        shortcut: if settings.shortcut.is_empty() {
            SHORTCUT.to_string()
        } else {
            settings.shortcut
        },
        tap_key: tap::TapKey::from_name(&settings.tap_key).name().to_string(),
        ..settings
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tapped {
    /// `draft` for a double tap, `type` for a single one.
    pub kind: &'static str,
    /// A picture of the window was taken.
    pub screen: bool,
    pub app: String,
    pub title: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listening {
    /// A picture of the screen was taken for the model.
    pub screen: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Heard {
    pub seconds: f32,
    /// Let go too soon to be a question.
    pub short: bool,
    /// Why nothing was heard, when the microphone failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub problem: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Point {
    /// Across and down the screen, 0..1.
    pub x: f64,
    pub y: f64,
    pub label: String,
}

/* ----------------------------------------------------------- shortcut */

/// From Settings and at start: speaking to Ask ZOOD on or off and its
/// keys, whether the chosen model is shown the screen, and the taps (left
/// as they were when not given). Keys the system will not take are an
/// error, and the ones before stay.
#[tauri::command]
pub fn ask_configure<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AskState>,
    enabled: bool,
    shortcut: Option<String>,
    sees: bool,
    taps: Option<TapChoice>,
) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let keys = shortcut
        .filter(|k| !k.trim().is_empty())
        .unwrap_or_else(|| SHORTCUT.to_string());
    let mut settings = state.settings.lock().unwrap_or_else(|e| e.into_inner());
    let taps = taps.unwrap_or_else(|| TapChoice {
        on: settings.taps,
        key: settings.tap_key.clone(),
        to_type: settings.tap_to_type,
    });
    let next = Settings {
        enabled,
        shortcut: keys.clone(),
        sees,
        taps: taps.on,
        tap_key: tap::TapKey::from_name(&taps.key).name().to_string(),
        tap_to_type: taps.to_type,
    };
    if *settings == next {
        return Ok(());
    }
    let handle = app.clone();
    tap::configure(
        next.taps,
        tap::TapKey::from_name(&next.tap_key),
        next.tap_to_type,
        move |tap| {
            let app = handle.clone();
            std::thread::spawn(move || tapped(&app, tap));
        },
    );
    let shortcuts = app.global_shortcut();
    if settings.enabled && (!enabled || settings.shortcut != keys) {
        let _ = shortcuts.unregister(settings.shortcut.as_str());
    }
    if enabled && (!settings.enabled || settings.shortcut != keys) {
        if let Err(e) = listen(&app, &keys) {
            // The keys before go back on, if there were any.
            if settings.enabled {
                let _ = listen(&app, &settings.shortcut);
            }
            return Err(format!("E_SHORTCUT: {e}"));
        }
    }
    if let Some(path) = settings_path(&app) {
        if let Ok(bytes) = serde_json::to_vec_pretty(&next) {
            let _ = std::fs::create_dir_all(path.parent().unwrap_or(&path));
            let _ = std::fs::write(path, bytes);
        }
    }
    *settings = next;
    Ok(())
}

fn listen<R: Runtime>(app: &AppHandle<R>, keys: &str) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
    app.global_shortcut()
        .on_shortcut(keys, |app, _, event| {
            let app = app.clone();
            match event.state {
                ShortcutState::Pressed => {
                    std::thread::spawn(move || pressed(&app));
                }
                ShortcutState::Released => {
                    std::thread::spawn(move || released(&app));
                }
            }
        })
        .map_err(|e| e.to_string())
}

/// The keys went down: listen, look, note the files, show the island.
fn pressed<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<AskState>();
    // The picture goes to a model that sees; the window's words are read
    // for a text model when the person let the taps read the window.
    let (sees, reads) = state
        .settings
        .lock()
        .map(|s| (s.enabled && s.sees, s.enabled && s.taps))
        .unwrap_or((false, false));
    {
        let mut recording = state.recording.lock().unwrap_or_else(|e| e.into_inner());
        if recording.is_some() {
            return; // The keys repeating while held.
        }
        // Whatever is in front now gets the keyboard back for typing.
        let front = focus::remember();
        let handle = app.clone();
        let started = ear::start(move |level| {
            let _ = handle.emit_to(LABEL, LEVEL_EVENT, level);
        });
        let mut moment = state.moment.lock().unwrap_or_else(|e| e.into_inner());
        *moment = Moment {
            front,
            monitor: monitor_at_pointer(app),
            ..Moment::default()
        };
        match started {
            Ok(listening) => *recording = Some(listening),
            Err(e) => debug_log(format!("ask: {e}")),
        }
    }
    hide_point(app);
    // The window in front before the island is on it.
    let shot = if sees || reads {
        eye::capture_front()
            .map_err(|e| debug_log(format!("ask: {e}")))
            .ok()
    } else {
        None
    };
    let looked = sees && shot.is_some();
    if let (Ok(mut moment), Some(shot)) = (state.moment.lock(), shot) {
        moment.window = Some((shot.app, shot.title));
        moment.sharp = Some(shot.sharp);
        if sees {
            moment.screen = Some(shot.screen);
        }
    }
    show_island(app);
    let _ = app.emit_to(LABEL, LISTEN_EVENT, Listening { screen: looked });
    // Reading Explorer's selection takes a moment; the island is up already.
    let files = crate::ring::selected_files();
    if let Ok(mut moment) = state.moment.lock() {
        moment.files = Some(files);
    };
}

/// The tap key was tapped: the window in front is looked at, and the island
/// shows — to draft a reply, or, with the keyboard, to take a typed request.
fn tapped<R: Runtime>(app: &AppHandle<R>, tap: tap::Tap) {
    let state = app.state::<AskState>();
    if state.recording.lock().map(|r| r.is_some()).unwrap_or(false) {
        return; // Speaking already.
    }
    let typing = tap == tap::Tap::Once;
    // A tap while the island is up and has the keyboard is the person
    // reaching for their own app again: the window in front is the island.
    if state.moment.lock().map(|m| m.typing).unwrap_or(false) {
        return;
    }
    hide_point(app);
    let front = focus::remember();
    let monitor = monitor_at_pointer(app);
    let shot = eye::capture_front()
        .map_err(|e| debug_log(format!("ask: {e}")))
        .ok();
    let looked = shot.is_some();
    let (app_name, title) = shot
        .as_ref()
        .map(|s| (s.app.clone(), s.title.clone()))
        .unwrap_or_default();
    if let Ok(mut moment) = state.moment.lock() {
        *moment = Moment {
            front,
            monitor,
            window: shot.as_ref().map(|s| (s.app.clone(), s.title.clone())),
            sharp: shot.as_ref().map(|s| s.sharp.clone()),
            screen: shot.map(|s| s.screen),
            typing,
            ..Moment::default()
        };
    }
    show_island(app);
    if typing {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(window) = handle.get_webview_window(LABEL) {
                let _ = window.set_focusable(true);
                let _ = window.set_focus();
            }
        });
    }
    let _ = app.emit_to(
        LABEL,
        TAP_EVENT,
        Tapped {
            kind: if typing { "type" } else { "draft" },
            screen: looked,
            app: app_name,
            title,
        },
    );
    if typing {
        let files = crate::ring::selected_files();
        if let Ok(mut moment) = state.moment.lock() {
            moment.files = Some(files);
        }
    }
}

/// The keys came up: what was heard waits for `ask_transcribe`.
fn released<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<AskState>();
    let recording = state
        .recording
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take();
    let heard = match recording.map(ear::Recording::finish) {
        Some(Ok(sound)) => {
            let seconds = sound.seconds();
            if let Ok(mut moment) = state.moment.lock() {
                moment.sound = Some(sound);
            }
            Heard {
                seconds,
                short: seconds < SHORTEST,
                problem: None,
            }
        }
        Some(Err(e)) => Heard {
            seconds: 0.0,
            short: false,
            problem: Some(e),
        },
        None => Heard {
            seconds: 0.0,
            short: false,
            problem: Some("E_MIC: the microphone did not start".into()),
        },
    };
    let _ = app.emit_to(LABEL, HEARD_EVENT, heard);
}

/* ------------------------------------------------------------- windows */

fn monitor_at_pointer<R: Runtime>(
    app: &AppHandle<R>,
) -> Option<(PhysicalPosition<i32>, PhysicalSize<u32>, f64)> {
    let at = app.cursor_position().ok()?;
    let monitor = app
        .monitor_from_point(at.x, at.y)
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten())?;
    Some((*monitor.position(), *monitor.size(), monitor.scale_factor()))
}

fn show_island<R: Runtime>(app: &AppHandle<R>) {
    let place = app
        .state::<AskState>()
        .moment
        .lock()
        .ok()
        .and_then(|m| m.monitor);
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let window = match handle.get_webview_window(LABEL) {
            Some(window) => window,
            None => match WebviewWindowBuilder::new(
                &handle,
                LABEL,
                WebviewUrl::App("index.html?ask=1".into()),
            )
            .title("Ask ZOOD")
            .inner_size(ISLAND_WIDTH, 120.0)
            .decorations(false)
            .resizable(false)
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(false)
            .focusable(false)
            .visible(false)
            .transparent(true)
            .build()
            {
                Ok(window) => window,
                Err(e) => {
                    debug_log(format!("ask: cannot make the island: {e}"));
                    return;
                }
            },
        };
        if let Some((position, size, scale)) = place {
            let width = (ISLAND_WIDTH * scale).round() as i32;
            let x = position.x + (size.width as i32 - width) / 2;
            let y = position.y + (24.0 * scale).round() as i32;
            let _ = window.set_position(PhysicalPosition::new(x, y));
        }
        let _ = window.show();
    });
}

/// The island's height follows what it shows, so the space below it stays
/// the person's to click.
#[tauri::command]
pub fn ask_resize<R: Runtime>(app: AppHandle<R>, height: f64) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let height = if height.is_finite() {
            height.clamp(60.0, 640.0)
        } else {
            120.0
        };
        let _ = window.set_size(tauri::LogicalSize::new(ISLAND_WIDTH, height));
    }
}

/// The island goes, with the point, and the moment is forgotten. When it
/// had the keyboard, the app before it gets the keyboard back.
#[tauri::command]
pub fn ask_hide<R: Runtime>(app: AppHandle<R>, state: State<'_, AskState>) {
    let front = state
        .moment
        .lock()
        .map(|mut moment| std::mem::take(&mut *moment))
        .ok()
        .filter(|moment| moment.typing)
        .map(|moment| moment.front);
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.hide();
        if front.is_some() {
            let _ = window.set_focusable(false);
        }
    }
    if let Some(front) = front {
        focus::restore(&front);
    }
}

/// The island gives the keyboard back to the app in front before, and
/// stays — to show what is being done there.
fn let_go<R: Runtime>(app: &AppHandle<R>, state: &AskState) -> focus::Front {
    let front = state
        .moment
        .lock()
        .map(|mut moment| {
            let was = std::mem::take(&mut moment.typing);
            (moment.front.clone(), was)
        })
        .unwrap_or_default();
    if front.1 {
        if let Some(window) = app.get_webview_window(LABEL) {
            let _ = window.set_focusable(false);
        }
    }
    front.0
}

fn hide_point<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = handle.get_webview_window(POINT_LABEL) {
            let _ = window.hide();
        }
    });
}

/// Shows where to click next: a ring on the screen the question was asked
/// on, at `x`, `y` in thousandths of it, as the model answered. The window
/// covers that screen, lets every click through, and goes by itself.
#[tauri::command]
pub fn ask_point<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AskState>,
    x: f64,
    y: f64,
    label: String,
) -> Result<(), String> {
    let (place, areas) = state
        .moment
        .lock()
        .ok()
        .and_then(|m| {
            let areas = m
                .screen
                .as_ref()
                .and_then(|s| s.window.map(|w| (w, s.monitor)));
            m.monitor.map(|place| (place, areas))
        })
        .ok_or_else(|| "E_ASK: there is no screen to point at".to_string())?;
    let (fx, fy) = eye::fraction(x, y);
    // The picture was of a window: the point is placed on its screen.
    let (fx, fy) = match areas {
        Some((window, monitor)) => eye::on_monitor(fx, fy, window, monitor),
        None => (fx, fy),
    };
    let point = Point {
        x: fx,
        y: fy,
        label: label.chars().take(80).collect(),
    };
    if let Ok(mut last) = LAST_POINT.lock() {
        *last = Some(point.clone());
    }
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let window = match handle.get_webview_window(POINT_LABEL) {
            Some(window) => window,
            None => match WebviewWindowBuilder::new(
                &handle,
                POINT_LABEL,
                WebviewUrl::App("index.html?askpoint=1".into()),
            )
            .title("ZOOD PDF")
            .decorations(false)
            .resizable(false)
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(false)
            .focusable(false)
            .visible(false)
            .transparent(true)
            .build()
            {
                Ok(window) => window,
                Err(e) => {
                    debug_log(format!("ask: cannot make the pointer: {e}"));
                    return;
                }
            },
        };
        let (position, size, _) = place;
        let _ = window.set_position(position);
        let _ = window.set_size(size);
        let _ = window.set_ignore_cursor_events(true);
        let _ = window.show();
        let _ = window.emit_to(POINT_LABEL, POINT_EVENT, point);
    })
    .map_err(|e| format!("E_ASK: {e}"))?;
    let later = app.clone();
    let turn = POINT_TURN.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
    std::thread::spawn(move || {
        std::thread::sleep(POINT_STAYS);
        if POINT_TURN.load(std::sync::atomic::Ordering::Relaxed) == turn {
            hide_point(&later);
        }
    });
    Ok(())
}

static LAST_POINT: Mutex<Option<Point>> = Mutex::new(None);
static POINT_TURN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// The point, for the pointer's view when it first loads.
#[tauri::command]
pub fn ask_point_last() -> Option<Point> {
    LAST_POINT.lock().ok()?.take()
}

/* -------------------------------------------------------------- models */

/// What the person said, as text: the recording read by a model that hears.
#[tauri::command]
pub async fn ask_transcribe<R: Runtime>(
    app: AppHandle<R>,
    ai_state: State<'_, AiState>,
    state: State<'_, AskState>,
    id: String,
    model: String,
) -> Result<String, String> {
    if !ai::model_spec(&model)?.hears {
        return Err("E_ARGS: that model does not hear".to_string());
    }
    let sound = state
        .moment
        .lock()
        .ok()
        .and_then(|m| m.sound.clone())
        .ok_or_else(|| "E_ASK: nothing was heard".to_string())?;
    let request = GenerateRequest {
        id,
        model,
        messages: vec![Message {
            role: "user".into(),
            content: MEDIA_MARKER.into(),
        }],
        grammar: None,
        max_tokens: 400,
        context_tokens: Some(4096),
        media: vec![Media::Sound {
            rate: sound.rate,
            samples: sound.samples,
        }],
    };
    let heard = ai::run(&app, &ai_state, request).await?;
    Ok(clean_transcript(&heard.text))
}

/// A model's request from the island, as `ai_generate` takes it, and
/// whether the picture of the screen goes with it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThinkRequest {
    #[serde(flatten)]
    pub request: GenerateRequest,
    #[serde(default)]
    pub screen: bool,
}

/// The chosen model's decision. With `screen`, the picture taken when the
/// keys went down goes before the person's words — the host puts it there,
/// never the interface.
#[tauri::command]
pub async fn ask_think<R: Runtime>(
    app: AppHandle<R>,
    ai_state: State<'_, AiState>,
    state: State<'_, AskState>,
    request: ThinkRequest,
) -> Result<Generated, String> {
    let ThinkRequest {
        mut request,
        screen,
    } = request;
    // No text of the island's may smuggle in a marker of its own.
    for message in &mut request.messages {
        message.content = message.content.replace(MEDIA_MARKER, "");
    }
    request.media.clear();
    if screen {
        let picture = state
            .moment
            .lock()
            .ok()
            .and_then(|m| m.screen.clone())
            .ok_or_else(|| "E_ASK: no picture of the screen was taken".to_string())?;
        if !ai::model_spec(&request.model)?.sees {
            return Err("E_ARGS: that model does not see".to_string());
        }
        let last = request
            .messages
            .iter_mut()
            .rev()
            .find(|m| m.role == "user")
            .ok_or_else(|| "E_ARGS: nothing to ask".to_string())?;
        last.content = format!("{MEDIA_MARKER}\n{}", last.content);
        request.media.push(Media::Picture {
            width: picture.width,
            height: picture.height,
            rgb: picture.rgb,
        });
    }
    ai::run(&app, &ai_state, request).await
}

/// Qwen's speech models answer `language Arabic<asr_text>…`: the words only.
pub fn clean_transcript(raw: &str) -> String {
    let words = match raw.find("<asr_text>") {
        Some(at) => &raw[at + "<asr_text>".len()..],
        None => raw.strip_prefix("language ").map_or(raw, |rest| {
            rest.split_once(char::is_whitespace)
                .map_or("", |(_, words)| words)
        }),
    };
    words
        .replace("</asr_text>", "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/* ------------------------------------------------------------- actions */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MomentView {
    /// The names of the files selected when the keys went down.
    pub files: Vec<String>,
    pub screen: bool,
    /// The app and title of the window in front, after a tap.
    pub app: String,
    pub title: String,
    /// Its picture can be read for words (`ask_window_png`).
    pub readable: bool,
}

/// What the island may tell the model about the moment.
#[tauri::command]
pub fn ask_moment(state: State<'_, AskState>) -> MomentView {
    let moment = state.moment.lock().unwrap_or_else(|e| e.into_inner());
    MomentView {
        files: moment
            .files
            .iter()
            .flatten()
            .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
            .collect(),
        screen: moment.screen.is_some(),
        app: moment
            .window
            .as_ref()
            .map(|w| w.0.clone())
            .unwrap_or_default(),
        title: moment
            .window
            .as_ref()
            .map(|w| w.1.chars().take(200).collect())
            .unwrap_or_default(),
        readable: moment.sharp.is_some(),
    }
}

/// The window in front at the tap, as a PNG, for the island to read its
/// words with the app's own recogniser when the model reads text only.
#[tauri::command]
pub fn ask_window_png(state: State<'_, AskState>) -> Result<tauri::ipc::Response, String> {
    let moment = state.moment.lock().map_err(|e| e.to_string())?;
    let (width, height, rgb) = moment
        .sharp
        .as_ref()
        .ok_or_else(|| "E_ASK: no picture of the window was taken".to_string())?;
    let png = eye::png_of(*width, *height, rgb)
        .ok_or_else(|| "E_ASK: the picture could not be made".to_string())?;
    Ok(tauri::ipc::Response::new(png))
}

/// Puts an answer on the clipboard, for the island's Copy (the island never
/// has the focus a web page needs to write the clipboard itself).
#[tauri::command]
pub fn ask_copy(text: String) -> Result<(), String> {
    let text: String = text.chars().take(hands::MAX_DRAFT).collect();
    if crate::remote::clip::write(&crate::remote::clip::Clip::Text(text)) {
        Ok(())
    } else {
        Err("E_ASK: the clipboard could not be written".to_string())
    }
}

/// Puts a draft where the person's cursor is, in the app that was in front
/// at the tap: pasted, with their clipboard put back after, never sent.
#[tauri::command]
pub async fn ask_paste<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AskState>,
    text: String,
) -> Result<(), String> {
    if !crate::remote::input::AVAILABLE {
        return Err("E_ASK: pasting is on Windows and macOS".to_string());
    }
    let text = hands::clean(&text);
    if text.is_empty() {
        return Err("E_ASK: there is nothing to paste".to_string());
    }
    let front = let_go(&app, &state);
    tauri::async_runtime::spawn_blocking(move || {
        focus::restore(&front);
        std::thread::sleep(Duration::from_millis(220));
        hands::paste(&text)
    })
    .await
    .map_err(|e| format!("E_ASK: {e}"))?
}

/// Runs a quick tool on the files selected when the keys went down: the
/// same as letting them go on that tool of the ring.
#[tauri::command]
pub fn ask_run_tool<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AskState>,
    tool: String,
) -> Result<usize, String> {
    let tool = crate::quick::TOOLS
        .iter()
        .find(|t| **t == tool)
        .ok_or_else(|| format!("E_ARGS: there is no tool called {tool:?}"))?;
    let files = state
        .moment
        .lock()
        .ok()
        .and_then(|m| m.files.clone())
        .unwrap_or_default();
    if files.is_empty() {
        return Err("E_ASK: no files were selected".to_string());
    }
    let count = files.len();
    ask_hide(app.clone(), state);
    crate::quick::request(
        &app,
        crate::quick::QuickRequest {
            tool: Some(tool.to_string()),
            files,
        },
    );
    Ok(count)
}

/// Opens a Library file the island found, in the editor. Only a file the
/// app may already read (a folder the person added to the Library).
#[tauri::command]
pub fn ask_open<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AskState>,
    path: String,
) -> Result<(), String> {
    let file = PathBuf::from(&path);
    let scope = app.fs_scope();
    crate::library::check_readable(&file, |p| scope.is_allowed(p))?;
    if !file.is_file() {
        return Err(format!("E_IO: not a file: {path}"));
    }
    ask_hide(app.clone(), state);
    crate::open_in_editor_at(&app, Some(file), None);
    Ok(())
}

/// Types the person's saved details where their cursor is — in whatever
/// app was in front when the keys went down — with Tab between them, as if
/// typed by hand. The island confirmed them with the person first.
#[tauri::command]
pub fn ask_type<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AskState>,
    parts: Vec<String>,
) -> Result<(), String> {
    use crate::remote::input::{perform, Act, Named};
    if !crate::remote::input::AVAILABLE {
        return Err("E_ASK: typing is on Windows and macOS".to_string());
    }
    let parts: Vec<String> = parts
        .into_iter()
        .take(20)
        .map(|part| {
            part.chars()
                .filter(|c| !c.is_control())
                .take(MAX_TYPED)
                .collect()
        })
        .collect();
    let front = let_go(&app, &state);
    ask_hide(app.clone(), state);
    std::thread::spawn(move || {
        focus::restore(&front);
        std::thread::sleep(Duration::from_millis(200));
        for (i, part) in parts.into_iter().enumerate() {
            if i > 0 {
                perform(Act::Key(Named::Tab));
            }
            if !part.is_empty() {
                perform(Act::Text(part));
            }
        }
    });
    Ok(())
}

/// Undoes the draft just pasted, in the app it went to, so Write it again
/// replaces it rather than adding a second one.
#[tauri::command]
pub async fn ask_undo<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AskState>,
) -> Result<(), String> {
    let front = let_go(&app, &state);
    tauri::async_runtime::spawn_blocking(move || {
        focus::restore(&front);
        std::thread::sleep(Duration::from_millis(150));
        hands::undo()
    })
    .await
    .map_err(|e| format!("E_ASK: {e}"))?
}

/* --------------------------------------------------------------- focus */

/// The app in front when the keys went down, given the keyboard back
/// before anything is typed into it.
mod focus {
    #[derive(Clone, Debug, Default)]
    pub struct Front {
        #[allow(dead_code)]
        handle: isize,
    }

    #[cfg(target_os = "windows")]
    pub fn remember() -> Front {
        // SAFETY: no arguments; returns a handle or null.
        let handle =
            unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow() as isize };
        Front { handle }
    }

    #[cfg(target_os = "windows")]
    pub fn restore(front: &Front) {
        if front.handle != 0 {
            // SAFETY: a window handle read from the system; a stale one is refused by it.
            unsafe {
                windows_sys::Win32::UI::WindowsAndMessaging::SetForegroundWindow(front.handle as _);
            }
        }
    }

    /// The process id of the app in front.
    #[cfg(target_os = "macos")]
    pub fn remember() -> Front {
        use objc2::rc::Retained;
        use objc2::runtime::AnyObject;
        use objc2::{class, msg_send};
        // SAFETY: NSWorkspace's documented class message and properties; nil-checked.
        let pid: i32 = unsafe {
            let workspace: Retained<AnyObject> = msg_send![class!(NSWorkspace), sharedWorkspace];
            let app: Option<Retained<AnyObject>> = msg_send![&*workspace, frontmostApplication];
            match app {
                Some(app) => msg_send![&*app, processIdentifier],
                None => 0,
            }
        };
        Front {
            handle: pid as isize,
        }
    }

    #[cfg(target_os = "macos")]
    pub fn restore(front: &Front) {
        use objc2::rc::Retained;
        use objc2::runtime::AnyObject;
        use objc2::{class, msg_send};
        if front.handle <= 0 {
            return;
        }
        // SAFETY: NSRunningApplication's documented class message; nil-checked.
        unsafe {
            let app: Option<Retained<AnyObject>> = msg_send![
                class!(NSRunningApplication),
                runningApplicationWithProcessIdentifier: front.handle as i32
            ];
            if let Some(app) = app {
                let _: bool = msg_send![&*app, activateWithOptions: 0usize];
            }
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    pub fn remember() -> Front {
        Front::default()
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    pub fn restore(_front: &Front) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_words_are_kept_and_the_speech_models_labels_dropped() {
        assert_eq!(
            clean_transcript("language Arabic<asr_text>ضغط هذا الملف"),
            "ضغط هذا الملف"
        );
        assert_eq!(
            clean_transcript("language English<asr_text> compress   this\nfile </asr_text>"),
            "compress this file"
        );
        assert_eq!(
            clean_transcript("language English find the contract"),
            "find the contract"
        );
        assert_eq!(clean_transcript("  open settings "), "open settings");
        assert_eq!(clean_transcript("language None<asr_text>"), "");
    }

    #[test]
    fn a_question_from_the_island_reads_as_the_engine_takes_it() {
        let parsed: ThinkRequest = serde_json::from_str(
            r#"{"id":"a1","model":"qwen2.5-1.5b","messages":[{"role":"user","content":"hi"}],
                "grammar":"root ::= \"x\"","maxTokens":64,"contextTokens":4096,"screen":true}"#,
        )
        .unwrap();
        assert!(parsed.screen);
        assert_eq!(parsed.request.max_tokens, 64);
        assert!(parsed.request.media.is_empty());
        let plain: ThinkRequest = serde_json::from_str(
            r#"{"id":"a1","model":"qwen2.5-1.5b","messages":[],"maxTokens":8}"#,
        )
        .unwrap();
        assert!(!plain.screen);
    }
}
