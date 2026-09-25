//! macOS printing through PDFKit: `PDFDocument(data:)` → `printOperation(for:scalingMode:autoRotate:)`.
//! WKWebView's `window.print()` does not print a PDF faithfully (or at all), so the document
//! bytes are handed to PDFKit, which shows the standard print panel.
//!
//! Compiled and exercised only on macOS (CI: `.github/workflows/macos.yml` builds it; the
//! print panel itself needs a person at a Mac — see docs/STATUS.md).
#![allow(unsafe_code)]

use objc2::{AnyThread, MainThreadMarker};
use objc2_app_kit::NSPrintInfo;
use objc2_foundation::{NSData, NSString};
use objc2_pdf_kit::{PDFDocument, PDFPrintScalingMode};

/// Must be called on the main thread (use `AppHandle::run_on_main_thread`).
pub fn print_pdf(bytes: Vec<u8>, job_title: &str) -> Result<(), String> {
    let mtm = MainThreadMarker::new().ok_or("print must run on the main thread")?;
    let data = NSData::with_bytes(&bytes);
    // SAFETY: `data` is a valid, retained NSData for the duration of the call; PDFKit retains
    // what it needs. `alloc` + `initWithData:` is the documented initialiser pair.
    let doc = unsafe { PDFDocument::initWithData(PDFDocument::alloc(), &data) }
        .ok_or("PDFKit could not open this document")?;
    // SAFETY: plain property getter on a valid PDFDocument.
    if unsafe { doc.isLocked() } {
        return Err("the document is locked with a password".into());
    }
    let info = NSPrintInfo::sharedPrintInfo();
    // SAFETY: valid PDFDocument and NSPrintInfo; we are on the main thread (mtm).
    let op = unsafe {
        doc.printOperationForPrintInfo_scalingMode_autoRotate(
            Some(&info),
            PDFPrintScalingMode::PageScaleDownToFit,
            true,
            mtm,
        )
    }
    .ok_or("PDFKit could not create a print operation")?;
    op.setJobTitle(Some(&NSString::from_str(job_title)));
    op.setShowsPrintPanel(true);
    op.setShowsProgressPanel(true);
    // App-modal print panel; returns when the user prints or cancels.
    op.runOperation();
    Ok(())
}
