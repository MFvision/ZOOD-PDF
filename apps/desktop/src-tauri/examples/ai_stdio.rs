//! The on-device engine over standard input and output, for measuring the
//! assistant by hand with the real model and the interface's own code:
//!
//! ```text
//! cargo run --release --example ai_stdio -- path/to/model.gguf
//! ```
//!
//! One JSON object a line in, one or more a line out:
//!
//! - `{"op":"generate","messages":[…],"maxTokens":N,"contextTokens":N}` →
//!   `{"token":"…"}` for each piece, then `{"done":{…}}` or `{"error":"…"}`;
//! - `{"op":"count","text":"…"}` → `{"count":N}`;
//! - `{"op":"memory"}` → `{"peakMiB":N}`, the process's peak so far.
//!
//! `packages/ui/src/ai/chat/realModel.test.ts` drives it: the chat's own
//! chunking, analysis and answering, against `Engine::generate` — everything
//! but the webview's message channel. Never part of the app.
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;

use serde::Deserialize;
use serde_json::json;
use warraq_desktop_lib::ai::{Engine, GenerateRequest, Message};

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum Op {
    #[serde(rename_all = "camelCase")]
    Generate {
        messages: Vec<Message>,
        max_tokens: u32,
        #[serde(default)]
        context_tokens: Option<u32>,
        #[serde(default)]
        grammar: Option<String>,
    },
    Count {
        text: String,
    },
    Memory,
}

fn peak_mib() -> f64 {
    #[cfg(unix)]
    {
        let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
        // SAFETY: getrusage fills the struct handed to it.
        if unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) } == 0 {
            // macOS reports bytes; Linux kilobytes.
            let bytes = if cfg!(target_os = "macos") {
                usage.ru_maxrss as f64
            } else {
                usage.ru_maxrss as f64 * 1024.0
            };
            return bytes / (1024.0 * 1024.0);
        }
    }
    0.0
}

fn main() {
    let model = PathBuf::from(std::env::args().nth(1).expect("usage: ai_stdio MODEL.gguf"));
    // WARRAQ_AI_CPU=1 keeps the model off the graphics processor: what a machine without Metal does.
    let engine = if std::env::var_os("WARRAQ_AI_CPU").is_some() {
        Engine::load_on_processor(&model)
    } else {
        Engine::load(&model)
    }
    .expect("model loads");
    let stdout = std::io::stdout();
    let say = |value: serde_json::Value| {
        let mut out = stdout.lock();
        let _ = writeln!(out, "{value}");
        let _ = out.flush();
    };
    say(json!({ "ready": true }));
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<Op>(&line) {
            Err(e) => say(json!({ "error": format!("E_ARGS: {e}") })),
            Ok(Op::Memory) => say(json!({ "peakMiB": peak_mib() })),
            Ok(Op::Count { text }) => match engine.count_tokens(&text) {
                Ok(count) => say(json!({ "count": count })),
                Err(e) => say(json!({ "error": e })),
            },
            Ok(Op::Generate {
                messages,
                max_tokens,
                context_tokens,
                grammar,
            }) => {
                let request = GenerateRequest {
                    id: "stdio".into(),
                    model: "stdio".into(),
                    messages,
                    grammar,
                    max_tokens,
                    context_tokens,
                };
                match engine.generate(&request, &AtomicBool::new(false), |piece| {
                    say(json!({ "token": piece }))
                }) {
                    Ok(done) => say(json!({ "done": done })),
                    Err(e) => say(json!({ "error": e })),
                }
            }
        }
    }
}
