//! `sign.*`: digital signatures (warraq-sign).
//!
//! The engine never does network I/O. Levels above B-B are driven by the host:
//!
//! ```text
//! sign.prepare {level:"B-T"} + blobs[p12]  → blobs[signed B-B file, tsaRequest]   (json.next = "timestamp")
//!   host POSTs tsaRequest to its TSA (application/timestamp-query)
//! sign.finish + blobs[tsaResponse]          → blobs[file with signature timestamp]
//! sign.revocationRequests                   → json.requests + blobs[OCSP request DER…]
//!   host fetches OCSP responses / CRLs
//! sign.addDss {kinds, docTimestamp:true} + blobs[certs/OCSP/CRL…] → blobs[file, tsaRequest]
//! sign.finish + blobs[tsaResponse]          → blobs[B-LTA file]
//! ```
//! Every step appends an incremental update or rewrites only an unsigned `/Contents`
//! placeholder, and replaces the open document's bytes. The PKCS#12 password and file are
//! held only for the duration of `sign.prepare` and wiped afterwards.

use super::{blob0, params};
use crate::registry::Registry;
use crate::{CoreError, Document, Reply};
use serde::Deserialize;
use serde_json::{json, Value};
use warraq_sign::appearance::AppearanceSpec;
use warraq_sign::sign::{
    self as s, DocTimestampOptions, DssMaterial, FieldLock, Finished, Level, LockAction,
    SignOptions,
};
use warraq_sign::verify::{list_fields, verify, VerifyOptions};
use warraq_sign::x509::Cert;
use warraq_sign::{SignError, Signer, SoftwareSigner};
use zeroize::{Zeroize, Zeroizing};

pub fn register(r: &mut Registry) {
    r.doc("sign.list", list)
        .doc("sign.prepare", prepare)
        .doc("sign.finish", finish)
        .doc("sign.revocationRequests", revocation_requests)
        .doc("sign.addDss", add_dss)
        .doc("sign.verify", verify_all);
}

impl From<SignError> for CoreError {
    fn from(e: SignError) -> Self {
        CoreError::new(e.code(), e.to_string())
    }
}

/// Host clock in Unix seconds (the caller may pass `time` instead).
fn now() -> i64 {
    #[cfg(all(target_arch = "wasm32", feature = "wasm"))]
    {
        (js_sys::Date::now() / 1000.0) as i64
    }
    #[cfg(not(all(target_arch = "wasm32", feature = "wasm")))]
    {
        #[cfg(target_arch = "wasm32")]
        {
            0
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0)
        }
    }
}

fn obj(v: Value) -> serde_json::Map<String, Value> {
    match v {
        Value::Object(m) => m,
        _ => serde_json::Map::new(),
    }
}

fn list(doc: &mut Document, _p: &Value, _b: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let fields = list_fields(doc.pdf());
    Ok(Reply::json(json!({ "fields": fields })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Appearance {
    lines: Option<Vec<String>>,
    arabic_labels: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Lock {
    action: String,
    #[serde(default)]
    fields: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Prepare {
    /// PKCS#12 password.
    #[serde(default)]
    password: String,
    field: Option<String>,
    #[serde(default)]
    page: usize,
    /// `[x0, y0, x1, y1]`; omit for an invisible signature.
    rect: Option<[f64; 4]>,
    appearance: Option<Appearance>,
    reason: Option<String>,
    location: Option<String>,
    contact_info: Option<String>,
    name: Option<String>,
    /// `B-B` (default), `B-T`, `B-LT`, `B-LTA`.
    level: Option<String>,
    /// Certification signature: DocMDP P = 1, 2 or 3.
    certify: Option<u8>,
    field_lock: Option<Lock>,
    /// Unix seconds for `/M` (default: host clock).
    time: Option<i64>,
    placeholder_size: Option<usize>,
}

fn level_name(l: Level) -> &'static str {
    match l {
        Level::BB => "B-B",
        Level::BT => "B-T",
        Level::BLT => "B-LT",
        Level::BLTA => "B-LTA",
    }
}

fn prepare(doc: &mut Document, p: &Value, blobs: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let p: Prepare = params(p)?;
    let password = Zeroizing::new(p.password);
    let mut p12 = blob0(blobs, "the PKCS#12 (.p12/.pfx) file")?;
    let signer = SoftwareSigner::from_pkcs12(&p12, &password);
    p12.zeroize();
    drop(password);
    let signer = signer?;
    let level = Level::parse(p.level.as_deref().unwrap_or("B-B"))?;
    let lock = match p.field_lock {
        Some(l) => Some(FieldLock {
            action: LockAction::parse(&l.action)?,
            fields: l.fields,
        }),
        None => None,
    };
    let opts = SignOptions {
        field: p.field,
        page: p.page,
        rect: p.rect,
        appearance: p.appearance.map(|a| AppearanceSpec {
            lines: a.lines,
            arabic_labels: a.arabic_labels,
        }),
        reason: p.reason,
        location: p.location,
        contact_info: p.contact_info,
        name: p.name,
        level,
        certify: p.certify,
        lock,
        time: p.time.unwrap_or_else(now),
        placeholder: p.placeholder_size,
    };
    let out = s::sign(doc.pdf(), &signer, &opts)?;
    doc.pdf_mut().replace_bytes(out.bytes.clone(), None)?;
    let mut j = obj(json!({
        "field": out.field,
        "byteRange": out.byte_range,
        "level": level_name(level),
        "signer": signer.certificate().display_name(),
        "byteLength": out.bytes.len(),
        "signatureSize": out.cms_len,
        "reservedSize": out.placeholder,
        "next": if out.tsa_request.is_some() { "timestamp" } else { "done" },
    }));
    let mut blobs = vec![out.bytes];
    if let Some(req) = out.tsa_request {
        j.insert("tsaRequestBlob".into(), json!(1));
        j.insert(
            "tsaContentType".into(),
            json!("application/timestamp-query"),
        );
        blobs.push(req.der);
    }
    Ok(Reply {
        json: Value::Object(j),
        blobs,
    })
}

fn finish(doc: &mut Document, _p: &Value, blobs: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let resp = blob0(blobs, "the timestamp authority's response")?;
    let (bytes, what, check) = s::finish(doc.pdf(), &resp)?;
    doc.pdf_mut().replace_bytes(bytes.clone(), None)?;
    let (kind, field) = match what {
        Finished::SignatureTimestamp { field } => ("signatureTimestamp", field),
        Finished::DocumentTimestamp { field } => ("documentTimestamp", field),
    };
    Ok(Reply::with_blob(
        json!({
            "completed": kind,
            "field": field,
            "timestamp": check.gen_time.map(warraq_sign::pdfobj::iso_date),
            "authority": check.tsa.as_ref().map(Cert::display_name),
            "byteLength": bytes.len(),
        }),
        bytes,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RevReq {
    /// Field of the signature (default: the newest signature).
    field: Option<String>,
}

fn revocation_requests(
    doc: &mut Document,
    p: &Value,
    _b: Vec<Vec<u8>>,
) -> Result<Reply, CoreError> {
    let p: RevReq = params(p)?;
    let slots = s::signature_slots(doc.pdf());
    let slot = match &p.field {
        Some(f) => slots.iter().find(|x| &x.field == f),
        None => slots.iter().rev().find(|x| x.kind != b"DocTimeStamp"),
    }
    .ok_or_else(|| CoreError::new("invalid_argument", "no such signature"))?;
    let cms = warraq_sign::cms::ParsedCms::parse(&slot.contents)?;
    let mut chains: Vec<Vec<Cert>> = Vec::new();
    if let Some(leaf) = cms.signer_cert()? {
        let mut c = vec![leaf.clone()];
        c.extend(cms.certs.iter().filter(|x| *x != leaf).cloned());
        chains.push(c);
    }
    // The timestamp authority's chain as well.
    if let Some(tok) = cms.unsigned_attr(warraq_sign::oids::SIGNATURE_TIMESTAMP_TOKEN)? {
        let der = der::Encode::to_der(tok)
            .map_err(|e| CoreError::new("malformed_input", e.to_string()))?;
        let t = warraq_sign::cms::ParsedCms::parse(&der)?;
        if let Some(leaf) = t.signer_cert()? {
            let mut c = vec![leaf.clone()];
            c.extend(t.certs.iter().filter(|x| *x != leaf).cloned());
            chains.push(c);
        }
    }
    let mut out = Vec::new();
    let mut blobs = Vec::new();
    let mut certs = Vec::new();
    for chain in &chains {
        for c in chain {
            if !certs.contains(&c.der) {
                certs.push(c.der.clone());
            }
        }
        for r in warraq_sign::ocsp::requests_for_chain(chain) {
            let blob = r.ocsp_request.map(|d| {
                blobs.push(d);
                blobs.len() - 1
            });
            out.push(json!({
                "subject": r.subject,
                "ocspUrls": r.ocsp_urls,
                "crlUrls": r.crl_urls,
                "ocspRequestBlob": blob,
                "ocspContentType": "application/ocsp-request",
            }));
        }
    }
    let cert_start = blobs.len();
    let n_certs = certs.len();
    blobs.extend(certs);
    Ok(Reply {
        json: json!({
            "field": slot.field,
            "requests": out,
            "certificateBlobs": (cert_start..cert_start + n_certs).collect::<Vec<_>>(),
        }),
        blobs,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AddDss {
    /// One of `cert`, `ocsp`, `crl` per blob.
    #[serde(default)]
    kinds: Vec<String>,
    /// Also append a document timestamp placeholder (B-LTA) and return its TSA request.
    #[serde(default)]
    doc_timestamp: bool,
}

fn add_dss(doc: &mut Document, p: &Value, blobs: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let p: AddDss = params(p)?;
    if p.kinds.len() != blobs.len() {
        return Err(CoreError::params(
            "kinds must name every blob (cert, ocsp or crl)",
        ));
    }
    let mut m = DssMaterial::default();
    for (k, b) in p.kinds.iter().zip(blobs) {
        match k.as_str() {
            "cert" => {
                for c in Cert::from_pem_or_der(&b)? {
                    m.certs.push(c.der);
                }
            }
            "ocsp" => m.ocsps.push(b),
            "crl" => m.crls.push(b),
            other => return Err(CoreError::params(format!("unknown kind {other:?}"))),
        }
    }
    if !(m.certs.is_empty() && m.ocsps.is_empty() && m.crls.is_empty()) {
        let bytes = s::add_dss(doc.pdf(), &m)?;
        doc.pdf_mut().replace_bytes(bytes, None)?;
    }
    let mut j = obj(json!({
        "certs": m.certs.len(), "ocsps": m.ocsps.len(), "crls": m.crls.len(),
        "next": "done",
    }));
    let mut out = Vec::new();
    if p.doc_timestamp {
        let prep = s::prepare_doc_timestamp(doc.pdf(), &DocTimestampOptions::default())?;
        doc.pdf_mut().replace_bytes(prep.bytes.clone(), None)?;
        j.insert("next".into(), json!("timestamp"));
        j.insert("field".into(), json!(prep.field));
        j.insert("tsaRequestBlob".into(), json!(1));
        j.insert(
            "tsaContentType".into(),
            json!("application/timestamp-query"),
        );
        out.push(prep.bytes);
        if let Some(r) = prep.tsa_request {
            out.push(r.der);
        }
    } else {
        out.push(doc.pdf().bytes().to_vec());
    }
    j.insert(
        "byteLength".into(),
        json!(out.first().map(Vec::len).unwrap_or(0)),
    );
    Ok(Reply {
        json: Value::Object(j),
        blobs: out,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Verify {
    /// Unix seconds (default: host clock).
    now: Option<i64>,
}

fn verify_all(doc: &mut Document, p: &Value, blobs: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let p: Verify = params(p)?;
    let mut roots = Vec::new();
    for b in &blobs {
        roots.extend(Cert::from_pem_or_der(b)?);
    }
    let n = roots.len();
    let reports = verify(
        doc.pdf(),
        &VerifyOptions {
            trusted_roots: roots,
            now: p.now.unwrap_or_else(now),
        },
    )?;
    Ok(Reply::json(json!({
        "signatures": reports,
        "trustedRoots": n,
    })))
}
