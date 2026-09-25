//! HTML (safe subset) → model, with an own bounded tokenizer.
//!
//! Understood: `h1–h6`, `p`, `div`/sections, `br`, `hr`, `blockquote`, `pre`, `ul/ol/li`
//! (`start`), `table/tr/td/th` (`colspan`, `rowspan`, `thead`), `strong/b`, `em/i`, `u`, `s`,
//! `a`, `code`, `span`, `img` (**`data:` URIs only**), `dir` and `lang` attributes on any
//! element, and a few inline styles (`text-align`, `direction`, `font-weight`, `font-style`,
//! `color`). `script`, `style`, `template`, `iframe`, `object`, forms and comments are dropped;
//! nothing is fetched. At most [`limits::MAX_XML_NODES`] tags and [`limits::MAX_XML_DEPTH`] open
//! elements.

use super::markdown::{data_uri, heading_style, image_block};
use super::ReadOptions;
use crate::error::Result;
use crate::layout::text::has_rtl;
use crate::limits;
use crate::model::{
    Align, Block, Cell, Color, Content, Dir, Document, Family, ListInfo, NumberStyle, ParaStyle,
    Paragraph, Row, Run, Section, Style, Table,
};

/// A token.
#[derive(Debug, Clone, PartialEq)]
pub enum Token {
    Start {
        name: String,
        attrs: Vec<(String, String)>,
        self_closing: bool,
    },
    End(String),
    Text(String),
}

fn entity(name: &str) -> Option<char> {
    if let Some(num) = name.strip_prefix('#') {
        let v = if let Some(h) = num.strip_prefix(['x', 'X']) {
            u32::from_str_radix(h, 16).ok()?
        } else {
            num.parse::<u32>().ok()?
        };
        return char::from_u32(v).filter(|c| *c != '\0');
    }
    Some(match name {
        "amp" => '&',
        "lt" => '<',
        "gt" => '>',
        "quot" => '"',
        "apos" => '\'',
        "nbsp" => '\u{00A0}',
        "copy" => '©',
        "reg" => '®',
        "hellip" => '…',
        "mdash" => '—',
        "ndash" => '–',
        "laquo" => '«',
        "raquo" => '»',
        "lrm" => '\u{200E}',
        "rlm" => '\u{200F}',
        "zwj" => '\u{200D}',
        "zwnj" => '\u{200C}',
        "times" => '×',
        "divide" => '÷',
        "bull" => '•',
        "rsquo" => '’',
        "lsquo" => '‘',
        "rdquo" => '”',
        "ldquo" => '“',
        _ => return None,
    })
}

/// Decode character references.
pub fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(rest.get(..i).unwrap_or(""));
        let after = rest.get(i + 1..).unwrap_or("");
        let end = after.find(';').filter(|&e| e <= 10);
        match end.and_then(|e| entity(after.get(..e).unwrap_or("")).map(|c| (e, c))) {
            Some((e, c)) => {
                out.push(c);
                rest = after.get(e + 1..).unwrap_or("");
            }
            None => {
                out.push('&');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

const RAW: [&str; 7] = [
    "script", "style", "template", "textarea", "title", "iframe", "noscript",
];

/// Tokenize HTML (bounded; never panics).
pub fn tokenize(src: &str) -> Result<Vec<Token>> {
    let mut out = Vec::new();
    let b = src.as_bytes();
    let mut i = 0usize;
    let mut text_start = 0usize;
    let flush = |out: &mut Vec<Token>, from: usize, to: usize| {
        if to > from {
            if let Some(t) = src.get(from..to) {
                out.push(Token::Text(decode_entities(t)));
            }
        }
    };
    while i < b.len() {
        if b.get(i) != Some(&b'<') {
            i += 1;
            continue;
        }
        let rest = src.get(i..).unwrap_or("");
        if rest.starts_with("<!--") {
            flush(&mut out, text_start, i);
            i = rest.find("-->").map_or(b.len(), |e| i + e + 3);
            text_start = i;
            continue;
        }
        if rest.starts_with("<!") || rest.starts_with("<?") {
            flush(&mut out, text_start, i);
            i = rest.find('>').map_or(b.len(), |e| i + e + 1);
            text_start = i;
            continue;
        }
        let closing = rest.starts_with("</");
        let name_start = i + if closing { 2 } else { 1 };
        let name_len = src
            .get(name_start..)
            .unwrap_or("")
            .bytes()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == b'-' || *c == b':')
            .count();
        if name_len == 0 {
            i += 1;
            continue; // a literal '<'
        }
        flush(&mut out, text_start, i);
        let name = src
            .get(name_start..name_start + name_len)
            .unwrap_or("")
            .to_ascii_lowercase();
        // Find the tag end, honouring quotes.
        let mut j = name_start + name_len;
        let mut quote: Option<u8> = None;
        while let Some(&c) = b.get(j) {
            match quote {
                Some(q) if c == q => quote = None,
                Some(_) => {}
                None if c == b'"' || c == b'\'' => quote = Some(c),
                None if c == b'>' => break,
                None => {}
            }
            j += 1;
        }
        let inner = src.get(name_start + name_len..j.min(b.len())).unwrap_or("");
        i = (j + 1).min(b.len());
        text_start = i;
        if closing {
            out.push(Token::End(name));
        } else {
            let self_closing = inner.trim_end().ends_with('/');
            let attrs = parse_attrs(inner);
            let raw = RAW.contains(&name.as_str());
            out.push(Token::Start {
                name: name.clone(),
                attrs,
                self_closing,
            });
            if raw && !self_closing {
                // Skip to </name>.
                let lower = src.get(i..).unwrap_or("").to_ascii_lowercase();
                let end = lower.find(&format!("</{name}")).map_or(b.len(), |e| i + e);
                i = end;
                text_start = i;
            }
        }
        limits::check(out.len(), limits::MAX_XML_NODES, "HTML tokens")?;
    }
    flush(&mut out, text_start, b.len());
    Ok(out)
}

fn parse_attrs(s: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() && out.len() < 64 {
        while b
            .get(i)
            .is_some_and(|c| c.is_ascii_whitespace() || *c == b'/')
        {
            i += 1;
        }
        let ns = i;
        while b
            .get(i)
            .is_some_and(|c| !c.is_ascii_whitespace() && *c != b'=' && *c != b'/')
        {
            i += 1;
        }
        if i == ns {
            i += 1;
            continue;
        }
        let name = s.get(ns..i).unwrap_or("").to_ascii_lowercase();
        while b.get(i).is_some_and(u8::is_ascii_whitespace) {
            i += 1;
        }
        let mut value = String::new();
        if b.get(i) == Some(&b'=') {
            i += 1;
            while b.get(i).is_some_and(u8::is_ascii_whitespace) {
                i += 1;
            }
            match b.get(i) {
                Some(&q) if q == b'"' || q == b'\'' => {
                    let vs = i + 1;
                    i = vs;
                    while b.get(i).is_some_and(|c| *c != q) {
                        i += 1;
                    }
                    value = s.get(vs..i).unwrap_or("").to_string();
                    i += 1;
                }
                _ => {
                    let vs = i;
                    while b.get(i).is_some_and(|c| !c.is_ascii_whitespace()) {
                        i += 1;
                    }
                    value = s.get(vs..i).unwrap_or("").to_string();
                }
            }
        }
        out.push((name, decode_entities(&value)));
    }
    out
}

#[derive(Clone)]
struct Inline {
    bold: bool,
    italic: bool,
    underline: bool,
    color: Option<Color>,
    lang: Option<String>,
    dir: Dir,
    align: Option<Align>,
    family: Option<Family>,
    heading: u8,
    pre: bool,
}

struct Open {
    name: String,
    saved: Inline,
}

struct Builder<'o> {
    opts: &'o ReadOptions,
    doc: Document,
    sinks: Vec<Vec<Block>>,
    para: Option<Paragraph>,
    cur: Inline,
    lists: Vec<(bool, u32)>,
    item: Option<ListInfo>,
    quote: u32,
    tables: Vec<(Table, Option<Row>, Option<Cell>)>,
    blocks: usize,
    in_thead: bool,
}

const BLOCKS: [&str; 24] = [
    "p",
    "div",
    "section",
    "article",
    "header",
    "footer",
    "main",
    "nav",
    "aside",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "blockquote",
    "pre",
    "ul",
    "ol",
    "li",
    "table",
    "figure",
    "figcaption",
    "address",
];

fn style_attr(style: &str, inl: &mut Inline) {
    for decl in style.split(';') {
        let Some((k, v)) = decl.split_once(':') else {
            continue;
        };
        let (k, v) = (k.trim().to_ascii_lowercase(), v.trim().to_ascii_lowercase());
        match k.as_str() {
            "text-align" => {
                inl.align = Some(match v.as_str() {
                    "center" => Align::Center,
                    "right" => Align::Right,
                    "left" => Align::Left,
                    "justify" => Align::Justify,
                    "end" => Align::End,
                    _ => Align::Start,
                })
            }
            "direction" => {
                inl.dir = match v.as_str() {
                    "rtl" => Dir::Rtl,
                    "ltr" => Dir::Ltr,
                    _ => inl.dir,
                }
            }
            "font-weight" => inl.bold = v == "bold" || v.parse::<u32>().is_ok_and(|w| w >= 600),
            "font-style" => inl.italic = v == "italic" || v == "oblique",
            "color" => {
                if let Some(c) = Color::from_hex(&v) {
                    inl.color = Some(c);
                }
            }
            "font-family" => {
                if let Some(f) = v
                    .split(',')
                    .find_map(|n| Family::from_font_name(n.trim().trim_matches(['"', '\''])))
                {
                    inl.family = Some(f);
                }
            }
            _ => {}
        }
    }
}

impl Builder<'_> {
    fn style(&self) -> Style {
        let mut s = if self.cur.heading > 0 {
            heading_style(self.cur.heading, &self.opts.base)
        } else {
            self.opts.base.clone()
        };
        s.bold |= self.cur.bold;
        s.italic = self.cur.italic;
        s.underline = self.cur.underline;
        if let Some(c) = self.cur.color {
            s.color = c;
        }
        if let Some(f) = self.cur.family {
            s.family = f;
        }
        s.lang = self.cur.lang.clone();
        s
    }

    fn open_para(&mut self) {
        if self.para.is_some() {
            return;
        }
        let list = self.item.take();
        let indent = f64::from(self.quote) * 20.0;
        self.para = Some(Paragraph {
            runs: Vec::new(),
            style: ParaStyle {
                heading: self.cur.heading,
                align: self.cur.align.unwrap_or(Align::Start),
                dir: self.cur.dir,
                list,
                indent,
                background: self.cur.pre.then_some(Color {
                    r: 0xF2,
                    g: 0xF2,
                    b: 0xF4,
                }),
                space_after: if self.tables.is_empty() {
                    None
                } else {
                    Some(0.0)
                },
                ..ParaStyle::default()
            },
        });
    }

    fn text(&mut self, t: &str) {
        let t: String = if self.cur.pre {
            t.to_string()
        } else {
            let mut s = String::with_capacity(t.len());
            let mut ws = false;
            for c in t.chars() {
                if c.is_whitespace() && c != '\u{00A0}' {
                    ws = true;
                } else {
                    if ws {
                        s.push(' ');
                    }
                    ws = false;
                    s.push(c);
                }
            }
            if ws {
                s.push(' ');
            }
            s
        };
        if t.is_empty() {
            return;
        }
        if self.para.is_none() && t.trim().is_empty() {
            return;
        }
        self.open_para();
        let style = self.style();
        if let Some(p) = &mut self.para {
            let t = if p.runs.iter().all(|r| r.text.is_empty()) {
                t.trim_start().to_string()
            } else {
                t
            };
            match p.runs.last_mut() {
                Some(r) if r.style == style => {
                    if r.text.ends_with(' ') && t.starts_with(' ') {
                        r.text.push_str(t.trim_start());
                    } else {
                        r.text.push_str(&t);
                    }
                }
                _ => p.runs.push(Run::new(t, style)),
            }
        }
    }

    fn push_block(&mut self, b: Block) -> Result<()> {
        self.blocks += 1;
        limits::check(self.blocks, limits::MAX_BLOCKS, "HTML blocks")?;
        if let Some(cell) = self.tables.last_mut().and_then(|t| t.2.as_mut()) {
            cell.blocks.push(b);
        } else if let Some(s) = self.sinks.last_mut() {
            s.push(b);
        }
        Ok(())
    }

    fn close_para(&mut self) -> Result<()> {
        if let Some(mut p) = self.para.take() {
            if let Some(r) = p.runs.last_mut() {
                let trimmed = r.text.trim_end_matches(' ').len();
                r.text.truncate(trimmed);
            }
            if p.runs.iter().any(|r| !r.text.trim().is_empty()) || p.style.list.is_some() {
                self.push_block(Block::Paragraph(p))?;
            }
        }
        Ok(())
    }

    fn start(&mut self, name: &str, attrs: &[(String, String)]) -> Result<()> {
        let attr = |k: &str| attrs.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
        if BLOCKS.contains(&name) || matches!(name, "hr" | "img" | "tr" | "td" | "th") {
            self.close_para()?;
        }
        if let Some(d) = attr("dir") {
            self.cur.dir = match d.to_ascii_lowercase().as_str() {
                "rtl" => Dir::Rtl,
                "ltr" => Dir::Ltr,
                _ => Dir::Auto,
            };
        }
        if let Some(l) = attr("lang") {
            if !l.is_empty() {
                self.cur.lang = Some(l.chars().take(35).collect());
            }
        }
        if let Some(s) = attr("style") {
            style_attr(s, &mut self.cur);
        }
        if let Some(a) = attr("align") {
            style_attr(&format!("text-align:{a}"), &mut self.cur);
        }
        match name {
            "b" | "strong" => self.cur.bold = true,
            "i" | "em" | "cite" | "var" => self.cur.italic = true,
            "u" | "ins" => self.cur.underline = true,
            "a" => {
                self.cur.underline = true;
                self.cur.color = Some(Color {
                    r: 0x1a,
                    g: 0x5f,
                    b: 0xd6,
                });
            }
            "code" | "kbd" | "samp" => self.cur.family = Some(Family::Latin),
            "pre" => {
                self.cur.pre = true;
                self.cur.family = Some(Family::Latin);
                if self.cur.dir == Dir::Auto {
                    self.cur.dir = Dir::Ltr;
                }
            }
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                self.cur.heading = name.get(1..2).and_then(|d| d.parse().ok()).unwrap_or(1);
            }
            "blockquote" => self.quote = (self.quote + 1).min(limits::MAX_NESTING as u32),
            "ul" | "ol" => {
                if self.lists.len() < limits::MAX_NESTING {
                    let start = attr("start")
                        .and_then(|s| s.parse::<u32>().ok())
                        .unwrap_or(1);
                    self.lists.push((name == "ol", start));
                }
            }
            "li" => {
                let level = self.lists.len().saturating_sub(1).min(8) as u8;
                let (ordered, n) = self.lists.last().copied().unwrap_or((false, 1));
                if let Some(v) = attr("value").and_then(|s| s.parse::<u32>().ok()) {
                    if let Some(top) = self.lists.last_mut() {
                        top.1 = v;
                    }
                }
                let n = attr("value")
                    .and_then(|s| s.parse::<u32>().ok())
                    .unwrap_or(n);
                self.item = Some(ListInfo {
                    ordered,
                    level,
                    number: n,
                    style: NumberStyle::Auto,
                });
                if let Some(top) = self.lists.last_mut() {
                    top.1 = n.saturating_add(1);
                }
            }
            "br" => self.text_raw("\n"),
            "hr" => self.push_block(Block::Paragraph(Paragraph {
                runs: Vec::new(),
                style: ParaStyle {
                    space_after: Some(6.0),
                    ..ParaStyle::default()
                },
            }))?,
            "img" => {
                let alt = attr("alt").unwrap_or("").to_string();
                let block = attr("src")
                    .and_then(data_uri)
                    .and_then(|b| image_block(&mut self.doc, &b, &alt));
                match block {
                    Some(mut b) => {
                        if let (Block::Image(ib), Some(w)) = (
                            &mut b,
                            attr("width")
                                .and_then(|w| w.trim_end_matches("px").parse::<f64>().ok()),
                        ) {
                            if w.is_finite() && w > 0.0 {
                                let ratio = ib.height / ib.width.max(0.01);
                                ib.width = w * 0.75;
                                ib.height = ib.width * ratio;
                            }
                        }
                        self.push_block(b)?;
                    }
                    None if !alt.is_empty() => self.text(&alt),
                    None => {}
                }
            }
            "table" => {
                if self.tables.len() < limits::MAX_NESTING {
                    let dir = self.cur.dir;
                    self.tables.push((
                        Table {
                            rows: Vec::new(),
                            col_widths: None,
                            dir,
                            borders: true,
                        },
                        None,
                        None,
                    ));
                }
            }
            "thead" => self.in_thead = true,
            "tbody" | "tfoot" => self.in_thead = false,
            "tr" => {
                let header = self.in_thead;
                if let Some(t) = self.tables.last_mut() {
                    finish_row(t);
                    t.1 = Some(Row {
                        cells: Vec::new(),
                        header,
                    });
                }
            }
            "td" | "th" => {
                if name == "th" {
                    self.cur.bold = true;
                }
                let span = |k: &str| {
                    attr(k)
                        .and_then(|v| v.parse::<u16>().ok())
                        .unwrap_or(1)
                        .clamp(1, 1000)
                };
                if let Some(t) = self.tables.last_mut() {
                    finish_cell(t);
                    if t.1.is_none() {
                        t.1 = Some(Row {
                            cells: Vec::new(),
                            header: false,
                        });
                    }
                    t.2 = Some(Cell {
                        blocks: Vec::new(),
                        colspan: span("colspan"),
                        rowspan: span("rowspan"),
                        fill: None,
                    });
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn text_raw(&mut self, t: &str) {
        self.open_para();
        let style = self.style();
        if let Some(p) = &mut self.para {
            match p.runs.last_mut() {
                Some(r) if r.style == style => {
                    let n = r.text.trim_end_matches(' ').len();
                    r.text.truncate(n);
                    r.text.push_str(t);
                }
                _ => p.runs.push(Run::new(t, style)),
            }
        }
    }

    fn end(&mut self, name: &str) -> Result<()> {
        if BLOCKS.contains(&name) || matches!(name, "tr" | "td" | "th") {
            self.close_para()?;
        }
        match name {
            "blockquote" => self.quote = self.quote.saturating_sub(1),
            "ul" | "ol" => {
                self.lists.pop();
            }
            "li" => self.item = None,
            "td" | "th" => {
                if let Some(t) = self.tables.last_mut() {
                    finish_cell(t);
                }
            }
            "tr" => {
                if let Some(t) = self.tables.last_mut() {
                    finish_row(t);
                }
            }
            "table" => {
                if let Some(mut t) = self.tables.pop() {
                    finish_row(&mut t);
                    if !t.0.rows.is_empty() {
                        self.push_block(Block::Table(t.0))?;
                    }
                }
            }
            "thead" => self.in_thead = false,
            _ => {}
        }
        Ok(())
    }
}

fn finish_cell(t: &mut (Table, Option<Row>, Option<Cell>)) {
    if let Some(c) = t.2.take() {
        if t.1.is_none() {
            t.1 = Some(Row::default());
        }
        if let Some(r) = &mut t.1 {
            r.cells.push(c);
        }
    }
}

fn finish_row(t: &mut (Table, Option<Row>, Option<Cell>)) {
    finish_cell(t);
    if let Some(mut r) = t.1.take() {
        if !r.cells.is_empty() {
            // A row of <th> only is a header row.
            if t.0.rows.is_empty() && !r.header {
                r.header = r.cells.iter().all(|c| {
                    c.blocks.iter().all(
                        |b| matches!(b, Block::Paragraph(p) if p.runs.iter().all(|r| r.style.bold)),
                    )
                }) && !r.cells.is_empty();
            }
            t.0.rows.push(r);
        }
    }
}

const VOID: [&str; 10] = [
    "br", "hr", "img", "meta", "link", "input", "col", "area", "base", "wbr",
];

/// Read HTML.
pub fn read(src: &str, opts: &ReadOptions) -> Result<Document> {
    let tokens = tokenize(src)?;
    let root_dir = Dir::Auto;
    let mut b = Builder {
        opts,
        doc: Document::default(),
        sinks: vec![Vec::new()],
        para: None,
        cur: Inline {
            bold: false,
            italic: false,
            underline: false,
            color: None,
            lang: None,
            dir: root_dir,
            align: None,
            family: None,
            heading: 0,
            pre: false,
        },
        lists: Vec::new(),
        item: None,
        quote: 0,
        tables: Vec::new(),
        blocks: 0,
        in_thead: false,
    };
    let mut stack: Vec<Open> = Vec::new();
    let mut title: Option<String> = None;
    let mut doc_lang: Option<String> = None;
    let mut skip_depth = 0usize;
    for tok in tokens {
        match tok {
            Token::Start {
                name,
                attrs,
                self_closing,
            } => {
                if name == "html" {
                    if let Some((_, l)) = attrs.iter().find(|(k, _)| k == "lang") {
                        doc_lang = Some(l.clone());
                    }
                }
                if RAW.contains(&name.as_str())
                    || matches!(
                        name.as_str(),
                        "head" | "svg" | "math" | "object" | "select" | "button"
                    )
                {
                    if !self_closing && !RAW.contains(&name.as_str()) {
                        skip_depth += 1;
                    }
                    continue;
                }
                if skip_depth > 0 {
                    continue;
                }
                // Implicit closes.
                if matches!(name.as_str(), "li" | "p" | "tr" | "td" | "th") {
                    let targets: &[&str] = match name.as_str() {
                        "li" => &["li"],
                        "p" => &["p"],
                        "tr" => &["tr", "td", "th"],
                        _ => &["td", "th"],
                    };
                    if stack
                        .last()
                        .is_some_and(|o| targets.contains(&o.name.as_str()))
                    {
                        if let Some(o) = stack.pop() {
                            b.end(&o.name)?;
                            b.cur = o.saved;
                        }
                    }
                }
                let saved = b.cur.clone();
                b.start(&name, &attrs)?;
                if self_closing || VOID.contains(&name.as_str()) {
                    b.cur = saved;
                } else {
                    limits::check(stack.len() + 1, limits::MAX_XML_DEPTH, "HTML nesting")?;
                    stack.push(Open { name, saved });
                }
            }
            Token::End(name) => {
                if matches!(
                    name.as_str(),
                    "head" | "svg" | "math" | "object" | "select" | "button"
                ) {
                    skip_depth = skip_depth.saturating_sub(1);
                    continue;
                }
                if skip_depth > 0 {
                    continue;
                }
                if let Some(pos) = stack.iter().rposition(|o| o.name == name) {
                    while stack.len() > pos {
                        if let Some(o) = stack.pop() {
                            b.end(&o.name)?;
                            b.cur = o.saved;
                        }
                    }
                }
            }
            Token::Text(t) => {
                if skip_depth > 0 {
                    continue;
                }
                b.text(&t);
            }
        }
    }
    while let Some(o) = stack.pop() {
        b.end(&o.name)?;
        b.cur = o.saved;
    }
    b.close_para()?;
    while let Some(mut t) = b.tables.pop() {
        finish_row(&mut t);
        if !t.0.rows.is_empty() {
            b.push_block(Block::Table(t.0))?;
        }
    }
    // <title> content is skipped by the tokenizer; take the first heading as the title instead.
    let blocks = b.sinks.into_iter().next().unwrap_or_default();
    for blk in &blocks {
        if let Block::Paragraph(p) = blk {
            if p.style.heading > 0 && title.is_none() {
                title = Some(p.text().chars().take(200).collect());
            }
        }
    }
    let any_ar = blocks
        .iter()
        .any(|x| matches!(x, Block::Paragraph(p) if has_rtl(&p.text())));
    let mut doc = b.doc;
    doc.title = title;
    doc.lang = doc_lang.or(Some(if any_ar || opts.default_rtl {
        "ar".into()
    } else {
        "en".into()
    }));
    doc.sections.push(Section {
        page: opts.page,
        content: Content::Flow(blocks),
        page_from_source: false,
    });
    Ok(doc)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing, clippy::panic)]
mod tests {
    use super::*;

    fn blocks(html: &str) -> Vec<Block> {
        let d = read(html, &ReadOptions::default()).unwrap();
        match &d.sections[0].content {
            Content::Flow(b) => b.clone(),
            Content::Fixed(_) => panic!(),
        }
    }

    #[test]
    fn tokenizer_is_forgiving() {
        let t = tokenize("<p class=x id='y' hidden>a &amp; b &unknown; &#1576;<br/>c</p><!-- x --><script>alert('<p>')</script>").unwrap();
        assert!(
            matches!(&t[0], Token::Start { name, attrs, .. } if name == "p" && attrs.len() == 3)
        );
        assert_eq!(t[1], Token::Text("a & b &unknown; ب".into()));
        assert!(!t
            .iter()
            .any(|x| matches!(x, Token::Text(s) if s.contains("alert"))));
        assert!(tokenize("<<<>>> <a <b").is_ok());
    }

    #[test]
    fn structure_dir_and_tables() {
        let b = blocks(
            r#"<html dir="rtl" lang="ar"><body><h1>عنوان</h1><p>نص <strong>عريض</strong></p>
          <ol><li>أول<li>ثان</ol><p dir="ltr" style="text-align:center">Hello</p>
          <table><tr><th>أ</th><th>ب</th></tr><tr><td colspan="2">ج</td></tr></table>
          <img src="https://evil.example/x.png" alt="صورة"><script>x()</script></body></html>"#,
        );
        let Block::Paragraph(h) = &b[0] else { panic!() };
        assert_eq!((h.style.heading, h.text().as_str()), (1, "عنوان"));
        let Block::Paragraph(p) = &b[1] else { panic!() };
        assert_eq!(p.text(), "نص عريض");
        assert!(p.runs[1].style.bold);
        let Block::Paragraph(l2) = &b[3] else {
            panic!()
        };
        assert_eq!(l2.style.list.as_ref().unwrap().number, 2);
        let Block::Paragraph(en) = &b[4] else {
            panic!()
        };
        assert_eq!((en.style.dir, en.style.align), (Dir::Ltr, Align::Center));
        let Block::Table(t) = &b[5] else { panic!() };
        assert!(t.rows[0].header);
        assert_eq!(t.rows[1].cells[0].colspan, 2);
        let Block::Paragraph(alt) = &b[6] else {
            panic!()
        };
        assert_eq!(alt.text(), "صورة");
        assert_eq!(b.len(), 7);
    }

    #[test]
    fn deep_nesting_is_bounded() {
        let deep = "<div>".repeat(100_000);
        assert!(read(&deep, &ReadOptions::default()).is_err());
    }
}
