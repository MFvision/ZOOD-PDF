//! The structure tree: reading an existing `/StructTreeRoot` into an editable model and writing it
//! back (changed elements only, `/ParentTree` rebuilt from the elements' marked-content references).
//!
//! Hostile input: the walk is iterative with a visited set (cycles and shared elements are kept as
//! opaque kids, never walked twice), bounded in depth ([`MAX_DEPTH`]), element count
//! ([`MAX_ELEMS`]) and kids per element ([`MAX_KIDS`]); a tree that hits a bound is `truncated` and
//! refuses to be written back (writing would drop what was not read).

use std::collections::{BTreeMap, HashMap, HashSet};

use lopdf::{Dictionary, Object, ObjectId, StringFormat};
use warraq_pdf::metadata::{decode_text, encode_text};
use warraq_pdf::{pages, Pdf};

use crate::error::{A11yError, Result};

/// Maximum structure elements read.
pub const MAX_ELEMS: usize = 200_000;
/// Maximum nesting depth read.
pub const MAX_DEPTH: usize = 128;
/// Maximum kids read per element.
pub const MAX_KIDS: usize = 100_000;
/// Largest MCID accepted in a parent tree array.
pub const MAX_MCID: i64 = 1_000_000;
/// Maximum `RoleMap` hops.
const MAX_ROLE_HOPS: usize = 16;

/// Standard structure types (ISO 32000-1 §14.8.4 and ISO 32000-2 additions).
pub const STANDARD_TYPES: &[&str] = &[
    "Document",
    "DocumentFragment",
    "Part",
    "Art",
    "Sect",
    "Div",
    "BlockQuote",
    "Caption",
    "TOC",
    "TOCI",
    "Index",
    "NonStruct",
    "Private",
    "Aside",
    "Title",
    "FENote",
    "P",
    "H",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "L",
    "LI",
    "Lbl",
    "LBody",
    "Table",
    "TR",
    "TH",
    "TD",
    "THead",
    "TBody",
    "TFoot",
    "Span",
    "Quote",
    "Note",
    "Reference",
    "BibEntry",
    "Code",
    "Link",
    "Annot",
    "Ruby",
    "RB",
    "RT",
    "RP",
    "Warichu",
    "WT",
    "WP",
    "Figure",
    "Formula",
    "Form",
    "Sub",
    "Em",
    "Strong",
    "Artifact",
];

/// A kid of a structure element.
#[derive(Debug, Clone, PartialEq)]
pub enum Kid {
    /// Another element (index into [`Tree::elems`]).
    Elem(usize),
    /// Marked content: MCID on a page (`page` None = the element's `/Pg`), optionally in a form
    /// XObject stream (`stm`).
    Mcr {
        mcid: i64,
        page: Option<ObjectId>,
        stm: Option<ObjectId>,
    },
    /// An object reference (annotation).
    Objr {
        obj: ObjectId,
        page: Option<ObjectId>,
    },
    /// Anything else (kept as read: cycles, shared elements, junk).
    Other(Object),
}

/// A structure element.
#[derive(Debug, Clone)]
pub struct Elem {
    /// Indirect object (None for a direct dictionary or a new element before writing).
    pub id: Option<ObjectId>,
    /// The dictionary as read (unmanaged keys are written back unchanged).
    pub dict: Dictionary,
    /// Structure type as written (`/S`).
    pub s: String,
    /// Parent element (None = the structure tree root).
    pub parent: Option<usize>,
    pub kids: Vec<Kid>,
    /// `/Pg`.
    pub page: Option<ObjectId>,
    pub alt: Option<String>,
    pub actual_text: Option<String>,
    pub lang: Option<String>,
    /// Changed since read: written back by [`Tree::write`].
    pub dirty: bool,
    /// Removed from the tree (never written, not referenced).
    pub removed: bool,
}

impl Elem {
    /// A new element.
    pub fn new(s: &str, parent: Option<usize>, page: Option<ObjectId>) -> Elem {
        Elem {
            id: None,
            dict: Dictionary::new(),
            s: s.to_string(),
            parent,
            kids: Vec::new(),
            page,
            alt: None,
            actual_text: None,
            lang: None,
            dirty: true,
            removed: false,
        }
    }

    /// MCIDs of this element (not of its children) with their pages.
    pub fn mcrs(&self) -> impl Iterator<Item = (i64, Option<ObjectId>, Option<ObjectId>)> + '_ {
        self.kids.iter().filter_map(|k| match k {
            Kid::Mcr { mcid, page, stm } => Some((*mcid, page.or(self.page), *stm)),
            _ => None,
        })
    }

    /// Child element indices.
    pub fn child_elems(&self) -> impl Iterator<Item = usize> + '_ {
        self.kids.iter().filter_map(|k| match k {
            Kid::Elem(i) => Some(*i),
            _ => None,
        })
    }

    /// `/A` attribute dictionaries (direct or array).
    pub fn attr(&self, pdf: &Pdf, owner: &[u8], key: &[u8]) -> Option<Object> {
        let a = self.dict.get(b"A").ok()?;
        let list: Vec<&Object> = match pdf.resolve(a)? {
            Object::Array(v) => v.iter().collect(),
            o => vec![o],
        };
        for item in list {
            if let Some(Object::Dictionary(d)) = pdf.resolve(item) {
                let o = d.get(b"O").ok().and_then(|o| o.as_name().ok());
                if o == Some(owner) {
                    if let Ok(v) = d.get(key) {
                        return pdf.resolve(v).cloned();
                    }
                }
            }
        }
        None
    }
}

/// The structure tree of a document.
#[derive(Debug, Clone, Default)]
pub struct Tree {
    /// `/StructTreeRoot` object (None: no tree yet).
    pub root: Option<ObjectId>,
    /// Root dictionary as read.
    pub root_dict: Dictionary,
    pub elems: Vec<Elem>,
    /// Root kids.
    pub top: Vec<usize>,
    /// `/RoleMap` (custom → mapped type).
    pub role_map: BTreeMap<String, String>,
    /// A bound was hit while reading.
    pub truncated: bool,
    /// Root dictionary (K, ParentTree) must be written.
    pub root_dirty: bool,
}

fn name_str(o: &Object) -> Option<String> {
    match o {
        Object::Name(n) => Some(String::from_utf8_lossy(n).into_owned()),
        _ => None,
    }
}

fn text_of(pdf: &Pdf, d: &Dictionary, key: &[u8]) -> Option<String> {
    match d.get(key).ok().and_then(|o| pdf.resolve(o)) {
        Some(Object::String(s, _)) => Some(decode_text(s)),
        _ => None,
    }
}

fn int_of(pdf: &Pdf, o: &Object) -> Option<i64> {
    match pdf.resolve(o)? {
        Object::Integer(i) => Some(*i),
        _ => None,
    }
}

fn ref_of(o: Option<&Object>) -> Option<ObjectId> {
    match o {
        Some(Object::Reference(id)) => Some(*id),
        _ => None,
    }
}

enum Source {
    Id(ObjectId),
    Direct(Dictionary),
}

impl Tree {
    /// Read the document's structure tree (an empty tree when there is none).
    pub fn read(pdf: &Pdf) -> Tree {
        let mut t = Tree::default();
        let Ok(cat) = pdf.catalog() else {
            return t;
        };
        let Some(root_obj) = cat.get(b"StructTreeRoot").ok() else {
            return t;
        };
        t.root = ref_of(Some(root_obj));
        let Some(Object::Dictionary(rd)) = pdf.resolve(root_obj) else {
            return t;
        };
        t.root_dict = rd.clone();
        if let Some(Object::Dictionary(rm)) = rd.get(b"RoleMap").ok().and_then(|o| pdf.resolve(o)) {
            for (k, v) in rm.iter().take(10_000) {
                if let Some(v) = pdf.resolve(v).and_then(name_str) {
                    t.role_map
                        .insert(String::from_utf8_lossy(k).into_owned(), v);
                }
            }
        }
        let mut seen: HashSet<ObjectId> = HashSet::new();
        if let Some(r) = t.root {
            seen.insert(r);
        }
        let mut queue: Vec<(Source, Option<usize>, usize)> = Vec::new();
        let root_kids = rd.get(b"K").ok().cloned();
        let mut top_items: Vec<Kid> = Vec::new();
        if let Some(k) = root_kids {
            t.kids_of(pdf, &k, None, 0, &mut seen, &mut queue, &mut top_items);
        }
        t.top = top_items
            .iter()
            .filter_map(|k| match k {
                Kid::Elem(i) => Some(*i),
                _ => None,
            })
            .collect();
        let mut qi = 0usize;
        while qi < queue.len() {
            let Some((src, _parent, depth)) = queue.get(qi) else {
                break;
            };
            let depth = *depth;
            let dict = match src {
                Source::Id(id) => pdf.get_dict(*id).cloned(),
                Source::Direct(d) => Some(d.clone()),
            };
            let idx = qi; // elements are allocated in queue order
            qi += 1;
            let Some(dict) = dict else { continue };
            if let Some(k) = dict.get(b"K").ok().cloned() {
                let mut items = Vec::new();
                t.kids_of(
                    pdf,
                    &k,
                    Some(idx),
                    depth + 1,
                    &mut seen,
                    &mut queue,
                    &mut items,
                );
                if let Some(e) = t.elems.get_mut(idx) {
                    e.kids = items;
                }
            }
        }
        t
    }

    /// Parse one `/K` value into kids, allocating child elements (queued for reading).
    #[allow(clippy::too_many_arguments)]
    fn kids_of(
        &mut self,
        pdf: &Pdf,
        k: &Object,
        parent: Option<usize>,
        depth: usize,
        seen: &mut HashSet<ObjectId>,
        queue: &mut Vec<(Source, Option<usize>, usize)>,
        out: &mut Vec<Kid>,
    ) {
        let items: Vec<Object> = match k {
            Object::Array(a) => a.iter().take(MAX_KIDS).cloned().collect(),
            o => match pdf.resolve(o) {
                Some(Object::Array(a))
                    if !matches!(o, Object::Array(_)) && ref_of(Some(o)).is_some() =>
                {
                    // A reference to an array of kids (unusual but seen).
                    a.iter().take(MAX_KIDS).cloned().collect()
                }
                _ => vec![o.clone()],
            },
        };
        if let Object::Array(a) = k {
            if a.len() > MAX_KIDS {
                self.truncated = true;
            }
        }
        for item in items {
            match &item {
                Object::Integer(m) => {
                    if (0..=MAX_MCID).contains(m) {
                        out.push(Kid::Mcr {
                            mcid: *m,
                            page: None,
                            stm: None,
                        });
                    } else {
                        out.push(Kid::Other(item.clone()));
                    }
                }
                Object::Reference(id) => {
                    let Some(Object::Dictionary(d)) = pdf.get(*id) else {
                        out.push(Kid::Other(item.clone()));
                        continue;
                    };
                    if let Some(kid) = marked_ref(pdf, d) {
                        out.push(kid);
                        continue;
                    }
                    if !d.has(b"S") {
                        out.push(Kid::Other(item.clone()));
                        continue;
                    }
                    if depth >= MAX_DEPTH || self.elems.len() >= MAX_ELEMS {
                        self.truncated = true;
                        out.push(Kid::Other(item.clone()));
                        continue;
                    }
                    if !seen.insert(*id) {
                        // Cycle or shared element: keep the reference, walk it once.
                        out.push(Kid::Other(item.clone()));
                        continue;
                    }
                    let idx = self.push_read(pdf, Some(*id), d, parent);
                    queue.push((Source::Id(*id), parent, depth));
                    out.push(Kid::Elem(idx));
                }
                Object::Dictionary(d) => {
                    if let Some(kid) = marked_ref(pdf, d) {
                        out.push(kid);
                        continue;
                    }
                    if !d.has(b"S") || depth >= MAX_DEPTH || self.elems.len() >= MAX_ELEMS {
                        if d.has(b"S") {
                            self.truncated = true;
                        }
                        out.push(Kid::Other(item.clone()));
                        continue;
                    }
                    let idx = self.push_read(pdf, None, d, parent);
                    queue.push((Source::Direct(d.clone()), parent, depth));
                    out.push(Kid::Elem(idx));
                }
                _ => out.push(Kid::Other(item.clone())),
            }
        }
    }

    fn push_read(
        &mut self,
        pdf: &Pdf,
        id: Option<ObjectId>,
        d: &Dictionary,
        parent: Option<usize>,
    ) -> usize {
        let s = d
            .get(b"S")
            .ok()
            .and_then(|o| pdf.resolve(o))
            .and_then(name_str)
            .unwrap_or_default();
        let e = Elem {
            id,
            dict: d.clone(),
            s,
            parent,
            kids: Vec::new(),
            page: ref_of(d.get(b"Pg").ok()),
            alt: text_of(pdf, d, b"Alt"),
            actual_text: text_of(pdf, d, b"ActualText"),
            lang: text_of(pdf, d, b"Lang"),
            dirty: false,
            removed: false,
        };
        self.elems.push(e);
        self.elems.len() - 1
    }

    /// Whether the document has a structure tree.
    pub fn exists(&self) -> bool {
        self.root.is_some() || !self.root_dict.is_empty()
    }

    /// Standard type of a structure type through the RoleMap (the type itself when standard or
    /// unmapped).
    pub fn std_role(&self, s: &str) -> String {
        let mut cur = s.to_string();
        for _ in 0..MAX_ROLE_HOPS {
            if STANDARD_TYPES.contains(&cur.as_str()) {
                return cur;
            }
            match self.role_map.get(&cur) {
                Some(n) if *n != cur => cur = n.clone(),
                _ => return cur,
            }
        }
        cur
    }

    /// Whether `s` maps to a standard type.
    pub fn is_standard(&self, s: &str) -> bool {
        STANDARD_TYPES.contains(&self.std_role(s).as_str())
    }

    /// Standard role of element `i`.
    pub fn role(&self, i: usize) -> String {
        self.elems
            .get(i)
            .map(|e| self.std_role(&e.s))
            .unwrap_or_default()
    }

    /// Elements in document (pre-)order with their depth, skipping removed ones.
    pub fn preorder(&self) -> Vec<(usize, usize)> {
        let mut out = Vec::new();
        let mut seen = vec![false; self.elems.len()];
        let mut stack: Vec<(usize, usize)> = self.top.iter().rev().map(|i| (*i, 0)).collect();
        while let Some((i, d)) = stack.pop() {
            let Some(e) = self.elems.get(i) else { continue };
            if e.removed || seen.get(i).copied().unwrap_or(true) {
                continue;
            }
            if let Some(s) = seen.get_mut(i) {
                *s = true;
            }
            out.push((i, d));
            for c in e.child_elems().collect::<Vec<_>>().into_iter().rev() {
                stack.push((c, d + 1));
            }
        }
        out
    }

    /// Index of the element written as object `num`.
    pub fn by_num(&self, num: u32) -> Option<usize> {
        self.elems
            .iter()
            .position(|e| !e.removed && e.id.map(|(n, _)| n) == Some(num))
    }

    /// Siblings list of element `i` (the root's kids for a top-level element).
    pub fn siblings(&self, i: usize) -> Vec<usize> {
        match self.elems.get(i).and_then(|e| e.parent) {
            Some(p) => self
                .elems
                .get(p)
                .map(|e| e.child_elems().collect())
                .unwrap_or_default(),
            None => self.top.clone(),
        }
    }

    /// Mark element `i` (or the root when None) as changed.
    pub fn touch(&mut self, i: Option<usize>) {
        match i {
            Some(i) => {
                if let Some(e) = self.elems.get_mut(i) {
                    e.dirty = true;
                }
            }
            None => self.root_dirty = true,
        }
    }

    /// Add a new element as the last kid of `parent` (the root when None).
    pub fn add(&mut self, mut e: Elem, parent: Option<usize>) -> usize {
        e.parent = parent;
        e.dirty = true;
        self.elems.push(e);
        let i = self.elems.len() - 1;
        match parent {
            Some(p) => {
                if let Some(pe) = self.elems.get_mut(p) {
                    pe.kids.push(Kid::Elem(i));
                    pe.dirty = true;
                }
            }
            None => {
                self.top.push(i);
                self.root_dirty = true;
            }
        }
        i
    }

    /// Remove element `i` and its subtree from the tree.
    pub fn remove(&mut self, i: usize) {
        let parent = self.elems.get(i).and_then(|e| e.parent);
        match parent {
            Some(p) => {
                if let Some(pe) = self.elems.get_mut(p) {
                    pe.kids.retain(|k| *k != Kid::Elem(i));
                    pe.dirty = true;
                }
            }
            None => {
                self.top.retain(|x| *x != i);
                self.root_dirty = true;
            }
        }
        let mut stack = vec![i];
        let mut n = 0usize;
        while let Some(x) = stack.pop() {
            n += 1;
            if n > MAX_ELEMS {
                break;
            }
            if let Some(e) = self.elems.get_mut(x) {
                if e.removed {
                    continue;
                }
                e.removed = true;
                stack.extend(e.child_elems().collect::<Vec<_>>());
            }
        }
        self.root_dirty = true;
    }

    /// Every (page object, MCID) referenced by the tree (page content only, not form streams).
    pub fn page_mcids(&self) -> HashMap<ObjectId, HashSet<i64>> {
        let mut out: HashMap<ObjectId, HashSet<i64>> = HashMap::new();
        for (i, _) in self.preorder() {
            if let Some(e) = self.elems.get(i) {
                for (mcid, page, stm) in e.mcrs() {
                    if let (Some(p), None) = (page, stm) {
                        out.entry(p).or_default().insert(mcid);
                    }
                }
            }
        }
        out
    }

    /// Annotation objects referenced by OBJR kids.
    pub fn objrs(&self) -> HashSet<ObjectId> {
        let mut out = HashSet::new();
        for (i, _) in self.preorder() {
            if let Some(e) = self.elems.get(i) {
                for k in &e.kids {
                    if let Kid::Objr { obj, .. } = k {
                        out.insert(*obj);
                    }
                }
            }
        }
        out
    }

    /// Write changed elements, the root and a rebuilt `/ParentTree`; sets `/StructTreeRoot` in the
    /// catalog. Pages and annotations that gain marked content get `/StructParents` /
    /// `/StructParent` keys.
    pub fn write(&mut self, pdf: &mut Pdf) -> Result<()> {
        if self.truncated {
            return Err(A11yError::Limit(
                "the structure tree is too large or too deep to be rewritten".into(),
            ));
        }
        let order = self.preorder();
        // 1. Object ids for every live element (direct or new ones become indirect).
        let root_id = match self.root {
            Some(r) if pdf.get(r).is_some() => r,
            _ => {
                let r = pdf.add(Object::Null);
                self.root = Some(r);
                self.root_dirty = true;
                r
            }
        };
        for &(i, _) in &order {
            let needs = self.elems.get(i).is_some_and(|e| e.id.is_none());
            if needs {
                let id = pdf.add(Object::Null);
                let parent = self.elems.get(i).and_then(|e| e.parent);
                if let Some(e) = self.elems.get_mut(i) {
                    e.id = Some(id);
                    e.dirty = true;
                }
                self.touch(parent);
            }
        }
        // 2. Changed elements.
        for &(i, _) in &order {
            let Some(e) = self.elems.get(i) else { continue };
            if !e.dirty {
                continue;
            }
            let Some(id) = e.id else { continue };
            let parent_id = match e.parent {
                Some(p) => self.elems.get(p).and_then(|pe| pe.id).unwrap_or(root_id),
                None => root_id,
            };
            let mut d = e.dict.clone();
            d.set("Type", Object::Name(b"StructElem".to_vec()));
            d.set("S", Object::Name(e.s.as_bytes().to_vec()));
            d.set("P", Object::Reference(parent_id));
            match e.page {
                Some(p) => d.set("Pg", Object::Reference(p)),
                None => {
                    d.remove(b"Pg");
                }
            }
            let mut k: Vec<Object> = Vec::with_capacity(e.kids.len());
            for kid in &e.kids {
                match kid {
                    Kid::Elem(c) => {
                        if let Some(cid) =
                            self.elems.get(*c).filter(|x| !x.removed).and_then(|x| x.id)
                        {
                            k.push(Object::Reference(cid));
                        }
                    }
                    Kid::Mcr { mcid, page, stm } => {
                        let own_page = page.is_none() || *page == e.page;
                        if own_page && stm.is_none() && e.page.is_some() {
                            k.push(Object::Integer(*mcid));
                        } else {
                            let mut m = Dictionary::new();
                            m.set("Type", Object::Name(b"MCR".to_vec()));
                            if let Some(p) = page.or(e.page) {
                                m.set("Pg", Object::Reference(p));
                            }
                            if let Some(s) = stm {
                                m.set("Stm", Object::Reference(*s));
                            }
                            m.set("MCID", Object::Integer(*mcid));
                            k.push(Object::Dictionary(m));
                        }
                    }
                    Kid::Objr { obj, page } => {
                        let mut m = Dictionary::new();
                        m.set("Type", Object::Name(b"OBJR".to_vec()));
                        if let Some(p) = page.or(e.page) {
                            m.set("Pg", Object::Reference(p));
                        }
                        m.set("Obj", Object::Reference(*obj));
                        k.push(Object::Dictionary(m));
                    }
                    Kid::Other(o) => k.push(o.clone()),
                }
            }
            d.set("K", Object::Array(k));
            set_text(&mut d, "Alt", e.alt.as_deref());
            set_text(&mut d, "ActualText", e.actual_text.as_deref());
            match e.lang.as_deref() {
                Some(l) if !l.is_empty() => d.set(
                    "Lang",
                    Object::String(l.as_bytes().to_vec(), StringFormat::Literal),
                ),
                _ => {
                    d.remove(b"Lang");
                }
            }
            pdf.set(id, Object::Dictionary(d));
        }
        for e in &mut self.elems {
            e.dirty = false;
        }
        // 3. Root with a rebuilt parent tree.
        let (nums, next_key) = self.parent_tree(pdf)?;
        let mut rd = self.root_dict.clone();
        rd.set("Type", Object::Name(b"StructTreeRoot".to_vec()));
        let top: Vec<Object> = self
            .top
            .iter()
            .filter_map(|i| self.elems.get(*i).filter(|e| !e.removed).and_then(|e| e.id))
            .map(Object::Reference)
            .collect();
        rd.set("K", Object::Array(top));
        let mut pt = Dictionary::new();
        pt.set("Nums", Object::Array(nums));
        let pt_id = pdf.add(Object::Dictionary(pt));
        rd.set("ParentTree", Object::Reference(pt_id));
        rd.set("ParentTreeNextKey", Object::Integer(next_key));
        if !self.role_map.is_empty() {
            let mut rm = Dictionary::new();
            for (k, v) in &self.role_map {
                rm.set(k.as_bytes().to_vec(), Object::Name(v.as_bytes().to_vec()));
            }
            rd.set("RoleMap", Object::Dictionary(rm));
        }
        rd.remove(b"IDTree"); // element ids may have changed hands; readers do not need it
        self.root_dict = rd.clone();
        pdf.set(root_id, Object::Dictionary(rd));
        self.root_dirty = false;
        let cat_id = pdf.root_id()?;
        let mut cat = pdf.catalog()?.clone();
        if ref_of(cat.get(b"StructTreeRoot").ok()) != Some(root_id) {
            cat.set("StructTreeRoot", Object::Reference(root_id));
            pdf.set(cat_id, Object::Dictionary(cat));
        }
        Ok(())
    }

    /// The `/Nums` array of a parent tree built from the live elements, and the next free key.
    /// Assigns `/StructParents` to pages (and form streams) and `/StructParent` to annotations
    /// that need one.
    fn parent_tree(&self, pdf: &mut Pdf) -> Result<(Vec<Object>, i64)> {
        let order = self.preorder();
        // MCID arrays per content holder (page or form stream) and OBJR owners.
        let mut per_holder: BTreeMap<ObjectId, BTreeMap<i64, ObjectId>> = BTreeMap::new();
        let mut objr: Vec<(ObjectId, ObjectId)> = Vec::new();
        for &(i, _) in &order {
            let Some(e) = self.elems.get(i) else { continue };
            let Some(eid) = e.id else { continue };
            for k in &e.kids {
                match k {
                    Kid::Mcr { mcid, page, stm } => {
                        let holder = match stm {
                            Some(s) => Some(*s),
                            None => page.or(e.page),
                        };
                        if let Some(h) = holder {
                            per_holder.entry(h).or_default().entry(*mcid).or_insert(eid);
                        }
                    }
                    Kid::Objr { obj, .. } => objr.push((*obj, eid)),
                    _ => {}
                }
            }
        }
        // Existing keys.
        let key_of = |pdf: &Pdf, id: ObjectId, key: &[u8]| -> Option<i64> {
            let d: Option<&Dictionary> = match pdf.get(id)? {
                Object::Dictionary(d) => Some(d),
                Object::Stream(s) => Some(&s.dict),
                _ => None,
            };
            d.and_then(|d| d.get(key).ok()).and_then(|o| int_of(pdf, o))
        };
        let mut used: BTreeMap<i64, ()> = BTreeMap::new();
        let mut entries: BTreeMap<i64, Object> = BTreeMap::new();
        let mut pending_holders: Vec<(ObjectId, Object)> = Vec::new();
        let mut pending_objr: Vec<(ObjectId, ObjectId)> = Vec::new();
        for (h, mcids) in &per_holder {
            let arr_len = mcids.keys().next_back().map_or(0, |m| m + 1);
            let mut arr = vec![Object::Null; usize::try_from(arr_len).unwrap_or(0)];
            for (m, e) in mcids {
                if let Some(slot) = usize::try_from(*m).ok().and_then(|m| arr.get_mut(m)) {
                    *slot = Object::Reference(*e);
                }
            }
            let arr = Object::Array(arr);
            match key_of(pdf, *h, b"StructParents") {
                Some(k) if k >= 0 && !used.contains_key(&k) => {
                    used.insert(k, ());
                    entries.insert(k, arr);
                }
                _ => pending_holders.push((*h, arr)),
            }
        }
        for (obj, e) in &objr {
            match key_of(pdf, *obj, b"StructParent") {
                Some(k) if k >= 0 && !used.contains_key(&k) => {
                    used.insert(k, ());
                    entries.insert(k, Object::Reference(*e));
                }
                _ => pending_objr.push((*obj, *e)),
            }
        }
        // Pages that are tagged but have no MCIDs keep their key with an empty array.
        if let Ok(list) = pages::flatten(pdf) {
            for p in list {
                if per_holder.contains_key(&p.id) {
                    continue;
                }
                if let Some(k) = key_of(pdf, p.id, b"StructParents") {
                    if k >= 0 && !used.contains_key(&k) {
                        used.insert(k, ());
                        entries.insert(k, Object::Array(Vec::new()));
                    }
                }
            }
        }
        let mut next = used.keys().next_back().map_or(0, |k| k + 1);
        for (h, arr) in pending_holders {
            let k = next;
            next += 1;
            entries.insert(k, arr);
            set_int_key(pdf, h, "StructParents", k);
        }
        for (obj, e) in pending_objr {
            let k = next;
            next += 1;
            entries.insert(k, Object::Reference(e));
            set_int_key(pdf, obj, "StructParent", k);
        }
        let mut nums = Vec::with_capacity(entries.len() * 2);
        for (k, v) in entries {
            nums.push(Object::Integer(k));
            nums.push(v);
        }
        Ok((nums, next))
    }
}

fn set_text(d: &mut Dictionary, key: &str, v: Option<&str>) {
    match v {
        Some(s) if !s.is_empty() => d.set(key, encode_text(s)),
        _ => {
            d.remove(key.as_bytes());
        }
    }
}

/// Set an integer key on a dictionary or stream object.
pub fn set_int_key(pdf: &mut Pdf, id: ObjectId, key: &str, v: i64) {
    match pdf.get(id).cloned() {
        Some(Object::Dictionary(mut d)) => {
            d.set(key, Object::Integer(v));
            pdf.set(id, Object::Dictionary(d));
        }
        Some(Object::Stream(mut s)) => {
            s.dict.set(key, Object::Integer(v));
            pdf.set(id, Object::Stream(s));
        }
        _ => {}
    }
}

/// An `MCR` or `OBJR` dictionary as a kid.
fn marked_ref(pdf: &Pdf, d: &Dictionary) -> Option<Kid> {
    let ty = d
        .get(b"Type")
        .ok()
        .and_then(|o| pdf.resolve(o))
        .and_then(name_str);
    match ty.as_deref() {
        Some("MCR") => {
            let mcid = d.get(b"MCID").ok().and_then(|o| int_of(pdf, o))?;
            if !(0..=MAX_MCID).contains(&mcid) {
                return None;
            }
            Some(Kid::Mcr {
                mcid,
                page: ref_of(d.get(b"Pg").ok()),
                stm: ref_of(d.get(b"Stm").ok()),
            })
        }
        Some("OBJR") => Some(Kid::Objr {
            obj: ref_of(d.get(b"Obj").ok())?,
            page: ref_of(d.get(b"Pg").ok()),
        }),
        _ => None,
    }
}
