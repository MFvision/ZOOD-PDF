//! PKCS#12 (.p12/.pfx) loader: password-integrity files with
//! * modern encryption: PBES2 (PBKDF2-HMAC-SHA1/SHA-256/384/512 + AES-128/192/256-CBC or
//!   3DES/DES-CBC) through the `pkcs5` crate;
//! * legacy encryption: pbeWithSHAAnd3-KeyTripleDES-CBC, pbeWithSHAAnd2-KeyTripleDES-CBC,
//!   pbeWithSHAAnd128BitRC2-CBC and pbeWithSHAAnd40BitRC2-CBC, implemented here with the
//!   RFC 7292 appendix B key derivation (`pkcs12::kdf`), `des` and `rc2`;
//! * MAC: HMAC-SHA1/SHA-256/384/512 with the PKCS#12 KDF (ID 3).
//!
//! BER input (Windows exports) is normalised to DER first. Iteration counts are bounded.
//! Decrypted buffers live in `Zeroizing` containers; the key ends in a `SoftKey` whose
//! underlying types zeroize on drop.

use crate::error::{Result, SignError};
use crate::keys::SoftKey;
use crate::limits::{MAX_CERTS, MAX_KDF_ITERATIONS, MAX_P12_SIZE};
use crate::oids;
use crate::tlv;
use crate::x509::Cert;
use cbc::cipher::{block_padding::Pkcs7, BlockDecryptMut, InnerIvInit, KeyInit, KeyIvInit};
use der::asn1::{BmpString, OctetString};
use der::{Decode, Encode};
use digest::Mac;
use pkcs12::kdf::{derive_key, Pkcs12KeyType};
use spki::AlgorithmIdentifierOwned;
use zeroize::Zeroizing;

/// Contents of a PKCS#12 file.
pub struct Pkcs12 {
    /// The private key.
    pub key: SoftKey,
    /// The certificate matching the key.
    pub cert: Cert,
    /// Every other certificate in the file (chain), in file order.
    pub chain: Vec<Cert>,
}

impl std::fmt::Debug for Pkcs12 {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Pkcs12")
            .field("cert", &self.cert.display_name())
            .field("chain", &self.chain.len())
            .finish_non_exhaustive()
    }
}

/// The candidate password encodings for the PKCS#12 KDF: BMPString + two zero bytes, and for
/// the empty password also "no bytes at all" (some producers write that).
fn kdf_passwords(password: &str) -> Result<Vec<Zeroizing<Vec<u8>>>> {
    let bmp = BmpString::from_utf8(password).map_err(|_| {
        SignError::InvalidArgument("password has characters outside the BMP".into())
    })?;
    let mut p = Zeroizing::new(bmp.into_bytes().to_vec());
    p.extend_from_slice(&[0, 0]);
    let mut out = vec![p];
    if password.is_empty() {
        out.push(Zeroizing::new(Vec::new()));
    }
    Ok(out)
}

fn check_iterations(n: i64) -> Result<u32> {
    let n = u32::try_from(n).map_err(|_| SignError::Malformed("iteration count".into()))?;
    if n == 0 || n > MAX_KDF_ITERATIONS {
        return Err(SignError::Limit(format!(
            "key derivation iteration count {n} (the maximum is {MAX_KDF_ITERATIONS})"
        )));
    }
    Ok(n)
}

fn kdf(
    hash: crate::hash::HashAlg,
    pass: &[u8],
    salt: &[u8],
    id: Pkcs12KeyType,
    rounds: u32,
    len: usize,
) -> Result<Zeroizing<Vec<u8>>> {
    let r = i32::try_from(rounds).map_err(|_| SignError::Limit("iterations".into()))?;
    use crate::hash::HashAlg;
    Ok(Zeroizing::new(match hash {
        HashAlg::Sha1 => derive_key::<sha1::Sha1>(pass, salt, id, r, len),
        HashAlg::Sha256 => derive_key::<sha2::Sha256>(pass, salt, id, r, len),
        HashAlg::Sha384 => derive_key::<sha2::Sha384>(pass, salt, id, r, len),
        HashAlg::Sha512 => derive_key::<sha2::Sha512>(pass, salt, id, r, len),
    }))
}

fn hmac_ok(hash: crate::hash::HashAlg, key: &[u8], data: &[u8], expected: &[u8]) -> bool {
    use crate::hash::HashAlg;
    fn run<M: Mac + KeyInit>(key: &[u8], data: &[u8], expected: &[u8]) -> bool {
        match <M as KeyInit>::new_from_slice(key) {
            Ok(mut m) => {
                m.update(data);
                m.verify_slice(expected).is_ok()
            }
            Err(_) => false,
        }
    }
    match hash {
        HashAlg::Sha1 => run::<hmac::Hmac<sha1::Sha1>>(key, data, expected),
        HashAlg::Sha256 => run::<hmac::Hmac<sha2::Sha256>>(key, data, expected),
        HashAlg::Sha384 => run::<hmac::Hmac<sha2::Sha384>>(key, data, expected),
        HashAlg::Sha512 => run::<hmac::Hmac<sha2::Sha512>>(key, data, expected),
    }
}

/// Decrypt with a PKCS#12 PBE (appendix B / C of RFC 7292).
fn decrypt_pkcs12_pbe(
    alg: &AlgorithmIdentifierOwned,
    data: &[u8],
    passes: &[Zeroizing<Vec<u8>>],
) -> Result<Zeroizing<Vec<u8>>> {
    let params = alg
        .parameters
        .as_ref()
        .ok_or_else(|| SignError::Malformed("PBE parameters".into()))?
        .decode_as::<pkcs12::pbe_params::Pkcs12PbeParams>()
        .map_err(|e| SignError::der("PBE parameters", e))?;
    let rounds = check_iterations(i64::from(params.iterations))?;
    let salt = params.salt.as_bytes();
    let sha1 = crate::hash::HashAlg::Sha1;
    for pass in passes {
        let iv = kdf(sha1, pass, salt, Pkcs12KeyType::Iv, rounds, 8)?;
        let out: Option<Vec<u8>> = match alg.oid {
            o if o == oids::PBE_SHA1_3DES => {
                let key = kdf(sha1, pass, salt, Pkcs12KeyType::EncryptionKey, rounds, 24)?;
                cbc::Decryptor::<des::TdesEde3>::new_from_slices(&key, &iv)
                    .ok()
                    .and_then(|d| d.decrypt_padded_vec_mut::<Pkcs7>(data).ok())
            }
            o if o == oids::PBE_SHA1_2DES => {
                let key = kdf(sha1, pass, salt, Pkcs12KeyType::EncryptionKey, rounds, 16)?;
                cbc::Decryptor::<des::TdesEde2>::new_from_slices(&key, &iv)
                    .ok()
                    .and_then(|d| d.decrypt_padded_vec_mut::<Pkcs7>(data).ok())
            }
            o if o == oids::PBE_SHA1_RC2_128 || o == oids::PBE_SHA1_RC2_40 => {
                let (klen, bits) = if o == oids::PBE_SHA1_RC2_40 {
                    (5, 40)
                } else {
                    (16, 128)
                };
                let key = kdf(sha1, pass, salt, Pkcs12KeyType::EncryptionKey, rounds, klen)?;
                let cipher = rc2::Rc2::new_with_eff_key_len(&key, bits);
                cbc::Decryptor::<rc2::Rc2>::inner_iv_slice_init(cipher, &iv)
                    .ok()
                    .and_then(|d| d.decrypt_padded_vec_mut::<Pkcs7>(data).ok())
            }
            o => return Err(SignError::Unsupported(format!("PKCS#12 encryption {o}"))),
        };
        if let Some(plain) = out {
            // Padding can verify by chance with a wrong key; the DER parse that follows
            // decides (and the MAC normally already rejected a wrong password).
            if tlv::read(&plain).is_ok() {
                return Ok(Zeroizing::new(plain));
            }
        }
    }
    Err(SignError::WrongPassword)
}

/// Decrypt with PBES2 (UTF-8 password bytes, as OpenSSL and Windows write them).
fn decrypt_pbes2(
    alg: &AlgorithmIdentifierOwned,
    data: &[u8],
    password: &str,
) -> Result<Zeroizing<Vec<u8>>> {
    let alg_der = alg.to_der().map_err(|e| SignError::der("PBES2", e))?;
    let scheme = pkcs5::EncryptionScheme::from_der(&alg_der)
        .map_err(|e| SignError::Unsupported(format!("PBES2 parameters: {e}")))?;
    if let pkcs5::EncryptionScheme::Pbes2(p) = &scheme {
        let n = match &p.kdf {
            pkcs5::pbes2::Kdf::Pbkdf2(k) => k.iteration_count,
            _ => {
                return Err(SignError::Unsupported(
                    "key derivation (only PBKDF2)".into(),
                ))
            }
        };
        check_iterations(i64::from(n))?;
    }
    let plain = scheme
        .decrypt(password.as_bytes(), data)
        .map_err(|_| SignError::WrongPassword)?;
    if tlv::read(&plain).is_err() {
        return Err(SignError::WrongPassword);
    }
    Ok(Zeroizing::new(plain))
}

fn decrypt(
    alg: &AlgorithmIdentifierOwned,
    data: &[u8],
    password: &str,
    passes: &[Zeroizing<Vec<u8>>],
) -> Result<Zeroizing<Vec<u8>>> {
    if alg.oid == oids::PBES2 {
        decrypt_pbes2(alg, data, password)
    } else {
        decrypt_pkcs12_pbe(alg, data, passes)
    }
}

/// Decode DER, falling back to BER normalisation.
fn der_or_ber(bytes: &[u8]) -> Result<Vec<u8>> {
    let len = tlv::element_len(bytes)?;
    let head = bytes.get(..len).unwrap_or(bytes);
    if tlv::read(head).is_ok() {
        Ok(head.to_vec())
    } else {
        tlv::ber_to_der(head)
    }
}

#[derive(der::Sequence)]
struct EncryptedContentInfo {
    content_type: der::asn1::ObjectIdentifier,
    content_encryption_algorithm: AlgorithmIdentifierOwned,
    #[asn1(context_specific = "0", tag_mode = "IMPLICIT", optional = "true")]
    encrypted_content: Option<OctetString>,
}

#[derive(der::Sequence)]
struct EncryptedData {
    version: u8,
    encrypted_content_info: EncryptedContentInfo,
}

#[derive(der::Sequence)]
struct EncryptedPrivateKeyInfo {
    encryption_algorithm: AlgorithmIdentifierOwned,
    encrypted_data: OctetString,
}

struct Collected {
    keys: Vec<Zeroizing<Vec<u8>>>,
    certs: Vec<Cert>,
}

fn walk_bags(
    safe_contents: &[u8],
    password: &str,
    passes: &[Zeroizing<Vec<u8>>],
    depth: usize,
    acc: &mut Collected,
) -> Result<()> {
    if depth > 4 {
        return Err(SignError::Limit("nested safe contents".into()));
    }
    let bags = Vec::<pkcs12::safe_bag::SafeBag>::from_der(safe_contents)
        .map_err(|e| SignError::der("PKCS#12 safe contents", e))?;
    for bag in bags {
        // pkcs12 0.1 hands back the explicit `[0]` wrapper itself: unwrap it.
        let value = match tlv::read(&bag.bag_value) {
            Ok((t, _)) if t.tag == 0xA0 => t.content,
            _ => bag.bag_value.as_slice(),
        };
        match bag.bag_id {
            o if o == oids::CERT_BAG => {
                let cb = pkcs12::cert_type::CertBag::from_der(value)
                    .map_err(|e| SignError::der("certificate bag", e))?;
                if cb.cert_id == oids::X509_CERTIFICATE {
                    acc.certs.push(Cert::from_der(cb.cert_value.as_bytes())?);
                    if acc.certs.len() > MAX_CERTS {
                        return Err(SignError::Limit("too many certificates".into()));
                    }
                }
            }
            o if o == oids::SHROUDED_KEY_BAG => {
                let epki = EncryptedPrivateKeyInfo::from_der(value)
                    .map_err(|e| SignError::der("encrypted private key", e))?;
                let plain = decrypt(
                    &epki.encryption_algorithm,
                    epki.encrypted_data.as_bytes(),
                    password,
                    passes,
                )?;
                acc.keys.push(plain);
            }
            o if o == oids::KEY_BAG => acc.keys.push(Zeroizing::new(value.to_vec())),
            o if o == oids::SAFE_CONTENTS_BAG => {
                walk_bags(value, password, passes, depth + 1, acc)?;
            }
            _ => {} // CRL, secret bags: ignored.
        }
    }
    Ok(())
}

/// Load a PKCS#12 file with `password`.
pub fn load(bytes: &[u8], password: &str) -> Result<Pkcs12> {
    if bytes.len() > MAX_P12_SIZE {
        return Err(SignError::Limit("certificate file too large".into()));
    }
    let der_bytes = Zeroizing::new(der_or_ber(bytes)?);
    let pfx =
        pkcs12::pfx::Pfx::from_der(&der_bytes).map_err(|e| SignError::der("PKCS#12 file", e))?;
    if pfx.auth_safe.content_type != oids::DATA {
        return Err(SignError::Unsupported(
            "public-key integrity mode PKCS#12 (only password integrity is supported)".into(),
        ));
    }
    let data = pfx
        .auth_safe
        .content
        .decode_as::<OctetString>()
        .map_err(|e| SignError::der("PKCS#12 auth safe", e))?;
    let data = data.as_bytes();
    let passes = kdf_passwords(password)?;
    let mut mac_pass: Option<&Zeroizing<Vec<u8>>> = None;
    if let Some(mac) = &pfx.mac_data {
        if mac.mac.algorithm.oid == oids::PBMAC1 {
            return Err(SignError::Unsupported("PBMAC1 integrity (RFC 9579)".into()));
        }
        let hash = crate::hash::HashAlg::from_oid(&mac.mac.algorithm.oid)?;
        let rounds = check_iterations(i64::from(mac.iterations))?;
        for p in &passes {
            let key = kdf(
                hash,
                p,
                mac.mac_salt.as_bytes(),
                Pkcs12KeyType::Mac,
                rounds,
                hash.len(),
            )?;
            if hmac_ok(hash, &key, data, mac.mac.digest.as_bytes()) {
                mac_pass = Some(p);
                break;
            }
        }
        if mac_pass.is_none() {
            return Err(SignError::WrongPassword);
        }
    }
    // Once the MAC identified the password encoding, only that one is tried for PBEs.
    let passes: Vec<Zeroizing<Vec<u8>>> = match mac_pass {
        Some(p) => vec![p.clone()],
        None => passes,
    };
    let items = Vec::<cms::content_info::ContentInfo>::from_der(data)
        .map_err(|e| SignError::der("PKCS#12 authenticated safe", e))?;
    let mut acc = Collected {
        keys: Vec::new(),
        certs: Vec::new(),
    };
    for ci in items {
        if ci.content_type == oids::DATA {
            let os = ci
                .content
                .decode_as::<OctetString>()
                .map_err(|e| SignError::der("PKCS#12 data", e))?;
            walk_bags(os.as_bytes(), password, &passes, 0, &mut acc)?;
        } else if ci.content_type == oids::ENCRYPTED_DATA {
            let ed_der = ci
                .content
                .to_der()
                .map_err(|e| SignError::der("encrypted data", e))?;
            let ed = EncryptedData::from_der(&ed_der)
                .map_err(|e| SignError::der("encrypted data", e))?;
            let _ = ed.version;
            let eci = ed.encrypted_content_info;
            let _ = eci.content_type;
            let Some(ct) = eci.encrypted_content else {
                continue;
            };
            let plain = decrypt(
                &eci.content_encryption_algorithm,
                ct.as_bytes(),
                password,
                &passes,
            )?;
            walk_bags(&plain, password, &passes, 0, &mut acc)?;
        } else {
            return Err(SignError::Unsupported(format!(
                "PKCS#12 content type {}",
                ci.content_type
            )));
        }
    }
    let key_der = acc
        .keys
        .into_iter()
        .next()
        .ok_or_else(|| SignError::Malformed("the file has no private key".into()))?;
    let key = SoftKey::from_pkcs8(&key_der)?;
    let pub_der = key.public_key_der()?;
    let idx = acc
        .certs
        .iter()
        .position(|c| c.spki_der().ok().as_deref() == Some(pub_der.as_slice()))
        .ok_or_else(|| SignError::Malformed("no certificate matches the private key".into()))?;
    let cert = acc.certs.remove(idx);
    Ok(Pkcs12 {
        key,
        cert,
        chain: acc.certs,
    })
}
