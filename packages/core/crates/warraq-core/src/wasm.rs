//! wasm-bindgen surface (feature `wasm`), used by `packages/ui/src/services/engine.ts` inside
//! a Worker:
//!
//! ```js
//! const doc = WarraqDocument.open(bytes, password ?? undefined);
//! const { json, blobs } = doc.call("pages.rotate", JSON.stringify({ pages: [0], degrees: 90 }), []);
//! const r = callStatic("pdf.isEncrypted", "{}", [bytes]);
//! ```
//! Errors are thrown as plain objects `{ code, message }`.

use crate::{call_static, guarded, CoreError, Document, Reply};
use js_sys::{Array, ArrayBuffer, Object, Reflect, Uint8Array};
use serde_json::Value;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

fn err_js(e: CoreError) -> JsValue {
    let o = Object::new();
    let _ = Reflect::set(&o, &"code".into(), &e.code.into());
    let _ = Reflect::set(&o, &"message".into(), &e.message.into());
    o.into()
}

fn reply_js(r: Reply) -> JsValue {
    let o = Object::new();
    let _ = Reflect::set(&o, &"json".into(), &r.json.to_string().into());
    let arr = Array::new();
    for b in &r.blobs {
        arr.push(&Uint8Array::from(b.as_slice()).into());
    }
    let _ = Reflect::set(&o, &"blobs".into(), &arr.into());
    o.into()
}

fn blobs_from(arr: &Array) -> Result<Vec<Vec<u8>>, CoreError> {
    arr.iter()
        .enumerate()
        .map(|(i, v)| {
            if let Some(u) = v.dyn_ref::<Uint8Array>() {
                Ok(u.to_vec())
            } else if let Some(b) = v.dyn_ref::<ArrayBuffer>() {
                Ok(Uint8Array::new(b).to_vec())
            } else {
                Err(CoreError::params(format!(
                    "blobs[{i}] must be a Uint8Array"
                )))
            }
        })
        .collect()
}

fn parse_params(s: &str) -> Result<Value, CoreError> {
    if s.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(s).map_err(|e| CoreError::params(format!("params are not JSON: {e}")))
}

/// An open PDF document.
#[wasm_bindgen]
pub struct WarraqDocument {
    inner: Document,
}

#[wasm_bindgen]
impl WarraqDocument {
    /// Open a document; `password` may be the user or owner password.
    pub fn open(bytes: Vec<u8>, password: Option<String>) -> Result<WarraqDocument, JsValue> {
        guarded(|| Document::open(bytes, password.as_deref()))
            .map(|inner| WarraqDocument { inner })
            .map_err(err_js)
    }

    /// Call a document method: returns `{ json: string, blobs: Uint8Array[] }`.
    pub fn call(
        &mut self,
        method: &str,
        params_json: &str,
        blobs: Array,
    ) -> Result<JsValue, JsValue> {
        let inner = &mut self.inner;
        guarded(|| {
            let params = parse_params(params_json)?;
            let blobs = blobs_from(&blobs)?;
            inner.call(method, &params, blobs)
        })
        .map(reply_js)
        .map_err(err_js)
    }
}

/// Call a static method: returns `{ json: string, blobs: Uint8Array[] }`.
#[wasm_bindgen(js_name = callStatic)]
pub fn call_static_js(method: &str, params_json: &str, blobs: Array) -> Result<JsValue, JsValue> {
    guarded(|| {
        let params = parse_params(params_json)?;
        let blobs = blobs_from(&blobs)?;
        call_static(method, &params, blobs)
    })
    .map(reply_js)
    .map_err(err_js)
}
