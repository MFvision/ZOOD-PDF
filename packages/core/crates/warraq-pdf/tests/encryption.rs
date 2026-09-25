#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod common;
use common::*;
use std::collections::BTreeMap;
use warraq_pdf::builder::{sample_pdf, SampleOptions};
use warraq_pdf::crypt::CryptMethod;
use warraq_pdf::{
    metadata, PasswordKind, Pdf, PdfError, PermissionFlags, Protection, SecurityHandler, XrefKind,
};

const THIRD_PARTY: &[&str] = &[
    "qpdf_r2_rc4_40.pdf",
    "qpdf_r3_rc4_128.pdf",
    "qpdf_r4_rc4.pdf",
    "qpdf_r4_aes.pdf",
    "qpdf_r4_aes_objstm.pdf",
    "qpdf_r4_aes_nometa.pdf",
    "qpdf_r6.pdf",
    "qpdf_r6_objstm.pdf",
    "pypdf_rc4_40.pdf",
    "pypdf_rc4_128.pdf",
    "pypdf_aes128.pdf",
    "pypdf_aes256.pdf",
];

#[test]
fn third_party_fixtures_decrypt_with_user_and_owner_passwords() {
    for name in THIRD_PARTY {
        let bytes = fixture(name);
        let u = Pdf::open(bytes.clone(), Some("user")).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert!(u.is_encrypted(), "{name}");
        assert_eq!(u.security().unwrap().matched, PasswordKind::User, "{name}");
        assert!(
            page_text(&u, 0).contains("Hello ZOOD"),
            "{name}: {}",
            page_text(&u, 0)
        );
        assert!(page_text(&u, 1).contains("page 2"), "{name}");
        assert_eq!(title(&u).as_deref(), Some("Fixture Title"), "{name}");

        let o = Pdf::open(bytes.clone(), Some("owner")).unwrap();
        assert_eq!(o.security().unwrap().matched, PasswordKind::Owner, "{name}");
        assert!(
            o.security().unwrap().same_key(u.security().unwrap()),
            "{name}"
        );
        assert!(page_text(&o, 0).contains("Hello ZOOD"), "{name}");

        assert!(
            matches!(
                Pdf::open(bytes.clone(), None),
                Err(PdfError::PasswordRequired)
            ),
            "{name}"
        );
        assert!(
            matches!(Pdf::open(bytes, Some("nope")), Err(PdfError::WrongPassword)),
            "{name}"
        );
    }
}

#[test]
fn unencrypted_metadata_stays_readable() {
    let pdf = Pdf::open(fixture("qpdf_r4_aes_nometa.pdf"), Some("user")).unwrap();
    assert!(!pdf.security().unwrap().encrypt_metadata);
    let xmp = metadata::get_xmp(&pdf).unwrap().unwrap();
    assert!(xmp.contains("Fixture Title"), "{xmp}");
    // And for an encrypted-metadata file the XMP decrypts too.
    let pdf = Pdf::open(fixture("qpdf_r6.pdf"), Some("user")).unwrap();
    assert!(metadata::get_xmp(&pdf)
        .unwrap()
        .unwrap()
        .contains("Fixture Title"));
}

#[test]
fn empty_user_password_and_permissions() {
    let bytes = fixture("qpdf_r6_empty_user_restricted.pdf");
    let u = Pdf::open(bytes.clone(), None).unwrap();
    assert_eq!(u.security().unwrap().matched, PasswordKind::User);
    let p = u.permissions();
    assert!(!p.modify && !p.copy && !p.assemble && !p.annotate);
    assert!(p.print);
    let o = Pdf::open(bytes, Some("owner")).unwrap();
    assert_eq!(o.permissions(), PermissionFlags::all());
}

fn own_handlers() -> Vec<(&'static str, SecurityHandler, Vec<u8>)> {
    let id0 = b"warraq-test-id-0".to_vec();
    let perms = PermissionFlags {
        print: true,
        ..Default::default()
    };
    vec![
        (
            "R2",
            SecurityHandler::new_legacy(2, 40, CryptMethod::Rc4, "user", "owner", &perms, &id0)
                .unwrap(),
            id0.clone(),
        ),
        (
            "R3",
            SecurityHandler::new_legacy(3, 128, CryptMethod::Rc4, "user", "owner", &perms, &id0)
                .unwrap(),
            id0.clone(),
        ),
        (
            "R4-RC4",
            SecurityHandler::new_legacy(4, 128, CryptMethod::Rc4, "user", "owner", &perms, &id0)
                .unwrap(),
            id0.clone(),
        ),
        (
            "R4-AES",
            SecurityHandler::new_legacy(4, 128, CryptMethod::AesV2, "user", "owner", &perms, &id0)
                .unwrap(),
            id0.clone(),
        ),
        (
            "R6",
            SecurityHandler::new_aes256("user", "owner", &perms).unwrap(),
            id0,
        ),
    ]
}

fn own_encrypted(h: &SecurityHandler, id0: &[u8], xref_stream: bool) -> Vec<u8> {
    sample_pdf(
        2,
        &SampleOptions {
            security: Some(h.clone()),
            id0: Some(id0.to_vec()),
            title: Some("Own Title".into()),
            compress: true,
            xref_stream,
            ..Default::default()
        },
    )
    .unwrap()
}

#[test]
fn own_encryptor_all_revisions_round_trip() {
    for (label, h, id0) in own_handlers() {
        for xs in [false, true] {
            let bytes = own_encrypted(&h, &id0, xs);
            assert!(
                !contains(&bytes, b"Own Title"),
                "{label}: title leaked in clear"
            );
            assert!(!contains(&bytes, b"Page 1"), "{label}");
            let u = Pdf::open(bytes.clone(), Some("user")).unwrap();
            assert_eq!(u.security().unwrap().matched, PasswordKind::User);
            assert!(page_text(&u, 0).contains("(Page 1)"), "{label}");
            assert_eq!(title(&u).as_deref(), Some("Own Title"), "{label}");
            let o = Pdf::open(bytes, Some("owner")).unwrap();
            assert_eq!(
                o.security().unwrap().matched,
                PasswordKind::Owner,
                "{label}"
            );
        }
    }
}

#[test]
fn pypdf_decrypts_what_we_encrypt() {
    let script = r#"
import sys, pypdf
r = pypdf.PdfReader(sys.argv[1])
assert r.is_encrypted
res = r.decrypt("user")
print(int(res))
print(r.metadata.title)
print(r.pages[0].get_contents().get_data().decode("latin-1"))
"#;
    for (label, h, id0) in own_handlers() {
        let bytes = own_encrypted(&h, &id0, false);
        let Some(out) = python(script, &bytes) else {
            return;
        };
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(
            lines[0], "1",
            "{label}: pypdf should match the USER password"
        );
        assert_eq!(lines[1], "Own Title", "{label}");
        assert!(out.contains("(Page 1)"), "{label}: {out}");
    }
}

fn set_title(pdf: &mut Pdf, t: &str) {
    let mut m = BTreeMap::new();
    m.insert("Title".to_string(), Some(t.to_string()));
    metadata::set_info(pdf, &m).unwrap();
}

#[test]
fn incremental_updates_keep_protection_and_key() {
    for name in [
        "qpdf_r2_rc4_40.pdf",
        "qpdf_r4_aes_objstm.pdf",
        "qpdf_r6.pdf",
        "pypdf_aes256.pdf",
    ] {
        let orig = fixture(name);
        let mut pdf = Pdf::open(orig.clone(), Some("owner")).unwrap();
        let kind = pdf.xref_kind();
        let key_before = pdf.security().unwrap().clone();
        set_title(&mut pdf, "عنوان جديد Secret");
        let out = pdf.commit().unwrap();
        assert_eq!(
            &out[..orig.len()],
            &orig[..],
            "{name}: original must be a byte prefix"
        );
        let appended = &out[orig.len()..];
        assert!(
            !contains(appended, b"Secret"),
            "{name}: appended title must be encrypted"
        );
        assert!(
            contains(appended, b"/Encrypt"),
            "{name}: trailer keeps /Encrypt"
        );
        assert_eq!(pdf.xref_kind(), kind, "{name}: same xref form");
        // Reopen with the USER password: same key, new title, old content intact.
        let re = Pdf::open(out, Some("user")).unwrap();
        assert!(re.security().unwrap().same_key(&key_before), "{name}");
        assert_eq!(title(&re).as_deref(), Some("عنوان جديد Secret"), "{name}");
        assert!(page_text(&re, 0).contains("Hello ZOOD"), "{name}");
        if kind == XrefKind::Stream {
            assert!(contains(&re.bytes()[orig.len()..], b"/XRef"), "{name}");
        }
    }
}

#[test]
fn pypdf_reads_our_incremental_update_on_encrypted_file() {
    let orig = fixture("qpdf_r6.pdf");
    let mut pdf = Pdf::open(orig, Some("owner")).unwrap();
    set_title(&mut pdf, "Updated");
    let out = pdf.commit().unwrap();
    let script = r#"
import sys, pypdf
r = pypdf.PdfReader(sys.argv[1])
r.decrypt("user")
print(r.metadata.title)
"#;
    if let Some(o) = python(script, &out) {
        assert_eq!(o.trim(), "Updated");
    }
}

#[test]
fn protect_set_change_and_remove_are_whole_rewrites() {
    let plain = sample_pdf(1, &SampleOptions::default()).unwrap();
    let pdf = Pdf::open(plain, None).unwrap();
    let h = SecurityHandler::new_aes256("كلمة السر", "مالك", &PermissionFlags::default()).unwrap();
    let enc = pdf.write_full(Protection::New(h)).unwrap();
    assert!(matches!(
        Pdf::open(enc.clone(), None),
        Err(PdfError::PasswordRequired)
    ));
    let e = Pdf::open(enc.clone(), Some("كلمة السر")).unwrap();
    assert_eq!(e.security().unwrap().r, 6);
    assert!(!e.permissions().modify);
    assert!(page_text(&e, 0).contains("Page 1"));
    // Remove protection (owner).
    let o = Pdf::open(enc, Some("مالك")).unwrap();
    let clear = o.write_full(Protection::Remove).unwrap();
    let c = Pdf::open(clear, None).unwrap();
    assert!(!c.is_encrypted());
    assert!(page_text(&c, 0).contains("Page 1"));
    // Keep: same key after a full rewrite of an encrypted third-party file.
    let q = Pdf::open(fixture("qpdf_r4_aes_objstm.pdf"), Some("owner")).unwrap();
    let kept = q.write_full(Protection::Keep).unwrap();
    let k = Pdf::open(kept, Some("user")).unwrap();
    assert!(k.security().unwrap().same_key(q.security().unwrap()));
    assert!(page_text(&k, 1).contains("page 2"));
}

#[test]
fn user_password_cannot_modify_restricted_document() {
    let mut pdf = Pdf::open(fixture("qpdf_r6_empty_user_restricted.pdf"), None).unwrap();
    let mut m = BTreeMap::new();
    m.insert("Title".to_string(), Some("x".to_string()));
    let err = metadata::set_info(&mut pdf, &m).unwrap_err();
    assert_eq!(err.code(), "permission_denied");
    assert_eq!(
        warraq_pdf::pages::rotate(&mut pdf, &[0], 90)
            .unwrap_err()
            .code(),
        "permission_denied"
    );
}
