//! Certificates, the path from a signer's up to one that is trusted, and
//! what is trusted for what.
//!
//! **Who signs a document** is vouched for only by a certificate the person
//! chose to trust on this device (their organisation's or their country's
//! certification authority, or a signer's own certificate). Mozilla's root
//! store (the `webpki-roots` data) is the list browsers trust *for web
//! sites*: its authorities check that someone controls a domain, not who a
//! person is, and anyone can get a certificate under them for free. A path
//! that ends there is reported as such (`Trust::WebRoot`) and does not make
//! a signer trusted — Acrobat, likewise, does not take the system's web
//! roots as signers unless told to.
//!
//! **A timestamp authority** may be trusted through Mozilla's roots: its
//! certificate must be for timestamping (RFC 3161's extended key usage), as
//! must every CA above it that restricts its purposes, and it vouches for a
//! time, not for a person.
//!
//! Along the path: each issuer must be a CA (basic constraints, and key
//! usage `keyCertSign` when it has one) within its path length; the leaf's
//! key must be allowed to sign; and its extended key usage, when it has one,
//! must allow the purpose — for documents `anyExtendedKeyUsage`,
//! `emailProtection`, `id-kp-documentSigning` (RFC 9336), Adobe's Authentic
//! Documents (1.2.840.113583.1.1.5) or Microsoft's Document Signing — and so
//! must every CA's on the way up that restricts it. A certificate the person
//! trusted itself is exempt from the purpose check: that is their choice.
//! Name constraints and certificate policies are not checked.
use der::{Decode, Encode};
use x509_cert::certificate::{CertificateInner, Raw};
use x509_cert::ext::pkix::name::{DistributionPointName, GeneralName};
use x509_cert::ext::pkix::{
    AuthorityInfoAccessSyntax, BasicConstraints, CrlDistributionPoints, ExtendedKeyUsage, KeyUsage,
    KeyUsages,
};

use crate::asn1::{children, read};
use crate::keys::{verify_message, SigAlg};
use crate::time::{iso, x509_unix};
use crate::{hex, oids, Result, SignError};

/// A certificate, parsed, with the exact bytes it was signed over.
#[derive(Clone)]
pub struct Cert {
    pub der: Vec<u8>,
    pub parsed: CertificateInner<Raw>,
    pub subject: Vec<u8>,
    pub issuer: Vec<u8>,
    pub spki: Vec<u8>,
    tbs: Vec<u8>,
}

impl std::fmt::Debug for Cert {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Cert({})", self.common_name())
    }
}

/// A `DirectoryString` (or any ASN.1 string) as text.
pub(crate) fn directory_string(tag: u8, value: &[u8]) -> String {
    match tag {
        // BMPString
        0x1e => String::from_utf16_lossy(
            &value
                .chunks(2)
                .map(|c| u16::from_be_bytes([c[0], *c.get(1).unwrap_or(&0)]))
                .collect::<Vec<_>>(),
        ),
        // UniversalString
        0x1c => value
            .chunks(4)
            .filter(|c| c.len() == 4)
            .map(|c| u32::from_be_bytes([c[0], c[1], c[2], c[3]]))
            .filter_map(char::from_u32)
            .collect(),
        // TeletexString, read as Latin-1
        0x14 => value.iter().map(|b| *b as char).collect(),
        _ => String::from_utf8_lossy(value).into_owned(),
    }
}

/// The value of attribute `oid` in a DER `Name`, if it has one.
pub(crate) fn name_attribute(name: &[u8], oid: &const_oid::ObjectIdentifier) -> Option<String> {
    let (seq, _) = read(name).ok()?;
    for rdn in children(seq.value).ok()? {
        for atv in children(rdn.value).ok()? {
            let parts = children(atv.value).ok()?;
            let (t, v) = (parts.first()?, parts.get(1)?);
            if const_oid::ObjectIdentifier::from_der(t.raw).ok().as_ref() == Some(oid) {
                return Some(directory_string(v.tag, v.value));
            }
        }
    }
    None
}

/// A name a person recognises: the common name, else the organisation, else
/// the whole distinguished name.
pub fn display_name(name: &[u8]) -> String {
    name_attribute(name, &oids::AT_COMMON_NAME)
        .or_else(|| name_attribute(name, &oids::AT_ORGANIZATION))
        .unwrap_or_else(|| {
            x509_cert::name::Name::from_der(name)
                .map(|n| n.to_string())
                .unwrap_or_default()
        })
}

impl Cert {
    pub fn parse(der: &[u8]) -> Result<Self> {
        let parsed = CertificateInner::<Raw>::from_der(der)
            .map_err(|e| SignError::Cms(format!("certificate: {e}")))?;
        let (outer, _) = read(der)?;
        let tbs = children(outer.value)?
            .first()
            .map(|t| t.raw.to_vec())
            .ok_or_else(|| SignError::Cms("certificate without content".into()))?;
        let tbs_c = &parsed.tbs_certificate;
        Ok(Self {
            der: der.to_vec(),
            subject: tbs_c.subject.to_der().map_err(crate::cms_err)?,
            issuer: tbs_c.issuer.to_der().map_err(crate::cms_err)?,
            spki: tbs_c
                .subject_public_key_info
                .to_der()
                .map_err(crate::cms_err)?,
            tbs,
            parsed,
        })
    }

    pub fn common_name(&self) -> String {
        display_name(&self.subject)
    }

    pub fn issuer_name(&self) -> String {
        display_name(&self.issuer)
    }

    pub fn subject_dn(&self) -> String {
        self.parsed.tbs_certificate.subject.to_string()
    }

    pub fn serial_hex(&self) -> String {
        hex(self.parsed.tbs_certificate.serial_number.as_bytes())
    }

    pub fn not_before(&self) -> i64 {
        x509_unix(&self.parsed.tbs_certificate.validity.not_before)
    }

    pub fn not_after(&self) -> i64 {
        x509_unix(&self.parsed.tbs_certificate.validity.not_after)
    }

    pub fn valid_at(&self, at: i64) -> bool {
        self.not_before() <= at && at <= self.not_after()
    }

    fn extension<T: for<'a> Decode<'a>>(&self, oid: &const_oid::ObjectIdentifier) -> Option<T> {
        self.parsed
            .tbs_certificate
            .extensions
            .as_ref()?
            .iter()
            .find(|e| e.extn_id == *oid)
            .and_then(|e| T::from_der(e.extn_value.as_bytes()).ok())
    }

    pub fn is_ca(&self) -> bool {
        self.extension::<BasicConstraints>(&oids::EXT_BASIC_CONSTRAINTS)
            .is_some_and(|b| b.ca)
    }

    /// Whether it may issue certificates: a CA, and — when it has a key
    /// usage — one that includes `keyCertSign`.
    pub fn may_issue(&self) -> bool {
        self.is_ca()
            && self
                .extension::<KeyUsage>(&oids::EXT_KEY_USAGE)
                .is_none_or(|ku| ku.0.contains(KeyUsages::KeyCertSign))
    }

    /// How many CAs may stand below it (basic constraints' `pathLenConstraint`).
    pub fn path_len(&self) -> Option<u32> {
        self.extension::<BasicConstraints>(&oids::EXT_BASIC_CONSTRAINTS)
            .and_then(|b| b.path_len_constraint.map(u32::from))
    }

    /// Whether it says anything about being a CA or not.
    fn has_basic_constraints(&self) -> bool {
        self.parsed
            .tbs_certificate
            .extensions
            .as_ref()
            .is_some_and(|e| e.iter().any(|e| e.extn_id == oids::EXT_BASIC_CONSTRAINTS))
    }

    fn restricts_purposes(&self) -> bool {
        self.extension::<ExtendedKeyUsage>(&oids::EXT_EXTENDED_KEY_USAGE)
            .is_some()
    }

    /// Whether its extended key usage allows `purpose`. Without one, a
    /// certificate may sign documents (RFC 5280) but is no timestamp
    /// authority (RFC 3161 requires the purpose).
    pub fn allows(&self, purpose: Purpose) -> bool {
        match self.extension::<ExtendedKeyUsage>(&oids::EXT_EXTENDED_KEY_USAGE) {
            None => purpose == Purpose::Documents,
            Some(eku) => eku.0.iter().any(|oid| purpose.accepts(oid)),
        }
    }

    /// Whether its extended key usage names web servers.
    pub fn for_web_servers(&self) -> bool {
        self.extended_key_usage().contains(&oids::KP_SERVER_AUTH)
    }

    /// The digest its issuer signed it with.
    pub fn signature_hash(&self) -> Option<crate::HashAlg> {
        let alg = &self.parsed.signature_algorithm;
        let params = alg.parameters.as_ref().and_then(|p| p.to_der().ok());
        match SigAlg::from_identifier(&alg.oid, params.as_deref(), None).ok()? {
            SigAlg::RsaPkcs1(h) | SigAlg::Ecdsa(h) | SigAlg::RsaPss { hash: h, .. } => Some(h),
        }
    }

    pub fn self_issued(&self) -> bool {
        self.subject == self.issuer
    }

    /// Whether the key may make signatures on documents: no key usage at all,
    /// or digital signature or non-repudiation among them.
    pub fn may_sign_documents(&self) -> bool {
        match self.extension::<KeyUsage>(&oids::EXT_KEY_USAGE) {
            None => true,
            Some(ku) => {
                ku.0.contains(KeyUsages::DigitalSignature)
                    || ku.0.contains(KeyUsages::NonRepudiation)
            }
        }
    }

    pub fn extended_key_usage(&self) -> Vec<const_oid::ObjectIdentifier> {
        self.extension::<ExtendedKeyUsage>(&oids::EXT_EXTENDED_KEY_USAGE)
            .map(|e| e.0)
            .unwrap_or_default()
    }

    fn access(&self, method: &const_oid::ObjectIdentifier) -> Vec<String> {
        self.extension::<AuthorityInfoAccessSyntax>(&oids::EXT_AUTHORITY_INFO_ACCESS)
            .map(|aia| {
                aia.0
                    .into_iter()
                    .filter(|a| a.access_method == *method)
                    .filter_map(|a| match a.access_location {
                        GeneralName::UniformResourceIdentifier(uri) => Some(uri.to_string()),
                        _ => None,
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Where the issuer answers OCSP about this certificate.
    pub fn ocsp_urls(&self) -> Vec<String> {
        self.access(&oids::AD_OCSP)
    }

    /// Where the issuer's own certificate can be fetched.
    pub fn ca_issuer_urls(&self) -> Vec<String> {
        self.access(&oids::AD_CA_ISSUERS)
    }

    /// Where the issuer publishes its revocation list.
    pub fn crl_urls(&self) -> Vec<String> {
        let Some(points) =
            self.extension::<CrlDistributionPoints>(&oids::EXT_CRL_DISTRIBUTION_POINTS)
        else {
            return Vec::new();
        };
        points
            .0
            .into_iter()
            .filter_map(|p| match p.distribution_point {
                Some(DistributionPointName::FullName(names)) => Some(names),
                _ => None,
            })
            .flatten()
            .filter_map(|n| match n {
                GeneralName::UniformResourceIdentifier(uri) => Some(uri.to_string()),
                _ => None,
            })
            .collect()
    }

    /// The kind of key the certificate is for, when it is one this crate
    /// signs with (a smart card's key is known only by its certificate).
    pub fn key_kind(&self) -> Option<crate::keys::KeyKind> {
        use pkcs8::DecodePublicKey;
        let alg = &self
            .parsed
            .tbs_certificate
            .subject_public_key_info
            .algorithm;
        if alg.oid == oids::RSA_ENCRYPTION {
            let key = rsa::RsaPublicKey::from_public_key_der(&self.spki).ok()?;
            return Some(crate::keys::KeyKind::Rsa {
                bits: rsa::traits::PublicKeyParts::size(&key) * 8,
            });
        }
        if alg.oid == oids::EC_PUBLIC_KEY {
            let curve = alg
                .parameters
                .as_ref()?
                .decode_as::<const_oid::ObjectIdentifier>()
                .ok()?;
            return match curve {
                c if c == oids::SECP256R1 => Some(crate::keys::KeyKind::P256),
                c if c == oids::SECP384R1 => Some(crate::keys::KeyKind::P384),
                _ => None,
            };
        }
        None
    }

    /// Whether `issuer_spki`'s key signed this certificate.
    pub fn signed_by(&self, issuer_spki: &[u8]) -> bool {
        let alg = &self.parsed.signature_algorithm;
        let params = alg.parameters.as_ref().and_then(|p| p.to_der().ok());
        let Ok(sig_alg) = SigAlg::from_identifier(&alg.oid, params.as_deref(), None) else {
            return false;
        };
        let Some(signature) = self.parsed.signature.as_bytes() else {
            return false;
        };
        verify_message(issuer_spki, sig_alg, &self.tbs, signature).is_ok()
    }

    pub fn summary(&self) -> CertSummary {
        CertSummary {
            name: self.common_name(),
            subject: self.subject_dn(),
            issuer: self.issuer_name(),
            serial: self.serial_hex(),
            not_before: iso(self.not_before()),
            not_after: iso(self.not_after()),
            ca: self.is_ca(),
        }
    }
}

/// What the interface shows of a certificate.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CertSummary {
    pub name: String,
    pub subject: String,
    pub issuer: String,
    pub serial: String,
    pub not_before: String,
    pub not_after: String,
    pub ca: bool,
}

/// What a certificate is trusted for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Purpose {
    /// Signing documents: a PDF signature's signer.
    Documents,
    /// Timestamping: the authority behind a timestamp token.
    Timestamps,
}

impl Purpose {
    /// Whether an extended key usage allows this purpose.
    fn accepts(self, oid: &const_oid::ObjectIdentifier) -> bool {
        *oid == oids::ANY_EXTENDED_KEY_USAGE
            || match self {
                Purpose::Documents => [
                    oids::KP_EMAIL_PROTECTION,
                    oids::KP_DOCUMENT_SIGNING,
                    oids::ADOBE_AUTHENTIC_DOCUMENTS,
                    oids::MS_DOCUMENT_SIGNING,
                ]
                .contains(oid),
                Purpose::Timestamps => *oid == oids::KP_TIME_STAMPING,
            }
    }
}

/// A certificate that is trusted without anything above it.
#[derive(Clone)]
pub struct Anchor {
    pub subject: Vec<u8>,
    pub spki: Vec<u8>,
    pub name: String,
    /// The person trusted it on this device (else it is one of Mozilla's).
    pub user: bool,
    /// The certificate itself, for an anchor the person added.
    pub cert: Option<Vec<u8>>,
    /// It may issue certificates: a root, or a CA the person trusted — not a
    /// signer's own certificate the person trusted.
    pub issues: bool,
    pub path_len: Option<u32>,
}

impl Anchor {
    /// One of Mozilla's roots, known by its name and key.
    pub fn web_root(subject: Vec<u8>, spki: Vec<u8>) -> Self {
        Self {
            name: display_name(&subject),
            subject,
            spki,
            user: false,
            cert: None,
            issues: true,
            path_len: None,
        }
    }
}

#[derive(Clone, Default)]
pub struct TrustStore {
    pub anchors: Vec<Anchor>,
}

fn sequence(contents: &[u8]) -> Vec<u8> {
    crate::asn1::wrap(0x30, contents)
}

impl TrustStore {
    /// Mozilla's roots. `webpki-roots` keeps each name and key without its
    /// outer SEQUENCE, which is put back here.
    pub fn mozilla() -> Self {
        let anchors = webpki_roots::TLS_SERVER_ROOTS
            .iter()
            .map(|a| {
                Anchor::web_root(
                    sequence(a.subject.as_ref()),
                    sequence(a.subject_public_key_info.as_ref()),
                )
            })
            .collect();
        Self { anchors }
    }

    /// A certificate the person trusts, as an anchor. It issues others only
    /// if it is a CA — or an old root that says nothing either way.
    pub fn add_user(&mut self, der: &[u8]) -> Result<()> {
        let cert = Cert::parse(der)?;
        let issues = cert.may_issue() || (cert.self_issued() && !cert.has_basic_constraints());
        self.anchors.push(Anchor {
            name: cert.common_name(),
            subject: cert.subject.clone(),
            spki: cert.spki.clone(),
            user: true,
            cert: Some(der.to_vec()),
            issues,
            path_len: cert.path_len(),
        });
        Ok(())
    }

    fn user_exact(&self, der: &[u8]) -> Option<&Anchor> {
        self.anchors
            .iter()
            .find(|a| a.user && a.cert.as_deref() == Some(der))
    }
}

/// How far trust reaches.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Trust {
    /// The path ends at a certificate trusted for the purpose: one the
    /// person trusts (`user`), or — for a timestamp authority only — one of
    /// Mozilla's roots.
    Trusted { anchor: String, user: bool },
    /// It ends at one of Mozilla's roots, which browsers trust for web
    /// sites: that does not say who signed a document.
    WebRoot { anchor: String },
    /// It ends at a root nobody here trusts.
    UntrustedRoot { root: String },
    /// A certificate on it may not issue the one below it.
    Broken { name: String },
    /// A certificate above could not be found.
    Incomplete { missing: String },
}

/// A path from a certificate upwards, and what was wrong along it.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainReport {
    /// Signer first.
    pub certs: Vec<CertSummary>,
    pub trust: Trust,
    /// Every certificate on the path was valid at the time asked about.
    pub valid_at_time: bool,
    /// Problem codes: `expired:<name>`, `notYetValid:<name>`, `notCa:<name>`,
    /// `pathLen:<name>`, `keyUsage`, `eku` (`eku:web` for a web server's),
    /// `ekuCa:<name>`, `issuerSignature:<name>`, `weakHash:<name>`.
    pub problems: Vec<String>,
    /// The leaf, and every CA above it that restricts purposes, allow the
    /// one asked about (or the person trusted the leaf itself).
    pub purpose_ok: bool,
    /// DER of the path (not serialised), for revocation checks.
    #[serde(skip)]
    pub path: Vec<Cert>,
}

impl ChainReport {
    /// Trusted for the purpose it was built for.
    pub fn trusted(&self) -> bool {
        matches!(self.trust, Trust::Trusted { .. }) && self.purpose_ok
    }
}

/// The path from `leaf` up through `pool` to a trust anchor, checked at
/// `at` (Unix seconds) for `purpose`: each signature, each validity period,
/// that each issuer may issue (a CA, within its path length), that the
/// leaf's key may sign, and that the purposes allow `purpose`.
pub fn build(
    leaf: &Cert,
    pool: &[Cert],
    store: &TrustStore,
    at: i64,
    purpose: Purpose,
) -> ChainReport {
    let mut path = vec![leaf.clone()];
    let mut problems = Vec::new();
    // Whether an issuer with `path_len` may have `below` CAs under it.
    let within = |path_len: Option<u32>, below: usize| path_len.is_none_or(|n| below <= n as usize);
    // The person trusted the leaf itself.
    let mut exact = false;
    let trust = loop {
        let current = path.last().expect("never empty");
        // The CAs on the path under the issuer about to be found (the leaf is none).
        let below = path.len() - 1;
        if path.len() > 12 {
            break Trust::Incomplete {
                missing: current.issuer_name(),
            };
        }
        if let Some(anchor) = store.user_exact(&current.der) {
            exact = path.len() == 1;
            break Trust::Trusted {
                anchor: anchor.name.clone(),
                user: true,
            };
        }
        if let Some(anchor) = store
            .anchors
            .iter()
            .find(|a| a.subject == current.issuer && current.signed_by(&a.spki))
        {
            if !anchor.issues || !within(anchor.path_len, below) {
                let code = if anchor.issues { "pathLen" } else { "notCa" };
                problems.push(format!("{code}:{}", anchor.name));
                break Trust::Broken {
                    name: anchor.name.clone(),
                };
            }
            break match (anchor.user, purpose) {
                (true, _) | (false, Purpose::Timestamps) => Trust::Trusted {
                    anchor: anchor.name.clone(),
                    user: anchor.user,
                },
                (false, Purpose::Documents) => Trust::WebRoot {
                    anchor: anchor.name.clone(),
                },
            };
        }
        if current.self_issued() {
            break Trust::UntrustedRoot {
                root: current.common_name(),
            };
        }
        let candidates: Vec<&Cert> = pool
            .iter()
            .filter(|c| c.subject == current.issuer)
            .collect();
        match candidates
            .iter()
            .find(|c| current.signed_by(&c.spki) && !path.iter().any(|p| p.der == c.der))
        {
            Some(issuer) => {
                let issuer = (*issuer).clone();
                // A certificate that may not issue signed the one below it:
                // the path is forged or broken, however high it would reach.
                if !issuer.may_issue() || !within(issuer.path_len(), below) {
                    let code = if issuer.may_issue() {
                        "pathLen"
                    } else {
                        "notCa"
                    };
                    let name = issuer.common_name();
                    problems.push(format!("{code}:{name}"));
                    path.push(issuer);
                    break Trust::Broken { name };
                }
                path.push(issuer);
            }
            None => {
                if !candidates.is_empty() {
                    problems.push(format!("issuerSignature:{}", current.common_name()));
                }
                break Trust::Incomplete {
                    missing: current.issuer_name(),
                };
            }
        }
    };
    let mut valid = true;
    for cert in &path {
        if at < cert.not_before() {
            problems.push(format!("notYetValid:{}", cert.common_name()));
            valid = false;
        } else if at > cert.not_after() {
            problems.push(format!("expired:{}", cert.common_name()));
            valid = false;
        }
    }
    if !leaf.may_sign_documents() {
        problems.push("keyUsage".into());
    }
    // What the certificates are for: the leaf's purposes, and those of every
    // CA above it that restricts them. A leaf the person trusted itself is
    // their own decision about it.
    let mut purpose_ok = true;
    if !exact {
        if !leaf.allows(purpose) {
            purpose_ok = false;
            problems.push(if leaf.for_web_servers() {
                "eku:web".into()
            } else {
                "eku".into()
            });
        }
        for ca in path.iter().skip(1) {
            if ca.restricts_purposes() && !ca.allows(purpose) {
                purpose_ok = false;
                problems.push(format!("ekuCa:{}", ca.common_name()));
            }
        }
    }
    // SHA-1 under the anchor: a collision could have made any of them.
    for cert in &path {
        if !cert.self_issued() && cert.signature_hash() == Some(crate::HashAlg::Sha1) {
            problems.push(format!("weakHash:{}", cert.common_name()));
        }
    }
    ChainReport {
        certs: path.iter().map(Cert::summary).collect(),
        trust,
        valid_at_time: valid,
        problems,
        purpose_ok,
        path,
    }
}

/// `others` ordered from `leaf` upwards as far as they chain (nearest
/// first), then whatever did not chain, as it came.
pub fn order_above(leaf: &[u8], others: Vec<Vec<u8>>) -> Vec<Vec<u8>> {
    let mut rest: Vec<(Vec<u8>, Option<Cert>)> = others
        .into_iter()
        .map(|der| {
            let parsed = Cert::parse(&der).ok();
            (der, parsed)
        })
        .collect();
    let mut out = Vec::new();
    let Ok(mut current) = Cert::parse(leaf) else {
        return rest.into_iter().map(|(d, _)| d).collect();
    };
    while !current.self_issued() {
        let Some(i) = rest
            .iter()
            .position(|(_, c)| c.as_ref().is_some_and(|c| c.subject == current.issuer))
        else {
            break;
        };
        let (der, parsed) = rest.remove(i);
        out.push(der);
        current = parsed.expect("matched above");
    }
    out.extend(rest.into_iter().map(|(d, _)| d));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> Cert {
        let der = std::fs::read(format!(
            "{}/../../../tests/fixtures/signatures/{name}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap();
        Cert::parse(&der).unwrap()
    }

    const NOW: i64 = 1_800_000_000; // 2027-01-15

    #[test]
    fn a_test_chain_is_untrusted_until_its_root_is_trusted() {
        let leaf = fixture("signer-rsa.cer");
        assert_eq!(leaf.common_name(), "محمد التجريبي (TEST)");
        let pool = [fixture("intermediate-rsa.cer"), fixture("root-rsa.cer")];
        let report = build(
            &leaf,
            &pool,
            &TrustStore::mozilla(),
            NOW,
            Purpose::Documents,
        );
        assert_eq!(report.certs.len(), 3);
        assert_eq!(
            report.trust,
            Trust::UntrustedRoot {
                root: "Warraq TEST Root CA RSA".into()
            }
        );
        assert!(report.valid_at_time, "{:?}", report.problems);

        let mut store = TrustStore::mozilla();
        store.add_user(&fixture("root-rsa.cer").der).unwrap();
        let report = build(&leaf, &pool[..1], &store, NOW, Purpose::Documents);
        assert!(report.trusted(), "{:?}", report.trust);
        assert_eq!(report.certs.len(), 2, "the root came from the trust list");
    }

    #[test]
    fn ec_chains_verify_and_time_is_checked() {
        let leaf = fixture("signer-ec384.cer");
        let pool = [fixture("root-ec.cer"), fixture("intermediate-ec.cer")];
        let report = build(
            &leaf,
            &pool,
            &TrustStore::default(),
            NOW,
            Purpose::Documents,
        );
        assert_eq!(report.certs.len(), 3, "{:?}", report.problems);
        assert!(report.problems.is_empty(), "{:?}", report.problems);
        let old = build(
            &leaf,
            &pool,
            &TrustStore::default(),
            1_000_000_000,
            Purpose::Documents,
        );
        assert!(!old.valid_at_time);
        assert!(old.problems.iter().any(|p| p.starts_with("notYetValid:")));
    }

    #[test]
    fn a_missing_intermediate_is_reported_and_urls_are_read() {
        let leaf = fixture("signer-rsa.cer");
        let report = build(&leaf, &[], &TrustStore::mozilla(), NOW, Purpose::Documents);
        assert_eq!(
            report.trust,
            Trust::Incomplete {
                missing: "Warraq TEST Intermediate CA RSA".into()
            }
        );
        assert_eq!(
            leaf.ocsp_urls(),
            ["http://ocsp.warraq.test/intermediate-rsa"]
        );
        assert_eq!(
            leaf.crl_urls(),
            ["http://crl.warraq.test/intermediate-rsa.crl"]
        );
        assert_eq!(
            leaf.ca_issuer_urls(),
            ["http://ca.warraq.test/intermediate-rsa.cer"]
        );
        assert!(TrustStore::mozilla().anchors.len() > 100);
    }

    #[test]
    fn the_key_behind_a_certificate_is_named() {
        use crate::keys::KeyKind;
        assert_eq!(
            fixture("signer-rsa.cer").key_kind(),
            Some(KeyKind::Rsa { bits: 2048 })
        );
        assert_eq!(fixture("signer-ec.cer").key_kind(), Some(KeyKind::P256));
        assert_eq!(fixture("signer-ec384.cer").key_kind(), Some(KeyKind::P384));
    }
}
