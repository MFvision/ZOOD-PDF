//! Digital signatures (`warraq_sign`): sign with a certificate file, add a
//! timestamp or validation data an authority sent back, and verify every
//! signature in a file. The host sends and fetches; nothing here touches
//! the network, and nothing leaves the device unless the person asks the
//! host to fetch a timestamp or revocation data.
//!
//! Every operation takes the file as it stands and answers a new file: a
//! signature is always the last thing written, as an incremental update.
use serde::Deserialize;
use warraq_pdf::signature::SigImage;
use warraq_pdf::PdfDocument;
use warraq_sign::chain::TrustStore;
use warraq_sign::keys::{Padding, Signer};
use warraq_sign::pades::{self, SignOptions, Signed};

use super::{args, Reply};
use crate::CoreError;

/// A signing error keeps its own code (`E_P12_PASSWORD`, `E_TSA`, …).
fn sign_err(e: warraq_sign::SignError) -> CoreError {
    match e {
        warraq_sign::SignError::Pdf(p) => CoreError::Pdf(p),
        other => CoreError::Sign(other.to_string()),
    }
}

/// Mozilla's roots and the certificates the person trusts (DER blobs).
fn trust(certs: &[Vec<u8>]) -> TrustStore {
    let mut store = TrustStore::mozilla();
    for cert in certs {
        let _ = store.add_user(cert);
    }
    store
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Verify {
    #[serde(default)]
    password: Option<String>,
    /// Unix seconds: the browser build has no clock of its own.
    now: i64,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Identity {
    p12_password: String,
    #[serde(default)]
    now: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImageSize {
    width: u32,
    height: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Sign {
    #[serde(default)]
    password: Option<String>,
    #[serde(default)]
    p12_password: String,
    #[serde(default)]
    field: Option<String>,
    #[serde(default)]
    page: usize,
    /// On the page as it is shown, in points from its top-left corner.
    #[serde(default)]
    rect: Option<[f32; 4]>,
    #[serde(default)]
    lines: Vec<String>,
    #[serde(default)]
    image: Option<ImageSize>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    location: Option<String>,
    #[serde(default)]
    contact: Option<String>,
    time: i64,
    #[serde(default)]
    offset_minutes: i32,
    #[serde(default)]
    certify: Option<u8>,
    #[serde(default)]
    lock_fields: bool,
    #[serde(default)]
    pss: bool,
    #[serde(default)]
    timestamp: bool,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Validate {
    #[serde(default)]
    password: Option<String>,
    now: i64,
    /// What each answer blob is: `ocsp`, `crl` or `certificate`.
    #[serde(default)]
    kinds: Vec<String>,
}

#[derive(Deserialize, Default)]
struct Password {
    #[serde(default)]
    password: Option<String>,
}

pub fn call_static(name: &str, json: &str, blobs: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let mut blobs = blobs.into_iter();
    let mut next = |what: &str| {
        blobs
            .next()
            .ok_or_else(|| CoreError::Args(format!("signatures.{name} takes {what}")))
    };
    match name {
        // blobs: the PDF, then certificates the person trusts.
        "verify" => {
            let a: Verify = args(json)?;
            let pdf = next("the PDF")?;
            let trusted: Vec<Vec<u8>> = std::iter::from_fn(|| next("").ok()).collect();
            let report = pades::verify(&pdf, a.password.as_deref(), &trust(&trusted), a.now)
                .map_err(sign_err)?;
            Reply::of(&report)
        }
        // blobs: a certificate file. What is in it, before signing with it.
        "identity" => {
            let a: Identity = args(json)?;
            let p12 = next("the certificate file")?;
            let id = warraq_sign::pkcs12::open(&p12, &a.p12_password).map_err(sign_err)?;
            let cert =
                warraq_sign::chain::Cert::parse(id.signer.certificate()).map_err(sign_err)?;
            Reply::of(&serde_json::json!({
                "name": cert.common_name(),
                "issuer": cert.issuer_name(),
                "subject": cert.subject_dn(),
                "notBefore": warraq_sign::time::iso(cert.not_before()),
                "notAfter": warraq_sign::time::iso(cert.not_after()),
                "validNow": a.now == 0 || cert.valid_at(a.now),
                "key": id.signer.key_kind().name(),
                "rsa": matches!(id.signer.key_kind(), warraq_sign::keys::KeyKind::Rsa { .. }),
                "chain": id.signer.chain().len(),
                "canSign": cert.may_sign_documents(),
            }))
        }
        // blobs: the PDF, the certificate file, then the face for a visible
        // signature, then the picture's RGBA pixels (when `image` is given).
        "sign" => {
            let a: Sign = args(json)?;
            let pdf = next("the PDF")?;
            let p12 = next("the certificate file")?;
            let font = next("a font").ok();
            let image = match a.image {
                Some(size) => Some(SigImage {
                    width: size.width,
                    height: size.height,
                    rgba: next("the picture")?,
                }),
                None => None,
            };
            let id = warraq_sign::pkcs12::open(&p12, &a.p12_password).map_err(sign_err)?;
            let mut doc = PdfDocument::open(pdf, a.password.as_deref())?;
            let options = SignOptions {
                field: a.field,
                page: a.page,
                rect: a.rect,
                lines: a.lines,
                font: font.filter(|f| !f.is_empty()),
                image,
                name: a.name,
                reason: a.reason,
                location: a.location,
                contact: a.contact,
                time: a.time,
                offset_minutes: a.offset_minutes,
                certify: a.certify,
                lock_fields: a.lock_fields,
                padding: if a.pss {
                    Padding::Pss
                } else {
                    Padding::Pkcs1v15
                },
                timestamp: a.timestamp,
            };
            signed_reply(pades::sign(&mut doc, &id.signer, &options).map_err(sign_err)?)
        }
        // blobs: the prepared file, the signature, the request and the
        // authority's answer.
        "finish" => {
            let prepared = next("the prepared file")?;
            let cms = next("the signature")?;
            let request = next("the request")?;
            let response = next("the answer")?;
            let bytes = pades::finish(prepared, &cms, &request, &response).map_err(sign_err)?;
            Ok(Reply::of(&serde_json::json!({ "done": true }))?.with_blob(bytes))
        }
        // blobs: the PDF. A document timestamp: the file with its room, and
        // the request for the authority.
        "prepare_document_timestamp" => {
            let a: Password = args(json)?;
            let mut doc = PdfDocument::open(next("the PDF")?, a.password.as_deref())?;
            let (prepared, request) = pades::prepare_doc_timestamp(&mut doc).map_err(sign_err)?;
            Ok(Reply::of(&serde_json::json!({ "done": false }))?
                .with_blob(prepared)
                .with_blob(request))
        }
        // blobs: the prepared file, the request, the answer.
        "finish_document_timestamp" => {
            let prepared = next("the prepared file")?;
            let request = next("the request")?;
            let response = next("the answer")?;
            let bytes =
                pades::finish_doc_timestamp(prepared, &request, &response).map_err(sign_err)?;
            Ok(Reply::of(&serde_json::json!({ "done": true }))?.with_blob(bytes))
        }
        // blobs: the PDF, then trusted certificates. What to fetch for
        // long-term validation; an OCSP request's body is the blob of the
        // same index (empty for a GET).
        "fetches" => {
            let a: Verify = args(json)?;
            let pdf = next("the PDF")?;
            let trusted: Vec<Vec<u8>> = std::iter::from_fn(|| next("").ok()).collect();
            let fetches = pades::fetches(&pdf, a.password.as_deref(), &trust(&trusted), a.now)
                .map_err(sign_err)?;
            let mut reply = Reply::of(&serde_json::json!({ "fetches": fetches }))?;
            for f in fetches {
                reply = reply.with_blob(f.body.unwrap_or_default());
            }
            Ok(reply)
        }
        // blobs: the PDF, one blob per `kinds` entry (the answers), then
        // trusted certificates.
        "add_validation" => {
            let a: Validate = args(json)?;
            let pdf = next("the PDF")?;
            let mut answers = Vec::new();
            for kind in &a.kinds {
                answers.push((kind.clone(), next("an answer")?));
            }
            let trusted: Vec<Vec<u8>> = std::iter::from_fn(|| next("").ok()).collect();
            let mut doc = PdfDocument::open(pdf, a.password.as_deref())?;
            let (bytes, added) = pades::add_validation(&mut doc, &answers, &trust(&trusted), a.now)
                .map_err(sign_err)?;
            Ok(Reply::of(&added)?.with_blob(bytes))
        }
        // blobs: a certificate file (DER, PEM or PKCS#7). Its certificates,
        // described, and each one's DER back as a blob.
        "certificates" => {
            let file = next("a certificate file")?;
            let certs = warraq_sign::certificates_in(&file);
            let described: Vec<_> = certs
                .iter()
                .filter_map(|der| warraq_sign::chain::Cert::parse(der).ok())
                .map(|c| c.summary())
                .collect();
            let mut reply = Reply::of(&serde_json::json!({ "certificates": described }))?;
            for der in certs {
                reply = reply.with_blob(der);
            }
            Ok(reply)
        }
        _ => Err(CoreError::UnknownOp(format!("signatures.{name}"))),
    }
}

/// A signing's answer: the signed file, or what finishing it needs.
pub fn signed_reply(signed: Signed) -> Result<Reply, CoreError> {
    Ok(match signed {
        Signed::Done(bytes) => Reply::of(&serde_json::json!({ "done": true }))?.with_blob(bytes),
        Signed::NeedsTimestamp {
            prepared,
            cms,
            request,
        } => Reply::of(&serde_json::json!({ "done": false }))?
            .with_blob(prepared)
            .with_blob(cms)
            .with_blob(request),
    })
}

/// Signs with any [`Signer`] — the desktop host's smart-card signer comes
/// through here with the same options as a certificate file.
pub fn sign_with(json: &str, blobs: Vec<Vec<u8>>, signer: &dyn Signer) -> Result<Reply, CoreError> {
    let a: Sign = args(json)?;
    let mut blobs = blobs.into_iter();
    let pdf = blobs
        .next()
        .ok_or_else(|| CoreError::Args("signing takes the PDF".into()))?;
    let font = blobs.next();
    let image = match (a.image, blobs.next()) {
        (Some(size), Some(rgba)) => Some(SigImage {
            width: size.width,
            height: size.height,
            rgba,
        }),
        _ => None,
    };
    let mut doc = PdfDocument::open(pdf, a.password.as_deref())?;
    let options = SignOptions {
        field: a.field,
        page: a.page,
        rect: a.rect,
        lines: a.lines,
        font: font.filter(|f| !f.is_empty()),
        image,
        name: a.name,
        reason: a.reason,
        location: a.location,
        contact: a.contact,
        time: a.time,
        offset_minutes: a.offset_minutes,
        certify: a.certify,
        lock_fields: a.lock_fields,
        padding: if a.pss {
            Padding::Pss
        } else {
            Padding::Pkcs1v15
        },
        timestamp: a.timestamp,
    };
    signed_reply(pades::sign(&mut doc, signer, &options).map_err(sign_err)?)
}
