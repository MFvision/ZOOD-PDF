//! Read aloud for the ZOOD PDF desktop app with the operating system's own voices.
//!
//! * macOS: `AVSpeechSynthesizer` (AVFAudio) — installed voices with their quality
//!   (default / Enhanced / Premium, e.g. "Ava (Premium)"). Siri voices are not exposed to
//!   third-party apps by the OS.
//! * Windows: `Windows.Media.SpeechSynthesis` (WinRT) — the installed OneCore voices, including
//!   Arabic ones (e.g. Hoda, Naayf) when the language pack is installed; audio is played with
//!   `Windows.Media.Playback.MediaPlayer`.
//! * Elsewhere [`engine`] returns `None` and the web layer falls back to the webview's
//!   on-device `speechSynthesis` voices (or hides the feature).
//!
//! Nothing is sent over the network. This module holds the platform-independent parts (voice
//! filtering and ranking, language matching, request checks, rate mapping) so they are unit
//! tested on every OS; the native engines live in `macos.rs` / `windows.rs`.

use serde::Serialize;
use std::sync::Arc;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

/// Voice quality as reported by the OS (Windows voices are all `Default`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Quality {
    Default,
    Enhanced,
    Premium,
}

impl Quality {
    /// `AVSpeechSynthesisVoiceQuality` raw value (1 default, 2 enhanced, 3 premium).
    pub fn from_av(raw: isize) -> Quality {
        match raw {
            3 => Quality::Premium,
            2 => Quality::Enhanced,
            _ => Quality::Default,
        }
    }
}

/// A voice as sent to the interface.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Voice {
    pub id: String,
    pub name: String,
    /// BCP-47 tag (`ar-SA`, `en-US`).
    pub lang: String,
    pub quality: Quality,
}

/// What a native engine reports before filtering.
#[derive(Debug, Clone, PartialEq)]
pub struct RawVoice {
    pub id: String,
    pub name: String,
    pub lang: String,
    pub quality: Quality,
    /// Novelty voices (Bells, Bubbles, Zarvox…) are not for reading documents.
    pub novelty: bool,
    /// Personal Voice needs its own authorisation and is never used.
    pub personal: bool,
}

/// `ar_SA` / `AR-sa` → `ar-SA`.
pub fn normalise_tag(tag: &str) -> String {
    tag.split(['-', '_'])
        .filter(|p| !p.is_empty())
        .enumerate()
        .map(|(i, p)| {
            if i == 0 {
                p.to_ascii_lowercase()
            } else if p.len() == 2 {
                p.to_ascii_uppercase()
            } else {
                p.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("-")
}

/// Primary language subtag (`ar-SA` → `ar`).
pub fn primary(tag: &str) -> String {
    normalise_tag(tag)
        .split('-')
        .next()
        .unwrap_or_default()
        .to_string()
}

/// Does a voice tag speak language `want` (a primary subtag or a full tag)?
pub fn lang_matches(voice_tag: &str, want: &str) -> bool {
    let v = normalise_tag(voice_tag);
    let w = normalise_tag(want);
    if w.contains('-') {
        v == w
    } else {
        primary(&v) == w && !w.is_empty()
    }
}

/// Usable voices, best first: Premium → Enhanced → default, then by language and name.
pub fn usable_voices(raw: Vec<RawVoice>) -> Vec<Voice> {
    let mut out: Vec<Voice> = raw
        .into_iter()
        .filter(|v| !v.novelty && !v.personal && !v.id.is_empty() && !v.lang.is_empty())
        .map(|v| Voice {
            id: v.id,
            name: v.name,
            lang: normalise_tag(&v.lang),
            quality: v.quality,
        })
        .collect();
    out.sort_by(|a, b| {
        b.quality
            .cmp(&a.quality)
            .then_with(|| a.lang.cmp(&b.lang))
            .then_with(|| a.name.cmp(&b.name))
    });
    out.dedup_by(|a, b| a.id == b.id);
    out
}

/// The best installed voice for a language (`ar`, `en-GB`, …), preferring the higher quality.
pub fn best_voice<'a>(voices: &'a [Voice], lang: &str) -> Option<&'a Voice> {
    voices
        .iter()
        .filter(|v| lang_matches(&v.lang, lang))
        .max_by(|a, b| a.quality.cmp(&b.quality).then_with(|| b.name.cmp(&a.name)))
}

/// Longest text accepted for one utterance (the interface sends sentences of ≤ 200 chars).
pub const MAX_TEXT_CHARS: usize = 4000;

/// A request to speak, as checked by [`SpeakRequest::new`].
#[derive(Debug, Clone, PartialEq)]
pub struct SpeakRequest {
    pub text: String,
    pub voice: String,
    /// 1 = normal speed, clamped to 0.5–2.
    pub rate: f32,
    /// 1 = normal pitch, clamped to 0.5–2.
    pub pitch: f32,
}

impl SpeakRequest {
    pub fn new(text: &str, voice: &str, rate: f64, pitch: f64) -> Result<SpeakRequest, String> {
        let text: String = text
            .chars()
            .filter(|c| !c.is_control() || *c == '\n')
            .collect();
        if text.trim().is_empty() {
            return Err("nothing to speak".into());
        }
        if text.chars().count() > MAX_TEXT_CHARS {
            return Err("text too long for one utterance".into());
        }
        if voice.is_empty() || voice.len() > 512 {
            return Err("invalid voice".into());
        }
        let clamp = |v: f64| {
            if v.is_finite() {
                v.clamp(0.5, 2.0) as f32
            } else {
                1.0
            }
        };
        Ok(SpeakRequest {
            text,
            voice: voice.to_string(),
            rate: clamp(rate),
            pitch: clamp(pitch),
        })
    }
}

/// `AVSpeechUtterance.rate` for a normalised rate (1 → `AVSpeechUtteranceDefaultSpeechRate` 0.5;
/// 2 → 0.75; 0.5 → 0.35). AVFoundation's scale is 0–1 and strongly non-linear near 1.
pub fn av_rate(rate: f32) -> f32 {
    let r = rate.clamp(0.5, 2.0);
    if r >= 1.0 {
        0.5 + (r - 1.0) * 0.25
    } else {
        0.5 - (1.0 - r) * 0.3
    }
}

/// Windows `SpeechSynthesizerOptions.SpeakingRate` (0.5–6, 1 = normal) for a normalised rate.
pub fn windows_rate(rate: f32) -> f64 {
    f64::from(rate.clamp(0.5, 2.0))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EventKind {
    Start,
    End,
    Error,
}

/// Emitted to the interface as `zood://speech`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SpeechEvent {
    pub id: u32,
    pub kind: EventKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl SpeechEvent {
    pub fn new(id: u32, kind: EventKind) -> Self {
        SpeechEvent {
            id,
            kind,
            message: None,
        }
    }
    pub fn error(id: u32, message: impl Into<String>) -> Self {
        SpeechEvent {
            id,
            kind: EventKind::Error,
            message: Some(message.into()),
        }
    }
}

/// Sends events to the interface.
pub type Emit = Arc<dyn Fn(SpeechEvent) + Send + Sync>;
/// Runs a closure on the app's main thread (AVSpeechSynthesizer is used from there only).
pub type MainRunner = Arc<dyn Fn(Box<dyn FnOnce() + Send>) + Send + Sync>;

/// A native speech engine. Only one utterance plays at a time; `speak` replaces the current one.
pub trait Engine: Send + Sync {
    fn voices(&self) -> Result<Vec<Voice>, String>;
    /// Starts speaking; `Start`/`End`/`Error` events with `id` follow through the emitter.
    fn speak(&self, id: u32, req: SpeakRequest) -> Result<(), String>;
    fn pause(&self) -> Result<(), String>;
    fn resume(&self) -> Result<(), String>;
    fn stop(&self) -> Result<(), String>;
}

/// The engine of this OS, or `None` where the desktop app has no native speech (Linux).
#[allow(unused_variables)]
pub fn engine(emit: Emit, main: MainRunner) -> Option<Arc<dyn Engine>> {
    #[cfg(target_os = "macos")]
    {
        return Some(Arc::new(macos::MacEngine::new(emit, main)));
    }
    #[cfg(target_os = "windows")]
    {
        return windows::WinEngine::new(emit)
            .ok()
            .map(|e| Arc::new(e) as Arc<dyn Engine>);
    }
    #[allow(unreachable_code)]
    None
}

/// Whether this build has a native engine (reported to the interface in `host_info`).
pub const NATIVE: bool = cfg!(any(target_os = "macos", target_os = "windows"));

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn raw(id: &str, lang: &str, quality: Quality) -> RawVoice {
        RawVoice {
            id: id.into(),
            name: id.into(),
            lang: lang.into(),
            quality,
            novelty: false,
            personal: false,
        }
    }

    #[test]
    fn premium_then_enhanced_then_default() {
        let v = usable_voices(vec![
            raw("Samantha", "en-US", Quality::Default),
            raw("Ava", "en_US", Quality::Premium),
            raw("Majed", "ar-SA", Quality::Enhanced),
            raw("Tarik", "ar-SA", Quality::Default),
            raw("Zoe", "en-US", Quality::Enhanced),
        ]);
        let ids: Vec<&str> = v.iter().map(|v| v.id.as_str()).collect();
        assert_eq!(ids, ["Ava", "Majed", "Zoe", "Tarik", "Samantha"]);
        assert_eq!(v[0].lang, "en-US");
        assert_eq!(best_voice(&v, "en").unwrap().id, "Ava");
        assert_eq!(best_voice(&v, "ar").unwrap().id, "Majed");
        assert!(best_voice(&v, "fr").is_none());
    }

    #[test]
    fn novelty_personal_and_broken_voices_are_dropped() {
        let mut bells = raw("Bells", "en-US", Quality::Default);
        bells.novelty = true;
        let mut me = raw("Me", "en-US", Quality::Premium);
        me.personal = true;
        let v = usable_voices(vec![
            bells,
            me,
            raw("", "en-US", Quality::Default),
            raw("x", "", Quality::Default),
            raw("Hoda", "ar-EG", Quality::Default),
            raw("Hoda", "ar-EG", Quality::Default),
        ]);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].id, "Hoda");
    }

    #[test]
    fn language_matching() {
        assert!(lang_matches("ar-SA", "ar"));
        assert!(lang_matches("AR_eg", "ar"));
        assert!(lang_matches("en-GB", "en-gb"));
        assert!(!lang_matches("en-US", "en-GB"));
        assert!(!lang_matches("arz", "ar"));
        assert!(!lang_matches("ar-SA", ""));
        assert_eq!(normalise_tag("zh_hant_TW"), "zh-hant-TW");
        assert_eq!(primary("EN-us"), "en");
    }

    #[test]
    fn av_quality_values() {
        assert_eq!(Quality::from_av(3), Quality::Premium);
        assert_eq!(Quality::from_av(2), Quality::Enhanced);
        assert_eq!(Quality::from_av(1), Quality::Default);
        assert_eq!(Quality::from_av(99), Quality::Default);
    }

    #[test]
    fn requests_are_checked_and_clamped() {
        let r = SpeakRequest::new(
            "مرحبًا\u{0007}",
            "com.apple.voice.premium.ar-SA.Majed",
            9.0,
            f64::NAN,
        )
        .unwrap();
        assert_eq!(r.text, "مرحبًا");
        assert_eq!((r.rate, r.pitch), (2.0, 1.0));
        assert!(SpeakRequest::new("  ", "v", 1.0, 1.0).is_err());
        assert!(SpeakRequest::new("x", "", 1.0, 1.0).is_err());
        assert!(SpeakRequest::new(&"a".repeat(MAX_TEXT_CHARS + 1), "v", 1.0, 1.0).is_err());
    }

    #[test]
    fn rate_mapping() {
        assert!((av_rate(1.0) - 0.5).abs() < 1e-6);
        assert!((av_rate(2.0) - 0.75).abs() < 1e-6);
        assert!((av_rate(0.5) - 0.35).abs() < 1e-6);
        assert!(av_rate(1.5) > av_rate(1.25));
        assert_eq!(windows_rate(9.0), 2.0);
    }

    #[test]
    fn events_serialise_for_the_interface() {
        let e = serde_json::to_string(&SpeechEvent::new(4, EventKind::End)).unwrap();
        assert_eq!(e, r#"{"id":4,"kind":"end"}"#);
        let e = serde_json::to_string(&SpeechEvent::error(5, "voice missing")).unwrap();
        assert_eq!(e, r#"{"id":5,"kind":"error","message":"voice missing"}"#);
        let v = serde_json::to_string(&Voice {
            id: "a".into(),
            name: "Ava".into(),
            lang: "en-US".into(),
            quality: Quality::Premium,
        })
        .unwrap();
        assert_eq!(
            v,
            r#"{"id":"a","name":"Ava","lang":"en-US","quality":"premium"}"#
        );
    }

    #[test]
    fn native_engine_exactly_on_macos_and_windows() {
        let emit: Emit = Arc::new(|_| {});
        let main: MainRunner = Arc::new(|f| f());
        assert_eq!(engine(emit, main).is_some(), NATIVE);
    }
}
