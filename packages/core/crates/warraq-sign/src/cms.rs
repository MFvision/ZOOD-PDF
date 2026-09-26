//! CMS SignedData: building CAdES-detached signatures (PAdES baseline) and parsing /
//! verifying signatures from documents.
//!
//! Verification works on the ORIGINAL bytes: the signed attributes are re-tagged from `[0]`
//! to `SET` exactly as received (RFC 5652 §5.4), certificates keep their received DER.

use crate::error::{Result, SignError};
use crate::hash::HashAlg;
use crate::keys;
use crate::limits::{MAX_CERTS, MAX_CMS_SIZE};
use crate::oids;
use crate::signer::Signer;
use crate::tlv;
use crate::x509::Cert;
use cms::cert::{CertificateChoices, IssuerAndSerialNumber};
use cms::content_info::{CmsVersion, ContentInfo};
use cms::signed_data::{
    CertificateSet, EncapsulatedContentInfo, SignedData, SignerIdentifier, SignerInfo, SignerInfos,
};
use der::asn1::{ObjectIdentifier, OctetString, SetOfVec};
use der::{Any, Decode, Encode, Sequence};
use spki::AlgorithmIdentifierOwned;
use x509_cert::attr::Attribute;
use x509_cert::ext::pkix::name::GeneralName;
use x509_cert::serial_number::SerialNumber;

/// ESS `IssuerSerial`.
#[derive(Clone, Debug, Eq, PartialEq, Sequence)]
pub struct IssuerSerial {
    /// Issuer as GeneralNames.
    pub issuer: Vec<GeneralName>,
    /// Serial.
    pub serial_number: SerialNumber,
}

/// ESS `ESSCertIDv2` (RFC 5035).
#[derive(Clone, Debug, Eq, PartialEq, Sequence)]
pub struct EssCertIdV2 {
    /// DEFAULT sha256 (omitted then).
    #[asn1(optional = "true")]
    pub hash_algorithm: Option<AlgorithmIdentifierOwned>,
    /// Hash of the certificate DER.
    pub cert_hash: OctetString,
    /// Issuer and serial.
    #[asn1(optional = "true")]
    pub issuer_serial: Option<IssuerSerial>,
}

/// ESS `SigningCertificateV2`.
#[derive(Clone, Debug, Eq, PartialEq, Sequence)]
pub struct SigningCertificateV2 {
    /// Certificate identifiers; the first is the signer.
    pub certs: Vec<EssCertIdV2>,
    /// Policies (ignored).
    #[asn1(optional = "true")]
    pub policies: Option<Vec<Any>>,
}

/// ESS `ESSCertID` (v1, SHA-1).
#[derive(Clone, Debug, Eq, PartialEq, Sequence)]
pub struct EssCertId {
    /// SHA-1 of the certificate.
    pub cert_hash: OctetString,
    /// Issuer and serial.
    #[asn1(optional = "true")]
    pub issuer_serial: Option<IssuerSerial>,
}

/// ESS `SigningCertificate` (v1).
#[derive(Clone, Debug, Eq, PartialEq, Sequence)]
pub struct SigningCertificate {
    /// Identifiers.
    pub certs: Vec<EssCertId>,
    /// Policies (ignored).
    #[asn1(optional = "true")]
    pub policies: Option<Vec<Any>>,
}

fn attr(oid: ObjectIdentifier, value: Any) -> Result<Attribute> {
    let mut values = SetOfVec::new();
    values
        .insert(value)
        .map_err(|e| SignError::der("attribute", e))?;
    Ok(Attribute { oid, values })
}

fn any_of<T: Encode>(v: &T) -> Result<Any> {
    let d = v.to_der().map_err(|e| SignError::der("encode", e))?;
    Any::from_der(&d).map_err(|e| SignError::der("encode", e))
}

fn digest_alg(hash: HashAlg) -> AlgorithmIdentifierOwned {
    // RFC 5754: parameters absent for SHA-2.
    AlgorithmIdentifierOwned {
        oid: hash.oid(),
        parameters: None,
    }
}

/// `signingCertificateV2` for `cert` (SHA-256, with issuerSerial).
pub fn signing_certificate_v2(cert: &Cert) -> Result<Attribute> {
    let id = EssCertIdV2 {
        hash_algorithm: None,
        cert_hash: OctetString::new(cert.sha256()).map_err(|e| SignError::der("hash", e))?,
        issuer_serial: Some(IssuerSerial {
            issuer: vec![GeneralName::DirectoryName(cert.issuer().clone())],
            serial_number: cert.cert.tbs_certificate.serial_number.clone(),
        }),
    };
    let v = SigningCertificateV2 {
        certs: vec![id],
        policies: None,
    };
    attr(oids::SIGNING_CERTIFICATE_V2, any_of(&v)?)
}

/// Build a detached CAdES SignedData (as a ContentInfo DER) over content whose digest is
/// `content_digest`. Signed attributes: contentType (id-data), messageDigest,
/// signingCertificateV2, plus `extra`. No signing-time (PAdES uses the dictionary's /M).
pub fn build_signed_data(
    signer: &dyn Signer,
    content_digest: &[u8],
    extra: Vec<Attribute>,
) -> Result<Vec<u8>> {
    let hash = signer.digest_algorithm();
    if content_digest.len() != hash.output_len() {
        return Err(SignError::InvalidArgument("content digest length".into()));
    }
    let cert = signer.certificate();
    let mut attrs = SetOfVec::new();
    let ins = |set: &mut SetOfVec<Attribute>, a: Attribute| {
        set.insert(a)
            .map_err(|e| SignError::der("signed attributes", e))
    };
    ins(&mut attrs, attr(oids::CONTENT_TYPE, any_of(&oids::DATA)?)?)?;
    ins(
        &mut attrs,
        attr(
            oids::MESSAGE_DIGEST,
            any_of(&OctetString::new(content_digest).map_err(|e| SignError::der("digest", e))?)?,
        )?,
    )?;
    ins(&mut attrs, signing_certificate_v2(cert)?)?;
    for a in extra {
        ins(&mut attrs, a)?;
    }
    let attrs_der = attrs
        .to_der()
        .map_err(|e| SignError::der("signed attributes", e))?;
    let sig = signer.sign_digest(hash, &hash.digest(&attrs_der))?;
    let si = SignerInfo {
        version: CmsVersion::V1,
        sid: SignerIdentifier::IssuerAndSerialNumber(IssuerAndSerialNumber {
            issuer: cert.issuer().clone(),
            serial_number: cert.cert.tbs_certificate.serial_number.clone(),
        }),
        digest_alg: digest_alg(hash),
        signed_attrs: Some(attrs),
        signature_algorithm: signer.key_algorithm().signature_algorithm(hash)?,
        signature: OctetString::new(sig).map_err(|e| SignError::der("signature", e))?,
        unsigned_attrs: None,
    };
    let mut certs = Vec::new();
    for c in std::iter::once(cert).chain(signer.chain().iter()) {
        certs.push(CertificateChoices::Certificate(c.cert.clone()));
    }
    let mut dalgs = SetOfVec::new();
    dalgs
        .insert(digest_alg(hash))
        .map_err(|e| SignError::der("digest algorithms", e))?;
    let sd = SignedData {
        version: CmsVersion::V1,
        digest_algorithms: dalgs,
        encap_content_info: EncapsulatedContentInfo {
            econtent_type: oids::DATA,
            econtent: None,
        },
        certificates: Some(
            CertificateSet::try_from(certs).map_err(|e| SignError::der("certificates", e))?,
        ),
        crls: None,
        signer_infos: SignerInfos::try_from(vec![si])
            .map_err(|e| SignError::der("signer infos", e))?,
    };
    wrap_signed_data(&sd)
}

fn wrap_signed_data(sd: &SignedData) -> Result<Vec<u8>> {
    let ci = ContentInfo {
        content_type: oids::SIGNED_DATA,
        content: any_of(sd)?,
    };
    ci.to_der().map_err(|e| SignError::der("ContentInfo", e))
}

/// Add (or replace) unsigned attribute `oid` with `value` on the first SignerInfo.
pub fn set_unsigned_attr(cms_der: &[u8], oid: ObjectIdentifier, value: Any) -> Result<Vec<u8>> {
    let parsed = ParsedCms::parse(cms_der)?;
    let mut sd = parsed.signed_data;
    let mut infos: Vec<SignerInfo> = sd.signer_infos.0.iter().cloned().collect();
    let first = infos
        .first_mut()
        .ok_or_else(|| SignError::Malformed("CMS without signer".into()))?;
    let mut ua = SetOfVec::new();
    if let Some(old) = &first.unsigned_attrs {
        for a in old.iter().filter(|a| a.oid != oid) {
            ua.insert(a.clone())
                .map_err(|e| SignError::der("unsigned attributes", e))?;
        }
    }
    ua.insert(attr(oid, value)?)
        .map_err(|e| SignError::der("unsigned attributes", e))?;
    first.unsigned_attrs = Some(ua);
    sd.signer_infos =
        SignerInfos::try_from(infos).map_err(|e| SignError::der("signer infos", e))?;
    let out = wrap_signed_data(&sd)?;
    // The signed attributes must survive the round trip byte for byte.
    let check = ParsedCms::parse(&out)?;
    if check.signed_attrs_raw != parsed.signed_attrs_raw {
        return Err(SignError::Malformed(
            "signed attributes are not DER; cannot add an unsigned attribute".into(),
        ));
    }
    Ok(out)
}

/// A parsed CMS SignedData with the raw pieces verification needs.
#[derive(Debug, Clone)]
pub struct ParsedCms {
    /// Typed form.
    pub signed_data: SignedData,
    /// The DER bytes (BER input normalised).
    pub der: Vec<u8>,
    /// `SET` + signed attributes exactly as received (tag 0xA0 replaced by 0x31).
    pub signed_attrs_raw: Option<Vec<u8>>,
    /// Certificates exactly as received.
    pub certs: Vec<Cert>,
    /// Encapsulated content bytes (OCTET STRING value), when present.
    pub econtent: Option<Vec<u8>>,
}

impl ParsedCms {
    /// Parse a ContentInfo(SignedData). Trailing bytes (the zero padding of `/Contents`)
    /// are ignored.
    pub fn parse(bytes: &[u8]) -> Result<ParsedCms> {
        if bytes.len() > MAX_CMS_SIZE {
            return Err(SignError::Limit("CMS too large".into()));
        }
        let len = tlv::element_len(bytes)?;
        let head = bytes
            .get(..len)
            .ok_or_else(|| SignError::Malformed("CMS".into()))?;
        let der = if ContentInfo::from_der(head).is_ok() {
            head.to_vec()
        } else {
            tlv::ber_to_der(head)?
        };
        let ci = ContentInfo::from_der(&der).map_err(|e| SignError::der("CMS", e))?;
        if ci.content_type != oids::SIGNED_DATA {
            return Err(SignError::Unsupported(format!(
                "CMS content type {}",
                ci.content_type
            )));
        }
        // Raw walk: ContentInfo { oid, [0] { SignedData } }.
        let (outer, _) = tlv::read(&der)?;
        let parts = tlv::children(outer.content)?;
        let wrapper = parts
            .get(1)
            .ok_or_else(|| SignError::Malformed("CMS content".into()))?;
        let (sd_tlv, _) = tlv::read(wrapper.content)?;
        let sd = SignedData::from_der(sd_tlv.raw).map_err(|e| SignError::der("SignedData", e))?;
        let fields = tlv::children(sd_tlv.content)?;
        let mut certs = Vec::new();
        let mut signer_set = None;
        let mut econtent = None;
        for f in &fields {
            match f.tag {
                0xA0 => {
                    for c in tlv::children(f.content)? {
                        if c.tag == 0x30 {
                            certs.push(Cert::from_der(c.raw)?);
                            if certs.len() > MAX_CERTS {
                                return Err(SignError::Limit("too many certificates".into()));
                            }
                        }
                    }
                }
                0x31 => signer_set = Some(*f),
                0x30 => {
                    // EncapsulatedContentInfo { oid, [0] EXPLICIT OCTET STRING }
                    let e = tlv::children(f.content)?;
                    if let Some(w) = e.get(1) {
                        if w.tag == 0xA0 {
                            let (os, _) = tlv::read(w.content)?;
                            if os.tag == 0x04 {
                                econtent = Some(os.content.to_vec());
                            }
                        }
                    }
                }
                _ => {}
            }
        }
        let mut signed_attrs_raw = None;
        if let Some(set) = signer_set {
            if let Some(first) = tlv::children(set.content)?.first() {
                for f in tlv::children(first.content)? {
                    if f.tag == 0xA0 {
                        let mut raw = f.raw.to_vec();
                        if let Some(t) = raw.first_mut() {
                            *t = 0x31;
                        }
                        signed_attrs_raw = Some(raw);
                        break;
                    }
                }
            }
        }
        Ok(ParsedCms {
            signed_data: sd,
            der,
            signed_attrs_raw,
            certs,
            econtent,
        })
    }

    /// The first SignerInfo.
    pub fn signer_info(&self) -> Result<&SignerInfo> {
        self.signed_data
            .signer_infos
            .0
            .iter()
            .next()
            .ok_or_else(|| SignError::Malformed("CMS without signer".into()))
    }

    /// The signer certificate (matched by issuer+serial or subject key identifier).
    pub fn signer_cert(&self) -> Result<Option<&Cert>> {
        let si = self.signer_info()?;
        Ok(match &si.sid {
            SignerIdentifier::IssuerAndSerialNumber(ias) => self.certs.iter().find(|c| {
                c.issuer() == &ias.issuer
                    && c.cert.tbs_certificate.serial_number == ias.serial_number
            }),
            SignerIdentifier::SubjectKeyIdentifier(ski) => self
                .certs
                .iter()
                .find(|c| c.subject_key_id().as_deref() == Some(ski.0.as_bytes())),
        })
    }

    /// Value of signed attribute `oid` (first value).
    pub fn signed_attr(&self, oid: ObjectIdentifier) -> Result<Option<&Any>> {
        let si = self.signer_info()?;
        Ok(si
            .signed_attrs
            .as_ref()
            .and_then(|s| s.iter().find(|a| a.oid == oid))
            .and_then(|a| a.values.iter().next()))
    }

    /// Value of unsigned attribute `oid` (first value).
    pub fn unsigned_attr(&self, oid: ObjectIdentifier) -> Result<Option<&Any>> {
        let si = self.signer_info()?;
        Ok(si
            .unsigned_attrs
            .as_ref()
            .and_then(|s| s.iter().find(|a| a.oid == oid))
            .and_then(|a| a.values.iter().next()))
    }

    /// Digest algorithm of the signer.
    pub fn hash(&self) -> Result<HashAlg> {
        HashAlg::from_oid(&self.signer_info()?.digest_alg.oid)
    }

    /// The signature value.
    pub fn signature_value(&self) -> Result<&[u8]> {
        Ok(self.signer_info()?.signature.as_bytes())
    }
}

/// Outcome of verifying a CMS signer against a content digest.
#[derive(Debug, Clone, Default)]
pub struct SignerCheck {
    /// The signer certificate was found.
    pub signer: Option<Cert>,
    /// messageDigest attribute equals the computed digest.
    pub digest_matches: bool,
    /// The signature over the signed attributes verifies with the signer key.
    pub signature_valid: bool,
    /// Errors (each makes the signature invalid).
    pub errors: Vec<String>,
    /// Non-fatal observations.
    pub warnings: Vec<String>,
    /// signingCertificate(V2) attribute present and matching.
    pub ess_ok: Option<bool>,
    /// Claimed signing-time attribute (Unix seconds), if present.
    pub signing_time: Option<i64>,
}

/// Verify the first signer of `cms` against content with digest function `content_digest`
/// (given the signer's digest algorithm, return the content's digest).
pub fn verify_signer(
    cms: &ParsedCms,
    content_digest: &dyn Fn(HashAlg) -> Vec<u8>,
) -> Result<SignerCheck> {
    let mut out = SignerCheck::default();
    let si = cms.signer_info()?;
    if cms.signed_data.signer_infos.0.len() > 1 {
        out.warnings
            .push("more than one signer; only the first is checked".into());
    }
    let hash = cms.hash()?;
    if hash == HashAlg::Sha1 {
        out.warnings
            .push("SHA-1 digest (weak, not accepted for new signatures)".into());
    }
    let signer = cms.signer_cert()?.cloned();
    let Some(cert) = signer else {
        out.errors
            .push("the signer certificate is not in the signature".into());
        return Ok(out);
    };
    let digest = content_digest(hash);
    let to_verify: Vec<u8> = match &cms.signed_attrs_raw {
        Some(raw) => {
            match cms.signed_attr(oids::MESSAGE_DIGEST)? {
                Some(md) => {
                    let md = md
                        .decode_as::<OctetString>()
                        .map_err(|e| SignError::der("messageDigest", e))?;
                    out.digest_matches = md.as_bytes() == digest.as_slice();
                    if !out.digest_matches {
                        out.errors
                            .push("the document bytes do not match the signed digest".into());
                    }
                }
                None => out.errors.push("messageDigest attribute missing".into()),
            }
            match cms.signed_attr(oids::CONTENT_TYPE)? {
                Some(ct) => {
                    let ct = ct.decode_as::<ObjectIdentifier>().ok();
                    let expect = cms.signed_data.encap_content_info.econtent_type;
                    if ct != Some(expect) {
                        out.errors
                            .push("contentType attribute does not match the content".into());
                    }
                }
                None => out.errors.push("contentType attribute missing".into()),
            }
            if let Some(t) = cms.signed_attr(oids::SIGNING_TIME)? {
                out.signing_time = decode_time(t);
            }
            out.ess_ok = check_ess(cms, &cert)?;
            if out.ess_ok == Some(false) {
                out.errors.push(
                    "signingCertificate attribute does not identify the signer certificate".into(),
                );
            }
            hash.digest(raw)
        }
        None => {
            // No signed attributes: the signature is directly over the content digest.
            out.digest_matches = true;
            digest.clone()
        }
    };
    match keys::verify_prehash(
        cert.spki(),
        &si.signature_algorithm,
        hash,
        &to_verify,
        si.signature.as_bytes(),
    ) {
        Ok(()) => out.signature_valid = true,
        Err(e) => out.errors.push(e.to_string()),
    }
    out.signer = Some(cert);
    Ok(out)
}

fn decode_time(t: &Any) -> Option<i64> {
    if let Ok(u) = t.decode_as::<der::asn1::UtcTime>() {
        return Some(u.to_unix_duration().as_secs() as i64);
    }
    t.decode_as::<der::asn1::GeneralizedTime>()
        .ok()
        .map(|g| g.to_unix_duration().as_secs() as i64)
}

/// `Some(true)` when an ESS signingCertificate(V2) attribute identifies `cert`,
/// `Some(false)` when it names another certificate, `None` when absent.
fn check_ess(cms: &ParsedCms, cert: &Cert) -> Result<Option<bool>> {
    if let Some(v) = cms.signed_attr(oids::SIGNING_CERTIFICATE_V2)? {
        let sc = v
            .decode_as::<SigningCertificateV2>()
            .map_err(|e| SignError::der("signingCertificateV2", e))?;
        let Some(first) = sc.certs.first() else {
            return Ok(Some(false));
        };
        let h = match &first.hash_algorithm {
            Some(a) => HashAlg::from_oid(&a.oid)?,
            None => HashAlg::Sha256,
        };
        return Ok(Some(
            first.cert_hash.as_bytes() == h.digest(&cert.der).as_slice(),
        ));
    }
    if let Some(v) = cms.signed_attr(oids::SIGNING_CERTIFICATE)? {
        let sc = v
            .decode_as::<SigningCertificate>()
            .map_err(|e| SignError::der("signingCertificate", e))?;
        let Some(first) = sc.certs.first() else {
            return Ok(Some(false));
        };
        return Ok(Some(
            first.cert_hash.as_bytes() == HashAlg::Sha1.digest(&cert.der).as_slice(),
        ));
    }
    Ok(None)
}
