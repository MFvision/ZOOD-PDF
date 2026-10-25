//! Windows shortcuts (`.lnk` files) dropped on ZOOD stand for the files they
//! point at: a shortcut to a PDF on the desktop is sorted, or run through a
//! tool, as that PDF.
//!
//! The shortcut is read as Microsoft documents it ([MS-SHLLINK]): the target's
//! full path from its LinkInfo (the Unicode one when there, which Arabic names
//! need), else its path relative to the shortcut. Shortcuts to folders, to
//! things that are not files, or to files that are gone stand for nothing.
use std::path::{Path, PathBuf};

const HEADER_SIZE: usize = 0x4C;
const HAS_ID_LIST: u32 = 0x1;
const HAS_LINK_INFO: u32 = 0x2;
const HAS_NAME: u32 = 0x4;
const HAS_RELATIVE_PATH: u32 = 0x8;
const IS_UNICODE: u32 = 0x80;
const FORCE_NO_LINK_INFO: u32 = 0x100;
/// LinkInfo flag: the target is on a drive of this computer.
const LOCAL_BASE_PATH: u32 = 0x1;
/// No shortcut is bigger; a bound on reading one.
const MOST_BYTES: u64 = 1 << 20;

fn u16_at(bytes: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(bytes.get(at..at + 2)?.try_into().ok()?))
}

fn u32_at(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

/// A NUL-ended string of single bytes, if it is plain ASCII (other code
/// pages are the PC's own, and unknown here).
fn ascii_at(bytes: &[u8], at: usize) -> Option<String> {
    let rest = bytes.get(at..)?;
    let end = rest.iter().position(|b| *b == 0)?;
    let text = &rest[..end];
    text.is_ascii()
        .then(|| String::from_utf8_lossy(text).into_owned())
}

/// A NUL-ended UTF-16 string.
fn wide_at(bytes: &[u8], at: usize) -> Option<String> {
    let mut units = Vec::new();
    let mut i = at;
    loop {
        let unit = u16_at(bytes, i)?;
        if unit == 0 {
            break;
        }
        units.push(unit);
        i += 2;
    }
    String::from_utf16(&units).ok()
}

/// What a shortcut's bytes say about its target.
#[derive(Debug, Default, PartialEq)]
pub struct Target {
    /// The full path, from LinkInfo.
    pub full: Option<String>,
    /// The path from the shortcut's own folder.
    pub relative: Option<String>,
}

pub fn read(bytes: &[u8]) -> Option<Target> {
    if u32_at(bytes, 0)? as usize != HEADER_SIZE {
        return None;
    }
    let flags = u32_at(bytes, 0x14)?;
    let mut at = HEADER_SIZE;
    if flags & HAS_ID_LIST != 0 {
        at += 2 + usize::from(u16_at(bytes, at)?);
    }
    let mut target = Target::default();
    if flags & HAS_LINK_INFO != 0 && flags & FORCE_NO_LINK_INFO == 0 {
        let info = at;
        let size = u32_at(bytes, info)? as usize;
        let header = u32_at(bytes, info + 4)? as usize;
        let info_flags = u32_at(bytes, info + 8)?;
        if info_flags & LOCAL_BASE_PATH != 0 {
            let base = u32_at(bytes, info + 16)? as usize;
            let suffix = u32_at(bytes, info + 24)? as usize;
            target.full = if header >= 0x24 {
                let base_w = u32_at(bytes, info + 28)? as usize;
                let suffix_w = u32_at(bytes, info + 32)? as usize;
                let suffix = if suffix_w > 0 {
                    wide_at(bytes, info + suffix_w)
                } else {
                    Some(String::new())
                };
                (base_w > 0)
                    .then(|| wide_at(bytes, info + base_w))
                    .flatten()
                    .zip(suffix)
                    .map(|(b, s)| b + &s)
            } else {
                None
            }
            .or_else(|| Some(ascii_at(bytes, info + base)? + &ascii_at(bytes, info + suffix)?));
        }
        at = info + size;
    }
    // StringData: the name first, then the relative path, each counted in characters.
    let unicode = flags & IS_UNICODE != 0;
    let string = |at: &mut usize| -> Option<String> {
        let count = usize::from(u16_at(bytes, *at)?);
        let start = *at + 2;
        let text = if unicode {
            let units = (0..count)
                .map(|i| u16_at(bytes, start + i * 2))
                .collect::<Option<Vec<u16>>>()?;
            *at = start + count * 2;
            String::from_utf16(&units).ok()?
        } else {
            let text = bytes.get(start..start + count)?;
            *at = start + count;
            text.is_ascii()
                .then(|| String::from_utf8_lossy(text).into_owned())?
        };
        Some(text)
    };
    if flags & HAS_NAME != 0 {
        string(&mut at)?;
    }
    if flags & HAS_RELATIVE_PATH != 0 {
        target.relative = string(&mut at);
    }
    (target.full.is_some() || target.relative.is_some()).then_some(target)
}

pub fn is_shortcut(path: &Path) -> bool {
    path.extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("lnk"))
}

/// The file a dropped path stands for: itself, or a shortcut's target.
/// None for folders, and for shortcuts that lead to no file.
pub fn file_of(path: &Path) -> Option<PathBuf> {
    if !path.is_file() {
        return None;
    }
    if !is_shortcut(path) {
        return Some(path.to_path_buf());
    }
    let file = std::fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    use std::io::Read;
    file.take(MOST_BYTES).read_to_end(&mut bytes).ok()?;
    let target = read(&bytes)?;
    let full = target.full.map(PathBuf::from);
    let relative = target.relative.and_then(|r| {
        let folder = path.parent()?;
        // Shortcuts write Windows separators; a Mac or Linux test reads them too.
        Some(folder.join(r.replace('\\', std::path::MAIN_SEPARATOR_STR)))
    });
    [full, relative]
        .into_iter()
        .flatten()
        .find(|p| p.is_file() && !is_shortcut(p))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wide(text: &str) -> Vec<u8> {
        text.encode_utf16()
            .chain([0])
            .flat_map(u16::to_le_bytes)
            .collect()
    }

    /// A shortcut as Explorer writes one: an ID list, LinkInfo with both
    /// the ANSI and the Unicode path, then the relative path.
    fn shortcut(full: &str, relative: &str, unicode_info: bool) -> Vec<u8> {
        let mut bytes = vec![0u8; HEADER_SIZE];
        bytes[0] = HEADER_SIZE as u8;
        let mut flags = HAS_ID_LIST | HAS_LINK_INFO | HAS_RELATIVE_PATH | IS_UNICODE;
        flags |= 0x10; // HasWorkingDir, ignored
        bytes[0x14..0x18].copy_from_slice(&flags.to_le_bytes());
        // An ID list of 6 bytes we skip.
        bytes.extend_from_slice(&6u16.to_le_bytes());
        bytes.extend_from_slice(&[1, 2, 3, 4, 0, 0]);
        // LinkInfo.
        let header: u32 = if unicode_info { 0x24 } else { 0x1C };
        let ansi: Vec<u8> = full
            .chars()
            .map(|c| if c.is_ascii() { c as u8 } else { 0xC7 }) // the PC's code page
            .chain([0])
            .collect();
        let mut body = Vec::new();
        let volume = header as usize;
        body.extend_from_slice(&[0u8; 16]); // a VolumeID, not read
        let base = volume + body.len();
        body.extend_from_slice(&ansi);
        let suffix = volume + body.len();
        body.push(0);
        let (base_w, suffix_w) = if unicode_info {
            let base_w = volume + body.len();
            body.extend(wide(full));
            let suffix_w = volume + body.len();
            body.extend(wide(""));
            (base_w as u32, suffix_w as u32)
        } else {
            (0, 0)
        };
        let size = header + body.len() as u32;
        let mut info = Vec::new();
        for v in [
            size,
            header,
            LOCAL_BASE_PATH,
            volume as u32,
            base as u32,
            0,
            suffix as u32,
        ] {
            info.extend_from_slice(&v.to_le_bytes());
        }
        if unicode_info {
            info.extend_from_slice(&base_w.to_le_bytes());
            info.extend_from_slice(&suffix_w.to_le_bytes());
        }
        info.extend(body);
        bytes.extend(info);
        // The relative path: counted UTF-16, no NUL.
        let units: Vec<u16> = relative.encode_utf16().collect();
        bytes.extend_from_slice(&(units.len() as u16).to_le_bytes());
        bytes.extend(units.iter().flat_map(|u| u.to_le_bytes()));
        bytes.extend_from_slice(&0u16.to_le_bytes()); // working dir, empty
        bytes.extend_from_slice(&[0u8; 4]); // the extra data's end
        bytes
    }

    #[test]
    fn an_arabic_target_is_read_from_the_unicode_path() {
        let bytes = shortcut(r"C:\Users\m\Desktop\آفا آي.pdf", r".\آفا آي.pdf", true);
        let target = read(&bytes).expect("a shortcut");
        assert_eq!(
            target.full.as_deref(),
            Some(r"C:\Users\m\Desktop\آفا آي.pdf")
        );
        assert_eq!(target.relative.as_deref(), Some(r".\آفا آي.pdf"));
    }

    #[test]
    fn without_a_unicode_path_only_a_plain_one_is_trusted() {
        let bytes = shortcut(r"C:\Docs\report.pdf", r"..\Docs\report.pdf", false);
        assert_eq!(
            read(&bytes).unwrap().full.as_deref(),
            Some(r"C:\Docs\report.pdf")
        );
        // An Arabic name in the PC's code page cannot be read: the relative path stands in.
        let bytes = shortcut(r"C:\Docs\آفا.pdf", r".\آفا.pdf", false);
        let target = read(&bytes).unwrap();
        assert_eq!(target.full, None);
        assert_eq!(target.relative.as_deref(), Some(r".\آفا.pdf"));
    }

    #[test]
    fn a_dropped_shortcut_stands_for_its_file() {
        let folder = std::env::temp_dir().join(format!("zood-lnk-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&folder);
        std::fs::create_dir_all(folder.join("docs")).unwrap();
        let pdf = folder.join("docs").join("آفا آي.pdf");
        std::fs::write(&pdf, b"%PDF-1.7").unwrap();
        // The full path is a Windows one that is not here, so the relative path is used.
        let link = folder.join("آفا آي.pdf - Shortcut.lnk");
        std::fs::write(
            &link,
            shortcut(r"C:\nowhere\آفا آي.pdf", r".\docs\آفا آي.pdf", true),
        )
        .unwrap();
        assert_eq!(
            file_of(&link).as_deref(),
            Some(folder.join(".").join("docs").join("آفا آي.pdf").as_path())
        );
        // A plain file is itself; a folder, or a shortcut to nothing, is nothing.
        assert_eq!(file_of(&pdf), Some(pdf.clone()));
        assert_eq!(file_of(&folder), None);
        let broken = folder.join("gone.lnk");
        std::fs::write(&broken, shortcut(r"C:\gone.pdf", r".\gone.pdf", true)).unwrap();
        assert_eq!(file_of(&broken), None);
        std::fs::write(folder.join("junk.lnk"), b"not a shortcut").unwrap();
        assert_eq!(file_of(&folder.join("junk.lnk")), None);
        let _ = std::fs::remove_dir_all(&folder);
    }
}
