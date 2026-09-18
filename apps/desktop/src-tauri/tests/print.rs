//! Print through PDFKit into a file rather than onto paper: the operation the
//! print sheet runs (src/print.rs), without the sheet. AppKit wants the main
//! thread, so this test runs without the harness (Cargo.toml).

#[cfg(target_os = "macos")]
fn main() {
    use objc2::runtime::ProtocolObject;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSPrintInfo, NSPrintJobSavingURL, NSPrintSaveJob};
    use objc2_foundation::{NSString, NSURL};
    use warraq_desktop_lib::print::mac::operation;

    let main = MainThreadMarker::new().expect("the test runs on the main thread");
    let _app = NSApplication::sharedApplication(main);
    let corpus = |name: &str| {
        std::fs::read(format!(
            "{}/../../../tests/corpus/arabic/generated/{name}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap()
    };
    let printed = |bytes: &[u8], password: Option<&str>| -> Result<Vec<u8>, String> {
        let out = std::env::temp_dir().join(format!("warraq-print-{}.pdf", std::process::id()));
        let _ = std::fs::remove_file(&out);
        let info = NSPrintInfo::sharedPrintInfo();
        let url = NSURL::fileURLWithPath(&NSString::from_str(out.to_str().unwrap()));
        unsafe {
            info.setJobDisposition(NSPrintSaveJob);
            info.dictionary()
                .setObject_forKey(&url, ProtocolObject::from_ref(NSPrintJobSavingURL));
        }
        let operation = operation(bytes, password, &info, main)?;
        operation.setShowsPrintPanel(false);
        operation.setShowsProgressPanel(false);
        if !operation.runOperation() {
            return Err("the print operation did not run".into());
        }
        std::fs::read(&out).map_err(|e| e.to_string())
    };

    let three = printed(&corpus("chrome-notonaskh-justified-3pages.pdf"), None).expect("printed");
    let doc = warraq_core::Document::open(three, None).unwrap();
    assert_eq!(doc.page_count(), 3, "every page printed");
    let text = doc.extract_text(0).unwrap();
    println!(
        "print: page 1 text starts {:?}",
        text.chars().take(40).collect::<String>()
    );

    let locked = corpus("variant-encrypted-aes256.pdf");
    let refused = printed(&locked, None).unwrap_err();
    assert!(refused.starts_with("E_PASSWORD"), "{refused}");
    let unlocked = printed(&locked, Some("warraq")).expect("printed with its password");
    assert_eq!(
        warraq_core::Document::open(unlocked, None)
            .unwrap()
            .page_count(),
        3
    );
    println!("print: ok");
}

#[cfg(not(target_os = "macos"))]
fn main() {}
