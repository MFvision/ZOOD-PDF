//! The file manager's right-click menu for the quick tools (`quick.rs`).
//!
//! Windows: entries under the person's own classes
//! (`HKCU\Software\Classes\SystemFileAssociations`), so no administrator is
//! needed and nothing outside this account changes. A PDF gets one entry with
//! a submenu of tools; a picture or an Office, text or web file gets "Convert
//! to PDF". The interface writes them at start, in its language, and takes
//! them away when the person turns the menu off in Settings; the uninstaller
//! takes them away too (`windows/hooks.nsh`). On Windows 11 they are under
//! "Show more options" (or Shift + right-click): the new short menu takes
//! only packaged extensions.
//!
//! macOS: one service, "Quick PDF tools", declared in `Info.plist` and
//! answered by the running app (`services` below); Finder lists it under
//! Quick Actions or Services. macOS itself turns it on or off (System
//! Settings > Keyboard > Keyboard Shortcuts > Services).
use serde::Serialize;

/// The key every PDF entry lives under, and the one for "Convert to PDF".
pub const PDF_VERB: &str = "ZoodPDF.Quick";
pub const TO_PDF_VERB: &str = "ZoodPDF.ToPdf";

/// The files "Convert to PDF" is offered on (`packages/ui/src/create/createPdf.ts`):
/// every picture through Windows' own `image` class, and these by extension.
pub const TO_PDF_TYPES: &[&str] = &[
    "image", ".docx", ".xlsx", ".pptx", ".txt", ".md", ".html", ".htm", ".csv",
];

/// The PDF submenu, in order: the tool, and its name in Arabic and English.
const PDF_TOOLS: &[(&str, &str, &str)] = &[
    ("compress", "ضغط الحجم", "Compress"),
    ("word", "تحويل إلى Word", "Convert to Word"),
    ("images", "تحويل إلى صور", "Convert to pictures"),
    ("ocr", "التعرّف على النص (OCR)", "Recognize text (OCR)"),
    ("combine", "دمج في ملف واحد", "Combine into one file"),
    ("rotate", "تدوير الصفحات", "Rotate pages"),
    ("extract", "استخراج صفحات", "Extract pages"),
    ("protect", "حماية بكلمة مرور", "Protect with a password"),
];

/// A registry key and the string values to set on it ("" is the default value).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeySpec {
    pub path: String,
    pub values: Vec<(String, String)>,
}

fn key(path: String, values: &[(&str, String)]) -> KeySpec {
    KeySpec {
        path,
        values: values
            .iter()
            .map(|(name, value)| (name.to_string(), value.clone()))
            .collect(),
    }
}

fn arabic(lang: &str) -> bool {
    !lang.starts_with("en")
}

/// `"exe" --quick --tool=<tool> "%1"`: Explorer puts the file where `%1` is.
fn command(exe: &str, tool: Option<&str>) -> String {
    match tool {
        Some(tool) => format!("\"{exe}\" --quick --tool={tool} \"%1\""),
        None => format!("\"{exe}\" --quick \"%1\""),
    }
}

/// Where the entries go, under `root` (`Software\Classes` for real).
pub fn verb_roots(root: &str) -> Vec<String> {
    std::iter::once(format!(
        r"{root}\SystemFileAssociations\.pdf\shell\{PDF_VERB}"
    ))
    .chain(
        TO_PDF_TYPES
            .iter()
            .map(|kind| format!(r"{root}\SystemFileAssociations\{kind}\shell\{TO_PDF_VERB}")),
    )
    .collect()
}

/// Every key the menu needs, parents first.
pub fn plan(root: &str, exe: &str, lang: &str) -> Vec<KeySpec> {
    let ar = arabic(lang);
    let icon = format!("\"{exe}\",0");
    let roots = verb_roots(root);
    let pdf = &roots[0];
    let mut keys = vec![key(
        pdf.clone(),
        &[
            (
                "MUIVerb",
                if ar {
                    "محرر PDF: أدوات سريعة"
                } else {
                    "PDF Editor: quick tools"
                }
                .to_string(),
            ),
            ("Icon", icon.clone()),
            // An empty SubCommands: the submenu is the `shell` key below.
            ("SubCommands", String::new()),
        ],
    )];
    for (index, (tool, name_ar, name_en)) in PDF_TOOLS.iter().enumerate() {
        let item = format!(r"{pdf}\shell\{:02}{tool}", index + 1);
        keys.push(key(
            item.clone(),
            &[
                ("MUIVerb", if ar { name_ar } else { name_en }.to_string()),
                // One launch for many selected files, past Explorer's limit of 15.
                ("MultiSelectModel", "Player".to_string()),
            ],
        ));
        keys.push(key(
            format!(r"{item}\command"),
            &[("", command(exe, Some(tool)))],
        ));
    }
    let all = format!(r"{pdf}\shell\99all");
    keys.push(key(
        all.clone(),
        &[
            (
                "MUIVerb",
                if ar {
                    "كل الأدوات…"
                } else {
                    "All tools…"
                }
                .to_string(),
            ),
            ("MultiSelectModel", "Player".to_string()),
            // ECF_SEPARATORBEFORE
            ("CommandFlags", "dword:32".to_string()),
        ],
    ));
    keys.push(key(format!(r"{all}\command"), &[("", command(exe, None))]));
    for verb in &roots[1..] {
        keys.push(key(
            verb.clone(),
            &[
                (
                    "MUIVerb",
                    if ar {
                        "تحويل إلى PDF (محرر PDF)"
                    } else {
                        "Convert to PDF (PDF Editor)"
                    }
                    .to_string(),
                ),
                ("Icon", icon.clone()),
                ("MultiSelectModel", "Player".to_string()),
            ],
        ));
        keys.push(key(
            format!(r"{verb}\command"),
            &[("", command(exe, Some("topdf")))],
        ));
    }
    keys
}

/// What the interface shows in Settings.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct MenuState {
    /// `registry` (Windows: the switch works), `service` (macOS: the system's
    /// own switch), or `none`.
    pub kind: &'static str,
    pub on: bool,
}

#[cfg(target_os = "windows")]
mod registry {
    use super::KeySpec;
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegDeleteKeyValueW, RegDeleteTreeW, RegOpenKeyExW,
        RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_READ, KEY_WRITE, REG_DWORD,
        REG_OPTION_NON_VOLATILE, REG_SZ,
    };

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn check(code: u32, what: &str) -> Result<(), String> {
        if code == 0 {
            Ok(())
        } else {
            Err(format!("E_IO: {what}: Windows error {code}"))
        }
    }

    pub fn write(keys: &[KeySpec]) -> Result<(), String> {
        for spec in keys {
            let path = wide(&spec.path);
            let mut handle: HKEY = std::ptr::null_mut();
            // SAFETY: every pointer is to a live, NUL-terminated buffer or a
            // local out-parameter; the handle is closed below.
            let code = unsafe {
                RegCreateKeyExW(
                    HKEY_CURRENT_USER,
                    path.as_ptr(),
                    0,
                    std::ptr::null(),
                    REG_OPTION_NON_VOLATILE,
                    KEY_WRITE,
                    std::ptr::null(),
                    &mut handle,
                    std::ptr::null_mut(),
                )
            };
            check(code, &spec.path)?;
            let mut result = Ok(());
            for (name, value) in &spec.values {
                let name_w = wide(name);
                let code = if let Some(number) = value.strip_prefix("dword:") {
                    let number: u32 = number.parse().unwrap_or(0);
                    let bytes = number.to_le_bytes();
                    // SAFETY: as above; four bytes for a REG_DWORD.
                    unsafe {
                        RegSetValueExW(handle, name_w.as_ptr(), 0, REG_DWORD, bytes.as_ptr(), 4)
                    }
                } else {
                    let data = wide(value);
                    // SAFETY: as above; the length counts the closing NUL, in bytes.
                    unsafe {
                        RegSetValueExW(
                            handle,
                            name_w.as_ptr(),
                            0,
                            REG_SZ,
                            data.as_ptr().cast(),
                            (data.len() * 2) as u32,
                        )
                    }
                };
                if let Err(e) = check(code, &spec.path) {
                    result = Err(e);
                    break;
                }
            }
            // SAFETY: the handle was opened above.
            unsafe { RegCloseKey(handle) };
            result?;
        }
        Ok(())
    }

    pub fn remove(paths: &[String]) -> Result<(), String> {
        for path in paths {
            let path_w = wide(path);
            // SAFETY: a NUL-terminated path under the current user's key.
            let code = unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, path_w.as_ptr()) };
            // 2: not there, which is what was wanted.
            if code != 0 && code != 2 {
                return Err(format!("E_IO: {path}: Windows error {code}"));
            }
        }
        Ok(())
    }

    /// Sets a string value, or deletes it when `value` is `None`.
    pub fn set_value(path: &str, name: &str, value: Option<&str>) -> Result<(), String> {
        match value {
            Some(value) => write(&[KeySpec {
                path: path.to_string(),
                values: vec![(name.to_string(), value.to_string())],
            }]),
            None => {
                let (path_w, name_w) = (wide(path), wide(name));
                // SAFETY: NUL-terminated strings under the current user's key.
                let code = unsafe {
                    RegDeleteKeyValueW(HKEY_CURRENT_USER, path_w.as_ptr(), name_w.as_ptr())
                };
                // 2: not there, which is what was wanted.
                if code != 0 && code != 2 {
                    return Err(format!("E_IO: {path}: Windows error {code}"));
                }
                Ok(())
            }
        }
    }

    pub fn exists(path: &str) -> bool {
        let path_w = wide(path);
        let mut handle: HKEY = std::ptr::null_mut();
        // SAFETY: as in `write`.
        let code =
            unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, path_w.as_ptr(), 0, KEY_READ, &mut handle) };
        if code == 0 {
            // SAFETY: opened just now.
            unsafe { RegCloseKey(handle) };
        }
        code == 0
    }
}

#[cfg(target_os = "windows")]
pub use registry::{
    exists as registry_key_exists, remove as registry_remove, write as registry_write,
};

const CLASSES: &str = r"Software\Classes";

/// Where Windows starts programs at sign-in, for this account.
#[cfg(target_os = "windows")]
const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
#[cfg(target_os = "windows")]
const RUN_VALUE: &str = "ZoodPDF";

/// Starts `command` at sign-in, or nothing when `None` (the ring's
/// "Keep the quick tools ready", `ring.rs`).
#[cfg(target_os = "windows")]
pub fn set_run_at_sign_in(command: Option<String>) -> Result<(), String> {
    registry::set_value(RUN, RUN_VALUE, command.as_deref())
}

/// Puts the menu in, in `lang`, pointing at this program; or takes it out.
#[tauri::command]
pub fn shell_menu_set(on: bool, lang: String) -> Result<MenuState, String> {
    #[cfg(target_os = "windows")]
    {
        let exe = std::env::current_exe().map_err(|e| format!("E_IO: {e}"))?;
        let exe = exe.to_string_lossy();
        if on {
            registry::write(&plan(CLASSES, &exe, &lang))?;
        } else {
            registry::remove(&verb_roots(CLASSES))?;
        }
        Ok(MenuState {
            kind: "registry",
            on,
        })
    }
    #[cfg(target_os = "macos")]
    {
        let _ = (on, lang);
        Ok(MenuState {
            kind: "service",
            on: true,
        })
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = (on, lang, CLASSES);
        Ok(MenuState {
            kind: "none",
            on: false,
        })
    }
}

/// Whether the menu is in.
#[tauri::command]
pub fn shell_menu_state() -> MenuState {
    #[cfg(target_os = "windows")]
    {
        MenuState {
            kind: "registry",
            on: registry::exists(&verb_roots(CLASSES)[0]),
        }
    }
    #[cfg(target_os = "macos")]
    {
        MenuState {
            kind: "service",
            on: true,
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        MenuState {
            kind: "none",
            on: false,
        }
    }
}

/// The macOS service: Finder hands the selected files to the running app,
/// which opens a quick window on them (`quick::request`). `Info.plist` names
/// the message (`quickTools`) and the port; this registers the object that
/// answers it.
#[cfg(target_os = "macos")]
pub mod services {
    use std::path::PathBuf;
    use std::sync::OnceLock;

    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, NSObject};
    use objc2::{class, define_class, msg_send, AllocAnyThread};
    use objc2_foundation::NSString;

    type Handler = Box<dyn Fn(Vec<PathBuf>) + Send + Sync>;
    static HANDLER: OnceLock<Handler> = OnceLock::new();

    #[link(name = "AppKit", kind = "framework")]
    extern "C" {
        fn NSUpdateDynamicServices();
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "WarraqServicesProvider"]
        struct ServicesProvider;

        impl ServicesProvider {
            #[unsafe(method(quickTools:userData:error:))]
            fn quick_tools(
                &self,
                pasteboard: &AnyObject,
                _user_data: *mut AnyObject,
                _error: *mut *mut AnyObject,
            ) {
                // Nothing may unwind into Objective-C: a failure just does nothing.
                let files = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| files_on(pasteboard))).unwrap_or_default();
                if let (false, Some(handler)) = (files.is_empty(), HANDLER.get()) {
                    handler(files);
                }
            }
        }
    );

    /// The file paths Finder put on the pasteboard, as file URLs.
    fn files_on(pasteboard: &AnyObject) -> Vec<PathBuf> {
        let mut files = Vec::new();
        let file_url = NSString::from_str("public.file-url");
        // SAFETY: NSPasteboard's documented messages, each answered with
        // an object or nil.
        unsafe {
            let items: Option<Retained<AnyObject>> = msg_send![pasteboard, pasteboardItems];
            let Some(items) = items else { return files };
            let count: usize = msg_send![&*items, count];
            for index in 0..count.min(500) {
                let item: Retained<AnyObject> = msg_send![&*items, objectAtIndex: index];
                let text: Option<Retained<NSString>> = msg_send![&*item, stringForType: &*file_url];
                let Some(text) = text else { continue };
                let url: Option<Retained<AnyObject>> =
                    msg_send![class!(NSURL), URLWithString: &*text];
                let Some(url) = url else { continue };
                let path: Option<Retained<NSString>> = msg_send![&*url, path];
                if let Some(path) = path {
                    files.push(PathBuf::from(path.to_string()));
                }
            }
        }
        files
    }

    /// Answers the service from now on. Call on the main thread, early: a
    /// service picked while the app was not running is delivered once this
    /// is set.
    pub fn register(handler: impl Fn(Vec<PathBuf>) + Send + Sync + 'static) {
        if HANDLER.set(Box::new(handler)).is_err() {
            return;
        }
        // SAFETY: plain Objective-C object creation and NSApplication's
        // documented setter; the provider is kept for the app's life.
        unsafe {
            let provider: Retained<ServicesProvider> = msg_send![ServicesProvider::alloc(), init];
            let app: Retained<AnyObject> = msg_send![class!(NSApplication), sharedApplication];
            let _: () = msg_send![&*app, setServicesProvider: &*provider];
            std::mem::forget(provider);
            NSUpdateDynamicServices();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pdf_gets_a_submenu_of_tools_and_other_files_convert_to_pdf() {
        let keys = plan(
            CLASSES,
            r"C:\Program Files\محرر PDF\warraq-desktop.exe",
            "ar",
        );
        let root = r"Software\Classes\SystemFileAssociations\.pdf\shell\ZoodPDF.Quick";
        assert_eq!(keys[0].path, root);
        assert!(keys[0]
            .values
            .contains(&("MUIVerb".into(), "محرر PDF: أدوات سريعة".into())));
        assert!(keys[0]
            .values
            .contains(&("SubCommands".into(), String::new())));
        let compress = keys
            .iter()
            .find(|k| k.path == format!(r"{root}\shell\01compress\command"))
            .unwrap();
        assert_eq!(
            compress.values,
            vec![(
                String::new(),
                r#""C:\Program Files\محرر PDF\warraq-desktop.exe" --quick --tool=compress "%1""#
                    .to_string()
            )]
        );
        let docx = keys
            .iter()
            .find(|k| {
                k.path
                    == r"Software\Classes\SystemFileAssociations\.docx\shell\ZoodPDF.ToPdf\command"
            })
            .unwrap();
        assert!(docx.values[0].1.contains("--tool=topdf"));
        // Every tool named in the menu is one the quick window knows.
        for (tool, _, _) in PDF_TOOLS {
            assert!(crate::quick::TOOLS.contains(tool), "{tool}");
        }
    }

    #[test]
    fn the_menu_follows_the_interface_language() {
        let keys = plan(CLASSES, "app.exe", "en");
        assert!(keys[0]
            .values
            .contains(&("MUIVerb".into(), "PDF Editor: quick tools".into())));
    }

    #[test]
    fn parents_come_before_their_children() {
        let keys = plan(CLASSES, "app.exe", "ar");
        for (index, spec) in keys.iter().enumerate() {
            for later in &keys[index + 1..] {
                assert!(
                    !spec.path.starts_with(&format!("{}\\", later.path)),
                    "{}",
                    spec.path
                );
            }
        }
    }

    /// On Windows, the menu written under a key of the test's own, read
    /// back, and taken away.
    #[cfg(target_os = "windows")]
    #[test]
    fn the_registry_takes_the_menu_and_gives_it_back() {
        let root = format!(r"Software\WarraqTest{}", std::process::id());
        registry_write(&plan(&root, r"C:\x\warraq-desktop.exe", "ar")).unwrap();
        for path in verb_roots(&root) {
            assert!(registry_key_exists(&path), "{path}");
        }
        registry_remove(&[root.clone()]).unwrap();
        assert!(!registry_key_exists(&verb_roots(&root)[0]));
    }
}
