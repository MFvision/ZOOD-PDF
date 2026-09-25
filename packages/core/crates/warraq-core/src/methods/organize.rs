//! Organize / Combine / Compress methods beyond the basic `pages.*` set:
//!
//! * `pages.boxes` — MediaBox/CropBox/Rotate of every page (crop sheet, tests).
//! * `pages.insertImage` — a JPEG (passthrough) or PNG (Flate + SMask) as a new page.
//! * `pages.trimMargins` — CropBox = painted content box (+ margin); `dryRun` only measures.
//! * `pages.replace` — swap one page for a page of another PDF (one update).
//! * `pages.combine` — insert several PDFs (blobs) at a position, each under its own bookmark.
//! * `pages.split` — new documents (blobs) every N pages, by ranges, or by top-level bookmarks.
//! * `doc.compress` — a new, smaller file (whole rewrite; the open document is unchanged).
//!
//! Page indices are 0-based. Mutating methods commit one incremental update and return the
//! new file as `blobs[0]`.

use super::doc::commit_reply;
use super::{blob0, params};
use crate::ops::compress::{compress, Preset};
use crate::ops::geometry::page_geometry;
use crate::ops::image::picture_from_file;
use crate::registry::Registry;
use crate::{CoreError, Document, Reply};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use warraq_pdf::import::{assemble, import_pages, ImportOptions};
use warraq_pdf::lopdf::{Dictionary, Object, Stream};
use warraq_pdf::{outline, pages, Pdf};

/// Most parts one split may produce.
const MAX_PARTS: usize = 1000;

pub fn register(r: &mut Registry) {
    r.doc("pages.boxes", boxes)
        .doc("pages.insertImage", insert_image)
        .doc("pages.trimMargins", trim_margins)
        .doc("pages.replace", replace)
        .doc("pages.combine", combine)
        .doc("pages.split", split)
        .doc("doc.compress", doc_compress);
}

fn box_json(b: [f64; 4]) -> Value {
    json!([b[0], b[1], b[2], b[3]])
}

fn boxes(doc: &mut Document, _p: &Value, _b: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let list = pages::flatten(doc.pdf())?;
    let out: Vec<Value> = list
        .iter()
        .map(|p| {
            json!({
                "mediaBox": box_json(p.media_box),
                "cropBox": p.crop_box.map(box_json),
                "rotate": p.rotate,
            })
        })
        .collect();
    Ok(Reply::json(json!({ "pages": out })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InsertImage {
    at: usize,
    /// Page size in points; default: the page before `at` (or A4).
    width: Option<f64>,
    height: Option<f64>,
    /// White margin around the picture, in points (default 0).
    #[serde(default)]
    margin: f64,
}

fn insert_image(doc: &mut Document, p: &Value, blobs: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let p: InsertImage = params(p)?;
    let bytes = blob0(blobs, "a JPEG or PNG picture")?;
    let pic = picture_from_file(&bytes)?;
    let list = pages::flatten(doc.pdf())?;
    let neighbour = list
        .get(p.at.saturating_sub(1))
        .or(list.first())
        .map(|pg| pg.size());
    let (w, h) = match (p.width, p.height, neighbour) {
        (Some(w), Some(h), _) => (w, h),
        (None, None, Some(s)) => s,
        (None, None, None) => (595.276, 841.89),
        _ => return Err(CoreError::params("give both width and height, or neither")),
    };
    if !(1.0..=14_400.0).contains(&w) || !(1.0..=14_400.0).contains(&h) {
        return Err(CoreError::params("page size must be 1–14400 points"));
    }
    let margin = p.margin.clamp(0.0, (w.min(h) / 2.0 - 1.0).max(0.0));
    // Fit the picture inside the page (minus margins), centred, keeping its aspect ratio.
    let (aw, ah) = (w - 2.0 * margin, h - 2.0 * margin);
    let scale = (aw / f64::from(pic.width)).min(ah / f64::from(pic.height));
    let (iw, ih) = (f64::from(pic.width) * scale, f64::from(pic.height) * scale);
    let (x, y) = ((w - iw) / 2.0, (h - ih) / 2.0);

    let pdf = doc.pdf_mut();
    let mut image = pic.image;
    if let Some(mask) = pic.smask {
        let mid = pdf.add(Object::Stream(mask));
        image.dict.set("SMask", Object::Reference(mid));
    }
    let img_id = pdf.add(Object::Stream(image));
    let ops = format!("q {iw:.4} 0 0 {ih:.4} {x:.4} {y:.4} cm /Im0 Do Q\n");
    let content = crate::ops::image::deflate(ops.as_bytes(), 6)?;
    let mut cd = Dictionary::new();
    cd.set("Filter", Object::Name(b"FlateDecode".to_vec()));
    let content_id = pdf.add(Object::Stream(Stream::new(cd, content)));
    let mut xo = Dictionary::new();
    xo.set("Im0", Object::Reference(img_id));
    let mut res = Dictionary::new();
    res.set("XObject", Object::Dictionary(xo));
    let mut page = Dictionary::new();
    page.set(
        "MediaBox",
        Object::Array(vec![
            0.into(),
            0.into(),
            Object::Real(w as f32),
            Object::Real(h as f32),
        ]),
    );
    page.set("Resources", Object::Dictionary(res));
    page.set("Contents", Object::Reference(content_id));
    pages::insert_page_dict(pdf, p.at, page)?;
    let mut extra = Map::new();
    extra.insert("imageWidth".into(), json!(pic.width));
    extra.insert("imageHeight".into(), json!(pic.height));
    commit_reply(doc, extra)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Trim {
    pages: Vec<usize>,
    /// Space kept around the content, in points (default 0).
    #[serde(default)]
    margin: f64,
    /// Only measure: reply with the boxes, change nothing.
    #[serde(default)]
    dry_run: bool,
}

fn trim_margins(doc: &mut Document, p: &Value, _b: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let p: Trim = params(p)?;
    if !p.margin.is_finite() || p.margin < 0.0 || p.margin > 1000.0 {
        return Err(CoreError::params("margin must be 0–1000 points"));
    }
    let list = pages::flatten(doc.pdf())?;
    if p.pages.is_empty() {
        return Err(CoreError::params("no pages given"));
    }
    let mut out = Vec::with_capacity(p.pages.len());
    let mut changes: Vec<(usize, [f64; 4])> = Vec::new();
    for &i in &p.pages {
        let pg = list.get(i).ok_or_else(|| {
            CoreError::new("invalid_argument", format!("page {} does not exist", i + 1))
        })?;
        let vis = pg.visible_box();
        let geo = page_geometry(doc.pdf(), pg, true);
        let trimmed = geo.bbox.0.and_then(|[a, b, c, d]| {
            let m = p.margin;
            let bx = [
                (a - m).max(vis[0]),
                (b - m).max(vis[1]),
                (c + m).min(vis[2]),
                (d + m).min(vis[3]),
            ];
            (bx[2] - bx[0] >= 1.0 && bx[3] - bx[1] >= 1.0).then_some(bx)
        });
        out.push(trimmed.map(box_json).unwrap_or(Value::Null));
        if let Some(bx) = trimmed {
            changes.push((i, bx));
        }
    }
    let mut extra = Map::new();
    extra.insert("boxes".into(), Value::Array(out));
    if p.dry_run {
        return Ok(Reply::json(Value::Object(extra)));
    }
    if changes.is_empty() {
        return Err(CoreError::new(
            "nothing_to_trim",
            "the pages have no visible content",
        ));
    }
    for (i, bx) in changes {
        pages::crop(doc.pdf_mut(), &[i], bx)?;
    }
    commit_reply(doc, extra)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Replace {
    page: usize,
    /// Page of the other PDF (default 0).
    #[serde(default)]
    source_page: usize,
    password: Option<String>,
}

fn replace(doc: &mut Document, p: &Value, blobs: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let p: Replace = params(p)?;
    let src = Pdf::open(
        blob0(blobs, "the PDF with the new page")?,
        p.password.as_deref(),
    )?;
    let n = pages::count(doc.pdf())?;
    if p.page >= n {
        return Err(CoreError::new(
            "invalid_argument",
            format!("page {} does not exist", p.page + 1),
        ));
    }
    let opts = ImportOptions {
        outline: false,
        page_labels: false,
        ..ImportOptions::default()
    };
    import_pages(doc.pdf_mut(), &src, &[p.source_page], p.page, &opts)?;
    pages::delete(doc.pdf_mut(), &[p.page + 1])?;
    commit_reply(doc, Map::new())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CombineFile {
    /// Bookmark title for this file (usually its name); none = no bookmark.
    title: Option<String>,
    password: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Combine {
    /// Insert position (default: the end).
    at: Option<usize>,
    /// One entry per blob.
    #[serde(default)]
    files: Vec<CombineFile>,
}

fn combine(doc: &mut Document, p: &Value, blobs: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let p: Combine = params(p)?;
    if blobs.is_empty() {
        return Err(CoreError::params("blobs must hold the PDFs to combine"));
    }
    let mut at = p.at.unwrap_or(usize::MAX).min(pages::count(doc.pdf())?);
    let mut inserted = 0usize;
    for (i, bytes) in blobs.into_iter().enumerate() {
        let meta = p.files.get(i);
        let src = Pdf::open(bytes, meta.and_then(|m| m.password.as_deref()))
            .map_err(|e| CoreError::new(e.code(), format!("file {}: {e}", i + 1)))?;
        let n = pages::count(&src)?;
        let opts = ImportOptions {
            outline_title: meta.and_then(|m| m.title.clone()),
            ..ImportOptions::default()
        };
        import_pages(doc.pdf_mut(), &src, &(0..n).collect::<Vec<_>>(), at, &opts)?;
        at += n;
        inserted += n;
    }
    let mut extra = Map::new();
    extra.insert("inserted".into(), json!(inserted));
    commit_reply(doc, extra)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Split {
    /// A new file every `every` pages …
    every: Option<usize>,
    /// … or these inclusive 0-based ranges `[first, last]` …
    ranges: Option<Vec<[usize; 2]>>,
    /// … or one file per top-level bookmark.
    #[serde(default)]
    bookmarks: bool,
}

fn split(doc: &mut Document, p: &Value, _b: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let p: Split = params(p)?;
    let pdf = doc.pdf();
    let list = pages::flatten(pdf)?;
    let n = list.len();
    let mut parts: Vec<(Vec<usize>, Option<String>)> = Vec::new();
    match (p.every, p.ranges, p.bookmarks) {
        (Some(k), None, false) => {
            if k == 0 {
                return Err(CoreError::params("every must be at least 1"));
            }
            let mut s = 0;
            while s < n {
                parts.push(((s..(s + k).min(n)).collect(), None));
                s += k;
            }
        }
        (None, Some(ranges), false) => {
            for [a, b] in ranges {
                if a > b || b >= n {
                    return Err(CoreError::new(
                        "invalid_argument",
                        format!("range {}–{} is outside 1–{n}", a + 1, b + 1),
                    ));
                }
                parts.push(((a..=b).collect(), None));
            }
        }
        (None, None, true) => {
            let mut starts: Vec<(usize, String)> = outline::read_outline(pdf)?
                .iter()
                .filter_map(|it| {
                    let d = it.dest.as_ref()?;
                    let idx = list.iter().position(|pg| pg.id == d.page)?;
                    Some((idx, it.title_text()))
                })
                .collect();
            starts.sort_by_key(|(i, _)| *i);
            starts.dedup_by_key(|(i, _)| *i);
            if starts.is_empty() {
                return Err(CoreError::new(
                    "no_bookmarks",
                    "the document has no bookmarks to split by",
                ));
            }
            if starts.first().map(|(i, _)| *i > 0).unwrap_or(false) {
                starts.insert(0, (0, String::new()));
            }
            for (k, (s, title)) in starts.iter().enumerate() {
                let end = starts.get(k + 1).map(|(e, _)| *e).unwrap_or(n);
                parts.push((
                    (*s..end).collect(),
                    (!title.is_empty()).then(|| title.clone()),
                ));
            }
        }
        _ => {
            return Err(CoreError::params(
                "give exactly one of every, ranges or bookmarks",
            ))
        }
    }
    if parts.is_empty() || parts.len() > MAX_PARTS {
        return Err(CoreError::params(format!(
            "a split makes 1–{MAX_PARTS} files"
        )));
    }
    let mut blobs = Vec::with_capacity(parts.len());
    let mut info = Vec::with_capacity(parts.len());
    for (idx, title) in &parts {
        blobs.push(assemble(&[(pdf, idx.clone(), None)])?);
        info.push(json!({ "pages": idx, "title": title }));
    }
    Ok(Reply {
        json: json!({ "parts": info }),
        blobs,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompressParams {
    /// `high` | `balanced` | `smallest` (default balanced).
    preset: Option<String>,
}

fn doc_compress(doc: &mut Document, p: &Value, _b: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let p: CompressParams = params(p)?;
    let preset = match p.preset.as_deref() {
        None => Preset::Balanced,
        Some(s) => Preset::parse(s)
            .ok_or_else(|| CoreError::params("preset must be high, balanced or smallest"))?,
    };
    let (bytes, report) = compress(doc.pdf(), preset)?;
    Ok(Reply::with_blob(report, bytes))
}
