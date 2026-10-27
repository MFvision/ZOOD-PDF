//! Pairing two computers (`twin.rs`): no QR code to scan, so the two agree
//! on a key with an X25519 exchange, and both screens show six digits made
//! from it. The person on the computer being paired presses Allow only when
//! the digits match; a device in the middle of the Wi-Fi would make the two
//! screens show different digits.
//!
//! The key that comes out stands in for a QR code's key: the hello that
//! follows is sealed with it, and the computer is welcomed and remembered
//! like a phone (`server.rs`). X25519 is ring's (already in the app through
//! rustls; Apache-2.0 AND ISC).

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use ring::agreement::{agree_ephemeral, EphemeralPrivateKey, UnparsedPublicKey, X25519};
use ring::rand::SystemRandom;
use sha2::{Digest, Sha256};

use super::seal::SealKey;

const KEY_LABEL: &[u8] = b"zood-remote/1 pc-pair key";
const DIGITS_LABEL: &[u8] = b"zood-remote/1 pc-pair digits";

/// What both computers have once they agree.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Agreed {
    pub key: SealKey,
    /// Six digits, as both screens show them.
    pub digits: String,
}

/// One side's half of the exchange.
pub struct Half {
    private: EphemeralPrivateKey,
    pub public: [u8; 32],
}

/// A fresh half, never used twice.
pub fn half() -> Option<Half> {
    let private = EphemeralPrivateKey::generate(&X25519, &SystemRandom::new()).ok()?;
    let public: [u8; 32] = private
        .compute_public_key()
        .ok()?
        .as_ref()
        .try_into()
        .ok()?;
    Some(Half { private, public })
}

/// Both sides' agreement, from this side's half and the other's public key.
/// `asker` is the public key of the computer that asked to pair, `answerer`
/// the other's, so both sides make the same key and digits.
pub fn agree(ours: Half, theirs: &[u8], asker: &[u8; 32], answerer: &[u8; 32]) -> Option<Agreed> {
    if theirs.len() != 32 {
        return None;
    }
    let peer = UnparsedPublicKey::new(&X25519, theirs);
    agree_ephemeral(ours.private, &peer, |shared| {
        derive(shared, asker, answerer)
    })
    .ok()
}

fn derive(shared: &[u8], asker: &[u8; 32], answerer: &[u8; 32]) -> Agreed {
    let hash = |label: &[u8]| -> [u8; 32] {
        let mut hash = Sha256::new();
        hash.update(label);
        hash.update(shared);
        hash.update(asker);
        hash.update(answerer);
        hash.finalize().into()
    };
    let digits = hash(DIGITS_LABEL);
    let number = u32::from_be_bytes([digits[0], digits[1], digits[2], digits[3]]) % 1_000_000;
    Agreed {
        key: hash(KEY_LABEL),
        digits: format!("{number:06}"),
    }
}

/// The asker's public key from its first message (`{t:'pcPair', pub}`).
pub fn asked(first: &str) -> Option<[u8; 32]> {
    let value: serde_json::Value = serde_json::from_str(first).ok()?;
    if value.get("t")?.as_str()? != "pcPair" {
        return None;
    }
    STANDARD
        .decode(value.get("pub")?.as_str()?)
        .ok()?
        .try_into()
        .ok()
}

pub fn to_text(public: &[u8; 32]) -> String {
    STANDARD.encode(public)
}

pub fn from_text(text: &str) -> Option<[u8; 32]> {
    STANDARD.decode(text).ok()?.try_into().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_computers_make_the_same_key_and_digits() {
        let asker = half().unwrap();
        let answerer = half().unwrap();
        let (a_pub, b_pub) = (asker.public, answerer.public);
        let one = agree(asker, &b_pub, &a_pub, &b_pub).unwrap();
        let two = agree(answerer, &a_pub, &a_pub, &b_pub).unwrap();
        assert_eq!(one, two);
        assert_eq!(one.digits.len(), 6);
        assert!(one.digits.chars().all(|c| c.is_ascii_digit()));
    }

    #[test]
    fn someone_in_the_middle_gets_other_digits() {
        let asker = half().unwrap();
        let answerer = half().unwrap();
        let middle_to_asker = half().unwrap();
        let middle_to_answerer = half().unwrap();
        let (a, b) = (asker.public, answerer.public);
        let (m1, m2) = (middle_to_asker.public, middle_to_answerer.public);
        // The asker talks to the middle thinking it is the answerer, and so on.
        let seen_by_asker = agree(asker, &m1, &a, &m1).unwrap();
        let seen_by_answerer = agree(answerer, &m2, &m2, &b).unwrap();
        assert_ne!(seen_by_asker.key, seen_by_answerer.key);
        // Six digits can match by chance, one time in a million; the keys never.
        let _ = (middle_to_asker, middle_to_answerer);
    }

    #[test]
    fn digits_are_pinned() {
        let agreed = derive(&[7u8; 32], &[1u8; 32], &[2u8; 32]);
        let mut hash = Sha256::new();
        hash.update(DIGITS_LABEL);
        hash.update([7u8; 32]);
        hash.update([1u8; 32]);
        hash.update([2u8; 32]);
        let full: [u8; 32] = hash.finalize().into();
        let number = u32::from_be_bytes([full[0], full[1], full[2], full[3]]) % 1_000_000;
        assert_eq!(agreed.digits, format!("{number:06}"));
    }

    #[test]
    fn only_a_pairing_message_is_read() {
        let key = to_text(&[9u8; 32]);
        assert_eq!(
            asked(&format!(r#"{{"t":"pcPair","pub":"{key}"}}"#)),
            Some([9u8; 32])
        );
        assert_eq!(asked(r#"{"t":"hello","pub":"AAAA"}"#), None);
        assert_eq!(asked(r#"{"t":"pcPair","pub":"short"}"#), None);
        assert_eq!(asked("not json"), None);
        assert!(agree(half().unwrap(), &[1, 2, 3], &[0; 32], &[0; 32]).is_none());
    }
}
