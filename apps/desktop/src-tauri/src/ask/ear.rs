//! Ask ZOOD's ear: the default microphone, only while the shortcut is held
//! or from one tap of the tap key until the next (or a minute at most).
//!
//! What is heard is kept in memory as mono samples for the on-device model
//! to read (`ai.rs`, a model that hears) and dropped once it has; nothing is
//! written to disk or sent anywhere. The microphone is cpal (Apache-2.0):
//! WASAPI on Windows, Core Audio on a Mac, which asks the person once
//! (`NSMicrophoneUsageDescription`). Elsewhere there is no ear.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// The longest anyone holds the keys to ask something, in seconds.
pub const MAX_SECONDS: u32 = 60;

/// What was heard: mono samples in -1..1, at `rate` a second.
#[derive(Clone, Debug, Default)]
pub struct Sound {
    pub rate: u32,
    pub samples: Vec<f32>,
}

impl Sound {
    pub fn seconds(&self) -> f32 {
        if self.rate == 0 {
            0.0
        } else {
            self.samples.len() as f32 / self.rate as f32
        }
    }
}

/// Interleaved frames as one channel: the channels of each frame averaged.
pub fn to_mono(frames: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return frames.to_vec();
    }
    frames
        .chunks_exact(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect()
}

/// How loud a stretch of samples is, 0..1, for the island's listening light.
pub fn level(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let power = samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32;
    // Speech sits around 0.05 RMS; the light is full well before shouting.
    (power.sqrt() * 6.0).min(1.0)
}

/// The microphone, listening until `finish`.
pub struct Recording {
    stop: Arc<AtomicBool>,
    thread: std::thread::JoinHandle<Result<Sound, String>>,
}

impl Recording {
    /// Stops listening and hands back what was heard.
    pub fn finish(self) -> Result<Sound, String> {
        self.stop.store(true, Ordering::Relaxed);
        self.thread
            .join()
            .unwrap_or_else(|_| Err("E_MIC: the microphone stopped".to_string()))
    }
}

/// Starts listening on the default microphone. `heard` is told how loud
/// each new stretch is.
pub fn start(heard: impl Fn(f32) + Send + 'static) -> Result<Recording, String> {
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    // The stream lives on a thread of its own: on some systems it may not
    // be moved between threads.
    let thread = std::thread::Builder::new()
        .name("zood-ask-ear".into())
        .spawn(move || system::listen(&flag, &ready_tx, &heard))
        .map_err(|e| format!("E_MIC: {e}"))?;
    match ready_rx.recv() {
        Ok(Ok(())) => Ok(Recording { stop, thread }),
        Ok(Err(e)) => {
            let _ = thread.join();
            Err(e)
        }
        Err(_) => Err(thread
            .join()
            .ok()
            .and_then(Result::err)
            .unwrap_or_else(|| "E_MIC: the microphone did not start".to_string())),
    }
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
mod system {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc::Sender;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use cpal::{SampleFormat, SizedSample};

    use super::{level, to_mono, Sound, MAX_SECONDS};

    type Heard = Arc<Mutex<Vec<f32>>>;

    pub fn listen(
        stop: &AtomicBool,
        ready: &Sender<Result<(), String>>,
        tell: &(impl Fn(f32) + Send + 'static),
    ) -> Result<Sound, String> {
        let started = open();
        let (stream, rate, heard) = match started {
            Ok(open) => {
                let _ = ready.send(Ok(()));
                open
            }
            Err(e) => {
                let _ = ready.send(Err(e.clone()));
                return Err(e);
            }
        };
        let mut told = 0;
        while !stop.load(Ordering::Relaxed) {
            std::thread::sleep(Duration::from_millis(60));
            // Only what came since the last look is read: a tap may keep
            // the microphone open for the whole minute.
            let (now, loud) = heard
                .lock()
                .map(|h| (h.len(), (h.len() > told).then(|| level(&h[told..]))))
                .unwrap_or((told, None));
            if let Some(loud) = loud {
                tell(loud);
                told = now;
            }
            if now >= (rate * MAX_SECONDS) as usize {
                break;
            }
        }
        drop(stream);
        let samples = heard.lock().map(|h| h.clone()).unwrap_or_default();
        Ok(Sound { rate, samples })
    }

    fn open() -> Result<(cpal::Stream, u32, Heard), String> {
        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or_else(|| "E_MIC: there is no microphone".to_string())?;
        let supported = device
            .default_input_config()
            .map_err(|e| format!("E_MIC: {e}"))?;
        let format = supported.sample_format();
        let config = supported.config();
        let rate = config.sample_rate;
        let channels = usize::from(config.channels);
        let heard: Heard = Arc::new(Mutex::new(Vec::new()));
        let limit = (rate * MAX_SECONDS) as usize;
        let stream = match format {
            SampleFormat::F32 => build::<f32>(&device, config, channels, limit, &heard),
            SampleFormat::I16 => build::<i16>(&device, config, channels, limit, &heard),
            SampleFormat::U16 => build::<u16>(&device, config, channels, limit, &heard),
            SampleFormat::I32 => build::<i32>(&device, config, channels, limit, &heard),
            other => return Err(format!("E_MIC: the microphone gives {other:?} samples")),
        }?;
        stream.play().map_err(|e| format!("E_MIC: {e}"))?;
        Ok((stream, rate, heard))
    }

    fn build<T>(
        device: &cpal::Device,
        config: cpal::StreamConfig,
        channels: usize,
        limit: usize,
        heard: &Heard,
    ) -> Result<cpal::Stream, String>
    where
        T: SizedSample,
        f32: cpal::FromSample<T>,
    {
        let into = heard.clone();
        device
            .build_input_stream::<T, _, _>(
                config,
                move |data: &[T], _| {
                    let frames: Vec<f32> = data
                        .iter()
                        .map(|s| <f32 as cpal::FromSample<T>>::from_sample_(*s))
                        .collect();
                    if let Ok(mut heard) = into.lock() {
                        if heard.len() < limit {
                            heard.extend(to_mono(&frames, channels));
                        }
                    }
                },
                |e| crate::core_bridge::debug_log(format!("ask: microphone: {e}")),
                None,
            )
            .map_err(|e| format!("E_MIC: {e}"))
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod system {
    use std::sync::atomic::AtomicBool;
    use std::sync::mpsc::Sender;

    use super::Sound;

    pub fn listen(
        _stop: &AtomicBool,
        ready: &Sender<Result<(), String>>,
        _tell: &(impl Fn(f32) + Send + 'static),
    ) -> Result<Sound, String> {
        let e = "E_MIC: Ask ZOOD listens on Windows and macOS".to_string();
        let _ = ready.send(Err(e.clone()));
        Err(e)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stereo_becomes_one_channel() {
        assert_eq!(to_mono(&[1.0, 0.0, 0.5, 0.5], 2), vec![0.5, 0.5]);
        assert_eq!(to_mono(&[0.25, 0.75], 1), vec![0.25, 0.75]);
        // A frame cut short at the end is left out.
        assert_eq!(to_mono(&[1.0, 1.0, 1.0], 2), vec![1.0]);
    }

    #[test]
    fn silence_is_dark_and_speech_lights_up() {
        assert_eq!(level(&[]), 0.0);
        assert_eq!(level(&[0.0; 100]), 0.0);
        assert!(level(&[0.05, -0.05, 0.05, -0.05]) > 0.25);
        assert_eq!(level(&[1.0, -1.0]), 1.0);
        let sound = Sound {
            rate: 16_000,
            samples: vec![0.0; 8_000],
        };
        assert_eq!(sound.seconds(), 0.5);
    }
}
