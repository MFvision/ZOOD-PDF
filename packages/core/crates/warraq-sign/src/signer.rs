//! The `Signer` abstraction: whatever holds the private key signs a digest. The software
//! signer (PKCS#12 in memory) is implemented here; a PKCS#11 / smart-card signer implements
//! the same trait (no hardware was available to build and test one — see docs/STATUS.md).

use crate::error::Result;
use crate::hash::HashAlg;
use crate::keys::{KeyAlgorithm, SoftKey};
use crate::x509::Cert;

/// A signing key plus its certificate chain.
///
/// A PKCS#11 implementation would map `sign_digest` to `C_Sign` with `CKM_RSA_PKCS` (after
/// prefixing the DER DigestInfo) or `CKM_ECDSA` (converting the raw r||s output to DER).
pub trait Signer {
    /// The signer certificate.
    fn certificate(&self) -> &Cert;
    /// Further certificates to embed (intermediates, optionally the root), leaf excluded.
    fn chain(&self) -> &[Cert];
    /// Key algorithm (decides the CMS signature algorithm identifier).
    fn key_algorithm(&self) -> KeyAlgorithm;
    /// Digest algorithm for new signatures.
    fn digest_algorithm(&self) -> HashAlg {
        self.key_algorithm().default_hash()
    }
    /// Sign `digest` (computed with `hash`): an RSA PKCS#1 v1.5 signature or a DER
    /// `Ecdsa-Sig-Value`.
    fn sign_digest(&self, hash: HashAlg, digest: &[u8]) -> Result<Vec<u8>>;
}

/// Software signer from a PKCS#12 file. The key lives only in memory and is zeroized on drop.
#[derive(Debug)]
pub struct SoftwareSigner {
    key: SoftKey,
    cert: Cert,
    chain: Vec<Cert>,
}

impl SoftwareSigner {
    /// Load from PKCS#12 bytes and password.
    pub fn from_pkcs12(bytes: &[u8], password: &str) -> Result<Self> {
        let p = crate::pkcs12::load(bytes, password)?;
        Ok(SoftwareSigner {
            key: p.key,
            cert: p.cert,
            chain: p.chain,
        })
    }

    /// From parts (tests, other key stores).
    pub fn new(key: SoftKey, cert: Cert, chain: Vec<Cert>) -> Self {
        SoftwareSigner { key, cert, chain }
    }
}

impl Signer for SoftwareSigner {
    fn certificate(&self) -> &Cert {
        &self.cert
    }
    fn chain(&self) -> &[Cert] {
        &self.chain
    }
    fn key_algorithm(&self) -> KeyAlgorithm {
        self.key.algorithm()
    }
    fn sign_digest(&self, hash: HashAlg, digest: &[u8]) -> Result<Vec<u8>> {
        self.key.sign_digest(hash, digest)
    }
}
