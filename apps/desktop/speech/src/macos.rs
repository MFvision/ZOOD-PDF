//! macOS: `AVSpeechSynthesizer` with the installed voices (Premium/Enhanced first).
//!
//! The synthesizer is created and used on the main thread only (through the host's
//! [`MainRunner`]); its delegate reports start/finish of the current utterance. Compiled only on
//! macOS; Linux CI type-checks it with `cargo check --target aarch64-apple-darwin`.
#![allow(unsafe_code)]

use std::cell::RefCell;
use std::sync::{Arc, Mutex};

use objc2::rc::Retained;
use objc2::runtime::{NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{define_class, msg_send, AnyThread, DefinedClass};
use objc2_avf_audio::{
    AVSpeechBoundary, AVSpeechSynthesisVoice, AVSpeechSynthesisVoiceTraits, AVSpeechSynthesizer,
    AVSpeechSynthesizerDelegate, AVSpeechUtterance,
};
use objc2_foundation::NSString;

use crate::{
    av_rate, usable_voices, Emit, Engine, EventKind, MainRunner, Quality, RawVoice, SpeakRequest,
    SpeechEvent, Voice,
};

/// The utterance being spoken: its address (identity) and the interface's id.
type Current = Arc<Mutex<Option<(usize, u32)>>>;

struct Ivars {
    emit: Emit,
    current: Current,
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements; no Drop impl.
    #[unsafe(super(NSObject))]
    #[name = "ZoodSpeechDelegate"]
    #[ivars = Ivars]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl AVSpeechSynthesizerDelegate for Delegate {
        #[unsafe(method(speechSynthesizer:didStartSpeechUtterance:))]
        fn did_start(&self, _s: &AVSpeechSynthesizer, u: &AVSpeechUtterance) {
            self.report(u, EventKind::Start, false);
        }

        #[unsafe(method(speechSynthesizer:didFinishSpeechUtterance:))]
        fn did_finish(&self, _s: &AVSpeechSynthesizer, u: &AVSpeechUtterance) {
            self.report(u, EventKind::End, true);
        }
    }
);

// SAFETY: the ivars are Send + Sync (Arc<Mutex<…>>, Arc<dyn Fn + Send + Sync>); the protocol
// requires it and AVFoundation may call the delegate from its own queue.
unsafe impl Send for Delegate {}
unsafe impl Sync for Delegate {}

impl Delegate {
    fn new(emit: Emit, current: Current) -> Retained<Self> {
        let this = Self::alloc().set_ivars(Ivars { emit, current });
        // SAFETY: NSObject's designated initialiser.
        unsafe { msg_send![super(this), init] }
    }

    fn report(&self, u: &AVSpeechUtterance, kind: EventKind, last: bool) {
        let key = u as *const AVSpeechUtterance as usize;
        let id = {
            let Ok(mut cur) = self.ivars().current.lock() else {
                return;
            };
            match *cur {
                Some((k, id)) if k == key => {
                    if last {
                        *cur = None;
                    }
                    id
                }
                _ => return,
            }
        };
        (self.ivars().emit)(SpeechEvent::new(id, kind));
    }
}

struct MainState {
    synth: Retained<AVSpeechSynthesizer>,
    _delegate: Retained<Delegate>,
    utterance: Option<Retained<AVSpeechUtterance>>,
}

thread_local! {
    /// Lives on the main thread only (all access goes through `MainRunner`).
    static STATE: RefCell<Option<MainState>> = const { RefCell::new(None) };
}

pub struct MacEngine {
    emit: Emit,
    main: MainRunner,
    current: Current,
}

impl MacEngine {
    pub fn new(emit: Emit, main: MainRunner) -> Self {
        MacEngine {
            emit,
            main,
            current: Arc::new(Mutex::new(None)),
        }
    }

    fn with_state(&self, f: impl FnOnce(&mut MainState) + Send + 'static) {
        let emit = self.emit.clone();
        let current = self.current.clone();
        (self.main)(Box::new(move || {
            STATE.with(|cell| {
                let mut slot = cell.borrow_mut();
                let state = slot.get_or_insert_with(|| {
                    // SAFETY: plain allocation + init of the synthesizer on the main thread.
                    let synth = unsafe { AVSpeechSynthesizer::new() };
                    let delegate = Delegate::new(emit, current);
                    // SAFETY: the delegate is retained in MainState for the synthesizer's lifetime.
                    unsafe { synth.setDelegate(Some(ProtocolObject::from_ref(&*delegate))) };
                    MainState {
                        synth,
                        _delegate: delegate,
                        utterance: None,
                    }
                });
                f(state);
            });
        }));
    }
}

fn raw_voices() -> Vec<RawVoice> {
    // SAFETY: class method returning an autoreleased NSArray of voices (thread-safe getter).
    let all = unsafe { AVSpeechSynthesisVoice::speechVoices() };
    all.iter()
        .map(|v| {
            // SAFETY: plain property getters on a valid AVSpeechSynthesisVoice.
            let (id, name, lang, quality, traits) = unsafe {
                (
                    v.identifier().to_string(),
                    v.name().to_string(),
                    v.language().to_string(),
                    v.quality(),
                    v.voiceTraits(),
                )
            };
            RawVoice {
                id,
                name,
                lang,
                quality: Quality::from_av(quality.0),
                novelty: traits.contains(AVSpeechSynthesisVoiceTraits::IsNoveltyVoice),
                personal: traits.contains(AVSpeechSynthesisVoiceTraits::IsPersonalVoice),
            }
        })
        .collect()
}

impl Engine for MacEngine {
    fn voices(&self) -> Result<Vec<Voice>, String> {
        Ok(usable_voices(raw_voices()))
    }

    fn speak(&self, id: u32, req: SpeakRequest) -> Result<(), String> {
        let emit = self.emit.clone();
        let current = self.current.clone();
        self.with_state(move |st| {
            // SAFETY: valid NSString; voiceWithIdentifier returns nil for unknown ids.
            let voice = unsafe {
                AVSpeechSynthesisVoice::voiceWithIdentifier(&NSString::from_str(&req.voice))
            };
            let Some(voice) = voice else {
                emit(SpeechEvent::error(id, "voice not installed"));
                return;
            };
            // Replace whatever is playing (its cancel is not reported).
            if let Ok(mut cur) = current.lock() {
                *cur = None;
            }
            // SAFETY: main-thread calls on a valid synthesizer / utterance.
            unsafe {
                st.synth.stopSpeakingAtBoundary(AVSpeechBoundary::Immediate);
                let u =
                    AVSpeechUtterance::speechUtteranceWithString(&NSString::from_str(&req.text));
                u.setVoice(Some(&voice));
                u.setRate(av_rate(req.rate));
                u.setPitchMultiplier(req.pitch);
                let key = &*u as *const AVSpeechUtterance as usize;
                if let Ok(mut cur) = current.lock() {
                    *cur = Some((key, id));
                }
                st.synth.speakUtterance(&u);
                st.utterance = Some(u);
            }
        });
        Ok(())
    }

    fn pause(&self) -> Result<(), String> {
        self.with_state(|st| {
            // SAFETY: main-thread call on a valid synthesizer.
            unsafe { st.synth.pauseSpeakingAtBoundary(AVSpeechBoundary::Word) };
        });
        Ok(())
    }

    fn resume(&self) -> Result<(), String> {
        self.with_state(|st| {
            // SAFETY: main-thread call on a valid synthesizer.
            unsafe { st.synth.continueSpeaking() };
        });
        Ok(())
    }

    fn stop(&self) -> Result<(), String> {
        let current = self.current.clone();
        self.with_state(move |st| {
            if let Ok(mut cur) = current.lock() {
                *cur = None;
            }
            // SAFETY: main-thread call on a valid synthesizer.
            unsafe { st.synth.stopSpeakingAtBoundary(AVSpeechBoundary::Immediate) };
            st.utterance = None;
        });
        Ok(())
    }
}
