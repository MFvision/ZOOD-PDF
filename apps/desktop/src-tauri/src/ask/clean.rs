//! What the microphone heard, made ready for the model that hears: the
//! hum and rumble below speech taken out, the silence before and after the
//! words cut away, a long pause to think in the middle shortened to a
//! breath (a model left with seconds of room noise starts making words up),
//! a quiet or far-off voice brought up to a steady level,
//! and the sound brought down to the model's 16 kHz through a proper
//! low-pass filter — a straight line between samples folds a microphone's
//! hiss above 8 kHz back down onto the voice.
//!
//! Plain arithmetic on the samples, kept in memory like the recording
//! itself. `ask_transcribe` runs it before every transcription.

/// The rate the hearing model reads.
pub const MODEL_RATE: u32 = 16_000;

/// The level speech is brought to: its loud stretches near -20 dBFS.
const TARGET_RMS: f32 = 0.1;
/// The most a quiet voice is raised (about +30 dB): beyond it is mostly room.
const MAX_GAIN: f32 = 30.0;
/// A loud voice is never lowered below this share of where it was.
const MIN_GAIN: f32 = 0.5;
/// Kept before the first word and after the last, so neither is clipped.
const LEAD_SECONDS: f32 = 0.25;
const TAIL_SECONDS: f32 = 0.4;
/// The stretch loudness is measured over.
const FRAME_SECONDS: f32 = 0.02;

/// `samples` at `rate` a second, ready for the model, at `MODEL_RATE`.
pub fn for_model(samples: &[f32], rate: u32) -> Vec<f32> {
    if samples.is_empty() || rate == 0 {
        return Vec::new();
    }
    let filtered = high_pass(samples, rate, 70.0);
    let spoken = shorten_pauses(trim(&filtered, rate), rate);
    let level = levelled(&spoken);
    resample(&level, rate, MODEL_RATE)
}

/// A gentle high-pass (one pole, `cutoff` Hz), which also takes out a
/// microphone's constant offset.
pub fn high_pass(samples: &[f32], rate: u32, cutoff: f32) -> Vec<f32> {
    let rc = 1.0 / (std::f32::consts::TAU * cutoff);
    let dt = 1.0 / rate as f32;
    let alpha = rc / (rc + dt);
    let mut out = Vec::with_capacity(samples.len());
    let (mut last_in, mut last_out) = (samples[0], 0.0f32);
    for &s in samples {
        let y = alpha * (last_out + s - last_in);
        out.push(y);
        last_in = s;
        last_out = y;
    }
    out
}

fn frame_rms(samples: &[f32], rate: u32) -> (usize, Vec<f32>) {
    let size = ((rate as f32 * FRAME_SECONDS) as usize).max(1);
    let rms = samples
        .chunks(size)
        .map(|frame| (frame.iter().map(|s| s * s).sum::<f32>() / frame.len() as f32).sqrt())
        .collect();
    (size, rms)
}

/// The stretch from a little before the first word to a little after the
/// last. A word is a frame clearly louder than the room: three times the
/// quietest tenth, and at least a twentieth of the loudest. Nothing heard
/// above the room leaves the sound as it was.
pub fn trim(samples: &[f32], rate: u32) -> &[f32] {
    let (size, rms) = frame_rms(samples, rate);
    if rms.len() < 3 {
        return samples;
    }
    let threshold = threshold(&rms);
    let (Some(first), Some(last)) = (
        rms.iter().position(|r| *r > threshold),
        rms.iter().rposition(|r| *r > threshold),
    ) else {
        return samples;
    };
    let start = (first * size).saturating_sub((LEAD_SECONDS * rate as f32) as usize);
    let end = ((last + 1) * size + (TAIL_SECONDS * rate as f32) as usize).min(samples.len());
    &samples[start..end]
}

/// A pause longer than this, between words, is someone thinking.
const LONG_PAUSE_SECONDS: f32 = 0.7;
/// What is kept of it: a breath between two thoughts.
const KEPT_PAUSE_SECONDS: f32 = 0.35;

/// The room's level and the words' threshold, as `trim` finds them.
fn threshold(rms: &[f32]) -> f32 {
    let mut sorted = rms.to_vec();
    sorted.sort_by(f32::total_cmp);
    let floor = sorted[sorted.len() / 10];
    let peak = sorted[sorted.len() - 1];
    (floor * 3.0).max(peak * 0.05).max(1e-4)
}

/// `samples` with every pause longer than `LONG_PAUSE_SECONDS` between
/// words cut down to `KEPT_PAUSE_SECONDS`, half of it each side of the cut.
pub fn shorten_pauses(samples: &[f32], rate: u32) -> Vec<f32> {
    let (size, rms) = frame_rms(samples, rate);
    if rms.len() < 3 {
        return samples.to_vec();
    }
    let loud = threshold(&rms);
    let long = (LONG_PAUSE_SECONDS / FRAME_SECONDS) as usize;
    let keep_each_side = ((KEPT_PAUSE_SECONDS / 2.0) * rate as f32) as usize;
    let mut out = Vec::with_capacity(samples.len());
    let mut copied = 0;
    let mut i = 0;
    while i < rms.len() {
        if rms[i] > loud {
            i += 1;
            continue;
        }
        let start = i;
        while i < rms.len() && rms[i] <= loud {
            i += 1;
        }
        // Only a pause with words on both sides; the ends are `trim`'s.
        if start > 0 && i < rms.len() && i - start >= long {
            let cut_from = start * size + keep_each_side;
            let cut_to = (i * size).saturating_sub(keep_each_side);
            if cut_to > cut_from {
                out.extend_from_slice(&samples[copied..cut_from]);
                copied = cut_to;
            }
        }
    }
    out.extend_from_slice(&samples[copied..]);
    out
}

/// The voice at a steady level: its loud stretches (the 90th percentile of
/// frames, so a cough does not set it) near `TARGET_RMS`, raised at most
/// `MAX_GAIN`, and any peak the raise would clip rounded off softly.
pub fn levelled(samples: &[f32]) -> Vec<f32> {
    let (_, rms) = frame_rms(samples, MODEL_RATE);
    if rms.is_empty() {
        return samples.to_vec();
    }
    let mut sorted = rms;
    sorted.sort_by(f32::total_cmp);
    let loud = sorted[(sorted.len() * 9 / 10).min(sorted.len() - 1)];
    if loud <= 1e-5 {
        return samples.to_vec();
    }
    let gain = (TARGET_RMS / loud).clamp(MIN_GAIN, MAX_GAIN);
    samples.iter().map(|s| soft_clip(s * gain)).collect()
}

/// Leaves the voice's range alone and rounds anything past 0.9 smoothly
/// toward full scale, never beyond it.
fn soft_clip(x: f32) -> f32 {
    const KNEE: f32 = 0.9;
    let a = x.abs();
    if a <= KNEE {
        return x;
    }
    let over = (a - KNEE) / (1.0 - KNEE);
    x.signum() * (KNEE + (1.0 - KNEE) * over.tanh())
}

/// `samples` at `from` a second, at `to` a second, through a windowed-sinc
/// filter that cuts what the new rate cannot hold before it could fold
/// back as noise.
pub fn resample(samples: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || from == 0 || to == 0 || samples.is_empty() {
        return samples.to_vec();
    }
    let step = f64::from(from) / f64::from(to);
    // The filter's cutoff as a share of the input's Nyquist frequency: a
    // little under the lower of the two rates' halves.
    let cutoff = (f64::from(to) / f64::from(from)).min(1.0) * 0.92;
    // Twelve zero crossings each side of the centre.
    let half = (12.0 / cutoff).ceil() as isize;
    let count = (samples.len() as f64 / step).floor() as usize;
    let last = samples.len() as isize - 1;
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        let centre = i as f64 * step;
        let base = centre.floor() as isize;
        let mut sum = 0.0f64;
        let mut weights = 0.0f64;
        for k in (base - half + 1)..=(base + half) {
            if k < 0 || k > last {
                continue;
            }
            let x = centre - k as f64;
            let w = cutoff * sinc(cutoff * x) * blackman(x, half as f64);
            sum += f64::from(samples[k as usize]) * w;
            weights += w;
        }
        // Normalised by the weights, so the edges keep their level.
        out.push(if weights.abs() > 1e-9 {
            (sum / weights) as f32
        } else {
            0.0
        });
    }
    out
}

fn sinc(x: f64) -> f64 {
    if x.abs() < 1e-9 {
        1.0
    } else {
        let px = std::f64::consts::PI * x;
        px.sin() / px
    }
}

/// The Blackman window over -`half`..`half`.
fn blackman(x: f64, half: f64) -> f64 {
    if x.abs() >= half {
        return 0.0;
    }
    let t = (x + half) / (2.0 * half);
    let tau = std::f64::consts::TAU;
    0.42 - 0.5 * (tau * t).cos() + 0.08 * (2.0 * tau * t).cos()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(freq: f32, rate: u32, seconds: f32, amp: f32) -> Vec<f32> {
        (0..(rate as f32 * seconds) as usize)
            .map(|i| amp * (std::f32::consts::TAU * freq * i as f32 / rate as f32).sin())
            .collect()
    }

    fn rms(s: &[f32]) -> f32 {
        (s.iter().map(|x| x * x).sum::<f32>() / s.len().max(1) as f32).sqrt()
    }

    #[test]
    fn speech_frequencies_pass_the_resampler_and_hiss_above_8k_does_not_fold_back() {
        // 1 kHz is speech: it comes through at its level.
        let voice = resample(&tone(1000.0, 48_000, 1.0, 0.5), 48_000, 16_000);
        assert_eq!(voice.len(), 16_000);
        let middle = &voice[1000..15_000];
        assert!(
            (rms(middle) - 0.5 / 2f32.sqrt()).abs() < 0.02,
            "{}",
            rms(middle)
        );
        // 13 kHz cannot exist at 16 kHz: a straight line would fold it to
        // 3 kHz at nearly full level; the filter leaves almost nothing.
        let hiss = resample(&tone(13_000.0, 48_000, 1.0, 0.5), 48_000, 16_000);
        assert!(
            rms(&hiss[1000..15_000]) < 0.01,
            "{}",
            rms(&hiss[1000..15_000])
        );
        // Rates that do not divide evenly, and up.
        assert_eq!(
            resample(&tone(440.0, 44_100, 1.0, 0.5), 44_100, 16_000).len(),
            16_000
        );
        assert_eq!(resample(&[0.0; 100], 8_000, 16_000).len(), 200);
        assert!(resample(&[], 48_000, 16_000).is_empty());
        assert_eq!(resample(&[0.25, 0.5], 16_000, 16_000), vec![0.25, 0.5]);
    }

    #[test]
    fn silence_around_the_words_is_cut_but_the_words_are_kept_whole() {
        let rate = 16_000;
        let mut sound = vec![0.001f32; rate as usize * 2];
        sound.extend(tone(300.0, rate, 1.0, 0.3));
        sound.extend(vec![0.001f32; rate as usize * 3]);
        let kept = trim(&sound, rate);
        let seconds = kept.len() as f32 / rate as f32;
        assert!((1.6..1.8).contains(&seconds), "{seconds}");
        // The whole tone is inside.
        assert!(rms(kept) > 0.15);
        // Silence alone stays as it was.
        let quiet = vec![0.0f32; 16_000];
        assert_eq!(trim(&quiet, rate).len(), quiet.len());
    }

    #[test]
    fn a_long_pause_to_think_is_cut_to_a_breath_and_short_ones_stay() {
        let rate = 16_000;
        let word = tone(300.0, rate, 0.5, 0.3);
        let pause = |seconds: f32| vec![0.0005f32; (rate as f32 * seconds) as usize];
        let mut thinking = word.clone();
        thinking.extend(pause(3.0));
        thinking.extend(word.clone());
        let out = shorten_pauses(&thinking, rate);
        let seconds = out.len() as f32 / rate as f32;
        assert!((1.3..1.45).contains(&seconds), "{seconds}");
        // Both words whole.
        assert!(rms(&out[..8000]) > 0.15 && rms(&out[out.len() - 8000..]) > 0.15);
        let mut breath = word.clone();
        breath.extend(pause(0.3));
        breath.extend(word);
        assert_eq!(shorten_pauses(&breath, rate).len(), breath.len());
    }

    #[test]
    fn a_quiet_voice_is_raised_and_a_loud_one_is_not_clipped() {
        let quiet = levelled(&tone(300.0, 16_000, 1.0, 0.01));
        assert!((rms(&quiet) - TARGET_RMS).abs() < 0.02, "{}", rms(&quiet));
        // Only so far: the room is not turned into a roar.
        let whisper = levelled(&tone(300.0, 16_000, 1.0, 0.0005));
        assert!(rms(&whisper) <= 0.0005 * MAX_GAIN * 1.01);
        let loud = levelled(&tone(300.0, 16_000, 1.0, 0.99));
        assert!(loud.iter().all(|s| s.abs() <= 1.0));
        assert!(rms(&loud) > 0.3);
        assert!(levelled(&[]).is_empty());
    }

    #[test]
    fn hum_and_offset_are_taken_out_and_the_voice_stays() {
        let rate = 16_000;
        let offset: Vec<f32> = tone(1000.0, rate, 1.0, 0.2)
            .iter()
            .map(|s| s + 0.3)
            .collect();
        let out = high_pass(&offset, rate, 70.0);
        let tail = &out[8000..];
        let mean = tail.iter().sum::<f32>() / tail.len() as f32;
        assert!(mean.abs() < 0.01, "{mean}");
        assert!((rms(tail) - 0.2 / 2f32.sqrt()).abs() < 0.01);
        let hum = high_pass(&tone(20.0, rate, 1.0, 0.3), rate, 70.0);
        assert!(rms(&hum[8000..]) < 0.1);
    }

    #[test]
    fn the_whole_way_gives_the_models_rate() {
        let mut sound = vec![0.0f32; 48_000];
        sound.extend(tone(500.0, 48_000, 1.0, 0.02));
        sound.extend(vec![0.0f32; 48_000]);
        let ready = for_model(&sound, 48_000);
        let seconds = ready.len() as f32 / MODEL_RATE as f32;
        assert!((1.5..1.8).contains(&seconds), "{seconds}");
        assert!(rms(&ready) > 0.05);
        assert!(for_model(&[], 48_000).is_empty());
    }
}
