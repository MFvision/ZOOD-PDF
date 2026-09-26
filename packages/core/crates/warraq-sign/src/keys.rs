//! Public-key primitives: signature verification for every algorithm we accept, and the
//! in-memory software private key loaded from PKCS#12.

use crate::error::{Result, SignError};
use crate::hash::HashAlg;
use crate::oids;
use der::asn1::ObjectIdentifier;
use der::{Decode, Encode};
use spki::{AlgorithmIdentifierOwned, SubjectPublicKeyInfoOwned};

/// Key algorithm of a certificate / signer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyAlgorithm {
    /// RSA with modulus bits.
    Rsa(usize),
    /// ECDSA on NIST P-256.
    EcP256,
    /// ECDSA on NIST P-384.
    EcP384,
    /// Anything else.
    Other,
}

impl KeyAlgorithm {
    /// Display name (e.g. `RSA-2048`, `ECDSA P-256`).
    pub fn name(&self) -> String {
        match self {
            KeyAlgorithm::Rsa(b) => format!("RSA-{b}"),
            KeyAlgorithm::EcP256 => "ECDSA P-256".into(),
            KeyAlgorithm::EcP384 => "ECDSA P-384".into(),
            KeyAlgorithm::Other => "unknown".into(),
        }
    }

    /// Digest used for new signatures with this key.
    pub fn default_hash(&self) -> HashAlg {
        match self {
            KeyAlgorithm::EcP384 => HashAlg::Sha384,
            _ => HashAlg::Sha256,
        }
    }

    /// The CMS/X.509 signature algorithm identifier for new signatures with `hash`.
    pub fn signature_algorithm(&self, hash: HashAlg) -> Result<AlgorithmIdentifierOwned> {
        let oid = match (self, hash) {
            (KeyAlgorithm::Rsa(_), HashAlg::Sha256) => oids::SHA256_WITH_RSA,
            (KeyAlgorithm::Rsa(_), HashAlg::Sha384) => oids::SHA384_WITH_RSA,
            (KeyAlgorithm::Rsa(_), HashAlg::Sha512) => oids::SHA512_WITH_RSA,
            (KeyAlgorithm::EcP256 | KeyAlgorithm::EcP384, HashAlg::Sha256) => oids::ECDSA_SHA256,
            (KeyAlgorithm::EcP256 | KeyAlgorithm::EcP384, HashAlg::Sha384) => oids::ECDSA_SHA384,
            (KeyAlgorithm::EcP256 | KeyAlgorithm::EcP384, HashAlg::Sha512) => oids::ECDSA_SHA512,
            _ => {
                return Err(SignError::Unsupported(format!(
                    "{} with {}",
                    self.name(),
                    hash.name()
                )))
            }
        };
        // RSA PKCS#1 v1.5 identifiers carry an explicit NULL; ECDSA ones carry nothing.
        let parameters = match self {
            KeyAlgorithm::Rsa(_) => Some(der::Any::from(der::asn1::Null)),
            _ => None,
        };
        Ok(AlgorithmIdentifierOwned { oid, parameters })
    }
}

fn curve_of(spki: &SubjectPublicKeyInfoOwned) -> Option<ObjectIdentifier> {
    spki.algorithm
        .parameters
        .as_ref()
        .and_then(|p| p.decode_as::<ObjectIdentifier>().ok())
}

/// Key algorithm of a SubjectPublicKeyInfo.
pub fn key_algorithm(spki: &SubjectPublicKeyInfoOwned) -> KeyAlgorithm {
    if spki.algorithm.oid == oids::RSA_ENCRYPTION || spki.algorithm.oid == oids::RSA_PSS {
        return rsa_public(spki)
            .map(|k| KeyAlgorithm::Rsa(rsa::traits::PublicKeyParts::size(&k) * 8))
            .unwrap_or(KeyAlgorithm::Other);
    }
    if spki.algorithm.oid == oids::EC_PUBLIC_KEY {
        return match curve_of(spki) {
            Some(c) if c == oids::P256 => KeyAlgorithm::EcP256,
            Some(c) if c == oids::P384 => KeyAlgorithm::EcP384,
            _ => KeyAlgorithm::Other,
        };
    }
    KeyAlgorithm::Other
}

fn rsa_public(spki: &SubjectPublicKeyInfoOwned) -> Result<rsa::RsaPublicKey> {
    use rsa::pkcs1::DecodeRsaPublicKey;
    let raw = spki
        .subject_public_key
        .as_bytes()
        .ok_or_else(|| SignError::Malformed("RSA key bit string".into()))?;
    rsa::RsaPublicKey::from_pkcs1_der(raw).map_err(|e| SignError::der("RSA public key", e))
}

/// The digest implied by a signature algorithm identifier, if it names one.
pub fn implied_hash(alg: &AlgorithmIdentifierOwned) -> Result<Option<HashAlg>> {
    let o = alg.oid;
    Ok(Some(match o {
        _ if o == oids::SHA1_WITH_RSA || o == oids::ECDSA_SHA1 => HashAlg::Sha1,
        _ if o == oids::SHA256_WITH_RSA || o == oids::ECDSA_SHA256 => HashAlg::Sha256,
        _ if o == oids::SHA384_WITH_RSA || o == oids::ECDSA_SHA384 => HashAlg::Sha384,
        _ if o == oids::SHA512_WITH_RSA || o == oids::ECDSA_SHA512 => HashAlg::Sha512,
        _ if o == oids::RSA_PSS => pss_params(alg)?.0,
        _ => return Ok(None),
    }))
}

/// RSASSA-PSS parameters: (hash, salt length).
fn pss_params(alg: &AlgorithmIdentifierOwned) -> Result<(HashAlg, usize)> {
    let Some(p) = &alg.parameters else {
        return Ok((HashAlg::Sha1, 20));
    };
    let der = p.to_der().map_err(|e| SignError::der("PSS params", e))?;
    let (seq, _) = crate::tlv::read(&der)?;
    let mut hash = HashAlg::Sha1;
    let mut salt = 20usize;
    for f in crate::tlv::children(seq.content)? {
        match f.tag {
            0xA0 => {
                let a = AlgorithmIdentifierOwned::from_der(f.content)
                    .map_err(|e| SignError::der("PSS hash", e))?;
                hash = HashAlg::from_oid(&a.oid)?;
            }
            0xA2 => {
                let v = u32::from_der(f.content).map_err(|e| SignError::der("PSS salt", e))?;
                salt = usize::try_from(v).unwrap_or(0).min(512);
            }
            _ => {}
        }
    }
    Ok((hash, salt))
}

fn verify_rsa_pkcs1(
    key: &rsa::RsaPublicKey,
    hash: HashAlg,
    digest: &[u8],
    sig: &[u8],
) -> Result<()> {
    use rsa::Pkcs1v15Sign;
    let scheme = match hash {
        HashAlg::Sha1 => Pkcs1v15Sign::new::<sha1::Sha1>(),
        HashAlg::Sha256 => Pkcs1v15Sign::new::<sha2::Sha256>(),
        HashAlg::Sha384 => Pkcs1v15Sign::new::<sha2::Sha384>(),
        HashAlg::Sha512 => Pkcs1v15Sign::new::<sha2::Sha512>(),
    };
    key.verify(scheme, digest, sig)
        .map_err(|_| SignError::Crypto("RSA signature does not verify".into()))
}

fn verify_rsa_pss(
    key: &rsa::RsaPublicKey,
    hash: HashAlg,
    salt: usize,
    digest: &[u8],
    sig: &[u8],
) -> Result<()> {
    use rsa::Pss;
    let scheme = match hash {
        HashAlg::Sha1 => Pss::new_with_salt::<sha1::Sha1>(salt),
        HashAlg::Sha256 => Pss::new_with_salt::<sha2::Sha256>(salt),
        HashAlg::Sha384 => Pss::new_with_salt::<sha2::Sha384>(salt),
        HashAlg::Sha512 => Pss::new_with_salt::<sha2::Sha512>(salt),
    };
    key.verify(scheme, digest, sig)
        .map_err(|_| SignError::Crypto("RSA-PSS signature does not verify".into()))
}

fn verify_ecdsa(spki: &SubjectPublicKeyInfoOwned, digest: &[u8], sig: &[u8]) -> Result<()> {
    use ecdsa::signature::hazmat::PrehashVerifier;
    let point = spki
        .subject_public_key
        .as_bytes()
        .ok_or_else(|| SignError::Malformed("EC key bit string".into()))?;
    let fail = || SignError::Crypto("ECDSA signature does not verify".into());
    match curve_of(spki) {
        Some(c) if c == oids::P256 => {
            let vk = p256::ecdsa::VerifyingKey::from_sec1_bytes(point)
                .map_err(|_| SignError::Malformed("P-256 public key".into()))?;
            let s = p256::ecdsa::Signature::from_der(sig).map_err(|_| fail())?;
            vk.verify_prehash(digest, &s).map_err(|_| fail())
        }
        Some(c) if c == oids::P384 => {
            let vk = p384::ecdsa::VerifyingKey::from_sec1_bytes(point)
                .map_err(|_| SignError::Malformed("P-384 public key".into()))?;
            let s = p384::ecdsa::Signature::from_der(sig).map_err(|_| fail())?;
            vk.verify_prehash(digest, &s).map_err(|_| fail())
        }
        _ => Err(SignError::Unsupported("elliptic curve".into())),
    }
}

/// Verify `sig` over a precomputed `digest` (computed with `hash`) using `spki`.
/// `sig_alg` is the signature algorithm identifier as written (a CMS SignerInfo may use
/// plain `rsaEncryption`/`id-ecPublicKey` there, then `hash` decides).
pub fn verify_prehash(
    spki: &SubjectPublicKeyInfoOwned,
    sig_alg: &AlgorithmIdentifierOwned,
    hash: HashAlg,
    digest: &[u8],
    sig: &[u8],
) -> Result<()> {
    if let Some(h) = implied_hash(sig_alg)? {
        if h != hash {
            return Err(SignError::Crypto(format!(
                "signature algorithm uses {} but the digest is {}",
                h.name(),
                hash.name()
            )));
        }
    }
    let o = sig_alg.oid;
    let is_rsa = o == oids::RSA_ENCRYPTION
        || o == oids::SHA1_WITH_RSA
        || o == oids::SHA256_WITH_RSA
        || o == oids::SHA384_WITH_RSA
        || o == oids::SHA512_WITH_RSA;
    let is_ec = o == oids::EC_PUBLIC_KEY
        || o == oids::ECDSA_SHA1
        || o == oids::ECDSA_SHA256
        || o == oids::ECDSA_SHA384
        || o == oids::ECDSA_SHA512;
    if is_rsa {
        if spki.algorithm.oid != oids::RSA_ENCRYPTION {
            return Err(SignError::Crypto("RSA signature with a non-RSA key".into()));
        }
        verify_rsa_pkcs1(&rsa_public(spki)?, hash, digest, sig)
    } else if o == oids::RSA_PSS {
        let (_, salt) = pss_params(sig_alg)?;
        verify_rsa_pss(&rsa_public(spki)?, hash, salt, digest, sig)
    } else if is_ec {
        if spki.algorithm.oid != oids::EC_PUBLIC_KEY {
            return Err(SignError::Crypto(
                "ECDSA signature with a non-EC key".into(),
            ));
        }
        verify_ecdsa(spki, digest, sig)
    } else {
        Err(SignError::Unsupported(format!("signature algorithm {o}")))
    }
}

/// Verify a signature over `data` whose algorithm identifier implies the digest
/// (certificates, CRLs, OCSP responses).
pub fn verify_data(
    spki: &SubjectPublicKeyInfoOwned,
    sig_alg: &AlgorithmIdentifierOwned,
    data: &[u8],
    sig: &[u8],
) -> Result<()> {
    let hash = implied_hash(sig_alg)?
        .ok_or_else(|| SignError::Unsupported(format!("signature algorithm {}", sig_alg.oid)))?;
    verify_prehash(spki, sig_alg, hash, &hash.digest(data), sig)
}

/// Randomness for RSA blinding, from the same source as the PDF writer (getrandom; on the
/// web `crypto.getRandomValues`).
struct BlindingRng;

impl rand_core::RngCore for BlindingRng {
    fn next_u32(&mut self) -> u32 {
        let mut b = [0u8; 4];
        self.fill_bytes(&mut b);
        u32::from_le_bytes(b)
    }
    fn next_u64(&mut self) -> u64 {
        let mut b = [0u8; 8];
        self.fill_bytes(&mut b);
        u64::from_le_bytes(b)
    }
    fn fill_bytes(&mut self, dest: &mut [u8]) {
        // try_fill_bytes only fails when the OS has no randomness at all; blinding then
        // degrades to zeros rather than panicking (the signature stays correct).
        let _ = self.try_fill_bytes(dest);
    }
    fn try_fill_bytes(&mut self, dest: &mut [u8]) -> std::result::Result<(), rand_core::Error> {
        for chunk in dest.chunks_mut(32) {
            let r: [u8; 32] = warraq_pdf::crypt::random_bytes()
                .map_err(|_| rand_core::Error::from(core::num::NonZeroU32::MIN))?;
            chunk.copy_from_slice(r.get(..chunk.len()).unwrap_or_default());
        }
        Ok(())
    }
}
impl rand_core::CryptoRng for BlindingRng {}

/// A private key held in memory (zeroized on drop by the underlying crates).
pub enum SoftKey {
    /// RSA.
    Rsa(Box<rsa::RsaPrivateKey>),
    /// ECDSA P-256.
    P256(p256::ecdsa::SigningKey),
    /// ECDSA P-384.
    P384(p384::ecdsa::SigningKey),
}

impl std::fmt::Debug for SoftKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            SoftKey::Rsa(_) => "SoftKey::Rsa(..)",
            SoftKey::P256(_) => "SoftKey::P256(..)",
            SoftKey::P384(_) => "SoftKey::P384(..)",
        })
    }
}

impl SoftKey {
    /// Parse a PKCS#8 PrivateKeyInfo.
    pub fn from_pkcs8(der_bytes: &[u8]) -> Result<SoftKey> {
        use pkcs8::DecodePrivateKey;
        let info = pkcs8::PrivateKeyInfo::from_der(der_bytes)
            .map_err(|e| SignError::der("private key", e))?;
        let alg = info.algorithm.oid;
        if alg == oids::RSA_ENCRYPTION {
            let k = rsa::RsaPrivateKey::from_pkcs8_der(der_bytes)
                .map_err(|e| SignError::der("RSA private key", e))?;
            return Ok(SoftKey::Rsa(Box::new(k)));
        }
        if alg == oids::EC_PUBLIC_KEY {
            let curve = info
                .algorithm
                .parameters
                .and_then(|p| p.decode_as::<ObjectIdentifier>().ok());
            return match curve {
                Some(c) if c == oids::P256 => Ok(SoftKey::P256(
                    p256::ecdsa::SigningKey::from_pkcs8_der(der_bytes)
                        .map_err(|e| SignError::der("P-256 private key", e))?,
                )),
                Some(c) if c == oids::P384 => Ok(SoftKey::P384(
                    p384::ecdsa::SigningKey::from_pkcs8_der(der_bytes)
                        .map_err(|e| SignError::der("P-384 private key", e))?,
                )),
                _ => Err(SignError::Unsupported(
                    "elliptic curve (only P-256 and P-384 are supported)".into(),
                )),
            };
        }
        Err(SignError::Unsupported(format!(
            "private key algorithm {alg}"
        )))
    }

    /// DER SubjectPublicKeyInfo of the matching public key.
    pub fn public_key_der(&self) -> Result<Vec<u8>> {
        use spki::EncodePublicKey;
        let doc = match self {
            SoftKey::Rsa(k) => k.to_public_key().to_public_key_der(),
            SoftKey::P256(k) => p256::PublicKey::from(k.verifying_key()).to_public_key_der(),
            SoftKey::P384(k) => p384::PublicKey::from(k.verifying_key()).to_public_key_der(),
        }
        .map_err(|e| SignError::Crypto(format!("public key: {e}")))?;
        Ok(doc.as_bytes().to_vec())
    }

    /// Key algorithm.
    pub fn algorithm(&self) -> KeyAlgorithm {
        match self {
            SoftKey::Rsa(k) => KeyAlgorithm::Rsa(rsa::traits::PublicKeyParts::size(k.as_ref()) * 8),
            SoftKey::P256(_) => KeyAlgorithm::EcP256,
            SoftKey::P384(_) => KeyAlgorithm::EcP384,
        }
    }

    /// Sign a digest: RSA PKCS#1 v1.5 (blinded) or DER-encoded ECDSA (RFC 6979 nonces).
    pub fn sign_digest(&self, hash: HashAlg, digest: &[u8]) -> Result<Vec<u8>> {
        use ecdsa::signature::hazmat::PrehashSigner;
        if digest.len() != hash.output_len() {
            return Err(SignError::InvalidArgument("digest length".into()));
        }
        match self {
            SoftKey::Rsa(k) => {
                use rsa::Pkcs1v15Sign;
                let scheme = match hash {
                    HashAlg::Sha256 => Pkcs1v15Sign::new::<sha2::Sha256>(),
                    HashAlg::Sha384 => Pkcs1v15Sign::new::<sha2::Sha384>(),
                    HashAlg::Sha512 => Pkcs1v15Sign::new::<sha2::Sha512>(),
                    HashAlg::Sha1 => {
                        return Err(SignError::Unsupported("SHA-1 for new signatures".into()))
                    }
                };
                k.sign_with_rng(&mut BlindingRng, scheme, digest)
                    .map_err(|e| SignError::Crypto(format!("RSA signing failed: {e}")))
            }
            SoftKey::P256(k) => {
                let s: p256::ecdsa::Signature = k
                    .sign_prehash(digest)
                    .map_err(|e| SignError::Crypto(format!("ECDSA signing failed: {e}")))?;
                Ok(s.to_der().as_bytes().to_vec())
            }
            SoftKey::P384(k) => {
                let s: p384::ecdsa::Signature = k
                    .sign_prehash(digest)
                    .map_err(|e| SignError::Crypto(format!("ECDSA signing failed: {e}")))?;
                Ok(s.to_der().as_bytes().to_vec())
            }
        }
    }
}
