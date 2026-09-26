//! Markdown (CommonMark + GFM tables/strikethrough) via `pulldown-cmark` → model.
//! Pictures are embedded only from `data:` URIs (nothing is fetched); other pictures become
//! their alt text.

use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag, TagEnd};

use super::ReadOptions;
use crate::error::Result;
use crate::limits;
use crate::model::{
    Block, Cell, Color, Content, Dir, Document, Family, ImageBlock, ListInfo, NumberStyle,
    ParaStyle, Paragraph, Row, Run, Section, Style, Table,
};

/// Heading run style for level 1–6.
pub fn heading_style(level: u8, base: &Style) -> Style {
    let size = match level {
        1 => 22.0,
        2 => 18.0,
        3 => 15.0,
        4 => 13.0,
        5 => 12.0,
        _ => 11.0,
    };
    Style {
        size,
        bold: true,
        ..base.clone()
    }
}

struct State<'o> {
    opts: &'o ReadOptions,
    doc: Document,
    sinks: Vec<Vec<Block>>,
    para: Option<Paragraph>,
    bold: u32,
    italic: u32,
    strike: u32,
    link: u32,
    code_block: bool,
    heading: u8,
    quote: u32,
    lists: Vec<(bool, u64)>,
    item_label: Option<ListInfo>,
    tables: Vec<(Table, Option<Row>)>,
    image_alt: Option<(String, String)>,
    blocks: usize,
}

impl State<'_> {
    fn style(&self) -> Style {
        let mut s = if self.heading > 0 {
            heading_style(self.heading, &self.opts.base)
        } else {
            self.opts.base.clone()
        };
        if self.bold > 0 {
            s.bold = true;
        }
        if self.italic > 0 {
            s.italic = true;
        }
        if self.link > 0 {
            s.underline = true;
            s.color = Color {
                r: 0x1a,
                g: 0x5f,
                b: 0xd6,
            };
        }
        if self.strike > 0 {
            s.color = Color {
                r: 0x77,
                g: 0x77,
                b: 0x77,
            };
        }
        if self.code_block {
            s.family = Family::Latin;
            s.size = (s.size - 1.0).max(8.0);
        }
        s
    }

    fn open_para(&mut self) {
        if self.para.is_some() {
            return;
        }
        let list = self.item_label.take();
        let indent = f64::from(self.quote) * 20.0
            + if list.is_none() && !self.lists.is_empty() {
                20.0 * self.lists.len() as f64
            } else {
                0.0
            };
        self.para = Some(Paragraph {
            runs: Vec::new(),
            style: ParaStyle {
                heading: self.heading,
                dir: if self.code_block { Dir::Ltr } else { Dir::Auto },
                list,
                indent,
                background: self.code_block.then_some(Color {
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
        if let Some((_, alt)) = &mut self.image_alt {
            alt.push_str(t);
            return;
        }
        self.open_para();
        let style = self.style();
        if let Some(p) = &mut self.para {
            match p.runs.last_mut() {
                Some(r) if r.style == style => r.text.push_str(t),
                _ => p.runs.push(Run::new(t, style)),
            }
        }
    }

    fn push_block(&mut self, b: Block) -> Result<()> {
        self.blocks += 1;
        limits::check(self.blocks, limits::MAX_BLOCKS, "Markdown blocks")?;
        if let Some(s) = self.sinks.last_mut() {
            s.push(b);
        }
        Ok(())
    }

    fn close_para(&mut self) -> Result<()> {
        if let Some(p) = self.para.take() {
            if p.runs.iter().any(|r| !r.text.trim().is_empty()) || p.style.list.is_some() {
                self.push_block(Block::Paragraph(p))?;
            }
        }
        Ok(())
    }
}

/// Decode `data:image/…;base64,…` URIs (nothing else is ever loaded).
pub fn data_uri(uri: &str) -> Option<Vec<u8>> {
    let rest = uri.trim().strip_prefix("data:")?;
    let (meta, payload) = rest.split_once(',')?;
    if !meta.starts_with("image/") || !meta.ends_with(";base64") {
        return None;
    }
    base64(payload)
}

/// Standard base64 (whitespace ignored), bounded by the input size.
pub fn base64(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut acc = 0u32;
    let mut bits = 0u32;
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            b' ' | b'\n' | b'\r' | b'\t' => continue,
            _ => return None,
        };
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

/// An image block from bytes (JPEG/PNG), scaled to its natural size.
pub fn image_block(doc: &mut Document, bytes: &[u8], alt: &str) -> Option<Block> {
    let img = crate::image::decode(bytes).ok()?;
    let (w, h) = img.natural_size();
    let idx = doc.add_image(img);
    Some(Block::Image(ImageBlock {
        image: idx,
        width: w,
        height: h,
        alt: alt.to_string(),
        align: crate::model::Align::Center,
    }))
}

/// Read Markdown.
pub fn read(text: &str, opts: &ReadOptions) -> Result<Document> {
    let mut st = State {
        opts,
        doc: Document::default(),
        sinks: vec![Vec::new()],
        para: None,
        bold: 0,
        italic: 0,
        strike: 0,
        link: 0,
        code_block: false,
        heading: 0,
        quote: 0,
        lists: Vec::new(),
        item_label: None,
        tables: Vec::new(),
        image_alt: None,
        blocks: 0,
    };
    let parser = Parser::new_ext(text, Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH);
    for ev in parser {
        match ev {
            Event::Start(tag) => match tag {
                Tag::Paragraph => st.open_para(),
                Tag::Heading { level, .. } => {
                    st.close_para()?;
                    st.heading = match level {
                        HeadingLevel::H1 => 1,
                        HeadingLevel::H2 => 2,
                        HeadingLevel::H3 => 3,
                        HeadingLevel::H4 => 4,
                        HeadingLevel::H5 => 5,
                        HeadingLevel::H6 => 6,
                    };
                    st.open_para();
                }
                Tag::BlockQuote(_) => {
                    st.close_para()?;
                    st.quote = (st.quote + 1).min(limits::MAX_NESTING as u32);
                }
                Tag::CodeBlock(_) => {
                    st.close_para()?;
                    st.code_block = true;
                    st.open_para();
                }
                Tag::List(start) => {
                    st.close_para()?;
                    if st.lists.len() < limits::MAX_NESTING {
                        st.lists.push((start.is_some(), start.unwrap_or(1)));
                    }
                }
                Tag::Item => {
                    st.close_para()?;
                    let level = st.lists.len().saturating_sub(1).min(8) as u8;
                    if let Some((ordered, n)) = st.lists.last_mut() {
                        st.item_label = Some(ListInfo {
                            ordered: *ordered,
                            level,
                            number: (*n).min(u64::from(u32::MAX)) as u32,
                            style: NumberStyle::Auto,
                        });
                        *n += 1;
                    }
                }
                Tag::Table(_) => {
                    st.close_para()?;
                    if st.tables.len() < limits::MAX_NESTING {
                        st.tables.push((
                            Table {
                                rows: Vec::new(),
                                col_widths: None,
                                dir: Dir::Auto,
                                borders: true,
                            },
                            None,
                        ));
                    }
                }
                Tag::TableHead | Tag::TableRow => {
                    if let Some((_, row)) = st.tables.last_mut() {
                        *row = Some(Row {
                            cells: Vec::new(),
                            header: matches!(tag, Tag::TableHead),
                        });
                    }
                }
                Tag::TableCell => {
                    st.sinks.push(Vec::new());
                    if st
                        .tables
                        .last()
                        .and_then(|t| t.1.as_ref())
                        .is_some_and(|r| r.header)
                    {
                        st.bold += 1;
                    }
                }
                Tag::Emphasis => st.italic += 1,
                Tag::Strong => st.bold += 1,
                Tag::Strikethrough => st.strike += 1,
                Tag::Link { .. } => st.link += 1,
                Tag::Image { dest_url, .. } => {
                    st.image_alt = Some((dest_url.to_string(), String::new()));
                }
                _ => {}
            },
            Event::End(tag) => match tag {
                TagEnd::Paragraph => st.close_para()?,
                TagEnd::Heading(_) => {
                    st.close_para()?;
                    st.heading = 0;
                }
                TagEnd::BlockQuote(_) => {
                    st.close_para()?;
                    st.quote = st.quote.saturating_sub(1);
                }
                TagEnd::CodeBlock => {
                    // Code blocks end with a newline; drop it.
                    if let Some(p) = &mut st.para {
                        if let Some(r) = p.runs.last_mut() {
                            while r.text.ends_with('\n') {
                                r.text.pop();
                            }
                        }
                    }
                    st.close_para()?;
                    st.code_block = false;
                }
                TagEnd::List(_) => {
                    st.close_para()?;
                    st.lists.pop();
                }
                TagEnd::Item => {
                    st.close_para()?;
                    st.item_label = None;
                }
                TagEnd::TableCell => {
                    st.close_para()?;
                    if st
                        .tables
                        .last()
                        .and_then(|t| t.1.as_ref())
                        .is_some_and(|r| r.header)
                    {
                        st.bold = st.bold.saturating_sub(1);
                    }
                    let blocks = st.sinks.pop().unwrap_or_default();
                    if let Some((_, Some(row))) = st.tables.last_mut() {
                        row.cells.push(Cell {
                            blocks,
                            ..Cell::default()
                        });
                    }
                }
                TagEnd::TableHead | TagEnd::TableRow => {
                    if let Some((t, row)) = st.tables.last_mut() {
                        if let Some(r) = row.take() {
                            t.rows.push(r);
                        }
                    }
                }
                TagEnd::Table => {
                    if let Some((t, _)) = st.tables.pop() {
                        st.push_block(Block::Table(t))?;
                    }
                }
                TagEnd::Emphasis => st.italic = st.italic.saturating_sub(1),
                TagEnd::Strong => st.bold = st.bold.saturating_sub(1),
                TagEnd::Strikethrough => st.strike = st.strike.saturating_sub(1),
                TagEnd::Link => st.link = st.link.saturating_sub(1),
                TagEnd::Image => {
                    if let Some((url, alt)) = st.image_alt.take() {
                        let block = data_uri(&url).and_then(|b| image_block(&mut st.doc, &b, &alt));
                        match block {
                            Some(b) => {
                                st.close_para()?;
                                st.push_block(b)?;
                            }
                            None if !alt.is_empty() => st.text(&alt),
                            None => {}
                        }
                    }
                }
                _ => {}
            },
            Event::Text(t) | Event::Code(t) => st.text(&t),
            Event::SoftBreak => st.text(" "),
            Event::HardBreak => st.text("\n"),
            Event::Rule => {
                st.close_para()?;
                st.push_block(Block::Paragraph(Paragraph {
                    runs: Vec::new(),
                    style: ParaStyle {
                        space_after: Some(6.0),
                        ..ParaStyle::default()
                    },
                }))?;
            }
            Event::TaskListMarker(done) => st.text(if done { "☑ " } else { "☐ " }),
            Event::Html(_) | Event::InlineHtml(_) | Event::FootnoteReference(_) => {}
            _ => {}
        }
    }
    st.close_para()?;
    let blocks = st.sinks.into_iter().next().unwrap_or_default();
    let mut doc = st.doc;
    let has_ar = blocks
        .iter()
        .any(|b| matches!(b, Block::Paragraph(p) if crate::layout::text::has_rtl(&p.text())));
    doc.lang = Some(if has_ar || opts.default_rtl {
        "ar".into()
    } else {
        "en".into()
    });
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

    fn blocks(md: &str) -> Vec<Block> {
        let d = read(md, &ReadOptions::default()).unwrap();
        match &d.sections[0].content {
            Content::Flow(b) => b.clone(),
            Content::Fixed(_) => panic!(),
        }
    }

    #[test]
    fn headings_lists_tables() {
        let b = blocks("# عنوان\n\nنص **عريض** و*مائل*.\n\n1. أول\n2. ثان\n\n- a\n  - b\n\n| س | ص |\n|---|---|\n| 1 | 2 |\n");
        let Block::Paragraph(h) = &b[0] else { panic!() };
        assert_eq!(h.style.heading, 1);
        assert_eq!(h.text(), "عنوان");
        let Block::Paragraph(p) = &b[1] else { panic!() };
        assert!(p.runs.iter().any(|r| r.style.bold && r.text == "عريض"));
        assert!(p.runs.iter().any(|r| r.style.italic && r.text == "مائل"));
        let Block::Paragraph(l1) = &b[2] else {
            panic!()
        };
        assert_eq!(l1.style.list.as_ref().unwrap().number, 1);
        let Block::Paragraph(l2) = &b[3] else {
            panic!()
        };
        assert_eq!(l2.style.list.as_ref().unwrap().number, 2);
        let nested = b
            .iter()
            .filter_map(|x| match x {
                Block::Paragraph(p) => p.style.list.as_ref(),
                _ => None,
            })
            .any(|l| l.level == 1);
        assert!(nested);
        let t = b
            .iter()
            .find_map(|x| match x {
                Block::Table(t) => Some(t),
                _ => None,
            })
            .unwrap();
        assert_eq!(t.rows.len(), 2);
        assert!(t.rows[0].header);
    }

    #[test]
    fn only_data_uri_images() {
        assert_eq!(base64("aGVsbG8=").unwrap(), b"hello");
        assert!(data_uri("https://example.com/x.png").is_none());
        let b = blocks("![alt text](https://example.com/x.png)");
        let Block::Paragraph(p) = &b[0] else { panic!() };
        assert_eq!(p.text(), "alt text");
    }
}
