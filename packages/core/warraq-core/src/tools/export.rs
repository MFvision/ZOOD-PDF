//! What Export needs from the core beyond a page's lines and paragraphs.
//!
//! - `export.tables` (Excel): what is on a page, top to bottom — the tables
//!   its rules draw or its columns of text make (`crate::tables`), and the
//!   lines around them, cut at their wide gaps. Text in reading order.
//! - `export.lines` (Word and PowerPoint with the layout kept): the page's
//!   lines as the editor has them — a line that crosses a table's columns
//!   or cards side by side cut into one piece per column — so each piece
//!   can be placed where it was; with `reading`, the lines as they are read
//!   (`text_lines`), for the exports that flow. Each line says which of its
//!   letters a web or mail link covers, so the export can link them too.
//! - `export.picture` (PowerPoint): the page drawn without its text, to go
//!   behind the slide's editable text boxes; and whether the page's text was
//!   invisible to begin with (a scan with a text layer), in which case the
//!   picture is the page as it is.
use serde::Deserialize;
use serde_json::{json, Value};
use warraq_pdf::LinkTarget;
use warraq_text::{Direction, TextLine};

use super::{args, Reply};
use crate::tables::{page_items, LineCell, PageItem};
use crate::{CoreError, Document};

#[derive(Deserialize)]
struct Page {
    page: usize,
}

#[derive(Deserialize)]
struct Lines {
    page: usize,
    /// The lines as read, rather than as the editor cuts them.
    #[serde(default)]
    reading: bool,
}

#[derive(Deserialize)]
struct Picture {
    page: usize,
    scale: f32,
}

fn dir(d: Direction) -> &'static str {
    match d {
        Direction::Rtl => "rtl",
        Direction::Ltr => "ltr",
    }
}

pub fn call(
    doc: &mut Document,
    name: &str,
    json: &str,
    _: Vec<Vec<u8>>,
) -> Result<Reply, CoreError> {
    match name {
        "tables" => {
            let a: Page = args(json)?;
            let lines = doc.text_lines(a.page)?;
            let rules = doc.drawing(a.page)?.rules;
            let cells = |cells: &[LineCell]| -> Vec<Value> {
                cells
                    .iter()
                    .map(|c| json!({ "text": c.text, "x0": c.x0, "x1": c.x1, "direction": dir(c.direction) }))
                    .collect()
            };
            let items: Vec<Value> = page_items(&lines, &rules)
                .iter()
                .map(|item| match item {
                    PageItem::Table(t) => json!({
                        "kind": "table",
                        "ruled": t.ruled,
                        "direction": dir(t.direction),
                        "left": t.left,
                        "top": t.top,
                        "widths": t.widths,
                        "heights": t.heights,
                        "rows": t.grid.iter().map(|row| row.iter().map(|cell| match cell {
                            Some(c) => match c.bounds {
                                Some([x0, y0, x1, y1]) => json!({ "text": c.text, "rows": c.rows, "columns": c.columns, "box": [x0, y0, x1 - x0, y1 - y0] }),
                                None => json!({ "text": c.text, "rows": c.rows, "columns": c.columns }),
                            },
                            None => Value::Null,
                        }).collect::<Vec<_>>()).collect::<Vec<_>>(),
                    }),
                    PageItem::Line { text, direction, cells: c, .. } => json!({
                        "kind": "line",
                        "text": text,
                        "direction": dir(*direction),
                        "cells": cells(c),
                    }),
                })
                .collect();
            Reply::of(&json!({ "items": items }))
        }
        "lines" => {
            let a: Lines = args(json)?;
            let lines = if a.reading {
                doc.text_lines(a.page)?
            } else {
                doc.edit_view(a.page)?.0
            };
            let links = web_links(doc, a.page);
            let lines: Vec<Value> = lines
                .iter()
                .map(|l| {
                    let mut line = json!({ "text": l.text, "x": l.x, "y": l.y, "width": l.width, "height": l.height, "direction": dir(l.direction) });
                    let on = links_on(l, &links);
                    if !on.is_empty() {
                        line["links"] = on
                            .iter()
                            .map(|(from, to, uri)| json!({ "from": from, "to": to, "uri": uri }))
                            .collect();
                    }
                    line
                })
                .collect();
            Reply::of(&json!({ "lines": lines }))
        }
        "picture" => {
            let a: Picture = args(json)?;
            let (bitmap, hidden) = doc.render_without_text(a.page, a.scale)?;
            Ok(Reply::of(&serde_json::json!({
                "width": bitmap.width, "height": bitmap.height, "textHidden": hidden,
            }))?
            .with_blob(bitmap.rgba))
        }
        _ => Err(CoreError::UnknownOp(format!("export.{name}"))),
    }
}

/// The page's links to web and mail addresses: where they are, and where to.
/// A file whose links cannot be read still exports, without them.
fn web_links(doc: &mut Document, page: usize) -> Vec<([f32; 4], String)> {
    doc.pdf_mut()
        .list_links(page)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|link| match link.target {
            LinkTarget::Uri(uri) => warraq_pdf::safe_uri(&uri).map(|uri| (link.rect, uri)),
            _ => None,
        })
        .collect()
}

/// Which letters of `line` each link covers: `(from, to, uri)`, offsets in
/// UTF-16 units of `line.text` (as the interface counts), spaces at either
/// end left out. A letter is linked when its middle is inside the link's
/// box; a line whose letters' places are unknown is linked whole when a
/// link covers most of it.
pub(crate) fn links_on(
    line: &TextLine,
    links: &[([f32; 4], String)],
) -> Vec<(usize, usize, String)> {
    if links.is_empty() {
        return Vec::new();
    }
    let chars: Vec<char> = line.text.chars().collect();
    let cy = line.y + line.height / 2.0;
    let inside = |[x, y, w, h]: [f32; 4], px: f32| {
        px >= x - 0.5 && px <= x + w + 0.5 && cy >= y - 1.0 && cy <= y + h + 1.0
    };
    let whole = line.spans.len() != chars.len();
    let mut owner: Vec<Option<usize>> = vec![None; chars.len()];
    for (k, owner) in owner.iter_mut().enumerate() {
        let cx = if whole {
            line.x + line.width / 2.0
        } else {
            (line.spans[k].0 + line.spans[k].1) / 2.0
        };
        *owner = links.iter().position(|(rect, _)| inside(*rect, cx));
    }
    if whole {
        // Most of the line, not only its middle, under the link.
        let covered = owner.first().copied().flatten().filter(|&k| {
            let [x, _, w, _] = links[k].0;
            (line.x + line.width).min(x + w) - line.x.max(x) >= 0.8 * line.width
        });
        owner = vec![covered; chars.len()];
    }
    // A space between two letters of one link is part of it.
    for k in 1..chars.len().saturating_sub(1) {
        if owner[k].is_none() && chars[k].is_whitespace() && owner[k - 1].is_some() {
            let next = (k + 1..chars.len()).find(|&j| !chars[j].is_whitespace());
            if next.is_some_and(|j| owner[j] == owner[k - 1]) {
                owner[k] = owner[k - 1];
            }
        }
    }
    let mut out: Vec<(usize, usize, String)> = Vec::new();
    let mut at = 0usize;
    let mut open: Option<(usize, usize, usize)> = None;
    for (k, c) in chars.iter().enumerate() {
        let width = c.len_utf16();
        let linked = owner[k].filter(|_| !c.is_whitespace());
        match (open, linked) {
            (Some((link, from, _)), Some(l)) if l == link => open = Some((link, from, at + width)),
            (Some((link, from, to)), Some(l)) if l != link => {
                out.push((from, to, links[link].1.clone()));
                open = Some((l, at, at + width));
            }
            (None, Some(l)) => open = Some((l, at, at + width)),
            (Some((link, from, to)), None) if owner[k] != Some(link) => {
                out.push((from, to, links[link].1.clone()));
                open = None;
            }
            _ => {}
        }
        at += width;
    }
    if let Some((link, from, to)) = open {
        out.push((from, to, links[link].1.clone()));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(text: &str, x: f32) -> TextLine {
        let n = text.chars().count();
        TextLine {
            text: text.into(),
            x,
            y: 100.0,
            width: n as f32 * 5.0,
            height: 12.0,
            direction: Direction::Ltr,
            spans: (0..n)
                .map(|k| (x + k as f32 * 5.0, x + k as f32 * 5.0 + 5.0))
                .collect(),
            turned: None,
        }
    }

    #[test]
    fn a_link_covers_the_letters_under_its_box() {
        // "see our site now": "our site" is chars 4..12, x 54..94.
        let l = line("see our site now", 34.0);
        let links = vec![([53.0, 99.0, 41.0, 14.0], "https://zood.sa".to_string())];
        assert_eq!(
            links_on(&l, &links),
            vec![(4, 12, "https://zood.sa".to_string())]
        );
    }

    #[test]
    fn two_links_on_a_line_stay_apart_and_offsets_count_utf16() {
        // An emoji is two UTF-16 units: the offsets after it move by two.
        let l = line("😀 a b", 0.0);
        let links = vec![
            ([9.0, 99.0, 7.0, 14.0], "https://a.example".to_string()),
            ([19.0, 99.0, 7.0, 14.0], "mailto:b@example.com".to_string()),
        ];
        assert_eq!(
            links_on(&l, &links),
            vec![
                (3, 4, "https://a.example".to_string()),
                (5, 6, "mailto:b@example.com".to_string())
            ]
        );
    }

    #[test]
    fn a_line_beside_or_below_a_link_is_not_linked() {
        let l = line("nothing here", 0.0);
        let links = vec![([0.0, 130.0, 60.0, 14.0], "https://zood.sa".to_string())];
        assert!(links_on(&l, &links).is_empty());
    }
}
