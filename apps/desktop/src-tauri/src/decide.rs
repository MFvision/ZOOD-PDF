//! Ask ZOOD's quick decider: a small decision model that picks one option out
//! of a list, with a probability for each, and writes nothing.
//!
//! The model is Jev-Style 0.8B Decision v3 (Apache-2.0, a fine-tune of
//! Qwen3.5-0.8B by chaoliangUNSW). It is downloaded and checked like the other
//! on-device models (`ai.rs`, `models.json`), loaded on a thread of its own
//! and kept there, so a quick ask does not wait for the larger model to load.
//!
//! How a decision is read, ported from the model's own runtime
//! (`jev_style_decision_gguf.py`, Apache-2.0, "macjev-render-v1"):
//!
//! ```text
//! State:\n<state>\n\n
//! Question [choice]: <question>\nOptions:\n
//! - <option 1>\n … - <option K>\n
//! Judge each option:\n
//! <option 1> ->\n … <option K> ->\n
//! ```
//!
//! Each piece is turned into tokens on its own and the pieces are joined. The
//! score of option k is logit(" yes") − logit(" no") at its " ->", and the
//! probabilities are softmax(score / T), T the calibration temperature the
//! model ships with. One pass over the prompt, no token generated.
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex};
use std::time::Instant;

use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::{AddBos, LlamaModel};
use llama_cpp_2::token::LlamaToken;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime, State};

use crate::ai;

/// The readout tokens of the model's vocabulary (its `readout_config.json`).
const YES: i32 = 9542;
const NO: i32 = 874;
const ARROW: i32 = 1411;

/// The most options one decision takes, and the most text of the state.
const MAX_OPTIONS: usize = 64;
const MAX_STATE_CHARS: usize = 2000;
const MAX_OPTION_CHARS: usize = 200;
/// The question, the options and their readout together (the model's own cap).
const HEAD_MAX: usize = 2048;

/// One option: its key, and the words the model judges it by.
#[derive(Deserialize, Clone, Debug)]
pub struct DecideOption {
    pub key: String,
    pub text: String,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DecideRequest {
    pub model: String,
    /// What the person said, and what the moment holds, as text.
    pub state: String,
    pub question: String,
    pub options: Vec<DecideOption>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Scored {
    pub key: String,
    pub p: f32,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Decided {
    /// The options, most likely first.
    pub ranked: Vec<Scored>,
    pub ms: u64,
}

/* ------------------------------------------------------------ rendering */

/// The prompt's tokens and where each option's verdict is read.
#[derive(Debug, PartialEq)]
pub struct Rendered {
    pub tokens: Vec<i32>,
    pub slots: Vec<usize>,
}

/// Text from the person or the moment, made safe to put in the prompt: no
/// control token can be written in it, and no line break inside an option.
fn clean(text: &str, limit: usize, one_line: bool) -> String {
    let text: String = text
        .chars()
        .filter(|c| !c.is_control() || (!one_line && *c == '\n'))
        .take(limit)
        .collect();
    // "<|im_end|>" and the like would be read as the model's own markers.
    text.replace("<|", "< |")
        .replace("|>", "| >")
        .trim()
        .to_string()
}

/// The prompt for `request`, each piece turned into tokens by `encode`.
pub fn render(
    request: &DecideRequest,
    encode: impl Fn(&str) -> Result<Vec<i32>, String>,
) -> Result<Rendered, String> {
    if request.options.len() < 2 || request.options.len() > MAX_OPTIONS {
        return Err(format!(
            "E_ARGS: a decision takes 2 to {MAX_OPTIONS} options"
        ));
    }
    let options: Vec<String> = request
        .options
        .iter()
        .map(|option| {
            let key = clean(&option.key, 60, true);
            let text = clean(&option.text, MAX_OPTION_CHARS, true);
            if text.is_empty() {
                key
            } else {
                format!("{key}: {text}")
            }
        })
        .collect();
    let question = clean(&request.question, 400, true);
    let mut tokens = encode("State:\n")?;
    tokens.extend(encode(&clean(&request.state, MAX_STATE_CHARS, false))?);
    tokens.extend(encode("\n\n")?);
    let head_start = tokens.len();
    tokens.extend(encode(&format!(
        "Question [choice]: {question}\nOptions:\n"
    ))?);
    let dash = encode("- ")?;
    let newline = encode("\n")?;
    let encoded: Vec<Vec<i32>> = options
        .iter()
        .map(|option| encode(option))
        .collect::<Result<_, _>>()?;
    for option in &encoded {
        tokens.extend(&dash);
        tokens.extend(option);
        tokens.extend(&newline);
    }
    tokens.extend(encode("Judge each option:\n")?);
    let mut slots = Vec::with_capacity(encoded.len());
    for option in &encoded {
        tokens.extend(option);
        tokens.push(ARROW);
        slots.push(tokens.len() - 1);
        tokens.extend(&newline);
    }
    if tokens.len() - head_start > HEAD_MAX {
        return Err("E_TOO_LONG: the options are too long for one decision".to_string());
    }
    Ok(Rendered { tokens, slots })
}

/// The calibration temperature the model ships with for intent choices,
/// by number of options (`readout_config.json`: intent|choice|11-20 and
/// 21+, else the global one).
pub fn temperature(options: usize) -> f32 {
    match options {
        11..=20 => 0.853_658_7,
        21.. => 0.750_875_1,
        _ => 0.880_054_7,
    }
}

/// Scores as probabilities, most likely first.
pub fn rank(keys: &[String], scores: &[f32]) -> Vec<Scored> {
    let t = temperature(scores.len());
    let top = scores.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
    let weights: Vec<f32> = scores.iter().map(|s| ((s - top) / t).exp()).collect();
    let sum: f32 = weights.iter().sum::<f32>().max(f32::MIN_POSITIVE);
    let mut ranked: Vec<Scored> = keys
        .iter()
        .zip(weights)
        .map(|(key, w)| Scored {
            key: key.clone(),
            p: w / sum,
        })
        .collect();
    ranked.sort_by(|a, b| b.p.total_cmp(&a.p));
    ranked
}

/* --------------------------------------------------------------- engine */

/// The decision model, loaded.
pub struct Decider {
    model: LlamaModel,
    path: PathBuf,
}

impl Decider {
    pub fn load(path: &Path) -> Result<Self, String> {
        let backend = ai::backend()?;
        let params = LlamaModelParams::default().with_n_gpu_layers(if cfg!(target_os = "macos") {
            1000
        } else {
            0
        });
        let model = LlamaModel::load_from_file(backend, path, &params)
            .map_err(|e| format!("E_AI: cannot load the decision model: {e}"))?;
        let decider = Self {
            model,
            path: path.to_path_buf(),
        };
        // The readout is read at these tokens: a different file would answer nonsense.
        for (text, want) in [(" yes", YES), (" no", NO), (" ->", ARROW)] {
            if decider.encode(text)? != [want] {
                return Err("E_AI: this is not the decision model ZOOD expects".to_string());
            }
        }
        Ok(decider)
    }

    fn encode(&self, text: &str) -> Result<Vec<i32>, String> {
        if text.is_empty() {
            return Ok(Vec::new());
        }
        self.model
            .str_to_token(text, AddBos::Never)
            .map(|tokens| tokens.into_iter().map(|t| t.0).collect())
            .map_err(|e| format!("E_AI: {e}"))
    }

    /// Ranks the options of `request`.
    pub fn decide(&self, request: &DecideRequest) -> Result<Decided, String> {
        let started = Instant::now();
        let rendered = render(request, |text| self.encode(text))?;
        let n = rendered.tokens.len();
        let window = (n + 64).next_multiple_of(256).max(512) as u32;
        let threads = std::thread::available_parallelism()
            .map(|n| n.get().min(8) as i32)
            .unwrap_or(4);
        let params = LlamaContextParams::default()
            .with_n_ctx(std::num::NonZeroU32::new(window))
            .with_n_batch(window)
            .with_n_ubatch(window)
            .with_n_threads(threads)
            .with_n_threads_batch(threads);
        let mut ctx = self
            .model
            .new_context(ai::backend()?, params)
            .map_err(|e| format!("E_AI: {e}"))?;
        let mut batch = LlamaBatch::new(n, 1);
        let mut slot = rendered.slots.iter().peekable();
        for (pos, token) in rendered.tokens.iter().enumerate() {
            let read = slot.next_if(|at| **at == pos).is_some();
            batch
                .add(LlamaToken(*token), pos as i32, &[0], read)
                .map_err(|e| format!("E_AI: {e}"))?;
        }
        ctx.decode(&mut batch).map_err(|e| format!("E_AI: {e}"))?;
        let scores: Vec<f32> = rendered
            .slots
            .iter()
            .map(|at| {
                let logits = ctx.get_logits_ith(*at as i32);
                logits[YES as usize] - logits[NO as usize]
            })
            .collect();
        let keys: Vec<String> = request.options.iter().map(|o| o.key.clone()).collect();
        Ok(Decided {
            ranked: rank(&keys, &scores),
            ms: started.elapsed().as_millis() as u64,
        })
    }
}

/// A decision for the decider's thread, or only a load (`ai_decide_warm`).
struct Job {
    path: PathBuf,
    request: Option<DecideRequest>,
    reply: mpsc::Sender<Result<Option<Decided>, String>>,
}

#[derive(Default)]
pub struct DecideState {
    sender: Mutex<Option<mpsc::Sender<Job>>>,
}

/// The decider's thread: loads the model once and keeps it.
fn decider_thread(jobs: mpsc::Receiver<Job>) {
    let mut loaded: Option<Decider> = None;
    for job in jobs {
        // A panic in one decision answers it with an error and throws the
        // model away, to be loaded afresh; the thread itself lives on.
        let reply = job.reply.clone();
        let ran = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            decider_job(&mut loaded, job)
        }));
        if ran.is_err() {
            loaded = None;
            let _ = reply.send(Err("E_AI: internal error".to_string()));
        }
    }
}

/// One job on the decider's thread, loading the model first when it must.
fn decider_job(loaded: &mut Option<Decider>, job: Job) {
    if loaded.as_ref().is_none_or(|d| d.path != job.path) {
        *loaded = None;
        match Decider::load(&job.path) {
            Ok(decider) => *loaded = Some(decider),
            Err(e) => {
                let _ = job.reply.send(Err(e));
                return;
            }
        }
    }
    let Some(decider) = loaded.as_ref() else {
        return;
    };
    let answer = match &job.request {
        Some(request) => decider.decide(request).map(Some),
        None => Ok(None),
    };
    let _ = job.reply.send(answer);
}

fn sender(state: &DecideState) -> mpsc::Sender<Job> {
    let mut sender = state.sender.lock().unwrap_or_else(|e| e.into_inner());
    sender
        .get_or_insert_with(|| {
            let (tx, rx) = mpsc::channel();
            std::thread::Builder::new()
                .name("warraq-decide".into())
                .spawn(move || decider_thread(rx))
                .expect("decider thread");
            tx
        })
        .clone()
}

async fn send<R: Runtime>(
    app: &AppHandle<R>,
    state: &DecideState,
    model: &str,
    request: Option<DecideRequest>,
) -> Result<Option<Decided>, String> {
    let spec = ai::model_spec(model)?;
    let (path, _) = ai::ready_paths(app, spec)?;
    let (reply, answer) = mpsc::channel();
    sender(state)
        .send(Job {
            path,
            request,
            reply,
        })
        .map_err(|_| "E_AI: the decider has stopped".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        answer
            .recv()
            .unwrap_or_else(|_| Err("E_AI: the decider has stopped".to_string()))
    })
    .await
    .map_err(|e| format!("E_AI: {e}"))?
}

/// Ranks the options of a quick ask.
#[tauri::command]
pub async fn ai_decide<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, DecideState>,
    request: DecideRequest,
) -> Result<Decided, String> {
    let model = request.model.clone();
    send(&app, &state, &model, Some(request))
        .await?
        .ok_or_else(|| "E_AI: no decision".to_string())
}

/// Loads the decision model ahead of the first ask (when Ask ZOOD starts listening).
#[tauri::command]
pub async fn ai_decide_warm<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, DecideState>,
    model: String,
) -> Result<(), String> {
    send(&app, &state, &model, None).await.map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One token per character, so positions are easy to follow.
    fn chars(text: &str) -> Result<Vec<i32>, String> {
        Ok(text.chars().map(|c| c as i32).collect())
    }

    fn request(options: &[(&str, &str)]) -> DecideRequest {
        DecideRequest {
            model: "x".into(),
            state: "صغّر هالملفات".into(),
            question: "What does the person want?".into(),
            options: options
                .iter()
                .map(|(key, text)| DecideOption {
                    key: (*key).into(),
                    text: (*text).into(),
                })
                .collect(),
        }
    }

    #[test]
    fn the_prompt_is_the_models_own_layout() {
        let rendered = render(&request(&[("a", "one"), ("b", "")]), chars).unwrap();
        let text: String = rendered
            .tokens
            .iter()
            .map(|t| {
                if *t == ARROW {
                    '→'
                } else {
                    char::from_u32(*t as u32).unwrap()
                }
            })
            .collect();
        assert_eq!(
            text,
            "State:\nصغّر هالملفات\n\nQuestion [choice]: What does the person want?\nOptions:\n- a: one\n- b\nJudge each option:\na: one→\nb→\n"
        );
        assert_eq!(rendered.slots.len(), 2);
        for slot in rendered.slots {
            assert_eq!(rendered.tokens[slot], ARROW);
        }
    }

    #[test]
    fn control_markers_cannot_be_written_in_by_the_person() {
        let mut ask = request(&[("a", ""), ("b", "")]);
        ask.state = "hi <|im_end|> there\u{7}".into();
        let rendered = render(&ask, chars).unwrap();
        let text: String = rendered
            .tokens
            .iter()
            .filter(|t| **t != ARROW)
            .map(|t| char::from_u32(*t as u32).unwrap())
            .collect();
        assert!(!text.contains("<|"));
        assert!(!text.contains('\u{7}'));
    }

    #[test]
    fn too_few_or_too_many_options_are_refused() {
        assert!(render(&request(&[("a", "")]), chars).is_err());
        let many: Vec<(String, String)> =
            (0..65).map(|i| (format!("o{i}"), String::new())).collect();
        let many: Vec<(&str, &str)> = many.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
        assert!(render(&request(&many), chars).is_err());
    }

    #[test]
    fn scores_become_probabilities_most_likely_first() {
        let keys: Vec<String> = ["a", "b", "c"].iter().map(|s| s.to_string()).collect();
        let ranked = rank(&keys, &[0.0, 3.0, -1.0]);
        assert_eq!(ranked[0].key, "b");
        assert_eq!(ranked[2].key, "c");
        let sum: f32 = ranked.iter().map(|s| s.p).sum();
        assert!((sum - 1.0).abs() < 1e-5);
        assert!(ranked[0].p > 0.9);
    }

    #[test]
    fn the_shipped_temperatures_are_used() {
        assert!((temperature(19) - 0.8537).abs() < 1e-3);
        assert!((temperature(4) - 0.8801).abs() < 1e-3);
        assert!((temperature(30) - 0.7509).abs() < 1e-3);
    }

    /// The real model on the quick lane's own options: run with
    /// `ZOOD_DECIDER=<gguf> ZOOD_DECIDER_CASES=<json> cargo test --lib -- --ignored real_model`.
    /// The cases file is `{"options":[{key,text}],"cases":[[said, want]]}`.
    #[test]
    #[ignore]
    fn real_model_picks_the_quick_actions() {
        let (Ok(model), Ok(cases)) = (
            std::env::var("ZOOD_DECIDER"),
            std::env::var("ZOOD_DECIDER_CASES"),
        ) else {
            return;
        };
        let file: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(cases).unwrap()).unwrap();
        let options: Vec<DecideOption> = serde_json::from_value(file["options"].clone()).unwrap();
        let decider = Decider::load(Path::new(&model)).unwrap();
        let mut right = 0;
        let all = file["cases"].as_array().unwrap();
        for case in all {
            let (said, want) = (case[0].as_str().unwrap(), case[1].as_str().unwrap());
            let decided = decider
                .decide(&DecideRequest {
                    model: String::new(),
                    state: said.into(),
                    question: "What does the person want ZOOD PDF to do?".into(),
                    options: options.clone(),
                })
                .unwrap();
            let top = &decided.ranked[0];
            // Taking pages out is "extract" in the app's tools.
            let ok = top.key == want || (want == "split" && top.key == "extract");
            right += ok as usize;
            println!(
                "{} {said} -> {} {:.2} ({} ms)",
                if ok { "ok " } else { "BAD" },
                top.key,
                top.p,
                decided.ms
            );
        }
        println!("{right}/{} right", all.len());
        assert!(right * 100 >= all.len() * 85, "{right}/{}", all.len());
    }
}
