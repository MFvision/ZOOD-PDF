//! What the menu shows and runs, with nothing of Windows in it, so it is
//! tested on any machine.
//!
//! The app writes the menu, in its own language and with the tools Settings
//! chose, to `shell-menu.json` in its local data folder whenever the
//! interface starts or the person changes the menu in Settings
//! (`src/shell_menu.rs`, `packaged_menu`). This DLL only reads it. Until the
//! app has run once there is no file, and the menu offers the quick window
//! with every tool (`fallback`).
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::Deserialize;

/// The app's folder under `%LOCALAPPDATA%`: Tauri names it after the app's
/// identifier (`tauri.conf.json`).
pub const APP_FOLDER: &str = "app.warraq.desktop";
pub const MENU_FILE: &str = "shell-menu.json";

/// The app's command-line name from the Store package
/// (`windows/store/AppxManifest.xml`, `AppExecutionAlias`). Started through
/// it, the app runs as the package, with the package's own data.
pub const ALIAS: &str = "zoodpdf.exe";
/// The app beside this DLL, when the alias is missing.
pub const EXE: &str = "warraq-desktop.exe";

/// The two COM classes the manifest declares: the PDF entry with its submenu
/// of tools, and "Convert to PDF" on pictures and Office, text and web files.
pub const CLSID_QUICK: u128 = 0x672e4d98_232c_4a9d_a642_feb595a16ee7;
pub const CLSID_TO_PDF: u128 = 0x0e85bbbe_5ba1_4875_a24b_311b2ca508fa;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct Item {
    /// The quick tool (`src/quick.rs`, `TOOLS`), or none for the quick
    /// window with every tool.
    pub tool: Option<String>,
    pub label: String,
    #[serde(default)]
    pub separator_before: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct Menu {
    /// Off in Settings: the entries are hidden, not removed (a Store package
    /// declares them once, at install).
    pub on: bool,
    /// The PDF entry, which opens the submenu of `items`.
    pub title: String,
    pub items: Vec<Item>,
    /// The entry on pictures and Office, text and web files.
    pub to_pdf: String,
}

impl Menu {
    /// The menu before the app has written one: the quick window with every
    /// tool, in Windows' own language.
    pub fn fallback(arabic: bool) -> Menu {
        let (title, all, to_pdf) = if arabic {
            (
                "محرر زود PDF: أدوات سريعة",
                "كل الأدوات…",
                "تحويل إلى PDF (محرر زود PDF)",
            )
        } else {
            (
                "ZOOD PDF: quick tools",
                "All tools…",
                "Convert to PDF (ZOOD PDF)",
            )
        };
        Menu {
            on: true,
            title: title.to_string(),
            items: vec![Item {
                tool: None,
                label: all.to_string(),
                separator_before: false,
            }],
            to_pdf: to_pdf.to_string(),
        }
    }

    /// The menu in `text`, or `None` when it cannot be read or lists nothing.
    pub fn parse(text: &str) -> Option<Menu> {
        let menu: Menu = serde_json::from_str(text).ok()?;
        (!menu.title.trim().is_empty() && !menu.items.is_empty()).then_some(menu)
    }
}

/// The package's full name from a path inside its install folder,
/// `...\WindowsApps\<full name>\...`.
pub fn package_full_name(path: &Path) -> Option<String> {
    let mut parts = path.components().map(|c| c.as_os_str().to_string_lossy());
    parts
        .by_ref()
        .find(|part| part.eq_ignore_ascii_case("WindowsApps"))?;
    let name = parts.next()?;
    (name.split('_').count() == 5).then(|| name.into_owned())
}

/// A package's family name from its full name: `Name_Version_Arch_Resource_
/// PublisherId` gives `Name_PublisherId`.
pub fn family_name(full_name: &str) -> Option<String> {
    let parts: Vec<&str> = full_name.split('_').collect();
    match parts.as_slice() {
        [name, _, _, _, publisher] if !name.is_empty() && !publisher.is_empty() => {
            Some(format!("{name}_{publisher}"))
        }
        _ => None,
    }
}

/// Where the app's menu file may be. A packaged app's writes to its local
/// data land in the package's own copy of that folder (`Packages\<family>\
/// LocalCache\Local`), which only the package's processes see in place; a
/// folder that already existed before the package was installed may be
/// written where it is. Both are read and the newer one wins (`newest`).
pub fn menu_files(local_app_data: &Path, family: Option<&str>) -> Vec<PathBuf> {
    let mut files = Vec::new();
    if let Some(family) = family {
        files.push(
            local_app_data
                .join("Packages")
                .join(family)
                .join("LocalCache")
                .join("Local")
                .join(APP_FOLDER)
                .join(MENU_FILE),
        );
    }
    files.push(local_app_data.join(APP_FOLDER).join(MENU_FILE));
    files
}

/// The most recently written of `files` that exist.
pub fn newest(files: &[PathBuf]) -> Option<PathBuf> {
    files
        .iter()
        .filter_map(|file| {
            let changed = std::fs::metadata(file)
                .ok()?
                .modified()
                .unwrap_or(SystemTime::UNIX_EPOCH);
            Some((changed, file))
        })
        .max_by_key(|(changed, _)| *changed)
        .map(|(_, file)| file.clone())
}

/// The menu to show: the newest file the app wrote, or the fallback.
pub fn load(local_app_data: Option<&Path>, family: Option<&str>, arabic: bool) -> Menu {
    local_app_data
        .and_then(|dir| newest(&menu_files(dir, family)))
        .and_then(|file| std::fs::read_to_string(file).ok())
        .and_then(|text| Menu::parse(&text))
        .unwrap_or_else(|| Menu::fallback(arabic))
}

/// The app's arguments for `tool` on `files`, as the app reads them
/// (`src/quick.rs`, `parse`): the same as the registry menu's command.
pub fn arguments(tool: Option<&str>, files: &[OsString]) -> Vec<OsString> {
    let mut args = vec![OsString::from("--quick")];
    if let Some(tool) = tool {
        args.push(OsString::from(format!("--tool={tool}")));
    }
    args.extend(files.iter().cloned());
    args
}

/// Windows language ids whose primary language is Arabic.
pub fn is_arabic_language(lang_id: u16) -> bool {
    lang_id & 0x3ff == 0x01
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_menu_the_app_wrote() {
        let text = r#"{"on":true,"title":"ZOOD PDF: quick tools","items":[
            {"tool":"compress","label":"Compress"},
            {"tool":null,"label":"All tools…","separator_before":true}],
            "to_pdf":"Convert to PDF (ZOOD PDF)"}"#;
        let menu = Menu::parse(text).unwrap();
        assert!(menu.on);
        assert_eq!(menu.items[0].tool.as_deref(), Some("compress"));
        assert!(!menu.items[0].separator_before);
        assert!(menu.items[1].separator_before);
        assert_eq!(menu.items[1].tool, None);
    }

    #[test]
    fn a_broken_or_empty_menu_is_not_used() {
        assert_eq!(Menu::parse("{"), None);
        assert_eq!(
            Menu::parse(r#"{"on":true,"title":"x","items":[],"to_pdf":"y"}"#),
            None
        );
        assert_eq!(
            Menu::parse(
                r#"{"on":true,"title":" ","items":[{"tool":null,"label":"a"}],"to_pdf":"y"}"#
            ),
            None
        );
    }

    #[test]
    fn the_fallback_opens_every_tool_in_windows_language() {
        let ar = Menu::fallback(true);
        assert!(ar.on);
        assert_eq!(ar.items.len(), 1);
        assert_eq!(ar.items[0].tool, None);
        assert!(ar.title.contains("زود"));
        assert_eq!(Menu::fallback(false).title, "ZOOD PDF: quick tools");
        assert!(is_arabic_language(0x0401));
        assert!(is_arabic_language(0x3c01));
        assert!(!is_arabic_language(0x0409));
    }

    #[test]
    fn the_package_is_found_from_the_dll_path() {
        let path = Path::new(
            r"C:\Program Files\WindowsApps\ZoodPDF.App_0.5.0.0_x64__8wekyb3d8bbwe\zood_shell_ext.dll",
        );
        // Backslashes only separate on Windows; elsewhere the test splits by hand.
        let path: PathBuf = path.to_string_lossy().split('\\').collect();
        let full = package_full_name(&path).unwrap();
        assert_eq!(full, "ZoodPDF.App_0.5.0.0_x64__8wekyb3d8bbwe");
        assert_eq!(
            family_name(&full).as_deref(),
            Some("ZoodPDF.App_8wekyb3d8bbwe")
        );
        assert_eq!(
            package_full_name(Path::new("/tmp/zood_shell_ext.dll")),
            None
        );
        assert_eq!(family_name("nonsense"), None);
    }

    #[test]
    fn the_newer_menu_file_wins_and_a_missing_one_falls_back() {
        let dir = std::env::temp_dir().join(format!("zood-shell-ext-{}", std::process::id()));
        let files = menu_files(&dir, Some("ZoodPDF.App_x"));
        assert_eq!(files.len(), 2);
        assert!(files[0].ends_with(Path::new(
            "Packages/ZoodPDF.App_x/LocalCache/Local/app.warraq.desktop/shell-menu.json"
        )));
        assert_eq!(
            load(Some(&dir), Some("ZoodPDF.App_x"), false),
            Menu::fallback(false)
        );

        let write = |file: &PathBuf, title: &str| {
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(
                file,
                format!(r#"{{"on":false,"title":"{title}","items":[{{"tool":"word","label":"Word"}}],"to_pdf":"p"}}"#),
            )
            .unwrap();
        };
        write(&files[1], "old");
        std::thread::sleep(std::time::Duration::from_millis(50));
        write(&files[0], "new");
        let menu = load(Some(&dir), Some("ZoodPDF.App_x"), false);
        assert_eq!(menu.title, "new");
        assert!(!menu.on);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The classes, the alias and the program the manifest names are the
    /// ones this DLL answers to and starts.
    #[test]
    fn the_manifest_declares_what_the_dll_answers() {
        let manifest = include_str!("../../windows/store/AppxManifest.xml");
        let guid = |value: u128| {
            let hex = format!("{value:032x}");
            format!(
                "{}-{}-{}-{}-{}",
                &hex[..8],
                &hex[8..12],
                &hex[12..16],
                &hex[16..20],
                &hex[20..]
            )
        };
        for clsid in [CLSID_QUICK, CLSID_TO_PDF] {
            let id = guid(clsid);
            assert!(
                manifest.contains(&format!(
                    r#"<com:Class Id="{id}" Path="zood_shell_ext.dll""#
                )),
                "{id}"
            );
            assert!(manifest.contains(&format!(r#"Clsid="{id}""#)), "{id}");
        }
        assert!(manifest.contains(&format!(r#"Alias="{ALIAS}""#)));
        assert!(manifest.contains(&format!(r#"Executable="{EXE}""#)));
    }

    #[test]
    fn the_arguments_match_the_registry_menu() {
        let files = vec![OsString::from(r"C:\a b.pdf"), OsString::from(r"C:\c.pdf")];
        assert_eq!(
            arguments(Some("compress"), &files),
            ["--quick", "--tool=compress", r"C:\a b.pdf", r"C:\c.pdf"].map(OsString::from)
        );
        assert_eq!(
            arguments(None, &files[..1]),
            ["--quick", r"C:\a b.pdf"].map(OsString::from)
        );
    }
}
