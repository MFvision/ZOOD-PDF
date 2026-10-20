//! How a phone and the PC lock their messages to each other.
//!
//! The QR code the PC shows carries a fresh random key in the part of its
//! address after `#`, which a browser never sends anywhere: only a phone that
//! saw the screen has it. Every message after that is sealed with
//! ChaCha20-Poly1305 — another device on the same Wi-Fi can neither read a
//! message nor make one the PC accepts.
//!
//! A connection starts with the PC's `challenge`, random each time. The
//! phone's `hello` is sealed with the key it holds (the QR code's, or the one
//! the PC gave it when it was first paired) and repeats the challenge, so an
//! old hello played back is refused. Both then seal with a key of this
//! connection alone, [`session_key`], and number their messages: one that
//! comes again, or out of order, is refused as well.
//!
//! The phone side of this is `packages/ui/src/remote/phone/seal.ts` (the
//! browser) and `apps/ios/PDFEditor/Remote/RemoteSeal.swift` (the iPhone app);
//! the three must agree byte for byte, which the vectors in the tests pin.

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use sha2::{Digest, Sha256};

/// A key: the QR code's, a remembered phone's or a connection's.
pub type SealKey = [u8; 32];

/// What the protocol is called inside the session key, so a key made for
/// this can never be mistaken for one made for anything else.
const SESSION_LABEL: &[u8] = b"zood-remote/1 session";

/// A nonce, a tag and at least `{}`: anything shorter is not a sealed message.
const MIN_SEALED: usize = 12 + 16 + 2;

/// 32 random bytes from the system.
pub fn random_key() -> SealKey {
    let mut key = [0u8; 32];
    getrandom::getrandom(&mut key).expect("the system's random source");
    key
}

/// 16 random bytes, as hex: a challenge or a phone's id.
pub fn random_id() -> String {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).expect("the system's random source");
    hex::encode(bytes)
}

/// The key one connection seals with, from the key the phone proved it holds
/// and that connection's challenge.
pub fn session_key(key: &SealKey, challenge: &str) -> SealKey {
    let mut hash = Sha256::new();
    hash.update(SESSION_LABEL);
    hash.update(key);
    hash.update(challenge.as_bytes());
    hash.finalize().into()
}

/// `plain` sealed: a random nonce, then the ciphertext and its tag.
pub fn seal(key: &SealKey, plain: &[u8]) -> Vec<u8> {
    let mut nonce = [0u8; 12];
    getrandom::getrandom(&mut nonce).expect("the system's random source");
    seal_with_nonce(key, &nonce, plain)
}

fn seal_with_nonce(key: &SealKey, nonce: &[u8; 12], plain: &[u8]) -> Vec<u8> {
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key));
    let sealed = cipher
        .encrypt(Nonce::from_slice(nonce), plain)
        .expect("ChaCha20-Poly1305 seals any length this app sends");
    let mut out = Vec::with_capacity(12 + sealed.len());
    out.extend_from_slice(nonce);
    out.extend_from_slice(&sealed);
    out
}

/// What `seal` sealed, or `None` for anything not sealed with `key` — a
/// wrong key, a changed byte, or not a sealed message at all.
pub fn open(key: &SealKey, sealed: &[u8]) -> Option<Vec<u8>> {
    if sealed.len() < MIN_SEALED {
        return None;
    }
    let (nonce, body) = sealed.split_at(12);
    ChaCha20Poly1305::new(Key::from_slice(key))
        .decrypt(Nonce::from_slice(nonce), body)
        .ok()
}

/// A key as the QR code's address carries it (base64url, no padding).
pub fn key_to_url(key: &SealKey) -> String {
    URL_SAFE_NO_PAD.encode(key)
}

/// A key as messages and the remembered-phones file carry it.
pub fn key_to_text(key: &SealKey) -> String {
    STANDARD.encode(key)
}

/// A key written by [`key_to_text`], if that is what `text` is.
pub fn key_from_text(text: &str) -> Option<SealKey> {
    STANDARD.decode(text).ok()?.try_into().ok()
}

/// Base64 for a sealed hello, which travels inside a text frame.
pub fn to_base64(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

pub fn from_base64(text: &str) -> Option<Vec<u8>> {
    STANDARD.decode(text).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: SealKey = [7u8; 32];

    #[test]
    fn opens_what_it_sealed() {
        let sealed = seal(&KEY, br#"{"t":"next"}"#);
        assert_eq!(
            open(&KEY, &sealed).as_deref(),
            Some(&br#"{"t":"next"}"#[..])
        );
    }

    #[test]
    fn refuses_another_key_a_changed_byte_and_scraps() {
        let sealed = seal(&KEY, br#"{"t":"next"}"#);
        assert!(open(&[8u8; 32], &sealed).is_none());
        for i in 0..sealed.len() {
            let mut changed = sealed.clone();
            changed[i] ^= 1;
            assert!(
                open(&KEY, &changed).is_none(),
                "byte {i} changed and still opened"
            );
        }
        assert!(open(&KEY, &[]).is_none());
        assert!(open(&KEY, &sealed[..20]).is_none());
    }

    #[test]
    fn never_repeats_a_nonce() {
        let a = seal(&KEY, b"{}");
        let b = seal(&KEY, b"{}");
        assert_ne!(a[..12], b[..12]);
    }

    /// The vector the phone's two implementations test against
    /// (`seal.test.ts`, `RemoteSealTests.swift`): change one, change all.
    #[test]
    fn matches_the_shared_vector() {
        let key: SealKey = core::array::from_fn(|i| i as u8);
        let nonce: [u8; 12] = core::array::from_fn(|i| (100 + i) as u8);
        let sealed = seal_with_nonce(&key, &nonce, br#"{"t":"next","s":1,"d":"p"}"#);
        assert_eq!(
            hex::encode(&sealed),
            "6465666768696a6b6c6d6e6f4f33cfe8a287183783aa3753d0fafaa941eab050bd6ac9dde442d2ed1eaaa54355a30c6438807266f4d3"
        );
        let session = session_key(&key, "00112233445566778899aabbccddeeff");
        assert_eq!(
            hex::encode(session),
            "11b2171425486fa3b7259d9096a3bee8f58f3ea3821fe2f52cc4fab0082e3d79"
        );
    }

    #[test]
    fn keys_go_through_text_and_back() {
        assert_eq!(key_from_text(&key_to_text(&KEY)), Some(KEY));
        assert_eq!(key_to_url(&[255u8; 32]).len(), 43);
        assert!(key_from_text("short").is_none());
    }
}
