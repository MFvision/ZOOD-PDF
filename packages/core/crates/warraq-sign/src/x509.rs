//! Certificate helpers: parsing (bounded), names, extensions, signature checks over the
//! ORIGINAL TBS bytes, chain building to trust anchors, and the extended-key-usage policy.

use crate::error::{Result, SignError};
use crate::keys::{self, KeyAlgorithm};
use crate::limits::{MAX_CERT_SIZE, MAX_CHAIN};
use crate::oids;
use crate::tlv;
use der::asn1::ObjectIdentifier;
use der::{Decode, Encode, Tagged};
use spki::{AlgorithmIdentifierOwned, SubjectPublicKeyInfoOwned};
use x509_cert::name::Name;
use x509_cert::Certificate;

/// A parsed certificate plus its exact DER bytes.
#[derive(Clone, Debug)]
pub struct Cert {
    /// Typed form.
    pub cert: Certificate,
    /// The DER exactly as received.
    pub der: Vec<u8>,
}

impl PartialEq for Cert {
    fn eq(&self, other: &Self) -> bool {
        self.der == other.der
    }
}

impl Cert {
    /// Parse DER (BER is normalised first).
    pub fn from_der(bytes: &[u8]) -> Result<Cert> {
        if bytes.len() > MAX_CERT_SIZE {
            return Err(SignError::Limit("certificate too large".into()));
        }
        let len = tlv::element_len(bytes)?;
        let bytes = bytes.get(..len).unwrap_or(bytes);
        let der = match Certificate::from_der(bytes) {
            Ok(c) => {
                return Ok(Cert {
                    cert: c,
                    der: bytes.to_vec(),
                })
            }
            Err(_) => tlv::ber_to_der(bytes)?,
        };
        let cert = Certificate::from_der(&der).map_err(|e| SignError::der("certificate", e))?;
        Ok(Cert { cert, der })
    }

    /// Parse PEM or DER.
    pub fn from_pem_or_der(bytes: &[u8]) -> Result<Vec<Cert>> {
        if bytes.starts_with(b"-----") || bytes.windows(11).any(|w| w == b"-----BEGIN ") {
            let text = std::str::from_utf8(bytes)
                .map_err(|_| SignError::Malformed("PEM is not UTF-8".into()))?;
            let mut out = Vec::new();
            let mut rest = text;
            while let Some(start) = rest.find("-----BEGIN CERTIFICATE-----") {
                let after = rest.get(start + 27..).unwrap_or_default();
                let end = after
                    .find("-----END CERTIFICATE-----")
                    .ok_or_else(|| SignError::Malformed("PEM without END".into()))?;
                let b64: String = after
                    .get(..end)
                    .unwrap_or_default()
                    .chars()
                    .filter(|c| !c.is_whitespace())
                    .collect();
                let der =
                    base64_decode(&b64).ok_or_else(|| SignError::Malformed("PEM base64".into()))?;
                out.push(Cert::from_der(&der)?);
                if out.len() > crate::limits::MAX_CERTS {
                    return Err(SignError::Limit("too many certificates".into()));
                }
                rest = after.get(end + 25..).unwrap_or_default();
            }
            if out.is_empty() {
                return Err(SignError::Malformed("no certificate in PEM".into()));
            }
            Ok(out)
        } else {
            Ok(vec![Cert::from_der(bytes)?])
        }
    }

    /// Subject public key info.
    pub fn spki(&self) -> &SubjectPublicKeyInfoOwned {
        &self.cert.tbs_certificate.subject_public_key_info
    }

    /// DER of the subject public key info.
    pub fn spki_der(&self) -> Result<Vec<u8>> {
        self.spki()
            .to_der()
            .map_err(|e| SignError::der("public key", e))
    }

    /// Key algorithm.
    pub fn key_algorithm(&self) -> KeyAlgorithm {
        keys::key_algorithm(self.spki())
    }

    /// Subject name.
    pub fn subject(&self) -> &Name {
        &self.cert.tbs_certificate.subject
    }

    /// Issuer name.
    pub fn issuer(&self) -> &Name {
        &self.cert.tbs_certificate.issuer
    }

    /// Display name: CN, else O, else the whole DN.
    pub fn display_name(&self) -> String {
        name_attr(self.subject(), oids::AT_COMMON_NAME)
            .or_else(|| name_attr(self.subject(), oids::AT_ORGANIZATION))
            .unwrap_or_else(|| name_string(self.subject()))
    }

    /// Serial number as uppercase hex.
    pub fn serial_hex(&self) -> String {
        crate::hash::hex_upper(self.cert.tbs_certificate.serial_number.as_bytes())
    }

    /// `(not_before, not_after)` in Unix seconds.
    pub fn validity(&self) -> (i64, i64) {
        let v = &self.cert.tbs_certificate.validity;
        let secs = |t: &x509_cert::time::Time| t.to_unix_duration().as_secs() as i64;
        (secs(&v.not_before), secs(&v.not_after))
    }

    /// Whether `at` (Unix seconds) is inside the validity period.
    pub fn valid_at(&self, at: i64) -> bool {
        let (a, b) = self.validity();
        a <= at && at <= b
    }

    fn extension(&self, oid: ObjectIdentifier) -> Option<&x509_cert::ext::Extension> {
        self.cert
            .tbs_certificate
            .extensions
            .as_ref()?
            .iter()
            .find(|e| e.extn_id == oid)
    }

    /// Extended key usages (`None` when the extension is absent = unrestricted).
    pub fn extended_key_usage(&self) -> Option<Vec<ObjectIdentifier>> {
        let e = self.extension(oids::EXT_EXTENDED_KEY_USAGE)?;
        let eku = x509_cert::ext::pkix::ExtendedKeyUsage::from_der(e.extn_value.as_bytes()).ok()?;
        Some(eku.0)
    }

    /// Key usage bits (`None` when absent).
    pub fn key_usage(&self) -> Option<x509_cert::ext::pkix::KeyUsage> {
        let e = self.extension(oids::EXT_KEY_USAGE)?;
        x509_cert::ext::pkix::KeyUsage::from_der(e.extn_value.as_bytes()).ok()
    }

    /// basicConstraints cA flag.
    pub fn is_ca(&self) -> bool {
        self.extension(oids::EXT_BASIC_CONSTRAINTS)
            .and_then(|e| {
                x509_cert::ext::pkix::BasicConstraints::from_der(e.extn_value.as_bytes()).ok()
            })
            .is_some_and(|b| b.ca)
    }

    /// Whether the certificate is self-issued (subject == issuer).
    pub fn is_self_issued(&self) -> bool {
        self.subject() == self.issuer()
    }

    /// Subject key identifier bytes.
    pub fn subject_key_id(&self) -> Option<Vec<u8>> {
        let e = self.extension(oids::EXT_SUBJECT_KEY_ID)?;
        der::asn1::OctetString::from_der(e.extn_value.as_bytes())
            .ok()
            .map(|o| o.as_bytes().to_vec())
    }

    /// OCSP responder URLs from the Authority Information Access extension.
    pub fn ocsp_urls(&self) -> Vec<String> {
        self.aia(oids::AIA_OCSP)
    }

    /// CA-issuers URLs from the AIA extension.
    pub fn ca_issuer_urls(&self) -> Vec<String> {
        self.aia(oids::AIA_CA_ISSUERS)
    }

    fn aia(&self, method: ObjectIdentifier) -> Vec<String> {
        use x509_cert::ext::pkix::name::GeneralName;
        let Some(e) = self.extension(oids::EXT_AUTHORITY_INFO_ACCESS) else {
            return Vec::new();
        };
        let Ok(aia) =
            x509_cert::ext::pkix::AuthorityInfoAccessSyntax::from_der(e.extn_value.as_bytes())
        else {
            return Vec::new();
        };
        aia.0
            .iter()
            .filter(|a| a.access_method == method)
            .filter_map(|a| match &a.access_location {
                GeneralName::UniformResourceIdentifier(u) => Some(u.to_string()),
                _ => None,
            })
            .collect()
    }

    /// CRL distribution point URLs.
    pub fn crl_urls(&self) -> Vec<String> {
        use x509_cert::ext::pkix::name::{DistributionPointName, GeneralName};
        let Some(e) = self.extension(oids::EXT_CRL_DISTRIBUTION_POINTS) else {
            return Vec::new();
        };
        let Ok(dps) =
            x509_cert::ext::pkix::CrlDistributionPoints::from_der(e.extn_value.as_bytes())
        else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for dp in dps.0 {
            if let Some(DistributionPointName::FullName(names)) = dp.distribution_point {
                for n in names {
                    if let GeneralName::UniformResourceIdentifier(u) = n {
                        out.push(u.to_string());
                    }
                }
            }
        }
        out
    }

    /// The exact TBS bytes, the signature algorithm and the signature value.
    fn signed_parts(&self) -> Result<(&[u8], AlgorithmIdentifierOwned, Vec<u8>)> {
        let (outer, _) = tlv::read(&self.der)?;
        let kids = tlv::children(outer.content)?;
        let tbs = kids
            .first()
            .ok_or_else(|| SignError::Malformed("certificate".into()))?
            .raw;
        let sig = self
            .cert
            .signature
            .as_bytes()
            .ok_or_else(|| SignError::Malformed("certificate signature bits".into()))?
            .to_vec();
        Ok((tbs, self.cert.signature_algorithm.clone(), sig))
    }

    /// Whether `issuer`'s key verifies this certificate's signature.
    pub fn is_signed_by(&self, issuer_spki: &SubjectPublicKeyInfoOwned) -> bool {
        match self.signed_parts() {
            Ok((tbs, alg, sig)) => keys::verify_data(issuer_spki, &alg, tbs, &sig).is_ok(),
            Err(_) => false,
        }
    }

    /// SHA-256 of the DER.
    pub fn sha256(&self) -> Vec<u8> {
        crate::hash::HashAlg::Sha256.digest(&self.der)
    }
}

/// Value of the first attribute `oid` in `name`, decoded to a Rust string.
pub fn name_attr(name: &Name, oid: ObjectIdentifier) -> Option<String> {
    for rdn in name.0.iter() {
        for atv in rdn.0.iter() {
            if atv.oid == oid {
                return decode_directory_string(&atv.value);
            }
        }
    }
    None
}

/// Decode UTF8String / PrintableString / IA5String / BMPString / TeletexString.
pub fn decode_directory_string(v: &der::Any) -> Option<String> {
    let bytes = v.value();
    match v.tag() {
        der::Tag::Utf8String | der::Tag::PrintableString | der::Tag::Ia5String => {
            std::str::from_utf8(bytes).ok().map(str::to_string)
        }
        der::Tag::BmpString => {
            let units: Vec<u16> = bytes
                .chunks_exact(2)
                .map(|c| {
                    u16::from_be_bytes([
                        c.first().copied().unwrap_or(0),
                        c.get(1).copied().unwrap_or(0),
                    ])
                })
                .collect();
            Some(String::from_utf16_lossy(&units))
        }
        der::Tag::TeletexString => Some(bytes.iter().map(|b| char::from(*b)).collect()),
        _ => None,
    }
}

/// RFC 4514-like string with decoded (Unicode) values, most-specific first.
pub fn name_string(name: &Name) -> String {
    let mut parts = Vec::new();
    for rdn in name.0.iter().rev() {
        for atv in rdn.0.iter() {
            let key = match atv.oid {
                o if o == oids::AT_COMMON_NAME => "CN".to_string(),
                o if o == oids::AT_ORGANIZATION => "O".to_string(),
                o if o == oids::AT_ORG_UNIT => "OU".to_string(),
                o if o == oids::AT_COUNTRY => "C".to_string(),
                o if o == oids::AT_EMAIL => "E".to_string(),
                o => o.to_string(),
            };
            let val = decode_directory_string(&atv.value).unwrap_or_else(|| "?".into());
            parts.push(format!("{key}={val}"));
        }
    }
    parts.join(", ")
}

/// Decode standard base64 (padding optional).
pub fn base64_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut acc = 0u32;
    let mut bits = 0u32;
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => return None,
        };
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

/// Standard base64 with padding.
pub fn base64_encode(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [
            chunk.first().copied().unwrap_or(0),
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                let idx = ((n >> (18 - 6 * i)) & 63) as usize;
                s.push(char::from(T.get(idx).copied().unwrap_or(b'A')));
            } else {
                s.push('=');
            }
        }
    }
    s
}

/// A trust anchor: a subject name and key (a certificate or a webpki-roots entry).
#[derive(Clone, Debug)]
pub struct Anchor {
    /// DER of the subject Name.
    pub subject_der: Vec<u8>,
    /// Public key.
    pub spki: SubjectPublicKeyInfoOwned,
    /// The certificate when the anchor came from one.
    pub cert: Option<Cert>,
}

impl Anchor {
    /// From a certificate.
    pub fn from_cert(c: &Cert) -> Result<Anchor> {
        Ok(Anchor {
            subject_der: c
                .subject()
                .to_der()
                .map_err(|e| SignError::der("name", e))?,
            spki: c.spki().clone(),
            cert: Some(c.clone()),
        })
    }
}

/// The public web PKI roots, used ONLY to recognise timestamp authorities (never as
/// document signer trust).
pub fn tsa_anchors() -> Vec<Anchor> {
    webpki_roots::TLS_SERVER_ROOTS
        .iter()
        .filter_map(|ta| {
            // rustls-pki-types stores the Name and SPKI contents without their SEQUENCE header.
            let subject_der = tlv::encode(0x30, ta.subject.as_ref());
            let spki_der = tlv::encode(0x30, ta.subject_public_key_info.as_ref());
            let spki = SubjectPublicKeyInfoOwned::from_der(&spki_der).ok()?;
            Some(Anchor {
                subject_der,
                spki,
                cert: None,
            })
        })
        .collect()
}

/// Result of chain building.
#[derive(Debug, Clone)]
pub struct ChainResult {
    /// Leaf first; ends with the anchor certificate when it is known.
    pub path: Vec<Cert>,
    /// A trust anchor was reached with every signature verifying.
    pub trusted: bool,
    /// Problems found on the path (expired intermediate, not a CA…).
    pub problems: Vec<String>,
}

/// Build a chain from `leaf` through `pool` to one of `anchors`, checking signatures,
/// CA flags and validity at `at` (Unix seconds) for every issuer.
pub fn build_chain(leaf: &Cert, pool: &[Cert], anchors: &[Anchor], at: i64) -> ChainResult {
    let mut path = vec![leaf.clone()];
    let mut problems = Vec::new();
    let mut current = leaf.clone();
    for _ in 0..MAX_CHAIN {
        let issuer_der = match current.issuer().to_der() {
            Ok(d) => d,
            Err(_) => break,
        };
        // 1. An anchor that issued `current` (also covers `current` being the anchor itself).
        let anchor_hit = anchors
            .iter()
            .find(|a| a.subject_der == issuer_der && current.is_signed_by(&a.spki));
        if let Some(a) = anchor_hit {
            if let Some(ac) = &a.cert {
                if ac != &current {
                    if !ac.valid_at(at) {
                        problems.push(format!(
                            "root {} is not valid at the checked time",
                            ac.display_name()
                        ));
                    }
                    path.push(ac.clone());
                }
            }
            return ChainResult {
                path,
                trusted: problems.is_empty(),
                problems,
            };
        }
        if current.is_self_issued() {
            break;
        }
        // 2. An intermediate from the pool.
        let next = pool.iter().find(|c| {
            c != &&current
                && c.subject().to_der().ok().as_deref() == Some(issuer_der.as_slice())
                && current.is_signed_by(c.spki())
                && !path.contains(c)
        });
        let Some(next) = next else { break };
        if !next.is_ca() {
            problems.push(format!("{} is not a CA certificate", next.display_name()));
        }
        if let Some(ku) = next.key_usage() {
            if !ku.key_cert_sign() {
                problems.push(format!("{} may not sign certificates", next.display_name()));
            }
        }
        if !next.valid_at(at) {
            problems.push(format!(
                "{} is not valid at the checked time",
                next.display_name()
            ));
        }
        path.push(next.clone());
        current = next.clone();
    }
    ChainResult {
        path,
        trusted: false,
        problems,
    }
}

/// EKU policy for document signer certificates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EkuVerdict {
    /// No EKU extension (unrestricted) or an accepted usage is present.
    Accepted(String),
    /// Only usages not meant for documents (e.g. serverAuth).
    Rejected(String),
}

fn eku_name(o: &ObjectIdentifier) -> String {
    match *o {
        x if x == oids::EKU_DOCUMENT_SIGNING => "documentSigning".into(),
        x if x == oids::EKU_ADOBE_AUTHENTIC_DOCUMENTS => "Adobe authentic documents".into(),
        x if x == oids::EKU_EMAIL_PROTECTION => "emailProtection".into(),
        x if x == oids::EKU_ANY => "anyExtendedKeyUsage".into(),
        x if x == oids::EKU_SERVER_AUTH => "serverAuth".into(),
        x if x == oids::EKU_CLIENT_AUTH => "clientAuth".into(),
        x if x == oids::EKU_TIME_STAMPING => "timeStamping".into(),
        x if x == oids::EKU_OCSP_SIGNING => "OCSPSigning".into(),
        x if x == oids::EKU_MS_DOCUMENT_SIGNING => "Microsoft document signing".into(),
        x => x.to_string(),
    }
}

/// Accept document signing (1.3.6.1.5.5.7.3.36), Adobe authentic documents
/// (1.2.840.113583.1.1.5), emailProtection, anyExtendedKeyUsage — or no EKU at all.
/// Reject everything else (serverAuth-only certificates in particular). Key usage, when
/// present, must allow digitalSignature or nonRepudiation.
pub fn document_signing_policy(c: &Cert) -> EkuVerdict {
    if let Some(ku) = c.key_usage() {
        if !ku.digital_signature() && !ku.non_repudiation() {
            return EkuVerdict::Rejected("key usage does not allow signatures".into());
        }
    }
    let Some(ekus) = c.extended_key_usage() else {
        return EkuVerdict::Accepted("no extended key usage restriction".into());
    };
    let ok = [
        oids::EKU_DOCUMENT_SIGNING,
        oids::EKU_ADOBE_AUTHENTIC_DOCUMENTS,
        oids::EKU_EMAIL_PROTECTION,
        oids::EKU_ANY,
    ];
    if let Some(hit) = ekus.iter().find(|e| ok.contains(e)) {
        return EkuVerdict::Accepted(eku_name(hit));
    }
    let names: Vec<String> = ekus.iter().map(eku_name).collect();
    EkuVerdict::Rejected(format!(
        "certificate is not meant for signing documents (extended key usage: {})",
        names.join(", ")
    ))
}

/// Whether `c` carries the timeStamping EKU (required for TSA certificates).
pub fn is_tsa_cert(c: &Cert) -> bool {
    c.extended_key_usage()
        .is_some_and(|e| e.contains(&oids::EKU_TIME_STAMPING))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn base64_round_trip() {
        for data in [&b""[..], b"f", b"fo", b"foo", b"foob", b"fooba", b"foobar"] {
            assert_eq!(base64_decode(&base64_encode(data)).unwrap(), data);
        }
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
        assert!(base64_decode("@@").is_none());
    }

    #[test]
    fn webpki_roots_load_as_tsa_anchors() {
        let a = tsa_anchors();
        assert!(a.len() > 50, "{}", a.len());
    }
}
