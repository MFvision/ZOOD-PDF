//! Optional content (layers): which OCGs are OFF in the default configuration, and whether an
//! OCG / OCMD (visibility policies `AnyOn` `AllOn` `AnyOff` `AllOff`, `/VE` expressions) is
//! hidden. ISO 32000-2 §8.11.

use lopdf::{Dictionary, Object, ObjectId};
use std::collections::HashSet;
use warraq_text::source::{resolve, resolve_dict, ContentSource};

/// Deepest `/VE` expression evaluated (deeper counts as visible).
const MAX_VE_DEPTH: usize = 32;

/// Visibility of the document's optional content groups in the default configuration.
#[derive(Debug, Clone, Default)]
pub struct OcState {
    /// Every OCG listed in `/OCProperties /OCGs`.
    pub all: HashSet<ObjectId>,
    /// OCGs that are OFF in `/D`.
    pub hidden: HashSet<ObjectId>,
}

fn refs(o: Option<&Object>) -> Vec<ObjectId> {
    match o {
        Some(Object::Array(a)) => a
            .iter()
            .filter_map(|x| x.as_reference().ok())
            .take(1_000_000)
            .collect(),
        Some(Object::Reference(r)) => vec![*r],
        _ => Vec::new(),
    }
}

impl OcState {
    /// Read `/OCProperties` of the catalog. `None` when the document has no optional content.
    pub fn from_catalog<S: ContentSource + ?Sized>(
        src: &S,
        catalog: &Dictionary,
    ) -> Option<OcState> {
        let props = catalog
            .get(b"OCProperties")
            .ok()
            .and_then(|o| resolve_dict(src, o))?;
        let all: HashSet<ObjectId> = refs(props.get(b"OCGs").ok().and_then(|o| resolve(src, o)))
            .into_iter()
            .collect();
        let d = props.get(b"D").ok().and_then(|o| resolve_dict(src, o));
        let mut hidden = HashSet::new();
        if let Some(d) = d {
            let base_off = matches!(
                d.get(b"BaseState").ok().and_then(|o| resolve(src, o)),
                Some(Object::Name(n)) if n.as_slice() == b"OFF"
            );
            if base_off {
                hidden.extend(all.iter().copied());
            }
            for id in refs(d.get(b"ON").ok().and_then(|o| resolve(src, o))) {
                hidden.remove(&id);
            }
            for id in refs(d.get(b"OFF").ok().and_then(|o| resolve(src, o))) {
                hidden.insert(id);
            }
        }
        Some(OcState { all, hidden })
    }

    fn ocg_visible(&self, id: ObjectId) -> bool {
        !self.hidden.contains(&id)
    }

    /// Is content tagged with this `/OC` value (OCG or OCMD, reference or direct) hidden?
    pub fn is_hidden<S: ContentSource + ?Sized>(&self, src: &S, oc: &Object) -> bool {
        !self.visible(src, oc, 0)
    }

    fn visible<S: ContentSource + ?Sized>(&self, src: &S, oc: &Object, depth: usize) -> bool {
        if depth > MAX_VE_DEPTH {
            return true;
        }
        let id = oc.as_reference().ok();
        let Some(dict) = resolve_dict(src, oc) else {
            return true;
        };
        let ty = match dict.get(b"Type").ok().and_then(|o| resolve(src, o)) {
            Some(Object::Name(n)) => n.clone(),
            _ => Vec::new(),
        };
        let is_ocmd = ty == b"OCMD" || (ty != b"OCG" && dict.has(b"OCGs"));
        if !is_ocmd {
            return id.is_none_or(|id| self.ocg_visible(id));
        }
        if let Some(ve) = dict.get(b"VE").ok().and_then(|o| resolve(src, o)) {
            if let Object::Array(_) = ve {
                return self.eval_ve(src, ve, depth + 1);
            }
        }
        let groups = refs(dict.get(b"OCGs").ok().and_then(|o| resolve(src, o)));
        if groups.is_empty() {
            return true;
        }
        let policy = match dict.get(b"P").ok().and_then(|o| resolve(src, o)) {
            Some(Object::Name(n)) => n.clone(),
            _ => b"AnyOn".to_vec(),
        };
        let on = groups.iter().filter(|g| self.ocg_visible(**g)).count();
        match policy.as_slice() {
            b"AllOn" => on == groups.len(),
            b"AnyOff" => on < groups.len(),
            b"AllOff" => on == 0,
            _ => on > 0,
        }
    }

    fn eval_ve<S: ContentSource + ?Sized>(&self, src: &S, e: &Object, depth: usize) -> bool {
        if depth > MAX_VE_DEPTH {
            return true;
        }
        match e {
            Object::Reference(id) => match resolve(src, e) {
                Some(Object::Array(_)) => {
                    resolve(src, e).is_none_or(|x| self.eval_ve(src, x, depth + 1))
                }
                _ => self.ocg_visible(*id),
            },
            Object::Array(a) => {
                let op = match a.first().and_then(|o| resolve(src, o)) {
                    Some(Object::Name(n)) => n.clone(),
                    _ => return true,
                };
                let args = a.get(1..).unwrap_or(&[]);
                match op.as_slice() {
                    b"Not" => args
                        .first()
                        .is_none_or(|x| !self.eval_ve(src, x, depth + 1)),
                    b"And" => args.iter().all(|x| self.eval_ve(src, x, depth + 1)),
                    b"Or" => {
                        args.is_empty() || args.iter().any(|x| self.eval_ve(src, x, depth + 1))
                    }
                    _ => true,
                }
            }
            _ => true,
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use lopdf::{dictionary, Document};
    use warraq_text::LopdfSource;

    fn setup() -> (LopdfSource, OcState, ObjectId, ObjectId) {
        let mut doc = Document::with_version("1.7");
        let on =
            doc.add_object(dictionary! {"Type" => "OCG", "Name" => Object::string_literal("on")});
        let off =
            doc.add_object(dictionary! {"Type" => "OCG", "Name" => Object::string_literal("off")});
        let cat = dictionary! {
            "OCProperties" => dictionary! {
                "OCGs" => vec![on.into(), off.into()],
                "D" => dictionary! {"OFF" => vec![off.into()]},
            }
        };
        let src = LopdfSource::from_document(doc);
        let st = OcState::from_catalog(&src, &cat).unwrap();
        (src, st, on, off)
    }

    #[test]
    fn ocg_and_policies() {
        let (src, st, on, off) = setup();
        assert!(!st.is_hidden(&src, &Object::Reference(on)));
        assert!(st.is_hidden(&src, &Object::Reference(off)));
        let md = |p: &str| {
            Object::Dictionary(
                dictionary! {"Type" => "OCMD", "OCGs" => vec![on.into(), off.into()], "P" => p},
            )
        };
        assert!(!st.is_hidden(&src, &md("AnyOn")));
        assert!(st.is_hidden(&src, &md("AllOn")));
        assert!(!st.is_hidden(&src, &md("AnyOff")));
        assert!(st.is_hidden(&src, &md("AllOff")));
    }

    #[test]
    fn visibility_expressions() {
        let (src, st, on, off) = setup();
        let ve = |e: Vec<Object>| Object::Dictionary(dictionary! {"Type" => "OCMD", "VE" => e});
        let not_off = Object::Array(vec!["Not".into(), off.into()]);
        assert!(!st.is_hidden(&src, &ve(vec!["And".into(), on.into(), not_off.clone()])));
        assert!(st.is_hidden(&src, &ve(vec!["And".into(), on.into(), off.into()])));
        assert!(!st.is_hidden(&src, &ve(vec!["Or".into(), off.into(), on.into()])));
        assert!(st.is_hidden(
            &src,
            &ve(vec![
                "Not".into(),
                Object::Array(vec!["Or".into(), on.into()])
            ])
        ));
        // BaseState OFF + ON list
        let cat = dictionary! {"OCProperties" => dictionary! {"OCGs" => vec![on.into(), off.into()], "D" => dictionary! {"BaseState" => "OFF", "ON" => vec![on.into()]}}};
        let st2 = OcState::from_catalog(&src, &cat).unwrap();
        assert!(!st2.is_hidden(&src, &Object::Reference(on)));
        assert!(st2.is_hidden(&src, &Object::Reference(off)));
    }
}
