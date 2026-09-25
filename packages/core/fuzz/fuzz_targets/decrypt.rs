//! Fuzz the Standard security handler: an encryption dictionary built from fuzz bytes, then
//! decryption of the remaining bytes; plus whole-file opening with common passwords.
#![no_main]

use libfuzzer_sys::fuzz_target;
use warraq_pdf::crypt::CryptMethod;
use warraq_pdf::lopdf::{Dictionary, Object, StringFormat};
use warraq_pdf::{Limits, Pdf, SecurityHandler};

fn take<'a>(d: &mut &'a [u8], n: usize) -> &'a [u8] {
    let n = n.min(d.len());
    let (a, b) = d.split_at(n);
    *d = b;
    a
}

fuzz_target!(|data: &[u8]| {
    let mut d = data;
    let hdr = take(&mut d, 4);
    let (v, r, len_sel, m) = match hdr {
        [a, b, c, e] => (i64::from(a % 6), i64::from(b % 8), i64::from(*c), *e),
        _ => return,
    };
    let s = |b: &[u8]| Object::String(b.to_vec(), StringFormat::Hexadecimal);
    let mut dict = Dictionary::new();
    dict.set("Filter", Object::Name(b"Standard".to_vec()));
    dict.set("V", Object::Integer(v));
    dict.set("R", Object::Integer(r));
    dict.set("Length", Object::Integer(len_sel * 8));
    dict.set("O", s(take(&mut d, 48)));
    dict.set("U", s(take(&mut d, 48)));
    dict.set("OE", s(take(&mut d, 32)));
    dict.set("UE", s(take(&mut d, 32)));
    dict.set("P", Object::Integer(-4));
    let mut cf = Dictionary::new();
    let mut std_cf = Dictionary::new();
    let cfm: &[u8] = match m % 4 {
        0 => b"V2",
        1 => b"AESV2",
        2 => b"AESV3",
        _ => b"None",
    };
    std_cf.set("CFM", Object::Name(cfm.to_vec()));
    cf.set("StdCF", Object::Dictionary(std_cf));
    dict.set("CF", Object::Dictionary(cf));
    dict.set("StmF", Object::Name(b"StdCF".to_vec()));
    dict.set("StrF", Object::Name(b"StdCF".to_vec()));
    let id0 = take(&mut d, 16).to_vec();
    for pw in ["", "user", "owner"] {
        if let Ok(h) = SecurityHandler::open(&dict, &id0, pw) {
            for method in [CryptMethod::Rc4, CryptMethod::AesV2, CryptMethod::AesV3] {
                let _ = h.decrypt_bytes((1, 0), method, d);
            }
            let mut o = Object::String(d.to_vec(), StringFormat::Literal);
            let _ = h.decrypt_object((2, 0), &mut o, &Limits::default());
        }
    }
    for pw in [None, Some("user"), Some("owner")] {
        let _ = Pdf::open(data.to_vec(), pw);
    }
});
