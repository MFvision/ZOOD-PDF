//! Warraq's own implementation of the PDF standard security handler
//! (ISO 32000-2 §7.6), so that an encrypted document can be opened, read and
//! edited like any other.
//!
//! Supported: revisions 2, 3, 4, 5 and 6 of the `/Standard` handler, with RC4
//! (`/V 1`, `/V 2`, `/CFM /V2`), AES-128-CBC (`/CFM /AESV2`) and AES-256-CBC
//! (`/CFM /AESV3`); user and owner passwords; `/StmF`, `/StrF`, per-stream
//! `/Crypt` filters and `/Identity`; and `/EncryptMetadata false`.
//!
//! # Why this does not just call `lopdf`
//!
//! `lopdf` 0.45 authenticates while it parses: [`lopdf::Document::load_mem`]
//! takes an "encrypted" path that extracts the raw bytes of every object and
//! then, if it cannot authenticate right there, returns having kept only the
//! `/Encrypt` dictionary — measured on every encrypted file of the corpus, the
//! document that comes back holds exactly one object. Its `decrypt()` then has
//! nothing left to decrypt. Its cryptography is fine; the loss is structural.
//!
//! So [`load_preserving_ciphertext`] hides the `/Encrypt` entry from the
//! trailer (and the `/ObjStm` type from object-stream containers, which
//! `lopdf` would otherwise try to inflate while still encrypted and drop on
//! failure) by renaming a single byte of each — never moving one, so every
//! cross-reference offset in the file still points where it did. The names are
//! put back in the parsed document, which now holds the file's ciphertext, and
//! [`decrypt_document`] takes it from there.

use lopdf::{Dictionary, Document, Object, ObjectId, ObjectStream};

mod cipher;
mod handler;

use handler::{Handler, Method};

/// What can go wrong while decrypting a document.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CryptError {
    /// The trailer has no `/Encrypt` entry, so there is nothing to decrypt.
    #[error("the document is not encrypted")]
    NotEncrypted,
    /// The password is neither the user nor the owner password.
    #[error("wrong password")]
    WrongPassword,
    /// A security handler, revision or crypt filter we do not implement.
    #[error("unsupported encryption: {0}")]
    Unsupported(String),
}

/// Whether `doc` still carries an `/Encrypt` entry in its trailer, i.e. its
/// strings and streams are ciphertext.
pub fn is_encrypted(doc: &Document) -> bool {
    doc.trailer.get(b"Encrypt").is_ok()
}

/// Parse `bytes` with `lopdf` while keeping encrypted strings and streams
/// intact, so that [`decrypt_document`] can decrypt them.
///
/// A document with no `/Encrypt` anywhere is loaded straight through, so this
/// is a drop-in replacement for [`lopdf::Document::load_mem`]. See the module
/// documentation for what the two renamed bytes are and why they are safe.
pub fn load_preserving_ciphertext(bytes: &[u8]) -> lopdf::Result<Document> {
    if find(bytes, b"/Encrypt", 0).is_none() {
        return Document::load_mem(bytes);
    }
    // The word can also turn up inside a compressed stream of a file that is
    // not encrypted at all; unless a trailer entry was really renamed, load the
    // original bytes so that `lopdf` expands the object streams as it always
    // would.
    let Some(hidden) = hide_encryption_markers(bytes) else {
        return Document::load_mem(bytes);
    };
    let mut doc = Document::load_mem(&hidden)?;
    if let Some(entry) = doc.trailer.remove(b"encrypt") {
        doc.trailer.set("Encrypt", entry);
    }
    for object in doc.objects.values_mut() {
        if let Ok(stream) = object.as_stream_mut() {
            if stream.dict.has_type(b"Objstm") {
                stream.dict.set("Type", Object::Name(b"ObjStm".to_vec()));
            }
        }
    }
    Ok(doc)
}

/// Decrypt every string and stream of `doc` in place with `password`, expand
/// any object streams that were still encrypted, and drop `/Encrypt` from the
/// trailer. Afterwards the document is plaintext and can be saved as such.
///
/// `password` is tried as the user password first and then as the owner
/// password; an empty string covers the common "encrypted, but opens without a
/// password" case.
///
/// # Errors
///
/// [`CryptError::NotEncrypted`] if the trailer has no `/Encrypt`,
/// [`CryptError::WrongPassword`] if the password is neither of the two, and
/// [`CryptError::Unsupported`] for a handler this module does not implement —
/// the document is then left untouched.
pub fn decrypt_document(doc: &mut Document, password: &str) -> Result<(), CryptError> {
    let handler = Handler::from_document(doc)?;
    let file_key = handler.authenticate(password)?;
    let encrypt_id = doc
        .trailer
        .get(b"Encrypt")
        .ok()
        .and_then(|entry| entry.as_reference().ok());

    let ids: Vec<ObjectId> = doc.objects.keys().copied().collect();
    for id in ids {
        // The /Encrypt dictionary is the one object that is never encrypted.
        if Some(id) == encrypt_id {
            continue;
        }
        if let Some(object) = doc.objects.get_mut(&id) {
            decrypt_value(&handler, &file_key, id, object)?;
        }
    }

    expand_object_streams(doc);

    doc.trailer.remove(b"Encrypt");
    if let Some(id) = encrypt_id {
        doc.objects.remove(&id);
    }
    Ok(())
}

/// Decrypt one object, recursing into arrays and dictionaries: encryption
/// applies to every string and stream, wherever it is nested.
fn decrypt_value(
    handler: &Handler,
    file_key: &[u8],
    id: ObjectId,
    object: &mut Object,
) -> Result<(), CryptError> {
    match object {
        Object::Array(items) => {
            for item in items {
                decrypt_value(handler, file_key, id, item)?;
            }
        }
        Object::Dictionary(dict) => decrypt_dictionary(handler, file_key, id, dict)?,
        Object::String(content, _) => {
            *content = handler.decrypt(file_key, id, handler.string_method(), content)?;
        }
        Object::Stream(stream) => {
            // The cross-reference stream is never encrypted, and neither are
            // the strings in its dictionary (ISO 32000-2 §7.5.8.2).
            if stream.dict.has_type(b"XRef") {
                return Ok(());
            }
            let method = stream_method(handler, &stream.dict);
            decrypt_dictionary(handler, file_key, id, &mut stream.dict)?;
            if method != Method::Identity {
                let content = handler.decrypt(file_key, id, method, &stream.content)?;
                stream.set_content(content);
            }
        }
        _ => {}
    }
    Ok(())
}

fn decrypt_dictionary(
    handler: &Handler,
    file_key: &[u8],
    id: ObjectId,
    dict: &mut Dictionary,
) -> Result<(), CryptError> {
    for (_, value) in dict.iter_mut() {
        decrypt_value(handler, file_key, id, value)?;
    }
    Ok(())
}

/// Which crypt filter a stream is encrypted with: `/StmF` by default, but a
/// `/Crypt` entry in the stream's own `/Filter` names another one, and the
/// metadata stream is in the clear when `/EncryptMetadata` is false.
fn stream_method(handler: &Handler, dict: &Dictionary) -> Method {
    if dict.has_type(b"Metadata") && !handler.encrypt_metadata() {
        return Method::Identity;
    }
    let names: Vec<&[u8]> = match dict.get(b"Filter") {
        Ok(Object::Name(name)) => vec![name.as_slice()],
        Ok(Object::Array(items)) => items.iter().filter_map(|o| o.as_name().ok()).collect(),
        _ => Vec::new(),
    };
    if !names.contains(&&b"Crypt"[..]) {
        return handler.stream_method();
    }
    // The /Crypt filter's decode parameters name the filter to use; a missing
    // or unknown name means /Identity (ISO 32000-2 §7.4.10).
    let name = match dict.get(b"DecodeParms") {
        Ok(Object::Dictionary(parms)) => parms.get(b"Name").and_then(Object::as_name).ok(),
        Ok(Object::Array(items)) => items
            .iter()
            .filter_map(|o| o.as_dict().ok())
            .find_map(|parms| parms.get(b"Name").and_then(Object::as_name).ok()),
        _ => None,
    };
    handler.named_filter(name.unwrap_or(b"Identity"))
}

/// Object streams could not be inflated while their container was encrypted;
/// now that it is plaintext, add the objects they hold. Their strings were
/// covered by the container and are never decrypted again.
fn expand_object_streams(doc: &mut Document) {
    let mut members: Vec<(ObjectId, Object)> = Vec::new();
    for object in doc.objects.values() {
        if let Ok(stream) = object.as_stream() {
            if stream.dict.has_type(b"ObjStm") {
                match ObjectStream::new(stream) {
                    Ok(object_stream) => members.extend(object_stream.objects),
                    Err(e) => log::warn!("object stream could not be expanded: {e}"),
                }
            }
        }
    }
    let mut max_id = doc.max_id;
    for (id, object) in members {
        max_id = max_id.max(id.0);
        // Only add: an object written out of line wins over a stale copy.
        doc.objects.entry(id).or_insert(object);
    }
    doc.max_id = max_id;
}

/// Rename `/Encrypt` (in a trailer) to `/encrypt` and `/ObjStm` to `/Objstm`,
/// one byte each, so `lopdf` parses the file as plaintext.
///
/// `/Encrypt` is only renamed where an indirect reference follows it, which is
/// what a trailer entry looks like; that makes a chance hit inside encrypted
/// stream data — which would have to spell out `/Encrypt 12 0 R` — impossible
/// in practice. `None` means no such entry was there, so the file is not
/// encrypted and must be loaded as it stands.
fn hide_encryption_markers(bytes: &[u8]) -> Option<Vec<u8>> {
    let mut out = bytes.to_vec();
    let mut hid_encrypt = false;
    let mut at = 0;
    while let Some(p) = find(&out, b"/Encrypt", at) {
        if reference_follows(&out[p + b"/Encrypt".len()..]) {
            out[p + 1] = b'e';
            hid_encrypt = true;
        }
        at = p + b"/Encrypt".len();
    }
    if !hid_encrypt {
        return None;
    }
    // Only worth hiding the object-stream containers from `lopdf` once we know
    // it would refuse to inflate them.
    let mut at = 0;
    while let Some(p) = find(&out, b"/ObjStm", at) {
        out[p + 4] = b's';
        at = p + b"/ObjStm".len();
    }
    Some(out)
}

/// Whether `bytes` starts with `<int> <int> R`, possibly after whitespace.
fn reference_follows(bytes: &[u8]) -> bool {
    let white = |b: u8| matches!(b, b' ' | b'\t' | b'\r' | b'\n' | b'\x0C' | b'\0');
    let mut i = 0;
    for _ in 0..2 {
        while i < bytes.len() && white(bytes[i]) {
            i += 1;
        }
        let start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i == start {
            return false;
        }
    }
    while i < bytes.len() && white(bytes[i]) {
        i += 1;
    }
    bytes.get(i) == Some(&b'R')
}

/// First occurrence of `needle` in `haystack` at or after `from`.
fn find(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    let last = haystack.len() - needle.len();
    let mut i = from;
    while i <= last {
        let offset = haystack[i..=last].iter().position(|b| *b == needle[0])?;
        let at = i + offset;
        if &haystack[at..at + needle.len()] == needle {
            return Some(at);
        }
        i = at + 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest as _, Sha256};

    const USER: &str = "warraq";
    const OWNER: &str = "warraq-owner";

    /// The corpus files, the password that opens each, the file encryption key
    /// that pikepdf (qpdf 12.2) reports for it, and the page count.
    ///
    /// The keys are ground truth from an independent implementation:
    /// `pikepdf.open(path, password=pw).encryption.encryption_key.hex()`.
    const VECTORS: &[(&str, &str, &str, usize)] = &[
        ("variant-encrypted-rc4-40.pdf", USER, "d56a77273b", 1),
        (
            "variant-encrypted-rc4-128.pdf",
            USER,
            "30d828b5a8f35c7eca5d8338b5e081a2",
            1,
        ),
        (
            "variant-encrypted-aes128.pdf",
            USER,
            "75d590a97a8ed8521790b9e2de2af88f",
            1,
        ),
        (
            "variant-encrypted-aes256-owner-only.pdf",
            "",
            "b717b421f3245e63745dc51393f76cbb77e025ff3dff331010967cf5ac1fb26f",
            1,
        ),
        (
            "variant-encrypted-aes256.pdf",
            USER,
            "7a2860ec4fbd653d7ca4b847ba1b3b8971f797ba284986e0ec1efff4f4bf5f14",
            3,
        ),
    ];

    fn corpus(name: &str) -> Vec<u8> {
        std::fs::read(format!(
            "{}/../../../tests/corpus/arabic/generated/{name}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap()
    }

    fn loaded(name: &str) -> Document {
        load_preserving_ciphertext(&corpus(name)).unwrap()
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// The first page's content stream, exactly as it is stored (decrypted but
    /// still Flate-compressed), plus the `/Producer` string of `/Info`.
    fn page_content_and_producer(doc: &Document) -> (Vec<u8>, Vec<u8>) {
        let page = *doc.get_pages().values().next().unwrap();
        let contents = doc
            .get_dictionary(page)
            .unwrap()
            .get(b"Contents")
            .and_then(Object::as_reference)
            .unwrap();
        let content = doc
            .get_object(contents)
            .unwrap()
            .as_stream()
            .unwrap()
            .content
            .clone();
        let producer = doc
            .trailer
            .get(b"Info")
            .and_then(Object::as_reference)
            .and_then(|id| doc.get_dictionary(id))
            .unwrap()
            .get(b"Producer")
            .and_then(Object::as_str)
            .unwrap()
            .to_vec();
        (content, producer)
    }

    #[test]
    fn ciphertext_survives_loading_every_encrypted_variant() {
        for (name, _, _, _) in VECTORS {
            let doc = loaded(name);
            assert!(is_encrypted(&doc), "{name}: /Encrypt was lost");
            // lopdf on its own keeps a single object here; we want the file.
            assert!(
                doc.objects.len() > 30,
                "{name}: only {} objects",
                doc.objects.len()
            );
            let raw = Document::load_mem(&corpus(name)).unwrap();
            if raw.is_encrypted() {
                assert_eq!(raw.objects.len(), 1, "{name}: lopdf's own loss changed");
            }
        }
    }

    #[test]
    fn derived_file_keys_match_pikepdf() {
        for (name, password, expected_key, _) in VECTORS {
            let doc = loaded(name);
            let handler = Handler::from_document(&doc).unwrap();
            assert_eq!(
                hex(&handler.authenticate(password).unwrap()),
                *expected_key,
                "{name}: user password"
            );
            // The owner password must reach the same file key: for R2-R4 via
            // algorithm 7 (recover the user password from /O), for R6 via the
            // /OE branch of algorithm 2.A.
            assert_eq!(
                hex(&handler.authenticate(OWNER).unwrap()),
                *expected_key,
                "{name}: owner password"
            );
        }
    }

    #[test]
    fn wrong_passwords_are_rejected() {
        for (name, password, _, _) in VECTORS {
            let doc = loaded(name);
            let handler = Handler::from_document(&doc).unwrap();
            for wrong in ["definitely-wrong", "warraq ", "Warraq"] {
                assert_eq!(
                    handler.authenticate(wrong),
                    Err(CryptError::WrongPassword),
                    "{name}: {wrong:?} was accepted"
                );
            }
            // An empty password only opens the file that has none.
            if !password.is_empty() {
                assert_eq!(
                    handler.authenticate(""),
                    Err(CryptError::WrongPassword),
                    "{name}"
                );
            }
        }
    }

    /// Every invoice variant decrypts to the very bytes of the plaintext file
    /// it was made from — the strongest check available, because the expected
    /// value is produced by Chrome and pikepdf, not by this module.
    #[test]
    fn decrypted_bytes_equal_the_plaintext_source_file() {
        let plain = Document::load_mem(&corpus("chrome-cairo-mixed-invoice.pdf")).unwrap();
        let (expected_content, expected_producer) = page_content_and_producer(&plain);
        assert_eq!(expected_producer, b"Skia/PDF m152");

        for (name, password, _, pages) in VECTORS {
            let mut doc = loaded(name);
            decrypt_document(&mut doc, password).unwrap();
            assert!(!is_encrypted(&doc), "{name}: /Encrypt outlived decryption");
            assert_eq!(doc.get_pages().len(), *pages, "{name}: page count");

            let (content, producer) = page_content_and_producer(&doc);
            assert_eq!(producer, expected_producer, "{name}: /Producer");
            if *name == "variant-encrypted-aes256.pdf" {
                // A different source file (the 3-page Noto Naskh one), so only
                // its own hash from pikepdf applies.
                assert_eq!(
                    &hex(&Sha256::digest(&content))[..32],
                    "ea4739050a83d2023b2e278dc85b0ee5",
                    "{name}: content stream"
                );
            } else {
                assert_eq!(content, expected_content, "{name}: content stream");
            }
            // The content stream must still inflate, which it only does if the
            // padding was stripped to exactly the right length.
            let page = *doc.get_pages().values().next().unwrap();
            let decoded = doc.get_page_content(page);
            assert!(decoded.starts_with(b".23999999 0 0 -.23999999"), "{name}");
        }
    }

    #[test]
    fn object_stream_members_are_recovered_after_the_container_is_decrypted() {
        let name = "variant-encrypted-aes256-owner-only.pdf";
        let mut doc = loaded(name);
        let before = doc.objects.len();
        assert!(
            doc.objects.values().any(|o| o
                .as_stream()
                .map(|s| s.dict.has_type(b"ObjStm"))
                .unwrap_or(false)),
            "the fixture no longer has an object stream"
        );
        decrypt_document(&mut doc, "").unwrap();
        assert!(
            doc.objects.len() > before,
            "no objects came out of the object stream ({before} before, {} after)",
            doc.objects.len()
        );
        // The page tree of this file lives inside the object stream.
        assert_eq!(doc.get_pages().len(), 1);
        assert_eq!(
            doc.catalog()
                .unwrap()
                .get(b"Type")
                .and_then(Object::as_name)
                .unwrap(),
            b"Catalog"
        );
    }

    #[test]
    fn a_plain_file_is_loaded_unchanged_and_reports_no_encryption() {
        let doc = loaded("chrome-cairo-mixed-invoice.pdf");
        assert!(!is_encrypted(&doc));
        assert_eq!(doc.get_pages().len(), 1);
        let mut doc = doc;
        assert_eq!(
            decrypt_document(&mut doc, ""),
            Err(CryptError::NotEncrypted)
        );
    }

    #[test]
    fn encrypt_markers_are_renamed_without_moving_a_byte() {
        let original = corpus("variant-encrypted-aes256-owner-only.pdf");
        let hidden = hide_encryption_markers(&original).unwrap();
        assert_eq!(hidden.len(), original.len());
        let changed: Vec<usize> = (0..original.len())
            .filter(|i| original[*i] != hidden[*i])
            .collect();
        // One /Encrypt in the cross-reference stream dictionary, one /ObjStm.
        assert_eq!(changed.len(), 2, "changed at {changed:?}");
        assert!(find(&hidden, b"/Encrypt", 0).is_none());
        assert!(find(&hidden, b"/ObjStm", 0).is_none());
    }

    #[test]
    fn only_a_real_trailer_reference_is_renamed() {
        assert!(reference_follows(b" 102 0 R >>"));
        assert!(reference_follows(b"\n12\t0\r\nR"));
        assert!(!reference_follows(b" << /Foo 1 >>"));
        assert!(!reference_follows(b"102 R"));
        assert!(!reference_follows(b""));
        // Ciphertext that merely contains the word is left alone.
        let mut data = b"stream\n\xd3/Encrypt\xa1\x00junk\nendstream".to_vec();
        let stream_only = data.clone();
        data.extend_from_slice(b"trailer << /Encrypt 9 0 R >> /Type /ObjStm");
        let hidden = hide_encryption_markers(&data).unwrap();
        assert_eq!(find(&hidden, b"/Encrypt", 0), Some(8));
        assert!(find(&hidden, b"/encrypt", 0).unwrap() > 30);
        // With no trailer entry the file is not encrypted, so nothing at all is
        // renamed — an /ObjStm that `lopdf` can inflate must stay inflatable.
        assert_eq!(hide_encryption_markers(&stream_only), None);
        assert_eq!(hide_encryption_markers(b"<< /Type /ObjStm >>"), None);
    }

    #[test]
    fn find_locates_needles_and_respects_the_start_offset() {
        assert_eq!(find(b"abcabc", b"abc", 0), Some(0));
        assert_eq!(find(b"abcabc", b"abc", 1), Some(3));
        assert_eq!(find(b"abcabc", b"abc", 4), None);
        assert_eq!(find(b"ab", b"abc", 0), None);
        assert_eq!(find(b"aab", b"ab", 0), Some(1));
    }
}
