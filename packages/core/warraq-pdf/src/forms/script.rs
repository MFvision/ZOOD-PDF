//! The one kind of form JavaScript Warraq runs: a small, closed subset.
//!
//! Acrobat keeps a form's formats, validations and calculations as JavaScript
//! in each field's `/AA` (ISO 32000-2, 12.6.3: `/K` keystroke, `/F` format,
//! `/V` validate, `/C` calculate), almost always as calls to its built-in
//! functions — `AFNumber_Format(2, 0, 0, 0, "", true)`,
//! `AFSimple_Calculate("SUM", new Array("a", "b"))` — or, from its
//! "simplified field notation", one assignment:
//! `event.value = AFMakeNumber(getField("a").value) * 2`. Warraq writes
//! exactly those, so every reader that runs form scripts runs its forms.
//!
//! This module parses that subset and nothing else. There is no `eval`, no
//! JavaScript engine, no loop, no variable and no call outside the list
//! below: a script that is anything more is not run at all — the interface
//! only says the form has scripts Warraq does not run. Parsing is bounded
//! (size, tokens, nesting), so a hostile file cannot make it loop, recurse
//! away or allocate without limit, and it never panics.
//!
//! Three functions of Warraq's own (`Warraq_Digits`, `Warraq_HijriFormat`,
//! `Warraq_HijriKeystroke`) do what Acrobat's cannot — Arabic-Indic digits and
//! Umm al-Qura dates. For other readers the script carries their definition in
//! plain JavaScript (`js/*.js`); Warraq recognises that definition by its
//! exact text and runs its own Rust instead. A definition that differs by one
//! token is not recognised, and the script is not run.
use super::format::{DateSpec, NumberSpec};

/// Longest script read; longer ones are not run.
pub const MAX_SCRIPT: usize = 64 * 1024;
const MAX_TOKENS: usize = 8192;
const MAX_DEPTH: usize = 48;
const MAX_FIELDS: usize = 512;
/// Nodes in one expression: a left-leaning chain of this many operators is
/// as deep as evaluating it recurses.
const MAX_NODES: usize = 1024;

/// A name in `AFSimple_Calculate`'s list, or in an expression.
pub type FieldName = String;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SimpleOp {
    Sum,
    Product,
    Average,
    Min,
    Max,
}

impl SimpleOp {
    pub fn code(self) -> &'static str {
        match self {
            SimpleOp::Sum => "SUM",
            SimpleOp::Product => "PRD",
            SimpleOp::Average => "AVG",
            SimpleOp::Min => "MIN",
            SimpleOp::Max => "MAX",
        }
    }

    pub fn from_code(code: &str) -> Option<Self> {
        Some(match code {
            "SUM" => SimpleOp::Sum,
            "PRD" => SimpleOp::Product,
            "AVG" => SimpleOp::Average,
            "MIN" => SimpleOp::Min,
            "MAX" => SimpleOp::Max,
            _ => return None,
        })
    }
}

/// An arithmetic expression over field values.
#[derive(Debug, Clone, PartialEq)]
pub enum Expr {
    Number(f64),
    Field(FieldName),
    Neg(Box<Expr>),
    Add(Box<Expr>, Box<Expr>),
    Sub(Box<Expr>, Box<Expr>),
    Mul(Box<Expr>, Box<Expr>),
    Div(Box<Expr>, Box<Expr>),
    Round(Box<Expr>),
    Floor(Box<Expr>),
    Ceil(Box<Expr>),
    Abs(Box<Expr>),
    Min(Vec<Expr>),
    Max(Vec<Expr>),
}

impl Expr {
    /// The fields it reads, in order of first use.
    pub fn fields(&self) -> Vec<FieldName> {
        let mut out = Vec::new();
        self.collect(&mut out);
        out
    }

    fn collect(&self, out: &mut Vec<FieldName>) {
        match self {
            Expr::Number(_) => {}
            Expr::Field(name) => {
                if !out.contains(name) {
                    out.push(name.clone());
                }
            }
            Expr::Neg(a) | Expr::Round(a) | Expr::Floor(a) | Expr::Ceil(a) | Expr::Abs(a) => {
                a.collect(out)
            }
            Expr::Add(a, b) | Expr::Sub(a, b) | Expr::Mul(a, b) | Expr::Div(a, b) => {
                a.collect(out);
                b.collect(out);
            }
            Expr::Min(items) | Expr::Max(items) => items.iter().for_each(|e| e.collect(out)),
        }
    }

    /// Its value, reading each field through `value`. Recursion is bounded
    /// by the parser's depth limit, which built the tree.
    pub fn eval(&self, value: &dyn Fn(&str) -> f64) -> f64 {
        match self {
            Expr::Number(n) => *n,
            Expr::Field(name) => value(name),
            Expr::Neg(a) => -a.eval(value),
            Expr::Add(a, b) => a.eval(value) + b.eval(value),
            Expr::Sub(a, b) => a.eval(value) - b.eval(value),
            Expr::Mul(a, b) => a.eval(value) * b.eval(value),
            Expr::Div(a, b) => a.eval(value) / b.eval(value),
            // JavaScript's Math.round: halves go up.
            Expr::Round(a) => (a.eval(value) + 0.5).floor(),
            Expr::Floor(a) => a.eval(value).floor(),
            Expr::Ceil(a) => a.eval(value).ceil(),
            Expr::Abs(a) => a.eval(value).abs(),
            Expr::Min(items) => items
                .iter()
                .map(|e| e.eval(value))
                .fold(f64::INFINITY, f64::min),
            Expr::Max(items) => items
                .iter()
                .map(|e| e.eval(value))
                .fold(f64::NEG_INFINITY, f64::max),
        }
    }
}

/// One statement of the subset.
#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    /// `AFNumber_Format` / `AFNumber_Keystroke`.
    Number(NumberSpec, Stage),
    /// `AFPercent_Format` / `AFPercent_Keystroke`: decimals and separator style.
    Percent(u8, u8, Stage),
    /// `AFDate_FormatEx`, `AFDate_Format` and their keystrokes.
    Date(DateSpec, Stage),
    /// `AFSpecial_Format` / `AFSpecial_Keystroke`: 0 ZIP, 1 ZIP+4, 2 phone, 3 SSN.
    Special(u8, Stage),
    /// `AFRange_Validate`: inclusive bounds.
    Range { min: Option<f64>, max: Option<f64> },
    /// `AFSimple_Calculate`.
    Simple(SimpleOp, Vec<FieldName>),
    /// `event.value = …`.
    Assign(Expr),
    /// `Warraq_Digits()`: the formatted value in Arabic-Indic digits.
    ArabicDigits,
    /// `Warraq_LatinDigits()`: Arabic-Indic digits typed become Western ones,
    /// so the value stays a number other readers can calculate with.
    LatinDigits,
    /// `Warraq_HijriFormat` / `Warraq_HijriKeystroke`: an Umm al-Qura date.
    Hijri(DateSpec, bool, Stage),
}

/// Whether a format call formats what is shown, or checks what is typed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    Format,
    Keystroke,
}

/// A parsed script: its statements, in order.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Script {
    pub actions: Vec<Action>,
}

/// Why a script is not run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unsupported(pub String);

impl std::fmt::Display for Unsupported {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

fn no<T>(why: impl Into<String>) -> Result<T, Unsupported> {
    Err(Unsupported(why.into()))
}

/// The definitions of Warraq's own functions, as written into files.
pub const DIGITS_JS: &str = include_str!("js/digits.js");
pub const HIJRI_FORMAT_JS: &str = include_str!("js/hijri-format.js");
pub const HIJRI_KEYSTROKE_JS: &str = include_str!("js/hijri-keystroke.js");
pub const LATIN_DIGITS_JS: &str = include_str!("js/latin-digits.js");

/// Whitespace collapsed to single spaces, comments kept: what "the same
/// text" means when recognising a definition.
fn squeeze(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Warraq's definitions, squeezed once: digits, Hijri format, Hijri
/// keystroke, Latin digits.
fn definitions() -> &'static [String; 4] {
    static KNOWN: std::sync::OnceLock<[String; 4]> = std::sync::OnceLock::new();
    KNOWN.get_or_init(|| {
        [
            squeeze(DIGITS_JS),
            squeeze(HIJRI_FORMAT_JS),
            squeeze(HIJRI_KEYSTROKE_JS),
            squeeze(LATIN_DIGITS_JS),
        ]
    })
}

/// Parses a script, or says why it is not one Warraq runs.
pub fn parse(source: &str) -> Result<Script, Unsupported> {
    if source.len() > MAX_SCRIPT {
        return no("too long");
    }
    // Warraq's own definitions are recognised whole, then taken out.
    let mut text = squeeze(source);
    let known = definitions();
    for definition in known {
        if let Some(at) = text.find(definition.as_str()) {
            text.replace_range(at..at + definition.len(), " ");
        }
    }
    let tokens = lex(&text)?;
    let mut parser = Parser {
        tokens,
        at: 0,
        depth: 0,
        nodes: 0,
    };
    let mut actions = Vec::new();
    while !parser.done() {
        if parser.eat_punct(';') {
            continue;
        }
        actions.push(parser.statement()?);
        if !parser.done() && !parser.eat_punct(';') {
            return no("statements must end with ';'");
        }
    }
    // A call to Warraq's own function needs its definition beside it, or
    // other readers would fail on it; the check keeps Warraq honest too.
    let squeezed = squeeze(source);
    for action in &actions {
        let needs = match action {
            Action::ArabicDigits => &known[0],
            Action::Hijri(_, _, Stage::Format) => &known[1],
            Action::Hijri(_, _, Stage::Keystroke) => &known[2],
            Action::LatinDigits => &known[3],
            _ => continue,
        };
        if !squeezed.contains(needs.as_str()) {
            return no("a Warraq function without its definition");
        }
    }
    Ok(Script { actions })
}

#[derive(Debug, Clone, PartialEq)]
enum Token {
    Ident(String),
    Number(f64),
    Str(String),
    Punct(char),
}

fn lex(text: &str) -> Result<Vec<Token>, Unsupported> {
    let chars: Vec<char> = text.chars().collect();
    let mut tokens = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if tokens.len() > MAX_TOKENS {
            return no("too many tokens");
        }
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
        } else if c == '/' && chars.get(i + 1) == Some(&'/') {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
        } else if c == '/' && chars.get(i + 1) == Some(&'*') {
            i += 2;
            loop {
                if i + 1 >= chars.len() {
                    return no("an unterminated comment");
                }
                if chars[i] == '*' && chars[i + 1] == '/' {
                    i += 2;
                    break;
                }
                i += 1;
            }
        } else if c.is_ascii_alphabetic() || c == '_' || c == '$' {
            let start = i;
            while i < chars.len()
                && (chars[i].is_ascii_alphanumeric() || chars[i] == '_' || chars[i] == '$')
            {
                i += 1;
            }
            tokens.push(Token::Ident(chars[start..i].iter().collect()));
        } else if c.is_ascii_digit()
            || (c == '.' && chars.get(i + 1).is_some_and(|d| d.is_ascii_digit()))
        {
            let start = i;
            while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == '.') {
                i += 1;
            }
            if i < chars.len() && (chars[i] == 'e' || chars[i] == 'E') {
                i += 1;
                if i < chars.len() && (chars[i] == '+' || chars[i] == '-') {
                    i += 1;
                }
                while i < chars.len() && chars[i].is_ascii_digit() {
                    i += 1;
                }
            }
            let literal: String = chars[start..i].iter().collect();
            match literal.parse::<f64>() {
                Ok(n) if n.is_finite() => tokens.push(Token::Number(n)),
                _ => return no("a number that is not one"),
            }
        } else if c == '"' || c == '\'' {
            let quote = c;
            i += 1;
            let mut s = String::new();
            loop {
                let Some(&ch) = chars.get(i) else {
                    return no("an unterminated string");
                };
                i += 1;
                if ch == quote {
                    break;
                }
                if ch != '\\' {
                    s.push(ch);
                    continue;
                }
                let Some(&esc) = chars.get(i) else {
                    return no("an unterminated string");
                };
                i += 1;
                match esc {
                    'n' => s.push('\n'),
                    't' => s.push('\t'),
                    'r' => s.push('\r'),
                    'u' => {
                        let hex: String = chars
                            .get(i..i + 4)
                            .map(|h| h.iter().collect())
                            .unwrap_or_default();
                        let code = u32::from_str_radix(&hex, 16).ok().and_then(char::from_u32);
                        match code {
                            Some(ch) if hex.len() == 4 => s.push(ch),
                            _ => return no("a bad \\u escape"),
                        }
                        i += 4;
                    }
                    other => s.push(other),
                }
            }
            tokens.push(Token::Str(s));
        } else if "(),;=+-*/[].".contains(c) {
            tokens.push(Token::Punct(c));
            i += 1;
        } else {
            return no(format!("the character {c:?}"));
        }
    }
    Ok(tokens)
}

struct Parser {
    tokens: Vec<Token>,
    at: usize,
    depth: usize,
    nodes: usize,
}

impl Parser {
    fn done(&self) -> bool {
        self.at >= self.tokens.len()
    }

    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.at)
    }

    fn next(&mut self) -> Option<Token> {
        let t = self.tokens.get(self.at).cloned();
        self.at += 1;
        t
    }

    fn eat_punct(&mut self, c: char) -> bool {
        if self.peek() == Some(&Token::Punct(c)) {
            self.at += 1;
            true
        } else {
            false
        }
    }

    fn expect_punct(&mut self, c: char) -> Result<(), Unsupported> {
        if self.eat_punct(c) {
            Ok(())
        } else {
            no(format!("expected '{c}'"))
        }
    }

    fn eat_ident(&mut self, name: &str) -> bool {
        if matches!(self.peek(), Some(Token::Ident(i)) if i == name) {
            self.at += 1;
            true
        } else {
            false
        }
    }

    fn expect_ident(&mut self, name: &str) -> Result<(), Unsupported> {
        if self.eat_ident(name) {
            Ok(())
        } else {
            no(format!("expected {name}"))
        }
    }

    fn statement(&mut self) -> Result<Action, Unsupported> {
        let Some(Token::Ident(name)) = self.next() else {
            return no("a statement that is not a call or an assignment");
        };
        if name == "event" {
            self.expect_punct('.')?;
            self.expect_ident("value")?;
            self.expect_punct('=')?;
            return Ok(Action::Assign(self.expr()?));
        }
        let args = self.arguments()?;
        call(&name, &args)
    }

    /// `( arg, … )`: numbers, strings, booleans and lists of strings.
    fn arguments(&mut self) -> Result<Vec<Arg>, Unsupported> {
        self.expect_punct('(')?;
        let mut args = Vec::new();
        if self.eat_punct(')') {
            return Ok(args);
        }
        loop {
            args.push(self.argument()?);
            if self.eat_punct(')') {
                return Ok(args);
            }
            self.expect_punct(',')?;
            if args.len() > 16 {
                return no("too many arguments");
            }
        }
    }

    fn argument(&mut self) -> Result<Arg, Unsupported> {
        match self.next() {
            Some(Token::Number(n)) => Ok(Arg::Number(n)),
            Some(Token::Punct('-')) => match self.next() {
                Some(Token::Number(n)) => Ok(Arg::Number(-n)),
                _ => no("'-' before something that is not a number"),
            },
            Some(Token::Str(s)) => Ok(Arg::Str(s)),
            Some(Token::Ident(i)) if i == "true" => Ok(Arg::Bool(true)),
            Some(Token::Ident(i)) if i == "false" => Ok(Arg::Bool(false)),
            Some(Token::Ident(i)) if i == "new" => {
                self.expect_ident("Array")?;
                self.expect_punct('(')?;
                self.strings(')')
            }
            Some(Token::Punct('[')) => self.strings(']'),
            _ => no("an argument that is not a number, a string or a list"),
        }
    }

    fn strings(&mut self, close: char) -> Result<Arg, Unsupported> {
        let mut list = Vec::new();
        if self.eat_punct(close) {
            return Ok(Arg::List(list));
        }
        loop {
            match self.next() {
                Some(Token::Str(s)) => list.push(s),
                _ => return no("a list of something other than field names"),
            }
            if list.len() > MAX_FIELDS {
                return no("too many fields");
            }
            if self.eat_punct(close) {
                return Ok(Arg::List(list));
            }
            self.expect_punct(',')?;
        }
    }

    fn deeper(&mut self) -> Result<(), Unsupported> {
        self.depth += 1;
        self.nodes += 1;
        if self.depth > MAX_DEPTH {
            return no("nested too deeply");
        }
        if self.nodes > MAX_NODES {
            return no("too long an expression");
        }
        Ok(())
    }

    fn expr(&mut self) -> Result<Expr, Unsupported> {
        self.deeper()?;
        let mut left = self.term()?;
        loop {
            if self.eat_punct('+') {
                left = Expr::Add(Box::new(left), Box::new(self.term()?));
            } else if self.eat_punct('-') {
                left = Expr::Sub(Box::new(left), Box::new(self.term()?));
            } else {
                break;
            }
        }
        self.depth -= 1;
        Ok(left)
    }

    fn term(&mut self) -> Result<Expr, Unsupported> {
        let mut left = self.unary()?;
        loop {
            if self.eat_punct('*') {
                left = Expr::Mul(Box::new(left), Box::new(self.unary()?));
            } else if self.eat_punct('/') {
                left = Expr::Div(Box::new(left), Box::new(self.unary()?));
            } else {
                break;
            }
        }
        Ok(left)
    }

    fn unary(&mut self) -> Result<Expr, Unsupported> {
        self.deeper()?;
        let e = if self.eat_punct('-') {
            Expr::Neg(Box::new(self.unary()?))
        } else if self.eat_punct('+') {
            self.unary()?
        } else {
            self.primary()?
        };
        self.depth -= 1;
        Ok(e)
    }

    fn primary(&mut self) -> Result<Expr, Unsupported> {
        match self.next() {
            Some(Token::Number(n)) => Ok(Expr::Number(n)),
            Some(Token::Punct('(')) => {
                let e = self.expr()?;
                self.expect_punct(')')?;
                Ok(e)
            }
            Some(Token::Ident(name)) => match name.as_str() {
                "AFMakeNumber" | "Number" => {
                    self.expect_punct('(')?;
                    let e = self.expr()?;
                    self.expect_punct(')')?;
                    Ok(e)
                }
                "this" => {
                    self.expect_punct('.')?;
                    self.expect_ident("getField")?;
                    self.field_value()
                }
                "getField" => self.field_value(),
                "Math" => {
                    self.expect_punct('.')?;
                    let Some(Token::Ident(f)) = self.next() else {
                        return no("Math. without a function");
                    };
                    self.expect_punct('(')?;
                    let mut items = vec![self.expr()?];
                    while self.eat_punct(',') {
                        if items.len() > MAX_FIELDS {
                            return no("too many arguments");
                        }
                        items.push(self.expr()?);
                    }
                    self.expect_punct(')')?;
                    let one = |items: Vec<Expr>, wrap: fn(Box<Expr>) -> Expr| {
                        match <[Expr; 1]>::try_from(items) {
                            Ok([e]) => Ok(wrap(Box::new(e))),
                            Err(_) => no("Math function with the wrong number of arguments"),
                        }
                    };
                    match f.as_str() {
                        "round" => one(items, Expr::Round),
                        "floor" => one(items, Expr::Floor),
                        "ceil" => one(items, Expr::Ceil),
                        "abs" => one(items, Expr::Abs),
                        "min" => Ok(Expr::Min(items)),
                        "max" => Ok(Expr::Max(items)),
                        _ => no(format!("Math.{f}")),
                    }
                }
                other => no(format!("{other} in an expression")),
            },
            _ => no("an expression that is not arithmetic on fields"),
        }
    }

    /// `("name").value`, after `getField`.
    fn field_value(&mut self) -> Result<Expr, Unsupported> {
        self.expect_punct('(')?;
        let Some(Token::Str(name)) = self.next() else {
            return no("getField without a field name");
        };
        self.expect_punct(')')?;
        self.expect_punct('.')?;
        self.expect_ident("value")?;
        Ok(Expr::Field(name))
    }
}

#[derive(Debug, Clone, PartialEq)]
enum Arg {
    Number(f64),
    Str(String),
    Bool(bool),
    List(Vec<String>),
}

impl Arg {
    fn number(&self) -> Option<f64> {
        match self {
            Arg::Number(n) => Some(*n),
            Arg::Str(s) => s.trim().parse().ok(),
            Arg::Bool(b) => Some(f64::from(u8::from(*b))),
            Arg::List(_) => None,
        }
    }

    fn small(&self, max: u8) -> Option<u8> {
        let n = self.number()?;
        (n >= 0.0 && n <= f64::from(max) && n.fract() == 0.0).then_some(n as u8)
    }

    fn truthy(&self) -> bool {
        match self {
            Arg::Number(n) => *n != 0.0,
            Arg::Str(s) => !s.is_empty(),
            Arg::Bool(b) => *b,
            Arg::List(_) => true,
        }
    }

    fn text(&self) -> Option<&str> {
        match self {
            Arg::Str(s) => Some(s),
            _ => None,
        }
    }
}

fn call(name: &str, args: &[Arg]) -> Result<Action, Unsupported> {
    let stage = if name.ends_with("_Keystroke") || name.ends_with("_KeystrokeEx") {
        Stage::Keystroke
    } else {
        Stage::Format
    };
    let arg = |i: usize| args.get(i);
    match name {
        "AFNumber_Format" | "AFNumber_Keystroke" => {
            let decimals = arg(0).and_then(|a| a.small(15));
            let separator = arg(1).and_then(|a| a.small(4));
            let (Some(decimals), Some(separator)) = (decimals, separator) else {
                return no(format!("{name} with bad arguments"));
            };
            Ok(Action::Number(
                NumberSpec {
                    decimals,
                    separator,
                    negative: arg(2).and_then(|a| a.small(3)).unwrap_or(0),
                    currency: arg(4)
                        .and_then(Arg::text)
                        .unwrap_or("")
                        .chars()
                        .take(16)
                        .collect(),
                    prepend: arg(5).map(Arg::truthy).unwrap_or(false),
                },
                stage,
            ))
        }
        "AFPercent_Format" | "AFPercent_Keystroke" => {
            let decimals = arg(0).and_then(|a| a.small(15));
            let (Some(decimals), separator) =
                (decimals, arg(1).and_then(|a| a.small(4)).unwrap_or(0))
            else {
                return no(format!("{name} with bad arguments"));
            };
            Ok(Action::Percent(decimals, separator, stage))
        }
        "AFDate_FormatEx" | "AFDate_KeystrokeEx" => match arg(0).and_then(Arg::text) {
            Some(pattern) if pattern.chars().count() <= 64 => {
                Ok(Action::Date(DateSpec::new(pattern), stage))
            }
            _ => no(format!("{name} without a pattern")),
        },
        "AFDate_Format" | "AFDate_Keystroke" => {
            // The old numbered formats of AForm.js.
            const OLD: [&str; 14] = [
                "m/d",
                "m/d/yy",
                "mm/dd/yy",
                "mm/yy",
                "d-mmm",
                "d-mmm-yy",
                "dd-mmm-yy",
                "yy-mm-dd",
                "mmm-yy",
                "mmmm-yy",
                "mmm d, yyyy",
                "mmmm d, yyyy",
                "m/d/yy",
                "m/d/yy",
            ];
            match arg(0).and_then(|a| a.small(13)) {
                Some(n) => Ok(Action::Date(DateSpec::new(OLD[n as usize]), stage)),
                None => no(format!("{name} with a bad format number")),
            }
        }
        "AFSpecial_Format" | "AFSpecial_Keystroke" => match arg(0).and_then(|a| a.small(3)) {
            Some(n) => Ok(Action::Special(n, stage)),
            None => no(format!("{name} with a bad format number")),
        },
        "AFRange_Validate" => {
            let bound = |flag: usize, value: usize| -> Result<Option<f64>, Unsupported> {
                if !arg(flag).map(Arg::truthy).unwrap_or(false) {
                    return Ok(None);
                }
                match arg(value).and_then(Arg::number) {
                    Some(n) if n.is_finite() => Ok(Some(n)),
                    _ => no("AFRange_Validate with a bad bound"),
                }
            };
            Ok(Action::Range {
                min: bound(0, 1)?,
                max: bound(2, 3)?,
            })
        }
        "AFSimple_Calculate" => {
            let op = arg(0).and_then(Arg::text).and_then(SimpleOp::from_code);
            let fields = match arg(1) {
                Some(Arg::List(list)) => list.clone(),
                // A comma-separated string is allowed too (AForm.js splits it).
                Some(Arg::Str(s)) => s
                    .split(',')
                    .map(|n| n.trim().to_string())
                    .filter(|n| !n.is_empty())
                    .collect(),
                _ => return no("AFSimple_Calculate without fields"),
            };
            match op {
                Some(op) if !fields.is_empty() => Ok(Action::Simple(op, fields)),
                _ => no("AFSimple_Calculate with a bad operation"),
            }
        }
        "Warraq_Digits" if args.is_empty() => Ok(Action::ArabicDigits),
        "Warraq_LatinDigits" if args.is_empty() => Ok(Action::LatinDigits),
        "Warraq_HijriFormat" | "Warraq_HijriKeystroke" => {
            let stage = if name == "Warraq_HijriFormat" {
                Stage::Format
            } else {
                Stage::Keystroke
            };
            match arg(0).and_then(Arg::text) {
                Some(pattern) if pattern.chars().count() <= 64 => Ok(Action::Hijri(
                    DateSpec::new(pattern),
                    arg(1).map(Arg::truthy).unwrap_or(false),
                    stage,
                )),
                _ => no(format!("{name} without a pattern")),
            }
        }
        other => no(format!("the function {other}")),
    }
}

/// A JavaScript string literal for `text`, safe inside any script.
pub fn js_string(text: &str) -> String {
    let mut out = String::from("\"");
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 || c == '\u{2028}' || c == '\u{2029}' => {
                out.push_str(&format!("\\u{:04x}", c as u32))
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn one(src: &str) -> Action {
        let script = parse(src).unwrap_or_else(|e| panic!("{src}: {e}"));
        assert_eq!(script.actions.len(), 1, "{src}");
        script.actions.into_iter().next().unwrap()
    }

    #[test]
    fn reads_acrobats_built_in_calls() {
        assert_eq!(
            one("AFNumber_Format(2, 0, 0, 0, \"\", true);"),
            Action::Number(
                NumberSpec {
                    decimals: 2,
                    separator: 0,
                    negative: 0,
                    currency: String::new(),
                    prepend: true
                },
                Stage::Format
            )
        );
        assert!(matches!(
            one("AFNumber_Keystroke(0,1,2,0,\" ر.س\",false)"),
            Action::Number(
                NumberSpec {
                    decimals: 0,
                    separator: 1,
                    negative: 2,
                    prepend: false,
                    ..
                },
                Stage::Keystroke
            )
        ));
        assert_eq!(
            one("AFPercent_Format(1, 0)"),
            Action::Percent(1, 0, Stage::Format)
        );
        assert_eq!(
            one("AFDate_FormatEx(\"dd/mm/yyyy\");"),
            Action::Date(DateSpec::new("dd/mm/yyyy"), Stage::Format)
        );
        assert_eq!(
            one("AFDate_Keystroke(2)"),
            Action::Date(DateSpec::new("mm/dd/yy"), Stage::Keystroke)
        );
        assert_eq!(
            one("AFRange_Validate(true, 0, true, 100);"),
            Action::Range {
                min: Some(0.0),
                max: Some(100.0)
            }
        );
        assert_eq!(
            one("AFRange_Validate(false, 0, true, -5)"),
            Action::Range {
                min: None,
                max: Some(-5.0)
            }
        );
        assert_eq!(
            one("AFSimple_Calculate(\"SUM\", new Array (\"a\", \"الكمية\"));"),
            Action::Simple(SimpleOp::Sum, vec!["a".into(), "الكمية".into()])
        );
        assert_eq!(
            one("AFSimple_Calculate('AVG', ['x.1', 'x.2'])"),
            Action::Simple(SimpleOp::Average, vec!["x.1".into(), "x.2".into()])
        );
        assert_eq!(
            one("AFSimple_Calculate(\"PRD\", \"a, b ,c\")"),
            Action::Simple(SimpleOp::Product, vec!["a".into(), "b".into(), "c".into()])
        );
        assert_eq!(
            one("AFSpecial_Format(2);"),
            Action::Special(2, Stage::Format)
        );
    }

    #[test]
    fn reads_simplified_field_notation() {
        let src = "/** BVCALC Price * Qty EVCALC **/ event.value = AFMakeNumber(getField(\"Price\").value) * AFMakeNumber(getField(\"Qty\").value)";
        let Action::Assign(e) = one(src) else {
            panic!()
        };
        assert_eq!(e.fields(), vec!["Price".to_string(), "Qty".to_string()]);
        let v = e.eval(&|n| if n == "Price" { 2.5 } else { 4.0 });
        assert_eq!(v, 10.0);

        let Action::Assign(e) = one(
            "event.value = (this.getField('a').value + -this.getField('b').value) / 2 + Math.max(1, 3, 2) + Math.round(2.5);",
        ) else {
            panic!()
        };
        assert_eq!(
            e.eval(&|n| if n == "a" { 10.0 } else { 4.0 }),
            3.0 + 3.0 + 3.0
        );
    }

    #[test]
    fn precedence_is_arithmetics() {
        let Action::Assign(e) = one("event.value = 2 + 3 * 4 - 8 / 2 / 2;") else {
            panic!()
        };
        assert_eq!(e.eval(&|_| 0.0), 12.0);
        let Action::Assign(e) = one("event.value = -(1 - 2) * --3") else {
            panic!()
        };
        assert_eq!(e.eval(&|_| 0.0), 3.0);
    }

    #[test]
    fn several_statements_in_one_script() {
        let src = format!("AFNumber_Format(2,0,0,0,\"\",false);\nWarraq_Digits();\n{DIGITS_JS}");
        let script = parse(&src).unwrap();
        assert_eq!(script.actions.len(), 2);
        assert_eq!(script.actions[1], Action::ArabicDigits);
    }

    #[test]
    fn anything_else_is_not_run() {
        for src in [
            "app.alert('hi')",
            "event.value = eval('1+1')",
            "var a = 1; event.value = a",
            "for (;;) {}",
            "while(true);",
            "AFNumber_Format(2, 0, 0, 0, \"\", true); app.launchURL('https://example.com')",
            "event.value = getField('a').value.toString()",
            "event.value = this.getField(x).value",
            "AFSimple_Calculate(\"DIV\", [\"a\"])",
            "AFSimple_Calculate(\"SUM\", [])",
            "AFNumber_Format(99, 0)",
            "Warraq_Digits()",
            "Warraq_HijriFormat(\"dd/mm/yyyy\", true)",
            "event.value = 1 +",
            "event.value = \"unterminated",
            "/* unterminated",
            "event.value = Math.pow(2, 3)",
            "event.value = Math.round(1, 2)",
            "getField('a').value = 3",
            "event.rc = false",
            "AFNumber_Format(2, 0, 0, 0, \"\", true) AFNumber_Format(2, 0, 0, 0, \"\", true)",
        ] {
            assert!(parse(src).is_err(), "{src} must not be run");
        }
    }

    #[test]
    fn a_changed_definition_of_warraqs_function_is_not_recognised() {
        let tampered = DIGITS_JS.replacen("0x0660", "0x0661", 1);
        assert_ne!(tampered, DIGITS_JS);
        assert!(parse(&format!("Warraq_Digits();\n{tampered}")).is_err());
        assert!(parse(&format!("Warraq_Digits();\n{DIGITS_JS}")).is_ok());
        let script = format!("Warraq_HijriFormat(\"dd/mm/yyyy\", true);\n{HIJRI_FORMAT_JS}");
        assert!(parse(&script).is_ok());
        let script = format!("Warraq_HijriKeystroke(\"dd/mm/yyyy\");\n{HIJRI_KEYSTROKE_JS}");
        assert!(parse(&script).is_ok());
    }

    #[test]
    fn js_strings_are_escaped() {
        assert_eq!(js_string("a\"b\\c\n"), "\"a\\\"b\\\\c\\n\"");
        let src = format!("AFDate_FormatEx({})", js_string("dd\"/mm"));
        assert_eq!(
            one(&src),
            Action::Date(DateSpec::new("dd\"/mm"), Stage::Format)
        );
    }

    /// A small deterministic generator, so the property tests need no crate.
    struct Rng(u64);
    impl Rng {
        fn new(seed: u64) -> Self {
            Self(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
        }
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn below(&mut self, n: usize) -> usize {
            (self.next() % n.max(1) as u64) as usize
        }
    }

    #[test]
    fn never_panics_on_token_soup() {
        const PIECES: &[&str] = &[
            "event",
            ".",
            "value",
            "=",
            "(",
            ")",
            "[",
            "]",
            ",",
            ";",
            "+",
            "-",
            "*",
            "/",
            "1",
            "2.5",
            "1e308",
            "1e999",
            "\"a\"",
            "'b'",
            "getField",
            "this",
            "AFMakeNumber",
            "Math",
            "min",
            "round",
            "AFSimple_Calculate",
            "\"SUM\"",
            "new",
            "Array",
            "AFNumber_Format",
            "true",
            "false",
            "AFRange_Validate",
            "AFDate_FormatEx",
            "\"dd/mm/yyyy\"",
            "Warraq_Digits",
            "/*",
            "*/",
            "//",
            "\n",
            "\\",
            "\"\\u12",
            "٣",
            "ـ",
            "\u{0}",
            "{",
            "}",
            "function",
            "Warraq_HijriFormat",
        ];
        let mut rng = Rng::new(7);
        for _ in 0..20_000 {
            let n = rng.below(40);
            let src: String = (0..n)
                .map(|_| PIECES[rng.below(PIECES.len())])
                .collect::<Vec<_>>()
                .join(if rng.below(2) == 0 { " " } else { "" });
            if let Ok(script) = parse(&src) {
                for action in script.actions {
                    if let Action::Assign(e) = action {
                        let _ = e.eval(&|_| 1.0);
                    }
                }
            }
        }
    }

    #[test]
    fn never_panics_on_random_bytes_and_is_bounded() {
        let mut rng = Rng::new(99);
        for _ in 0..5_000 {
            let len = rng.below(300);
            let bytes: Vec<u8> = (0..len).map(|_| rng.next() as u8).collect();
            let _ = parse(&String::from_utf8_lossy(&bytes));
        }
        // Deep nesting is refused, not recursed into.
        let deep = format!(
            "event.value = {}1{}",
            "(".repeat(100_000),
            ")".repeat(100_000)
        );
        assert!(parse(&deep).is_err());
        let deep = format!("event.value = {}1", "-".repeat(100_000));
        assert!(parse(&deep).is_err());
        // Long scripts are refused before anything is read.
        let long = format!("event.value = {}", "1+".repeat(MAX_SCRIPT));
        assert!(parse(&long).is_err());
        // Long flat sums stay within the token bound.
        let wide = format!("event.value = {}1", "1+".repeat(MAX_TOKENS));
        assert!(parse(&wide).is_err());
    }
}
