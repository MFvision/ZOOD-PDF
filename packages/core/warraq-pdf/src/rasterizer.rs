//! A copy of the document the rasterizer can take without harm.
//!
//! The rasterizer (hayro) reads the file itself, and walks the page tree —
//! cloning each level's resources — recursively: a hostile tree thousands of
//! levels deep overflows the stack, which in WebAssembly is a trap that ends
//! the engine, not an error. Such a file is drawn from a copy with a flat page
//! tree, which draws the same: every page keeps what it inherited. Other
//! hostile shapes are bounded inside the vendored hayro crates
//! (`packages/core/vendor/*/ZOOD-PATCHES.md`).
use crate::document::PdfDocument;
use crate::{Error, Result};
use lopdf::{Document, Object, ObjectId};
use std::collections::HashSet;

/// Deeper than this, the page tree is flattened. Real files use two or three
/// levels.
pub const MAX_RENDER_TREE_DEPTH: usize = 32;

impl PdfDocument {
    /// How many `/Pages` levels the page tree has from the catalog down,
    /// counted without recursion and stopping past `cap`: a loop counts once.
    pub fn page_tree_depth(&self, cap: usize) -> usize {
        let Some(root) = page_root(&self.doc) else {
            return 0;
        };
        let mut seen = HashSet::from([root]);
        let mut level = vec![root];
        let mut depth = 0;
        while !level.is_empty() && depth <= cap {
            depth += 1;
            let mut next = Vec::new();
            for id in level {
                let Ok(node) = self.doc.get_dictionary(id) else {
                    continue;
                };
                let kids = match node.get(b"Kids") {
                    Ok(Object::Array(a)) => a,
                    Ok(Object::Reference(r)) => match self.doc.get_object(*r) {
                        Ok(Object::Array(a)) => a,
                        _ => continue,
                    },
                    _ => continue,
                };
                for kid in kids {
                    if let Ok(kid) = kid.as_reference() {
                        let inner = self.doc.get_dictionary(kid).is_ok_and(|d| d.has(b"Kids"));
                        if inner && seen.insert(kid) {
                            next.push(kid);
                        }
                    }
                }
            }
            level = next;
        }
        depth
    }

    /// The bytes the rasterizer should read instead of the file's own, or
    /// `None` when the file's own are safe for it (see the module's notes).
    /// Plaintext, like `save_to_vec`.
    pub fn for_rasterizer(&self) -> Result<Option<Vec<u8>>> {
        if self.page_tree_depth(MAX_RENDER_TREE_DEPTH) <= MAX_RENDER_TREE_DEPTH {
            return Ok(None);
        }
        let mut doc = self.doc.clone();
        self.flatten_into(&mut doc)?;
        let mut out = Vec::with_capacity(self.original_bytes().len() + 4096);
        doc.save_to(&mut out)
            .map_err(|e| Error::Io(e.to_string()))?;
        Ok(Some(out))
    }

    /// `doc` (a copy of this document) with a flat page tree: every page a
    /// kid of the root `/Pages`, with its inherited attributes copied onto it.
    fn flatten_into(&self, doc: &mut Document) -> Result<()> {
        let root =
            page_root(doc).ok_or_else(|| Error::Parse("the file has no page tree".into()))?;
        for &page in &self.pages {
            let Ok(dict) = self.doc.get_dictionary(page) else {
                continue;
            };
            let mut copied: Vec<(&[u8], Object)> = Vec::new();
            for key in [&b"Resources"[..], b"MediaBox", b"CropBox", b"Rotate"] {
                if !dict.has(key) {
                    if let Some(v) = self.inherited(dict, key) {
                        copied.push((key, v.clone()));
                    }
                }
            }
            if let Ok(d) = doc.get_dictionary_mut(page) {
                for (key, value) in copied {
                    d.set(key, value);
                }
                d.set("Parent", Object::Reference(root));
            }
        }
        let kids: Vec<Object> = self.pages.iter().map(|&p| Object::Reference(p)).collect();
        let count = kids.len() as i64;
        let node = doc
            .get_dictionary_mut(root)
            .map_err(|e| Error::Parse(e.to_string()))?;
        node.set("Kids", Object::Array(kids));
        node.set("Count", Object::Integer(count));
        node.remove(b"Parent");
        Ok(())
    }
}

fn page_root(doc: &Document) -> Option<ObjectId> {
    doc.catalog()
        .ok()
        .and_then(|c| c.get(b"Pages").ok())
        .and_then(|p| p.as_reference().ok())
}
