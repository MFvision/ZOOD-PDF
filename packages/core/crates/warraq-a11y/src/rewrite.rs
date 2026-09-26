//! Marked-content rewrites of page content, as splices over the byte-faithful operations (every
//! other byte stays identical):
//!
//! * [`strip_mcids`] — "retag all": sequences that carry an MCID lose it (the `BDC` and its `EMC`
//!   go; a property list with other entries such as `/ActualText` or `/Lang` becomes a `/Span`).
//! * [`to_artifact`] — "decorative": the sequences of chosen MCIDs become `/Artifact` sequences.
//! * [`Insert`] — ordered insertions of new `BDC`/`EMC` at operation boundaries.

use std::collections::HashSet;

use warraq_edit::content::{fmt_name, fmt_num, Content, Splice, Value};

use crate::marked::Marks;

/// Serialise an operand value.
pub fn fmt_value(v: &Value) -> String {
    match v {
        Value::Num(n) => fmt_num(*n),
        Value::Name(n) => fmt_name(n),
        Value::Str(s) => {
            let mut o = String::from("<");
            for b in s {
                o.push_str(&format!("{b:02X}"));
            }
            o.push('>');
            o
        }
        Value::Array(a) => {
            let items: Vec<String> = a.iter().map(fmt_value).collect();
            format!("[{}]", items.join(" "))
        }
        Value::Dict(d) => {
            let items: Vec<String> = d
                .iter()
                .map(|(k, v)| format!("{} {}", fmt_name(k), fmt_value(v)))
                .collect();
            format!("<<{}>>", items.join(" "))
        }
        Value::Bool(b) => if *b { "true" } else { "false" }.to_string(),
        Value::Null | Value::Junk => "null".to_string(),
    }
}

/// Splices removing the MCIDs of every marked-content sequence that carries one.
pub fn strip_mcids(content: &Content, marks: &Marks) -> Vec<Splice> {
    let mut out = Vec::new();
    for (i, op) in content.ops.iter().enumerate() {
        let Some(m) = marks.get(i) else { continue };
        if m.opens_mcid.is_none() || !op.is(b"BDC") {
            continue;
        }
        let rest: Vec<(Vec<u8>, Value)> = match op.operands.get(1).map(|o| &o.value) {
            Some(Value::Dict(d)) => d
                .iter()
                .filter(|(k, _)| k.as_slice() != b"MCID")
                .cloned()
                .collect(),
            _ => Vec::new(),
        };
        let keep = rest
            .iter()
            .any(|(k, _)| matches!(k.as_slice(), b"ActualText" | b"Lang" | b"Alt" | b"E"));
        if keep {
            out.push(Splice {
                range: op.span.clone(),
                with: format!("/Span {} BDC", fmt_value(&Value::Dict(rest))).into_bytes(),
            });
        } else if let Some(emc) = m.mc_match.and_then(|e| content.ops.get(e)) {
            out.push(Splice {
                range: op.span.clone(),
                with: Vec::new(),
            });
            out.push(Splice {
                range: emc.span.clone(),
                with: Vec::new(),
            });
        }
    }
    out
}

/// Splices turning the sequences of `mcids` into `/Artifact` sequences.
pub fn to_artifact(content: &Content, marks: &Marks, mcids: &HashSet<i64>) -> Vec<Splice> {
    let mut out = Vec::new();
    for (i, op) in content.ops.iter().enumerate() {
        let Some(m) = marks.get(i) else { continue };
        if !op.is(b"BDC") || m.mc_match.is_none() {
            continue;
        }
        if m.opens_mcid.is_some_and(|x| mcids.contains(&x)) {
            out.push(Splice {
                range: op.span.clone(),
                with: b"/Artifact BMC".to_vec(),
            });
        }
    }
    out
}

/// Ordered insertions: at one position, closers (`EMC`) come before openers.
#[derive(Default)]
pub struct Insert {
    items: Vec<(usize, u8, u32, Vec<u8>)>,
    seq: u32,
}

impl Insert {
    /// Open a sequence before operation span start `at`.
    pub fn open(&mut self, at: usize, text: String) {
        self.seq += 1;
        let mut b = text.into_bytes();
        b.push(b'\n');
        self.items.push((at, 1, self.seq, b));
    }

    /// Close a sequence after operation span end `at`.
    pub fn close(&mut self, at: usize) {
        self.seq += 1;
        self.items.push((at, 0, self.seq, b"\nEMC".to_vec()));
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    /// The splices (zero-length ranges) in writing order.
    pub fn splices(mut self) -> Vec<Splice> {
        self.items
            .sort_by_key(|(at, kind, seq, _)| (*at, *kind, *seq));
        self.items
            .into_iter()
            .map(|(at, _, _, with)| Splice {
                range: at..at,
                with,
            })
            .collect()
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing, clippy::panic)]
mod tests {
    use super::*;
    use crate::marked::{analyze, Props};
    use warraq_edit::content::{parse, rewrite};

    fn none(_: &[u8]) -> Option<Props> {
        None
    }

    #[test]
    fn strip_keeps_actual_text_and_other_bytes() {
        let data = b"q /P <</MCID 0>> BDC BT (a) Tj ET EMC /Span <</MCID 1 /ActualText (x)>> BDC (b) Tj EMC Q";
        let c = parse(data).unwrap();
        let m = analyze(&c, &none);
        let out = rewrite(data, &strip_mcids(&c, &m)).unwrap();
        let s = String::from_utf8(out).unwrap();
        assert!(!s.contains("MCID"), "{s}");
        assert!(
            s.contains("/Span <</ActualText <78>>> BDC (b) Tj EMC"),
            "{s}"
        );
        assert!(s.contains("BT (a) Tj ET"), "{s}");
        let c2 = parse(s.as_bytes()).unwrap();
        assert!(!analyze(&c2, &none).unbalanced);
    }

    #[test]
    fn artifacts_and_insert_order() {
        let data = b"/Figure <</MCID 4>> BDC /Im0 Do EMC";
        let c = parse(data).unwrap();
        let m = analyze(&c, &none);
        let set: HashSet<i64> = [4].into_iter().collect();
        let out = rewrite(data, &to_artifact(&c, &m, &set)).unwrap();
        assert_eq!(out, b"/Artifact BMC /Im0 Do EMC".to_vec());

        let data = b"(a)Tj(b)Tj";
        let mut ins = Insert::default();
        ins.open(5, "/P <</MCID 1>> BDC".into());
        ins.close(5);
        ins.open(0, "/P <</MCID 0>> BDC".into());
        ins.close(10);
        let out = rewrite(data, &ins.splices()).unwrap();
        assert_eq!(
            String::from_utf8(out).unwrap(),
            "/P <</MCID 0>> BDC\n(a)Tj\nEMC/P <</MCID 1>> BDC\n(b)Tj\nEMC"
        );
    }
}
