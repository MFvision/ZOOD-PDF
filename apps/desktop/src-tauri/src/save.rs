//! Saving a file the person chose in the save panel, safely.
//!
//! The file system plugin's `write_file` empties the file and then writes
//! it: a full disk, a USB stick pulled out or the PC losing power halfway
//! leaves the person's PDF cut short — and when they saved over the file
//! they had open, the original is gone with it. Here the new bytes go into a
//! hidden file beside it first, are flushed to the disk, and only then take
//! the file's name in one step (`rename`): the file is either the old one
//! or the new one, whole, never half of either.
//!
//! The same small writer keeps the app's own records (journals of moves
//! that can be undone, the shelf) whole across a crash.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Runtime};
use tauri_plugin_fs::FsExt;

use crate::core_bridge::debug_log;

/// The header that names the file, percent-encoded (headers are ASCII).
const PATH_HEADER: &str = "x-warraq-path";

/// The file a write lands in: the file a link points at, so the link stays
/// a link; `path` itself otherwise.
fn landing(path: &Path) -> PathBuf {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => {
            std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
        }
        _ => path.to_path_buf(),
    }
}

/// A hidden name beside `target` that nothing else uses.
fn temp_beside(target: &Path) -> std::io::Result<PathBuf> {
    let dir = target
        .parent()
        .filter(|d| !d.as_os_str().is_empty())
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "no folder"))?;
    let mut random = [0u8; 6];
    let _ = getrandom::getrandom(&mut random);
    Ok(dir.join(format!(".zood-saving-{}.tmp", hex::encode(random))))
}

/// Writes `bytes` to `path` whole or not at all: into a file beside it,
/// flushed, then renamed over it. A read-only file is refused, as the
/// system would refuse writing into it.
///
/// Where that cannot be done, the file is written in place, as every save
/// was before this writer, so a save that used to work is never refused:
/// a folder where the chosen file may be written but no file added beside
/// it (a Mac's Desktop, Documents or Downloads before ZOOD is let into the
/// folder, since the save panel opens the file and not the folder; a shared
/// folder that allows changes but not new files), and a file another
/// program keeps from being replaced. A write that fails halfway (a full
/// disk) is never tried again in place: that is the case this writer is for.
pub fn write_whole(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let target = landing(path);
    let before = std::fs::metadata(&target).ok();
    if let Some(meta) = &before {
        if !meta.is_file() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "not a file",
            ));
        }
        if meta.permissions().readonly() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "the file is read-only",
            ));
        }
    }
    let temp = temp_beside(&target)?;
    let mut file = match OpenOptions::new().write(true).create_new(true).open(&temp) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
            debug_log(format!(
                "save {}: no file may be made beside it ({e}); written in place",
                target.display()
            ));
            return std::fs::write(&target, bytes);
        }
        Err(e) => return Err(e),
    };
    let flushed = file.write_all(bytes).and_then(|()| file.sync_all());
    drop(file);
    // The new file keeps who may read the old one (Unix modes).
    #[cfg(unix)]
    let flushed = flushed.and_then(|()| match &before {
        Some(meta) => std::fs::set_permissions(&temp, meta.permissions()),
        None => Ok(()),
    });
    if let Err(e) = flushed {
        let _ = std::fs::remove_file(&temp);
        return Err(e);
    }
    match rename_over(&temp, &target) {
        Ok(()) => Ok(()),
        Err(e) => {
            // The new bytes fitted on the disk; only the swap was refused.
            let _ = std::fs::remove_file(&temp);
            debug_log(format!(
                "save {}: could not take the file's place ({e}); written in place",
                target.display()
            ));
            std::fs::write(&target, bytes)
        }
    }
}

/// Puts `temp` in `target`'s place. Windows renames over a file with
/// `MoveFileEx(REPLACE_EXISTING)` and refuses while another program holds
/// either file without letting it be replaced (an antivirus reading the new
/// file, a sync client), often only for a moment, so there the rename is
/// tried again for about a second.
fn rename_over(temp: &Path, target: &Path) -> std::io::Result<()> {
    let mut tries = 0;
    loop {
        match std::fs::rename(temp, target) {
            Ok(()) => return Ok(()),
            Err(_) if cfg!(windows) && tries < 10 => {
                tries += 1;
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(e) => return Err(e),
        }
    }
}

/// The largest file the app opens whole: past this a webview cannot hold it
/// anyway, and the read alone would take the memory of a small laptop.
pub const MAX_OPEN_BYTES: u64 = 2 * 1024 * 1024 * 1024 - 1;

/// A file's bytes, at most `max` of them: a larger file is refused before
/// it is read, and one that grows while it is read (or never ends, like a
/// device) is refused when it passes `max`, never read to the end.
pub fn read_bounded(path: &Path, max: u64) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let file = std::fs::File::open(path).map_err(|e| format!("E_IO: {}: {e}", path.display()))?;
    let size = file.metadata().map(|m| m.len()).unwrap_or(0);
    let too_big = || {
        format!(
            "E_TOO_BIG: {} is larger than the {} MB a file may be",
            path.display(),
            max / (1024 * 1024)
        )
    };
    if size > max {
        return Err(too_big());
    }
    let mut bytes = Vec::with_capacity(size as usize);
    file.take(max + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("E_IO: {}: {e}", path.display()))?;
    if bytes.len() as u64 > max {
        return Err(too_big());
    }
    Ok(bytes)
}

/// Saves the raw body to the file the header names. Only a path the person
/// chose in the save panel (which puts it in the file scope) is written.
#[tauri::command(async)]
pub fn save_file<R: Runtime>(
    app: AppHandle<R>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("E_ARGS: the file travels as a raw body".into());
    };
    let path = request
        .headers()
        .get(PATH_HEADER)
        .and_then(|value| value.to_str().ok())
        .and_then(crate::batch::percent_decode)
        .map(PathBuf::from)
        .ok_or("E_ARGS: no path to save to")?;
    if !path.is_absolute() || !app.fs_scope().is_allowed(&path) {
        return Err(format!(
            "E_SCOPE: {} was not chosen in the save panel",
            path.display()
        ));
    }
    let saved = write_whole(&path, bytes);
    debug_log(format!(
        "save {} ({} bytes) -> {saved:?}",
        path.display(),
        bytes.len()
    ));
    saved.map_err(|e| match e.kind() {
        std::io::ErrorKind::PermissionDenied => format!("E_READONLY: {}: {e}", path.display()),
        _ => format!("E_IO: {}: {e}", path.display()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "zood-save-{name}-{}",
            crate::remote::seal::random_id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn leftovers(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with(".zood-saving-"))
            .collect()
    }

    #[test]
    fn a_save_replaces_the_file_whole_and_leaves_nothing_beside_it() {
        let dir = folder("whole");
        let file = dir.join("تقرير 😀.pdf");
        write_whole(&file, b"%PDF-1.7 first").unwrap();
        write_whole(&file, b"%PDF-1.7 second, longer").unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), b"%PDF-1.7 second, longer");
        write_whole(&file, b"").unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), b"");
        assert!(leftovers(&dir).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_save_that_cannot_finish_leaves_the_original_as_it_was() {
        let dir = folder("fails");
        // The target is a folder: the rename fails after the bytes are written.
        let taken = dir.join("taken.pdf");
        std::fs::create_dir(&taken).unwrap();
        assert!(write_whole(&taken, b"new").is_err());
        assert!(taken.is_dir());
        // A folder that is not there: nothing is written anywhere.
        assert!(write_whole(&dir.join("gone").join("x.pdf"), b"new").is_err());
        assert!(leftovers(&dir).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_folder_that_takes_no_new_file_still_saves_the_chosen_one() {
        // As a Mac's Desktop before ZOOD is let into it: the chosen file may
        // be written, nothing may be added beside it. (Run as root, the
        // folder takes the file anyway, and the save is whole as usual.)
        use std::os::unix::fs::PermissionsExt;
        let dir = folder("closed");
        let file = dir.join("chosen.pdf");
        std::fs::write(&file, b"old").unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555)).unwrap();
        let saved = write_whole(&file, b"new and longer");
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        saved.unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), b"new and longer");
        assert!(leftovers(&dir).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn a_file_another_program_keeps_from_being_replaced_is_still_saved() {
        // Open as a program that lets others write the file but not replace
        // it: the rename is refused, and the save is written in place, as
        // saves always were.
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_READ: u32 = 0x1;
        const FILE_SHARE_WRITE: u32 = 0x2;
        let dir = folder("held");
        let file = dir.join("held.pdf");
        std::fs::write(&file, b"old").unwrap();
        let held = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .open(&file)
            .unwrap();
        write_whole(&file, b"new and longer").unwrap();
        drop(held);
        assert_eq!(std::fs::read(&file).unwrap(), b"new and longer");
        assert!(leftovers(&dir).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_read_only_file_is_not_written_over() {
        let dir = folder("readonly");
        let file = dir.join("kept.pdf");
        std::fs::write(&file, b"original").unwrap();
        let mut permissions = std::fs::metadata(&file).unwrap().permissions();
        permissions.set_readonly(true);
        std::fs::set_permissions(&file, permissions.clone()).unwrap();
        let e = write_whole(&file, b"new").unwrap_err();
        assert_eq!(e.kind(), std::io::ErrorKind::PermissionDenied);
        assert_eq!(std::fs::read(&file).unwrap(), b"original");
        #[allow(clippy::permissions_set_readonly_false)]
        permissions.set_readonly(false);
        std::fs::set_permissions(&file, permissions).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_file_too_large_to_hold_is_refused_not_read() {
        let dir = folder("big");
        // Sparse: 3 GB on paper, nothing on the disk.
        let huge = dir.join("huge.pdf");
        std::fs::File::create(&huge)
            .unwrap()
            .set_len(3 * 1024 * 1024 * 1024)
            .unwrap();
        let e = read_bounded(&huge, MAX_OPEN_BYTES).unwrap_err();
        assert!(e.starts_with("E_TOO_BIG"), "{e}");
        let small = dir.join("small.pdf");
        std::fs::write(&small, b"%PDF-1.7").unwrap();
        assert_eq!(read_bounded(&small, MAX_OPEN_BYTES).unwrap(), b"%PDF-1.7");
        let empty = dir.join("empty.pdf");
        std::fs::write(&empty, b"").unwrap();
        assert!(read_bounded(&empty, MAX_OPEN_BYTES).unwrap().is_empty());
        assert!(read_bounded(&dir.join("gone.pdf"), MAX_OPEN_BYTES)
            .unwrap_err()
            .starts_with("E_IO"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_file_that_never_ends_is_refused() {
        // Its size says 0; reading it would never stop.
        let e = read_bounded(Path::new("/dev/zero"), 1024 * 1024).unwrap_err();
        assert!(e.starts_with("E_TOO_BIG"), "{e}");
    }

    #[cfg(unix)]
    #[test]
    fn a_link_stays_a_link_and_the_file_keeps_its_mode() {
        use std::os::unix::fs::PermissionsExt;
        let dir = folder("link");
        let real = dir.join("real.pdf");
        std::fs::write(&real, b"old").unwrap();
        std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o640)).unwrap();
        let link = dir.join("link.pdf");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        write_whole(&link, b"new").unwrap();
        assert!(std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(std::fs::read(&real).unwrap(), b"new");
        let mode = std::fs::metadata(&real).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o640);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
