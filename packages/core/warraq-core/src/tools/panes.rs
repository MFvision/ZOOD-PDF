//! The document panes: bookmarks (`outline.list`), attachments
//! (`attachments.*`) and layers (`layers.*`). Each takes the file as it stands
//! and answers JSON, and a changed file where there is one — written as an
//! update of the file's own bytes, sealed with its key if it has one.
use std::collections::BTreeSet;

use serde::Deserialize;
use warraq_pdf::{AttachmentPlace, LayerNode, PdfDocument};

use super::{args, Reply};
use crate::CoreError;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Args {
    #[serde(default)]
    password: Option<String>,
    /// An attachment, as `attachments.list` names it.
    #[serde(default)]
    key: Option<String>,
    /// A file to attach: its name and, if any, a description.
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    /// Layers to show, by id; every other one is hidden.
    #[serde(default)]
    visible: Vec<String>,
    /// `layers.restore`: keep the result an update of the file's own bytes.
    #[serde(default)]
    rebase: bool,
}

fn first(blobs: &mut std::vec::IntoIter<Vec<u8>>, what: &str) -> Result<Vec<u8>, CoreError> {
    blobs
        .next()
        .ok_or_else(|| CoreError::Args(format!("{what} is missing")))
}

fn node_json(node: &LayerNode) -> serde_json::Value {
    match node {
        LayerNode::Layer { id, children } => serde_json::json!({
            "id": id,
            "children": children.iter().map(node_json).collect::<Vec<_>>(),
        }),
        LayerNode::Group { label, children } => serde_json::json!({
            "label": label,
            "children": children.iter().map(node_json).collect::<Vec<_>>(),
        }),
    }
}

/// The document written back: an update of its own bytes when it can be,
/// whole when it cannot (a file with no usable cross-reference section).
fn saved(doc: &mut PdfDocument) -> Result<Vec<u8>, CoreError> {
    match doc.save_incremental() {
        Ok(bytes) => Ok(bytes),
        Err(_) => Ok(doc.save_to_vec()?),
    }
}

pub fn outline(name: &str, json: &str, blobs: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let a: Args = args(json)?;
    let mut blobs = blobs.into_iter();
    match name {
        "list" => {
            let doc = PdfDocument::open(first(&mut blobs, "the PDF")?, a.password.as_deref())?;
            let items: Vec<serde_json::Value> = doc
                .bookmarks()
                .into_iter()
                .map(|b| {
                    serde_json::json!({
                        "title": b.title,
                        "depth": b.depth,
                        "page": b.page,
                        "outside": b.outside,
                        "open": b.open,
                        "children": b.children,
                    })
                })
                .collect();
            Reply::of(&serde_json::json!({ "bookmarks": items }))
        }
        _ => Err(CoreError::UnknownOp(format!("outline.{name}"))),
    }
}

pub fn attachments(name: &str, json: &str, blobs: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let a: Args = args(json)?;
    let mut blobs = blobs.into_iter();
    let mut doc = PdfDocument::open(first(&mut blobs, "the PDF")?, a.password.as_deref())?;
    let key = || {
        a.key
            .clone()
            .ok_or_else(|| CoreError::Args("which attachment?".into()))
    };
    match name {
        "list" => {
            let items: Vec<serde_json::Value> = doc
                .attachments()
                .into_iter()
                .map(|x| {
                    serde_json::json!({
                        "key": x.key,
                        "name": x.name,
                        "description": x.description,
                        "size": x.size,
                        "mime": x.mime,
                        "page": match x.place {
                            AttachmentPlace::Document => None,
                            AttachmentPlace::Page(p) => Some(p),
                        },
                    })
                })
                .collect();
            Reply::of(&serde_json::json!({ "attachments": items }))
        }
        // Handed back as bytes, to be saved; never opened here or anywhere.
        "get" => {
            let (name, bytes) = doc.attachment_bytes(&key()?)?;
            Ok(
                Reply::of(&serde_json::json!({ "name": name, "size": bytes.len() }))?
                    .with_blob(bytes),
            )
        }
        "add" => {
            let file = first(&mut blobs, "the file to attach")?;
            let wanted = a.name.as_deref().unwrap_or("attachment");
            let name = doc.add_attachment(wanted, file, a.description.as_deref())?;
            let bytes = saved(&mut doc)?;
            Ok(Reply::of(&serde_json::json!({ "name": name }))?.with_blob(bytes))
        }
        "remove" => {
            doc.remove_attachment(&key()?)?;
            let bytes = saved(&mut doc)?;
            Ok(Reply::of(&serde_json::json!({ "removed": true }))?.with_blob(bytes))
        }
        _ => Err(CoreError::UnknownOp(format!("attachments.{name}"))),
    }
}

pub fn layers(name: &str, json: &str, blobs: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let a: Args = args(json)?;
    let mut blobs = blobs.into_iter();
    match name {
        "list" => {
            let doc = PdfDocument::open(first(&mut blobs, "the PDF")?, a.password.as_deref())?;
            let found = doc.layers();
            let layers: Vec<serde_json::Value> = found
                .layers
                .iter()
                .map(|l| {
                    serde_json::json!({
                        "id": l.id,
                        "name": l.name,
                        "visible": l.visible,
                        "locked": l.locked,
                        "print": l.print,
                        "export": l.export,
                    })
                })
                .collect();
            let order: Vec<serde_json::Value> = found.order.iter().map(node_json).collect();
            Reply::of(&serde_json::json!({ "layers": layers, "order": order }))
        }
        // A copy whose default configuration shows exactly `visible`.
        "show" => {
            let mut doc = PdfDocument::open(first(&mut blobs, "the PDF")?, a.password.as_deref())?;
            let visible: BTreeSet<String> = a.visible.into_iter().collect();
            if !doc.set_layer_visibility(&visible)? {
                return Err(CoreError::Args("this file has no layers".into()));
            }
            let bytes = saved(&mut doc)?;
            Ok(Reply::of(&serde_json::json!({ "shown": visible.len() }))?.with_blob(bytes))
        }
        // blobs: the file with its own visibility, then the same file as it
        // stands, shown with other choices: the second, given back the
        // first's visibility — as an update of the first when `rebase`.
        "restore" => {
            let own_bytes = first(&mut blobs, "the file")?;
            let current = first(&mut blobs, "the file as it stands")?;
            let mut own = PdfDocument::open(own_bytes, a.password.as_deref())?;
            let mut theirs = PdfDocument::open(current, a.password.as_deref())?;
            theirs.restore_layer_visibility(&own)?;
            let restored = saved(&mut theirs)?;
            let (bytes, rebased) = if a.rebase {
                match own.rebase(restored.clone(), a.password.as_deref())? {
                    Some(bytes) => (bytes, true),
                    None => (restored, false),
                }
            } else {
                (restored, false)
            };
            Ok(Reply::of(&serde_json::json!({ "rebased": rebased }))?.with_blob(bytes))
        }
        _ => Err(CoreError::UnknownOp(format!("layers.{name}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(path: &str) -> Vec<u8> {
        std::fs::read(format!(
            "{}/../../../tests/fixtures/{path}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap()
    }

    fn json(reply: &Reply) -> serde_json::Value {
        serde_json::from_str(&reply.json).unwrap()
    }

    #[test]
    fn a_view_copy_shows_other_layers_and_saving_gives_the_file_its_own_back() {
        let file = fixture("layers/layers.pdf");
        let listed = json(&crate::call_static("layers.list", "", vec![file.clone()]).unwrap());
        let ids: Vec<String> = listed["layers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|l| l["id"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(listed["layers"][1]["name"], "طبقة عربية");
        let shown = crate::call_static(
            "layers.show",
            &serde_json::json!({ "visible": [ids[2]] }).to_string(),
            vec![file.clone()],
        )
        .unwrap();
        let view = shown.blobs[0].clone();
        assert!(view.starts_with(&file), "an update of the file");
        let states = json(&crate::call_static("layers.list", "", vec![view.clone()]).unwrap());
        let visible: Vec<bool> = states["layers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|l| l["visible"].as_bool().unwrap())
            .collect();
        assert_eq!(visible, [false, false, true, true], "locked stays shown");

        let restored = crate::call_static(
            "layers.restore",
            r#"{"rebase": true}"#,
            vec![file.clone(), view],
        )
        .unwrap();
        assert_eq!(json(&restored)["rebased"], true);
        assert_eq!(
            restored.blobs[0], file,
            "nothing else changed: the file comes back byte for byte"
        );
    }

    #[test]
    fn attachments_are_listed_read_added_and_removed_through_the_ops() {
        let file = fixture("hidden/everything.pdf");
        let listed = json(&crate::call_static("attachments.list", "", vec![file.clone()]).unwrap());
        assert_eq!(listed["attachments"].as_array().unwrap().len(), 2);
        assert_eq!(listed["attachments"][1]["page"], 0);
        let got =
            crate::call_static("attachments.get", r#"{"key":"d0"}"#, vec![file.clone()]).unwrap();
        assert_eq!(got.blobs[0], b"ATTACH-DOC-SECRET\n");
        let added = crate::call_static(
            "attachments.add",
            r#"{"name":"ملاحظات.txt","description":"من ورّاق"}"#,
            vec![file.clone(), b"hello".to_vec()],
        )
        .unwrap();
        let with = added.blobs[0].clone();
        assert!(with.starts_with(&file));
        let listed = json(&crate::call_static("attachments.list", "", vec![with.clone()]).unwrap());
        assert_eq!(listed["attachments"].as_array().unwrap().len(), 3);
        let removed =
            crate::call_static("attachments.remove", r#"{"key":"p0:2"}"#, vec![with]).unwrap();
        let listed = json(
            &crate::call_static("attachments.list", "", vec![removed.blobs[0].clone()]).unwrap(),
        );
        let names: Vec<&str> = listed["attachments"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, ["doc-secret.txt", "ملاحظات.txt"]);
    }

    #[test]
    fn bookmarks_are_listed() {
        let listed = json(
            &crate::call_static("outline.list", "", vec![fixture("hidden/everything.pdf")])
                .unwrap(),
        );
        assert_eq!(listed["bookmarks"][0]["title"], "BOOKMARK-SECRET");
        assert_eq!(listed["bookmarks"][0]["page"], 0);
        assert_eq!(listed["bookmarks"][0]["outside"], false);
        assert_eq!(listed["bookmarks"][1]["outside"], true, "a web address");
    }
}
