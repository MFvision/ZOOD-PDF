//! A page's marked-content sequences in the order a renderer meets them —
//! the page's content, the forms it draws, then its annotations' appearances
//! — each with the text it stands for (`/ActualText`, PDF 2.0 §14.9.4).
//!
//! The reader pairs these with the glyphs it collected: the renderer says
//! which sequences each glyph was drawn in, and their tags, but not their
//! properties. Where the order cannot be vouched for, there is no answer.
use lopdf::content::Content;
use lopdf::{Dictionary, Document, Object};

use crate::document::decode_text_string;
use crate::PdfDocument;

/// One `BMC` or `BDC`: its tag, the text its content stands for, and the
/// marked-content identifier that ties it to a structure element.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkedSequence {
    pub tag: Vec<u8>,
    pub actual_text: Option<String>,
    pub mcid: Option<i64>,
    /// One of Warraq's own page marks: an `/Artifact` whose properties
    /// carry `/WarraqMark` (see `marks`), not another program's artifact.
    pub warraq_mark: bool,
}

/// The renderer (hayro) gives up on forms nested deeper than this.
const MAX_DEPTH: u32 = 50;

fn resolve<'a>(doc: &'a Document, object: &'a Object) -> &'a Object {
    match object {
        Object::Reference(id) => doc.get_object(*id).unwrap_or(object),
        other => other,
    }
}

/// Resource dictionaries in lookup order: the nearest first.
type Resources<'a> = Vec<&'a Dictionary>;

fn lookup<'a>(
    doc: &'a Document,
    resources: &Resources<'a>,
    category: &[u8],
    name: &[u8],
) -> Option<&'a Object> {
    resources.iter().find_map(|dict| {
        let group = resolve(doc, dict.get(category).ok()?).as_dict().ok()?;
        Some(resolve(doc, group.get(name).ok()?))
    })
}

/// Optional content: a renderer may skip what it marks, forms included, and
/// its sequences with it — so a page that has any is not paired at all.
fn is_optional_content(dict: &Dictionary) -> bool {
    dict.has(b"OC")
        || matches!(
            dict.get(b"Type").ok().and_then(|t| t.as_name().ok()),
            Some(b"OCG" | b"OCMD")
        )
}

fn walk<'a>(
    doc: &'a Document,
    content: &[u8],
    resources: &Resources<'a>,
    depth: u32,
    out: &mut Vec<MarkedSequence>,
) -> Option<()> {
    for op in Content::decode(content).ok()?.operations {
        match op.operator.as_str() {
            "BMC" => out.push(MarkedSequence {
                tag: op.operands.first()?.as_name().ok()?.to_vec(),
                actual_text: None,
                mcid: None,
                warraq_mark: false,
            }),
            "BDC" => {
                let tag = op.operands.first()?.as_name().ok()?.to_vec();
                if tag == b"OC" {
                    return None;
                }
                let properties = match op.operands.get(1)? {
                    Object::Name(name) => {
                        lookup(doc, resources, b"Properties", name).and_then(|p| p.as_dict().ok())
                    }
                    other => resolve(doc, other).as_dict().ok(),
                };
                if properties.is_some_and(is_optional_content) {
                    return None;
                }
                let actual_text = properties
                    .and_then(|p| p.get(b"ActualText").ok())
                    .and_then(|t| resolve(doc, t).as_str().ok())
                    .map(decode_text_string);
                let mcid = properties
                    .and_then(|p| p.get(b"MCID").ok())
                    .and_then(|m| m.as_i64().ok());
                let warraq_mark =
                    tag == b"Artifact" && properties.is_some_and(|p| p.has(b"WarraqMark"));
                out.push(MarkedSequence {
                    tag,
                    actual_text,
                    mcid,
                    warraq_mark,
                });
            }
            "Do" => {
                let name = op.operands.first()?.as_name().ok()?;
                let Some(Object::Stream(form)) = lookup(doc, resources, b"XObject", name) else {
                    continue;
                };
                if form
                    .dict
                    .get(b"Subtype")
                    .ok()
                    .and_then(|s| s.as_name().ok())
                    == Some(b"Form")
                {
                    draw_form(doc, form, resources, depth, out)?;
                }
            }
            _ => {}
        }
    }
    Some(())
}

fn draw_form<'a>(
    doc: &'a Document,
    form: &'a lopdf::Stream,
    parent: &Resources<'a>,
    depth: u32,
    out: &mut Vec<MarkedSequence>,
) -> Option<()> {
    if depth + 1 >= MAX_DEPTH || is_optional_content(&form.dict) {
        return None;
    }
    let content = crate::document::decoded(form).ok()?;
    let resources: Resources<'a> = match form
        .dict
        .get(b"Resources")
        .ok()
        .and_then(|r| resolve(doc, r).as_dict().ok())
    {
        Some(own) => std::iter::once(own).chain(parent.iter().copied()).collect(),
        None => parent.clone(),
    };
    walk(doc, &content, &resources, depth + 1, out)
}

impl PdfDocument {
    /// Page `index`'s marked-content sequences, in the order a renderer meets
    /// them. `None` when that order cannot be vouched for: optional content,
    /// forms nested past the renderer's limit, a content stream that does not
    /// parse.
    pub fn marked_content(&self, index: usize) -> Option<Vec<MarkedSequence>> {
        let doc = &self.doc;
        let page_id = self.page_id(index).ok()?;
        let (own, inherited) = doc.get_page_resources(page_id).ok()?;
        let resources: Resources<'_> = own
            .into_iter()
            .chain(
                inherited
                    .iter()
                    .filter_map(|id| doc.get_dictionary(*id).ok()),
            )
            .collect();
        let mut out = Vec::new();
        let content = crate::document::page_content_of(doc, page_id).ok()?;
        walk(doc, &content, &resources, 0, &mut out)?;
        let page = doc.get_dictionary(page_id).ok()?;
        let annots = page
            .get(b"Annots")
            .ok()
            .and_then(|a| resolve(doc, a).as_array().ok());
        for annot in annots.into_iter().flatten() {
            let Ok(annot) = resolve(doc, annot).as_dict() else {
                continue;
            };
            // As the renderer: hidden ones, and ones without a place, are not drawn.
            let flags = annot
                .get(b"F")
                .ok()
                .and_then(|f| f.as_i64().ok())
                .unwrap_or(0);
            if flags & 2 != 0 || !annot.has(b"Rect") {
                continue;
            }
            let normal = annot
                .get(b"AP")
                .ok()
                .and_then(|ap| resolve(doc, ap).as_dict().ok())
                .and_then(|ap| ap.get(b"N").ok())
                .map(|n| resolve(doc, n));
            if let Some(Object::Stream(form)) = normal {
                draw_form(doc, form, &resources, 0, &mut out)?;
            }
        }
        Some(out)
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

    #[test]
    fn a_chrome_page_lists_its_spans_with_their_text() {
        let doc = PdfDocument::open(
            corpus("generated/chrome-amiri-tashkeel-ligatures.pdf"),
            None,
        )
        .unwrap();
        let marks = doc.marked_content(0).expect("no optional content here");
        let texts: Vec<&str> = marks
            .iter()
            .filter_map(|m| m.actual_text.as_deref())
            .collect();
        assert!(!texts.is_empty(), "Chrome marks its clusters: {marks:?}");
        assert!(
            texts
                .iter()
                .any(|t| t.chars().any(|c| ('\u{0600}'..='\u{06FF}').contains(&c))),
            "{texts:?}"
        );
    }

    #[test]
    fn a_page_without_marked_content_has_none() {
        let doc = PdfDocument::open(
            corpus("generated/raw-amiri-cid-identity-tounicode.pdf"),
            None,
        )
        .unwrap();
        assert_eq!(doc.marked_content(0), Some(vec![]));
    }
}
