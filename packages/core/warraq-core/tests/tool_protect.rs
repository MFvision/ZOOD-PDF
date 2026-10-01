//! The protect tool through `call_static`, the way every host reaches it:
//! a password goes on, changes and comes off, the permissions say what was
//! chosen, and the Arabic text of the document still reads afterwards.
//!
//! The protection is AES-256 at revision 6 of the standard security handler,
//! written by the core itself (`warraq_pdf::crypt`) — the same bytes on every
//! host, so a document protected on iPhone opens on the desktop and the other
//! way round.
use serde_json::{json, Value};
use warraq_core::{call_static, CoreError, Document, Reply};

fn corpus(name: &str) -> Vec<u8> {
    std::fs::read(format!(
        "{}/../../../tests/corpus/arabic/{name}",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap()
}

/// Three pages of justified Arabic, unprotected.
const PLAIN: &str = "generated/chrome-notonaskh-justified-3pages.pdf";
/// A password in Arabic, which is the whole point of revision 6.
const ARABIC: &str = "كلمة السر ١٢٣";

fn value(reply: &Reply) -> Value {
    serde_json::from_str(&reply.json).unwrap()
}

fn set(bytes: Vec<u8>, args: Value) -> Result<Reply, CoreError> {
    call_static("protect.set", &args.to_string(), vec![bytes])
}

fn inspect(bytes: Vec<u8>) -> Value {
    value(&call_static("protect.inspect", "{}", vec![bytes]).unwrap())
}

/// The text of every page, so that a document can be shown to have survived.
fn texts(bytes: Vec<u8>, password: Option<&str>) -> Vec<String> {
    let doc = Document::open(bytes, password).unwrap();
    (0..doc.page_count())
        .map(|i| doc.extract_text(i).unwrap())
        .collect()
}

#[test]
fn a_password_goes_on_and_the_document_still_reads() {
    let original = corpus(PLAIN);
    let before = texts(original.clone(), None);

    let reply = set(
        original,
        json!({ "openPassword": "warraq", "permissions": { "print": true, "copy": true, "change": true } }),
    )
    .unwrap();
    let answer = value(&reply);
    assert_eq!(answer["protected"], true);
    assert_eq!(answer["method"], "aes-256");
    assert_eq!(answer["keyBits"], 256);
    assert_eq!(answer["revision"], 6);
    let sealed = reply.blobs.into_iter().next().unwrap();

    // The password is needed, and it is enough.
    assert!(matches!(
        Document::open(sealed.clone(), None),
        Err(CoreError::Pdf(warraq_pdf::Error::Password))
    ));
    assert_eq!(texts(sealed.clone(), Some("warraq")), before);

    // And `inspect` says so without being given the password at all.
    let described = inspect(sealed);
    assert_eq!(described["protected"], true);
    assert_eq!(described["method"], "aes-256");
    assert_eq!(described["opensWithoutPassword"], false);
}

/// The reason this is the core's own AES-256 and not the platform's RC4: an
/// Arabic password works, exactly as typed.
#[test]
fn an_arabic_password_works_and_only_that_password() {
    let before = texts(corpus(PLAIN), None);
    let reply = set(corpus(PLAIN), json!({ "openPassword": ARABIC })).unwrap();
    let sealed = reply.blobs.into_iter().next().unwrap();

    assert_eq!(texts(sealed.clone(), Some(ARABIC)), before);
    for wrong in ["كلمة السر ١٢٤", "كلمة السر", "warraq", ""] {
        assert!(
            matches!(
                Document::open(sealed.clone(), Some(wrong)),
                Err(CoreError::Pdf(warraq_pdf::Error::Password))
            ),
            "{wrong:?} must not open it"
        );
    }
}

/// A protected document protected again: the old password stops working.
#[test]
fn the_password_can_be_changed() {
    let first = set(corpus(PLAIN), json!({ "openPassword": "old" }))
        .unwrap()
        .blobs
        .remove(0);
    let second = set(first, json!({ "password": "old", "openPassword": ARABIC }))
        .unwrap()
        .blobs
        .remove(0);

    assert!(Document::open(second.clone(), Some(ARABIC)).is_ok());
    assert!(matches!(
        Document::open(second, Some("old")),
        Err(CoreError::Pdf(warraq_pdf::Error::Password))
    ));
}

/// The password comes off, and then the file opens for everyone.
#[test]
fn the_password_comes_off() {
    let before = texts(corpus(PLAIN), None);
    let sealed = set(corpus(PLAIN), json!({ "openPassword": ARABIC }))
        .unwrap()
        .blobs
        .remove(0);

    let reply = call_static(
        "protect.remove",
        &json!({ "password": ARABIC }).to_string(),
        vec![sealed],
    )
    .unwrap();
    assert_eq!(value(&reply)["protected"], false);
    let plain = reply.blobs.into_iter().next().unwrap();

    assert_eq!(texts(plain.clone(), None), before);
    assert_eq!(inspect(plain)["protected"], false);
}

/// Taking the protection off a document that has none is an error, not a
/// silent rewrite: the person asked for something that is not the case.
#[test]
fn removing_protection_that_is_not_there_is_refused() {
    let error = call_static("protect.remove", "{}", vec![corpus(PLAIN)]).unwrap_err();
    assert!(error.to_string().contains("E_EDIT: E_PROTECT"), "{error}");
}

/// The wrong password gets `E_PASSWORD`, wherever it is given.
#[test]
fn the_wrong_password_is_refused() {
    let sealed = set(corpus(PLAIN), json!({ "openPassword": ARABIC }))
        .unwrap()
        .blobs
        .remove(0);
    for op in ["protect.set", "protect.remove"] {
        let error = call_static(
            op,
            &json!({ "password": "wrong", "openPassword": "new" }).to_string(),
            vec![sealed.clone()],
        )
        .unwrap_err();
        assert!(error.to_string().starts_with("E_PASSWORD"), "{op}: {error}");
    }
}

/// The three permissions are written as chosen and read back as chosen.
#[test]
fn the_permissions_are_what_was_chosen() {
    for (print, copy, change) in [
        (true, true, true),
        (true, false, false),
        (false, false, false),
        (false, true, false),
    ] {
        let sealed = set(
            corpus(PLAIN),
            json!({
                "openPassword": "warraq",
                "permissions": { "print": print, "copy": copy, "change": change },
            }),
        )
        .unwrap()
        .blobs
        .remove(0);
        let permissions = inspect(sealed)["permissions"].clone();
        assert_eq!(permissions["print"], print, "print");
        assert_eq!(permissions["copy"], copy, "copy");
        assert_eq!(permissions["change"], change, "change");
    }
}

/// An empty password is not a password, and one too long to store is refused
/// rather than cut — a cut password would open the file for a string nobody
/// typed.
#[test]
fn a_password_we_cannot_store_is_refused() {
    let error = set(corpus(PLAIN), json!({ "openPassword": "" })).unwrap_err();
    assert!(error.to_string().contains("E_PASSWORD_EMPTY"), "{error}");

    // 128 bytes: one past what revisions 5 and 6 hold.
    let long = "a".repeat(128);
    let error = set(corpus(PLAIN), json!({ "openPassword": long })).unwrap_err();
    assert!(error.to_string().contains("E_PASSWORD_LONG"), "{error}");

    // The same in Arabic, where each letter is two bytes.
    let long = "ك".repeat(64);
    let error = set(corpus(PLAIN), json!({ "openPassword": long })).unwrap_err();
    assert!(error.to_string().contains("E_PASSWORD_LONG"), "{error}");
    // 63 letters fit, so the limit is on bytes and is not off by one.
    assert!(set(corpus(PLAIN), json!({ "openPassword": "ك".repeat(63) })).is_ok());
}

/// `openPassword` is required: there is no protecting a document with nothing.
#[test]
fn set_without_a_password_is_refused() {
    let error = set(corpus(PLAIN), json!({})).unwrap_err();
    assert!(error.to_string().starts_with("E_ARGS"), "{error}");
}

/// A file that is protected but opens for everyone — only an owner password,
/// to state the permissions — is reported as exactly that.
#[test]
fn a_file_that_opens_without_a_password_is_reported_as_such() {
    let described = inspect(corpus("generated/variant-encrypted-aes256-owner-only.pdf"));
    assert_eq!(described["protected"], true);
    assert_eq!(described["opensWithoutPassword"], true);
}

/// The older protections other programs write are named for what they are, so
/// the interface can tell a person their file is weakly protected.
#[test]
fn older_protections_are_named() {
    for (file, method, bits) in [
        ("variant-encrypted-rc4-40.pdf", "rc4-40", 40),
        ("variant-encrypted-rc4-128.pdf", "rc4-128", 128),
        ("variant-encrypted-aes128.pdf", "aes-128", 128),
        ("variant-encrypted-aes256.pdf", "aes-256", 256),
    ] {
        let described = inspect(corpus(&format!("generated/{file}")));
        assert_eq!(described["method"], method, "{file}");
        assert_eq!(described["keyBits"], bits, "{file}");
    }
}

/// Hostile input: nothing here panics, whatever the bytes are.
#[test]
fn rubbish_is_an_error_and_never_a_panic() {
    for bytes in [
        Vec::new(),
        b"%PDF-1.7\n".to_vec(),
        b"not a pdf at all".to_vec(),
        vec![0u8; 4096],
    ] {
        let _ = call_static("protect.inspect", "{}", vec![bytes.clone()]);
        let _ = set(bytes.clone(), json!({ "openPassword": "warraq" }));
        let _ = call_static("protect.remove", "{}", vec![bytes]);
    }
    // And an operation that does not exist is named, not guessed at.
    assert!(matches!(
        call_static("protect.nonsense", "{}", vec![corpus(PLAIN)]),
        Err(CoreError::UnknownOp(_))
    ));
}
