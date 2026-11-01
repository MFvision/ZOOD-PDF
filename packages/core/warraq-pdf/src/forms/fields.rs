//! A form's fields as Warraq reads and writes them (ISO 32000-2, 12.7).
//!
//! Reading: every terminal field with its full name, value, widgets and the
//! scripts of its `/AA`; the calculation order; whether the form is XFA; and
//! every script in the file that Warraq will not run, so the interface can
//! say so. Writing: new fields where Prepare form's detection proposed them,
//! and a field's format, validation and calculation as the JavaScript
//! Acrobat's own functions take (see `script`). Everything is an ordinary
//! change of objects, saved as an incremental update.
use std::collections::{BTreeMap, BTreeSet, HashSet};

use lopdf::{Dictionary, Object, ObjectId, Stream, StringFormat};

use super::expr::{calculate_script, parse_expression, ExprError};
use super::format::NumberSpec;
use super::script::{
    self, js_string, parse, Action, SimpleOp, DIGITS_JS, HIJRI_FORMAT_JS, HIJRI_KEYSTROKE_JS,
    LATIN_DIGITS_JS, MAX_SCRIPT,
};
use crate::document::decode_text_string;
use crate::{Error, PdfDocument, Result};

/// Fields read at most; a form with more is read up to here.
const MAX_FIELDS: usize = 5000;
/// Field tree depth read at most.
const MAX_DEPTH: usize = 32;
/// Scripts listed at most as not run.
const MAX_NOTES: usize = 100;
/// How much of a script not run is shown.
const NOTE_TEXT: usize = 400;

const FLAG_READ_ONLY: i64 = 1;
const FLAG_NO_TOGGLE_OFF: i64 = 1 << 14;
const FLAG_RADIO: i64 = 1 << 15;
const FLAG_PUSH: i64 = 1 << 16;
const FLAG_COMBO: i64 = 1 << 17;
const FLAG_EDIT: i64 = 1 << 18;
/// Options a choice field is written or read with at most.
const MAX_OPTIONS: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldKind {
    Text,
    Checkbox,
    Radio,
    Button,
    Choice,
    Signature,
}

impl FieldKind {
    pub fn code(self) -> &'static str {
        match self {
            FieldKind::Text => "text",
            FieldKind::Checkbox => "checkbox",
            FieldKind::Radio => "radio",
            FieldKind::Button => "button",
            FieldKind::Choice => "choice",
            FieldKind::Signature => "signature",
        }
    }
}

/// One widget of a field: its page, and its box as the page is shown
/// (`[x0, top, x1, bottom]`, points from the top-left).
#[derive(Debug, Clone, PartialEq)]
pub struct Widget {
    pub page: usize,
    pub rect: [f32; 4],
}

#[derive(Debug, Clone, PartialEq)]
pub struct FormField {
    pub name: String,
    pub kind: FieldKind,
    pub value: String,
    pub tooltip: Option<String>,
    pub read_only: bool,
    pub widgets: Vec<Widget>,
    pub keystroke: Option<String>,
    pub format: Option<String>,
    pub validate: Option<String>,
    pub calculate: Option<String>,
    /// A choice field's options (their export values), or what a check box
    /// or radio button's states stand for: its `/Opt` entry where it has
    /// one, else the state's own name.
    pub options: Vec<String>,
    /// A check box or radio button's on states, as its widgets name them,
    /// one for each of `options`.
    pub states: Vec<String>,
    /// A combo box that takes text typed into it too.
    pub editable: bool,
}

/// Whether the form is XFA, and which kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Xfa {
    None,
    /// XFA with an AcroForm beside it that every reader can fill.
    Static,
    /// XFA that draws its own pages: only an XFA engine can show it.
    Dynamic,
}

/// Where a script Warraq does not run lives.
#[derive(Debug, Clone, PartialEq)]
pub enum Place {
    Document,
    Open,
    Page(usize),
    Field(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct ScriptNote {
    pub place: Place,
    /// The event: a name-tree key, `K`/`F`/`V`/`C`, `WC`, `O`, `click`…
    pub event: String,
    /// The start of the script's text.
    pub text: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FormReport {
    pub fields: Vec<FormField>,
    /// Names in the calculation order.
    pub order: Vec<String>,
    pub xfa: Xfa,
    pub not_run: Vec<ScriptNote>,
}

/// A field to create where a person accepted it.
#[derive(Debug, Clone, PartialEq)]
pub struct NewField {
    pub page: usize,
    /// `text`, `checkbox`, `radio`, `choice`, `date`, `hijri` or `signature`.
    /// Radio buttons asked for under one name are one field, a button each.
    pub kind: String,
    pub name: String,
    pub tooltip: String,
    /// As shown: `[x0, top, x1, bottom]`.
    pub rect: [f32; 4],
    /// Right-aligned text (`/Q 2`), for a field whose label is Arabic.
    pub rtl: bool,
    /// The date pattern of a date or Hijri field.
    pub pattern: Option<String>,
    /// A choice field's options; a radio button's first entry is what it
    /// stands for (its `/Opt` entry: Arabic is kept as it is written).
    pub options: Vec<String>,
}

/// How a field's value is shown and what it accepts.
#[derive(Debug, Clone, PartialEq)]
pub enum FormatSpec {
    Number {
        spec: NumberSpec,
        arabic: bool,
    },
    Percent {
        decimals: u8,
        separator: u8,
        arabic: bool,
    },
    Date {
        pattern: String,
    },
    Hijri {
        pattern: String,
        arabic: bool,
    },
}

/// A calculation.
#[derive(Debug, Clone, PartialEq)]
pub enum CalcSpec {
    Simple { op: SimpleOp, fields: Vec<String> },
    Expression(String),
}

/// A change to one field's scripts; `None` leaves that script as it is,
/// `Some(None)` removes it.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ActionsChange {
    pub name: String,
    pub format: Option<Option<FormatSpec>>,
    pub range: Option<Option<(Option<f64>, Option<f64>)>>,
    pub calculate: Option<Option<CalcSpec>>,
}

/// Why a change was refused.
#[derive(Debug, Clone, PartialEq)]
pub enum ActionsError {
    NoField(String),
    Expression(ExprError),
    /// The calculations would go round in a circle through these fields.
    Cycle(Vec<String>),
    Pdf(String),
}

impl From<Error> for ActionsError {
    fn from(e: Error) -> Self {
        ActionsError::Pdf(e.to_string())
    }
}

fn parse_err(e: impl std::fmt::Display) -> Error {
    Error::Parse(e.to_string())
}

/// A PDF text string: PDFDocEncoding's ASCII as it is, anything else UTF-16BE.
pub(crate) fn text_string(text: &str) -> Object {
    if text.bytes().all(|b| (0x20..0x7F).contains(&b)) {
        Object::String(text.as_bytes().to_vec(), StringFormat::Literal)
    } else {
        let mut bytes = vec![0xFE, 0xFF];
        bytes.extend(text.encode_utf16().flat_map(u16::to_be_bytes));
        Object::String(bytes, StringFormat::Hexadecimal)
    }
}

impl PdfDocument {
    fn form_value(&self, value: &Object) -> Object {
        match value {
            Object::Reference(id) => self.doc.get_object(*id).cloned().unwrap_or(Object::Null),
            other => other.clone(),
        }
    }

    fn root_id(&self) -> Result<ObjectId> {
        self.doc
            .trailer
            .get(b"Root")
            .and_then(Object::as_reference)
            .map_err(parse_err)
    }

    /// The `/AcroForm` dictionary, resolved.
    pub(crate) fn acroform(&self) -> Option<Dictionary> {
        let form = self.doc.catalog().ok()?.get(b"AcroForm").ok()?;
        self.form_value(form).as_dict().ok().cloned()
    }

    /// The text of a JavaScript action, or None for any other action.
    fn javascript(&self, action: &Object) -> Option<String> {
        let action = self.form_value(action);
        let dict = action.as_dict().ok()?;
        if dict.get(b"S").ok()?.as_name().ok()? != b"JavaScript" {
            return None;
        }
        let js = self.form_value(dict.get(b"JS").ok()?);
        let bytes = match &js {
            Object::String(bytes, _) => bytes.clone(),
            Object::Stream(stream) => crate::document::decoded(stream).ok()?,
            _ => return None,
        };
        if bytes.len() > 4 * MAX_SCRIPT {
            return Some(String::from("/* too long to read */"));
        }
        Some(decode_text_string(&bytes))
    }

    /// Every field of the form, the calculation order, whether it is XFA,
    /// and the scripts Warraq will not run.
    pub fn form(&self) -> FormReport {
        let mut report = FormReport {
            fields: Vec::new(),
            order: Vec::new(),
            xfa: Xfa::None,
            not_run: Vec::new(),
        };
        let pages: BTreeMap<ObjectId, usize> = self
            .pages
            .iter()
            .enumerate()
            .map(|(i, id)| (*id, i))
            .collect();
        // Widgets by page, for widgets that do not name their page.
        let mut on_page: BTreeMap<ObjectId, usize> = BTreeMap::new();
        for (index, page) in self.pages.iter().enumerate() {
            let annots = self
                .doc
                .get_dictionary(*page)
                .ok()
                .and_then(|p| p.get(b"Annots").ok())
                .map(|a| self.form_value(a));
            for item in annots
                .as_ref()
                .and_then(|a| a.as_array().ok())
                .into_iter()
                .flatten()
            {
                if let Ok(id) = item.as_reference() {
                    on_page.entry(id).or_insert(index);
                }
            }
            if let Some(aa) = self
                .doc
                .get_dictionary(*page)
                .ok()
                .and_then(|p| p.get(b"AA").ok())
                .map(|a| self.form_value(a))
            {
                if let Ok(aa) = aa.as_dict() {
                    for (key, action) in aa.iter() {
                        if let Some(js) = self.javascript(action) {
                            note(&mut report.not_run, Place::Page(index), key, &js);
                        }
                    }
                }
            }
        }
        let form = self.acroform();
        if let Some(form) = &form {
            let mut seen = HashSet::new();
            let fields = form.get(b"Fields").ok().map(|f| self.form_value(f));
            for item in fields
                .as_ref()
                .and_then(|f| f.as_array().ok())
                .into_iter()
                .flatten()
            {
                if let Ok(id) = item.as_reference() {
                    self.walk(
                        id,
                        "",
                        Inherited::default(),
                        0,
                        &mut seen,
                        &pages,
                        &on_page,
                        &mut report,
                    );
                }
            }
            let order = form.get(b"CO").ok().map(|c| self.form_value(c));
            for item in order
                .as_ref()
                .and_then(|c| c.as_array().ok())
                .into_iter()
                .flatten()
            {
                if let Ok(id) = item.as_reference() {
                    if let Some(name) = self.full_name(id) {
                        if !report.order.contains(&name) {
                            report.order.push(name);
                        }
                    }
                }
            }
            if form.has(b"XFA") {
                let needs_rendering = self
                    .doc
                    .catalog()
                    .ok()
                    .and_then(|c| c.get(b"NeedsRendering").ok())
                    .and_then(|v| v.as_bool().ok())
                    .unwrap_or(false);
                let has_widgets = report.fields.iter().any(|f| !f.widgets.is_empty());
                report.xfa = if needs_rendering || !has_widgets {
                    Xfa::Dynamic
                } else {
                    Xfa::Static
                };
            }
        }
        self.document_scripts(&mut report.not_run);
        // Field scripts outside the subset.
        for field in &report.fields {
            for (event, script) in [
                ("K", &field.keystroke),
                ("F", &field.format),
                ("V", &field.validate),
                ("C", &field.calculate),
            ] {
                if let Some(js) = script {
                    if parse(js).is_err() {
                        note(
                            &mut report.not_run,
                            Place::Field(field.name.clone()),
                            event.as_bytes(),
                            js,
                        );
                    }
                }
            }
        }
        report
    }

    /// Document-level JavaScript: the name tree, the open action and the
    /// document's own additional actions. Warraq runs none of them.
    fn document_scripts(&self, notes: &mut Vec<ScriptNote>) {
        let Ok(catalog) = self.doc.catalog() else {
            return;
        };
        if let Ok(open) = catalog.get(b"OpenAction") {
            if let Some(js) = self.javascript(open) {
                note(notes, Place::Open, b"open", &js);
            }
        }
        if let Some(aa) = catalog.get(b"AA").ok().map(|a| self.form_value(a)) {
            if let Ok(aa) = aa.as_dict() {
                for (key, action) in aa.iter() {
                    if let Some(js) = self.javascript(action) {
                        note(notes, Place::Document, key, &js);
                    }
                }
            }
        }
        let tree = catalog
            .get(b"Names")
            .ok()
            .map(|n| self.form_value(n))
            .and_then(|n| {
                n.as_dict()
                    .ok()
                    .and_then(|d| d.get(b"JavaScript").ok().cloned())
            });
        if let Some(tree) = tree {
            let mut stack = vec![(tree, 0usize)];
            let mut visited = 0;
            while let Some((node, depth)) = stack.pop() {
                visited += 1;
                if visited > 1000 || depth > 16 || notes.len() >= MAX_NOTES {
                    break;
                }
                let node = self.form_value(&node);
                let Ok(dict) = node.as_dict() else { continue };
                if let Some(names) = dict.get(b"Names").ok().map(|n| self.form_value(n)) {
                    if let Ok(pairs) = names.as_array() {
                        for pair in pairs.chunks(2) {
                            if let [key, action] = pair {
                                let key = self.form_value(key);
                                let name = key.as_str().map(decode_text_string).unwrap_or_default();
                                if let Some(js) = self.javascript(action) {
                                    note(notes, Place::Document, name.as_bytes(), &js);
                                }
                            }
                        }
                    }
                }
                if let Some(kids) = dict.get(b"Kids").ok().map(|k| self.form_value(k)) {
                    for kid in kids.as_array().into_iter().flatten() {
                        stack.push((kid.clone(), depth + 1));
                    }
                }
            }
        }
    }

    /// The full name of the field at `id`: its `/T` and its parents', joined by dots.
    fn full_name(&self, id: ObjectId) -> Option<String> {
        let mut parts = Vec::new();
        let mut current = Some(id);
        let mut seen = HashSet::new();
        while let Some(node) = current {
            if !seen.insert(node) || parts.len() > MAX_DEPTH {
                break;
            }
            let dict = self.doc.get_dictionary(node).ok()?;
            if let Ok(t) = dict.get(b"T") {
                if let Ok(bytes) = self.form_value(t).as_str() {
                    parts.push(decode_text_string(bytes));
                }
            }
            current = dict.get(b"Parent").ok().and_then(|p| p.as_reference().ok());
        }
        parts.reverse();
        (!parts.is_empty()).then(|| parts.join("."))
    }

    #[allow(clippy::too_many_arguments)]
    fn walk(
        &self,
        id: ObjectId,
        prefix: &str,
        inherited: Inherited,
        depth: usize,
        seen: &mut HashSet<ObjectId>,
        pages: &BTreeMap<ObjectId, usize>,
        on_page: &BTreeMap<ObjectId, usize>,
        report: &mut FormReport,
    ) {
        if depth > MAX_DEPTH || !seen.insert(id) || report.fields.len() >= MAX_FIELDS {
            return;
        }
        let Ok(dict) = self.doc.get_dictionary(id) else {
            return;
        };
        let partial = dict
            .get(b"T")
            .ok()
            .map(|t| self.form_value(t))
            .and_then(|t| t.as_str().ok().map(decode_text_string));
        let name = match (&partial, prefix.is_empty()) {
            (Some(p), true) => p.clone(),
            (Some(p), false) => format!("{prefix}.{p}"),
            (None, _) => prefix.to_string(),
        };
        let here = inherited.with(self, dict);
        let kids: Vec<ObjectId> = dict
            .get(b"Kids")
            .ok()
            .map(|k| self.form_value(k))
            .and_then(|k| k.as_array().ok().cloned())
            .unwrap_or_default()
            .iter()
            .filter_map(|k| k.as_reference().ok())
            .collect();
        // Kids that are fields (they have a name) make this a non-terminal field.
        let field_kids: Vec<ObjectId> = kids
            .iter()
            .copied()
            .filter(|k| {
                self.doc
                    .get_dictionary(*k)
                    .map(|d| d.has(b"T"))
                    .unwrap_or(false)
            })
            .collect();
        if !field_kids.is_empty() {
            for kid in field_kids {
                self.walk(
                    kid,
                    &name,
                    here.clone(),
                    depth + 1,
                    seen,
                    pages,
                    on_page,
                    report,
                );
            }
            return;
        }
        let widget_ids: Vec<ObjectId> = if kids.is_empty() { vec![id] } else { kids };
        let mut widgets = Vec::new();
        let mut states: Vec<String> = Vec::new();
        for &widget in &widget_ids {
            for state in self.on_states(widget) {
                if !states.contains(&state) {
                    states.push(state);
                }
            }
        }
        for widget in widget_ids {
            let Ok(w) = self.doc.get_dictionary(widget) else {
                continue;
            };
            if w.get(b"Subtype").ok().and_then(|s| s.as_name().ok()) != Some(b"Widget".as_slice()) {
                continue;
            }
            let page = w
                .get(b"P")
                .ok()
                .and_then(|p| p.as_reference().ok())
                .and_then(|p| pages.get(&p).copied())
                .or_else(|| on_page.get(&widget).copied());
            let rect = self.rect(w.get(b"Rect").ok());
            if let (Some(page), Some(rect)) = (page, rect) {
                let rect = self
                    .display_frame(page)
                    .map(|frame| frame.shown_rect(rect))
                    .unwrap_or(rect);
                widgets.push(Widget { page, rect });
            }
            // Mouse and focus scripts on the widget are never run.
            if let Some(js) = w.get(b"A").ok().and_then(|a| self.javascript(a)) {
                note(
                    &mut report.not_run,
                    Place::Field(name.clone()),
                    b"click",
                    &js,
                );
            }
            if let Some(aa) = w.get(b"AA").ok().map(|a| self.form_value(a)) {
                if let Ok(aa) = aa.as_dict() {
                    for (key, action) in aa.iter() {
                        if matches!(key.as_slice(), b"K" | b"F" | b"V" | b"C") {
                            continue;
                        }
                        if let Some(js) = self.javascript(action) {
                            note(&mut report.not_run, Place::Field(name.clone()), key, &js);
                        }
                    }
                }
            }
        }
        let kind = match here.kind.as_deref() {
            Some(b"Tx") => FieldKind::Text,
            Some(b"Ch") => FieldKind::Choice,
            Some(b"Sig") => FieldKind::Signature,
            Some(b"Btn") if here.flags & FLAG_PUSH != 0 => FieldKind::Button,
            Some(b"Btn") if here.flags & FLAG_RADIO != 0 => FieldKind::Radio,
            Some(b"Btn") => FieldKind::Checkbox,
            _ => return,
        };
        let value = match here.value.as_ref() {
            Some(Object::String(bytes, _)) => decode_text_string(bytes),
            Some(Object::Name(n)) => String::from_utf8_lossy(n).into_owned(),
            Some(Object::Array(items)) => items
                .iter()
                .filter_map(|i| i.as_str().ok().map(decode_text_string))
                .collect::<Vec<_>>()
                .join(", "),
            Some(Object::Integer(n)) => n.to_string(),
            Some(Object::Real(n)) => n.to_string(),
            _ => String::new(),
        };
        let script = |key: &[u8]| here.actions.get(key).cloned();
        let opt = self.options_of(dict);
        let options = match kind {
            FieldKind::Choice => opt,
            FieldKind::Checkbox | FieldKind::Radio => states
                .iter()
                .map(|s| {
                    s.parse::<usize>()
                        .ok()
                        .and_then(|i| opt.get(i).cloned())
                        .unwrap_or_else(|| s.clone())
                })
                .collect(),
            _ => Vec::new(),
        };
        if !matches!(kind, FieldKind::Checkbox | FieldKind::Radio) {
            states.clear();
        }
        report.fields.push(FormField {
            name,
            kind,
            value,
            tooltip: dict
                .get(b"TU")
                .ok()
                .map(|t| self.form_value(t))
                .and_then(|t| t.as_str().ok().map(decode_text_string)),
            read_only: here.flags & FLAG_READ_ONLY != 0,
            widgets,
            keystroke: script(b"K"),
            format: script(b"F"),
            validate: script(b"V"),
            calculate: script(b"C"),
            options,
            states,
            editable: kind == FieldKind::Choice && here.flags & FLAG_EDIT != 0,
        });
    }

    /// A widget's on states: the names of its normal appearances but `Off`.
    pub(crate) fn on_states(&self, widget: ObjectId) -> Vec<String> {
        let Ok(w) = self.doc.get_dictionary(widget) else {
            return Vec::new();
        };
        let normal = w
            .get(b"AP")
            .ok()
            .map(|ap| self.form_value(ap))
            .and_then(|ap| ap.as_dict().ok().and_then(|d| d.get(b"N").ok().cloned()))
            .map(|n| self.form_value(&n));
        match normal.as_ref().and_then(|n| n.as_dict().ok()) {
            Some(states) => states
                .iter()
                .map(|(k, _)| String::from_utf8_lossy(k).into_owned())
                .filter(|k| k != "Off")
                .take(MAX_OPTIONS)
                .collect(),
            None => Vec::new(),
        }
    }

    /// A field's `/Opt`: each entry's export value (the first of a pair).
    fn options_of(&self, dict: &Dictionary) -> Vec<String> {
        let Some(opt) = dict.get(b"Opt").ok().map(|o| self.form_value(o)) else {
            return Vec::new();
        };
        opt.as_array()
            .map(|items| {
                items
                    .iter()
                    .take(MAX_OPTIONS)
                    .filter_map(|item| match self.form_value(item) {
                        Object::String(b, _) => Some(decode_text_string(&b)),
                        Object::Array(pair) => pair
                            .first()
                            .and_then(|e| self.form_value(e).as_str().ok().map(decode_text_string)),
                        _ => None,
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// The object id of the terminal field called `name`.
    pub(crate) fn field_id(&self, name: &str) -> Option<ObjectId> {
        let form = self.acroform()?;
        let fields = form.get(b"Fields").ok().map(|f| self.form_value(f))?;
        let mut stack: Vec<(ObjectId, usize)> = fields
            .as_array()
            .ok()?
            .iter()
            .filter_map(|f| f.as_reference().ok())
            .map(|id| (id, 0))
            .collect();
        let mut seen = HashSet::new();
        while let Some((id, depth)) = stack.pop() {
            if depth > MAX_DEPTH || !seen.insert(id) || seen.len() > MAX_FIELDS * 4 {
                continue;
            }
            let Ok(dict) = self.doc.get_dictionary(id) else {
                continue;
            };
            if !dict.has(b"T") {
                continue;
            }
            let kids: Vec<ObjectId> = dict
                .get(b"Kids")
                .ok()
                .map(|k| self.form_value(k))
                .and_then(|k| k.as_array().ok().cloned())
                .unwrap_or_default()
                .iter()
                .filter_map(|k| k.as_reference().ok())
                .filter(|k| {
                    self.doc
                        .get_dictionary(*k)
                        .map(|d| d.has(b"T"))
                        .unwrap_or(false)
                })
                .collect();
            if kids.is_empty() {
                if self.full_name(id).as_deref() == Some(name) {
                    return Some(id);
                }
            } else {
                stack.extend(kids.into_iter().map(|k| (k, depth + 1)));
            }
        }
        None
    }

    /// Replaces the dictionary under `key` of the object `owner` — kept where
    /// it is, in its own object or inline — with what `change` makes of it.
    fn update_dict(
        &mut self,
        owner: ObjectId,
        key: &[u8],
        change: impl FnOnce(&mut Dictionary),
    ) -> Result<()> {
        let held = self
            .doc
            .get_dictionary(owner)
            .map_err(parse_err)?
            .get(key)
            .ok()
            .cloned();
        match held {
            Some(Object::Reference(id)) if self.doc.get_dictionary(id).is_ok() => {
                let dict = self.doc.get_dictionary_mut(id).map_err(parse_err)?;
                change(dict);
                self.mark_touched(id);
            }
            other => {
                let mut dict = other
                    .and_then(|o| o.as_dict().ok().cloned())
                    .unwrap_or_default();
                change(&mut dict);
                self.doc
                    .get_dictionary_mut(owner)
                    .map_err(parse_err)?
                    .set(key, dict);
                self.mark_touched(owner);
            }
        }
        Ok(())
    }

    /// The same for an array.
    fn update_array(
        &mut self,
        owner: ObjectId,
        key: &[u8],
        change: impl FnOnce(&mut Vec<Object>),
    ) -> Result<()> {
        let held = self
            .doc
            .get_dictionary(owner)
            .map_err(parse_err)?
            .get(key)
            .ok()
            .cloned();
        match held {
            Some(Object::Reference(id))
                if matches!(self.doc.get_object(id), Ok(Object::Array(_))) =>
            {
                if let Ok(Object::Array(items)) = self.doc.get_object_mut(id) {
                    change(items);
                }
                self.mark_touched(id);
            }
            other => {
                let mut items = other
                    .and_then(|o| o.as_array().ok().cloned())
                    .unwrap_or_default();
                change(&mut items);
                self.doc
                    .get_dictionary_mut(owner)
                    .map_err(parse_err)?
                    .set(key, Object::Array(items));
                self.mark_touched(owner);
            }
        }
        Ok(())
    }

    /// The `/AcroForm` as its own object, made so if it is not; with the
    /// fonts new fields name in its `/DR`.
    fn acroform_id(&mut self) -> Result<ObjectId> {
        let catalog = self.root_id()?;
        let held = self
            .doc
            .catalog()
            .map_err(parse_err)?
            .get(b"AcroForm")
            .ok()
            .cloned();
        let id = match held {
            Some(Object::Reference(id)) if self.doc.get_dictionary(id).is_ok() => id,
            other => {
                let dict = other
                    .and_then(|o| o.as_dict().ok().cloned())
                    .unwrap_or_default();
                let id = self.doc.add_object(dict);
                self.doc
                    .get_dictionary_mut(catalog)
                    .map_err(parse_err)?
                    .set("AcroForm", id);
                self.mark_touched(catalog);
                id
            }
        };
        let helv = self.doc.add_object(Dictionary::from_iter([
            ("Type", Object::Name(b"Font".to_vec())),
            ("Subtype", Object::Name(b"Type1".to_vec())),
            ("BaseFont", Object::Name(b"Helvetica".to_vec())),
            ("Encoding", Object::Name(b"WinAnsiEncoding".to_vec())),
        ]));
        let zadb = self.doc.add_object(Dictionary::from_iter([
            ("Type", Object::Name(b"Font".to_vec())),
            ("Subtype", Object::Name(b"Type1".to_vec())),
            ("BaseFont", Object::Name(b"ZapfDingbats".to_vec())),
        ]));
        let mut added = false;
        self.update_dict(id, b"DR", |_| {})?;
        let dr_owner = match self.doc.get_dictionary(id).map_err(parse_err)?.get(b"DR") {
            Ok(Object::Reference(r)) => *r,
            _ => id,
        };
        let fonts_key: &[u8] = b"Font";
        if dr_owner == id {
            // /DR inline in the form: its /Font inside it.
            let form = self.doc.get_dictionary_mut(id).map_err(parse_err)?;
            let mut dr = form
                .get(b"DR")
                .ok()
                .and_then(|d| d.as_dict().ok().cloned())
                .unwrap_or_default();
            let fonts_held = dr.get(fonts_key).ok().cloned();
            match fonts_held {
                Some(Object::Reference(fid)) => {
                    if let Ok(fonts) = self.doc.get_dictionary_mut(fid) {
                        for (name, font) in [(b"Helv".as_slice(), helv), (b"ZaDb".as_slice(), zadb)]
                        {
                            if !fonts.has(name) {
                                fonts.set(name, font);
                                added = true;
                            }
                        }
                    }
                    self.mark_touched(fid);
                }
                other => {
                    let mut fonts = other
                        .and_then(|o| o.as_dict().ok().cloned())
                        .unwrap_or_default();
                    for (name, font) in [(b"Helv".as_slice(), helv), (b"ZaDb".as_slice(), zadb)] {
                        if !fonts.has(name) {
                            fonts.set(name, font);
                            added = true;
                        }
                    }
                    dr.set(fonts_key, fonts);
                    self.doc
                        .get_dictionary_mut(id)
                        .map_err(parse_err)?
                        .set("DR", dr);
                }
            }
        } else {
            self.update_dict(dr_owner, fonts_key, |fonts| {
                for (name, font) in [(b"Helv".as_slice(), helv), (b"ZaDb".as_slice(), zadb)] {
                    if !fonts.has(name) {
                        fonts.set(name, font);
                        added = true;
                    }
                }
            })?;
        }
        if !added {
            self.doc.objects.remove(&helv);
            self.doc.objects.remove(&zadb);
        }
        let form = self.doc.get_dictionary_mut(id).map_err(parse_err)?;
        if !form.has(b"DA") {
            form.set("DA", Object::string_literal("/Helv 0 Tf 0 g"));
        }
        if !form.has(b"Fields") {
            form.set("Fields", Vec::<Object>::new());
        }
        self.mark_touched(id);
        Ok(id)
    }

    /// Every full field name in the form.
    fn field_names(&self) -> BTreeSet<String> {
        self.form().fields.into_iter().map(|f| f.name).collect()
    }

    /// Creates `fields` as real AcroForm fields, one widget each, named as
    /// asked (made unique, and never with a dot, which would nest them).
    /// Returns the names given.
    pub fn create_fields(&mut self, fields: &[NewField]) -> Result<Vec<String>> {
        if fields.is_empty() {
            return Ok(Vec::new());
        }
        let form = self.acroform_id()?;
        let mut taken = self.field_names();
        let mut created = Vec::new();
        let mut refs = Vec::new();
        // Radio buttons by the name they were asked for: their field, its
        // buttons, and each button's `/Opt` entry.
        let mut radios: BTreeMap<String, (ObjectId, Vec<Object>, Vec<Object>)> = BTreeMap::new();
        for field in fields.iter().take(MAX_FIELDS) {
            let page = self.page_id(field.page)?;
            let frame = self.display_frame(field.page)?;
            let turn = frame.turn;
            let [x0, y0, x1, y1] = frame.user_rect(field.rect);
            if !(x0.is_finite() && y0.is_finite() && x1.is_finite() && y1.is_finite())
                || x1 - x0 < 2.0
                || y1 - y0 < 2.0
            {
                return Err(Error::Edit(format!(
                    "the box of {} is too small",
                    field.name
                )));
            }
            let name = match radios.get(&field.name) {
                Some(_) if field.kind == "radio" => field.name.clone(),
                _ => unique_name(&field.name, &mut taken),
            };
            let (w, h) = if turn == 90 || turn == 270 {
                (y1 - y0, x1 - x0)
            } else {
                (x1 - x0, y1 - y0)
            };
            let rect = vec![
                Object::Real(x0),
                Object::Real(y0),
                Object::Real(x1),
                Object::Real(y1),
            ];
            let mut dict = Dictionary::from_iter([
                ("Type", Object::Name(b"Annot".to_vec())),
                ("Subtype", Object::Name(b"Widget".to_vec())),
                ("Rect", Object::Array(rect)),
                ("P", Object::Reference(page)),
                ("F", Object::Integer(4)),
                ("T", text_string(&name)),
            ]);
            if !field.tooltip.trim().is_empty() {
                dict.set("TU", text_string(field.tooltip.trim()));
            }
            let mut mk = Dictionary::new();
            if turn != 0 {
                mk.set("R", Object::Integer(turn));
            }
            let matrix = rotation_matrix(turn, w, h);
            match field.kind.as_str() {
                "checkbox" => {
                    dict.set("FT", Object::Name(b"Btn".to_vec()));
                    dict.set("V", Object::Name(b"Off".to_vec()));
                    dict.set("AS", Object::Name(b"Off".to_vec()));
                    dict.set("DA", Object::string_literal("/ZaDb 0 Tf 0 g"));
                    mk.set("CA", Object::string_literal("4"));
                    let on = self
                        .doc
                        .add_object(check_appearance(w, h, true, matrix.clone()));
                    let off = self.doc.add_object(check_appearance(w, h, false, matrix));
                    dict.set(
                        "AP",
                        Dictionary::from_iter([(
                            "N",
                            Object::Dictionary(Dictionary::from_iter([
                                ("Yes", Object::Reference(on)),
                                ("Off", Object::Reference(off)),
                            ])),
                        )]),
                    );
                }
                "radio" => {
                    // One field for every button asked for under this name;
                    // each button is a widget below it, its state its index
                    // and its `/Opt` entry what it stands for.
                    dict.remove(b"T");
                    dict.remove(b"TU");
                    let parent = match radios.get(&field.name) {
                        Some((parent, _, _)) => *parent,
                        None => {
                            let mut group = Dictionary::from_iter([
                                ("FT", Object::Name(b"Btn".to_vec())),
                                ("Ff", Object::Integer(FLAG_RADIO | FLAG_NO_TOGGLE_OFF)),
                                ("T", text_string(&name)),
                                ("V", Object::Name(b"Off".to_vec())),
                            ]);
                            if !field.tooltip.trim().is_empty() {
                                group.set("TU", text_string(field.tooltip.trim()));
                            }
                            let parent = self.doc.add_object(group);
                            radios.insert(field.name.clone(), (parent, Vec::new(), Vec::new()));
                            refs.push(Object::Reference(parent));
                            created.push(name.clone());
                            parent
                        }
                    };
                    let count = radios.get(&field.name).map_or(0, |(_, kids, _)| kids.len());
                    let state = count.to_string();
                    let label = field
                        .options
                        .first()
                        .map(|o| o.trim().to_string())
                        .filter(|o| !o.is_empty())
                        .unwrap_or_else(|| (count + 1).to_string());
                    dict.set("Parent", Object::Reference(parent));
                    dict.set("AS", Object::Name(b"Off".to_vec()));
                    dict.set("DA", Object::string_literal("/ZaDb 0 Tf 0 g"));
                    mk.set("CA", Object::string_literal("l"));
                    let on = self
                        .doc
                        .add_object(radio_appearance(w, h, true, matrix.clone()));
                    let off = self.doc.add_object(radio_appearance(w, h, false, matrix));
                    dict.set(
                        "AP",
                        Dictionary::from_iter([(
                            "N",
                            Object::Dictionary(Dictionary::from_iter([
                                (state.as_str(), Object::Reference(on)),
                                ("Off", Object::Reference(off)),
                            ])),
                        )]),
                    );
                    dict.set("MK", mk);
                    let id = self.doc.add_object(dict);
                    self.update_array(page, b"Annots", |annots| {
                        annots.push(Object::Reference(id))
                    })?;
                    if let Some((_, kids, opt)) = radios.get_mut(&field.name) {
                        kids.push(Object::Reference(id));
                        opt.push(text_string(&label));
                    }
                    continue;
                }
                "choice" => {
                    // A drop-down list of the options, Arabic as written; its
                    // value is drawn by `fix_arabic_appearances` once chosen.
                    dict.set("FT", Object::Name(b"Ch".to_vec()));
                    dict.set("Ff", Object::Integer(FLAG_COMBO));
                    let size = (h * 0.6).clamp(7.0, 12.0).round();
                    dict.set("DA", Object::string_literal(format!("/Helv {size} Tf 0 g")));
                    dict.set("Q", Object::Integer(if field.rtl { 2 } else { 0 }));
                    let options: Vec<Object> = field
                        .options
                        .iter()
                        .map(|o| o.trim())
                        .filter(|o| !o.is_empty())
                        .take(MAX_OPTIONS)
                        .map(text_string)
                        .collect();
                    if options.is_empty() {
                        return Err(Error::Edit(format!(
                            "the list {} has no options",
                            field.name
                        )));
                    }
                    dict.set("Opt", Object::Array(options));
                    let n = self.doc.add_object(empty_appearance(w, h, true, matrix));
                    dict.set("AP", Dictionary::from_iter([("N", Object::Reference(n))]));
                }
                "signature" => {
                    dict.set("FT", Object::Name(b"Sig".to_vec()));
                    let n = self.doc.add_object(empty_appearance(w, h, false, matrix));
                    dict.set("AP", Dictionary::from_iter([("N", Object::Reference(n))]));
                }
                kind => {
                    dict.set("FT", Object::Name(b"Tx".to_vec()));
                    // A size the box holds, not 0 ("fit"): viewers that edit
                    // a field in place (EmbedPDF among them) take the size
                    // literally, and at 0 nothing typed shows or is kept.
                    let size = (h * 0.6).clamp(7.0, 12.0).round();
                    dict.set("DA", Object::string_literal(format!("/Helv {size} Tf 0 g")));
                    dict.set("Q", Object::Integer(if field.rtl { 2 } else { 0 }));
                    let n = self.doc.add_object(empty_appearance(w, h, true, matrix));
                    dict.set("AP", Dictionary::from_iter([("N", Object::Reference(n))]));
                    let pattern = field.pattern.clone().unwrap_or_else(|| "dd/mm/yyyy".into());
                    let format = match kind {
                        "date" => Some(FormatSpec::Date { pattern }),
                        "hijri" => Some(FormatSpec::Hijri {
                            pattern,
                            arabic: field.rtl,
                        }),
                        _ => None,
                    };
                    if let Some(format) = format {
                        let (k, f) = format_scripts(&format);
                        dict.set(
                            "AA",
                            Dictionary::from_iter([("K", js_action(&k)), ("F", js_action(&f))]),
                        );
                    }
                }
            }
            if !mk.is_empty() {
                dict.set("MK", mk);
            }
            let id = self.doc.add_object(dict);
            self.update_array(page, b"Annots", |annots| annots.push(Object::Reference(id)))?;
            refs.push(Object::Reference(id));
            created.push(name);
        }
        for (parent, kids, opt) in radios.into_values() {
            if let Ok(group) = self.doc.get_dictionary_mut(parent) {
                group.set("Kids", Object::Array(kids));
                group.set("Opt", Object::Array(opt));
            }
        }
        self.update_array(form, b"Fields", |list| list.extend(refs))?;
        Ok(created)
    }

    /// Sets the format, validation and calculation of fields, writes the
    /// calculation order again, and recalculates. Returns the fields whose
    /// value the recalculation changed.
    pub fn set_actions(
        &mut self,
        changes: &[ActionsChange],
    ) -> std::result::Result<Vec<String>, ActionsError> {
        let report = self.form();
        let names: Vec<String> = report.fields.iter().map(|f| f.name.clone()).collect();
        // Every change is checked before anything is written.
        let mut planned: Vec<(ObjectId, &ActionsChange, Option<Option<String>>)> = Vec::new();
        for change in changes {
            let id = self
                .field_id(&change.name)
                .ok_or_else(|| ActionsError::NoField(change.name.clone()))?;
            let calculate = match &change.calculate {
                None => None,
                Some(None) => Some(None),
                Some(Some(CalcSpec::Simple { op, fields })) => {
                    if let Some(missing) = fields.iter().find(|f| {
                        !names
                            .iter()
                            .any(|n| n == *f || n.starts_with(&format!("{f}.")))
                    }) {
                        return Err(ActionsError::NoField(missing.clone()));
                    }
                    let list = fields
                        .iter()
                        .map(|f| js_string(f))
                        .collect::<Vec<_>>()
                        .join(", ");
                    Some(Some(format!(
                        "AFSimple_Calculate(\"{}\", new Array({list}));",
                        op.code()
                    )))
                }
                Some(Some(CalcSpec::Expression(text))) => {
                    let expr = parse_expression(text, &names).map_err(ActionsError::Expression)?;
                    Some(Some(calculate_script(&expr)))
                }
            };
            planned.push((id, change, calculate));
        }
        // The calculations as they will be, checked for circles.
        let mut calcs: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for field in &report.fields {
            if let Some(js) = &field.calculate {
                calcs.insert(field.name.clone(), inputs(js));
            }
        }
        for (_, change, calculate) in &planned {
            match calculate {
                Some(Some(js)) => {
                    calcs.insert(change.name.clone(), inputs(js));
                }
                Some(None) => {
                    calcs.remove(&change.name);
                }
                None => {}
            }
        }
        let order =
            calculation_order(&report.order, &calcs, &names).map_err(ActionsError::Cycle)?;

        for (id, change, calculate) in planned {
            let mut set: Vec<(&[u8], Option<String>)> = Vec::new();
            if let Some(format) = &change.format {
                let (k, f) = match format {
                    Some(format) => {
                        let (k, f) = format_scripts(format);
                        (Some(k), Some(f))
                    }
                    None => (None, None),
                };
                set.push((b"K", k));
                set.push((b"F", f));
            }
            if let Some(range) = &change.range {
                let v = range.and_then(|(min, max)| {
                    (min.is_some() || max.is_some()).then(|| {
                        format!(
                            "AFRange_Validate({}, {}, {}, {});",
                            min.is_some(),
                            number_js(min.unwrap_or(0.0)),
                            max.is_some(),
                            number_js(max.unwrap_or(0.0))
                        )
                    })
                });
                set.push((b"V", v));
            }
            if let Some(calculate) = calculate {
                set.push((b"C", calculate));
            }
            if set.is_empty() {
                continue;
            }
            self.update_dict(id, b"AA", |aa| {
                for (key, js) in set {
                    match js {
                        Some(js) => aa.set(key, js_action(&js)),
                        None => {
                            aa.remove(key);
                        }
                    }
                }
            })?;
            // An empty /AA is dropped rather than left behind.
            let empty = matches!(
                self.doc.get_dictionary(id).ok().and_then(|d| d.get(b"AA").ok()),
                Some(Object::Dictionary(d)) if d.is_empty()
            );
            if empty {
                if let Ok(dict) = self.doc.get_dictionary_mut(id) {
                    dict.remove(b"AA");
                }
            }
        }
        // The calculation order, as references to the fields.
        let form = self.acroform_id()?;
        let refs: Vec<Object> = order
            .iter()
            .filter_map(|name| self.field_id(name))
            .map(Object::Reference)
            .collect();
        let form_dict = self.doc.get_dictionary_mut(form).map_err(parse_err)?;
        if refs.is_empty() {
            form_dict.remove(b"CO");
        } else {
            form_dict.set("CO", Object::Array(refs));
        }
        self.mark_touched(form);
        self.recalculate_values()
    }

    /// Runs every calculation over the values the fields hold and stores
    /// what changed in their `/V`. Returns the fields changed.
    pub fn recalculate_values(&mut self) -> std::result::Result<Vec<String>, ActionsError> {
        let report = self.form();
        let states: Vec<super::run::FieldState> = report
            .fields
            .iter()
            .map(|f| super::run::FieldState {
                name: f.name.clone(),
                value: f.value.clone(),
                keystroke: f.keystroke.clone(),
                format: f.format.clone(),
                validate: f.validate.clone(),
                calculate: f.calculate.clone(),
            })
            .collect();
        let outcome = super::run::recalculate(&states, &report.order, None);
        let mut changed = Vec::new();
        for (name, value) in outcome.values {
            if let Some(id) = self.field_id(&name) {
                if let Ok(dict) = self.doc.get_dictionary_mut(id) {
                    dict.set("V", text_string(&value));
                    self.mark_touched(id);
                    changed.push(name);
                }
            }
        }
        Ok(changed)
    }

    /// Draws the fields called `names` again whatever they hold, and every
    /// formatted or Arabic value with them (see `appearance`).
    pub fn redraw_named(
        &mut self,
        font: &[u8],
        names: &[String],
    ) -> Result<crate::AppearanceReport> {
        let ids: BTreeSet<ObjectId> = names.iter().filter_map(|n| self.field_id(n)).collect();
        self.redraw_appearances(font, &ids)
    }

    /// Takes the XFA away from a static XFA form, so every reader fills and
    /// shows its AcroForm — the version Warraq fills. False if there was none.
    pub fn drop_xfa(&mut self) -> Result<bool> {
        let Some(form) = self.acroform() else {
            return Ok(false);
        };
        if !form.has(b"XFA") {
            return Ok(false);
        }
        let id = self.acroform_id()?;
        if let Ok(dict) = self.doc.get_dictionary_mut(id) {
            dict.remove(b"XFA");
        }
        self.mark_touched(id);
        let catalog = self.root_id()?;
        if let Ok(dict) = self.doc.get_dictionary_mut(catalog) {
            if dict.remove(b"NeedsRendering").is_some() {
                self.mark_touched(catalog);
            }
        }
        Ok(true)
    }
}

/// Field attributes that pass from a field to the fields below it.
#[derive(Debug, Clone, Default)]
struct Inherited {
    kind: Option<Vec<u8>>,
    flags: i64,
    value: Option<Object>,
    actions: BTreeMap<Vec<u8>, String>,
}

impl Inherited {
    fn with(&self, doc: &PdfDocument, dict: &Dictionary) -> Self {
        let mut next = self.clone();
        if let Ok(ft) = dict.get(b"FT") {
            if let Ok(name) = doc.form_value(ft).as_name() {
                next.kind = Some(name.to_vec());
            }
        }
        if let Ok(ff) = dict.get(b"Ff") {
            if let Ok(flags) = doc.form_value(ff).as_i64() {
                next.flags = flags;
            }
        }
        if let Ok(v) = dict.get(b"V") {
            next.value = Some(doc.form_value(v));
        }
        if let Some(aa) = dict.get(b"AA").ok().map(|a| doc.form_value(a)) {
            if let Ok(aa) = aa.as_dict() {
                for key in [b"K".as_slice(), b"F", b"V", b"C"] {
                    if let Some(js) = aa.get(key).ok().and_then(|a| doc.javascript(a)) {
                        next.actions.insert(key.to_vec(), js);
                    }
                }
            }
        }
        next
    }
}

fn note(notes: &mut Vec<ScriptNote>, place: Place, event: &[u8], js: &str) {
    if notes.len() >= MAX_NOTES || js.trim().is_empty() {
        return;
    }
    notes.push(ScriptNote {
        place,
        event: String::from_utf8_lossy(event).into_owned(),
        text: js.chars().take(NOTE_TEXT).collect(),
    });
}

/// A name no other field has: without dots (a dot nests fields), trimmed,
/// and numbered when taken.
fn unique_name(wanted: &str, taken: &mut BTreeSet<String>) -> String {
    let base: String = wanted
        .replace(['.', '\n', '\r', '\t'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(80)
        .collect();
    let base = if base.is_empty() {
        "Field".to_string()
    } else {
        base
    };
    let mut name = base.clone();
    let mut n = 2;
    while taken.contains(&name) {
        name = format!("{base} {n}");
        n += 1;
    }
    taken.insert(name.clone());
    name
}

/// A JavaScript action with `js` as its text.
fn js_action(js: &str) -> Object {
    Object::Dictionary(Dictionary::from_iter([
        ("S", Object::Name(b"JavaScript".to_vec())),
        ("JS", text_string(js)),
    ]))
}

fn number_js(n: f64) -> String {
    super::run::number_text(n)
}

/// The keystroke and format scripts of a format.
pub fn format_scripts(format: &FormatSpec) -> (String, String) {
    match format {
        FormatSpec::Number { spec, arabic } => {
            let args = format!(
                "{}, {}, {}, 0, {}, {}",
                spec.decimals.min(10),
                spec.separator.min(4),
                spec.negative.min(3),
                js_string(&spec.currency),
                spec.prepend
            );
            if *arabic {
                (
                    format!(
                        "Warraq_LatinDigits();\nAFNumber_Keystroke({args});\n{LATIN_DIGITS_JS}"
                    ),
                    format!("AFNumber_Format({args});\nWarraq_Digits();\n{DIGITS_JS}"),
                )
            } else {
                (
                    format!("AFNumber_Keystroke({args});"),
                    format!("AFNumber_Format({args});"),
                )
            }
        }
        FormatSpec::Percent {
            decimals,
            separator,
            arabic,
        } => {
            let args = format!("{}, {}", (*decimals).min(10), (*separator).min(3));
            if *arabic {
                (
                    format!(
                        "Warraq_LatinDigits();\nAFPercent_Keystroke({args});\n{LATIN_DIGITS_JS}"
                    ),
                    format!("AFPercent_Format({args});\nWarraq_Digits();\n{DIGITS_JS}"),
                )
            } else {
                (
                    format!("AFPercent_Keystroke({args});"),
                    format!("AFPercent_Format({args});"),
                )
            }
        }
        FormatSpec::Date { pattern } => (
            format!("AFDate_KeystrokeEx({});", js_string(pattern)),
            format!("AFDate_FormatEx({});", js_string(pattern)),
        ),
        FormatSpec::Hijri { pattern, arabic } => (
            format!(
                "Warraq_HijriKeystroke({});\n{HIJRI_KEYSTROKE_JS}",
                js_string(pattern)
            ),
            format!(
                "Warraq_HijriFormat({}, {arabic});\n{HIJRI_FORMAT_JS}",
                js_string(pattern)
            ),
        ),
    }
}

/// The fields a calculate script reads.
fn inputs(js: &str) -> Vec<String> {
    let Ok(parsed) = script::parse(js) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for action in parsed.actions {
        match action {
            Action::Simple(_, fields) => out.extend(fields),
            Action::Assign(expr) => out.extend(expr.fields()),
            _ => {}
        }
    }
    out
}

/// The calculated fields in an order where each comes after every calculated
/// field it reads — the existing order kept wherever it already is one — or
/// the fields of a circle.
fn calculation_order(
    existing: &[String],
    calcs: &BTreeMap<String, Vec<String>>,
    names: &[String],
) -> std::result::Result<Vec<String>, Vec<String>> {
    // Start from the existing order, then the rest by their order in the form.
    let mut wanted: Vec<String> = existing
        .iter()
        .filter(|n| calcs.contains_key(*n))
        .cloned()
        .collect();
    for name in names {
        if calcs.contains_key(name) && !wanted.contains(name) {
            wanted.push(name.clone());
        }
    }
    // What each reads among the calculated fields (a parent name reads its kids).
    let reads = |name: &String| -> Vec<String> {
        calcs
            .get(name)
            .map(|inputs| {
                wanted
                    .iter()
                    .filter(|other| {
                        *other != name
                            && inputs
                                .iter()
                                .any(|i| *other == i || other.starts_with(&format!("{i}.")))
                    })
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    };
    for name in &wanted {
        if calcs.get(name).is_some_and(|inputs| inputs.contains(name)) {
            return Err(vec![name.clone()]);
        }
    }
    let mut done: Vec<String> = Vec::new();
    while done.len() < wanted.len() {
        let next = wanted
            .iter()
            .find(|n| !done.contains(n) && reads(n).iter().all(|r| done.contains(r)))
            .cloned();
        match next {
            Some(n) => done.push(n),
            None => {
                return Err(wanted.into_iter().filter(|n| !done.contains(n)).collect());
            }
        }
    }
    Ok(done)
}

/// The matrix of a widget's appearance on a page turned by `turn`, so what
/// it draws stands upright as the page is shown (`/MK /R`).
fn rotation_matrix(turn: i64, w: f32, h: f32) -> Option<Object> {
    let m: [f32; 6] = match turn {
        90 => [0.0, 1.0, -1.0, 0.0, h, 0.0],
        180 => [-1.0, 0.0, 0.0, -1.0, w, h],
        270 => [0.0, -1.0, 1.0, 0.0, 0.0, w],
        _ => return None,
    };
    Some(Object::Array(m.iter().map(|v| Object::Real(*v)).collect()))
}

fn form_xobject(w: f32, h: f32, matrix: Option<Object>, content: Vec<u8>) -> Stream {
    let mut dict = Dictionary::from_iter([
        ("Type", Object::Name(b"XObject".to_vec())),
        ("Subtype", Object::Name(b"Form".to_vec())),
        (
            "BBox",
            Object::Array(vec![
                Object::Real(0.0),
                Object::Real(0.0),
                Object::Real(w),
                Object::Real(h),
            ]),
        ),
        ("Resources", Object::Dictionary(Dictionary::new())),
    ]);
    if let Some(matrix) = matrix {
        dict.set("Matrix", matrix);
    }
    Stream::new(dict, content)
}

/// An appearance that draws nothing yet: the marked text block of a text
/// field, or nothing at all.
fn empty_appearance(w: f32, h: f32, text: bool, matrix: Option<Object>) -> Stream {
    form_xobject(
        w,
        h,
        matrix,
        if text {
            b"/Tx BMC\nEMC\n".to_vec()
        } else {
            Vec::new()
        },
    )
}

/// A circle round `(cx, cy)` as four Bézier quarters.
fn circle(cx: f32, cy: f32, r: f32) -> String {
    let k = 0.5523 * r;
    let p = |x: f32, y: f32| format!("{x:.2} {y:.2}");
    format!(
        "{} m {} {} {} c {} {} {} c {} {} {} c {} {} {} c h",
        p(cx + r, cy),
        p(cx + r, cy + k),
        p(cx + k, cy + r),
        p(cx, cy + r),
        p(cx - k, cy + r),
        p(cx - r, cy + k),
        p(cx - r, cy),
        p(cx - r, cy - k),
        p(cx - k, cy - r),
        p(cx, cy - r),
        p(cx + k, cy - r),
        p(cx + r, cy - k),
        p(cx + r, cy)
    )
}

/// A radio button's appearance: a ring, with a dot in it when on. Drawn as
/// paths, so it needs no font in any reader.
fn radio_appearance(w: f32, h: f32, on: bool, matrix: Option<Object>) -> Stream {
    let (cx, cy, r) = (w / 2.0, h / 2.0, (w.min(h) / 2.0 - 1.0).max(1.0));
    let mut content = format!("q 0 G 1 w {} S Q\n", circle(cx, cy, r));
    if on {
        content.push_str(&format!(
            "q 0 g {} f Q\n",
            circle(cx, cy, (r * 0.5).max(0.5))
        ));
    }
    form_xobject(w, h, matrix, content.into_bytes())
}

/// A check box's appearance: a tick when on, nothing when off. Drawn as a
/// path, so it needs no font in any reader.
fn check_appearance(w: f32, h: f32, on: bool, matrix: Option<Object>) -> Stream {
    let content = if on {
        let s = w.min(h);
        let (ox, oy) = ((w - s) / 2.0, (h - s) / 2.0);
        let p = |x: f32, y: f32| format!("{:.2} {:.2}", ox + x * s, oy + y * s);
        format!(
            "q 0 g 0 G {:.2} w 1 J 1 j {} m {} l {} l S Q\n",
            (s * 0.12).max(0.8),
            p(0.2, 0.52),
            p(0.42, 0.28),
            p(0.8, 0.76)
        )
        .into_bytes()
    } else {
        Vec::new()
    };
    form_xobject(w, h, matrix, content)
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

    const FLAT: &str = "generated/chrome-notosansarabic-form-layout.pdf";
    const ACROBAT: &str =
        "realworld/F_pdfjs15546_rtl_acroform_textfields_arabic_digits_acrobat.pdf";
    const PDFLIB: &str = "generated/acroform-pdflib-arabic-fields.pdf";

    fn new_field(kind: &str, name: &str, rect: [f32; 4]) -> NewField {
        NewField {
            page: 0,
            kind: kind.into(),
            name: name.into(),
            tooltip: format!("{name}:"),
            rect,
            rtl: true,
            pattern: None,
            options: Vec::new(),
        }
    }

    #[test]
    fn reads_an_acrobat_form() {
        let doc = PdfDocument::open(corpus(ACROBAT), None).unwrap();
        let report = doc.form();
        assert_eq!(report.xfa, Xfa::None);
        assert_eq!(report.fields.len(), 4);
        assert!(report
            .fields
            .iter()
            .all(|f| f.kind == FieldKind::Text && f.widgets.len() == 1));
        let (w, h) = doc.page_size(0).unwrap();
        for f in &report.fields {
            let [x0, top, x1, bottom] = f.widgets[0].rect;
            assert!(
                x0 >= 0.0 && x1 <= w && top >= 0.0 && bottom <= h && x0 < x1 && top < bottom,
                "{f:?}"
            );
        }
    }

    #[test]
    fn reads_nested_names_and_inherited_values() {
        let doc = PdfDocument::open(corpus(PDFLIB), None).unwrap();
        let report = doc.form();
        let name = report
            .fields
            .iter()
            .find(|f| f.name == "الاسم الكامل")
            .unwrap();
        assert_eq!(name.value, "محمد عبد الله");
        assert!(report.fields.iter().any(|f| f.kind == FieldKind::Checkbox));
    }

    #[test]
    fn creates_fields_that_read_back_and_survive_a_save() {
        let mut doc = PdfDocument::open(corpus(FLAT), None).unwrap();
        assert!(doc.form().fields.is_empty());
        let mut date = new_field("hijri", "تاريخ الميلاد", [50.0, 300.0, 250.0, 320.0]);
        date.pattern = Some("dd/mm/yyyy هـ".into());
        let created = doc
            .create_fields(&[
                new_field("text", "الاسم الكامل", [50.0, 100.0, 400.0, 124.0]),
                new_field("text", "الاسم الكامل", [50.0, 130.0, 400.0, 154.0]),
                new_field("checkbox", "الجنس/ذكر", [480.0, 200.0, 494.0, 214.0]),
                new_field("signature", "التوقيع", [300.0, 700.0, 500.0, 730.0]),
                new_field("date", "a.b", [50.0, 400.0, 150.0, 420.0]),
                date,
            ])
            .unwrap();
        assert_eq!(
            created,
            [
                "الاسم الكامل",
                "الاسم الكامل 2",
                "الجنس/ذكر",
                "التوقيع",
                "a b",
                "تاريخ الميلاد"
            ]
        );
        let saved = doc.save_incremental().unwrap();
        assert!(saved.starts_with(&corpus(FLAT)), "an update of the file");
        let back = PdfDocument::open(saved, None).unwrap();
        let report = back.form();
        assert_eq!(report.fields.len(), 6);
        let text = &report.fields[0];
        assert_eq!(text.kind, FieldKind::Text);
        assert_eq!(text.tooltip.as_deref(), Some("الاسم الكامل:"));
        let [x0, top, x1, bottom] = text.widgets[0].rect;
        assert!(
            (x0 - 50.0).abs() < 0.01
                && (top - 100.0).abs() < 0.01
                && (x1 - 400.0).abs() < 0.01
                && (bottom - 124.0).abs() < 0.01
        );
        assert_eq!(report.fields[2].kind, FieldKind::Checkbox);
        assert_eq!(report.fields[3].kind, FieldKind::Signature);
        let date = report.fields.iter().find(|f| f.name == "a b").unwrap();
        assert_eq!(
            date.format.as_deref(),
            Some("AFDate_FormatEx(\"dd/mm/yyyy\");")
        );
        let hijri = report
            .fields
            .iter()
            .find(|f| f.name == "تاريخ الميلاد")
            .unwrap();
        assert!(parse(hijri.format.as_deref().unwrap()).is_ok());
        assert!(parse(hijri.keystroke.as_deref().unwrap()).is_ok());
        assert!(report.not_run.is_empty(), "{:?}", report.not_run);
        // Right to left: /Q 2.
        let id = back.field_id("الاسم الكامل").unwrap();
        assert_eq!(
            back.doc
                .get_dictionary(id)
                .unwrap()
                .get(b"Q")
                .unwrap()
                .as_i64()
                .unwrap(),
            2
        );
    }

    #[test]
    fn calculations_are_written_in_order_and_computed() {
        let mut doc = PdfDocument::open(corpus(FLAT), None).unwrap();
        doc.create_fields(&[
            new_field("text", "الكمية", [50.0, 100.0, 150.0, 120.0]),
            new_field("text", "سعر الوحدة", [160.0, 100.0, 260.0, 120.0]),
            new_field("text", "الإجمالي", [270.0, 100.0, 370.0, 120.0]),
            new_field("text", "الضريبة", [380.0, 100.0, 480.0, 120.0]),
        ])
        .unwrap();
        for (name, value) in [("الكمية", "3"), ("سعر الوحدة", "20")] {
            let id = doc.field_id(name).unwrap();
            doc.doc
                .get_dictionary_mut(id)
                .unwrap()
                .set("V", text_string(value));
        }
        // The tax reads the total: set first, it must still come after it.
        doc.set_actions(&[ActionsChange {
            name: "الضريبة".into(),
            calculate: Some(Some(CalcSpec::Expression("الإجمالي * 0.15".into()))),
            format: Some(Some(FormatSpec::Number {
                spec: NumberSpec {
                    decimals: 2,
                    separator: 0,
                    negative: 0,
                    currency: " ر.س".into(),
                    prepend: false,
                },
                arabic: true,
            })),
            ..Default::default()
        }])
        .unwrap();
        let changed = doc
            .set_actions(&[ActionsChange {
                name: "الإجمالي".into(),
                calculate: Some(Some(CalcSpec::Expression("الكمية × \"سعر الوحدة\"".into()))),
                range: Some(Some((Some(0.0), None))),
                ..Default::default()
            }])
            .unwrap();
        assert_eq!(changed, ["الإجمالي", "الضريبة"]);
        let report = doc.form();
        assert_eq!(report.order, ["الإجمالي", "الضريبة"]);
        let value = |n: &str| {
            report
                .fields
                .iter()
                .find(|f| f.name == n)
                .unwrap()
                .value
                .clone()
        };
        assert_eq!(value("الإجمالي"), "60");
        assert_eq!(value("الضريبة"), "9");
        assert!(report.not_run.is_empty(), "{:?}", report.not_run);
        let tax = report.fields.iter().find(|f| f.name == "الضريبة").unwrap();
        assert_eq!(
            super::super::run::show(tax.format.as_deref().unwrap(), &tax.value)
                .unwrap()
                .text,
            "٩٫٠٠ ر.س"
        );

        // A circle is refused, and nothing is written.
        let err = doc
            .set_actions(&[ActionsChange {
                name: "الكمية".into(),
                calculate: Some(Some(CalcSpec::Simple {
                    op: SimpleOp::Sum,
                    fields: vec!["الضريبة".into()],
                })),
                ..Default::default()
            }])
            .unwrap_err();
        assert!(matches!(err, ActionsError::Cycle(_)), "{err:?}");
        // A name the form does not have.
        let err = doc
            .set_actions(&[ActionsChange {
                name: "الإجمالي".into(),
                calculate: Some(Some(CalcSpec::Expression("الكمية * سعر".into()))),
                ..Default::default()
            }])
            .unwrap_err();
        assert!(
            matches!(err, ActionsError::Expression(ref e) if e.kind == "unknownField"),
            "{err:?}"
        );
        // Removing a calculation takes it out of the order.
        doc.set_actions(&[ActionsChange {
            name: "الضريبة".into(),
            calculate: Some(None),
            ..Default::default()
        }])
        .unwrap();
        assert_eq!(doc.form().order, ["الإجمالي"]);

        let saved = doc.save_incremental().unwrap();
        let back = PdfDocument::open(saved, None).unwrap();
        assert_eq!(back.form().order, ["الإجمالي"]);
    }

    #[test]
    fn document_scripts_are_listed_not_run() {
        let mut doc = PdfDocument::open(corpus(ACROBAT), None).unwrap();
        let js = doc.doc.add_object(Dictionary::from_iter([
            ("S", Object::Name(b"JavaScript".to_vec())),
            ("JS", Object::string_literal("app.alert('hello')")),
        ]));
        let catalog = doc.root_id().unwrap();
        doc.doc
            .get_dictionary_mut(catalog)
            .unwrap()
            .set("OpenAction", Object::Reference(js));
        let field = doc.form().fields[0].name.clone();
        let id = doc.field_id(&field).unwrap();
        doc.doc.get_dictionary_mut(id).unwrap().set(
            "AA",
            Dictionary::from_iter([
                (
                    "C",
                    js_action("event.value = this.getField('x').value.length"),
                ),
                ("F", js_action("AFNumber_Format(2, 0, 0, 0, \"\", true);")),
            ]),
        );
        let report = doc.form();
        assert!(report
            .not_run
            .iter()
            .any(|n| n.place == Place::Open && n.text.contains("app.alert")));
        assert!(report
            .not_run
            .iter()
            .any(|n| n.place == Place::Field(field.clone()) && n.event == "C"));
        assert!(
            !report.not_run.iter().any(|n| n.event == "F"),
            "the format is one Warraq runs"
        );
    }

    #[test]
    fn xfa_is_told_apart() {
        let mut doc = PdfDocument::open(corpus(ACROBAT), None).unwrap();
        let form = doc.acroform_id().unwrap();
        doc.doc
            .get_dictionary_mut(form)
            .unwrap()
            .set("XFA", Object::Array(vec![]));
        assert_eq!(doc.form().xfa, Xfa::Static);
        let catalog = doc.root_id().unwrap();
        doc.doc
            .get_dictionary_mut(catalog)
            .unwrap()
            .set("NeedsRendering", true);
        assert_eq!(doc.form().xfa, Xfa::Dynamic);
        assert!(doc.drop_xfa().unwrap());
        assert_eq!(doc.form().xfa, Xfa::None);
        assert!(!doc.drop_xfa().unwrap());
    }

    #[test]
    fn calculation_order_keeps_what_it_can() {
        let calcs: BTreeMap<String, Vec<String>> = [
            ("a".to_string(), vec!["x".to_string()]),
            ("b".to_string(), vec!["a".to_string()]),
            ("c".to_string(), vec!["row".to_string()]),
            ("row.1".to_string(), vec!["x".to_string()]),
        ]
        .into_iter()
        .collect();
        let names: Vec<String> = ["x", "a", "b", "c", "row.1"].map(String::from).to_vec();
        let order =
            calculation_order(&["b".into(), "c".into(), "a".into()], &calcs, &names).unwrap();
        let pos = |n: &str| order.iter().position(|o| o == n).unwrap();
        assert!(pos("a") < pos("b"));
        assert!(
            pos("row.1") < pos("c"),
            "a parent name reads its kids: {order:?}"
        );
        let circle: BTreeMap<String, Vec<String>> = [
            ("a".to_string(), vec!["b".to_string()]),
            ("b".to_string(), vec!["a".to_string()]),
        ]
        .into_iter()
        .collect();
        assert!(calculation_order(&[], &circle, &["a".into(), "b".into()]).is_err());
    }
}
