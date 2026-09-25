//! warraq-create — "Create PDF" for ZOOD PDF: an own layout engine and bounded readers.
//!
//! ```text
//! bytes ─▶ readers::detect/read ─▶ model::Document ─▶ layout::layout ─▶ pdf::write ─▶ PDF
//!          (DOCX, XLSX, PPTX,        (blocks, tables,    (UAX #14, bidi,     (subset fonts,
//!           HTML, Markdown, text,     lists, images,      harfrust, kashida,  ActualText,
//!           CSV, JPEG/PNG/TIFF)       fixed pages)        pagination)         tagged PDF)
//! ```
//!
//! The RPC surface is [`rpc_from_files`] (`create.fromFiles`, registered by warraq-core).

pub mod error;
pub mod fonts;
pub mod image;
pub mod layout;
pub mod limits;
pub mod model;
pub mod pdf;
pub mod readers;

use serde::Deserialize;
use serde_json::{json, Value};

pub use error::{CreateError, Result};
use model::{Content, Document, PageSetup, A4, LETTER};
use readers::{Format, ReadOptions};

/// Paper size choice.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PageSize {
    /// The source's own size when it has one (DOCX sections, slides, pictures), else A4.
    #[default]
    Auto,
    A4,
    Letter,
}

/// Orientation choice.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Orientation {
    #[default]
    Auto,
    Portrait,
    Landscape,
}

/// Margin preset.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Margins {
    #[default]
    Normal,
    Narrow,
    Wide,
}

impl Margins {
    fn points(self) -> f64 {
        match self {
            Margins::Normal => 72.0,
            Margins::Narrow => 36.0,
            Margins::Wide => 108.0,
        }
    }
}

/// One input file's description (`params.files[i]` for `blobs[i]`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileSpec {
    pub name: String,
    /// Optional explicit type (extension or MIME type).
    #[serde(default, rename = "type")]
    pub kind: Option<String>,
}

/// `create.fromFiles` parameters.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateOptions {
    #[serde(default)]
    pub files: Vec<FileSpec>,
    #[serde(default)]
    pub page_size: PageSize,
    #[serde(default)]
    pub orientation: Orientation,
    #[serde(default)]
    pub margins: Margins,
    /// One PDF for all files (default) or one per file.
    #[serde(default = "yes")]
    pub merge: bool,
    #[serde(default)]
    pub page_numbers: bool,
    /// UI locale (`ar` → Arabic page numbers and right-to-left neutral text).
    #[serde(default)]
    pub locale: Option<String>,
    /// Title of the merged PDF.
    #[serde(default)]
    pub title: Option<String>,
}

fn yes() -> bool {
    true
}

/// A created PDF.
#[derive(Debug, Clone)]
pub struct Created {
    pub name: String,
    pub bytes: Vec<u8>,
    pub page_count: usize,
}

fn setup_for(opts: &CreateOptions) -> PageSetup {
    let (w, h) = match opts.page_size {
        PageSize::Letter => LETTER,
        PageSize::A4 | PageSize::Auto => A4,
    };
    let s = PageSetup::with_size(w, h, opts.margins.points());
    match opts.orientation {
        Orientation::Landscape => s.oriented(true),
        Orientation::Portrait | Orientation::Auto => s,
    }
}

/// Apply the requested page setup to a document read from a file.
fn apply_setup(doc: &mut Document, opts: &CreateOptions, base: PageSetup) {
    for s in &mut doc.sections {
        if !matches!(s.content, Content::Flow(_)) {
            continue; // fixed pages (slides, pictures) keep their own size
        }
        if opts.page_size == PageSize::Auto && s.page_from_source {
            if opts.orientation != Orientation::Auto {
                s.page = s.page.oriented(opts.orientation == Orientation::Landscape);
            }
            continue;
        }
        let landscape_src = s.page.width > s.page.height;
        let mut p = base;
        p.margin_top = base.margin_top;
        if opts.orientation == Orientation::Auto && landscape_src {
            p = p.oriented(true);
        }
        s.page = p;
    }
}

fn pdf_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let stem = base.rsplit_once('.').map_or(base, |(a, _)| a);
    let stem = if stem.trim().is_empty() { "document" } else { stem };
    format!("{stem}.pdf")
}

/// Create PDF(s) from files.
pub fn create(files: &[(FileSpec, Vec<u8>)], opts: &CreateOptions) -> Result<Vec<Created>> {
    if files.is_empty() {
        return Err(CreateError::Params("no files to create a PDF from".into()));
    }
    limits::check(files.len(), limits::MAX_FILES, "files")?;
    let arabic = opts
        .locale
        .as_deref()
        .is_some_and(|l| l.to_ascii_lowercase().starts_with("ar"));
    let base = setup_for(opts);
    let ropts = ReadOptions {
        page: base,
        default_rtl: arabic,
        ..ReadOptions::default()
    };
    let mut docs = Vec::with_capacity(files.len());
    for (spec, bytes) in files {
        limits::check(bytes.len(), limits::MAX_INPUT_BYTES, "file size")?;
        let format = match spec.kind.as_deref().and_then(Format::from_hint) {
            Some(f) => {
                // A declared type still has to match the bytes for binary formats.
                let sniffed = readers::detect(&spec.name, bytes);
                match (f, sniffed) {
                    (Format::Text | Format::Markdown | Format::Csv | Format::Html, _) => f,
                    (_, Ok(s)) => s,
                    (_, Err(e)) => return Err(named(&spec.name, e)),
                }
            }
            None => readers::detect(&spec.name, bytes).map_err(|e| named(&spec.name, e))?,
        };
        let mut doc =
            readers::read(format, &spec.name, bytes, &ropts).map_err(|e| named(&spec.name, e))?;
        apply_setup(&mut doc, opts, base);
        docs.push((spec.name.clone(), doc));
    }
    let lopts = layout::Options {
        default_rtl: arabic,
        page_numbers: opts.page_numbers,
        arabic_numbers: arabic,
    };
    let render = |doc: &Document| -> Result<(Vec<u8>, usize)> {
        let l = layout::layout(doc, &lopts)?;
        let meta = pdf::Meta {
            title: doc.title.clone(),
            lang: doc
                .lang
                .clone()
                .or_else(|| Some(if arabic { "ar".into() } else { "en".into() })),
        };
        let n = l.pages.len();
        Ok((pdf::write(&l, doc, &meta)?, n))
    };
    if opts.merge && docs.len() > 1 {
        let mut all = Document::default();
        let first_name = docs.first().map(|d| d.0.clone()).unwrap_or_default();
        for (_, d) in docs {
            all.append(d);
        }
        if let Some(t) = &opts.title {
            all.title = Some(t.clone());
        }
        let (bytes, page_count) = render(&all)?;
        Ok(vec![Created {
            name: opts
                .title
                .as_deref()
                .map_or_else(|| pdf_name(&first_name), pdf_name),
            bytes,
            page_count,
        }])
    } else {
        let mut out = Vec::with_capacity(docs.len());
        for (name, d) in docs {
            let (bytes, page_count) = render(&d).map_err(|e| named(&name, e))?;
            out.push(Created {
                name: pdf_name(&name),
                bytes,
                page_count,
            });
        }
        Ok(out)
    }
}

fn named(name: &str, e: CreateError) -> CreateError {
    let prefix = |m: String| format!("{name}: {m}");
    match e {
        CreateError::Unsupported(m) => CreateError::Unsupported(prefix(m)),
        CreateError::Malformed(m) => CreateError::Malformed(prefix(m)),
        CreateError::Limit(m) => CreateError::Limit(prefix(m)),
        other => other,
    }
}

/// Supported file extensions (for the UI's picker).
pub const EXTENSIONS: &[&str] = &[
    "docx", "xlsx", "pptx", "html", "htm", "md", "markdown", "txt", "csv", "tsv", "jpg", "jpeg",
    "png", "tif", "tiff",
];

/// `create.fromFiles`: `params` = [`CreateOptions`], `blobs` = the files in order.
/// Reply JSON: `{ "documents": [{ "name", "pageCount", "byteLength" }] }`, blobs = the PDFs.
pub fn rpc_from_files(params: &Value, blobs: Vec<Vec<u8>>) -> Result<(Value, Vec<Vec<u8>>)> {
    let p = if params.is_null() {
        Value::Object(Default::default())
    } else {
        params.clone()
    };
    let opts: CreateOptions =
        serde_json::from_value(p).map_err(|e| CreateError::Params(e.to_string()))?;
    if opts.files.len() != blobs.len() {
        return Err(CreateError::Params(format!(
            "files ({}) and blobs ({}) must have the same length",
            opts.files.len(),
            blobs.len()
        )));
    }
    let files: Vec<(FileSpec, Vec<u8>)> = opts.files.iter().cloned().zip(blobs).collect();
    let made = create(&files, &opts)?;
    let docs: Vec<Value> = made
        .iter()
        .map(|c| json!({ "name": c.name, "pageCount": c.page_count, "byteLength": c.bytes.len() }))
        .collect();
    Ok((
        json!({ "documents": docs }),
        made.into_iter().map(|c| c.bytes).collect(),
    ))
}

/// `create.formats`: what the UI may offer in its file picker.
pub fn rpc_formats() -> Value {
    json!({ "extensions": EXTENSIONS })
}
