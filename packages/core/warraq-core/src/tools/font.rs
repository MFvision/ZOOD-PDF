//! Fonts a host found for an edit — installed on the device, or downloaded
//! from the open library — checked before any text is set in them: that the
//! bytes are a font at all, of the family asked for, with outlines the
//! embedder can write, a licence that allows embedding, and a glyph for
//! every character of the text. A font that fails any of these is not used:
//! the host falls through to the next one rather than draw empty boxes.
use std::io::Cursor;

use serde::Deserialize;
use warraq_text::fontfile;

use super::{args, Reply};
use crate::CoreError;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Check {
    /// The text to be drawn; every character of it must have a glyph.
    #[serde(default)]
    text: String,
    /// The family the font must be of, when the host asked for one.
    #[serde(default)]
    family: Option<String>,
}

/// Why a font is not used; `None` when it can be.
fn refusal(font: &[u8], check: &Check) -> (Option<&'static str>, Option<fontfile::FaceFacts>) {
    if font.len() > fontfile::MAX_FACE_BYTES {
        return (Some("too-large"), None);
    }
    let Some(facts) = fontfile::faces(&mut Cursor::new(font)).into_iter().next() else {
        return (Some("not-a-font"), None);
    };
    let reason = if !facts.truetype {
        Some("not-truetype")
    } else if !facts.embeddable {
        Some("not-embeddable")
    } else if check.family.as_deref().is_some_and(|wanted| {
        // A file may name its family with a style in it: the open
        // library's static files are cut from a variable font and all say
        // "Montserrat Thin", whatever their weight. The family is what is
        // left when the style words are taken off, as for a PDF's names.
        let wanted = fontfile::family_key(wanted);
        !facts.families.iter().any(|name| {
            fontfile::family_key(name) == wanted
                || fontfile::family_key(&warraq_pdf::face::parse_base_font(name).family) == wanted
        })
    }) {
        Some("other-family")
    } else {
        match warraq_text::Shaper::new(font) {
            Err(_) => Some("not-a-font"),
            Ok(shaper) if !shaper.covers(&check.text) => Some("missing-glyphs"),
            Ok(_) => None,
        }
    };
    (reason, Some(facts))
}

pub fn call_static(name: &str, json: &str, blobs: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    match name {
        // blob: a font file (not a collection: a host hands over one face).
        "check" => {
            let a: Check = args(json)?;
            let Some(font) = blobs.first() else {
                return Err(CoreError::Args("font.check takes a font file".into()));
            };
            let (reason, facts) = refusal(font, &a);
            Reply::of(&serde_json::json!({
                "usable": reason.is_none(),
                "reason": reason,
                "family": facts.as_ref().and_then(|f| f.families.first()),
                "weight": facts.as_ref().map(|f| f.weight),
                "italic": facts.as_ref().map(|f| f.italic),
                "variable": facts.as_ref().map(|f| f.variable),
            }))
        }
        _ => Err(CoreError::UnknownOp(format!("font.{name}"))),
    }
}
