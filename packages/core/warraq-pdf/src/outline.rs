//! Bookmarks: the document outline, flattened in reading order with each
//! entry's depth and the page it goes to.
use std::collections::{HashMap, HashSet};

use lopdf::{Dictionary, Object, ObjectId};

use crate::document::decode_text_string;
use crate::PdfDocument;

const MAX_ITEMS: usize = 10_000;
const MAX_DEPTH: usize = 32;

#[derive(Debug, Clone, PartialEq)]
pub struct Bookmark {
    pub title: String,
    /// 0 for a top-level entry.
    pub depth: usize,
    /// The page it goes to, zero-based; `None` for one that goes elsewhere
    /// (a web address, another file) or nowhere.
    pub page: Option<usize>,
    /// Shown open: its children are listed below it.
    pub open: bool,
    pub children: usize,
}

impl PdfDocument {
    /// The outline, entry by entry, bounded.
    pub fn bookmarks(&self) -> Vec<Bookmark> {
        let mut out = vec![];
        let Some(outlines) = self
            .doc
            .catalog()
            .ok()
            .and_then(|c| c.get(b"Outlines").ok())
            .and_then(|o| self.doc.dereference(o).ok())
            .and_then(|(_, o)| o.as_dict().ok())
        else {
            return out;
        };
        let pages: HashMap<ObjectId, usize> = self
            .pages
            .iter()
            .enumerate()
            .map(|(i, id)| (*id, i))
            .collect();
        let named = self.named_destinations();
        let mut seen: HashSet<ObjectId> = HashSet::new();
        // (next item, depth), depth-first in reading order.
        let mut stack: Vec<(ObjectId, usize)> = outlines
            .get(b"First")
            .and_then(|o| o.as_reference())
            .map(|id| vec![(id, 0)])
            .unwrap_or_default();
        while let Some((id, depth)) = stack.pop() {
            if out.len() >= MAX_ITEMS || !seen.insert(id) {
                continue;
            }
            let Ok(item) = self.doc.get_dictionary(id) else {
                continue;
            };
            let title = item
                .get(b"Title")
                .ok()
                .and_then(|o| self.doc.dereference(o).ok())
                .and_then(|(_, o)| o.as_str().ok())
                .map(decode_text_string)
                .unwrap_or_default();
            let count = item.get(b"Count").and_then(|c| c.as_i64()).unwrap_or(0);
            let first = item.get(b"First").and_then(|o| o.as_reference()).ok();
            let mut children = 0;
            let mut child = first;
            let mut guard = HashSet::new();
            while let Some(c) = child {
                if !guard.insert(c) || children >= MAX_ITEMS {
                    break;
                }
                children += 1;
                child = self
                    .doc
                    .get_dictionary(c)
                    .ok()
                    .and_then(|d| d.get(b"Next").and_then(|n| n.as_reference()).ok());
            }
            out.push(Bookmark {
                title: title.trim().to_string(),
                depth,
                page: self.destination_page(item, &pages, &named),
                open: count > 0,
                children,
            });
            if let Ok(next) = item.get(b"Next").and_then(|o| o.as_reference()) {
                stack.push((next, depth));
            }
            if let Some(first) = first {
                if depth < MAX_DEPTH {
                    stack.push((first, depth + 1));
                }
            }
        }
        out
    }

    /// Named destinations: the catalog's `/Dests` and the `/Dests` name tree.
    fn named_destinations(&self) -> HashMap<Vec<u8>, Object> {
        let mut out = HashMap::new();
        if let Some(root) = self.names_root(b"Dests") {
            for (k, v) in self.name_tree_entries(root) {
                out.insert(k, v);
            }
        }
        if let Some(dests) = self
            .doc
            .catalog()
            .ok()
            .and_then(|c| c.get(b"Dests").ok())
            .and_then(|o| self.doc.dereference(o).ok())
            .and_then(|(_, o)| o.as_dict().ok())
        {
            for (k, v) in dests.iter().take(MAX_ITEMS) {
                out.insert(k.clone(), v.clone());
            }
        }
        out
    }

    fn destination_page(
        &self,
        item: &Dictionary,
        pages: &HashMap<ObjectId, usize>,
        named: &HashMap<Vec<u8>, Object>,
    ) -> Option<usize> {
        let dest = match item.get(b"Dest") {
            Ok(d) => d.clone(),
            Err(_) => {
                let action = self
                    .doc
                    .dereference(item.get(b"A").ok()?)
                    .ok()?
                    .1
                    .as_dict()
                    .ok()?;
                if action.get(b"S").ok()?.as_name().ok()? != b"GoTo" {
                    return None;
                }
                action.get(b"D").ok()?.clone()
            }
        };
        self.dest_page(&dest, pages, named, 0)
    }

    fn dest_page(
        &self,
        dest: &Object,
        pages: &HashMap<ObjectId, usize>,
        named: &HashMap<Vec<u8>, Object>,
        depth: usize,
    ) -> Option<usize> {
        if depth > 4 {
            return None;
        }
        match self.doc.dereference(dest).ok()?.1 {
            Object::Array(a) => match a.first()? {
                Object::Reference(page) => pages.get(page).copied(),
                // A remote destination names the page by number.
                Object::Integer(n) if *n >= 0 && (*n as usize) < self.pages.len() => {
                    Some(*n as usize)
                }
                _ => None,
            },
            Object::Name(n) | Object::String(n, _) => {
                self.dest_page(named.get(n)?, pages, named, depth + 1)
            }
            // A named destination's value may be a dictionary with `/D`.
            Object::Dictionary(d) => self.dest_page(d.get(b"D").ok()?, pages, named, depth + 1),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_outline_is_read_with_titles_depths_and_pages() {
        let read = |path: &str| {
            PdfDocument::open(
                std::fs::read(format!(
                    "{}/../../../tests/{path}",
                    env!("CARGO_MANIFEST_DIR")
                ))
                .unwrap(),
                None,
            )
            .unwrap()
        };
        let marks = read("fixtures/hidden/everything.pdf").bookmarks();
        assert_eq!(marks.len(), 2);
        assert_eq!(marks[0].title, "BOOKMARK-SECRET");
        assert_eq!(marks[0].page, Some(0));
        assert_eq!(marks[1].page, None, "a web address is not a page");
        let arabic =
            read("corpus/arabic/generated/variant-arabic-metadata-outlines-annots.pdf").bookmarks();
        assert!(!arabic.is_empty());
        let is_arabic = |c: char| ('\u{0600}'..='\u{06FF}').contains(&c);
        assert!(
            arabic.iter().any(|b| b.title.chars().any(is_arabic)),
            "{arabic:#?}"
        );
        assert!(arabic.iter().all(|b| b.page.is_some()), "{arabic:#?}");
    }
}
