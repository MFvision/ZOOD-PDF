//! Remove hidden information: what a file carries besides the pages as they
//! look — its metadata, scripts, attachments, comments, form data, layers
//! that are switched off, bookmarks, thumbnails, applications' private data,
//! links and text nobody can see — reported, and removed on request.
//!
//! Removal is a new file written whole, like an applied redaction: objects
//! nothing refers to any longer are dropped, and the file's earlier
//! revisions — which an incremental update would keep, readable, before the
//! new one — are not written at all.
//!
//! Every loop here is bounded by what the file holds (objects, pages, the
//! operators of a content stream), and every stream is decoded against a
//! limit: the file is treated as hostile.
use std::collections::{BTreeSet, HashSet};

use lopdf::content::{Content, Operation};
use lopdf::{Dictionary, Object, ObjectId, Stream, StringFormat};

use crate::document::decode_text_string;
use crate::text_walk::Matrix;
use crate::{Error, PdfDocument, Result};

/// What a file can carry that is not on its pages as they look.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Hidden {
    /// The document information dictionary and XMP metadata streams.
    Metadata,
    /// Document JavaScript, the action run on opening, automatic actions
    /// (`/AA`) and actions that run, launch, submit or import.
    Scripts,
    /// Embedded files: the `EmbeddedFiles` name tree, file attachment
    /// annotations and associated files (`/AF`).
    Attachments,
    /// Comments and markup: every annotation but form fields, links and
    /// attached files.
    Comments,
    /// Form fields: their values, names and scripts. Each field's appearance
    /// is drawn into the page, so the page looks as it did.
    Forms,
    /// Layers (optional content) that are switched off, and what they draw.
    HiddenLayers,
    Bookmarks,
    /// Page thumbnails (`/Thumb`).
    Thumbnails,
    /// Applications' private data (`/PieceInfo`).
    PrivateData,
    /// Link annotations, and web addresses in bookmarks.
    Links,
    /// Text drawn invisibly (render mode 3 or 7, as an OCR text layer is), in
    /// white, or off the page.
    HiddenText,
}

impl Hidden {
    pub const ALL: [Hidden; 11] = [
        Hidden::Metadata,
        Hidden::Scripts,
        Hidden::Attachments,
        Hidden::Comments,
        Hidden::Forms,
        Hidden::HiddenLayers,
        Hidden::Bookmarks,
        Hidden::Thumbnails,
        Hidden::PrivateData,
        Hidden::Links,
        Hidden::HiddenText,
    ];

    /// The name the interface uses.
    pub fn key(self) -> &'static str {
        match self {
            Hidden::Metadata => "metadata",
            Hidden::Scripts => "scripts",
            Hidden::Attachments => "attachments",
            Hidden::Comments => "comments",
            Hidden::Forms => "forms",
            Hidden::HiddenLayers => "hiddenLayers",
            Hidden::Bookmarks => "bookmarks",
            Hidden::Thumbnails => "thumbnails",
            Hidden::PrivateData => "privateData",
            Hidden::Links => "links",
            Hidden::HiddenText => "hiddenText",
        }
    }

    pub fn from_key(key: &str) -> Option<Hidden> {
        Hidden::ALL.into_iter().find(|h| h.key() == key)
    }
}

/// One kind of hidden information the file carries.
#[derive(Debug, Clone, PartialEq)]
pub struct Finding {
    pub kind: Hidden,
    /// How many: entries, annotations, layers, runs of text.
    pub count: usize,
    /// What they are, a line each, for a person to read (at most a few).
    pub details: Vec<String>,
}

/// What `hidden_report` found.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct HiddenReport {
    /// Only the kinds the file has.
    pub findings: Vec<Finding>,
    /// Earlier revisions kept before the current one (incremental updates).
    pub revisions: usize,
    /// Objects in the file that nothing refers to: deleted, but still there.
    pub unreachable: usize,
    /// A digital signature, which a file written whole no longer satisfies.
    pub signed: bool,
    /// Password-protected: removal is refused, as the copy would lose it.
    pub protected: bool,
}

/// Lines of detail kept per kind.
const MAX_DETAILS: usize = 12;
/// The most a content stream may decode to here.
const MAX_CONTENT: usize = 64 << 20;
/// The deepest nesting followed through direct objects, name trees and the like.
const MAX_DEPTH: usize = 64;
/// The most entries read from a name tree or an outline.
const MAX_ENTRIES: usize = 100_000;

/// Actions that do something beyond moving within the document or to a web
/// address: they run, launch, submit, import or play.
const ACTIVE_ACTIONS: &[&[u8]] = &[
    b"JavaScript",
    b"Launch",
    b"SubmitForm",
    b"ImportData",
    b"ResetForm",
    b"Rendition",
    b"Sound",
    b"Movie",
    b"RichMediaExecute",
    b"GoTo3DView",
    b"Hide",
    b"SetOCGState",
    b"Trans",
    b"GoToE",
];

fn truncate(s: &str, n: usize) -> String {
    let t: String = s.chars().take(n).collect();
    if s.chars().count() > n {
        format!("{t}…")
    } else {
        t
    }
}

fn name_of(o: Option<&Object>) -> Option<&[u8]> {
    o.and_then(|o| o.as_name().ok())
}

/// Calls `f` on every dictionary in `object`, its own and those nested in it
/// directly (not through references), to a bounded depth.
fn visit_dicts(object: &Object, depth: usize, f: &mut dyn FnMut(&Dictionary)) {
    if depth > MAX_DEPTH {
        return;
    }
    match object {
        Object::Dictionary(d) => {
            f(d);
            d.iter().for_each(|(_, v)| visit_dicts(v, depth + 1, f));
        }
        Object::Stream(s) => {
            f(&s.dict);
            s.dict
                .iter()
                .for_each(|(_, v)| visit_dicts(v, depth + 1, f));
        }
        Object::Array(a) => a.iter().for_each(|v| visit_dicts(v, depth + 1, f)),
        _ => {}
    }
}

/// `visit_dicts`, allowed to change what it visits.
fn visit_dicts_mut(object: &mut Object, depth: usize, f: &mut dyn FnMut(&mut Dictionary)) {
    if depth > MAX_DEPTH {
        return;
    }
    match object {
        Object::Dictionary(d) => {
            f(d);
            d.iter_mut()
                .for_each(|(_, v)| visit_dicts_mut(v, depth + 1, f));
        }
        Object::Stream(s) => {
            f(&mut s.dict);
            s.dict
                .iter_mut()
                .for_each(|(_, v)| visit_dicts_mut(v, depth + 1, f));
        }
        Object::Array(a) => a.iter_mut().for_each(|v| visit_dicts_mut(v, depth + 1, f)),
        _ => {}
    }
}

/// Earlier revisions of a file: one per end-of-file marker after the first,
/// less the one a linearized file has for its first page.
pub fn earlier_revisions(bytes: &[u8]) -> usize {
    let eofs = bytes.windows(5).filter(|w| w == b"%%EOF").count();
    let head = &bytes[..bytes.len().min(1024)];
    let linearized = head.windows(11).any(|w| w == b"/Linearized");
    eofs.saturating_sub(1 + usize::from(linearized && eofs > 1))
}

impl PdfDocument {
    fn deref<'a>(&'a self, o: &'a Object) -> Option<&'a Object> {
        self.doc.dereference(o).ok().map(|(_, o)| o)
    }

    fn resolve_dict<'a>(&'a self, o: Option<&'a Object>) -> Option<&'a Dictionary> {
        self.deref(o?)?.as_dict().ok()
    }

    /// Every (key, value) of a name tree, in order, bounded.
    pub(crate) fn name_tree_entries(&self, root: &Dictionary) -> Vec<(Vec<u8>, Object)> {
        let mut out = vec![];
        let mut seen: HashSet<ObjectId> = HashSet::new();
        let mut stack: Vec<(&Dictionary, usize)> = vec![(root, 0)];
        while let Some((node, depth)) = stack.pop() {
            if depth > MAX_DEPTH || out.len() > MAX_ENTRIES {
                break;
            }
            if let Some(Ok(names)) = node
                .get(b"Names")
                .ok()
                .and_then(|o| self.deref(o))
                .map(|o| o.as_array())
            {
                for pair in names.chunks(2) {
                    if let [key, value] = pair {
                        if let Ok(k) = key.as_str() {
                            out.push((k.to_vec(), value.clone()));
                        }
                    }
                }
            }
            if let Ok(kids) = node.get(b"Kids").and_then(|o| o.as_array()) {
                // Pushed in reverse, so the kids are read in order.
                for kid in kids.iter().rev() {
                    if let Ok(id) = kid.as_reference() {
                        if !seen.insert(id) {
                            continue;
                        }
                    }
                    if let Some(d) = self.deref(kid).and_then(|o| o.as_dict().ok()) {
                        stack.push((d, depth + 1));
                    }
                }
            }
        }
        out
    }

    /// The catalog's `/Names` entry `key`, as a name tree root.
    pub(crate) fn names_root(&self, key: &[u8]) -> Option<&Dictionary> {
        let catalog = self.doc.catalog().ok()?;
        let names = self.resolve_dict(catalog.get(b"Names").ok())?;
        self.resolve_dict(names.get(key).ok())
    }

    /// The annotations of page `page_id`, resolved, with the id of each one
    /// that is its own object.
    pub(crate) fn page_annotations(
        &self,
        page_id: ObjectId,
    ) -> Vec<(Option<ObjectId>, &Dictionary)> {
        let Ok(page) = self.doc.get_dictionary(page_id) else {
            return vec![];
        };
        let Some(Ok(annots)) = page
            .get(b"Annots")
            .ok()
            .and_then(|o| self.deref(o))
            .map(|o| o.as_array())
        else {
            return vec![];
        };
        annots
            .iter()
            .filter_map(|a| {
                let id = a.as_reference().ok();
                self.deref(a)
                    .and_then(|o| o.as_dict().ok())
                    .map(|d| (id, d))
            })
            .collect()
    }

    /// Layers switched off in the default configuration (`/D`).
    pub(crate) fn off_layers(&self) -> BTreeSet<ObjectId> {
        let mut off = BTreeSet::new();
        let Ok(catalog) = self.doc.catalog() else {
            return off;
        };
        let Some(props) = self.resolve_dict(catalog.get(b"OCProperties").ok()) else {
            return off;
        };
        let all: Vec<ObjectId> = props
            .get(b"OCGs")
            .ok()
            .and_then(|o| self.deref(o))
            .and_then(|o| o.as_array().ok())
            .map(|a| a.iter().filter_map(|o| o.as_reference().ok()).collect())
            .unwrap_or_default();
        let Some(config) = self.resolve_dict(props.get(b"D").ok()) else {
            return off;
        };
        let ids = |key: &[u8]| -> Vec<ObjectId> {
            config
                .get(key)
                .ok()
                .and_then(|o| self.deref(o))
                .and_then(|o| o.as_array().ok())
                .map(|a| a.iter().filter_map(|o| o.as_reference().ok()).collect())
                .unwrap_or_default()
        };
        if name_of(config.get(b"BaseState").ok()) == Some(b"OFF") {
            off.extend(all.iter().copied());
        }
        for id in ids(b"ON") {
            off.remove(&id);
        }
        off.extend(ids(b"OFF"));
        off
    }

    /// The name of a layer, as a person reads it.
    pub(crate) fn layer_name(&self, id: ObjectId) -> String {
        self.doc
            .get_dictionary(id)
            .ok()
            .and_then(|d| d.get(b"Name").ok())
            .and_then(|o| self.deref(o))
            .and_then(|o| o.as_str().ok())
            .map(decode_text_string)
            .unwrap_or_default()
    }

    /// What this file carries besides its pages as they look.
    pub fn hidden_report(&self) -> HiddenReport {
        let mut report = HiddenReport {
            revisions: earlier_revisions(self.original_bytes()),
            protected: self.was_encrypted,
            signed: self.compress_refusal() == Some(crate::Refusal::Signed),
            ..Default::default()
        };
        let reachable = self.reachable_ids();
        report.unreachable = self
            .doc
            .objects
            .keys()
            .filter(|id| !reachable.contains(id))
            .count();

        let mut add = |kind: Hidden, count: usize, details: Vec<String>| {
            if count > 0 {
                report.findings.push(Finding {
                    kind,
                    count,
                    details: details.into_iter().take(MAX_DETAILS).collect(),
                });
            }
        };
        let catalog = self.doc.catalog().ok();

        // Metadata: the information dictionary, and XMP wherever it is.
        let mut details = vec![];
        if let Some(info) = self.resolve_dict(self.doc.trailer.get(b"Info").ok()) {
            for (key, value) in info.iter() {
                let text = self
                    .deref(value)
                    .and_then(|v| v.as_str().ok())
                    .map(decode_text_string)
                    .unwrap_or_default();
                if !text.trim().is_empty() {
                    details.push(format!(
                        "{}: {}",
                        String::from_utf8_lossy(key),
                        truncate(text.trim(), 80)
                    ));
                }
            }
        }
        let mut xmp: HashSet<ObjectId> = HashSet::new();
        for object in self.doc.objects.values() {
            visit_dicts(object, 0, &mut |d| {
                if let Ok(id) = d.get(b"Metadata").and_then(|o| o.as_reference()) {
                    xmp.insert(id);
                }
            });
        }
        if !xmp.is_empty() {
            details.push(format!("XMP ({})", xmp.len()));
        }
        add(Hidden::Metadata, details.len(), details);

        // Scripts and actions.
        let js = self
            .names_root(b"JavaScript")
            .map(|root| self.name_tree_entries(root).len())
            .unwrap_or(0);
        let opens = catalog.is_some_and(|c| c.has(b"OpenAction"));
        let (mut automatic, mut active) = (0usize, 0usize);
        for object in self.doc.objects.values() {
            visit_dicts(object, 0, &mut |d| {
                if d.has(b"AA") {
                    automatic += 1;
                }
                if let Some(action) = d.get(b"A").ok().and_then(|a| a.as_dict().ok()) {
                    if name_of(action.get(b"S").ok()).is_some_and(|s| ACTIVE_ACTIONS.contains(&s)) {
                        active += 1;
                    }
                }
            });
        }
        // An `/A` held as its own object is counted where it is.
        for object in self.doc.objects.values() {
            if let Ok(d) = object.as_dict() {
                if d.has_type(b"Action")
                    && name_of(d.get(b"S").ok()).is_some_and(|s| ACTIVE_ACTIONS.contains(&s))
                {
                    active += 1;
                }
            }
        }
        let mut details = vec![];
        if js > 0 {
            details.push(format!("JavaScript ({js})"));
        }
        if opens {
            details.push("OpenAction".into());
        }
        if automatic > 0 {
            details.push(format!("AA ({automatic})"));
        }
        if active > 0 {
            details.push(format!("Actions ({active})"));
        }
        add(
            Hidden::Scripts,
            js + usize::from(opens) + automatic + active,
            details,
        );

        // Attachments, comments, links and form fields: from the annotations.
        let mut attached: Vec<String> = self
            .names_root(b"EmbeddedFiles")
            .map(|root| {
                self.name_tree_entries(root)
                    .into_iter()
                    .map(|(k, _)| decode_text_string(&k))
                    .collect()
            })
            .unwrap_or_default();
        let mut comments: std::collections::BTreeMap<String, usize> = Default::default();
        let (mut links, mut widgets) = (0usize, 0usize);
        let mut uris = vec![];
        for &page in &self.pages {
            for (_, annot) in self.page_annotations(page) {
                let subtype = name_of(annot.get(b"Subtype").ok()).unwrap_or(b"");
                match subtype {
                    b"Widget" => widgets += 1,
                    b"Link" => {
                        links += 1;
                        if let Some(uri) = self
                            .resolve_dict(annot.get(b"A").ok())
                            .and_then(|a| a.get(b"URI").ok())
                            .and_then(|u| self.deref(u))
                            .and_then(|u| u.as_str().ok())
                        {
                            uris.push(truncate(&String::from_utf8_lossy(uri), 80));
                        }
                    }
                    other => {
                        if other == b"FileAttachment" {
                            let name = self
                                .resolve_dict(annot.get(b"FS").ok())
                                .and_then(|fs| fs.get(b"UF").or_else(|_| fs.get(b"F")).ok())
                                .and_then(|n| self.deref(n))
                                .and_then(|n| n.as_str().ok())
                                .map(decode_text_string)
                                .unwrap_or_default();
                            attached.push(name);
                            continue;
                        }
                        *comments
                            .entry(String::from_utf8_lossy(other).into_owned())
                            .or_default() += 1;
                    }
                }
            }
        }
        add(Hidden::Attachments, attached.len(), attached);
        let count = comments.values().sum();
        add(
            Hidden::Comments,
            count,
            comments
                .into_iter()
                .map(|(k, n)| format!("{k} ({n})"))
                .collect(),
        );
        let acroform = catalog.and_then(|c| self.resolve_dict(c.get(b"AcroForm").ok()));
        let xfa = acroform.is_some_and(|f| f.has(b"XFA"));
        let mut details = vec![];
        if widgets > 0 {
            details.push(format!("Fields ({widgets})"));
        }
        if xfa {
            details.push("XFA".into());
        }
        add(Hidden::Forms, widgets + usize::from(xfa), details);

        let off: Vec<String> = self
            .off_layers()
            .into_iter()
            .map(|id| self.layer_name(id))
            .collect();
        add(Hidden::HiddenLayers, off.len(), off);

        let bookmarks = self.outline_count();
        add(Hidden::Bookmarks, bookmarks, vec![]);

        let thumbs = self
            .pages
            .iter()
            .filter(|&&p| self.doc.get_dictionary(p).is_ok_and(|d| d.has(b"Thumb")))
            .count();
        add(Hidden::Thumbnails, thumbs, vec![]);

        let mut pieces = 0usize;
        for object in self.doc.objects.values() {
            visit_dicts(object, 0, &mut |d| {
                if d.has(b"PieceInfo") {
                    pieces += 1;
                }
            });
        }
        add(Hidden::PrivateData, pieces, vec![]);

        add(Hidden::Links, links, uris);

        let (mut invisible, mut white, mut off_page) = (0usize, 0usize, 0usize);
        for index in 0..self.pages.len() {
            if let Some(runs) = self.hidden_runs(index) {
                for run in runs {
                    match run.reason {
                        Reason::Invisible => invisible += 1,
                        Reason::White => white += 1,
                        Reason::OffPage => off_page += 1,
                    }
                }
            }
        }
        let mut details = vec![];
        if invisible > 0 {
            details.push(format!("invisible ({invisible})"));
        }
        if white > 0 {
            details.push(format!("white ({white})"));
        }
        if off_page > 0 {
            details.push(format!("offPage ({off_page})"));
        }
        add(Hidden::HiddenText, invisible + white + off_page, details);
        report
    }

    /// Every object the trailer reaches, bounded by the file's own objects.
    pub(crate) fn reachable_ids(&self) -> HashSet<ObjectId> {
        let mut reachable = HashSet::new();
        let mut queue: Vec<ObjectId> = vec![];
        let push_refs = |o: &Object, q: &mut Vec<ObjectId>| collect_refs(o, q, 0);
        for (_, value) in self.doc.trailer.iter() {
            push_refs(value, &mut queue);
        }
        while let Some(id) = queue.pop() {
            if !reachable.insert(id) {
                continue;
            }
            if let Ok(object) = self.doc.get_object(id) {
                push_refs(object, &mut queue);
            }
        }
        reachable
    }

    /// How many bookmarks the outline holds, bounded.
    fn outline_count(&self) -> usize {
        let Some(outlines) = self
            .doc
            .catalog()
            .ok()
            .and_then(|c| self.resolve_dict(c.get(b"Outlines").ok()))
        else {
            return 0;
        };
        let mut count = 0;
        let mut seen = HashSet::new();
        let mut stack: Vec<ObjectId> = outlines
            .get(b"First")
            .and_then(|o| o.as_reference())
            .into_iter()
            .collect();
        while let Some(id) = stack.pop() {
            if !seen.insert(id) || count > MAX_ENTRIES {
                continue;
            }
            count += 1;
            if let Ok(item) = self.doc.get_dictionary(id) {
                for key in [b"First".as_slice(), b"Next"] {
                    if let Ok(next) = item.get(key).and_then(|o| o.as_reference()) {
                        stack.push(next);
                    }
                }
            }
        }
        count
    }

    fn page_ops(&self, page_id: ObjectId) -> Option<Vec<Operation>> {
        let bytes = self
            .doc
            .get_page_content_with_limit(page_id, MAX_CONTENT)
            .ok()?;
        Content::decode(&bytes).ok().map(|c| c.operations)
    }

    /// The runs of text on page `index` nobody can see, or `None` when its
    /// content cannot be read.
    fn hidden_runs(&self, index: usize) -> Option<Vec<HiddenRun>> {
        let page_id = *self.pages.get(index)?;
        let ops = self.page_ops(page_id)?;
        let dict = self.doc.get_dictionary(page_id).ok()?;
        let media = self
            .rect(self.inherited(dict, b"MediaBox"))
            .unwrap_or([0.0, 0.0, 612.0, 792.0]);
        let crop = self.rect(self.inherited(dict, b"CropBox")).unwrap_or(media);
        Some(find_hidden_runs(&ops, crop))
    }

    /// A copy of this document without what `remove` names, written whole:
    /// see the module documentation. A protected file is refused, as the
    /// copy would be written without its password.
    pub fn without_hidden(&self, remove: &BTreeSet<Hidden>) -> Result<Vec<u8>> {
        if self.was_encrypted {
            return Err(Error::Edit(
                "a protected file cannot be written whole without losing its password".into(),
            ));
        }
        let mut copy = self.detached_copy();
        // Content first, while the layers and fields it refers to are there.
        if remove.contains(&Hidden::HiddenText) {
            copy.remove_hidden_text();
        }
        if remove.contains(&Hidden::HiddenLayers) {
            copy.remove_hidden_layers();
        }
        if remove.contains(&Hidden::Forms) {
            copy.flatten_forms();
        }
        copy.remove_annotations(|subtype| {
            (remove.contains(&Hidden::Comments)
                && !matches!(subtype, b"Widget" | b"Link" | b"FileAttachment"))
                || (remove.contains(&Hidden::Attachments) && subtype == b"FileAttachment")
                || (remove.contains(&Hidden::Links) && subtype == b"Link")
        });
        if remove.contains(&Hidden::Metadata) {
            copy.doc.trailer.remove(b"Info");
            copy.strip_keys(&[b"Metadata"]);
        }
        if remove.contains(&Hidden::Scripts) {
            copy.remove_scripts();
        }
        if remove.contains(&Hidden::Attachments) {
            copy.remove_names(b"EmbeddedFiles");
            copy.strip_keys(&[b"AF"]);
            if let Ok(catalog) = copy.doc.catalog_mut() {
                catalog.remove(b"Collection");
            }
        }
        if remove.contains(&Hidden::Bookmarks) {
            if let Ok(catalog) = copy.doc.catalog_mut() {
                catalog.remove(b"Outlines");
                if name_of(catalog.get(b"PageMode").ok()) == Some(b"UseOutlines") {
                    catalog.remove(b"PageMode");
                }
            }
        }
        if remove.contains(&Hidden::Thumbnails) {
            for page in copy.pages.clone() {
                if let Ok(d) = copy.doc.get_dictionary_mut(page) {
                    d.remove(b"Thumb");
                }
            }
        }
        if remove.contains(&Hidden::PrivateData) {
            copy.strip_keys(&[b"PieceInfo"]);
        }
        if remove.contains(&Hidden::Links) {
            // Web addresses reached from anywhere else: bookmarks, above all.
            copy.strip_actions(&[b"URI", b"GoToR", b"Launch"]);
        }
        // Nothing of an earlier revision is written, nor any pointer to one.
        for key in [b"Prev".as_slice(), b"XRefStm"] {
            copy.doc.trailer.remove(key);
        }
        copy.prune_unreachable();
        copy.save_to_vec()
    }

    /// Removes `keys` from every dictionary of the file.
    fn strip_keys(&mut self, keys: &[&[u8]]) {
        for object in self.doc.objects.values_mut() {
            visit_dicts_mut(object, 0, &mut |d| {
                for key in keys {
                    d.remove(key);
                }
            });
        }
    }

    /// Removes every `/A` whose action type is one of `kinds`.
    fn strip_actions(&mut self, kinds: &[&[u8]]) {
        let is_kind =
            |d: &Dictionary| name_of(d.get(b"S").ok()).is_some_and(|s| kinds.contains(&s));
        // Actions held as their own objects, by reference.
        let own: HashSet<ObjectId> = self
            .doc
            .objects
            .iter()
            .filter(|(_, o)| o.as_dict().is_ok_and(is_kind))
            .map(|(id, _)| *id)
            .collect();
        for object in self.doc.objects.values_mut() {
            visit_dicts_mut(object, 0, &mut |d| {
                let drop = match d.get(b"A") {
                    Ok(Object::Dictionary(a)) => is_kind(a),
                    Ok(Object::Reference(id)) => own.contains(id),
                    _ => false,
                };
                if drop {
                    d.remove(b"A");
                }
            });
        }
    }

    fn remove_names(&mut self, key: &[u8]) {
        let Ok(catalog) = self.doc.catalog() else {
            return;
        };
        match catalog.get(b"Names") {
            Ok(Object::Reference(id)) => {
                let id = *id;
                if let Ok(names) = self.doc.get_dictionary_mut(id) {
                    names.remove(key);
                }
            }
            Ok(Object::Dictionary(_)) => {
                if let Ok(Object::Dictionary(names)) =
                    self.doc.catalog_mut().and_then(|c| c.get_mut(b"Names"))
                {
                    names.remove(key);
                }
            }
            _ => {}
        }
    }

    fn remove_scripts(&mut self) {
        self.remove_names(b"JavaScript");
        if let Ok(catalog) = self.doc.catalog_mut() {
            catalog.remove(b"OpenAction");
        }
        self.strip_keys(&[b"AA"]);
        self.strip_actions(ACTIVE_ACTIONS);
        // Calculation order is a list of scripts to run.
        if let Some(form) = self.acroform_mut() {
            form.remove(b"CO");
        }
    }

    fn acroform_mut(&mut self) -> Option<&mut Dictionary> {
        let form = self.doc.catalog().ok()?.get(b"AcroForm").ok()?.clone();
        match form {
            Object::Reference(id) => self.doc.get_dictionary_mut(id).ok(),
            Object::Dictionary(_) => self
                .doc
                .catalog_mut()
                .ok()?
                .get_mut(b"AcroForm")
                .ok()?
                .as_dict_mut()
                .ok(),
            _ => None,
        }
    }

    /// The page's `/Annots`, rewritten as a direct array of what `keep`
    /// keeps; an array held as its own object is left for pruning.
    fn set_annotations(&mut self, page: ObjectId, kept: Vec<Object>) {
        if let Ok(d) = self.doc.get_dictionary_mut(page) {
            if kept.is_empty() {
                d.remove(b"Annots");
            } else {
                d.set("Annots", Object::Array(kept));
            }
        }
    }

    /// Removes every annotation whose subtype `drop` says to.
    fn remove_annotations(&mut self, drop: impl Fn(&[u8]) -> bool) {
        for page in self.pages.clone() {
            let Ok(dict) = self.doc.get_dictionary(page) else {
                continue;
            };
            let Some(Ok(annots)) = dict
                .get(b"Annots")
                .ok()
                .and_then(|o| self.deref(o))
                .map(|o| o.as_array())
            else {
                continue;
            };
            let before = annots.len();
            let kept: Vec<Object> = annots
                .iter()
                .filter(|a| {
                    let subtype = self
                        .deref(a)
                        .and_then(|o| o.as_dict().ok())
                        .and_then(|d| name_of(d.get(b"Subtype").ok()))
                        .unwrap_or(b"");
                    !drop(subtype)
                })
                .cloned()
                .collect();
            if kept.len() != before {
                self.set_annotations(page, kept);
            }
        }
    }

    /// Draws each form field's appearance into its page, then removes the
    /// fields: what the form showed stays, its data does not.
    fn flatten_forms(&mut self) {
        for page in self.pages.clone() {
            let annots: Vec<(Option<ObjectId>, Dictionary)> = self
                .page_annotations(page)
                .into_iter()
                .map(|(id, d)| (id, d.clone()))
                .collect();
            let mut drawing = String::new();
            let mut forms: Vec<(String, ObjectId)> = vec![];
            for (_, annot) in annots.iter() {
                if name_of(annot.get(b"Subtype").ok()) != Some(b"Widget") {
                    continue;
                }
                let flags = annot.get(b"F").and_then(|f| f.as_i64()).unwrap_or(0);
                // Hidden (2) or not shown on screen (32): nothing to draw.
                if flags & (2 | 32) != 0 {
                    continue;
                }
                let Some((stream_id, a)) = self.flattened_placement(annot) else {
                    continue;
                };
                let name = format!("WqFlat{}", forms.len() + 1);
                drawing.push_str(&format!(
                    "q {} {} {} {} {} {} cm /{name} Do Q\n",
                    a.0[0], a.0[1], a.0[2], a.0[3], a.0[4], a.0[5]
                ));
                forms.push((name, stream_id));
            }
            if !forms.is_empty() {
                self.append_to_page(page, &drawing, &forms);
            }
            let kept: Vec<Object> = {
                let Ok(dict) = self.doc.get_dictionary(page) else {
                    continue;
                };
                let Some(Ok(annots)) = dict
                    .get(b"Annots")
                    .ok()
                    .and_then(|o| self.deref(o))
                    .map(|o| o.as_array())
                else {
                    continue;
                };
                annots
                    .iter()
                    .filter(|a| {
                        self.deref(a)
                            .and_then(|o| o.as_dict().ok())
                            .and_then(|d| name_of(d.get(b"Subtype").ok()))
                            != Some(b"Widget")
                    })
                    .cloned()
                    .collect()
            };
            self.set_annotations(page, kept);
        }
        if let Ok(catalog) = self.doc.catalog_mut() {
            catalog.remove(b"AcroForm");
        }
    }

    /// A widget's normal appearance, and the matrix that puts it on its
    /// rectangle (PDF 32000-1 §12.5.5): the appearance's box, through its
    /// own matrix, scaled and moved onto `/Rect`.
    pub(crate) fn flattened_placement(&self, annot: &Dictionary) -> Option<(ObjectId, Matrix)> {
        let rect = self.rect(annot.get(b"Rect").ok())?;
        let ap = self.resolve_dict(annot.get(b"AP").ok())?;
        let normal = ap.get(b"N").ok()?;
        let stream_ref = match normal {
            Object::Reference(id) => match self.doc.get_object(*id).ok()? {
                Object::Stream(_) => *id,
                Object::Dictionary(states) => {
                    let state = name_of(annot.get(b"AS").ok())?;
                    states.get(state).ok()?.as_reference().ok()?
                }
                _ => return None,
            },
            Object::Dictionary(states) => {
                let state = name_of(annot.get(b"AS").ok())?;
                states.get(state).ok()?.as_reference().ok()?
            }
            _ => return None,
        };
        let stream = self.doc.get_object(stream_ref).ok()?.as_stream().ok()?;
        let bbox = self.rect(stream.dict.get(b"BBox").ok())?;
        let m = stream
            .dict
            .get(b"Matrix")
            .ok()
            .and_then(|o| o.as_array().ok())
            .filter(|a| a.len() == 6)
            .map(|a| {
                let mut v = [0f32; 6];
                for (i, o) in a.iter().enumerate() {
                    v[i] = o.as_float().unwrap_or(0.0);
                }
                Matrix(v)
            })
            .unwrap_or(Matrix::IDENTITY);
        let corners = [
            m.apply(bbox[0], bbox[1]),
            m.apply(bbox[2], bbox[1]),
            m.apply(bbox[0], bbox[3]),
            m.apply(bbox[2], bbox[3]),
        ];
        let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
        for (x, y) in corners {
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x);
            y1 = y1.max(y);
        }
        let (bw, bh) = (x1 - x0, y1 - y0);
        if !(bw > 1e-3 && bh > 1e-3) {
            return None;
        }
        let sx = (rect[2] - rect[0]) / bw;
        let sy = (rect[3] - rect[1]) / bh;
        Some((
            stream_ref,
            Matrix([sx, 0.0, 0.0, sy, rect[0] - x0 * sx, rect[1] - y0 * sy]),
        ))
    }

    /// Appends `drawing` to the page, after its own content (wrapped so that
    /// a transform it leaves in place does not move what is added), with
    /// `forms` added to its resources as XObjects.
    fn append_to_page(&mut self, page: ObjectId, drawing: &str, forms: &[(String, ObjectId)]) {
        let Some(ops) = self.page_ops(page) else {
            return;
        };
        let open = crate::text_walk::unbalanced_q(&ops);
        let mut content = b"q\n".to_vec();
        content.extend(Content { operations: ops }.encode().unwrap_or_default());
        content.extend("\nQ".repeat(open + 1).into_bytes());
        content.push(b'\n');
        content.extend(drawing.as_bytes());
        let mut resources = self.page_resources(page).cloned().unwrap_or_default();
        let mut xobjects = self
            .resolve_dict(resources.get(b"XObject").ok())
            .cloned()
            .unwrap_or_default();
        for (name, id) in forms {
            xobjects.set(name.as_bytes().to_vec(), Object::Reference(*id));
        }
        resources.set("XObject", Object::Dictionary(xobjects));
        self.set_page_content(page, content);
        if let Ok(d) = self.doc.get_dictionary_mut(page) {
            d.set("Resources", Object::Dictionary(resources));
        }
    }

    /// The page's content, replaced by `content` in a stream of its own.
    fn set_page_content(&mut self, page: ObjectId, content: Vec<u8>) {
        let mut stream = Stream::new(Dictionary::new(), content);
        let _ = stream.compress();
        let id = self.doc.add_object(stream);
        if let Ok(d) = self.doc.get_dictionary_mut(page) {
            d.set("Contents", Object::Reference(id));
        }
    }

    /// Blanks every run of text nobody can see that can go without moving
    /// text that is seen.
    fn remove_hidden_text(&mut self) {
        for index in 0..self.pages.len() {
            let page = self.pages[index];
            let Some(mut ops) = self.page_ops(page) else {
                continue;
            };
            let Some(runs) = self.hidden_runs(index) else {
                continue;
            };
            let mut changed = false;
            for run in runs.iter().filter(|r| r.removable) {
                blank(&mut ops[run.op_index]);
                changed = true;
            }
            if changed {
                if let Ok(bytes) = (Content { operations: ops }).encode() {
                    self.set_page_content(page, bytes);
                }
            }
        }
    }

    /// Removes the layers that are switched off, with everything they draw
    /// on the pages and in the drawings those use, and every mention of them.
    fn remove_hidden_layers(&mut self) {
        let off = self.off_layers();
        if off.is_empty() {
            return;
        }
        // Optional-content membership dictionaries count as off when every
        // layer they list is.
        let hidden = |doc: &PdfDocument, o: &Object| -> bool {
            let Some((id, target)) = doc.doc.dereference(o).ok() else {
                return false;
            };
            if id.is_some_and(|id| off.contains(&id)) {
                return true;
            }
            let Ok(d) = target.as_dict() else {
                return false;
            };
            if d.has_type(b"OCMD") {
                let members: Vec<ObjectId> = match d.get(b"OCGs") {
                    Ok(Object::Reference(r)) => vec![*r],
                    Ok(Object::Array(a)) => {
                        a.iter().filter_map(|o| o.as_reference().ok()).collect()
                    }
                    _ => vec![],
                };
                return !members.is_empty() && members.iter().all(|m| off.contains(m));
            }
            false
        };
        // Page content, and the form XObjects it draws, each once.
        let mut done: HashSet<ObjectId> = HashSet::new();
        for page in self.pages.clone() {
            let resources = self.page_resources(page).cloned().unwrap_or_default();
            if let Some(ops) = self.page_ops(page) {
                let (kept, changed) = self.without_layers(ops, &resources, &hidden);
                if changed {
                    if let Ok(bytes) = (Content { operations: kept }).encode() {
                        self.set_page_content(page, bytes);
                    }
                }
            }
            self.strip_layers_from_forms(&resources, &hidden, &mut done, 0);
        }
        // Annotations in a hidden layer.
        for page in self.pages.clone() {
            let annots: Vec<Object> = {
                let Ok(dict) = self.doc.get_dictionary(page) else {
                    continue;
                };
                match dict.get(b"Annots").ok().and_then(|o| self.deref(o)) {
                    Some(Object::Array(a)) => a.clone(),
                    _ => continue,
                }
            };
            let kept: Vec<Object> = annots
                .iter()
                .filter(|a| {
                    !self
                        .deref(a)
                        .and_then(|o| o.as_dict().ok())
                        .and_then(|d| d.get(b"OC").ok())
                        .is_some_and(|oc| hidden(self, oc))
                })
                .cloned()
                .collect();
            if kept.len() != annots.len() {
                self.set_annotations(page, kept);
            }
        }
        // Their names in resources, and the layers themselves.
        let refers_to_off = |o: &Object| o.as_reference().is_ok_and(|r| off.contains(&r));
        for object in self.doc.objects.values_mut() {
            visit_dicts_mut(object, 0, &mut |d| {
                if let Ok(Object::Dictionary(props)) = d.get_mut(b"Properties") {
                    let names: Vec<Vec<u8>> = props
                        .iter()
                        .filter(|(_, v)| refers_to_off(v))
                        .map(|(k, _)| k.clone())
                        .collect();
                    for name in names {
                        props.remove(&name);
                    }
                }
            });
        }
        self.remove_layers_from_properties(&off);
    }

    /// The operators of a content stream without the marked content and
    /// the drawings that belong to a hidden layer.
    fn without_layers(
        &self,
        ops: Vec<Operation>,
        resources: &Dictionary,
        hidden: &dyn Fn(&PdfDocument, &Object) -> bool,
    ) -> (Vec<Operation>, bool) {
        let properties = self.resolve_dict(resources.get(b"Properties").ok());
        let xobjects = self.resolve_dict(resources.get(b"XObject").ok());
        let mut kept = Vec::with_capacity(ops.len());
        // Depth of marked-content nesting, and where a hidden one began.
        let mut depth = 0usize;
        let mut hidden_from: Option<usize> = None;
        let mut changed = false;
        for op in ops {
            match op.operator.as_str() {
                "BDC" | "BMC" => {
                    depth += 1;
                    if hidden_from.is_none()
                        && op.operator == "BDC"
                        && name_of(op.operands.first()) == Some(b"OC")
                    {
                        let target = match op.operands.get(1) {
                            Some(Object::Name(n)) => properties.and_then(|p| p.get(n).ok()),
                            Some(other) => Some(other),
                            None => None,
                        };
                        if target.is_some_and(|t| hidden(self, t)) {
                            hidden_from = Some(depth);
                            changed = true;
                            continue;
                        }
                    }
                }
                "EMC" => {
                    if hidden_from == Some(depth) {
                        hidden_from = None;
                        depth = depth.saturating_sub(1);
                        continue;
                    }
                    depth = depth.saturating_sub(1);
                }
                "Do" if hidden_from.is_none() => {
                    let in_layer = name_of(op.operands.first())
                        .and_then(|n| xobjects.and_then(|x| x.get(n).ok()))
                        .and_then(|x| self.deref(x))
                        .and_then(|x| x.as_stream().ok())
                        .and_then(|s| s.dict.get(b"OC").ok())
                        .is_some_and(|oc| hidden(self, oc));
                    if in_layer {
                        changed = true;
                        continue;
                    }
                }
                _ => {}
            }
            if hidden_from.is_none() {
                kept.push(op);
            }
        }
        (kept, changed)
    }

    fn strip_layers_from_forms(
        &mut self,
        resources: &Dictionary,
        hidden: &dyn Fn(&PdfDocument, &Object) -> bool,
        done: &mut HashSet<ObjectId>,
        depth: usize,
    ) {
        if depth > 8 {
            return;
        }
        let forms: Vec<ObjectId> = self
            .resolve_dict(resources.get(b"XObject").ok())
            .map(|x| {
                x.iter()
                    .filter_map(|(_, v)| v.as_reference().ok())
                    .collect()
            })
            .unwrap_or_default();
        for id in forms {
            if !done.insert(id) {
                continue;
            }
            let Ok(stream) = self.doc.get_object(id).and_then(|o| o.as_stream()) else {
                continue;
            };
            if name_of(stream.dict.get(b"Subtype").ok()) != Some(b"Form") {
                continue;
            }
            let own = self
                .resolve_dict(stream.dict.get(b"Resources").ok())
                .cloned()
                .unwrap_or_else(|| resources.clone());
            let Ok(bytes) = stream.decompressed_content_with_limit(MAX_CONTENT) else {
                continue;
            };
            let Ok(content) = Content::decode(&bytes) else {
                continue;
            };
            let (kept, changed) = self.without_layers(content.operations, &own, hidden);
            if changed {
                if let (Ok(bytes), Ok(Object::Stream(s))) = (
                    (Content { operations: kept }).encode(),
                    self.doc.get_object_mut(id),
                ) {
                    s.dict.remove(b"Filter");
                    s.dict.remove(b"DecodeParms");
                    s.set_plain_content(bytes);
                    let _ = s.compress();
                }
            }
            self.strip_layers_from_forms(&own, hidden, done, depth + 1);
        }
    }

    /// Takes `off` out of `/OCProperties`: its list, every configuration's
    /// arrays, the order tree. With no layer left, the whole entry goes.
    fn remove_layers_from_properties(&mut self, off: &BTreeSet<ObjectId>) {
        let Ok(catalog) = self.doc.catalog() else {
            return;
        };
        let Ok(props_obj) = catalog.get(b"OCProperties").cloned() else {
            return;
        };
        let mut props = match self.deref(&props_obj).and_then(|o| o.as_dict().ok()) {
            Some(p) => p.clone(),
            None => return,
        };
        fn drop_ids(o: &mut Object, off: &BTreeSet<ObjectId>, depth: usize) {
            if depth > MAX_DEPTH {
                return;
            }
            match o {
                Object::Array(a) => {
                    a.retain(|v| !v.as_reference().is_ok_and(|r| off.contains(&r)));
                    a.iter_mut().for_each(|v| drop_ids(v, off, depth + 1));
                    // An order group left with only its label says nothing.
                    a.retain(|v| !matches!(v, Object::Array(inner) if inner.iter().all(|x| matches!(x, Object::String(..)))));
                }
                Object::Dictionary(d) => {
                    d.iter_mut().for_each(|(_, v)| drop_ids(v, off, depth + 1))
                }
                _ => {}
            }
        }
        // Configurations held as their own objects are resolved in place.
        for key in [b"D".as_slice(), b"Configs"] {
            if let Ok(value) = props.get(key).cloned() {
                let mut resolved = self.deep_resolve(&value, 0);
                drop_ids(&mut resolved, off, 0);
                props.set(key.to_vec(), resolved);
            }
        }
        if let Ok(ocgs) = props.get_mut(b"OCGs") {
            drop_ids(ocgs, off, 0);
        }
        let empty = props
            .get(b"OCGs")
            .and_then(|o| o.as_array())
            .map(|a| a.is_empty())
            .unwrap_or(true);
        if let Ok(catalog) = self.doc.catalog_mut() {
            if empty {
                catalog.remove(b"OCProperties");
            } else {
                catalog.set("OCProperties", Object::Dictionary(props));
            }
        }
    }

    /// `o` with references to dictionaries and arrays replaced by what they
    /// point at, one level deep in each: enough for a configuration.
    fn deep_resolve(&self, o: &Object, depth: usize) -> Object {
        if depth > 4 {
            return o.clone();
        }
        match o {
            Object::Reference(id) => match self.doc.get_object(*id) {
                Ok(target @ (Object::Dictionary(_) | Object::Array(_))) => {
                    self.deep_resolve(target, depth + 1)
                }
                _ => o.clone(),
            },
            Object::Dictionary(d) => {
                let mut out = Dictionary::new();
                for (k, v) in d.iter() {
                    let v = match v {
                        // Layers themselves stay references.
                        Object::Reference(_) => v.clone(),
                        other => self.deep_resolve(other, depth + 1),
                    };
                    out.set(k.clone(), v);
                }
                Object::Dictionary(out)
            }
            Object::Array(a) => Object::Array(
                a.iter()
                    .map(|v| match v {
                        Object::Reference(_) => v.clone(),
                        other => self.deep_resolve(other, depth + 1),
                    })
                    .collect(),
            ),
            _ => o.clone(),
        }
    }
}

fn collect_refs(object: &Object, out: &mut Vec<ObjectId>, depth: usize) {
    if depth > MAX_DEPTH {
        return;
    }
    match object {
        Object::Reference(id) => out.push(*id),
        Object::Array(items) => items.iter().for_each(|o| collect_refs(o, out, depth + 1)),
        Object::Dictionary(dict) => dict
            .iter()
            .for_each(|(_, o)| collect_refs(o, out, depth + 1)),
        Object::Stream(stream) => stream
            .dict
            .iter()
            .for_each(|(_, o)| collect_refs(o, out, depth + 1)),
        _ => {}
    }
}

/// Why a run of text cannot be seen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Reason {
    /// Render mode 3 (neither filled nor stroked) or 7 (clip only).
    Invisible,
    /// Filled in white, and not stroked.
    White,
    /// Its origin lies off the page.
    OffPage,
}

#[derive(Debug, Clone, Copy)]
struct HiddenRun {
    op_index: usize,
    reason: Reason,
    /// Blanking it moves no text that is seen: the next run in its text
    /// object is placed on its own, or is itself removed.
    removable: bool,
}

fn num(o: &Object) -> f32 {
    o.as_float().unwrap_or(0.0)
}

/// Whether a colour is white in the space it is given in.
fn white(space: &[u8], values: &[f32]) -> bool {
    let near = |v: f32| (v - 1.0).abs() < 0.01;
    match (space, values) {
        (b"DeviceGray" | b"CalGray" | b"G", [g]) => near(*g),
        (b"DeviceRGB" | b"CalRGB" | b"RGB", [r, g, b]) => near(*r) && near(*g) && near(*b),
        (b"DeviceCMYK" | b"CMYK", [c, m, y, k]) => [*c, *m, *y, *k].iter().all(|v| v.abs() < 0.01),
        _ => false,
    }
}

/// The runs of text nobody can see, in a page's operators; `crop` is the
/// page's visible box in its own space.
fn find_hidden_runs(ops: &[Operation], crop: [f32; 4]) -> Vec<HiddenRun> {
    #[derive(Clone)]
    struct State {
        ctm: Matrix,
        fill_space: Vec<u8>,
        fill_white: bool,
        stroke_visible: bool,
        mode: i64,
    }
    let mut state = State {
        ctm: Matrix::IDENTITY,
        fill_space: b"DeviceGray".to_vec(),
        fill_white: false,
        stroke_visible: false,
        mode: 0,
    };
    let mut stack: Vec<State> = vec![];
    let (mut tm, mut tlm) = (Matrix::IDENTITY, Matrix::IDENTITY);
    let (mut leading, mut size) = (0.0f32, 0.0f32);
    // Every show in the current text object: (op index, hidden reason,
    // whether it is placed on its own rather than after the one before).
    let mut shows: Vec<(usize, Option<Reason>, bool)> = vec![];
    let mut placed = true;
    let mut out = vec![];
    let finish = |shows: &mut Vec<(usize, Option<Reason>, bool)>, out: &mut Vec<HiddenRun>| {
        // From the end: a run can go when the run after it is placed on its
        // own, or goes too.
        let mut next_safe = true;
        let mut runs = vec![];
        for &(index, reason, own_place) in shows.iter().rev() {
            let removable = reason.is_some() && next_safe;
            if let Some(reason) = reason {
                runs.push(HiddenRun {
                    op_index: index,
                    reason,
                    removable,
                });
            }
            next_safe = own_place || removable;
        }
        runs.reverse();
        out.extend(runs);
        shows.clear();
    };
    for (i, op) in ops.iter().enumerate() {
        let a = &op.operands;
        match op.operator.as_str() {
            "q" => stack.push(state.clone()),
            "Q" => {
                if let Some(s) = stack.pop() {
                    state = s;
                }
            }
            "cm" if a.len() >= 6 => {
                state.ctm = Matrix([
                    num(&a[0]),
                    num(&a[1]),
                    num(&a[2]),
                    num(&a[3]),
                    num(&a[4]),
                    num(&a[5]),
                ])
                .then(state.ctm)
            }
            "g" if a.len() == 1 => {
                state.fill_space = b"DeviceGray".to_vec();
                state.fill_white = white(b"DeviceGray", &[num(&a[0])]);
            }
            "rg" if a.len() == 3 => {
                state.fill_space = b"DeviceRGB".to_vec();
                state.fill_white = white(b"DeviceRGB", &a.iter().map(num).collect::<Vec<_>>());
            }
            "k" if a.len() == 4 => {
                state.fill_space = b"DeviceCMYK".to_vec();
                state.fill_white = white(b"DeviceCMYK", &a.iter().map(num).collect::<Vec<_>>());
            }
            "cs" => {
                state.fill_space = name_of(a.first()).unwrap_or(b"").to_vec();
                state.fill_white = false;
            }
            "sc" | "scn" => {
                let values: Vec<f32> = a.iter().filter(|o| o.as_float().is_ok()).map(num).collect();
                state.fill_white = white(&state.fill_space, &values);
            }
            // Any stroke colour but none counts as visible.
            "G" | "RG" | "K" | "CS" | "SC" | "SCN" => state.stroke_visible = true,
            "Tr" if !a.is_empty() => state.mode = a[0].as_i64().unwrap_or(0),
            "BT" => {
                tm = Matrix::IDENTITY;
                tlm = tm;
                shows.clear();
                placed = true;
            }
            "ET" => finish(&mut shows, &mut out),
            "Tf" if a.len() >= 2 => size = num(&a[1]),
            "TL" if !a.is_empty() => leading = num(&a[0]),
            "Td" | "TD" if a.len() >= 2 => {
                if op.operator == "TD" {
                    leading = -num(&a[1]);
                }
                tlm = Matrix([1.0, 0.0, 0.0, 1.0, num(&a[0]), num(&a[1])]).then(tlm);
                tm = tlm;
                placed = true;
            }
            "Tm" if a.len() >= 6 => {
                tlm = Matrix([
                    num(&a[0]),
                    num(&a[1]),
                    num(&a[2]),
                    num(&a[3]),
                    num(&a[4]),
                    num(&a[5]),
                ]);
                tm = tlm;
                placed = true;
            }
            "T*" => {
                tlm = Matrix([1.0, 0.0, 0.0, 1.0, 0.0, -leading]).then(tlm);
                tm = tlm;
                placed = true;
            }
            "Tj" | "TJ" | "'" | "\"" => {
                if matches!(op.operator.as_str(), "'" | "\"") {
                    tlm = Matrix([1.0, 0.0, 0.0, 1.0, 0.0, -leading]).then(tlm);
                    tm = tlm;
                    placed = true;
                }
                let full = tm.then(state.ctm);
                let (x, y) = full.apply(0.0, 0.0);
                let margin = (size * full.scale()).abs().max(1.0) * 2.0;
                let reason = if shows_nothing(op) {
                    None
                } else if matches!(state.mode, 3 | 7) {
                    Some(Reason::Invisible)
                } else if state.fill_white
                    && !(state.stroke_visible && matches!(state.mode, 1 | 2 | 5 | 6))
                {
                    Some(Reason::White)
                } else if x < crop[0] - margin
                    || x > crop[2] + margin
                    || y < crop[1] - margin
                    || y > crop[3] + margin
                {
                    Some(Reason::OffPage)
                } else {
                    None
                };
                shows.push((i, reason, placed));
                placed = false;
            }
            _ => {}
        }
    }
    finish(&mut shows, &mut out);
    out
}

/// A text-showing operator with no text: one `blank` emptied, say.
fn shows_nothing(op: &Operation) -> bool {
    let empty = |o: &Object| match o {
        Object::String(s, _) => s.is_empty(),
        Object::Array(items) => items
            .iter()
            .all(|i| !matches!(i, Object::String(s, _) if !s.is_empty())),
        _ => true,
    };
    op.operands.last().is_none_or(empty)
}

/// Empties a text-showing operator, leaving it in place.
fn blank(op: &mut Operation) {
    match op.operator.as_str() {
        "TJ" => op.operands = vec![Object::Array(vec![])],
        "\"" if op.operands.len() == 3 => {
            op.operands[2] = Object::String(vec![], StringFormat::Hexadecimal)
        }
        _ => op.operands = vec![Object::String(vec![], StringFormat::Hexadecimal)],
    }
}

/// For callers that key things by object: `"12 0"` for object 12.
pub fn object_key(id: ObjectId) -> String {
    format!("{} {}", id.0, id.1)
}

/// `object_key` read back.
pub fn parse_object_key(key: &str) -> Option<ObjectId> {
    let mut parts = key.split_whitespace();
    let n = parts.next()?.parse().ok()?;
    let g = parts.next()?.parse().ok()?;
    Some((n, g))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::Read;

    fn fixture() -> Vec<u8> {
        std::fs::read(format!(
            "{}/../../../tests/fixtures/hidden/everything.pdf",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap()
    }

    /// The bytes of a file as anyone could read them: the file itself, and
    /// every stream in it inflated, found by scanning — not through lopdf,
    /// which only sees the current revision.
    pub(crate) fn readable(bytes: &[u8]) -> String {
        let mut out = String::from_utf8_lossy(bytes).into_owned();
        let mut at = 0;
        while let Some(pos) = find(&bytes[at..], b"stream") {
            let start = at + pos + 6;
            let start = start
                + bytes[start..]
                    .iter()
                    .take_while(|b| **b == b'\r' || **b == b'\n')
                    .count();
            let Some(end) = find(&bytes[start..], b"endstream") else {
                break;
            };
            let mut inflated = vec![];
            let _ = flate2::read::ZlibDecoder::new(&bytes[start..start + end])
                .take(64 << 20)
                .read_to_end(&mut inflated);
            out.push_str(&String::from_utf8_lossy(&inflated));
            at = start + end + 9;
        }
        out
    }

    fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
        hay.windows(needle.len()).position(|w| w == needle)
    }

    const MARKERS: &[(Hidden, &[&str])] = &[
        (
            Hidden::Metadata,
            &["INFO-TITLE-SECRET", "INFO-AUTHOR-SECRET", "XMP-SECRET"],
        ),
        (
            Hidden::Scripts,
            &["DOCJS-SECRET", "OPENACTION-SECRET", "PAGE-AA-SECRET"],
        ),
        (
            Hidden::Attachments,
            &[
                "ATTACH-DOC-SECRET",
                "ATTACH-ANNOT-SECRET",
                "doc-secret.txt",
                "annot-secret.txt",
            ],
        ),
        (Hidden::Comments, &["COMMENT-SECRET", "ANNOT-WRITER-SECRET"]),
        (
            Hidden::Forms,
            &["FIELDNAME-SECRET", "FIELDVALUE-SECRET", "XFA-SECRET"],
        ),
        (
            Hidden::HiddenLayers,
            &["LAYER-OFF-SECRET", "LAYERNAME-OFF-SECRET"],
        ),
        (Hidden::Bookmarks, &["BOOKMARK-SECRET"]),
        (Hidden::Thumbnails, &["THUMB-SECRET"]),
        (
            Hidden::PrivateData,
            &["PIECEINFO-SECRET", "PAGEPIECE-SECRET"],
        ),
        (
            Hidden::Links,
            &["link-secret.example", "bookmark-uri-secret.example"],
        ),
        (
            Hidden::HiddenText,
            &[
                "WHITE-TEXT-SECRET",
                "INVISIBLE-TEXT-SECRET",
                "OFFPAGE-TEXT-SECRET",
            ],
        ),
    ];

    #[test]
    fn the_report_finds_every_kind_the_fixture_carries() {
        let bytes = fixture();
        for (_, markers) in MARKERS {
            for m in *markers {
                assert!(readable(&bytes).contains(m), "the fixture should carry {m}");
            }
        }
        let report = PdfDocument::open(bytes, None).unwrap().hidden_report();
        let found: BTreeSet<Hidden> = report.findings.iter().map(|f| f.kind).collect();
        assert_eq!(found, Hidden::ALL.into_iter().collect(), "{report:#?}");
        assert_eq!(report.revisions, 1);
        assert_eq!(report.unreachable, 1, "the orphan");
        assert!(!report.protected && !report.signed);
        let text = report
            .findings
            .iter()
            .find(|f| f.kind == Hidden::HiddenText)
            .unwrap();
        assert_eq!(text.count, 3, "{text:?}");
        let layers = report
            .findings
            .iter()
            .find(|f| f.kind == Hidden::HiddenLayers)
            .unwrap();
        assert_eq!(layers.details, vec!["LAYERNAME-OFF-SECRET".to_string()]);
    }

    /// Each kind, removed alone, is gone from the bytes and from every
    /// stream; every other kind is still there; what the page shows stays.
    /// The earlier revision and the orphan go whatever is chosen.
    #[test]
    fn each_kind_removed_alone_is_gone_from_the_bytes_and_nothing_else_is() {
        let doc = PdfDocument::open(fixture(), None).unwrap();
        for (kind, markers) in MARKERS {
            let out = doc.without_hidden(&[*kind].into_iter().collect()).unwrap();
            let text = readable(&out);
            for m in *markers {
                assert!(!text.contains(m), "{kind:?}: {m} is still in the file");
            }
            for (other, others) in MARKERS {
                // A bookmark carries a web address: the two overlap.
                if other == kind || (*kind == Hidden::Bookmarks && *other == Hidden::Links) {
                    continue;
                }
                for m in *others {
                    assert!(text.contains(m), "{kind:?} took {m} ({other:?}) with it");
                }
            }
            for kept in ["VISIBLE-TEXT-KEPT", "LAYER-ON-TEXT", "Visible again"] {
                assert!(text.contains(kept), "{kind:?}: {kept} went too");
            }
            assert!(
                !text.contains("OLD-REVISION-SECRET"),
                "{kind:?}: an earlier revision survived"
            );
            assert!(
                !text.contains("ORPHAN-SECRET"),
                "{kind:?}: an unreachable object survived"
            );
            let reopened = PdfDocument::open(out, None).unwrap();
            assert_eq!(reopened.page_count(), 1);
            assert_eq!(earlier_revisions(reopened.original_bytes()), 0);
        }
    }

    #[test]
    fn everything_removed_leaves_the_page_as_it_looks() {
        let doc = PdfDocument::open(fixture(), None).unwrap();
        let out = doc
            .without_hidden(&Hidden::ALL.into_iter().collect())
            .unwrap();
        let text = readable(&out);
        for (_, markers) in MARKERS {
            for m in *markers {
                assert!(!text.contains(m), "{m} is still in the file");
            }
        }
        // The field's appearance is drawn into the page; the field is gone.
        for kept in ["VISIBLE-TEXT-KEPT", "LAYER-ON-TEXT", "FIELD-SHOWN"] {
            assert!(text.contains(kept), "{kept} went too");
        }
        let reopened = PdfDocument::open(out, None).unwrap();
        let report = reopened.hidden_report();
        assert!(report.findings.is_empty(), "{report:#?}");
        assert_eq!(report.unreachable, 0);
    }

    #[test]
    fn a_protected_file_is_refused_rather_than_written_without_its_password() {
        let bytes = std::fs::read(format!(
            "{}/../../../tests/corpus/arabic/generated/variant-encrypted-aes256.pdf",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap();
        let doc = PdfDocument::open(bytes, Some("warraq")).unwrap();
        assert!(doc.hidden_report().protected);
        assert!(doc
            .without_hidden(&[Hidden::Metadata].into_iter().collect())
            .is_err());
    }

    #[test]
    fn hidden_text_that_would_move_visible_text_is_left_in_place() {
        let ops = Content::decode(
            b"BT /F1 12 Tf 10 10 Td 3 Tr (a) Tj 0 Tr (b) Tj ET BT 3 Tr 10 20 Td (c) Tj 0 Tr 0 -12 Td (d) Tj ET",
        )
        .unwrap()
        .operations;
        let runs = find_hidden_runs(&ops, [0.0, 0.0, 612.0, 792.0]);
        assert_eq!(runs.len(), 2);
        assert!(!runs[0].removable, "b follows a without a place of its own");
        assert!(runs[1].removable, "d is placed by its own Td");
    }
}
