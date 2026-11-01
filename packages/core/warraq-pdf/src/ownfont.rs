//! Replacing a paragraph in the font it is already set in, by that font's
//! own character codes — nothing embedded, nothing substituted.
//!
//! A PDF carries a subset of each font: only the glyphs its text uses. New
//! text can still be drawn with it whenever every character it needs is one
//! the document already used. The font's `/ToUnicode` (or, for a simple font
//! without one, its named encoding) says which code draws which character;
//! `/Widths` or the CID `/W` say how far each moves the pen. With those the
//! lines are laid out in the paragraph's box and shown with the SAME font
//! resource, at the same size: the result is the original face exactly,
//! because it is the original face.
//!
//! This holds only for scripts that need no shaping — Latin, Greek,
//! Cyrillic, digits, punctuation. An Arabic subset maps several joining
//! forms to one letter and cannot say which goes where, so Arabic never
//! takes this path: it is shaped by `warraq_text` and embedded as before.
//! One character without a code and the whole paragraph is left to the
//! caller's own font — two faces are never mixed in one paragraph.
//!
//! Everything read from the file is bounded.
use std::collections::{HashMap, HashSet};

use crate::face::{face_of, OriginalFace};
use crate::ops::{erase_area_keeping_fill, mark_page_objects, reset_state_ops, Replacement};
use crate::redaction::fonts::Font;
use crate::text_walk::ShowRun;
use crate::{Error, PdfDocument, Result};
use lopdf::content::{Content, Operation};
use lopdf::{Dictionary, Object, StringFormat};
use warraq_text::{Alignment, Direction};

/// A `/ToUnicode` stream is read up to this many bytes.
const MAX_TOUNICODE: usize = 4 << 20;
/// Fonts of one page read at most; runs in others have no face.
const MAX_PAGE_FONTS: usize = 512;
/// The gap drawn for a space when the font has no code for one, in ems.
const SPACE_WITHOUT_CODE: f32 = 0.27;

/// Whether `c` belongs to a script drawn letter by letter, with no shaping:
/// Latin, Greek, Cyrillic, digits, punctuation and common symbols.
/// Combining marks are left out — placing them is shaping too.
pub fn needs_no_shaping(c: char) -> bool {
    matches!(c as u32,
        0x20..=0x7E
        | 0xA0..=0xFF
        | 0x100..=0x24F
        | 0x370..=0x3FF
        | 0x400..=0x52F
        | 0x1E00..=0x1EFF
        | 0x2010..=0x2027
        | 0x2030..=0x205E
        | 0x20A0..=0x20BF
        | 0x2100..=0x214F
        | 0x2190..=0x21FF
        | 0x2200..=0x22FF
        | 0x25A0..=0x25FF)
        && c != '\u{AD}'
}

/// One font of a page as new text can use it.
#[derive(Debug, Clone)]
struct Codec {
    /// Bytes a code takes: 1 or 2.
    code_len: usize,
    /// Each character the font can draw: its code and its advance for a
    /// size of 1.
    chars: HashMap<char, (u32, f32)>,
    /// Every code that draws each character, when there are several.
    all: HashMap<char, Vec<u32>>,
}

/// A paragraph's own font, ready to draw new text.
#[derive(Debug, Clone)]
pub struct OwnFont {
    /// The font's name in the page's resources.
    pub resource: Vec<u8>,
    /// The size the paragraph is set in, in page units.
    pub size: f32,
    /// The baseline of its first line (PDF user space, y up).
    pub first_baseline: f32,
    code_len: usize,
    chars: HashMap<char, (u32, f32)>,
}

impl OwnFont {
    /// Whether every character of `text` can be drawn with this font.
    /// White space needs no code: a gap is left for it.
    pub fn covers(&self, text: &str) -> bool {
        text.chars()
            .all(|c| c.is_whitespace() || (needs_no_shaping(c) && self.chars.contains_key(&c)))
    }
}

fn resolve<'a>(doc: &'a lopdf::Document, o: &'a Object) -> &'a Object {
    match o {
        Object::Reference(id) => doc.get_object(*id).unwrap_or(o),
        other => other,
    }
}

/// What `WinAnsiEncoding` draws at 0x80–0x9F, where it differs from Latin 1.
const WINDOWS_1252_HIGH: [(u8, char); 27] = [
    (0x80, '€'),
    (0x82, '‚'),
    (0x83, 'ƒ'),
    (0x84, '„'),
    (0x85, '…'),
    (0x86, '†'),
    (0x87, '‡'),
    (0x88, 'ˆ'),
    (0x89, '‰'),
    (0x8A, 'Š'),
    (0x8B, '‹'),
    (0x8C, 'Œ'),
    (0x8E, 'Ž'),
    (0x91, '‘'),
    (0x92, '’'),
    (0x93, '“'),
    (0x94, '”'),
    (0x95, '•'),
    (0x96, '–'),
    (0x97, '—'),
    (0x98, '˜'),
    (0x99, '™'),
    (0x9A, 'š'),
    (0x9B, '›'),
    (0x9C, 'œ'),
    (0x9E, 'ž'),
    (0x9F, 'Ÿ'),
];

/// The characters a simple font without `/ToUnicode` draws, by code: only
/// what its named encoding leaves in no doubt. `None` when the encoding
/// cannot be trusted (a symbolic font, a TrueType font with none).
fn encoding_chars(doc: &lopdf::Document, font: &Dictionary) -> Option<Vec<(u32, char)>> {
    let subtype = font.get(b"Subtype").and_then(Object::as_name).ok()?;
    let symbolic = font
        .get(b"FontDescriptor")
        .ok()
        .map(|d| resolve(doc, d))
        .and_then(|d| d.as_dict().ok())
        .and_then(|d| d.get(b"Flags").ok())
        .and_then(|f| f.as_i64().ok())
        .is_some_and(|f| f & 4 != 0 && f & 32 == 0);
    if symbolic {
        return None;
    }
    let encoding = font.get(b"Encoding").ok().map(|e| resolve(doc, e));
    let (base, differences): (Option<&[u8]>, Option<&Vec<Object>>) = match encoding {
        Some(Object::Name(n)) => (Some(n.as_slice()), None),
        Some(Object::Dictionary(e)) => (
            e.get(b"BaseEncoding").ok().and_then(|b| b.as_name().ok()),
            e.get(b"Differences")
                .ok()
                .map(|d| resolve(doc, d))
                .and_then(|d| d.as_array().ok()),
        ),
        _ => (None, None),
    };
    // Codes the file renamed are left out: what they draw is told by glyph
    // names, which this does not read.
    let mut renamed = [false; 256];
    if let Some(differences) = differences {
        let mut code = 0usize;
        for item in differences.iter().take(512) {
            match item {
                Object::Integer(c) => code = (*c).clamp(0, 255) as usize,
                Object::Name(_) if code < 256 => {
                    renamed[code] = true;
                    code += 1;
                }
                _ => {}
            }
        }
    }
    let latin1 = match base {
        Some(b"WinAnsiEncoding") => true,
        Some(b"MacRomanEncoding") => false,
        // The standard encoding, which a Type 1 font has when it names
        // none; a TrueType font's own is not known from here.
        Some(b"StandardEncoding") => false,
        None if subtype == b"Type1" || subtype == b"MMType1" => false,
        _ => return None,
    };
    let standard = !matches!(base, Some(b"WinAnsiEncoding") | Some(b"MacRomanEncoding"));
    let mut out = vec![];
    for code in 0x20u32..=0xFF {
        if renamed[code as usize] {
            continue;
        }
        let c = match code {
            // The standard encoding draws curly quotes at these two.
            0x27 | 0x60 if standard => None,
            0x20..=0x7E => char::from_u32(code),
            // Windows' own between the two halves of Latin 1: the dashes
            // and curly quotes a writer types without thinking.
            0x80..=0x9F if latin1 => WINDOWS_1252_HIGH
                .iter()
                .find(|(at, _)| *at as u32 == code)
                .map(|(_, c)| *c),
            // Windows' Latin 1 above the controls is Unicode's.
            0xA1..=0xFF if latin1 && code != 0xAD => char::from_u32(code),
            _ => None,
        };
        if let Some(c) = c {
            out.push((code, c));
        }
    }
    Some(out)
}

impl Codec {
    /// Reads a font dictionary; `None` when new text cannot be set in it
    /// with certainty: a Type 3 font, vertical writing, a CMap of the
    /// file's own, guessed widths, no way to tell what its codes draw.
    fn read(doc: &lopdf::Document, font: &Object) -> Option<Codec> {
        let d = resolve(doc, font).as_dict().ok()?;
        let subtype = d.get(b"Subtype").and_then(Object::as_name).ok()?;
        if subtype == b"Type3" {
            return None;
        }
        let metrics = Font::read(doc, font);
        if metrics.unsure || metrics.vertical {
            return None;
        }
        let code_len = metrics.code_len()?;
        let pairs: Vec<(u32, char)> = match d.get(b"ToUnicode").ok().map(|t| resolve(doc, t)) {
            Some(Object::Stream(s)) => {
                let bytes = if s.dict.get(b"Filter").is_err() {
                    s.content.clone()
                } else {
                    s.decompressed_content_with_limit(MAX_TOUNICODE).ok()?
                };
                if bytes.len() > MAX_TOUNICODE {
                    return None;
                }
                crate::tounicode::parse(&bytes)
                    .into_iter()
                    // One code, one character: a ligature's code is no
                    // use for either of its letters.
                    .filter_map(|(code, text)| {
                        let mut chars = text.chars();
                        match (chars.next(), chars.next()) {
                            (Some(c), None) => Some((code, c)),
                            _ => None,
                        }
                    })
                    .collect()
            }
            _ if code_len == 1 => encoding_chars(doc, d)?,
            _ => return None,
        };
        let mut chars: HashMap<char, (u32, f32)> = HashMap::new();
        let mut all: HashMap<char, Vec<u32>> = HashMap::new();
        for (code, c) in pairs {
            if (code_len == 1 && code > 0xFF) || code > 0xFFFF {
                continue;
            }
            let bytes = code_bytes(code, code_len);
            let advance = match metrics.codes(&bytes).as_slice() {
                [one] => one.advance,
                _ => continue,
            };
            // No advance: the font has no glyph there, whatever the map says.
            if !(advance > 0.0 && advance < 10.0) {
                continue;
            }
            all.entry(c).or_default().push(code);
            chars.entry(c).or_insert((code, advance));
        }
        all.retain(|_, codes| codes.len() > 1);
        Some(Codec {
            code_len,
            chars,
            all,
        })
    }
}

fn code_bytes(code: u32, code_len: usize) -> Vec<u8> {
    if code_len == 1 {
        vec![code as u8]
    } else {
        vec![(code >> 8) as u8, code as u8]
    }
}

/// A page's text-showing operators and its fonts, read once: what each
/// paragraph of the page asks about is answered from here.
pub struct PageFonts<'a> {
    pdf: &'a PdfDocument,
    ops: Vec<Operation>,
    runs: Vec<ShowRun>,
    fonts: Option<&'a Dictionary>,
    faces: HashMap<Vec<u8>, Option<OriginalFace>>,
    codecs: HashMap<Vec<u8>, Option<Codec>>,
}

impl<'a> PageFonts<'a> {
    pub fn read(pdf: &'a PdfDocument, page_index: usize) -> Result<Self> {
        let page_id = pdf.page_id(page_index)?;
        let ops = Content::decode(&pdf.page_content(page_id)?)
            .map_err(|e| Error::Edit(e.to_string()))?
            .operations;
        let runs = crate::text_walk::locate_show_runs(&ops);
        let fonts = pdf
            .page_resources(page_id)
            .and_then(|r| r.get(b"Font").ok())
            .map(|f| resolve(&pdf.doc, f))
            .and_then(|f| f.as_dict().ok());
        Ok(Self {
            pdf,
            ops,
            runs,
            fonts,
            faces: HashMap::new(),
            codecs: HashMap::new(),
        })
    }

    /// The runs that start in `rect` (x, y of the bottom, width, height):
    /// the ones replacing the paragraph there would blank.
    fn runs_in(&self, rect: (f32, f32, f32, f32)) -> Vec<&ShowRun> {
        let (x0, y0, w, h) = rect;
        let (x1, y1) = (x0 + w, y0 + h);
        self.runs
            .iter()
            .filter(|r| {
                // The same reach as `erase_area_keeping_fill`.
                let size = r.size.max(1.0);
                let (pad, below) = (0.2 * size, 0.5 * size);
                r.x >= x0 - pad && r.x <= x1 + pad && r.y >= y0 - below && r.y <= y1 + pad
            })
            .collect()
    }

    /// The font most of the runs in `rect` are set in: its resource name.
    fn font_in(&self, rect: (f32, f32, f32, f32)) -> Option<Vec<u8>> {
        let mut counts: Vec<(&[u8], usize)> = vec![];
        for run in self.runs_in(rect) {
            match counts
                .iter_mut()
                .find(|(name, _)| *name == run.font.as_slice())
            {
                Some((_, n)) => *n += 1,
                None => counts.push((&run.font, 1)),
            }
        }
        // The first of the most used: a paragraph is nearly always one font.
        let most = counts.iter().map(|(_, n)| *n).max()?;
        counts
            .iter()
            .find(|(_, n)| *n == most)
            .map(|(name, _)| name.to_vec())
    }

    fn font_object(&self, name: &[u8]) -> Option<&'a Object> {
        self.fonts.and_then(|f| f.get(name).ok())
    }

    /// The face the paragraph in `rect` is set in, as the file names it.
    pub fn face_in(&mut self, rect: (f32, f32, f32, f32)) -> Option<OriginalFace> {
        let name = self.font_in(rect)?;
        if let Some(face) = self.faces.get(&name) {
            return face.clone();
        }
        if self.faces.len() >= MAX_PAGE_FONTS {
            return None;
        }
        let face = self
            .font_object(&name)
            .map(|f| resolve(&self.pdf.doc, f))
            .and_then(|f| f.as_dict().ok())
            .and_then(|f| face_of(&self.pdf.doc, f));
        self.faces.insert(name, face.clone());
        face
    }

    /// The font of the paragraph in `rect`, when new text can be set in it.
    /// Where several codes draw one character, the one the paragraph's own
    /// text used is taken.
    pub fn own_font_in(&mut self, rect: (f32, f32, f32, f32)) -> Option<OwnFont> {
        let name = self.font_in(rect)?;
        if !self.codecs.contains_key(&name) {
            if self.codecs.len() >= MAX_PAGE_FONTS {
                return None;
            }
            let codec = self
                .font_object(&name)
                .and_then(|f| Codec::read(&self.pdf.doc, f));
            self.codecs.insert(name.clone(), codec);
        }
        let codec = self.codecs.get(&name)?.as_ref()?;
        let runs: Vec<&ShowRun> = self
            .runs_in(rect)
            .into_iter()
            .filter(|r| r.font == name)
            .collect();
        // The first line is the highest; its first run gives the size.
        let first = runs.iter().copied().max_by(|a, b| a.y.total_cmp(&b.y))?;
        if !(first.size.is_finite() && first.size > 0.5 && first.size < 2000.0) {
            return None;
        }
        let mut chars = codec.chars.clone();
        if !codec.all.is_empty() {
            let used = self.codes_used(&runs, codec.code_len);
            for (c, codes) in &codec.all {
                if let Some(code) = codes.iter().find(|code| used.contains(code)) {
                    if let Some(entry) = chars.get_mut(c) {
                        if entry.0 != *code {
                            // Its advance is that code's own.
                            let metrics = self
                                .font_object(&name)
                                .map(|f| Font::read(&self.pdf.doc, f))?;
                            if let [one] =
                                metrics.codes(&code_bytes(*code, codec.code_len)).as_slice()
                            {
                                *entry = (*code, one.advance);
                            }
                        }
                    }
                }
            }
        }
        Some(OwnFont {
            resource: name,
            size: first.size,
            first_baseline: first.y,
            code_len: codec.code_len,
            chars,
        })
    }

    /// The codes the given runs show.
    fn codes_used(&self, runs: &[&ShowRun], code_len: usize) -> HashSet<u32> {
        let mut used = HashSet::new();
        let mut take = |bytes: &[u8]| {
            for chunk in bytes.chunks_exact(code_len) {
                used.insert(chunk.iter().fold(0u32, |a, b| (a << 8) | *b as u32));
            }
        };
        for run in runs {
            let Some(op) = self.ops.get(run.op_index) else {
                continue;
            };
            for operand in &op.operands {
                match operand {
                    Object::String(bytes, _) => take(bytes),
                    Object::Array(items) => {
                        for item in items {
                            if let Object::String(bytes, _) = item {
                                take(bytes);
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        used
    }
}

/// What to draw in place of a paragraph, in its own font.
pub struct OwnFontEdit<'a> {
    /// The paragraph box in PDF user space (x, y of the BOTTOM edge, width, height).
    pub rect: (f32, f32, f32, f32),
    pub text: &'a str,
    /// Distance between baselines, positive.
    pub leading: f32,
    pub direction: Direction,
    pub alignment: Alignment,
}

/// A word of a line: its codes and its width for a size of 1.
struct Word {
    bytes: Vec<u8>,
    width: f32,
}

/// Lines of words no wider than `width` (for a size of 1), broken at spaces.
fn wrap(words: &[Word], space: f32, width: f32) -> Vec<std::ops::Range<usize>> {
    let mut lines = vec![];
    let mut start = 0;
    let mut used = 0.0f32;
    for (i, word) in words.iter().enumerate() {
        if i > start && used + space + word.width > width {
            lines.push(start..i);
            start = i;
            used = word.width;
        } else {
            used += if i > start { space } else { 0.0 } + word.width;
        }
    }
    if start < words.len() {
        lines.push(start..words.len());
    }
    lines
}

/// Replace the paragraph in `edit.rect` with `edit.text`, drawn in the font
/// the paragraph is already set in, at its size and in its colour.
///
/// `Ok(None)` — and the document untouched — when that cannot be done:
/// the paragraph runs right to left, the font cannot be used with certainty
/// (see [`PageFonts::own_font_in`]) or a character of the text has no code
/// in it. The caller then draws the paragraph with a font of its own.
pub fn replace_paragraph_own_font(
    pdf: &mut PdfDocument,
    page_index: usize,
    edit: &OwnFontEdit<'_>,
) -> Result<Option<Replacement>> {
    if edit.direction != Direction::Ltr {
        return Ok(None);
    }
    let Some(font) = PageFonts::read(pdf, page_index)?.own_font_in(edit.rect) else {
        return Ok(None);
    };
    if !font.covers(edit.text) {
        return Ok(None);
    }
    let space = font.chars.get(&' ').copied();
    let space_width = space.map_or(SPACE_WITHOUT_CODE, |(_, w)| w);
    let words: Vec<Word> = edit
        .text
        .split_whitespace()
        .map(|word| {
            let mut bytes = Vec::with_capacity(word.len() * font.code_len);
            let mut width = 0.0;
            for c in word.chars() {
                // `covers` saw every one of them.
                if let Some((code, advance)) = font.chars.get(&c) {
                    bytes.extend(code_bytes(*code, font.code_len));
                    width += advance;
                }
            }
            Word { bytes, width }
        })
        .collect();
    let (x0, _, w, box_height) = edit.rect;
    // The size never changes unless the text cannot fit its box: the same
    // rule as a paragraph drawn in a font of the caller's.
    let fits = |size: f32, lead: f32| -> bool {
        let lines = wrap(&words, space_width, w / size).len().max(1);
        (lines as f32 - 1.0) * lead + size <= box_height + 0.5
    };
    let (mut size, mut leading) = (font.size, edit.leading);
    let mut steps = 0;
    while !fits(size, leading) && size > font.size * 0.6 {
        size *= 0.95;
        leading *= 0.95;
        steps += 1;
    }
    let (shrunk, overflowed) = (steps > 0, !fits(size, leading));
    let lines = wrap(&words, space_width, w / size);

    let (_, fill) = erase_area_keeping_fill(pdf, page_index, edit.rect)?;
    if lines.is_empty() {
        return Ok(Some(Replacement {
            lines_drawn: 0,
            font_size: size,
            shrunk,
            overflowed,
        }));
    }
    let page_id = pdf.page_id(page_index)?;
    let mut ops = reset_state_ops(pdf, page_id);
    ops.push(Operation::new("q", vec![]));
    ops.extend(fill);
    ops.push(Operation::new("BT", vec![]));
    ops.push(Operation::new(
        "Tf",
        vec![Object::Name(font.resource.clone()), Object::Real(size)],
    ));
    // Spacing the page's own text may have left set would move ours.
    ops.push(Operation::new("Tc", vec![Object::Integer(0)]));
    ops.push(Operation::new("Tw", vec![Object::Integer(0)]));
    ops.push(Operation::new("Tz", vec![Object::Integer(100)]));
    ops.push(Operation::new("Ts", vec![Object::Integer(0)]));
    let last = lines.len() - 1;
    for (k, line) in lines.iter().enumerate() {
        let in_line = &words[line.clone()];
        let gaps = in_line.len().saturating_sub(1) as f32;
        let natural: f32 = in_line.iter().map(|w| w.width).sum::<f32>() + gaps * space_width;
        let slack = (w / size - natural).max(0.0);
        // A justified line is stretched at its spaces; the last line, and a
        // line of one word, are not.
        let stretch = if edit.alignment == Alignment::Justify && k != last && gaps > 0.0 {
            slack / gaps
        } else {
            0.0
        };
        let x = x0
            + size
                * match edit.alignment {
                    Alignment::End => slack,
                    Alignment::Center => slack / 2.0,
                    Alignment::Start | Alignment::Justify => 0.0,
                };
        let y = font.first_baseline - k as f32 * leading;
        ops.push(Operation::new(
            "Tm",
            vec![
                Object::Integer(1),
                Object::Integer(0),
                Object::Integer(0),
                Object::Integer(1),
                Object::Real(x),
                Object::Real(y),
            ],
        ));
        let mut items: Vec<Object> = vec![];
        let mut pending: Vec<u8> = vec![];
        for (i, word) in in_line.iter().enumerate() {
            if i > 0 {
                // A space is its code when the font has one, and a move of
                // the pen when it has not — or when the line is stretched.
                let mut gap = stretch;
                match space {
                    Some((code, _)) => pending.extend(code_bytes(code, font.code_len)),
                    None => gap += space_width,
                }
                if gap > 0.0 {
                    items.push(Object::String(
                        std::mem::take(&mut pending),
                        StringFormat::Hexadecimal,
                    ));
                    items.push(Object::Real(-gap * 1000.0));
                }
            }
            pending.extend(&word.bytes);
        }
        items.push(Object::String(pending, StringFormat::Hexadecimal));
        ops.push(Operation::new("TJ", vec![Object::Array(items)]));
    }
    ops.push(Operation::new("ET", vec![]));
    ops.push(Operation::new("Q", vec![]));
    let mut content = pdf.page_content(page_id)?;
    content.push(b'\n');
    content.extend(
        Content { operations: ops }
            .encode()
            .map_err(|e| Error::Edit(e.to_string()))?,
    );
    pdf.replace_page_content(page_id, content)?;
    mark_page_objects(pdf, page_id);
    Ok(Some(Replacement {
        lines_drawn: lines.len(),
        font_size: size,
        shrunk,
        overflowed,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_scripts_that_need_no_shaping_pass() {
        for c in "Az09 .,;:!?-–—’“”€£éßÿŁΩωЖя".chars() {
            assert!(needs_no_shaping(c), "{c:?}");
        }
        for c in "عربيאहค\u{301}\u{200F}\u{202E}\u{AD}\n".chars() {
            assert!(!needs_no_shaping(c), "{c:?}");
        }
    }

    #[test]
    fn words_wrap_at_the_width_and_a_long_word_stands_alone() {
        let word = |w: f32| Word {
            bytes: vec![],
            width: w,
        };
        let words = [word(3.0), word(3.0), word(9.0), word(1.0), word(1.0)];
        assert_eq!(wrap(&words, 1.0, 7.0), vec![0..2, 2..3, 3..5]);
        assert_eq!(wrap(&[], 1.0, 7.0), Vec::<std::ops::Range<usize>>::new());
    }
}
