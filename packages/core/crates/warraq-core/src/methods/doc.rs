//! `doc.*`: document info, saving, rebase, revisions, metadata.

use super::{blob0, params};
use crate::registry::Registry;
use crate::{CoreError, Document, Reply};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use warraq_pdf::crypt::{CryptMethod, PermissionFlags};
use warraq_pdf::lopdf::Object;
use warraq_pdf::rebase::{rebase_pdf, RebaseMode};
use warraq_pdf::{metadata, pages, revisions, Pdf, Protection, XrefKind};

pub fn register(r: &mut Registry) {
    r.doc("doc.info", info)
        .doc("doc.save", save)
        .doc("doc.saveFull", save_full)
        .doc("doc.rebase", rebase)
        .doc("doc.revisions", revs)
        .doc("doc.metadata.get", metadata_get)
        .doc("doc.metadata.set", metadata_set);
}

pub(crate) fn perms_json(p: &PermissionFlags) -> Value {
    json!({
        "print": p.print, "modify": p.modify, "copy": p.copy, "annotate": p.annotate,
        "fillForms": p.fill_forms, "accessibility": p.accessibility,
        "assemble": p.assemble, "printHighQuality": p.print_high,
    })
}

fn method_name(m: CryptMethod) -> &'static str {
    match m {
        CryptMethod::Identity => "none",
        CryptMethod::Rc4 => "RC4",
        CryptMethod::AesV2 => "AES-128",
        CryptMethod::AesV3 => "AES-256",
    }
}

fn has_signatures(pdf: &Pdf) -> bool {
    pdf.objects().values().any(|o| {
        let d = match o {
            Object::Dictionary(d) => d,
            _ => return false,
        };
        let is_sig_field =
            matches!(d.get(b"FT").and_then(Object::as_name), Ok(b"Sig")) && d.has(b"V");
        let is_sig_value = matches!(
            d.get(b"Type").and_then(Object::as_name),
            Ok(b"Sig") | Ok(b"DocTimeStamp")
        ) && d.has(b"ByteRange");
        is_sig_field || is_sig_value
    })
}

/// Commit pending edits and reply with the new file as `blobs[0]`.
pub(crate) fn commit_reply(
    doc: &mut Document,
    mut extra: Map<String, Value>,
) -> Result<Reply, CoreError> {
    let bytes = doc.pdf_mut().commit()?;
    let pdf = doc.pdf();
    extra.insert("byteLength".into(), json!(bytes.len()));
    extra.insert("pageCount".into(), json!(pages::count(pdf)?));
    extra.insert(
        "revisions".into(),
        json!(revisions::revisions(pdf.bytes(), pdf.limits()).len()),
    );
    Ok(Reply::with_blob(Value::Object(extra), bytes))
}

fn info(doc: &mut Document, _p: &Value, _b: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let pdf = doc.pdf();
    let list = pages::flatten(pdf)?;
    let page_json: Vec<Value> = list
        .iter()
        .map(|p| {
            let (w, h) = p.size();
            json!({ "width": w, "height": h, "rotation": p.rotate })
        })
        .collect();
    let meta = metadata::get_info(pdf);
    let encryption = pdf.security().map(|s| {
        json!({
            "revision": s.r, "version": s.v,
            "method": method_name(s.stm),
            "encryptMetadata": s.encrypt_metadata,
        })
    });
    Ok(Reply::json(json!({
        "pageCount": list.len(),
        "pages": page_json,
        "encrypted": pdf.is_encrypted(),
        "encryption": encryption,
        "passwordMatched": pdf.security().map(|s| s.matched.as_str()),
        "permissions": perms_json(&pdf.permissions()),
        "version": pdf.version(),
        "revisions": revisions::revisions(pdf.bytes(), pdf.limits()).len(),
        "hasSignatures": has_signatures(pdf),
        "title": meta.get("Title"),
        "author": meta.get("Author"),
        "xrefStream": pdf.xref_kind() == XrefKind::Stream,
        "repaired": pdf.was_repaired(),
        "byteLength": pdf.bytes().len(),
        "unsavedChanges": pdf.has_changes(),
    })))
}

fn save(doc: &mut Document, _p: &Value, _b: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    commit_reply(doc, Map::new())
}

fn save_full(doc: &mut Document, _p: &Value, _b: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let bytes = doc.pdf().write_full(Protection::Keep)?;
    doc.pdf_mut().replace_bytes(bytes.clone(), None)?;
    Ok(Reply::with_blob(
        json!({ "byteLength": bytes.len() }),
        bytes,
    ))
}

fn rebase(doc: &mut Document, _p: &Value, blobs: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let edited = blob0(blobs, "the PDF saved by the viewer")?;
    let rep = rebase_pdf(doc.pdf(), &edited)?;
    let mode = match rep.mode {
        RebaseMode::Incremental => "incremental",
        RebaseMode::Unchanged => "unchanged",
        RebaseMode::ProtectionChanged => "protectionChanged",
    };
    let ids = |v: &[(u32, u16)]| v.iter().map(|(n, g)| json!([n, g])).collect::<Vec<_>>();
    let out = json!({
        "mode": mode,
        "changed": ids(&rep.changed),
        "added": ids(&rep.added),
        "deleted": ids(&rep.deleted),
        "renumbered": rep.renumbered,
        "byteLength": rep.bytes.len(),
    });
    if rep.mode == RebaseMode::ProtectionChanged {
        // New protection: the caller reopens the returned bytes with the new password.
        return Ok(Reply::with_blob(out, rep.bytes));
    }
    doc.pdf_mut().replace_bytes(rep.bytes.clone(), None)?;
    Ok(Reply::with_blob(out, rep.bytes))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RevParams {
    /// Return the bytes of this revision as blobs[0].
    extract: Option<usize>,
}

fn revs(doc: &mut Document, p: &Value, _b: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let p: RevParams = params(p)?;
    let pdf = doc.pdf();
    let list: Vec<Value> = revisions::revisions(pdf.bytes(), pdf.limits())
        .iter()
        .map(|r| json!({ "index": r.index, "end": r.end, "startxref": r.startxref }))
        .collect();
    let json = json!({ "revisions": list });
    match p.extract {
        Some(k) => {
            let bytes = revisions::revision_bytes(pdf.bytes(), k, pdf.limits())?.to_vec();
            Ok(Reply::with_blob(json, bytes))
        }
        None => Ok(Reply::json(json)),
    }
}

fn metadata_get(doc: &mut Document, _p: &Value, _b: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let pdf = doc.pdf();
    Ok(Reply::json(json!({
        "info": metadata::get_info(pdf),
        "xmp": metadata::get_xmp(pdf)?,
    })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MetaSet {
    /// Info keys (`Title`, `Author`, …) → value, or null to remove.
    #[serde(default)]
    info: BTreeMap<String, Option<String>>,
    /// Replace the XMP packet verbatim.
    xmp: Option<String>,
    /// Regenerate a minimal XMP packet from the resulting Info (default false).
    #[serde(default)]
    sync_xmp: bool,
}

fn metadata_set(doc: &mut Document, p: &Value, _b: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let p: MetaSet = params(p)?;
    if p.info.is_empty() && p.xmp.is_none() && !p.sync_xmp {
        return Err(CoreError::params("nothing to set"));
    }
    if !p.info.is_empty() {
        metadata::set_info(doc.pdf_mut(), &p.info)?;
    }
    if let Some(x) = &p.xmp {
        metadata::set_xmp(doc.pdf_mut(), x)?;
    } else if p.sync_xmp {
        let xmp = metadata::xmp_from_info(&metadata::get_info(doc.pdf()));
        metadata::set_xmp(doc.pdf_mut(), &xmp)?;
    }
    let mut extra = Map::new();
    extra.insert("info".into(), json!(metadata::get_info(doc.pdf())));
    commit_reply(doc, extra)
}
