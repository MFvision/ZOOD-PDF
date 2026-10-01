//! The standard security handler of ISO 32000-2 §7.6.4: everything that turns
//! a password and an `/Encrypt` dictionary into the file encryption key.
//!
//! Implemented here:
//!
//! * algorithm 2   — file key for revisions 2–4 (MD5 based),
//! * algorithm 2.A — file key for revisions 5 and 6 (AES key unwrapping),
//! * algorithm 2.B — the hardened hash of revision 6 (SHA-256/384/512),
//! * algorithms 4 and 5 — checking a user password for R2 and R3/R4,
//! * algorithm 7   — checking an owner password for R2–R4,
//! * algorithm 1   — the per-object key of `/V` 1, 2 and 4,
//! * algorithms 8, 9 and 10 — writing `/U`, `/UE`, `/O`, `/OE` and `/Perms`
//!   for a new revision-6 (AES-256) `/Encrypt` dictionary.

use std::collections::BTreeMap;

use lopdf::{Dictionary, Document, Object, ObjectId};
use md5::{Digest as _, Md5};
use sha2::{Sha256, Sha384, Sha512};

use super::cipher;
use super::CryptError;

/// The 32-byte padding string of ISO 32000-2, table 24.
const PAD: [u8; 32] = [
    0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41, 0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01, 0x08,
    0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80, 0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A,
];

/// The suffix that algorithm 1 appends to the per-object key of an `/AESV2`
/// crypt filter ("sAlT" in ASCII).
const AES_SALT: [u8; 4] = [0x73, 0x41, 0x6C, 0x54];

/// How a crypt filter transforms bytes — the `/CFM` entry of ISO 32000-2,
/// table 25, plus `/Identity`, which is not a filter but behaves like one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Method {
    /// `/Identity` or `/CFM /None`: the data is stored as-is.
    Identity,
    /// `/V 1`, `/V 2` or `/CFM /V2`: RC4 with the per-object key.
    Rc4,
    /// `/CFM /AESV2`: AES-128-CBC with the per-object key.
    Aes128,
    /// `/CFM /AESV3`: AES-256-CBC with the file key, unchanged.
    Aes256,
}

/// A parsed `/Encrypt` dictionary plus the first element of the file `/ID`.
#[derive(Debug)]
pub(crate) struct Handler {
    version: i64,
    revision: i64,
    /// File key length in bytes (5–16 for R2–R4, always 32 for R5/R6).
    key_len: usize,
    owner_value: Vec<u8>,
    user_value: Vec<u8>,
    owner_encrypted: Vec<u8>,
    user_encrypted: Vec<u8>,
    permissions: i32,
    encrypt_metadata: bool,
    id0: Vec<u8>,
    stream_method: Method,
    string_method: Method,
    /// `/CF`, so that a stream's own `/Crypt` filter can name a different one.
    filters: BTreeMap<Vec<u8>, Method>,
}

impl Handler {
    /// Read the `/Encrypt` dictionary of `doc` (and the file `/ID`).
    ///
    /// Fails with [`CryptError::NotEncrypted`] when the trailer has no
    /// `/Encrypt`, and with [`CryptError::Unsupported`] for a security handler
    /// other than `/Standard` or a revision we do not implement.
    pub(crate) fn from_document(doc: &Document) -> Result<Self, CryptError> {
        let encrypt = encryption_dictionary(doc)?;
        let name = |key: &[u8]| {
            encrypt
                .get(key)
                .and_then(Object::as_name)
                .ok()
                .map(<[u8]>::to_vec)
        };
        let int = |key: &[u8]| encrypt.get(key).and_then(Object::as_i64).ok();
        let bytes = |key: &[u8]| {
            encrypt
                .get(key)
                .and_then(Object::as_str)
                .ok()
                .map(<[u8]>::to_vec)
                .unwrap_or_default()
        };

        let filter = name(b"Filter").unwrap_or_default();
        if filter != b"Standard" {
            return Err(CryptError::Unsupported(format!(
                "security handler /{}",
                String::from_utf8_lossy(&filter)
            )));
        }
        let version = int(b"V").unwrap_or(0);
        let revision = int(b"R").unwrap_or(0);
        if !matches!(revision, 2..=6) || !matches!(version, 1 | 2 | 4 | 5) {
            return Err(CryptError::Unsupported(format!(
                "standard security handler /V {version} /R {revision}"
            )));
        }

        let key_len = if revision >= 5 {
            32
        } else if version == 1 {
            5
        } else {
            // /Length is in bits; the spec allows 40–128 in steps of 8.
            let bits = int(b"Length").unwrap_or(40).clamp(40, 128) as usize;
            (bits / 8).clamp(5, 16)
        };

        let mut filters = BTreeMap::new();
        if let Ok(cf) = encrypt.get(b"CF").and_then(Object::as_dict) {
            for (key, value) in cf.iter() {
                let cfm = value
                    .as_dict()
                    .ok()
                    .and_then(|d| d.get(b"CFM").and_then(Object::as_name).ok())
                    .unwrap_or(b"None");
                let method = match cfm {
                    b"V2" => Method::Rc4,
                    b"AESV2" => Method::Aes128,
                    b"AESV3" => Method::Aes256,
                    b"None" => Method::Identity,
                    other => {
                        return Err(CryptError::Unsupported(format!(
                            "crypt filter method /{}",
                            String::from_utf8_lossy(other)
                        )))
                    }
                };
                filters.insert(key.clone(), method);
            }
        }
        filters.insert(b"Identity".to_vec(), Method::Identity);

        // /V 1 and /V 2 have no crypt filters at all: RC4 everywhere. From /V 4
        // on, /StmF and /StrF name an entry of /CF, defaulting to /Identity.
        let resolve = |key: &[u8]| -> Result<Method, CryptError> {
            if version < 4 {
                return Ok(Method::Rc4);
            }
            let named = name(key).unwrap_or_else(|| b"Identity".to_vec());
            filters.get(&named).copied().ok_or_else(|| {
                CryptError::Unsupported(format!(
                    "crypt filter /{} named by /{}",
                    String::from_utf8_lossy(&named),
                    String::from_utf8_lossy(key)
                ))
            })
        };
        let stream_method = resolve(b"StmF")?;
        let string_method = resolve(b"StrF")?;

        Ok(Self {
            version,
            revision,
            key_len,
            owner_value: bytes(b"O"),
            user_value: bytes(b"U"),
            owner_encrypted: bytes(b"OE"),
            user_encrypted: bytes(b"UE"),
            permissions: int(b"P").unwrap_or(0) as i32,
            encrypt_metadata: encrypt
                .get(b"EncryptMetadata")
                .and_then(Object::as_bool)
                .unwrap_or(true),
            id0: file_id(doc),
            stream_method,
            string_method,
            filters,
        })
    }

    pub(crate) fn stream_method(&self) -> Method {
        self.stream_method
    }

    pub(crate) fn string_method(&self) -> Method {
        self.string_method
    }

    pub(crate) fn encrypt_metadata(&self) -> bool {
        self.encrypt_metadata
    }

    /// Look up a crypt filter that a stream named through its own `/Crypt`
    /// filter. An unknown name means `/Identity`, as ISO 32000-2 §7.4.10 says.
    pub(crate) fn named_filter(&self, name: &[u8]) -> Method {
        self.filters.get(name).copied().unwrap_or(Method::Identity)
    }

    /// Derive the file encryption key from `password`, trying it as the user
    /// password first and then as the owner password.
    ///
    /// Returns [`CryptError::WrongPassword`] when it is neither.
    pub(crate) fn authenticate(&self, password: &str) -> Result<Vec<u8>, CryptError> {
        if self.revision >= 5 {
            self.authenticate_r6(password)
        } else {
            self.authenticate_r4(password)
        }
    }

    // ----- revisions 2 to 4 -------------------------------------------------

    /// Algorithm 2: the file key for revisions 2–4, given the *user* password.
    fn file_key_r4(&self, password: &[u8]) -> Vec<u8> {
        let mut hasher = Md5::new();
        hasher.update(pad_password(password));
        hasher.update(&self.owner_value);
        hasher.update(self.permissions.to_le_bytes());
        hasher.update(&self.id0);
        // Step (f): revision 4 and later add four 0xFF bytes when the document
        // metadata is left in the clear.
        if self.revision >= 4 && !self.encrypt_metadata {
            hasher.update([0xFF, 0xFF, 0xFF, 0xFF]);
        }
        let mut hash = hasher.finalize().to_vec();
        if self.revision >= 3 {
            for _ in 0..50 {
                hash = Md5::digest(&hash[..self.key_len]).to_vec();
            }
        }
        hash.truncate(self.key_len);
        hash
    }

    /// Algorithm 4 (R2) and algorithm 5 (R3, R4): the expected `/U` value.
    fn expected_user_value(&self, file_key: &[u8]) -> Vec<u8> {
        if self.revision == 2 {
            return cipher::rc4(file_key, &PAD);
        }
        let mut hasher = Md5::new();
        hasher.update(PAD);
        hasher.update(&self.id0);
        let mut value = cipher::rc4(file_key, &hasher.finalize());
        for i in 1..=19u8 {
            let key: Vec<u8> = file_key.iter().map(|b| b ^ i).collect();
            value = cipher::rc4(&key, &value);
        }
        value
    }

    /// Algorithm 6: is `password` the user password? R2 compares all 32 bytes
    /// of `/U`, R3 and R4 only the first 16 (the rest is arbitrary padding).
    fn is_user_password(&self, password: &[u8]) -> Option<Vec<u8>> {
        let file_key = self.file_key_r4(password);
        let expected = self.expected_user_value(&file_key);
        let compared = if self.revision == 2 { 32 } else { 16 };
        let matches = self.user_value.len() >= compared
            && expected.len() >= compared
            && expected[..compared] == self.user_value[..compared];
        matches.then_some(file_key)
    }

    /// Algorithm 7: treat `password` as the owner password, recover the user
    /// password from `/O`, and authenticate that instead.
    fn authenticate_r4(&self, password: &str) -> Result<Vec<u8>, CryptError> {
        let password = pdf_doc_encode(password);
        if let Some(key) = self.is_user_password(&password) {
            return Ok(key);
        }

        // Step (a): the RC4 key is built from the owner password exactly like
        // the first half of algorithm 3.
        let mut hash = Md5::digest(pad_password(&password)).to_vec();
        if self.revision >= 3 {
            for _ in 0..50 {
                hash = Md5::digest(&hash).to_vec();
            }
        }
        let key = &hash[..self.key_len];

        // Step (b): R2 decrypts /O once, R3 and later run 20 rounds backwards.
        let mut user_password = self.owner_value.clone();
        if self.revision == 2 {
            user_password = cipher::rc4(key, &user_password);
        } else {
            for i in (0..=19u8).rev() {
                let round: Vec<u8> = key.iter().map(|b| b ^ i).collect();
                user_password = cipher::rc4(&round, &user_password);
            }
        }
        self.is_user_password(&user_password)
            .ok_or(CryptError::WrongPassword)
    }

    // ----- revisions 5 and 6 ------------------------------------------------

    /// Algorithm 2.A: check `password` against `/U` then `/O`, and unwrap the
    /// file key from `/UE` or `/OE` with AES-256-CBC (zero IV, no padding).
    fn authenticate_r6(&self, password: &str) -> Result<Vec<u8>, CryptError> {
        if self.user_value.len() < 48 || self.owner_value.len() < 48 {
            return Err(CryptError::Unsupported(
                "/U and /O must be 48 bytes for /R 5 and /R 6".into(),
            ));
        }
        let password = utf8_password(password);
        let user = &self.user_value[..48];

        let unwrap = |hash: Vec<u8>, wrapped: &[u8]| -> Result<Vec<u8>, CryptError> {
            let key: [u8; 32] = hash
                .get(..32)
                .and_then(|k| k.try_into().ok())
                .ok_or_else(|| CryptError::Unsupported("short intermediate key".into()))?;
            if wrapped.len() != 32 {
                return Err(CryptError::Unsupported(
                    "/UE and /OE must be 32 bytes".into(),
                ));
            }
            Ok(cipher::aes256_cbc_decrypt_no_padding(&key, wrapped))
        };

        if self.hash_2b(&password, &user[32..40], &[]) == user[..32] {
            return unwrap(
                self.hash_2b(&password, &user[40..48], &[]),
                &self.user_encrypted,
            );
        }
        let owner = &self.owner_value[..48];
        if self.hash_2b(&password, &owner[32..40], user) == owner[..32] {
            return unwrap(
                self.hash_2b(&password, &owner[40..48], user),
                &self.owner_encrypted,
            );
        }
        Err(CryptError::WrongPassword)
    }

    /// Algorithm 2.B: the hardened hash of revision 6. Revision 5 (the
    /// deprecated Adobe extension) stops after the first SHA-256.
    ///
    /// `user_key` is the 48-byte `/U` value when checking an owner password and
    /// empty otherwise.
    fn hash_2b(&self, password: &[u8], salt: &[u8], user_key: &[u8]) -> Vec<u8> {
        let mut hasher = Sha256::new();
        hasher.update(password);
        hasher.update(salt);
        hasher.update(user_key);
        let mut k = hasher.finalize().to_vec();
        if self.revision == 5 {
            return k;
        }

        let mut e = Vec::new();
        for round in 1u32.. {
            // (a) K1 is 64 repetitions of password ‖ K ‖ user key.
            e.clear();
            for _ in 0..64 {
                e.extend_from_slice(password);
                e.extend_from_slice(&k);
                e.extend_from_slice(user_key);
            }
            // (b) AES-128-CBC over K1, keyed by the two halves of K.
            let key: [u8; 16] = k[..16].try_into().expect("K is at least 32 bytes");
            let iv: [u8; 16] = k[16..32].try_into().expect("K is at least 32 bytes");
            cipher::aes128_cbc_encrypt_in_place(&key, &iv, &mut e);
            // (c) The first 16 bytes of E as a big-endian integer, modulo 3 —
            // and 256 ≡ 1 (mod 3), so the byte sum has the same remainder.
            let selector = e[..16].iter().map(|b| u32::from(*b)).sum::<u32>() % 3;
            // (d) Hash E with the algorithm that selector picked.
            k = match selector {
                0 => Sha256::digest(&e).to_vec(),
                1 => Sha384::digest(&e).to_vec(),
                _ => Sha512::digest(&e).to_vec(),
            };
            // At least 64 rounds, then until the last byte of E is small
            // enough. `round` cannot overflow before that: the loop exits with
            // probability ~1/8 or better from round 64 on.
            if round >= 64 && u32::from(e[e.len() - 1]) <= round - 32 {
                break;
            }
        }
        k.truncate(32);
        k
    }

    // ----- per-object keys --------------------------------------------------

    /// Algorithm 1: mix the object and generation numbers into the file key.
    /// `/AESV3` skips this and uses the file key as it stands.
    pub(crate) fn object_key(&self, file_key: &[u8], id: ObjectId, method: Method) -> Vec<u8> {
        if method == Method::Aes256 || self.version >= 5 {
            return file_key.to_vec();
        }
        let mut hasher = Md5::new();
        hasher.update(file_key);
        hasher.update(&id.0.to_le_bytes()[..3]);
        hasher.update(&id.1.to_le_bytes()[..2]);
        if method == Method::Aes128 {
            hasher.update(AES_SALT);
        }
        let mut key = hasher.finalize().to_vec();
        key.truncate((file_key.len() + 5).min(16));
        key
    }

    /// Encrypt one string or stream that belongs to object `id`, for writing:
    /// the inverse of [`Handler::decrypt`], with a fresh random IV for AES.
    pub(crate) fn encrypt(
        &self,
        file_key: &[u8],
        id: ObjectId,
        method: Method,
        data: &[u8],
    ) -> Result<Vec<u8>, CryptError> {
        let key = self.object_key(file_key, id, method);
        match method {
            Method::Identity => Ok(data.to_vec()),
            Method::Rc4 => Ok(cipher::rc4(&key, data)),
            Method::Aes128 | Method::Aes256 => {
                let mut iv = [0u8; 16];
                getrandom::fill(&mut iv).map_err(|e| {
                    CryptError::Unsupported(format!("no source of randomness for AES: {e}"))
                })?;
                cipher::aes_cbc_encrypt(&key, &iv, data)
            }
        }
    }

    // ----- describing and writing protection --------------------------------

    /// How this handler protects the file, for the interface to report.
    pub(crate) fn description(&self) -> super::Description {
        super::Description {
            method: match (self.stream_method, self.key_len) {
                (Method::Aes256, _) => "aes-256",
                (Method::Aes128, _) => "aes-128",
                (Method::Rc4, 5) => "rc4-40",
                (Method::Rc4, _) => "rc4-128",
                (Method::Identity, _) => "none",
            },
            revision: self.revision,
            key_bits: self.key_len * 8,
            permissions: super::Permissions::from_bits(self.permissions),
            encrypt_metadata: self.encrypt_metadata,
        }
    }

    /// A fresh revision-6 handler: a random 32-byte file key, `/U` and `/UE`
    /// from the open password (algorithm 8), `/O` and `/OE` from the owner
    /// password (algorithm 9) and `/Perms` from the permissions (algorithm 10).
    ///
    /// Answers the handler, the file key and the `/Encrypt` dictionary to
    /// write. Nothing here keeps the passwords: they are hashed and dropped.
    pub(crate) fn new_aes256(
        open_password: &str,
        owner_password: &str,
        permissions: i32,
        encrypt_metadata: bool,
    ) -> Result<(Self, Vec<u8>, Dictionary), CryptError> {
        let mut file_key = [0u8; 32];
        random(&mut file_key)?;

        // A handler with the shape of what is being written, so that `hash_2b`
        // — algorithm 2.B, which reading and writing share — runs with
        // revision 6's rules. Its /U…/OE are filled in below.
        let mut handler = Self {
            version: 5,
            revision: 6,
            key_len: 32,
            owner_value: Vec::new(),
            user_value: Vec::new(),
            owner_encrypted: Vec::new(),
            user_encrypted: Vec::new(),
            permissions,
            encrypt_metadata,
            // Revision 6 does not mix the file /ID into the key at all.
            id0: Vec::new(),
            stream_method: Method::Aes256,
            string_method: Method::Aes256,
            filters: [
                (b"StdCF".to_vec(), Method::Aes256),
                (b"Identity".to_vec(), Method::Identity),
            ]
            .into_iter()
            .collect(),
        };

        let open = utf8_password(open_password);
        let owner = utf8_password(owner_password);

        // Algorithm 8: /U is the validation hash over an 8-byte validation
        // salt, then that salt and the 8-byte key salt; /UE wraps the file key
        // under the hash over the key salt.
        let mut salts = [0u8; 16];
        random(&mut salts)?;
        let mut user_value = handler.hash_2b(&open, &salts[..8], &[]);
        user_value.extend_from_slice(&salts);
        let user_encrypted = cipher::aes256_cbc_encrypt_no_padding(
            &key32(&handler.hash_2b(&open, &salts[8..], &[]))?,
            &file_key,
        );

        // Algorithm 9: the same, with the 48 bytes of /U mixed into the hash,
        // so an owner password cannot be checked without the file's own /U.
        let mut salts = [0u8; 16];
        random(&mut salts)?;
        let mut owner_value = handler.hash_2b(&owner, &salts[..8], &user_value);
        owner_value.extend_from_slice(&salts);
        let owner_encrypted = cipher::aes256_cbc_encrypt_no_padding(
            &key32(&handler.hash_2b(&owner, &salts[8..], &user_value))?,
            &file_key,
        );

        handler.user_value = user_value.clone();
        handler.owner_value = owner_value.clone();
        handler.user_encrypted = user_encrypted.clone();
        handler.owner_encrypted = owner_encrypted.clone();

        let perms = encode_perms(&file_key, permissions, encrypt_metadata)?;

        let mut std_cf = Dictionary::new();
        std_cf.set("CFM", Object::Name(b"AESV3".to_vec()));
        std_cf.set("AuthEvent", Object::Name(b"DocOpen".to_vec()));
        std_cf.set("Length", Object::Integer(32));
        let mut cf = Dictionary::new();
        cf.set("StdCF", Object::Dictionary(std_cf));

        let mut dict = Dictionary::new();
        dict.set("Filter", Object::Name(b"Standard".to_vec()));
        dict.set("V", Object::Integer(5));
        dict.set("R", Object::Integer(6));
        dict.set("Length", Object::Integer(256));
        dict.set("CF", Object::Dictionary(cf));
        dict.set("StmF", Object::Name(b"StdCF".to_vec()));
        dict.set("StrF", Object::Name(b"StdCF".to_vec()));
        dict.set("U", Object::string_literal(user_value));
        dict.set("O", Object::string_literal(owner_value));
        dict.set("UE", Object::string_literal(user_encrypted));
        dict.set("OE", Object::string_literal(owner_encrypted));
        dict.set("Perms", Object::string_literal(perms));
        dict.set("P", Object::Integer(i64::from(permissions)));
        dict.set("EncryptMetadata", Object::Boolean(encrypt_metadata));

        Ok((handler, file_key.to_vec(), dict))
    }

    /// Decrypt one string or stream that belongs to object `id`.
    pub(crate) fn decrypt(
        &self,
        file_key: &[u8],
        id: ObjectId,
        method: Method,
        data: &[u8],
    ) -> Result<Vec<u8>, CryptError> {
        let key = self.object_key(file_key, id, method);
        match method {
            Method::Identity => Ok(data.to_vec()),
            Method::Rc4 => Ok(cipher::rc4(&key, data)),
            Method::Aes128 | Method::Aes256 => cipher::aes_cbc_decrypt(&key, data),
        }
    }
}

/// The `/Encrypt` dictionary, whether it is an indirect reference (the normal
/// case) or written inline in the trailer.
fn encryption_dictionary(doc: &Document) -> Result<&Dictionary, CryptError> {
    let entry = doc
        .trailer
        .get(b"Encrypt")
        .map_err(|_| CryptError::NotEncrypted)?;
    match entry {
        Object::Reference(id) => doc
            .get_dictionary(*id)
            .map_err(|_| CryptError::Unsupported("/Encrypt points at no dictionary".into())),
        Object::Dictionary(dict) => Ok(dict),
        _ => Err(CryptError::Unsupported(
            "/Encrypt is not a dictionary".into(),
        )),
    }
}

/// The first element of the trailer's `/ID`, which seeds algorithm 2. A file
/// without `/ID` contributes nothing, which is what the spec's wording allows.
fn file_id(doc: &Document) -> Vec<u8> {
    doc.trailer
        .get(b"ID")
        .and_then(Object::as_array)
        .ok()
        .and_then(|a| a.first())
        .and_then(|o| o.as_str().ok())
        .map(<[u8]>::to_vec)
        .unwrap_or_default()
}

/// Step (a) of algorithm 2: the password truncated to 32 bytes, or extended
/// from the front of the padding string.
fn pad_password(password: &[u8]) -> [u8; 32] {
    let mut out = PAD;
    let n = password.len().min(32);
    out[..n].copy_from_slice(&password[..n]);
    out[n..].copy_from_slice(&PAD[..32 - n]);
    out
}

/// Revisions 2–4 take the password in PDFDocEncoding. That agrees with
/// Latin-1 over the whole range Warraq can produce, so a character that fits
/// in one byte becomes that byte; anything else falls back to its UTF-8 bytes,
/// which is what most producers do in practice.
fn pdf_doc_encode(password: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(password.len());
    let mut buf = [0u8; 4];
    for ch in password.chars() {
        if (ch as u32) < 0x100 {
            out.push(ch as u8);
        } else {
            out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
        }
    }
    out
}

/// Revisions 5 and 6 take the password as UTF-8, truncated to 127 bytes.
///
/// ISO 32000-2 also asks for SASLprep (RFC 4013) normalisation first; that is
/// not implemented, so a password that only normalises to the stored form —
/// one with non-NFKC characters or non-ASCII spaces — is not recognised.
/// ASCII passwords, which is what Warraq's own tooling produces, are
/// unaffected.
fn utf8_password(password: &str) -> Vec<u8> {
    let bytes = password.as_bytes();
    let mut end = bytes.len().min(127);
    // Do not cut a UTF-8 sequence in half.
    while end > 0 && !password.is_char_boundary(end) {
        end -= 1;
    }
    bytes[..end].to_vec()
}

/// Algorithm 10: the 16-byte `/Perms` value — the permissions, four 0xFF
/// bytes, whether the metadata is encrypted, the marker "adb" and four random
/// bytes — encrypted with the file key in AES-256-ECB. A reader that trusts
/// `/Perms` cannot be lied to about the permissions by an edit of `/P`,
/// because only the file key can produce it.
fn encode_perms(
    file_key: &[u8; 32],
    permissions: i32,
    encrypt_metadata: bool,
) -> Result<Vec<u8>, CryptError> {
    let mut perms = [0u8; 16];
    perms[..4].copy_from_slice(&permissions.to_le_bytes());
    perms[4..8].copy_from_slice(&[0xFF; 4]);
    perms[8] = if encrypt_metadata { b'T' } else { b'F' };
    perms[9..12].copy_from_slice(b"adb");
    random(&mut perms[12..16])?;
    cipher::aes256_ecb_encrypt_block(file_key, &mut perms);
    Ok(perms.to_vec())
}

/// `bytes` as a 32-byte AES key. The hashes of algorithm 2.B are always at
/// least 32 bytes long, so this never fails in practice; it is a `Result`
/// rather than a panic because nothing derived from a file may panic.
fn key32(bytes: &[u8]) -> Result<[u8; 32], CryptError> {
    bytes
        .get(..32)
        .and_then(|k| k.try_into().ok())
        .ok_or_else(|| CryptError::Unsupported("short intermediate key".into()))
}

/// Random bytes, or an error: a key we cannot make unpredictable we must not
/// write.
fn random(into: &mut [u8]) -> Result<(), CryptError> {
    getrandom::fill(into)
        .map_err(|e| CryptError::Unsupported(format!("no source of randomness: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Algorithm 10 written and read back: the permissions and the metadata
    /// flag survive the round trip, and the marker is where the spec puts it.
    #[test]
    fn perms_encodes_the_permissions_under_the_file_key() {
        let key = [0x5Au8; 32];
        let coded = encode_perms(&key, -3904, false).unwrap();
        assert_eq!(coded.len(), 16);
        let mut block: [u8; 16] = coded.try_into().unwrap();
        cipher::aes256_ecb_decrypt_block(&key, &mut block);
        assert_eq!(i32::from_le_bytes(block[..4].try_into().unwrap()), -3904);
        assert_eq!(&block[4..8], &[0xFF; 4]);
        assert_eq!(block[8], b'F');
        assert_eq!(&block[9..12], b"adb");
        assert_eq!(encode_perms(&key, -1, true).unwrap().len(), 16);
    }

    #[test]
    fn padding_follows_algorithm_2_step_a() {
        assert_eq!(pad_password(b""), PAD);
        let padded = pad_password(b"warraq");
        assert_eq!(&padded[..6], b"warraq");
        assert_eq!(&padded[6..], &PAD[..26]);
        // A password longer than 32 bytes is truncated, not hashed.
        let long: Vec<u8> = (0..40).collect();
        assert_eq!(pad_password(&long)[..], long[..32]);
    }

    #[test]
    fn passwords_are_encoded_per_revision() {
        assert_eq!(pdf_doc_encode("warraq"), b"warraq");
        assert_eq!(pdf_doc_encode("é"), vec![0xE9]);
        assert_eq!(utf8_password("warraq"), b"warraq");
        // Truncation to 127 bytes never splits a character.
        let long = "é".repeat(100);
        let cut = utf8_password(&long);
        assert_eq!(cut.len(), 126);
        assert!(std::str::from_utf8(&cut).is_ok());
    }
}
