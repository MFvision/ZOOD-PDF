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
/// bytes at most, counted in UTF-16 (two bytes a unit, and an emoji is two
/// units), so a larger one is kept in parts of at most `PART_UNITS` units
/// under `profile.1`, `profile.2`… (or `profile.b.1`… for the other set,
/// below), with `{"warraqParts":N}` under `profile` saying how many.
const MAX_BYTES: usize = 64_000;
const PART_UNITS: usize = 1200;
const MAX_PARTS: usize = 80;

fn keychain_err(e: keyring::Error) -> String {
    format!("E_KEYCHAIN: {e}")
}

fn entry(name: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, name).map_err(keychain_err)
}

/// Which names a Wallet in parts is under. A new Wallet is written under
/// the set the old one is not, and `profile` is changed to point at it only
/// once every part is in: a write that fails halfway (the credential store
/// refuses a part, the app is closed) leaves the old Wallet whole.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Set {
    /// `profile.1`, `profile.2`… — the names earlier versions used.
    A,
    /// `profile.b.1`, `profile.b.2`…
    B,
}

impl Set {
    fn other(self) -> Set {
        match self {
            Set::A => Set::B,
            Set::B => Set::A,
        }
    }

    fn part_name(self, index: usize) -> String {
        match self {
            Set::A => format!("{ENTRY}.{index}"),
            Set::B => format!("{ENTRY}.b.{index}"),
        }
    }

    fn head(self, parts: usize) -> String {
        match self {
            Set::A => serde_json::json!({ "warraqParts": parts }).to_string(),
            Set::B => serde_json::json!({ "warraqParts": parts, "warraqSet": "b" }).to_string(),
        }
    }
}

/// How many parts `profile` says the Wallet is in, and under which names,
/// when it is in parts.
fn parts_of(head: &str) -> Option<(usize, Set)> {
    let value: serde_json::Value = serde_json::from_str(head).ok()?;
    let object = value.as_object()?;
    let set = match object.get("warraqSet") {
        None => Set::A,
        Some(set) if set.as_str() == Some("b") => Set::B,
        Some(_) => return None,
    };
    let known = 1 + usize::from(set == Set::B);
    if object.len() != known {
        return None;
    }
    let parts = object.get("warraqParts")?.as_u64()? as usize;
    (1..=MAX_PARTS).contains(&parts).then_some((parts, set))
}

/// `json` cut into parts of at most `PART_UNITS` UTF-16 units each, never
/// inside a character.
pub fn split(json: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut part = String::new();
    let mut units = 0;
    for c in json.chars() {
        if units + c.len_utf16() > PART_UNITS {
            parts.push(std::mem::take(&mut part));
            units = 0;
        }
        part.push(c);
        units += c.len_utf16();
    }
    if !part.is_empty() || parts.is_empty() {
        parts.push(part);
    }
    parts
}

/// The store, so the commands can be tested against memory.
pub trait ProfileStore: Send + Sync {
    fn get(&self) -> Result<Option<String>, String>;
    fn set(&self, json: &str) -> Result<(), String>;
    fn delete(&self) -> Result<(), String>;
}

/// Named secrets, one string each: the system's credential store, or a map
/// in the tests.
pub trait Slots: Send + Sync {
    fn read(&self, name: &str) -> Result<Option<String>, String>;
    fn write(&self, name: &str, text: &str) -> Result<(), String>;
    fn remove(&self, name: &str) -> Result<(), String>;
}

pub struct Keychain;

impl Slots for Keychain {
    fn read(&self, name: &str) -> Result<Option<String>, String> {
        match entry(name)?.get_password() {
            Ok(text) => Ok(Some(text)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(keychain_err(e)),
        }
    }

    fn write(&self, name: &str, text: &str) -> Result<(), String> {
        entry(name)?.set_password(text).map_err(keychain_err)
    }

    fn remove(&self, name: &str) -> Result<(), String> {
        match entry(name)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(keychain_err(e)),
        }
    }
}

/// Takes out `parts` parts of `set`, as far as it can: a part left behind
/// is never read (`profile` no longer points at it) and is written over by
/// a later Wallet.
fn remove_parts(slots: &dyn Slots, set: Set, parts: usize) {
    for index in 1..=parts {
        let _ = slots.remove(&set.part_name(index));
    }
}

/// The Wallet in `slots`, whole, or none.
pub fn read_wallet(slots: &dyn Slots) -> Result<Option<String>, String> {
    let Some(head) = slots.read(ENTRY)? else {
        return Ok(None);
    };
    let Some((parts, set)) = parts_of(&head) else {
        return Ok(Some(head));
    };
    let mut json = String::new();
    for index in 1..=parts {
        // A part gone missing: the Wallet cannot be read whole, so none of it is.
        let Some(part) = slots.read(&set.part_name(index))? else {
            return Ok(None);
        };
        json.push_str(&part);
    }
    Ok(Some(json))
}

/// Writes a new Wallet into `slots`. Until it is all in, `profile` still
/// points at the old one; on any failure the old Wallet is what is kept.
pub fn write_wallet(slots: &dyn Slots, json: &str) -> Result<(), String> {
    let old = slots.read(ENTRY)?.as_deref().and_then(parts_of);
    let parts = split(json);
    if parts.len() <= 1 {
        slots.write(ENTRY, json)?;
    } else {
        let set = old.map_or(Set::A, |(_, set)| set.other());
        for (index, part) in parts.iter().enumerate() {
            if let Err(e) = slots.write(&set.part_name(index + 1), part) {
                remove_parts(slots, set, index);
                return Err(e);
            }
        }
        if let Err(e) = slots.write(ENTRY, &set.head(parts.len())) {
            remove_parts(slots, set, parts.len());
            return Err(e);
        }
    }
    // The new Wallet is in: the old one's parts go.
    if let Some((count, set)) = old {
        remove_parts(slots, set, count);
    }
    Ok(())
}

/// Deletes the Wallet and its parts.
pub fn delete_wallet(slots: &dyn Slots) -> Result<(), String> {
    if let Some((parts, set)) = slots.read(ENTRY)?.as_deref().and_then(parts_of) {
        for index in 1..=parts {
            slots.remove(&set.part_name(index))?;
        }
    }
    slots.remove(ENTRY)
}

impl ProfileStore for Keychain {
    fn get(&self) -> Result<Option<String>, String> {
        read_wallet(self)
    }

    fn set(&self, json: &str) -> Result<(), String> {
        write_wallet(self, json)
    }

    fn delete(&self) -> Result<(), String> {
        delete_wallet(self)
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

// Off the main thread on Windows, where it draws every window (`stall.rs`).
#[cfg_attr(windows, tauri::command(async))]
#[cfg_attr(not(windows), tauri::command)]
pub fn profile_get(state: State<'_, ProfileState>) -> Result<Option<String>, String> {
    state.0.get()
}

// Off the main thread on Windows, where it draws every window (`stall.rs`).
#[cfg_attr(windows, tauri::command(async))]
#[cfg_attr(not(windows), tauri::command)]
pub fn profile_set(state: State<'_, ProfileState>, json: String) -> Result<(), String> {
    state.0.set(checked(&json)?)
}

// Off the main thread on Windows, where it draws every window (`stall.rs`).
#[cfg_attr(windows, tauri::command(async))]
#[cfg_attr(not(windows), tauri::command)]
pub fn profile_delete(state: State<'_, ProfileState>) -> Result<(), String> {
    state.0.delete()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    /// Windows Credential Manager, in memory: it refuses a secret over 2560
    /// bytes of UTF-16, and, when told to, every write after the first few.
    #[derive(Default)]
    struct CredentialManager {
        kept: Mutex<HashMap<String, String>>,
        writes_left: Mutex<Option<usize>>,
        writes: AtomicUsize,
    }

    impl CredentialManager {
        fn fail_after(&self, writes: usize) {
            *self.writes_left.lock().unwrap() = Some(writes);
        }
    }

    impl Slots for CredentialManager {
        fn read(&self, name: &str) -> Result<Option<String>, String> {
            Ok(self.kept.lock().unwrap().get(name).cloned())
        }
        fn write(&self, name: &str, text: &str) -> Result<(), String> {
            if text.encode_utf16().count() * 2 > 2560 {
                return Err("E_KEYCHAIN: too long".into());
            }
            if let Some(left) = self.writes_left.lock().unwrap().as_mut() {
                if *left == 0 {
                    return Err("E_KEYCHAIN: refused".into());
                }
                *left -= 1;
            }
            self.writes.fetch_add(1, Ordering::Relaxed);
            self.kept
                .lock()
                .unwrap()
                .insert(name.to_string(), text.to_string());
            Ok(())
        }
        fn remove(&self, name: &str) -> Result<(), String> {
            self.kept.lock().unwrap().remove(name);
            Ok(())
        }
    }

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
        // Nor one of emoji at the largest size.
        let emoji = format!(r#"{{"a":"{}"}}"#, "😀".repeat((MAX_BYTES - 10) / 4));
        assert!(checked(&emoji).is_ok());
    }

    #[test]
    fn a_large_wallet_is_cut_into_parts_that_join_back() {
        let json = format!(r#"{{"v":2,"name":"{}"}}"#, "عبدالله ".repeat(400));
        let parts = split(&json);
        assert!(parts.len() > 1);
        // Under Credential Manager's 2560 bytes of UTF-16.
        assert!(parts
            .iter()
            .all(|part| part.encode_utf16().count() * 2 <= 2560));
        assert_eq!(parts.concat(), json);
    }

    #[test]
    fn a_wallet_of_emoji_fits_windows() {
        // An emoji is two UTF-16 units: a thousand of them were 4000 bytes,
        // which Credential Manager refused, and the Wallet was not saved.
        let json = format!(r#"{{"note":"{}"}}"#, "😀🇸🇦".repeat(2000));
        assert!(checked(&json).is_ok());
        let parts = split(&json);
        assert!(parts
            .iter()
            .all(|part| part.encode_utf16().count() * 2 <= 2560));
        assert_eq!(parts.concat(), json);
        let store = CredentialManager::default();
        write_wallet(&store, &json).unwrap();
        assert_eq!(read_wallet(&store).unwrap().as_deref(), Some(json.as_str()));
        // Small, but too many emoji for one secret: in parts too.
        let small = format!(r#"{{"n":"{}"}}"#, "😀".repeat(700));
        write_wallet(&store, &small).unwrap();
        assert_eq!(
            read_wallet(&store).unwrap().as_deref(),
            Some(small.as_str())
        );
    }

    #[test]
    fn a_save_that_fails_halfway_keeps_the_old_wallet() {
        let store = CredentialManager::default();
        let old = format!(r#"{{"name":"{}"}}"#, "محمد ".repeat(900));
        write_wallet(&store, &old).unwrap();
        // The new one is refused after two of its parts.
        let new = format!(r#"{{"name":"{}"}}"#, "عبدالله ".repeat(1200));
        store.fail_after(2);
        assert!(write_wallet(&store, &new).is_err());
        assert_eq!(read_wallet(&store).unwrap().as_deref(), Some(old.as_str()));
        // Refused at the very last step, the note that points at the parts.
        let parts = split(&new).len();
        store.fail_after(parts);
        assert!(write_wallet(&store, &new).is_err());
        assert_eq!(read_wallet(&store).unwrap().as_deref(), Some(old.as_str()));
        // Then saved, and saved again over itself, and a small one after.
        *store.writes_left.lock().unwrap() = None;
        write_wallet(&store, &new).unwrap();
        assert_eq!(read_wallet(&store).unwrap().as_deref(), Some(new.as_str()));
        write_wallet(&store, &new).unwrap();
        assert_eq!(read_wallet(&store).unwrap().as_deref(), Some(new.as_str()));
        write_wallet(&store, r#"{"a":1}"#).unwrap();
        assert_eq!(read_wallet(&store).unwrap().as_deref(), Some(r#"{"a":1}"#));
        // Nothing of the larger ones is left behind.
        assert_eq!(store.kept.lock().unwrap().len(), 1);
        delete_wallet(&store).unwrap();
        assert!(store.kept.lock().unwrap().is_empty());
        assert!(store.writes.load(Ordering::Relaxed) > 0);
    }

    #[test]
    fn a_wallet_an_earlier_version_kept_in_parts_still_reads() {
        let store = CredentialManager::default();
        store.write("profile.1", r#"{"a":"#).unwrap();
        store.write("profile.2", r#""b"}"#).unwrap();
        store.write("profile", r#"{"warraqParts":2}"#).unwrap();
        assert_eq!(
            read_wallet(&store).unwrap().as_deref(),
            Some(r#"{"a":"b"}"#)
        );
    }

    #[test]
    fn only_a_parts_note_is_read_as_one() {
        assert_eq!(parts_of(r#"{"warraqParts":3}"#), Some((3, Set::A)));
        assert_eq!(
            parts_of(r#"{"warraqParts":3,"warraqSet":"b"}"#),
            Some((3, Set::B))
        );
        assert_eq!(parts_of(r#"{"warraqParts":3,"warraqSet":"c"}"#), None);
        assert_eq!(parts_of(r#"{"warraqParts":0}"#), None);
        assert_eq!(parts_of(r#"{"warraqParts":100000}"#), None);
        assert_eq!(parts_of(r#"{"warraqParts":2,"v":2}"#), None);
        assert_eq!(parts_of(r#"{"nameAr":"محمد"}"#), None);
    }
}
