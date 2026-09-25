//! Built-in RPC namespaces. One file per namespace; add yours to [`NAMESPACES`].

use crate::registry::Registry;
use crate::CoreError;
use serde::de::DeserializeOwned;
use serde_json::Value;

mod create;
mod doc;
mod pages;
mod pdf;
mod protect;
#[cfg(feature = "render")]
mod render;
mod text;

/// Every namespace's `register` function.
pub const NAMESPACES: &[fn(&mut Registry)] = &[
    doc::register,
    pages::register,
    protect::register,
    pdf::register,
    text::register,
    // Create PDF
    create::register,
    #[cfg(feature = "render")]
    render::register,
];

/// Deserialize params (`null` counts as `{}`).
pub(crate) fn params<T: DeserializeOwned>(v: &Value) -> Result<T, CoreError> {
    let v = if v.is_null() {
        Value::Object(Default::default())
    } else {
        v.clone()
    };
    serde_json::from_value(v).map_err(|e| CoreError::params(e.to_string()))
}

/// The first blob or an `invalid_params` error.
pub(crate) fn blob0(blobs: Vec<Vec<u8>>, what: &str) -> Result<Vec<u8>, CoreError> {
    blobs
        .into_iter()
        .next()
        .ok_or_else(|| CoreError::params(format!("blobs[0] must be {what}")))
}
