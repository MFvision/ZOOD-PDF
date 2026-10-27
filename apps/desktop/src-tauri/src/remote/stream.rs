//! Files of any size between a phone and the PC, in pieces.
//!
//! A file used to cross as one message: the whole of it, as base64, held in
//! memory several times over on both sides, and too much for a phone's
//! browser past a few tens of megabytes. Now it goes in parts of [`PART`]
//! bytes, each answered before more than [`WINDOW`] are on their way, so
//! neither side ever holds more than a few parts, whatever the file's size.
//!
//! From the phone: `putStart { id, name, mime, size }`, then `putPart { id,
//! n, data }` from 0 up, then `putEnd { id }` (or `putStop` to give up). The
//! PC answers `putOk`/`putNo`, `putGot { n }` for each part, and the same
//! `landed` as before once the file is on the Desktop. The part file waits
//! hidden beside where it lands (`.zood-<id>.part`) and is taken away if the
//! phone leaves or gives up.
//!
//! To the phone: `giveStart { id, name, mime, size }`, `givePart { id, n,
//! data }`, `giveEnd { id }` (or `giveStop`), each part answered with
//! `giveGot { id, n }`.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

use base64::Engine;

use super::transfer;

/// One part, before base64.
pub const PART: usize = 512 * 1024;
/// The largest file either way.
pub const MAX_STREAM: u64 = 1024 * 1024 * 1024;
/// Parts on their way before the first is answered.
pub const WINDOW: u64 = 4;
/// How long a part's answer may take before the file is given up.
pub const ANSWER_WAIT: Duration = Duration::from_secs(30);
/// Files one phone may be sending at once.
const MAX_OPEN: usize = 4;
/// The longest base64 a part may be.
const MAX_PART_TEXT: usize = PART.div_ceil(3) * 4;

/// A transfer's id, as the phone made it: short, and safe in a file name.
pub fn good_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 40
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// A file on its way in from a phone.
pub struct Incoming {
    file: Option<File>,
    part_path: PathBuf,
    folder: PathBuf,
    pub name: String,
    pub mime: String,
    size: u64,
    written: u64,
    next: u64,
}

impl Incoming {
    /// The part file opened beside where the file will land.
    pub fn begin(folder: &Path, id: &str, name: &str, mime: &str, size: u64) -> Result<Incoming, String> {
        if !good_id(id) {
            return Err("E_ARGS: bad id".into());
        }
        if size > MAX_STREAM {
            return Err("E_TOO_BIG".into());
        }
        std::fs::create_dir_all(folder).map_err(|e| format!("E_IO: {e}"))?;
        let part_path = folder.join(format!(".zood-{id}.part"));
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&part_path)
            .map_err(|e| format!("E_IO: {e}"))?;
        hide(&part_path);
        Ok(Incoming {
            file: Some(file),
            part_path,
            folder: folder.to_path_buf(),
            name: transfer::safe_name(name),
            mime: mime.chars().take(100).collect(),
            size,
            written: 0,
            next: 0,
        })
    }

    /// Part `n`, in order, as base64.
    pub fn part(&mut self, n: u64, data: &str) -> Result<(), String> {
        if n != self.next {
            return Err("E_ARGS: a part out of order".into());
        }
        if data.len() > MAX_PART_TEXT {
            return Err("E_ARGS: a part too large".into());
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|_| "E_ARGS: a part did not arrive whole".to_string())?;
        if self.written + bytes.len() as u64 > self.size {
            return Err("E_ARGS: more than the file's size".into());
        }
        let file = self.file.as_mut().ok_or("E_IO: closed")?;
        file.write_all(&bytes).map_err(|e| format!("E_IO: {e}"))?;
        self.written += bytes.len() as u64;
        self.next += 1;
        Ok(())
    }

    /// All in: the file takes its own name (never over another) and is
    /// marked as having come from another device.
    pub fn finish(mut self) -> Result<PathBuf, String> {
        if self.written != self.size {
            return Err("E_ARGS: the file did not arrive whole".into());
        }
        if let Some(mut file) = self.file.take() {
            file.flush().map_err(|e| format!("E_IO: {e}"))?;
        }
        let path = transfer::free_path(&self.folder, &self.name);
        std::fs::rename(&self.part_path, &path).map_err(|e| format!("E_IO: {e}"))?;
        transfer::mark_downloaded(&path);
        Ok(path)
    }
}

impl Drop for Incoming {
    /// A file never finished leaves nothing behind.
    fn drop(&mut self) {
        if self.file.take().is_some() {
            let _ = std::fs::remove_file(&self.part_path);
        }
    }
}

/// The part file is not one the person should see on their Desktop.
#[cfg(target_os = "windows")]
fn hide(path: &Path) {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{SetFileAttributesW, FILE_ATTRIBUTE_HIDDEN};
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: `wide` is NUL-terminated and lives across the call.
    unsafe {
        SetFileAttributesW(wide.as_ptr(), FILE_ATTRIBUTE_HIDDEN);
    }
}

#[cfg(not(target_os = "windows"))]
fn hide(_path: &Path) {}

/// The transfers going on now, by phone and id.
#[derive(Default)]
pub struct Streams {
    incoming: HashMap<(u64, String), Incoming>,
    answers: HashMap<(u64, String), mpsc::Sender<u64>>,
}

impl Streams {
    pub fn open_count(&self, peer: u64) -> usize {
        self.incoming.keys().filter(|(p, _)| *p == peer).count()
    }

    pub fn can_open(&self, peer: u64) -> bool {
        self.open_count(peer) < MAX_OPEN
    }

    pub fn add(&mut self, peer: u64, id: &str, incoming: Incoming) {
        self.incoming.insert((peer, id.to_string()), incoming);
    }

    pub fn get(&mut self, peer: u64, id: &str) -> Option<&mut Incoming> {
        self.incoming.get_mut(&(peer, id.to_string()))
    }

    pub fn take(&mut self, peer: u64, id: &str) -> Option<Incoming> {
        self.incoming.remove(&(peer, id.to_string()))
    }

    /// Where the phone's answers for a file going to it are heard.
    pub fn listen(&mut self, peer: u64, id: &str) -> mpsc::Receiver<u64> {
        let (tx, rx) = mpsc::channel();
        self.answers.insert((peer, id.to_string()), tx);
        rx
    }

    pub fn answered(&mut self, peer: u64, id: &str, n: u64) {
        if let Some(tx) = self.answers.get(&(peer, id.to_string())) {
            let _ = tx.send(n);
        }
    }

    pub fn stop_listening(&mut self, peer: u64, id: &str) {
        self.answers.remove(&(peer, id.to_string()));
    }

    /// The phone left: what it was sending is thrown away, what was going
    /// to it stops (its sender hears nothing more).
    pub fn forget_peer(&mut self, peer: u64) {
        self.incoming.retain(|(p, _), _| *p != peer);
        self.answers.retain(|(p, _), _| *p != peer);
    }
}

/// What a file for the phone is read from.
pub enum Source {
    Path(PathBuf),
    Bytes(std::sync::Arc<Vec<u8>>),
}

impl Source {
    pub fn size(&self) -> Option<u64> {
        match self {
            Source::Path(path) => std::fs::metadata(path).ok().filter(|m| m.is_file()).map(|m| m.len()),
            Source::Bytes(bytes) => Some(bytes.len() as u64),
        }
    }
}

/// Sends `source` to one phone in parts through `say`, waiting for its
/// answers on `answers` so no more than [`WINDOW`] parts are ever on their
/// way. True once the phone has every part.
pub fn give(
    source: &Source,
    id: &str,
    name: &str,
    mime: &str,
    answers: &mpsc::Receiver<u64>,
    say: &dyn Fn(serde_json::Value) -> bool,
) -> bool {
    use serde_json::json;
    let Some(size) = source.size().filter(|s| *s <= MAX_STREAM) else {
        return false;
    };
    let parts = size.div_ceil(PART as u64);
    if !say(json!({ "t": "giveStart", "id": id, "name": name, "mime": mime, "size": size })) {
        return false;
    }
    let mut reader: Box<dyn Read> = match source {
        Source::Path(path) => match File::open(path) {
            Ok(file) => Box::new(std::io::BufReader::new(file)),
            Err(_) => {
                say(json!({ "t": "giveStop", "id": id }));
                return false;
            }
        },
        Source::Bytes(bytes) => Box::new(std::io::Cursor::new(bytes.as_slice().to_vec())),
    };
    let mut answered: u64 = 0;
    let mut buffer = vec![0u8; PART];
    let wait = |answered: &mut u64| -> bool {
        match answers.recv_timeout(ANSWER_WAIT) {
            Ok(n) => {
                *answered = (*answered).max(n + 1);
                true
            }
            Err(_) => false,
        }
    };
    for n in 0..parts {
        while n >= answered + WINDOW {
            if !wait(&mut answered) {
                say(json!({ "t": "giveStop", "id": id }));
                return false;
            }
        }
        let want = (size - n * PART as u64).min(PART as u64) as usize;
        if reader.read_exact(&mut buffer[..want]).is_err() {
            say(json!({ "t": "giveStop", "id": id }));
            return false;
        }
        let data = base64::engine::general_purpose::STANDARD.encode(&buffer[..want]);
        if !say(json!({ "t": "givePart", "id": id, "n": n, "data": data })) {
            return false;
        }
    }
    while answered < parts {
        if !wait(&mut answered) {
            say(json!({ "t": "giveStop", "id": id }));
            return false;
        }
    }
    say(json!({ "t": "giveEnd", "id": id }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn folder(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("zood-stream-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    #[test]
    fn a_file_in_parts_lands_whole_under_its_own_name() {
        let dir = folder("whole");
        std::fs::write(dir.join("Scan.pdf"), b"already here").unwrap();
        let data: Vec<u8> = (0..(PART * 2 + 10)).map(|i| (i % 251) as u8).collect();
        let mut incoming = Incoming::begin(&dir, "abc", "Scan.pdf", "application/pdf", data.len() as u64).unwrap();
        for (n, chunk) in data.chunks(PART).enumerate() {
            incoming.part(n as u64, &b64(chunk)).unwrap();
        }
        let path = incoming.finish().unwrap();
        assert_eq!(path.file_name().unwrap(), "Scan (2).pdf");
        assert_eq!(std::fs::read(&path).unwrap(), data);
        assert_eq!(std::fs::read(dir.join("Scan.pdf")).unwrap(), b"already here");
        assert!(!dir.join(".zood-abc.part").exists());
    }

    #[test]
    fn a_file_left_unfinished_leaves_nothing() {
        let dir = folder("left");
        let mut incoming = Incoming::begin(&dir, "x1", "a.txt", "text/plain", 10).unwrap();
        incoming.part(0, &b64(b"hello")).unwrap();
        assert!(dir.join(".zood-x1.part").exists());
        drop(incoming);
        assert!(!dir.join(".zood-x1.part").exists());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
    }

    #[test]
    fn refuses_parts_out_of_order_too_many_bytes_or_short_files() {
        let dir = folder("refuse");
        let mut incoming = Incoming::begin(&dir, "r", "a.txt", "text/plain", 4).unwrap();
        assert!(incoming.part(1, &b64(b"ab")).is_err());
        assert!(incoming.part(0, &b64(b"abcde")).is_err());
        incoming.part(0, &b64(b"ab")).unwrap();
        assert!(incoming.finish().is_err());
        assert!(!dir.join(".zood-r.part").exists());
        assert!(Incoming::begin(&dir, "../evil", "a", "", 1).is_err());
        assert!(Incoming::begin(&dir, "big", "a", "", MAX_STREAM + 1).is_err());
    }

    #[test]
    fn gives_in_parts_and_never_runs_ahead_of_the_phone() {
        let data: Vec<u8> = (0..(PART * 9 + 3)).map(|i| (i % 7) as u8).collect();
        let source = Source::Bytes(Arc::new(data.clone()));
        let (answer, answers) = mpsc::channel();
        let (part_tx, parts) = mpsc::channel::<(u64, Vec<u8>)>();
        // The phone, slow on purpose: it answers each part a moment later.
        let phone = std::thread::spawn(move || {
            let mut got = Vec::new();
            for (n, bytes) in parts {
                std::thread::sleep(Duration::from_millis(5));
                got.extend(bytes);
                let _ = answer.send(n);
            }
            got
        });
        let sent = Arc::new(Mutex::new((0u64, Vec::<String>::new())));
        let s = sent.clone();
        let say = move |m: serde_json::Value| {
            let mut sent = s.lock().unwrap();
            if m["t"] == "givePart" {
                sent.0 += 1;
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(m["data"].as_str().unwrap())
                    .unwrap();
                let _ = part_tx.send((m["n"].as_u64().unwrap(), bytes));
            }
            sent.1.push(m["t"].as_str().unwrap().to_string());
            true
        };
        assert!(give(&source, "g1", "a.bin", "application/octet-stream", &answers, &say));
        drop(say);
        assert_eq!(phone.join().unwrap(), data);
        let sent = sent.lock().unwrap();
        assert_eq!(sent.0, 10);
        assert_eq!(sent.1.first().unwrap(), "giveStart");
        assert_eq!(sent.1.last().unwrap(), "giveEnd");
    }

    #[test]
    fn the_window_holds_parts_back_until_answered() {
        let source = Source::Bytes(Arc::new(vec![1u8; PART * 8]));
        let (answer, answers) = mpsc::channel();
        let sent = Arc::new(Mutex::new(0u64));
        let s = sent.clone();
        let checker = std::thread::spawn(move || {
            // Nothing answered yet: only WINDOW parts may have gone.
            std::thread::sleep(Duration::from_millis(150));
            let early = *s.lock().unwrap();
            for n in 0..8 {
                let _ = answer.send(n);
            }
            early
        });
        let say = move |m: serde_json::Value| {
            if m["t"] == "givePart" {
                *sent.lock().unwrap() += 1;
            }
            true
        };
        assert!(give(&source, "w", "a", "", &answers, &say));
        assert_eq!(checker.join().unwrap(), WINDOW);
    }

    #[test]
    fn a_phone_that_stops_answering_is_given_up() {
        let source = Source::Bytes(Arc::new(vec![1u8; PART * (WINDOW as usize + 2)]));
        let (_tx, rx) = mpsc::channel::<u64>();
        let said: Arc<Mutex<Vec<String>>> = Arc::default();
        let s = said.clone();
        let say = move |m: serde_json::Value| {
            s.lock().unwrap().push(m["t"].as_str().unwrap().to_string());
            true
        };
        // `_tx` is kept, so the wait runs to its time limit; dropped, it ends at once.
        drop(_tx);
        assert!(!give(&source, "g2", "a", "", &rx, &say));
        let said = said.lock().unwrap();
        assert_eq!(said.iter().filter(|t| *t == "givePart").count(), WINDOW as usize);
        assert_eq!(said.last().unwrap(), "giveStop");
    }
}
