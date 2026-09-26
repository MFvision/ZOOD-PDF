//! Windows: `Windows.Media.SpeechSynthesis.SpeechSynthesizer` (the installed OneCore voices,
//! Arabic ones included when the language's speech pack is installed) rendered to a stream and
//! played with a `Windows.Media.Playback.MediaPlayer`. One player per utterance, so a finished
//! old utterance can never end the new one. Compiled only on Windows; Linux CI type-checks it
//! with `cargo check --target x86_64-pc-windows-msvc`.

use std::sync::{Arc, Mutex};

use windows::core::{Interface, HSTRING};
use windows::Foundation::TypedEventHandler;
use windows::Media::Core::MediaSource;
use windows::Media::Playback::{IMediaPlaybackSource, MediaPlayer};
use windows::Media::SpeechSynthesis::{SpeechSynthesizer, VoiceInformation};

use crate::{
    usable_voices, windows_rate, Emit, Engine, EventKind, Quality, RawVoice, SpeakRequest,
    SpeechEvent, Voice,
};

type Playing = Arc<Mutex<Option<(u32, MediaPlayer)>>>;

pub struct WinEngine {
    synth: SpeechSynthesizer,
    emit: Emit,
    playing: Playing,
}

fn e(err: windows::core::Error) -> String {
    err.message().to_string()
}

impl WinEngine {
    pub fn new(emit: Emit) -> Result<Self, String> {
        Ok(WinEngine {
            synth: SpeechSynthesizer::new().map_err(e)?,
            emit,
            playing: Arc::new(Mutex::new(None)),
        })
    }

    fn all_voices() -> Result<Vec<VoiceInformation>, String> {
        let list = SpeechSynthesizer::AllVoices().map_err(e)?;
        Ok(list.into_iter().collect())
    }

    fn stop_current(&self) {
        let old = self.playing.lock().ok().and_then(|mut p| p.take());
        if let Some((_, player)) = old {
            let _ = player.Pause();
            let _ = player.Close();
        }
    }
}

// WinRT objects in the `windows` crate are agile (Send + Sync), so no unsafe is needed here.
impl Engine for WinEngine {
    fn voices(&self) -> Result<Vec<Voice>, String> {
        let raw = Self::all_voices()?
            .into_iter()
            .filter_map(|v| {
                Some(RawVoice {
                    id: v.Id().ok()?.to_string(),
                    name: v.DisplayName().ok()?.to_string(),
                    lang: v.Language().ok()?.to_string(),
                    quality: Quality::Default,
                    novelty: false,
                    personal: false,
                })
            })
            .collect();
        Ok(usable_voices(raw))
    }

    fn speak(&self, id: u32, req: SpeakRequest) -> Result<(), String> {
        self.stop_current();
        let voice = Self::all_voices()?
            .into_iter()
            .find(|v| v.Id().map(|i| i == req.voice).unwrap_or(false))
            .ok_or_else(|| "voice not installed".to_string())?;
        self.synth.SetVoice(&voice).map_err(e)?;
        let options = self.synth.Options().map_err(e)?;
        options.SetSpeakingRate(windows_rate(req.rate)).map_err(e)?;
        options
            .SetAudioPitch(f64::from(req.pitch.clamp(0.5, 2.0)))
            .map_err(e)?;
        // Synthesis is local (OneCore); the blocking wait runs on a worker thread of the host.
        let stream = self
            .synth
            .SynthesizeTextToStreamAsync(&HSTRING::from(req.text.as_str()))
            .map_err(e)?
            .get()
            .map_err(e)?;
        let content_type = stream.ContentType().map_err(e)?;
        let source = MediaSource::CreateFromStream(&stream, &content_type).map_err(e)?;
        let player = MediaPlayer::new().map_err(e)?;
        let emit = self.emit.clone();
        let playing = self.playing.clone();
        player
            .MediaEnded(&TypedEventHandler::new(move |_, _| {
                let mine = playing.lock().ok().and_then(|mut p| match p.as_ref() {
                    Some((cur, _)) if *cur == id => p.take(),
                    _ => None,
                });
                if mine.is_some() {
                    emit(SpeechEvent::new(id, EventKind::End));
                }
                Ok(())
            }))
            .map_err(e)?;
        let emit = self.emit.clone();
        let playing = self.playing.clone();
        player
            .MediaFailed(&TypedEventHandler::new(move |_, _| {
                let mine = playing.lock().ok().and_then(|mut p| match p.as_ref() {
                    Some((cur, _)) if *cur == id => p.take(),
                    _ => None,
                });
                if mine.is_some() {
                    emit(SpeechEvent::error(id, "playback failed"));
                }
                Ok(())
            }))
            .map_err(e)?;
        let playable: IMediaPlaybackSource = source.cast().map_err(e)?;
        player.SetSource(&playable).map_err(e)?;
        if let Ok(mut p) = self.playing.lock() {
            *p = Some((id, player.clone()));
        }
        (self.emit)(SpeechEvent::new(id, EventKind::Start));
        player.Play().map_err(e)?;
        Ok(())
    }

    fn pause(&self) -> Result<(), String> {
        if let Some((_, p)) = self.playing.lock().map_err(|_| "busy")?.as_ref() {
            p.Pause().map_err(e)?;
        }
        Ok(())
    }

    fn resume(&self) -> Result<(), String> {
        if let Some((_, p)) = self.playing.lock().map_err(|_| "busy")?.as_ref() {
            p.Play().map_err(e)?;
        }
        Ok(())
    }

    fn stop(&self) -> Result<(), String> {
        self.stop_current();
        Ok(())
    }
}
