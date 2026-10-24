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
//! - `export.image` (Images as JPG or WebP): the page drawn and written as
//!   that kind of picture here, so every host makes the same file (a
//!   webview's canvas cannot write WebP everywhere). PNG stays with the
//!   interface's own writer (`export/png.ts`).
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

#[derive(Deserialize)]
struct Image {
    page: usize,
    scale: f32,
    /// `jpeg` or `webp`.
    format: String,
    /// JPEG's quality, 1 to 100; WebP is written without loss.
    #[serde(default = "default_quality")]
    quality: u8,
}

fn default_quality() -> u8 {
    90
}

/// A drawn page (RGBA, already over white) as a JPEG or a lossless WebP.
pub(crate) fn encode_image(
    width: u32,
    height: u32,
    rgba: &[u8],
    format: &str,
    quality: u8,
) -> Result<Vec<u8>, CoreError> {
    use image::ImageEncoder;
    let pixels = (width as usize) * (height as usize);
    if width == 0 || height == 0 || rgba.len() < pixels * 4 {
        return Err(CoreError::Args("export.image: no picture to write".into()));
    }
    let mut out = Vec::new();
    let failed = |e: image::ImageError| CoreError::Args(format!("export.image: {e}"));
    match format {
        "jpeg" | "jpg" => {
            // JPEG has no transparency: the page is opaque already, so the alpha goes.
            let rgb: Vec<u8> = rgba[..pixels * 4]
                .as_chunks::<4>()
                .0
                .iter()
                .flat_map(|p| [p[0], p[1], p[2]])
                .collect();
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality.clamp(1, 100))
                .write_image(&rgb, width, height, image::ExtendedColorType::Rgb8)
                .map_err(failed)?;
        }
        "webp" => {
            image::codecs::webp::WebPEncoder::new_lossless(&mut out)
                .write_image(
                    &rgba[..pixels * 4],
                    width,
                    height,
                    image::ExtendedColorType::Rgba8,
                )
                .map_err(failed)?;
        }
        other => return Err(CoreError::Args(format!("export.image: no {other} writer"))),
    }
    Ok(out)
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
        "image" => {
            let a: Image = args(json)?;
            let bitmap = doc.render_page(a.page, a.scale)?;
            let bytes = encode_image(
                bitmap.width,
                bitmap.height,
                &bitmap.rgba,
                &a.format,
                a.quality,
            )?;
            Ok(
                Reply::of(&serde_json::json!({ "width": bitmap.width, "height": bitmap.height }))?
                    .with_blob(bytes),
            )
        }
        _ => Err(CoreError::UnknownOp(format!("export.{name}"))),
    }
}

#[cfg(test)]
mod image_tests {
    use super::encode_image;

    fn page() -> Vec<u8> {
        // 4 by 3, white with one red pixel.
        let mut rgba = vec![255u8; 4 * 3 * 4];
        rgba[4..8].copy_from_slice(&[255, 0, 0, 255]);
        rgba
    }

    #[test]
    fn writes_a_jpeg() {
        let bytes = encode_image(4, 3, &page(), "jpeg", 90).unwrap();
        assert_eq!(&bytes[..3], &[0xff, 0xd8, 0xff]);
        let back = image::load_from_memory(&bytes).unwrap();
        assert_eq!((back.width(), back.height()), (4, 3));
    }

    #[test]
    fn writes_a_lossless_webp() {
        let bytes = encode_image(4, 3, &page(), "webp", 90).unwrap();
        assert_eq!(&bytes[..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WEBP");
        let back = image::load_from_memory(&bytes).unwrap().to_rgba8();
        assert_eq!(back.get_pixel(1, 0).0, [255, 0, 0, 255]);
        assert_eq!(back.get_pixel(0, 0).0, [255, 255, 255, 255]);
    }

    #[test]
    fn refuses_what_it_cannot_write() {
        assert!(encode_image(4, 3, &page(), "gif", 90).is_err());
        assert!(encode_image(0, 3, &page(), "jpeg", 90).is_err());
        assert!(encode_image(40, 30, &page(), "webp", 90).is_err());
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
