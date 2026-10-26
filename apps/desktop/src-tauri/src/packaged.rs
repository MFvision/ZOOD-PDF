//! The copy installed from the Microsoft Store (docs/store.md).
//!
//! The same program runs from the installer and from the Store package
//! (`windows/store/AppxManifest.xml`); it asks Windows which one it is. A
//! package's registry writes stay inside the package, where Explorer and
//! sign-in never look, so the packaged copy does what the installer copy does
//! with the registry in the package's own ways:
//! - the right-click menu is the package's COM add-on (`shell-ext/`), which
//!   reads the menu the app writes here (`shell_menu.rs`, `packaged_menu`);
//! - starting at sign-in is the package's startup task, turned on and off here;
//! - updates come from the Store, not the app's own updater (`updates.rs`).

/// The package's family name, or `None` when this copy came from the
/// installer (or is not on Windows).
pub fn family_name() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        use std::sync::OnceLock;
        static NAME: OnceLock<Option<String>> = OnceLock::new();
        NAME.get_or_init(system::family_name).clone()
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

/// Whether this copy runs from the Store package.
pub fn is_packaged() -> bool {
    family_name().is_some()
}

/// The package's startup task (`ZoodPDFBackground` in the manifest), which
/// starts the app at sign-in with `--background`.
#[cfg(target_os = "windows")]
pub const STARTUP_TASK: &str = "ZoodPDFBackground";

#[cfg(target_os = "windows")]
pub use system::set_start_at_sign_in;

#[cfg(target_os = "windows")]
mod system {
    use windows_sys::Win32::Foundation::ERROR_INSUFFICIENT_BUFFER;
    use windows_sys::Win32::Storage::Packaging::Appx::GetCurrentPackageFamilyName;

    pub fn family_name() -> Option<String> {
        let mut len = 0u32;
        // SAFETY: a size query; without a package Windows answers
        // APPMODEL_ERROR_NO_PACKAGE and leaves `len` alone.
        let code = unsafe { GetCurrentPackageFamilyName(&mut len, std::ptr::null_mut()) };
        if code != ERROR_INSUFFICIENT_BUFFER || len == 0 {
            return None;
        }
        let mut buffer = vec![0u16; len as usize];
        // SAFETY: a buffer of the size Windows asked for.
        let code = unsafe { GetCurrentPackageFamilyName(&mut len, buffer.as_mut_ptr()) };
        if code != 0 {
            return None;
        }
        let end = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
        Some(String::from_utf16_lossy(&buffer[..end]))
    }

    /// Turns the startup task on or off. Windows lets the person switch it
    /// off in Task Manager › Startup apps, and that choice wins: the app
    /// then stays ready only until sign-out, as a log line says.
    pub fn set_start_at_sign_in(on: bool) -> Result<(), String> {
        use std::sync::Once;
        use windows::core::HSTRING;
        use windows::ApplicationModel::{StartupTask, StartupTaskState};
        use windows::Win32::System::Com::CoIncrementMTAUsage;

        // The Windows Runtime wants COM on the calling thread; an MTA kept
        // for the process's life covers every thread Tauri runs commands on.
        static MTA: Once = Once::new();
        // SAFETY: no arguments; the cookie is kept, never released.
        MTA.call_once(|| {
            let _ = unsafe { CoIncrementMTAUsage() };
        });
        let fail = |e: windows::core::Error| format!("E_IO: startup task: {e}");
        let task = StartupTask::GetAsync(&HSTRING::from(super::STARTUP_TASK))
            .and_then(|op| op.get())
            .map_err(fail)?;
        if !on {
            return task.Disable().map_err(fail);
        }
        let state = task
            .RequestEnableAsync()
            .and_then(|op| op.get())
            .map_err(fail)?;
        if state != StartupTaskState::Enabled && state != StartupTaskState::EnabledByPolicy {
            crate::core_bridge::debug_log(format!(
                "startup task not turned on: state {} (off in Task Manager or by policy)",
                state.0
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_test_run_is_not_the_store_package() {
        assert!(!super::is_packaged());
        assert_eq!(super::family_name(), None);
    }
}
