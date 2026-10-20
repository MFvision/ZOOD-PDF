//! Read aloud with the system's own speech engine, not the webview's.
//!
//! A webview's Web Speech hands an app only some of the system's voices —
//! WebKit leaves out the Enhanced and Premium voices a Mac has downloaded,
//! so pages were read in the small default voice — and it says nothing of a
//! voice's quality. On a Mac the host speaks through AVSpeechSynthesizer
//! instead: every installed voice, each with its quality, the best one
//! chosen first (`packages/ui/src/speech/readAloud.ts` asks `speech_engine`
//! and uses these commands when the answer is not `web`). Siri's own voices
//! are not offered to any app by the system; Premium voices are the nearest.
//!
//! Elsewhere `speech_engine` answers `web` and the interface keeps Web
//! Speech. Nothing here reaches the network.

use serde::Serialize;

/// One installed voice, as the interface lists it.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Voice {
    /// The engine's own identifier for the voice, stable across runs.
    pub id: String,
    pub name: String,
    /// BCP 47, as the engine reports it ("ar-001", "en-US").
    pub lang: String,
    /// `premium`, `enhanced` or `standard`.
    pub quality: &'static str,
}

/// Which engine reads aloud in this build: `apple` (AVSpeechSynthesizer on a
/// Mac) or `web` (the webview's Web Speech).
#[tauri::command]
pub fn speech_engine() -> &'static str {
    if cfg!(target_os = "macos") {
        "apple"
    } else {
        "web"
    }
}

/// The installed voices, without the novelty ones (Bells, Bubbles…).
#[tauri::command(async)]
pub fn speech_voices() -> Vec<Voice> {
    #[cfg(target_os = "macos")]
    {
        apple::voices()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Vec::new()
    }
}

/// Reads `text` in `voice` (an id from `speech_voices`; the system's voice
/// for `lang` when it is none or no longer installed) at `rate`, the
/// interface's speed (1 is normal, 0.5 to 2). Resolves `done` when the text
/// has been read, `cancelled` when `speech_stop` or another text cut it off.
#[tauri::command]
pub async fn speech_speak<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    text: String,
    voice: Option<String>,
    lang: String,
    rate: f32,
) -> Result<&'static str, String> {
    // A sentence at a time is what the interface sends; this only bounds a
    // runaway call.
    let text: String = text.chars().take(20_000).collect();
    #[cfg(target_os = "macos")]
    {
        apple::speak(&app, text, voice, lang, apple_rate(rate)).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, text, voice, lang, rate);
        Err("E_SPEECH: this build reads aloud through the webview".into())
    }
}

/// Stops reading at once.
#[tauri::command]
pub fn speech_stop<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    #[cfg(target_os = "macos")]
    apple::control(&app, apple::Control::Stop);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// Pauses at the end of the word being read.
#[tauri::command]
pub fn speech_pause<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    #[cfg(target_os = "macos")]
    apple::control(&app, apple::Control::Pause);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// Goes on from where `speech_pause` stopped.
#[tauri::command]
pub fn speech_resume<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    #[cfg(target_os = "macos")]
    apple::control(&app, apple::Control::Resume);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// Opens the system's settings where more voices are downloaded: Spoken
/// Content on a Mac (its Manage Voices list has the Enhanced and Premium
/// ones), Speech on Windows.
#[tauri::command]
pub fn speech_open_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let (program, args): (&str, &[&str]) = (
        "/usr/bin/open",
        &["x-apple.systempreferences:com.apple.preference.universalaccess?SpokenContent"],
    );
    #[cfg(target_os = "windows")]
    let (program, args): (&str, &[&str]) = ("explorer.exe", &["ms-settings:speech"]);
    #[cfg(all(unix, not(target_os = "macos")))]
    return Err("E_SPEECH: no speech settings to open on this system".into());
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let mut child = std::process::Command::new(program)
            .args(args)
            .spawn()
            .map_err(|e| format!("E_SPEECH: {e}"))?;
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        Ok(())
    }
}

/// The interface's speed (1 normal, 0.5 to 2) as AVSpeechUtterance's rate,
/// whose normal is 0.5 on a scale of 0 to 1 that speeds up steeply past
/// about 0.75: half speed is 0.35, double speed 0.75.
pub fn apple_rate(rate: f32) -> f32 {
    let rate = if rate.is_finite() { rate.clamp(0.5, 2.0) } else { 1.0 };
    if rate >= 1.0 {
        0.5 + (rate - 1.0) * 0.25
    } else {
        0.5 - (1.0 - rate) * 0.3
    }
}

/// `premium`, `enhanced` or `standard`, from AVSpeechSynthesisVoiceQuality.
pub fn quality_name(quality: isize) -> &'static str {
    match quality {
        3 => "premium",
        2 => "enhanced",
        _ => "standard",
    }
}

#[cfg(target_os = "macos")]
mod apple {
    use std::cell::RefCell;
    use std::sync::Mutex;

    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, NSObject};
    use objc2::{class, define_class, msg_send, sel, AllocAnyThread};
    use objc2_foundation::NSString;
    use tokio::sync::oneshot;

    use super::{quality_name, Voice};

    // AVSpeechSynthesizer and its voices live in AVFAudio, which AVFoundation
    // re-exports.
    #[link(name = "AVFoundation", kind = "framework")]
    extern "C" {}

    /// The utterance being read (its address) and who waits for its end.
    static PENDING: Mutex<Option<(usize, oneshot::Sender<&'static str>)>> = Mutex::new(None);

    thread_local! {
        /// The synthesizer and its delegate, made once on the main thread
        /// and used only there. The synthesizer holds its delegate weakly,
        /// so both are kept here.
        static SYNTH: RefCell<Option<(Retained<AnyObject>, Retained<SpeechDelegate>)>> = const { RefCell::new(None) };
    }

    /// Ends the wait on `utterance`, if it is the one being read.
    fn ended(utterance: *const AnyObject, how: &'static str) {
        let mut pending = PENDING.lock().unwrap_or_else(|e| e.into_inner());
        if pending.as_ref().is_some_and(|(id, _)| *id == utterance as usize) {
            if let Some((_, sender)) = pending.take() {
                let _ = sender.send(how);
            }
        }
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "WarraqSpeechDelegate"]
        struct SpeechDelegate;

        impl SpeechDelegate {
            #[unsafe(method(speechSynthesizer:didFinishSpeechUtterance:))]
            fn did_finish(&self, _synthesizer: &AnyObject, utterance: &AnyObject) {
                ended(utterance, "done");
            }

            #[unsafe(method(speechSynthesizer:didCancelSpeechUtterance:))]
            fn did_cancel(&self, _synthesizer: &AnyObject, utterance: &AnyObject) {
                ended(utterance, "cancelled");
            }
        }
    );

    /// The synthesizer, made on first use. Main thread only.
    fn synthesizer() -> Retained<AnyObject> {
        SYNTH.with(|cell| {
            let mut slot = cell.borrow_mut();
            if let Some((synth, _)) = slot.as_ref() {
                return synth.clone();
            }
            // SAFETY: AVSpeechSynthesizer's documented initialiser and
            // delegate setter; both objects are kept in SYNTH for the app's life.
            unsafe {
                let synth: Retained<AnyObject> = msg_send![class!(AVSpeechSynthesizer), new];
                let delegate: Retained<SpeechDelegate> = msg_send![SpeechDelegate::alloc(), init];
                let _: () = msg_send![&*synth, setDelegate: &*delegate];
                *slot = Some((synth.clone(), delegate));
                synth
            }
        })
    }

    fn text(value: Option<Retained<NSString>>) -> String {
        value.map(|s| s.to_string()).unwrap_or_default()
    }

    pub fn voices() -> Vec<Voice> {
        let mut out = Vec::new();
        // SAFETY: AVSpeechSynthesisVoice's documented class method and
        // properties; `voiceTraits` is asked only where it exists (macOS 14).
        unsafe {
            let all: Retained<AnyObject> = msg_send![class!(AVSpeechSynthesisVoice), speechVoices];
            let count: usize = msg_send![&*all, count];
            for index in 0..count.min(2000) {
                let voice: Retained<AnyObject> = msg_send![&*all, objectAtIndex: index];
                let has_traits: bool = msg_send![&*voice, respondsToSelector: sel!(voiceTraits)];
                if has_traits {
                    let traits: usize = msg_send![&*voice, voiceTraits];
                    // AVSpeechSynthesisVoiceTraitIsNoveltyVoice
                    if traits & 1 != 0 {
                        continue;
                    }
                }
                let quality: isize = msg_send![&*voice, quality];
                out.push(Voice {
                    id: text(msg_send![&*voice, identifier]),
                    name: text(msg_send![&*voice, name]),
                    lang: text(msg_send![&*voice, language]),
                    quality: quality_name(quality),
                });
            }
        }
        out
    }

    pub async fn speak<R: tauri::Runtime>(
        app: &tauri::AppHandle<R>,
        text: String,
        voice: Option<String>,
        lang: String,
        rate: f32,
    ) -> Result<&'static str, String> {
        let (sender, receiver) = oneshot::channel();
        app.run_on_main_thread(move || {
            let synth = synthesizer();
            // SAFETY: AVSpeechUtterance's and AVSpeechSynthesisVoice's
            // documented constructors and setters, on the main thread the
            // synthesizer was made on.
            unsafe {
                let utterance: Retained<AnyObject> =
                    msg_send![class!(AVSpeechUtterance), speechUtteranceWithString: &*NSString::from_str(&text)];
                let chosen: Option<Retained<AnyObject>> = match voice {
                    Some(id) => msg_send![class!(AVSpeechSynthesisVoice), voiceWithIdentifier: &*NSString::from_str(&id)],
                    None => None,
                };
                let chosen = match chosen {
                    Some(found) => Some(found),
                    None => msg_send![class!(AVSpeechSynthesisVoice), voiceWithLanguage: &*NSString::from_str(&lang)],
                };
                if let Some(chosen) = chosen {
                    let _: () = msg_send![&*utterance, setVoice: &*chosen];
                }
                let _: () = msg_send![&*utterance, setRate: rate];
                // Whoever waited on the sentence before this one is let go.
                let previous = PENDING
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .replace((Retained::as_ptr(&utterance) as usize, sender));
                if let Some((_, waiting)) = previous {
                    let _ = waiting.send("cancelled");
                }
                let _: () = msg_send![&*synth, speakUtterance: &*utterance];
            }
        })
        .map_err(|e| format!("E_SPEECH: {e}"))?;
        receiver.await.map_err(|_| "E_SPEECH: the voice stopped".to_string())
    }

    pub enum Control {
        Stop,
        Pause,
        Resume,
    }

    pub fn control<R: tauri::Runtime>(app: &tauri::AppHandle<R>, what: Control) {
        let _ = app.run_on_main_thread(move || {
            let synth = synthesizer();
            // SAFETY: AVSpeechSynthesizer's documented controls; boundary 0
            // is AVSpeechBoundaryImmediate, 1 AVSpeechBoundaryWord.
            unsafe {
                let _: bool = match what {
                    Control::Stop => msg_send![&*synth, stopSpeakingAtBoundary: 0isize],
                    Control::Pause => msg_send![&*synth, pauseSpeakingAtBoundary: 1isize],
                    Control::Resume => msg_send![&*synth, continueSpeaking],
                };
            }
            if let Control::Stop = what {
                // A stop before the sentence began says nothing through the
                // delegate; whoever waits is let go here.
                if let Some((_, waiting)) = PENDING.lock().unwrap_or_else(|e| e.into_inner()).take() {
                    let _ = waiting.send("cancelled");
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_speed_maps_onto_apples_rate_with_normal_in_the_middle() {
        assert_eq!(apple_rate(1.0), 0.5);
        assert!((apple_rate(2.0) - 0.75).abs() < 1e-6);
        assert!((apple_rate(0.5) - 0.35).abs() < 1e-6);
        assert!(apple_rate(1.25) > apple_rate(1.0));
        assert_eq!(apple_rate(9.0), apple_rate(2.0));
        assert_eq!(apple_rate(f32::NAN), 0.5);
    }

    #[test]
    fn qualities_are_named_as_the_interface_ranks_them() {
        assert_eq!(quality_name(3), "premium");
        assert_eq!(quality_name(2), "enhanced");
        assert_eq!(quality_name(1), "standard");
        assert_eq!(quality_name(0), "standard");
    }
}
