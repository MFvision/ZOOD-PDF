//! Modification listing between a signed revision and the current document, with every
//! change classified by what it touches (page content, annotations, form fields, signatures,
//! validation data…) and whether the signature's DocMDP/FieldMDP policy allows it.
//!
//! The comparison is object-level and semantic (`warraq_pdf::compare`): the signed revision
//! is loaded from its byte prefix and compared with the document a viewer would display.
//! Shadow-attack evidence (objects already present in the signed bytes but only activated
//! later, xref entries re-pointed into signed bytes) is reported separately.

use crate::pdfobj::{self, get_name};
use lopdf::{Dictionary, Object, ObjectId};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, HashSet, VecDeque};
use warraq_pdf::compare::objects_equal;
use warraq_pdf::Pdf;

/// One detected change.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    /// Machine-readable kind (see `kind_*` below).
    pub kind: &'static str,
    /// Whether the signature's policy allows it.
    pub allowed: bool,
    /// Object `"N G"` when object-level.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub object: Option<String>,
    /// 0-based page.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<usize>,
    /// Field name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    /// Human-readable detail (English; the UI localises by `kind`).
    pub detail: String,
}

/// Evidence of an attack pattern.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Attack {
    /// `shadow_hide`, `shadow_replace`, `shadow_hide_and_replace`, `overlay`,
    /// `incremental_saving`, `signature_wrapping`, `borrowed_signature`, `xref_manipulation`,
    /// `trailing_data`.
    pub kind: &'static str,
    /// Detail.
    pub detail: String,
}

/// Field locks in force (FieldMDP).
#[derive(Debug, Clone, Default)]
pub struct Locks {
    /// Every field is locked.
    pub all: bool,
    /// Locked names.
    pub include: BTreeSet<String>,
    /// Everything except these (one set per Exclude lock; a field is locked when missing
    /// from any of them).
    pub exclude: Vec<BTreeSet<String>>,
}

impl Locks {
    /// Add a lock.
    pub fn add(&mut self, l: &crate::sign::FieldLock) {
        match l.action {
            crate::sign::LockAction::All => self.all = true,
            crate::sign::LockAction::Include => self.include.extend(l.fields.iter().cloned()),
            crate::sign::LockAction::Exclude => {
                self.exclude.push(l.fields.iter().cloned().collect())
            }
        }
    }
    /// Is `name` (or one of its ancestors) locked?
    pub fn locked(&self, name: &str) -> bool {
        if self.all {
            return true;
        }
        let mut prefixes = vec![name.to_string()];
        let mut n = name;
        while let Some(i) = n.rfind('.') {
            n = n.get(..i).unwrap_or_default();
            prefixes.push(n.to_string());
        }
        prefixes.iter().any(|p| self.include.contains(p))
            || self
                .exclude
                .iter()
                .any(|ex| !prefixes.iter().any(|p| ex.contains(p)))
    }
}

/// The policy a change is judged against.
#[derive(Debug, Clone, Default)]
pub struct Policy {
    /// DocMDP P of a certification signature that precedes the changes (None = approval
    /// signatures only).
    pub docmdp: Option<u8>,
    /// Field locks.
    pub locks: Locks,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Role {
    Unreferenced,
    Other,
    Metadata,
    Dss,
    SigValue,
    Appearance,
    AcroForm,
    Field,
    Annotation,
    Widget,
    PageTree,
    Page,
    Content,
    Catalog,
}

struct Map {
    roles: BTreeMap<ObjectId, Role>,
    /// Appearance / widget → owning annotation.
    owner: BTreeMap<ObjectId, ObjectId>,
    /// Annotation → page index.
    annot_page: BTreeMap<ObjectId, usize>,
    /// Field/widget → fully qualified field name.
    field_name: BTreeMap<ObjectId, String>,
    /// Widget → field object.
    widget_field: BTreeMap<ObjectId, ObjectId>,
    pages: Vec<ObjectId>,
    reachable: HashSet<ObjectId>,
}

fn refs_in(o: &Object, out: &mut Vec<ObjectId>, depth: usize) {
    if depth > 64 {
        return;
    }
    match o {
        Object::Reference(id) => out.push(*id),
        Object::Array(a) => a.iter().for_each(|x| refs_in(x, out, depth + 1)),
        Object::Dictionary(d) => d.iter().for_each(|(_, v)| refs_in(v, out, depth + 1)),
        Object::Stream(s) => s.dict.iter().for_each(|(_, v)| refs_in(v, out, depth + 1)),
        _ => {}
    }
}

/// Objects reachable from `start` (bounded), not entering `stop` keys of dictionaries.
fn closure(pdf: &Pdf, start: &[ObjectId], skip_keys: &[&[u8]], limit: usize) -> Vec<ObjectId> {
    let mut seen = HashSet::new();
    let mut order = Vec::new();
    let mut q: VecDeque<ObjectId> = start.iter().copied().collect();
    while let Some(id) = q.pop_front() {
        if !seen.insert(id) || order.len() >= limit {
            continue;
        }
        let Some(o) = pdf.get(id) else { continue };
        order.push(id);
        let mut refs = Vec::new();
        match o {
            Object::Dictionary(d) => {
                for (k, v) in d.iter() {
                    if !skip_keys.contains(&k.as_slice()) {
                        refs_in(v, &mut refs, 0);
                    }
                }
            }
            Object::Stream(s) => {
                for (k, v) in s.dict.iter() {
                    if !skip_keys.contains(&k.as_slice()) {
                        refs_in(v, &mut refs, 0);
                    }
                }
            }
            other => refs_in(other, &mut refs, 0),
        }
        q.extend(refs);
    }
    order
}

fn set_role(m: &mut Map, id: ObjectId, r: Role) {
    let e = m.roles.entry(id).or_insert(r);
    if r > *e {
        *e = r;
    }
}

fn map_document(pdf: &Pdf) -> Map {
    let limit = crate::limits::MAX_DIFF_OBJECTS;
    let mut m = Map {
        roles: BTreeMap::new(),
        owner: BTreeMap::new(),
        annot_page: BTreeMap::new(),
        field_name: BTreeMap::new(),
        widget_field: BTreeMap::new(),
        pages: Vec::new(),
        reachable: HashSet::new(),
    };
    if let Ok(reach) = pdf.reachable() {
        m.reachable = reach.into_iter().collect();
    }
    for id in m.reachable.clone() {
        set_role(&mut m, id, Role::Other);
    }
    let Ok(root) = pdf.root_id() else { return m };
    set_role(&mut m, root, Role::Catalog);
    if let Ok(Object::Reference(i)) = pdf.trailer().get(b"Info") {
        set_role(&mut m, *i, Role::Metadata);
    }
    let cat = pdf.catalog().ok().cloned().unwrap_or_default();
    if let Ok(Object::Reference(x)) = cat.get(b"Metadata") {
        set_role(&mut m, *x, Role::Metadata);
    }
    // DSS.
    if let Ok(Object::Reference(d)) = cat.get(b"DSS") {
        for id in closure(pdf, &[*d], &[], limit) {
            set_role(&mut m, id, Role::Dss);
        }
    }
    // Page tree.
    if let Ok(pages_root) = warraq_pdf::pages::pages_root(pdf) {
        for id in closure(
            pdf,
            &[pages_root],
            &[
                b"Parent",
                b"Annots",
                b"Contents",
                b"Resources",
                b"B",
                b"Thumb",
                b"StructParents",
            ],
            limit,
        ) {
            if matches!(pdf.get_dict(id).and_then(|d| d.get(b"Type").ok()), Some(Object::Name(n)) if n == b"Pages")
            {
                set_role(&mut m, id, Role::PageTree);
            }
        }
    }
    if let Ok(list) = warraq_pdf::pages::flatten(pdf) {
        m.pages = list.iter().map(|p| p.id).collect();
        for (pi, p) in list.iter().enumerate() {
            set_role(&mut m, p.id, Role::Page);
            let Some(pd) = pdf.get_dict(p.id) else {
                continue;
            };
            // Content: /Contents and /Resources closure (inherited resources included).
            let mut start = Vec::new();
            for key in [b"Contents".as_slice(), b"Resources", b"Group"] {
                if let Ok(v) = pd.get(key) {
                    refs_in(v, &mut start, 0);
                }
            }
            if let Some(r) = &p.resources {
                refs_in(r, &mut start, 0);
            }
            for id in closure(pdf, &start, &[b"Parent"], limit) {
                set_role(&mut m, id, Role::Content);
            }
            // Annotations.
            let annots: Vec<ObjectId> = match pd.get(b"Annots").ok().and_then(|o| pdf.resolve(o)) {
                Some(Object::Array(a)) => a.iter().filter_map(|o| o.as_reference().ok()).collect(),
                _ => Vec::new(),
            };
            if let Ok(Object::Reference(arr)) = pd.get(b"Annots") {
                set_role(&mut m, *arr, Role::Page);
            }
            for a in annots {
                m.annot_page.insert(a, pi);
                let Some(ad) = pdf.get_dict(a) else { continue };
                let widget = get_name(pdf, ad, b"Subtype") == Some(b"Widget");
                set_role(
                    &mut m,
                    a,
                    if widget {
                        Role::Widget
                    } else {
                        Role::Annotation
                    },
                );
                let mut ap = Vec::new();
                for key in [b"AP".as_slice(), b"MK", b"Popup"] {
                    if let Ok(v) = ad.get(key) {
                        refs_in(v, &mut ap, 0);
                    }
                }
                for id in closure(pdf, &ap, &[b"Parent", b"P"], limit) {
                    set_role(&mut m, id, Role::Appearance);
                    m.owner.entry(id).or_insert(a);
                }
            }
        }
    }
    // AcroForm and fields.
    if let Ok(afo) = cat.get(b"AcroForm") {
        if let Object::Reference(af) = afo {
            set_role(&mut m, *af, Role::AcroForm);
        }
        if let Some(af) = pdfobj::dict_of(pdf, afo) {
            let mut dr = Vec::new();
            for key in [b"DR".as_slice(), b"Fields"] {
                if let Ok(v) = af.get(key) {
                    if key == b"DR" {
                        refs_in(v, &mut dr, 0);
                    } else if let Object::Reference(fid) = v {
                        set_role(&mut m, *fid, Role::AcroForm);
                    }
                }
            }
            for id in closure(pdf, &dr, &[], limit) {
                set_role(&mut m, id, Role::Appearance);
            }
        }
    }
    for f in pdfobj::fields(pdf) {
        set_role(&mut m, f.id, Role::Field);
        m.field_name.insert(f.id, f.name.clone());
        // Non-terminal ancestors.
        let mut cur = f.id;
        for _ in 0..32 {
            let Some(Object::Reference(p)) = pdf.get_dict(cur).and_then(|d| d.get(b"Parent").ok())
            else {
                break;
            };
            set_role(&mut m, *p, Role::Field);
            cur = *p;
        }
        for w in &f.widgets {
            m.widget_field.insert(*w, f.id);
            m.field_name.insert(*w, f.name.clone());
            // Widgets reachable only through the field tree still own their appearances.
            if let Some(wd) = pdf.get_dict(*w) {
                set_role(&mut m, *w, Role::Widget);
                let mut ap = Vec::new();
                for key in [b"AP".as_slice(), b"MK"] {
                    if let Ok(v) = wd.get(key) {
                        refs_in(v, &mut ap, 0);
                    }
                }
                for id in closure(pdf, &ap, &[b"Parent", b"P"], limit) {
                    set_role(&mut m, id, Role::Appearance);
                    m.owner.entry(id).or_insert(*w);
                }
            }
        }
        if f.ft.as_deref() == Some(b"Sig") {
            if let Some(Object::Reference(v)) = pdf.get_dict(f.id).and_then(|d| d.get(b"V").ok()) {
                for id in closure(pdf, &[*v], &[], 64) {
                    set_role(&mut m, id, Role::SigValue);
                }
            }
        }
    }
    m
}

fn oid_s(id: ObjectId) -> String {
    format!("{} {}", id.0, id.1)
}

fn dict(o: &Object) -> Option<&Dictionary> {
    match o {
        Object::Dictionary(d) => Some(d),
        Object::Stream(s) => Some(&s.dict),
        _ => None,
    }
}

fn changed_keys(a: &Dictionary, b: &Dictionary, pdf: &Pdf) -> Vec<Vec<u8>> {
    let mut keys: BTreeSet<Vec<u8>> = a.iter().map(|(k, _)| k.clone()).collect();
    keys.extend(b.iter().map(|(k, _)| k.clone()));
    keys.into_iter()
        .filter(|k| match (a.get(k), b.get(k)) {
            (Ok(x), Ok(y)) => !objects_equal(x, y, pdf.limits()),
            _ => true,
        })
        .collect()
}

fn visible_annotation(pdf: &Pdf, d: &Dictionary) -> Option<[f64; 4]> {
    let flags = pdfobj::get_num(pdf, d, b"F").unwrap_or(0.0) as i64;
    if flags & (2 | 32) != 0 {
        return None;
    }
    if !d.has(b"AP") {
        return None;
    }
    let r = pdfobj::get_rect(pdf, d, b"Rect")?;
    ((r[2] - r[0]) > 0.5 && (r[3] - r[1]) > 0.5).then_some(r)
}

/// Compare the signed revision `old` with the current document `new`. `signed_end` is the
/// byte length of the signed revision (for xref re-pointing checks).
pub fn diff(
    old: &Pdf,
    new: &Pdf,
    signed_end: usize,
    policy: &Policy,
) -> (Vec<Change>, Vec<Attack>) {
    let mut changes = Vec::new();
    let mut attacks = Vec::new();
    let om = map_document(old);
    let nm = map_document(new);
    let p = policy.docmdp;
    let annots_ok = p.is_none() || p == Some(3);
    let fill_ok = p != Some(1);
    let push = |changes: &mut Vec<Change>,
                kind: &'static str,
                allowed: bool,
                id: Option<ObjectId>,
                page: Option<usize>,
                field: Option<String>,
                detail: String| {
        if !changes
            .iter()
            .any(|c: &Change| c.kind == kind && c.object == id.map(oid_s) && c.field == field)
        {
            changes.push(Change {
                kind,
                allowed,
                object: id.map(oid_s),
                page,
                field,
                detail,
            });
        }
    };

    // Page list.
    if om.pages != nm.pages {
        let added: Vec<usize> = nm
            .pages
            .iter()
            .enumerate()
            .filter(|(_, id)| !om.pages.contains(id))
            .map(|(i, _)| i)
            .collect();
        let removed: Vec<usize> = om
            .pages
            .iter()
            .enumerate()
            .filter(|(_, id)| !nm.pages.contains(id))
            .map(|(i, _)| i)
            .collect();
        for i in &added {
            push(
                &mut changes,
                "page_added",
                false,
                nm.pages.get(*i).copied(),
                Some(*i),
                None,
                format!("page {} was added", i + 1),
            );
        }
        for i in &removed {
            push(
                &mut changes,
                "page_removed",
                false,
                om.pages.get(*i).copied(),
                Some(*i),
                None,
                format!("page {} was removed", i + 1),
            );
        }
        if added.is_empty() && removed.is_empty() {
            push(
                &mut changes,
                "pages_reordered",
                false,
                None,
                None,
                None,
                "the page order changed".into(),
            );
        }
    }

    // Objects.
    let mut ids: BTreeSet<ObjectId> = new.objects().keys().copied().collect();
    ids.extend(old.objects().keys().copied());
    let mut filled_fields: BTreeSet<ObjectId> = BTreeSet::new();
    for id in ids.iter().take(crate::limits::MAX_DIFF_OBJECTS) {
        let (o, n) = (old.get(*id), new.get(*id));
        let same = match (o, n) {
            (Some(a), Some(b)) => objects_equal(a, b, new.limits()),
            (None, None) => true,
            _ => false,
        };
        if same {
            continue;
        }
        // Skip xref streams and object-stream containers: formatting, not content.
        if let Some(Object::Stream(s)) = n.or(o) {
            if s.dict.has_type(b"XRef") || s.dict.has_type(b"ObjStm") {
                continue;
            }
        }
        let role_new = nm.roles.get(id).copied().unwrap_or(Role::Unreferenced);
        let role_old = om.roles.get(id).copied().unwrap_or(Role::Unreferenced);
        let role = role_new.max(role_old);
        let page = nm
            .annot_page
            .get(id)
            .or(om.annot_page.get(id))
            .copied()
            .or_else(|| nm.pages.iter().position(|x| x == id));
        let field = nm.field_name.get(id).or(om.field_name.get(id)).cloned();
        let existed_unreferenced =
            o.is_some() && role_old == Role::Unreferenced && role_new >= Role::Content;
        match role {
            Role::Unreferenced => {
                if n.is_some() {
                    push(
                        &mut changes,
                        "unused_object",
                        true,
                        Some(*id),
                        None,
                        None,
                        "an object no page or form uses was added or changed".into(),
                    );
                }
            }
            Role::Metadata => push(
                &mut changes,
                "metadata_changed",
                true,
                Some(*id),
                None,
                None,
                "document information or XMP metadata changed".into(),
            ),
            Role::Dss => push(
                &mut changes,
                "validation_data_added",
                true,
                Some(*id),
                None,
                None,
                "long-term validation data (DSS)".into(),
            ),
            Role::SigValue => {
                let is_ts = n
                    .and_then(dict)
                    .is_some_and(|d| get_name(new, d, b"Type") == Some(b"DocTimeStamp"));
                if o.is_none() && is_ts {
                    push(
                        &mut changes,
                        "document_timestamp_added",
                        true,
                        Some(*id),
                        None,
                        field,
                        "a document timestamp was added".into(),
                    );
                } else if o.is_none() {
                    push(
                        &mut changes,
                        "signature_added",
                        p != Some(1),
                        Some(*id),
                        None,
                        field,
                        "a signature was added".into(),
                    );
                } else {
                    push(
                        &mut changes,
                        "signature_changed",
                        false,
                        Some(*id),
                        None,
                        field,
                        "an existing signature dictionary was modified".into(),
                    );
                }
            }
            Role::Catalog => {
                let (Some(a), Some(b)) = (o.and_then(dict), n.and_then(dict)) else {
                    continue;
                };
                for k in changed_keys(a, b, new) {
                    let (kind, allowed, detail): (&'static str, bool, String) = match k.as_slice() {
                        b"AcroForm" => (
                            "form_changed",
                            fill_ok,
                            "the form dictionary changed".into(),
                        ),
                        b"DSS" => (
                            "validation_data_added",
                            true,
                            "long-term validation data (DSS)".into(),
                        ),
                        b"Extensions" => (
                            "extensions_changed",
                            true,
                            "PDF extension levels changed".into(),
                        ),
                        b"Metadata" => ("metadata_changed", true, "XMP metadata changed".into()),
                        b"Perms" => (
                            "permissions_changed",
                            false,
                            "the certification permissions were changed".into(),
                        ),
                        b"Pages" => (
                            "page_tree_replaced",
                            false,
                            "the page tree was replaced".into(),
                        ),
                        b"OCProperties" => (
                            "layers_changed",
                            false,
                            "optional content (layer visibility) changed".into(),
                        ),
                        b"OpenAction" | b"AA" | b"Names" => (
                            "actions_changed",
                            false,
                            format!(
                                "document actions or names changed (/{})",
                                String::from_utf8_lossy(&k)
                            ),
                        ),
                        _ => (
                            "document_structure_changed",
                            p.is_none(),
                            format!("catalog entry /{} changed", String::from_utf8_lossy(&k)),
                        ),
                    };
                    push(&mut changes, kind, allowed, Some(*id), None, None, detail);
                    if kind == "page_tree_replaced" || kind == "layers_changed" {
                        attacks.push(Attack {
                            kind: "shadow_hide_and_replace",
                            detail: detail_for(kind),
                        });
                    }
                }
            }
            Role::PageTree => {
                let (Some(a), Some(b)) = (o.and_then(dict), n.and_then(dict)) else {
                    push(
                        &mut changes,
                        "page_tree_changed",
                        false,
                        Some(*id),
                        None,
                        None,
                        "a page tree node was added or removed".into(),
                    );
                    continue;
                };
                let keys = changed_keys(a, b, new);
                let only_annots = keys.iter().all(|k| k.as_slice() == b"Annots");
                if !only_annots {
                    push(
                        &mut changes,
                        "page_tree_changed",
                        false,
                        Some(*id),
                        None,
                        None,
                        "a page tree node changed (inherited resources, page list)".into(),
                    );
                }
            }
            Role::Page => {
                let pg = nm
                    .pages
                    .iter()
                    .position(|x| x == id)
                    .or_else(|| om.pages.iter().position(|x| x == id));
                match (o, n) {
                    (Some(Object::Array(a)), Some(Object::Array(b))) => {
                        // An /Annots array object.
                        annot_list_changes(a, b, pg, &mut changes, annots_ok, new, &nm);
                    }
                    (Some(a), Some(b)) => {
                        let (Some(da), Some(db)) = (dict(a), dict(b)) else {
                            continue;
                        };
                        for k in changed_keys(da, db, new) {
                            match k.as_slice() {
                                b"Annots" => {
                                    let la = annot_ids(old, da);
                                    let lb = annot_ids(new, db);
                                    annot_list_changes_ids(
                                        &la,
                                        &lb,
                                        pg,
                                        &mut changes,
                                        annots_ok,
                                        new,
                                        &nm,
                                    );
                                }
                                b"Contents" | b"Resources" | b"MediaBox" | b"CropBox"
                                | b"Rotate" | b"Group" | b"UserUnit" => {
                                    push(
                                        &mut changes,
                                        "page_content_changed",
                                        false,
                                        Some(*id),
                                        pg,
                                        None,
                                        format!(
                                            "page {} /{} changed",
                                            pg.map(|x| x + 1).unwrap_or(0),
                                            String::from_utf8_lossy(&k)
                                        ),
                                    );
                                    let reused = reused_from_signed(old, new, db, &k, &om);
                                    attacks.push(Attack {
                                        kind: if reused {
                                            "shadow_hide_and_replace"
                                        } else {
                                            "shadow_replace"
                                        },
                                        detail: format!(
                                            "page {} /{} was redefined after signing{}",
                                            pg.map(|x| x + 1).unwrap_or(0),
                                            String::from_utf8_lossy(&k),
                                            if reused {
                                                " using content hidden in the signed revision"
                                            } else {
                                                ""
                                            }
                                        ),
                                    });
                                }
                                _ => push(
                                    &mut changes,
                                    "page_changed",
                                    p.is_none(),
                                    Some(*id),
                                    pg,
                                    None,
                                    format!("page entry /{} changed", String::from_utf8_lossy(&k)),
                                ),
                            }
                        }
                    }
                    _ => push(
                        &mut changes,
                        "page_changed",
                        false,
                        Some(*id),
                        pg,
                        None,
                        "a page object was added or removed".into(),
                    ),
                }
            }
            Role::Content => {
                push(
                    &mut changes,
                    "page_content_changed",
                    false,
                    Some(*id),
                    None,
                    None,
                    "content drawn on a page (content stream, font, image or form XObject) changed"
                        .into(),
                );
                attacks.push(Attack {
                    kind: if existed_unreferenced {
                        "shadow_hide_and_replace"
                    } else {
                        "shadow_replace"
                    },
                    detail: format!(
                        "object {} used by page content was {} after signing",
                        oid_s(*id),
                        if o.is_some() { "redefined" } else { "added" }
                    ),
                });
            }
            Role::Field | Role::Widget => {
                let is_sig = n
                    .and_then(dict)
                    .and_then(|d| get_name(new, d, b"FT"))
                    .map(|x| x == b"Sig")
                    .unwrap_or(false)
                    || nm
                        .widget_field
                        .get(id)
                        .and_then(|f| new.get_dict(*f))
                        .and_then(|d| get_name(new, d, b"FT"))
                        .is_some_and(|x| x == b"Sig");
                match (o.and_then(dict), n.and_then(dict)) {
                    (None, Some(nd)) => {
                        if is_sig {
                            push(
                                &mut changes,
                                "signature_field_added",
                                p != Some(1),
                                Some(*id),
                                page,
                                field,
                                "a signature field was added".into(),
                            );
                        } else {
                            push(
                                &mut changes,
                                "form_field_added",
                                p.is_none(),
                                Some(*id),
                                page,
                                field.clone(),
                                "a form field was added".into(),
                            );
                            if let Some(r) = visible_annotation(new, nd) {
                                attacks.push(Attack {
                                    kind: "overlay",
                                    detail: format!(
                                        "a new form field {} draws over page {} at {:?}",
                                        field.unwrap_or_default(),
                                        page.map(|x| x + 1).unwrap_or(0),
                                        r
                                    ),
                                });
                            }
                        }
                    }
                    (Some(_), None) => push(
                        &mut changes,
                        "form_field_removed",
                        false,
                        Some(*id),
                        page,
                        field,
                        "a form field was removed".into(),
                    ),
                    (Some(od), Some(nd)) => {
                        let keys = changed_keys(od, nd, new);
                        let value_keys: [&[u8]; 4] = [b"V", b"AS", b"AP", b"MK"];
                        let only_value = keys.iter().all(|k| value_keys.contains(&k.as_slice()));
                        let name = field.clone().unwrap_or_default();
                        let locked = policy.locks.locked(&name);
                        if is_sig
                            && keys.iter().any(|k| k.as_slice() == b"V")
                            && od.get(b"V").is_err()
                        {
                            push(
                                &mut changes,
                                "signature_added",
                                p != Some(1) && !locked,
                                Some(*id),
                                page,
                                field,
                                "an empty signature field was signed".into(),
                            );
                        } else if only_value {
                            filled_fields.insert(*id);
                            push(
                                &mut changes,
                                "form_field_filled",
                                fill_ok && !locked,
                                Some(*id),
                                page,
                                field.clone(),
                                if locked {
                                    format!("locked field {name} was changed")
                                } else {
                                    format!("field {name} was filled in")
                                },
                            );
                            if keys.iter().any(|k| k.as_slice() == b"AP") && !is_sig {
                                if let Some(r) = visible_annotation(new, nd) {
                                    let _ = r;
                                }
                            }
                        } else {
                            push(
                                &mut changes,
                                "form_field_changed",
                                p.is_none() && !locked,
                                Some(*id),
                                page,
                                field,
                                format!(
                                    "field {name} properties changed ({})",
                                    keys.iter()
                                        .map(|k| String::from_utf8_lossy(k).into_owned())
                                        .collect::<Vec<_>>()
                                        .join(", ")
                                ),
                            );
                        }
                    }
                    _ => {}
                }
            }
            Role::Annotation => match (o.and_then(dict), n.and_then(dict)) {
                (None, Some(nd)) => {
                    push(
                        &mut changes,
                        "annotation_added",
                        annots_ok,
                        Some(*id),
                        page,
                        None,
                        format!(
                            "a {} annotation was added",
                            String::from_utf8_lossy(get_name(new, nd, b"Subtype").unwrap_or(b"?"))
                        ),
                    );
                    if let Some(r) = visible_annotation(new, nd) {
                        attacks.push(Attack { kind: "overlay", detail: format!("a {} annotation added after signing draws over page {} at [{:.0} {:.0} {:.0} {:.0}]", String::from_utf8_lossy(get_name(new, nd, b"Subtype").unwrap_or(b"?")), page.map(|x| x + 1).unwrap_or(0), r[0], r[1], r[2], r[3]) });
                    }
                }
                (Some(_), None) => push(
                    &mut changes,
                    "annotation_removed",
                    annots_ok,
                    Some(*id),
                    page,
                    None,
                    "an annotation was removed".into(),
                ),
                (Some(_), Some(nd)) => {
                    push(
                        &mut changes,
                        "annotation_changed",
                        annots_ok,
                        Some(*id),
                        page,
                        None,
                        "an annotation was changed".into(),
                    );
                    if let Some(r) = visible_annotation(new, nd) {
                        attacks.push(Attack { kind: "overlay", detail: format!("an annotation changed after signing draws over page {} at [{:.0} {:.0} {:.0} {:.0}]", page.map(|x| x + 1).unwrap_or(0), r[0], r[1], r[2], r[3]) });
                    }
                }
                _ => {}
            },
            Role::Appearance => {
                let owner = nm.owner.get(id).or(om.owner.get(id)).copied();
                let owner_is_field = owner.is_some_and(|w| {
                    nm.widget_field.contains_key(&w) || om.widget_field.contains_key(&w)
                });
                let owner_new = owner.is_some_and(|w| old.get(w).is_none());
                if owner_new {
                    continue; // Reported with its annotation.
                }
                if owner_is_field {
                    let fname = owner.and_then(|w| nm.field_name.get(&w)).cloned();
                    let locked = fname.as_deref().is_some_and(|n| policy.locks.locked(n));
                    push(
                        &mut changes,
                        "form_field_filled",
                        fill_ok && !locked,
                        owner,
                        owner.and_then(|w| nm.annot_page.get(&w).copied()),
                        fname,
                        "a form field's appearance changed".into(),
                    );
                } else if owner.is_some() {
                    push(
                        &mut changes,
                        "annotation_changed",
                        annots_ok,
                        owner,
                        owner.and_then(|w| nm.annot_page.get(&w).copied()),
                        None,
                        "an annotation's appearance changed".into(),
                    );
                    if let Some(w) = owner {
                        if let Some(r) = new.get_dict(w).and_then(|d| visible_annotation(new, d)) {
                            attacks.push(Attack { kind: "overlay", detail: format!("the appearance of an annotation on page {} was replaced after signing (covers [{:.0} {:.0} {:.0} {:.0}])", nm.annot_page.get(&w).map(|x| x + 1).unwrap_or(0), r[0], r[1], r[2], r[3]) });
                        }
                    }
                } else {
                    push(
                        &mut changes,
                        "form_resources_changed",
                        fill_ok,
                        Some(*id),
                        None,
                        None,
                        "form default resources changed".into(),
                    );
                }
            }
            Role::AcroForm => {
                let (Some(a), Some(b)) = (o.and_then(dict), n.and_then(dict)) else {
                    if matches!(
                        (o, n),
                        (Some(Object::Array(_)), Some(Object::Array(_))) | (None, Some(_))
                    ) {
                        push(
                            &mut changes,
                            "form_changed",
                            fill_ok,
                            Some(*id),
                            None,
                            None,
                            "the form's field list changed".into(),
                        );
                    }
                    continue;
                };
                for k in changed_keys(a, b, new) {
                    let (kind, allowed) = match k.as_slice() {
                        b"Fields" | b"SigFlags" | b"DR" | b"DA" => ("form_changed", fill_ok),
                        b"NeedAppearances" => ("form_appearances_regenerated", false),
                        b"XFA" => ("xfa_changed", false),
                        _ => ("form_changed", p.is_none()),
                    };
                    push(
                        &mut changes,
                        kind,
                        allowed,
                        Some(*id),
                        None,
                        None,
                        format!("form entry /{} changed", String::from_utf8_lossy(&k)),
                    );
                }
            }
            Role::Other => {
                push(
                    &mut changes,
                    "document_structure_changed",
                    p.is_none() && o.is_some(),
                    Some(*id),
                    None,
                    None,
                    "a document-level object (outline, names, actions…) was added or changed"
                        .into(),
                );
            }
        }
    }

    // Xref entries re-pointed into the signed bytes (hide attacks through xref manipulation).
    let old_xref = &old.document().reference_table;
    for (num, entry) in new.document().reference_table.entries.iter() {
        if let lopdf::xref::XrefEntry::Normal { offset, .. } = entry {
            let off = *offset as usize;
            if off >= signed_end {
                continue;
            }
            let before = old_xref.get(*num);
            let same = matches!(before, Some(lopdf::xref::XrefEntry::Normal { offset: o2, .. }) if *o2 as usize == off);
            if !same {
                attacks.push(Attack {
                    kind: "shadow_hide",
                    detail: format!("a later cross-reference section points object {num} at bytes inside the signed revision that the signed revision did not use"),
                });
                push(
                    &mut changes,
                    "xref_manipulation",
                    false,
                    None,
                    None,
                    None,
                    format!("object {num} was re-pointed into signed bytes"),
                );
            }
        }
    }
    let _ = filled_fields;
    (changes, dedup(attacks))
}

fn detail_for(kind: &str) -> String {
    match kind {
        "page_tree_replaced" => "the catalog now points to a different page tree".into(),
        _ => {
            "layer visibility was changed after signing (content can be hidden or revealed)".into()
        }
    }
}

fn dedup(mut a: Vec<Attack>) -> Vec<Attack> {
    let mut seen = HashSet::new();
    a.retain(|x| seen.insert((x.kind, x.detail.clone())));
    a
}

fn annot_ids(pdf: &Pdf, page: &Dictionary) -> Vec<ObjectId> {
    match page.get(b"Annots").ok().and_then(|o| pdf.resolve(o)) {
        Some(Object::Array(a)) => a.iter().filter_map(|o| o.as_reference().ok()).collect(),
        _ => Vec::new(),
    }
}

fn annot_list_changes(
    a: &[Object],
    b: &[Object],
    pg: Option<usize>,
    changes: &mut Vec<Change>,
    annots_ok: bool,
    new: &Pdf,
    nm: &Map,
) {
    let la: Vec<ObjectId> = a.iter().filter_map(|o| o.as_reference().ok()).collect();
    let lb: Vec<ObjectId> = b.iter().filter_map(|o| o.as_reference().ok()).collect();
    annot_list_changes_ids(&la, &lb, pg, changes, annots_ok, new, nm);
}

fn annot_list_changes_ids(
    la: &[ObjectId],
    lb: &[ObjectId],
    pg: Option<usize>,
    changes: &mut Vec<Change>,
    annots_ok: bool,
    _new: &Pdf,
    nm: &Map,
) {
    // Additions/removals are reported by the annotation objects themselves; here only
    // references to pre-existing objects that were not annotations before (re-use).
    for id in lb.iter().filter(|x| !la.contains(x)) {
        if nm.widget_field.contains_key(id) {
            continue;
        }
        let _ = (id, pg, annots_ok);
    }
    for id in la.iter().filter(|x| !lb.contains(x)) {
        changes.push(Change {
            kind: "annotation_removed",
            allowed: annots_ok,
            object: Some(oid_s(*id)),
            page: pg,
            field: None,
            detail: "an annotation was removed from the page".into(),
        });
    }
}

/// Whether the new value of page entry `key` references objects that already existed in
/// the signed revision without being used there.
fn reused_from_signed(old: &Pdf, _new: &Pdf, new_page: &Dictionary, key: &[u8], om: &Map) -> bool {
    let mut refs = Vec::new();
    if let Ok(v) = new_page.get(key) {
        refs_in(v, &mut refs, 0);
    }
    refs.iter()
        .any(|r| old.get(*r).is_some() && !om.reachable.contains(r))
}
