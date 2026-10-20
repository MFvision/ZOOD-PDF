//! A Piper voice (VITS, as ONNX): phonemes in, 16-bit audio out. The voice's
//! own config (`*.onnx.json`) gives its phoneme ids, sample rate and
//! default scales.

use std::collections::HashMap;
use std::path::Path;

use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::value::Tensor;
use serde::Deserialize;

#[derive(Deserialize)]
struct Config {
    audio: Audio,
    #[serde(default)]
    inference: Inference,
    phoneme_id_map: HashMap<String, Vec<i64>>,
}

#[derive(Deserialize)]
struct Audio {
    sample_rate: u32,
}

#[derive(Deserialize)]
struct Inference {
    noise_scale: f32,
    length_scale: f32,
    noise_w: f32,
}

impl Default for Inference {
    fn default() -> Self {
        Self {
            noise_scale: 0.667,
            length_scale: 1.0,
            noise_w: 0.8,
        }
    }
}

pub struct Voice {
    session: Session,
    ids: HashMap<char, Vec<i64>>,
    pub sample_rate: u32,
    inference: Inference,
}

/// The phonemes a sentence may hold before it is cut: a long run-on line
/// would otherwise hold the CPU for many seconds.
const MAX_PHONEMES: usize = 1500;

pub fn session_builder() -> Result<ort::session::builder::SessionBuilder, String> {
    let threads = std::thread::available_parallelism().map_or(2, |n| n.get().clamp(1, 4));
    let builder = Session::builder()
        .map_err(err)?
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .map_err(err)?;
    builder.with_intra_threads(threads).map_err(err)
}

impl Voice {
    pub fn load(model: &Path, config: &Path) -> Result<Self, String> {
        let text = std::fs::read_to_string(config)
            .map_err(|e| format!("E_IO: {}: {e}", config.display()))?;
        let config: Config = serde_json::from_str(&text)
            .map_err(|e| format!("E_SPEECH: the voice's settings: {e}"))?;
        let session = session_builder()?.commit_from_file(model).map_err(err)?;
        let ids = config
            .phoneme_id_map
            .into_iter()
            .filter_map(|(k, v)| {
                let mut chars = k.chars();
                match (chars.next(), chars.next()) {
                    (Some(c), None) => Some((c, v)),
                    _ => None,
                }
            })
            .collect();
        Ok(Self {
            session,
            ids,
            sample_rate: config.audio.sample_rate,
            inference: config.inference,
        })
    }

    /// The model's input: start, each known phoneme followed by the pad, end.
    pub fn phoneme_ids(&self, phonemes: &[char]) -> Vec<i64> {
        phoneme_ids(&self.ids, phonemes)
    }

    /// Speaks `phonemes` at `rate` (1 normal, 0.5 to 2), as 16-bit samples.
    pub fn speak(&mut self, phonemes: &[char], rate: f32) -> Result<Vec<i16>, String> {
        let ids = self.phoneme_ids(&phonemes[..phonemes.len().min(MAX_PHONEMES)]);
        if ids.len() <= 3 {
            return Ok(Vec::new());
        }
        let rate = if rate.is_finite() {
            rate.clamp(0.5, 2.0)
        } else {
            1.0
        };
        let n = ids.len();
        let scales = vec![
            self.inference.noise_scale,
            self.inference.length_scale / rate,
            self.inference.noise_w,
        ];
        let outputs = self
            .session
            .run(ort::inputs![
                "input" => Tensor::from_array(([1usize, n], ids)).map_err(err)?,
                "input_lengths" => Tensor::from_array(([1usize], vec![n as i64])).map_err(err)?,
                "scales" => Tensor::from_array(([3usize], scales)).map_err(err)?,
            ])
            .map_err(err)?;
        let (_, audio) = outputs[0].try_extract_tensor::<f32>().map_err(err)?;
        Ok(to_pcm(audio))
    }
}

pub fn phoneme_ids(map: &HashMap<char, Vec<i64>>, phonemes: &[char]) -> Vec<i64> {
    let pad = map.get(&'_').cloned().unwrap_or_default();
    let mut ids = map.get(&'^').cloned().unwrap_or_default();
    ids.extend(&pad);
    for c in phonemes {
        if let Some(id) = map.get(c) {
            ids.extend(id);
            ids.extend(&pad);
        }
    }
    ids.extend(map.get(&'$').cloned().unwrap_or_default());
    ids
}

/// Float audio to 16-bit, scaled as Piper does: to the loudest sample,
/// never louder than full scale.
pub fn to_pcm(audio: &[f32]) -> Vec<i16> {
    let peak = audio.iter().fold(0.01f32, |m, s| m.max(s.abs()));
    let gain = 32767.0 / peak;
    audio
        .iter()
        .map(|s| (s * gain).clamp(-32768.0, 32767.0) as i16)
        .collect()
}

/// A mono 16-bit WAV file of `samples`, for the webview to play.
pub fn wav(samples: &[i16], sample_rate: u32) -> Vec<u8> {
    let data = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data as usize);
    out.extend(b"RIFF");
    out.extend((36 + data).to_le_bytes());
    out.extend(b"WAVEfmt ");
    out.extend(16u32.to_le_bytes());
    out.extend(1u16.to_le_bytes()); // PCM
    out.extend(1u16.to_le_bytes()); // mono
    out.extend(sample_rate.to_le_bytes());
    out.extend((sample_rate * 2).to_le_bytes());
    out.extend(2u16.to_le_bytes());
    out.extend(16u16.to_le_bytes());
    out.extend(b"data");
    out.extend(data.to_le_bytes());
    for s in samples {
        out.extend(s.to_le_bytes());
    }
    out
}

fn err(e: impl std::fmt::Display) -> String {
    format!("E_SPEECH: {e}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_start_pad_each_phoneme_and_end() {
        let map: HashMap<char, Vec<i64>> = [
            ('^', vec![1]),
            ('_', vec![0]),
            ('$', vec![2]),
            ('a', vec![14]),
        ]
        .into_iter()
        .collect();
        assert_eq!(
            phoneme_ids(&map, &['a', 'z', 'a']),
            vec![1, 0, 14, 0, 14, 0, 2]
        );
    }

    #[test]
    fn audio_is_scaled_to_full_volume_and_written_as_wav() {
        assert_eq!(to_pcm(&[0.5, -0.25]), vec![32767, -16383]);
        let file = wav(&[0, 1, -1], 22050);
        assert_eq!(&file[..4], b"RIFF");
        assert_eq!(file.len(), 44 + 6);
        assert_eq!(u32::from_le_bytes(file[24..28].try_into().unwrap()), 22050);
    }
}
