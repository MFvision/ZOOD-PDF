//! Editable text blocks, replacing a block's text with reflow, and adding text boxes.
//!
//! Blocks are warraq-text's logical-order paragraphs (artifacts excluded). Each text-showing
//! operator of the page is assigned to the paragraph containing its glyphs; a block is editable
//! when it owns at least one operator and no operator also draws another paragraph. Replacing
//! removes exactly those operators (whole `BT…ET` groups when every show in them goes, keeping
//! state operators; otherwise a number-only `TJ` keeps the text position for the shows that stay)
//! and lays the new text into the block's box.

use serde::Serialize;
use warraq_pdf::Pdf;
use warraq_text::bidi::Dir;
use warraq_text::{extract_pages, DocSource, LayoutOptions};

use crate::content::{fmt_num, Splice};
use crate::error::{EditError, Result};
use crate::fonts::{family_of, original_face, write_face, Face, Family};
use crate::geom::Rect;
use crate::layout::{layout, Align, Laid, Request};
use crate::page::{load, write, PageContent};
use crate::scan::{scan, Scan, ShowKind};

/// A text block as listed for the UI (top-left page coordinates).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TextBlock {
    pub id: usize,
    pub text: String,
    pub bbox: Rect,
    pub dir: &'static str,
    pub size: f64,
    pub line_height: f64,
    pub lines: usize,
    /// `#rrggbb`
    pub color: String,
    pub bold: bool,
    pub italic: bool,
    pub family: &'static str,
    pub font: String,
    pub editable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
}

/// A block and the show operators (indices into `Scan::shows`) that draw it.
#[derive(Debug, Clone)]
pub struct Planned {
    pub block: TextBlock,
    pub shows: Vec<usize>,
    pub fill: [f64; 3],
}

fn hex_colour(c: [f64; 3]) -> String {
    let b = |v: f64| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
    format!("#{:02x}{:02x}{:02x}", b(c[0]), b(c[1]), b(c[2]))
}

/// Parse `#rrggbb` (or `#rgb`).
pub fn parse_colour(s: &str) -> Option<[f64; 3]> {
    let h = s.strip_prefix('#')?;
    let v: Vec<u8> = match h.len() {
        6 => (0..3)
            .map(|i| u8::from_str_radix(h.get(i * 2..i * 2 + 2)?, 16).ok())
            .collect::<Option<_>>()?,
        3 => (0..3)
            .map(|i| u8::from_str_radix(h.get(i..=i)?, 16).ok().map(|x| x * 17))
            .collect::<Option<_>>()?,
        _ => return None,
    };
    Some([
        f64::from(*v.first()?) / 255.0,
        f64::from(*v.get(1)?) / 255.0,
        f64::from(*v.get(2)?) / 255.0,
    ])
}

/// Blocks of page `index` with their operators.
pub fn plan(pdf: &Pdf, index: usize) -> Result<(PageContent, Scan, Vec<Planned>)> {
    let pc = load(pdf, index)?;
    let sc = scan(pdf, &pc)?;
    let src = DocSource::borrowed(pdf.document());
    let opts = LayoutOptions {
        glyphs: false,
        include_hidden: true,
        include_artifacts: false,
    };
    let pages =
        extract_pages(&src, &[index], &opts).map_err(|e| EditError::Params(e.to_string()))?;
    let Some(pt) = pages.into_iter().next() else {
        return Ok((pc, sc, Vec::new()));
    };
    let paras: Vec<_> = pt.paragraphs().cloned().collect();
    // Line boxes per paragraph (top-left coordinates), slightly grown.
    let boxes: Vec<Vec<Rect>> = paras
        .iter()
        .map(|p| {
            p.lines
                .iter()
                .map(|l| {
                    let r = Rect::new(l.bbox.x0, l.bbox.y0, l.bbox.x1, l.bbox.y1);
                    let dy = (r.height() * 0.2).max(0.5);
                    r.expand(1.0, dy)
                })
                .collect()
        })
        .collect();
    let mut owners: Vec<Vec<usize>> = vec![Vec::new(); paras.len()];
    let mut shared = vec![false; paras.len()];
    for (si, show) in sc.shows.iter().enumerate() {
        if show.artifact {
            continue;
        }
        let mut votes: Vec<usize> = vec![0; paras.len()];
        for g in &show.glyphs {
            if g.bbox.width() <= 0.0 && g.bbox.height() <= 0.0 {
                continue;
            }
            let tl = pc.space.rect_to_tl(&g.bbox);
            let (cx, cy) = tl.center();
            if let Some(p) = boxes
                .iter()
                .position(|bs| bs.iter().any(|b| b.contains(cx, cy)))
            {
                if let Some(v) = votes.get_mut(p) {
                    *v += 1;
                }
            }
        }
        let hit: Vec<usize> = votes
            .iter()
            .enumerate()
            .filter(|(_, v)| **v > 0)
            .map(|(i, _)| i)
            .collect();
        if hit.len() > 1 {
            for &p in &hit {
                if let Some(s) = shared.get_mut(p) {
                    *s = true;
                }
            }
        }
        if let Some(best) = votes
            .iter()
            .enumerate()
            .max_by_key(|(_, v)| **v)
            .filter(|(_, v)| **v > 0)
            .map(|(i, _)| i)
        {
            if let Some(o) = owners.get_mut(best) {
                o.push(si);
            }
        }
    }
    let mut out = Vec::new();
    for (i, p) in paras.iter().enumerate() {
        let words: Vec<_> = p.lines.iter().flat_map(|l| l.words.iter()).collect();
        let n = words.len().max(1) as f64;
        let size = {
            let mut sizes: Vec<f64> = words.iter().map(|w| w.size).collect();
            sizes.sort_by(f64::total_cmp);
            sizes.get(sizes.len() / 2).copied().unwrap_or(12.0)
        };
        let bold = words.iter().filter(|w| w.bold).count() as f64 / n > 0.5;
        let italic = words.iter().filter(|w| w.italic).count() as f64 / n > 0.5;
        let hidden = !words.is_empty() && words.iter().all(|w| w.hidden);
        let line_height = match p.lines.as_slice() {
            [first, .., last] if p.lines.len() >= 2 => {
                (last.bbox.y1 - first.bbox.y1) / (p.lines.len() - 1) as f64
            }
            _ => size * 1.4,
        };
        let shows = owners.get(i).cloned().unwrap_or_default();
        let first = shows.first().and_then(|s| sc.shows.get(*s));
        let fill = first.map_or([0.0; 3], |s| s.fill);
        let font = first.map(|s| s.font_base.clone()).unwrap_or_default();
        let reason = if hidden {
            Some("hidden")
        } else if shows.is_empty() {
            Some("no_operators")
        } else if shared.get(i).copied().unwrap_or(false) {
            Some("shared_operators")
        } else if shows
            .iter()
            .any(|s| sc.shows.get(*s).is_some_and(|x| x.vertical))
        {
            Some("vertical")
        } else {
            None
        };
        out.push(Planned {
            block: TextBlock {
                id: i,
                text: p.text.clone(),
                bbox: Rect::new(p.bbox.x0, p.bbox.y0, p.bbox.x1, p.bbox.y1).rounded(),
                dir: if p.dir == Dir::Rtl { "rtl" } else { "ltr" },
                size: (size * 100.0).round() / 100.0,
                line_height: (line_height.max(size) * 100.0).round() / 100.0,
                lines: p.lines.len(),
                color: hex_colour(fill),
                bold,
                italic,
                family: if family_of(&font) == Family::Sans {
                    "sans"
                } else {
                    "serif"
                },
                font,
                editable: reason.is_none(),
                reason,
            },
            shows,
            fill,
        });
    }
    Ok((pc, sc, out))
}

/// List the text blocks of a page.
pub fn blocks(pdf: &Pdf, index: usize) -> Result<Vec<TextBlock>> {
    Ok(plan(pdf, index)?.2.into_iter().map(|p| p.block).collect())
}

/// Splices removing the show operators `remove` (indices into `sc.shows`).
pub fn removal_splices(sc: &Scan, remove: &[usize]) -> Vec<Splice> {
    let ops = &sc.content.ops;
    let removed_ops: std::collections::BTreeSet<usize> = remove
        .iter()
        .filter_map(|s| sc.shows.get(*s))
        .map(|s| s.op)
        .collect();
    let mut splices = Vec::new();
    let mut done = std::collections::BTreeSet::new();
    // Whole BT…ET groups whose every show goes.
    for bt in &sc.bts {
        let Some(et) = bt.et else { continue };
        let inside: Vec<usize> = sc
            .shows
            .iter()
            .filter(|s| s.op > bt.bt && s.op < et)
            .map(|s| s.op)
            .collect();
        if inside.is_empty() || !inside.iter().all(|o| removed_ops.contains(o)) {
            continue;
        }
        for (i, op) in ops.iter().enumerate().take(et + 1).skip(bt.bt) {
            let drop = matches!(
                op.operator.as_slice(),
                b"BT" | b"ET" | b"Td" | b"TD" | b"Tm" | b"T*" | b"Tj" | b"TJ" | b"'" | b"\""
            );
            if drop {
                splices.push(Splice {
                    range: op.span.clone(),
                    with: Vec::new(),
                });
                done.insert(i);
            }
        }
    }
    for s in remove.iter().filter_map(|s| sc.shows.get(*s)) {
        if done.contains(&s.op) {
            continue;
        }
        let Some(op) = ops.get(s.op) else { continue };
        // Does a kept show follow before the text position is reset?
        let mut needs_advance = false;
        for next in ops.iter().enumerate().skip(s.op + 1) {
            match next.1.operator.as_slice() {
                b"Tj" | b"TJ" if !removed_ops.contains(&next.0) => {
                    needs_advance = true;
                    break;
                }
                b"Td" | b"TD" | b"Tm" | b"T*" | b"'" | b"\"" | b"ET" | b"BT" => break,
                _ => {}
            }
        }
        let mut with = String::new();
        if s.kind == ShowKind::DQuote {
            let n = op.nums();
            if let [aw, ac, ..] = n.as_slice() {
                with.push_str(&format!("{} Tw {} Tc ", fmt_num(*aw), fmt_num(*ac)));
            }
        }
        if matches!(s.kind, ShowKind::Quote | ShowKind::DQuote) {
            with.push_str("T* ");
        }
        if needs_advance && s.size.abs() > 1e-9 && s.advance.abs() > 1e-9 && !s.vertical {
            with.push_str(&format!("[{}] TJ", fmt_num(-s.advance * 1000.0 / s.size)));
        }
        splices.push(Splice {
            range: op.span.clone(),
            with: with.trim_end().as_bytes().to_vec(),
        });
    }
    splices
}

/// Where new text goes and how it looks.
#[derive(Debug, Clone)]
pub struct TextStyle {
    pub size: f64,
    pub line_height: Option<f64>,
    pub align: Align,
    pub rtl: Option<bool>,
    pub family: Family,
    pub bold: bool,
    pub fill: [f64; 3],
}

/// Summary of written text.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteReport {
    pub bbox: Rect,
    pub lines: usize,
    pub fonts: Vec<String>,
    pub reused_original_font: bool,
}

fn write_laid(
    pdf: &mut Pdf,
    page_id: lopdf::ObjectId,
    laid: &Laid,
    fill: [f64; 3],
) -> Result<(Vec<u8>, Vec<String>)> {
    let mut written = Vec::new();
    let mut names = Vec::new();
    for (face, used) in laid.faces.iter().zip(laid.used()) {
        names.push(match &face.source {
            crate::fonts::FaceSource::Bundled(b) => b.base_name().to_string(),
            crate::fonts::FaceSource::Original { .. } => "original".to_string(),
        });
        written.push(write_face(pdf, page_id, face, &used)?);
    }
    Ok((laid.content(&written, fill), names))
}

/// Replace the text of block `id` on page `index` by `text` (empty: delete it).
pub fn replace(
    pdf: &mut Pdf,
    index: usize,
    id: usize,
    text: &str,
    expect: Option<&str>,
    align: Option<Align>,
) -> Result<WriteReport> {
    let (pc, sc, planned) = plan(pdf, index)?;
    let p = planned
        .get(id)
        .ok_or_else(|| EditError::NotFound(format!("text block {id}")))?;
    if let Some(e) = expect {
        if e.trim() != p.block.text.trim() {
            return Err(EditError::Stale);
        }
    }
    if let Some(r) = p.block.reason {
        return Err(EditError::NotEditable(r.into()));
    }
    let splices = removal_splices(&sc, &p.shows);
    let b = pc.space.rect_to_user(&p.block.bbox);
    let text = text.trim_end_matches(['\n', ' ']);
    if text.trim().is_empty() {
        write(pdf, &pc, &splices, None)?;
        return Ok(WriteReport {
            bbox: p.block.bbox,
            lines: 0,
            fonts: Vec::new(),
            reused_original_font: false,
        });
    }
    // The page's own font, if every operator of the block used it and it covers the new text.
    let mut font_ids = p
        .shows
        .iter()
        .filter_map(|s| sc.shows.get(*s))
        .map(|s| (s.font_id, s.font_name.clone()));
    let original: Option<Face> = match font_ids.next() {
        Some((Some(fid), name)) if font_ids.all(|(f, _)| f == Some(fid)) => {
            original_face(pdf, fid, &name, text)
        }
        _ => None,
    };
    let block_rtl = p.block.dir == "rtl";
    let first_strong = text
        .chars()
        .find_map(warraq_text::bidi::strong_dir)
        .map(|d| d == Dir::Rtl);
    let req = Request {
        text,
        x0: b.x0,
        top: b.y1,
        width: b.width().max(p.block.size * 2.0),
        size: p.block.size,
        line_height: Some(p.block.line_height),
        align: align.unwrap_or(Align::Start),
        rtl: Some(first_strong.unwrap_or(block_rtl)),
        family: if p.block.family == "sans" {
            Family::Sans
        } else {
            Family::Serif
        },
        bold: p.block.bold,
        original: original.as_ref(),
    };
    let laid = layout(&req)?;
    let (content, fonts) = write_laid(pdf, pc.page_id, &laid, p.fill)?;
    write(pdf, &pc, &splices, Some(&content))?;
    Ok(WriteReport {
        bbox: pc.space.rect_to_tl(&laid.bbox).rounded(),
        lines: laid.lines.len(),
        fonts,
        reused_original_font: original.is_some(),
    })
}

/// Add a text box whose top-left corner is `(x, y)` (top-left page coordinates), `width` wide.
pub fn add(
    pdf: &mut Pdf,
    index: usize,
    x: f64,
    y: f64,
    width: f64,
    text: &str,
    style: &TextStyle,
) -> Result<WriteReport> {
    if text.trim().is_empty() {
        return Err(EditError::Params("text is empty".into()));
    }
    let pc = load(pdf, index)?;
    let (ux, uy) = pc.space.to_user(x, y);
    let req = Request {
        text,
        x0: ux,
        top: uy,
        width,
        size: style.size,
        line_height: style.line_height,
        align: style.align,
        rtl: style.rtl,
        family: style.family,
        bold: style.bold,
        original: None,
    };
    let laid = layout(&req)?;
    let (content, fonts) = write_laid(pdf, pc.page_id, &laid, style.fill)?;
    write(pdf, &pc, &[], Some(&content))?;
    Ok(WriteReport {
        bbox: pc.space.rect_to_tl(&laid.bbox).rounded(),
        lines: laid.lines.len(),
        fonts,
        reused_original_font: false,
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn colours() {
        assert_eq!(parse_colour("#ff0000"), Some([1.0, 0.0, 0.0]));
        assert_eq!(parse_colour("#0f0"), Some([0.0, 1.0, 0.0]));
        assert_eq!(parse_colour("red"), None);
        assert_eq!(hex_colour([0.0, 0.5, 1.0]), "#0080ff");
    }
}
