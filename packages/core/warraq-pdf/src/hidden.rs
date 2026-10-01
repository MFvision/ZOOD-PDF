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

/// One line of what a finding holds, for a person to read — in their own
/// language: the interface words the core's own terms, and shows what
/// comes from the file as the file gives it.
#[derive(Debug, Clone, PartialEq)]
pub enum Detail {
    /// One of the core's own words, and how many: `white` (3), `XMP` (1).
    Word(&'static str, usize),
    /// A kind of annotation by its PDF name (`Highlight`), and how many.
    Subtype(String, usize),
    /// A document property: its key as the file names it, and its value.
    Property(String, String),
    /// A name from the file itself: an attachment's, a layer's, an address.
    Name(String),
}

/// One kind of hidden information the file carries.
#[derive(Debug, Clone, PartialEq)]
pub struct Finding {
    pub kind: Hidden,
    /// How many: entries, annotations, layers, runs of text.
    pub count: usize,
    /// What they are, a line each (at most a few).
    pub details: Vec<Detail>,
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

    /// A layer's own "shown on screen" state (`/Usage /View /ViewState`).
    fn view_state(&self, layer: &Dictionary) -> Option<bool> {
        let usage = self.resolve_dict(layer.get(b"Usage").ok())?;
        let view = self.resolve_dict(usage.get(b"View").ok())?;
        match name_of(view.get(b"ViewState").ok())? {
            b"OFF" => Some(false),
            _ => Some(true),
        }
    }

    /// Layers not shown on screen, as PDFium — the engine the view draws
    /// pages with — decides (`CPDF_OCContext::LoadOCGState`): a layer's own
    /// view state first, then, for a layer the file lists, the default
    /// configuration (`/D`); a layer the file does not list is shown unless
    /// its own view state says otherwise.
    pub(crate) fn off_layers(&self) -> BTreeSet<ObjectId> {
        let mut off = BTreeSet::new();
        let Ok(catalog) = self.doc.catalog() else {
            return off;
        };
        let props = self.resolve_dict(catalog.get(b"OCProperties").ok());
        let all: Vec<ObjectId> = props
            .and_then(|p| p.get(b"OCGs").ok())
            .and_then(|o| self.deref(o))
            .and_then(|o| o.as_array().ok())
            .map(|a| a.iter().filter_map(|o| o.as_reference().ok()).collect())
            .unwrap_or_default();
        let config = props.and_then(|p| self.resolve_dict(p.get(b"D").ok()));
        let ids = |key: &[u8]| -> HashSet<ObjectId> {
            config
                .and_then(|c| c.get(key).ok())
                .and_then(|o| self.deref(o))
                .and_then(|o| o.as_array().ok())
                .map(|a| a.iter().filter_map(|o| o.as_reference().ok()).collect())
                .unwrap_or_default()
        };
        let base = config.is_none_or(|c| name_of(c.get(b"BaseState").ok()) != Some(b"OFF"));
        let (on, off_list) = (ids(b"ON"), ids(b"OFF"));
        for &id in all.iter().take(MAX_ENTRIES) {
            let Ok(layer) = self.doc.get_dictionary(id) else {
                continue;
            };
            let shown = self.view_state(layer).unwrap_or_else(|| {
                config.is_none() || ((base || on.contains(&id)) && !off_list.contains(&id))
            });
            if !shown {
                off.insert(id);
            }
        }
        // Layers the file does not list, off by their own view state.
        for (id, object) in &self.doc.objects {
            if let Ok(d) = object.as_dict() {
                if d.has_type(b"OCG") && self.view_state(d) == Some(false) {
                    off.insert(*id);
                }
            }
        }
        off
    }

    /// Whether optional content `o` — a layer, or a membership dictionary
    /// (OCMD) — is shown when the layers in `off` are not, as PDFium
    /// decides it: a membership dictionary by its expression (`/VE`), or by
    /// its policy (`/P`, AnyOn unless it says) over the layers it lists — a
    /// single layer given alone by that layer's own state. Anything that is
    /// neither is shown.
    fn oc_shown(&self, o: &Object, off: &BTreeSet<ObjectId>, depth: usize) -> bool {
        if depth > MAX_DEPTH {
            return false;
        }
        let Ok((id, target)) = self.doc.dereference(o) else {
            return true;
        };
        let Ok(d) = target.as_dict() else {
            return true;
        };
        if !d.has_type(b"OCMD") {
            return !id.is_some_and(|id| off.contains(&id));
        }
        if let Some(ve) = d
            .get(b"VE")
            .ok()
            .and_then(|v| self.deref(v))
            .and_then(|v| v.as_array().ok())
        {
            return self.ve_shown(ve, off, depth + 1);
        }
        let Ok(ocgs) = d.get(b"OCGs") else {
            return true;
        };
        match self.doc.dereference(ocgs) {
            Ok((_, Object::Dictionary(_))) => self.oc_shown(ocgs, off, depth + 1),
            Ok((_, Object::Array(items))) => {
                let policy = name_of(d.get(b"P").ok()).unwrap_or(b"AnyOn");
                let mut seen = false;
                for item in items.iter().take(MAX_ENTRIES) {
                    let Ok((item_id, Object::Dictionary(_))) = self.doc.dereference(item) else {
                        continue;
                    };
                    seen = true;
                    let shown = !item_id.is_some_and(|i| off.contains(&i));
                    match (policy, shown) {
                        (b"AnyOn", true) | (b"AnyOff", false) => return true,
                        (b"AllOn", false) | (b"AllOff", true) => return false,
                        _ => {}
                    }
                }
                !seen || matches!(policy, b"AllOn" | b"AllOff")
            }
            _ => true,
        }
    }

    /// A visibility expression (`/VE`): `[/And …]`, `[/Or …]` or `[/Not x]`
    /// over layers and expressions; anything else hides (PDFium's reading).
    fn ve_shown(&self, ve: &[Object], off: &BTreeSet<ObjectId>, depth: usize) -> bool {
        if depth > MAX_DEPTH {
            return false;
        }
        let operand = |o: &Object| -> Option<bool> {
            match self.deref(o)? {
                Object::Dictionary(_) => Some(self.oc_shown(o, off, depth + 1)),
                Object::Array(inner) => Some(self.ve_shown(inner, off, depth + 1)),
                _ => None,
            }
        };
        match name_of(ve.first()) {
            Some(b"Not") => ve.get(1).and_then(operand).is_some_and(|shown| !shown),
            Some(op @ (b"And" | b"Or")) => {
                let mut value = None;
                for item in ve.iter().skip(1).take(MAX_ENTRIES) {
                    let Some(shown) = operand(item) else {
                        continue;
                    };
                    value = Some(match value {
                        None => shown,
                        Some(v) if op == b"Or" => v || shown,
                        Some(v) => v && shown,
                    });
                }
                value.unwrap_or(false)
            }
            _ => false,
        }
    }

    /// The layers optional content `o` depends on: itself, or those a
    /// membership dictionary lists or names in its expression.
    fn oc_members(&self, o: &Object, out: &mut BTreeSet<ObjectId>, depth: usize) {
        if depth > MAX_DEPTH {
            return;
        }
        let (id, target) = match o {
            Object::Reference(id) => match self.doc.get_object(*id) {
                Ok(target) => (Some(*id), target),
                Err(_) => return,
            },
            other => (None, other),
        };
        match target {
            Object::Dictionary(d) if d.has_type(b"OCMD") => {
                for key in [b"OCGs".as_slice(), b"VE"] {
                    if let Ok(v) = d.get(key) {
                        self.oc_members(v, out, depth + 1);
                    }
                }
            }
            Object::Dictionary(_) => out.extend(id),
            Object::Array(a) => a
                .iter()
                .take(MAX_ENTRIES)
                .for_each(|v| self.oc_members(v, out, depth + 1)),
            _ => {}
        }
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

        let mut add = |kind: Hidden, count: usize, details: Vec<Detail>| {
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
                    details.push(Detail::Property(
                        String::from_utf8_lossy(key).into_owned(),
                        truncate(text.trim(), 80),
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
            details.push(Detail::Word("XMP", xmp.len()));
        }
        add(Hidden::Metadata, details.len(), details);

        // Scripts and actions.
        let js = self
            .names_root(b"JavaScript")
            .map(|root| self.name_tree_entries(root).len())
            .unwrap_or(0);
        let opens = catalog.is_some_and(|c| c.has(b"OpenAction"));
        let (mut automatic, mut active) = (0usize, 0usize);
        // An action that runs something: written in place, or — as actions
        // usually are — an object of its own, with or without `/Type`.
        let runs = |o: &Object| match self.deref(o) {
            Some(Object::Dictionary(action)) => {
                name_of(action.get(b"S").ok()).is_some_and(|s| ACTIVE_ACTIONS.contains(&s))
            }
            _ => false,
        };
        for object in self.doc.objects.values() {
            visit_dicts(object, 0, &mut |d| {
                if d.has(b"AA") {
                    automatic += 1;
                }
                if d.get(b"A").is_ok_and(runs) {
                    active += 1;
                }
                // What an action runs after itself (`/Next`): one action or
                // a list of them, each with a chain of its own.
                if d.has(b"S") {
                    match d.get(b"Next").ok().and_then(|n| self.deref(n)) {
                        Some(Object::Array(chain)) => {
                            active += chain.iter().take(MAX_ENTRIES).filter(|a| runs(a)).count()
                        }
                        Some(_) if d.get(b"Next").is_ok_and(runs) => active += 1,
                        _ => {}
                    }
                }
            });
        }
        let mut details = vec![];
        if js > 0 {
            details.push(Detail::Word("JavaScript", js));
        }
        if opens {
            details.push(Detail::Word("OpenAction", 1));
        }
        if automatic > 0 {
            details.push(Detail::Word("AA", automatic));
        }
        if active > 0 {
            details.push(Detail::Word("Actions", active));
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
        add(
            Hidden::Attachments,
            attached.len(),
            attached.into_iter().map(Detail::Name).collect(),
        );
        let count = comments.values().sum();
        add(
            Hidden::Comments,
            count,
            comments
                .into_iter()
                .map(|(k, n)| Detail::Subtype(k, n))
                .collect(),
        );
        let acroform = catalog.and_then(|c| self.resolve_dict(c.get(b"AcroForm").ok()));
        let xfa = acroform.is_some_and(|f| f.has(b"XFA"));
        let mut details = vec![];
        if widgets > 0 {
            details.push(Detail::Word("Fields", widgets));
        }
        if xfa {
            details.push(Detail::Word("XFA", 1));
        }
        add(Hidden::Forms, widgets + usize::from(xfa), details);

        let off: Vec<Detail> = self
            .off_layers()
            .into_iter()
            .map(|id| Detail::Name(self.layer_name(id)))
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

        add(
            Hidden::Links,
            links,
            uris.into_iter().map(Detail::Name).collect(),
        );

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
        for (word, count) in [
            ("invisible", invisible),
            ("white", white),
            ("offPage", off_page),
        ] {
            if count > 0 {
                details.push(Detail::Word(word, count));
            }
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

    /// A page's operators, or `None` when a stream of its content cannot be
    /// decoded. Every stream or none: lopdf's own reading of a page falls
    /// back to a stream's raw bytes when it cannot decode it, and garbage
    /// read as operators would be written back as the page.
    fn page_ops(&self, page_id: ObjectId) -> Option<Vec<Operation>> {
        let mut bytes = vec![];
        for id in self.doc.get_page_contents(page_id) {
            let stream = self.doc.get_object(id).ok()?.as_stream().ok()?;
            let limit = MAX_CONTENT.saturating_sub(bytes.len());
            bytes.extend(stream.decompressed_content_with_limit(limit).ok()?);
            bytes.push(b'\n');
        }
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
        Some(find_hidden_runs(&ops, crop, &self.xobject_boxes(page_id)))
    }

    /// What each drawing a page names covers, in the space it is drawn in:
    /// a picture its unit square, a form its box through its own matrix.
    fn xobject_boxes(&self, page_id: ObjectId) -> std::collections::HashMap<Vec<u8>, [f32; 4]> {
        let mut out = std::collections::HashMap::new();
        let Some(xobjects) = self
            .page_resources(page_id)
            .and_then(|r| self.resolve_dict(r.get(b"XObject").ok()))
        else {
            return out;
        };
        for (name, x) in xobjects.iter().take(MAX_ENTRIES) {
            let Some(stream) = self.deref(x).and_then(|x| x.as_stream().ok()) else {
                continue;
            };
            let covered = match name_of(stream.dict.get(b"Subtype").ok()) {
                Some(b"Image") => Some([0.0, 0.0, 1.0, 1.0]),
                Some(b"Form") => self.rect(stream.dict.get(b"BBox").ok()).map(|b| {
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
                        m.apply(b[0], b[1]),
                        m.apply(b[2], b[1]),
                        m.apply(b[0], b[3]),
                        m.apply(b[2], b[3]),
                    ];
                    let mut r = [f32::MAX, f32::MAX, f32::MIN, f32::MIN];
                    for (x, y) in corners {
                        r = [r[0].min(x), r[1].min(y), r[2].max(x), r[3].max(y)];
                    }
                    r
                }),
                _ => None,
            };
            if let Some(covered) = covered {
                out.insert(name.clone(), covered);
            }
        }
        out
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
        // What is taken off the pages: annotations, and the fields behind
        // widgets. Nothing may still reach them afterwards (see `unreach`).
        let mut gone: HashSet<ObjectId> = HashSet::new();
        // Content first, while the layers and fields it refers to are there.
        if remove.contains(&Hidden::HiddenText) {
            copy.remove_hidden_text();
        }
        if remove.contains(&Hidden::HiddenLayers) {
            gone.extend(copy.remove_hidden_layers());
        }
        if remove.contains(&Hidden::Forms) {
            gone.extend(copy.flatten_forms());
        }
        gone.extend(copy.remove_annotations(|subtype| {
            (remove.contains(&Hidden::Comments)
                && !matches!(subtype, b"Widget" | b"Link" | b"FileAttachment"))
                || (remove.contains(&Hidden::Attachments) && subtype == b"FileAttachment")
                || (remove.contains(&Hidden::Links) && subtype == b"Link")
        }));
        copy.unreach(&gone);
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

    /// Removes every action whose type is one of `kinds`, wherever it sits:
    /// a link's or a bookmark's `/A`, an entry of a chain run after another
    /// action (`/Next`), an automatic action — written in place, or an
    /// object of its own (with or without `/Type`) that nothing then
    /// refers to. An action it would have led on to goes with it.
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
        let is_action = |o: &Object| match o {
            Object::Dictionary(d) => is_kind(d),
            Object::Reference(id) => own.contains(id),
            _ => false,
        };
        fn strip(o: &mut Object, is_action: &dyn Fn(&Object) -> bool, depth: usize) {
            if depth > MAX_DEPTH {
                return;
            }
            let dict = match o {
                Object::Dictionary(d) => d,
                Object::Stream(s) => &mut s.dict,
                Object::Array(items) => {
                    // Anywhere else in a list, an action is left as null, so
                    // pairs (a name tree's) keep their places.
                    for item in items.iter_mut() {
                        if is_action(item) {
                            *item = Object::Null;
                        } else {
                            strip(item, is_action, depth + 1);
                        }
                    }
                    return;
                }
                _ => return,
            };
            let dropped: Vec<Vec<u8>> = dict
                .iter()
                .filter(|(_, v)| is_action(v))
                .map(|(k, _)| k.clone())
                .collect();
            for key in dropped {
                dict.remove(&key);
            }
            // A chain of actions keeps those that stay, in their order.
            if dict.has(b"S") {
                if let Ok(Object::Array(chain)) = dict.get_mut(b"Next") {
                    chain.retain(|a| !is_action(a));
                    if chain.is_empty() {
                        dict.remove(b"Next");
                    }
                }
            }
            for (_, v) in dict.iter_mut() {
                strip(v, is_action, depth + 1);
            }
        }
        for object in self.doc.objects.values_mut() {
            strip(object, &is_action, 0);
        }
        // Nothing reaches them now: pruning takes them out.
        self.cut_references_to(&own);
    }

    /// Makes `gone` — annotations taken off their pages, the fields behind
    /// widgets — unreachable, so the file written whole does not carry them.
    ///
    /// A tagged file's structure tree points at each annotation it tags
    /// (`/OBJR`, PDF 32000-1 §14.7.4.3), as Word, LibreOffice and Chrome tag
    /// links, fields and comments; a reply points at the comment it answers,
    /// a submit action at its fields. Those object references are taken out
    /// of the structure elements' `/K`, and every other reference to `gone`
    /// becomes null.
    pub(crate) fn unreach(&mut self, gone: &HashSet<ObjectId>) {
        if gone.is_empty() {
            return;
        }
        let points_at_gone = |d: &Dictionary| {
            d.has_type(b"OBJR")
                && d.get(b"Obj")
                    .and_then(|o| o.as_reference())
                    .is_ok_and(|id| gone.contains(&id))
        };
        // Object references held as objects of their own.
        let own: HashSet<ObjectId> = self
            .doc
            .objects
            .iter()
            .filter(|(_, o)| o.as_dict().is_ok_and(points_at_gone))
            .map(|(id, _)| *id)
            .collect();
        let is_gone = |o: &Object| match o {
            Object::Dictionary(d) => points_at_gone(d),
            Object::Reference(id) => own.contains(id),
            _ => false,
        };
        for object in self.doc.objects.values_mut() {
            visit_dicts_mut(object, 0, &mut |d| {
                let whole = match d.get_mut(b"K") {
                    Ok(Object::Array(kids)) => {
                        kids.retain(|k| !is_gone(k));
                        false
                    }
                    Ok(kid) => is_gone(kid),
                    Err(_) => false,
                };
                if whole {
                    d.remove(b"K");
                }
            });
        }
        let mut cut = gone.clone();
        cut.extend(own);
        self.cut_references_to(&cut);
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

    /// Removes every annotation whose subtype `drop` says to; answers the
    /// ones that were objects of their own.
    fn remove_annotations(&mut self, drop: impl Fn(&[u8]) -> bool) -> HashSet<ObjectId> {
        let mut gone = HashSet::new();
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
            let (dropped, kept): (Vec<Object>, Vec<Object>) =
                annots.iter().cloned().partition(|a| {
                    let subtype = self
                        .deref(a)
                        .and_then(|o| o.as_dict().ok())
                        .and_then(|d| name_of(d.get(b"Subtype").ok()))
                        .unwrap_or(b"");
                    drop(subtype)
                });
            if !dropped.is_empty() {
                gone.extend(dropped.iter().filter_map(|a| a.as_reference().ok()));
                self.set_annotations(page, kept);
            }
        }
        gone
    }

    /// Every form field of the file: the tree under the form's `/Fields`,
    /// and each widget's parents; bounded.
    fn form_fields(&self) -> HashSet<ObjectId> {
        let mut fields = HashSet::new();
        let mut stack: Vec<ObjectId> = vec![];
        if let Some(form) = self
            .doc
            .catalog()
            .ok()
            .and_then(|c| self.resolve_dict(c.get(b"AcroForm").ok()))
        {
            if let Some(Object::Array(roots)) = form.get(b"Fields").ok().and_then(|o| self.deref(o))
            {
                stack.extend(roots.iter().filter_map(|o| o.as_reference().ok()));
            }
        }
        for &page in &self.pages {
            for (_, annot) in self.page_annotations(page) {
                if name_of(annot.get(b"Subtype").ok()) == Some(b"Widget") {
                    stack.extend(annot.get(b"Parent").and_then(|p| p.as_reference()));
                }
            }
        }
        while let Some(id) = stack.pop() {
            if fields.len() > MAX_ENTRIES || !fields.insert(id) {
                continue;
            }
            let Ok(field) = self.doc.get_dictionary(id) else {
                continue;
            };
            stack.extend(field.get(b"Parent").and_then(|p| p.as_reference()));
            if let Some(Object::Array(kids)) = field.get(b"Kids").ok().and_then(|o| self.deref(o)) {
                stack.extend(kids.iter().filter_map(|o| o.as_reference().ok()));
            }
        }
        fields
    }

    /// Draws each form field's appearance into its page, then removes the
    /// fields: what the form showed stays, its data does not. Answers the
    /// widgets and fields removed.
    fn flatten_forms(&mut self) -> HashSet<ObjectId> {
        let mut gone = self.form_fields();
        for page in self.pages.clone() {
            let annots: Vec<(Option<ObjectId>, Dictionary)> = self
                .page_annotations(page)
                .into_iter()
                .map(|(id, d)| (id, d.clone()))
                .collect();
            // Names the page's drawings already have — its own, and those
            // of a form flattened before — are not taken again.
            let mut taken: HashSet<Vec<u8>> = self
                .page_resources(page)
                .and_then(|r| self.resolve_dict(r.get(b"XObject").ok()))
                .map(|x| x.iter().map(|(k, _)| k.clone()).collect())
                .unwrap_or_default();
            let mut next = 1usize;
            let mut drawing = String::new();
            let mut forms: Vec<(String, ObjectId)> = vec![];
            for (id, annot) in annots.iter() {
                if name_of(annot.get(b"Subtype").ok()) != Some(b"Widget") {
                    continue;
                }
                gone.extend(id);
                let flags = annot.get(b"F").and_then(|f| f.as_i64()).unwrap_or(0);
                // Hidden (2) or not shown on screen (32): nothing to draw.
                if flags & (2 | 32) != 0 {
                    continue;
                }
                let Some((stream_id, a)) = self.flattened_placement(annot) else {
                    continue;
                };
                let name = loop {
                    let name = format!("WqFlat{next}");
                    next += 1;
                    if taken.insert(name.clone().into_bytes()) {
                        break name;
                    }
                };
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
        gone
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

    /// Removes what hidden layers draw — on the pages, in the drawings those
    /// use, in the appearances of annotations, and the annotations in them —
    /// then the layers themselves and every mention of them. Answers the
    /// annotations removed.
    ///
    /// "Hidden" is decided as PDFium decides it, the engine the view draws
    /// pages with (`off_layers`, `oc_shown`), so what goes is what the person
    /// did not see. A hidden layer that something shown still depends on — a
    /// membership dictionary whose policy shows content while the layer is
    /// off, content that cannot be read to strip it, a drawing no page draws
    /// (a pattern, a soft mask, a Type 3 glyph) — stays in the file, off:
    /// taken out of `/OCProperties`, a viewer would count it as on, and show
    /// what it hid, or hide what it showed.
    fn remove_hidden_layers(&mut self) -> HashSet<ObjectId> {
        let off = self.off_layers();
        let mut gone = HashSet::new();
        if off.is_empty() {
            return gone;
        }
        // The hidden layers that must stay, and the streams read.
        let mut keep: BTreeSet<ObjectId> = BTreeSet::new();
        let mut done: HashSet<ObjectId> = HashSet::new();
        for page in self.pages.clone() {
            let resources = self.page_resources(page).cloned().unwrap_or_default();
            match self.page_ops(page) {
                Some(ops) => {
                    let (kept, changed) = self.without_layers(ops, &resources, &off, &mut keep);
                    if changed {
                        if let Ok(bytes) = (Content { operations: kept }).encode() {
                            self.set_page_content(page, bytes);
                        }
                    }
                }
                None => self.layers_named_in(&resources, &off, &mut keep),
            }
            self.strip_forms_in(&resources, &off, &mut keep, &mut done, 0);
        }
        // Annotations in a hidden layer go; the appearances of the others
        // are stripped as forms are.
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
            let mut kept = Vec::with_capacity(annots.len());
            for annot in &annots {
                if let Some(oc) = self
                    .deref(annot)
                    .and_then(|o| o.as_dict().ok())
                    .and_then(|d| d.get(b"OC").ok())
                {
                    if !self.oc_shown(oc, &off, 0) {
                        gone.extend(annot.as_reference().ok());
                        continue;
                    }
                    self.depends_on(oc, &off, &mut keep);
                }
                kept.push(annot.clone());
            }
            if kept.len() != annots.len() {
                self.set_annotations(page, kept.clone());
            }
            for annot in &kept {
                for stream in self.appearance_streams(annot) {
                    self.strip_form(
                        stream,
                        &Dictionary::new(),
                        true,
                        &off,
                        &mut keep,
                        &mut done,
                        0,
                    );
                }
            }
        }
        // Drawings nothing above read keep every layer their resources name.
        let pages: HashSet<ObjectId> = self.pages.iter().copied().collect();
        let unread: Vec<Dictionary> = self
            .doc
            .objects
            .iter()
            .filter(|(id, _)| !done.contains(id) && !pages.contains(id))
            .filter_map(|(_, o)| match o {
                Object::Stream(s) => Some(&s.dict),
                Object::Dictionary(d) if !d.has_type(b"Pages") => Some(d),
                _ => None,
            })
            .filter_map(|d| self.resolve_dict(d.get(b"Resources").ok()).cloned())
            .collect();
        for resources in &unread {
            self.layers_named_in(resources, &off, &mut keep);
        }
        let mut removed: BTreeSet<ObjectId> = off.difference(&keep).copied().collect();
        if removed.is_empty() {
            return gone;
        }
        // Names nothing draws any more: a removed layer, a group hidden only
        // through removed layers, a drawing in either.
        let unused = |o: &Object| -> bool {
            let mut members = BTreeSet::new();
            self.oc_members(o, &mut members, 0);
            !self.oc_shown(o, &off, 0)
                && members
                    .iter()
                    .filter(|m| off.contains(m))
                    .all(|m| removed.contains(m))
        };
        let mut unused_ids: HashSet<ObjectId> = HashSet::new();
        // Name dictionaries (`/Properties`, `/XObject`) held as objects.
        let mut name_dicts: HashSet<ObjectId> = HashSet::new();
        for (id, object) in &self.doc.objects {
            let is_unused = match object {
                Object::Stream(s) => s.dict.get(b"OC").is_ok_and(&unused),
                Object::Dictionary(d) if off.contains(id) || d.has_type(b"OCMD") => {
                    unused(&Object::Reference(*id))
                }
                _ => false,
            };
            if is_unused {
                unused_ids.insert(*id);
            }
            visit_dicts(object, 0, &mut |d| {
                for key in [b"Properties".as_slice(), b"XObject"] {
                    if let Ok(Object::Reference(names)) = d.get(key) {
                        name_dicts.insert(*names);
                    }
                }
            });
        }
        let drop_names = |names: &mut Dictionary| {
            let dropped: Vec<Vec<u8>> = names
                .iter()
                .filter(|(_, v)| v.as_reference().is_ok_and(|r| unused_ids.contains(&r)))
                .map(|(k, _)| k.clone())
                .collect();
            for name in dropped {
                names.remove(&name);
            }
        };
        for (id, object) in self.doc.objects.iter_mut() {
            if name_dicts.contains(id) {
                if let Object::Dictionary(names) = object {
                    drop_names(names);
                }
            }
            visit_dicts_mut(object, 0, &mut |d| {
                for key in [b"Properties".as_slice(), b"XObject"] {
                    if let Ok(Object::Dictionary(names)) = d.get_mut(key) {
                        drop_names(names);
                    }
                }
            });
        }
        // A layer something reachable still refers to stays: a group that
        // names it, a drawing that is in it.
        for id in self.still_referenced(&removed, &gone) {
            removed.remove(&id);
        }
        self.remove_layers_from_properties(&removed);
        gone
    }

    /// Adds to `keep` the hidden layers optional content `oc` depends on.
    fn depends_on(&self, oc: &Object, off: &BTreeSet<ObjectId>, keep: &mut BTreeSet<ObjectId>) {
        let mut members = BTreeSet::new();
        self.oc_members(oc, &mut members, 0);
        keep.extend(members.intersection(off));
    }

    /// Adds to `keep` every hidden layer a resource dictionary names, for a
    /// stream that could not be read: what it hides must stay hidden.
    fn layers_named_in(
        &self,
        resources: &Dictionary,
        off: &BTreeSet<ObjectId>,
        keep: &mut BTreeSet<ObjectId>,
    ) {
        if let Some(properties) = self.resolve_dict(resources.get(b"Properties").ok()) {
            for (_, oc) in properties.iter().take(MAX_ENTRIES) {
                self.depends_on(oc, off, keep);
            }
        }
        if let Some(xobjects) = self.resolve_dict(resources.get(b"XObject").ok()) {
            for (_, x) in xobjects.iter().take(MAX_ENTRIES) {
                if let Some(oc) = self
                    .deref(x)
                    .and_then(|x| x.as_stream().ok())
                    .and_then(|s| s.dict.get(b"OC").ok())
                {
                    self.depends_on(oc, off, keep);
                }
            }
        }
    }

    /// The streams an annotation's appearance is drawn with: normal, rollover
    /// and down, each one stream or one per state.
    fn appearance_streams(&self, annot: &Object) -> Vec<ObjectId> {
        let mut out = vec![];
        let Some(ap) = self
            .deref(annot)
            .and_then(|o| o.as_dict().ok())
            .and_then(|d| self.resolve_dict(d.get(b"AP").ok()))
        else {
            return out;
        };
        for key in [b"N".as_slice(), b"R", b"D"] {
            let Ok(entry) = ap.get(key) else {
                continue;
            };
            match (entry, self.deref(entry)) {
                (Object::Reference(id), Some(Object::Stream(_))) => out.push(*id),
                (_, Some(Object::Dictionary(states))) => out.extend(
                    states
                        .iter()
                        .take(MAX_ENTRIES)
                        .filter_map(|(_, v)| v.as_reference().ok())
                        .filter(|id| {
                            self.doc
                                .get_object(*id)
                                .is_ok_and(|o| o.as_stream().is_ok())
                        }),
                ),
                _ => {}
            }
        }
        out
    }

    /// Hidden layers something reachable — besides `/OCProperties`, and
    /// what is `gone` — still refers to.
    fn still_referenced(
        &self,
        layers: &BTreeSet<ObjectId>,
        gone: &HashSet<ObjectId>,
    ) -> BTreeSet<ObjectId> {
        let root = self
            .doc
            .trailer
            .get(b"Root")
            .and_then(|r| r.as_reference())
            .ok();
        let mut found = BTreeSet::new();
        let mut seen: HashSet<ObjectId> = HashSet::new();
        let mut queue: Vec<ObjectId> = vec![];
        for (_, value) in self.doc.trailer.iter() {
            collect_refs(value, &mut queue, 0);
        }
        while let Some(id) = queue.pop() {
            if gone.contains(&id) || !seen.insert(id) {
                continue;
            }
            if layers.contains(&id) {
                found.insert(id);
                continue;
            }
            match self.doc.get_object(id) {
                Ok(Object::Dictionary(catalog)) if Some(id) == root => {
                    for (key, value) in catalog.iter() {
                        if key != b"OCProperties" {
                            collect_refs(value, &mut queue, 0);
                        }
                    }
                }
                Ok(object) => collect_refs(object, &mut queue, 0),
                Err(_) => {}
            }
        }
        found
    }

    /// The operators of a content stream without the marked content and
    /// the drawings in a hidden layer; the hidden layers that what is kept
    /// depends on are added to `keep`.
    fn without_layers(
        &self,
        ops: Vec<Operation>,
        resources: &Dictionary,
        off: &BTreeSet<ObjectId>,
        keep: &mut BTreeSet<ObjectId>,
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
                        if let Some(target) = target {
                            if !self.oc_shown(target, off, 0) {
                                hidden_from = Some(depth);
                                changed = true;
                                continue;
                            }
                            self.depends_on(target, off, keep);
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
                    if let Some(oc) = name_of(op.operands.first())
                        .and_then(|n| xobjects.and_then(|x| x.get(n).ok()))
                        .and_then(|x| self.deref(x))
                        .and_then(|x| x.as_stream().ok())
                        .and_then(|s| s.dict.get(b"OC").ok())
                    {
                        if !self.oc_shown(oc, off, 0) {
                            changed = true;
                            continue;
                        }
                        self.depends_on(oc, off, keep);
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

    /// `strip_form` for every form a resource dictionary names.
    fn strip_forms_in(
        &mut self,
        resources: &Dictionary,
        off: &BTreeSet<ObjectId>,
        keep: &mut BTreeSet<ObjectId>,
        done: &mut HashSet<ObjectId>,
        depth: usize,
    ) {
        let forms: Vec<ObjectId> = self
            .resolve_dict(resources.get(b"XObject").ok())
            .map(|x| {
                x.iter()
                    .take(MAX_ENTRIES)
                    .filter_map(|(_, v)| v.as_reference().ok())
                    .collect()
            })
            .unwrap_or_default();
        for id in forms {
            self.strip_form(id, resources, false, off, keep, done, depth);
        }
    }

    /// A form XObject — or an appearance, whose stream may not say it is
    /// one — without what hidden layers draw in it, and the forms it draws
    /// in turn; each once. A form with no resources of its own uses
    /// `inherited`. One that cannot be read keeps the layers it names.
    #[allow(clippy::too_many_arguments)]
    fn strip_form(
        &mut self,
        id: ObjectId,
        inherited: &Dictionary,
        appearance: bool,
        off: &BTreeSet<ObjectId>,
        keep: &mut BTreeSet<ObjectId>,
        done: &mut HashSet<ObjectId>,
        depth: usize,
    ) {
        if depth > 8 || !done.insert(id) {
            return;
        }
        let Ok(stream) = self.doc.get_object(id).and_then(|o| o.as_stream()) else {
            return;
        };
        let subtype = name_of(stream.dict.get(b"Subtype").ok());
        if subtype != Some(b"Form") && !(appearance && subtype.is_none()) {
            return;
        }
        let own = self
            .resolve_dict(stream.dict.get(b"Resources").ok())
            .cloned()
            .unwrap_or_else(|| inherited.clone());
        let ops = stream
            .decompressed_content_with_limit(MAX_CONTENT)
            .ok()
            .and_then(|bytes| Content::decode(&bytes).ok());
        let Some(content) = ops else {
            self.layers_named_in(&own, off, keep);
            return;
        };
        let (kept, changed) = self.without_layers(content.operations, &own, off, keep);
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
        self.strip_forms_in(&own, off, keep, done, depth + 1);
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
/// page's visible box in its own space, and `xobjects` what each drawing
/// the page names covers (`PdfDocument::xobject_boxes`).
///
/// White text is hidden only where nothing but white was painted under it
/// before: white on a coloured band, a table's shaded header or a picture
/// is seen. What is under it is judged by boxes — a path's, a picture's, a
/// form's, all of a shading's — so white text beside one, but inside its
/// box, counts as seen too: the doubt leaves text in place.
fn find_hidden_runs(
    ops: &[Operation],
    crop: [f32; 4],
    xobjects: &std::collections::HashMap<Vec<u8>, [f32; 4]>,
) -> Vec<HiddenRun> {
    #[derive(Clone)]
    struct State {
        ctm: Matrix,
        fill_space: Vec<u8>,
        fill_white: bool,
        stroke_space: Vec<u8>,
        // Black until a file says otherwise.
        stroke_white: bool,
        mode: i64,
    }
    let mut state = State {
        ctm: Matrix::IDENTITY,
        fill_space: b"DeviceGray".to_vec(),
        fill_white: false,
        stroke_space: b"DeviceGray".to_vec(),
        stroke_white: false,
        mode: 0,
    };
    let mut stack: Vec<State> = vec![];
    let (mut tm, mut tlm) = (Matrix::IDENTITY, Matrix::IDENTITY);
    let (mut leading, mut size) = (0.0f32, 0.0f32);
    // What was painted, in anything but white, before: boxes in page space.
    let mut painted: Vec<[f32; 4]> = vec![];
    // The path being built, as a box in page space.
    let mut path: Option<[f32; 4]> = None;
    let bounds = |points: &[(f32, f32)]| -> [f32; 4] {
        let mut b = [f32::MAX, f32::MAX, f32::MIN, f32::MIN];
        for &(x, y) in points {
            b = [b[0].min(x), b[1].min(y), b[2].max(x), b[3].max(y)];
        }
        b
    };
    let grow = |path: &mut Option<[f32; 4]>, b: [f32; 4]| {
        *path = Some(match *path {
            Some(p) => [
                p[0].min(b[0]),
                p[1].min(b[1]),
                p[2].max(b[2]),
                p[3].max(b[3]),
            ],
            None => b,
        });
    };
    // A box in some space, through a matrix, as a box in page space.
    let placed = |m: Matrix, b: [f32; 4]| -> [f32; 4] {
        bounds(&[
            m.apply(b[0], b[1]),
            m.apply(b[2], b[1]),
            m.apply(b[0], b[3]),
            m.apply(b[2], b[3]),
        ])
    };
    let overlaps =
        |a: [f32; 4], b: [f32; 4]| a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
    // Every show in the current text object: (op index, hidden reason,
    // whether it is placed on its own rather than after the one before).
    let mut shows: Vec<(usize, Option<Reason>, bool)> = vec![];
    let mut placed_own = true;
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
        let point = |k: usize| state.ctm.apply(num(&a[k]), num(&a[k + 1]));
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
            "G" if a.len() == 1 => {
                state.stroke_space = b"DeviceGray".to_vec();
                state.stroke_white = white(b"DeviceGray", &[num(&a[0])]);
            }
            "RG" if a.len() == 3 => {
                state.stroke_space = b"DeviceRGB".to_vec();
                state.stroke_white = white(b"DeviceRGB", &a.iter().map(num).collect::<Vec<_>>());
            }
            "K" if a.len() == 4 => {
                state.stroke_space = b"DeviceCMYK".to_vec();
                state.stroke_white = white(b"DeviceCMYK", &a.iter().map(num).collect::<Vec<_>>());
            }
            "CS" => {
                state.stroke_space = name_of(a.first()).unwrap_or(b"").to_vec();
                state.stroke_white = false;
            }
            "SC" | "SCN" => {
                let values: Vec<f32> = a.iter().filter(|o| o.as_float().is_ok()).map(num).collect();
                state.stroke_white = white(&state.stroke_space, &values);
            }
            // The path, and what painting it covers.
            "m" | "l" if a.len() >= 2 => grow(&mut path, bounds(&[point(0)])),
            "c" if a.len() >= 6 => grow(&mut path, bounds(&[point(0), point(2), point(4)])),
            "v" | "y" if a.len() >= 4 => grow(&mut path, bounds(&[point(0), point(2)])),
            "re" if a.len() >= 4 => {
                let (x, y, w, h) = (num(&a[0]), num(&a[1]), num(&a[2]), num(&a[3]));
                grow(&mut path, placed(state.ctm, [x, y, x + w, y + h]));
            }
            "f" | "F" | "f*" | "B" | "B*" | "b" | "b*" => {
                if let Some(b) = path.take() {
                    if !state.fill_white {
                        painted.push(b);
                    }
                }
            }
            "S" | "s" | "n" => path = None,
            // A shading paints whatever the clip leaves: the page, at most.
            "sh" => painted.push(crop),
            "Do" => painted.push(
                name_of(a.first())
                    .and_then(|n| xobjects.get(n))
                    .map_or(crop, |b| placed(state.ctm, *b)),
            ),
            "BI" => painted.push(placed(state.ctm, [0.0, 0.0, 1.0, 1.0])),
            "Tr" if !a.is_empty() => state.mode = a[0].as_i64().unwrap_or(0),
            "BT" => {
                tm = Matrix::IDENTITY;
                tlm = tm;
                shows.clear();
                placed_own = true;
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
                placed_own = true;
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
                placed_own = true;
            }
            "T*" => {
                tlm = Matrix([1.0, 0.0, 0.0, 1.0, 0.0, -leading]).then(tlm);
                tm = tlm;
                placed_own = true;
            }
            "Tj" | "TJ" | "'" | "\"" => {
                if matches!(op.operator.as_str(), "'" | "\"") {
                    tlm = Matrix([1.0, 0.0, 0.0, 1.0, 0.0, -leading]).then(tlm);
                    tm = tlm;
                    placed_own = true;
                }
                let full = tm.then(state.ctm);
                let (x, y) = full.apply(0.0, 0.0);
                let margin = (size * full.scale()).abs().max(1.0) * 2.0;
                // What the run shows with: its fill, its stroke, or both.
                let fills = matches!(state.mode, 0 | 2 | 4 | 6);
                let strokes = matches!(state.mode, 1 | 2 | 5 | 6);
                let all_white = (!fills || state.fill_white) && (!strokes || state.stroke_white);
                // Where it is drawn, generously: every code as wide as the
                // font is high, from below the baseline to above the caps.
                let codes = shown_bytes(op).max(1) as f32;
                let text_box = placed(full, [0.0, -0.3 * size, codes * size, 1.1 * size]);
                let reason = if shows_nothing(op) {
                    None
                } else if matches!(state.mode, 3 | 7) {
                    Some(Reason::Invisible)
                } else if all_white && !painted.iter().any(|p| overlaps(*p, text_box)) {
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
                shows.push((i, reason, placed_own));
                placed_own = false;
            }
            _ => {}
        }
    }
    finish(&mut shows, &mut out);
    out
}

/// How many bytes of text a showing operator carries.
fn shown_bytes(op: &Operation) -> usize {
    match op.operands.last() {
        Some(Object::String(s, _)) => s.len(),
        Some(Object::Array(items)) => items
            .iter()
            .map(|i| match i {
                Object::String(s, _) => s.len(),
                _ => 0,
            })
            .sum(),
        _ => 0,
    }
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
            &[
                "DOCJS-SECRET",
                "OPENACTION-SECRET",
                "PAGE-AA-SECRET",
                "NEXT-JS-SECRET",
                "NEXT-SUBMIT-SECRET",
            ],
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
        assert_eq!(
            layers.details,
            vec![Detail::Name("LAYERNAME-OFF-SECRET".to_string())]
        );
        // The core's words, the annotations' kinds and the properties' keys
        // come apart from what the file names, for the interface to say.
        let details = |kind: Hidden| {
            report
                .findings
                .iter()
                .find(|f| f.kind == kind)
                .unwrap()
                .details
                .clone()
        };
        assert_eq!(
            details(Hidden::HiddenText),
            [
                Detail::Word("invisible", 1),
                Detail::Word("white", 1),
                Detail::Word("offPage", 1)
            ]
        );
        assert_eq!(
            details(Hidden::Comments),
            [Detail::Subtype("Text".into(), 1)]
        );
        assert!(details(Hidden::Metadata).contains(&Detail::Property(
            "Title".into(),
            "INFO-TITLE-SECRET".into()
        )));
        assert!(details(Hidden::Scripts).contains(&Detail::Word("Actions", 2)));
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
                if other == kind {
                    continue;
                }
                // A bookmark carries a web address, and runs a script and
                // submits the form after going to its page: removed, it
                // takes them.
                let with_bookmark = [
                    "bookmark-uri-secret.example",
                    "NEXT-JS-SECRET",
                    "NEXT-SUBMIT-SECRET",
                ];
                for m in *others {
                    if *kind == Hidden::Bookmarks && with_bookmark.contains(m) {
                        continue;
                    }
                    assert!(text.contains(m), "{kind:?} took {m} ({other:?}) with it");
                }
            }
            for kept in [
                "VISIBLE-TEXT-KEPT",
                "LAYER-ON-TEXT",
                "Visible again",
                "WHITE-ON-BLUE-SHOWN",
            ] {
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
        // White text on a dark band is seen, and stays.
        for kept in [
            "VISIBLE-TEXT-KEPT",
            "LAYER-ON-TEXT",
            "FIELD-SHOWN",
            "WHITE-ON-BLUE-SHOWN",
        ] {
            assert!(text.contains(kept), "{kept} went too");
        }
        let reopened = PdfDocument::open(out, None).unwrap();
        let report = reopened.hidden_report();
        assert!(report.findings.is_empty(), "{report:#?}");
        assert_eq!(report.unreachable, 0);
        // Still a tagged file: its structure stays, without what it pointed at.
        let catalog = reopened.doc.catalog().unwrap();
        let tree = catalog
            .get(b"StructTreeRoot")
            .unwrap()
            .as_reference()
            .unwrap();
        assert!(reopened.doc.get_dictionary(tree).is_ok());
    }

    /// A tagged file's structure tree points at its annotations (`/OBJR`):
    /// an annotation taken off its page must not stay reachable through it,
    /// with its text, its field's name and value, or its attached file.
    #[test]
    fn what_the_structure_tree_pointed_at_goes_with_the_annotation() {
        let doc = PdfDocument::open(fixture(), None).unwrap();
        for kind in [
            Hidden::Comments,
            Hidden::Forms,
            Hidden::Attachments,
            Hidden::Links,
        ] {
            let out = doc.without_hidden(&[kind].into_iter().collect()).unwrap();
            let copy = PdfDocument::open(out, None).unwrap();
            // No object reference left pointing at an annotation of the kind.
            for object in copy.doc.objects.values() {
                visit_dicts(object, 0, &mut |d| {
                    if d.has_type(b"OBJR") {
                        let target = d
                            .get(b"Obj")
                            .and_then(|o| o.as_reference())
                            .expect("an OBJR left points at an object");
                        let subtype = copy
                            .doc
                            .get_dictionary(target)
                            .ok()
                            .and_then(|t| name_of(t.get(b"Subtype").ok()));
                        let gone: &[u8] = match kind {
                            Hidden::Comments => b"Text",
                            Hidden::Forms => b"Widget",
                            Hidden::Attachments => b"FileAttachment",
                            _ => b"Link",
                        };
                        assert_ne!(subtype, Some(gone), "{kind:?}: an OBJR still points at one");
                    }
                });
            }
        }
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

    /// A file of `objects` (number, body): the catalog is object 1, and the
    /// cross-reference table is written for them.
    pub(crate) fn file_of(objects: &[(u32, String)]) -> Vec<u8> {
        let mut sorted = objects.to_vec();
        sorted.sort_by_key(|(n, _)| *n);
        let mut out = b"%PDF-1.7\n".to_vec();
        let mut offsets = std::collections::BTreeMap::new();
        for (n, body) in &sorted {
            offsets.insert(*n, out.len());
            out.extend(format!("{n} 0 obj\n{body}\nendobj\n").into_bytes());
        }
        let size = sorted.last().map_or(1, |(n, _)| n + 1);
        let xref = out.len();
        out.extend(format!("xref\n0 {size}\n0000000000 65535 f \n").into_bytes());
        for n in 1..size {
            match offsets.get(&n) {
                Some(at) => out.extend(format!("{at:010} 00000 n \n").into_bytes()),
                None => out.extend(b"0000000000 65535 f \n"),
            }
        }
        out.extend(
            format!("trailer\n<< /Size {size} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n")
                .into_bytes(),
        );
        out
    }

    /// A content stream object, uncompressed.
    fn content(ops: &str) -> String {
        format!("<< /Length {} >>\nstream\n{ops}\nendstream", ops.len())
    }

    /// One page (object 3, its content object 4, Helvetica 5), with `page`
    /// added to the page dictionary, `catalog` to the catalog, and `more`.
    fn one_page(catalog: &str, page: &str, ops: &str, more: &[(u32, &str)]) -> Vec<u8> {
        let mut objects = vec![
            (1, format!("<< /Type /Catalog /Pages 2 0 R {catalog} >>")),
            (2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string()),
            (
                3,
                format!(
                    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R {page} >>"
                ),
            ),
            (4, content(ops)),
            (
                5,
                "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
            ),
        ];
        objects.extend(more.iter().map(|(n, body)| (*n, body.to_string())));
        file_of(&objects)
    }

    fn scripts(doc: &PdfDocument) -> usize {
        doc.hidden_report()
            .findings
            .iter()
            .find(|f| f.kind == Hidden::Scripts)
            .map_or(0, |f| f.count)
    }

    /// An action is usually an object of its own, with no `/Type`: a link
    /// whose `/A` points at a script runs it all the same. And an action
    /// runs the ones chained after it (`/Next`), by reference too.
    #[test]
    fn a_script_behind_a_reference_or_after_another_action_is_reported_and_removed() {
        let bytes = one_page(
            "",
            "/Annots [10 0 R 11 0 R]",
            "BT /F1 12 Tf 72 700 Td (Links) Tj ET",
            &[
                (
                    10,
                    "<< /Type /Annot /Subtype /Link /Rect [72 690 200 710] /A 12 0 R >>",
                ),
                (
                    11,
                    "<< /Type /Annot /Subtype /Link /Rect [72 650 200 670] \
                     /A << /S /GoTo /D [3 0 R /Fit] /Next 13 0 R >> >>",
                ),
                (12, "<< /S /JavaScript /JS (app.alert('INDIRECT-A-SECRET')) >>"),
                (
                    13,
                    "<< /S /SubmitForm /F << /FS /URL /F (https://NEXT-SUBMIT-SECRET.example) >> >>",
                ),
            ],
        );
        let doc = PdfDocument::open(bytes, None).unwrap();
        assert_eq!(scripts(&doc), 2, "{:#?}", doc.hidden_report());
        let out = doc
            .without_hidden(&[Hidden::Scripts].into_iter().collect())
            .unwrap();
        let text = readable(&out);
        assert!(!text.contains("INDIRECT-A-SECRET"));
        assert!(!text.contains("NEXT-SUBMIT-SECRET"));
        let copy = PdfDocument::open(out, None).unwrap();
        assert_eq!(scripts(&copy), 0);
        // The links stay, and the second still goes to its page.
        let annots = copy.page_annotations(copy.pages[0]);
        assert_eq!(annots.len(), 2);
        let goto = copy.resolve_dict(annots[1].1.get(b"A").ok()).unwrap();
        assert_eq!(name_of(goto.get(b"S").ok()), Some(b"GoTo".as_slice()));
        assert!(!goto.has(b"Next"));
    }

    /// White text shows on what was painted under it: only white on white
    /// is hidden. Outlined text is seen in the stroke's colour, which is
    /// black until a file says otherwise.
    #[test]
    fn white_text_is_hidden_only_where_nothing_but_white_is_under_it() {
        let runs = |ops: &str| {
            let ops = Content::decode(ops.as_bytes()).unwrap().operations;
            find_hidden_runs(&ops, [0.0, 0.0, 612.0, 792.0], &Default::default())
                .into_iter()
                .map(|r| r.reason)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            runs("1 g BT /F1 12 Tf 72 700 Td (on the page) Tj ET"),
            [Reason::White]
        );
        assert!(
            runs("0 0 0.5 rg 0 690 612 30 re f 1 g BT /F1 12 Tf 72 700 Td (on a band) Tj ET")
                .is_empty(),
            "on a dark band it is seen"
        );
        assert_eq!(
            runs("0 0 0.5 rg 0 100 612 30 re f 1 g BT /F1 12 Tf 72 700 Td (above it) Tj ET"),
            [Reason::White],
            "a band elsewhere changes nothing"
        );
        assert!(
            runs(
                "q 400 0 0 300 50 500 cm /Im1 Do Q 1 g BT /F1 12 Tf 72 700 Td (on a picture) Tj ET"
            )
            .is_empty(),
            "a picture under it may be dark"
        );
        assert_eq!(
            runs("1 g 0 690 612 30 re f 1 g BT /F1 12 Tf 72 700 Td (white on white) Tj ET"),
            [Reason::White]
        );
        assert!(
            runs("1 g 1 Tr BT /F1 12 Tf 72 700 Td (outlined) Tj ET").is_empty(),
            "stroked in the default black"
        );
        assert_eq!(
            runs("1 g 1 G 2 Tr BT /F1 12 Tf 72 700 Td (all white) Tj ET"),
            [Reason::White],
            "filled and stroked in white"
        );
    }

    /// A form XObject object drawing `text`, uncompressed.
    fn form(text: &str) -> String {
        let ops = format!("BT /F1 12 Tf 2 6 Td ({text}) Tj ET");
        format!(
            "<< /Type /XObject /Subtype /Form /BBox [0 0 200 24] \
             /Resources << /Font << /F1 5 0 R >> >> /Length {} >>\nstream\n{ops}\nendstream",
            ops.len()
        )
    }

    /// Membership dictionaries (OCMD) show or hide by their policy (`/P`)
    /// or their expression (`/VE`): what one hides goes; what one shows
    /// stays, and so does a hidden layer it depends on — switched off, or
    /// a viewer would count it as on and change what shows.
    #[test]
    fn hidden_layers_follow_the_policy_of_the_groups_that_use_them() {
        let ocmd = |body: &str| format!("<< /Type /OCMD {body} >>");
        let bytes = one_page(
            "/OCProperties << /OCGs [20 0 R 21 0 R] /D << /ON [21 0 R] /OFF [20 0 R] >> >>",
            "/Resources << /Font << /F1 5 0 R >> /Properties << /Off 20 0 R /AllOn 30 0 R \
             /AllOff 31 0 R /AnyOff 32 0 R /And 33 0 R /Not 34 0 R /Single 35 0 R >> >>",
            "/OC /Off BDC BT /F1 12 Tf 72 700 Td (OFF-LAYER-SECRET) Tj ET EMC\n\
             /OC /AllOn BDC BT /F1 12 Tf 72 680 Td (ALLON-HIDDEN-SECRET) Tj ET EMC\n\
             /OC /AllOff BDC BT /F1 12 Tf 72 660 Td (ALLOFF-SHOWN) Tj ET EMC\n\
             /OC /AnyOff BDC BT /F1 12 Tf 72 640 Td (ANYOFF-SHOWN) Tj ET EMC\n\
             /OC /And BDC BT /F1 12 Tf 72 620 Td (VE-AND-HIDDEN-SECRET) Tj ET EMC\n\
             /OC /Not BDC BT /F1 12 Tf 72 600 Td (VE-NOT-SHOWN) Tj ET EMC\n\
             /OC /Single BDC BT /F1 12 Tf 72 580 Td (SINGLE-HIDDEN-SECRET) Tj ET EMC",
            &[
                (20, "<< /Type /OCG /Name (Off layer) >>"),
                (21, "<< /Type /OCG /Name (On layer) >>"),
                (30, &ocmd("/OCGs [20 0 R 21 0 R] /P /AllOn")),
                // A list: PDFium reads one layer given alone by its state,
                // whatever the policy says.
                (31, &ocmd("/OCGs [20 0 R] /P /AllOff")),
                (32, &ocmd("/OCGs [20 0 R 21 0 R] /P /AnyOff")),
                (33, &ocmd("/OCGs [21 0 R] /VE [/And 20 0 R 21 0 R]")),
                (34, &ocmd("/VE [/Not 20 0 R]")),
                (35, &ocmd("/OCGs 20 0 R /P /AllOff")),
            ],
        );
        let doc = PdfDocument::open(bytes, None).unwrap();
        let out = doc
            .without_hidden(&[Hidden::HiddenLayers].into_iter().collect())
            .unwrap();
        let text = readable(&out);
        for gone in [
            "OFF-LAYER-SECRET",
            "ALLON-HIDDEN-SECRET",
            "VE-AND-HIDDEN-SECRET",
            "SINGLE-HIDDEN-SECRET",
        ] {
            assert!(!text.contains(gone), "{gone} is still in the file");
        }
        for shown in ["ALLOFF-SHOWN", "ANYOFF-SHOWN", "VE-NOT-SHOWN"] {
            assert!(text.contains(shown), "{shown} was shown, and went");
        }
        // The shown groups depend on the hidden layer being off: it stays so.
        let copy = PdfDocument::open(out, None).unwrap();
        assert_eq!(copy.off_layers(), [(20, 0)].into_iter().collect());
    }

    /// PDFium hides a layer whose own view state is off, whatever the
    /// configuration says; a drawing inside an annotation's appearance can
    /// be in a hidden layer too.
    #[test]
    fn a_layer_off_by_its_view_state_and_layers_in_appearances_are_removed() {
        let bytes = one_page(
            "/OCProperties << /OCGs [20 0 R 21 0 R] /D << /ON [20 0 R 21 0 R] >> >>",
            "/Resources << /Font << /F1 5 0 R >> /Properties << /Seen 21 0 R /ViewOff 20 0 R >> >> \
             /Annots [10 0 R]",
            "/OC /ViewOff BDC BT /F1 12 Tf 72 700 Td (VIEWSTATE-OFF-SECRET) Tj ET EMC\n\
             /OC /Seen BDC BT /F1 12 Tf 72 680 Td (SEEN-LAYER-SHOWN) Tj ET EMC",
            &[
                (
                    20,
                    "<< /Type /OCG /Name (VIEW-OFF-NAME) /Usage << /View << /ViewState /OFF >> >> >>",
                ),
                (21, "<< /Type /OCG /Name (Seen) >>"),
                (
                    10,
                    "<< /Type /Annot /Subtype /Square /Rect [300 600 400 700] /AP << /N 11 0 R >> >>",
                ),
                (
                    11,
                    &{
                        let ops = "/OC /L BDC BT /F1 12 Tf 2 6 Td (AP-LAYER-SECRET) Tj ET EMC \
                                   BT /F1 12 Tf 2 20 Td (AP-SHOWN) Tj ET";
                        format!(
                            "<< /Type /XObject /Subtype /Form /BBox [0 0 100 100] /Resources \
                             << /Font << /F1 5 0 R >> /Properties << /L 20 0 R >> >> /Length {} \
                             >>\nstream\n{ops}\nendstream",
                            ops.len()
                        )
                    },
                ),
            ],
        );
        let doc = PdfDocument::open(bytes, None).unwrap();
        let layers = doc
            .hidden_report()
            .findings
            .into_iter()
            .find(|f| f.kind == Hidden::HiddenLayers)
            .expect("the layer off by its view state is reported");
        assert_eq!(layers.count, 1);
        let out = doc
            .without_hidden(&[Hidden::HiddenLayers].into_iter().collect())
            .unwrap();
        let text = readable(&out);
        for gone in ["VIEWSTATE-OFF-SECRET", "AP-LAYER-SECRET", "VIEW-OFF-NAME"] {
            assert!(!text.contains(gone), "{gone} is still in the file");
        }
        for shown in ["SEEN-LAYER-SHOWN", "AP-SHOWN"] {
            assert!(text.contains(shown), "{shown} went");
        }
    }

    /// Content that cannot be read cannot be stripped: the layer that hides
    /// it stays in the file, switched off, rather than let it show.
    #[test]
    fn a_hidden_layer_over_content_that_cannot_be_read_stays_off() {
        let bytes = file_of(&[
            (
                1,
                "<< /Type /Catalog /Pages 2 0 R \
                 /OCProperties << /OCGs [20 0 R] /D << /OFF [20 0 R] >> >> >>"
                    .into(),
            ),
            (2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".into()),
            (
                3,
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R \
                 /Resources << /Properties << /Off 20 0 R >> >> >>"
                    .into(),
            ),
            // Encoded as nothing this reader knows.
            (
                4,
                "<< /Length 9 /Filter /FooDecode >>\nstream\nnot read!\nendstream".into(),
            ),
            (20, "<< /Type /OCG /Name (Off layer) >>".into()),
        ]);
        let doc = PdfDocument::open(bytes, None).unwrap();
        assert_eq!(doc.off_layers().len(), 1);
        let out = doc
            .without_hidden(&[Hidden::HiddenLayers].into_iter().collect())
            .unwrap();
        let copy = PdfDocument::open(out, None).unwrap();
        assert_eq!(
            copy.off_layers().len(),
            1,
            "the layer is still there, and off"
        );
    }

    /// A page flattened once draws its fields as `/WqFlat1`, `/WqFlat2`…: a
    /// second flattening names its drawings anew, and the first stay.
    #[test]
    fn a_second_flattening_keeps_the_drawings_of_the_first() {
        let bytes = one_page(
            "/AcroForm << /Fields [11 0 R] >>",
            "/Resources << /Font << /F1 5 0 R >> /XObject << /WqFlat1 10 0 R >> >> /Annots [11 0 R]",
            "q 1 0 0 1 72 600 cm /WqFlat1 Do Q",
            &[
                (10, &form("EARLIER-FIELD-SHOWN")),
                (
                    11,
                    "<< /Type /Annot /Subtype /Widget /FT /Tx /T (NEW-FIELD-NAME) \
                     /Rect [72 500 272 524] /F 4 /AP << /N 12 0 R >> >>",
                ),
                (12, &form("NEW-FIELD-SHOWN")),
            ],
        );
        let doc = PdfDocument::open(bytes, None).unwrap();
        let out = doc
            .without_hidden(&[Hidden::Forms].into_iter().collect())
            .unwrap();
        let text = readable(&out);
        assert!(!text.contains("NEW-FIELD-NAME"));
        for shown in ["EARLIER-FIELD-SHOWN", "NEW-FIELD-SHOWN"] {
            assert!(text.contains(shown), "{shown} is no longer drawn");
        }
        let copy = PdfDocument::open(out, None).unwrap();
        let xobjects = copy
            .resolve_dict(
                copy.page_resources(copy.pages[0])
                    .unwrap()
                    .get(b"XObject")
                    .ok(),
            )
            .unwrap();
        let drawn: HashSet<ObjectId> = xobjects
            .iter()
            .filter_map(|(_, v)| v.as_reference().ok())
            .collect();
        assert_eq!(drawn.len(), 2, "each drawing under a name of its own");
    }

    #[test]
    fn hidden_text_that_would_move_visible_text_is_left_in_place() {
        let ops = Content::decode(
            b"BT /F1 12 Tf 10 10 Td 3 Tr (a) Tj 0 Tr (b) Tj ET BT 3 Tr 10 20 Td (c) Tj 0 Tr 0 -12 Td (d) Tj ET",
        )
        .unwrap()
        .operations;
        let runs = find_hidden_runs(&ops, [0.0, 0.0, 612.0, 792.0], &Default::default());
        assert_eq!(runs.len(), 2);
        assert!(!runs[0].removable, "b follows a without a place of its own");
        assert!(runs[1].removable, "d is placed by its own Td");
    }
}
