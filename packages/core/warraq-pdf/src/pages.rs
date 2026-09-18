//! Page structure: rotate, reorder, delete, insert a blank page, copy pages
//! out into a new document, and append another document's pages.
//!
//! These stay in Warraq's object layer rather than EmbedPDF's PDFium
//! (ADR-0007, and the build plan's engine split): EmbedPDF 2.15 cannot move or
//! rotate pages, and PDFium's importer leaves form fields pointing into the
//! source file and drops bookmarks. Every change here is recorded as touched
//! or new objects, so `save_incremental` appends it and the opened bytes stay
//! the prefix of the saved file.
use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};

use lopdf::{dictionary, Dictionary, Object, ObjectId};

use crate::{Error, PdfDocument, Result};

/// Page attributes a page may take from its ancestors (ISO 32000-2, 7.7.3.4).
const INHERITED: [&[u8]; 4] = [b"Resources", b"MediaBox", b"CropBox", b"Rotate"];

fn parse(e: impl std::fmt::Display) -> Error {
    Error::Parse(e.to_string())
}

impl PdfDocument {
    /// The root `/Pages` node.
    fn pages_root(&self) -> Result<ObjectId> {
        self.doc
            .catalog()
            .and_then(|catalog| catalog.get(b"Pages"))
            .and_then(Object::as_reference)
            .map_err(parse)
    }

    /// An attribute of a page, looked up through its ancestors.
    fn inherited_value(&self, page: ObjectId, key: &[u8]) -> Option<Object> {
        let mut id = page;
        let mut seen = HashSet::new();
        while seen.insert(id) {
            let dict = self.doc.get_dictionary(id).ok()?;
            if let Ok(value) = dict.get(key) {
                return Some(value.clone());
            }
            id = dict.get(b"Parent").ok()?.as_reference().ok()?;
        }
        None
    }

    /// The page's rotation in degrees, normalized to 0, 90, 180 or 270.
    pub fn page_rotation(&self, index: usize) -> Result<i64> {
        let id = self.page_id(index)?;
        let degrees = match self.inherited_value(id, b"Rotate") {
            Some(Object::Reference(r)) => self.doc.get_object(r).ok().and_then(|o| o.as_i64().ok()),
            Some(o) => o.as_i64().ok(),
            None => None,
        }
        .unwrap_or(0);
        Ok(((degrees % 360) + 360) % 360 / 90 * 90)
    }

    /// Makes every page a direct kid of the root `/Pages` node that carries its
    /// inherited attributes itself, so pages can be reordered, removed and
    /// inserted by rewriting one array. Does nothing to a tree that is already
    /// flat. Intermediate nodes are left unreferenced.
    fn flatten_page_tree(&mut self) -> Result<ObjectId> {
        let root = self.pages_root()?;
        let parent_of = |doc: &lopdf::Document, id: ObjectId| {
            doc.get_dictionary(id)
                .ok()
                .and_then(|d| d.get(b"Parent").ok())
                .and_then(|p| p.as_reference().ok())
        };
        let flat = self
            .pages
            .iter()
            .all(|&id| parent_of(&self.doc, id) == Some(root));
        if !flat {
            for id in self.pages.clone() {
                let carried: Vec<(&[u8], Object)> = INHERITED
                    .iter()
                    .filter(|key| {
                        self.doc
                            .get_dictionary(id)
                            .map(|d| !d.has(key))
                            .unwrap_or(false)
                    })
                    .filter_map(|key| Some((*key, self.inherited_value(id, key)?)))
                    .collect();
                let page = self.doc.get_dictionary_mut(id).map_err(parse)?;
                for (key, value) in carried {
                    page.set(key, value);
                }
                page.set("Parent", Object::Reference(root));
                self.mark_touched(id);
            }
        }
        self.write_kids(root)?;
        Ok(root)
    }

    /// The root's `/Kids` and `/Count` from `self.pages`.
    fn write_kids(&mut self, root: ObjectId) -> Result<()> {
        let kids = self.pages.iter().map(|&id| Object::Reference(id)).collect();
        let count = self.pages.len() as i64;
        let node = self.doc.get_dictionary_mut(root).map_err(parse)?;
        node.set("Kids", Object::Array(kids));
        node.set("Count", Object::Integer(count));
        self.mark_touched(root);
        Ok(())
    }

    /// Sorted, de-duplicated page indices, every one of them in range.
    fn page_set(&self, indices: &[usize]) -> Result<BTreeSet<usize>> {
        let set: BTreeSet<usize> = indices.iter().copied().collect();
        match set.iter().find(|&&i| i >= self.pages.len()) {
            Some(&bad) => Err(Error::Page(bad)),
            None => Ok(set),
        }
    }

    /// Turns pages by quarter turns: 1 is 90° clockwise, -1 counter-clockwise.
    /// Only `/Rotate` changes; the page content is untouched.
    pub fn rotate_pages(&mut self, indices: &[usize], quarter_turns: i32) -> Result<()> {
        for index in self.page_set(indices)? {
            let current = self.page_rotation(index)?;
            let turned = (current + 90 * i64::from(quarter_turns)).rem_euclid(360);
            let id = self.page_id(index)?;
            self.doc
                .get_dictionary_mut(id)
                .map_err(parse)?
                .set("Rotate", Object::Integer(turned));
            self.mark_touched(id);
        }
        Ok(())
    }

    /// Puts the pages in a new order: `order[k]` is the current index of the
    /// page that becomes page `k`, so `order` must be a permutation.
    pub fn reorder_pages(&mut self, order: &[usize]) -> Result<()> {
        let n = self.pages.len();
        let mut seen = vec![false; n];
        for &i in order {
            if i >= n || std::mem::replace(&mut seen[i], true) {
                return Err(Error::Edit(format!(
                    "a new page order must list each of the {n} pages once"
                )));
            }
        }
        if order.len() != n {
            return Err(Error::Edit(format!(
                "a new page order must list each of the {n} pages once"
            )));
        }
        let root = self.flatten_page_tree()?;
        self.pages = order.iter().map(|&i| self.pages[i]).collect();
        self.write_kids(root)
    }

    /// Removes pages from the page tree. A document keeps at least one page.
    ///
    /// The removed pages' objects stay in the file's earlier revision, as every
    /// incremental change does; extracting pages writes a new file without them.
    pub fn delete_pages(&mut self, indices: &[usize]) -> Result<()> {
        let doomed = self.page_set(indices)?;
        if doomed.len() >= self.pages.len() {
            return Err(Error::Edit("a document needs at least one page".into()));
        }
        let root = self.flatten_page_tree()?;
        self.pages = self
            .pages
            .iter()
            .enumerate()
            .filter(|(i, _)| !doomed.contains(i))
            .map(|(_, &id)| id)
            .collect();
        self.write_kids(root)
    }

    /// Inserts an empty page at position `at` (0 puts it first, `page_count()`
    /// last), with the size and rotation of page `like`.
    pub fn insert_blank_page(&mut self, at: usize, like: usize) -> Result<()> {
        if at > self.pages.len() {
            return Err(Error::Page(at));
        }
        let model = self.page_id(like)?;
        let media = self
            .inherited_value(model, b"MediaBox")
            .unwrap_or_else(|| vec![0.into(), 0.into(), 612.into(), 792.into()].into());
        let rotate = self.page_rotation(like)?;
        let root = self.flatten_page_tree()?;
        let page = self.doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => Object::Reference(root),
            "MediaBox" => media,
            "Rotate" => rotate,
            "Resources" => Dictionary::new(),
        });
        self.pages.insert(at, page);
        self.write_kids(root)
    }

    /// A new, self-contained PDF holding copies of `indices`, in that order.
    ///
    /// Written from scratch, not as an update: nothing of the other pages may
    /// travel with it. Every reference to a page left behind — a bookmark, a
    /// link, a form field, the structure tree — is cut before unreachable
    /// objects are dropped, so their content cannot come along through one.
    pub fn extract_pages(&self, indices: &[usize]) -> Result<Vec<u8>> {
        if indices.is_empty() {
            return Err(Error::Edit("choose at least one page to extract".into()));
        }
        for &i in indices {
            self.page_id(i)?;
        }
        let mut copy = self.detached_copy();
        let order: Vec<usize> = indices.to_vec();
        let kept: HashSet<ObjectId> = order.iter().map(|&i| copy.pages[i]).collect();
        let root = copy.flatten_page_tree()?;
        copy.pages = order.iter().map(|&i| copy.pages[i]).collect();
        copy.write_kids(root)?;
        // A page may be listed twice; the second listing must be its own object.
        copy.dedupe_repeated_pages()?;
        let left_behind: HashSet<ObjectId> = self
            .pages
            .iter()
            .copied()
            .filter(|id| !kept.contains(id))
            .collect();
        copy.cut_references_to(&left_behind);
        copy.prune_unreachable();
        copy.save_to_vec()
    }

    /// Appends every page of `other` after this document's pages, together
    /// with everything they use; their form fields join this document's form.
    ///
    /// `other`'s objects are renumbered above this document's; references to
    /// objects `other` does not have become null rather than pointing at an
    /// unrelated object of ours.
    pub fn append_document(&mut self, other: &PdfDocument) -> Result<()> {
        let base = self.doc.max_id;
        let map: HashMap<ObjectId, ObjectId> = other
            .doc
            .objects
            .keys()
            .enumerate()
            .map(|(k, &id)| (id, (base + 1 + k as u32, 0)))
            .collect();
        for (id, object) in &other.doc.objects {
            let mut object = object.clone();
            remap_references(&mut object, &map);
            self.doc.objects.insert(map[id], object);
        }
        self.doc.max_id = base + other.doc.objects.len() as u32;
        let appended: Vec<ObjectId> = other.pages.iter().map(|id| map[id]).collect();
        let root = self.flatten_page_tree()?;
        // `other`'s pages keep their own inherited attributes: flatten them
        // against `other`'s tree before they are hung under ours.
        for (&old, &new) in other.pages.iter().zip(&appended) {
            let carried: Vec<(&[u8], Object)> = INHERITED
                .iter()
                .filter(|key| {
                    other
                        .doc
                        .get_dictionary(old)
                        .map(|d| !d.has(key))
                        .unwrap_or(false)
                })
                .filter_map(|key| {
                    let mut value = other.inherited_value(old, key)?;
                    remap_references(&mut value, &map);
                    Some((*key, value))
                })
                .collect();
            let page = self.doc.get_dictionary_mut(new).map_err(parse)?;
            for (key, value) in carried {
                page.set(key, value);
            }
            page.set("Parent", Object::Reference(root));
        }
        self.pages.extend(appended);
        self.write_kids(root)?;
        self.adopt_form_fields(other, &map)?;
        // Page labels described our pages only; the appended ones would carry on
        // the last range. Without labels every viewer numbers pages 1..n.
        if let Ok(catalog) = self.doc.catalog_mut() {
            catalog.remove(b"PageLabels");
        }
        Ok(())
    }

    /// Inserts every page of `other` at position `at` (0 puts them first,
    /// `page_count()` last), with everything they use and their form fields,
    /// as an update of this file. Returns how many pages came in.
    pub fn insert_document(&mut self, other: &PdfDocument, at: usize) -> Result<usize> {
        let before = self.pages.len();
        if at > before {
            return Err(Error::Page(at));
        }
        self.append_document(other)?;
        let added = self.pages.len() - before;
        let order: Vec<usize> = (0..at)
            .chain(before..before + added)
            .chain(at..before)
            .collect();
        self.reorder_pages(&order)?;
        // Appending changed the catalog in place (the form, the page labels),
        // which an update has to carry like any other change.
        if let Ok(Object::Reference(root)) = self.doc.trailer.get(b"Root") {
            let root = *root;
            self.mark_touched(root);
        }
        self.drop_unreachable_additions();
        Ok(added)
    }

    /// `other`'s top-level form fields, renumbered by `map`, added to this
    /// document's `/AcroForm`, renamed where a name is already taken: fields
    /// with the same name are one field in PDF and would share their value.
    fn adopt_form_fields(
        &mut self,
        other: &PdfDocument,
        map: &HashMap<ObjectId, ObjectId>,
    ) -> Result<()> {
        let Some(theirs) = other
            .doc
            .catalog()
            .ok()
            .and_then(|c| c.get(b"AcroForm").ok())
            .and_then(|form| match form {
                Object::Reference(id) => other.doc.get_dictionary(*id).ok(),
                Object::Dictionary(d) => Some(d),
                _ => None,
            })
            .and_then(|form| form.get(b"Fields").ok())
            .and_then(|fields| fields.as_array().ok())
            .map(|fields| {
                fields
                    .iter()
                    .filter_map(|f| f.as_reference().ok())
                    .filter_map(|id| map.get(&id).copied())
                    .collect::<Vec<_>>()
            })
        else {
            return Ok(());
        };
        if theirs.is_empty() {
            return Ok(());
        }
        let form_id = match self
            .doc
            .catalog()
            .ok()
            .and_then(|c| c.get(b"AcroForm").ok())
        {
            Some(Object::Reference(id)) => *id,
            Some(Object::Dictionary(d)) => {
                let id = self.doc.add_object(d.clone());
                self.doc.catalog_mut().map_err(parse)?.set("AcroForm", id);
                id
            }
            _ => {
                let id = self
                    .doc
                    .add_object(dictionary! { "Fields" => Vec::<Object>::new() });
                self.doc.catalog_mut().map_err(parse)?.set("AcroForm", id);
                id
            }
        };
        let mut names: HashSet<Vec<u8>> = self
            .doc
            .get_dictionary(form_id)
            .ok()
            .and_then(|form| form.get(b"Fields").ok())
            .and_then(|fields| fields.as_array().ok())
            .into_iter()
            .flatten()
            .filter_map(|f| f.as_reference().ok())
            .filter_map(|id| self.doc.get_dictionary(id).ok())
            .filter_map(|field| field.get(b"T").ok().and_then(|t| t.as_str().ok()))
            .map(<[u8]>::to_vec)
            .collect();
        for &field in &theirs {
            let Ok(dict) = self.doc.get_dictionary_mut(field) else {
                continue;
            };
            let Some(name) = dict
                .get(b"T")
                .ok()
                .and_then(|t| t.as_str().ok())
                .map(<[u8]>::to_vec)
            else {
                continue;
            };
            let mut unique = name.clone();
            let mut n = 2;
            while names.contains(&unique) {
                unique = [name.as_slice(), format!("_{n}").as_bytes()].concat();
                n += 1;
            }
            if unique != name {
                dict.set(
                    "T",
                    Object::String(unique.clone(), lopdf::StringFormat::Literal),
                );
            }
            names.insert(unique);
        }
        let form = self.doc.get_dictionary_mut(form_id).map_err(parse)?;
        match form.get_mut(b"Fields") {
            Ok(Object::Array(fields)) => fields.extend(theirs.into_iter().map(Object::Reference)),
            _ => form.set(
                "Fields",
                theirs
                    .into_iter()
                    .map(Object::Reference)
                    .collect::<Vec<_>>(),
            ),
        }
        self.mark_touched(form_id);
        Ok(())
    }

    /// A copy of this document to build a new file from: same objects, no
    /// original bytes, no record of changes.
    pub(crate) fn detached_copy(&self) -> PdfDocument {
        PdfDocument::from_parts(self.doc.clone(), self.pages.clone())
    }

    /// Gives a page listed more than once its own copy for each extra listing.
    fn dedupe_repeated_pages(&mut self) -> Result<()> {
        let mut seen = HashSet::new();
        let mut changed = false;
        for k in 0..self.pages.len() {
            let id = self.pages[k];
            if !seen.insert(id) {
                let copy = self.doc.get_object(id).map_err(parse)?.clone();
                self.pages[k] = self.doc.add_object(copy);
                changed = true;
            }
        }
        if changed {
            let root = self.pages_root()?;
            self.write_kids(root)?;
        }
        Ok(())
    }

    /// Replaces every reference to one of `ids` with null, wherever it sits.
    fn cut_references_to(&mut self, ids: &HashSet<ObjectId>) {
        if ids.is_empty() {
            return;
        }
        let map: HashMap<ObjectId, ObjectId> = self
            .doc
            .objects
            .keys()
            .filter(|id| !ids.contains(id))
            .map(|&id| (id, id))
            .collect();
        for object in self.doc.objects.values_mut() {
            remap_references(object, &map);
        }
        for (_, value) in self.doc.trailer.iter_mut() {
            remap_references(value, &map);
        }
    }

    /// Every object the trailer reaches.
    fn reachable(&self) -> HashSet<ObjectId> {
        let mut reachable = HashSet::new();
        let mut queue: VecDeque<ObjectId> = VecDeque::new();
        for (_, value) in self.doc.trailer.iter() {
            collect_references(value, &mut queue);
        }
        while let Some(id) = queue.pop_front() {
            if !reachable.insert(id) {
                continue;
            }
            if let Ok(object) = self.doc.get_object(id) {
                collect_references(object, &mut queue);
            }
        }
        reachable
    }

    /// Drops every object that cannot be reached from the trailer.
    pub(crate) fn prune_unreachable(&mut self) {
        let reachable = self.reachable();
        self.doc.objects.retain(|id, _| reachable.contains(id));
    }

    /// Drops objects added since the file was opened that nothing reaches —
    /// another file's catalog and page tree, brought along by an insert — so
    /// an update does not carry them. What the file had stays as it was.
    fn drop_unreachable_additions(&mut self) {
        let reachable = self.reachable();
        let added: Vec<ObjectId> = self
            .doc
            .objects
            .keys()
            .copied()
            .filter(|id| self.is_addition(*id) && !reachable.contains(id))
            .collect();
        for id in added {
            self.doc.objects.remove(&id);
        }
    }
}

/// A new PDF made of every page of `inputs`, in order: Combine files.
///
/// Each input is opened with its password, if it has one, and the result is a
/// new, unprotected file written from scratch. The first file's catalog —
/// bookmarks, names, viewer preferences — is kept; the others bring their
/// pages, everything those use, and their form fields.
pub fn combine(inputs: Vec<(Vec<u8>, Option<String>)>) -> Result<Vec<u8>> {
    if inputs.len() < 2 {
        return Err(Error::Edit("choose at least two files to combine".into()));
    }
    let mut opened = Vec::with_capacity(inputs.len());
    for (bytes, password) in inputs {
        opened.push(PdfDocument::open(bytes, password.as_deref())?);
    }
    let mut out = opened[0].detached_copy();
    for other in &opened[1..] {
        out.append_document(other)?;
    }
    out.prune_unreachable();
    out.save_to_vec()
}

/// Every reference inside `object`, pushed onto `out`.
fn collect_references(object: &Object, out: &mut VecDeque<ObjectId>) {
    match object {
        Object::Reference(id) => out.push_back(*id),
        Object::Array(items) => items.iter().for_each(|o| collect_references(o, out)),
        Object::Dictionary(dict) => dict.iter().for_each(|(_, o)| collect_references(o, out)),
        Object::Stream(stream) => stream
            .dict
            .iter()
            .for_each(|(_, o)| collect_references(o, out)),
        _ => {}
    }
}

/// Rewrites references through `map`; a reference `map` does not know becomes
/// null, so nothing points at an object that is not there, or is another one.
fn remap_references(object: &mut Object, map: &HashMap<ObjectId, ObjectId>) {
    match object {
        Object::Reference(id) => match map.get(id) {
            Some(new) => *id = *new,
            None => *object = Object::Null,
        },
        Object::Array(items) => items.iter_mut().for_each(|o| remap_references(o, map)),
        Object::Dictionary(dict) => dict.iter_mut().for_each(|(_, o)| remap_references(o, map)),
        Object::Stream(stream) => stream
            .dict
            .iter_mut()
            .for_each(|(_, o)| remap_references(o, map)),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn corpus(name: &str) -> Vec<u8> {
        std::fs::read(format!(
            "{}/../../../tests/corpus/arabic/{name}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap()
    }

    /// Each page's content stream reference: a page's identity across changes.
    fn contents(doc: &PdfDocument) -> Vec<String> {
        (0..doc.page_count())
            .map(|i| {
                let page = doc.doc.get_dictionary(doc.page_id(i).unwrap()).unwrap();
                format!("{:?}", page.get(b"Contents").ok())
            })
            .collect()
    }

    fn reopen(doc: &mut PdfDocument) -> PdfDocument {
        let saved = doc.save_incremental().expect("an incremental save");
        assert!(
            saved.starts_with(doc.original_bytes()),
            "the opened bytes stay the prefix"
        );
        PdfDocument::open(saved, None).unwrap()
    }

    const THREE: &str = "generated/chrome-notonaskh-justified-3pages.pdf";

    #[test]
    fn rotating_a_page_turns_it_and_survives_a_save() {
        let mut doc = PdfDocument::open(corpus(THREE), None).unwrap();
        let (w, h) = doc.page_size(1).unwrap();
        doc.rotate_pages(&[1], 1).unwrap();
        assert_eq!(doc.page_rotation(1).unwrap(), 90);
        assert_eq!(doc.page_size(1).unwrap(), (h, w));
        doc.rotate_pages(&[1, 1], 3).unwrap(); // three more quarter turns; duplicates count once
        assert_eq!(doc.page_rotation(1).unwrap(), 0);
        doc.rotate_pages(&[0, 2], 2).unwrap();
        let back = reopen(&mut doc);
        let turns: Vec<i64> = (0..3).map(|i| back.page_rotation(i).unwrap()).collect();
        assert_eq!(turns, [180, 0, 180]);
    }

    #[test]
    fn reordering_moves_pages_and_survives_a_save() {
        let mut doc = PdfDocument::open(corpus(THREE), None).unwrap();
        let before = contents(&doc);
        doc.reorder_pages(&[2, 0, 1]).unwrap();
        let expected = vec![before[2].clone(), before[0].clone(), before[1].clone()];
        assert_eq!(contents(&doc), expected);
        assert_eq!(contents(&reopen(&mut doc)), expected);
        assert!(doc.reorder_pages(&[0, 0, 1]).is_err());
        assert!(doc.reorder_pages(&[0, 1]).is_err());
    }

    #[test]
    fn deleting_keeps_the_rest_in_order_and_never_the_last_page() {
        let mut doc = PdfDocument::open(corpus(THREE), None).unwrap();
        let before = contents(&doc);
        doc.delete_pages(&[1]).unwrap();
        assert_eq!(
            contents(&reopen(&mut doc)),
            vec![before[0].clone(), before[2].clone()]
        );
        assert!(doc.delete_pages(&[0, 1]).is_err(), "all pages");
        assert!(matches!(doc.delete_pages(&[7]), Err(Error::Page(7))));
    }

    #[test]
    fn a_blank_page_takes_its_neighbours_size() {
        let mut doc = PdfDocument::open(corpus(THREE), None).unwrap();
        let size = doc.page_size(0).unwrap();
        doc.insert_blank_page(1, 0).unwrap();
        let back = reopen(&mut doc);
        assert_eq!(back.page_count(), 4);
        assert_eq!(back.page_size(1).unwrap(), size);
        let blank = back.doc.get_dictionary(back.page_id(1).unwrap()).unwrap();
        assert!(!blank.has(b"Contents"));
        assert!(doc.insert_blank_page(9, 0).is_err());
    }

    #[test]
    fn a_nested_page_tree_is_flattened_with_the_attributes_its_pages_inherited() {
        // Distiller 5 hangs all 23 pages under intermediate /Pages nodes.
        let name =
            "realworld/G_wipo_saudi_copyright_law_laserwriter8_distiller5_legacy_encoding.pdf";
        let mut doc = PdfDocument::open(corpus(name), None).unwrap();
        let n = doc.page_count();
        assert_eq!(n, 23);
        let root = doc.pages_root().unwrap();
        let nested = (0..n)
            .filter(|&i| {
                let page = doc.doc.get_dictionary(doc.page_id(i).unwrap()).unwrap();
                page.get(b"Parent").unwrap().as_reference().unwrap() != root
            })
            .count();
        assert_eq!(nested, n, "the fixture must really be nested");
        let sizes: Vec<_> = (0..n).map(|i| doc.page_size(i).unwrap()).collect();
        let resources: Vec<_> = (0..n)
            .map(|i| {
                format!(
                    "{:?}",
                    doc.inherited_value(doc.page_id(i).unwrap(), b"Resources")
                )
            })
            .collect();
        let before = contents(&doc);
        doc.reorder_pages(&(0..n).rev().collect::<Vec<_>>())
            .unwrap();
        let back = reopen(&mut doc);
        assert_eq!(back.page_count(), n);
        assert_eq!(
            contents(&back),
            before.into_iter().rev().collect::<Vec<_>>()
        );
        let after: Vec<_> = (0..n).map(|i| back.page_size(i).unwrap()).collect();
        assert_eq!(after, sizes.into_iter().rev().collect::<Vec<_>>());
        let carried: Vec<_> = (0..n)
            .map(|i| {
                format!(
                    "{:?}",
                    back.inherited_value(back.page_id(i).unwrap(), b"Resources")
                )
            })
            .collect();
        assert_eq!(carried, resources.into_iter().rev().collect::<Vec<_>>());
    }

    #[test]
    fn extracting_writes_a_file_with_only_the_chosen_pages() {
        let doc = PdfDocument::open(corpus(THREE), None).unwrap();
        let before = contents(&doc);
        let bytes = doc.extract_pages(&[2, 0]).unwrap();
        let out = PdfDocument::open(bytes, None).unwrap();
        assert_eq!(out.page_count(), 2);
        // Nothing of the page left behind travels in the new file.
        let pages = out
            .doc
            .objects
            .values()
            .filter(|o| o.as_dict().map(|d| d.has_type(b"Page")).unwrap_or(false))
            .count();
        assert_eq!(pages, 2);
        let streams: HashSet<String> = contents(&out).into_iter().collect();
        assert_eq!(streams.len(), 2);
        assert_eq!(contents(&doc), before, "the source is untouched");
    }

    #[test]
    fn extracting_cuts_bookmarks_and_links_to_pages_left_behind() {
        let doc = PdfDocument::open(
            corpus("generated/variant-arabic-metadata-outlines-annots.pdf"),
            None,
        )
        .unwrap();
        let bytes = doc.extract_pages(&[0]).unwrap();
        let out = PdfDocument::open(bytes, None).unwrap();
        assert_eq!(out.page_count(), 1);
        let kept = out.page_id(0).unwrap();
        for object in out.doc.objects.values() {
            let mut refs = VecDeque::new();
            collect_references(object, &mut refs);
            for id in refs {
                let target = out.doc.get_object(id);
                assert!(target.is_ok(), "no reference may dangle: {id:?}");
                if let Ok(d) = target.unwrap().as_dict() {
                    if d.has_type(b"Page") {
                        assert_eq!(id, kept, "only the kept page may be referenced");
                    }
                }
            }
        }
    }

    #[test]
    fn combining_files_makes_one_unprotected_file_of_all_their_pages() {
        let three = corpus(THREE);
        let locked = corpus("generated/variant-encrypted-aes256.pdf");
        let bytes = combine(vec![(three.clone(), None), (locked, Some("warraq".into()))]).unwrap();
        let out = PdfDocument::open(bytes, None).unwrap();
        assert_eq!(out.page_count(), 6);
        assert!(!out.metadata().encrypted);
        assert!(
            combine(vec![(three.clone(), None)]).is_err(),
            "one file is not a combination"
        );
        let wrong = combine(vec![
            (three, None),
            (corpus("generated/variant-encrypted-aes256.pdf"), None),
        ]);
        assert!(matches!(wrong, Err(Error::Password)));
    }

    #[test]
    fn inserting_a_file_puts_its_pages_at_the_position_as_an_update() {
        let mut doc = PdfDocument::open(corpus(THREE), None).unwrap();
        let before = contents(&doc);
        let form =
            PdfDocument::open(corpus("generated/acroform-pdflib-arabic-fields.pdf"), None).unwrap();
        let theirs = form.page_count();
        assert_eq!(doc.insert_document(&form, 1).unwrap(), theirs);
        let after = contents(&doc);
        assert_eq!(after.len(), 3 + theirs);
        assert_eq!(after[0], before[0]);
        assert_eq!(after[1 + theirs..], before[1..]);
        // Only what the new pages use comes along, not the other file's catalog.
        let catalogs = doc
            .doc
            .objects
            .values()
            .filter(|o| {
                o.as_dict()
                    .ok()
                    .and_then(|d| d.get(b"Type").ok())
                    .and_then(|t| t.as_name().ok())
                    == Some(b"Catalog".as_slice())
            })
            .count();
        assert_eq!(catalogs, 1);
        let back = reopen(&mut doc);
        assert_eq!(back.page_count(), 3 + theirs);
        assert!(
            back.doc.catalog().unwrap().has(b"AcroForm"),
            "their fields join this file's form, in the update"
        );
        assert!(matches!(
            doc.insert_document(&form, 99),
            Err(Error::Page(99))
        ));
    }

    #[test]
    fn appending_a_document_brings_its_pages_and_form_fields() {
        let mut first = PdfDocument::open(corpus(THREE), None).unwrap();
        let form =
            PdfDocument::open(corpus("generated/acroform-pdflib-arabic-fields.pdf"), None).unwrap();
        let theirs = form.page_count();
        first.append_document(&form).unwrap();
        first.append_document(&form).unwrap(); // twice: names must not clash
        assert_eq!(first.page_count(), 3 + 2 * theirs);
        let bytes = first.save_to_vec().unwrap();
        let out = PdfDocument::open(bytes, None).unwrap();
        assert_eq!(out.page_count(), 3 + 2 * theirs);
        let fields = out
            .doc
            .catalog()
            .unwrap()
            .get(b"AcroForm")
            .ok()
            .and_then(|f| match f {
                Object::Reference(id) => out.doc.get_dictionary(*id).ok(),
                Object::Dictionary(d) => Some(d),
                _ => None,
            })
            .and_then(|f| f.get(b"Fields").ok())
            .and_then(|f| f.as_array().ok())
            .cloned()
            .unwrap_or_default();
        let names: Vec<Vec<u8>> = fields
            .iter()
            .filter_map(|f| f.as_reference().ok())
            .filter_map(|id| out.doc.get_dictionary(id).ok())
            .filter_map(|d| {
                d.get(b"T")
                    .ok()
                    .and_then(|t| t.as_str().ok())
                    .map(<[u8]>::to_vec)
            })
            .collect();
        assert!(!names.is_empty());
        let unique: HashSet<_> = names.iter().collect();
        assert_eq!(
            unique.len(),
            names.len(),
            "every field keeps a name of its own"
        );
    }
}
