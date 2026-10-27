//! Ask ZOOD's hearing by hand, with the real model: each WAV file (16-bit
//! mono, any rate) read three ways — as the app used to send it, made ready
//! by `ask::clean`, and made ready with the person's own words as context —
//! and what the model heard printed for each, tidied as the app tidies it.
//!
//! ```text
//! cargo run --release --example hear_check -- MODEL.gguf PROJECTOR.gguf WORDS.txt a.wav b.wav …
//! ```
//!
//! WORDS.txt holds the person's words, one a line. Never part of the app.
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;

use warraq_desktop_lib::ai::{Engine, GenerateRequest, Media, Message, MEDIA_MARKER};
use warraq_desktop_lib::ask::{clean, clean_transcript, transcribe_messages, words};

fn read_wav(path: &str) -> (u32, Vec<f32>) {
    let bytes = std::fs::read(path).expect("the file reads");
    assert_eq!(&bytes[..4], b"RIFF", "{path} is a WAV file");
    let mut at = 12;
    let (mut rate, mut channels) = (16_000u32, 1usize);
    while at + 8 <= bytes.len() {
        let id = &bytes[at..at + 4];
        let size = u32::from_le_bytes(bytes[at + 4..at + 8].try_into().unwrap()) as usize;
        let body = &bytes[at + 8..(at + 8 + size).min(bytes.len())];
        if id == b"fmt " {
            channels = u16::from_le_bytes(body[2..4].try_into().unwrap()) as usize;
            rate = u32::from_le_bytes(body[4..8].try_into().unwrap());
        } else if id == b"data" {
            let samples: Vec<f32> = body
                .as_chunks::<2>()
                .0
                .iter()
                .map(|b| f32::from(i16::from_le_bytes(*b)) / 32768.0)
                .collect();
            return (
                rate,
                warraq_desktop_lib::ask::ear::to_mono(&samples, channels),
            );
        }
        at += 8 + size + (size & 1);
    }
    panic!("{path} has no sound");
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let engine =
        Engine::load_with_projector(&PathBuf::from(&args[0]), Some(&PathBuf::from(&args[1])))
            .expect("model loads");
    let mine: Vec<String> = std::fs::read_to_string(&args[2])
        .unwrap_or_default()
        .lines()
        .map(str::to_string)
        .filter(|l| !l.trim().is_empty())
        .collect();
    for path in &args[3..] {
        let (rate, samples) = read_wav(path);
        let ready = clean::for_model(&samples, rate);
        for (how, messages, sound) in [
            (
                "before",
                transcribe_messages(&[]),
                Media::Sound {
                    rate,
                    samples: samples.clone(),
                },
            ),
            (
                "ready",
                transcribe_messages(&[]),
                Media::Sound {
                    rate: clean::MODEL_RATE,
                    samples: ready.clone(),
                },
            ),
            (
                "words",
                transcribe_messages(&mine),
                Media::Sound {
                    rate: clean::MODEL_RATE,
                    samples: ready.clone(),
                },
            ),
        ] {
            // Without words of the person's own, "words" is "ready" again.
            if how == "words" && mine.is_empty() {
                continue;
            }
            if std::env::var("HEAR_ONLY").is_ok_and(|only| !only.split(',').any(|o| o == how)) {
                continue;
            }
            let request = GenerateRequest {
                id: "hear".into(),
                model: "hear".into(),
                messages: if messages.is_empty() {
                    vec![Message {
                        role: "user".into(),
                        content: MEDIA_MARKER.into(),
                    }]
                } else {
                    messages
                },
                grammar: None,
                max_tokens: 400,
                context_tokens: Some(4096),
                media: vec![sound],
            };
            let started = std::time::Instant::now();
            let heard = engine
                .generate(&request, &AtomicBool::new(false), |_| {})
                .map(|g| g.text)
                .unwrap_or_else(|e| format!("ERROR {e}"));
            let raw = clean_transcript(&heard);
            let fixed = if how == "words" {
                words::apply_custom_words(&words::tidy(&raw), &mine)
            } else {
                raw.clone()
            };
            println!(
                "{}\t{how}\t{:.1}s\t{fixed}",
                std::path::Path::new(path)
                    .file_name()
                    .unwrap()
                    .to_string_lossy(),
                started.elapsed().as_secs_f32()
            );
        }
    }
}
