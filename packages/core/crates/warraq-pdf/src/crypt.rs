//! Own implementation of the PDF Standard security handler (ISO 32000-2 §7.6.4).
//!
//! lopdf drops or garbles objects it cannot decrypt, and we must (a) tell user from owner
//! passwords, (b) keep the file key to re-encrypt objects we append in incremental updates,
//! and (c) write new AES-256 (R6) protection. So lopdf is only used as a *parser*: the loader
//! hides `/Encrypt` from it, and this module does all key derivation and (de|en)cryption.
//!
//! Supported: V1/R2 (RC4-40), V2/R3 (RC4 40–128), V4/R4 (crypt filters with /V2 = RC4 or
//! /AESV2 = AES-128-CBC, /Identity), V5/R5 (Adobe extension level 3) and V5/R6 (AES-256,
//! hash algorithm 2.B), `/EncryptMetadata false`, per-stream `/Crypt` filters, and user and
//! owner password authentication for every revision.

use crate::error::{PdfError, Result};
use crate::limits::Limits;
use aes::cipher::block_padding::{NoPadding, Pkcs7};
use aes::cipher::{BlockModeDecrypt, BlockModeEncrypt, KeyInit, KeyIvInit, StreamCipher};
use lopdf::{Dictionary, Object, ObjectId, StringFormat};
use md5::{Digest, Md5};
use sha2::{Sha256, Sha384, Sha512};

/// The 32-byte padding string of Algorithm 2 step (a).
const PAD: [u8; 32] = [
    0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41, 0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01, 0x08,
    0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80, 0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A,
];

/// How strings or streams of a crypt filter are transformed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CryptMethod {
    /// `/Identity` or `/None`: data is stored in the clear.
    Identity,
    /// `/V2`: RC4 with the per-object key.
    Rc4,
    /// `/AESV2`: AES-128-CBC with the per-object key, random IV prefix.
    AesV2,
    /// `/AESV3`: AES-256-CBC with the file key, random IV prefix.
    AesV3,
}

/// Which password opened the document.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasswordKind {
    /// The user ("open") password: permissions in `/P` apply.
    User,
    /// The owner ("permissions") password: every operation is allowed.
    Owner,
}

impl PasswordKind {
    /// `"user"` or `"owner"` for the RPC layer.
    pub fn as_str(&self) -> &'static str {
        match self {
            PasswordKind::User => "user",
            PasswordKind::Owner => "owner",
        }
    }
}

/// The `/P` permission bits (ISO 32000-2 Table 22). Bit numbers are 1-based as in the spec.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Permissions(pub i32);

/// Named permission flags used by the RPC layer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PermissionFlags {
    /// Bit 3: print (possibly degraded).
    pub print: bool,
    /// Bit 4: modify contents by other operations than 6, 9, 11.
    pub modify: bool,
    /// Bit 5: copy or extract text and graphics.
    pub copy: bool,
    /// Bit 6: add or modify annotations, fill forms.
    pub annotate: bool,
    /// Bit 9: fill existing form fields (even if bit 6 is clear).
    pub fill_forms: bool,
    /// Bit 10: extract for accessibility.
    pub accessibility: bool,
    /// Bit 11: assemble (insert, rotate, delete pages, bookmarks, thumbnails).
    pub assemble: bool,
    /// Bit 12: print at full quality.
    pub print_high: bool,
}

impl PermissionFlags {
    /// Everything allowed.
    pub fn all() -> Self {
        PermissionFlags {
            print: true,
            modify: true,
            copy: true,
            annotate: true,
            fill_forms: true,
            accessibility: true,
            assemble: true,
            print_high: true,
        }
    }
}

impl Permissions {
    fn bit(&self, n: u32) -> bool {
        (self.0 as u32) & (1u32 << (n - 1)) != 0
    }

    /// Decode into named flags.
    pub fn flags(&self) -> PermissionFlags {
        PermissionFlags {
            print: self.bit(3),
            modify: self.bit(4),
            copy: self.bit(5),
            annotate: self.bit(6),
            fill_forms: self.bit(9),
            accessibility: self.bit(10),
            assemble: self.bit(11),
            print_high: self.bit(12),
        }
    }

    /// Encode named flags with the reserved bits set as the spec requires (bits 7, 8, 13–32 = 1).
    pub fn from_flags(f: &PermissionFlags) -> Self {
        let mut p: u32 = 0xFFFF_F0C0;
        let set = |p: &mut u32, n: u32, on: bool| {
            if on {
                *p |= 1 << (n - 1);
            }
        };
        set(&mut p, 3, f.print);
        set(&mut p, 4, f.modify);
        set(&mut p, 5, f.copy);
        set(&mut p, 6, f.annotate);
        set(&mut p, 9, f.fill_forms);
        set(&mut p, 10, f.accessibility);
        set(&mut p, 11, f.assemble);
        set(&mut p, 12, f.print_high);
        Permissions(p as i32)
    }
}

/// An authenticated Standard security handler: holds the file key and knows how to
/// decrypt and encrypt every string and stream of the document.
#[derive(Clone)]
pub struct SecurityHandler {
    /// `/V`.
    pub v: i64,
    /// `/R`.
    pub r: i64,
    /// The file encryption key (5–16 bytes for R2–R4, 32 bytes for R5/R6).
    key: Vec<u8>,
    /// Method for streams (`/StmF`).
    pub stm: CryptMethod,
    /// Method for strings (`/StrF`).
    pub strf: CryptMethod,
    /// Method for embedded files (`/EFF`).
    pub eff: CryptMethod,
    /// Named crypt filters from `/CF` (for per-stream `/Crypt` filters).
    named: Vec<(Vec<u8>, CryptMethod)>,
    /// `/EncryptMetadata`.
    pub encrypt_metadata: bool,
    /// `/P`.
    pub permissions: Permissions,
    /// Which password authenticated.
    pub matched: PasswordKind,
    /// The encryption dictionary as found in (or written to) the file.
    pub dict: Dictionary,
}

impl std::fmt::Debug for SecurityHandler {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SecurityHandler")
            .field("v", &self.v)
            .field("r", &self.r)
            .field("stm", &self.stm)
            .field("strf", &self.strf)
            .field("matched", &self.matched)
            .field("permissions", &self.permissions)
            .finish_non_exhaustive()
    }
}

// ---------------------------------------------------------------- primitives

fn md5(parts: &[&[u8]]) -> [u8; 16] {
    let mut h = Md5::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

fn rc4(key: &[u8], data: &[u8]) -> Result<Vec<u8>> {
    let mut c =
        rc4::Rc4::new_from_slice(key).map_err(|_| PdfError::Crypto("bad RC4 key length".into()))?;
    let mut out = data.to_vec();
    c.apply_keystream(&mut out);
    Ok(out)
}

fn aes_cbc_encrypt(key: &[u8], iv: &[u8], data: &[u8], pad: bool) -> Result<Vec<u8>> {
    let bad = |_| PdfError::Crypto("bad AES key/iv length".into());
    match key.len() {
        16 => {
            let c = cbc::Encryptor::<aes::Aes128>::new_from_slices(key, iv).map_err(bad)?;
            Ok(if pad {
                c.encrypt_padded_vec::<Pkcs7>(data)
            } else {
                if data.len() % 16 != 0 {
                    return Err(PdfError::Crypto(
                        "unpadded AES input not block aligned".into(),
                    ));
                }
                c.encrypt_padded_vec::<NoPadding>(data)
            })
        }
        32 => {
            let c = cbc::Encryptor::<aes::Aes256>::new_from_slices(key, iv).map_err(bad)?;
            Ok(if pad {
                c.encrypt_padded_vec::<Pkcs7>(data)
            } else {
                if data.len() % 16 != 0 {
                    return Err(PdfError::Crypto(
                        "unpadded AES input not block aligned".into(),
                    ));
                }
                c.encrypt_padded_vec::<NoPadding>(data)
            })
        }
        _ => Err(PdfError::Crypto("AES key must be 16 or 32 bytes".into())),
    }
}

fn aes_cbc_decrypt(key: &[u8], iv: &[u8], data: &[u8], pad: bool) -> Result<Vec<u8>> {
    let bad = |_| PdfError::Crypto("bad AES key/iv length".into());
    let aligned = data.get(..data.len() - data.len() % 16).unwrap_or_default();
    macro_rules! run {
        ($t:ty) => {{
            if pad {
                let c = cbc::Decryptor::<$t>::new_from_slices(key, iv).map_err(bad)?;
                match c.decrypt_padded_vec::<Pkcs7>(aligned) {
                    Ok(v) => Ok(v),
                    // Broken padding is common in the wild: keep the unpadded plaintext.
                    Err(_) => {
                        let c = cbc::Decryptor::<$t>::new_from_slices(key, iv).map_err(bad)?;
                        c.decrypt_padded_vec::<NoPadding>(aligned)
                            .map_err(|_| PdfError::Crypto("AES decrypt failed".into()))
                    }
                }
            } else {
                let c = cbc::Decryptor::<$t>::new_from_slices(key, iv).map_err(bad)?;
                c.decrypt_padded_vec::<NoPadding>(aligned)
                    .map_err(|_| PdfError::Crypto("AES decrypt failed".into()))
            }
        }};
    }
    match key.len() {
        16 => run!(aes::Aes128),
        32 => run!(aes::Aes256),
        _ => Err(PdfError::Crypto("AES key must be 16 or 32 bytes".into())),
    }
}

/// Cryptographically secure random bytes (getrandom: OS on native, crypto.getRandomValues on wasm).
pub fn random_bytes<const N: usize>() -> Result<[u8; N]> {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).map_err(|e| PdfError::Crypto(format!("no randomness: {e}")))?;
    Ok(b)
}

fn pad_password(pw: &[u8]) -> [u8; 32] {
    let mut out = PAD;
    let n = pw.len().min(32);
    for (o, b) in out.iter_mut().zip(pw.iter().take(n)) {
        *o = *b;
    }
    // Fill the remainder from the start of PAD.
    for (o, p) in out.iter_mut().skip(n).zip(PAD.iter()) {
        *o = *p;
    }
    out
}

/// Password bytes for R2–R4: PDFDocEncoding ≈ Latin-1 for the characters it covers;
/// anything else falls back to UTF-8 bytes (non-portable, documented in ADR 0004).
pub fn legacy_password_bytes(pw: &str) -> Vec<u8> {
    if pw.chars().all(|c| (c as u32) < 256) {
        pw.chars().map(|c| c as u32 as u8).collect()
    } else {
        pw.as_bytes().to_vec()
    }
}

/// Password bytes for R5/R6: UTF-8 truncated to 127 bytes. (SASLprep is skipped: it changes
/// nothing for ASCII/Arabic passwords without compatibility characters; see ADR 0004.)
pub fn unicode_password_bytes(pw: &str) -> Vec<u8> {
    let b = pw.as_bytes();
    let mut end = b.len().min(127);
    while end > 0 && !pw.is_char_boundary(end) {
        end -= 1;
    }
    b.get(..end).unwrap_or_default().to_vec()
}

// ------------------------------------------------------------- R2–R4 algorithms

/// Algorithm 2: file key from a (user) password.
fn key_r234(
    pw: &[u8],
    o: &[u8],
    p: i32,
    id0: &[u8],
    r: i64,
    n: usize,
    encrypt_metadata: bool,
) -> Vec<u8> {
    let mut h = Md5::new();
    h.update(pad_password(pw));
    h.update(o.get(..32).unwrap_or(o));
    h.update((p as u32).to_le_bytes());
    h.update(id0);
    if r >= 4 && !encrypt_metadata {
        h.update([0xFF; 4]);
    }
    let mut d: [u8; 16] = h.finalize().into();
    if r >= 3 {
        for _ in 0..50 {
            d = md5(&[d.get(..n).unwrap_or(&d)]);
        }
    }
    d.get(..n).unwrap_or(&d).to_vec()
}

/// Algorithms 4/5: the /U value for a file key.
fn u_r234(key: &[u8], r: i64, id0: &[u8]) -> Result<Vec<u8>> {
    if r == 2 {
        return rc4(key, &PAD);
    }
    let mut x = rc4(key, &md5(&[&PAD, id0]))?;
    for i in 1..=19u8 {
        let k: Vec<u8> = key.iter().map(|b| b ^ i).collect();
        x = rc4(&k, &x)?;
    }
    x.extend_from_slice(&[0u8; 16]);
    Ok(x)
}

/// Algorithm 3 steps (a)–(d): RC4 key derived from the owner password.
fn owner_key_r234(owner: &[u8], r: i64, n: usize) -> Vec<u8> {
    let mut d = md5(&[&pad_password(owner)]);
    if r >= 3 {
        for _ in 0..50 {
            d = md5(&[&d]);
        }
    }
    d.get(..n).unwrap_or(&d).to_vec()
}

/// Algorithm 3: the /O value.
fn o_r234(owner: &[u8], user: &[u8], r: i64, n: usize) -> Result<Vec<u8>> {
    let key = owner_key_r234(owner, r, n);
    let mut x = rc4(&key, &pad_password(user))?;
    if r >= 3 {
        for i in 1..=19u8 {
            let k: Vec<u8> = key.iter().map(|b| b ^ i).collect();
            x = rc4(&k, &x)?;
        }
    }
    Ok(x)
}

/// Algorithm 7 step (b): recover the padded user password from /O with an owner password.
fn user_from_o_r234(owner: &[u8], o: &[u8], r: i64, n: usize) -> Result<Vec<u8>> {
    let key = owner_key_r234(owner, r, n);
    let o = o.get(..32).unwrap_or(o);
    if r == 2 {
        return rc4(&key, o);
    }
    let mut x = o.to_vec();
    for i in (0..=19u8).rev() {
        let k: Vec<u8> = key.iter().map(|b| b ^ i).collect();
        x = rc4(&k, &x)?;
    }
    Ok(x)
}

fn check_user_r234(key: &[u8], u: &[u8], r: i64, id0: &[u8]) -> Result<bool> {
    let calc = u_r234(key, r, id0)?;
    let cmp = if r == 2 { 32 } else { 16 };
    Ok(calc.get(..cmp).is_some() && calc.get(..cmp) == u.get(..cmp))
}

// ------------------------------------------------------------- R5/R6 algorithms

/// Algorithm 2.A/2.B hash (R5 = plain SHA-256, R6 = iterated 2.B).
fn hash_r56(pw: &[u8], salt: &[u8], udata: &[u8], r: i64) -> Result<[u8; 32]> {
    let mut k: Vec<u8> = {
        let mut h = Sha256::new();
        h.update(pw);
        h.update(salt);
        h.update(udata);
        h.finalize().to_vec()
    };
    if r >= 6 {
        let mut round: usize = 0;
        loop {
            round += 1;
            let mut k1 = Vec::with_capacity((pw.len() + k.len() + udata.len()) * 64);
            for _ in 0..64 {
                k1.extend_from_slice(pw);
                k1.extend_from_slice(&k);
                k1.extend_from_slice(udata);
            }
            let (aes_key, iv) = (
                k.get(..16)
                    .ok_or_else(|| PdfError::Crypto("short hash".into()))?,
                k.get(16..32)
                    .ok_or_else(|| PdfError::Crypto("short hash".into()))?,
            );
            let e = aes_cbc_encrypt(aes_key, iv, &k1, false)?;
            let sum: u32 = e.iter().take(16).map(|b| u32::from(*b)).sum();
            k = match sum % 3 {
                0 => Sha256::digest(&e).to_vec(),
                1 => Sha384::digest(&e).to_vec(),
                _ => Sha512::digest(&e).to_vec(),
            };
            let last = usize::from(*e.last().unwrap_or(&0));
            // The loop terminates: after round 64 the bound (round - 32) grows past 255.
            if round >= 64 && last <= round - 32 {
                break;
            }
        }
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(
        k.get(..32)
            .ok_or_else(|| PdfError::Crypto("short hash".into()))?,
    );
    Ok(out)
}

fn get_bytes(d: &Dictionary, key: &[u8]) -> Vec<u8> {
    match d.get(key) {
        Ok(Object::String(s, _)) => s.clone(),
        _ => Vec::new(),
    }
}

fn get_int(d: &Dictionary, key: &[u8]) -> Option<i64> {
    d.get(key).ok().and_then(|o| o.as_i64().ok())
}

fn method_from_cfm(name: &[u8]) -> Result<CryptMethod> {
    match name {
        b"None" | b"Identity" => Ok(CryptMethod::Identity),
        b"V2" => Ok(CryptMethod::Rc4),
        b"AESV2" => Ok(CryptMethod::AesV2),
        b"AESV3" => Ok(CryptMethod::AesV3),
        other => Err(PdfError::UnsupportedEncryption(format!(
            "crypt filter method /{}",
            String::from_utf8_lossy(other)
        ))),
    }
}

impl SecurityHandler {
    /// Authenticate `password` against an encryption dictionary. Tries the owner password
    /// first, then the user password. `id0` is the first element of the trailer `/ID`.
    pub fn open(dict: &Dictionary, id0: &[u8], password: &str) -> Result<Self> {
        let filter = dict
            .get(b"Filter")
            .and_then(Object::as_name)
            .unwrap_or(b"Standard");
        if filter != b"Standard" {
            return Err(PdfError::UnsupportedEncryption(format!(
                "security handler /{} (only /Standard is supported; certificate encryption needs the recipient key)",
                String::from_utf8_lossy(filter)
            )));
        }
        let v = get_int(dict, b"V").unwrap_or(0);
        let r = get_int(dict, b"R").unwrap_or(2);
        let p = get_int(dict, b"P").unwrap_or(-1);
        // /P is a 32-bit field; some writers store it unsigned.
        let p = p as u32 as i32;
        let encrypt_metadata = dict
            .get(b"EncryptMetadata")
            .and_then(Object::as_bool)
            .unwrap_or(true);
        let o = get_bytes(dict, b"O");
        let u = get_bytes(dict, b"U");

        let mut named = Vec::new();
        let (stm, strf, eff, n) = match v {
            0 | 1 => (CryptMethod::Rc4, CryptMethod::Rc4, CryptMethod::Rc4, 5usize),
            2 | 3 => {
                let bits = get_int(dict, b"Length").unwrap_or(40);
                if !(40..=128).contains(&bits) || bits % 8 != 0 {
                    return Err(PdfError::UnsupportedEncryption(format!(
                        "RC4 key length {bits}"
                    )));
                }
                (
                    CryptMethod::Rc4,
                    CryptMethod::Rc4,
                    CryptMethod::Rc4,
                    (bits / 8) as usize,
                )
            }
            4 | 5 => {
                if let Ok(cf) = dict.get(b"CF").and_then(Object::as_dict) {
                    for (name, f) in cf.iter() {
                        if let Ok(fd) = f.as_dict() {
                            let cfm = fd.get(b"CFM").and_then(Object::as_name).unwrap_or(b"None");
                            named.push((name.clone(), method_from_cfm(cfm)?));
                        }
                    }
                }
                let lookup = |key: &[u8], default: CryptMethod| -> Result<CryptMethod> {
                    match dict.get(key).and_then(Object::as_name) {
                        Ok(b"Identity") => Ok(CryptMethod::Identity),
                        Ok(name) => named
                            .iter()
                            .find(|(k, _)| k.as_slice() == name)
                            .map(|(_, m)| *m)
                            .ok_or_else(|| {
                                PdfError::UnsupportedEncryption(format!(
                                    "undefined crypt filter /{}",
                                    String::from_utf8_lossy(name)
                                ))
                            }),
                        Err(_) => Ok(default),
                    }
                };
                let stm = lookup(b"StmF", CryptMethod::Identity)?;
                let strf = lookup(b"StrF", CryptMethod::Identity)?;
                let eff = lookup(b"EFF", stm)?;
                let n = if v == 5 {
                    32
                } else {
                    let bits = get_int(dict, b"Length").unwrap_or(128);
                    // /Length is in bits for V4 (some writers put bytes).
                    let bytes = if bits <= 16 { bits } else { bits / 8 };
                    (bytes.clamp(5, 16)) as usize
                };
                (stm, strf, eff, n)
            }
            other => {
                return Err(PdfError::UnsupportedEncryption(format!("/V {other}")));
            }
        };

        let mut handler = SecurityHandler {
            v,
            r,
            key: Vec::new(),
            stm,
            strf,
            eff,
            named,
            encrypt_metadata,
            permissions: Permissions(p),
            matched: PasswordKind::User,
            dict: dict.clone(),
        };

        let found = match r {
            2..=4 => {
                if !(2..=4).contains(&r) || (v >= 5) {
                    None
                } else {
                    let pw = legacy_password_bytes(password);
                    // Owner first.
                    let upw = user_from_o_r234(&pw, &o, r, n)?;
                    let k_owner = key_r234(&upw, &o, p, id0, r, n, encrypt_metadata);
                    if check_user_r234(&k_owner, &u, r, id0)? {
                        Some((k_owner, PasswordKind::Owner))
                    } else {
                        let k_user = key_r234(&pw, &o, p, id0, r, n, encrypt_metadata);
                        if check_user_r234(&k_user, &u, r, id0)? {
                            Some((k_user, PasswordKind::User))
                        } else {
                            None
                        }
                    }
                }
            }
            5 | 6 => {
                if o.len() < 48 || u.len() < 48 {
                    return Err(PdfError::UnsupportedEncryption(
                        "short /O or /U for R5/R6".into(),
                    ));
                }
                let pw = unicode_password_bytes(password);
                let oe = get_bytes(dict, b"OE");
                let ue = get_bytes(dict, b"UE");
                let u48 = u.get(..48).unwrap_or_default();
                let sl = |b: &[u8], a: usize, z: usize| b.get(a..z).unwrap_or_default().to_vec();
                let iv = [0u8; 16];
                if hash_r56(&pw, &sl(&o, 32, 40), u48, r)?.as_slice() == sl(&o, 0, 32).as_slice() {
                    let ik = hash_r56(&pw, &sl(&o, 40, 48), u48, r)?;
                    Some((aes_cbc_decrypt(&ik, &iv, &oe, false)?, PasswordKind::Owner))
                } else if hash_r56(&pw, &sl(&u, 32, 40), &[], r)?.as_slice()
                    == sl(&u, 0, 32).as_slice()
                {
                    let ik = hash_r56(&pw, &sl(&u, 40, 48), &[], r)?;
                    Some((aes_cbc_decrypt(&ik, &iv, &ue, false)?, PasswordKind::User))
                } else {
                    None
                }
            }
            other => return Err(PdfError::UnsupportedEncryption(format!("/R {other}"))),
        };
        match found {
            Some((key, kind)) => {
                if (r == 5 || r == 6) && key.len() != 32 {
                    return Err(PdfError::Crypto("file key is not 32 bytes".into()));
                }
                handler.key = key;
                handler.matched = kind;
                Ok(handler)
            }
            None if password.is_empty() => Err(PdfError::PasswordRequired),
            None => Err(PdfError::WrongPassword),
        }
    }

    /// Effective permissions: everything when the owner password matched.
    pub fn effective_permissions(&self) -> PermissionFlags {
        match self.matched {
            PasswordKind::Owner => PermissionFlags::all(),
            PasswordKind::User => self.permissions.flags(),
        }
    }

    /// Whether this handler uses the same file key as `other` (same protection).
    pub fn same_key(&self, other: &SecurityHandler) -> bool {
        self.key == other.key
    }

    /// Create a new AES-256 (V5/R6) handler with fresh random file key and salts.
    /// An empty owner password means "same as the user password" (like pypdf/qpdf).
    pub fn new_aes256(user: &str, owner: &str, perms: &PermissionFlags) -> Result<Self> {
        let owner = if owner.is_empty() { user } else { owner };
        let key: [u8; 32] = random_bytes()?;
        let upw = unicode_password_bytes(user);
        let opw = unicode_password_bytes(owner);
        let r = 6;
        let iv = [0u8; 16];
        let uvs: [u8; 8] = random_bytes()?;
        let uks: [u8; 8] = random_bytes()?;
        let mut u = hash_r56(&upw, &uvs, &[], r)?.to_vec();
        u.extend_from_slice(&uvs);
        u.extend_from_slice(&uks);
        let ue = aes_cbc_encrypt(&hash_r56(&upw, &uks, &[], r)?, &iv, &key, false)?;
        let ovs: [u8; 8] = random_bytes()?;
        let oks: [u8; 8] = random_bytes()?;
        let mut o = hash_r56(&opw, &ovs, &u, r)?.to_vec();
        o.extend_from_slice(&ovs);
        o.extend_from_slice(&oks);
        let oe = aes_cbc_encrypt(&hash_r56(&opw, &oks, &u, r)?, &iv, &key, false)?;
        let p = Permissions::from_flags(perms);
        let mut block = [0u8; 16];
        block[..4].copy_from_slice(&(p.0 as u32).to_le_bytes());
        block[4..8].copy_from_slice(&[0xFF; 4]);
        block[8] = b'T';
        block[9..12].copy_from_slice(b"adb");
        let tail: [u8; 4] = random_bytes()?;
        block[12..16].copy_from_slice(&tail);
        // One-block CBC with a zero IV is ECB.
        let perms_enc = aes_cbc_encrypt(&key, &iv, &block, false)?;

        let mut std_cf = Dictionary::new();
        std_cf.set("AuthEvent", Object::Name(b"DocOpen".to_vec()));
        std_cf.set("CFM", Object::Name(b"AESV3".to_vec()));
        std_cf.set("Length", Object::Integer(32));
        let mut cf = Dictionary::new();
        cf.set("StdCF", Object::Dictionary(std_cf));
        let hex = |b: Vec<u8>| Object::String(b, StringFormat::Hexadecimal);
        let mut dict = Dictionary::new();
        dict.set("Filter", Object::Name(b"Standard".to_vec()));
        dict.set("V", Object::Integer(5));
        dict.set("R", Object::Integer(6));
        dict.set("Length", Object::Integer(256));
        dict.set("CF", Object::Dictionary(cf));
        dict.set("StmF", Object::Name(b"StdCF".to_vec()));
        dict.set("StrF", Object::Name(b"StdCF".to_vec()));
        dict.set("O", hex(o));
        dict.set("U", hex(u));
        dict.set("OE", hex(oe));
        dict.set("UE", hex(ue));
        dict.set("P", Object::Integer(i64::from(p.0)));
        dict.set("Perms", hex(perms_enc));
        dict.set("EncryptMetadata", Object::Boolean(true));
        Ok(SecurityHandler {
            v: 5,
            r,
            key: key.to_vec(),
            stm: CryptMethod::AesV3,
            strf: CryptMethod::AesV3,
            eff: CryptMethod::AesV3,
            named: vec![(b"StdCF".to_vec(), CryptMethod::AesV3)],
            encrypt_metadata: true,
            permissions: p,
            matched: PasswordKind::Owner,
            dict,
        })
    }

    /// Create a legacy (R2–R4) handler. Only used to produce interoperability fixtures and
    /// tests: new protection written by ZOOD PDF is always AES-256 R6. `method` selects the
    /// R4 crypt filter (`Rc4` or `AesV2`) and is ignored for R2/R3.
    pub fn new_legacy(
        r: i64,
        key_bits: usize,
        method: CryptMethod,
        user: &str,
        owner: &str,
        perms: &PermissionFlags,
        id0: &[u8],
    ) -> Result<Self> {
        let owner = if owner.is_empty() { user } else { owner };
        let n = match r {
            2 => 5,
            3 | 4 => key_bits / 8,
            _ => {
                return Err(PdfError::InvalidArgument(
                    "legacy revision must be 2, 3 or 4".into(),
                ))
            }
        };
        if !(5..=16).contains(&n) {
            return Err(PdfError::InvalidArgument(
                "key length must be 40–128 bits".into(),
            ));
        }
        let upw = legacy_password_bytes(user);
        let opw = legacy_password_bytes(owner);
        let p = Permissions::from_flags(perms);
        let o = o_r234(&opw, &upw, r, n)?;
        let key = key_r234(&upw, &o, p.0, id0, r, n, true);
        let u = u_r234(&key, r, id0)?;
        let hex = |b: Vec<u8>| Object::String(b, StringFormat::Hexadecimal);
        let mut dict = Dictionary::new();
        dict.set("Filter", Object::Name(b"Standard".to_vec()));
        let (v, m) = match r {
            2 => (1, CryptMethod::Rc4),
            3 => (2, CryptMethod::Rc4),
            _ => (4, method),
        };
        dict.set("V", Object::Integer(v));
        dict.set("R", Object::Integer(r));
        dict.set("Length", Object::Integer((n * 8) as i64));
        let mut named = Vec::new();
        if r == 4 {
            let cfm: &[u8] = match method {
                CryptMethod::AesV2 => b"AESV2",
                CryptMethod::Rc4 => b"V2",
                _ => {
                    return Err(PdfError::InvalidArgument(
                        "R4 method must be RC4 or AESV2".into(),
                    ))
                }
            };
            let mut std_cf = Dictionary::new();
            std_cf.set("AuthEvent", Object::Name(b"DocOpen".to_vec()));
            std_cf.set("CFM", Object::Name(cfm.to_vec()));
            std_cf.set("Length", Object::Integer(16));
            let mut cf = Dictionary::new();
            cf.set("StdCF", Object::Dictionary(std_cf));
            dict.set("CF", Object::Dictionary(cf));
            dict.set("StmF", Object::Name(b"StdCF".to_vec()));
            dict.set("StrF", Object::Name(b"StdCF".to_vec()));
            named.push((b"StdCF".to_vec(), method));
        }
        dict.set("O", hex(o));
        dict.set("U", hex(u));
        dict.set("P", Object::Integer(i64::from(p.0)));
        Ok(SecurityHandler {
            v,
            r,
            key,
            stm: m,
            strf: m,
            eff: m,
            named,
            encrypt_metadata: true,
            permissions: p,
            matched: PasswordKind::Owner,
            dict,
        })
    }

    fn object_key(&self, id: ObjectId, method: CryptMethod) -> Vec<u8> {
        if method == CryptMethod::AesV3 {
            return self.key.clone();
        }
        let n = id.0.to_le_bytes();
        let g = id.1.to_le_bytes();
        let salt: &[u8] = if method == CryptMethod::AesV2 {
            b"sAlT"
        } else {
            b""
        };
        let d = md5(&[&self.key, n.get(..3).unwrap_or(&n), &g, salt]);
        let len = (self.key.len() + 5).min(16);
        d.get(..len).unwrap_or(&d).to_vec()
    }

    /// Decrypt `data` belonging to object `id` with `method`.
    pub fn decrypt_bytes(&self, id: ObjectId, method: CryptMethod, data: &[u8]) -> Result<Vec<u8>> {
        match method {
            CryptMethod::Identity => Ok(data.to_vec()),
            CryptMethod::Rc4 => rc4(&self.object_key(id, method), data),
            CryptMethod::AesV2 | CryptMethod::AesV3 => {
                let (Some(iv), Some(body)) = (data.get(..16), data.get(16..)) else {
                    return Ok(Vec::new());
                };
                aes_cbc_decrypt(&self.object_key(id, method), iv, body, true)
            }
        }
    }

    /// Encrypt `data` belonging to object `id` with `method` (fresh random IV for AES).
    pub fn encrypt_bytes(&self, id: ObjectId, method: CryptMethod, data: &[u8]) -> Result<Vec<u8>> {
        match method {
            CryptMethod::Identity => Ok(data.to_vec()),
            CryptMethod::Rc4 => rc4(&self.object_key(id, method), data),
            CryptMethod::AesV2 | CryptMethod::AesV3 => {
                let iv: [u8; 16] = random_bytes()?;
                let mut out = iv.to_vec();
                out.extend(aes_cbc_encrypt(
                    &self.object_key(id, method),
                    &iv,
                    data,
                    true,
                )?);
                Ok(out)
            }
        }
    }

    /// The method that applies to a stream with dictionary `dict`.
    pub fn stream_method(&self, dict: &Dictionary) -> CryptMethod {
        let ty = dict.get(b"Type").and_then(Object::as_name).unwrap_or(b"");
        if ty == b"XRef" {
            return CryptMethod::Identity;
        }
        if ty == b"Metadata" && !self.encrypt_metadata {
            return CryptMethod::Identity;
        }
        // Per-stream /Crypt filter (must be first in the filter chain).
        let first_filter = match dict.get(b"Filter") {
            Ok(Object::Name(n)) => Some(n.as_slice()),
            Ok(Object::Array(a)) => a.first().and_then(|o| o.as_name().ok()),
            _ => None,
        };
        if first_filter == Some(b"Crypt".as_slice()) {
            let parms = match dict.get(b"DecodeParms") {
                Ok(Object::Dictionary(d)) => Some(d),
                Ok(Object::Array(a)) => a.first().and_then(|o| o.as_dict().ok()),
                _ => None,
            };
            let name = parms
                .and_then(|p| p.get(b"Name").and_then(Object::as_name).ok())
                .unwrap_or(b"Identity");
            if name == b"Identity" {
                return CryptMethod::Identity;
            }
            return self
                .named
                .iter()
                .find(|(k, _)| k.as_slice() == name)
                .map(|(_, m)| *m)
                .unwrap_or(self.stm);
        }
        if ty == b"EmbeddedFile" {
            return self.eff;
        }
        self.stm
    }

    /// Decrypt every string and stream in `obj` (object `id`) in place.
    pub fn decrypt_object(&self, id: ObjectId, obj: &mut Object, limits: &Limits) -> Result<()> {
        self.transform(id, obj, limits, 0, false)
    }

    /// Encrypt every string and stream in `obj` (object `id`) in place.
    pub fn encrypt_object(&self, id: ObjectId, obj: &mut Object, limits: &Limits) -> Result<()> {
        self.transform(id, obj, limits, 0, true)
    }

    fn apply(&self, id: ObjectId, method: CryptMethod, data: &[u8], enc: bool) -> Result<Vec<u8>> {
        if enc {
            self.encrypt_bytes(id, method, data)
        } else {
            self.decrypt_bytes(id, method, data)
        }
    }

    fn transform_dict(
        &self,
        id: ObjectId,
        d: &mut Dictionary,
        limits: &Limits,
        depth: usize,
        enc: bool,
    ) -> Result<()> {
        // Signature /Contents are never encrypted (ISO 32000-2 §7.6.2).
        let is_sig = matches!(
            d.get(b"Type").and_then(Object::as_name),
            Ok(b"Sig") | Ok(b"DocTimeStamp")
        );
        for (k, v) in d.iter_mut() {
            if is_sig && k.as_slice() == b"Contents" {
                continue;
            }
            self.transform(id, v, limits, depth + 1, enc)?;
        }
        Ok(())
    }

    fn transform(
        &self,
        id: ObjectId,
        obj: &mut Object,
        limits: &Limits,
        depth: usize,
        enc: bool,
    ) -> Result<()> {
        limits.check_depth(depth)?;
        match obj {
            Object::String(s, _) => {
                *s = self.apply(id, self.strf, s, enc)?;
            }
            Object::Array(a) => {
                for o in a.iter_mut() {
                    self.transform(id, o, limits, depth + 1, enc)?;
                }
            }
            Object::Dictionary(d) => self.transform_dict(id, d, limits, depth, enc)?,
            Object::Stream(s) => {
                let method = self.stream_method(&s.dict);
                if method != CryptMethod::Identity {
                    let content = self.apply(id, method, &s.content, enc)?;
                    s.set_content(content);
                }
                self.transform_dict(id, &mut s.dict, limits, depth, enc)?;
            }
            _ => {}
        }
        Ok(())
    }
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
mod tests {
    use super::*;

    const ID0: &[u8] = b"0123456789abcdef";

    fn roundtrip(h: &SecurityHandler) {
        let id = (7, 0);
        for m in [h.stm, h.strf] {
            let ct = h.encrypt_bytes(id, m, b"hello world, marhaba").unwrap();
            assert_ne!(ct, b"hello world, marhaba");
            assert_eq!(
                h.decrypt_bytes(id, m, &ct).unwrap(),
                b"hello world, marhaba"
            );
        }
    }

    #[test]
    fn pad_password_fills_with_pad() {
        assert_eq!(pad_password(b""), PAD);
        let p = pad_password(b"ab");
        assert_eq!(&p[..2], b"ab");
        assert_eq!(&p[2..], &PAD[..30]);
    }

    #[test]
    fn legacy_revisions_authenticate_user_and_owner() {
        let perms = PermissionFlags {
            print: true,
            ..Default::default()
        };
        for (r, bits, m) in [
            (2, 40, CryptMethod::Rc4),
            (3, 128, CryptMethod::Rc4),
            (3, 40, CryptMethod::Rc4),
            (4, 128, CryptMethod::Rc4),
            (4, 128, CryptMethod::AesV2),
        ] {
            let h = SecurityHandler::new_legacy(r, bits, m, "user", "owner", &perms, ID0).unwrap();
            let u = SecurityHandler::open(&h.dict, ID0, "user").unwrap();
            assert_eq!(u.matched, PasswordKind::User, "r{r}");
            assert!(u.same_key(&h));
            assert!(!u.effective_permissions().modify);
            assert!(u.effective_permissions().print);
            let o = SecurityHandler::open(&h.dict, ID0, "owner").unwrap();
            assert_eq!(o.matched, PasswordKind::Owner, "r{r}");
            assert!(o.same_key(&h));
            assert!(o.effective_permissions().modify);
            assert!(matches!(
                SecurityHandler::open(&h.dict, ID0, "nope"),
                Err(PdfError::WrongPassword)
            ));
            assert!(matches!(
                SecurityHandler::open(&h.dict, ID0, ""),
                Err(PdfError::PasswordRequired)
            ));
            roundtrip(&u);
        }
    }

    #[test]
    fn r6_authenticates_user_and_owner_with_arabic_password() {
        let h = SecurityHandler::new_aes256("كلمة", "مالك", &PermissionFlags::default()).unwrap();
        let u = SecurityHandler::open(&h.dict, b"", "كلمة").unwrap();
        assert_eq!(u.matched, PasswordKind::User);
        assert!(u.same_key(&h));
        let o = SecurityHandler::open(&h.dict, b"whatever", "مالك").unwrap();
        assert_eq!(o.matched, PasswordKind::Owner);
        assert!(matches!(
            SecurityHandler::open(&h.dict, b"", "x"),
            Err(PdfError::WrongPassword)
        ));
        roundtrip(&u);
    }

    #[test]
    fn empty_user_password_opens_without_prompt() {
        let h = SecurityHandler::new_aes256("", "owner", &PermissionFlags::default()).unwrap();
        let u = SecurityHandler::open(&h.dict, b"", "").unwrap();
        assert_eq!(u.matched, PasswordKind::User);
    }

    #[test]
    fn permissions_round_trip_and_reserved_bits() {
        let f = PermissionFlags {
            print: true,
            copy: true,
            assemble: true,
            ..Default::default()
        };
        let p = Permissions::from_flags(&f);
        assert_eq!(p.flags(), f);
        assert!(p.0 < 0, "bits 13-32 must be set");
        assert_eq!((p.0 as u32) & 0b11, 0);
    }

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    #[test]
    fn r5_r6_hash_known_answers_from_pypdf() {
        // Expected values from pypdf's AlgV5.calculate_hash (independent implementation).
        assert_eq!(
            hex(&hash_r56(b"test", b"12345678", b"", 6).unwrap()),
            "045b0db69e5d899a60b40c7fd6514f1ff51d85eed5768bbd4319a17b8342671d"
        );
        let udata: Vec<u8> = (0u8..48).collect();
        assert_eq!(
            hex(&hash_r56(b"test", b"12345678", &udata, 6).unwrap()),
            "f2982ac4456821cd2bb2da332ea9aa6ee8aa389ac39e54532aa3178f178a7061"
        );
        assert_eq!(
            hex(&hash_r56(b"test", b"12345678", b"", 5).unwrap()),
            "f5fbc6fe84c365315f491d4275c2f2e5d3c60f25684e1d62e7e9fe63abf8d0d8"
        );
    }

    #[test]
    fn encrypt_metadata_false_and_crypt_filter_identity() {
        let mut h = SecurityHandler::new_aes256("", "o", &PermissionFlags::default()).unwrap();
        h.encrypt_metadata = false;
        let mut md = Dictionary::new();
        md.set("Type", Object::Name(b"Metadata".to_vec()));
        assert_eq!(h.stream_method(&md), CryptMethod::Identity);
        let mut cr = Dictionary::new();
        cr.set(
            "Filter",
            Object::Array(vec![Object::Name(b"Crypt".to_vec())]),
        );
        assert_eq!(h.stream_method(&cr), CryptMethod::Identity);
        let mut x = Dictionary::new();
        x.set("Type", Object::Name(b"XRef".to_vec()));
        assert_eq!(h.stream_method(&x), CryptMethod::Identity);
        assert_eq!(h.stream_method(&Dictionary::new()), CryptMethod::AesV3);
    }

    #[test]
    fn sig_contents_not_encrypted() {
        let h = SecurityHandler::new_aes256("", "o", &PermissionFlags::default()).unwrap();
        let mut d = Dictionary::new();
        d.set("Type", Object::Name(b"Sig".to_vec()));
        d.set(
            "Contents",
            Object::String(b"cms".to_vec(), StringFormat::Hexadecimal),
        );
        d.set("Name", Object::String(b"n".to_vec(), StringFormat::Literal));
        let mut o = Object::Dictionary(d);
        h.encrypt_object((3, 0), &mut o, &Limits::default())
            .unwrap();
        let d = o.as_dict().unwrap();
        assert_eq!(d.get(b"Contents").unwrap().as_str().unwrap(), b"cms");
        assert_ne!(d.get(b"Name").unwrap().as_str().unwrap(), b"n");
    }
}
