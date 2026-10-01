//! Text operations on existing pages: append a shaped line, replace a word.
use crate::fonts::{embed_subset_font, FontSubset};
use crate::show::{show_line, ShownLine};
use crate::{Error, PdfDocument, Result};
use lopdf::content::{Content, Operation};
use lopdf::{Object, ObjectId, StringFormat};
use warraq_text::{
    layout_paragraph, Alignment, Direction, LayoutBox, LayoutStyle, ShapedGlyph, Shaper,
};

/// Mark the page and everything it references by id (content streams, resources,
/// font dictionaries) as changed, so an incremental save carries them.
pub(crate) fn mark_page_objects(pdf: &mut PdfDocument, page_id: ObjectId) {
    pdf.mark_touched(page_id);
    let mut ids: Vec<ObjectId> = vec![];
    if let Ok(page) = pdf.doc.get_dictionary(page_id) {
        for key in [b"Contents".as_ref(), b"Resources".as_ref()] {
            match page.get(key) {
                Ok(Object::Reference(id)) => ids.push(*id),
                Ok(Object::Array(a)) => ids.extend(a.iter().filter_map(|o| o.as_reference().ok())),
                _ => {}
            }
        }
        if let Ok(res) = page
            .get(b"Resources")
            .and_then(|o| o.as_reference())
            .and_then(|id| pdf.doc.get_dictionary(id))
        {
            if let Ok(Object::Reference(id)) = res.get(b"Font") {
                ids.push(*id);
            }
        }
    }
    for id in ids {
        pdf.mark_touched(id);
    }
}

/// Register `font_id` under a fresh resource name on the page; returns the name.
pub(crate) fn add_font_resource(
    pdf: &mut PdfDocument,
    page_id: ObjectId,
    font_id: ObjectId,
) -> Result<Vec<u8>> {
    let page = pdf
        .doc
        .get_dictionary(page_id)
        .map_err(|e| Error::Parse(e.to_string()))?
        .clone();
    let res_ref = page
        .get(b"Resources")
        .ok()
        .and_then(|o| o.as_reference().ok());
    let mut res = match res_ref {
        Some(id) => pdf
            .doc
            .get_dictionary(id)
            .map_err(|e| Error::Parse(e.to_string()))?
            .clone(),
        None => page
            .get(b"Resources")
            .ok()
            .and_then(|o| o.as_dict().ok())
            .cloned()
            .unwrap_or_default(),
    };
    let fonts_ref = res.get(b"Font").ok().and_then(|o| o.as_reference().ok());
    let mut fonts = match fonts_ref {
        Some(id) => pdf
            .doc
            .get_dictionary(id)
            .map_err(|e| Error::Parse(e.to_string()))?
            .clone(),
        None => res
            .get(b"Font")
            .ok()
            .and_then(|o| o.as_dict().ok())
            .cloned()
            .unwrap_or_default(),
    };
    let mut n = 1;
    while fonts.has(format!("FW{n}").as_bytes()) {
        n += 1;
    }
    let name = format!("FW{n}").into_bytes();
    fonts.set(name.clone(), Object::Reference(font_id));
    match fonts_ref {
        Some(id) => {
            *pdf.doc
                .get_dictionary_mut(id)
                .map_err(|e| Error::Parse(e.to_string()))? = fonts
        }
        None => res.set(b"Font".to_vec(), Object::Dictionary(fonts)),
    }
    match res_ref {
        Some(id) => {
            if fonts_ref.is_none() {
                *pdf.doc
                    .get_dictionary_mut(id)
                    .map_err(|e| Error::Parse(e.to_string()))? = res;
            }
        }
        None => pdf
            .doc
            .get_dictionary_mut(page_id)
            .map_err(|e| Error::Parse(e.to_string()))?
            .set(b"Resources".to_vec(), Object::Dictionary(res)),
    }
    Ok(name)
}

/// Operators that restore the graphics state a page's content stream leaves
/// dangling, so appended drawing happens in plain PDF user space.
///
/// These must be emitted *before* the caller's own `q`, because they pop the
/// page's stack, not ours. Closing the dangling saves is what also drops any
/// clip path still in effect — undoing the transform alone is not enough, and
/// text appended to a clipped page was invisible until this was fixed.
pub(crate) fn reset_state_ops(pdf: &PdfDocument, page_id: ObjectId) -> Vec<Operation> {
    let Ok(content) = Content::decode(&pdf.doc.get_page_content(page_id)) else {
        return vec![];
    };
    let depth = crate::text_walk::unbalanced_q(&content.operations);
    if depth > 0 {
        return std::iter::repeat_with(|| Operation::new("Q", vec![]))
            .take(depth)
            .collect();
    }
    // Balanced, but a `cm` outside any `q` still applies.
    let ctm = crate::text_walk::final_ctm(&content.operations);
    if ctm == crate::text_walk::Matrix::IDENTITY {
        return vec![];
    }
    match ctm.invert() {
        Some(i) => vec![Operation::new(
            "cm",
            i.0.iter().map(|v| Object::Real(*v)).collect::<Vec<_>>(),
        )],
        None => vec![],
    }
}

/// TJ array items for shaped glyphs (visual order), correcting each advance to the shaped one.
pub(crate) fn tj_items(
    subset: &FontSubset,
    shaper: &Shaper,
    glyphs: &[ShapedGlyph],
) -> Vec<Object> {
    let mut items = vec![];
    for g in glyphs {
        items.push(Object::String(
            subset.cid(g.gid).to_be_bytes().to_vec(),
            StringFormat::Hexadecimal,
        ));
        let adj = shaper.advance(g.gid) - g.x_advance;
        if adj.abs() > 0.01 {
            items.push(Object::Real(adj));
        }
    }
    items
}

/// Append one right-aligned (for RTL) or left-aligned line of text to a page using `font`.
pub fn append_line(
    pdf: &mut PdfDocument,
    page_index: usize,
    text: &str,
    font: &[u8],
    size: f32,
    x_edge: f32,
    y: f32,
) -> Result<()> {
    append_line_in_color(pdf, page_index, text, font, size, x_edge, y, None)
}

/// `append_line` in a colour: `color` is RGB from 0 to 1, set inside the
/// line's own `q`/`Q` so nothing after it is painted in that colour. `None`
/// leaves the fill colour the page's content ends with, as `append_line` does.
#[allow(clippy::too_many_arguments)]
pub fn append_line_in_color(
    pdf: &mut PdfDocument,
    page_index: usize,
    text: &str,
    font: &[u8],
    size: f32,
    x_edge: f32,
    y: f32,
    color: Option<[f32; 3]>,
) -> Result<()> {
    let shaper = Shaper::new(font).map_err(|e| Error::Font(e.to_string()))?;
    let glyphs = shaper.shape_line(text);
    let subset = FontSubset::build(font, &shaper, &glyphs)?;
    let font_id = embed_subset_font(&mut pdf.doc, &shaper, &subset, "Warraq");
    let page_id = pdf.page_id(page_index)?;
    let name = add_font_resource(pdf, page_id, font_id)?;
    let width: f32 = glyphs.iter().map(|g| g.x_advance).sum::<f32>() * size / 1000.0;
    let x = if warraq_text::base_direction(text) == Direction::Rtl {
        x_edge - width
    } else {
        x_edge
    };
    let mut ops = reset_state_ops(pdf, page_id);
    ops.push(Operation::new("q", vec![]));
    ops.push(Operation::new("BT", vec![]));
    ops.push(Operation::new(
        "Tf",
        vec![Object::Name(name), Object::Real(size)],
    ));
    if let Some([r, g, b]) = color {
        ops.push(Operation::new(
            "rg",
            vec![Object::Real(r), Object::Real(g), Object::Real(b)],
        ));
    }
    show_line(
        &mut ops,
        &subset,
        &shaper,
        &ShownLine {
            glyphs: &glyphs,
            matrix: [1.0, 0.0, 0.0, 1.0, x, y],
            size,
            space_stretch: 0.0,
        },
    );
    ops.push(Operation::new("ET", vec![]));
    ops.push(Operation::new("Q", vec![]));
    let mut content = pdf.doc.get_page_content(page_id);
    content.push(b'\n');
    content.extend(
        Content { operations: ops }
            .encode()
            .map_err(|e| Error::Edit(e.to_string()))?,
    );
    pdf.doc
        .change_page_content(page_id, content)
        .map_err(|e| Error::Edit(e.to_string()))?;
    mark_page_objects(pdf, page_id);
    Ok(())
}

/// Text (via ToUnicode) of the first font resource of a page: (resource name, code → text).
fn first_font_map(
    pdf: &PdfDocument,
    page_id: ObjectId,
) -> Result<(Vec<u8>, std::collections::BTreeMap<u32, String>)> {
    let page = pdf
        .doc
        .get_dictionary(page_id)
        .map_err(|e| Error::Parse(e.to_string()))?;
    let res = match page
        .get(b"Resources")
        .map_err(|e| Error::Parse(e.to_string()))?
    {
        Object::Reference(id) => pdf
            .doc
            .get_dictionary(*id)
            .map_err(|e| Error::Parse(e.to_string()))?
            .clone(),
        o => o
            .as_dict()
            .map_err(|e| Error::Parse(e.to_string()))?
            .clone(),
    };
    let fonts = match res.get(b"Font").map_err(|e| Error::Parse(e.to_string()))? {
        Object::Reference(id) => pdf
            .doc
            .get_dictionary(*id)
            .map_err(|e| Error::Parse(e.to_string()))?
            .clone(),
        o => o
            .as_dict()
            .map_err(|e| Error::Parse(e.to_string()))?
            .clone(),
    };
    let (name, fref) = fonts
        .iter()
        .next()
        .map(|(k, v)| (k.clone(), v.as_reference()))
        .ok_or_else(|| Error::Edit("page has no fonts".into()))?;
    let fdict = pdf
        .doc
        .get_dictionary(fref.map_err(|e| Error::Parse(e.to_string()))?)
        .map_err(|e| Error::Parse(e.to_string()))?;
    let tu = fdict
        .get(b"ToUnicode")
        .ok()
        .and_then(|o| o.as_reference().ok())
        .and_then(|id| pdf.doc.get_object(id).ok())
        .and_then(|o| o.as_stream().ok())
        .and_then(|s| s.decompressed_content().ok())
        .map(|b| crate::tounicode::parse(&b))
        .unwrap_or_default();
    Ok((name, tu))
}

/// Replace the first occurrence of `old` on a page with `new`, shaped with `font`.
/// The word is located through the page's ToUnicode map across all text-showing
/// operators (it may span several TJ items, e.g. with cursive attachment).
pub fn replace_word(
    pdf: &mut PdfDocument,
    page_index: usize,
    old: &str,
    new: &str,
    font: &[u8],
) -> Result<()> {
    let page_id = pdf.page_id(page_index)?;
    let (font_name, tu) = first_font_map(pdf, page_id)?;
    let content = Content::decode(&pdf.doc.get_page_content(page_id))
        .map_err(|e| Error::Edit(e.to_string()))?;
    let ops = content.operations;
    let mut flat: Vec<(usize, usize, usize, u16)> = vec![];
    let items_of = |op: &Operation| -> Vec<Object> {
        if op.operator == "TJ" {
            op.operands
                .first()
                .and_then(|o| o.as_array().ok())
                .cloned()
                .unwrap_or_default()
        } else {
            op.operands.first().cloned().into_iter().collect()
        }
    };
    for (oi, op) in ops.iter().enumerate() {
        if op.operator == "TJ" || op.operator == "Tj" {
            for (ii, item) in items_of(op).iter().enumerate() {
                if let Object::String(bytes, _) = item {
                    for (k, c) in bytes.chunks(2).enumerate() {
                        flat.push((
                            oi,
                            ii,
                            k * 2,
                            u16::from_be_bytes([c[0], *c.get(1).unwrap_or(&0)]),
                        ));
                    }
                }
            }
        }
    }
    let chars: Vec<char> = flat
        .iter()
        .map(|(_, _, _, c)| {
            tu.get(&(*c as u32))
                .and_then(|s| s.chars().next())
                .unwrap_or('\u{0}')
        })
        .collect();
    let old_chars: Vec<char> = old.chars().collect();
    let old_rev: Vec<char> = old.chars().rev().collect();
    let find = |pat: &[char]| chars.windows(pat.len()).position(|w| w == pat);
    let pos = find(&old_chars)
        .or_else(|| find(&old_rev))
        .ok_or_else(|| Error::Edit(format!("'{old}' not found on page {page_index}")))?;
    let (first, last) = (flat[pos], flat[pos + old_chars.len() - 1]);
    let shaper = Shaper::new(font).map_err(|e| Error::Font(e.to_string()))?;
    let glyphs = shaper.shape_run(new, warraq_text::base_direction(new));
    let subset = FontSubset::build(font, &shaper, &glyphs)?;
    let font_id = embed_subset_font(&mut pdf.doc, &shaper, &subset, "WarraqEdit");
    let new_name = add_font_resource(pdf, page_id, font_id)?;
    let mut new_ops: Vec<Operation> = vec![];
    let mut cur_size = 12.0f32;
    for (oi, op) in ops.iter().enumerate() {
        if op.operator == "Tf" {
            if let Some(Object::Real(s)) = op.operands.get(1) {
                cur_size = *s;
            }
            if let Some(Object::Integer(s)) = op.operands.get(1) {
                cur_size = *s as f32;
            }
        }
        if oi < first.0 || oi > last.0 {
            new_ops.push(op.clone());
            continue;
        }
        if oi == first.0 {
            let items = items_of(op);
            let mut before: Vec<Object> = items[..first.1].to_vec();
            if let Some(Object::String(bytes, _)) = items.get(first.1) {
                if first.2 > 0 {
                    before.push(Object::String(
                        bytes[..first.2].to_vec(),
                        StringFormat::Hexadecimal,
                    ));
                }
            }
            if !before.is_empty() {
                new_ops.push(Operation::new("TJ", vec![Object::Array(before)]));
            }
            new_ops.push(Operation::new(
                "Tf",
                vec![Object::Name(new_name.clone()), Object::Real(cur_size)],
            ));
            new_ops.push(Operation::new(
                "TJ",
                vec![Object::Array(tj_items(&subset, &shaper, &glyphs))],
            ));
            new_ops.push(Operation::new(
                "Tf",
                vec![Object::Name(font_name.clone()), Object::Real(cur_size)],
            ));
        }
        if oi == last.0 {
            let items = items_of(op);
            let mut after: Vec<Object> = vec![];
            if let Some(Object::String(bytes, _)) = items.get(last.1) {
                if last.2 + 2 < bytes.len() {
                    after.push(Object::String(
                        bytes[last.2 + 2..].to_vec(),
                        StringFormat::Hexadecimal,
                    ));
                }
            }
            after.extend_from_slice(&items[last.1 + 1..]);
            if !after.is_empty() {
                new_ops.push(Operation::new("TJ", vec![Object::Array(after)]));
            }
        }
    }
    let encoded = Content {
        operations: new_ops,
    }
    .encode()
    .map_err(|e| Error::Edit(e.to_string()))?;
    pdf.doc
        .change_page_content(page_id, encoded)
        .map_err(|e| Error::Edit(e.to_string()))?;
    mark_page_objects(pdf, page_id);
    Ok(())
}

/// Outcome of a paragraph replacement.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Replacement {
    pub lines_drawn: usize,
    /// The size actually used, which may be smaller than requested.
    pub font_size: f32,
    /// True when the text had to be shrunk to fit the box.
    pub shrunk: bool,
    /// True when it still does not fit and runs past the box: the caller should warn.
    pub overflowed: bool,
}

/// What to draw in place of an existing paragraph.
pub struct ParagraphEdit<'a> {
    /// The paragraph box in PDF user space (x of the left edge, y of the BOTTOM edge, width, height).
    pub rect: (f32, f32, f32, f32),
    /// Baseline of the first line in PDF user space (y up).
    pub first_baseline: f32,
    pub text: &'a str,
    /// Font to shape and embed. Reusing the document's own font needs its full
    /// (unsubsetted) file, which a PDF rarely carries, so callers pass a bundled
    /// face from the fallback chain and tell the user when a substitution happened.
    pub font: &'a [u8],
    pub font_size: f32,
    /// Distance between baselines, positive (lines run down the page).
    pub leading: f32,
    pub direction: Direction,
    pub alignment: Alignment,
}

/// Blank every text-showing operator whose pen origin lies inside `rect`
/// (PDF user space: x, y_bottom, width, height), leaving the operators in place
/// so that no other run's text matrix moves. Returns how many were blanked.
pub fn erase_area(
    pdf: &mut PdfDocument,
    page_index: usize,
    rect: (f32, f32, f32, f32),
) -> Result<usize> {
    let page_id = pdf.page_id(page_index)?;
    let content = Content::decode(&pdf.doc.get_page_content(page_id))
        .map_err(|e| Error::Edit(e.to_string()))?;
    let mut ops = content.operations;
    let runs = crate::text_walk::locate_show_runs(&ops);
    let (x0, y0, w, h) = rect;
    let (x1, y1) = (x0 + w, y0 + h);
    let mut blanked = 0;
    for r in runs {
        // A run belongs to the box when its origin is inside, with a small
        // tolerance so a baseline sitting exactly on an edge still counts —
        // and more below: the box's bottom is the last line's baseline plus a
        // little, and Chrome sets some Arabic glyphs as runs of their own,
        // lowered by the font's positioning, which left two letters of a
        // replaced heading on the page. Half a size below still stops well
        // short of the next line, whose baseline is at least a leading down.
        let size = r.size.max(1.0);
        let (pad, below) = (0.2 * size, 0.5 * size);
        if r.x >= x0 - pad && r.x <= x1 + pad && r.y >= y0 - below && r.y <= y1 + pad {
            let op = &mut ops[r.op_index];
            match op.operator.as_str() {
                "TJ" => op.operands = vec![Object::Array(vec![])],
                _ => op.operands = vec![Object::String(vec![], StringFormat::Hexadecimal)],
            }
            blanked += 1;
        }
    }
    let encoded = Content { operations: ops }
        .encode()
        .map_err(|e| Error::Edit(e.to_string()))?;
    pdf.doc
        .change_page_content(page_id, encoded)
        .map_err(|e| Error::Edit(e.to_string()))?;
    mark_page_objects(pdf, page_id);
    Ok(blanked)
}

/// Erase a paragraph and draw `edit.text` in its place, reflowed to the box width
/// with correct shaping and bidi. Returns the number of lines drawn.
pub fn replace_paragraph(
    pdf: &mut PdfDocument,
    page_index: usize,
    edit: &ParagraphEdit<'_>,
) -> Result<Replacement> {
    erase_area(pdf, page_index, edit.rect)?;
    let shaper = Shaper::new(edit.font).map_err(|e| Error::Font(e.to_string()))?;
    let (x0, _, w, box_height) = edit.rect;
    // Replacement text is rarely the same length as what it replaces. Rather than
    // letting it run into whatever is below, shrink it to fit the box the user
    // pointed at — and say so when even the smallest size still does not fit.
    let (font_size, leading, shrunk, overflowed) = {
        let (mut size, mut lead) = (edit.font_size, edit.leading);
        let fits = |size: f32, lead: f32| -> bool {
            let area = LayoutBox {
                left: x0,
                right: x0 + w,
                first_baseline: edit.first_baseline,
            };
            let style = LayoutStyle {
                font_size: size,
                leading: -lead,
                direction: edit.direction,
                alignment: edit.alignment,
            };
            let lines = layout_paragraph(&shaper, edit.text, &area, &style)
                .len()
                .max(1);
            (lines as f32 - 1.0) * lead + size <= box_height + 0.5
        };
        let mut steps = 0;
        while !fits(size, lead) && size > edit.font_size * 0.6 {
            size *= 0.95;
            lead *= 0.95;
            steps += 1;
        }
        (size, lead, steps > 0, !fits(size, lead))
    };
    // lines run DOWN the page, so the baseline step is negative in PDF user space
    let area = LayoutBox {
        left: x0,
        right: x0 + w,
        first_baseline: edit.first_baseline,
    };
    // The size it fitted at, not the size asked for: shrinking only the
    // leading, as this once did, still ran the text out of its box.
    let style = LayoutStyle {
        font_size,
        leading: -leading,
        direction: edit.direction,
        alignment: edit.alignment,
    };
    let lines = layout_paragraph(&shaper, edit.text, &area, &style);
    if lines.is_empty() {
        return Ok(Replacement {
            lines_drawn: 0,
            font_size,
            shrunk,
            overflowed,
        });
    }
    let all: Vec<ShapedGlyph> = lines
        .iter()
        .flat_map(|l| l.glyphs.iter().cloned())
        .collect();
    let subset = FontSubset::build(edit.font, &shaper, &all)?;
    let font_id = embed_subset_font(&mut pdf.doc, &shaper, &subset, "WarraqReflow");
    let page_id = pdf.page_id(page_index)?;
    let name = add_font_resource(pdf, page_id, font_id)?;
    let mut ops = reset_state_ops(pdf, page_id);
    ops.push(Operation::new("q", vec![]));
    ops.push(Operation::new("BT", vec![]));
    ops.push(Operation::new(
        "Tf",
        vec![Object::Name(name), Object::Real(font_size)],
    ));
    for line in &lines {
        show_line(
            &mut ops,
            &subset,
            &shaper,
            &ShownLine {
                glyphs: &line.glyphs,
                matrix: [1.0, 0.0, 0.0, 1.0, line.x, line.y],
                size: font_size,
                space_stretch: line.space_stretch,
            },
        );
    }
    ops.push(Operation::new("ET", vec![]));
    ops.push(Operation::new("Q", vec![]));
    let mut content = pdf.doc.get_page_content(page_id);
    content.push(b'\n');
    content.extend(
        Content { operations: ops }
            .encode()
            .map_err(|e| Error::Edit(e.to_string()))?,
    );
    pdf.doc
        .change_page_content(page_id, content)
        .map_err(|e| Error::Edit(e.to_string()))?;
    mark_page_objects(pdf, page_id);
    Ok(Replacement {
        lines_drawn: lines.len(),
        font_size,
        shrunk,
        overflowed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    const AMIRI: &[u8] = include_bytes!("../../../../tests/fonts/Amiri-Regular.ttf");
    fn corpus(name: &str) -> Vec<u8> {
        std::fs::read(format!(
            "{}/../../../tests/corpus/arabic/generated/{name}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap()
    }

    #[test]
    fn replace_word_embeds_a_new_subset_font_with_tounicode_and_reopens() {
        let mut d =
            PdfDocument::open(corpus("raw-amiri-cid-identity-tounicode.pdf"), None).unwrap();
        replace_word(&mut d, 0, "للتقنية", "للبرمجة", AMIRI).unwrap();
        let bytes = d.save_to_vec().unwrap();
        let d2 = PdfDocument::open(bytes, None).unwrap();
        let (_, tu) = first_font_map(&d2, d2.page_id(0).unwrap()).unwrap();
        assert!(!tu.is_empty());
        let content =
            String::from_utf8_lossy(&d2.doc.get_page_content(d2.page_id(0).unwrap())).to_string();
        assert!(
            content.contains("/FW1"),
            "new font resource must be used in the content stream"
        );
        assert!(matches!(
            replace_word(&mut d, 0, "غير موجود", "x", AMIRI),
            Err(Error::Edit(_))
        ));
    }

    #[test]
    fn erase_area_blanks_only_the_runs_inside_the_box() {
        let mut d =
            PdfDocument::open(corpus("raw-amiri-cid-identity-tounicode.pdf"), None).unwrap();
        let page_id = d.page_id(0).unwrap();
        let before = crate::text_walk::locate_show_runs(
            &Content::decode(&d.doc.get_page_content(page_id))
                .unwrap()
                .operations,
        )
        .len();
        // the first two lines of that file sit near the top of an A4 page
        let blanked = erase_area(&mut d, 0, (0.0, 780.0, 595.0, 62.0)).unwrap();
        assert!(
            blanked > 0 && blanked < before,
            "blanked {blanked} of {before}"
        );
        let bytes = d.save_to_vec().unwrap();
        let d2 = PdfDocument::open(bytes, None).unwrap();
        let after = crate::text_walk::locate_show_runs(
            &Content::decode(&d2.doc.get_page_content(d2.page_id(0).unwrap()))
                .unwrap()
                .operations,
        )
        .len();
        assert_eq!(
            after, before,
            "operators must stay in place so the text matrix does not move"
        );
    }

    #[test]
    fn replace_paragraph_reflows_arabic_into_the_box() {
        let mut d =
            PdfDocument::open(corpus("raw-amiri-cid-identity-tounicode.pdf"), None).unwrap();
        let edit = ParagraphEdit {
            rect: (56.0, 700.0, 483.0, 90.0),
            first_baseline: 775.0,
            text: "هذه فقرة جديدة كتبها محرر وراق وأعاد توزيعها على الأسطر بعرض الإطار نفسه مع تشكيل صحيح للحروف العربية",
            font: AMIRI,
            font_size: 14.0,
            leading: 20.0,
            direction: Direction::Rtl,
            alignment: Alignment::Start,
        };
        let r = replace_paragraph(&mut d, 0, &edit).unwrap();
        assert!(
            r.lines_drawn >= 2,
            "expected the text to reflow onto several lines, got {}",
            r.lines_drawn
        );
        let bytes = d.save_to_vec().unwrap();
        let d2 = PdfDocument::open(bytes, None).unwrap();
        let content =
            String::from_utf8_lossy(&d2.doc.get_page_content(d2.page_id(0).unwrap())).to_string();
        assert!(content.contains("/FW1 14"), "the reflow font must be used");
    }

    #[test]
    fn append_line_adds_shaped_text_to_a_chrome_page() {
        let mut d = PdfDocument::open(corpus("chrome-cairo-mixed-invoice.pdf"), None).unwrap();
        append_line(
            &mut d,
            0,
            "سطر جديد أضافه وراق — added by Warraq 2026",
            AMIRI,
            14.0,
            540.0,
            60.0,
        )
        .unwrap();
        let bytes = d.save_to_vec().unwrap();
        let d2 = PdfDocument::open(bytes, None).unwrap();
        let content =
            String::from_utf8_lossy(&d2.doc.get_page_content(d2.page_id(0).unwrap())).to_string();
        assert!(content.contains("/FW1 14"));
        assert!(content.contains("TJ"));
    }
}
