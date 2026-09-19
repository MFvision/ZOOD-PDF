//! PAdES: signing a PDF, timestamping it, adding validation data, and
//! verifying every signature in it — `warraq_pdf::signature` for the file,
//! the rest of this crate for the cryptography.
//!
//! Baseline levels (ETSI EN 319 142-1): B-B is [`sign`]; B-T adds a
//! signature timestamp ([`finish`]); B-LT adds the chain's revocation data
//! to `/DSS` ([`add_validation`]); B-LTA timestamps the whole document
//! ([`prepare_doc_timestamp`]).
use serde::Serialize;
use warraq_pdf::signature::{
    DssData, FieldLock, Prepared, SigAppearance, SigDict, SigImage, SigKind, SignatureSpec,
    VriEntry,
};
use warraq_pdf::PdfDocument;

use crate::asn1::{children, read};
use crate::chain::{self, Cert, CertSummary, ChainReport, Purpose, Trust, TrustStore};
use crate::cms;
use crate::keys::{Padding, Signer};
use crate::revocation::{self, IssuerKey, Status};
use crate::time::{iso, parse_pdf_date, pdf_date};
use crate::tsp;
use crate::{hex, HashAlg, Result, SignError};

pub const CADES: &str = "ETSI.CAdES.detached";
pub const RFC3161: &str = "ETSI.RFC3161";

/// What the person chose when signing.
pub struct SignOptions {
    pub field: Option<String>,
    pub page: usize,
    pub rect: Option<[f32; 4]>,
    /// The lines a visible signature shows (and the face for them).
    pub lines: Vec<String>,
    pub font: Option<Vec<u8>>,
    pub image: Option<SigImage>,
    pub name: Option<String>,
    pub reason: Option<String>,
    pub location: Option<String>,
    pub contact: Option<String>,
    /// When, and the local offset from UTC, for `/M`.
    pub time: i64,
    pub offset_minutes: i32,
    /// Certify, with DocMDP `/P` 1–3; `None` approves.
    pub certify: Option<u8>,
    pub lock_fields: bool,
    pub padding: Padding,
    /// Room for a signature timestamp is kept, and a request made for one.
    pub timestamp: bool,
}

/// A signed file, or one waiting for its timestamp.
pub enum Signed {
    Done(Vec<u8>),
    /// The file with room for its signature, the signature (a CMS without
    /// its timestamp yet), and the request to send the authority.
    NeedsTimestamp {
        prepared: Vec<u8>,
        cms: Vec<u8>,
        request: Vec<u8>,
    },
}

/// Room for the signature: its certificates, the signature value and the
/// attributes, a margin, and a timestamp token when one will be added —
/// observed from public authorities at up to 7.7 KB.
fn contents_size(signer: &dyn Signer, timestamp: bool) -> usize {
    let certs: usize =
        signer.certificate().len() + signer.chain().iter().map(Vec::len).sum::<usize>();
    let signature = match signer.key_kind() {
        crate::keys::KeyKind::Rsa { bits } => bits / 8,
        _ => 128,
    };
    let base = certs + signature + 2048;
    let total = base + if timestamp { 16_384 } else { 0 };
    total.div_ceil(1024) * 1024
}

/// Signs `doc` as it stands (PAdES B-B, or B-T once [`finish`]ed).
pub fn sign(doc: &mut PdfDocument, signer: &dyn Signer, o: &SignOptions) -> Result<Signed> {
    let hash = signer.key_kind().hash();
    let spec = SignatureSpec {
        field: o.field.clone(),
        page: o.page,
        rect: o.rect,
        appearance: match (&o.font, o.rect) {
            (Some(font), Some(_)) => Some(SigAppearance {
                lines: o.lines.clone(),
                font,
                image: o.image.clone(),
            }),
            _ => None,
        },
        name: o.name.clone(),
        reason: o.reason.clone(),
        location: o.location.clone(),
        contact: o.contact.clone(),
        time: Some(pdf_date(o.time, o.offset_minutes)),
        sub_filter: CADES,
        kind: match o.certify {
            Some(p) => SigKind::Certification(p),
            None => SigKind::Approval,
        },
        lock_fields: o.lock_fields,
        contents_size: contents_size(signer, o.timestamp),
    };
    let mut prepared = doc.prepare_signature(&spec)?;
    let digest = hash.digest_parts(&prepared.signed_parts());
    let signature = cms::sign(
        signer,
        &cms::Content {
            econtent_type: crate::oids::DATA,
            econtent: None,
            digest: &digest,
            hash,
            padding: o.padding,
            extra_signed: vec![],
        },
    )?;
    if !o.timestamp {
        prepared.embed(&signature)?;
        return Ok(Signed::Done(prepared.bytes));
    }
    let value = cms::parse(&signature)?.signature;
    let request = tsp::request(hash, &hash.digest(&value))?;
    Ok(Signed::NeedsTimestamp {
        prepared: prepared.bytes,
        cms: signature,
        request: request.der,
    })
}

/// The nonce a request carries.
fn request_nonce(request: &[u8]) -> Result<Option<Vec<u8>>> {
    let (req, _) = read(request)?;
    Ok(children(req.value)?
        .into_iter()
        .skip(2)
        .find(|t| t.tag == 0x02)
        .map(|t| t.value.to_vec()))
}

/// The request's message imprint and its digest algorithm.
fn request_imprint(request: &[u8]) -> Result<(HashAlg, Vec<u8>)> {
    let req = <x509_tsp::TimeStampReq as der::Decode>::from_der(request).map_err(crate::cms_err)?;
    let hash = HashAlg::from_oid(&req.message_imprint.hash_algorithm.oid)
        .ok_or_else(|| SignError::Tsa("unsupported digest".into()))?;
    Ok((hash, req.message_imprint.hashed_message.as_bytes().to_vec()))
}

/// Adds the authority's answer to a signature waiting for its timestamp,
/// and writes the signature into the file.
pub fn finish(
    prepared: Vec<u8>,
    signature: &[u8],
    request: &[u8],
    response: &[u8],
) -> Result<Vec<u8>> {
    let (hash, imprint) = request_imprint(request)?;
    let value = cms::parse(signature)?.signature;
    if hash.digest(&value) != imprint {
        return Err(SignError::Tsa(
            "the request is not for this signature".into(),
        ));
    }
    let token = tsp::token_from_response(response, &imprint, request_nonce(request)?.as_deref())?;
    let stamped = cms::add_timestamp(signature, &token)?;
    let mut prepared = Prepared::find(prepared)?;
    prepared.embed(&stamped)?;
    Ok(prepared.bytes)
}

/// A document timestamp (PAdES B-LTA): the file with room for the token,
/// and the request (over the digest of what it covers).
pub fn prepare_doc_timestamp(doc: &mut PdfDocument) -> Result<(Vec<u8>, Vec<u8>)> {
    let spec = SignatureSpec {
        field: None,
        page: 0,
        rect: None,
        appearance: None,
        name: None,
        reason: None,
        location: None,
        contact: None,
        time: None,
        sub_filter: RFC3161,
        kind: SigKind::DocTimeStamp,
        lock_fields: false,
        contents_size: 16_384,
    };
    let prepared = doc.prepare_signature(&spec)?;
    let digest = HashAlg::Sha256.digest_parts(&prepared.signed_parts());
    let request = tsp::request(HashAlg::Sha256, &digest)?;
    Ok((prepared.bytes, request.der))
}

/// Writes the authority's token into a prepared document timestamp.
pub fn finish_doc_timestamp(prepared: Vec<u8>, request: &[u8], response: &[u8]) -> Result<Vec<u8>> {
    let mut prepared = Prepared::find(prepared)?;
    let (hash, imprint) = request_imprint(request)?;
    if hash.digest_parts(&prepared.signed_parts()) != imprint {
        return Err(SignError::Tsa("the request is not for this file".into()));
    }
    let token = tsp::token_from_response(response, &imprint, request_nonce(request)?.as_deref())?;
    prepared.embed(&token)?;
    Ok(prepared.bytes)
}

// ------------------------------------------------------------------ verify

/// One signature, checked.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignatureReport {
    pub field: String,
    /// `approval`, `certification` or `timestamp`.
    pub kind: &'static str,
    /// `valid`, `untrusted`, `modified` or `invalid`.
    pub status: &'static str,
    pub page: Option<usize>,
    pub visible: bool,
    pub sub_filter: String,
    pub signer: Option<CertSummary>,
    /// Who signed, as the person reads it.
    pub signed_by: String,
    /// The name the signature dictionary gives (`/Name`): the signer's own
    /// claim, not verified.
    pub claimed_name: Option<String>,
    pub reason: Option<String>,
    pub location: Option<String>,
    pub contact: Option<String>,
    /// The time the signer's computer claimed (`/M`), ISO 8601.
    pub claimed_time: Option<String>,
    pub integrity: Integrity,
    pub chain: Option<ChainReport>,
    pub timestamp: Option<TimestampReport>,
    pub revocation: RevocationReport,
    pub doc_mdp: Option<u8>,
    pub locks_fields: bool,
    pub changes: Vec<ChangeReport>,
    /// Problem codes, for the details.
    pub problems: Vec<String>,
    /// Where the signed revision ends.
    pub revision_end: usize,
    /// When the signer is not trusted: the certificate at the top of its
    /// path (base64 DER), which the person may choose to trust.
    pub trust_candidate: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Integrity {
    /// The byte range is well formed and leaves out exactly the signature.
    pub byte_range_ok: bool,
    /// It reaches the end of the file: nothing was added after.
    pub covers_whole_file: bool,
    /// The digest of the signed bytes is the one signed.
    pub digest_ok: bool,
    /// The signature verifies with the signer's key.
    pub signature_ok: bool,
    pub algorithm: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimestampReport {
    pub time: String,
    pub authority: String,
    /// The token's own signature verifies, and it stamps this signature.
    pub valid: bool,
    pub trusted: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevocationReport {
    /// Revocation data is in the file (`/DSS` or signed with the signature).
    pub embedded: bool,
    /// What it says of the signer's certificate: `good`, `revoked`,
    /// `unknown`, or `notChecked` when there is none for it.
    pub status: String,
    /// `ocsp` or `crl`.
    pub source: Option<String>,
    pub revoked_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeReport {
    pub kind: &'static str,
    pub count: usize,
    pub allowed: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub signatures: Vec<SignatureReport>,
    /// Signature fields not signed yet, by name.
    pub empty_fields: Vec<String>,
    /// The certification signature's DocMDP `/P`, if the file is certified.
    pub certified: Option<u8>,
    pub dss: DssCounts,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DssCounts {
    pub certs: usize,
    pub ocsps: usize,
    pub crls: usize,
}

/// The signature's hole in the file: `/Contents`, decoded, when the byte
/// range is well formed.
fn contents_at(bytes: &[u8], br: &[i64]) -> Option<(Vec<u8>, usize)> {
    let [a, b, c, d] = br[..] else {
        return None;
    };
    if a != 0 || b <= 0 || c <= b || d < 0 {
        return None;
    }
    let (b, c, d) = (b as usize, c as usize, d as usize);
    let end = c.checked_add(d)?;
    if end > bytes.len() || bytes[b] != b'<' || bytes[c - 1] != b'>' {
        return None;
    }
    // What comes before the hole must be this dictionary's /Contents key.
    let before = String::from_utf8_lossy(&bytes[b.saturating_sub(64)..b]).into_owned();
    if !before.trim_end().ends_with("/Contents") {
        return None;
    }
    let hexits = &bytes[b + 1..c - 1];
    if !hexits.len().is_multiple_of(2) || !hexits.iter().all(u8::is_ascii_hexdigit) {
        return None;
    }
    let decoded = hexits
        .chunks(2)
        .map(|p| u8::from_str_radix(std::str::from_utf8(p).ok()?, 16).ok())
        .collect::<Option<Vec<u8>>>()?;
    // A revision ends with %%EOF (and perhaps an end of line).
    let tail = String::from_utf8_lossy(&bytes[end.saturating_sub(8)..end]).into_owned();
    if !tail.trim_end().ends_with("%%EOF") {
        return None;
    }
    Some((decoded, end))
}

fn certs_of(ders: &[Vec<u8>]) -> Vec<Cert> {
    ders.iter().filter_map(|d| Cert::parse(d).ok()).collect()
}

/// The issuer of `path[i]`: the next certificate on the path, or the trust
/// anchor that signed it (which may be known only by its name and key).
fn issuer_of<'a>(path: &'a [Cert], i: usize, trust: &'a TrustStore) -> Option<&'a dyn IssuerKey> {
    if let Some(next) = path.get(i + 1) {
        return Some(next);
    }
    let cert = path.get(i)?;
    if cert.self_issued() {
        return None;
    }
    trust
        .anchors
        .iter()
        .find(|a| a.subject == cert.issuer && cert.signed_by(&a.spki))
        .map(|a| a as &dyn IssuerKey)
}

/// Revocation status of `cert` (issued by `issuer`) from the data given.
fn revocation_of(
    cert: &Cert,
    issuer: Option<&dyn IssuerKey>,
    ocsps: &[Vec<u8>],
    crls: &[Vec<u8>],
) -> RevocationReport {
    let mut out = RevocationReport {
        embedded: !ocsps.is_empty() || !crls.is_empty(),
        status: "notChecked".into(),
        ..RevocationReport::default()
    };
    let Some(issuer) = issuer else {
        return out;
    };
    for o in ocsps {
        if let Ok(check) = revocation::check_ocsp(o, cert, issuer) {
            if !check.signature_ok {
                continue;
            }
            out.source = Some("ocsp".into());
            match check.status {
                Status::Good => out.status = "good".into(),
                Status::Revoked { at } => {
                    out.status = "revoked".into();
                    out.revoked_at = Some(iso(at));
                }
                Status::Unknown => out.status = "unknown".into(),
            }
            return out;
        }
    }
    for c in crls {
        if let Ok(check) = revocation::check_crl(c, cert, issuer) {
            if !check.signature_ok {
                continue;
            }
            out.source = Some("crl".into());
            match check.revoked_at {
                Some(at) => {
                    out.status = "revoked".into();
                    out.revoked_at = Some(iso(at));
                }
                None => out.status = "good".into(),
            }
            return out;
        }
    }
    out
}

/// Verifies every signature in `bytes` (opened with `password`), trusting
/// `trust`, at `now` (Unix seconds).
pub fn verify(
    bytes: &[u8],
    password: Option<&str>,
    trust: &TrustStore,
    now: i64,
) -> Result<Report> {
    let doc = PdfDocument::open(bytes.to_vec(), password)?;
    let fields = doc.signature_fields();
    let dss = doc.dss();
    let mut report = Report {
        certified: doc.doc_mdp(),
        dss: DssCounts {
            certs: dss.certs.len(),
            ocsps: dss.ocsps.len(),
            crls: dss.crls.len(),
        },
        empty_fields: fields
            .iter()
            .filter(|f| f.value.is_none())
            .map(|f| f.name.clone())
            .collect(),
        ..Report::default()
    };
    let mut signed: Vec<(&warraq_pdf::signature::SigField, &SigDict)> = fields
        .iter()
        .filter_map(|f| f.value.as_ref().map(|v| (f, v)))
        .collect();
    signed.sort_by_key(|(_, v)| {
        v.byte_range
            .get(2)
            .zip(v.byte_range.get(3))
            .map(|(c, d)| c + d)
            .unwrap_or(0)
    });
    // The certification level is the certifying signature's own (its
    // /Reference is signed), not only what the catalog says now: a later
    // update could drop /Perms, or point the trailer at another catalog.
    report.certified = report
        .certified
        .into_iter()
        .chain(signed.iter().filter_map(|(_, s)| s.doc_mdp))
        .min();
    let certified = report.certified;
    let dss_certs = certs_of(&dss.certs);
    let mut locks: Vec<FieldLock> = Vec::new();

    for (index, (field, sig)) in signed.iter().enumerate() {
        if let Some(lock) = &sig.field_mdp {
            locks.push(lock.clone());
        }
        if let Some(lock) = &field.lock {
            locks.push(lock.clone());
        }
        let visible = field
            .rect
            .is_some_and(|r| r[2] - r[0] > 1.0 && r[3] - r[1] > 1.0);
        let mut r = SignatureReport {
            field: field.name.clone(),
            kind: if sig.doc_timestamp || sig.sub_filter == RFC3161 {
                "timestamp"
            } else if sig.doc_mdp.is_some() {
                "certification"
            } else {
                "approval"
            },
            status: "invalid",
            page: field.page,
            visible,
            sub_filter: sig.sub_filter.clone(),
            signer: None,
            // The certificate's name, once the signer is found: /Name is
            // the dictionary's own claim, outside what the signature covers.
            signed_by: String::new(),
            claimed_name: sig.name.clone().filter(|n| !n.trim().is_empty()),
            reason: sig.reason.clone(),
            location: sig.location.clone(),
            contact: sig.contact.clone(),
            claimed_time: sig.time.as_deref().and_then(parse_pdf_date).map(iso),
            integrity: Integrity::default(),
            chain: None,
            timestamp: None,
            revocation: RevocationReport {
                status: "notChecked".into(),
                ..RevocationReport::default()
            },
            doc_mdp: sig.doc_mdp,
            locks_fields: sig.field_mdp.is_some() || field.lock.is_some(),
            changes: Vec::new(),
            problems: Vec::new(),
            revision_end: 0,
            trust_candidate: None,
        };
        let Some((contents, end)) = contents_at(bytes, &sig.byte_range) else {
            r.problems.push("byteRange".into());
            report.signatures.push(r);
            continue;
        };
        r.revision_end = end;
        r.integrity.byte_range_ok = true;
        r.integrity.covers_whole_file = end == bytes.len();
        let br: Vec<usize> = sig.byte_range.iter().map(|v| *v as usize).collect();
        let parts = [&bytes[..br[1]], &bytes[br[2]..end]];
        if index >= 30 {
            // Not checked, to bound the work a file can ask for.
            r.problems.push("tooManySignatures".into());
            r.status = "unchecked";
            report.signatures.push(r);
            continue;
        }

        // The revision it signed must hold this very signature: the same
        // field and dictionary, unchanged since, the dictionary's own
        // /Contents where the byte range leaves its hole. A dictionary added
        // later that borrows a genuine signature's byte range (and so its
        // CMS) — to show another name, reason or time — fails here.
        let revision = PdfDocument::open(bytes[..end].to_vec(), password).ok();
        let in_revision = revision
            .as_ref()
            .is_some_and(|rev| doc.signed_in(rev, field));
        if !in_revision {
            r.integrity.byte_range_ok = false;
            r.problems.push("notInRevision".into());
        }

        check_signature(&mut r, &contents, &parts, sig, &dss, &dss_certs, trust, now);

        // What changed after it, and whether that was allowed.
        if let (Some(rev), false) = (&revision, r.integrity.covers_whole_file) {
            let changes = doc.changes_since(rev, &locks);
            let only_ts = changes.only_timestamps_added;
            for (kind, count) in &changes.kinds {
                r.changes.push(ChangeReport {
                    kind: kind.code(),
                    count: *count,
                    allowed: kind.allowed(certified, only_ts),
                });
            }
        }
        r.status = status_of(&r);
        report.signatures.push(r);
    }
    Ok(report)
}

/// Problems that make a signature invalid: what it signed or who signed it
/// is wrong, whatever anyone trusts.
const INVALID: [&str; 7] = [
    "certBinding",
    "noSigner",
    "notValidAtSigning",
    "revokedBeforeSigning",
    // The key was not allowed to sign; a certificate that is not a CA, or
    // one beyond its path length, issued the one below it.
    "keyUsage",
    "notCa",
    "pathLen",
];

/// Problems that leave a signature intact but its signer or time not
/// vouched for.
const UNTRUSTED: [&str; 4] = ["eku", "ekuCa", "weakHash", "noProofOfTime"];

fn has_problem(r: &SignatureReport, codes: &[&str]) -> bool {
    r.problems.iter().any(|p| {
        let code = p.split(':').next().unwrap_or(p);
        codes.contains(&code)
    })
}

/// The final word on a signature, from what was found.
fn status_of(r: &SignatureReport) -> &'static str {
    let i = &r.integrity;
    if !i.byte_range_ok || !i.digest_ok || !i.signature_ok || has_problem(r, &INVALID) {
        return "invalid";
    }
    if r.changes.iter().any(|c| !c.allowed) {
        return "modified";
    }
    let trusted = r.chain.as_ref().is_some_and(|c| c.trusted());
    if !trusted
        || r.revocation.status == "revoked"
        || r.timestamp.as_ref().is_some_and(|t| !t.valid)
        || has_problem(r, &UNTRUSTED)
    {
        return "untrusted";
    }
    "valid"
}

/// SHA-1 is accepted only for a signature a trusted timestamp puts before
/// 2017 (SHAttered, the first public SHA-1 collision, was published then).
const SHA1_UNTIL: i64 = 1_483_228_800;

/// Checks the cryptography of one signature (or document timestamp), filling
/// in `r`; returns the time it is judged at.
#[allow(clippy::too_many_arguments)]
fn check_signature(
    r: &mut SignatureReport,
    contents: &[u8],
    parts: &[&[u8]; 2],
    sig: &SigDict,
    dss: &DssData,
    dss_certs: &[Cert],
    trust: &TrustStore,
    now: i64,
) -> i64 {
    let der = match crate::asn1::first_der(contents) {
        Ok(d) => d,
        Err(e) => {
            r.problems.push(format!("cms:{e}"));
            return now;
        }
    };
    let timestamp_only = r.kind == "timestamp";
    let parsed = match cms::parse(der) {
        Ok(p) => p,
        Err(e) => {
            r.problems.push(format!("cms:{e}"));
            return now;
        }
    };
    let mut pool = cms::certificates(&parsed);
    pool.extend(dss_certs.iter().cloned());
    let Some(signer) = cms::find_signer(&parsed, &pool).cloned() else {
        r.problems.push("noSigner".into());
        return now;
    };
    r.signer = Some(signer.summary());
    // Who signed is who the certificate says.
    r.signed_by = signer.common_name();
    r.integrity.algorithm = parsed.sig_alg.name();

    // The time the signer's computer claimed (signed, but the signer's own
    // word), and a time an authority vouches for, if there is one.
    let claimed = parsed
        .signing_time
        .or_else(|| sig.time.as_deref().and_then(parse_pdf_date));
    let mut trusted_time: Option<i64> = None;
    let mut weak = false;
    if timestamp_only {
        // A document timestamp: the token stamps the digest of the bytes,
        // and its time is the authority's own statement.
        match tsp::check_token(der, dss_certs) {
            Ok(check) => {
                let imprint_ok = check.info.hash.digest_parts(parts) == check.info.imprint;
                r.integrity.digest_ok = imprint_ok;
                r.integrity.signature_ok = check.signature_ok;
                trusted_time = Some(check.info.gen_time);
                r.claimed_time = Some(iso(check.info.gen_time));
                r.signed_by = check.authority.clone();
                weak = check.info.hash == HashAlg::Sha1;
            }
            Err(e) => r.problems.push(format!("token:{e}")),
        }
    } else {
        // adbe.pkcs7.sha1 signs the SHA-1 of the bytes as its content.
        let digest = if sig.sub_filter == "adbe.pkcs7.sha1" {
            match &parsed.econtent {
                Some(content) if *content == HashAlg::Sha1.digest_parts(parts) => {
                    parsed.digest.digest(content)
                }
                _ => Vec::new(),
            }
        } else {
            parsed.digest.digest_parts(parts)
        };
        let check = cms::check(&parsed, &signer, &digest);
        r.integrity.digest_ok = check.digest_ok && check.content_type_ok;
        r.integrity.signature_ok = check.signature_ok;
        if check.cert_binding_ok == Some(false) {
            r.problems.push("certBinding".into());
        }
        if let Some(p) = check.problem {
            r.problems.push(format!("signature:{p}"));
        }
        weak = parsed.digest == HashAlg::Sha1
            || sig.sub_filter == "adbe.pkcs7.sha1"
            || matches!(
                parsed.sig_alg,
                crate::keys::SigAlg::RsaPkcs1(HashAlg::Sha1)
                    | crate::keys::SigAlg::Ecdsa(HashAlg::Sha1)
                    | crate::keys::SigAlg::RsaPss {
                        hash: HashAlg::Sha1,
                        ..
                    }
            );
        // A signature timestamp: the token stamps the signature value. Its
        // time is relied on only when an authority trusted for timestamping
        // signed it; anyone can make a token with a key of their own, and a
        // token sits outside what the signer signed.
        if let Some(token) = parsed.timestamps.first() {
            match tsp::check_token(token, dss_certs) {
                Ok(t) => {
                    let stamps_this = t.info.hash.digest(&parsed.signature) == t.info.imprint;
                    let tsa_chain = t.signer.as_ref().map(|c| {
                        chain::build(
                            c,
                            &[cms::certificates(&t.info.parsed), dss_certs.to_vec()].concat(),
                            trust,
                            t.info.gen_time,
                            Purpose::Timestamps,
                        )
                    });
                    let valid = t.signature_ok && stamps_this;
                    let trusted = valid
                        && t.purpose_ok
                        && tsa_chain.is_some_and(|c| c.trusted() && c.valid_at_time);
                    if trusted {
                        trusted_time = Some(t.info.gen_time);
                    }
                    r.timestamp = Some(TimestampReport {
                        time: iso(t.info.gen_time),
                        authority: t.authority,
                        valid,
                        trusted,
                    });
                }
                Err(e) => r.problems.push(format!("token:{e}")),
            }
        }
    }

    // The chain, judged at the trusted time — or, without one, now (ETSI
    // EN 319 102-1): the time the signer claimed proves nothing, so a
    // certificate that has expired since is "not proven" rather than valid.
    let purpose = if timestamp_only {
        Purpose::Timestamps
    } else {
        Purpose::Documents
    };
    let at = trusted_time.unwrap_or(now);
    let mut chain = chain::build(&signer, &pool, trust, at, purpose);
    if !chain.valid_at_time {
        let valid_when_claimed = trusted_time.is_none()
            && claimed.is_some_and(|c| chain.path.iter().all(|cert| cert.valid_at(c)));
        r.problems.push(if valid_when_claimed {
            "noProofOfTime".into()
        } else {
            "notValidAtSigning".into()
        });
    }
    // SHA-1 only for what a trusted time puts before collisions were public.
    let old_enough = trusted_time.is_some_and(|t| t < SHA1_UNTIL);
    if old_enough {
        chain.problems.retain(|p| !p.starts_with("weakHash"));
    } else if weak {
        r.problems.push("weakHash".into());
    }
    r.problems.extend(chain.problems.iter().cloned());
    let issuer = issuer_of(&chain.path, 0, trust);
    let mut ocsps = dss.ocsps.clone();
    ocsps.extend(parsed.archived.ocsps.iter().cloned());
    let mut crls = dss.crls.clone();
    crls.extend(parsed.archived.crls.iter().cloned());
    crls.extend(parsed.crls.iter().cloned());
    r.revocation = revocation_of(&signer, issuer, &ocsps, &crls);
    if let Some(revoked) = r.revocation.revoked_at.as_deref() {
        // Revoked before the trusted time — or before even the signer's own.
        if let Some(signed) = trusted_time.or(claimed) {
            if revoked <= iso(signed).as_str() {
                r.problems.push("revokedBeforeSigning".into());
            }
        }
    }
    if !chain.trusted() {
        r.trust_candidate = match chain.trust {
            // A forged or broken path: nothing to trust.
            Trust::Broken { .. } => None,
            // The certificate is not for this purpose: only trusting it
            // itself would do, and that is the person's call.
            _ if !chain.purpose_ok => Some(crate::base64(&signer.der)),
            _ => chain.path.last().map(|c| crate::base64(&c.der)),
        };
    }
    r.chain = Some(chain);
    at
}

// -------------------------------------------------------------- validation

/// Something to fetch for long-term validation.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fetch {
    pub url: String,
    /// `ocsp` (POST the body), `crl` or `certificate` (GET).
    pub kind: &'static str,
    /// Whose status or issuer this is, by name.
    pub about: String,
    #[serde(skip)]
    pub body: Option<Vec<u8>>,
}

/// The certificate paths of every signature and timestamp in the file.
fn paths(
    doc: &PdfDocument,
    bytes: &[u8],
    trust: &TrustStore,
    now: i64,
) -> Vec<(Vec<u8>, Vec<Cert>)> {
    let dss_certs = certs_of(&doc.dss().certs);
    let mut out = Vec::new();
    for field in doc.signature_fields() {
        let Some(sig) = field.value else {
            continue;
        };
        let Some((contents, _)) = contents_at(bytes, &sig.byte_range) else {
            continue;
        };
        let Ok(der) = crate::asn1::first_der(&contents) else {
            continue;
        };
        let Ok(parsed) = cms::parse(der) else {
            continue;
        };
        let mut pool = cms::certificates(&parsed);
        pool.extend(dss_certs.iter().cloned());
        let mut path = Vec::new();
        if let Some(signer) = cms::find_signer(&parsed, &pool) {
            path.extend(chain::build(signer, &pool, trust, now, Purpose::Documents).path);
        }
        for token in &parsed.timestamps {
            if let Ok(t) = tsp::check_token(token, &dss_certs) {
                if let Some(tsa) = &t.signer {
                    let tsa_pool = [cms::certificates(&t.info.parsed), dss_certs.clone()].concat();
                    path.extend(chain::build(tsa, &tsa_pool, trust, now, Purpose::Timestamps).path);
                }
            }
        }
        out.push((contents, path));
    }
    out
}

/// What to fetch to make the file's signatures verifiable for the long term:
/// for every certificate in their paths, an OCSP answer from its issuer (or
/// failing that the issuer's revocation list), and an issuer certificate a
/// path is missing.
pub fn fetches(
    bytes: &[u8],
    password: Option<&str>,
    trust: &TrustStore,
    now: i64,
) -> Result<Vec<Fetch>> {
    let doc = PdfDocument::open(bytes.to_vec(), password)?;
    let mut out: Vec<Fetch> = Vec::new();
    let mut push = |f: Fetch| {
        if !out.iter().any(|o| o.url == f.url && o.body == f.body) {
            out.push(f);
        }
    };
    for (_, path) in paths(&doc, bytes, trust, now) {
        for (i, cert) in path.iter().enumerate() {
            if cert.self_issued() {
                continue;
            }
            match issuer_of(&path, i, trust) {
                Some(issuer) => {
                    let ocsp = cert.ocsp_urls().into_iter().find(|u| u.starts_with("http"));
                    match (ocsp, revocation::ocsp_request(cert, issuer)) {
                        (Some(url), Ok(body)) => push(Fetch {
                            url,
                            kind: "ocsp",
                            about: cert.common_name(),
                            body: Some(body),
                        }),
                        _ => {
                            if let Some(url) =
                                cert.crl_urls().into_iter().find(|u| u.starts_with("http"))
                            {
                                push(Fetch {
                                    url,
                                    kind: "crl",
                                    about: cert.common_name(),
                                    body: None,
                                });
                            }
                        }
                    }
                }
                None => {
                    if let Some(url) = cert
                        .ca_issuer_urls()
                        .into_iter()
                        .find(|u| u.starts_with("http"))
                    {
                        push(Fetch {
                            url,
                            kind: "certificate",
                            about: cert.issuer_name(),
                            body: None,
                        });
                    }
                }
            }
        }
    }
    Ok(out)
}

/// What adding validation data did.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Validation {
    pub certs: usize,
    pub ocsps: usize,
    pub crls: usize,
    /// Answers that were not what they claimed (by position).
    pub rejected: Vec<usize>,
}

/// Adds to `/DSS` the certificates of every signature's path and the
/// revocation answers (`kind`, bytes) that check out against them.
pub fn add_validation(
    doc: &mut PdfDocument,
    answers: &[(String, Vec<u8>)],
    trust: &TrustStore,
    now: i64,
) -> Result<(Vec<u8>, Validation)> {
    let bytes = doc.original_bytes().to_vec();
    let mut extra: Vec<Cert> = Vec::new();
    for (kind, der) in answers {
        if kind == "certificate" {
            // A CA answers with DER, or with a PKCS#7 "certs-only" bundle.
            if let Ok(c) = Cert::parse(crate::asn1::first_der(der).unwrap_or(der)) {
                extra.push(c);
            } else if let Ok(p) = cms::parse(der) {
                extra.extend(cms::certificates(&p));
            }
        }
    }
    let mut data = DssData::default();
    let mut validation = Validation::default();
    let mut accepted = vec![false; answers.len()];
    let dss_certs = certs_of(&doc.dss().certs);
    for (contents, mut path) in paths(doc, &bytes, trust, now) {
        // Complete a path with fetched issuer certificates.
        while let Some(last) = path.last().cloned() {
            if last.self_issued() || path.len() > 12 {
                break;
            }
            match extra
                .iter()
                .find(|c| c.subject == last.issuer && last.signed_by(&c.spki))
            {
                Some(issuer) if !path.iter().any(|p| p.der == issuer.der) => {
                    path.push(issuer.clone())
                }
                _ => break,
            }
        }
        let mut vri = VriEntry {
            key: hex(&HashAlg::Sha1.digest(&contents)),
            ..VriEntry::default()
        };
        for (i, cert) in path.iter().enumerate() {
            vri.certs.push(cert.der.clone());
            let Some(issuer) = issuer_of(&path, i, trust).or_else(|| {
                dss_certs
                    .iter()
                    .find(|c| c.subject == cert.issuer)
                    .map(|c| c as &dyn IssuerKey)
            }) else {
                continue;
            };
            for (n, (kind, der)) in answers.iter().enumerate() {
                let ok = match kind.as_str() {
                    "ocsp" => {
                        revocation::check_ocsp(der, cert, issuer).is_ok_and(|c| c.signature_ok)
                    }
                    "crl" => revocation::check_crl(der, cert, issuer).is_ok_and(|c| c.signature_ok),
                    _ => false,
                };
                if ok {
                    accepted[n] = true;
                    let raw = crate::asn1::first_der(der)
                        .map(<[u8]>::to_vec)
                        .unwrap_or_else(|_| der.clone());
                    if kind == "ocsp" {
                        vri.ocsps.push(raw);
                    } else {
                        vri.crls.push(raw);
                    }
                }
            }
        }
        for c in &vri.certs {
            if !data.certs.contains(c) {
                data.certs.push(c.clone());
            }
        }
        for o in &vri.ocsps {
            if !data.ocsps.contains(o) {
                data.ocsps.push(o.clone());
            }
        }
        for c in &vri.crls {
            if !data.crls.contains(c) {
                data.crls.push(c.clone());
            }
        }
        data.vri.push(vri);
    }
    for (n, (kind, _)) in answers.iter().enumerate() {
        if kind != "certificate" && !accepted[n] {
            validation.rejected.push(n);
        }
    }
    let added = doc.add_dss(&data)?;
    validation.certs = added.certs;
    validation.ocsps = added.ocsps;
    validation.crls = added.crls;
    Ok((doc.save_incremental()?, validation))
}
