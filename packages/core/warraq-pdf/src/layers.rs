//! Layers: a PDF's optional content groups (`/OCProperties`), with the order
//! a viewer lists them in, which are locked, and which are shown, printed
//! and exported.
//!
//! Showing or hiding a layer changes only the default configuration (`/D`):
//! its `/ON` and `/OFF` lists. The interface uses that on a copy, to draw the
//! pages with the layers a person chose, and on the file itself only when
//! they choose to keep that visibility with it.
use std::collections::{BTreeSet, HashSet};

use lopdf::{Dictionary, Object, ObjectId};

use crate::document::decode_text_string;
use crate::hidden::{object_key, parse_object_key};
use crate::{Error, PdfDocument, Result};

/// The deepest an order tree is followed, and the most entries read from it.
const MAX_DEPTH: usize = 32;
const MAX_ENTRIES: usize = 10_000;

#[derive(Debug, Clone, PartialEq)]
pub struct Layer {
    /// The group's object, as `"12 0"`.
    pub id: String,
    pub name: String,
    /// Shown, in the default configuration.
    pub visible: bool,
    /// The person may not switch it (`/D /Locked`).
    pub locked: bool,
    /// Printed, when the file says (`/Usage /Print /PrintState`).
    pub print: Option<bool>,
    /// Exported, when the file says (`/Usage /Export /ExportState`).
    pub export: Option<bool>,
}

/// One entry of the order a viewer lists layers in.
#[derive(Debug, Clone, PartialEq)]
pub enum LayerNode {
    /// A layer, with the layers listed under it.
    Layer {
        id: String,
        children: Vec<LayerNode>,
    },
    /// A heading that is not a layer itself, with what it groups.
    Group {
        label: String,
        children: Vec<LayerNode>,
    },
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Layers {
    pub layers: Vec<Layer>,
    /// The order tree; every layer it leaves out is listed after it, flat.
    pub order: Vec<LayerNode>,
}

impl PdfDocument {
    fn oc_properties(&self) -> Option<&Dictionary> {
        let catalog = self.doc.catalog().ok()?;
        let o = catalog.get(b"OCProperties").ok()?;
        self.doc.dereference(o).ok()?.1.as_dict().ok()
    }

    fn oc_config(&self) -> Option<&Dictionary> {
        let props = self.oc_properties()?;
        self.doc
            .dereference(props.get(b"D").ok()?)
            .ok()?
            .1
            .as_dict()
            .ok()
    }

    fn ref_list(&self, dict: &Dictionary, key: &[u8]) -> Vec<ObjectId> {
        dict.get(key)
            .ok()
            .and_then(|o| self.doc.dereference(o).ok())
            .and_then(|(_, o)| o.as_array().ok())
            .map(|a| {
                a.iter()
                    .filter_map(|o| o.as_reference().ok())
                    .take(MAX_ENTRIES)
                    .collect()
            })
            .unwrap_or_default()
    }

    fn usage_state(&self, group: &Dictionary, usage: &[u8], key: &[u8]) -> Option<bool> {
        let u = self
            .doc
            .dereference(group.get(b"Usage").ok()?)
            .ok()?
            .1
            .as_dict()
            .ok()?;
        let d = self
            .doc
            .dereference(u.get(usage).ok()?)
            .ok()?
            .1
            .as_dict()
            .ok()?;
        match d.get(key).ok()?.as_name().ok()? {
            b"ON" => Some(true),
            b"OFF" => Some(false),
            _ => None,
        }
    }

    /// The document's layers, in the order its list gives them.
    pub fn layers(&self) -> Layers {
        let Some(props) = self.oc_properties() else {
            return Layers::default();
        };
        let off = self.off_layers();
        let locked: HashSet<ObjectId> = self
            .oc_config()
            .map(|c| self.ref_list(c, b"Locked").into_iter().collect())
            .unwrap_or_default();
        let mut seen = HashSet::new();
        let layers: Vec<Layer> = self
            .ref_list(props, b"OCGs")
            .into_iter()
            .filter(|id| seen.insert(*id))
            .filter_map(|id| {
                let group = self.doc.get_dictionary(id).ok()?;
                Some(Layer {
                    id: object_key(id),
                    name: self.layer_name(id),
                    visible: !off.contains(&id),
                    locked: locked.contains(&id),
                    print: self.usage_state(group, b"Print", b"PrintState"),
                    export: self.usage_state(group, b"Export", b"ExportState"),
                })
            })
            .collect();
        let known: HashSet<String> = layers.iter().map(|l| l.id.clone()).collect();
        let mut listed = HashSet::new();
        let mut order = self
            .oc_config()
            .and_then(|c| c.get(b"Order").ok())
            .and_then(|o| self.doc.dereference(o).ok())
            .and_then(|(_, o)| o.as_array().ok())
            .map(|a| self.order_nodes(a, &known, &mut listed, 0))
            .unwrap_or_default();
        for layer in &layers {
            if !listed.contains(&layer.id) {
                order.push(LayerNode::Layer {
                    id: layer.id.clone(),
                    children: vec![],
                });
            }
        }
        Layers { layers, order }
    }

    /// An order array read as a tree: a layer followed by an array has that
    /// array as its children; an array that starts with a string is a group.
    fn order_nodes(
        &self,
        items: &[Object],
        known: &HashSet<String>,
        listed: &mut HashSet<String>,
        depth: usize,
    ) -> Vec<LayerNode> {
        if depth > MAX_DEPTH {
            return vec![];
        }
        let mut out: Vec<LayerNode> = vec![];
        for item in items.iter().take(MAX_ENTRIES) {
            let resolved = match item {
                Object::Reference(id) => {
                    let key = object_key(*id);
                    if known.contains(&key) {
                        if listed.insert(key.clone()) {
                            out.push(LayerNode::Layer {
                                id: key,
                                children: vec![],
                            });
                        }
                        continue;
                    }
                    self.doc.get_object(*id).ok()
                }
                other => Some(other),
            };
            let Some(Object::Array(inner)) = resolved else {
                continue;
            };
            let label = inner
                .first()
                .and_then(|o| o.as_str().ok())
                .map(decode_text_string);
            let rest = if label.is_some() {
                &inner[1..]
            } else {
                &inner[..]
            };
            let children = self.order_nodes(rest, known, listed, depth + 1);
            match (label, out.last_mut()) {
                (Some(label), _) => out.push(LayerNode::Group { label, children }),
                (None, Some(LayerNode::Layer { children: own, .. })) if own.is_empty() => {
                    *own = children
                }
                (None, _) => out.extend(children),
            }
        }
        out
    }

    /// Shows the layers in `visible` and hides every other one, in the
    /// default configuration; a locked layer keeps its state. Returns
    /// whether the file has layers at all.
    pub fn set_layer_visibility(&mut self, visible: &BTreeSet<String>) -> Result<bool> {
        let Some(props) = self.oc_properties() else {
            return Ok(false);
        };
        let all = self.ref_list(props, b"OCGs");
        let before = self.off_layers();
        let locked: HashSet<ObjectId> = self
            .oc_config()
            .map(|c| self.ref_list(c, b"Locked").into_iter().collect())
            .unwrap_or_default();
        let (mut on, mut off) = (vec![], vec![]);
        let mut seen = HashSet::new();
        for id in all.into_iter().filter(|id| seen.insert(*id)) {
            let shown = if locked.contains(&id) {
                !before.contains(&id)
            } else {
                visible.contains(&object_key(id))
            };
            if shown {
                on.push(Object::Reference(id));
            } else {
                off.push(Object::Reference(id));
            }
        }
        let mut config = self.oc_config().cloned().unwrap_or_default();
        config.set("BaseState", Object::Name(b"ON".to_vec()));
        config.set("ON", Object::Array(on));
        config.set("OFF", Object::Array(off));
        self.set_oc_config(config)?;
        Ok(true)
    }

    /// Replaces the default configuration, wherever it is held.
    fn set_oc_config(&mut self, config: Dictionary) -> Result<()> {
        let parse = |e: lopdf::Error| Error::Parse(e.to_string());
        let root = self
            .doc
            .trailer
            .get(b"Root")
            .and_then(|r| r.as_reference())
            .map_err(parse)?;
        let props_obj = self
            .doc
            .catalog()
            .map_err(parse)?
            .get(b"OCProperties")
            .map_err(parse)?
            .clone();
        let (props_id, mut props) = match props_obj {
            Object::Reference(id) => (
                Some(id),
                self.doc.get_dictionary(id).map_err(parse)?.clone(),
            ),
            Object::Dictionary(d) => (None, d),
            _ => return Err(Error::Edit("the layers cannot be read".into())),
        };
        match props.get(b"D") {
            Ok(Object::Reference(id)) => {
                let id = *id;
                *self.doc.get_dictionary_mut(id).map_err(parse)? = config;
                self.mark_touched(id);
                return Ok(());
            }
            _ => props.set("D", Object::Dictionary(config)),
        }
        match props_id {
            Some(id) => {
                *self.doc.get_dictionary_mut(id).map_err(parse)? = props;
                self.mark_touched(id);
            }
            None => {
                self.doc
                    .get_dictionary_mut(root)
                    .map_err(parse)?
                    .set("OCProperties", Object::Dictionary(props));
                self.mark_touched(root);
            }
        }
        Ok(())
    }

    /// Gives this document `other`'s layer visibility: the file's own, back
    /// on a copy that was shown with other choices. Objects keep their
    /// numbers across the engines, so the layers are the same ones.
    pub fn restore_layer_visibility(&mut self, other: &PdfDocument) -> Result<()> {
        let (Some(_), Some(theirs)) = (self.oc_properties(), other.oc_config()) else {
            return Ok(());
        };
        let theirs = theirs.clone();
        self.set_oc_config(theirs)
    }
}

/// A layer id from the interface, checked.
pub fn layer_id(key: &str) -> Option<ObjectId> {
    parse_object_key(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Vec<u8> {
        std::fs::read(format!(
            "{}/../../../tests/fixtures/layers/layers.pdf",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap()
    }

    #[test]
    fn layers_come_with_their_state_order_and_arabic_names() {
        let doc = PdfDocument::open(fixture(), None).unwrap();
        let Layers { layers, order } = doc.layers();
        let names: Vec<&str> = layers.iter().map(|l| l.name.as_str()).collect();
        assert_eq!(names, ["Text", "طبقة عربية", "Watermark", "Locked notes"]);
        let visible: Vec<bool> = layers.iter().map(|l| l.visible).collect();
        assert_eq!(visible, [true, true, false, true]);
        assert!(layers[3].locked && !layers[0].locked);
        assert_eq!(layers[2].print, Some(true), "the watermark prints");
        assert_eq!(layers[3].export, Some(false));
        let text = layers[0].id.clone();
        let locked = layers[3].id.clone();
        assert_eq!(
            order,
            vec![
                LayerNode::Layer {
                    id: text,
                    children: vec![LayerNode::Layer {
                        id: locked,
                        children: vec![]
                    }],
                },
                LayerNode::Layer {
                    id: layers[1].id.clone(),
                    children: vec![]
                },
                LayerNode::Group {
                    label: "Extras".into(),
                    children: vec![LayerNode::Layer {
                        id: layers[2].id.clone(),
                        children: vec![]
                    }],
                },
            ]
        );
    }

    #[test]
    fn visibility_is_set_on_a_copy_and_the_file_own_comes_back() {
        let original = PdfDocument::open(fixture(), None).unwrap();
        let ids: Vec<String> = original.layers().layers.into_iter().map(|l| l.id).collect();
        let mut view = PdfDocument::open(fixture(), None).unwrap();
        // Show the watermark, hide the text and try to hide the locked layer.
        let visible: BTreeSet<String> = [ids[1].clone(), ids[2].clone()].into_iter().collect();
        assert!(view.set_layer_visibility(&visible).unwrap());
        let shown = PdfDocument::open(view.save_incremental().unwrap(), None).unwrap();
        let states: Vec<bool> = shown.layers().layers.iter().map(|l| l.visible).collect();
        assert_eq!(
            states,
            [false, true, true, true],
            "the locked layer keeps its state"
        );

        let mut back = shown;
        back.restore_layer_visibility(&original).unwrap();
        let states: Vec<bool> = back.layers().layers.iter().map(|l| l.visible).collect();
        assert_eq!(states, [true, true, false, true]);
        assert!(!PdfDocument::open(
            std::fs::read(format!(
                "{}/../../../tests/corpus/arabic/generated/raw-amiri-cid-identity-tounicode.pdf",
                env!("CARGO_MANIFEST_DIR")
            ))
            .unwrap(),
            None
        )
        .unwrap()
        .set_layer_visibility(&BTreeSet::new())
        .unwrap());
    }
}
