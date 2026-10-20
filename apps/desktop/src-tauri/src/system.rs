//! Small questions to the system from Settings: the person's name for the
//! home screen's greeting, and the system's page for choosing the app that
//! opens PDFs.

/// The signed-in person's name: the full name where the system keeps one
/// (macOS), else the account name. Empty when neither can be read.
#[tauri::command]
pub fn system_user_name() -> String {
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = std::process::Command::new("/usr/bin/id").arg("-F").output() {
            let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if output.status.success() && !name.is_empty() {
                return name;
            }
        }
    }
    let name = std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_default();
    tidy(&name)
}

/// An account name as a greeting would say it: "mohammed.f" is "Mohammed".
pub fn tidy(account: &str) -> String {
    let first = account
        .split(['.', '_', '-', ' '])
        .find(|part| !part.is_empty())
        .unwrap_or("");
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
    {
        return std::process::Command::new("explorer")
            .arg("ms-settings:defaultapps")
            .spawn()
            .is_ok();
    }
    #[cfg(not(target_os = "windows"))]
    false
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
    }
}
