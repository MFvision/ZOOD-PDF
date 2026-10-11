//! The fonts installed on the device, for an edit that should be drawn in
//! the family its paragraph was set in: found by the family's name among
//! the system's and the person's font folders, never over a network.
//!
//! Only a few kilobytes of each file are read to learn what it is
//! (`fontfile::faces`); the one face chosen is then read whole — a
//! collection's face taken out as a file of its own — and checked: outlines
//! the embedder writes, a licence that allows embedding, a glyph for every
//! character of the text. A font that fails is passed over, not embedded.
use std::path::{Path, PathBuf};

use crate::fontfile::{self, FaceFacts};

/// Font files looked at in all.
const MAX_FILES: usize = 20_000;
/// Folders inside folders followed this deep.
const MAX_DEPTH: usize = 4;
/// How far from the weight asked for an installed face may be: a SemiBold
/// paragraph takes an installed Bold or Medium, never a Regular.
pub const WEIGHT_TOLERANCE: u16 = 100;

/// One installed face.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Installed {
    pub path: PathBuf,
    pub facts: FaceFacts,
}

/// Where this system keeps fonts: its own, the machine's, the person's.
pub fn system_font_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = vec![];
    #[cfg(target_os = "macos")]
    {
        dirs.push(PathBuf::from("/System/Library/Fonts"));
        dirs.push(PathBuf::from("/Library/Fonts"));
        if let Some(home) = std::env::var_os("HOME") {
            dirs.push(Path::new(&home).join("Library").join("Fonts"));
        }
    }
    #[cfg(windows)]
    {
        // `%WINDIR%\Fonts` for every user, and since Windows 10 1809 the
        // fonts a person installs for themselves under their local data.
        if let Some(windir) = std::env::var_os("WINDIR").or_else(|| std::env::var_os("SystemRoot"))
        {
            dirs.push(Path::new(&windir).join("Fonts"));
        }
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            dirs.push(
                Path::new(&local)
                    .join("Microsoft")
                    .join("Windows")
                    .join("Fonts"),
            );
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        dirs.push(PathBuf::from("/usr/share/fonts"));
        dirs.push(PathBuf::from("/usr/local/share/fonts"));
        if let Some(home) = std::env::var_os("HOME") {
            dirs.push(Path::new(&home).join(".local").join("share").join("fonts"));
            dirs.push(Path::new(&home).join(".fonts"));
        }
    }
    dirs
}

fn is_font_file(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| {
        ["ttf", "ttc", "otf", "otc"]
            .iter()
            .any(|known| e.eq_ignore_ascii_case(known))
    })
}

fn scan_dir(dir: &Path, depth: usize, files: &mut usize, out: &mut Vec<Installed>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if *files >= MAX_FILES {
            return;
        }
        let path = entry.path();
        // `metadata` follows a link; a folder linked to itself stops at the depth.
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        if meta.is_dir() {
            if depth < MAX_DEPTH {
                scan_dir(&path, depth + 1, files, out);
            }
        } else if meta.is_file() && is_font_file(&path) {
            *files += 1;
            let Ok(mut file) = std::fs::File::open(&path) else {
                continue;
            };
            out.extend(
                fontfile::faces(&mut file)
                    .into_iter()
                    .map(|facts| Installed {
                        path: path.clone(),
                        facts,
                    }),
            );
        }
    }
}

/// Every face in the font files under `dirs`.
pub fn scan(dirs: &[PathBuf]) -> Vec<Installed> {
    let mut out = vec![];
    let mut files = 0;
    for dir in dirs {
        scan_dir(dir, 0, &mut files, &mut out);
    }
    out
}

/// A font found for a face: its family as the file names it, and the face
/// as a font file of its own.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    pub family: String,
    pub weight: u16,
    pub bytes: Vec<u8>,
}

/// The installed face that best stands for `family` at `weight` and slant
/// and can draw `text`, as bytes ready for the shaper. `None` when no
/// installed face of the family is near enough, may be embedded, has
/// TrueType outlines and has every glyph the text needs.
pub fn find(
    installed: &[Installed],
    family: &str,
    weight: u16,
    italic: bool,
    text: &str,
) -> Option<Found> {
    // The nearest first; a face that cannot draw the text gives way to the
    // next nearest, a few times at most.
    let mut candidates: Vec<&Installed> = installed.iter().collect();
    for _ in 0..4 {
        let best = fontfile::best_face(
            candidates.iter().map(|i| &i.facts),
            family,
            weight,
            italic,
            WEIGHT_TOLERANCE,
        )?;
        let at = candidates
            .iter()
            .position(|i| std::ptr::eq(&i.facts, best))?;
        let chosen = candidates.remove(at);
        let bytes = std::fs::File::open(&chosen.path)
            .ok()
            .and_then(|mut file| fontfile::extract_face(&mut file, chosen.facts.index));
        if let Some(bytes) = bytes {
            if crate::Shaper::new(&bytes).is_ok_and(|shaper| shaper.covers(text)) {
                return Some(Found {
                    family: chosen.facts.families.first().cloned().unwrap_or_default(),
                    weight: chosen.facts.weight,
                    bytes,
                });
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fonts(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../tests/fonts")
            .join(name)
    }

    /// A folder of its own holding copies of the given test fonts.
    fn folder(tag: &str, names: &[&str]) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("warraq-installed-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("nested")).unwrap();
        for (i, name) in names.iter().enumerate() {
            // One of them a folder down, as a foundry's folder would be.
            let to = if i == 0 {
                dir.join("nested")
            } else {
                dir.clone()
            };
            std::fs::copy(fonts(name), to.join(Path::new(name).file_name().unwrap())).unwrap();
        }
        std::fs::write(dir.join("readme.txt"), b"not a font").unwrap();
        std::fs::write(dir.join("broken.ttf"), b"not a font either").unwrap();
        dir
    }

    #[test]
    fn a_family_is_found_by_name_at_the_nearest_weight() {
        let dir = folder(
            "find",
            &[
                "Amiri-Regular.ttf",
                "Amiri-Bold.ttf",
                "static/Inter-Regular-static.ttf",
            ],
        );
        let installed = scan(std::slice::from_ref(&dir));
        assert_eq!(
            installed.len(),
            3,
            "the text file and the broken one are passed over"
        );
        let bold = find(&installed, "Amiri", 700, false, "نص عربي").unwrap();
        assert_eq!((bold.family.as_str(), bold.weight), ("Amiri", 700));
        // What comes back is a font the shaper reads, with the text's glyphs.
        assert!(crate::Shaper::new(&bold.bytes).unwrap().covers("نص عربي"));
        assert_eq!(
            fontfile::faces(&mut std::io::Cursor::new(&bold.bytes))[0].weight,
            700
        );
        // SemiBold is not installed: Bold is the nearest within reach.
        assert_eq!(
            find(&installed, "amiri", 600, false, "x").unwrap().weight,
            700
        );
        assert_eq!(
            find(&installed, "Amiri", 400, false, "x").unwrap().weight,
            400
        );
        assert_eq!(
            find(&installed, "Inter", 400, false, "Meeting")
                .unwrap()
                .family,
            "Inter"
        );
        // Nothing near enough, no such slant, no such family.
        assert_eq!(find(&installed, "Inter", 700, false, "x"), None);
        assert_eq!(find(&installed, "Amiri", 400, true, "x"), None);
        assert_eq!(find(&installed, "Montserrat", 400, false, "x"), None);
        // A family that is there but cannot draw the text is not used.
        assert_eq!(find(&installed, "Inter", 400, false, "نص"), None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_font_whose_licence_forbids_embedding_is_passed_over() {
        let dir = folder("restricted", &["Amiri-Regular.ttf"]);
        let path = dir.join("nested").join("Amiri-Regular.ttf");
        let mut bytes = std::fs::read(&path).unwrap();
        let count = u16::from_be_bytes([bytes[4], bytes[5]]) as usize;
        let os2 = (0..count)
            .map(|i| 12 + i * 16)
            .find(|at| &bytes[*at..*at + 4] == b"OS/2")
            .map(|at| u32::from_be_bytes(bytes[at + 8..at + 12].try_into().unwrap()) as usize)
            .unwrap();
        // fsType: restricted licence embedding.
        bytes[os2 + 8..os2 + 10].copy_from_slice(&0x0002u16.to_be_bytes());
        std::fs::write(&path, bytes).unwrap();
        let installed = scan(std::slice::from_ref(&dir));
        assert_eq!(installed.len(), 1);
        assert_eq!(find(&installed, "Amiri", 400, false, "x"), None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_folder_that_is_not_there_is_no_fonts_and_no_error() {
        assert!(scan(&[PathBuf::from("/nonexistent/warraq/fonts")]).is_empty());
        assert!(scan(&[]).is_empty());
    }

    /// The real thing, on the machine the tests run on: this Mac's own
    /// Arial is found by name among its installed fonts, and Helvetica —
    /// which macOS keeps in a collection — comes out as a font of its own.
    #[cfg(target_os = "macos")]
    #[test]
    fn this_macs_own_fonts_are_found_by_name() {
        let installed = scan(&system_font_dirs());
        assert!(installed.len() > 20, "{} faces", installed.len());
        let arial = find(&installed, "Arial", 700, false, "Family Budget 2026")
            .expect("Arial Bold is installed on every Mac");
        assert_eq!((arial.family.as_str(), arial.weight), ("Arial", 700));
        assert!(crate::Shaper::new(&arial.bytes)
            .unwrap()
            .covers("Family Budget 2026"));
        // As a PDF spells it.
        assert!(find(&installed, "TimesNewRoman", 400, true, "Italic").is_some());
        let helvetica = find(&installed, "Helvetica", 400, false, "Collection")
            .expect("Helvetica is installed on every Mac, in a .ttc");
        assert!(!helvetica.bytes.starts_with(b"ttcf"));
        assert!(crate::Shaper::new(&helvetica.bytes)
            .unwrap()
            .covers("Collection"));
    }

    /// The same on Windows, where it runs in CI: Arial out of
    /// `%WINDIR%\\Fonts` by name and weight, Times New Roman as a PDF spells
    /// it, and a face out of a collection — Windows keeps Cambria and the
    /// CJK faces in `.ttc` files; Cambria is on every Windows since Vista.
    #[cfg(windows)]
    #[test]
    fn this_pcs_own_fonts_are_found_by_name() {
        let installed = scan(&system_font_dirs());
        assert!(installed.len() > 20, "{} faces", installed.len());
        let arial = find(&installed, "Arial", 700, false, "Family Budget 2026")
            .expect("Arial Bold is installed on every Windows");
        assert_eq!((arial.family.as_str(), arial.weight), ("Arial", 700));
        assert!(crate::Shaper::new(&arial.bytes)
            .unwrap()
            .covers("Family Budget 2026"));
        assert!(find(&installed, "TimesNewRoman", 400, true, "Italic").is_some());
        let cambria = find(&installed, "Cambria", 400, false, "Collection")
            .expect("Cambria is installed on every Windows, in a .ttc");
        assert!(!cambria.bytes.starts_with(b"ttcf"));
        assert!(crate::Shaper::new(&cambria.bytes)
            .unwrap()
            .covers("Collection"));
    }
}
