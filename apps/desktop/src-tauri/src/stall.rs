//! Keeps an eye on the main thread. Every window of the app is drawn by it,
//! so when it is held up, Windows shows each one as "Not Responding" with a
//! plain white title bar. Two things are written to `stall.log` beside the
//! app's settings: any command answered on the main thread that took long,
//! and any second in which the main thread did not answer at all (with the
//! command it was busy with, if it was one).

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::ipc::Invoke;
use tauri::{AppHandle, Manager, Runtime};

static LOG: OnceLock<PathBuf> = OnceLock::new();
/// The log is started again at launch once this full.
const LOG_LIMIT: u64 = 128 * 1024;
/// A command this long on the main thread is written down.
const SLOW: Duration = Duration::from_millis(150);
/// How often the main thread is asked to answer.
const EVERY: Duration = Duration::from_millis(500);
/// An answer this late is a stall.
const LATE: Duration = Duration::from_millis(750);

/// The command being answered on the main thread now, and since when.
static BUSY: Mutex<Option<(String, Instant)>> = Mutex::new(None);
/// When the main thread last answered, in ms since `START`.
static ANSWERED: AtomicU64 = AtomicU64::new(0);
static START: OnceLock<Instant> = OnceLock::new();

fn since_start() -> u64 {
    START.get_or_init(Instant::now).elapsed().as_millis() as u64
}

pub fn log(line: &str) {
    use std::io::Write;
    let Some(path) = LOG.get() else { return };
    if std::fs::metadata(path).map(|m| m.len()).unwrap_or(0) >= LOG_LIMIT {
        return;
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ =
            file.write_all(format!("{:>8.1}s {line}\n", since_start() as f64 / 1000.0).as_bytes());
    }
}

/// Where the log goes, and the watching thread.
pub fn start<R: Runtime>(app: &AppHandle<R>) {
    START.get_or_init(Instant::now);
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("stall.log");
        if std::fs::metadata(&path).is_ok_and(|m| m.len() >= LOG_LIMIT) {
            let _ = std::fs::remove_file(&path);
        }
        let _ = LOG.set(path);
    }
    log(&format!("started, version {}", app.package_info().version));
    let app = app.clone();
    ANSWERED.store(since_start(), Ordering::Relaxed);
    std::thread::Builder::new()
        .name("warraq-stall-watch".into())
        .spawn(move || {
            let mut stalled_since: Option<u64> = None;
            loop {
                std::thread::sleep(EVERY);
                let asked = since_start();
                if app
                    .run_on_main_thread(|| ANSWERED.store(since_start(), Ordering::Relaxed))
                    .is_err()
                {
                    return;
                }
                std::thread::sleep(LATE);
                let answered = ANSWERED.load(Ordering::Relaxed);
                if answered >= asked {
                    if let Some(from) = stalled_since.take() {
                        log(&format!(
                            "main thread answered again after {:.1}s",
                            (answered.saturating_sub(from)) as f64 / 1000.0
                        ));
                    }
                } else if stalled_since.is_none() {
                    stalled_since = Some(asked);
                    let busy = BUSY
                        .lock()
                        .ok()
                        .and_then(|b| b.as_ref().map(|(name, at)| (name.clone(), at.elapsed())));
                    match busy {
                        Some((name, for_)) => log(&format!(
                            "main thread stalled, in command {name} for {} ms",
                            for_.as_millis()
                        )),
                        None => log("main thread stalled (not in a command)"),
                    }
                }
            }
        })
        .ok();
}

/// The app's command handler, timed: a command answered on the main thread
/// (a plain `fn` command) runs inside `handler`, so its time is the call's.
pub fn timed<R: Runtime>(
    handler: impl Fn(Invoke<R>) -> bool + Send + Sync + 'static,
) -> impl Fn(Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke: Invoke<R>| {
        let name = invoke.message.command().to_string();
        let started = Instant::now();
        if let Ok(mut busy) = BUSY.lock() {
            *busy = Some((name.clone(), started));
        }
        let handled = handler(invoke);
        if let Ok(mut busy) = BUSY.lock() {
            *busy = None;
        }
        let took = started.elapsed();
        if took >= SLOW {
            log(&format!(
                "slow command on the main thread: {name} {} ms",
                took.as_millis()
            ));
        }
        handled
    }
}
