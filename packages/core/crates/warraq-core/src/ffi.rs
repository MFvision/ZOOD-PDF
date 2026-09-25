//! C ABI (feature `ffi`) for the iOS app. Header: `include/warraq.h` (kept in sync by the
//! `header_declares_every_export` test). This is the only module allowed to use `unsafe`;
//! every block states why it is sound.
//!
//! Ownership: `warraq_open` returns a document the caller must `warraq_close`; every
//! `WarraqReply*` must be released with `warraq_free_reply`. Input pointers are borrowed for
//! the duration of the call only.
#![allow(unsafe_code)]

use crate::{call_static, guarded, CoreError, Document, Reply};
use serde_json::Value;
use std::ffi::{c_char, CStr, CString};

/// Result of a call. `is_error == 1` means `json` holds `{ "code", "message" }`.
#[repr(C)]
pub struct WarraqReply {
    /// 0 on success, 1 on error.
    pub is_error: i32,
    /// NUL-terminated UTF-8 JSON.
    pub json: *mut c_char,
    /// Length of `json` in bytes (without the NUL).
    pub json_len: usize,
    /// `blob_count` pointers to blob bytes.
    pub blobs: *mut *mut u8,
    /// `blob_count` blob lengths.
    pub blob_lens: *mut usize,
    /// Number of blobs.
    pub blob_count: usize,
}

/// Opaque document handle.
pub struct WarraqDoc {
    doc: Document,
}

fn into_reply(r: Result<Reply, CoreError>) -> *mut WarraqReply {
    let (is_error, json, blobs) = match r {
        Ok(r) => (0, r.json.to_string(), r.blobs),
        Err(e) => (1, e.to_json().to_string(), Vec::new()),
    };
    // serde_json escapes NUL, so this cannot fail; fall back to a fixed error anyway.
    let json = CString::new(json)
        .unwrap_or_else(|_| CString::from(c"{\"code\":\"internal\",\"message\":\"nul\"}"));
    let json_len = json.as_bytes().len();
    let blob_count = blobs.len();
    let mut lens: Vec<usize> = Vec::with_capacity(blob_count);
    let mut ptrs: Vec<*mut u8> = Vec::with_capacity(blob_count);
    for b in blobs {
        lens.push(b.len());
        ptrs.push(Box::into_raw(b.into_boxed_slice()) as *mut u8);
    }
    Box::into_raw(Box::new(WarraqReply {
        is_error,
        json: json.into_raw(),
        json_len,
        blobs: Box::into_raw(ptrs.into_boxed_slice()) as *mut *mut u8,
        blob_lens: Box::into_raw(lens.into_boxed_slice()) as *mut usize,
        blob_count,
    }))
}

/// Read a NUL-terminated UTF-8 string; `None` for a null pointer.
///
/// # Safety
/// `p` must be null or point to a NUL-terminated string valid for the call.
unsafe fn read_str(p: *const c_char, what: &str) -> Result<Option<String>, CoreError> {
    if p.is_null() {
        return Ok(None);
    }
    // SAFETY: the caller guarantees `p` is a valid NUL-terminated string (checked non-null above).
    let s = unsafe { CStr::from_ptr(p) };
    s.to_str()
        .map(|s| Some(s.to_string()))
        .map_err(|_| CoreError::params(format!("{what} is not UTF-8")))
}

/// Copy `count` blobs described by pointer/length arrays.
///
/// # Safety
/// When `count > 0`, `ptrs` and `lens` must point to `count` elements, and each non-empty
/// blob pointer must be valid for reads of its length.
unsafe fn read_blobs(
    ptrs: *const *const u8,
    lens: *const usize,
    count: usize,
) -> Result<Vec<Vec<u8>>, CoreError> {
    if count == 0 {
        return Ok(Vec::new());
    }
    if ptrs.is_null() || lens.is_null() {
        return Err(CoreError::params("blob arrays are null"));
    }
    // SAFETY: non-null and, per the contract, valid for `count` elements.
    let (ps, ls) = unsafe {
        (
            std::slice::from_raw_parts(ptrs, count),
            std::slice::from_raw_parts(lens, count),
        )
    };
    let mut out = Vec::with_capacity(count);
    for (i, (p, l)) in ps.iter().zip(ls.iter()).enumerate() {
        if *l == 0 {
            out.push(Vec::new());
        } else if p.is_null() {
            return Err(CoreError::params(format!("blob {i} is null")));
        } else {
            // SAFETY: per the contract each non-empty blob is readable for `l` bytes.
            out.push(unsafe { std::slice::from_raw_parts(*p, *l) }.to_vec());
        }
    }
    Ok(out)
}

fn parse_params(s: Option<String>) -> Result<Value, CoreError> {
    match s {
        None => Ok(Value::Null),
        Some(s) if s.trim().is_empty() => Ok(Value::Null),
        Some(s) => serde_json::from_str(&s)
            .map_err(|e| CoreError::params(format!("params are not JSON: {e}"))),
    }
}

/// Open a document. Returns null on failure and, if `error_out` is non-null, stores an error
/// reply there (free it with `warraq_free_reply`).
///
/// # Safety
/// `bytes` must be valid for `len` bytes; `password` null or a NUL-terminated string;
/// `error_out` null or a valid pointer to write to.
#[no_mangle]
pub unsafe extern "C" fn warraq_open(
    bytes: *const u8,
    len: usize,
    password: *const c_char,
    error_out: *mut *mut WarraqReply,
) -> *mut WarraqDoc {
    let r = guarded(|| {
        if bytes.is_null() && len > 0 {
            return Err(CoreError::params("bytes is null"));
        }
        let data = if len == 0 {
            Vec::new()
        } else {
            // SAFETY: non-null and the caller guarantees `len` readable bytes.
            unsafe { std::slice::from_raw_parts(bytes, len) }.to_vec()
        };
        // SAFETY: forwarded caller contract for `password`.
        let pw = unsafe { read_str(password, "password") }?;
        Document::open(data, pw.as_deref())
    });
    match r {
        Ok(doc) => Box::into_raw(Box::new(WarraqDoc { doc })),
        Err(e) => {
            if !error_out.is_null() {
                // SAFETY: the caller guarantees `error_out` is writable when non-null.
                unsafe { *error_out = into_reply(Err(e)) };
            }
            std::ptr::null_mut()
        }
    }
}

/// Call a document method.
///
/// # Safety
/// `doc` must come from `warraq_open` and not be closed; `method` a NUL-terminated string;
/// `params_json` null or NUL-terminated; blob arrays as described in `read_blobs`.
#[no_mangle]
pub unsafe extern "C" fn warraq_call(
    doc: *mut WarraqDoc,
    method: *const c_char,
    params_json: *const c_char,
    blobs: *const *const u8,
    blob_lens: *const usize,
    blob_count: usize,
) -> *mut WarraqReply {
    into_reply(guarded(|| {
        if doc.is_null() {
            return Err(CoreError::params("document handle is null"));
        }
        // SAFETY: forwarded caller contracts for the strings and blob arrays.
        let (m, p, b) = unsafe {
            (
                read_str(method, "method")?,
                read_str(params_json, "params")?,
                read_blobs(blobs, blob_lens, blob_count)?,
            )
        };
        let m = m.ok_or_else(|| CoreError::params("method is null"))?;
        // SAFETY: non-null handle created by `warraq_open`, exclusively borrowed for this call.
        let d = unsafe { &mut *doc };
        d.doc.call(&m, &parse_params(p)?, b)
    }))
}

/// Call a static method.
///
/// # Safety
/// Same string and blob contracts as `warraq_call`.
#[no_mangle]
pub unsafe extern "C" fn warraq_call_static(
    method: *const c_char,
    params_json: *const c_char,
    blobs: *const *const u8,
    blob_lens: *const usize,
    blob_count: usize,
) -> *mut WarraqReply {
    into_reply(guarded(|| {
        // SAFETY: forwarded caller contracts for the strings and blob arrays.
        let (m, p, b) = unsafe {
            (
                read_str(method, "method")?,
                read_str(params_json, "params")?,
                read_blobs(blobs, blob_lens, blob_count)?,
            )
        };
        let m = m.ok_or_else(|| CoreError::params("method is null"))?;
        call_static(&m, &parse_params(p)?, b)
    }))
}

/// Release a reply.
///
/// # Safety
/// `reply` must be null or a pointer returned by this library, freed at most once.
#[no_mangle]
pub unsafe extern "C" fn warraq_free_reply(reply: *mut WarraqReply) {
    if reply.is_null() {
        return;
    }
    // SAFETY: allocated by `into_reply` via Box::into_raw and not freed before.
    let r = unsafe { Box::from_raw(reply) };
    // SAFETY: the arrays were created from boxed slices of exactly `blob_count` elements.
    let (ptrs, lens) = unsafe {
        (
            Box::from_raw(std::ptr::slice_from_raw_parts_mut(r.blobs, r.blob_count)),
            Box::from_raw(std::ptr::slice_from_raw_parts_mut(
                r.blob_lens,
                r.blob_count,
            )),
        )
    };
    for (p, l) in ptrs.iter().zip(lens.iter()) {
        // SAFETY: each blob was a boxed slice of length `l` leaked in `into_reply`.
        drop(unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(*p, *l)) });
    }
    if !r.json.is_null() {
        // SAFETY: created by CString::into_raw in `into_reply`.
        drop(unsafe { CString::from_raw(r.json) });
    }
}

/// Close a document.
///
/// # Safety
/// `doc` must be null or a handle from `warraq_open`, closed at most once.
#[no_mangle]
pub unsafe extern "C" fn warraq_close(doc: *mut WarraqDoc) {
    if !doc.is_null() {
        // SAFETY: created by Box::into_raw in `warraq_open` and not freed before.
        drop(unsafe { Box::from_raw(doc) });
    }
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
mod tests {
    use super::*;
    use warraq_pdf::builder::{sample_pdf, SampleOptions};

    fn json_of(r: *mut WarraqReply) -> (i32, serde_json::Value, Vec<Vec<u8>>) {
        // SAFETY (test): `r` comes from this library.
        unsafe {
            let rr = &*r;
            let s = CStr::from_ptr(rr.json).to_str().unwrap();
            assert_eq!(s.len(), rr.json_len);
            let v = serde_json::from_str(s).unwrap();
            let mut blobs = vec![];
            for i in 0..rr.blob_count {
                blobs.push(
                    std::slice::from_raw_parts(*rr.blobs.add(i), *rr.blob_lens.add(i)).to_vec(),
                );
            }
            let e = rr.is_error;
            warraq_free_reply(r);
            (e, v, blobs)
        }
    }

    #[test]
    fn open_call_close_round_trip() {
        let pdf = sample_pdf(2, &SampleOptions::default()).unwrap();
        unsafe {
            let mut err: *mut WarraqReply = std::ptr::null_mut();
            let doc = warraq_open(pdf.as_ptr(), pdf.len(), std::ptr::null(), &mut err);
            assert!(!doc.is_null());
            let (e, v, _) = json_of(warraq_call(
                doc,
                c"doc.info".as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                0,
            ));
            assert_eq!(e, 0);
            assert_eq!(v["pageCount"], 2);
            let (e, v, blobs) = json_of(warraq_call(
                doc,
                c"pages.rotate".as_ptr(),
                c"{\"pages\":[1],\"degrees\":90}".as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                0,
            ));
            assert_eq!(e, 0, "{v}");
            assert_eq!(&blobs[0][..pdf.len()], &pdf[..]);
            let (e, v, _) = json_of(warraq_call(
                doc,
                c"nope".as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                0,
            ));
            assert_eq!(e, 1);
            assert_eq!(v["code"], "unknown_method");
            warraq_close(doc);

            let ptrs = [pdf.as_ptr()];
            let lens = [pdf.len()];
            let (e, v, _) = json_of(warraq_call_static(
                c"pdf.isEncrypted".as_ptr(),
                c"{}".as_ptr(),
                ptrs.as_ptr(),
                lens.as_ptr(),
                1,
            ));
            assert_eq!(e, 0);
            assert_eq!(v["encrypted"], false);

            let bad = b"not a pdf";
            let doc = warraq_open(bad.as_ptr(), bad.len(), std::ptr::null(), &mut err);
            assert!(doc.is_null());
            let (e, v, _) = json_of(err);
            assert_eq!(e, 1);
            assert_eq!(v["code"], "parse_error");
            warraq_free_reply(std::ptr::null_mut());
            warraq_close(std::ptr::null_mut());
        }
    }

    #[test]
    fn header_declares_every_export() {
        let header = include_str!("../include/warraq.h");
        let src = include_str!("ffi.rs");
        let exports: Vec<&str> = src
            .lines()
            .filter_map(|l| l.trim().strip_prefix("pub unsafe extern \"C\" fn "))
            .map(|l| l.split('(').next().unwrap())
            .collect();
        assert_eq!(exports.len(), 5, "{exports:?}");
        for f in &exports {
            assert!(
                header.contains(&format!(" {f}(")) || header.contains(&format!("*{f}(")),
                "warraq.h is missing {f}"
            );
        }
        for field in [
            "is_error",
            "json",
            "json_len",
            "blobs",
            "blob_lens",
            "blob_count",
        ] {
            let declared =
                header.contains(&format!(" {field};")) || header.contains(&format!("*{field};"));
            assert!(declared, "WarraqReply.{field} missing in header");
        }
    }
}
