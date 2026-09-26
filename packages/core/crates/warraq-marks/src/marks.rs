//! Adding, listing, updating and removing ZOOD marks (see [`crate::store`] for the storage).

use std::collections::BTreeMap;

use lopdf::ObjectId;
use serde::Serialize;
use serde_json::Value;
use warraq_edit::images::{decode_picture, embed_picture};
use warraq_pdf::{pages, Pdf};

use crate::draw::{draw, picture_ref, PictureRef, Target};
use crate::error::{MarkError, Result};
use crate::model::MarkSpec;
use crate::store::{self, classify, Item};

/// A ZOOD mark found in the document.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Listed {
    pub id: String,
    /// The stored model (as given when the mark was added), `null` if unreadable.
    pub spec: Value,
    /// Pages (0-based) the mark is on now.
    pub pages: Vec<usize>,
}

fn marks_on(pdf: &Pdf, page_id: ObjectId) -> Vec<ObjectId> {
    store::contents_ro(pdf, page_id)
        .iter()
        .filter_map(|o| match classify(pdf, o) {
            Item::Mark(i) => Some(i),
            _ => None,
        })
        .collect()
}

/// Info objects of one mark, the pages carrying it and its stored info.
type Entry = (Vec<ObjectId>, Vec<usize>, Option<store::Info>);

/// Info objects per mark id, with the pages carrying them.
fn index(pdf: &Pdf) -> Result<BTreeMap<String, Entry>> {
    let list = pages::flatten(pdf)?;
    let mut by: BTreeMap<String, Entry> = BTreeMap::new();
    for (i, p) in list.iter().enumerate() {
        for info in marks_on(pdf, p.id) {
            let Some(inf) = store::read_info(pdf, info) else {
                continue;
            };
            let e = by.entry(inf.id.clone()).or_default();
            if !e.0.contains(&info) {
                e.0.push(info);
            }
            if e.1.last() != Some(&i) {
                e.1.push(i);
            }
            if e.2.is_none() {
                e.2 = Some(inf);
            }
        }
    }
    Ok(by)
}

/// ZOOD marks of the document.
pub fn list(pdf: &Pdf) -> Result<Vec<Listed>> {
    let by = index(pdf)?;
    Ok(by
        .into_iter()
        .map(|(id, (_, pages, info))| Listed {
            id,
            spec: info
                .and_then(|i| serde_json::from_str(&i.spec).ok())
                .unwrap_or(Value::Null),
            pages,
        })
        .collect())
}

fn new_id(pdf: &Pdf, spec: &str, taken: &[String]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in spec
        .bytes()
        .chain(pdf.next_number().to_le_bytes())
        .chain((pdf.bytes().len() as u64).to_le_bytes())
    {
        h = (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3);
    }
    for n in 0u64..1000 {
        let id = format!("zm{:012x}", (h.wrapping_add(n)) & 0xffff_ffff_ffff);
        if !taken.contains(&id) {
            return id;
        }
    }
    format!("zm{h:016x}")
}

/// Result of an add/update.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Added {
    pub id: String,
    pub pages: Vec<usize>,
}

/// Add `spec` (a picture watermark takes `picture`, or `keep_picture` when updating).
/// `only`: draw on these pages only (previews) while tokens still count every marked page.
pub fn add(
    pdf: &mut Pdf,
    spec: &MarkSpec,
    picture: Option<&[u8]>,
    only: Option<&[usize]>,
    id: Option<String>,
    keep_picture: Option<ObjectId>,
) -> Result<Added> {
    spec.validate()?;
    let list = pages::flatten(pdf)?;
    let n = list.len();
    let mut selected: Vec<usize> = match &spec.pages {
        Some(p) => {
            if let Some(bad) = p.iter().find(|i| **i >= n) {
                return Err(MarkError::PageOutOfRange(*bad));
            }
            p.clone()
        }
        None => (0..n).collect(),
    };
    selected.sort_unstable();
    selected.dedup();
    if selected.is_empty() {
        return Err(MarkError::Params("no pages to mark".into()));
    }
    let pic: Option<PictureRef> = if spec.picture {
        let obj = match (picture, keep_picture) {
            (Some(b), _) if !b.is_empty() => embed_picture(pdf, &decode_picture(b)?)?,
            (_, Some(k)) => k,
            _ => {
                return Err(MarkError::Params(
                    "a picture watermark needs a JPEG or PNG".into(),
                ))
            }
        };
        Some(picture_ref(pdf, obj).ok_or_else(|| MarkError::Params("unreadable picture".into()))?)
    } else {
        None
    };
    let spec_json = serde_json::to_string(spec).map_err(|e| MarkError::Params(e.to_string()))?;
    let id = match id {
        Some(i) => i,
        None => {
            let taken: Vec<String> = list_ids(pdf)?;
            new_id(pdf, &spec_json, &taken)
        }
    };
    let info = store::new_info(pdf, &id, &spec_json, pic.map(|p| p.id));
    let targets: Vec<Target> = selected
        .iter()
        .enumerate()
        .filter(|(_, p)| only.is_none_or(|o| o.contains(p)))
        .filter_map(|(ordinal, p)| {
            list.get(*p).map(|info| Target {
                index: *p,
                ordinal,
                info: info.clone(),
            })
        })
        .collect();
    let drawn: Vec<usize> = targets.iter().map(|t| t.index).collect();
    draw(pdf, spec, &id, info, pic, &targets, n)?;
    Ok(Added { id, pages: drawn })
}

fn list_ids(pdf: &Pdf) -> Result<Vec<String>> {
    Ok(list(pdf)?.into_iter().map(|l| l.id).collect())
}

/// Remove the mark `id`. Returns the pages it was on and its picture (for updates).
pub fn remove(pdf: &mut Pdf, id: &str) -> Result<(Vec<usize>, Option<ObjectId>)> {
    let mut by = index(pdf)?;
    let (infos, pages_on, info) = by
        .remove(id)
        .ok_or_else(|| MarkError::NotFound(id.to_string()))?;
    let list = pages::flatten(pdf)?;
    for p in &pages_on {
        let Some(page) = list.get(*p) else { continue };
        let mut items = store::contents(pdf, page.id)?;
        if store::remove_from(pdf, &mut items, &infos) {
            store::set_contents(pdf, page.id, items)?;
        }
        store::drop_form_resources(pdf, page.id, &infos)?;
    }
    Ok((pages_on, info.and_then(|i| i.picture)))
}

/// Replace mark `id` by `spec` (same id). A picture watermark keeps its picture unless a new one
/// is given.
/// `only`: as in [`add`] (previews of an edit).
pub fn update(
    pdf: &mut Pdf,
    id: &str,
    spec: &MarkSpec,
    picture: Option<&[u8]>,
    only: Option<&[usize]>,
) -> Result<Added> {
    spec.validate()?;
    let (_, old_picture) = remove(pdf, id)?;
    add(pdf, spec, picture, only, Some(id.to_string()), old_picture)
}
