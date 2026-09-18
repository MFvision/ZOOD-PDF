//! RFC 3161 timestamps: the request sent to a timestamp authority, the
//! token it answers with, and checking a token.
//!
//! A timestamp authority sees only a digest — of the signature value for a
//! signature timestamp (PAdES B-T), of the signed bytes for a document
//! timestamp (B-LTA) — never the document.
use der::{Decode, Encode};
use rand_core::RngCore;

use crate::asn1::{children, read, wrap};
use crate::chain::{display_name, Cert};
use crate::cms::{self, Parsed};
use crate::{cms_err, oids, HashAlg, Result, SignError};

/// A request, and what its answer must echo.
#[derive(Debug, Clone)]
pub struct Request {
    pub der: Vec<u8>,
    pub hash: HashAlg,
    pub imprint: Vec<u8>,
    pub nonce: Vec<u8>,
}

/// A `TimeStampReq` for `imprint` (a digest made with `hash`), asking for the
/// authority's certificate and carrying a fresh nonce.
pub fn request(hash: HashAlg, imprint: &[u8]) -> Result<Request> {
    let mut nonce = [0u8; 8];
    rand_core::OsRng.fill_bytes(&mut nonce);
    // A positive INTEGER: no leading one bit.
    nonce[0] &= 0x7f;
    nonce[0] |= 0x01;
    let message_imprint = wrap(
        0x30,
        &[
            hash.algorithm().to_der().map_err(cms_err)?,
            wrap(0x04, imprint),
        ]
        .concat(),
    );
    let der = wrap(
        0x30,
        &[
            vec![0x02, 0x01, 0x01],
            message_imprint,
            wrap(0x02, &nonce),
            vec![0x01, 0x01, 0xff],
        ]
        .concat(),
    );
    Ok(Request {
        der,
        hash,
        imprint: imprint.to_vec(),
        nonce: nonce.to_vec(),
    })
}

/// The token in a `TimeStampResp`, after checking the authority granted it
/// and that it stamps `imprint` (and echoes `nonce`, when one was sent).
pub fn token_from_response(response: &[u8], imprint: &[u8], nonce: Option<&[u8]>) -> Result<Vec<u8>> {
    let (resp, _) = read(response).map_err(|_| SignError::Tsa("the answer is not a timestamp response".into()))?;
    let parts = children(resp.value)?;
    let status = parts
        .first()
        .map(|s| children(s.value))
        .transpose()?
        .and_then(|s| s.into_iter().next())
        .filter(|s| s.tag == 0x02 && s.value.len() == 1)
        .map(|s| s.value[0])
        .ok_or_else(|| SignError::Tsa("the answer has no status".into()))?;
    // granted (0) or grantedWithMods (1)
    if status > 1 {
        return Err(SignError::Tsa(format!("the authority refused the request (status {status})")));
    }
    let token = parts
        .get(1)
        .ok_or_else(|| SignError::Tsa("the answer carries no token".into()))?
        .raw
        .to_vec();
    let info = token_info(&token)?;
    if info.imprint != imprint {
        return Err(SignError::Tsa("the token stamps something else".into()));
    }
    if let Some(nonce) = nonce {
        if info.nonce.as_deref() != Some(nonce) {
            return Err(SignError::Tsa("the token does not answer this request (nonce)".into()));
        }
    }
    Ok(token)
}

/// What a token says.
#[derive(Debug, Clone)]
pub struct TokenInfo {
    pub gen_time: i64,
    pub hash: HashAlg,
    pub imprint: Vec<u8>,
    pub nonce: Option<Vec<u8>>,
    pub serial: Vec<u8>,
    pub parsed: Parsed,
}

/// Reads a timestamp token: a `SignedData` over a `TSTInfo`.
pub fn token_info(token: &[u8]) -> Result<TokenInfo> {
    let parsed = cms::parse(token)?;
    if parsed.econtent_type != oids::TST_INFO {
        return Err(SignError::Tsa("not a timestamp token".into()));
    }
    let content = parsed
        .econtent
        .as_deref()
        .ok_or_else(|| SignError::Tsa("the token has no content".into()))?;
    let tst = x509_tsp::TstInfo::from_der(content).map_err(|e| SignError::Tsa(format!("TSTInfo: {e}")))?;
    let hash = HashAlg::from_oid(&tst.message_imprint.hash_algorithm.oid)
        .ok_or_else(|| SignError::Tsa("unsupported imprint digest".into()))?;
    Ok(TokenInfo {
        gen_time: crate::time::generalized_unix(&tst.gen_time),
        hash,
        imprint: tst.message_imprint.hashed_message.as_bytes().to_vec(),
        nonce: tst.nonce.map(|n| n.as_bytes().to_vec()),
        serial: tst.serial_number.as_bytes().to_vec(),
        parsed,
    })
}

/// Checking a token: its own signature, and whose it is.
#[derive(Debug, Clone)]
pub struct TokenCheck {
    pub info: TokenInfo,
    pub signer: Option<Cert>,
    pub authority: String,
    /// The token's signature verifies over its `TSTInfo`.
    pub signature_ok: bool,
    /// The signing certificate is for timestamping (extended key usage).
    pub purpose_ok: bool,
    pub problem: Option<String>,
}

/// Checks `token`'s own signature; `extra` are certificates found elsewhere
/// (the document's validation data) for a token that does not carry its own.
pub fn check_token(token: &[u8], extra: &[Cert]) -> Result<TokenCheck> {
    let info = token_info(token)?;
    let mut certs = cms::certificates(&info.parsed);
    certs.extend(extra.iter().cloned());
    let signer = cms::find_signer(&info.parsed, &certs).cloned();
    let content = info.parsed.econtent.clone().unwrap_or_default();
    let (signature_ok, purpose_ok, problem, authority) = match &signer {
        Some(cert) => {
            let c = cms::check(&info.parsed, cert, &info.parsed.digest.digest(&content));
            let ok = c.digest_ok && c.signature_ok && c.content_type_ok && c.cert_binding_ok != Some(false);
            (
                ok,
                cert.extended_key_usage().contains(&oids::KP_TIME_STAMPING),
                c.problem,
                cert.common_name(),
            )
        }
        None => (
            false,
            false,
            Some("the authority's certificate is not in the token".into()),
            match &info.parsed.sid {
                cms::SignerId::IssuerSerial { issuer, .. } => display_name(issuer),
                cms::SignerId::KeyId(_) => String::new(),
            },
        ),
    };
    Ok(TokenCheck {
        info,
        signer,
        authority,
        signature_ok,
        purpose_ok,
        problem,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::keys::{Padding, Signer};

    fn fixture(name: &str) -> Vec<u8> {
        std::fs::read(format!(
            "{}/../../../tests/fixtures/signatures/{name}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap()
    }

    /// A timestamp authority for the tests: the TEST TSA's key, answering a
    /// request the way RFC 3161 says, through this crate's own CMS writer.
    pub(crate) fn answer(request_der: &[u8], at: i64) -> Vec<u8> {
        let tsa = crate::pkcs12::open(&fixture("tsa-rsa.p12"), "warraq-test").unwrap();
        let (req, _) = read(request_der).unwrap();
        let parts = children(req.value).unwrap();
        let imprint = parts[1].raw.to_vec();
        let nonce = parts.iter().find(|p| p.tag == 0x02 && p.raw != [2, 1, 1]).map(|p| p.raw.to_vec());
        let time = der::asn1::GeneralizedTime::from_unix_duration(std::time::Duration::from_secs(at as u64))
            .unwrap()
            .to_der()
            .unwrap();
        let tst = wrap(
            0x30,
            &[
                vec![0x02, 0x01, 0x01],
                const_oid::ObjectIdentifier::new_unwrap("1.2.3.4.1").to_der().unwrap(),
                imprint,
                vec![0x02, 0x02, 0x10, 0x01],
                time,
                nonce.unwrap_or_default(),
            ]
            .concat(),
        );
        let hash = HashAlg::Sha256;
        let token = cms::sign(
            &tsa.signer,
            &cms::Content {
                econtent_type: oids::TST_INFO,
                econtent: Some(&tst),
                digest: &hash.digest(&tst),
                hash,
                padding: Padding::Pkcs1v15,
                extra_signed: vec![],
            },
        )
        .unwrap();
        assert!(!tsa.signer.chain().is_empty());
        wrap(0x30, &[wrap(0x30, &[0x02, 0x01, 0x00]), token].concat())
    }

    #[test]
    fn a_request_is_answered_and_the_token_checks_out() {
        let imprint = HashAlg::Sha256.digest(b"signature value");
        let req = request(HashAlg::Sha256, &imprint).unwrap();
        let resp = answer(&req.der, 1_800_000_000);
        let token = token_from_response(&resp, &imprint, Some(&req.nonce)).unwrap();
        let check = check_token(&token, &[]).unwrap();
        assert!(check.signature_ok, "{:?}", check.problem);
        assert!(check.purpose_ok);
        assert_eq!(check.info.gen_time, 1_800_000_000);
        assert_eq!(check.authority, "Warraq TEST Timestamp Authority");
        // Another request's nonce, or another imprint, is refused.
        assert!(token_from_response(&resp, &imprint, Some(&[1, 2, 3])).is_err());
        assert!(token_from_response(&resp, &[0; 32], None).is_err());
    }

    /// Answers from three public authorities, fetched once for "hello\n"
    /// (`tests/fixtures/signatures/real-tsa`): parsed and checked the same way.
    #[test]
    fn tokens_from_real_timestamp_authorities_verify() {
        let imprint = HashAlg::Sha256.digest(b"hello\n");
        for name in ["digicert", "sectigo", "freetsa"] {
            let resp = fixture(&format!("real-tsa/{name}.tsr"));
            let token = token_from_response(&resp, &imprint, None).unwrap_or_else(|e| panic!("{name}: {e}"));
            let check = check_token(&token, &[]).unwrap_or_else(|e| panic!("{name}: {e}"));
            assert!(check.signature_ok, "{name}: {:?}", check.problem);
            assert!(check.purpose_ok, "{name}");
            assert!(check.info.gen_time > 1_780_000_000, "{name}");
        }
    }
}
