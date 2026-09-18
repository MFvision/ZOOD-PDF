//! Revocation data: OCSP (RFC 6960) requests and answers, and certificate
//! revocation lists (RFC 5280), checked against the certificate and issuer
//! they are about. Fetching them is the host's business.
use der::{Decode, Encode};
use x509_cert::crl::CertificateList;

use crate::asn1::{children, read, wrap};
use crate::chain::Cert;
use crate::keys::{verify_message, SigAlg};
use crate::time::generalized_unix;
use crate::{cms_err, oids, HashAlg, Result, SignError};

/// What a certificate's issuer is known by: its name and its key. A
/// certificate has them, and so does a trust anchor with no certificate.
pub trait IssuerKey {
    fn subject(&self) -> &[u8];
    fn spki(&self) -> &[u8];
}

impl IssuerKey for Cert {
    fn subject(&self) -> &[u8] {
        &self.subject
    }
    fn spki(&self) -> &[u8] {
        &self.spki
    }
}

impl IssuerKey for crate::chain::Anchor {
    fn subject(&self) -> &[u8] {
        &self.subject
    }
    fn spki(&self) -> &[u8] {
        &self.spki
    }
}

/// The issuer's public key bits, which OCSP identifies it by.
fn issuer_key(issuer: &(impl IssuerKey + ?Sized)) -> Vec<u8> {
    spki::SubjectPublicKeyInfoRef::from_der(issuer.spki())
        .map(|k| k.subject_public_key.raw_bytes().to_vec())
        .unwrap_or_default()
}

/// An `OCSPRequest` for `cert` (issued by `issuer`), unsigned, no nonce —
/// what CAs' responders answer from cache and what can be sent by GET.
pub fn ocsp_request(cert: &Cert, issuer: &(impl IssuerKey + ?Sized)) -> Result<Vec<u8>> {
    let hash = HashAlg::Sha1;
    let serial = cert.parsed.tbs_certificate.serial_number.to_der().map_err(cms_err)?;
    let cert_id = wrap(
        0x30,
        &[
            hash.algorithm().to_der().map_err(cms_err)?,
            wrap(0x04, &hash.digest(issuer.subject())),
            wrap(0x04, &hash.digest(&issuer_key(issuer))),
            serial,
        ]
        .concat(),
    );
    let request = wrap(0x30, &cert_id);
    let tbs = wrap(0x30, &wrap(0x30, &request));
    Ok(wrap(0x30, &tbs))
}

/// What an answer says of a certificate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Status {
    Good,
    Revoked { at: i64 },
    Unknown,
}

#[derive(Debug, Clone)]
pub struct OcspCheck {
    pub status: Status,
    pub produced_at: i64,
    pub this_update: i64,
    pub next_update: Option<i64>,
    /// Signed by the issuer, or by a responder the issuer authorised.
    pub signature_ok: bool,
    /// Certificates the answer carries (a delegated responder's).
    pub certs: Vec<Vec<u8>>,
}

fn bad(what: impl std::fmt::Display) -> SignError {
    SignError::Revocation(what.to_string())
}

/// The `BasicOCSPResponse` inside an `OCSPResponse`.
fn basic(response: &[u8]) -> Result<(x509_ocsp::BasicOcspResponse, Vec<u8>)> {
    let resp = x509_ocsp::OcspResponse::from_der(crate::asn1::first_der(response)?).map_err(bad)?;
    if resp.response_status != x509_ocsp::OcspResponseStatus::Successful {
        return Err(bad(format!("the responder answered {:?}", resp.response_status)));
    }
    let bytes = resp.response_bytes.ok_or_else(|| bad("an empty answer"))?;
    if bytes.response_type != oids::OCSP_BASIC {
        return Err(bad("not a basic OCSP answer"));
    }
    let raw = bytes.response.as_bytes().to_vec();
    Ok((x509_ocsp::BasicOcspResponse::from_der(&raw).map_err(bad)?, raw))
}

/// Whether `response` is an OCSP answer about `cert` from `issuer`.
pub fn ocsp_is_about(response: &[u8], cert: &Cert, issuer: &(impl IssuerKey + ?Sized)) -> bool {
    basic(response).is_ok_and(|(b, _)| {
        b.tbs_response_data
            .responses
            .iter()
            .any(|r| cert_id_matches(&r.cert_id, cert, issuer))
    })
}

fn cert_id_matches(id: &x509_ocsp::CertId, cert: &Cert, issuer: &(impl IssuerKey + ?Sized)) -> bool {
    let Some(hash) = HashAlg::from_oid(&id.hash_algorithm.oid) else {
        return false;
    };
    id.serial_number.as_bytes() == cert.parsed.tbs_certificate.serial_number.as_bytes()
        && id.issuer_name_hash.as_bytes() == hash.digest(issuer.subject())
        && id.issuer_key_hash.as_bytes() == hash.digest(&issuer_key(issuer))
}

/// Checks an OCSP answer about `cert`, issued by `issuer`.
pub fn check_ocsp(response: &[u8], cert: &Cert, issuer: &(impl IssuerKey + ?Sized)) -> Result<OcspCheck> {
    let (basic_resp, der) = basic(response)?;
    let single = basic_resp
        .tbs_response_data
        .responses
        .iter()
        .find(|r| cert_id_matches(&r.cert_id, cert, issuer))
        .ok_or_else(|| bad("the answer is about another certificate"))?;
    let status = match &single.cert_status {
        x509_ocsp::CertStatus::Good(_) => Status::Good,
        x509_ocsp::CertStatus::Revoked(info) => Status::Revoked {
            at: generalized_unix(&info.revocation_time.0),
        },
        x509_ocsp::CertStatus::Unknown(_) => Status::Unknown,
    };
    // The signature over `tbsResponseData`, as the responder wrote it.
    let (outer, _) = read(&der)?;
    let tbs = children(outer.value)?
        .first()
        .map(|t| t.raw.to_vec())
        .ok_or_else(|| bad("empty answer"))?;
    let alg = &basic_resp.signature_algorithm;
    let params = alg.parameters.as_ref().and_then(|p| p.to_der().ok());
    let sig_alg = SigAlg::from_identifier(&alg.oid, params.as_deref(), None)?;
    let signature = basic_resp.signature.as_bytes().unwrap_or(&[]);
    let certs: Vec<Vec<u8>> = basic_resp
        .certs
        .iter()
        .flatten()
        .filter_map(|c| c.to_der().ok())
        .collect();
    let signature_ok = verify_message(issuer.spki(), sig_alg, &tbs, signature).is_ok()
        || certs.iter().filter_map(|d| Cert::parse(d).ok()).any(|responder| {
            responder.issuer == issuer.subject()
                && responder.signed_by(issuer.spki())
                && responder.extended_key_usage().contains(&oids::KP_OCSP_SIGNING)
                && verify_message(&responder.spki, sig_alg, &tbs, signature).is_ok()
        });
    Ok(OcspCheck {
        status,
        produced_at: generalized_unix(&basic_resp.tbs_response_data.produced_at.0),
        this_update: generalized_unix(&single.this_update.0),
        next_update: single.next_update.as_ref().map(|t| generalized_unix(&t.0)),
        signature_ok,
        certs,
    })
}

#[derive(Debug, Clone)]
pub struct CrlCheck {
    pub this_update: i64,
    pub next_update: Option<i64>,
    pub signature_ok: bool,
    /// When `cert` was revoked, if the list says it was.
    pub revoked_at: Option<i64>,
}

/// The issuer (a DER `Name`) of a revocation list.
pub fn crl_issuer(crl: &[u8]) -> Result<Vec<u8>> {
    let list = CertificateList::from_der(crate::asn1::first_der(crl)?).map_err(bad)?;
    list.tbs_cert_list.issuer.to_der().map_err(bad)
}

/// Checks a revocation list from `issuer` for `cert`.
pub fn check_crl(crl: &[u8], cert: &Cert, issuer: &(impl IssuerKey + ?Sized)) -> Result<CrlCheck> {
    let raw = crate::asn1::first_der(crl)?;
    let list = CertificateList::from_der(raw).map_err(bad)?;
    if list.tbs_cert_list.issuer.to_der().map_err(bad)? != issuer.subject() {
        return Err(bad("the list is from another issuer"));
    }
    let (outer, _) = read(raw)?;
    let tbs = children(outer.value)?
        .first()
        .map(|t| t.raw.to_vec())
        .ok_or_else(|| bad("empty list"))?;
    let alg = &list.signature_algorithm;
    let params = alg.parameters.as_ref().and_then(|p| p.to_der().ok());
    let sig_alg = SigAlg::from_identifier(&alg.oid, params.as_deref(), None)?;
    let signature_ok = verify_message(issuer.spki(), sig_alg, &tbs, list.signature.as_bytes().unwrap_or(&[])).is_ok();
    let serial = cert.parsed.tbs_certificate.serial_number.as_bytes();
    let revoked_at = list
        .tbs_cert_list
        .revoked_certificates
        .iter()
        .flatten()
        .find(|r| r.serial_number.as_bytes() == serial)
        .map(|r| crate::time::x509_unix(&r.revocation_date));
    Ok(CrlCheck {
        this_update: crate::time::x509_unix(&list.tbs_cert_list.this_update),
        next_update: list.tbs_cert_list.next_update.as_ref().map(crate::time::x509_unix),
        signature_ok,
        revoked_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> Vec<u8> {
        std::fs::read(format!(
            "{}/../../../tests/fixtures/signatures/{name}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap()
    }
    fn cert(name: &str) -> Cert {
        Cert::parse(&fixture(name)).unwrap()
    }

    #[test]
    fn ocsp_answers_from_the_test_ca_are_read_and_checked() {
        let (leaf, issuer) = (cert("signer-rsa.cer"), cert("intermediate-rsa.cer"));
        let good = check_ocsp(&fixture("signer-rsa.ocsp"), &leaf, &issuer).unwrap();
        assert_eq!(good.status, Status::Good);
        assert!(good.signature_ok);
        let revoked = check_ocsp(&fixture("revoked-rsa.ocsp"), &cert("revoked-rsa.cer"), &issuer).unwrap();
        assert!(matches!(revoked.status, Status::Revoked { .. }), "{:?}", revoked.status);
        assert!(check_ocsp(&fixture("revoked-rsa.ocsp"), &leaf, &issuer).is_err(), "about another certificate");
        assert!(ocsp_is_about(&fixture("signer-ec.ocsp"), &cert("signer-ec.cer"), &cert("intermediate-ec.cer")));
        // A request asks about exactly that certificate, the way openssl does.
        let req = ocsp_request(&leaf, &issuer).unwrap();
        assert!(x509_ocsp::OcspRequest::from_der(&req).is_ok());
    }

    #[test]
    fn revocation_lists_are_read_and_checked() {
        let issuer = cert("intermediate-rsa.cer");
        let crl = fixture("intermediate-rsa.crl");
        assert_eq!(crl_issuer(&crl).unwrap(), issuer.subject);
        let fine = check_crl(&crl, &cert("signer-rsa.cer"), &issuer).unwrap();
        assert!(fine.signature_ok && fine.revoked_at.is_none());
        let revoked = check_crl(&crl, &cert("revoked-rsa.cer"), &issuer).unwrap();
        assert!(revoked.revoked_at.is_some());
        assert!(check_crl(&crl, &cert("signer-ec.cer"), &cert("intermediate-ec.cer")).is_err());
    }
}
