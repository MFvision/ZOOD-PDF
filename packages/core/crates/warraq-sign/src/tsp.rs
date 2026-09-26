//! RFC 3161 timestamps: requests, responses and token verification.
//!
//! The engine does no network I/O. It builds the request DER; the host (desktop app) posts it
//! to the TSA (`Content-Type: application/timestamp-query`) and hands the response back.
//! Native callers may implement [`TsaClient`] to do both in one step.

use crate::cms::{verify_signer, ParsedCms};
use crate::error::{Result, SignError};
use crate::hash::HashAlg;
use crate::oids;
use crate::tlv;
use crate::x509::{self, Anchor, Cert};
use der::asn1::{Int, OctetString};
use der::{Any, Decode, Encode};
use x509_tsp::{MessageImprint, TimeStampReq, TspVersion, TstInfo};

/// Sends a timestamp request and returns the response bytes (implemented by hosts with
/// network access; the core itself never does network I/O).
pub trait TsaClient {
    /// POST `request_der` to the TSA and return the raw response.
    fn timestamp(&self, request_der: &[u8]) -> Result<Vec<u8>>;
}

/// A timestamp request.
#[derive(Debug, Clone)]
pub struct TsaRequest {
    /// DER to send.
    pub der: Vec<u8>,
    /// Digest algorithm of the imprint.
    pub hash: HashAlg,
    /// The hashed message.
    pub imprint: Vec<u8>,
    /// Nonce sent.
    pub nonce: Vec<u8>,
}

/// Deterministic nonce bound to the imprint (lets `finish` re-derive it without state).
fn nonce_for(imprint: &[u8]) -> Vec<u8> {
    let d = HashAlg::Sha256.digest_parts(&[b"ZOOD PDF TSA nonce", imprint]);
    let mut n = d.get(..8).unwrap_or_default().to_vec();
    // Positive INTEGER with a non-zero leading byte.
    if let Some(f) = n.first_mut() {
        *f = (*f & 0x7F) | 0x01;
    }
    n
}

/// Build a request for `imprint` (the digest of the data to timestamp, made with `hash`).
pub fn build_request(hash: HashAlg, imprint: &[u8]) -> Result<TsaRequest> {
    let nonce = nonce_for(imprint);
    let req = TimeStampReq {
        version: TspVersion::V1,
        message_imprint: MessageImprint {
            hash_algorithm: spki::AlgorithmIdentifier {
                oid: hash.oid(),
                parameters: None,
            },
            hashed_message: OctetString::new(imprint).map_err(|e| SignError::der("imprint", e))?,
        },
        req_policy: None,
        nonce: Some(Int::new(&nonce).map_err(|e| SignError::der("nonce", e))?),
        cert_req: true,
        extensions: None,
    };
    Ok(TsaRequest {
        der: req
            .to_der()
            .map_err(|e| SignError::der("timestamp request", e))?,
        hash,
        imprint: imprint.to_vec(),
        nonce,
    })
}

/// Extract the token (ContentInfo DER) from a TimeStampResp; rejects non-granted statuses.
pub fn token_from_response(resp: &[u8]) -> Result<Vec<u8>> {
    if resp.len() > crate::limits::MAX_CMS_SIZE {
        return Err(SignError::Limit("timestamp response too large".into()));
    }
    let bytes = if tlv::read(resp).is_ok() {
        resp.to_vec()
    } else {
        tlv::ber_to_der(resp)?
    };
    let (outer, _) = tlv::read(&bytes)?;
    let parts = tlv::children(outer.content)?;
    let status_info = parts
        .first()
        .ok_or_else(|| SignError::Timestamp("empty response".into()))?;
    let status_tlv = tlv::children(status_info.content)?;
    let status = status_tlv
        .first()
        .filter(|t| t.tag == 0x02)
        .map(|t| t.content)
        .ok_or_else(|| SignError::Timestamp("response without status".into()))?;
    let code = match status {
        [v] => *v,
        _ => 0xFF,
    };
    if code > 1 {
        let what = match code {
            2 => "rejection",
            3 => "waiting",
            4 | 5 => "revocation",
            _ => "unknown status",
        };
        return Err(SignError::Timestamp(format!(
            "the timestamp authority answered {what}"
        )));
    }
    let token = parts
        .get(1)
        .ok_or_else(|| SignError::Timestamp("response carries no token".into()))?;
    Ok(token.raw.to_vec())
}

/// Result of checking a timestamp token.
#[derive(Debug, Clone, Default)]
pub struct TokenCheck {
    /// genTime (Unix seconds).
    pub gen_time: Option<i64>,
    /// The TSA certificate.
    pub tsa: Option<Cert>,
    /// Imprint matches, CMS signature verifies, TSA certificate has the timeStamping EKU.
    pub valid: bool,
    /// The TSA chains to a trust anchor (web PKI roots or user-trusted roots).
    pub trusted: bool,
    /// Errors (each makes the token invalid).
    pub errors: Vec<String>,
    /// Observations.
    pub warnings: Vec<String>,
    /// Nonce from the TSTInfo.
    pub nonce: Option<Vec<u8>>,
    /// Imprint digest algorithm.
    pub hash: Option<HashAlg>,
}

/// Verify a timestamp token over data whose digest (for the token's imprint algorithm) is
/// `expected(hash)`. Chains the TSA to `anchors` (plus `pool` intermediates) at genTime.
pub fn verify_token(
    token_der: &[u8],
    expected: &dyn Fn(HashAlg) -> Vec<u8>,
    anchors: &[Anchor],
    pool: &[Cert],
) -> Result<TokenCheck> {
    let mut out = TokenCheck::default();
    let cms = ParsedCms::parse(token_der)?;
    if cms.signed_data.encap_content_info.econtent_type != oids::TST_INFO {
        out.errors.push("not a timestamp token".into());
        return Ok(out);
    }
    let Some(econtent) = cms.econtent.clone() else {
        out.errors.push("timestamp token without TSTInfo".into());
        return Ok(out);
    };
    let tst = TstInfo::from_der(&econtent).map_err(|e| SignError::der("TSTInfo", e))?;
    let gen = tst.gen_time.to_unix_duration().as_secs() as i64;
    out.gen_time = Some(gen);
    out.nonce = tst.nonce.as_ref().map(|n| n.as_bytes().to_vec());
    let ih = HashAlg::from_oid(&tst.message_imprint.hash_algorithm.oid)?;
    out.hash = Some(ih);
    let imprint_ok = tst.message_imprint.hashed_message.as_bytes() == expected(ih).as_slice();
    if !imprint_ok {
        out.errors
            .push("the timestamp is for different data (imprint mismatch)".into());
    }
    let signer = verify_signer(&cms, &|h| h.digest(&econtent))?;
    out.errors.extend(signer.errors.iter().cloned());
    out.warnings.extend(signer.warnings.iter().cloned());
    if let Some(tsa) = &signer.signer {
        if !x509::is_tsa_cert(tsa) {
            out.errors
                .push("the timestamp signer is not a timestamping certificate".into());
        }
        let mut all: Vec<Cert> = cms.certs.clone();
        all.extend(pool.iter().cloned());
        let chain = x509::build_chain(tsa, &all, anchors, gen);
        out.trusted = chain.trusted && tsa.valid_at(gen);
        if !tsa.valid_at(gen) {
            out.errors
                .push("the timestamp certificate was not valid at the timestamp time".into());
        }
        out.warnings.extend(chain.problems);
    }
    out.tsa = signer.signer.clone();
    out.valid =
        imprint_ok && signer.signature_valid && signer.digest_matches && out.errors.is_empty();
    Ok(out)
}

/// The token as a CMS attribute value.
pub fn token_any(token_der: &[u8]) -> Result<Any> {
    Any::from_der(token_der).map_err(|e| SignError::der("timestamp token", e))
}

/// Check a TSA response against a request we built for `imprint` (nonce, imprint,
/// signature) and return the token DER.
pub fn accept_response(
    resp: &[u8],
    hash: HashAlg,
    imprint: &[u8],
) -> Result<(Vec<u8>, TokenCheck)> {
    let token = token_from_response(resp)?;
    let check = verify_token(
        &token,
        &|h| {
            if h == hash {
                imprint.to_vec()
            } else {
                Vec::new()
            }
        },
        &[],
        &[],
    )?;
    if !check.valid {
        return Err(SignError::Timestamp(check.errors.join("; ")));
    }
    if let Some(n) = &check.nonce {
        let want = nonce_for(imprint);
        if strip_zero(n) != strip_zero(&want) {
            return Err(SignError::Timestamp("nonce mismatch".into()));
        }
    }
    Ok((token, check))
}

fn strip_zero(b: &[u8]) -> &[u8] {
    let n = b.iter().take_while(|x| **x == 0).count();
    b.get(n..).unwrap_or_default()
}
