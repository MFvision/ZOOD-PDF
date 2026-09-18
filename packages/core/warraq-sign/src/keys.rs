//! Keys: what signs, and checking what was signed.
//!
//! [`Signer`] is the one thing signing needs from a key: the certificates,
//! and a signature over a digest. A certificate file gives a
//! [`SoftwareSigner`]; a smart card or token is another implementation,
//! written by the desktop host over PKCS#11, and neither the CMS nor the PDF
//! code can tell them apart.
use der::{Decode, Encode};
use pkcs8::{DecodePrivateKey, DecodePublicKey, EncodePublicKey};
use rand_core::OsRng;
use rsa::{Pkcs1v15Sign, Pss, RsaPrivateKey, RsaPublicKey};
use sha1::Sha1;
use sha2::{Sha256, Sha384, Sha512};
use signature::hazmat::{PrehashSigner, PrehashVerifier};
use spki::AlgorithmIdentifierOwned;

use crate::asn1::{children, read, wrap};
use crate::{oids, HashAlg, Result, SignError};

/// The kind of key behind a certificate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum KeyKind {
    Rsa { bits: usize },
    P256,
    P384,
}

impl KeyKind {
    /// The digest a signature with this key uses: SHA-256, or SHA-384 for a
    /// P-384 key, whose strength it matches.
    pub fn hash(self) -> HashAlg {
        match self {
            KeyKind::P384 => HashAlg::Sha384,
            _ => HashAlg::Sha256,
        }
    }

    pub fn name(self) -> String {
        match self {
            KeyKind::Rsa { bits } => format!("RSA {bits}"),
            KeyKind::P256 => "ECDSA P-256".into(),
            KeyKind::P384 => "ECDSA P-384".into(),
        }
    }
}

/// How an RSA key signs; ignored by an EC key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Padding {
    #[default]
    Pkcs1v15,
    Pss,
}

/// Signs digests with a key whose certificate it holds.
pub trait Signer {
    /// The signer's certificate, DER.
    fn certificate(&self) -> &[u8];
    /// The certificates above it that it knows of, DER, nearest first.
    fn chain(&self) -> &[Vec<u8>];
    fn key_kind(&self) -> KeyKind;
    /// A signature over `digest` (made with `hash`): the RSA signature
    /// bytes, or an ECDSA signature DER-encoded (`Ecdsa-Sig-Value`).
    fn sign_digest(&self, digest: &[u8], hash: HashAlg, padding: Padding) -> Result<Vec<u8>>;
}

/// A private key read from a certificate file.
pub enum PrivateKey {
    Rsa(Box<RsaPrivateKey>),
    P256(p256::ecdsa::SigningKey),
    P384(p384::ecdsa::SigningKey),
}

impl PrivateKey {
    /// From a PKCS#8 `PrivateKeyInfo` (RSA, or EC on P-256 or P-384).
    pub fn from_pkcs8_der(der: &[u8]) -> Result<Self> {
        let info = pkcs8::PrivateKeyInfo::from_der(der)
            .map_err(|e| SignError::Key(format!("not a PKCS#8 key: {e}")))?;
        let oid = info.algorithm.oid;
        if oid == oids::RSA_ENCRYPTION {
            let key =
                RsaPrivateKey::from_pkcs8_der(der).map_err(|e| SignError::Key(e.to_string()))?;
            return Ok(Self::Rsa(Box::new(key)));
        }
        if oid == oids::EC_PUBLIC_KEY {
            let curve = info
                .algorithm
                .parameters_oid()
                .map_err(|e| SignError::Key(e.to_string()))?;
            if curve == oids::SECP256R1 {
                return p256::ecdsa::SigningKey::from_pkcs8_der(der)
                    .map(Self::P256)
                    .map_err(|e| SignError::Key(e.to_string()));
            }
            if curve == oids::SECP384R1 {
                return p384::ecdsa::SigningKey::from_pkcs8_der(der)
                    .map(Self::P384)
                    .map_err(|e| SignError::Key(e.to_string()));
            }
            return Err(SignError::Key(format!(
                "elliptic curve {curve} is not supported (P-256 and P-384 are)"
            )));
        }
        Err(SignError::Key(format!("key type {oid} is not supported")))
    }

    /// The public half, as a `SubjectPublicKeyInfo`, to match a certificate.
    pub fn public_key_der(&self) -> Result<Vec<u8>> {
        let doc = match self {
            PrivateKey::Rsa(k) => k.to_public_key().to_public_key_der(),
            PrivateKey::P256(k) => p256::PublicKey::from(k.verifying_key()).to_public_key_der(),
            PrivateKey::P384(k) => p384::PublicKey::from(k.verifying_key()).to_public_key_der(),
        };
        doc.map(|d| d.as_bytes().to_vec())
            .map_err(|e| SignError::Key(e.to_string()))
    }

    pub fn kind(&self) -> KeyKind {
        match self {
            PrivateKey::Rsa(k) => KeyKind::Rsa {
                bits: rsa::traits::PublicKeyParts::size(k.as_ref()) * 8,
            },
            PrivateKey::P256(_) => KeyKind::P256,
            PrivateKey::P384(_) => KeyKind::P384,
        }
    }

    pub fn sign_digest(&self, digest: &[u8], hash: HashAlg, padding: Padding) -> Result<Vec<u8>> {
        let fail = |e: &dyn std::fmt::Display| SignError::Sign(e.to_string());
        match self {
            PrivateKey::Rsa(key) => {
                // Blinded (`with_rng`), so the time a signature takes says
                // nothing about the key.
                let signed = match (padding, hash) {
                    (Padding::Pkcs1v15, HashAlg::Sha256) => {
                        key.sign_with_rng(&mut OsRng, Pkcs1v15Sign::new::<Sha256>(), digest)
                    }
                    (Padding::Pkcs1v15, HashAlg::Sha384) => {
                        key.sign_with_rng(&mut OsRng, Pkcs1v15Sign::new::<Sha384>(), digest)
                    }
                    (Padding::Pkcs1v15, HashAlg::Sha512) => {
                        key.sign_with_rng(&mut OsRng, Pkcs1v15Sign::new::<Sha512>(), digest)
                    }
                    (Padding::Pss, HashAlg::Sha256) => {
                        key.sign_with_rng(&mut OsRng, Pss::new_with_salt::<Sha256>(32), digest)
                    }
                    (Padding::Pss, HashAlg::Sha384) => {
                        key.sign_with_rng(&mut OsRng, Pss::new_with_salt::<Sha384>(48), digest)
                    }
                    (Padding::Pss, HashAlg::Sha512) => {
                        key.sign_with_rng(&mut OsRng, Pss::new_with_salt::<Sha512>(64), digest)
                    }
                    (_, HashAlg::Sha1) => {
                        return Err(SignError::Sign("SHA-1 is not signed with".into()))
                    }
                };
                signed.map_err(|e| fail(&e))
            }
            PrivateKey::P256(key) => {
                let sig: p256::ecdsa::Signature = key.sign_prehash(digest).map_err(|e| fail(&e))?;
                Ok(sig.to_der().as_bytes().to_vec())
            }
            PrivateKey::P384(key) => {
                let sig: p384::ecdsa::Signature = key.sign_prehash(digest).map_err(|e| fail(&e))?;
                Ok(sig.to_der().as_bytes().to_vec())
            }
        }
    }
}

/// A key and its certificates, from a certificate file.
pub struct SoftwareSigner {
    pub key: PrivateKey,
    pub cert: Vec<u8>,
    pub chain: Vec<Vec<u8>>,
}

impl Signer for SoftwareSigner {
    fn certificate(&self) -> &[u8] {
        &self.cert
    }
    fn chain(&self) -> &[Vec<u8>] {
        &self.chain
    }
    fn key_kind(&self) -> KeyKind {
        self.key.kind()
    }
    fn sign_digest(&self, digest: &[u8], hash: HashAlg, padding: Padding) -> Result<Vec<u8>> {
        self.key.sign_digest(digest, hash, padding)
    }
}

/// A signature algorithm, as far as checking one needs to know it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SigAlg {
    RsaPkcs1(HashAlg),
    RsaPss { hash: HashAlg, salt: usize },
    Ecdsa(HashAlg),
}

impl SigAlg {
    pub fn hash(self) -> HashAlg {
        match self {
            SigAlg::RsaPkcs1(h) | SigAlg::Ecdsa(h) => h,
            SigAlg::RsaPss { hash, .. } => hash,
        }
    }

    pub fn name(self) -> String {
        match self {
            SigAlg::RsaPkcs1(h) => format!("RSA PKCS#1 v1.5 with {}", h.name()),
            SigAlg::RsaPss { hash, .. } => format!("RSA-PSS with {}", hash.name()),
            SigAlg::Ecdsa(h) => format!("ECDSA with {}", h.name()),
        }
    }

    /// The `AlgorithmIdentifier` a CMS signer writes for it.
    pub fn algorithm(self) -> Result<AlgorithmIdentifierOwned> {
        let null = || der::Any::new(der::Tag::Null, Vec::<u8>::new()).map_err(crate::cms_err);
        Ok(match self {
            SigAlg::RsaPkcs1(_) => AlgorithmIdentifierOwned {
                oid: oids::RSA_ENCRYPTION,
                parameters: Some(null()?),
            },
            SigAlg::RsaPss { hash, salt } => {
                let hash_id = wrap(
                    0x30,
                    &[
                        hash.oid().to_der().map_err(crate::cms_err)?,
                        vec![0x05, 0x00],
                    ]
                    .concat(),
                );
                let mgf = wrap(
                    0x30,
                    &[
                        oids::MGF1.to_der().map_err(crate::cms_err)?,
                        hash_id.clone(),
                    ]
                    .concat(),
                );
                let salt = der::asn1::Int::new(&(salt as u32).to_be_bytes())
                    .and_then(|i| i.to_der())
                    .map_err(crate::cms_err)?;
                let params = wrap(
                    0x30,
                    &[wrap(0xa0, &hash_id), wrap(0xa1, &mgf), wrap(0xa2, &salt)].concat(),
                );
                AlgorithmIdentifierOwned {
                    oid: oids::RSASSA_PSS,
                    parameters: Some(der::Any::from_der(&params).map_err(crate::cms_err)?),
                }
            }
            SigAlg::Ecdsa(h) => AlgorithmIdentifierOwned {
                oid: match h {
                    HashAlg::Sha1 => oids::ECDSA_SHA1,
                    HashAlg::Sha256 => oids::ECDSA_SHA256,
                    HashAlg::Sha384 => oids::ECDSA_SHA384,
                    HashAlg::Sha512 => oids::ECDSA_SHA512,
                },
                parameters: None,
            },
        })
    }

    /// From an `AlgorithmIdentifier` (its OID and parameters' DER); `digest`
    /// is the signer's digest algorithm, which `rsaEncryption` or a bare EC
    /// key identifier leave to be named elsewhere.
    pub fn from_identifier(
        oid: &const_oid::ObjectIdentifier,
        params: Option<&[u8]>,
        digest: Option<HashAlg>,
    ) -> Result<Self> {
        let need = || digest.ok_or_else(|| SignError::Cms(format!("no digest named for {oid}")));
        Ok(match *oid {
            o if o == oids::RSA_ENCRYPTION => SigAlg::RsaPkcs1(need()?),
            o if o == oids::SHA1_WITH_RSA => SigAlg::RsaPkcs1(HashAlg::Sha1),
            o if o == oids::SHA256_WITH_RSA => SigAlg::RsaPkcs1(HashAlg::Sha256),
            o if o == oids::SHA384_WITH_RSA => SigAlg::RsaPkcs1(HashAlg::Sha384),
            o if o == oids::SHA512_WITH_RSA => SigAlg::RsaPkcs1(HashAlg::Sha512),
            o if o == oids::ECDSA_SHA1 => SigAlg::Ecdsa(HashAlg::Sha1),
            o if o == oids::ECDSA_SHA256 => SigAlg::Ecdsa(HashAlg::Sha256),
            o if o == oids::ECDSA_SHA384 => SigAlg::Ecdsa(HashAlg::Sha384),
            o if o == oids::ECDSA_SHA512 => SigAlg::Ecdsa(HashAlg::Sha512),
            o if o == oids::EC_PUBLIC_KEY => SigAlg::Ecdsa(need()?),
            o if o == oids::RSASSA_PSS => pss_params(params.unwrap_or(&[]))?,
            o => {
                return Err(SignError::Cms(format!(
                    "signature algorithm {o} is not supported"
                )))
            }
        })
    }
}

/// `RSASSA-PSS-params` (RFC 4055): the hash (SHA-1 when absent) and the salt
/// length (20 when absent). The mask generation is taken to use the same hash.
fn pss_params(der: &[u8]) -> Result<SigAlg> {
    let mut hash = HashAlg::Sha1;
    let mut salt = 20usize;
    if !der.is_empty() {
        let (seq, _) = read(der)?;
        for field in children(seq.value)? {
            match field.tag {
                0xa0 => {
                    let (alg, _) = read(field.value)?;
                    let oid_tlv = children(alg.value)?
                        .into_iter()
                        .next()
                        .ok_or_else(|| SignError::Cms("empty PSS hash".into()))?;
                    let oid = const_oid::ObjectIdentifier::from_der(oid_tlv.raw)
                        .map_err(crate::cms_err)?;
                    hash = HashAlg::from_oid(&oid).ok_or_else(|| {
                        SignError::Cms(format!("PSS hash {oid} is not supported"))
                    })?;
                }
                0xa2 => {
                    let (int, _) = read(field.value)?;
                    if int.value.len() > 4 {
                        return Err(SignError::Cms("PSS salt length".into()));
                    }
                    salt = int.value.iter().fold(0usize, |n, b| (n << 8) | *b as usize);
                }
                _ => {}
            }
        }
    }
    Ok(SigAlg::RsaPss { hash, salt })
}

/// Checks `signature` over `digest` with the key in `spki` (a DER
/// `SubjectPublicKeyInfo`).
pub fn verify_digest(spki: &[u8], alg: SigAlg, digest: &[u8], signature: &[u8]) -> Result<()> {
    let info = spki::SubjectPublicKeyInfoRef::from_der(spki).map_err(crate::cms_err)?;
    let bad = |e: &dyn std::fmt::Display| SignError::Cms(format!("signature does not verify: {e}"));
    let key_oid = info.algorithm.oid;
    match alg {
        SigAlg::RsaPkcs1(h) | SigAlg::RsaPss { hash: h, .. } => {
            if key_oid != oids::RSA_ENCRYPTION && key_oid != oids::RSASSA_PSS {
                return Err(SignError::Cms(
                    "an RSA signature with a key that is not RSA".into(),
                ));
            }
            let key = RsaPublicKey::from_public_key_der(spki).map_err(crate::cms_err)?;
            let r = match alg {
                SigAlg::RsaPkcs1(_) => match h {
                    HashAlg::Sha1 => key.verify(Pkcs1v15Sign::new::<Sha1>(), digest, signature),
                    HashAlg::Sha256 => key.verify(Pkcs1v15Sign::new::<Sha256>(), digest, signature),
                    HashAlg::Sha384 => key.verify(Pkcs1v15Sign::new::<Sha384>(), digest, signature),
                    HashAlg::Sha512 => key.verify(Pkcs1v15Sign::new::<Sha512>(), digest, signature),
                },
                SigAlg::RsaPss { salt, .. } => match h {
                    HashAlg::Sha1 => {
                        key.verify(Pss::new_with_salt::<Sha1>(salt), digest, signature)
                    }
                    HashAlg::Sha256 => {
                        key.verify(Pss::new_with_salt::<Sha256>(salt), digest, signature)
                    }
                    HashAlg::Sha384 => {
                        key.verify(Pss::new_with_salt::<Sha384>(salt), digest, signature)
                    }
                    HashAlg::Sha512 => {
                        key.verify(Pss::new_with_salt::<Sha512>(salt), digest, signature)
                    }
                },
                SigAlg::Ecdsa(_) => unreachable!(),
            };
            r.map_err(|e| bad(&e))
        }
        SigAlg::Ecdsa(_) => {
            if key_oid != oids::EC_PUBLIC_KEY {
                return Err(SignError::Cms(
                    "an ECDSA signature with a key that is not EC".into(),
                ));
            }
            let curve = info.algorithm.parameters_oid().map_err(crate::cms_err)?;
            if curve == oids::SECP256R1 {
                let key =
                    p256::ecdsa::VerifyingKey::from_public_key_der(spki).map_err(crate::cms_err)?;
                let sig = p256::ecdsa::Signature::from_der(signature).map_err(|e| bad(&e))?;
                key.verify_prehash(digest, &sig).map_err(|e| bad(&e))
            } else if curve == oids::SECP384R1 {
                let key =
                    p384::ecdsa::VerifyingKey::from_public_key_der(spki).map_err(crate::cms_err)?;
                let sig = p384::ecdsa::Signature::from_der(signature).map_err(|e| bad(&e))?;
                key.verify_prehash(digest, &sig).map_err(|e| bad(&e))
            } else {
                Err(SignError::Cms(format!(
                    "elliptic curve {curve} is not supported"
                )))
            }
        }
    }
}

/// Checks `signature` over `message`, hashed as `alg` says.
pub fn verify_message(spki: &[u8], alg: SigAlg, message: &[u8], signature: &[u8]) -> Result<()> {
    verify_digest(spki, alg, &alg.hash().digest(message), signature)
}
