//! Method registry: the extension point for new RPC namespaces.
//!
//! ```text
//! src/methods/mod.rs   NAMESPACES = [doc::register, pages::register, …]
//! src/methods/pages.rs pub fn register(r: &mut Registry) { r.doc("pages.rotate", rotate); … }
//! ```
//! A crate like warraq-text gets its namespace by adding `src/methods/text.rs` (calling into
//! warraq-text) and one entry in `NAMESPACES`. Embedders can also build their own registry.

use crate::{CoreError, Document, Reply};
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::OnceLock;

/// A method on an open document.
pub type DocMethod = fn(&mut Document, &Value, Vec<Vec<u8>>) -> Result<Reply, CoreError>;
/// A method without a document.
pub type StaticMethod = fn(&Value, Vec<Vec<u8>>) -> Result<Reply, CoreError>;

/// Name → function tables.
#[derive(Default)]
pub struct Registry {
    doc: BTreeMap<&'static str, DocMethod>,
    stat: BTreeMap<&'static str, StaticMethod>,
}

impl Registry {
    /// Register a document method. Later registrations of the same name replace earlier ones.
    pub fn doc(&mut self, name: &'static str, f: DocMethod) -> &mut Self {
        self.doc.insert(name, f);
        self
    }

    /// Register a static method.
    pub fn static_fn(&mut self, name: &'static str, f: StaticMethod) -> &mut Self {
        self.stat.insert(name, f);
        self
    }

    /// Look up a document method.
    pub fn doc_method(&self, name: &str) -> Option<DocMethod> {
        self.doc.get(name).copied()
    }

    /// Look up a static method.
    pub fn static_method(&self, name: &str) -> Option<StaticMethod> {
        self.stat.get(name).copied()
    }

    /// Names of all document methods (sorted).
    pub fn doc_names(&self) -> Vec<&'static str> {
        self.doc.keys().copied().collect()
    }

    /// Names of all static methods (sorted).
    pub fn static_names(&self) -> Vec<&'static str> {
        self.stat.keys().copied().collect()
    }
}

/// The process-wide registry with every built-in namespace.
pub fn registry() -> &'static Registry {
    static R: OnceLock<Registry> = OnceLock::new();
    R.get_or_init(|| {
        let mut r = Registry::default();
        for register in crate::methods::NAMESPACES {
            register(&mut r);
        }
        r
    })
}
