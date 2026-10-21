//! Small questions to the system from Settings: the person's name for the
//! home screen's greeting, and the system's page for choosing the app that
//! opens PDFs.

/// The signed-in person's name: the full name where the system keeps one
/// (macOS, a Windows work account), else the account name. Empty when
/// neither can be read or the account is a shared one ("Admin", "User"),
/// so the greeting says "Good evening" without a name rather than a wrong one.
#[tauri::command]
pub fn system_user_name() -> String {
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = std::process::Command::new("/usr/bin/id").arg("-F").output() {
            let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if output.status.success() && !name.is_empty() {
                return tidy(&name);
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Some(name) = windows_display_name() {
            return tidy(&name);
        }
    }
    let name = std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_default();
    tidy(&name)
}

/// The account's display name ("Ahmad Ali") where Windows knows one: a work
/// or school account. A home PC's local account has none.
#[cfg(target_os = "windows")]
fn windows_display_name() -> Option<String> {
    use windows_sys::Win32::Security::Authentication::Identity::{GetUserNameExW, NameDisplay};
    let mut buffer = [0u16; 256];
    let mut size = buffer.len() as u32;
    let ok = unsafe { GetUserNameExW(NameDisplay, buffer.as_mut_ptr(), &mut size) };
    if ok == 0 || size == 0 {
        return None;
    }
    let name = String::from_utf16_lossy(&buffer[..size as usize]).trim().to_string();
    (!name.is_empty()).then_some(name)
}

/// Account names that belong to a computer, not a person.
const NOT_A_NAME: &[&str] = &[
    "admin", "administrator", "user", "users", "owner", "guest", "default", "root", "pc", "desktop", "laptop", "home",
    "office", "staff", "test", "local", "windows", "mac", "macbook", "student", "public",
];

/// A name as a greeting would say it: "mohammed.f" is "Mohammed", "Ahmad Ali"
/// is "Ahmad". Empty for a shared or machine account ("Admin", "User1",
/// "DESKTOP-4F2K"), which says nothing about who is sitting there.
pub fn tidy(account: &str) -> String {
    let first = account
        .split(['.', '_', '-', ' '])
        .find(|part| !part.is_empty())
        .unwrap_or("");
    if NOT_A_NAME.contains(&first.to_lowercase().as_str()) || first.chars().any(|c| c.is_ascii_digit() || c == '@') {
        return String::new();
    }
    let mut chars = first.chars();
    match chars.next() {
        Some(c) => c.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// Opens Windows' "Default apps" page, where the person makes this app the
/// one for PDFs (an app may not make itself the default). False elsewhere.
#[tauri::command]
pub fn open_default_apps() -> bool {
    #[cfg(target_os = "windows")]
    let opened = std::process::Command::new("explorer")
        .arg("ms-settings:defaultapps")
        .spawn()
        .is_ok();
    #[cfg(not(target_os = "windows"))]
    let opened = false;
    opened
}

#[cfg(test)]
mod tests {
    use super::tidy;

    #[test]
    fn an_account_name_reads_as_a_first_name() {
        assert_eq!(tidy("mohammed.f"), "Mohammed");
        assert_eq!(tidy("sara"), "Sara");
        assert_eq!(tidy(""), "");
        assert_eq!(tidy("محمد"), "محمد");
        assert_eq!(tidy("Ahmad Ali"), "Ahmad");
        assert_eq!(tidy("نورة"), "نورة");
    }

    #[test]
    fn a_shared_or_machine_account_has_no_name() {
        assert_eq!(tidy("Admin"), "");
        assert_eq!(tidy("Administrator"), "");
        assert_eq!(tidy("user"), "");
        assert_eq!(tidy("User1"), "");
        assert_eq!(tidy("DESKTOP-4F2K9"), "");
        assert_eq!(tidy("Owner"), "");
    }
}
