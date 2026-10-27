//! Supertonic 3 (Supertone, model under OpenRAIL-M; sample code MIT,
//! https://github.com/supertone-inc/supertonic): one multilingual model,
//! Arabic and English among its 31 languages, read straight from the text's
//! letters — no phonemizer, so no espeak-ng. Four ONNX graphs: a duration
//! predictor, a text encoder, a flow-matching estimator run a few steps from
//! noise, and a vocoder. A voice is a "style" (two small tensors, a JSON
//! file); every voice speaks every language. About four times faster than
//! real time on four ordinary CPU cores, at 44.1 kHz.

use std::path::Path;

use ort::session::Session;
use ort::value::Tensor;
use serde::Deserialize;
use unicode_normalization::UnicodeNormalization;

use super::piper::session_builder;

/// The denoising steps: the project's own default, where the sound settles.
pub const STEPS: usize = 8;
/// Their examples speak a touch faster than the model's own pace.
const BASE_SPEED: f32 = 1.05;
/// The longest piece read at once, in characters; longer text is cut at its
/// pauses and the pieces joined with a short silence.
const MAX_CHARS: usize = 300;
const GAP_SECONDS: f32 = 0.25;

#[derive(Deserialize)]
struct Config {
    ae: Ae,
    ttl: Ttl,
}

#[derive(Deserialize)]
struct Ae {
    sample_rate: u32,
    base_chunk_size: usize,
}

#[derive(Deserialize)]
struct Ttl {
    latent_dim: usize,
    chunk_compress_factor: usize,
}

#[derive(Deserialize)]
struct Tensor3 {
    dims: Vec<usize>,
    data: serde_json::Value,
}

#[derive(Deserialize)]
struct StyleFile {
    style_ttl: Tensor3,
    style_dp: Tensor3,
}

/// A voice: its two style tensors, shape and values.
pub struct Style {
    ttl: (Vec<usize>, Vec<f32>),
    dp: (Vec<usize>, Vec<f32>),
}

fn flatten(value: &serde_json::Value, out: &mut Vec<f32>) {
    match value {
        serde_json::Value::Array(items) => items.iter().for_each(|v| flatten(v, out)),
        serde_json::Value::Number(n) => out.push(n.as_f64().unwrap_or(0.0) as f32),
        _ => {}
    }
}

fn tensor(t: &Tensor3) -> Result<(Vec<usize>, Vec<f32>), String> {
    let mut data = Vec::new();
    flatten(&t.data, &mut data);
    if t.dims.is_empty() || t.dims.iter().product::<usize>() != data.len() {
        return Err("E_SPEECH: the voice's style does not match its shape".into());
    }
    Ok((t.dims.clone(), data))
}

impl Style {
    pub fn load(path: &Path) -> Result<Self, String> {
        let text =
            std::fs::read_to_string(path).map_err(|e| format!("E_IO: {}: {e}", path.display()))?;
        Self::parse(&text)
    }

    pub fn parse(text: &str) -> Result<Self, String> {
        let file: StyleFile =
            serde_json::from_str(text).map_err(|e| format!("E_SPEECH: the voice's style: {e}"))?;
        Ok(Self {
            ttl: tensor(&file.style_ttl)?,
            dp: tensor(&file.style_dp)?,
        })
    }
}

pub struct Model {
    duration: Session,
    encoder: Session,
    estimator: Session,
    vocoder: Session,
    /// Model input id of each UTF-16 code unit; negative where unknown.
    indexer: Vec<i64>,
    pub sample_rate: u32,
    chunk: usize,
    latent_channels: usize,
}

/// The files of the model, in its folder.
pub const FILES: [&str; 6] = [
    "duration_predictor.onnx",
    "text_encoder.onnx",
    "vector_estimator.onnx",
    "vocoder.onnx",
    "tts.json",
    "unicode_indexer.json",
];

impl Model {
    /// The model from the folder its files are kept in, under their own names.
    pub fn load(dir: &Path) -> Result<Self, String> {
        let file = |name: &str| dir.join(name);
        let read = |name: &str| {
            let path = file(name);
            std::fs::read_to_string(&path).map_err(|e| format!("E_IO: {}: {e}", path.display()))
        };
        let config: Config = serde_json::from_str(&read("tts.json")?)
            .map_err(|e| format!("E_SPEECH: the model's settings: {e}"))?;
        let indexer: Vec<i64> = serde_json::from_str(&read("unicode_indexer.json")?)
            .map_err(|e| format!("E_SPEECH: the model's letters: {e}"))?;
        let open = |name: &str| {
            session_builder()?
                .commit_from_file(file(name))
                .map_err(|e| format!("E_SPEECH: {e}"))
        };
        Ok(Self {
            duration: open("duration_predictor.onnx")?,
            encoder: open("text_encoder.onnx")?,
            estimator: open("vector_estimator.onnx")?,
            vocoder: open("vocoder.onnx")?,
            indexer,
            sample_rate: config.ae.sample_rate,
            chunk: config.ae.base_chunk_size * config.ttl.chunk_compress_factor,
            latent_channels: config.ttl.latent_dim * config.ttl.chunk_compress_factor,
        })
    }

    /// Speaks `text` in `lang` ("ar", "en") with `style` at `rate` (1
    /// normal, 0.5 to 3): float samples at `sample_rate`.
    pub fn speak(
        &mut self,
        text: &str,
        lang: &str,
        style: &Style,
        rate: f32,
    ) -> Result<Vec<f32>, String> {
        let rate = if rate.is_finite() {
            rate.clamp(0.5, 3.0)
        } else {
            1.0
        };
        let mut out = Vec::new();
        let mut noise = Noise::seeded();
        for piece in pieces(&prepare(text), MAX_CHARS) {
            let ids = text_ids(&self.indexer, &wrap(&piece, lang));
            if ids.len() <= wrap("", lang).encode_utf16().count() {
                continue;
            }
            let samples = self.piece(&ids, style, BASE_SPEED * rate, &mut noise)?;
            if !out.is_empty() && !samples.is_empty() {
                out.extend(std::iter::repeat_n(
                    0.0,
                    (GAP_SECONDS * self.sample_rate as f32) as usize,
                ));
            }
            out.extend(samples);
        }
        Ok(out)
    }

    fn piece(
        &mut self,
        ids: &[i64],
        style: &Style,
        speed: f32,
        noise: &mut Noise,
    ) -> Result<Vec<f32>, String> {
        let n = ids.len();
        let ids_t = || Tensor::from_array(([1usize, n], ids.to_vec())).map_err(err);
        let mask_t = || Tensor::from_array(([1usize, 1, n], vec![1.0f32; n])).map_err(err);
        let style_t = |(dims, data): &(Vec<usize>, Vec<f32>)| {
            Tensor::from_array((dims.clone(), data.clone())).map_err(err)
        };

        let outputs = self
            .duration
            .run(ort::inputs![
                "text_ids" => ids_t()?,
                "style_dp" => style_t(&style.dp)?,
                "text_mask" => mask_t()?,
            ])
            .map_err(err)?;
        let (_, duration) = outputs[0].try_extract_tensor::<f32>().map_err(err)?;
        let seconds = (duration.first().copied().unwrap_or(0.0) / speed).clamp(0.0, 60.0);
        drop(outputs);
        let length = (seconds * self.sample_rate as f32) as usize;
        let latent = length.div_ceil(self.chunk).max(1);

        let outputs = self
            .encoder
            .run(ort::inputs![
                "text_ids" => ids_t()?,
                "style_ttl" => style_t(&style.ttl)?,
                "text_mask" => mask_t()?,
            ])
            .map_err(err)?;
        let (emb_shape, emb) = outputs[0].try_extract_tensor::<f32>().map_err(err)?;
        let emb_dims: Vec<usize> = emb_shape.iter().map(|d| *d as usize).collect();
        let emb = emb.to_vec();
        drop(outputs);

        let channels = self.latent_channels;
        let mut xt: Vec<f32> = (0..channels * latent).map(|_| noise.normal()).collect();
        for step in 0..STEPS {
            let outputs = self
                .estimator
                .run(ort::inputs![
                    "noisy_latent" => Tensor::from_array(([1usize, channels, latent], xt)).map_err(err)?,
                    "text_emb" => Tensor::from_array((emb_dims.clone(), emb.clone())).map_err(err)?,
                    "style_ttl" => style_t(&style.ttl)?,
                    "text_mask" => mask_t()?,
                    "latent_mask" => Tensor::from_array(([1usize, 1, latent], vec![1.0f32; latent])).map_err(err)?,
                    "current_step" => Tensor::from_array(([1usize], vec![step as f32])).map_err(err)?,
                    "total_step" => Tensor::from_array(([1usize], vec![STEPS as f32])).map_err(err)?,
                ])
                .map_err(err)?;
            let (_, next) = outputs[0].try_extract_tensor::<f32>().map_err(err)?;
            xt = next.to_vec();
        }

        let outputs = self
            .vocoder
            .run(ort::inputs![
                "latent" => Tensor::from_array(([1usize, channels, latent], xt)).map_err(err)?,
            ])
            .map_err(err)?;
        let (_, wav) = outputs[0].try_extract_tensor::<f32>().map_err(err)?;
        Ok(wav[..length.min(wav.len())].to_vec())
    }
}

/// The text as the model was trained on it: decomposed (NFKD), dashes,
/// quotes and brackets made plain, emoji and stray symbols dropped, spaces
/// collapsed, and a closing mark so the voice comes to rest.
pub fn prepare(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.nfkd() {
        let c = match c {
            '–' | '‑' | '—' => '-',
            '“' | '”' | '«' | '»' => '"',
            '‘' | '’' | '´' | '`' => '\'',
            '_' | '[' | ']' | '|' | '/' | '#' | '→' | '←' | '\\' => ' ',
            '@' => {
                out.push_str(" at ");
                continue;
            }
            c if is_emoji(c) || matches!(c, '♥' | '☆' | '♡' | '©') => continue,
            c if c.is_whitespace() => ' ',
            c => c,
        };
        out.push(c);
    }
    let mut text = out.split_whitespace().collect::<Vec<_>>().join(" ");
    for (from, to) in [
        (" ,", ","),
        (" .", "."),
        (" !", "!"),
        (" ?", "?"),
        (" ;", ";"),
        (" :", ":"),
        (" ،", "،"),
        (" ؟", "؟"),
    ] {
        text = text.replace(from, to);
    }
    let ends = |c: char| ".!?;:,'\")]}…。؟،".contains(c);
    if !text.is_empty() && !text.ends_with(ends) {
        text.push('.');
    }
    text
}

fn is_emoji(c: char) -> bool {
    matches!(c as u32,
        0x1F300..=0x1FAFF | 0x2600..=0x27BF | 0x1F1E6..=0x1F1FF)
}

fn wrap(text: &str, lang: &str) -> String {
    format!("<{lang}>{text}</{lang}>")
}

/// The model's ids of `text`, a UTF-16 code unit each; what it does not
/// know is left out.
pub fn text_ids(indexer: &[i64], text: &str) -> Vec<i64> {
    text.encode_utf16()
        .filter_map(|unit| indexer.get(unit as usize).copied())
        .filter(|id| *id >= 0)
        .collect()
}

/// `text` in pieces of at most `max` characters, cut after a sentence's
/// end where it can be, else after a comma, else at a space.
pub fn pieces(text: &str, max: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest: Vec<char> = text.chars().collect();
    while rest.len() > max {
        let window = &rest[..max];
        let cut = [".!?؟…", ",;:،؛", " "]
            .iter()
            .find_map(|marks| {
                window
                    .iter()
                    .rposition(|c| marks.contains(*c))
                    .filter(|at| *at >= max / 3)
            })
            .map_or(max, |at| at + 1);
        let piece: String = rest.drain(..cut).collect();
        if !piece.trim().is_empty() {
            out.push(piece.trim().to_string());
        }
    }
    let last: String = rest.into_iter().collect();
    if !last.trim().is_empty() {
        out.push(last.trim().to_string());
    }
    out
}

/// Gaussian noise for the estimator's starting point: xorshift and
/// Box–Muller, seeded from the clock. Its quality hardly matters; each
/// sentence starts from fresh noise.
struct Noise {
    state: u64,
    spare: Option<f32>,
}

impl Noise {
    fn seeded() -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0x9E37_79B9_7F4A_7C15, |d| d.as_nanos() as u64);
        Self::with_seed(nanos)
    }

    fn with_seed(seed: u64) -> Self {
        Self {
            state: seed | 1,
            spare: None,
        }
    }

    fn uniform(&mut self) -> f32 {
        self.state ^= self.state << 13;
        self.state ^= self.state >> 7;
        self.state ^= self.state << 17;
        // 24 bits in (0, 1].
        ((self.state >> 40) as f32 + 1.0) / 16_777_216.0
    }

    fn normal(&mut self) -> f32 {
        if let Some(spare) = self.spare.take() {
            return spare;
        }
        let (u, v) = (self.uniform(), self.uniform());
        let radius = (-2.0 * u.ln()).sqrt();
        let angle = std::f32::consts::TAU * v;
        self.spare = Some(radius * angle.sin());
        radius * angle.cos()
    }
}

/// Float audio to 16-bit at the level the model made it, clipped.
pub fn to_pcm(audio: &[f32]) -> Vec<i16> {
    audio
        .iter()
        .map(|s| (s.clamp(-1.0, 1.0) * 32767.0) as i16)
        .collect()
}

fn err(e: impl std::fmt::Display) -> String {
    format!("E_SPEECH: {e}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_is_made_plain_and_ends_at_rest() {
        assert_eq!(prepare("  Hello —  world  "), "Hello - world.");
        assert_eq!(prepare("“Quoted” 🙂 text!"), "\"Quoted\" text!");
        assert_eq!(prepare("مرحبا ، كيف حالك ؟"), "مرحبا، كيف حالك؟");
        assert_eq!(prepare("a@b"), "a at b.");
        assert_eq!(prepare(""), "");
    }

    #[test]
    fn ids_follow_the_indexer_and_skip_unknown_letters() {
        let mut indexer = vec![-1i64; 0x700];
        indexer['a' as usize] = 5;
        indexer['<' as usize] = 1;
        indexer['م' as usize] = 9;
        assert_eq!(text_ids(&indexer, "a?م<"), vec![5, 9, 1]);
        // Beyond the indexer is unknown too.
        assert_eq!(text_ids(&indexer, "\u{FFFF}"), Vec::<i64>::new());
    }

    #[test]
    fn long_text_is_cut_at_its_pauses() {
        let sentence = "This is one sentence that goes on. ";
        let text = sentence.repeat(20);
        let cut = pieces(text.trim(), 120);
        assert!(cut.len() > 1);
        assert!(cut.iter().all(|p| p.chars().count() <= 120));
        assert!(cut.iter().all(|p| p.ends_with('.')));
        assert_eq!(cut.join(" "), text.trim());
        let endless = "a".repeat(250);
        assert!(pieces(&endless, 100).iter().all(|p| p.len() <= 100));
        assert_eq!(pieces("short.", 100), vec!["short.".to_string()]);
        assert!(pieces("   ", 100).is_empty());
    }

    #[test]
    fn noise_is_roughly_standard_normal() {
        let mut noise = Noise::with_seed(42);
        let draws: Vec<f32> = (0..20_000).map(|_| noise.normal()).collect();
        let mean = draws.iter().sum::<f32>() / draws.len() as f32;
        let var = draws.iter().map(|x| (x - mean) * (x - mean)).sum::<f32>() / draws.len() as f32;
        assert!(mean.abs() < 0.05, "mean {mean}");
        assert!((var - 1.0).abs() < 0.08, "variance {var}");
        assert!(draws.iter().all(|x| x.is_finite()));
    }

    #[test]
    fn a_style_file_is_read_with_its_shapes() {
        let style = Style::parse(
            r#"{"style_ttl":{"dims":[1,2,2],"data":[[[1,2],[3,4]]]},"style_dp":{"dims":[1,1,2],"data":[[[0.5,0.25]]]},"metadata":{}}"#,
        )
        .unwrap();
        assert_eq!(style.ttl, (vec![1, 2, 2], vec![1.0, 2.0, 3.0, 4.0]));
        assert_eq!(style.dp.1, vec![0.5, 0.25]);
        assert!(Style::parse(
            r#"{"style_ttl":{"dims":[1,3],"data":[1]},"style_dp":{"dims":[1],"data":[1]}}"#
        )
        .is_err());
    }

    #[test]
    fn audio_keeps_its_level_and_is_clipped() {
        assert_eq!(to_pcm(&[0.5, -2.0, 0.0]), vec![16383, -32767, 0]);
    }

    /// The real model, by hand: `ZOOD_SUPERTONIC_DIR` holds its files
    /// (`onnx/` and `voice_styles/` flattened into one folder), and each
    /// line of `ZOOD_SUPERTONIC_TEXTS` (`lang<TAB>name<TAB>text`) is written
    /// there as `out-<name>.wav`, with the time each took.
    #[test]
    #[ignore]
    fn speaks_with_the_real_model() {
        let dir = std::path::PathBuf::from(std::env::var("ZOOD_SUPERTONIC_DIR").unwrap());
        let texts =
            std::fs::read_to_string(std::env::var("ZOOD_SUPERTONIC_TEXTS").unwrap()).unwrap();
        let voice = std::env::var("ZOOD_SUPERTONIC_VOICE").unwrap_or_else(|_| "F1".into());
        let mut model = Model::load(&dir).unwrap();
        let style = Style::load(&dir.join(format!("{voice}.json"))).unwrap();
        for line in texts.lines().filter(|l| !l.trim().is_empty()) {
            let mut parts = line.splitn(3, '\t');
            let (lang, name, text) = (
                parts.next().unwrap(),
                parts.next().unwrap(),
                parts.next().unwrap(),
            );
            let text = if lang == "ar" {
                super::super::arabic::spell_numbers(text)
            } else {
                text.to_string()
            };
            let started = std::time::Instant::now();
            let rate = std::env::var("ZOOD_SUPERTONIC_RATE")
                .ok()
                .and_then(|r| r.parse().ok())
                .unwrap_or(1.0);
            let (voice_rate, quicker) = super::super::stretch::split(rate);
            let samples = model.speak(&text, lang, &style, voice_rate).unwrap();
            let samples = super::super::stretch::faster(&samples, quicker, model.sample_rate);
            let seconds = samples.len() as f32 / model.sample_rate as f32;
            println!(
                "{name}: {seconds:.2} s of speech in {:.2} s",
                started.elapsed().as_secs_f32()
            );
            assert!(seconds > 0.5);
            std::fs::write(
                dir.join(format!("out-{voice}--{name}.wav")),
                super::super::piper::wav(&to_pcm(&samples), model.sample_rate),
            )
            .unwrap();
        }
    }
}
