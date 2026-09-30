//! Protecting a document: a password that is asked for when it is opened, and
//! what a reader may do without the owner's.
//!
//! The protection is Warraq's own (`warraq_pdf::crypt`): the standard security
//! handler at revision 6 — AES-256, the password taken as UTF-8, so a password
//! in Arabic is a password like any other. The hosts that used to hand this to
//! another engine wrote RC4 with a Latin-1 password, which is both weak and
//! unable to carry Arabic at all.
//!
//! Protection is the one change that cannot be an update appended to the
//! file's own bytes: it covers every object already in the file. So `set` and
//! `remove` answer the document written whole, and the bytes the person opened
//! are untouched until they save — as with every other tool, the host decides
//! that.
use serde::Deserialize;
use warraq_pdf::crypt::{Permissions, Protection};
use warraq_pdf::PdfDocument;

use super::{args, Reply};
use crate::CoreError;

/// The longest password we write. Revisions 5 and 6 take 127 *bytes*, and a
/// password cut in the middle would open the file for a string nobody typed;
/// so anything longer is refused rather than silently shortened. Arabic runs
/// at two bytes a letter, which leaves 63 letters — far more than anyone types.
const MAX_PASSWORD_BYTES: usize = 127;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Args {
    /// The password the file is opened with now, if it has one.
    #[serde(default)]
    password: Option<String>,
    /// The password to ask for from now on.
    #[serde(default)]
    open_password: Option<String>,
    /// The password that lifts the permissions. Left out, one is drawn at
    /// random and dropped, so nobody can lift them.
    #[serde(default)]
    owner_password: Option<String>,
    #[serde(default)]
    permissions: Option<PermissionArgs>,
    /// `false` leaves the XMP metadata readable without the password, which is
    /// what a library or a search index wants. Encrypted by default.
    #[serde(default)]
    encrypt_metadata: Option<bool>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PermissionArgs {
    #[serde(default)]
    print: bool,
    #[serde(default)]
    copy: bool,
    #[serde(default)]
    change: bool,
}

impl From<&PermissionArgs> for Permissions {
    fn from(p: &PermissionArgs) -> Self {
        Self {
            print: p.print,
            copy: p.copy,
            change: p.change,
        }
    }
}

/// An `E_EDIT` error with a code of its own in the message, as the other tools
/// raise theirs.
fn edit(message: impl Into<String>) -> CoreError {
    CoreError::Pdf(warraq_pdf::Error::Edit(message.into()))
}

fn first(blobs: &mut std::vec::IntoIter<Vec<u8>>, what: &str) -> Result<Vec<u8>, CoreError> {
    blobs
        .next()
        .ok_or_else(|| CoreError::Args(format!("{what} is missing")))
}

/// A password we are willing to write. Empty is not a password — a file whose
/// open password is empty opens for everyone, which is not what "protect" means
/// — and neither is one we would have to cut.
fn checked(password: &str) -> Result<&str, CoreError> {
    if password.is_empty() {
        return Err(edit("E_PASSWORD_EMPTY: the password is empty"));
    }
    if password.len() > MAX_PASSWORD_BYTES {
        return Err(edit(format!(
            "E_PASSWORD_LONG: the password is {} bytes; at most {MAX_PASSWORD_BYTES} fit",
            password.len()
        )));
    }
    Ok(password)
}

/// An owner password nobody knows, for a file given an open password and no
/// owner password of its own: an empty one would let any reader lift the
/// permissions, which is worse than none at all.
fn unguessable_owner() -> Result<String, CoreError> {
    warraq_pdf::crypt::unguessable_password()
        .map_err(|e| edit(format!("E_RANDOM: no owner password could be made: {e}")))
}

/// What a file's protection is, as JSON.
fn describe(bytes: &[u8]) -> serde_json::Value {
    match warraq_pdf::crypt::describe(bytes) {
        Some(d) => serde_json::json!({
            "protected": true,
            "method": d.method,
            "revision": d.revision,
            "keyBits": d.key_bits,
            "encryptMetadata": d.encrypt_metadata,
            "permissions": {
                "print": d.permissions.print,
                "copy": d.permissions.copy,
                "change": d.permissions.change,
            },
        }),
        None => serde_json::json!({ "protected": false }),
    }
}

pub fn call_static(name: &str, json: &str, blobs: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let a: Args = args(json)?;
    let mut blobs = blobs.into_iter();
    match name {
        // What protects the file, and whether it opens without a password.
        // Reads only the `/Encrypt` dictionary, which is in the clear, so it
        // answers for a file whose password we do not have.
        "inspect" => {
            let bytes = first(&mut blobs, "the PDF")?;
            let mut answer = describe(&bytes);
            if let Some(object) = answer.as_object_mut() {
                let protected = object["protected"].as_bool().unwrap_or(false);
                // Some files are encrypted and still open for everyone: they
                // carry only an owner password, to state the permissions.
                let opens_empty = protected && PdfDocument::open(bytes.clone(), Some("")).is_ok();
                object.insert("opensWithoutPassword".into(), opens_empty.into());
                // A file we cannot read the handler of, but that is encrypted.
                object.insert(
                    "readable".into(),
                    PdfDocument::open(bytes, a.password.as_deref())
                        .is_ok()
                        .into(),
                );
            }
            Reply::of(&answer)
        }

        // Set the open password, change it, and set the permissions — one
        // operation, because for the file they are the same thing: the old
        // protection (if any) comes off as the file is read and the new one
        // goes on as it is written.
        "set" => {
            let open = a
                .open_password
                .as_deref()
                .ok_or_else(|| CoreError::Args("openPassword is missing".into()))?;
            let open = checked(open)?;
            let owner = match a.owner_password.as_deref() {
                Some(owner) if !owner.is_empty() => checked(owner)?.to_string(),
                _ => unguessable_owner()?,
            };
            let permissions = a
                .permissions
                .as_ref()
                .map(Permissions::from)
                .unwrap_or(Permissions::ALL);

            let mut doc = PdfDocument::open(first(&mut blobs, "the PDF")?, a.password.as_deref())?;
            let bytes = doc.save_protected(&Protection {
                open_password: open.to_string(),
                owner_password: owner,
                permissions,
                encrypt_metadata: a.encrypt_metadata.unwrap_or(true),
            })?;

            // Never tell a person their document is protected without having
            // seen that it is: the password must be needed, and must work.
            if PdfDocument::open(bytes.clone(), None).is_ok() {
                return Err(edit(
                    "E_PROTECT: the document was written without protection",
                ));
            }
            if PdfDocument::open(bytes.clone(), Some(open)).is_err() {
                return Err(edit(
                    "E_PROTECT: the document was written with a password we cannot open",
                ));
            }
            Ok(Reply::of(&describe(&bytes))?.with_blob(bytes))
        }

        // The protection off: the document written whole, in the clear. The
        // password it had is needed to read it in the first place.
        "remove" => {
            let mut doc = PdfDocument::open(first(&mut blobs, "the PDF")?, a.password.as_deref())?;
            if !doc.was_encrypted() {
                return Err(edit("E_PROTECT: the document is not protected"));
            }
            let bytes = doc.save_to_vec()?;
            // And it really opens with no password now.
            if PdfDocument::open(bytes.clone(), None).is_err() {
                return Err(edit("E_PROTECT: the document is still protected"));
            }
            Ok(Reply::of(&describe(&bytes))?.with_blob(bytes))
        }

        _ => Err(CoreError::UnknownOp(format!("protect.{name}"))),
    }
}
