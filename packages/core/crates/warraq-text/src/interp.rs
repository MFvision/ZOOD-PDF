//! Content-stream interpreter for text: produces positioned glyph units in content order.
//!
//! Handles the text state (`Tc Tw Tz TL Ts Tr Tf`), text positioning (`Td TD Tm T*`), showing
//! (`Tj TJ ' "`), the graphics state stack (`q Q cm`), form XObjects (`Do`, depth- and
//! cycle-bounded) and marked content (`BMC BDC EMC`) with `/ActualText` (preferred over the
//! glyphs it covers), `/Artifact`, `/Lang` and Chrome's `/ReversedChars`.
//!
//! Bold text drawn twice (fill, then stroke, or with a tiny offset) is detected and emitted
//! once. Invisible text (`Tr 3`/`7`) is kept but flagged `hidden`.

use std::collections::HashMap;
use std::rc::Rc;

use lopdf::{Dictionary, Object, ObjectId};

use crate::error::{Result, TextError};
use crate::font::{Font, FontKey};
use crate::geom::{Matrix, Rect};
use crate::lexer::{ContentParser, Operand};
use crate::limits;
use crate::source::{as_number, dict_get, resolve, resolve_dict, stream_data, ContentSource};

/// One positioned unit of text: a glyph, or everything an `/ActualText` span covered.
#[derive(Debug, Clone, PartialEq)]
pub struct RawGlyph {
    /// Unicode text in logical order within the unit.
    pub text: String,
    /// Bounding box in PDF user space (y up).
    pub bbox: Rect,
    /// Text origin (baseline start) in user space.
    pub origin: (f64, f64),
    /// Unit vector of the advance direction in user space.
    pub dir: (f64, f64),
    /// Advance length along `dir` (user space units).
    pub width: f64,
    /// Ascent / descent along the perpendicular of `dir` (user space units, desc ≤ 0).
    pub asc: f64,
    pub desc: f64,
    /// Effective font size (em height) in user space.
    pub size: f64,
    /// Content-stream order.
    pub seq: usize,
    /// Invisible text (render mode 3/7).
    pub hidden: bool,
    /// Inside `/Artifact` marked content (headers, footers, page marks).
    pub artifact: bool,
    /// Text came from `/ActualText`.
    pub actual_text: bool,
    /// Inside `/ReversedChars` marked content (the producer says glyphs are in visual order).
    pub reversed: bool,
    /// Innermost `/Lang`.
    pub lang: Option<Rc<str>>,
    pub font: Option<FontKey>,
    pub bold: bool,
}

#[derive(Clone)]
struct GState {
    ctm: Matrix,
    font: Option<Rc<Font>>,
    size: f64,
    tc: f64,
    tw: f64,
    th: f64,
    tl: f64,
    rise: f64,
    mode: i64,
}

impl GState {
    fn new(ctm: Matrix) -> Self {
        GState {
            ctm,
            font: None,
            size: 0.0,
            tc: 0.0,
            tw: 0.0,
            th: 1.0,
            tl: 0.0,
            rise: 0.0,
            mode: 0,
        }
    }
}

#[derive(Debug, Default, Clone)]
struct McProps {
    actual_text: Option<String>,
    lang: Option<Rc<str>>,
    artifact: bool,
    reversed: bool,
}

struct Marked {
    props: McProps,
    /// Index into `glyphs` where this ActualText group started.
    group_start: Option<usize>,
}

/// Decode a PDF text string (UTF-16BE with BOM, UTF-8 with BOM, else PDFDocEncoding≈Latin-1).
pub fn decode_text_string(b: &[u8]) -> String {
    let s = if let Some(rest) = b.strip_prefix(&[0xfe, 0xff]) {
        let units: Vec<u16> = rest
            .chunks(2)
            .map(|c| match c {
                [a, b] => u16::from(*a) << 8 | u16::from(*b),
                [a] => u16::from(*a) << 8,
                _ => 0,
            })
            .collect();
        char::decode_utf16(units)
            .map(|r| r.unwrap_or('\u{FFFD}'))
            .collect()
    } else if let Some(rest) = b.strip_prefix(&[0xef, 0xbb, 0xbf]) {
        String::from_utf8_lossy(rest).into_owned()
    } else {
        b.iter().map(|&c| char::from(c)).collect()
    };
    s.chars()
        .filter(|&c| c != '\0')
        .take(limits::MAX_ACTUAL_TEXT)
        .collect()
}

fn norm(v: (f64, f64)) -> (f64, f64) {
    let l = (v.0 * v.0 + v.1 * v.1).sqrt();
    if l > 1e-12 && l.is_finite() {
        (v.0 / l, v.1 / l)
    } else {
        (1.0, 0.0)
    }
}

fn nums(ops: &[Operand]) -> Vec<f64> {
    ops.iter().filter_map(Operand::as_f64).collect()
}

/// Stateful interpreter; one per document so fonts are cached across pages.
pub struct Interpreter<'s, S: ContentSource + ?Sized> {
    src: &'s S,
    fonts: HashMap<FontKey, Rc<Font>>,
    glyphs: Vec<RawGlyph>,
    ops: usize,
    seq: usize,
    marked: Vec<Marked>,
    forms: Vec<ObjectId>,
    dedupe: HashMap<(String, i64, i64), Vec<usize>>,
    open_groups: usize,
}

impl<'s, S: ContentSource + ?Sized> Interpreter<'s, S> {
    pub fn new(src: &'s S) -> Self {
        Interpreter {
            src,
            fonts: HashMap::new(),
            glyphs: Vec::new(),
            ops: 0,
            seq: 0,
            marked: Vec::new(),
            forms: Vec::new(),
            dedupe: HashMap::new(),
            open_groups: 0,
        }
    }

    /// Interpret page `index` and return its text units in content order.
    pub fn page_glyphs(&mut self, index: usize) -> Result<Vec<RawGlyph>> {
        let content = self.src.page_content(index)?;
        let resources = self.src.page_resources(index)?;
        self.glyphs.clear();
        self.dedupe.clear();
        self.marked.clear();
        self.forms.clear();
        self.ops = 0;
        self.seq = 0;
        self.open_groups = 0;
        self.run(&content, &resources, Matrix::IDENTITY, 0)?;
        // Close unbalanced ActualText groups.
        while let Some(m) = self.marked.pop() {
            if let Some(start) = m.group_start {
                self.open_groups = self.open_groups.saturating_sub(1);
                self.close_group(start, m.props.actual_text.unwrap_or_default());
            }
        }
        Ok(std::mem::take(&mut self.glyphs))
    }

    /// Interpret raw content bytes with the given resources (used by tests and fuzzing).
    pub fn run_content(&mut self, content: &[u8], resources: &Dictionary) -> Vec<RawGlyph> {
        self.glyphs.clear();
        self.dedupe.clear();
        self.marked.clear();
        self.ops = 0;
        self.open_groups = 0;
        let _ = self.run(content, resources, Matrix::IDENTITY, 0);
        while let Some(m) = self.marked.pop() {
            if let Some(start) = m.group_start {
                self.open_groups = self.open_groups.saturating_sub(1);
                self.close_group(start, m.props.actual_text.unwrap_or_default());
            }
        }
        std::mem::take(&mut self.glyphs)
    }

    fn font_for(&mut self, resources: &Dictionary, name: &[u8]) -> Option<Rc<Font>> {
        let src = self.src;
        let fonts = dict_get(src, resources, b"Font").and_then(|o| resolve_dict(src, o))?;
        let entry = fonts.get(name).ok()?;
        let dict = resolve_dict(src, entry)?;
        let key = Font::key_for(entry, dict);
        if let Some(f) = self.fonts.get(&key) {
            return Some(f.clone());
        }
        let f = Rc::new(Font::load(src, key, dict));
        if self.fonts.len() < limits::MAX_FONTS {
            self.fonts.insert(key, f.clone());
        }
        Some(f)
    }

    fn mc_props(&self, resources: &Dictionary, tag: &[u8], props: Option<&Operand>) -> McProps {
        let mut p = McProps {
            artifact: tag == b"Artifact",
            reversed: tag == b"ReversedChars",
            ..Default::default()
        };
        match props {
            Some(d @ Operand::Dict(_)) => {
                if let Some(Operand::Str(s)) = d.dict_get(b"ActualText") {
                    p.actual_text = Some(decode_text_string(s));
                }
                if let Some(Operand::Str(s)) = d.dict_get(b"Lang") {
                    p.lang = Some(Rc::from(decode_text_string(s).as_str()));
                }
            }
            Some(Operand::Name(n)) => {
                let src = self.src;
                let dict = dict_get(src, resources, b"Properties")
                    .and_then(|o| resolve_dict(src, o))
                    .and_then(|pd| pd.get(n).ok())
                    .and_then(|o| resolve_dict(src, o));
                if let Some(d) = dict {
                    if let Some(Object::String(s, _)) = dict_get(src, d, b"ActualText") {
                        p.actual_text = Some(decode_text_string(s));
                    }
                    if let Some(Object::String(s, _)) = dict_get(src, d, b"Lang") {
                        p.lang = Some(Rc::from(decode_text_string(s).as_str()));
                    }
                }
            }
            _ => {}
        }
        p
    }

    fn current_flags(&self) -> (bool, bool, Option<Rc<str>>) {
        let artifact = self.marked.iter().any(|m| m.props.artifact);
        let reversed = self.marked.iter().any(|m| m.props.reversed);
        let lang = self.marked.iter().rev().find_map(|m| m.props.lang.clone());
        (artifact, reversed, lang)
    }

    fn run(
        &mut self,
        content: &[u8],
        resources: &Dictionary,
        base_ctm: Matrix,
        depth: usize,
    ) -> Result<()> {
        let mut gs = GState::new(base_ctm);
        let mut stack: Vec<GState> = Vec::new();
        let mut tm = Matrix::IDENTITY;
        let mut tlm = Matrix::IDENTITY;
        let marked_base = self.marked.len();
        for op in ContentParser::new(content) {
            self.ops += 1;
            if self.ops > limits::MAX_OPS_PER_PAGE {
                return Err(TextError::Limit("operators per page"));
            }
            let o = op.operands.as_slice();
            match op.operator.as_slice() {
                b"q" => {
                    if stack.len() < limits::MAX_GSTATE_DEPTH {
                        stack.push(gs.clone());
                    }
                }
                b"Q" => {
                    if let Some(s) = stack.pop() {
                        gs = s;
                    }
                }
                b"cm" => {
                    if let [a, b, c, d, e, f] = nums(o).as_slice() {
                        gs.ctm = Matrix::new(*a, *b, *c, *d, *e, *f).then(&gs.ctm);
                    }
                }
                b"BT" => {
                    tm = Matrix::IDENTITY;
                    tlm = Matrix::IDENTITY;
                }
                b"Tf" => {
                    if let [Operand::Name(n), size] = o {
                        gs.font = self
                            .font_for(resources, n)
                            .or_else(|| Some(Rc::new(Font::fallback())));
                        gs.size = size.as_f64().unwrap_or(0.0);
                    }
                }
                b"Tc" => gs.tc = nums(o).first().copied().unwrap_or(0.0),
                b"Tw" => gs.tw = nums(o).first().copied().unwrap_or(0.0),
                b"Tz" => gs.th = nums(o).first().copied().unwrap_or(100.0) / 100.0,
                b"TL" => gs.tl = nums(o).first().copied().unwrap_or(0.0),
                b"Ts" => gs.rise = nums(o).first().copied().unwrap_or(0.0),
                b"Tr" => gs.mode = nums(o).first().copied().unwrap_or(0.0) as i64,
                b"Td" | b"TD" => {
                    if let [tx, ty] = nums(o).as_slice() {
                        if op.operator == b"TD" {
                            gs.tl = -ty;
                        }
                        tlm = Matrix::translate(*tx, *ty).then(&tlm);
                        tm = tlm;
                    }
                }
                b"Tm" => {
                    if let [a, b, c, d, e, f] = nums(o).as_slice() {
                        tlm = Matrix::new(*a, *b, *c, *d, *e, *f);
                        tm = tlm;
                    }
                }
                b"T*" => {
                    tlm = Matrix::translate(0.0, -gs.tl).then(&tlm);
                    tm = tlm;
                }
                b"Tj" => {
                    if let Some(Operand::Str(s)) = o.first() {
                        self.show(&gs, &mut tm, s);
                    }
                }
                b"'" => {
                    tlm = Matrix::translate(0.0, -gs.tl).then(&tlm);
                    tm = tlm;
                    if let Some(Operand::Str(s)) = o.first() {
                        self.show(&gs, &mut tm, s);
                    }
                }
                b"\"" => {
                    if let [aw, ac, Operand::Str(s)] = o {
                        gs.tw = aw.as_f64().unwrap_or(0.0);
                        gs.tc = ac.as_f64().unwrap_or(0.0);
                        tlm = Matrix::translate(0.0, -gs.tl).then(&tlm);
                        tm = tlm;
                        self.show(&gs, &mut tm, s);
                    }
                }
                b"TJ" => {
                    if let Some(Operand::Array(items)) = o.first() {
                        for item in items {
                            match item {
                                Operand::Str(s) => self.show(&gs, &mut tm, s),
                                Operand::Num(n) => {
                                    let adj = -n / 1000.0 * gs.size;
                                    let vertical = gs.font.as_ref().is_some_and(|f| f.vertical);
                                    tm = if vertical {
                                        Matrix::translate(0.0, adj).then(&tm)
                                    } else {
                                        Matrix::translate(adj * gs.th, 0.0).then(&tm)
                                    };
                                }
                                _ => {}
                            }
                        }
                    }
                }
                b"BMC" | b"BDC" => {
                    if self.marked.len() >= limits::MAX_MARKED_DEPTH {
                        // Keep balance: push a neutral entry.
                        self.marked.push(Marked {
                            props: McProps::default(),
                            group_start: None,
                        });
                        continue;
                    }
                    let tag = o.first().and_then(Operand::as_name).unwrap_or(b"");
                    let props = self.mc_props(resources, tag, o.get(1));
                    let group_start = props.actual_text.as_ref().map(|_| self.glyphs.len());
                    if group_start.is_some() {
                        self.open_groups += 1;
                    }
                    self.marked.push(Marked { props, group_start });
                }
                b"EMC" => {
                    if self.marked.len() > marked_base {
                        if let Some(m) = self.marked.pop() {
                            if let Some(start) = m.group_start {
                                self.open_groups = self.open_groups.saturating_sub(1);
                                self.close_group(start, m.props.actual_text.unwrap_or_default());
                            }
                        }
                    }
                }
                b"Do" => {
                    if let Some(Operand::Name(n)) = o.first() {
                        self.do_xobject(resources, n, &gs, depth)?;
                    }
                }
                _ => {}
            }
        }
        // Unbalanced BMC/BDC inside a form: close what this stream opened.
        while self.marked.len() > marked_base {
            if let Some(m) = self.marked.pop() {
                if let Some(start) = m.group_start {
                    self.open_groups = self.open_groups.saturating_sub(1);
                    self.close_group(start, m.props.actual_text.unwrap_or_default());
                }
            }
        }
        Ok(())
    }

    fn do_xobject(
        &mut self,
        resources: &Dictionary,
        name: &[u8],
        gs: &GState,
        depth: usize,
    ) -> Result<()> {
        if depth >= limits::MAX_FORM_DEPTH {
            return Ok(());
        }
        let src = self.src;
        let Some(xobjs) = dict_get(src, resources, b"XObject").and_then(|o| resolve_dict(src, o))
        else {
            return Ok(());
        };
        let Ok(entry) = xobjs.get(name) else {
            return Ok(());
        };
        let id = match entry {
            Object::Reference(id) => Some(*id),
            _ => None,
        };
        if let Some(id) = id {
            if self.forms.contains(&id) {
                return Ok(()); // cycle
            }
        }
        let Some(Object::Stream(stream)) = resolve(src, entry) else {
            return Ok(());
        };
        if !matches!(stream.dict.get(b"Subtype"), Ok(Object::Name(n)) if n.as_slice() == b"Form") {
            return Ok(());
        }
        let m = match dict_get(src, &stream.dict, b"Matrix") {
            Some(Object::Array(a)) => {
                let v: Vec<f64> = a
                    .iter()
                    .filter_map(|x| resolve(src, x).and_then(as_number))
                    .collect();
                match v.as_slice() {
                    [a, b, c, d, e, f] => Matrix::new(*a, *b, *c, *d, *e, *f),
                    _ => Matrix::IDENTITY,
                }
            }
            _ => Matrix::IDENTITY,
        };
        let data = stream_data(stream)?;
        let form_res = dict_get(src, &stream.dict, b"Resources").and_then(|o| resolve_dict(src, o));
        if let Some(id) = id {
            self.forms.push(id);
        }
        let ctm = m.then(&gs.ctm);
        let r = match form_res {
            Some(fr) => self.run(&data, fr, ctm, depth + 1),
            None => self.run(&data, resources, ctm, depth + 1),
        };
        if id.is_some() {
            self.forms.pop();
        }
        r
    }

    fn show(&mut self, gs: &GState, tm: &mut Matrix, bytes: &[u8]) {
        let Some(font) = gs.font.clone() else { return };
        let (artifact, reversed, lang) = self.current_flags();
        let hidden = gs.mode == 3 || gs.mode == 7;
        for d in font.decode(bytes) {
            let trm = Matrix::new(gs.size * gs.th, 0.0, 0.0, gs.size, 0.0, gs.rise)
                .then(tm)
                .then(&gs.ctm);
            let (x0, x1, y0, y1) = if font.vertical {
                (-0.5, 0.5, -1.0, 0.0)
            } else {
                (0.0, d.width, font.descent, font.ascent)
            };
            let pts = [
                trm.apply(x0, y0),
                trm.apply(x1, y0),
                trm.apply(x1, y1),
                trm.apply(x0, y1),
            ];
            let bbox = Rect::from_points(&pts);
            let origin = trm.apply(0.0, 0.0);
            let dir = norm(trm.apply_vec(1.0, 0.0));
            let (vx, vy) = trm.apply_vec(0.0, 1.0);
            let size = (vx * vx + vy * vy).sqrt();
            let up = (-dir.1, dir.0);
            let proj = |v: (f64, f64)| v.0 * up.0 + v.1 * up.1;
            let (ax, ay) = trm.apply_vec(d.width, 0.0);
            let width = if font.vertical {
                size
            } else {
                (ax * ax + ay * ay).sqrt()
            };
            let a = proj(trm.apply_vec(0.0, font.ascent));
            let de = proj(trm.apply_vec(0.0, font.descent));
            let (asc, desc) = if a >= de { (a, de) } else { (de, a) };
            if !d.text.is_empty() || self.open_groups > 0 {
                let g = RawGlyph {
                    text: d.text.clone(),
                    bbox,
                    origin,
                    dir,
                    width,
                    asc,
                    desc,
                    size,
                    seq: self.seq,
                    hidden,
                    artifact,
                    actual_text: false,
                    reversed,
                    lang: lang.clone(),
                    font: Some(font.key),
                    bold: font.bold || gs.mode == 2,
                };
                self.seq += 1;
                self.emit(g);
            }
            // Advance.
            let ws = if d.word_space { gs.tw } else { 0.0 };
            if font.vertical {
                let ty = -gs.size + gs.tc + ws;
                *tm = Matrix::translate(0.0, ty).then(tm);
            } else {
                let tx = (d.width * gs.size + gs.tc + ws) * gs.th;
                *tm = Matrix::translate(tx, 0.0).then(tm);
            }
        }
    }

    fn emit(&mut self, g: RawGlyph) {
        if self.glyphs.len() >= limits::MAX_GLYPHS_PER_PAGE {
            return;
        }
        if self.open_groups > 0 {
            self.glyphs.push(g);
            return;
        }
        if g.text.chars().all(char::is_whitespace) {
            self.glyphs.push(g);
            return;
        }
        // Fill+stroke / offset double drawing of bold text: same text at (almost) the same place.
        let tol = (g.size * 0.15).max(0.3);
        let cell = tol * 2.0;
        let cx = (g.origin.0 / cell).floor() as i64;
        let cy = (g.origin.1 / cell).floor() as i64;
        for dx in -1..=1 {
            for dy in -1..=1 {
                if let Some(list) = self.dedupe.get(&(g.text.clone(), cx + dx, cy + dy)) {
                    for &i in list {
                        if let Some(prev) = self.glyphs.get_mut(i) {
                            let close = (prev.origin.0 - g.origin.0).abs() < tol
                                && (prev.origin.1 - g.origin.1).abs() < tol
                                && (prev.size - g.size).abs() <= prev.size.max(g.size) * 0.2;
                            if close {
                                prev.hidden = prev.hidden && g.hidden;
                                prev.bold = true;
                                return;
                            }
                        }
                    }
                }
            }
        }
        let idx = self.glyphs.len();
        self.dedupe
            .entry((g.text.clone(), cx, cy))
            .or_default()
            .push(idx);
        self.glyphs.push(g);
    }

    /// Replace the glyphs drawn inside an ActualText span by one unit carrying the text.
    fn close_group(&mut self, start: usize, text: String) {
        if start > self.glyphs.len() {
            return;
        }
        let inner: Vec<RawGlyph> = self.glyphs.drain(start..).collect();
        let Some(first) = inner.first() else { return };
        let mut bbox = first.bbox;
        let mut size = first.size;
        for g in &inner {
            bbox = bbox.union(&g.bbox);
            size = size.max(g.size);
        }
        let spans_lines = bbox.height() > size * 2.6 && bbox.width() > size * 2.6;
        // Extent along the first glyph's direction / perpendicular.
        let d = first.dir;
        let up = (-d.1, d.0);
        let (mut lo, mut hi, mut asc, mut desc) = (f64::MAX, f64::MIN, f64::MIN, f64::MAX);
        let take = if spans_lines { 1 } else { inner.len() };
        for g in inner.iter().take(take) {
            let rel = (g.origin.0 - first.origin.0, g.origin.1 - first.origin.1);
            let p = rel.0 * d.0 + rel.1 * d.1;
            let q = rel.0 * up.0 + rel.1 * up.1;
            lo = lo.min(p).min(p + g.width);
            hi = hi.max(p).max(p + g.width);
            asc = asc.max(q + g.asc);
            desc = desc.min(q + g.desc);
        }
        let unit = RawGlyph {
            text,
            bbox: if spans_lines { first.bbox } else { bbox },
            origin: (first.origin.0 + lo * d.0, first.origin.1 + lo * d.1),
            dir: first.dir,
            width: (hi - lo).max(0.0),
            asc,
            desc,
            size,
            seq: first.seq,
            hidden: inner.iter().all(|g| g.hidden),
            artifact: inner.iter().any(|g| g.artifact),
            actual_text: true,
            reversed: first.reversed,
            lang: first.lang.clone(),
            font: first.font,
            bold: inner.iter().any(|g| g.bold),
        };
        if unit.text.is_empty() {
            return;
        }
        self.emit(unit);
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;
    use crate::source::LopdfSource;
    use lopdf::{dictionary, Document, Stream};

    /// A document with one WinAnsi Helvetica font F1 and one Identity-H font F2 whose
    /// ToUnicode maps 0x0001..0x0005 to ا ل س م ب.
    fn fixture() -> (LopdfSource, Dictionary) {
        let mut doc = Document::with_version("1.7");
        let f1 = doc.add_object(dictionary! {
            "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica", "Encoding" => "WinAnsiEncoding",
        });
        let tu = doc.add_object(Stream::new(
            dictionary! {},
            b"1 begincodespacerange <0000> <FFFF> endcodespacerange 5 beginbfchar <0001> <0627> <0002> <0644> <0003> <0633> <0004> <0645> <0005> <0628> endbfchar".to_vec(),
        ));
        let desc = doc.add_object(dictionary! {"Type" => "Font", "Subtype" => "CIDFontType2", "BaseFont" => "AR", "DW" => 500});
        let f2 = doc.add_object(dictionary! {
            "Type" => "Font", "Subtype" => "Type0", "BaseFont" => "AR", "Encoding" => "Identity-H",
            "DescendantFonts" => vec![Object::Reference(desc)], "ToUnicode" => tu,
        });
        let form = doc.add_object(Stream::new(
            dictionary! {"Type" => "XObject", "Subtype" => "Form", "BBox" => vec![0.into(), 0.into(), 100.into(), 100.into()], "Matrix" => vec![1.into(), 0.into(), 0.into(), 1.into(), 10.into(), 0.into()]},
            b"BT /F1 10 Tf 0 0 Td (Form) Tj ET".to_vec(),
        ));
        let res = dictionary! {
            "Font" => dictionary! {"F1" => f1, "F2" => f2},
            "XObject" => dictionary! {"X1" => form},
        };
        (LopdfSource::from_document(doc), res)
    }

    fn texts(g: &[RawGlyph]) -> Vec<String> {
        g.iter().map(|g| g.text.clone()).collect()
    }

    #[test]
    fn tj_positions_and_spacing() {
        let (src, res) = fixture();
        let mut it = Interpreter::new(&src);
        let g = it.run_content(b"BT /F1 10 Tf 2 Tc 100 700 Td (AB) Tj ET", &res);
        assert_eq!(texts(&g), ["A", "B"]);
        // A width 667/1000*10 = 6.67 + Tc 2
        assert!((g[1].origin.0 - (100.0 + 6.67 + 2.0)).abs() < 1e-6);
        assert!((g[0].origin.1 - 700.0).abs() < 1e-9);
        assert!((g[0].size - 10.0).abs() < 1e-9);
    }

    #[test]
    fn tj_array_kerning_tz_and_word_spacing() {
        let (src, res) = fixture();
        let mut it = Interpreter::new(&src);
        let g = it.run_content(
            b"BT /F1 10 Tf 50 Tz 5 Tw 0 0 Td [(A) -1000 ( B)] TJ ET",
            &res,
        );
        assert_eq!(texts(&g), ["A", " ", "B"]);
        // A: 6.67*0.5 ; kern +10*0.5 ; space: (2.78 + 5)*0.5
        let expect_space = (6.67 + 10.0) * 0.5;
        assert!(
            (g[1].origin.0 - expect_space).abs() < 1e-6,
            "{}",
            g[1].origin.0
        );
        let expect_b = expect_space + (2.78 + 5.0) * 0.5;
        assert!((g[2].origin.0 - expect_b).abs() < 1e-6);
    }

    #[test]
    fn leading_quote_operators_and_ctm() {
        let (src, res) = fixture();
        let mut it = Interpreter::new(&src);
        let g = it.run_content(b"q 2 0 0 2 0 0 cm BT /F1 10 Tf 12 TL 0 100 Td (A) Tj T* (B) Tj (C) ' 1 1 (D) \" ET Q BT /F1 10 Tf (E) Tj ET", &res);
        assert_eq!(texts(&g), ["A", "B", "C", "D", "E"]);
        assert!((g[0].origin.1 - 200.0).abs() < 1e-9);
        assert!((g[1].origin.1 - 176.0).abs() < 1e-9);
        assert!((g[2].origin.1 - 152.0).abs() < 1e-9);
        assert!((g[4].origin.1).abs() < 1e-9, "Q restored the CTM");
        assert!((g[0].size - 20.0).abs() < 1e-9);
    }

    #[test]
    fn identity_h_and_actual_text_preferred() {
        let (src, res) = fixture();
        let mut it = Interpreter::new(&src);
        let g = it.run_content(
            b"BT /F2 20 Tf 0 0 Td /Span <</ActualText <FEFF0633064406270645>>> BDC <0004000100020003> Tj EMC <0005> Tj ET",
            &res,
        );
        assert_eq!(texts(&g), ["سلام", "ب"]);
        assert!(g[0].actual_text);
        assert!(
            (g[0].bbox.width() - 40.0).abs() < 1e-6,
            "4 glyphs × 0.5 em × 20"
        );
    }

    #[test]
    fn fill_stroke_double_drawing_is_read_once() {
        let (src, res) = fixture();
        let mut it = Interpreter::new(&src);
        let g = it.run_content(
            b"BT /F1 10 Tf 0 Tr 100 100 Td (Bold) Tj ET BT /F1 10 Tf 1 Tr 100.2 100 Td (Bold) Tj ET BT /F1 10 Tf 100 100 Td (x) Tj ET",
            &res,
        );
        assert_eq!(texts(&g).concat(), "Boldx");
        assert!(g[..4].iter().all(|g| g.bold));
    }

    #[test]
    fn repeated_letters_are_not_deduplicated() {
        let (src, res) = fixture();
        let mut it = Interpreter::new(&src);
        let g = it.run_content(b"BT /F1 10 Tf 0 0 Td (lll) Tj ET", &res);
        assert_eq!(texts(&g).concat(), "lll");
    }

    #[test]
    fn invisible_text_is_flagged_hidden() {
        let (src, res) = fixture();
        let mut it = Interpreter::new(&src);
        let g = it.run_content(b"BT /F1 10 Tf 3 Tr (H) Tj 0 Tr (V) Tj ET", &res);
        assert!(g[0].hidden);
        assert!(!g[1].hidden);
    }

    #[test]
    fn artifact_lang_and_forms() {
        let (src, res) = fixture();
        let mut it = Interpreter::new(&src);
        let g = it.run_content(
            b"/Artifact BMC BT /F1 10 Tf (P) Tj ET EMC /Span <</Lang (ar-SA)>> BDC /X1 Do EMC",
            &res,
        );
        assert_eq!(texts(&g).concat(), "PForm");
        assert!(g[0].artifact);
        assert!(!g[1].artifact);
        assert_eq!(g[1].lang.as_deref(), Some("ar-SA"));
        assert!((g[1].origin.0 - 10.0).abs() < 1e-9, "form /Matrix applied");
    }

    #[test]
    fn self_referencing_form_is_bounded() {
        let mut doc = Document::with_version("1.7");
        let id = doc.new_object_id();
        let f1 = doc.add_object(
            dictionary! {"Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica"},
        );
        let res =
            dictionary! {"Font" => dictionary!{"F1" => f1}, "XObject" => dictionary! {"X" => id}};
        let s = Stream::new(
            dictionary! {"Subtype" => "Form", "Resources" => res.clone()},
            b"BT /F1 10 Tf (a) Tj ET /X Do".to_vec(),
        );
        doc.objects.insert(id, Object::Stream(s));
        let src = LopdfSource::from_document(doc);
        let mut it = Interpreter::new(&src);
        let g = it.run_content(b"/X Do", &res);
        assert_eq!(g.len(), 1);
    }

    #[test]
    fn text_strings() {
        assert_eq!(
            decode_text_string(&[0xfe, 0xff, 0x06, 0x44, 0x06, 0x27]),
            "لا"
        );
        assert_eq!(decode_text_string(b"abc"), "abc");
        assert_eq!(decode_text_string(&[0xef, 0xbb, 0xbf, 0xd9, 0x84]), "ل");
    }
}
