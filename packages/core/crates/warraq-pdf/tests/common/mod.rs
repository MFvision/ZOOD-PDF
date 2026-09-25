#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    dead_code
)]

use warraq_pdf::limits::decode_stream;
use warraq_pdf::lopdf::Object;
use warraq_pdf::{metadata, pages, Pdf};

pub fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(format!(
        "{}/tests/fixtures/{}",
        env!("CARGO_MANIFEST_DIR"),
        name
    ))
    .unwrap_or_else(|e| panic!("fixture {name}: {e}"))
}

/// Decoded content of page `i`.
pub fn page_text(pdf: &Pdf, i: usize) -> String {
    let p = &pages::flatten(pdf).unwrap()[i];
    let d = pdf.get_dict(p.id).unwrap();
    let mut out = Vec::new();
    let ids: Vec<_> = match d.get(b"Contents").unwrap() {
        Object::Reference(r) => vec![*r],
        Object::Array(a) => a.iter().map(|o| o.as_reference().unwrap()).collect(),
        _ => vec![],
    };
    for id in ids {
        if let Some(Object::Stream(s)) = pdf.get(id) {
            out.extend(decode_stream(s, pdf.limits()).unwrap());
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub fn title(pdf: &Pdf) -> Option<String> {
    metadata::get_info(pdf).get("Title").cloned()
}

pub fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

/// Run python with pypdf if available; returns None when python/pypdf is missing.
pub fn python(script: &str, file: &[u8]) -> Option<String> {
    let dir = std::env::temp_dir().join(format!(
        "warraq-py-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join("in.pdf");
    std::fs::write(&path, file).ok()?;
    let out = std::process::Command::new("python3")
        .arg("-c")
        .arg(script)
        .arg(&path)
        .output()
        .ok()?;
    let _ = std::fs::remove_dir_all(&dir);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if stderr.contains("No module named") {
        eprintln!("skipping python cross-check: {stderr}");
        return None;
    }
    assert!(out.status.success(), "python failed: {stderr}");
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}
