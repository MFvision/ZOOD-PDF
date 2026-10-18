//! The registry behind the Tauri commands, driven directly against the corpus.
//!
//! Same code path as `doc_open` / `doc_render_page` / `doc_extract_text` — only
//! the IPC wrapper is missing, so this proves the desktop host really renders
//! with native PDFium and still reads Arabic through the shared core API.
//!
//! `PDFIUM_LIB_DIR` is set here the way `core_bridge::setup` sets it at startup:
//! the bundled copy in `src-tauri/resources/pdfium`, else the session tools dir.

use std::path::PathBuf;
use std::time::Instant;

use warraq_desktop_lib::core_bridge::{
    detect_engine, encode_bitmap, metadata_json, text_lines, Registry,
};

const CORPUS: &str = "chrome-cairo-mixed-invoice.pdf";
const ARABIC_TITLE: &str = "فاتورة ضريبية مبسطة";

fn manifest() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// Mirrors `core_bridge::locate_pdfium`, which cannot run without an
/// `AppHandle`. Once per process: tests share the environment.
fn point_at_pdfium() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        if std::env::var_os("PDFIUM_LIB_DIR").is_some() {
            return;
        }
        let candidates = [
            manifest().join("resources/pdfium"),
            manifest().join("../../../.tools/pdfium/mac/lib"),
        ];
        let dir = candidates
            .iter()
            .find(|dir| dir.join("libpdfium.dylib").is_file())
            .unwrap_or_else(|| {
                panic!("no libpdfium.dylib in any of {candidates:?}; set PDFIUM_LIB_DIR")
            });
        std::env::set_var("PDFIUM_LIB_DIR", dir);
    });
}

fn corpus_bytes() -> Vec<u8> {
    let path = manifest()
        .join("../../../tests/corpus/arabic/generated")
        .join(CORPUS);
    std::fs::read(&path).unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()))
}

/// The engine each desktop build renders with: PDFium on the Mac, where its
/// library is bundled; Warraq's own Rust renderer (hayro) on Windows, where it
/// is not (apps/desktop/README.md), so the same checks below run against that.
const EXPECTED_ENGINE: &str = if cfg!(target_os = "macos") {
    "pdfium+hayro"
} else {
    "hayro"
};

#[test]
fn renders_with_native_pdfium_and_reads_arabic_through_the_core_api() {
    point_at_pdfium();
    assert_eq!(
        detect_engine(),
        EXPECTED_ENGINE,
        "the engine is not the one this platform's build ships with (on the Mac: the PDFium \
         dynamic library did not bind, and the host would silently fall back to hayro)"
    );

    let mut registry = Registry::default();

    let started = Instant::now();
    let handle = registry.open(corpus_bytes(), None).expect("doc_open");
    let open_ms = started.elapsed().as_secs_f64() * 1000.0;

    let document = registry.get(handle).expect("handle is registered");
    assert_eq!(document.page_count(), 1);

    let (width_pt, height_pt) = document.page_size(0).expect("doc_page_size");
    assert!((width_pt - 595.0).abs() <= 1.0, "width {width_pt} pt");
    assert!((height_pt - 842.0).abs() <= 1.0, "height {height_pt} pt");

    // A4 at scale 1.0 is one pixel per point.
    let started = Instant::now();
    let bitmap = document.render_page(0, 1.0).expect("doc_render_page");
    let render_ms = started.elapsed().as_secs_f64() * 1000.0;
    assert!(
        (bitmap.width as i64 - 595).abs() <= 1 && (bitmap.height as i64 - 842).abs() <= 1,
        "expected 595x842 (+/-1), got {}x{}",
        bitmap.width,
        bitmap.height
    );
    assert_eq!(
        bitmap.rgba.len(),
        (bitmap.width * bitmap.height * 4) as usize
    );

    // The page must carry ink, not just a white rectangle.
    let dark = bitmap
        .rgba
        .as_chunks::<4>()
        .0
        .iter()
        .filter(|p| p[0] < 100 && p[1] < 100 && p[2] < 100)
        .count();
    assert!(dark > 500, "only {dark} dark pixels; the page looks blank");

    // Exactly the bytes `doc_render_page` puts on the wire.
    let body = encode_bitmap(&bitmap);
    assert_eq!(&body[0..4], &bitmap.width.to_le_bytes());
    assert_eq!(&body[4..8], &bitmap.height.to_le_bytes());
    assert_eq!(body.len(), 8 + bitmap.rgba.len());

    let started = Instant::now();
    let text = document.extract_text(0).expect("doc_extract_text");
    let text_ms = started.elapsed().as_secs_f64() * 1000.0;
    assert!(
        text.contains(ARABIC_TITLE),
        "missing {ARABIC_TITLE:?} in:\n{text}"
    );

    let lines = text_lines(document, 0).expect("doc_text_lines");
    assert!(!lines.is_empty());
    assert!(
        lines.iter().any(|l| l.direction == "rtl"),
        "no right-to-left line was reported"
    );

    assert_eq!(document.search(ARABIC_TITLE), vec![0]);

    let metadata = metadata_json(document, detect_engine()).expect("doc_metadata");
    assert!(
        metadata.contains(&format!("\"engine\":\"{EXPECTED_ENGINE}\"")),
        "{metadata}"
    );
    assert!(metadata.contains("\"pages\":1"), "{metadata}");

    println!(
        "core_bridge timings: open {open_ms:.1} ms, render@1.0 {render_ms:.1} ms \
         ({}x{}), extract_text {text_ms:.1} ms",
        bitmap.width, bitmap.height
    );

    assert!(registry.close(handle));
    assert!(registry.is_empty());
    assert!(!registry.close(handle), "closing twice must be a no-op");
    assert!(registry.get(handle).is_err());
}

#[test]
fn unknown_handles_and_broken_bytes_get_stable_error_codes() {
    point_at_pdfium();
    let mut registry = Registry::default();
    assert_eq!(registry.len(), 0);
    // `Document` is not `Debug`, so unwrap the error side explicitly.
    let err = registry.get(7).err().expect("an unknown handle must fail");
    assert!(err.starts_with("E_NOT_FOUND"), "{err}");
    let err = registry
        .open(b"not a pdf at all".to_vec(), None)
        .unwrap_err();
    assert!(err.starts_with("E_PARSE"), "{err}");
}
