//! warraq-sign — digital signatures of the ZOOD PDF engine.
//!
//! * [`pkcs12`]: PKCS#12 loader (modern PBES2/AES and legacy 3DES/RC2), [`signer`]: the
//!   `Signer` trait with a software implementation.
//! * [`cms`](crate::cmsbuild): CAdES-detached SignedData with contentType, messageDigest and
//!   signingCertificateV2; RFC 3161 timestamps ([`tsp`]); OCSP ([`ocsp`]).
//! * [`sign`]: PAdES B-B / B-T / B-LT / B-LTA as incremental updates (encrypted documents
//!   included), certification (DocMDP) and field locks (FieldMDP), visible Arabic appearance.
//! * [`verify`]: byte-range sanity, CMS/chain/EKU/timestamp checks, modification listing
//!   and attack detection (shadow, incremental saving, wrapping, borrowed signatures).
//!
//! The engine never touches the network: timestamp and revocation requests are returned as
//! DER for the host (desktop app) to send, and the responses are passed back in.

pub mod appearance;
pub mod cms;
pub mod diff;
pub mod error;
pub mod hash;
pub mod keys;
pub mod limits;
pub mod ocsp;
pub mod oids;
pub mod pdfobj;
pub mod pkcs12;
pub mod sign;
pub mod signer;
pub mod tlv;
pub mod tsp;
pub mod verify;
pub mod x509;

pub use error::{Result, SignError};
pub use hash::HashAlg;
pub use signer::{Signer, SoftwareSigner};
