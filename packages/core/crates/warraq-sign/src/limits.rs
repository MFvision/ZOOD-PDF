//! Bounds for everything input-driven in the signature code.

/// Largest PKCS#12 file accepted.
pub const MAX_P12_SIZE: usize = 1 << 20;
/// Largest CMS blob (a `/Contents` value, a TSA response, an OCSP response, a CRL).
pub const MAX_CMS_SIZE: usize = 4 << 20;
/// Largest single certificate.
pub const MAX_CERT_SIZE: usize = 64 << 10;
/// Most certificates considered from one source (CMS, DSS, PKCS#12).
pub const MAX_CERTS: usize = 256;
/// Deepest ASN.1 nesting walked by the TLV reader.
pub const MAX_ASN1_DEPTH: usize = 64;
/// Longest certificate chain built.
pub const MAX_CHAIN: usize = 12;
/// Largest PBKDF2 / PKCS#12-KDF iteration count accepted (OpenSSL writes 2048, modern tools
/// up to 600 000). Beyond this a crafted file would pin the CPU.
pub const MAX_KDF_ITERATIONS: u32 = 3_000_000;
/// Most signatures verified in one document.
pub const MAX_SIGNATURES: usize = 512;
/// Largest `/Contents` placeholder (bytes of CMS, the hex string is twice as long).
pub const MAX_PLACEHOLDER: usize = 1 << 20;
/// Most objects compared when listing modifications between two revisions.
pub const MAX_DIFF_OBJECTS: usize = 2_000_000;
/// Bytes of hashing + revision parsing `sign.verify` may spend on one document (a file with
/// hundreds of signatures over hundreds of MB would otherwise take minutes).
pub const MAX_VERIFY_WORK: u64 = 3 << 30;
