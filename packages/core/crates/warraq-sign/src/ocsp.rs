//! Revocation data: OCSP requests (built here, sent by the host), OCSP responses and CRLs
//! (parsed and verified here), and the per-certificate revocation verdict used by
//! verification.

use crate::error::{Result, SignError};
use crate::hash::HashAlg;
use crate::keys;
use crate::oids;
use crate::tlv;
use crate::x509::Cert;
use der::asn1::{Null, OctetString};
use der::{Any, Decode, Encode};
use spki::AlgorithmIdentifierOwned;
use x509_cert::crl::CertificateList;
use x509_ocsp::{
    BasicOcspResponse, CertId, CertStatus, OcspRequest, OcspResponse, OcspResponseStatus, Request,
    ResponderId, TbsRequest,
};

fn cert_id(issuer: &Cert, subject: &Cert) -> Result<CertId> {
    let name_der = issuer
        .subject()
        .to_der()
        .map_err(|e| SignError::der("issuer name", e))?;
    let key = issuer
        .spki()
        .subject_public_key
        .as_bytes()
        .ok_or_else(|| SignError::Malformed("issuer key".into()))?;
    Ok(CertId {
        hash_algorithm: AlgorithmIdentifierOwned {
            oid: oids::SHA1,
            parameters: Some(Any::from(Null)),
        },
        issuer_name_hash: OctetString::new(HashAlg::Sha1.digest(&name_der))
            .map_err(|e| SignError::der("CertID", e))?,
        issuer_key_hash: OctetString::new(HashAlg::Sha1.digest(key))
            .map_err(|e| SignError::der("CertID", e))?,
        serial_number: subject.cert.tbs_certificate.serial_number.clone(),
    })
}

/// DER OCSP request for `subject` issued by `issuer` (SHA-1 CertID, as every responder
/// accepts; no nonce so responses stay cacheable).
pub fn build_request(issuer: &Cert, subject: &Cert) -> Result<Vec<u8>> {
    let req = OcspRequest {
        tbs_request: TbsRequest {
            version: Default::default(),
            requestor_name: None,
            request_list: vec![Request {
                req_cert: cert_id(issuer, subject)?,
                single_request_extensions: None,
            }],
            request_extensions: None,
        },
        optional_signature: None,
    };
    req.to_der().map_err(|e| SignError::der("OCSP request", e))
}

/// Parse an OCSPResponse and return its BasicOCSPResponse (successful responses only).
pub fn parse_response(bytes: &[u8]) -> Result<BasicOcspResponse> {
    if bytes.len() > crate::limits::MAX_CMS_SIZE {
        return Err(SignError::Limit("OCSP response too large".into()));
    }
    let len = tlv::element_len(bytes)?;
    let head = bytes.get(..len).unwrap_or(bytes);
    let r = OcspResponse::from_der(head).map_err(|e| SignError::der("OCSP response", e))?;
    if r.response_status != OcspResponseStatus::Successful {
        return Err(SignError::Malformed(
            "OCSP response status is not successful".into(),
        ));
    }
    let rb = r
        .response_bytes
        .ok_or_else(|| SignError::Malformed("OCSP response without body".into()))?;
    if rb.response_type != oids::OCSP_BASIC {
        return Err(SignError::Unsupported("OCSP response type".into()));
    }
    BasicOcspResponse::from_der(rb.response.as_bytes())
        .map_err(|e| SignError::der("basic OCSP response", e))
}

/// Parse a DER CRL.
pub fn parse_crl(bytes: &[u8]) -> Result<CertificateList> {
    if bytes.len() > crate::limits::MAX_CMS_SIZE {
        return Err(SignError::Limit("CRL too large".into()));
    }
    let len = tlv::element_len(bytes)?;
    let head = bytes.get(..len).unwrap_or(bytes);
    CertificateList::from_der(head).map_err(|e| SignError::der("CRL", e))
}

/// Revocation verdict for one certificate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Revocation {
    /// A verified OCSP response or CRL says good.
    Good {
        /// "OCSP" or "CRL".
        source: &'static str,
    },
    /// Revoked at Unix time.
    Revoked {
        /// Source.
        source: &'static str,
        /// Revocation time.
        at: i64,
    },
    /// No usable revocation data.
    Unknown,
}

fn raw_signed(der: &[u8]) -> Result<&[u8]> {
    let (outer, _) = tlv::read(der)?;
    Ok(tlv::children(outer.content)?
        .first()
        .ok_or_else(|| SignError::Malformed("signed structure".into()))?
        .raw)
}

/// Check `subject` (issued by `issuer`) against the given OCSP responses and CRLs.
/// Responses must be signed by the issuer or by a responder certificate the issuer issued
/// with the OCSPSigning EKU.
pub fn check(subject: &Cert, issuer: &Cert, ocsps: &[Vec<u8>], crls: &[Vec<u8>]) -> Revocation {
    let want = match cert_id(issuer, subject) {
        Ok(c) => c,
        Err(_) => return Revocation::Unknown,
    };
    for o in ocsps {
        let Ok(basic) = parse_response(o) else {
            continue;
        };
        let Some(single) = basic.tbs_response_data.responses.iter().find(|s| {
            s.cert_id.issuer_key_hash == want.issuer_key_hash
                && s.cert_id.issuer_name_hash == want.issuer_name_hash
                && s.cert_id.serial_number == want.serial_number
                && s.cert_id.hash_algorithm.oid == oids::SHA1
        }) else {
            continue;
        };
        // Who signed the response?
        let Ok(tbs_der) = basic.tbs_response_data.to_der() else {
            continue;
        };
        let Some(sig) = basic.signature.as_bytes() else {
            continue;
        };
        let issuer_signed =
            keys::verify_data(issuer.spki(), &basic.signature_algorithm, &tbs_der, sig).is_ok();
        let delegated = !issuer_signed
            && basic.certs.iter().flatten().any(|c| {
                let Ok(der) = c.to_der() else { return false };
                let Ok(rc) = Cert::from_der(&der) else {
                    return false;
                };
                rc.extended_key_usage()
                    .is_some_and(|e| e.contains(&oids::EKU_OCSP_SIGNING))
                    && rc.is_signed_by(issuer.spki())
                    && match &basic.tbs_response_data.responder_id {
                        ResponderId::ByName(n) => rc.subject() == n,
                        ResponderId::ByKey(k) => {
                            rc.spki()
                                .subject_public_key
                                .as_bytes()
                                .map(|b| HashAlg::Sha1.digest(b))
                                .as_deref()
                                == Some(k.as_bytes())
                        }
                    }
                    && keys::verify_data(rc.spki(), &basic.signature_algorithm, &tbs_der, sig)
                        .is_ok()
            });
        if !issuer_signed && !delegated {
            continue;
        }
        return match &single.cert_status {
            CertStatus::Good(_) => Revocation::Good { source: "OCSP" },
            CertStatus::Revoked(r) => Revocation::Revoked {
                source: "OCSP",
                at: r.revocation_time.0.to_unix_duration().as_secs() as i64,
            },
            CertStatus::Unknown(_) => Revocation::Unknown,
        };
    }
    for c in crls {
        let Ok(crl) = parse_crl(c) else { continue };
        if &crl.tbs_cert_list.issuer != issuer.subject() {
            continue;
        }
        let Ok(tbs) = raw_signed(c) else { continue };
        let Some(sig) = crl.signature.as_bytes() else {
            continue;
        };
        if keys::verify_data(issuer.spki(), &crl.signature_algorithm, tbs, sig).is_err() {
            continue;
        }
        let serial = &subject.cert.tbs_certificate.serial_number;
        if let Some(r) = crl
            .tbs_cert_list
            .revoked_certificates
            .iter()
            .flatten()
            .find(|r| &r.serial_number == serial)
        {
            return Revocation::Revoked {
                source: "CRL",
                at: r.revocation_date.to_unix_duration().as_secs() as i64,
            };
        }
        return Revocation::Good { source: "CRL" };
    }
    Revocation::Unknown
}

/// Certificates embedded in an OCSP response (responder certificates).
pub fn response_certs(bytes: &[u8]) -> Vec<Cert> {
    parse_response(bytes)
        .ok()
        .and_then(|b| b.certs)
        .into_iter()
        .flatten()
        .filter_map(|c| c.to_der().ok().and_then(|d| Cert::from_der(&d).ok()))
        .collect()
}

/// One certificate that needs revocation data, with what the host should fetch.
#[derive(Debug, Clone)]
pub struct RevocationRequest {
    /// Subject display name.
    pub subject: String,
    /// OCSP request DER (when the issuer is known).
    pub ocsp_request: Option<Vec<u8>>,
    /// OCSP responder URLs.
    pub ocsp_urls: Vec<String>,
    /// CRL URLs.
    pub crl_urls: Vec<String>,
    /// The certificate (DER) — goes into the DSS too.
    pub cert: Vec<u8>,
}

/// Revocation requests for every non-self-signed certificate of `chain` (leaf first) whose
/// issuer is also in `chain`.
pub fn requests_for_chain(chain: &[Cert]) -> Vec<RevocationRequest> {
    let mut out = Vec::new();
    for c in chain {
        if c.is_self_issued() {
            continue;
        }
        let issuer = chain
            .iter()
            .find(|i| i.subject() == c.issuer() && c.is_signed_by(i.spki()));
        let no_check = c
            .cert
            .tbs_certificate
            .extensions
            .iter()
            .flatten()
            .any(|e| e.extn_id == oids::OCSP_NOCHECK);
        if no_check {
            continue;
        }
        out.push(RevocationRequest {
            subject: c.display_name(),
            ocsp_request: issuer.and_then(|i| build_request(i, c).ok()),
            ocsp_urls: c.ocsp_urls(),
            crl_urls: c.crl_urls(),
            cert: c.der.clone(),
        });
    }
    out
}
