//! Text operations on existing pages: append a shaped line, replace a word.
use crate::fonts::{embed_subset_font, FontSubset};
use crate::{Error, PdfDocument, Result};
use lopdf::content::{Content, Operation};
use lopdf::{Object, ObjectId, StringFormat};
use warraq_text::{Direction, ShapedGlyph, Shaper};

/// Register `font_id` under a fresh resource name on the page; returns the name.
fn add_font_resource(
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

/// TJ array items for shaped glyphs (visual order), correcting each advance to the shaped one.
fn tj_items(subset: &FontSubset, shaper: &Shaper, glyphs: &[ShapedGlyph]) -> Vec<Object> {
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
    // glyphs with offsets (marks, cursive attachment) are positioned individually
    let mut ops = vec![
        Operation::new("q", vec![]),
        Operation::new("BT", vec![]),
        Operation::new("Tf", vec![Object::Name(name), Object::Real(size)]),
    ];
    let mut pen = x;
    let mut chunk: Vec<ShapedGlyph> = vec![];
    let mut chunk_x = x;
    let flush = |ops: &mut Vec<Operation>, chunk: &mut Vec<ShapedGlyph>, chunk_x: f32| {
        if !chunk.is_empty() {
            ops.push(Operation::new(
                "Tm",
                vec![
                    1.into(),
                    0.into(),
                    0.into(),
                    1.into(),
                    Object::Real(chunk_x),
                    Object::Real(y),
                ],
            ));
            ops.push(Operation::new(
                "TJ",
                vec![Object::Array(tj_items(&subset, &shaper, chunk))],
            ));
            chunk.clear();
        }
    };
    for g in &glyphs {
        if g.x_offset != 0.0 || g.y_offset != 0.0 {
            flush(&mut ops, &mut chunk, chunk_x);
            ops.push(Operation::new(
                "Tm",
                vec![
                    1.into(),
                    0.into(),
                    0.into(),
                    1.into(),
                    Object::Real(pen + g.x_offset * size / 1000.0),
                    Object::Real(y + g.y_offset * size / 1000.0),
                ],
            ));
            ops.push(Operation::new(
                "Tj",
                vec![Object::String(
                    subset.cid(g.gid).to_be_bytes().to_vec(),
                    StringFormat::Hexadecimal,
                )],
            ));
        } else {
            if chunk.is_empty() {
                chunk_x = pen;
            }
            chunk.push(g.clone());
        }
        pen += g.x_advance * size / 1000.0;
    }
    flush(&mut ops, &mut chunk, chunk_x);
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
    Ok(())
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
