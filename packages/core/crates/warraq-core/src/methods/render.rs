//! `pages.render` (feature `render`): PNG of one page via hayro.

use super::params;
use crate::registry::Registry;
use crate::{CoreError, Document, Reply};
use serde::Deserialize;
use serde_json::{json, Value};
use warraq_pdf::Protection;
use warraq_render::{HayroRenderer, PageRenderer};

pub fn register(r: &mut Registry) {
    r.doc("pages.render", render);
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Render {
    page: usize,
    #[serde(default = "one")]
    scale: f32,
}

fn one() -> f32 {
    1.0
}

fn render(doc: &mut Document, p: &Value, _b: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let p: Render = params(p)?;
    // hayro gets plaintext: decrypt in memory with our own handler.
    let bytes = if doc.pdf().is_encrypted() || doc.pdf().has_changes() {
        doc.pdf().write_full(Protection::Remove)?
    } else {
        doc.pdf().bytes().to_vec()
    };
    let r = HayroRenderer::new(bytes).map_err(|e| CoreError::new("render_error", e.to_string()))?;
    let bmp = r
        .render(p.page, p.scale)
        .map_err(|e| CoreError::new("render_error", e.to_string()))?;
    let png = bmp
        .to_png()
        .map_err(|e| CoreError::new("render_error", e.to_string()))?;
    Ok(Reply::with_blob(
        json!({ "width": bmp.width, "height": bmp.height }),
        png,
    ))
}
