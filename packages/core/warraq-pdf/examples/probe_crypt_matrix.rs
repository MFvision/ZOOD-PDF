//! TEMPORARY probe: can lopdf parse an encrypted file with the ciphertext left
//! in place if `/Encrypt` is hidden from the trailer?
use lopdf::{Document, Object};

fn hide_encrypt(data: &[u8]) -> Vec<u8> {
    let mut out = data.to_vec();
    let mut i = 0usize;
    while let Some(p) = find(&out[i..], b"/Encrypt") {
        let at = i + p;
        if reference_follows(&out[at + 8..]) {
            out[at + 1] = b'e';
        }
        i = at + 8;
    }
    // also downgrade /Type /ObjStm so lopdf does not try to inflate an encrypted container
    let mut i = 0usize;
    while let Some(p) = find(&out[i..], b"/ObjStm") {
        let at = i + p;
        out[at + 4] = b's';
        i = at + 7;
    }
    out
}

fn find(h: &[u8], n: &[u8]) -> Option<usize> {
    h.windows(n.len()).position(|w| w == n)
}

fn reference_follows(s: &[u8]) -> bool {
    let mut i = 0;
    let ws = |b: u8| matches!(b, b' ' | b'\t' | b'\r' | b'\n' | b'\x0c' | b'\0');
    for _ in 0..2 {
        while i < s.len() && ws(s[i]) {
            i += 1;
        }
        let start = i;
        while i < s.len() && s[i].is_ascii_digit() {
            i += 1;
        }
        if i == start {
            return false;
        }
    }
    while i < s.len() && ws(s[i]) {
        i += 1;
    }
    s.get(i) == Some(&b'R')
}

fn main() {
    let dir = format!(
        "{}/../../../tests/corpus/arabic/generated",
        env!("CARGO_MANIFEST_DIR")
    );
    for name in [
        "variant-encrypted-rc4-40.pdf",
        "variant-encrypted-rc4-128.pdf",
        "variant-encrypted-aes128.pdf",
        "variant-encrypted-aes256-owner-only.pdf",
        "variant-encrypted-aes256.pdf",
    ] {
        let bytes = std::fs::read(format!("{dir}/{name}")).unwrap();
        let patched = hide_encrypt(&bytes);
        match Document::load_mem(&patched) {
            Ok(d) => {
                let objstm = d
                    .objects
                    .iter()
                    .filter(|(_, o)| {
                        o.as_stream()
                            .map(|s| {
                                s.dict
                                    .get(b"Type")
                                    .and_then(Object::as_name)
                                    .map(|n| n == b"Objstm")
                                    .unwrap_or(false)
                            })
                            .unwrap_or(false)
                    })
                    .count();
                let strings = d
                    .objects
                    .values()
                    .filter(|o| matches!(o, Object::String(..)))
                    .count();
                let title = d
                    .trailer
                    .get(b"Info")
                    .and_then(Object::as_reference)
                    .and_then(|id| d.get_dictionary(id))
                    .ok()
                    .and_then(|dd| {
                        dd.get(b"Producer")
                            .ok()
                            .and_then(|o| o.as_str().ok())
                            .map(|b| b.to_vec())
                    });
                println!(
                    "{name:42} objs={:4} enc={} objstm_containers={objstm} top_strings={strings} producer_ciphertext={:?}",
                    d.objects.len(),
                    d.is_encrypted(),
                    title.map(|t| t.iter().take(12).map(|b| format!("{b:02x}")).collect::<String>())
                );
            }
            Err(e) => println!("{name:42} ERR {e}"),
        }
    }
}
