//! Edit PDF, links: list a page's links with where they go, and add, move,
//! re-point and remove them (`warraq_pdf::links`). On the open document;
//! `list` is also static, to read a saved file.
use serde::Deserialize;
use warraq_pdf::{LinkInfo, LinkTarget, PdfDocument};

use super::{args, Reply};
use crate::{CoreError, Document};

/// Where a link goes, as the interface says it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct To {
    #[serde(default)]
    uri: Option<String>,
    /// 0-based.
    #[serde(default)]
    page: Option<usize>,
}

impl To {
    fn target(&self) -> Result<LinkTarget, CoreError> {
        match (&self.uri, self.page) {
            (Some(uri), None) => Ok(LinkTarget::Uri(uri.clone())),
            (None, Some(page)) => Ok(LinkTarget::Page(page)),
            _ => Err(CoreError::Args(
                "a link goes to an address or to a page".into(),
            )),
        }
    }
}

#[derive(Deserialize)]
struct Link {
    page: usize,
    #[serde(default)]
    id: Option<String>,
    /// `[x, y, width, height]` on the page as shown.
    #[serde(default)]
    rect: Option<[f32; 4]>,
    #[serde(default)]
    to: Option<To>,
}

#[derive(Deserialize)]
struct Saved {
    #[serde(default)]
    password: Option<String>,
    page: usize,
}

fn json(links: Vec<LinkInfo>) -> serde_json::Value {
    let links: Vec<serde_json::Value> = links
        .into_iter()
        .map(|l| {
            let to = match l.target {
                LinkTarget::Uri(uri) => serde_json::json!({ "uri": uri }),
                LinkTarget::Page(page) => serde_json::json!({ "page": page }),
                LinkTarget::Other => serde_json::json!({}),
            };
            serde_json::json!({ "id": l.id, "rect": l.rect, "to": to })
        })
        .collect();
    serde_json::json!({ "links": links })
}

fn id(a: &Link) -> Result<&str, CoreError> {
    a.id.as_deref()
        .ok_or_else(|| CoreError::Args("which link?".into()))
}

pub fn call(
    doc: &mut Document,
    name: &str,
    json_args: &str,
    _blobs: Vec<Vec<u8>>,
) -> Result<Reply, CoreError> {
    let a: Link = args(json_args)?;
    match name {
        "list" => {}
        "add" => {
            let rect = a
                .rect
                .ok_or_else(|| CoreError::Args("links.add takes a rect".into()))?;
            let to =
                a.to.as_ref()
                    .ok_or_else(|| CoreError::Args("links.add takes where to".into()))?;
            let id = doc.pdf_mut().add_link(a.page, rect, &to.target()?)?;
            doc.refresh_after_edit()?;
            let mut reply = json(doc.pdf_mut().list_links(a.page)?);
            reply["id"] = serde_json::Value::String(id);
            return Reply::of(&reply);
        }
        "update" => {
            let target = a.to.as_ref().map(To::target).transpose()?;
            doc.pdf_mut()
                .update_link(a.page, id(&a)?, a.rect, target.as_ref())?;
            doc.refresh_after_edit()?;
        }
        "remove" => {
            doc.pdf_mut().remove_link(a.page, id(&a)?)?;
            doc.refresh_after_edit()?;
        }
        _ => return Err(CoreError::UnknownOp(format!("links.{name}"))),
    }
    Reply::of(&json(doc.pdf_mut().list_links(a.page)?))
}

pub fn call_static(name: &str, json_args: &str, blobs: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    match name {
        "list" => {
            let a: Saved = args(json_args)?;
            let pdf = blobs
                .into_iter()
                .next()
                .ok_or_else(|| CoreError::Args("links.list takes the PDF".into()))?;
            let doc = PdfDocument::open(pdf, a.password.as_deref())?;
            Reply::of(&json(doc.list_links(a.page)?))
        }
        _ => Err(CoreError::UnknownOp(format!("links.{name}"))),
    }
}
