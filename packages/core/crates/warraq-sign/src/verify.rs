//! Signature verification: byte-range sanity (wrapping / borrowed signatures), CMS
//! integrity, certificate chain to user-trusted roots (none by default), extended key usage
//! policy, validity time, signature timestamps, revocation data from the DSS, and the list of
//! modifications made after each signature with DocMDP/FieldMDP classification and attack
//! evidence.

use crate::cms::{self, ParsedCms};
use crate::diff::{self, Attack, Change, Locks, Policy};
use crate::error::Result;
use crate::hash::{hex_decode, HashAlg};
use crate::limits::MAX_SIGNATURES;
use crate::ocsp::{self, Revocation};
use crate::oids;
use crate::pdfobj::{self, get_name, get_text, iso_date, parse_pdf_date};
use crate::sign::{self, lock_from_dict, SigSlot};
use crate::tsp;
use crate::x509::{self, Anchor, Cert, EkuVerdict};
use lopdf::Object;
use serde::Serialize;
use warraq_pdf::Pdf;

/// Verification inputs.
#[derive(Debug, Clone, Default)]
pub struct VerifyOptions {
    /// Roots the user trusts for document signatures (the document trust store is EMPTY by
    /// default: signatures then verify as "valid, signer identity unknown").
    pub trusted_roots: Vec<Cert>,
    /// Current time (Unix seconds) from the host clock.
    pub now: i64,
}

/// A problem or observation.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Note {
    /// Machine code.
    pub code: String,
    /// English message.
    pub message: String,
}

fn note(code: &str, message: impl Into<String>) -> Note {
    Note {
        code: code.into(),
        message: message.into(),
    }
}

/// Signer certificate summary.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignerInfo {
    /// Common name (or organisation).
    pub name: String,
    /// Subject DN.
    pub subject: String,
    /// Issuer DN.
    pub issuer: String,
    /// Serial (hex).
    pub serial: String,
    /// Key algorithm.
    pub key_algorithm: String,
    /// Validity start (ISO 8601).
    pub not_before: String,
    /// Validity end (ISO 8601).
    pub not_after: String,
    /// Email from the subject, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
}

/// Timestamp summary.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimestampInfo {
    /// genTime (ISO 8601).
    pub time: Option<String>,
    /// Token verifies and covers this signature.
    pub valid: bool,
    /// TSA chains to a known root (web PKI roots or user roots).
    pub trusted: bool,
    /// TSA name.
    pub authority: Option<String>,
}

/// Verification result for one signature.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// 0-based order (by signed revision).
    pub index: usize,
    /// Field name.
    pub field: String,
    /// `approval`, `certification` or `documentTimestamp`.
    pub kind: &'static str,
    /// `/SubFilter`.
    pub sub_filter: String,
    /// `valid`, `valid_identity_unknown`, `modified`, `invalid`, `unsupported`, `unchecked`.
    pub status: &'static str,
    /// Bytes and cryptography check out for the signed revision.
    pub integrity: bool,
    /// `trusted`, `unknown`, `invalid`.
    pub identity: &'static str,
    /// Signer.
    pub signer: Option<SignerInfo>,
    /// Certificate path (display names, leaf first).
    pub chain: Vec<String>,
    /// `/M` (claimed by the signer, not verified).
    pub claimed_time: Option<String>,
    /// Signature timestamp (or the document timestamp itself).
    pub timestamp: Option<TimestampInfo>,
    /// `/Reason`.
    pub reason: Option<String>,
    /// `/Location`.
    pub location: Option<String>,
    /// `/ContactInfo`.
    pub contact_info: Option<String>,
    /// PAdES level reached: `B-B`, `B-T`, `B-LT`, `B-LTA`.
    pub level: &'static str,
    /// Index of the signed revision.
    pub revision: Option<usize>,
    /// The signature covers the whole current file.
    pub covers_whole_document: bool,
    /// `/ByteRange`.
    pub byte_range: [usize; 4],
    /// DocMDP P when this is a certification signature.
    pub certification: Option<u8>,
    /// FieldMDP locks written by this signature.
    pub locks: Vec<serde_json::Value>,
    /// `good`, `revoked`, `unknown` (+ source).
    pub revocation: String,
    /// Why the status is not `valid` (machine codes with messages).
    pub reasons: Vec<Note>,
    /// Observations.
    pub warnings: Vec<Note>,
    /// Changes after this signature.
    pub modifications: Vec<Change>,
    /// Attack evidence.
    pub attacks: Vec<Attack>,
}

struct Ctx<'a> {
    pdf: &'a Pdf,
    revisions: Vec<warraq_pdf::revisions::Revision>,
    dss_certs: Vec<Cert>,
    dss_ocsps: Vec<Vec<u8>>,
    dss_crls: Vec<Vec<u8>>,
    opts: &'a VerifyOptions,
    anchors: Vec<Anchor>,
    tsa_anchors: Vec<Anchor>,
}

fn dss_items(pdf: &Pdf, key: &[u8]) -> Vec<Vec<u8>> {
    let Ok(cat) = pdf.catalog() else {
        return Vec::new();
    };
    let Some(dss) = cat.get(b"DSS").ok().and_then(|o| pdfobj::dict_of(pdf, o)) else {
        return Vec::new();
    };
    match pdfobj::get(pdf, dss, key) {
        Some(Object::Array(a)) => a
            .iter()
            .take(crate::limits::MAX_CERTS)
            .filter_map(|o| match pdf.resolve(o)? {
                Object::Stream(s) => warraq_pdf::limits::decode_stream(s, pdf.limits()).ok(),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// Certificate summary (also used by the UI to preview a PKCS#12 before signing).
pub fn signer_info(c: &Cert) -> SignerInfo {
    let (a, b) = c.validity();
    SignerInfo {
        name: c.display_name(),
        subject: x509::name_string(c.subject()),
        issuer: x509::name_string(c.issuer()),
        serial: c.serial_hex(),
        key_algorithm: c.key_algorithm().name(),
        not_before: iso_date(a),
        not_after: iso_date(b),
        email: x509::name_attr(c.subject(), oids::AT_EMAIL),
    }
}

/// Verify every signature of `pdf`.
pub fn verify(pdf: &Pdf, opts: &VerifyOptions) -> Result<Vec<Report>> {
    let mut anchors = Vec::new();
    for c in &opts.trusted_roots {
        anchors.push(Anchor::from_cert(c)?);
    }
    let mut tsa_anchors = x509::tsa_anchors();
    tsa_anchors.extend(anchors.iter().cloned());
    let dss_certs = dss_items(pdf, b"Certs")
        .iter()
        .filter_map(|d| Cert::from_der(d).ok())
        .collect();
    let ctx = Ctx {
        pdf,
        revisions: warraq_pdf::revisions::revisions(pdf.bytes(), pdf.limits()),
        dss_certs,
        dss_ocsps: dss_items(pdf, b"OCSPs"),
        dss_crls: dss_items(pdf, b"CRLs"),
        opts,
        anchors,
        tsa_anchors,
    };
    let slots = sign::signature_slots(pdf);
    // Certification signature (by /Perms /DocMDP) and its P.
    let cert_sig = pdf
        .catalog()
        .ok()
        .and_then(|c| pdfobj::dict_of(pdf, c.get(b"Perms").ok()?))
        .and_then(|p| p.get(b"DocMDP").ok()?.as_reference().ok());
    let mut reports = Vec::new();
    let mut locks = Locks::default();
    let mut docmdp: Option<u8> = None;
    let mut budget: u64 = crate::limits::MAX_VERIFY_WORK;
    for (i, slot) in slots.iter().enumerate().take(MAX_SIGNATURES) {
        let sd = pdf.get_dict(slot.sig_id).cloned().unwrap_or_default();
        // Locks written by this signature (FieldMDP reference or the field's /Lock).
        let mut own_locks = Vec::new();
        if let Some(Object::Array(refs)) = pdfobj::get(pdf, &sd, b"Reference") {
            for r in refs {
                if let Some(rd) = pdfobj::dict_of(pdf, r) {
                    if get_name(pdf, rd, b"TransformMethod") == Some(b"FieldMDP") {
                        if let Some(Object::Dictionary(tp)) =
                            pdfobj::get(pdf, rd, b"TransformParams")
                        {
                            if let Some(l) = lock_from_dict(pdf, tp) {
                                own_locks.push(l);
                            }
                        }
                    }
                }
            }
        }
        for l in &own_locks {
            locks.add(l);
        }
        let is_cert = cert_sig == Some(slot.sig_id);
        let p = if is_cert {
            sign::docmdp_p_of_sig(pdf, &sd).or(Some(2))
        } else {
            None
        };
        if p.is_some() {
            docmdp = p;
        }
        let policy = Policy {
            docmdp,
            locks: locks.clone(),
        };
        // Work budget: every signature hashes (and may re-parse) up to the whole file.
        let cost = slot.range[2]
            .saturating_add(slot.range[3])
            .saturating_mul(2) as u64;
        if cost > budget {
            reports.push(unchecked(i, slot));
            continue;
        }
        budget -= cost;
        let mut r = verify_one(&ctx, i, slot, &sd, &policy)?;
        r.certification = p;
        if is_cert {
            r.kind = "certification";
        }
        r.locks = own_locks
            .iter()
            .map(|l| serde_json::json!({"action": l.action.pdf_name(), "fields": l.fields}))
            .collect();
        reports.push(r);
    }
    // Levels: B-LT when validation data covers the signer, B-LTA when a document timestamp
    // follows it.
    let has_dss = !ctx.dss_ocsps.is_empty() || !ctx.dss_crls.is_empty();
    let ts_after: Vec<usize> = reports
        .iter()
        .filter(|r| r.kind == "documentTimestamp" && r.integrity)
        .map(|r| r.byte_range[2] + r.byte_range[3])
        .collect();
    for r in reports.iter_mut().filter(|r| r.kind != "documentTimestamp") {
        if r.level == "B-T" && has_dss && r.revocation.starts_with("good") {
            r.level = "B-LT";
            let end = r.byte_range[2] + r.byte_range[3];
            if ts_after.iter().any(|e| *e > end) {
                r.level = "B-LTA";
            }
        }
    }
    Ok(reports)
}

/// A report for a signature skipped because the work budget ran out.
fn unchecked(index: usize, slot: &SigSlot) -> Report {
    Report {
        index,
        field: slot.field.clone(),
        kind: if slot.kind == b"DocTimeStamp" {
            "documentTimestamp"
        } else {
            "approval"
        },
        sub_filter: String::from_utf8_lossy(&slot.sub_filter).into_owned(),
        status: "unchecked",
        integrity: false,
        identity: "unknown",
        signer: None,
        chain: Vec::new(),
        claimed_time: None,
        timestamp: None,
        reason: None,
        location: None,
        contact_info: None,
        level: "B-B",
        revision: None,
        covers_whole_document: false,
        byte_range: slot.range,
        certification: None,
        locks: Vec::new(),
        revocation: "unknown".into(),
        reasons: vec![note(
            "limit_exceeded",
            "too many signatures over a large file: this one was not checked",
        )],
        warnings: Vec::new(),
        modifications: Vec::new(),
        attacks: Vec::new(),
    }
}

/// Byte-range structure checks; returns reasons (empty = sane) and attack evidence.
fn check_range(ctx: &Ctx<'_>, slot: &SigSlot) -> (Vec<Note>, Vec<Attack>, Option<usize>) {
    let bytes = ctx.pdf.bytes();
    let len = bytes.len();
    let r = slot.range;
    let mut reasons = Vec::new();
    let mut attacks = Vec::new();
    let end = r[2].checked_add(r[3]);
    let first_end = r[0].checked_add(r[1]);
    let sane = end.is_some_and(|e| e <= len) && first_end.is_some_and(|f| f < r[2]);
    if !sane {
        reasons.push(note(
            "byte_range_invalid",
            "the byte range overlaps itself or points outside the file",
        ));
        attacks.push(Attack {
            kind: "signature_wrapping",
            detail: "the /ByteRange is not a proper split of the file".into(),
        });
        return (reasons, attacks, None);
    }
    let end = end.unwrap_or(0);
    if r[0] != 0 {
        reasons.push(note(
            "byte_range_not_from_start",
            "the signed bytes do not start at the beginning of the file",
        ));
        attacks.push(Attack {
            kind: "borrowed_signature",
            detail: format!(
                "the signed range starts at byte {} — the signature was made for other bytes (a different document embedded here)",
                r[0]
            ),
        });
    }
    // The gap must be exactly this dictionary's /Contents hex string.
    let gap = bytes.get(r[1]..r[2]).unwrap_or_default();
    let inner = gap
        .strip_prefix(b"<")
        .and_then(|g| g.strip_suffix(b">"))
        .filter(|g| g.iter().all(u8::is_ascii_hexdigit));
    match inner.and_then(hex_decode) {
        Some(decoded) if decoded == slot.contents => {}
        _ => {
            reasons.push(note(
                "contents_not_in_gap",
                "the unsigned gap is not exactly the signature value",
            ));
            attacks.push(Attack {
                kind: "signature_wrapping",
                detail: "bytes other than the signature value are excluded from the signature (injected content hides in the unsigned gap)".into(),
            });
        }
    }
    // The signed bytes must end exactly at a revision end.
    let rev = ctx.revisions.iter().position(|x| x.end == end);
    let at_trailing_ws = bytes
        .get(end..)
        .is_some_and(|rest| rest.iter().all(u8::is_ascii_whitespace))
        && ctx.revisions.last().is_some_and(|x| x.end <= end);
    if rev.is_none() && !at_trailing_ws {
        reasons.push(note(
            "byte_range_not_at_revision_end",
            "the signed bytes do not end at the end of a saved revision",
        ));
        attacks.push(Attack {
            kind: "borrowed_signature",
            detail: format!(
                "the signed range ends at byte {end}, which is not the end of any revision of this file"
            ),
        });
    }
    let rev = rev.or_else(|| at_trailing_ws.then(|| ctx.revisions.len().saturating_sub(1)));
    (reasons, attacks, rev)
}

fn verify_one(
    ctx: &Ctx<'_>,
    index: usize,
    slot: &SigSlot,
    sd: &lopdf::Dictionary,
    policy: &Policy,
) -> Result<Report> {
    let pdf = ctx.pdf;
    let bytes = pdf.bytes();
    let is_ts = slot.kind == b"DocTimeStamp" || slot.sub_filter == b"ETSI.RFC3161";
    let mut rep = Report {
        index,
        field: slot.field.clone(),
        kind: if is_ts {
            "documentTimestamp"
        } else {
            "approval"
        },
        sub_filter: String::from_utf8_lossy(&slot.sub_filter).into_owned(),
        status: "invalid",
        integrity: false,
        identity: "unknown",
        signer: None,
        chain: Vec::new(),
        claimed_time: get_text(pdf, sd, b"M")
            .and_then(|m| parse_pdf_date(&m))
            .map(iso_date),
        timestamp: None,
        reason: get_text(pdf, sd, b"Reason"),
        location: get_text(pdf, sd, b"Location"),
        contact_info: get_text(pdf, sd, b"ContactInfo"),
        level: "B-B",
        revision: None,
        covers_whole_document: false,
        byte_range: slot.range,
        certification: None,
        locks: Vec::new(),
        revocation: "unknown".into(),
        reasons: Vec::new(),
        warnings: Vec::new(),
        modifications: Vec::new(),
        attacks: Vec::new(),
    };
    let (range_reasons, range_attacks, rev) = check_range(ctx, slot);
    let range_ok = range_reasons.is_empty();
    rep.reasons.extend(range_reasons);
    rep.attacks.extend(range_attacks);
    rep.revision = rev;
    let end = slot.range[2].saturating_add(slot.range[3]);
    rep.covers_whole_document = range_ok
        && bytes
            .get(end..)
            .is_some_and(|rest| rest.iter().all(u8::is_ascii_whitespace));
    // The signed revision must itself contain this very signature dictionary.
    let rev_pdf = if range_ok {
        match Pdf::open_with_limits(
            bytes.get(..end).unwrap_or_default().to_vec(),
            Some(pdf.password()),
            *pdf.limits(),
        ) {
            Ok(p) => Some(p),
            Err(e) => {
                rep.reasons.push(note(
                    "signed_revision_unreadable",
                    format!("the signed revision cannot be read: {e}"),
                ));
                None
            }
        }
    } else {
        None
    };
    if let Some(rp) = &rev_pdf {
        let same = match (rp.get(slot.sig_id), pdf.get(slot.sig_id)) {
            (Some(a), Some(b)) => warraq_pdf::compare::objects_equal(a, b, pdf.limits()),
            _ => false,
        };
        if !same {
            rep.reasons.push(note(
                "signature_not_in_signed_revision",
                "the signature dictionary is not part of the revision it claims to sign",
            ));
            rep.attacks.push(Attack {
                kind: "borrowed_signature",
                detail:
                    "the signature dictionary was introduced or altered outside the signed bytes"
                        .into(),
            });
        } else if let Some(lopdf::xref::XrefEntry::Normal { offset, .. }) =
            rp.document().reference_table.get(slot.sig_id.0)
        {
            // The gap must lie inside the signature object's own bytes.
            let off = *offset as usize;
            let endobj = bytes
                .get(off..end)
                .and_then(|s| s.windows(6).position(|w| w == b"endobj"))
                .map(|p| p + off);
            let inside = off < slot.range[1] && endobj.is_some_and(|e| slot.range[2] <= e);
            if !inside {
                rep.reasons.push(note(
                    "contents_outside_signature_object",
                    "the excluded bytes are not the /Contents of the signature dictionary",
                ));
                rep.attacks.push(Attack {
                    kind: "signature_wrapping",
                    detail: "the byte-range gap lies outside the signature dictionary".into(),
                });
            }
        } else {
            rep.reasons.push(note(
                "signature_in_object_stream",
                "the signature dictionary is stored in a compressed object stream",
            ));
        }
    }
    let signed_bytes =
        |h: HashAlg| -> Vec<u8> { sign::range_digest(bytes, slot.range, h).unwrap_or_default() };
    // Cryptography.
    let mut signer_cert: Option<Cert> = None;
    let mut pool: Vec<Cert> = ctx.dss_certs.clone();
    let mut check_time = ctx.opts.now;
    let mut crypto_ok = false;
    let mut cms_ocsps: Vec<Vec<u8>> = Vec::new();
    let mut cms_crls: Vec<Vec<u8>> = Vec::new();
    if slot.contents.iter().all(|b| *b == 0) {
        rep.reasons.push(note(
            "signature_pending",
            "the signature value is empty (unfinished signature)",
        ));
    } else if is_ts {
        match tsp::verify_token(&slot.contents, &signed_bytes, &ctx.tsa_anchors, &pool) {
            Ok(t) => {
                crypto_ok = t.valid;
                for e in &t.errors {
                    rep.reasons.push(note("timestamp_invalid", e.clone()));
                }
                for w in &t.warnings {
                    rep.warnings.push(note("timestamp_warning", w.clone()));
                }
                rep.timestamp = Some(TimestampInfo {
                    time: t.gen_time.map(iso_date),
                    valid: t.valid,
                    trusted: t.trusted,
                    authority: t.tsa.as_ref().map(Cert::display_name),
                });
                rep.identity = if t.trusted { "trusted" } else { "unknown" };
                if let Some(tsa) = &t.tsa {
                    rep.signer = Some(signer_info(tsa));
                }
                rep.level = "B-LTA";
            }
            Err(e) => rep.reasons.push(note("malformed_signature", e.to_string())),
        }
    } else {
        let sf = slot.sub_filter.as_slice();
        let supported = matches!(
            sf,
            b"ETSI.CAdES.detached" | b"adbe.pkcs7.detached" | b"adbe.pkcs7.sha1"
        );
        if !supported {
            rep.status = "unsupported";
            rep.reasons.push(note(
                "unsupported_sub_filter",
                format!(
                    "signature format /{} is not supported",
                    String::from_utf8_lossy(sf)
                ),
            ));
            return Ok(rep);
        }
        match ParsedCms::parse(&slot.contents) {
            Err(e) => rep.reasons.push(note("malformed_signature", e.to_string())),
            Ok(parsed) => {
                pool.extend(parsed.certs.iter().cloned());
                let result = if sf == b"adbe.pkcs7.sha1" {
                    let expect = signed_bytes(HashAlg::Sha1);
                    if parsed.econtent.as_deref() != Some(expect.as_slice()) {
                        rep.reasons.push(note(
                            "digest_mismatch",
                            "the document bytes do not match the signed digest",
                        ));
                    }
                    let ec = parsed.econtent.clone().unwrap_or_default();
                    cms::verify_signer(&parsed, &move |h| h.digest(&ec))
                } else {
                    cms::verify_signer(&parsed, &signed_bytes)
                };
                match result {
                    Err(e) => rep.reasons.push(note("malformed_signature", e.to_string())),
                    Ok(chk) => {
                        for e in &chk.errors {
                            let code = if e.contains("do not match the signed digest") {
                                "digest_mismatch"
                            } else if e.contains("does not verify") {
                                "signature_mismatch"
                            } else {
                                "cms_invalid"
                            };
                            rep.reasons.push(note(code, e.clone()));
                        }
                        for w in &chk.warnings {
                            rep.warnings.push(note("cms_warning", w.clone()));
                        }
                        if sf == b"ETSI.CAdES.detached" {
                            if chk.ess_ok.is_none() {
                                rep.warnings.push(note(
                                    "no_signing_certificate_attribute",
                                    "no signingCertificateV2 attribute (not PAdES baseline)",
                                ));
                            }
                            if chk.signing_time.is_some() {
                                rep.warnings.push(note(
                                    "signing_time_attribute",
                                    "a signing-time attribute is present (PAdES uses /M)",
                                ));
                            }
                        }
                        crypto_ok =
                            chk.signature_valid && chk.digest_matches && chk.errors.is_empty();
                        signer_cert = chk.signer.clone();
                    }
                }
                // Signature timestamp.
                if let Ok(Some(tok)) = parsed.unsigned_attr(oids::SIGNATURE_TIMESTAMP_TOKEN) {
                    let sigval = parsed.signature_value().unwrap_or_default().to_vec();
                    match der::Encode::to_der(tok)
                        .map_err(|e| crate::SignError::der("token", e))
                        .and_then(|t| {
                            tsp::verify_token(&t, &|h| h.digest(&sigval), &ctx.tsa_anchors, &pool)
                        }) {
                        Ok(t) => {
                            if t.valid {
                                if let Some(g) = t.gen_time {
                                    check_time = g;
                                }
                                rep.level = "B-T";
                            } else {
                                for e in &t.errors {
                                    rep.warnings.push(note("timestamp_invalid", e.clone()));
                                }
                            }
                            if t.valid && !t.trusted {
                                rep.warnings.push(note(
                                    "timestamp_authority_unknown",
                                    "the timestamp authority is not a known root",
                                ));
                            }
                            rep.timestamp = Some(TimestampInfo {
                                time: t.gen_time.map(iso_date),
                                valid: t.valid,
                                trusted: t.trusted,
                                authority: t.tsa.as_ref().map(Cert::display_name),
                            });
                        }
                        Err(e) => rep.warnings.push(note("timestamp_invalid", e.to_string())),
                    }
                }
                // Revocation archival attribute (Adobe) inside the signed attributes.
                if let Ok(Some(ria)) = parsed.signed_attr(oids::ADBE_REVOCATION_INFO) {
                    collect_revocation_info(ria, &mut cms_crls, &mut cms_ocsps);
                }
            }
        }
    }
    rep.integrity = crypto_ok && range_ok && rep.reasons.is_empty();
    // Identity (signature, not timestamps: those were handled above).
    if let Some(cert) = &signer_cert {
        rep.signer = Some(signer_info(cert));
        for o in ctx.dss_ocsps.iter().chain(cms_ocsps.iter()) {
            pool.extend(ocsp::response_certs(o));
        }
        let chain = x509::build_chain(cert, &pool, &ctx.anchors, check_time);
        rep.chain = chain.path.iter().map(Cert::display_name).collect();
        for pbm in &chain.problems {
            rep.warnings.push(note("chain_problem", pbm.clone()));
        }
        let mut identity_invalid = false;
        match x509::document_signing_policy(cert) {
            EkuVerdict::Accepted(_) => {}
            EkuVerdict::Rejected(why) => {
                identity_invalid = true;
                rep.reasons
                    .push(note("certificate_not_for_document_signing", why));
            }
        }
        if !cert.valid_at(check_time) {
            identity_invalid = true;
            rep.reasons.push(note(
                "certificate_expired",
                if rep.level == "B-B" {
                    "the signer certificate is not valid now and there is no trusted timestamp"
                } else {
                    "the signer certificate was not valid at the timestamp time"
                },
            ));
        }
        // Revocation.
        let ocsps: Vec<Vec<u8>> = ctx
            .dss_ocsps
            .iter()
            .chain(cms_ocsps.iter())
            .cloned()
            .collect();
        let crls: Vec<Vec<u8>> = ctx
            .dss_crls
            .iter()
            .chain(cms_crls.iter())
            .cloned()
            .collect();
        let issuer = chain.path.get(1).cloned();
        rep.revocation = match issuer.map(|i| ocsp::check(cert, &i, &ocsps, &crls)) {
            Some(Revocation::Good { source }) => format!("good ({source})"),
            Some(Revocation::Revoked { source, at }) => {
                if at <= check_time {
                    identity_invalid = true;
                    rep.reasons.push(note(
                        "certificate_revoked",
                        format!("the signer certificate was revoked on {}", iso_date(at)),
                    ));
                }
                format!("revoked ({source}, {})", iso_date(at))
            }
            _ => "unknown".into(),
        };
        rep.identity = if identity_invalid {
            "invalid"
        } else if chain.trusted {
            "trusted"
        } else {
            "unknown"
        };
    }
    // Modifications after the signed revision.
    if let (Some(rp), true) = (&rev_pdf, !rep.covers_whole_document) {
        let (mods, attacks) = diff::diff(rp, pdf, end, policy);
        rep.modifications = mods;
        rep.attacks.extend(attacks);
        if rep.modifications.iter().any(|m| !m.allowed) {
            rep.attacks.push(Attack {
                kind: "incremental_saving",
                detail: "later incremental updates change the document in ways this signature does not allow".into(),
            });
        }
    }
    // Trailing data after the last %%EOF.
    if let Some(last) = ctx.revisions.last() {
        let tail = bytes.get(last.end..).unwrap_or_default();
        if tail.windows(3).any(|w| w == b"obj") {
            rep.warnings.push(note(
                "trailing_data",
                "data after the last %%EOF (ignored by this viewer)",
            ));
            rep.attacks.push(Attack {
                kind: "trailing_data",
                detail: "objects were appended after the last end-of-file marker without a cross-reference section".into(),
            });
        }
    }
    rep.status = if !rep.integrity || rep.identity == "invalid" {
        "invalid"
    } else if rep.modifications.iter().any(|m| !m.allowed) {
        "modified"
    } else if rep.identity == "trusted" {
        "valid"
    } else {
        "valid_identity_unknown"
    };
    if rep.status == "valid_identity_unknown" && rep.kind != "documentTimestamp" {
        rep.warnings.push(note(
            "identity_unknown",
            "the signature is intact but the signer's certificate does not chain to a root you trust",
        ));
    }
    Ok(rep)
}

/// RevocationInfoArchival ::= SEQUENCE { crl [0] EXPLICIT SEQUENCE OF CRL OPTIONAL,
/// ocsp [1] EXPLICIT SEQUENCE OF OCSPResponse OPTIONAL, otherRevInfo [2] … }
fn collect_revocation_info(v: &der::Any, crls: &mut Vec<Vec<u8>>, ocsps: &mut Vec<Vec<u8>>) {
    let Ok(der_bytes) = der::Encode::to_der(v) else {
        return;
    };
    let Ok((seq, _)) = crate::tlv::read(&der_bytes) else {
        return;
    };
    let Ok(parts) = crate::tlv::children(seq.content) else {
        return;
    };
    for p in parts {
        let Ok((inner, _)) = crate::tlv::read(p.content) else {
            continue;
        };
        let Ok(items) = crate::tlv::children(inner.content) else {
            continue;
        };
        for it in items.into_iter().take(crate::limits::MAX_CERTS) {
            match p.tag {
                0xA0 => crls.push(it.raw.to_vec()),
                0xA1 => ocsps.push(it.raw.to_vec()),
                _ => {}
            }
        }
    }
}

/// Signature fields for `sign.list`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldInfo {
    /// Fully qualified name.
    pub name: String,
    /// Has a value.
    pub signed: bool,
    /// `approval`, `certification`, `documentTimestamp` (signed fields only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<&'static str>,
    /// 0-based page of the first widget.
    pub page: Option<usize>,
    /// Widget rectangle.
    pub rect: Option<[f64; 4]>,
    /// Visible (non-empty rectangle, not hidden).
    pub visible: bool,
    /// The field's own /Lock (applied when it gets signed).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lock: Option<serde_json::Value>,
}

/// List signature fields (signed and empty).
pub fn list_fields(pdf: &Pdf) -> Vec<FieldInfo> {
    let pages = warraq_pdf::pages::flatten(pdf).unwrap_or_default();
    let mut page_of = std::collections::BTreeMap::new();
    for (i, p) in pages.iter().enumerate() {
        if let Some(Object::Array(a)) = pdf
            .get_dict(p.id)
            .and_then(|d| pdfobj::get(pdf, d, b"Annots"))
        {
            for o in a {
                if let Ok(id) = o.as_reference() {
                    page_of.insert(id, i);
                }
            }
        }
    }
    let cert_sig = pdf
        .catalog()
        .ok()
        .and_then(|c| pdfobj::dict_of(pdf, c.get(b"Perms").ok()?))
        .and_then(|p| p.get(b"DocMDP").ok()?.as_reference().ok());
    pdfobj::fields(pdf)
        .into_iter()
        .filter(|f| f.ft.as_deref() == Some(b"Sig"))
        .map(|f| {
            let fd = pdf.get_dict(f.id);
            let v = fd
                .and_then(|d| d.get(b"V").ok())
                .and_then(|v| v.as_reference().ok());
            let kind = v.map(|id| {
                if Some(id) == cert_sig {
                    "certification"
                } else if pdf.get_dict(id).and_then(|d| get_name(pdf, d, b"Type"))
                    == Some(b"DocTimeStamp")
                {
                    "documentTimestamp"
                } else {
                    "approval"
                }
            });
            let w = f.widgets.first().copied();
            let wd = w.and_then(|w| pdf.get_dict(w));
            let rect = wd.and_then(|d| pdfobj::get_rect(pdf, d, b"Rect"));
            let flags = wd
                .and_then(|d| pdfobj::get_num(pdf, d, b"F"))
                .unwrap_or(0.0) as i64;
            let lock = fd
                .and_then(|d| pdfobj::get(pdf, d, b"Lock"))
                .and_then(|o| match o {
                    Object::Dictionary(ld) => lock_from_dict(pdf, ld),
                    _ => None,
                })
                .map(|l| serde_json::json!({"action": l.action.pdf_name(), "fields": l.fields}));
            FieldInfo {
                name: f.name.clone(),
                signed: v.is_some(),
                kind,
                page: w.and_then(|w| page_of.get(&w).copied()),
                rect,
                visible: rect.is_some_and(|r| r[2] - r[0] > 0.5 && r[3] - r[1] > 0.5)
                    && flags & 2 == 0,
                lock,
            }
        })
        .collect()
}
