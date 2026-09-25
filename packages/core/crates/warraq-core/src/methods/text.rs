//! `text.*`: Arabic-aware extraction, search and logical-order plain text (warraq-text).

use crate::registry::Registry;
use crate::{CoreError, Document, Reply};
use serde_json::Value;
use warraq_text::DocSource;

pub fn register(r: &mut Registry) {
    r.doc("text.extract", extract)
        .doc("text.search", search)
        .doc("text.plain", plain);
}

fn run(d: &mut Document, method: &str, p: &Value) -> Result<Reply, CoreError> {
    let src = DocSource::borrowed(d.pdf().document());
    match warraq_text::call(&src, method, p) {
        Some(Ok(v)) => Ok(Reply::json(v)),
        Some(Err(e)) => Err(CoreError::new(e.code(), e.to_string())),
        None => Err(CoreError::new("unknown_method", method.to_string())),
    }
}

fn extract(d: &mut Document, p: &Value, _b: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    run(d, "text.extract", p)
}
fn search(d: &mut Document, p: &Value, _b: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    run(d, "text.search", p)
}
fn plain(d: &mut Document, p: &Value, _b: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    run(d, "text.plain", p)
}
