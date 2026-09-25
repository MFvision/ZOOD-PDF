//! A small, bounded XML tree on top of `quick-xml`.
//!
//! * No DTD processing: `<!DOCTYPE …>` is skipped and **no entity is ever expanded** except the
//!   five predefined ones and numeric character references (billion-laughs cannot happen).
//! * At most [`limits::MAX_XML_NODES`] nodes and [`limits::MAX_XML_DEPTH`] levels.
//! * Element and attribute names are kept with their prefix (`w:p`) and matched by local name.

use quick_xml::events::Event;
use quick_xml::Reader;

use crate::error::{CreateError, Result};
use crate::limits;

/// An element.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Node {
    /// Qualified name (`w:p`).
    pub qname: String,
    /// Attributes as (qualified name, value).
    pub attrs: Vec<(String, String)>,
    pub children: Vec<Child>,
}

/// Element content.
#[derive(Debug, Clone, PartialEq)]
pub enum Child {
    Elem(Node),
    Text(String),
}

fn local(q: &str) -> &str {
    q.rsplit(':').next().unwrap_or(q)
}

impl Node {
    /// Local name (`p` for `w:p`).
    pub fn name(&self) -> &str {
        local(&self.qname)
    }

    /// Is this element named `name` (local name)?
    pub fn is(&self, name: &str) -> bool {
        self.name() == name
    }

    /// Attribute by local name (the first match).
    pub fn attr(&self, name: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(k, _)| local(k) == name)
            .map(|(_, v)| v.as_str())
    }

    /// Attribute by exact qualified name, else a prefixed attribute with that local name
    /// (`r:id` must not match a plain `id`).
    pub fn attr_prefixed(&self, name: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(k, _)| k == name)
            .or_else(|| {
                let l = local(name);
                self.attrs.iter().find(|(k, _)| k.contains(':') && local(k) == l)
            })
            .map(|(_, v)| v.as_str())
    }

    /// Child elements.
    pub fn elems(&self) -> impl Iterator<Item = &Node> {
        self.children.iter().filter_map(|c| match c {
            Child::Elem(n) => Some(n),
            Child::Text(_) => None,
        })
    }

    /// First child element with local name `name`.
    pub fn child(&self, name: &str) -> Option<&Node> {
        self.elems().find(|n| n.is(name))
    }

    /// Child elements with local name `name`.
    pub fn children_named<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Node> + 'a {
        self.elems().filter(move |n| n.is(name))
    }

    /// Follow a path of local names (`["pPr", "jc"]`).
    pub fn path(&self, names: &[&str]) -> Option<&Node> {
        let mut n = self;
        for name in names {
            n = n.child(name)?;
        }
        Some(n)
    }

    /// First descendant (depth first) named `name`.
    pub fn find(&self, name: &str) -> Option<&Node> {
        let mut stack: Vec<&Node> = vec![self];
        let mut steps = 0usize;
        while let Some(n) = stack.pop() {
            steps += 1;
            if steps > limits::MAX_XML_NODES {
                return None;
            }
            if n.is(name) && !std::ptr::eq(n, self) {
                return Some(n);
            }
            let kids: Vec<&Node> = n.elems().collect();
            stack.extend(kids.into_iter().rev());
        }
        None
    }

    /// All descendants named `name`, in document order.
    pub fn find_all<'a>(&'a self, name: &str) -> Vec<&'a Node> {
        let mut out = Vec::new();
        let mut stack: Vec<&Node> = vec![self];
        while let Some(n) = stack.pop() {
            if out.len() > limits::MAX_XML_NODES {
                break;
            }
            if n.is(name) && !std::ptr::eq(n, self) {
                out.push(n);
            }
            let kids: Vec<&Node> = n.elems().collect();
            stack.extend(kids.into_iter().rev());
        }
        out
    }

    /// Concatenated text of all descendants.
    pub fn text(&self) -> String {
        let mut s = String::new();
        let mut stack: Vec<&Child> = self.children.iter().rev().collect();
        while let Some(c) = stack.pop() {
            match c {
                Child::Text(t) => s.push_str(t),
                Child::Elem(n) => stack.extend(n.children.iter().rev()),
            }
        }
        s
    }
}

fn predefined(name: &str) -> Option<char> {
    Some(match name {
        "amp" => '&',
        "lt" => '<',
        "gt" => '>',
        "quot" => '"',
        "apos" => '\'',
        _ => return None,
    })
}

fn push_text(stack: &mut [Node], t: &str) {
    if let Some(top) = stack.last_mut() {
        if let Some(Child::Text(prev)) = top.children.last_mut() {
            prev.push_str(t);
        } else {
            top.children.push(Child::Text(t.to_string()));
        }
    }
}

fn start_node(e: &quick_xml::events::BytesStart) -> Node {
    let qname = e.name().as_ref().to_string();
    let attrs = e
        .attributes()
        .with_checks(false)
        .flatten()
        .map(|a| {
            let k = a.key.as_ref().to_string();
            let v = a
                .normalized_value(quick_xml::XmlVersion::Implicit1_0)
                .map(|c| c.into_owned())
                .unwrap_or_else(|_| a.value.as_ref().to_string());
            (k, v)
        })
        .collect();
    Node {
        qname,
        attrs,
        children: Vec::new(),
    }
}

/// Parse `text` into a tree. The returned node is a synthetic root whose children are the
/// document's top-level elements.
pub fn parse(text: &str) -> Result<Node> {
    let mut reader = Reader::from_str(text);
    reader.config_mut().trim_text(false);
    reader.config_mut().check_end_names = false;
    let mut stack: Vec<Node> = vec![Node::default()];
    let mut nodes = 0usize;
    loop {
        let ev = reader
            .read_event()
            .map_err(|e| CreateError::malformed(format!("XML: {e}")))?;
        match ev {
            Event::Start(e) => {
                nodes += 1;
                limits::check(nodes, limits::MAX_XML_NODES, "XML nodes")?;
                limits::check(stack.len(), limits::MAX_XML_DEPTH, "XML depth")?;
                stack.push(start_node(&e));
            }
            Event::Empty(e) => {
                nodes += 1;
                limits::check(nodes, limits::MAX_XML_NODES, "XML nodes")?;
                let n = start_node(&e);
                if let Some(top) = stack.last_mut() {
                    top.children.push(Child::Elem(n));
                }
            }
            Event::End(_) => {
                if stack.len() > 1 {
                    if let Some(n) = stack.pop() {
                        if let Some(top) = stack.last_mut() {
                            top.children.push(Child::Elem(n));
                        }
                    }
                }
            }
            Event::Text(t) => push_text(&mut stack, &t.xml10_content()),
            Event::CData(c) => {
                let s = c.into_inner().into_owned();
                push_text(&mut stack, &s);
            }
            Event::GeneralRef(r) => {
                let resolved = match r.resolve_char_ref() {
                    Ok(Some(c)) => Some(c),
                    Ok(None) => predefined(r.as_ref()),
                    Err(_) => None,
                };
                // Unknown (DTD-declared) entities are dropped, never expanded.
                if let Some(c) = resolved {
                    let mut b = [0u8; 4];
                    push_text(&mut stack, c.encode_utf8(&mut b));
                }
            }
            Event::Eof => break,
            Event::Comment(_) | Event::Decl(_) | Event::PI(_) | Event::DocType(_) => {}
        }
    }
    // Close unclosed elements (lenient).
    while stack.len() > 1 {
        if let Some(n) = stack.pop() {
            if let Some(top) = stack.last_mut() {
                top.children.push(Child::Elem(n));
            }
        }
    }
    stack
        .pop()
        .ok_or_else(|| CreateError::malformed("XML: empty document"))
}

/// Parse and return the document element.
pub fn parse_root(text: &str) -> Result<Node> {
    let root = parse(text)?;
    let first = root.children.into_iter().find_map(|c| match c {
        Child::Elem(n) => Some(n),
        Child::Text(_) => None,
    });
    first.ok_or_else(|| CreateError::malformed("XML has no root element"))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    #[test]
    fn tree_and_names() {
        let r = parse_root(r#"<?xml version="1.0"?><w:doc xmlns:w="x" r:id="rId1" id="7"><w:p a="1&amp;2"><w:t>سلام &amp; &#x41;</w:t></w:p><w:p/></w:doc>"#).unwrap();
        assert!(r.is("doc"));
        assert_eq!(r.attr_prefixed("r:id"), Some("rId1"));
        assert_eq!(r.attr("id"), Some("rId1"));
        assert_eq!(r.children_named("p").count(), 2);
        assert_eq!(r.child("p").unwrap().attr("a"), Some("1&2"));
        assert_eq!(r.find("t").unwrap().text(), "سلام & A");
        assert_eq!(r.find_all("p").len(), 2);
    }

    #[test]
    fn entities_are_never_expanded() {
        let lol = r#"<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;">]><r>&lol2;&lt;</r>"#;
        let r = parse_root(lol).unwrap();
        assert_eq!(r.text(), "<");
    }

    #[test]
    fn depth_is_bounded() {
        let deep = "<a>".repeat(10_000);
        assert_eq!(parse(&deep).unwrap_err().code(), "limit_exceeded");
        assert!(parse("<a><b></a>").is_ok());
    }
}
