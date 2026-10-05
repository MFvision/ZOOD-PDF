//! The person's own details for filling forms — name, ID number, phone,
//! address — kept in the system's credential store: the macOS keychain,
//! Windows Credential Manager (DPAPI), the Secret Service on Linux. The same
//! `keyring` crate and the same idea as a cloud drive's token (`cloud.rs`):
//! encrypted at rest by the system, under the app's own identifier, never
//! in a file of the app's own. The webview holds the details only while it
//! shows them; nothing here is sent anywhere.
use tauri::State;

const SERVICE: &str = "app.warraq.desktop.profile";
const ENTRY: &str = "profile";
/// Windows Credential Manager keeps a blob of 2560 bytes at most; a profile
/// of nine short fields is a few hundred. Anything larger is not a profile.
const MAX_BYTES: usize = 2000;

fn keychain_err(e: keyring::Error) -> String {
    format!("E_KEYCHAIN: {e}")
}

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, ENTRY).map_err(keychain_err)
}

/// The store, so the commands can be tested against memory.
pub trait ProfileStore: Send + Sync {
    fn get(&self) -> Result<Option<String>, String>;
    fn set(&self, json: &str) -> Result<(), String>;
    fn delete(&self) -> Result<(), String>;
}

pub struct Keychain;

impl ProfileStore for Keychain {
    fn get(&self) -> Result<Option<String>, String> {
        match entry()?.get_password() {
            Ok(json) => Ok(Some(json)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(keychain_err(e)),
        }
    }

    fn set(&self, json: &str) -> Result<(), String> {
        entry()?.set_password(json).map_err(keychain_err)
    }

    fn delete(&self) -> Result<(), String> {
        match entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(keychain_err(e)),
        }
    }
}

pub struct ProfileState(pub Box<dyn ProfileStore>);

impl Default for ProfileState {
    fn default() -> Self {
        Self(Box::new(Keychain))
    }
}

/// What `profile_set` accepts: a JSON object, not too large. The interface
/// reads it back as data, field by field.
pub fn checked(json: &str) -> Result<&str, String> {
    if json.len() > MAX_BYTES {
        return Err(format!("E_ARGS: a profile is at most {MAX_BYTES} bytes"));
    }
    let value: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("E_ARGS: not JSON: {e}"))?;
    if !value.is_object() {
        return Err("E_ARGS: a profile is a JSON object".to_string());
    }
    Ok(json)
}

#[tauri::command]
pub fn profile_get(state: State<'_, ProfileState>) -> Result<Option<String>, String> {
    state.0.get()
}

#[tauri::command]
pub fn profile_set(state: State<'_, ProfileState>, json: String) -> Result<(), String> {
    state.0.set(checked(&json)?)
}

#[tauri::command]
pub fn profile_delete(state: State<'_, ProfileState>) -> Result<(), String> {
    state.0.delete()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_profile_is_a_small_json_object() {
        assert!(checked(r#"{"nameAr":"محمد"}"#).is_ok());
        assert!(checked("[1]").unwrap_err().starts_with("E_ARGS"));
        assert!(checked("not json").unwrap_err().starts_with("E_ARGS"));
        let big = format!(r#"{{"a":"{}"}}"#, "x".repeat(MAX_BYTES));
        assert!(checked(&big).unwrap_err().contains("at most"));
    }
}
