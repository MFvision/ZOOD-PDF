//! Object identifiers used by signatures, named as their RFCs name them.
use const_oid::ObjectIdentifier as Oid;

pub const SHA1: Oid = Oid::new_unwrap("1.3.14.3.2.26");
pub const SHA256: Oid = Oid::new_unwrap("2.16.840.1.101.3.4.2.1");
pub const SHA384: Oid = Oid::new_unwrap("2.16.840.1.101.3.4.2.2");
pub const SHA512: Oid = Oid::new_unwrap("2.16.840.1.101.3.4.2.3");

pub const RSA_ENCRYPTION: Oid = Oid::new_unwrap("1.2.840.113549.1.1.1");
pub const SHA1_WITH_RSA: Oid = Oid::new_unwrap("1.2.840.113549.1.1.5");
pub const RSASSA_PSS: Oid = Oid::new_unwrap("1.2.840.113549.1.1.10");
pub const SHA256_WITH_RSA: Oid = Oid::new_unwrap("1.2.840.113549.1.1.11");
pub const SHA384_WITH_RSA: Oid = Oid::new_unwrap("1.2.840.113549.1.1.12");
pub const SHA512_WITH_RSA: Oid = Oid::new_unwrap("1.2.840.113549.1.1.13");
pub const MGF1: Oid = Oid::new_unwrap("1.2.840.113549.1.1.8");

pub const EC_PUBLIC_KEY: Oid = Oid::new_unwrap("1.2.840.10045.2.1");
pub const ECDSA_SHA1: Oid = Oid::new_unwrap("1.2.840.10045.4.1");
pub const ECDSA_SHA256: Oid = Oid::new_unwrap("1.2.840.10045.4.3.2");
pub const ECDSA_SHA384: Oid = Oid::new_unwrap("1.2.840.10045.4.3.3");
pub const ECDSA_SHA512: Oid = Oid::new_unwrap("1.2.840.10045.4.3.4");
pub const SECP256R1: Oid = Oid::new_unwrap("1.2.840.10045.3.1.7");
pub const SECP384R1: Oid = Oid::new_unwrap("1.3.132.0.34");

pub const DATA: Oid = Oid::new_unwrap("1.2.840.113549.1.7.1");
pub const SIGNED_DATA: Oid = Oid::new_unwrap("1.2.840.113549.1.7.2");
pub const ENCRYPTED_DATA: Oid = Oid::new_unwrap("1.2.840.113549.1.7.6");
pub const TST_INFO: Oid = Oid::new_unwrap("1.2.840.113549.1.9.16.1.4");

pub const ATTR_CONTENT_TYPE: Oid = Oid::new_unwrap("1.2.840.113549.1.9.3");
pub const ATTR_MESSAGE_DIGEST: Oid = Oid::new_unwrap("1.2.840.113549.1.9.4");
pub const ATTR_SIGNING_TIME: Oid = Oid::new_unwrap("1.2.840.113549.1.9.5");
pub const ATTR_SIGNING_CERTIFICATE: Oid = Oid::new_unwrap("1.2.840.113549.1.9.16.2.12");
pub const ATTR_SIGNING_CERTIFICATE_V2: Oid = Oid::new_unwrap("1.2.840.113549.1.9.16.2.47");
pub const ATTR_TIMESTAMP_TOKEN: Oid = Oid::new_unwrap("1.2.840.113549.1.9.16.2.14");
/// Adobe's revocation archive (`adbe-revocationInfoArchival`), signed.
pub const ATTR_ADBE_REVOCATION: Oid = Oid::new_unwrap("1.2.840.113583.1.1.8");

// PKCS#12 (RFC 7292)
pub const PBES2: Oid = Oid::new_unwrap("1.2.840.113549.1.5.13");
pub const PBE_SHA1_RC2_128: Oid = Oid::new_unwrap("1.2.840.113549.1.12.1.5");
pub const PBE_SHA1_RC2_40: Oid = Oid::new_unwrap("1.2.840.113549.1.12.1.6");
pub const PBE_SHA1_3DES: Oid = Oid::new_unwrap("1.2.840.113549.1.12.1.3");
pub const PBE_SHA1_2DES: Oid = Oid::new_unwrap("1.2.840.113549.1.12.1.4");
pub const BAG_KEY: Oid = Oid::new_unwrap("1.2.840.113549.1.12.10.1.1");
pub const BAG_SHROUDED_KEY: Oid = Oid::new_unwrap("1.2.840.113549.1.12.10.1.2");
pub const BAG_CERT: Oid = Oid::new_unwrap("1.2.840.113549.1.12.10.1.3");
pub const BAG_SAFE_CONTENTS: Oid = Oid::new_unwrap("1.2.840.113549.1.12.10.1.6");
pub const CERT_X509: Oid = Oid::new_unwrap("1.2.840.113549.1.9.22.1");
pub const ATTR_LOCAL_KEY_ID: Oid = Oid::new_unwrap("1.2.840.113549.1.9.21");
pub const ATTR_FRIENDLY_NAME: Oid = Oid::new_unwrap("1.2.840.113549.1.9.20");

// Certificates
pub const EXT_KEY_USAGE: Oid = Oid::new_unwrap("2.5.29.15");
pub const EXT_BASIC_CONSTRAINTS: Oid = Oid::new_unwrap("2.5.29.19");
pub const EXT_EXTENDED_KEY_USAGE: Oid = Oid::new_unwrap("2.5.29.37");
pub const EXT_CRL_DISTRIBUTION_POINTS: Oid = Oid::new_unwrap("2.5.29.31");
pub const EXT_AUTHORITY_INFO_ACCESS: Oid = Oid::new_unwrap("1.3.6.1.5.5.7.1.1");
pub const AD_OCSP: Oid = Oid::new_unwrap("1.3.6.1.5.5.7.48.1");
pub const AD_CA_ISSUERS: Oid = Oid::new_unwrap("1.3.6.1.5.5.7.48.2");
pub const KP_TIME_STAMPING: Oid = Oid::new_unwrap("1.3.6.1.5.5.7.3.8");
pub const KP_OCSP_SIGNING: Oid = Oid::new_unwrap("1.3.6.1.5.5.7.3.9");
pub const OCSP_BASIC: Oid = Oid::new_unwrap("1.3.6.1.5.5.7.48.1.1");
pub const OCSP_NOCHECK: Oid = Oid::new_unwrap("1.3.6.1.5.5.7.48.1.5");

pub const AT_COMMON_NAME: Oid = Oid::new_unwrap("2.5.4.3");
pub const AT_ORGANIZATION: Oid = Oid::new_unwrap("2.5.4.10");
