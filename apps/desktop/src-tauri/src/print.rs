//! Print: the file as it stands, through the system's print panel.
//!
//! A webview's own print prints the app around the document, and the macOS
//! webview offers none to a page at all. So on macOS the host prints the PDF
//! itself, with PDFKit: vector pages scaled to the paper, in the standard
//! print sheet on Warraq's window. Elsewhere there is no print yet, and the
//! interface does not offer one (`print_available`).

use tauri::ipc::{InvokeBody, Request};
use tauri::{Runtime, WebviewWindow};

use crate::core_bridge::password_from;

/// Whether this build can print: the interface offers Print only then.
#[tauri::command]
pub fn print_available() -> bool {
    cfg!(target_os = "macos")
}

/// Opens the print sheet for the PDF in the raw request body — the file as it
/// stands, from the interface — with its password, if it has one, in the
/// same header `doc_open` reads.
#[tauri::command(async)]
pub fn print_pdf<R: Runtime>(window: WebviewWindow<R>, request: Request<'_>) -> Result<(), String> {
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes.clone(),
        InvokeBody::Json(_) => {
            return Err("E_PARSE: print_pdf expects the PDF bytes as the raw request body".into())
        }
    };
    let password = password_from(&request);
    crate::core_bridge::debug_log(format!("print {} bytes", bytes.len()));
    #[cfg(target_os = "macos")]
    {
        mac::print_sheet(window, bytes, password)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, bytes, password);
        Err("E_PRINT: printing is not available on this system yet".into())
    }
}

#[cfg(target_os = "macos")]
pub mod mac {
    use objc2::rc::Retained;
    use objc2::AllocAnyThread;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSPrintInfo, NSPrintOperation, NSWindow};
    use objc2_foundation::{NSData, NSString};
    use objc2_pdf_kit::{PDFDocument, PDFPrintScalingMode};
    use tauri::{Runtime, WebviewWindow};

    /// The print operation for a PDF, with `info`: its pages scaled down to
    /// fit the paper and turned to match it. `Err` when PDFKit cannot read
    /// the file, the password does not unlock it, or it does not allow
    /// printing — a permission Warraq honours, as Acrobat does.
    pub fn operation(
        bytes: &[u8],
        password: Option<&str>,
        info: &NSPrintInfo,
        main: MainThreadMarker,
    ) -> Result<Retained<NSPrintOperation>, String> {
        let data = NSData::with_bytes(bytes);
        let document = unsafe { PDFDocument::initWithData(PDFDocument::alloc(), &data) }
            .ok_or("E_PRINT: the file could not be read for printing")?;
        if unsafe { document.isLocked() } {
            let unlocked = password
                .map(|p| unsafe { document.unlockWithPassword(&NSString::from_str(p)) })
                .unwrap_or(false);
            if !unlocked {
                return Err("E_PASSWORD: the file needs its password to be printed".into());
            }
        }
        if !unsafe { document.allowsPrinting() } {
            return Err("E_PRINT_FORBIDDEN: this file does not allow printing".into());
        }
        unsafe {
            document.printOperationForPrintInfo_scalingMode_autoRotate(
                Some(info),
                PDFPrintScalingMode::PageScaleDownToFit,
                true,
                main,
            )
        }
        .ok_or_else(|| "E_PRINT: PDFKit made no print operation for this file".into())
    }

    /// Runs `operation` as a sheet on `window`, on the main thread AppKit
    /// needs; returns once the sheet is up, or with why it could not be.
    pub fn print_sheet<R: Runtime>(
        window: WebviewWindow<R>,
        bytes: Vec<u8>,
        password: Option<String>,
    ) -> Result<(), String> {
        let (sent, received) = std::sync::mpsc::channel();
        let target = window.clone();
        window
            .run_on_main_thread(move || {
                let shown = (|| {
                    let main = MainThreadMarker::new().ok_or("E_PRINT: not on the main thread")?;
                    let info = NSPrintInfo::sharedPrintInfo();
                    let operation = operation(&bytes, password.as_deref(), &info, main)?;
                    operation.setShowsPrintPanel(true);
                    operation.setShowsProgressPanel(true);
                    let ns_window = target.ns_window().map_err(|e| format!("E_PRINT: {e}"))?;
                    // Tauri's own window, alive for as long as the app is.
                    let ns_window = unsafe { &*(ns_window as *const NSWindow) };
                    unsafe {
                        operation.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
                            ns_window,
                            None,
                            None,
                            std::ptr::null_mut(),
                        );
                    }
                    Ok(())
                })();
                let _ = sent.send(shown);
            })
            .map_err(|e| format!("E_PRINT: {e}"))?;
        received
            .recv()
            .map_err(|_| "E_PRINT: the print sheet did not open".to_string())?
    }
}
