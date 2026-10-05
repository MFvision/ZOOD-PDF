//! The C ABI behind the iOS app, and any other host that links the core as a
//! static library: `warraq_open`, `warraq_call`, `warraq_call_static`,
//! `warraq_save` and the rest, mirroring `wasm.rs` function for function.
//! Built with the `ffi` feature; declared to C in `include/warraq_core.h`
//! (a test here keeps the two in step).
//!
//! The shape of every answer is one `WarraqReply`: a code (`WARRAQ_OK` or an
//! `WARRAQ_E_*`), JSON as a NUL-terminated string — on an error, the message
//! as `{"code":"E_PASSWORD","message":"…"}` — and bytes beside the JSON as
//! (pointer, length) buffers. `warraq_free` frees all of it at once. Bytes
//! and strings the caller passes in are only read for the duration of the
//! call and stay the caller's. A document handle from `warraq_open` is used
//! from one thread at a time (the Swift wrapper is an actor) and closed with
//! `warraq_close`.
//!
//! A panic inside the core is caught and answered as `WARRAQ_E_PANIC` rather
//! than taking the host process down: every PDF is hostile input. The build
//! for a phone uses the `ios` profile, which unwinds, so the catch works
//! there; under `panic = "abort"` it cannot.
use std::ffi::{c_char, CStr, CString};
use std::panic::{catch_unwind, AssertUnwindSafe};

use crate::{CoreError, Reply};

/// An answer worked: `json` is the result.
pub const WARRAQ_OK: i32 = 0;
/// Arguments that do not parse, a null pointer, or text that is not UTF-8.
pub const WARRAQ_E_ARGS: i32 = 1;
/// No tool operation of that name.
pub const WARRAQ_E_UNKNOWN_OP: i32 = 2;
/// Not a PDF, or one too damaged to read.
pub const WARRAQ_E_PARSE: i32 = 3;
/// Encrypted, and the password is missing or wrong.
pub const WARRAQ_E_PASSWORD: i32 = 4;
/// A page index past the last page.
pub const WARRAQ_E_PAGE: i32 = 5;
/// The page could not be drawn.
pub const WARRAQ_E_RENDER: i32 = 6;
/// A font that cannot be read or subset.
pub const WARRAQ_E_FONT: i32 = 7;
/// An edit that cannot be made as asked.
pub const WARRAQ_E_EDIT: i32 = 8;
/// Bytes that could not be written.
pub const WARRAQ_E_IO: i32 = 9;
/// A Library index that cannot be read.
pub const WARRAQ_E_INDEX: i32 = 10;
/// Signing or verifying failed (`E_P12_PASSWORD`, `E_TSA`, `E_SIGN`, …).
pub const WARRAQ_E_SIGN: i32 = 11;
/// The core panicked and was caught. The handle it was working on may be
/// left half-changed: close it and open the bytes again.
pub const WARRAQ_E_PANIC: i32 = 12;
/// Any other failure; the message says what.
pub const WARRAQ_E_OTHER: i32 = 13;

/// An open document. Opaque to C; one thread at a time.
pub struct WarraqDocument(crate::Document);

/// Bytes the caller lends to a call: `len` bytes at `ptr`.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct WarraqBlob {
    pub ptr: *const u8,
    pub len: usize,
}

/// Bytes the core hands back inside a reply, freed with the reply.
/// Empty bytes are a null `ptr` with `len` 0.
#[repr(C)]
pub struct WarraqBuffer {
    pub ptr: *mut u8,
    pub len: usize,
}

/// What every call answers. Free it with `warraq_free`, once.
#[repr(C)]
pub struct WarraqReply {
    /// `WARRAQ_OK`, or one of the `WARRAQ_E_*` codes.
    pub code: i32,
    /// NUL-terminated UTF-8 JSON: the answer, or on an error
    /// `{"code":"E_…","message":"…"}`. Never null.
    pub json: *mut c_char,
    /// `blob_count` buffers, or null when there are none.
    pub blobs: *mut WarraqBuffer,
    pub blob_count: usize,
}

/// The core's version, as a static C string: never freed.
#[no_mangle]
pub extern "C" fn warraq_version() -> *const c_char {
    static VERSION: &str = concat!(env!("CARGO_PKG_VERSION"), "\0");
    VERSION.as_ptr() as *const c_char
}

// ---- building and freeing replies ----------------------------------------

fn c_string(text: &str) -> *mut c_char {
    // JSON never carries a raw NUL (serde escapes control characters), so
    // this only guards text that reached here another way.
    let owned = match CString::new(text) {
        Ok(s) => s,
        Err(_) => CString::new(text.replace('\0', "\u{FFFD}")).unwrap_or_default(),
    };
    owned.into_raw()
}

fn buffer_out(bytes: Vec<u8>) -> WarraqBuffer {
    if bytes.is_empty() {
        return WarraqBuffer {
            ptr: std::ptr::null_mut(),
            len: 0,
        };
    }
    // A boxed slice has no spare capacity, so the pointer and length are
    // enough to free it again.
    let boxed: Box<[u8]> = bytes.into_boxed_slice();
    let len = boxed.len();
    WarraqBuffer {
        ptr: Box::into_raw(boxed) as *mut u8,
        len,
    }
}

fn reply_out(reply: Reply) -> WarraqReply {
    let count = reply.blobs.len();
    let blobs = if count == 0 {
        std::ptr::null_mut()
    } else {
        let buffers: Vec<WarraqBuffer> = reply.blobs.into_iter().map(buffer_out).collect();
        Box::into_raw(buffers.into_boxed_slice()) as *mut WarraqBuffer
    };
    WarraqReply {
        code: WARRAQ_OK,
        json: c_string(&reply.json),
        blobs,
        blob_count: count,
    }
}

fn json_out(value: &impl serde::Serialize) -> WarraqReply {
    match Reply::of(value) {
        Ok(reply) => reply_out(reply),
        Err(e) => error_out(&e),
    }
}

/// The stable code prefix of a message such as `E_PASSWORD: …`.
fn code_prefix(message: &str) -> &str {
    let end = message
        .find(|c: char| !(c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_'))
        .unwrap_or(message.len());
    &message[..end]
}

/// The numeric code of an error, from its variant and its `E_…` prefix.
fn code_of(error: &CoreError) -> i32 {
    match error {
        CoreError::Args(_) => WARRAQ_E_ARGS,
        CoreError::UnknownOp(_) => WARRAQ_E_UNKNOWN_OP,
        CoreError::Index(_) => WARRAQ_E_INDEX,
        CoreError::Sign(_) => WARRAQ_E_SIGN,
        // The reply's name, `E_OWN_FONT`, is what a host tells it by.
        CoreError::OwnFont => WARRAQ_E_FONT,
        CoreError::Pdf(_) | CoreError::Render(_) => match code_prefix(&error.to_string()) {
            "E_PARSE" => WARRAQ_E_PARSE,
            "E_PASSWORD" => WARRAQ_E_PASSWORD,
            "E_PAGE" => WARRAQ_E_PAGE,
            "E_RENDER" => WARRAQ_E_RENDER,
            "E_FONT" => WARRAQ_E_FONT,
            "E_EDIT" => WARRAQ_E_EDIT,
            "E_IO" => WARRAQ_E_IO,
            _ => WARRAQ_E_OTHER,
        },
    }
}

fn failure(code: i32, code_name: &str, message: &str) -> WarraqReply {
    let json = serde_json::json!({ "code": code_name, "message": message }).to_string();
    WarraqReply {
        code,
        json: c_string(&json),
        blobs: std::ptr::null_mut(),
        blob_count: 0,
    }
}

fn error_out(error: &CoreError) -> WarraqReply {
    let message = error.to_string();
    let code = code_of(error);
    let name = match code_prefix(&message) {
        "" => "E_OTHER",
        prefix => prefix,
    };
    failure(code, name, &message)
}

fn args_error(message: &str) -> WarraqReply {
    failure(WARRAQ_E_ARGS, "E_ARGS", &format!("E_ARGS: {message}"))
}

/// Runs the body, answering a panic as `WARRAQ_E_PANIC` instead of unwinding
/// into C, which is undefined behaviour.
fn guarded(body: impl FnOnce() -> WarraqReply) -> WarraqReply {
    match catch_unwind(AssertUnwindSafe(body)) {
        Ok(reply) => reply,
        Err(cause) => {
            let what = cause
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| cause.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_else(|| "unknown panic".into());
            failure(WARRAQ_E_PANIC, "E_PANIC", &format!("E_PANIC: {what}"))
        }
    }
}

/// Frees a reply and everything in it. Passing the same reply twice is
/// a double free, as in C.
///
/// # Safety
/// `reply` must have come from this library and not have been freed.
#[no_mangle]
pub unsafe extern "C" fn warraq_free(reply: WarraqReply) {
    if !reply.json.is_null() {
        drop(CString::from_raw(reply.json));
    }
    if !reply.blobs.is_null() {
        let buffers: Box<[WarraqBuffer]> = Box::from_raw(std::ptr::slice_from_raw_parts_mut(
            reply.blobs,
            reply.blob_count,
        ));
        for buffer in buffers.iter() {
            if !buffer.ptr.is_null() {
                drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(
                    buffer.ptr, buffer.len,
                )));
            }
        }
    }
}

// ---- reading what the caller passes --------------------------------------

/// # Safety
/// `text` is null or a NUL-terminated string.
unsafe fn str_in<'a>(text: *const c_char, what: &str) -> Result<&'a str, WarraqReply> {
    if text.is_null() {
        return Err(args_error(&format!("{what} is null")));
    }
    CStr::from_ptr(text)
        .to_str()
        .map_err(|_| args_error(&format!("{what} is not UTF-8")))
}

/// # Safety
/// `text` is null (allowed: no password) or a NUL-terminated string.
unsafe fn optional_str_in<'a>(text: *const c_char) -> Result<Option<&'a str>, WarraqReply> {
    if text.is_null() {
        Ok(None)
    } else {
        str_in(text, "password").map(Some)
    }
}

/// # Safety
/// `ptr` is null only when `len` is 0; otherwise `len` bytes are readable.
unsafe fn bytes_in<'a>(ptr: *const u8, len: usize, what: &str) -> Result<&'a [u8], WarraqReply> {
    if len == 0 {
        return Ok(&[]);
    }
    if ptr.is_null() {
        return Err(args_error(&format!("{what} is null")));
    }
    Ok(std::slice::from_raw_parts(ptr, len))
}

/// # Safety
/// `blobs` is null only when `count` is 0; otherwise it is `count` blobs,
/// each readable as `bytes_in` asks.
unsafe fn blobs_in(blobs: *const WarraqBlob, count: usize) -> Result<Vec<Vec<u8>>, WarraqReply> {
    if count == 0 {
        return Ok(Vec::new());
    }
    if blobs.is_null() {
        return Err(args_error("blobs is null"));
    }
    std::slice::from_raw_parts(blobs, count)
        .iter()
        .map(|b| bytes_in(b.ptr, b.len, "blob").map(<[u8]>::to_vec))
        .collect()
}

/// # Safety
/// `doc` is null or a handle from `warraq_open` not yet closed.
unsafe fn doc_in<'a>(doc: *mut WarraqDocument) -> Result<&'a mut crate::Document, WarraqReply> {
    if doc.is_null() {
        return Err(args_error("document is null"));
    }
    Ok(&mut (*doc).0)
}

macro_rules! try_reply {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(reply) => return reply,
        }
    };
}

// ---- the surface -----------------------------------------------------------

/// A tool operation that needs no open document, such as combining files.
///
/// # Safety
/// `op` and `args` are NUL-terminated strings (`args` may be null: no
/// arguments); `blobs` as `blobs_in` asks.
#[no_mangle]
pub unsafe extern "C" fn warraq_call_static(
    op: *const c_char,
    args: *const c_char,
    blobs: *const WarraqBlob,
    blob_count: usize,
) -> WarraqReply {
    let op = try_reply!(str_in(op, "op"));
    let args = try_reply!(optional_str_in(args)).unwrap_or("");
    let blobs = try_reply!(blobs_in(blobs, blob_count));
    guarded(|| match crate::call_static(op, args, blobs) {
        Ok(reply) => reply_out(reply),
        Err(e) => error_out(&e),
    })
}

/// Opens a PDF from its bytes. On `WARRAQ_OK`, `*out` is the handle and the
/// JSON is `{"pages":n}`; on an error `*out` is null.
///
/// # Safety
/// `bytes` as `bytes_in` asks; `password` null or NUL-terminated; `out`
/// a writable pointer.
#[no_mangle]
pub unsafe extern "C" fn warraq_open(
    bytes: *const u8,
    len: usize,
    password: *const c_char,
    out: *mut *mut WarraqDocument,
) -> WarraqReply {
    if out.is_null() {
        return args_error("out is null");
    }
    *out = std::ptr::null_mut();
    let bytes = try_reply!(bytes_in(bytes, len, "bytes"));
    let password = try_reply!(optional_str_in(password));
    guarded(|| match crate::Document::open(bytes.to_vec(), password) {
        Ok(doc) => {
            let pages = doc.page_count();
            *out = Box::into_raw(Box::new(WarraqDocument(doc)));
            json_out(&serde_json::json!({ "pages": pages }))
        }
        Err(e) => error_out(&e),
    })
}

/// Closes a handle from `warraq_open`. Null is ignored.
///
/// # Safety
/// `doc` is null or an open handle, closed once.
#[no_mangle]
pub unsafe extern "C" fn warraq_close(doc: *mut WarraqDocument) {
    if !doc.is_null() {
        drop(Box::from_raw(doc));
    }
}

/// The number of pages; 0 for a null handle.
///
/// # Safety
/// `doc` is null or an open handle.
#[no_mangle]
pub unsafe extern "C" fn warraq_page_count(doc: *const WarraqDocument) -> usize {
    if doc.is_null() {
        0
    } else {
        (*doc).0.page_count()
    }
}

/// `{"width":w,"height":h}` in points, after the page's own rotation.
///
/// # Safety
/// `doc` is an open handle.
#[no_mangle]
pub unsafe extern "C" fn warraq_page_size(doc: *mut WarraqDocument, index: usize) -> WarraqReply {
    let doc = try_reply!(doc_in(doc));
    guarded(|| match doc.page_size(index) {
        Ok((width, height)) => json_out(&serde_json::json!({ "width": width, "height": height })),
        Err(e) => error_out(&e),
    })
}

/// Draws a page: `{"width":px,"height":px}` and blob 0 the RGBA8 pixels,
/// premultiplied over white.
///
/// # Safety
/// `doc` is an open handle.
#[no_mangle]
pub unsafe extern "C" fn warraq_render_page(
    doc: *mut WarraqDocument,
    index: usize,
    scale: f32,
) -> WarraqReply {
    let doc = try_reply!(doc_in(doc));
    guarded(|| match doc.render_page(index, scale) {
        Ok(bitmap) => {
            match Reply::of(&serde_json::json!({ "width": bitmap.width, "height": bitmap.height }))
            {
                Ok(reply) => reply_out(reply.with_blob(bitmap.rgba)),
                Err(e) => error_out(&e),
            }
        }
        Err(e) => error_out(&e),
    })
}

/// `{"text":"…"}`: the page's text in logical order, lines joined by `\n`.
///
/// # Safety
/// `doc` is an open handle.
#[no_mangle]
pub unsafe extern "C" fn warraq_extract_text(
    doc: *mut WarraqDocument,
    index: usize,
) -> WarraqReply {
    let doc = try_reply!(doc_in(doc));
    guarded(|| match doc.extract_text(index) {
        Ok(text) => json_out(&serde_json::json!({ "text": text })),
        Err(e) => error_out(&e),
    })
}

fn direction_name(direction: warraq_text::Direction) -> &'static str {
    if direction == warraq_text::Direction::Rtl {
        "rtl"
    } else {
        "ltr"
    }
}

/// `{"lines":[{"text","x","y","width","height","direction"}]}`, for
/// selection and highlight overlays.
///
/// # Safety
/// `doc` is an open handle.
#[no_mangle]
pub unsafe extern "C" fn warraq_text_lines(doc: *mut WarraqDocument, index: usize) -> WarraqReply {
    let doc = try_reply!(doc_in(doc));
    guarded(|| match doc.text_lines(index) {
        Ok(lines) => {
            let lines: Vec<serde_json::Value> = lines
                .into_iter()
                .map(|l| {
                    serde_json::json!({
                        "text": l.text,
                        "x": l.x,
                        "y": l.y,
                        "width": l.width,
                        "height": l.height,
                        "direction": direction_name(l.direction),
                    })
                })
                .collect();
            json_out(&serde_json::json!({ "lines": lines }))
        }
        Err(e) => error_out(&e),
    })
}

/// `{"pages":[…]}`: the indices of the pages holding `query`, matched with
/// the core's Arabic-aware normalization.
///
/// # Safety
/// `doc` is an open handle; `query` a NUL-terminated string.
#[no_mangle]
pub unsafe extern "C" fn warraq_search(
    doc: *mut WarraqDocument,
    query: *const c_char,
) -> WarraqReply {
    let doc = try_reply!(doc_in(doc));
    let query = try_reply!(str_in(query, "query"));
    guarded(|| json_out(&serde_json::json!({ "pages": doc.search(query) })))
}

/// The document's metadata: `{"title","author","producer","creator","pages",
/// "encrypted","engine"}`.
///
/// # Safety
/// `doc` is an open handle.
#[no_mangle]
pub unsafe extern "C" fn warraq_metadata(doc: *mut WarraqDocument) -> WarraqReply {
    let doc = try_reply!(doc_in(doc));
    guarded(|| json_out(&doc.metadata()))
}

/// `{"paragraphs":[{"index","text","x","y","width","height","direction",
/// "alignment","fontSize","lineCount","fontFamily","fontWeight","fontItalic",
/// "fontClass","ownFont"}]}` in device space, for hit-testing. The font
/// fields are the face the file names for the paragraph (`fontFamily` empty
/// when it names none, `fontClass` "serif" | "sans" | "unknown") and whether
/// its own font can draw its text (`warraq_replace_paragraph` with no font).
///
/// # Safety
/// `doc` is an open handle.
#[no_mangle]
pub unsafe extern "C" fn warraq_paragraphs(doc: *mut WarraqDocument, index: usize) -> WarraqReply {
    use warraq_text::Alignment;
    let doc = try_reply!(doc_in(doc));
    guarded(|| {
        match doc
            .paragraphs(index)
            .and_then(|p| Ok((p, doc.paragraph_fonts(index)?)))
        {
            Ok((paragraphs, fonts)) => {
                let paragraphs: Vec<serde_json::Value> = paragraphs
                    .into_iter()
                    .zip(fonts)
                    .enumerate()
                    .map(|(i, (p, font))| {
                        serde_json::json!({
                            "index": i,
                            "text": p.text,
                            "x": p.bbox.0,
                            "y": p.bbox.1,
                            "width": p.bbox.2,
                            "height": p.bbox.3,
                            "direction": direction_name(p.direction),
                            "alignment": match p.alignment {
                                Alignment::Start => "start",
                                Alignment::End => "end",
                                Alignment::Center => "center",
                                Alignment::Justify => "justify",
                            },
                            "fontSize": p.font_size,
                            "lineCount": p.lines.len(),
                            "fontFamily": font.face.as_ref().map_or("", |f| f.family.as_str()),
                            "fontWeight": font.face.as_ref().map_or(400, |f| f.weight),
                            "fontItalic": font.face.as_ref().is_some_and(|f| f.italic),
                            "fontClass": font.face.as_ref().map_or("unknown", |f| f.class.as_str()),
                            "ownFont": font.own_font,
                        })
                    })
                    .collect();
                json_out(&serde_json::json!({ "paragraphs": paragraphs }))
            }
            Err(e) => error_out(&e),
        }
    })
}

/// Draws a new line of text at a point on the page (points from the
/// top-left corner; `x` is where the line starts) in the given font file.
///
/// # Safety
/// `doc` is an open handle; `text` NUL-terminated; `font` as `bytes_in` asks.
#[no_mangle]
pub unsafe extern "C" fn warraq_add_text(
    doc: *mut WarraqDocument,
    index: usize,
    x: f32,
    y: f32,
    size: f32,
    text: *const c_char,
    font: *const u8,
    font_len: usize,
) -> WarraqReply {
    let doc = try_reply!(doc_in(doc));
    let text = try_reply!(str_in(text, "text"));
    let font = try_reply!(bytes_in(font, font_len, "font"));
    guarded(|| match doc.add_text(index, x, y, size, text, font) {
        Ok(()) => json_out(&serde_json::json!({})),
        Err(e) => error_out(&e),
    })
}

/// `warraq_add_text` in a colour: `color` is `#rrggbb`, or null for the
/// page's own (black on nearly every page). Anything else is `E_ARGS`,
/// rather than a line quietly drawn in a colour nobody asked for.
///
/// # Safety
/// `doc` is an open handle; `text` and `color` NUL-terminated (`color` may be
/// null); `font` as `bytes_in` asks.
#[no_mangle]
pub unsafe extern "C" fn warraq_add_text_colored(
    doc: *mut WarraqDocument,
    index: usize,
    x: f32,
    y: f32,
    size: f32,
    text: *const c_char,
    color: *const c_char,
    font: *const u8,
    font_len: usize,
) -> WarraqReply {
    let doc = try_reply!(doc_in(doc));
    let text = try_reply!(str_in(text, "text"));
    let font = try_reply!(bytes_in(font, font_len, "font"));
    let rgb = if color.is_null() {
        None
    } else {
        let hex = try_reply!(str_in(color, "color"));
        match hex_rgb(hex) {
            Some(rgb) => Some(rgb),
            None => return args_error(&format!("{hex} is not a #rrggbb colour")),
        }
    };
    guarded(
        || match doc.add_text_in_color(index, x, y, size, text, font, rgb) {
            Ok(()) => json_out(&serde_json::json!({})),
            Err(e) => error_out(&e),
        },
    )
}

/// `#rrggbb` as RGB from 0 to 1; `None` for anything that is not one.
fn hex_rgb(hex: &str) -> Option<[f32; 3]> {
    let digits = hex.strip_prefix('#').filter(|h| h.len() == 6)?;
    let channel = |k: usize| {
        u8::from_str_radix(digits.get(k..k + 2)?, 16)
            .ok()
            .map(f32::from)
    };
    Some([
        channel(0)? / 255.0,
        channel(2)? / 255.0,
        channel(4)? / 255.0,
    ])
}

/// Replaces a paragraph with reflowed, shaped text; answers
/// `{"linesDrawn","fontSubstituted","shrunk","overflowed","fontSize"}`.
/// With no font (`font_len` 0) the paragraph is redrawn in its own font,
/// or the reply is the error `E_OWN_FONT` and nothing is changed.
///
/// # Safety
/// `doc` is an open handle; `text` NUL-terminated; `font` as `bytes_in` asks.
#[no_mangle]
pub unsafe extern "C" fn warraq_replace_paragraph(
    doc: *mut WarraqDocument,
    index: usize,
    paragraph: usize,
    text: *const c_char,
    font: *const u8,
    font_len: usize,
) -> WarraqReply {
    let doc = try_reply!(doc_in(doc));
    let text = try_reply!(str_in(text, "text"));
    let font = try_reply!(bytes_in(font, font_len, "font"));
    guarded(
        || match doc.replace_paragraph(index, paragraph, text, font) {
            Ok(r) => json_out(&serde_json::json!({
                "linesDrawn": r.lines_drawn,
                "fontSubstituted": r.font_substituted,
                "shrunk": r.shrunk,
                "overflowed": r.overflowed,
                "fontSize": r.font_size,
            })),
            Err(e) => error_out(&e),
        },
    )
}

/// The document's bytes as edited: blob 0, an incremental update on top of
/// the original wherever that is possible; JSON `{"bytes":n}`.
///
/// # Safety
/// `doc` is an open handle.
#[no_mangle]
pub unsafe extern "C" fn warraq_save(doc: *mut WarraqDocument) -> WarraqReply {
    let doc = try_reply!(doc_in(doc));
    guarded(|| match doc.save() {
        Ok(bytes) => match Reply::of(&serde_json::json!({ "bytes": bytes.len() })) {
            Ok(reply) => reply_out(reply.with_blob(bytes)),
            Err(e) => error_out(&e),
        },
        Err(e) => error_out(&e),
    })
}

/// One entry point for tool operations on an open document: `op` names it
/// ("pages.rotate"), `args` is JSON, `blobs` carries bytes.
///
/// # Safety
/// `doc` is an open handle; `op` NUL-terminated; `args` null or
/// NUL-terminated; `blobs` as `blobs_in` asks.
#[no_mangle]
pub unsafe extern "C" fn warraq_call(
    doc: *mut WarraqDocument,
    op: *const c_char,
    args: *const c_char,
    blobs: *const WarraqBlob,
    blob_count: usize,
) -> WarraqReply {
    let doc = try_reply!(doc_in(doc));
    let op = try_reply!(str_in(op, "op"));
    let args = try_reply!(optional_str_in(args)).unwrap_or("");
    let blobs = try_reply!(blobs_in(blobs, blob_count));
    guarded(|| match doc.call(op, args, blobs) {
        Ok(reply) => reply_out(reply),
        Err(e) => error_out(&e),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ptr;

    fn corpus(name: &str) -> Vec<u8> {
        std::fs::read(format!(
            "{}/../../../tests/corpus/arabic/generated/{name}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap()
    }

    /// Takes a reply the way a C caller would: copies the JSON out, checks
    /// the code, frees it.
    fn take(reply: WarraqReply) -> (i32, serde_json::Value, Vec<Vec<u8>>) {
        assert!(!reply.json.is_null(), "every reply carries JSON");
        let json: serde_json::Value =
            serde_json::from_str(unsafe { CStr::from_ptr(reply.json) }.to_str().unwrap()).unwrap();
        let blobs: Vec<Vec<u8>> = if reply.blobs.is_null() {
            assert_eq!(reply.blob_count, 0);
            vec![]
        } else {
            unsafe { std::slice::from_raw_parts(reply.blobs, reply.blob_count) }
                .iter()
                .map(|b| {
                    if b.ptr.is_null() {
                        assert_eq!(b.len, 0);
                        vec![]
                    } else {
                        unsafe { std::slice::from_raw_parts(b.ptr, b.len) }.to_vec()
                    }
                })
                .collect()
        };
        let code = reply.code;
        unsafe { warraq_free(reply) };
        (code, json, blobs)
    }

    fn ok(reply: WarraqReply) -> (serde_json::Value, Vec<Vec<u8>>) {
        let (code, json, blobs) = take(reply);
        assert_eq!(code, WARRAQ_OK, "{json}");
        (json, blobs)
    }

    fn failed(reply: WarraqReply) -> (i32, String, String) {
        let (code, json, blobs) = take(reply);
        assert_ne!(code, WARRAQ_OK);
        assert!(blobs.is_empty());
        (
            code,
            json["code"].as_str().unwrap().to_string(),
            json["message"].as_str().unwrap().to_string(),
        )
    }

    fn c(text: &str) -> CString {
        CString::new(text).unwrap()
    }

    fn open(bytes: &[u8], password: Option<&str>) -> Result<*mut WarraqDocument, (i32, String)> {
        let password = password.map(c);
        let mut handle: *mut WarraqDocument = ptr::null_mut();
        let reply = unsafe {
            warraq_open(
                bytes.as_ptr(),
                bytes.len(),
                password.as_ref().map_or(ptr::null(), |p| p.as_ptr()),
                &mut handle,
            )
        };
        if reply.code == WARRAQ_OK {
            let (json, _) = ok(reply);
            assert!(!handle.is_null());
            assert_eq!(json["pages"], unsafe { warraq_page_count(handle) });
            Ok(handle)
        } else {
            assert!(handle.is_null());
            let (code, name, _) = failed(reply);
            Err((code, name))
        }
    }

    #[test]
    fn version_is_the_crate_version() {
        let v = unsafe { CStr::from_ptr(warraq_version()) }
            .to_str()
            .unwrap();
        assert_eq!(v, crate::version());
    }

    #[test]
    fn opens_a_corpus_file_and_reads_its_arabic_in_logical_order() {
        let doc = open(&corpus("coretext-sfarabic-mixed-invoice.pdf"), None).unwrap();
        assert_eq!(unsafe { warraq_page_count(doc) }, 1);

        let (size, _) = ok(unsafe { warraq_page_size(doc, 0) });
        assert!(size["width"].as_f64().unwrap() > 100.0);

        let (text, _) = ok(unsafe { warraq_extract_text(doc, 0) });
        let text = text["text"].as_str().unwrap();
        assert!(text.contains("فاتورة ضريبية مبسطة"), "{text}");
        assert!(text.contains("شركة زود للتقنية"), "{text}");

        let (lines, _) = ok(unsafe { warraq_text_lines(doc, 0) });
        let lines = lines["lines"].as_array().unwrap();
        assert!(lines.len() > 5);
        assert!(lines.iter().any(|l| l["direction"] == "rtl"));
        assert!(lines[0]["height"].as_f64().unwrap() > 0.0);

        let query = c("الفاتوره"); // taa marbuta unified with haa
        let (hits, _) = ok(unsafe { warraq_search(doc, query.as_ptr()) });
        assert_eq!(hits["pages"], serde_json::json!([0]));

        let (meta, _) = ok(unsafe { warraq_metadata(doc) });
        assert_eq!(meta["pages"], 1);
        assert_eq!(meta["encrypted"], false);

        let (paragraphs, _) = ok(unsafe { warraq_paragraphs(doc, 0) });
        let first = &paragraphs["paragraphs"][0];
        assert_eq!(first["index"], 0);
        assert!(first["lineCount"].as_u64().unwrap() >= 1);
        // The face the file names, and that Arabic never reuses its font.
        assert_eq!(first["fontFamily"], "Geeza Pro");
        assert_eq!(first["fontWeight"], 400);
        assert_eq!(first["fontItalic"], false);
        assert_eq!(first["fontClass"], "sans");
        assert_eq!(first["ownFont"], false);

        let (picture, blobs) = ok(unsafe { warraq_render_page(doc, 0, 0.25) });
        let (w, h) = (
            picture["width"].as_u64().unwrap() as usize,
            picture["height"].as_u64().unwrap() as usize,
        );
        assert_eq!(blobs.len(), 1);
        assert_eq!(blobs[0].len(), w * h * 4, "RGBA8, {w}x{h}");

        unsafe { warraq_close(doc) };
    }

    #[test]
    fn a_call_edits_and_save_is_an_incremental_update() {
        let original = corpus("coretext-sfarabic-mixed-invoice.pdf");
        let doc = open(&original, None).unwrap();

        let op = c("pages.rotate");
        let args = c(r#"{"pages":[0],"quarterTurns":1}"#);
        let (shape, _) =
            ok(unsafe { warraq_call(doc, op.as_ptr(), args.as_ptr(), ptr::null(), 0) });
        assert_eq!(shape["pageCount"], 1);

        let (size, _) = ok(unsafe { warraq_page_size(doc, 0) });
        assert!(
            size["width"].as_f64().unwrap() > size["height"].as_f64().unwrap(),
            "turned on its side: {size}"
        );

        let (info, blobs) = ok(unsafe { warraq_save(doc) });
        let saved = &blobs[0];
        assert_eq!(info["bytes"], saved.len());
        assert!(saved.starts_with(&original), "the original bytes untouched");
        assert!(saved.len() > original.len(), "the edit appended");

        // The saved bytes open again, still turned.
        let again = open(saved, None).unwrap();
        let (size, _) = ok(unsafe { warraq_page_size(again, 0) });
        assert!(size["width"].as_f64().unwrap() > size["height"].as_f64().unwrap());
        unsafe { warraq_close(again) };
        unsafe { warraq_close(doc) };
    }

    #[test]
    fn a_static_call_takes_blobs_and_answers_bytes() {
        let a = corpus("coretext-sfarabic-mixed-invoice.pdf");
        let b = corpus("raw-amiri-cid-identity-tounicode.pdf");
        let blobs = [
            WarraqBlob {
                ptr: a.as_ptr(),
                len: a.len(),
            },
            WarraqBlob {
                ptr: b.as_ptr(),
                len: b.len(),
            },
        ];
        let op = c("pages.combine");
        let (json, out) =
            ok(unsafe { warraq_call_static(op.as_ptr(), ptr::null(), blobs.as_ptr(), 2) });
        assert_eq!(json["pageCount"], 2);
        assert_eq!(out.len(), 1);
        assert!(out[0].starts_with(b"%PDF"));
        let combined = open(&out[0], None).unwrap();
        assert_eq!(unsafe { warraq_page_count(combined) }, 2);
        unsafe { warraq_close(combined) };
    }

    #[test]
    fn errors_are_codes_with_their_names() {
        assert_eq!(
            open(b"not a pdf at all", None).unwrap_err(),
            (WARRAQ_E_PARSE, "E_PARSE".to_string())
        );
        assert_eq!(
            open(&corpus("variant-encrypted-rc4-40.pdf"), None).unwrap_err(),
            (WARRAQ_E_PASSWORD, "E_PASSWORD".to_string())
        );
        assert_eq!(
            open(&corpus("variant-encrypted-rc4-40.pdf"), Some("wrong")).unwrap_err(),
            (WARRAQ_E_PASSWORD, "E_PASSWORD".to_string())
        );
        let doc = open(&corpus("variant-encrypted-rc4-40.pdf"), Some("warraq")).unwrap();
        let (meta, _) = ok(unsafe { warraq_metadata(doc) });
        assert_eq!(meta["encrypted"], true);

        let (code, name, message) = failed(unsafe { warraq_extract_text(doc, 99) });
        assert_eq!((code, name.as_str()), (WARRAQ_E_PAGE, "E_PAGE"));
        assert!(message.contains("99"), "{message}");

        let op = c("nothing.here");
        let (code, name, _) =
            failed(unsafe { warraq_call(doc, op.as_ptr(), ptr::null(), ptr::null(), 0) });
        assert_eq!((code, name.as_str()), (WARRAQ_E_UNKNOWN_OP, "E_UNKNOWN_OP"));
        let (code, name, _) =
            failed(unsafe { warraq_call_static(op.as_ptr(), ptr::null(), ptr::null(), 0) });
        assert_eq!((code, name.as_str()), (WARRAQ_E_UNKNOWN_OP, "E_UNKNOWN_OP"));

        let op = c("pages.rotate");
        let args = c(r#"{"pages":"not a list"}"#);
        let (code, name, _) =
            failed(unsafe { warraq_call(doc, op.as_ptr(), args.as_ptr(), ptr::null(), 0) });
        assert_eq!((code, name.as_str()), (WARRAQ_E_ARGS, "E_ARGS"));
        unsafe { warraq_close(doc) };
    }

    #[test]
    fn null_and_bad_pointers_are_argument_errors_not_crashes() {
        let mut handle: *mut WarraqDocument = ptr::null_mut();
        let (code, _, _) =
            failed(unsafe { warraq_open(ptr::null(), 10, ptr::null(), &mut handle) });
        assert_eq!(code, WARRAQ_E_ARGS);
        let (code, _, _) =
            failed(unsafe { warraq_open(b"x".as_ptr(), 1, ptr::null(), ptr::null_mut()) });
        assert_eq!(code, WARRAQ_E_ARGS);
        assert_eq!(unsafe { warraq_page_count(ptr::null()) }, 0);
        let (code, _, _) = failed(unsafe { warraq_metadata(ptr::null_mut()) });
        assert_eq!(code, WARRAQ_E_ARGS);
        let (code, _, _) =
            failed(unsafe { warraq_call_static(ptr::null(), ptr::null(), ptr::null(), 0) });
        assert_eq!(code, WARRAQ_E_ARGS);

        let doc = open(&corpus("coretext-sfarabic-mixed-invoice.pdf"), None).unwrap();
        let (code, _, message) = failed(unsafe { warraq_search(doc, ptr::null()) });
        assert_eq!(code, WARRAQ_E_ARGS);
        assert!(message.contains("query"));
        let not_utf8 = [0xffu8, 0xfe, 0];
        let (code, _, message) =
            failed(unsafe { warraq_search(doc, not_utf8.as_ptr() as *const c_char) });
        assert_eq!(code, WARRAQ_E_ARGS);
        assert!(message.contains("UTF-8"));
        // A blob list with a count but no pointer.
        let op = c("pages.combine");
        let (code, _, _) =
            failed(unsafe { warraq_call_static(op.as_ptr(), ptr::null(), ptr::null(), 2) });
        assert_eq!(code, WARRAQ_E_ARGS);
        unsafe { warraq_close(doc) };
        unsafe { warraq_close(ptr::null_mut()) };
    }

    #[test]
    fn a_panic_in_the_core_is_answered_not_propagated() {
        let reply = guarded(|| panic!("hostile input did this"));
        let (code, name, message) = failed(reply);
        assert_eq!((code, name.as_str()), (WARRAQ_E_PANIC, "E_PANIC"));
        assert!(message.contains("hostile input did this"));
    }

    #[test]
    fn freeing_covers_empty_and_full_replies() {
        // Nothing but JSON.
        unsafe { warraq_free(json_out(&serde_json::json!({}))) };
        // Blobs, one of them empty.
        let reply = reply_out(Reply {
            json: "{}".into(),
            blobs: vec![vec![1, 2, 3], vec![], vec![4]],
        });
        assert_eq!(reply.blob_count, 3);
        let (_, blobs) = ok(reply);
        assert_eq!(blobs, vec![vec![1, 2, 3], vec![], vec![4]]);
        // A NUL inside text that is not JSON would otherwise cut the string.
        let raw = c_string("a\0b");
        let text = unsafe { CStr::from_ptr(raw) }.to_str().unwrap().to_string();
        assert_eq!(text, "a\u{FFFD}b");
        drop(unsafe { CString::from_raw(raw) });
    }

    #[test]
    fn the_c_header_declares_every_exported_function() {
        let source = include_str!("ffi.rs");
        let header = include_str!("../include/warraq_core.h");
        let exported = regex::Regex::new(r#"extern "C" fn (warraq_\w+)"#).unwrap();
        let names: Vec<&str> = exported
            .captures_iter(source)
            .map(|m| m.get(1).unwrap().as_str())
            .collect();
        assert!(names.len() >= 15, "{names:?}");
        for name in names {
            let declared = regex::Regex::new(&format!(r"\b{name}\s*\(")).unwrap();
            assert!(
                declared.is_match(header),
                "{name} is missing from warraq_core.h"
            );
        }
        for code in [
            ("WARRAQ_OK", WARRAQ_OK),
            ("WARRAQ_E_ARGS", WARRAQ_E_ARGS),
            ("WARRAQ_E_UNKNOWN_OP", WARRAQ_E_UNKNOWN_OP),
            ("WARRAQ_E_PARSE", WARRAQ_E_PARSE),
            ("WARRAQ_E_PASSWORD", WARRAQ_E_PASSWORD),
            ("WARRAQ_E_PAGE", WARRAQ_E_PAGE),
            ("WARRAQ_E_RENDER", WARRAQ_E_RENDER),
            ("WARRAQ_E_FONT", WARRAQ_E_FONT),
            ("WARRAQ_E_EDIT", WARRAQ_E_EDIT),
            ("WARRAQ_E_IO", WARRAQ_E_IO),
            ("WARRAQ_E_INDEX", WARRAQ_E_INDEX),
            ("WARRAQ_E_SIGN", WARRAQ_E_SIGN),
            ("WARRAQ_E_PANIC", WARRAQ_E_PANIC),
            ("WARRAQ_E_OTHER", WARRAQ_E_OTHER),
        ] {
            let line = format!("{} = {}", code.0, code.1);
            assert!(
                header.contains(&line),
                "{line} is missing from warraq_core.h"
            );
        }
    }
}
