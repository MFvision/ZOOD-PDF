//! Attack fixtures: shadow attacks (replace, hide via xref re-pointing), borrowed signature,
//! signature wrapping. Each builder produces a file whose CMS still verifies over its byte
//! range — a naive verifier would call it valid — and the test checks that our verifier
//! rejects it for the right reason.
//!
//! `WARRAQ_WRITE_FIXTURES=1 cargo test -p warraq-sign --test attacks` rewrites the committed
//! copies in `tests/fixtures/sign/attacks/`; `committed_attack_fixtures_are_rejected` checks
//! those files as they are.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
mod common;
use common::*;
use lopdf::{dictionary, Object, Stream, StringFormat};
use warraq_pdf::builder::{sample_pdf, SampleOptions};
use warraq_pdf::Pdf;
use warraq_sign::sign::{sign, signature_slots, SignOptions};
use warraq_sign::verify::{verify, Report, VerifyOptions};
use warraq_sign::x509::Cert;
use warraq_sign::SoftwareSigner;

const NOW: i64 = 1_790_358_029;

fn opts() -> VerifyOptions {
    VerifyOptions {
        trusted_roots: Cert::from_pem_or_der(&read_pki("root.pem")).unwrap(),
        now: NOW,
    }
}

fn signed(doc: Vec<u8>) -> Vec<u8> {
    let s = SoftwareSigner::from_pkcs12(&read_pki("signer-rsa-modern.p12"), PW).unwrap();
    sign(
        &Pdf::open(doc, None).unwrap(),
        &s,
        &SignOptions {
            time: NOW,
            ..Default::default()
        },
    )
    .unwrap()
    .bytes
}

fn check(bytes: &[u8]) -> Vec<Report> {
    verify(&Pdf::open(bytes.to_vec(), None).unwrap(), &opts()).unwrap()
}

/// Digest over the byte range recomputes to the CMS messageDigest: the naive check passes.
fn naive_digest_ok(bytes: &[u8]) -> bool {
    let pdf = Pdf::open(bytes.to_vec(), None).unwrap();
    let slot = signature_slots(&pdf).pop().unwrap();
    let cms = warraq_sign::cms::ParsedCms::parse(&slot.contents).unwrap();
    let r = slot.range;
    let chk = warraq_sign::cms::verify_signer(&cms, &|h| {
        h.digest_parts(&[&bytes[r[0]..r[0] + r[1]], &bytes[r[2]..r[2] + r[3]]])
    })
    .unwrap();
    chk.signature_valid && chk.digest_matches
}

fn startxref(bytes: &[u8]) -> usize {
    let p = bytes.windows(9).rposition(|w| w == b"startxref").unwrap();
    let s: String = bytes[p + 9..]
        .iter()
        .skip_while(|b| b.is_ascii_whitespace())
        .take_while(|b| b.is_ascii_digit())
        .map(|b| *b as char)
        .collect();
    s.parse().unwrap()
}

fn page_content_id(bytes: &[u8]) -> u32 {
    let pdf = Pdf::open(bytes.to_vec(), None).unwrap();
    let page = warraq_pdf::pages::flatten(&pdf).unwrap()[0].id;
    pdf.get_dict(page)
        .unwrap()
        .get(b"Contents")
        .unwrap()
        .as_reference()
        .unwrap()
        .0
}

/// Signed file + an appended update that replaces page 1's content stream.
fn shadow_replace() -> Vec<u8> {
    let b = signed(sample_pdf(1, &SampleOptions::default()).unwrap());
    let mut pdf = Pdf::open(b, None).unwrap();
    let c = page_content_id(pdf.bytes());
    pdf.set(
        (c, 0),
        Object::Stream(Stream::new(
            dictionary! {},
            b"BT /F1 24 Tf 72 720 Td (Pay 1,000,000 SAR) Tj ET".to_vec(),
        )),
    );
    pdf.commit().unwrap()
}

/// Hide attack through the cross-reference table: the signed revision carries a second,
/// unreferenced definition of the page content object; a later update only adds an xref
/// section re-pointing the object at those signed bytes.
fn shadow_hide_xref() -> Vec<u8> {
    let base = sample_pdf(1, &SampleOptions::default()).unwrap();
    let c = page_content_id(&base);
    let hidden = b"BT /F1 24 Tf 72 720 Td (Hidden: Pay 1,000,000 SAR) Tj ET";
    let mut doc = base.clone();
    let hidden_off = doc.len();
    doc.extend_from_slice(format!("{c} 0 obj\n<</Length {}>>\nstream\n", hidden.len()).as_bytes());
    doc.extend_from_slice(hidden);
    doc.extend_from_slice(b"\nendstream\nendobj\n");
    let signed_bytes = signed(doc);
    let pdf = Pdf::open(signed_bytes.clone(), None).unwrap();
    let size = pdf.next_number();
    let prev = startxref(&signed_bytes);
    let mut out = signed_bytes.clone();
    let xref_off = out.len();
    out.extend_from_slice(
        format!(
            "xref\n0 1\n0000000000 65535 f\r\n{c} 1\n{hidden_off:010} 00000 n\r\ntrailer\n<</Size {size} /Root 1 0 R /Prev {prev}>>\nstartxref\n{xref_off}\n%%EOF\n"
        )
        .as_bytes(),
    );
    out
}

/// Borrowed signature: a different document embeds the signed file in a stream and points a
/// copied signature dictionary's /ByteRange at the embedded bytes.
fn borrowed() -> Vec<u8> {
    let a = signed(sample_pdf(1, &SampleOptions::default()).unwrap());
    let apdf = Pdf::open(a.clone(), None).unwrap();
    let slot = signature_slots(&apdf).pop().unwrap();
    let r = slot.range;
    let other = sample_pdf(
        2,
        &SampleOptions {
            title: Some("A different contract".into()),
            ..Default::default()
        },
    )
    .unwrap();
    let mut pdf = Pdf::open(other, None).unwrap();
    pdf.add(Object::Stream(Stream::new(dictionary! {}, a.clone())));
    let sig = pdf.add(Object::Dictionary(dictionary! {
        "Type" => "Sig", "Filter" => "Adobe.PPKLite", "SubFilter" => "ETSI.CAdES.detached",
        "ByteRange" => vec![Object::Integer(9_999_999_999), Object::Integer(9_999_999_999), Object::Integer(9_999_999_999), Object::Integer(9_999_999_999)],
        "Contents" => Object::String(slot.contents.clone(), StringFormat::Hexadecimal),
        "M" => Object::string_literal("D:20260925174029+00'00'"),
    }));
    let page = warraq_pdf::pages::flatten(&pdf).unwrap()[0].id;
    let w = pdf.add(Object::Dictionary(dictionary! {
        "FT" => "Sig", "T" => Object::string_literal("Signature1"), "V" => Object::Reference(sig),
        "Type" => "Annot", "Subtype" => "Widget", "F" => 132,
        "Rect" => vec![0.into(), 0.into(), 0.into(), 0.into()], "P" => Object::Reference(page),
    }));
    let mut pd = pdf.get_dict(page).unwrap().clone();
    pd.set("Annots", vec![Object::Reference(w)]);
    pdf.set(page, Object::Dictionary(pd));
    let root = pdf.root_id().unwrap();
    let mut cat = pdf.get_dict(root).unwrap().clone();
    cat.set(
        "AcroForm",
        dictionary! {"Fields" => vec![Object::Reference(w)], "SigFlags" => 3},
    );
    pdf.set(root, Object::Dictionary(cat));
    let base_len = pdf.bytes().len();
    let mut out = pdf.save_incremental().unwrap();
    let s = base_len
        + out[base_len..]
            .windows(64)
            .position(|x| x == &a[..64])
            .unwrap();
    let mark = b"[9999999999 9999999999 9999999999 9999999999]";
    let at = out.windows(mark.len()).position(|x| x == mark).unwrap();
    let mut text = format!("[{} {} {} {}", s, r[1], s + r[2], r[3]).into_bytes();
    text.resize(mark.len() - 1, b' ');
    text.push(b']');
    out[at..at + mark.len()].copy_from_slice(&text);
    out
}

/// Signature wrapping (SWA): the signed second part is moved to the end, the space opened
/// inside the byte-range gap holds a new cross-reference section (at the offset the signed
/// `startxref` names), a new signature dictionary with a widened /ByteRange and malicious
/// page content.
fn wrapped() -> Vec<u8> {
    let base = sample_pdf(1, &SampleOptions::default()).unwrap();
    let c_obj = page_content_id(&base);
    let a = signed(base.clone());
    let apdf = Pdf::open(a.clone(), None).unwrap();
    let slot = signature_slots(&apdf).pop().unwrap();
    let [_, b, c, d] = slot.range;
    let x = startxref(&a);
    let prev = startxref(&base);
    // A's last xref section entries.
    let xref_text = String::from_utf8_lossy(&a[x..]).to_string();
    let mut entries: Vec<(u32, usize, u16, bool)> = Vec::new();
    let mut lines = xref_text.lines().skip(1);
    while let Some(l) = lines.next() {
        if l.starts_with("trailer") {
            break;
        }
        let parts: Vec<&str> = l.split_whitespace().collect();
        let (start, count): (u32, u32) = (parts[0].parse().unwrap(), parts[1].parse().unwrap());
        for i in 0..count {
            let e: Vec<&str> = lines.next().unwrap().split_whitespace().collect();
            entries.push((
                start + i,
                e[0].parse().unwrap(),
                e[1].parse().unwrap(),
                e[2] == "n",
            ));
        }
    }
    let size = apdf.next_number();
    let sig_num = slot.sig_id.0;
    let contents_hex: String = slot.contents.iter().map(|b| format!("{b:02X}")).collect();
    let evil = b"BT /F1 24 Tf 72 720 Td (Wrapped: Pay 1,000,000 SAR) Tj ET";
    // Layout: A[..c] | fill (x - c) | XREF | TRAILER | OBJS | A[c..]
    let n_entries = entries.len() + 1; // + the page content object
    let xref_len = |_: usize| -> usize {
        // "xref\n" + per-entry subsection header + 20-byte rows (one subsection per entry).
        5 + entries
            .iter()
            .map(|(n, ..)| format!("{n} 1\n").len() + 20)
            .sum::<usize>()
            + format!("{c_obj} 1\n").len()
            + 20
    };
    let _ = n_entries;
    let trailer = format!("trailer\n<</Size {size} /Root 1 0 R /Prev {prev}>>\n");
    let sig_obj = |c2: usize| -> String {
        format!(
            "{sig_num} 0 obj\n<</Type /Sig /Filter /Adobe.PPKLite /SubFilter /ETSI.CAdES.detached /ByteRange [0 {b} {c2:<12} {d}] /Contents <{contents_hex}> /M (D:20260925174029+00'00')>>\nendobj\n"
        )
    };
    let evil_obj = format!(
        "{c_obj} 0 obj\n<</Length {}>>\nstream\n{}\nendstream\nendobj\n",
        evil.len(),
        String::from_utf8_lossy(evil)
    );
    let objs_len = sig_obj(0).len() + evil_obj.len();
    let m = (x - c) + xref_len(0) + trailer.len() + objs_len;
    let c2 = c + m;
    let objs_start = x + xref_len(0) + trailer.len();
    let sig_off = objs_start;
    let evil_off = objs_start + sig_obj(c2).len();
    let mut xref = String::from("xref\n");
    let mut all: Vec<(u32, usize, u16, bool)> = entries
        .iter()
        .map(|&(n, off, g, used)| {
            if !used {
                (n, off, g, used)
            } else if n == sig_num {
                (n, sig_off, g, used)
            } else if off >= c {
                (n, off + m, g, used)
            } else {
                (n, off, g, used)
            }
        })
        .collect();
    all.push((c_obj, evil_off, 0, true));
    for (n, off, g, used) in &all {
        xref.push_str(&format!(
            "{n} 1\n{off:010} {g:05} {}\r\n",
            if *used { 'n' } else { 'f' }
        ));
    }
    assert_eq!(xref.len(), xref_len(0));
    let mut w = a[..c].to_vec();
    w.extend(std::iter::repeat_n(b' ', x - c));
    assert_eq!(w.len(), x);
    w.extend_from_slice(xref.as_bytes());
    w.extend_from_slice(trailer.as_bytes());
    assert_eq!(w.len(), sig_off);
    w.extend_from_slice(sig_obj(c2).as_bytes());
    w.extend_from_slice(evil_obj.as_bytes());
    assert_eq!(w.len(), c2);
    w.extend_from_slice(&a[c..]);
    w
}

fn has_attack(r: &Report, kind: &str) -> bool {
    r.attacks.iter().any(|a| a.kind == kind)
}

fn write_fixture(name: &str, bytes: &[u8]) {
    if std::env::var("WARRAQ_WRITE_FIXTURES").is_ok() {
        let dir = fixture("attacks");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(name), bytes).unwrap();
    }
}

fn assert_shadow_replace(b: &[u8]) {
    let r = &check(b)[0];
    assert!(r.integrity, "the signed revision itself is intact");
    assert_eq!(r.status, "modified", "{r:#?}");
    assert!(has_attack(r, "shadow_replace"), "{:?}", r.attacks);
}

fn assert_shadow_hide(b: &[u8]) {
    let r = &check(b)[0];
    assert_eq!(r.status, "modified", "{r:#?}");
    assert!(has_attack(r, "shadow_hide"), "{:?}", r.attacks);
    assert!(r
        .modifications
        .iter()
        .any(|m| m.kind == "xref_manipulation"));
}

fn assert_borrowed(b: &[u8]) {
    let r = &check(b)[0];
    assert_eq!(r.status, "invalid", "{r:#?}");
    assert!(!r.integrity);
    assert!(has_attack(r, "borrowed_signature"), "{:?}", r.attacks);
    assert!(r
        .reasons
        .iter()
        .any(|n| n.code == "byte_range_not_from_start"));
}

fn assert_wrapped(b: &[u8]) {
    let r = &check(b)[0];
    assert_eq!(r.status, "invalid", "{r:#?}");
    assert!(has_attack(r, "signature_wrapping"), "{:?}", r.attacks);
    assert!(
        r.reasons.iter().any(|n| n.code == "contents_not_in_gap"),
        "{:?}",
        r.reasons
    );
}

#[test]
fn shadow_replace_fixture() {
    let b = shadow_replace();
    assert!(naive_digest_ok(&b));
    assert_shadow_replace(&b);
    write_fixture("shadow-replace.pdf", &b);
}

#[test]
fn shadow_hide_via_xref_fixture() {
    let b = shadow_hide_xref();
    assert!(naive_digest_ok(&b));
    // The attack works on a viewer: the current page content is the hidden text.
    let pdf = Pdf::open(b.clone(), None).unwrap();
    let c = page_content_id(&b);
    let s = match pdf.get((c, 0)).unwrap() {
        Object::Stream(s) => s.content.clone(),
        _ => panic!(),
    };
    assert!(
        String::from_utf8_lossy(&s).contains("Hidden"),
        "the attack must be effective"
    );
    assert_shadow_hide(&b);
    write_fixture("shadow-hide-xref.pdf", &b);
}

#[test]
fn borrowed_signature_fixture() {
    let b = borrowed();
    assert!(
        naive_digest_ok(&b),
        "digest over the byte range matches: a naive check passes"
    );
    assert_borrowed(&b);
    write_fixture("borrowed-signature.pdf", &b);
}

#[test]
fn wrapped_byte_range_fixture() {
    let b = wrapped();
    assert!(
        naive_digest_ok(&b),
        "digest over the byte range matches: a naive check passes"
    );
    let pdf = Pdf::open(b.clone(), None).unwrap();
    let c = page_content_id(&b);
    let s = match pdf.get((c, 0)).unwrap() {
        Object::Stream(s) => s.content.clone(),
        _ => panic!(),
    };
    assert!(
        String::from_utf8_lossy(&s).contains("Wrapped"),
        "the attack must be effective"
    );
    assert_wrapped(&b);
    write_fixture("wrapped-byterange.pdf", &b);
}

#[test]
fn committed_attack_fixtures_are_rejected() {
    let dir = fixture("attacks");
    let read = |n: &str| std::fs::read(dir.join(n)).unwrap_or_else(|e| panic!("{n}: {e}"));
    assert_shadow_replace(&read("shadow-replace.pdf"));
    assert_shadow_hide(&read("shadow-hide-xref.pdf"));
    assert_borrowed(&read("borrowed-signature.pdf"));
    assert_wrapped(&read("wrapped-byterange.pdf"));
}
