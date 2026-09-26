//! Object identifiers used by the signature code.

use const_oid::ObjectIdentifier as Oid;

macro_rules! oid {
    ($name:ident, $s:literal) => {
        #[allow(missing_docs)]
        pub const $name: Oid = Oid::new_unwrap($s);
    };
}

// CMS / PKCS#7 / PKCS#9
oid!(DATA, "1.2.840.113549.1.7.1");
oid!(SIGNED_DATA, "1.2.840.113549.1.7.2");
oid!(ENCRYPTED_DATA, "1.2.840.113549.1.7.6");
oid!(CONTENT_TYPE, "1.2.840.113549.1.9.3");
oid!(MESSAGE_DIGEST, "1.2.840.113549.1.9.4");
oid!(SIGNING_TIME, "1.2.840.113549.1.9.5");
oid!(SIGNING_CERTIFICATE, "1.2.840.113549.1.9.16.2.12");
oid!(SIGNING_CERTIFICATE_V2, "1.2.840.113549.1.9.16.2.47");
oid!(SIGNATURE_TIMESTAMP_TOKEN, "1.2.840.113549.1.9.16.2.14");
oid!(TST_INFO, "1.2.840.113549.1.9.16.1.4");
oid!(ADBE_REVOCATION_INFO, "1.2.840.113583.1.1.8");

// Digests
oid!(SHA1, "1.3.14.3.2.26");
oid!(SHA256, "2.16.840.1.101.3.4.2.1");
oid!(SHA384, "2.16.840.1.101.3.4.2.2");
oid!(SHA512, "2.16.840.1.101.3.4.2.3");

// Signature algorithms / keys
oid!(RSA_ENCRYPTION, "1.2.840.113549.1.1.1");
oid!(RSA_PSS, "1.2.840.113549.1.1.10");
oid!(MGF1, "1.2.840.113549.1.1.8");
oid!(SHA1_WITH_RSA, "1.2.840.113549.1.1.5");
oid!(SHA256_WITH_RSA, "1.2.840.113549.1.1.11");
oid!(SHA384_WITH_RSA, "1.2.840.113549.1.1.12");
oid!(SHA512_WITH_RSA, "1.2.840.113549.1.1.13");
oid!(EC_PUBLIC_KEY, "1.2.840.10045.2.1");
oid!(ECDSA_SHA1, "1.2.840.10045.4.1");
oid!(ECDSA_SHA256, "1.2.840.10045.4.3.2");
oid!(ECDSA_SHA384, "1.2.840.10045.4.3.3");
oid!(ECDSA_SHA512, "1.2.840.10045.4.3.4");
oid!(P256, "1.2.840.10045.3.1.7");
oid!(P384, "1.3.132.0.34");

// PKCS#12 / PKCS#5
oid!(PBES2, "1.2.840.113549.1.5.13");
oid!(PBKDF2, "1.2.840.113549.1.5.12");
oid!(PBE_SHA1_3DES, "1.2.840.113549.1.12.1.3");
oid!(PBE_SHA1_2DES, "1.2.840.113549.1.12.1.4");
oid!(PBE_SHA1_RC2_128, "1.2.840.113549.1.12.1.5");
oid!(PBE_SHA1_RC2_40, "1.2.840.113549.1.12.1.6");
oid!(KEY_BAG, "1.2.840.113549.1.12.10.1.1");
oid!(SHROUDED_KEY_BAG, "1.2.840.113549.1.12.10.1.2");
oid!(CERT_BAG, "1.2.840.113549.1.12.10.1.3");
oid!(SAFE_CONTENTS_BAG, "1.2.840.113549.1.12.10.1.6");
oid!(X509_CERTIFICATE, "1.2.840.113549.1.9.22.1");
oid!(PBMAC1, "1.2.840.113549.1.5.14");

// X.509 extensions
oid!(EXT_KEY_USAGE, "2.5.29.15");
oid!(EXT_BASIC_CONSTRAINTS, "2.5.29.19");
oid!(EXT_EXTENDED_KEY_USAGE, "2.5.29.37");
oid!(EXT_CRL_DISTRIBUTION_POINTS, "2.5.29.31");
oid!(EXT_AUTHORITY_INFO_ACCESS, "1.3.6.1.5.5.7.1.1");
oid!(EXT_SUBJECT_KEY_ID, "2.5.29.14");
oid!(AIA_OCSP, "1.3.6.1.5.5.7.48.1");
oid!(AIA_CA_ISSUERS, "1.3.6.1.5.5.7.48.2");
oid!(OCSP_BASIC, "1.3.6.1.5.5.7.48.1.1");
oid!(OCSP_NONCE, "1.3.6.1.5.5.7.48.1.2");
oid!(OCSP_NOCHECK, "1.3.6.1.5.5.7.48.1.5");

// Extended key usages
oid!(EKU_ANY, "2.5.29.37.0");
oid!(EKU_SERVER_AUTH, "1.3.6.1.5.5.7.3.1");
oid!(EKU_CLIENT_AUTH, "1.3.6.1.5.5.7.3.2");
oid!(EKU_EMAIL_PROTECTION, "1.3.6.1.5.5.7.3.4");
oid!(EKU_TIME_STAMPING, "1.3.6.1.5.5.7.3.8");
oid!(EKU_OCSP_SIGNING, "1.3.6.1.5.5.7.3.9");
oid!(EKU_DOCUMENT_SIGNING, "1.3.6.1.5.5.7.3.36");
oid!(EKU_ADOBE_AUTHENTIC_DOCUMENTS, "1.2.840.113583.1.1.5");
oid!(EKU_MS_DOCUMENT_SIGNING, "1.3.6.1.4.1.311.10.3.12");

// Names
oid!(AT_COMMON_NAME, "2.5.4.3");
oid!(AT_ORGANIZATION, "2.5.4.10");
oid!(AT_ORG_UNIT, "2.5.4.11");
oid!(AT_COUNTRY, "2.5.4.6");
oid!(AT_EMAIL, "1.2.840.113549.1.9.1");
