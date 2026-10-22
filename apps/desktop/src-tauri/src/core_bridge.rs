//! Native core bridge: `warraq-core` behind Tauri commands.
//!
//! The commands mirror `packages/core/API.md` one for one, so the desktop host
//! and the browser hosts speak the same API: `packages/ui/src/core/client.ts`
//! either posts to the WASM worker or invokes these commands through
//! `host-tauri.ts`. The difference is the rasterizer — natively linked PDFium
//! here, pure-Rust hayro in the browser (ADR-0003, narrowed by ADR-0006).
//!
//! **Threading.** `warraq_core::Document` owns a `Box<dyn RenderDoc>`, a trait
//! object declared without a `Send` bound, so `Mutex<HashMap<u32, Document>>`
//! is not `Sync` and cannot be Tauri managed state (`.manage()` wants
//! `Send + Sync`). The registry is therefore owned by one dedicated core
//! thread and reached through a job channel: documents never cross a thread
//! boundary, calls run in arrival order, and the commands are `(async)` so a
//! long parse or render never blocks the window's event loop.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;

use serde::Serialize;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager, Runtime, State};
use warraq_core::Document;
use warraq_render::Bitmap;
use warraq_text::Direction;

/// Engine names, identical to the strings `warraq_core::Metadata::engine` uses.
const PDFIUM_ENGINE: &str = "pdfium+hayro";
const HAYRO_ENGINE: &str = "hayro";

/// Marker in `warraq_render`'s error when the dynamic library cannot be bound.
const PDFIUM_MISSING: &str = "PDFium library not found";

#[cfg(target_os = "macos")]
const PDFIUM_LIB_FILE: &str = "libpdfium.dylib";
#[cfg(target_os = "windows")]
const PDFIUM_LIB_FILE: &str = "pdfium.dll";
#[cfg(all(unix, not(target_os = "macos")))]
const PDFIUM_LIB_FILE: &str = "libpdfium.so";

/// Header carrying the open password, hex-encoded UTF-8: HTTP header values
/// are ASCII-only, and Arabic passwords must survive the trip.
const PASSWORD_HEADER: &str = "x-warraq-password-hex";

/// Headers of `core_call`: the tool operation, and the open document's handle
/// (absent for an operation that needs none, such as combining files).
const OP_HEADER: &str = "x-warraq-op";
const HANDLE_HEADER: &str = "x-warraq-handle";

/* ------------------------------------------------------------------ registry */

/// Open documents by handle. Owned by the core thread; see the module note.
#[derive(Default)]
pub struct Registry {
    documents: HashMap<u32, Document>,
    next_handle: u32,
}

impl Registry {
    /// `Document.open(bytes, password?)`; returns the handle the UI keeps.
    pub fn open(&mut self, bytes: Vec<u8>, password: Option<&str>) -> Result<u32, String> {
        let document = Document::open(bytes, password).map_err(|e| e.to_string())?;
        self.next_handle += 1;
        let handle = self.next_handle;
        self.documents.insert(handle, document);
        Ok(handle)
    }

    pub fn get(&self, handle: u32) -> Result<&Document, String> {
        self.documents
            .get(&handle)
            .ok_or_else(|| format!("E_NOT_FOUND: document {handle} is not open"))
    }

    pub fn get_mut(&mut self, handle: u32) -> Result<&mut Document, String> {
        self.documents
            .get_mut(&handle)
            .ok_or_else(|| format!("E_NOT_FOUND: document {handle} is not open"))
    }

    /// Dropping the document frees the PDFium and hayro state behind it.
    pub fn close(&mut self, handle: u32) -> bool {
        self.documents.remove(&handle).is_some()
    }

    pub fn len(&self) -> usize {
        self.documents.len()
    }

    pub fn is_empty(&self) -> bool {
        self.documents.is_empty()
    }
}

/// A unit of work for the core thread.
type Job = Box<dyn FnOnce(&mut Registry) + Send + 'static>;

/// Managed state: the handle on the core thread plus the engine it really got.
pub struct CoreBridge {
    jobs: Mutex<Sender<Job>>,
    engine: &'static str,
}

impl CoreBridge {
    /// Starts the core thread. `PDFIUM_LIB_DIR` must already be set, because
    /// `warraq_render` binds the library once and caches the result.
    pub fn start() -> Self {
        let (sender, receiver) = channel::<Job>();
        std::thread::Builder::new()
            .name("warraq-core".into())
            .stack_size(8 * 1024 * 1024)
            .spawn(move || {
                let mut registry = Registry::default();
                while let Ok(job) = receiver.recv() {
                    job(&mut registry);
                }
            })
            .expect("warraq: cannot start the core thread");
        Self {
            jobs: Mutex::new(sender),
            engine: detect_engine(),
        }
    }

    /// `"pdfium+hayro"` when the PDFium library was bound, `"hayro"` when the
    /// core fell back to the pure-Rust rasterizer.
    pub fn engine(&self) -> &'static str {
        self.engine
    }

    /// Runs `job` on the core thread and waits for its value.
    fn call<T: Send + 'static>(
        &self,
        job: impl FnOnce(&mut Registry) -> T + Send + 'static,
    ) -> Result<T, String> {
        let (reply, answer) = channel::<Result<T, String>>();
        {
            let jobs = self.jobs.lock().unwrap_or_else(|e| e.into_inner());
            jobs.send(Box::new(move |registry| {
                // A panic inside one job (a malformed PDF tripping a bug in
                // the core) answers that call with an error instead of taking
                // the core thread, and with it every open document, down.
                let value = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    job(registry)
                }))
                .map_err(|_| "E_CORE: internal error".to_string());
                let _ = reply.send(value);
            }))
            .map_err(|_| "E_CORE: the core thread is gone".to_string())?;
        }
        answer
            .recv()
            .map_err(|_| "E_CORE: the core thread stopped while answering".to_string())?
    }

    /// `call` for the common "look the document up, then read it" shape.
    fn with_document<T: Send + 'static>(
        &self,
        handle: u32,
        job: impl FnOnce(&Document) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        self.call(move |registry| registry.get(handle).and_then(job))?
    }

    fn with_document_mut<T: Send + 'static>(
        &self,
        handle: u32,
        job: impl FnOnce(&mut Document) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        self.call(move |registry| registry.get_mut(handle).and_then(job))?
    }
}

/* ------------------------------------------------- shapes crossing to the UI */

/// JSON twin of `warraq_text::TextLine`, matching `TextLineData` in the UI.
#[derive(Debug, Clone, Serialize)]
pub struct TextLineDto {
    pub text: String,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub direction: &'static str,
}

pub fn text_lines(document: &Document, index: usize) -> Result<Vec<TextLineDto>, String> {
    Ok(document
        .text_lines(index)
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|line| TextLineDto {
            text: line.text,
            x: line.x,
            y: line.y,
            width: line.width,
            height: line.height,
            direction: match line.direction {
                Direction::Rtl => "rtl",
                Direction::Ltr => "ltr",
            },
        })
        .collect())
}

/// `width` u32 LE + `height` u32 LE + RGBA8. Pixels travel as a raw IPC body:
/// JSON-encoding a 2000x2800 page would be ~60 MB of digits and commas.
pub fn encode_bitmap(bitmap: &Bitmap) -> Vec<u8> {
    let mut out = Vec::with_capacity(8 + bitmap.rgba.len());
    out.extend_from_slice(&bitmap.width.to_le_bytes());
    out.extend_from_slice(&bitmap.height.to_le_bytes());
    out.extend_from_slice(&bitmap.rgba);
    out
}

/// The body of `core_call`, both ways, as one frame: a u32 LE length and the
/// JSON, a u32 LE count of blobs, then each blob as a u32 LE length and its
/// bytes. PDFs travel as raw bytes, never as JSON arrays of numbers.
pub fn encode_frame(json: &str, blobs: &[Vec<u8>]) -> Vec<u8> {
    let size = 8 + json.len() + blobs.iter().map(|b| 4 + b.len()).sum::<usize>();
    let mut out = Vec::with_capacity(size);
    out.extend_from_slice(&(json.len() as u32).to_le_bytes());
    out.extend_from_slice(json.as_bytes());
    out.extend_from_slice(&(blobs.len() as u32).to_le_bytes());
    for blob in blobs {
        out.extend_from_slice(&(blob.len() as u32).to_le_bytes());
        out.extend_from_slice(blob);
    }
    out
}

pub fn decode_frame(bytes: &[u8]) -> Result<(String, Vec<Vec<u8>>), String> {
    fn take<'a>(bytes: &'a [u8], at: &mut usize, n: usize) -> Result<&'a [u8], String> {
        let end = at
            .checked_add(n)
            .filter(|&end| end <= bytes.len())
            .ok_or("E_ARGS: the request frame is cut short")?;
        let slice = &bytes[*at..end];
        *at = end;
        Ok(slice)
    }
    fn length(bytes: &[u8], at: &mut usize) -> Result<usize, String> {
        let raw = take(bytes, at, 4)?;
        Ok(u32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]) as usize)
    }
    let mut at = 0;
    let json_len = length(bytes, &mut at)?;
    let json = std::str::from_utf8(take(bytes, &mut at, json_len)?)
        .map_err(|_| "E_ARGS: the request's JSON is not UTF-8")?
        .to_string();
    let count = length(bytes, &mut at)?;
    let mut blobs = Vec::with_capacity(count.min(64));
    for _ in 0..count {
        let n = length(bytes, &mut at)?;
        blobs.push(take(bytes, &mut at, n)?.to_vec());
    }
    Ok((json, blobs))
}

/// `metadata(): string` from `API.md`, with `engine` corrected to the engine
/// actually in use (the core's own field is a compile-time `cfg!`).
pub fn metadata_json(document: &Document, engine: &str) -> Result<String, String> {
    let mut value = serde_json::to_value(document.metadata()).map_err(|e| e.to_string())?;
    if let Some(object) = value.as_object_mut() {
        object.insert("engine".into(), serde_json::Value::String(engine.into()));
    }
    serde_json::to_string(&value).map_err(|e| e.to_string())
}

/* --------------------------------------------------- PDFium library location */

/// Smallest valid one-page PDF, built with correct xref offsets, used to ask
/// `warraq_render` whether the PDFium backend is usable at all.
fn probe_pdf() -> Vec<u8> {
    const OBJECTS: [&str; 4] = [
        "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
        "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
        "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> /Contents 4 0 R >>\nendobj\n",
        "4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n",
    ];
    let mut out: Vec<u8> = b"%PDF-1.7\n%\xE2\xE3\xCF\xD3\n".to_vec();
    let mut offsets = Vec::with_capacity(OBJECTS.len());
    for object in OBJECTS {
        offsets.push(out.len());
        out.extend_from_slice(object.as_bytes());
    }
    let startxref = out.len();
    let size = OBJECTS.len() + 1;
    out.extend_from_slice(format!("xref\n0 {size}\n0000000000 65535 f \n").as_bytes());
    for offset in &offsets {
        out.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    out.extend_from_slice(
        format!("trailer\n<< /Size {size} /Root 1 0 R >>\nstartxref\n{startxref}\n%%EOF\n")
            .as_bytes(),
    );
    out
}

/// Which rasterizer the core will really use. `warraq_render::open` silently
/// degrades to hayro when the dynamic library is missing; this reproduces that
/// decision once so `core_engine()` can report the truth instead of the
/// compile-time feature flag.
pub fn detect_engine() -> &'static str {
    match warraq_render::pdfium_backend::PdfiumDoc::open(probe_pdf(), None) {
        Ok(_) => PDFIUM_ENGINE,
        // Bound, but unhappy with the probe file: PDFium is still there.
        Err(e) if !e.to_string().contains(PDFIUM_MISSING) => PDFIUM_ENGINE,
        Err(_) => HAYRO_ENGINE,
    }
}

fn has_library(dir: &Path) -> bool {
    dir.join(PDFIUM_LIB_FILE).is_file()
}

/// Bundled first (`bundle.resources` in `tauri.conf.json`), then — in a debug
/// build only — the copy in the source tree and the session's tools directory,
/// so `tauri dev` works before anything has been bundled.
pub fn locate_pdfium<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(resources) = app.path().resource_dir() {
        candidates.push(resources.join("resources").join("pdfium"));
        candidates.push(resources.join("pdfium"));
        candidates.push(resources);
    }
    #[cfg(debug_assertions)]
    {
        candidates.push(PathBuf::from(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/resources/pdfium"
        )));
        candidates.push(PathBuf::from(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../.tools/pdfium/mac/lib"
        )));
    }
    candidates.into_iter().find(|dir| has_library(dir))
}

/// Points `warraq_render` at the bundled PDFium and starts the core thread.
/// An existing `PDFIUM_LIB_DIR` wins, so a developer can test another build.
pub fn setup<R: Runtime>(app: &AppHandle<R>) -> CoreBridge {
    if std::env::var_os("PDFIUM_LIB_DIR").is_none() {
        match locate_pdfium(app) {
            Some(dir) => std::env::set_var("PDFIUM_LIB_DIR", &dir),
            None => eprintln!(
                "warraq: no {PDFIUM_LIB_FILE} found next to the app; \
                 falling back to the pure-Rust renderer"
            ),
        }
    }
    CoreBridge::start()
}

/* ------------------------------------------------------------------ commands */

/// Prints what the UI asked the core to do, when `WARRAQ_DEBUG` is set.
///
/// The desktop shell cannot be watched the way the web build can — there is no
/// console to read — so this is how a maintainer without a screen confirms
/// that a document really reached the core and really came back as pixels.
/// Local stdout only: nothing is written to disk and nothing leaves the
/// machine, which is the same rule as everywhere else in Warraq.
pub fn debug_log(message: impl std::fmt::Display) {
    if std::env::var_os("WARRAQ_DEBUG").is_some() {
        println!("warraq: {message}");
    }
}

/// Hex-decodes the password header back into a `String`.
fn decode_password(hex: &str) -> Option<String> {
    if !hex.len().is_multiple_of(2) {
        return None;
    }
    let bytes: Option<Vec<u8>> = (0..hex.len() / 2)
        .map(|i| u8::from_str_radix(hex.get(i * 2..i * 2 + 2)?, 16).ok())
        .collect();
    String::from_utf8(bytes?).ok()
}

/// The password a request carries in its header, if any (`doc_open`, `print_pdf`).
pub(crate) fn password_from(request: &Request<'_>) -> Option<String> {
    request
        .headers()
        .get(PASSWORD_HEADER)
        .and_then(|value| value.to_str().ok())
        .and_then(decode_password)
}

/// `Document.open(bytes, password?)`. The PDF arrives as the raw request body
/// (an `ArrayBuffer` on the JS side), never as a JSON array of numbers.
#[tauri::command(async)]
pub fn doc_open(bridge: State<'_, CoreBridge>, request: Request<'_>) -> Result<u32, String> {
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes.clone(),
        InvokeBody::Json(_) => {
            return Err("E_PARSE: doc_open expects the PDF bytes as the raw request body".into())
        }
    };
    let password = password_from(&request);
    let size = bytes.len();
    let handle = bridge.call(move |registry| registry.open(bytes, password.as_deref()))??;
    let pages = bridge
        .with_document(handle, |document| Ok(document.page_count()))
        .unwrap_or(0);
    debug_log(format!("opened #{handle}, {size} bytes, {pages} page(s)"));
    Ok(handle)
}

#[tauri::command(async)]
pub fn doc_close(bridge: State<'_, CoreBridge>, handle: u32) -> Result<bool, String> {
    bridge.call(move |registry| registry.close(handle))
}

#[tauri::command(async)]
pub fn doc_page_count(bridge: State<'_, CoreBridge>, handle: u32) -> Result<u32, String> {
    bridge.with_document(handle, |document| Ok(document.page_count() as u32))
}

#[tauri::command(async)]
pub fn doc_page_size(
    bridge: State<'_, CoreBridge>,
    handle: u32,
    index: u32,
) -> Result<[f32; 2], String> {
    bridge.with_document(handle, move |document| {
        document
            .page_size(index as usize)
            .map(|(w, h)| [w, h])
            .map_err(|e| e.to_string())
    })
}

/// RGBA8 page bitmap as a raw IPC body: see [`encode_bitmap`].
#[tauri::command(async)]
pub fn doc_render_page(
    bridge: State<'_, CoreBridge>,
    handle: u32,
    index: u32,
    scale: f32,
) -> Result<Response, String> {
    let body = bridge.with_document(handle, move |document| {
        document
            .render_page(index as usize, scale)
            .map(|bitmap| encode_bitmap(&bitmap))
            .map_err(|e| e.to_string())
    })?;
    debug_log(format!(
        "rendered #{handle} page {index} at {scale}x, {} bytes",
        body.len()
    ));
    Ok(Response::new(body))
}

#[tauri::command(async)]
pub fn doc_extract_text(
    bridge: State<'_, CoreBridge>,
    handle: u32,
    index: u32,
) -> Result<String, String> {
    bridge.with_document(handle, move |document| {
        document
            .extract_text(index as usize)
            .map_err(|e| e.to_string())
    })
}

#[tauri::command(async)]
pub fn doc_text_lines(
    bridge: State<'_, CoreBridge>,
    handle: u32,
    index: u32,
) -> Result<Vec<TextLineDto>, String> {
    bridge.with_document(handle, move |document| text_lines(document, index as usize))
}

#[tauri::command(async)]
pub fn doc_search(
    bridge: State<'_, CoreBridge>,
    handle: u32,
    query: String,
) -> Result<Vec<u32>, String> {
    bridge.with_document(handle, move |document| {
        Ok(document
            .search(&query)
            .into_iter()
            .map(|i| i as u32)
            .collect())
    })
}

#[tauri::command(async)]
pub fn doc_metadata(bridge: State<'_, CoreBridge>, handle: u32) -> Result<String, String> {
    let engine = bridge.engine();
    bridge.with_document(handle, move |document| metadata_json(document, engine))
}

/// One entry point for tool operations (`warraq-core/src/tools`). The op and
/// the handle come as headers, the arguments and any bytes as one raw frame
/// ([`encode_frame`]), and the answer goes back the same way.
#[tauri::command(async)]
pub fn core_call(bridge: State<'_, CoreBridge>, request: Request<'_>) -> Result<Response, String> {
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string)
    };
    let op = header(OP_HEADER).ok_or("E_ARGS: core_call needs the x-warraq-op header")?;
    let handle = match header(HANDLE_HEADER) {
        Some(text) => Some(
            text.parse::<u32>()
                .map_err(|_| "E_ARGS: x-warraq-handle is not a number")?,
        ),
        None => None,
    };
    let (args, blobs) = match request.body() {
        InvokeBody::Raw(bytes) => decode_frame(bytes)?,
        InvokeBody::Json(_) => return Err("E_ARGS: core_call expects a raw frame".into()),
    };
    let label = op.clone();
    let reply = match handle {
        Some(handle) => bridge.with_document_mut(handle, move |document| {
            document.call(&op, &args, blobs).map_err(|e| e.to_string())
        })?,
        None => bridge.call(move |_| {
            warraq_core::call_static(&op, &args, blobs).map_err(|e| e.to_string())
        })??,
    };
    debug_log(format!(
        "{label} on {}: {} blob(s) back",
        handle.map_or("no document".into(), |h| format!("#{h}")),
        reply.blobs.len()
    ));
    Ok(Response::new(encode_frame(&reply.json, &reply.blobs)))
}

/// The rasterizer actually in use, shown in the UI's status bar.
#[tauri::command]
pub fn core_engine(bridge: State<'_, CoreBridge>) -> String {
    debug_log("the UI asked which engine it got");
    bridge.engine().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_frame_round_trips_json_and_blobs() {
        let blobs = vec![b"%PDF-1.7 one".to_vec(), Vec::new(), vec![0u8, 255, 7]];
        let frame = encode_frame(r#"{"pages":[1]}"#, &blobs);
        assert_eq!(
            decode_frame(&frame).unwrap(),
            (r#"{"pages":[1]}"#.to_string(), blobs)
        );
        assert_eq!(
            decode_frame(&encode_frame("", &[])).unwrap(),
            (String::new(), vec![])
        );
    }

    #[test]
    fn a_short_frame_is_refused_not_read_past() {
        let frame = encode_frame("{}", &[vec![1, 2, 3]]);
        for cut in 0..frame.len() {
            assert!(decode_frame(&frame[..cut]).is_err(), "cut at {cut}");
        }
        let mut lying = encode_frame("{}", &[]);
        lying[6..10].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(decode_frame(&lying).is_err());
    }

    #[test]
    fn probe_pdf_is_a_readable_one_page_document() {
        let bytes = probe_pdf();
        assert!(bytes.starts_with(b"%PDF-1.7"));
        assert!(bytes.ends_with(b"%%EOF\n"));
    }

    #[test]
    fn password_header_round_trips_arabic() {
        let hex = "d8b3d8b1"; // "سر" in UTF-8
        assert_eq!(decode_password(hex).as_deref(), Some("سر"));
        assert_eq!(decode_password("zz"), None);
        assert_eq!(decode_password("abc"), None);
    }

    #[test]
    fn bitmap_header_is_little_endian_width_then_height() {
        let bitmap = Bitmap {
            width: 2,
            height: 1,
            rgba: vec![1, 2, 3, 4, 5, 6, 7, 8],
        };
        let encoded = encode_bitmap(&bitmap);
        assert_eq!(&encoded[0..4], &2u32.to_le_bytes());
        assert_eq!(&encoded[4..8], &1u32.to_le_bytes());
        assert_eq!(encoded.len(), 8 + 8);
    }
}

/* --------------------------------------------------------- editing commands */

/// JSON twin of `warraq_text::Paragraph`, matching `ParagraphData` in the UI,
/// which is camelCase on the JavaScript side.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParagraphDto {
    pub index: usize,
    pub text: String,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub direction: &'static str,
    pub alignment: &'static str,
    pub font_size: f32,
    pub line_count: usize,
    /// The face the file names for the paragraph: its family (sanitised;
    /// empty when none), weight, slant and "serif" | "sans" | "unknown".
    pub font_family: String,
    pub font_weight: u16,
    pub font_italic: bool,
    pub font_class: &'static str,
    /// Whether the paragraph's own font can draw the text it has now.
    pub own_font: bool,
}

#[tauri::command(async)]
pub fn doc_paragraphs(
    bridge: State<'_, CoreBridge>,
    handle: u32,
    index: u32,
) -> Result<Vec<ParagraphDto>, String> {
    bridge.with_document(handle, move |document| {
        let paragraphs = document
            .paragraphs(index as usize)
            .map_err(|e| e.to_string())?;
        let fonts = document
            .paragraph_fonts(index as usize)
            .map_err(|e| e.to_string())?;
        Ok(paragraphs
            .into_iter()
            .zip(fonts)
            .enumerate()
            .map(|(i, (p, font))| ParagraphDto {
                index: i,
                text: p.text,
                x: p.bbox.0,
                y: p.bbox.1,
                width: p.bbox.2,
                height: p.bbox.3,
                direction: if p.direction == warraq_text::Direction::Rtl {
                    "rtl"
                } else {
                    "ltr"
                },
                alignment: match p.alignment {
                    warraq_text::Alignment::Start => "start",
                    warraq_text::Alignment::End => "end",
                    warraq_text::Alignment::Center => "center",
                    warraq_text::Alignment::Justify => "justify",
                },
                font_size: p.font_size,
                line_count: p.lines.len(),
                font_family: font
                    .face
                    .as_ref()
                    .map(|f| f.family.clone())
                    .unwrap_or_default(),
                font_weight: font.face.as_ref().map_or(400, |f| f.weight),
                font_italic: font.face.as_ref().is_some_and(|f| f.italic),
                font_class: font.face.as_ref().map_or("unknown", |f| f.class.as_str()),
                own_font: font.own_font,
            })
            .collect())
    })
}

#[tauri::command(async)]
pub fn doc_replace_paragraph(
    bridge: State<'_, CoreBridge>,
    handle: u32,
    index: u32,
    para: u32,
    text: String,
    font: Vec<u8>,
) -> Result<String, String> {
    bridge.with_document_mut(handle, move |document| {
        let r = document
            .replace_paragraph(index as usize, para as usize, &text, &font)
            .map_err(|e| e.to_string())?;
        serde_json::to_string(&r).map_err(|e| e.to_string())
    })
}

/// `Document.add_text(page, x, y, size, text, font)`.
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn doc_add_text(
    bridge: State<'_, CoreBridge>,
    handle: u32,
    index: u32,
    x: f32,
    y: f32,
    size: f32,
    text: String,
    font: Vec<u8>,
) -> Result<(), String> {
    bridge.with_document_mut(handle, move |document| {
        document
            .add_text(index as usize, x, y, size, &text, &font)
            .map_err(|e| e.to_string())
    })
}

/// Saved bytes travel as a raw IPC body, like rendered pixels: JSON would
/// balloon a megabyte-scale PDF into an array of numbers.
#[tauri::command(async)]
pub fn doc_save(
    bridge: State<'_, CoreBridge>,
    handle: u32,
) -> Result<tauri::ipc::Response, String> {
    let bytes = bridge.with_document_mut(handle, move |document| {
        document.save().map_err(|e| e.to_string())
    })?;
    Ok(tauri::ipc::Response::new(bytes))
}
