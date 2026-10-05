//! Measures the on-device model once, by hand, on the machine it runs on:
//!
//! ```text
//! cargo run --release --example ai_bench -- path/to/qwen2.5-1.5b-instruct-q4_k_m.gguf [file.txt]
//! ```
//!
//! Prints the load time, the tokens a second while writing, the process's
//! peak memory, and an Arabic summary of the text file (or of a short built-in
//! passage), so the numbers in `docs/STATUS.md` come from a run, not a guess.
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::time::Instant;

use warraq_desktop_lib::ai::{Engine, GenerateRequest, Message};

const PASSAGE: &str = "تُعد المدينة المنورة ثاني أقدس مدينة في الإسلام، وتقع في غرب المملكة العربية السعودية. يزورها ملايين المسلمين كل عام، وتشتهر بالمسجد النبوي الذي يضم قبر النبي محمد صلى الله عليه وسلم. تطورت المدينة في العقود الأخيرة بمشاريع كبيرة للنقل والإسكان والخدمات، مع الحفاظ على معالمها التاريخية.";

fn peak_rss_mib() -> f64 {
    #[cfg(unix)]
    {
        let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
        // SAFETY: getrusage fills the struct handed to it.
        if unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) } == 0 {
            // macOS reports bytes; Linux kilobytes.
            let bytes = if cfg!(target_os = "macos") { usage.ru_maxrss as f64 } else { usage.ru_maxrss as f64 * 1024.0 };
            return bytes / (1024.0 * 1024.0);
        }
    }
    0.0
}

fn main() {
    let mut args = std::env::args().skip(1);
    let model = PathBuf::from(args.next().expect("usage: ai_bench MODEL.gguf [TEXT.txt]"));
    let text = args
        .next()
        .map(|path| std::fs::read_to_string(path).expect("readable text file"))
        .unwrap_or_else(|| PASSAGE.to_string());
    let started = Instant::now();
    let engine = Engine::load(&model).expect("model loads");
    println!("loaded in {:.1} s", started.elapsed().as_secs_f64());
    let request = GenerateRequest {
        id: "bench".into(),
        model: "bench".into(),
        messages: vec![
            Message {
                role: "system".into(),
                content: "You help a person read a document. Answer in Modern Standard Arabic, in plain text.".into(),
            },
            Message {
                role: "user".into(),
                content: format!("<document>\n{text}\n</document>\n\nلخّص هذا النص في جملتين."),
            },
        ],
        grammar: None,
        max_tokens: 200,
    };
    let done = engine
        .generate(&request, &AtomicBool::new(false), |piece| {
            print!("{piece}");
            use std::io::Write;
            let _ = std::io::stdout().flush();
        })
        .expect("generates");
    println!();
    println!(
        "{} tokens in {} ms = {:.1} tokens/s; cut off: {}; peak RSS {:.0} MiB",
        done.tokens,
        done.ms,
        done.tokens as f64 * 1000.0 / done.ms.max(1) as f64,
        done.cut_off,
        peak_rss_mib()
    );
}
