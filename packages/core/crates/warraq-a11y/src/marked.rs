//! Marked content of a page's operations: which MCID and artifact state every operation is drawn
//! in, and the matching `BMC/BDC…EMC`, `BT…ET` and `q…Q` pairs (so new marked-content sequences can
//! be placed where they nest properly).
//!
//! Hostile input: stacks are bounded; unmatched openers/closers are recorded as `None` matches and
//! make any range containing them unusable for new sequences.

use lopdf::{Dictionary, Object};
use warraq_edit::content::{Content, Op, Value};
use warraq_pdf::Pdf;

/// Maximum nesting tracked per kind (deeper operations stay unmatched).
pub const MAX_NEST: usize = 1024;

/// A marked-content property list (inline dictionary or named `/Properties` resource).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Props {
    pub mcid: Option<i64>,
    pub actual_text: bool,
    pub lang: Option<String>,
}

/// Marked-content state of one operation.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct OpMark {
    /// Innermost MCID in effect (for an opener: the state before it).
    pub mcid: Option<i64>,
    /// Inside `/Artifact` marked content.
    pub artifact: bool,
    /// Inside a sequence with `/ActualText`.
    pub actual_text: bool,
    /// For `BMC`/`BDC`: the matching `EMC`; for `EMC`: its opener.
    pub mc_match: Option<usize>,
    /// For `BT`: its `ET`; for `ET`: its `BT`.
    pub bt_match: Option<usize>,
    /// For `q`: its `Q`; for `Q`: its `q`.
    pub q_match: Option<usize>,
    /// For a `BDC` that carries an MCID: that MCID.
    pub opens_mcid: Option<i64>,
    /// For a `BMC`/`BDC` whose tag is `/Artifact`.
    pub opens_artifact: bool,
    /// Inside `BT…ET`.
    pub in_bt: bool,
}

/// Marks for every operation of a content stream.
#[derive(Debug, Clone, Default)]
pub struct Marks {
    pub ops: Vec<OpMark>,
    /// Some opener or closer had no partner.
    pub unbalanced: bool,
}

impl Marks {
    pub fn get(&self, i: usize) -> Option<&OpMark> {
        self.ops.get(i)
    }
}

/// Whether the operation is a marked-content operator.
pub fn is_mc(op: &Op) -> bool {
    matches!(op.operator.as_slice(), b"BMC" | b"BDC" | b"EMC" | b"MP" | b"DP")
}

/// Path construction operators.
pub fn is_path_construct(op: &Op) -> bool {
    matches!(
        op.operator.as_slice(),
        b"m" | b"l" | b"c" | b"v" | b"y" | b"h" | b"re"
    )
}

/// Path painting operators that paint (not `n`).
pub fn is_path_paint(op: &Op) -> bool {
    matches!(
        op.operator.as_slice(),
        b"S" | b"s" | b"f" | b"F" | b"f*" | b"B" | b"B*" | b"b" | b"b*"
    )
}

/// Text-showing operators.
pub fn is_show(op: &Op) -> bool {
    matches!(op.operator.as_slice(), b"Tj" | b"TJ" | b"'" | b"\"")
}

/// Property list of a `BDC` (inline dictionary or `/Properties` resource name).
pub fn props_of(op: &Op, named: &dyn Fn(&[u8]) -> Option<Props>) -> Props {
    let Some(arg) = op.operands.get(1).map(|o| &o.value) else {
        return Props::default();
    };
    match arg {
        Value::Dict(_) => {
            let mcid = arg.get(b"MCID").and_then(Value::num).and_then(|n| {
                if n.is_finite() && n >= 0.0 && n == n.trunc() && n < 1e9 {
                    Some(n as i64)
                } else {
                    None
                }
            });
            let lang = match arg.get(b"Lang") {
                Some(Value::Str(s)) => Some(warraq_pdf::metadata::decode_text(s)),
                _ => None,
            };
            Props {
                mcid,
                actual_text: arg.get(b"ActualText").is_some(),
                lang,
            }
        }
        Value::Name(n) => named(n).unwrap_or_default(),
        _ => Props::default(),
    }
}

/// Lookup of named property lists in a resource dictionary (`/Properties`).
pub fn named_props<'a>(pdf: &'a Pdf, res: &'a Dictionary) -> impl Fn(&[u8]) -> Option<Props> + 'a {
    move |name: &[u8]| {
        let cat = pdf.resolve(res.get(b"Properties").ok()?)?;
        let Object::Dictionary(cd) = cat else {
            return None;
        };
        let Object::Dictionary(d) = pdf.resolve(cd.get(name).ok()?)? else {
            return None;
        };
        let mcid = match d.get(b"MCID").ok().and_then(|o| pdf.resolve(o)) {
            Some(Object::Integer(i)) if *i >= 0 => Some(*i),
            _ => None,
        };
        let lang = match d.get(b"Lang").ok().and_then(|o| pdf.resolve(o)) {
            Some(Object::String(s, _)) => Some(warraq_pdf::metadata::decode_text(s)),
            _ => None,
        };
        Some(Props {
            mcid,
            actual_text: d.has(b"ActualText"),
            lang,
        })
    }
}

struct Open {
    at: usize,
    mcid: Option<i64>,
    artifact: bool,
    actual: bool,
}

/// Analyse the operations of `content`.
pub fn analyze(content: &Content, named: &dyn Fn(&[u8]) -> Option<Props>) -> Marks {
    let n = content.ops.len();
    let mut ops = vec![OpMark::default(); n];
    let mut mc: Vec<Open> = Vec::new();
    let mut bt: Vec<usize> = Vec::new();
    let mut q: Vec<usize> = Vec::new();
    let mut unbalanced = false;
    let mut overflow_mc = 0usize;
    let mut overflow_q = 0usize;
    for (i, op) in content.ops.iter().enumerate() {
        let (mcid, artifact, actual) = {
            let mcid = mc.iter().rev().find_map(|o| o.mcid);
            (
                mcid,
                mc.iter().any(|o| o.artifact),
                mc.iter().any(|o| o.actual),
            )
        };
        let mut m = OpMark {
            mcid,
            artifact,
            actual_text: actual,
            in_bt: !bt.is_empty(),
            ..OpMark::default()
        };
        match op.operator.as_slice() {
            b"BMC" | b"BDC" => {
                let tag = op.operands.first().and_then(|o| o.value.name()).unwrap_or(b"");
                let p = if op.is(b"BDC") {
                    props_of(op, named)
                } else {
                    Props::default()
                };
                m.opens_mcid = p.mcid;
                m.opens_artifact = tag == b"Artifact";
                if mc.len() < MAX_NEST {
                    mc.push(Open {
                        at: i,
                        mcid: p.mcid,
                        artifact: tag == b"Artifact",
                        actual: p.actual_text,
                    });
                } else {
                    overflow_mc += 1;
                    unbalanced = true;
                }
            }
            b"EMC" => {
                if overflow_mc > 0 {
                    overflow_mc -= 1;
                } else if let Some(o) = mc.pop() {
                    m.mc_match = Some(o.at);
                    if let Some(om) = ops.get_mut(o.at) {
                        om.mc_match = Some(i);
                    }
                } else {
                    unbalanced = true;
                }
            }
            b"BT" => {
                if bt.is_empty() {
                    bt.push(i);
                } else {
                    // Nested BT is invalid: leave it unmatched.
                    unbalanced = true;
                }
            }
            b"ET" => {
                if let Some(b) = bt.pop() {
                    m.bt_match = Some(b);
                    if let Some(om) = ops.get_mut(b) {
                        om.bt_match = Some(i);
                    }
                } else {
                    unbalanced = true;
                }
            }
            b"q" => {
                if q.len() < MAX_NEST {
                    q.push(i);
                } else {
                    overflow_q += 1;
                    unbalanced = true;
                }
            }
            b"Q" => {
                if overflow_q > 0 {
                    overflow_q -= 1;
                } else if let Some(b) = q.pop() {
                    m.q_match = Some(b);
                    if let Some(om) = ops.get_mut(b) {
                        om.q_match = Some(i);
                    }
                } else {
                    unbalanced = true;
                }
            }
            _ => {}
        }
        if let Some(slot) = ops.get_mut(i) {
            *slot = m;
        }
    }
    if !mc.is_empty() || !bt.is_empty() || !q.is_empty() {
        unbalanced = true;
    }
    Marks { ops, unbalanced }
}

/// Whether operation `i` opens or closes a pair (and so needs its partner inside any range).
fn pairs(content: &Content, marks: &Marks, i: usize) -> Vec<Option<usize>> {
    let Some(op) = content.ops.get(i) else {
        return Vec::new();
    };
    let Some(m) = marks.get(i) else {
        return Vec::new();
    };
    match op.operator.as_slice() {
        b"BMC" | b"BDC" | b"EMC" => vec![m.mc_match],
        b"BT" | b"ET" => vec![m.bt_match],
        b"q" | b"Q" => vec![m.q_match],
        _ => Vec::new(),
    }
}

/// Smallest range `[s', e'] ⊇ [s, e]` in which every `BMC/BDC/EMC`, `BT/ET` and `q/Q` has its
/// partner, never reaching `floor` (an earlier sequence ends before it). `None` when an unmatched
/// operator is involved or the range would reach `floor`.
pub fn balance(
    content: &Content,
    marks: &Marks,
    s: usize,
    e: usize,
    floor: Option<usize>,
) -> Option<(usize, usize)> {
    if s > e || e >= content.ops.len() {
        return None;
    }
    let (mut lo, mut hi) = (s, e);
    // Scanned window [scan_lo, scan_hi]; grows as the range grows (each op scanned once).
    let (mut scan_lo, mut scan_hi) = (s, s);
    let mut first = true;
    loop {
        let mut todo: Vec<usize> = Vec::new();
        if first {
            todo.extend(s..=e);
            scan_hi = e;
            first = false;
        } else {
            if lo < scan_lo {
                todo.extend(lo..scan_lo);
                scan_lo = lo;
            }
            if hi > scan_hi {
                todo.extend(scan_hi + 1..=hi);
                scan_hi = hi;
            }
        }
        if todo.is_empty() {
            break;
        }
        for i in todo {
            for partner in pairs(content, marks, i) {
                let p = partner?;
                if p < lo {
                    lo = p;
                }
                if p > hi {
                    hi = p;
                }
            }
        }
        if let Some(f) = floor {
            if lo <= f {
                return None;
            }
        }
    }
    Some((lo, hi))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing, clippy::panic)]
mod tests {
    use super::*;
    use warraq_edit::content::parse;

    fn none(_: &[u8]) -> Option<Props> {
        None
    }

    #[test]
    fn mcids_and_matches() {
        let data = b"/P <</MCID 3>> BDC BT (a) Tj ET EMC /Artifact BMC 0 0 m 1 1 l S EMC q Q";
        let c = parse(data).unwrap();
        let m = analyze(&c, &none);
        assert!(!m.unbalanced);
        let tj = c.ops.iter().position(|o| o.is(b"Tj")).unwrap();
        assert_eq!(m.ops[tj].mcid, Some(3));
        assert!(m.ops[tj].in_bt);
        let s = c.ops.iter().position(|o| o.is(b"S")).unwrap();
        assert!(m.ops[s].artifact);
        assert_eq!(m.ops[s].mcid, None);
        assert_eq!(m.ops[0].opens_mcid, Some(3));
        assert_eq!(m.ops[0].mc_match, Some(4));
    }

    #[test]
    fn balance_extends_to_wrappers() {
        // Two shows inside different /Span wrappers inside one BT.
        let data = b"BT /Span <</ActualText (x)>> BDC (a) Tj EMC /Span <</ActualText (y)>> BDC (b) Tj EMC ET";
        let c = parse(data).unwrap();
        let m = analyze(&c, &none);
        let shows: Vec<usize> = c
            .ops
            .iter()
            .enumerate()
            .filter(|(_, o)| o.is(b"Tj"))
            .map(|(i, _)| i)
            .collect();
        let (a, b) = (shows[0], shows[1]);
        let (lo, hi) = balance(&c, &m, a, b, None).unwrap();
        assert_eq!((lo, hi), (1, 6));
        // A single operator is balanced by itself.
        assert_eq!(balance(&c, &m, a, a, None), Some((a, a)));
        // Across BT/ET: the whole text object.
        let data = b"BT (a) Tj ET BT (b) Tj ET";
        let c = parse(data).unwrap();
        let m = analyze(&c, &none);
        assert_eq!(balance(&c, &m, 1, 4, None), Some((0, 5)));
        assert_eq!(balance(&c, &m, 1, 4, Some(0)), None);
    }

    #[test]
    fn unmatched_is_refused() {
        let data = b"EMC (a) Tj BDC";
        let c = parse(data).unwrap();
        let m = analyze(&c, &none);
        assert!(m.unbalanced);
        assert_eq!(balance(&c, &m, 0, 1, None), None);
        assert_eq!(balance(&c, &m, 1, 1, None), Some((1, 1)));
    }
}
