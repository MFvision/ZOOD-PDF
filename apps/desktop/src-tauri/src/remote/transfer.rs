//! Files flicked from the phone land on the PC's desktop.
//!
//! A paired phone sends a file (`{ t: "drop", name, mime, data }`); it is
//! written to the person's Desktop under a name of its own (never over a file
//! that is there), marked as having come from elsewhere — Windows' "Mark of
//! the Web", macOS's quarantine flag — so the system asks before anything in
//! it runs, and never opened by the app. The phone hears `landed`, and the
//! PC shows the file arriving (`arrival.rs`).

use std::path::{Path, PathBuf};

use base64::Engine;

/// The longest name kept, in characters, before its extension.
const MAX_STEM: usize = 120;
/// And in bytes, with room for the extension and a " (n)" after it.
const MAX_STEM_BYTES: usize = 200;

/// Names Windows keeps for devices, whatever their extension.
const RESERVED: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// A phone's file name as a plain name in one folder: no folders, no
/// characters Windows or macOS refuse, no device names, not empty.
pub fn safe_name(raw: &str) -> String {
    // Only the last part of anything that looks like a path.
    let last = raw.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = last
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            // Characters that turn text around would hide the real extension.
            '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{200E}' | '\u{200F}' => '_',
            c => c,
        })
        .collect();
    // Windows drops trailing dots and spaces; leading dots hide a file.
    let trimmed = cleaned
        .trim()
        .trim_end_matches(['.', ' '])
        .trim_start_matches('.');
    let (stem, extension) = match trimmed.rfind('.') {
        Some(dot) if dot > 0 && trimmed.len() - dot <= 12 => (&trimmed[..dot], &trimmed[dot..]),
        _ => (trimmed, ""),
    };
    // At most `MAX_STEM` characters and `MAX_STEM_BYTES` bytes: a Mac's
    // names are 255 bytes, and 120 emoji are 480 (the file would not land).
    let mut kept = String::new();
    for c in stem.chars().take(MAX_STEM) {
        if kept.len() + c.len_utf8() > MAX_STEM_BYTES {
            break;
        }
        kept.push(c);
    }
    // Cut short, it may end in a dot or a space again, which Windows drops.
    let mut stem = kept.trim_end_matches(['.', ' ']).to_string();
    if stem.trim().is_empty() {
        stem = "file".into();
    }
    if is_reserved(&stem) {
        // After the part Windows reads: "CON.tar" becomes "CON_.tar".
        let at = stem.find('.').unwrap_or(stem.len());
        stem.insert(at, '_');
    }
    format!("{stem}{extension}")
}

/// Whether Windows takes a name for a device: it looks only at the part
/// before the first dot, without trailing spaces, so `CON.tar.gz` and
/// `nul .txt` are devices too.
pub(crate) fn is_reserved(stem: &str) -> bool {
    let first = stem.split('.').next().unwrap_or("");
    let first = first.trim_end_matches(' ').to_lowercase();
    RESERVED.contains(&first.as_str())
        || matches!(first.as_str(), "conin$" | "conout$" | "clock$")
        || ["com", "lpt"].iter().any(|device| {
            first
                .strip_prefix(device)
                .is_some_and(|n| matches!(n, "0" | "¹" | "²" | "³"))
        })
}

/// `name` in `folder`, or `name (2)`, `name (3)`… — the first that is free.
pub fn free_path(folder: &Path, name: &str) -> PathBuf {
    let first = folder.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, extension) = match name.rfind('.') {
        Some(dot) if dot > 0 => (&name[..dot], &name[dot..]),
        _ => (name, ""),
    };
    (2..10_000)
        .map(|n| folder.join(format!("{stem} ({n}){extension}")))
        .find(|path| !path.exists())
        .unwrap_or_else(|| {
            folder.join(format!(
                "{stem} ({}){extension}",
                crate::remote::seal::random_id()
            ))
        })
}

/// Writes a phone's file into `folder` and marks it as downloaded. The path
/// it was written to, or why not.
pub fn save(
    folder: &Path,
    name: &str,
    data_base64: &str,
    max_bytes: usize,
) -> Result<PathBuf, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|_| "E_ARGS: the file did not arrive whole".to_string())?;
    if bytes.len() > max_bytes {
        return Err("E_ARGS: the file is too large".into());
    }
    std::fs::create_dir_all(folder).map_err(|e| format!("E_IO: {e}"))?;
    let path = free_path(folder, &safe_name(name));
    // `create_new`: a file that appeared meanwhile is never written over.
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| format!("E_IO: {}: {e}", path.display()))?;
    std::io::Write::write_all(&mut file, &bytes).map_err(|e| format!("E_IO: {e}"))?;
    drop(file);
    mark_downloaded(&path);
    Ok(path)
}

/// Tells the system the file came from another device, as a browser does
/// for a download: Windows' SmartScreen and macOS's Gatekeeper then ask
/// before a program in it runs.
#[cfg(target_os = "windows")]
pub(crate) fn mark_downloaded(path: &Path) {
    let mut stream = path.as_os_str().to_owned();
    stream.push(":Zone.Identifier");
    // Zone 3: the internet, the zone Windows treats with most care.
    let _ = std::fs::write(PathBuf::from(stream), "[ZoneTransfer]\r\nZoneId=3\r\n");
}

#[cfg(target_os = "macos")]
pub(crate) fn mark_downloaded(path: &Path) {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // flags;time;agent;id — 0081: downloaded, not yet opened.
    let value = format!("0081;{seconds:08x};ZOOD PDF;");
    let (Ok(target), Ok(key)) = (
        CString::new(path.as_os_str().as_bytes()),
        CString::new("com.apple.quarantine"),
    ) else {
        return;
    };
    // SAFETY: both strings are NUL-terminated and live across the call; the
    // value's pointer and length describe one buffer.
    unsafe {
        libc::setxattr(
            target.as_ptr(),
            key.as_ptr(),
            value.as_ptr().cast(),
            value.len(),
            0,
            0,
        );
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub(crate) fn mark_downloaded(_path: &Path) {}

/// Where flicked files land: the Desktop, or the home folder without one.
pub fn landing_folder(desktop: Option<PathBuf>, home: Option<PathBuf>) -> Option<PathBuf> {
    desktop.filter(|d| d.is_dir()).or(home)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_stay_in_their_folder_and_readable() {
        assert_eq!(safe_name("photo.jpg"), "photo.jpg");
        assert_eq!(safe_name("../../etc/passwd"), "passwd");
        assert_eq!(safe_name("C:\\Windows\\evil.exe"), "evil.exe");
        assert_eq!(safe_name("a<b>:c?.pdf"), "a_b__c_.pdf");
        assert_eq!(safe_name("  .hidden. "), "hidden");
        assert_eq!(safe_name(""), "file");
        assert_eq!(safe_name("CON.txt"), "CON_.txt");
        assert_eq!(safe_name("فاتورة.pdf"), "فاتورة.pdf");
        // A right-to-left override would show "invoice_fdp.exe" as "invoice_exe.pdf".
        assert_eq!(safe_name("invoice_\u{202E}fdp.exe"), "invoice__fdp.exe");
        let long = format!("{}.pdf", "x".repeat(400));
        assert_eq!(safe_name(&long).chars().count(), MAX_STEM + 4);
    }

    #[test]
    fn names_windows_takes_for_devices_are_changed() {
        // Windows reads only the part before the first dot, spaces trimmed.
        assert_eq!(safe_name("CON.tar.gz"), "CON_.tar.gz");
        assert_eq!(safe_name("nul .txt"), "nul_.txt");
        assert_eq!(safe_name("aux.a.b.pdf"), "aux_.a.b.pdf");
        assert_eq!(safe_name("COM¹.txt"), "COM¹_.txt");
        assert_eq!(safe_name("conout$.log"), "conout$_.log");
        // Names that only start like one are left alone.
        assert_eq!(safe_name("console.pdf"), "console.pdf");
        assert_eq!(safe_name("com10.pdf"), "com10.pdf");
    }

    #[test]
    fn a_long_name_still_fits_a_mac_and_lands() {
        // 300 emoji (4 bytes each) and 300 Arabic letters: the stem keeps
        // under 255 bytes even with " (n)" and the extension after it.
        for raw in [
            format!("{}.pdf", "😀".repeat(300)),
            format!("{}.pdf", "ع".repeat(300)),
            format!("{} .pdf", "x".repeat(MAX_STEM - 1)),
            "x".repeat(MAX_STEM - 1) + " yz",
        ] {
            let name = safe_name(&raw);
            assert!(name.len() + " (9999)".len() <= 255, "{} bytes", name.len());
            assert!(!name.ends_with(['.', ' ']), "{name:?}");
            let stem = name.strip_suffix(".pdf").unwrap_or(&name);
            assert!(!stem.ends_with(['.', ' ']), "{name:?}");
        }
        let folder =
            std::env::temp_dir().join(format!("zood-long-{}", crate::remote::seal::random_id()));
        let data = base64::engine::general_purpose::STANDARD.encode(b"x");
        let emoji = format!("{}.pdf", "😀".repeat(300));
        assert!(save(&folder, &emoji, &data, 16).is_ok());
        assert!(save(&folder, &emoji, &data, 16).is_ok());
        let _ = std::fs::remove_dir_all(&folder);
    }

    #[test]
    fn a_flicked_file_never_replaces_one_already_there() {
        let folder =
            std::env::temp_dir().join(format!("zood-drop-{}", crate::remote::seal::random_id()));
        let data = base64::engine::general_purpose::STANDARD.encode(b"hello");
        let first = save(&folder, "note.txt", &data, 1024).unwrap();
        let second = save(&folder, "note.txt", &data, 1024).unwrap();
        assert_eq!(first.file_name().unwrap(), "note.txt");
        assert_eq!(second.file_name().unwrap(), "note (2).txt");
        assert_eq!(std::fs::read(&second).unwrap(), b"hello");
        assert!(save(&folder, "big.bin", &data, 2).is_err());
        assert!(save(&folder, "bad.bin", "not base64!", 1024).is_err());
        let _ = std::fs::remove_dir_all(&folder);
    }

    #[test]
    fn files_land_on_the_desktop_or_at_home() {
        let here = std::env::temp_dir();
        assert_eq!(landing_folder(Some(here.clone()), None), Some(here.clone()));
        assert_eq!(
            landing_folder(Some(here.join("no-such-desktop-zood")), Some(here.clone())),
            Some(here)
        );
    }
}
