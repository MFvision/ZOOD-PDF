//! Certificate files: PKCS#12 (RFC 7292), the `.p12` / `.pfx` a CA or an
//! operating system exports a signing identity as.
//!
//! Both generations are read: the modern one (PBES2 with PBKDF2 and AES,
//! SHA-256 MAC — OpenSSL 3, Windows 10+, recent macOS) and the legacy one
//! still everywhere (keys under 3DES, certificates under 40-bit RC2, SHA-1
//! MAC — OpenSSL 1.x, LibreSSL, older Windows and Keychain exports). The
//! legacy ciphers are only ever used to *read* a file the person chose.
//!
//! The file is hostile input like any other: every length is checked, and
//! iteration counts are capped so a crafted file cannot make the password
//! check run for hours.
use cipher::{block_padding::Pkcs7, BlockDecryptMut, InnerIvInit, KeyIvInit};
use der::{Decode, Encode};
use hmac::{Mac, SimpleHmac};
use sha1::Sha1;
use sha2::{Sha256, Sha384, Sha512};

use crate::asn1::{children, read, Tlv};
use crate::keys::{PrivateKey, SoftwareSigner};
use crate::{oids, HashAlg, Result, SignError};

/// Above this a file is refused rather than tried: OpenSSL writes 2048,
/// current guidance 600 000 at most.
const MAX_ITERATIONS: u64 = 2_000_000;

/// What a certificate file holds for signing.
pub struct Identity {
    pub signer: SoftwareSigner,
    /// The name the file gives the key, if any.
    pub friendly_name: Option<String>,
}

fn bad(what: impl std::fmt::Display) -> SignError {
    SignError::P12(format!("not a usable certificate file: {what}"))
}

fn oid_of(tlv: &Tlv) -> Result<const_oid::ObjectIdentifier> {
    const_oid::ObjectIdentifier::from_der(tlv.raw).map_err(bad)
}

/// The children of a TLV that must be `tag`.
fn inside<'a>(tlv: &Tlv<'a>, tag: u8, what: &str) -> Result<Vec<Tlv<'a>>> {
    if tlv.tag != tag {
        return Err(bad(format!("{what}: tag {:#x}", tlv.tag)));
    }
    children(tlv.value)
}

fn integer(tlv: &Tlv) -> Result<u64> {
    if tlv.tag != 0x02 || tlv.value.len() > 8 || tlv.value.first().is_some_and(|b| b & 0x80 != 0) {
        return Err(bad("integer"));
    }
    Ok(tlv.value.iter().fold(0u64, |n, b| (n << 8) | *b as u64))
}

fn octets<'a>(tlv: &Tlv<'a>) -> Result<&'a [u8]> {
    if tlv.tag != 0x04 {
        return Err(bad(format!(
            "expected an OCTET STRING, found tag {:#x}",
            tlv.tag
        )));
    }
    Ok(tlv.value)
}

/// The password as the PKCS#12 key derivation takes it: UTF-16BE with a
/// terminating zero (a `BMPString`).
fn bmp_password(password: &str) -> Vec<u8> {
    let mut out: Vec<u8> = password.encode_utf16().flat_map(u16::to_be_bytes).collect();
    out.extend([0, 0]);
    out
}

fn block_size(hash: HashAlg) -> usize {
    match hash {
        HashAlg::Sha1 | HashAlg::Sha256 => 64,
        HashAlg::Sha384 | HashAlg::Sha512 => 128,
    }
}

/// RFC 7292 appendix B.2: `n` bytes of key material for purpose `id` (1 key,
/// 2 IV, 3 MAC key).
pub(crate) fn kdf(
    hash: HashAlg,
    password: &[u8],
    salt: &[u8],
    iterations: u64,
    id: u8,
    n: usize,
) -> Vec<u8> {
    let (u, v) = (hash.len(), block_size(hash));
    let fill = |src: &[u8]| -> Vec<u8> {
        if src.is_empty() {
            return Vec::new();
        }
        let len = v * src.len().div_ceil(v);
        src.iter().copied().cycle().take(len).collect()
    };
    let d = vec![id; v];
    let mut i = [fill(salt), fill(password)].concat();
    let mut out = Vec::with_capacity(n + u);
    while out.len() < n {
        let mut a = hash.digest_parts(&[&d, &i]);
        for _ in 1..iterations {
            a = hash.digest(&a);
        }
        out.extend_from_slice(&a);
        if out.len() >= n {
            break;
        }
        let b: Vec<u8> = a.iter().copied().cycle().take(v).collect();
        for chunk in i.chunks_mut(v) {
            let mut carry = 1u16;
            for k in (0..v).rev() {
                let sum = chunk[k] as u16 + b[k] as u16 + carry;
                chunk[k] = sum as u8;
                carry = sum >> 8;
            }
        }
    }
    out.truncate(n);
    out
}

fn hmac(hash: HashAlg, key: &[u8], data: &[u8]) -> Vec<u8> {
    fn run<D: digest::Digest + digest::core_api::BlockSizeUser>(
        key: &[u8],
        data: &[u8],
    ) -> Vec<u8> {
        let mut mac =
            <SimpleHmac<D> as hmac::digest::KeyInit>::new_from_slice(key).expect("any key length");
        mac.update(data);
        mac.finalize().into_bytes().to_vec()
    }
    match hash {
        HashAlg::Sha1 => run::<Sha1>(key, data),
        HashAlg::Sha256 => run::<Sha256>(key, data),
        HashAlg::Sha384 => run::<Sha384>(key, data),
        HashAlg::Sha512 => run::<Sha512>(key, data),
    }
}

/// Constant-time comparison of two MACs.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Decrypts `data` with the algorithm in `alg` (an `AlgorithmIdentifier`,
/// DER): PBES2, or one of PKCS#12's own password-based ciphers.
fn decrypt(alg: &Tlv, password: &str, data: &[u8]) -> Result<Vec<u8>> {
    let fields = inside(alg, 0x30, "algorithm")?;
    let oid = oid_of(fields.first().ok_or_else(|| bad("algorithm"))?)?;
    if oid == oids::PBES2 {
        let scheme = pkcs5::EncryptionScheme::try_from(alg.raw).map_err(bad)?;
        match scheme.pbes2().map(|p| &p.kdf) {
            Some(pkcs5::pbes2::Kdf::Pbkdf2(p)) if p.iteration_count as u64 > MAX_ITERATIONS => {
                return Err(bad("too many PBKDF2 iterations"))
            }
            Some(pkcs5::pbes2::Kdf::Scrypt(_)) => return Err(bad("scrypt is not supported")),
            _ => {}
        }
        return scheme
            .decrypt(password.as_bytes(), data)
            .map_err(|_| SignError::P12Password);
    }
    let params = inside(
        fields.get(1).ok_or_else(|| bad("PBE parameters"))?,
        0x30,
        "PBE parameters",
    )?;
    let salt = octets(params.first().ok_or_else(|| bad("salt"))?)?;
    let iterations = params.get(1).map(integer).transpose()?.unwrap_or(1).max(1);
    if iterations > MAX_ITERATIONS {
        return Err(bad("too many iterations"));
    }
    let pw = bmp_password(password);
    let key = |n| kdf(HashAlg::Sha1, &pw, salt, iterations, 1, n);
    let iv = kdf(HashAlg::Sha1, &pw, salt, iterations, 2, 8);
    let fail = |_| SignError::P12Password;
    match oid {
        o if o == oids::PBE_SHA1_3DES => {
            cbc::Decryptor::<des::TdesEde3>::new_from_slices(&key(24), &iv)
                .map_err(bad)?
                .decrypt_padded_vec_mut::<Pkcs7>(data)
                .map_err(fail)
        }
        o if o == oids::PBE_SHA1_2DES => {
            cbc::Decryptor::<des::TdesEde2>::new_from_slices(&key(16), &iv)
                .map_err(bad)?
                .decrypt_padded_vec_mut::<Pkcs7>(data)
                .map_err(fail)
        }
        o if o == oids::PBE_SHA1_RC2_40 || o == oids::PBE_SHA1_RC2_128 => {
            let (len, bits) = if o == oids::PBE_SHA1_RC2_40 {
                (5, 40)
            } else {
                (16, 128)
            };
            let rc2 = rc2::Rc2::new_with_eff_key_len(&key(len), bits);
            cbc::Decryptor::<rc2::Rc2>::inner_iv_slice_init(rc2, &iv)
                .map_err(bad)?
                .decrypt_padded_vec_mut::<Pkcs7>(data)
                .map_err(fail)
        }
        o => Err(bad(format!("encryption {o} is not supported"))),
    }
}

/// A bag's `localKeyId` and `friendlyName`, from its attribute set.
fn bag_attributes(tlv: Option<&Tlv>) -> Result<(Option<Vec<u8>>, Option<String>)> {
    let (mut id, mut name) = (None, None);
    let Some(set) = tlv else {
        return Ok((id, name));
    };
    for attr in inside(set, 0x31, "attributes")? {
        let parts = inside(&attr, 0x30, "attribute")?;
        let (Some(oid), Some(values)) = (parts.first(), parts.get(1)) else {
            continue;
        };
        let oid = oid_of(oid)?;
        let Some(value) = children(values.value)?.into_iter().next() else {
            continue;
        };
        if oid == oids::ATTR_LOCAL_KEY_ID && value.tag == 0x04 {
            id = Some(value.value.to_vec());
        } else if oid == oids::ATTR_FRIENDLY_NAME && value.tag == 0x1e {
            let units: Vec<u16> = value
                .value
                .chunks(2)
                .map(|c| u16::from_be_bytes([c[0], *c.get(1).unwrap_or(&0)]))
                .collect();
            name = Some(String::from_utf16_lossy(&units));
        }
    }
    Ok((id, name))
}

#[derive(Default)]
struct Found {
    keys: Vec<(Option<Vec<u8>>, Option<String>, PrivateKey)>,
    certs: Vec<(Option<Vec<u8>>, Vec<u8>)>,
}

fn read_safe_contents(bytes: &[u8], password: &str, found: &mut Found, depth: u8) -> Result<()> {
    if depth > 4 {
        return Err(bad("bags nested too deep"));
    }
    let (seq, _) = read(bytes)?;
    for bag in inside(&seq, 0x30, "safe contents")? {
        let parts = inside(&bag, 0x30, "bag")?;
        let (Some(kind), Some(value)) = (parts.first(), parts.get(1)) else {
            return Err(bad("bag"));
        };
        let kind = oid_of(kind)?;
        let value = children(inside_tag(value, 0xa0)?)?
            .into_iter()
            .next()
            .ok_or_else(|| bad("empty bag"))?;
        let (id, name) = bag_attributes(parts.get(2))?;
        match kind {
            k if k == oids::BAG_KEY => {
                found
                    .keys
                    .push((id, name, PrivateKey::from_pkcs8_der(value.raw)?));
            }
            k if k == oids::BAG_SHROUDED_KEY => {
                let fields = inside(&value, 0x30, "encrypted key")?;
                let (Some(alg), Some(data)) = (fields.first(), fields.get(1)) else {
                    return Err(bad("encrypted key"));
                };
                let plain = decrypt(alg, password, octets(data)?)?;
                let key = PrivateKey::from_pkcs8_der(&plain).map_err(|_| SignError::P12Password)?;
                found.keys.push((id, name, key));
            }
            k if k == oids::BAG_CERT => {
                let fields = inside(&value, 0x30, "certificate bag")?;
                let (Some(kind), Some(cert)) = (fields.first(), fields.get(1)) else {
                    return Err(bad("certificate bag"));
                };
                if oid_of(kind)? != oids::CERT_X509 {
                    continue;
                }
                let cert = children(inside_tag(cert, 0xa0)?)?
                    .into_iter()
                    .next()
                    .ok_or_else(|| bad("certificate"))?;
                found.certs.push((id, octets(&cert)?.to_vec()));
            }
            k if k == oids::BAG_SAFE_CONTENTS => {
                read_safe_contents(value.raw, password, found, depth + 1)?
            }
            _ => {}
        }
    }
    Ok(())
}

fn inside_tag<'a>(tlv: &Tlv<'a>, tag: u8) -> Result<&'a [u8]> {
    if tlv.tag != tag {
        return Err(bad(format!("expected tag {tag:#x}, found {:#x}", tlv.tag)));
    }
    Ok(tlv.value)
}

/// The certificate's `SubjectPublicKeyInfo`, DER, to match a key to it.
pub(crate) fn cert_spki(cert: &[u8]) -> Option<Vec<u8>> {
    let cert = x509_cert::Certificate::from_der(cert).ok()?;
    cert.tbs_certificate.subject_public_key_info.to_der().ok()
}

/// Checks the MAC with the password as PKCS#12 derives it. An empty password
/// is tried both ways implementations write it (with and without the
/// terminating zero).
fn check_mac(mac_data: &Tlv, auth_safe: &[u8], password: &str) -> Result<()> {
    let fields = inside(mac_data, 0x30, "MAC")?;
    let digest_info = inside(
        fields.first().ok_or_else(|| bad("MAC"))?,
        0x30,
        "MAC digest",
    )?;
    let alg = inside(
        digest_info.first().ok_or_else(|| bad("MAC algorithm"))?,
        0x30,
        "MAC algorithm",
    )?;
    let oid = oid_of(alg.first().ok_or_else(|| bad("MAC algorithm"))?)?;
    let hash =
        HashAlg::from_oid(&oid).ok_or_else(|| bad(format!("MAC algorithm {oid} (PBMAC1?)")))?;
    let expected = octets(digest_info.get(1).ok_or_else(|| bad("MAC value"))?)?;
    let salt = octets(fields.get(1).ok_or_else(|| bad("MAC salt"))?)?;
    let iterations = fields.get(2).map(integer).transpose()?.unwrap_or(1).max(1);
    if iterations > MAX_ITERATIONS {
        return Err(bad("too many MAC iterations"));
    }
    let mut candidates = vec![bmp_password(password)];
    if password.is_empty() {
        candidates.push(Vec::new());
    }
    for pw in candidates {
        let key = kdf(hash, &pw, salt, iterations, 3, hash.len());
        if same(&hmac(hash, &key, auth_safe), expected) {
            return Ok(());
        }
    }
    Err(SignError::P12Password)
}

/// Opens a certificate file with its password: the signing key, its
/// certificate and the certificates above it.
pub fn open(pfx: &[u8], password: &str) -> Result<Identity> {
    let (top, _) = read(pfx).map_err(|_| bad("not DER"))?;
    let fields = inside(&top, 0x30, "PFX")?;
    if fields.first().map(integer).transpose()? != Some(3) {
        return Err(bad("not a PKCS#12 version 3 file"));
    }
    let content_info = inside(
        fields.get(1).ok_or_else(|| bad("no content"))?,
        0x30,
        "content",
    )?;
    if oid_of(content_info.first().ok_or_else(|| bad("content type"))?)? != oids::DATA {
        return Err(bad("public-key integrity mode is not supported"));
    }
    let wrapped = children(inside_tag(
        content_info.get(1).ok_or_else(|| bad("content"))?,
        0xa0,
    )?)?;
    let auth_safe = octets(wrapped.first().ok_or_else(|| bad("content"))?)?;
    if let Some(mac) = fields.get(2) {
        check_mac(mac, auth_safe, password)?;
    }

    let mut found = Found::default();
    let (safe, _) = read(auth_safe)?;
    for info in inside(&safe, 0x30, "authenticated safe")? {
        let parts = inside(&info, 0x30, "content info")?;
        let kind = oid_of(parts.first().ok_or_else(|| bad("content info"))?)?;
        let body = children(inside_tag(
            parts.get(1).ok_or_else(|| bad("content info"))?,
            0xa0,
        )?)?;
        let body = body.first().ok_or_else(|| bad("content info"))?;
        if kind == oids::DATA {
            read_safe_contents(octets(body)?, password, &mut found, 0)?;
        } else if kind == oids::ENCRYPTED_DATA {
            let data = inside(body, 0x30, "encrypted data")?;
            let eci = inside(
                data.get(1).ok_or_else(|| bad("encrypted data"))?,
                0x30,
                "encrypted content",
            )?;
            let (Some(alg), Some(content)) = (eci.get(1), eci.get(2)) else {
                return Err(bad("encrypted content"));
            };
            let ciphertext = match content.tag {
                0x80 => content.value.to_vec(),
                // A constructed [0] of OCTET STRING pieces.
                0xa0 => children(content.value)?
                    .iter()
                    .map(octets)
                    .collect::<Result<Vec<_>>>()?
                    .concat(),
                t => return Err(bad(format!("encrypted content tag {t:#x}"))),
            };
            let plain = decrypt(alg, password, &ciphertext)?;
            read_safe_contents(&plain, password, &mut found, 0)?;
        }
    }

    choose(found)
}

/// The key, and the certificate that goes with it — by the `localKeyId` both
/// bags carry, or failing that by the public key — then the certificates
/// above it, nearest first.
fn choose(found: Found) -> Result<Identity> {
    let Found { keys, mut certs } = found;
    for (id, name, key) in keys {
        let public = key.public_key_der()?;
        let position = certs
            .iter()
            .position(|(cid, _)| id.is_some() && *cid == id)
            .filter(|&i| cert_spki(&certs[i].1).as_deref() == Some(public.as_slice()))
            .or_else(|| {
                certs
                    .iter()
                    .position(|(_, der)| cert_spki(der).as_deref() == Some(public.as_slice()))
            });
        let Some(position) = position else {
            continue;
        };
        let (_, cert) = certs.remove(position);
        let others: Vec<Vec<u8>> = certs.into_iter().map(|(_, der)| der).collect();
        return Ok(Identity {
            signer: SoftwareSigner {
                key,
                chain: crate::chain::order_above(&cert, others),
                cert,
            },
            friendly_name: name,
        });
    }
    Err(SignError::P12(
        "the file has no private key with its certificate".into(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::{KeyKind, Signer};

    pub(crate) fn fixture(name: &str) -> Vec<u8> {
        std::fs::read(format!(
            "{}/../../../tests/fixtures/signatures/{name}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap()
    }

    #[test]
    fn the_key_derivation_matches_rfc_7292_as_openssl_implements_it() {
        // `openssl`'s PKCS12_key_gen_uni test vector: "smeg", salt
        // 0A58CF64530D823F, 1 iteration, ID 1, 24 bytes.
        let key = kdf(
            HashAlg::Sha1,
            &bmp_password("smeg"),
            &[0x0A, 0x58, 0xCF, 0x64, 0x53, 0x0D, 0x82, 0x3F],
            1,
            1,
            24,
        );
        assert_eq!(
            crate::hex(&key),
            "8AAAE6297B6CB04642AB5B077851284EB7128F1A2A7FBCA3"
        );
        let iv = kdf(
            HashAlg::Sha1,
            &bmp_password("smeg"),
            &[0x0A, 0x58, 0xCF, 0x64, 0x53, 0x0D, 0x82, 0x3F],
            1,
            2,
            8,
        );
        assert_eq!(crate::hex(&iv), "79993DFE048D3B76");
    }

    #[test]
    fn opens_legacy_and_modern_files_with_rsa_and_ec_keys() {
        let cases = [
            ("signer-rsa-legacy.p12", KeyKind::Rsa { bits: 2048 }),
            ("signer-rsa-aes.p12", KeyKind::Rsa { bits: 2048 }),
            ("signer-ec.p12", KeyKind::P256),
            ("signer-ec384-legacy.p12", KeyKind::P384),
        ];
        for (file, kind) in cases {
            let id = open(&fixture(file), "warraq-test").unwrap_or_else(|e| panic!("{file}: {e}"));
            assert_eq!(id.signer.key_kind(), kind, "{file}");
            let leaf = file.split(['-', '.']).take(2).collect::<Vec<_>>().join("-");
            let leaf = if leaf == "signer-ec384" || leaf == "signer-ec" {
                leaf
            } else {
                "signer-rsa".into()
            };
            assert_eq!(
                id.signer.certificate(),
                fixture(&format!("{leaf}.cer")),
                "{file}"
            );
            assert_eq!(id.signer.chain().len(), 2, "{file}: intermediate and root");
            // Nearest first: the intermediate, then the root.
            let root = if file.contains("ec") {
                "root-ec.cer"
            } else {
                "root-rsa.cer"
            };
            assert_eq!(id.signer.chain()[1], fixture(root), "{file}");
        }
    }

    #[test]
    fn a_wrong_password_is_said_so_and_garbage_is_refused() {
        for file in ["signer-rsa-legacy.p12", "signer-rsa-aes.p12"] {
            assert!(
                matches!(open(&fixture(file), "wrong"), Err(SignError::P12Password)),
                "{file}"
            );
        }
        assert!(matches!(open(b"not a p12", "x"), Err(SignError::P12(_))));
        let mut cut = fixture("signer-ec.p12");
        cut.truncate(cut.len() / 2);
        assert!(open(&cut, "warraq-test").is_err());
    }
}
