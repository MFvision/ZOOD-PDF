//! `create.*` (static): Create PDF from DOCX/XLSX/PPTX/HTML/Markdown/text/CSV/pictures
//! (warraq-create).
//!
//! * `create.fromFiles` — params `{ files: [{ name, type? }], pageSize: "auto"|"a4"|"letter",
//!   orientation: "auto"|"portrait"|"landscape", margins: "normal"|"narrow"|"wide", merge,
//!   pageNumbers, locale, title? }`, blobs = the files in the same order. Reply
//!   `{ documents: [{ name, pageCount, byteLength }] }` with one PDF blob per document.
//! * `create.formats` — `{ extensions: [...] }` for the file picker.

use crate::registry::Registry;
use crate::{CoreError, Reply};
use serde_json::Value;

pub fn register(r: &mut Registry) {
    r.static_fn("create.fromFiles", from_files)
        .static_fn("create.formats", formats);
}

fn from_files(p: &Value, blobs: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let (json, blobs) = warraq_create::rpc_from_files(p, blobs)
        .map_err(|e| CoreError::new(e.code(), e.to_string()))?;
    Ok(Reply { json, blobs })
}

fn formats(_p: &Value, _b: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    Ok(Reply::json(warraq_create::rpc_formats()))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use crate::{call_static, Document};
    use serde_json::json;

    #[test]
    fn create_from_markdown_then_open_and_extract() {
        let md = "# عنوان\n\nنص عربي مع English.\n";
        let r = call_static(
            "create.fromFiles",
            &json!({ "files": [{ "name": "a.md" }], "locale": "ar", "pageNumbers": true }),
            vec![md.as_bytes().to_vec()],
        )
        .unwrap();
        assert_eq!(r.json["documents"][0]["name"], "a.pdf");
        assert_eq!(r.json["documents"][0]["pageCount"], 1);
        let mut d = Document::open(r.blobs[0].clone(), None).unwrap();
        let t = d.call("text.plain", &json!({}), vec![]).unwrap();
        let text = t.json["text"].as_str().unwrap();
        assert!(
            text.contains("عنوان") && text.contains("نص عربي مع English."),
            "{text}"
        );
    }

    #[test]
    fn errors_are_coded() {
        let e = call_static("create.fromFiles", &json!({ "files": [] }), vec![]).unwrap_err();
        assert_eq!(e.code, "invalid_params");
        let e = call_static(
            "create.fromFiles",
            &json!({ "files": [{ "name": "a.docx" }] }),
            vec![b"PK\x03\x04broken".to_vec()],
        )
        .unwrap_err();
        assert_eq!(e.code, "malformed_input");
        let e = call_static(
            "create.fromFiles",
            &json!({ "files": [{ "name": "a.pdf" }] }),
            vec![b"%PDF-1.7".to_vec()],
        )
        .unwrap_err();
        assert_eq!(e.code, "unsupported_format");
        let f = call_static("create.formats", &json!({}), vec![]).unwrap();
        assert!(f.json["extensions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|x| x == "docx"));
    }
}
