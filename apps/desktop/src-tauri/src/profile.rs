//! The person's Wallet — their details for filling forms (name, ID number,
//! phone, addresses, bank accounts) and the Memory the AI may read — kept in
//! the system's credential store: the macOS keychain,
//! Windows Credential Manager (DPAPI), the Secret Service on Linux. The same
//! `keyring` crate and the same idea as a cloud drive's token (`cloud.rs`):
//! encrypted at rest by the system, under the app's own identifier, never
//! in a file of the app's own. The webview holds the details only while it
//! shows them; nothing here is sent anywhere.
use tauri::State;

const SERVICE: &str = "app.warraq.desktop.profile";
const ENTRY: &str = "profile";
/// The most a Wallet may be. Windows Credential Manager keeps a blob of 2560
/// bytes at most, so a larger one is kept in parts (`PART_CHARS` each, at
/// most two bytes a character there) under `profile.1`, `profile.2`…, with
/// `{"warraqParts":N}` under `profile` saying how many.
const MAX_BYTES: usize = 64_000;
const PART_CHARS: usize = 1000;
const MAX_PARTS: usize = 80;

fn keychain_err(e: keyring::Error) -> String {
    format!("E_KEYCHAIN: {e}")
}

fn entry(name: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, name).map_err(keychain_err)
}

fn part_name(index: usize) -> String {
    format!("{ENTRY}.{index}")
}

/// How many parts `profile` says the Wallet is in, when it is in parts.
fn parts_of(head: &str) -> Option<usize> {
    let value: serde_json::Value = serde_json::from_str(head).ok()?;
    let object = value.as_object()?;
    if object.len() != 1 {
        return None;
    }
    let parts = object.get("warraqParts")?.as_u64()? as usize;
    (1..=MAX_PARTS).contains(&parts).then_some(parts)
}

/// `json` cut into parts of `PART_CHARS` characters (never inside one).
pub fn split(json: &str) -> Vec<String> {
    let chars: Vec<char> = json.chars().collect();
    chars
        .chunks(PART_CHARS)
        .map(|part| part.iter().collect())
        .collect()
}

/// The store, so the commands can be tested against memory.
pub trait ProfileStore: Send + Sync {
    fn get(&self) -> Result<Option<String>, String>;
    fn set(&self, json: &str) -> Result<(), String>;
    fn delete(&self) -> Result<(), String>;
}

pub struct Keychain;

fn read(name: &str) -> Result<Option<String>, String> {
    match entry(name)?.get_password() {
        Ok(text) => Ok(Some(text)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(keychain_err(e)),
    }
}

fn remove(name: &str) -> Result<(), String> {
    match entry(name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(keychain_err(e)),
    }
}

impl Keychain {
    /// Takes out the parts an earlier, larger Wallet left.
    fn remove_parts(&self) -> Result<(), String> {
        if let Some(parts) = read(ENTRY)?.as_deref().and_then(parts_of) {
            for index in 1..=parts {
                remove(&part_name(index))?;
            }
        }
        Ok(())
    }
}

impl ProfileStore for Keychain {
    fn get(&self) -> Result<Option<String>, String> {
        let Some(head) = read(ENTRY)? else {
            return Ok(None);
        };
        let Some(parts) = parts_of(&head) else {
            return Ok(Some(head));
        };
        let mut json = String::new();
        for index in 1..=parts {
            // A part gone missing: the Wallet cannot be read whole, so none of it is.
            let Some(part) = read(&part_name(index))? else {
                return Ok(None);
            };
            json.push_str(&part);
        }
        Ok(Some(json))
    }

    fn set(&self, json: &str) -> Result<(), String> {
        self.remove_parts()?;
        let parts = split(json);
        if parts.len() <= 1 {
            return entry(ENTRY)?.set_password(json).map_err(keychain_err);
        }
        for (index, part) in parts.iter().enumerate() {
            entry(&part_name(index + 1))?
                .set_password(part)
                .map_err(keychain_err)?;
        }
        let head = serde_json::json!({ "warraqParts": parts.len() }).to_string();
        entry(ENTRY)?.set_password(&head).map_err(keychain_err)
    }

    fn delete(&self) -> Result<(), String> {
        self.remove_parts()?;
        remove(ENTRY)
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
    if json.len() > MAX_BYTES || split(json).len() > MAX_PARTS {
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
        // A Wallet of many details is not refused: it is kept in parts.
        let wallet = format!(r#"{{"v":2,"a":"{}"}}"#, "محمد ".repeat(3000));
        assert!(checked(&wallet).is_ok());
    }

    #[test]
    fn a_large_wallet_is_cut_into_parts_that_join_back() {
        let json = format!(r#"{{"v":2,"name":"{}"}}"#, "عبدالله ".repeat(400));
        let parts = split(&json);
        assert!(parts.len() > 1);
        assert!(parts.iter().all(|part| part.chars().count() <= PART_CHARS));
        // At most two bytes a character in UTF-16: under Credential Manager's 2560.
        assert!(parts
            .iter()
            .all(|part| part.encode_utf16().count() * 2 <= 2560));
        assert_eq!(parts.concat(), json);
    }

    #[test]
    fn only_a_parts_note_is_read_as_one() {
        assert_eq!(parts_of(r#"{"warraqParts":3}"#), Some(3));
        assert_eq!(parts_of(r#"{"warraqParts":0}"#), None);
        assert_eq!(parts_of(r#"{"warraqParts":100000}"#), None);
        assert_eq!(parts_of(r#"{"warraqParts":2,"v":2}"#), None);
        assert_eq!(parts_of(r#"{"nameAr":"محمد"}"#), None);
    }
}
