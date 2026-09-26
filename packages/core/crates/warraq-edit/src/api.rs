//! JSON RPC surface of the Edit tool. warraq-core registers these names and commits mutating
//! calls as one incremental update. Page indices are 0-based; boxes are `[x0, y0, x1, y1]` in
//! points from the top-left corner of the page's visible box (y down), like `text.extract`.

use serde::Deserialize;
use serde_json::{json, Value};
use warraq_pdf::Pdf;

use crate::error::{EditError, Result};
use crate::fonts::Family;
use crate::geom::Rect;
use crate::layout::Align;
use crate::{images, links, text, url};

/// Document methods (`mutating` says whether the call changes the document).
pub const DOC_METHODS: &[(&str, bool)] = &[
    ("edit.textBlocks", false),
    ("edit.replaceText", true),
    ("edit.addText", true),
    ("edit.images", false),
    ("edit.imageTransform", true),
    ("edit.imageCrop", true),
    ("edit.imageReplace", true),
    ("edit.imageDelete", true),
    ("edit.imageAdd", true),
    ("edit.links", false),
    ("edit.linkAdd", true),
    ("edit.linkUpdate", true),
    ("edit.linkDelete", true),
];

/// Static methods.
pub const STATIC_METHODS: &[&str] = &["edit.checkUrl"];

fn p<T: for<'de> Deserialize<'de>>(v: &Value) -> Result<T> {
    let v = if v.is_null() { json!({}) } else { v.clone() };
    serde_json::from_value(v).map_err(|e| EditError::Params(e.to_string()))
}

fn rect(b: [f64; 4]) -> Result<Rect> {
    let r = Rect::from_array(b);
    if r.is_finite() {
        Ok(r)
    } else {
        Err(EditError::Params("box must be finite".into()))
    }
}

fn align(s: Option<&str>) -> Result<Option<Align>> {
    Ok(match s {
        None => None,
        Some("start") => Some(Align::Start),
        Some("end") => Some(Align::End),
        Some("center") => Some(Align::Center),
        Some(o) => return Err(EditError::Params(format!("unknown align {o:?}"))),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PageOnly {
    page: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReplaceText {
    page: usize,
    block: usize,
    text: String,
    expect: Option<String>,
    align: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AddText {
    page: usize,
    x: f64,
    y: f64,
    width: Option<f64>,
    text: String,
    size: Option<f64>,
    color: Option<String>,
    align: Option<String>,
    /// `auto` | `serif` | `sans`
    family: Option<String>,
    bold: Option<bool>,
    /// `auto` | `rtl` | `ltr`
    dir: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImageTransform {
    page: usize,
    image: usize,
    dx: Option<f64>,
    dy: Option<f64>,
    #[serde(rename = "box")]
    bbox: Option<[f64; 4]>,
    rotate: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImageBox {
    page: usize,
    image: usize,
    #[serde(rename = "box")]
    bbox: [f64; 4],
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImageRef {
    page: usize,
    image: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PageBox {
    page: usize,
    #[serde(rename = "box")]
    bbox: [f64; 4],
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LinkParams {
    page: usize,
    link: Option<usize>,
    #[serde(rename = "box")]
    bbox: Option<[f64; 4]>,
    uri: Option<String>,
    target_page: Option<usize>,
    confirm_host: Option<String>,
}

fn target(l: &LinkParams) -> Result<Option<links::Target>> {
    Ok(match (&l.uri, l.target_page) {
        (Some(u), None) => Some(links::Target::Uri(u.clone())),
        (None, Some(pg)) => Some(links::Target::Page(pg)),
        (None, None) => None,
        _ => return Err(EditError::Params("give either uri or targetPage".into())),
    })
}

fn blob0(blobs: &[Vec<u8>]) -> Result<&[u8]> {
    blobs
        .first()
        .map(Vec::as_slice)
        .ok_or_else(|| EditError::Params("blobs[0] must be a JPEG or PNG picture".into()))
}

/// Dispatch a document method. Returns `None` for unknown names.
pub fn call(
    pdf: &mut Pdf,
    method: &str,
    params: &Value,
    blobs: &[Vec<u8>],
) -> Option<Result<Value>> {
    run(pdf, method, params, blobs).transpose()
}

fn run(pdf: &mut Pdf, method: &str, params: &Value, blobs: &[Vec<u8>]) -> Result<Option<Value>> {
    Ok(Some(match method {
        "edit.textBlocks" => {
            let a: PageOnly = p(params)?;
            json!({ "blocks": text::blocks(pdf, a.page)? })
        }
        "edit.replaceText" => {
            let a: ReplaceText = p(params)?;
            let r = text::replace(
                pdf,
                a.page,
                a.block,
                &a.text,
                a.expect.as_deref(),
                align(a.align.as_deref())?,
            )?;
            json!({ "written": r })
        }
        "edit.addText" => {
            let a: AddText = p(params)?;
            let fill = match a.color.as_deref() {
                Some(c) => text::parse_colour(c)
                    .ok_or_else(|| EditError::Params("color must be #rrggbb".into()))?,
                None => [0.0; 3],
            };
            let first_arabic = a.text.chars().any(crate::fonts::is_arabic);
            let family = match a.family.as_deref() {
                None | Some("auto") => {
                    if first_arabic {
                        Family::Serif
                    } else {
                        Family::Sans
                    }
                }
                Some("serif") => Family::Serif,
                Some("sans") => Family::Sans,
                Some(o) => return Err(EditError::Params(format!("unknown family {o:?}"))),
            };
            let rtl = match a.dir.as_deref() {
                None | Some("auto") => None,
                Some("rtl") => Some(true),
                Some("ltr") => Some(false),
                Some(o) => return Err(EditError::Params(format!("unknown dir {o:?}"))),
            };
            let style = text::TextStyle {
                size: a.size.unwrap_or(14.0),
                line_height: None,
                align: align(a.align.as_deref())?.unwrap_or(Align::Start),
                rtl,
                family,
                bold: a.bold.unwrap_or(false),
                fill,
            };
            let r = text::add(
                pdf,
                a.page,
                a.x,
                a.y,
                a.width.unwrap_or(240.0),
                &a.text,
                &style,
            )?;
            json!({ "written": r })
        }
        "edit.images" => {
            let a: PageOnly = p(params)?;
            json!({ "images": images::list(pdf, a.page)? })
        }
        "edit.imageTransform" => {
            let a: ImageTransform = p(params)?;
            let t = images::Transform {
                dx: a.dx.unwrap_or(0.0),
                dy: a.dy.unwrap_or(0.0),
                bbox: a.bbox.map(rect).transpose()?,
                rotate: a.rotate.unwrap_or(0.0),
            };
            if ![t.dx, t.dy, t.rotate].iter().all(|v| v.is_finite()) {
                return Err(EditError::Params("non-finite transform".into()));
            }
            json!({ "image": images::transform(pdf, a.page, a.image, &t)? })
        }
        "edit.imageCrop" => {
            let a: ImageBox = p(params)?;
            json!({ "image": images::crop(pdf, a.page, a.image, rect(a.bbox)?)? })
        }
        "edit.imageReplace" => {
            let a: ImageRef = p(params)?;
            json!({ "image": images::replace(pdf, a.page, a.image, blob0(blobs)?)? })
        }
        "edit.imageDelete" => {
            let a: ImageRef = p(params)?;
            images::delete(pdf, a.page, a.image)?;
            json!({})
        }
        "edit.imageAdd" => {
            let a: PageBox = p(params)?;
            json!({ "image": images::add(pdf, a.page, rect(a.bbox)?, blob0(blobs)?)? })
        }
        "edit.links" => {
            let a: PageOnly = p(params)?;
            json!({ "links": links::list(pdf, a.page)? })
        }
        "edit.linkAdd" => {
            let a: LinkParams = p(params)?;
            let t = target(&a)?
                .ok_or_else(|| EditError::Params("uri or targetPage is required".into()))?;
            let b = rect(
                a.bbox
                    .ok_or_else(|| EditError::Params("box is required".into()))?,
            )?;
            links::add(pdf, a.page, b, &t, a.confirm_host.as_deref())?;
            json!({})
        }
        "edit.linkUpdate" => {
            let a: LinkParams = p(params)?;
            let id = a
                .link
                .ok_or_else(|| EditError::Params("link is required".into()))?;
            let t = target(&a)?;
            links::update(
                pdf,
                a.page,
                id,
                a.bbox.map(rect).transpose()?,
                t.as_ref(),
                a.confirm_host.as_deref(),
            )?;
            json!({})
        }
        "edit.linkDelete" => {
            let a: LinkParams = p(params)?;
            let id = a
                .link
                .ok_or_else(|| EditError::Params("link is required".into()))?;
            links::delete(pdf, a.page, id)?;
            json!({})
        }
        _ => return Ok(None),
    }))
}

/// Dispatch a static method.
pub fn call_static(method: &str, params: &Value) -> Option<Result<Value>> {
    match method {
        "edit.checkUrl" => Some((|| {
            let u = params
                .get("url")
                .and_then(Value::as_str)
                .ok_or_else(|| EditError::Params("url (string) is required".into()))?;
            serde_json::to_value(url::check(u)).map_err(|e| EditError::Params(e.to_string()))
        })()),
        _ => None,
    }
}
