//! What Export needs from the core beyond a page's lines and paragraphs.
//!
//! - `export.tables` (Excel): what is on a page, top to bottom — the tables
//!   its rules draw or its columns of text make (`crate::tables`), and the
//!   lines around them, cut at their wide gaps. Text in reading order.
//! - `export.picture` (PowerPoint): the page drawn without its text, to go
//!   behind the slide's editable text boxes; and whether the page's text was
//!   invisible to begin with (a scan with a text layer), in which case the
//!   picture is the page as it is.
use serde::Deserialize;
use serde_json::{json, Value};
use warraq_text::Direction;

use super::{args, Reply};
use crate::tables::{page_items, LineCell, PageItem};
use crate::{CoreError, Document};

#[derive(Deserialize)]
struct Page {
    page: usize,
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
            let rulings = doc.rulings(a.page)?;
            let cells = |cells: &[LineCell]| -> Vec<Value> {
                cells
                    .iter()
                    .map(|c| json!({ "text": c.text, "x0": c.x0, "x1": c.x1, "direction": dir(c.direction) }))
                    .collect()
            };
            let items: Vec<Value> = page_items(&lines, &rulings)
                .iter()
                .map(|item| match item {
                    PageItem::Table(t) => json!({
                        "kind": "table",
                        "ruled": t.ruled,
                        "direction": dir(t.direction),
                        "widths": t.widths,
                        "rows": t.grid.iter().map(|row| row.iter().map(|cell| match cell {
                            Some(c) => json!({ "text": c.text, "rows": c.rows, "columns": c.columns }),
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
