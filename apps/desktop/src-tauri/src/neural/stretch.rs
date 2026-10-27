//! Faster reading without a higher voice. The voices themselves stay clear
//! only up to `MODEL_MAX_RATE` (tested: at twice the speed Supertonic drops
//! words, at three times it cannot be followed), so above it the voice
//! speaks at that rate and its sound is shortened by WSOLA — short
//! overlapping slices of the sound, each placed where it lines up best with
//! the one before, so the pitch stays where it was.

/// The fastest a voice is asked to speak by itself.
pub const MODEL_MAX_RATE: f32 = 1.5;
/// The fastest reading there is.
pub const MAX_RATE: f32 = 3.0;

/// The rate the voice speaks at, and how much faster its sound is then
/// played, for the interface's `rate` (1 normal, 0.5 to 3).
pub fn split(rate: f32) -> (f32, f32) {
    let rate = if rate.is_finite() {
        rate.clamp(0.5, MAX_RATE)
    } else {
        1.0
    };
    if rate <= MODEL_MAX_RATE {
        (rate, 1.0)
    } else {
        (MODEL_MAX_RATE, rate / MODEL_MAX_RATE)
    }
}

/// `samples` played `factor` times faster at the same pitch (1 to 2;
/// below 1.01 they come back as they are).
pub fn faster(samples: &[f32], factor: f32, sample_rate: u32) -> Vec<f32> {
    let factor = if factor.is_finite() {
        factor.clamp(1.0, 2.0)
    } else {
        1.0
    };
    // A slice of 30 ms, laid down every 15 ms, may move 8 ms to line up.
    let frame = ((sample_rate as usize * 30 / 1000) / 2 * 2).max(64);
    let out_hop = frame / 2;
    let tolerance = sample_rate as usize * 8 / 1000;
    if factor < 1.01 || samples.len() < frame * 2 {
        return samples.to_vec();
    }
    let in_hop = out_hop as f32 * factor;
    let window: Vec<f32> = (0..frame)
        .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / frame as f32).cos())
        .collect();
    let length = (samples.len() as f32 / factor) as usize + frame;
    let mut out = vec![0.0f32; length];
    // Where the slice laid down last was taken from: its natural next part
    // is what the next slice must sound like where they overlap.
    let mut previous = 0usize;
    let mut k = 0usize;
    loop {
        let at = k * out_hop;
        let nominal = (k as f32 * in_hop) as usize;
        if nominal + frame > samples.len() || at + frame > out.len() {
            break;
        }
        let from = if k == 0 {
            0
        } else {
            let natural = previous + out_hop;
            best_offset(samples, natural, nominal, tolerance, frame)
        };
        for i in 0..frame {
            out[at + i] += samples[from + i] * window[i];
        }
        previous = from;
        k += 1;
    }
    out.truncate((k.saturating_sub(1)) * out_hop + frame);
    out
}

/// The start near `nominal` whose slice looks most like the one at
/// `natural`, compared on every fourth sample.
fn best_offset(
    samples: &[f32],
    natural: usize,
    nominal: usize,
    tolerance: usize,
    frame: usize,
) -> usize {
    if natural + frame > samples.len() {
        return nominal;
    }
    let target = &samples[natural..natural + frame];
    let low = nominal.saturating_sub(tolerance);
    let high = (nominal + tolerance).min(samples.len() - frame);
    let mut best = (nominal, f32::MIN);
    for start in low..=high {
        let candidate = &samples[start..start + frame];
        let score: f32 = (0..frame)
            .step_by(4)
            .map(|i| candidate[i] * target[i])
            .sum();
        if score > best.1 {
            best = (start, score);
        }
    }
    best.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_voice_speaks_up_to_its_own_limit_and_the_rest_is_played_faster() {
        assert_eq!(split(1.0), (1.0, 1.0));
        assert_eq!(split(1.5), (1.5, 1.0));
        assert_eq!(split(3.0), (1.5, 2.0));
        assert_eq!(split(9.0), (1.5, 2.0));
        assert_eq!(split(0.1), (0.5, 1.0));
        assert_eq!(split(f32::NAN), (1.0, 1.0));
    }

    /// The strongest frequency of `samples`, by counting rising zero crossings.
    fn pitch(samples: &[f32], rate: u32) -> f32 {
        let rises = samples
            .windows(2)
            .filter(|w| w[0] < 0.0 && w[1] >= 0.0)
            .count();
        rises as f32 * rate as f32 / samples.len() as f32
    }

    #[test]
    fn faster_is_shorter_at_the_same_pitch() {
        let rate = 44_100;
        let tone: Vec<f32> = (0..rate * 2)
            .map(|i| (2.0 * std::f32::consts::PI * 220.0 * i as f32 / rate as f32).sin() * 0.5)
            .collect();
        let quick = faster(&tone, 2.0, rate as u32);
        let seconds = quick.len() as f32 / rate as f32;
        assert!((seconds - 1.0).abs() < 0.05, "{seconds} s");
        let heard = pitch(&quick[2000..quick.len() - 2000], rate as u32);
        assert!((heard - 220.0).abs() < 5.0, "{heard} Hz");
        // No clicks where the slices meet: the level stays even.
        let middle = &quick[4000..quick.len() - 4000];
        let peak = middle.iter().fold(0.0f32, |m, s| m.max(s.abs()));
        assert!(peak < 0.56 && peak > 0.44, "{peak}");
    }

    #[test]
    fn short_or_normal_sound_comes_back_as_it_was() {
        let sound = vec![0.1f32; 100];
        assert_eq!(faster(&sound, 2.0, 44_100), sound);
        let long = vec![0.1f32; 10_000];
        assert_eq!(faster(&long, 1.0, 44_100), long);
        assert_eq!(faster(&[], 2.0, 44_100), Vec::<f32>::new());
    }
}
