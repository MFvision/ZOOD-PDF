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
        let (reply, answer) = channel::<T>();
        {
            let jobs = self
                .jobs
                .lock()
                .map_err(|_| "E_CORE: the core thread queue is poisoned".to_string())?;
            jobs.send(Box::new(move |registry| {
                let _ = reply.send(job(registry));
            }))
            .map_err(|_| "E_CORE: the core thread is gone".to_string())?;
        }
        answer
            .recv()
            .map_err(|_| "E_CORE: the core thread stopped while answering".to_string())
    }

    /// `call` for the common "look the document up, then read it" shape.
    fn with_document<T: Send + 'static>(
        &self,
        handle: u32,
        job: impl FnOnce(&Document) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        self.call(move |registry| registry.get(handle).and_then(job))?
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
            "/../../../../tools/pdfium/mac/lib"
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

/// Hex-decodes the password header back into a `String`.
fn decode_password(hex: &str) -> Option<String> {
    if hex.len() % 2 != 0 {
        return None;
    }
    let bytes: Option<Vec<u8>> = (0..hex.len() / 2)
        .map(|i| u8::from_str_radix(hex.get(i * 2..i * 2 + 2)?, 16).ok())
        .collect();
    String::from_utf8(bytes?).ok()
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
    let password = request
        .headers()
        .get(PASSWORD_HEADER)
        .and_then(|value| value.to_str().ok())
        .and_then(decode_password);
    bridge.call(move |registry| registry.open(bytes, password.as_deref()))?
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
        Ok(document.search(&query).into_iter().map(|i| i as u32).collect())
    })
}

#[tauri::command(async)]
pub fn doc_metadata(bridge: State<'_, CoreBridge>, handle: u32) -> Result<String, String> {
    let engine = bridge.engine();
    bridge.with_document(handle, move |document| metadata_json(document, engine))
}

/// The rasterizer actually in use, shown in the UI's status bar.
#[tauri::command]
pub fn core_engine(bridge: State<'_, CoreBridge>) -> String {
    bridge.engine().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

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
