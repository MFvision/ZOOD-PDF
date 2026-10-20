//! The phones this PC remembers: paired once with a QR code, they come back
//! without one. Each has its own key, given to it at pairing; forgetting a
//! phone throws its key away, so it must scan a new code.
//!
//! Kept in `remote-phones.json` in the app's own data folder. Whoever can
//! read that file can already work this PC with its own mouse.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::seal::{key_from_text, key_to_text, SealKey};

/// The most phones remembered; pairing one more forgets the longest unused.
const MAX_PHONES: usize = 8;

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
pub struct Phone {
    pub id: String,
    pub name: String,
    key: String,
    /// Seconds since 1970 it last connected: who goes when the list is full.
    #[serde(default)]
    pub seen: u64,
}

impl Phone {
    pub fn key(&self) -> Option<SealKey> {
        key_from_text(&self.key)
    }
}

#[derive(Default)]
pub struct Phones {
    file: Option<PathBuf>,
    list: Vec<Phone>,
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// A name a phone gave itself, kept to something a list can show.
pub fn tidy_name(name: &str) -> String {
    let name: String = name.chars().filter(|c| !c.is_control()).take(40).collect();
    let name = name.trim();
    if name.is_empty() {
        "Phone".into()
    } else {
        name.into()
    }
}

impl Phones {
    /// The phones in `file`, or none when it is missing or unreadable.
    pub fn load(file: &Path) -> Self {
        let list = std::fs::read(file)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Vec<Phone>>(&bytes).ok())
            .unwrap_or_default()
            .into_iter()
            .filter(|p| p.key().is_some())
            .take(MAX_PHONES)
            .collect();
        Self {
            file: Some(file.to_path_buf()),
            list,
        }
    }

    fn save(&self) {
        let Some(file) = &self.file else { return };
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_vec_pretty(&self.list) {
            let _ = std::fs::write(file, json);
        }
    }

    pub fn list(&self) -> &[Phone] {
        &self.list
    }

    pub fn find(&self, id: &str) -> Option<&Phone> {
        self.list.iter().find(|p| p.id == id)
    }

    /// Remembers a newly paired phone under `id` with `key`.
    pub fn add(&mut self, id: String, name: &str, key: &SealKey) {
        if self.list.len() >= MAX_PHONES {
            if let Some(oldest) = self
                .list
                .iter()
                .enumerate()
                .min_by_key(|(_, p)| p.seen)
                .map(|(i, _)| i)
            {
                self.list.remove(oldest);
            }
        }
        self.list.push(Phone {
            id,
            name: tidy_name(name),
            key: key_to_text(key),
            seen: now(),
        });
        self.save();
    }

    /// A remembered phone connected again, perhaps under a new name.
    pub fn touch(&mut self, id: &str, name: &str) {
        if let Some(phone) = self.list.iter_mut().find(|p| p.id == id) {
            phone.seen = now();
            phone.name = tidy_name(name);
            self.save();
        }
    }

    pub fn forget(&mut self, id: &str) -> bool {
        let before = self.list.len();
        self.list.retain(|p| p.id != id);
        let gone = self.list.len() != before;
        if gone {
            self.save();
        }
        gone
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remembers_forgets_and_survives_a_restart() {
        let dir =
            std::env::temp_dir().join(format!("zood-remote-{}", super::super::seal::random_id()));
        let file = dir.join("remote-phones.json");
        let mut phones = Phones::load(&file);
        assert!(phones.list().is_empty());
        phones.add("a".into(), "Mohammed's iPhone", &[1u8; 32]);
        phones.add("b".into(), "  \u{7}\n ", &[2u8; 32]);
        let again = Phones::load(&file);
        assert_eq!(again.list().len(), 2);
        assert_eq!(again.find("a").and_then(Phone::key), Some([1u8; 32]));
        assert_eq!(again.find("b").map(|p| p.name.as_str()), Some("Phone"));
        assert!(phones.forget("a"));
        assert!(!phones.forget("a"));
        assert_eq!(Phones::load(&file).list().len(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn keeps_at_most_eight() {
        let mut phones = Phones::default();
        for i in 0..12 {
            phones.add(format!("{i}"), "p", &[i as u8; 32]);
        }
        assert_eq!(phones.list().len(), MAX_PHONES);
    }

    #[test]
    fn a_damaged_file_is_no_phones() {
        let dir =
            std::env::temp_dir().join(format!("zood-remote-{}", super::super::seal::random_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("remote-phones.json");
        std::fs::write(&file, b"{not json").unwrap();
        assert!(Phones::load(&file).list().is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }
}
