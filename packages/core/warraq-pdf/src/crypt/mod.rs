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

/// What a reader may do with the document without the owner password — the
/// `/P` bits of ISO 32000-2, table 22, as the three choices a person makes.
///
/// The bits the standard reserves are kept as it prescribes, so a file Warraq
/// writes says exactly what it means to every other reader.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Permissions {
    /// Print the document (bit 3), at full resolution (bit 12).
    pub print: bool,
    /// Copy text and pictures out (bit 5).
    pub copy: bool,
    /// Change it: the content (bit 4), comments (bit 6), form fields (bit 9)
    /// and the order of the pages (bit 11).
    pub change: bool,
}

/// Bits 1 and 2 are reserved and shall be 0; bits 7, 8 and 13 to 32 are
/// reserved and shall be 1. Everything a person can choose starts cleared.
const PERMISSIONS_BASE: i32 = 0xFFFF_F0C0u32 as i32;

impl Permissions {
    /// Everything allowed — what an unprotected document permits.
    pub const ALL: Self = Self {
        print: true,
        copy: true,
        change: true,
    };

    /// The `/P` value these permissions mean. Extraction for accessibility
    /// (bit 10) is always granted: ISO 32000-2 deprecated withholding it, and
    /// a document nobody with a screen reader can read is not one we write.
    pub fn bits(self) -> i32 {
        let mut p = PERMISSIONS_BASE | 512;
        if self.print {
            p |= 4 | 2048;
        }
        if self.copy {
            p |= 16;
        }
        if self.change {
            p |= 8 | 32 | 256 | 1024;
        }
        p
    }

    /// What a `/P` value in a file permits. A bit a file leaves out is a thing
    /// it does not allow, whoever wrote it.
    pub fn from_bits(p: i32) -> Self {
        Self {
            print: p & 4 != 0,
            copy: p & 16 != 0,
            change: p & 8 != 0,
        }
    }
}

/// How a file is protected, for the interface to report — never a key, never
/// a password.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Description {
    /// `"aes-256"`, `"aes-128"`, `"rc4-128"`, `"rc4-40"` or `"none"`.
    pub method: &'static str,
    /// The `/R` revision of the standard security handler.
    pub revision: i64,
    /// The file encryption key's length in bits.
    pub key_bits: usize,
    pub permissions: Permissions,
    pub encrypt_metadata: bool,
}

/// What protection to write over a document. The open password is what a
/// person is asked for; the owner password only lifts the permissions, and a
/// caller that does not want one should pass something unguessable rather than
/// the empty string, which would let anyone lift them.
#[derive(Debug, Clone)]
pub struct Protection {
    pub open_password: String,
    pub owner_password: String,
    pub permissions: Permissions,
    /// `false` leaves the XMP metadata stream readable without the password,
    /// which is what a library or a search index wants.
    pub encrypt_metadata: bool,
}

/// A password nobody knows: 24 random bytes in hex, for the owner password of
/// a file whose owner wants no second password. An empty owner password would
/// let any reader lift the permissions, which is worse than having none.
pub fn unguessable_password() -> Result<String, CryptError> {
    let mut bytes = [0u8; 24];
    getrandom::fill(&mut bytes)
        .map_err(|e| CryptError::Unsupported(format!("no source of randomness: {e}")))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Encrypt `doc` — which must be plaintext, as it is after
/// [`decrypt_document`] — with AES-256 under the standard security handler at
/// revision 6, and name the new `/Encrypt` dictionary in its trailer.
///
/// Afterwards the document's strings and streams are ciphertext, so it can
/// only be written whole: encryption covers every object in the file, and
/// nothing but a full write can change what the objects already there say.
/// The caller writes it with [`Document::save_to`].
///
/// # Errors
///
/// [`CryptError::Unsupported`] if `doc` is still encrypted (decrypt it first),
/// or if the machine has no source of randomness — without one there is no key
/// worth writing.
pub fn encrypt_document(doc: &mut Document, protection: &Protection) -> Result<(), CryptError> {
    if is_encrypted(doc) {
        return Err(CryptError::Unsupported(
            "the document is still encrypted; decrypt it before encrypting it again".into(),
        ));
    }
    let (handler, file_key, dict) = Handler::new_aes256(
        &protection.open_password,
        &protection.owner_password,
        protection.permissions.bits(),
        protection.encrypt_metadata,
    )?;

    // Every object in the file, one by one. The /Encrypt dictionary itself is
    // added afterwards, so it is never encrypted — nor is the cross-reference
    // stream or a signature's /Contents, which `crypt_value` leaves alone.
    let ids: Vec<ObjectId> = doc.objects.keys().copied().collect();
    for id in ids {
        if let Some(object) = doc.objects.get_mut(&id) {
            crypt_value(&handler, &file_key, id, object, Direction::Encrypt)?;
        }
    }

    // An /ID the file may not have had: readers expect one on an encrypted
    // file, and revisions before 5 key themselves from it.
    ensure_file_id(doc)?;

    doc.max_id += 1;
    let encrypt_id = (doc.max_id, 0);
    doc.objects.insert(encrypt_id, Object::Dictionary(dict));
    doc.trailer.set("Encrypt", Object::Reference(encrypt_id));
    Ok(())
}

/// How the file in `bytes` is protected, or `None` when it is not protected at
/// all or carries a handler this module does not implement. Reading this needs
/// no password: the `/Encrypt` dictionary is the one part of a protected file
/// that is in the clear.
pub fn describe(bytes: &[u8]) -> Option<Description> {
    let doc = load_preserving_ciphertext(bytes).ok()?;
    if !is_encrypted(&doc) {
        return None;
    }
    Handler::from_document(&doc).ok().map(|h| h.description())
}

/// Give the trailer a two-part `/ID` if it has none. The first part identifies
/// the file and the second this revision of it, both 16 random bytes, which is
/// what ISO 32000-2 §14.4 asks for.
fn ensure_file_id(doc: &mut Document) -> Result<(), CryptError> {
    if doc
        .trailer
        .get(b"ID")
        .and_then(Object::as_array)
        .is_ok_and(|a| a.len() == 2)
    {
        return Ok(());
    }
    let mut id = [0u8; 32];
    getrandom::fill(&mut id)
        .map_err(|e| CryptError::Unsupported(format!("no source of randomness: {e}")))?;
    doc.trailer.set(
        "ID",
        Object::Array(vec![
            Object::string_literal(id[..16].to_vec()),
            Object::string_literal(id[16..].to_vec()),
        ]),
    );
    Ok(())
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
/// trailer. Afterwards the document is plaintext and can be saved as such;
/// the returned [`Sealer`] writes updates that stay encrypted instead.
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
pub fn decrypt_document(doc: &mut Document, password: &str) -> Result<Sealer, CryptError> {
    let handler = Handler::from_document(doc)?;
    let file_key = handler.authenticate(password)?;
    let entry = doc
        .trailer
        .get(b"Encrypt")
        .cloned()
        .map_err(|_| CryptError::NotEncrypted)?;
    let encrypt_id = entry.as_reference().ok();

    let ids: Vec<ObjectId> = doc.objects.keys().copied().collect();
    for id in ids {
        // The /Encrypt dictionary is the one object that is never encrypted.
        if Some(id) == encrypt_id {
            continue;
        }
        if let Some(object) = doc.objects.get_mut(&id) {
            crypt_value(&handler, &file_key, id, object, Direction::Decrypt)?;
        }
    }

    expand_object_streams(doc);

    doc.trailer.remove(b"Encrypt");
    if let Some(id) = encrypt_id {
        doc.objects.remove(&id);
    }
    Ok(Sealer {
        handler,
        file_key,
        entry,
    })
}

/// What it takes to write an update that stays encrypted: the security
/// handler, the file key the password unlocked, and the trailer's `/Encrypt`
/// entry as it was. An update sealed with it is read with the same passwords
/// and has the same permissions as the file it extends, because it uses the
/// same key and names the same `/Encrypt` dictionary.
pub struct Sealer {
    handler: Handler,
    file_key: Vec<u8>,
    entry: Object,
}

impl Sealer {
    /// Whether `other` seals with the same key: the same protection, the
    /// same passwords, whoever wrote the file.
    pub(crate) fn same_key(&self, other: &Sealer) -> bool {
        self.file_key == other.file_key
    }
}

impl std::fmt::Debug for Sealer {
    // Never print the key.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Sealer { .. }")
    }
}

impl Sealer {
    /// `object`, with its strings and streams encrypted as object `id`'s.
    pub fn seal(&self, id: ObjectId, object: &Object) -> Result<Object, CryptError> {
        let mut sealed = object.clone();
        crypt_value(
            &self.handler,
            &self.file_key,
            id,
            &mut sealed,
            Direction::Encrypt,
        )?;
        Ok(sealed)
    }

    /// The `/Encrypt` entry an update's trailer must carry.
    pub fn trailer_entry(&self) -> &Object {
        &self.entry
    }
}

/// Which way [`crypt_value`] turns strings and streams.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Direction {
    Decrypt,
    Encrypt,
}

fn crypt_bytes(
    handler: &Handler,
    file_key: &[u8],
    id: ObjectId,
    method: Method,
    data: &[u8],
    direction: Direction,
) -> Result<Vec<u8>, CryptError> {
    match direction {
        Direction::Decrypt => handler.decrypt(file_key, id, method, data),
        Direction::Encrypt => handler.encrypt(file_key, id, method, data),
    }
}

/// Decrypt or encrypt one object, recursing into arrays and dictionaries:
/// encryption applies to every string and stream, wherever it is nested. One
/// traversal for both directions, so what is left in the clear on the way in
/// is left in the clear on the way out.
fn crypt_value(
    handler: &Handler,
    file_key: &[u8],
    id: ObjectId,
    object: &mut Object,
    direction: Direction,
) -> Result<(), CryptError> {
    match object {
        Object::Array(items) => {
            for item in items {
                crypt_value(handler, file_key, id, item, direction)?;
            }
        }
        Object::Dictionary(dict) => crypt_dictionary(handler, file_key, id, dict, direction)?,
        Object::String(content, _) => {
            *content = crypt_bytes(
                handler,
                file_key,
                id,
                handler.string_method(),
                content,
                direction,
            )?;
        }
        Object::Stream(stream) => {
            // The cross-reference stream is never encrypted, and neither are
            // the strings in its dictionary (ISO 32000-2 §7.5.8.2).
            if stream.dict.has_type(b"XRef") {
                return Ok(());
            }
            let method = stream_method(handler, &stream.dict);
            crypt_dictionary(handler, file_key, id, &mut stream.dict, direction)?;
            if method != Method::Identity {
                let content =
                    crypt_bytes(handler, file_key, id, method, &stream.content, direction)?;
                stream.set_content(content);
            }
        }
        _ => {}
    }
    Ok(())
}

fn crypt_dictionary(
    handler: &Handler,
    file_key: &[u8],
    id: ObjectId,
    dict: &mut Dictionary,
    direction: Direction,
) -> Result<(), CryptError> {
    // The signature blob in a signature dictionary is written after the file is
    // encrypted and is therefore in the clear (ISO 32000-2 §7.6.2).
    let signature = dict.has_type(b"Sig") || dict.has_type(b"DocTimeStamp");
    for (key, value) in dict.iter_mut() {
        if signature && key.as_slice() == b"Contents" {
            continue;
        }
        crypt_value(handler, file_key, id, value, direction)?;
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
    /// Regenerating the corpus draws new salts and therefore new keys;
    /// `tests/corpus/arabic/generators/gen_encrypted.py` prints the rows below
    /// ready to be pasted back in.
    const VECTORS: &[(&str, &str, &str, usize)] = &[
        ("variant-encrypted-rc4-40.pdf", USER, "0b57e0e286", 1),
        (
            "variant-encrypted-rc4-128.pdf",
            USER,
            "c9678b26d0b263d510318095e4bf8e01",
            1,
        ),
        (
            "variant-encrypted-aes128.pdf",
            USER,
            "321b513cf96b74eb266c57db7a044fd6",
            1,
        ),
        (
            "variant-encrypted-aes256-owner-only.pdf",
            "",
            "3a66efbaa736b49057374788629c7718cb8a440b673811d937de5800542fc095",
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
            decrypt_document(&mut doc, "").err(),
            Some(CryptError::NotEncrypted)
        );
    }

    /// Two strings that the spec keeps in the clear: the `/Contents` of a
    /// signature dictionary and everything in the cross-reference stream.
    #[test]
    fn strings_the_spec_exempts_are_left_alone() {
        let name = "variant-encrypted-aes256-owner-only.pdf";
        let mut doc = loaded(name);
        let blob = b"not ciphertext".to_vec();
        let mut sig = Dictionary::new();
        sig.set("Type", Object::Name(b"Sig".to_vec()));
        sig.set("Contents", Object::string_literal(blob.clone()));
        sig.set(
            "Name",
            Object::string_literal("encrypted".as_bytes().to_vec()),
        );
        let sig_id = doc.add_object(Object::Dictionary(sig));

        let xref_before = doc
            .objects
            .values()
            .find(|o| {
                o.as_stream()
                    .map(|s| s.dict.has_type(b"XRef"))
                    .unwrap_or(false)
            })
            .cloned();

        decrypt_document(&mut doc, "").unwrap();
        let sig = doc.get_dictionary(sig_id).unwrap();
        assert_eq!(sig.get(b"Contents").and_then(Object::as_str).unwrap(), blob);
        // Every other string of the same dictionary did go through the cipher.
        assert_ne!(
            sig.get(b"Name").and_then(Object::as_str).unwrap(),
            b"encrypted"
        );
        if let Some(before) = xref_before {
            let after = doc
                .objects
                .values()
                .find(|o| {
                    o.as_stream()
                        .map(|s| s.dict.has_type(b"XRef"))
                        .unwrap_or(false)
                })
                .unwrap();
            assert_eq!(
                after.as_stream().unwrap().content,
                before.as_stream().unwrap().content
            );
        }
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

    // ----- writing protection -----------------------------------------------

    /// A password in Arabic, to prove the writer takes one: revisions 5 and 6
    /// hold the password as UTF-8, where every script fits.
    const ARABIC: &str = "كلمة السر ١٢٣";

    /// An unprotected corpus file to protect. Two of them, so that both a
    /// classic cross-reference table and object streams are covered.
    fn plain_corpus() -> Vec<u8> {
        corpus("variant-linearized.pdf")
    }

    /// `bytes` protected with `open`/`owner`, written whole.
    fn protect(bytes: &[u8], open: &str, owner: &str, permissions: Permissions) -> Vec<u8> {
        let mut doc = load_preserving_ciphertext(bytes).unwrap();
        if is_encrypted(&doc) {
            decrypt_document(&mut doc, "").unwrap();
        }
        encrypt_document(
            &mut doc,
            &Protection {
                open_password: open.to_string(),
                owner_password: owner.to_string(),
                permissions,
                encrypt_metadata: true,
            },
        )
        .unwrap();
        let mut out = Vec::new();
        doc.save_to(&mut out).unwrap();
        out
    }

    /// What we write is what we read: the password opens it, the wrong one
    /// does not, and the pages come back.
    #[test]
    fn a_document_we_protect_opens_with_its_password_and_no_other() {
        let original = plain_corpus();
        let pages = load_preserving_ciphertext(&original)
            .unwrap()
            .get_pages()
            .len();
        let sealed = protect(&original, "warraq", "owner", Permissions::ALL);

        // It really is protected, and at revision 6 with AES-256.
        let description = describe(&sealed).expect("protected");
        assert_eq!(description.method, "aes-256");
        assert_eq!(description.revision, 6);
        assert_eq!(description.key_bits, 256);

        // The open password opens it; so does the owner password.
        for password in ["warraq", "owner"] {
            let mut doc = load_preserving_ciphertext(&sealed).unwrap();
            decrypt_document(&mut doc, password).unwrap();
            assert_eq!(doc.get_pages().len(), pages, "with {password}");
            assert!(!is_encrypted(&doc));
        }

        // Nothing else does.
        let mut doc = load_preserving_ciphertext(&sealed).unwrap();
        assert!(matches!(
            decrypt_document(&mut doc, "warra"),
            Err(CryptError::WrongPassword)
        ));
        let mut doc = load_preserving_ciphertext(&sealed).unwrap();
        assert!(matches!(
            decrypt_document(&mut doc, ""),
            Err(CryptError::WrongPassword)
        ));
    }

    /// The point of writing revision 6: an Arabic password round-trips
    /// byte for byte, where the Latin-1 passwords of revisions 2 to 4 cannot
    /// carry it at all.
    #[test]
    fn an_arabic_password_round_trips_exactly() {
        let sealed = protect(&plain_corpus(), ARABIC, ARABIC, Permissions::ALL);
        let mut doc = load_preserving_ciphertext(&sealed).unwrap();
        decrypt_document(&mut doc, ARABIC).unwrap();
        assert!(!doc.get_pages().is_empty());

        // A password that differs only in one Arabic letter is refused, and so
        // is one that differs only by a diacritic: nothing is folded away.
        for wrong in ["كلمة السر ١٢٤", "كلمة السر", "كَلمة السر ١٢٣", ""]
        {
            let mut doc = load_preserving_ciphertext(&sealed).unwrap();
            assert!(
                matches!(
                    decrypt_document(&mut doc, wrong),
                    Err(CryptError::WrongPassword)
                ),
                "{wrong:?} must not open it"
            );
        }
    }

    /// The document's own bytes survive the round trip: the first page's
    /// content stream comes back exactly as it went in.
    ///
    /// Object streams are the interesting case: their members are plaintext
    /// objects of their own once expanded, so every one of them must be
    /// encrypted individually on the way out.
    #[test]
    fn the_pages_bytes_survive_being_protected_and_opened() {
        for name in [
            "variant-linearized.pdf",
            "variant-objectstreams-xrefstream.pdf",
        ] {
            let original = corpus(name);
            let before = {
                let doc = load_preserving_ciphertext(&original).unwrap();
                page_content_and_producer(&doc)
            };
            let sealed = protect(&original, ARABIC, "owner", Permissions::ALL);
            let mut doc = load_preserving_ciphertext(&sealed).unwrap();
            decrypt_document(&mut doc, ARABIC).unwrap();
            assert_eq!(page_content_and_producer(&doc), before, "{name}");
        }
    }

    /// The permissions a person chooses are the `/P` bits a reader sees, and
    /// they come back as they were set.
    #[test]
    fn permissions_are_written_and_read_back() {
        for permissions in [
            Permissions::ALL,
            Permissions {
                print: true,
                copy: false,
                change: false,
            },
            Permissions {
                print: false,
                copy: false,
                change: false,
            },
        ] {
            let sealed = protect(&plain_corpus(), "warraq", "owner", permissions);
            let description = describe(&sealed).unwrap();
            assert_eq!(description.permissions, permissions);
        }
        // The bits the standard reserves are exactly as it prescribes: 1 and 2
        // clear, 7, 8 and 13 upwards set.
        let bits = Permissions::ALL.bits();
        assert_eq!(bits & 3, 0);
        assert_eq!(bits & 0xFFFF_F000u32 as i32, 0xFFFF_F000u32 as i32);
        assert_eq!(bits & 0xC0, 0xC0);
        // Accessibility (bit 10) is granted even when nothing else is.
        assert_eq!(
            Permissions {
                print: false,
                copy: false,
                change: false
            }
            .bits()
                & 512,
            512
        );
    }

    /// A file that was already protected is re-protected with a new password:
    /// the old one stops working and the new one works.
    #[test]
    fn the_password_of_a_protected_file_can_be_changed() {
        let original = corpus("variant-encrypted-aes256.pdf");
        let mut doc = load_preserving_ciphertext(&original).unwrap();
        decrypt_document(&mut doc, USER).unwrap();
        encrypt_document(
            &mut doc,
            &Protection {
                open_password: ARABIC.to_string(),
                owner_password: ARABIC.to_string(),
                permissions: Permissions::ALL,
                encrypt_metadata: true,
            },
        )
        .unwrap();
        let mut out = Vec::new();
        doc.save_to(&mut out).unwrap();

        let mut reopened = load_preserving_ciphertext(&out).unwrap();
        decrypt_document(&mut reopened, ARABIC).unwrap();
        assert_eq!(reopened.get_pages().len(), 3);
        let mut reopened = load_preserving_ciphertext(&out).unwrap();
        assert!(matches!(
            decrypt_document(&mut reopened, USER),
            Err(CryptError::WrongPassword)
        ));
    }

    /// Encrypting a document that is still ciphertext would encrypt it twice,
    /// so it is refused rather than attempted.
    #[test]
    fn a_still_encrypted_document_is_refused() {
        let mut doc = loaded("variant-encrypted-aes256.pdf");
        assert!(matches!(
            encrypt_document(
                &mut doc,
                &Protection {
                    open_password: "x".into(),
                    owner_password: "x".into(),
                    permissions: Permissions::ALL,
                    encrypt_metadata: true,
                }
            ),
            Err(CryptError::Unsupported(_))
        ));
    }

    /// Writes a protected copy where `WARRAQ_PROTECT_OUT` says, so that an
    /// implementation that is not ours can be pointed at it — the only way to
    /// know our `/Encrypt` dictionary is right and not merely self-consistent.
    /// Ignored by default because it writes outside the target directory:
    ///
    /// ```text
    /// WARRAQ_PROTECT_OUT=/tmp/protected.pdf cargo test -p warraq-pdf \
    ///   -- --ignored writes_a_protected_file_for_an_outside_reader
    /// python3 tests/tools/check_protection.py /tmp/protected.pdf
    /// ```
    #[test]
    #[ignore = "writes a file outside the target directory for an outside reader"]
    fn writes_a_protected_file_for_an_outside_reader() {
        let path = std::env::var("WARRAQ_PROTECT_OUT")
            .expect("set WARRAQ_PROTECT_OUT to where the file should go");
        let sealed = protect(
            &plain_corpus(),
            ARABIC,
            "owner",
            Permissions {
                print: true,
                copy: false,
                change: false,
            },
        );
        std::fs::write(&path, &sealed).unwrap();
    }

    /// An encrypted file needs an `/ID`, and one is made when the original had
    /// none.
    #[test]
    fn a_file_without_an_id_is_given_one() {
        let original = plain_corpus();
        let mut doc = load_preserving_ciphertext(&original).unwrap();
        doc.trailer.remove(b"ID");
        encrypt_document(
            &mut doc,
            &Protection {
                open_password: "warraq".into(),
                owner_password: "owner".into(),
                permissions: Permissions::ALL,
                encrypt_metadata: true,
            },
        )
        .unwrap();
        let id = doc.trailer.get(b"ID").and_then(Object::as_array).unwrap();
        assert_eq!(id.len(), 2);
        assert_eq!(id[0].as_str().unwrap().len(), 16);
    }
}
