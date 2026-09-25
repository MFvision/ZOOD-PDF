//! `protect.*`: open password / permissions. Both are whole rewrites (SPEC §1); every later
//! incremental save keeps the protection and key (warraq-pdf re-encrypts appended objects).

use super::doc::perms_json;
use super::params;
use crate::registry::Registry;
use crate::{CoreError, Document, Reply};
use serde::Deserialize;
use serde_json::{json, Value};
use warraq_pdf::{PasswordKind, Pdf, PermissionFlags, Protection, SecurityHandler};

pub fn register(r: &mut Registry) {
    r.doc("protect.set", set).doc("protect.remove", remove);
}

fn yes() -> bool {
    true
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Perms {
    #[serde(default = "yes")]
    print: bool,
    #[serde(default = "yes")]
    modify: bool,
    #[serde(default = "yes")]
    copy: bool,
    #[serde(default = "yes")]
    annotate: bool,
    #[serde(default = "yes")]
    fill_forms: bool,
    #[serde(default = "yes")]
    accessibility: bool,
    #[serde(default = "yes")]
    assemble: bool,
    #[serde(default = "yes")]
    print_high_quality: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Set {
    /// Password needed to open the file ("" = opens without a password).
    #[serde(default)]
    user_password: String,
    /// Password that grants full rights ("" = same as the user password).
    #[serde(default)]
    owner_password: String,
    permissions: Option<Perms>,
}

fn is_owner(pdf: &Pdf) -> bool {
    pdf.security()
        .is_none_or(|s| s.matched == PasswordKind::Owner)
}

fn set(doc: &mut Document, p: &Value, _b: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let p: Set = params(p)?;
    if !is_owner(doc.pdf()) {
        return Err(CoreError::new(
            "permission_denied",
            "changing the protection needs the owner password",
        ));
    }
    if p.user_password.is_empty() && p.owner_password.is_empty() {
        return Err(CoreError::params("set a user or an owner password"));
    }
    let flags = match p.permissions {
        Some(x) => PermissionFlags {
            print: x.print,
            modify: x.modify,
            copy: x.copy,
            annotate: x.annotate,
            fill_forms: x.fill_forms,
            accessibility: x.accessibility,
            assemble: x.assemble,
            print_high: x.print_high_quality,
        },
        None => PermissionFlags::all(),
    };
    let handler = SecurityHandler::new_aes256(&p.user_password, &p.owner_password, &flags)?;
    let bytes = doc.pdf().write_full(Protection::New(handler))?;
    let reopen = if p.owner_password.is_empty() {
        &p.user_password
    } else {
        &p.owner_password
    };
    doc.pdf_mut().replace_bytes(bytes.clone(), Some(reopen))?;
    Ok(Reply::with_blob(
        json!({
            "byteLength": bytes.len(),
            "encryption": "AES-256",
            "permissions": perms_json(&flags),
        }),
        bytes,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Remove {
    /// Needed when the document was opened with the user password.
    owner_password: Option<String>,
}

fn remove(doc: &mut Document, p: &Value, _b: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let p: Remove = params(p)?;
    if !doc.pdf().is_encrypted() {
        return Err(CoreError::new(
            "not_encrypted",
            "the document has no password",
        ));
    }
    if !is_owner(doc.pdf()) {
        let ok = match &p.owner_password {
            Some(pw) => Pdf::open(doc.pdf().bytes().to_vec(), Some(pw))
                .map(|o| is_owner(&o))
                .unwrap_or(false),
            None => false,
        };
        if !ok {
            return Err(CoreError::new(
                "permission_denied",
                "removing the protection needs the owner password",
            ));
        }
    }
    let bytes = doc.pdf().write_full(Protection::Remove)?;
    doc.pdf_mut().replace_bytes(bytes.clone(), Some(""))?;
    Ok(Reply::with_blob(
        json!({ "byteLength": bytes.len() }),
        bytes,
    ))
}
