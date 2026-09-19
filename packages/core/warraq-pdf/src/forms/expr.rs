//! The calculation a person types in Prepare form: arithmetic over fields,
//! such as `الكمية * "سعر الوحدة"` or `(a + b) / 2`.
//!
//! Field names are written bare when they are one word (Arabic or Latin
//! letters, digits, `_` and `.`), and in quotes — "…" or «…» — when they hold
//! spaces or anything else. Numbers may be in Western or Arabic-Indic digits.
//! `+ - * /` (and `× ÷ −`), parentheses and a leading minus are the whole
//! language: there are no functions and no variables.
//!
//! What is typed is parsed here, checked against the form's fields, and
//! written as the JavaScript Acrobat itself writes for its "simplified field
//! notation" — `event.value = AFMakeNumber(getField("a").value) * 2` after a
//! `/** BVCALC a*2 EVCALC **/` comment, so Acrobat shows it as typed — which
//! `script` then reads back.
use super::format::latin_digits;
use super::script::{js_string, Expr};

const MAX_EXPRESSION: usize = 4096;
const MAX_DEPTH: usize = 32;
const MAX_NODES: usize = 512;

/// Why an expression does not parse, and where (in characters).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExprError {
    /// `syntax`, `unknownField`, `empty`, `tooLong`.
    pub kind: &'static str,
    pub start: usize,
    pub end: usize,
    /// The field name, for `unknownField`.
    pub name: Option<String>,
}

fn error(kind: &'static str, start: usize, end: usize) -> ExprError {
    ExprError {
        kind,
        start,
        end,
        name: None,
    }
}

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Num(f64),
    Name(String),
    Op(char),
}

fn lex(text: &str) -> Result<Vec<(Tok, usize, usize)>, ExprError> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let start = i;
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        match c {
            '+' | '-' | '*' | '/' | '(' | ')' | '×' | '÷' | '−' | '（' | '）' => {
                let op = match c {
                    '×' => '*',
                    '÷' => '/',
                    '−' => '-',
                    '（' => '(',
                    '）' => ')',
                    c => c,
                };
                out.push((Tok::Op(op), start, start + 1));
                i += 1;
            }
            '"' | '«' | '“' => {
                let close = match c {
                    '«' => '»',
                    '“' => '”',
                    _ => '"',
                };
                i += 1;
                let from = i;
                while i < chars.len() && chars[i] != close {
                    i += 1;
                }
                if i >= chars.len() {
                    return Err(error("syntax", start, chars.len()));
                }
                let name: String = chars[from..i].iter().collect();
                i += 1;
                out.push((Tok::Name(name.trim().to_string()), start, i));
            }
            c if c.is_ascii_digit()
                || ('\u{0660}'..='\u{0669}').contains(&c)
                || ('\u{06F0}'..='\u{06F9}').contains(&c) =>
            {
                while i < chars.len()
                    && (chars[i].is_ascii_digit()
                        || ('\u{0660}'..='\u{0669}').contains(&chars[i])
                        || ('\u{06F0}'..='\u{06F9}').contains(&chars[i])
                        || chars[i] == '.'
                        || chars[i] == '٫')
                {
                    i += 1;
                }
                let literal = latin_digits(&chars[start..i].iter().collect::<String>());
                match literal.parse::<f64>() {
                    Ok(n) if n.is_finite() => out.push((Tok::Num(n), start, i)),
                    _ => return Err(error("syntax", start, i)),
                }
            }
            c if c.is_alphabetic() || c == '_' => {
                while i < chars.len()
                    && (chars[i].is_alphanumeric()
                        || chars[i] == '_'
                        || chars[i] == '.'
                        || is_mark(chars[i]))
                {
                    i += 1;
                }
                let name: String = chars[start..i].iter().collect();
                out.push((Tok::Name(name.trim_end_matches('.').to_string()), start, i));
            }
            _ => return Err(error("syntax", start, start + 1)),
        }
        if out.len() > MAX_NODES {
            return Err(error("tooLong", 0, chars.len()));
        }
    }
    Ok(out)
}

/// Arabic marks (tashkeel, the tatweel) inside a bare name.
fn is_mark(c: char) -> bool {
    matches!(c as u32, 0x0610..=0x061A | 0x064B..=0x065F | 0x0670 | 0x06D6..=0x06ED | 0x0640)
}

struct Parser<'a> {
    tokens: &'a [(Tok, usize, usize)],
    at: usize,
    depth: usize,
    end: usize,
}

impl Parser<'_> {
    fn peek_op(&self, op: char) -> bool {
        matches!(self.tokens.get(self.at), Some((Tok::Op(o), _, _)) if *o == op)
    }

    fn here(&self) -> (usize, usize) {
        self.tokens
            .get(self.at)
            .map(|(_, s, e)| (*s, *e))
            .unwrap_or((self.end, self.end))
    }

    fn expr(&mut self) -> Result<Expr, ExprError> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            let (s, e) = self.here();
            return Err(error("tooLong", s, e));
        }
        let mut left = self.term()?;
        loop {
            if self.peek_op('+') {
                self.at += 1;
                left = Expr::Add(Box::new(left), Box::new(self.term()?));
            } else if self.peek_op('-') {
                self.at += 1;
                left = Expr::Sub(Box::new(left), Box::new(self.term()?));
            } else {
                break;
            }
        }
        self.depth -= 1;
        Ok(left)
    }

    fn term(&mut self) -> Result<Expr, ExprError> {
        let mut left = self.unary()?;
        loop {
            if self.peek_op('*') {
                self.at += 1;
                left = Expr::Mul(Box::new(left), Box::new(self.unary()?));
            } else if self.peek_op('/') {
                self.at += 1;
                left = Expr::Div(Box::new(left), Box::new(self.unary()?));
            } else {
                break;
            }
        }
        Ok(left)
    }

    fn unary(&mut self) -> Result<Expr, ExprError> {
        if self.peek_op('-') {
            self.at += 1;
            self.depth += 1;
            if self.depth > MAX_DEPTH {
                let (s, e) = self.here();
                return Err(error("tooLong", s, e));
            }
            let inner = self.unary()?;
            self.depth -= 1;
            return Ok(Expr::Neg(Box::new(inner)));
        }
        if self.peek_op('+') {
            self.at += 1;
        }
        let (start, end) = self.here();
        match self.tokens.get(self.at).cloned() {
            Some((Tok::Num(n), _, _)) => {
                self.at += 1;
                Ok(Expr::Number(n))
            }
            Some((Tok::Name(name), _, _)) => {
                self.at += 1;
                Ok(Expr::Field(name))
            }
            Some((Tok::Op('('), _, _)) => {
                self.at += 1;
                let inner = self.expr()?;
                if !self.peek_op(')') {
                    let (s, e) = self.here();
                    return Err(error("syntax", s, e));
                }
                self.at += 1;
                Ok(inner)
            }
            _ => Err(error("syntax", start, end)),
        }
    }
}

/// Parses what was typed, checking every name against `fields` (the form's
/// field names). A name that differs only in letter case or in its Arabic
/// letter variants is taken as the field it matches.
pub fn parse_expression(text: &str, fields: &[String]) -> Result<Expr, ExprError> {
    if text.chars().count() > MAX_EXPRESSION {
        return Err(error("tooLong", 0, text.chars().count()));
    }
    let tokens = lex(text)?;
    if tokens.is_empty() {
        return Err(error("empty", 0, 0));
    }
    let mut parser = Parser {
        tokens: &tokens,
        at: 0,
        depth: 0,
        end: text.chars().count(),
    };
    let expr = parser.expr()?;
    if parser.at < tokens.len() {
        let (s, e) = parser.here();
        return Err(error("syntax", s, e));
    }
    // Every name must be a field; a near spelling becomes the field's own.
    let mut resolved = expr;
    let mut failure = None;
    resolve(&mut resolved, fields, &mut failure);
    if let Some(name) = failure {
        let (start, end) = tokens
            .iter()
            .find(|(t, _, _)| matches!(t, Tok::Name(n) if *n == name))
            .map(|(_, s, e)| (*s, *e))
            .unwrap_or((0, 0));
        return Err(ExprError {
            kind: "unknownField",
            start,
            end,
            name: Some(name),
        });
    }
    Ok(resolved)
}

fn loose(name: &str) -> String {
    warraq_text::normalize_for_search(name, &warraq_text::SearchNormalization::default())
        .0
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn resolve(expr: &mut Expr, fields: &[String], failure: &mut Option<String>) {
    match expr {
        Expr::Field(name) => {
            if fields.contains(name) {
                return;
            }
            let want = loose(name);
            match fields.iter().find(|f| loose(f) == want) {
                Some(found) => *name = found.clone(),
                None => {
                    if failure.is_none() {
                        *failure = Some(name.clone());
                    }
                }
            }
        }
        Expr::Number(_) => {}
        Expr::Neg(a) | Expr::Round(a) | Expr::Floor(a) | Expr::Ceil(a) | Expr::Abs(a) => {
            resolve(a, fields, failure)
        }
        Expr::Add(a, b) | Expr::Sub(a, b) | Expr::Mul(a, b) | Expr::Div(a, b) => {
            resolve(a, fields, failure);
            resolve(b, fields, failure);
        }
        Expr::Min(items) | Expr::Max(items) => {
            items.iter_mut().for_each(|e| resolve(e, fields, failure))
        }
    }
}

/// A number as JavaScript writes it.
fn js_number(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

/// The expression as JavaScript over field values.
pub fn to_js(expr: &Expr) -> String {
    fn go(e: &Expr, out: &mut String, parent: u8) {
        // Precedence: 1 additive, 2 multiplicative; atoms need no parentheses.
        match e {
            Expr::Number(n) => return out.push_str(&js_number(*n)),
            Expr::Field(name) => {
                return out.push_str(&format!(
                    "AFMakeNumber(getField({}).value)",
                    js_string(name)
                ))
            }
            _ => {}
        }
        let (prec, op, a, b) = match e {
            Expr::Add(a, b) => (1, " + ", a, b),
            Expr::Sub(a, b) => (1, " - ", a, b),
            Expr::Mul(a, b) => (2, " * ", a, b),
            Expr::Div(a, b) => (2, " / ", a, b),
            Expr::Neg(a) => {
                out.push('-');
                let wrap = !matches!(**a, Expr::Number(_) | Expr::Field(_));
                if wrap {
                    out.push('(');
                }
                go(a, out, 0);
                if wrap {
                    out.push(')');
                }
                return;
            }
            Expr::Round(a) | Expr::Floor(a) | Expr::Ceil(a) | Expr::Abs(a) => {
                let f = match e {
                    Expr::Round(_) => "round",
                    Expr::Floor(_) => "floor",
                    Expr::Ceil(_) => "ceil",
                    _ => "abs",
                };
                out.push_str(&format!("Math.{f}("));
                go(a, out, 0);
                out.push(')');
                return;
            }
            Expr::Min(items) | Expr::Max(items) => {
                out.push_str(if matches!(e, Expr::Min(_)) {
                    "Math.min("
                } else {
                    "Math.max("
                });
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push_str(", ");
                    }
                    go(item, out, 0);
                }
                out.push(')');
                return;
            }
            _ => unreachable!("atoms are handled above"),
        };
        let wrap = prec < parent;
        if wrap {
            out.push('(');
        }
        go(a, out, prec);
        out.push_str(op);
        // The right side of - and / binds tighter: a - (b - c).
        go(b, out, prec + 1);
        if wrap {
            out.push(')');
        }
    }
    let mut out = String::new();
    go(expr, &mut out, 0);
    out
}

/// A field name as Acrobat's simplified field notation writes it: anything
/// but a letter, a digit, `_` or `.` escaped with a backslash.
fn sfn_name(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        if !(c.is_alphanumeric() || c == '_' || c == '.') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// The expression in simplified field notation, for the BVCALC comment.
pub fn to_sfn(expr: &Expr) -> String {
    let js = to_js(expr);
    // Same shape as the JavaScript, with names in place of the lookups.
    let mut out = String::new();
    let mut rest = js.as_str();
    while let Some(at) = rest.find("AFMakeNumber(getField(") {
        out.push_str(&rest[..at]);
        let after = &rest[at + "AFMakeNumber(getField(".len()..];
        let Some(end) = after.find(").value)") else {
            break;
        };
        let literal = &after[..end];
        let name = super::script::parse(&format!("event.value = getField({literal}).value"))
            .ok()
            .and_then(|s| match s.actions.first() {
                Some(super::script::Action::Assign(Expr::Field(n))) => Some(n.clone()),
                _ => None,
            })
            .unwrap_or_default();
        out.push_str(&sfn_name(&name));
        rest = &after[end + ").value)".len()..];
    }
    out.push_str(rest);
    out.replace("*/", "* /")
}

/// The expression as a person types it here: names bare when they are one
/// word, in quotes otherwise.
pub fn to_typed(expr: &Expr) -> String {
    let js = to_js(expr);
    let mut out = String::new();
    let mut rest = js.as_str();
    while let Some(at) = rest.find("AFMakeNumber(getField(") {
        out.push_str(&rest[..at]);
        let after = &rest[at + "AFMakeNumber(getField(".len()..];
        let Some(end) = after.find(").value)") else {
            break;
        };
        let literal = &after[..end];
        let name = super::script::parse(&format!("event.value = getField({literal}).value"))
            .ok()
            .and_then(|s| match s.actions.first() {
                Some(super::script::Action::Assign(Expr::Field(n))) => Some(n.clone()),
                _ => None,
            })
            .unwrap_or_default();
        let bare = !name.is_empty()
            && name
                .chars()
                .next()
                .is_some_and(|c| c.is_alphabetic() || c == '_')
            && name
                .chars()
                .all(|c| c.is_alphanumeric() || c == '_' || c == '.' || is_mark(c));
        if bare {
            out.push_str(&name);
        } else {
            out.push('"');
            out.push_str(&name.replace('"', ""));
            out.push('"');
        }
        rest = &after[end + ").value)".len()..];
    }
    out.push_str(rest);
    out
}

/// The calculate script for an expression, as Acrobat writes one.
pub fn calculate_script(expr: &Expr) -> String {
    format!(
        "/** BVCALC {} EVCALC **/ event.value = {};",
        to_sfn(expr),
        to_js(expr)
    )
}

#[cfg(test)]
mod tests {
    use super::super::script::{parse, Action};
    use super::*;

    fn fields() -> Vec<String> {
        ["الكمية", "سعر الوحدة", "a", "b", "Total.Tax"]
            .map(String::from)
            .to_vec()
    }

    #[test]
    fn arabic_names_quoted_names_and_arabic_digits() {
        let e = parse_expression("الكمية × \"سعر الوحدة\" + ١٠٫٥", &fields()).unwrap();
        assert_eq!(
            e.fields(),
            vec!["الكمية".to_string(), "سعر الوحدة".to_string()]
        );
        let v = e.eval(&|n| if n == "الكمية" { 3.0 } else { 20.0 });
        assert_eq!(v, 70.5);
        let e = parse_expression("«سعر الوحدة» / 2", &fields()).unwrap();
        assert_eq!(e.eval(&|_| 9.0), 4.5);
        let e = parse_expression("Total.Tax - -a", &fields()).unwrap();
        assert_eq!(e.eval(&|n| if n == "a" { 1.0 } else { 2.0 }), 3.0);
    }

    #[test]
    fn a_near_spelling_is_the_fields_own() {
        let e = parse_expression("A + \"سعر  الوحده\"", &fields()).unwrap();
        assert_eq!(e.fields(), vec!["a".to_string(), "سعر الوحدة".to_string()]);
    }

    #[test]
    fn errors_say_what_and_where() {
        let err = parse_expression("a + c", &fields()).unwrap_err();
        assert_eq!(
            (err.kind, err.start, err.end, err.name.as_deref()),
            ("unknownField", 4, 5, Some("c"))
        );
        assert_eq!(
            parse_expression("a +", &fields()).unwrap_err().kind,
            "syntax"
        );
        assert_eq!(
            parse_expression("(a", &fields()).unwrap_err().kind,
            "syntax"
        );
        assert_eq!(
            parse_expression("a b", &fields()).unwrap_err().kind,
            "syntax"
        );
        assert_eq!(
            parse_expression("a ^ 2", &fields()).unwrap_err().kind,
            "syntax"
        );
        assert_eq!(parse_expression("  ", &fields()).unwrap_err().kind, "empty");
        assert_eq!(
            parse_expression("\"a", &fields()).unwrap_err().kind,
            "syntax"
        );
        let deep = format!("{}a{}", "(".repeat(200), ")".repeat(200));
        assert_eq!(
            parse_expression(&deep, &fields()).unwrap_err().kind,
            "tooLong"
        );
    }

    #[test]
    fn written_as_acrobat_writes_it_and_read_back_the_same() {
        for (typed, a, b, want) in [
            ("a * b", 3.0, 4.0, 12.0),
            ("a - (b - 1)", 10.0, 4.0, 7.0),
            ("(a + b) / 2", 3.0, 5.0, 4.0),
            ("a / b / 2", 12.0, 3.0, 2.0),
            ("-(a + b) * 2", 1.0, 2.0, -6.0),
            ("a - b - 1", 10.0, 4.0, 5.0),
        ] {
            let e = parse_expression(typed, &fields()).unwrap();
            let script = calculate_script(&e);
            let back = parse(&script).unwrap();
            let Action::Assign(read) = &back.actions[0] else {
                panic!("{script}")
            };
            let value = |n: &str| if n == "a" { a } else { b };
            assert_eq!(read.eval(&value), want, "{typed} → {script}");
            assert_eq!(e.eval(&value), want, "{typed}");
        }
        let e = parse_expression("الكمية * \"سعر الوحدة\"", &fields()).unwrap();
        let script = calculate_script(&e);
        assert!(
            script.starts_with("/** BVCALC الكمية * سعر\\ الوحدة EVCALC **/"),
            "{script}"
        );
        assert!(
            script.contains("AFMakeNumber(getField(\"سعر الوحدة\").value)"),
            "{script}"
        );
    }

    #[test]
    fn shown_again_as_typed() {
        let e = parse_expression("الكمية×«سعر الوحدة» - (a+1)", &fields()).unwrap();
        let typed = to_typed(&e);
        assert_eq!(typed, "الكمية * \"سعر الوحدة\" - (a + 1)");
        assert_eq!(parse_expression(&typed, &fields()).unwrap(), e);
    }

    #[test]
    fn a_comment_cannot_be_closed_from_a_name() {
        let names = vec!["x*/app.alert(1)//".to_string()];
        let e = parse_expression("\"x*/app.alert(1)//\" + 1", &names).unwrap();
        let script = calculate_script(&e);
        assert!(
            !script[..script.find("EVCALC").unwrap()].contains("*/"),
            "{script}"
        );
        assert!(parse(&script).is_ok(), "{script}");
    }
}
