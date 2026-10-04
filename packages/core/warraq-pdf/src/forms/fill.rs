//! Filling a form: values written into fields by their names, for a host
//! with no form engine of its own to type into (the iPhone and iPad app).
//!
//! A text field or a list takes its value as text (`/V`); a check box is on
//! (its own on state) or `Off`; a radio button takes the state of the
//! button chosen, by the state's name or by what it stands for (its `/Opt`
//! entry), and every button of the field shows whether it is the one. The
//! calculations the form carries are run afterwards, as a reader runs them
//! on leaving a field. The caller redraws the appearances of what changed
//! (`redraw_appearances`), so the values show in every reader — Arabic
//! shaped. Nothing is run that the form's own scripts would run beyond that
//! subset (see `script`).
use std::collections::BTreeSet;

use lopdf::{Object, ObjectId};

use super::fields::{text_string, FieldKind};
use crate::{Error, PdfDocument, Result};

/// Widgets of one field followed at most.
const MAX_WIDGETS: usize = 5_000;
/// A value too long for any field is refused rather than written.
const MAX_VALUE: usize = 10_000;

impl PdfDocument {
    /// Writes `values` (`(field name, value)`) into the form, then runs its
    /// calculations. Returns the fields whose appearance must be drawn again:
    /// the text and list fields written, and those a calculation changed.
    pub fn fill_fields(&mut self, values: &[(String, String)]) -> Result<BTreeSet<ObjectId>> {
        let report = self.form();
        let mut redraw = BTreeSet::new();
        for (name, value) in values {
            if value.chars().count() > MAX_VALUE {
                return Err(Error::Edit(format!(
                    "E_FIELD: the value for {name} is too long"
                )));
            }
            let field = report
                .fields
                .iter()
                .find(|f| &f.name == name)
                .ok_or_else(|| Error::Edit(format!("E_FIELD: no field called {name}")))?;
            if field.read_only {
                return Err(Error::Edit(format!("E_FIELD: {name} cannot be changed")));
            }
            let id = self
                .field_id(name)
                .ok_or_else(|| Error::Edit(format!("E_FIELD: no field called {name}")))?;
            match field.kind {
                FieldKind::Text => {
                    self.set_value(id, text_string(value))?;
                    redraw.insert(id);
                }
                FieldKind::Choice => {
                    if !value.is_empty()
                        && !field.editable
                        && !field.options.iter().any(|o| o == value)
                    {
                        return Err(Error::Edit(format!(
                            "E_FIELD: {value} is not one of the choices of {name}"
                        )));
                    }
                    self.set_value(id, text_string(value))?;
                    if let Ok(d) = self.doc.get_dictionary_mut(id) {
                        // A list's selection by index goes with the value it no longer names.
                        d.remove(b"I");
                    }
                    redraw.insert(id);
                }
                FieldKind::Checkbox | FieldKind::Radio => {
                    let off = value.is_empty() || value == "Off";
                    let state = if off {
                        None
                    } else if field.kind == FieldKind::Checkbox {
                        // A check box has one on state, whatever it is called.
                        Some(
                            field
                                .states
                                .first()
                                .cloned()
                                .unwrap_or_else(|| "Yes".into()),
                        )
                    } else {
                        let at = field
                            .states
                            .iter()
                            .position(|s| s == value)
                            .or_else(|| field.options.iter().position(|o| o == value))
                            .ok_or_else(|| {
                                Error::Edit(format!(
                                    "E_FIELD: {value} is not one of the buttons of {name}"
                                ))
                            })?;
                        Some(field.states[at].clone())
                    };
                    let on = state.clone().unwrap_or_else(|| "Off".into());
                    self.set_value(id, Object::Name(on.clone().into_bytes()))?;
                    for widget in self.widgets_of(id) {
                        let shown = if self.on_states(widget).contains(&on) {
                            on.as_str()
                        } else {
                            "Off"
                        };
                        if let Ok(w) = self.doc.get_dictionary_mut(widget) {
                            w.set("AS", Object::Name(shown.as_bytes().to_vec()));
                        }
                        self.mark_touched(widget);
                    }
                }
                FieldKind::Signature | FieldKind::Button => {
                    return Err(Error::Edit(format!(
                        "E_FIELD: {name} is not filled in with a value"
                    )));
                }
            }
        }
        let changed = self
            .recalculate_values()
            .map_err(|e| Error::Edit(format!("E_FIELD: {e:?}")))?;
        redraw.extend(changed.iter().filter_map(|n| self.field_id(n)));
        Ok(redraw)
    }

    fn set_value(&mut self, id: ObjectId, value: Object) -> Result<()> {
        let d = self
            .doc
            .get_dictionary_mut(id)
            .map_err(|e| Error::Parse(e.to_string()))?;
        d.set("V", value);
        d.remove(b"RV");
        self.mark_touched(id);
        Ok(())
    }

    /// A terminal field's widgets: its kids, or itself when they are one.
    fn widgets_of(&self, id: ObjectId) -> Vec<ObjectId> {
        let kids: Vec<ObjectId> = self
            .doc
            .get_dictionary(id)
            .ok()
            .and_then(|d| d.get(b"Kids").ok())
            .map(|k| match k {
                Object::Reference(r) => self.doc.get_object(*r).cloned().unwrap_or(Object::Null),
                o => o.clone(),
            })
            .and_then(|k| k.as_array().ok().cloned())
            .unwrap_or_default()
            .iter()
            .filter_map(|k| k.as_reference().ok())
            .take(MAX_WIDGETS)
            .collect();
        if kids.is_empty() {
            vec![id]
        } else {
            kids
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::forms::NewField;

    fn flat() -> PdfDocument {
        let bytes = std::fs::read(format!(
            "{}/../../../tests/fixtures/forms/ar-invoice.pdf",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap();
        PdfDocument::open(bytes, None).unwrap()
    }

    fn field(kind: &str, name: &str, rect: [f32; 4], options: &[&str]) -> NewField {
        NewField {
            page: 0,
            kind: kind.into(),
            name: name.into(),
            tooltip: String::new(),
            rect,
            rtl: true,
            pattern: None,
            options: options.iter().map(|o| o.to_string()).collect(),
        }
    }

    #[test]
    fn radio_buttons_and_a_list_are_made_read_back_and_filled() {
        let mut doc = flat();
        let created = doc
            .create_fields(&[
                field("radio", "الدفع", [400.0, 100.0, 414.0, 114.0], &["نقدًا"]),
                field("radio", "الدفع", [400.0, 120.0, 414.0, 134.0], &["بطاقة"]),
                field(
                    "choice",
                    "المدينة",
                    [50.0, 100.0, 250.0, 120.0],
                    &["الرياض", "جدة", "Dammam"],
                ),
                field("checkbox", "موافق", [50.0, 140.0, 64.0, 154.0], &[]),
                field("text", "الاسم", [50.0, 160.0, 250.0, 180.0], &[]),
            ])
            .unwrap();
        assert_eq!(created, ["الدفع", "المدينة", "موافق", "الاسم"]);
        let saved = doc.save_incremental().unwrap();
        let mut back = PdfDocument::open(saved, None).unwrap();
        let report = back.form();
        let radio = report.fields.iter().find(|f| f.name == "الدفع").unwrap();
        assert_eq!(radio.kind, FieldKind::Radio);
        assert_eq!(radio.widgets.len(), 2);
        assert_eq!(radio.states, ["0", "1"]);
        assert_eq!(radio.options, ["نقدًا", "بطاقة"]);
        let list = report.fields.iter().find(|f| f.name == "المدينة").unwrap();
        assert_eq!(list.kind, FieldKind::Choice);
        assert_eq!(list.options, ["الرياض", "جدة", "Dammam"]);

        let redraw = back
            .fill_fields(&[
                ("الدفع".into(), "بطاقة".into()),
                ("المدينة".into(), "جدة".into()),
                ("موافق".into(), "Yes".into()),
                ("الاسم".into(), "سارة".into()),
            ])
            .unwrap();
        assert_eq!(redraw.len(), 2, "the list and the text");
        let report = back.form();
        let value = |n: &str| {
            report
                .fields
                .iter()
                .find(|f| f.name == n)
                .unwrap()
                .value
                .clone()
        };
        assert_eq!(value("الدفع"), "1");
        assert_eq!(value("المدينة"), "جدة");
        assert_eq!(value("موافق"), "Yes");
        assert_eq!(value("الاسم"), "سارة");
        // Only the chosen button shows on.
        let id = back.field_id("الدفع").unwrap();
        let shown: Vec<String> = back
            .widgets_of(id)
            .iter()
            .map(|w| {
                let d = back.doc.get_dictionary(*w).unwrap();
                String::from_utf8_lossy(d.get(b"AS").unwrap().as_name().unwrap()).into_owned()
            })
            .collect();
        assert_eq!(shown, ["Off", "1"]);

        assert!(back
            .fill_fields(&[("المدينة".into(), "مكة".into())])
            .is_err());
        assert!(back.fill_fields(&[("لا يوجد".into(), "x".into())]).is_err());
        assert!(back.fill_fields(&[("الدفع".into(), "شيك".into())]).is_err());
        back.fill_fields(&[("موافق".into(), "Off".into())]).unwrap();
        assert_eq!(
            back.form()
                .fields
                .iter()
                .find(|f| f.name == "موافق")
                .unwrap()
                .value,
            "Off"
        );
    }

    #[test]
    fn a_list_without_options_is_refused() {
        let mut doc = flat();
        assert!(doc
            .create_fields(&[field(
                "choice",
                "فارغة",
                [50.0, 100.0, 250.0, 120.0],
                &[" "]
            )])
            .is_err());
    }
}
