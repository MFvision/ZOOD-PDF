//! Share › Email as an attachment: the document as it stands is written to a
//! folder of the app's own under the system's temporary folder, then handed to
//! the person's mail program as a new message with the file attached — Mail
//! on a Mac (`open -a Mail`), the default mail program on Windows through
//! Simple MAPI (`MAPISendMailW`, the call Explorer's "Send to › Mail recipient"
//! makes), `xdg-email` elsewhere. Nothing is sent: the message opens for the
//! person to address and send.

use std::path::{Path, PathBuf};

use tauri::ipc::{InvokeBody, Request};

/// Where shared copies are written: emptied of older copies each time.
fn share_folder() -> PathBuf {
    std::env::temp_dir().join("ZOOD PDF").join("share")
}

/// A plain file name, whatever the document was called: no folders, none of
/// the characters Windows refuses, and ending in .pdf.
pub fn safe_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let cleaned: String = base
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.');
    let stem = if trimmed.is_empty() {
        "document"
    } else {
        trimmed
    };
    if stem.to_lowercase().ends_with(".pdf") {
        stem.to_string()
    } else {
        format!("{stem}.pdf")
    }
}

/// Writes the document (the raw body; its name percent-encoded in
/// `x-warraq-name`) for sharing, and returns where.
#[tauri::command]
pub fn share_prepare(request: Request<'_>) -> Result<String, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("E_ARGS: the document travels as a raw body".into());
    };
    let name = request
        .headers()
        .get("x-warraq-name")
        .and_then(|value| value.to_str().ok())
        .and_then(crate::batch::percent_decode)
        .ok_or("E_ARGS: no file name")?;
    let folder = share_folder();
    // Copies shared earlier are not kept.
    let _ = std::fs::remove_dir_all(&folder);
    std::fs::create_dir_all(&folder).map_err(|e| format!("E_IO: {e}"))?;
    let path = folder.join(safe_name(&name));
    std::fs::write(&path, bytes).map_err(|e| format!("E_IO: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

/// Opens a new message with `path` attached. Only a file `share_prepare` wrote.
#[tauri::command]
pub async fn share_email(path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    let folder = share_folder();
    if path.parent() != Some(folder.as_path()) || !path.is_file() {
        return Err("E_SCOPE: only a copy made for sharing is attached".into());
    }
    send(&path)
}

#[cfg(target_os = "macos")]
fn send(path: &Path) -> Result<(), String> {
    let status = std::process::Command::new("open")
        .args(["-a", "Mail"])
        .arg(path)
        .status()
        .map_err(|e| format!("E_MAIL: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("E_MAIL: Mail did not open".into())
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn send(path: &Path) -> Result<(), String> {
    let status = std::process::Command::new("xdg-email")
        .arg("--attach")
        .arg(path)
        .status()
        .map_err(|e| format!("E_MAIL: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("E_MAIL: no mail program answered".into())
    }
}

#[cfg(windows)]
fn send(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
    use windows_sys::Win32::System::Mapi::{
        MapiFileDescW, MapiMessageW, MAPI_DIALOG, MAPI_LOGON_UI, MAPI_USER_ABORT, SUCCESS_SUCCESS,
    };

    let wide = |text: &std::ffi::OsStr| text.encode_wide().chain(Some(0)).collect::<Vec<u16>>();
    let mut full = wide(path.as_os_str());
    let mut name = wide(path.file_name().unwrap_or_default());
    let library = wide(std::ffi::OsStr::new("mapi32.dll"));
    // SAFETY: plain Win32 calls with NUL-terminated buffers that outlive them;
    // the function pointer is MAPISendMailW's, as its exported name says.
    unsafe {
        let module = LoadLibraryW(library.as_ptr());
        if module.is_null() {
            return Err("E_MAIL: no mail program is set up on this computer".into());
        }
        let Some(proc) = GetProcAddress(module, c"MAPISendMailW".as_ptr().cast()) else {
            return Err(
                "E_MAIL: the mail program does not take attachments from other apps".into(),
            );
        };
        // The shape `LPMAPISENDMAILW` names.
        let send_mail = std::mem::transmute::<
            unsafe extern "system" fn() -> isize,
            unsafe extern "system" fn(usize, usize, *const MapiMessageW, u32, u32) -> u32,
        >(proc);
        let mut file = MapiFileDescW {
            ulReserved: 0,
            flFlags: 0,
            nPosition: u32::MAX,
            lpszPathName: full.as_mut_ptr(),
            lpszFileName: name.as_mut_ptr(),
            lpFileType: std::ptr::null_mut(),
        };
        let message = MapiMessageW {
            ulReserved: 0,
            lpszSubject: name.as_mut_ptr(),
            lpszNoteText: std::ptr::null_mut(),
            lpszMessageType: std::ptr::null_mut(),
            lpszDateReceived: std::ptr::null_mut(),
            lpszConversationID: std::ptr::null_mut(),
            flFlags: 0,
            lpOriginator: std::ptr::null_mut(),
            nRecipCount: 0,
            lpRecips: std::ptr::null_mut(),
            nFileCount: 1,
            lpFiles: &mut file,
        };
        let code = send_mail(0, 0, &message, MAPI_DIALOG | MAPI_LOGON_UI, 0);
        match code {
            SUCCESS_SUCCESS | MAPI_USER_ABORT => Ok(()),
            other => Err(format!("E_MAIL: the mail program answered {other}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_shared_copy_has_a_plain_pdf_name() {
        assert_eq!(safe_name("Invoice 0412.pdf"), "Invoice 0412.pdf");
        assert_eq!(safe_name("عقد الإيجار"), "عقد الإيجار.pdf");
        assert_eq!(safe_name("../../etc/passwd"), "passwd.pdf");
        assert_eq!(
            safe_name("C:\\Users\\a\\Report: final?.PDF"),
            "Report_ final_.PDF"
        );
        assert_eq!(safe_name("..."), "document.pdf");
    }
}
