//! Laying text into a box: paragraphs, UAX #14 line breaking, bidi (visual runs per line),
//! per-character font choice with fallback, harfrust shaping, alignment; then content-stream
//! operators with one `/Span <</ActualText …>> BDC … EMC` per logical word so every extractor
//! reads the words back in logical order. `/Direction /R2L` is never written and glyphs are
//! drawn once (fill only, `0 Tr`).

use std::collections::BTreeMap;
use std::ops::Range;

use unicode_bidi::{get_base_direction, Direction as BidiDir, Level, ParagraphBidiInfo};
use unicode_linebreak::{linebreaks, BreakOpportunity};

use crate::content::fmt_num;
use crate::error::{EditError, Result};
use crate::fonts::{bundled, bundled_chain, is_ignorable, Face, FaceShaper, Family, Written};
use crate::geom::Rect;

/// Maximum characters laid out per call.
pub const MAX_TEXT_CHARS: usize = 20_000;
/// Maximum lines produced.
pub const MAX_LINES: usize = 2_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Align {
    /// Right edge for right-to-left paragraphs, left edge otherwise.
    Start,
    End,
    Center,
}

/// What to lay out and where (user space, y up).
pub struct Request<'a> {
    pub text: &'a str,
    pub x0: f64,
    /// y of the top edge of the box.
    pub top: f64,
    pub width: f64,
    pub size: f64,
    /// Baseline-to-baseline distance (default 1.4 × size).
    pub line_height: Option<f64>,
    pub align: Align,
    /// Paragraph direction (None: from the first strong character, per paragraph).
    pub rtl: Option<bool>,
    pub family: Family,
    pub bold: bool,
    /// The page's own font, when it covers the whole text.
    pub original: Option<&'a Face>,
}

/// A glyph placed on the page.
#[derive(Debug, Clone, PartialEq)]
pub struct Placed {
    pub face: usize,
    pub gid: u16,
    pub x: f64,
    pub y: f64,
    /// Pen position before the glyph's offset, and its advance (the word's advance range).
    pub pen: f64,
    pub adv: f64,
    /// Text this glyph stands for in the ToUnicode fallback ("" for secondary glyphs).
    pub text: String,
}

/// One line: glyphs in visual order and the ActualText spans over them.
#[derive(Debug, Clone, PartialEq)]
pub struct Line {
    pub glyphs: Vec<Placed>,
    pub spans: Vec<(Range<usize>, String)>,
}

/// Result of a layout.
pub struct Laid<'a> {
    pub faces: Vec<&'a Face>,
    pub lines: Vec<Line>,
    pub size: f64,
    /// Box actually used (user space).
    pub bbox: Rect,
}

impl Laid<'_> {
    /// Glyph ids (with fallback text) used per face.
    pub fn used(&self) -> Vec<BTreeMap<u16, String>> {
        let mut out = vec![BTreeMap::new(); self.faces.len()];
        for l in &self.lines {
            for g in &l.glyphs {
                if let Some(m) = out.get_mut(g.face) {
                    let e: &mut String = m.entry(g.gid).or_default();
                    if e.is_empty() {
                        e.clone_from(&g.text);
                    }
                }
            }
        }
        out
    }

    /// Content operators drawing the text with the faces written as `written[face]`.
    pub fn content(&self, written: &[Written], fill: [f64; 3]) -> Vec<u8> {
        let mut s = String::from("q\nBT\n");
        s.push_str(&format!(
            "{} {} {} rg\n0 Tr 0 Tc 0 Tw 100 Tz 0 Ts\n",
            fmt_num(fill[0]),
            fmt_num(fill[1]),
            fmt_num(fill[2])
        ));
        let mut cur: Option<usize> = None;
        let mut glyph = |s: &mut String, g: &Placed| {
            let Some(w) = written.get(g.face) else {
                return;
            };
            if cur != Some(g.face) {
                s.push_str(&format!(
                    "{} {} Tf\n",
                    crate::content::fmt_name(&w.resource),
                    fmt_num(self.size)
                ));
                cur = Some(g.face);
            }
            let cid = w.cid.get(&g.gid).copied().unwrap_or(g.gid);
            s.push_str(&format!(
                "1 0 0 1 {} {} Tm <{cid:04X}> Tj\n",
                fmt_num(g.x),
                fmt_num(g.y)
            ));
        };
        for line in &self.lines {
            for (range, text) in &line.spans {
                let gs = line.glyphs.get(range.clone()).unwrap_or(&[]);
                // The word's advance range; glyphs drawn outside it (a tanween hanging over the
                // space) are drawn in an empty ActualText span so no extractor merges the word
                // with its neighbour or the space.
                let lo = gs.iter().map(|g| g.pen).fold(f64::MAX, f64::min);
                let hi = gs.iter().map(|g| g.pen + g.adv).fold(f64::MIN, f64::max);
                let outside = |g: &Placed| g.x < lo - 0.05 || g.x > hi + 0.05;
                s.push_str(&format!("/Span <</ActualText {}>> BDC\n", hex_text(text)));
                for g in gs.iter().filter(|g| !outside(g)) {
                    glyph(&mut s, g);
                }
                s.push_str("EMC\n");
                if gs.iter().any(outside) {
                    s.push_str("/Span <</ActualText <FEFF>>> BDC\n");
                    for g in gs.iter().filter(|g| outside(g)) {
                        glyph(&mut s, g);
                    }
                    s.push_str("EMC\n");
                }
            }
        }
        s.push_str("ET\nQ\n");
        s.into_bytes()
    }
}

/// `<FEFF…>` text string.
pub fn hex_text(s: &str) -> String {
    let mut out = String::from("<FEFF");
    for u in s.encode_utf16() {
        out.push_str(&format!("{u:04X}"));
    }
    out.push('>');
    out
}

struct Shaped {
    face: usize,
    gid: u16,
    /// Byte offset in the line.
    cluster: usize,
    adv: f64,
    x_off: f64,
    y_off: f64,
    text: String,
}

struct Ctx<'a> {
    faces: Vec<&'a Face>,
    shapers: Vec<FaceShaper<'a>>,
    size: f64,
}

impl<'a> Ctx<'a> {
    fn face_index(&mut self, f: &'a Face) -> Result<usize> {
        if let Some(i) = self.faces.iter().position(|x| std::ptr::eq(*x, f)) {
            return Ok(i);
        }
        let sh = f
            .shaper()
            .ok_or_else(|| EditError::Font("font cannot be shaped".into()))?;
        self.faces.push(f);
        self.shapers.push(sh);
        Ok(self.faces.len() - 1)
    }

    /// Face index for every char of `text` (by byte offset order).
    fn assign(&mut self, text: &str, req: &Request<'a>) -> Result<Vec<usize>> {
        let mut out = Vec::new();
        let mut prev: Option<usize> = None;
        for c in text.chars() {
            let i = if let Some(o) = req.original {
                self.face_index(o)?
            } else if c.is_whitespace() || is_ignorable(c) || is_mark(c) {
                match prev {
                    Some(p) => p,
                    None => self.face_index(bundled(bundled_chain(req.family, req.bold, c)[0])?)?,
                }
            } else {
                let chain = bundled_chain(req.family, req.bold, c);
                let mut pick = None;
                for b in chain {
                    let f = bundled(b)?;
                    let idx = self.face_index(f)?;
                    if self.shapers.get(idx).is_some_and(|s| s.covers(c)) {
                        pick = Some(idx);
                        break;
                    }
                }
                match pick {
                    Some(p) => p,
                    None => self.face_index(bundled(chain[0])?)?,
                }
            };
            prev = Some(i);
            for _ in 0..c.len_utf8() {
                out.push(i);
            }
        }
        Ok(out)
    }

    /// Shape a line (logical text) into glyphs in visual order.
    fn shape_line(&self, line: &str, faces: &[usize], rtl_base: bool) -> Vec<Shaped> {
        let mut out = Vec::new();
        if line.is_empty() {
            return out;
        }
        let level = if rtl_base { Level::rtl() } else { Level::ltr() };
        let info = ParagraphBidiInfo::new(line, Some(level));
        let (levels, runs) = info.visual_runs(0..line.len());
        let scale = |f: usize| self.faces.get(f).map_or(0.0, |x| self.size / x.upem);
        for run in runs {
            let rtl = levels.get(run.start).is_some_and(|l| l.is_rtl());
            // Split the run by face (logical order).
            let mut subs: Vec<(usize, Range<usize>)> = Vec::new();
            let mut i = run.start;
            while i < run.end {
                let f = faces.get(i).copied().unwrap_or(0);
                let mut j = i + 1;
                while j < run.end && (faces.get(j).copied() == Some(f) || !line.is_char_boundary(j))
                {
                    j += 1;
                }
                subs.push((f, i..j));
                i = j;
            }
            if rtl {
                subs.reverse();
            }
            for (f, r) in subs {
                let Some(text) = line.get(r.clone()) else {
                    continue;
                };
                let Some(sh) = self.shapers.get(f) else {
                    continue;
                };
                let glyphs = sh.shape(text, rtl);
                let mut clusters: Vec<usize> = glyphs.iter().map(|g| g.cluster).collect();
                clusters.sort_unstable();
                clusters.dedup();
                let mut seen = std::collections::HashSet::new();
                let k = scale(f);
                for g in glyphs {
                    let end = clusters
                        .iter()
                        .find(|&&c| c > g.cluster)
                        .copied()
                        .unwrap_or(text.len());
                    let t = if seen.insert(g.cluster) {
                        text.get(g.cluster..end).unwrap_or("").to_string()
                    } else {
                        String::new()
                    };
                    out.push(Shaped {
                        face: f,
                        gid: g.gid,
                        cluster: r.start + g.cluster,
                        adv: g.x_advance * k,
                        x_off: g.x_offset * k,
                        y_off: g.y_offset * k,
                        text: t,
                    });
                }
            }
        }
        out
    }
}

fn is_mark(c: char) -> bool {
    matches!(c as u32, 0x0300..=0x036F | 0x0610..=0x061A | 0x064B..=0x065F | 0x0670 | 0x06D6..=0x06ED | 0x08D3..=0x08FF)
}

fn first_strong_rtl(text: &str) -> Option<bool> {
    match get_base_direction(text) {
        BidiDir::Rtl => Some(true),
        BidiDir::Ltr => Some(false),
        BidiDir::Mixed => None,
    }
}

/// Logical tokens: words and whitespace runs (byte ranges).
fn tokens(text: &str) -> Vec<Range<usize>> {
    let mut out: Vec<Range<usize>> = Vec::new();
    let mut cur: Option<(usize, bool)> = None;
    for (i, c) in text.char_indices() {
        let ws = c.is_whitespace();
        match cur {
            Some((_, w)) if w == ws => {}
            Some((s, _)) => {
                out.push(s..i);
                cur = Some((i, ws));
            }
            None => cur = Some((i, ws)),
        }
    }
    if let Some((s, _)) = cur {
        out.push(s..text.len());
    }
    out
}

/// Lay out `req`.
pub fn layout<'a>(req: &Request<'a>) -> Result<Laid<'a>> {
    if req.text.chars().count() > MAX_TEXT_CHARS {
        return Err(EditError::Limit("text length".into()));
    }
    if !(req.size.is_finite() && req.size > 0.5 && req.size < 1000.0) {
        return Err(EditError::Params(
            "font size must be between 0.5 and 1000".into(),
        ));
    }
    if !(req.width.is_finite() && req.width > 0.0 && req.x0.is_finite() && req.top.is_finite()) {
        return Err(EditError::Params(
            "box must be finite with a positive width".into(),
        ));
    }
    let mut ctx = Ctx {
        faces: Vec::new(),
        shapers: Vec::new(),
        size: req.size,
    };
    let lh = req
        .line_height
        .filter(|v| v.is_finite() && *v > 0.0)
        .unwrap_or(req.size * 1.4);
    let mut lines = Vec::new();
    let mut baseline: Option<f64> = None;
    let mut bbox: Option<Rect> = None;
    let text = req.text.replace("\r\n", "\n").replace('\r', "\n");
    for para in text.split('\n') {
        let rtl = req.rtl.or_else(|| first_strong_rtl(para)).unwrap_or(false);
        let faces = ctx.assign(para, req)?;
        // Segments between break opportunities.
        let mut breaks: Vec<usize> = linebreaks(para)
            .filter(|(_, o)| matches!(o, BreakOpportunity::Allowed | BreakOpportunity::Mandatory))
            .map(|(i, _)| i)
            .collect();
        if breaks.last() != Some(&para.len()) {
            breaks.push(para.len());
        }
        let mut seg_w = Vec::new();
        let mut start = 0usize;
        for &b in &breaks {
            let seg = para.get(start..b).unwrap_or("");
            let fs = faces.get(start..b).unwrap_or(&[]);
            let w: f64 = ctx
                .shape_line(seg.trim_end(), fs, rtl)
                .iter()
                .map(|g| g.adv)
                .sum();
            let full: f64 = ctx.shape_line(seg, fs, rtl).iter().map(|g| g.adv).sum();
            seg_w.push((start..b, w, full));
            start = b;
        }
        // Greedy fill.
        let mut line_ranges: Vec<Range<usize>> = Vec::new();
        let mut ls = 0usize;
        let mut acc = 0.0f64;
        let mut le = 0usize;
        for (r, w, full) in &seg_w {
            if le > ls && acc + w > req.width {
                line_ranges.push(ls..le);
                ls = r.start;
                acc = 0.0;
            }
            acc += full;
            le = r.end;
        }
        line_ranges.push(ls..para.len());
        for lr in line_ranges {
            if lines.len() >= MAX_LINES {
                return Err(EditError::Limit("lines".into()));
            }
            let raw = para.get(lr.clone()).unwrap_or("");
            let trimmed = raw.trim_end();
            let lf = faces.get(lr.start..lr.start + trimmed.len()).unwrap_or(&[]);
            let shaped = ctx.shape_line(trimmed, lf, rtl);
            let width: f64 = shaped.iter().map(|g| g.adv).sum();
            let first_face = lf.first().and_then(|f| ctx.faces.get(*f)).copied();
            let asc = first_face.map_or(0.8, |f| f.ascender / f.upem) * req.size;
            let desc = first_face.map_or(-0.2, |f| f.descender / f.upem) * req.size;
            let y = match baseline {
                None => req.top - asc,
                Some(b) => b - lh,
            };
            baseline = Some(y);
            let x_start = match (req.align, rtl) {
                (Align::Start, false) | (Align::End, true) => req.x0,
                (Align::Start, true) | (Align::End, false) => req.x0 + req.width - width,
                (Align::Center, _) => req.x0 + (req.width - width) / 2.0,
            };
            let toks = tokens(trimmed);
            let token_of = |c: usize| toks.iter().position(|r| r.contains(&c));
            let mut glyphs = Vec::new();
            let mut spans: Vec<(Range<usize>, String)> = Vec::new();
            let mut used_tok = vec![false; toks.len()];
            let mut cur: Option<(Option<usize>, usize)> = None;
            let mut x = x_start;
            let mut close = |tok: Option<usize>,
                             s: usize,
                             e: usize,
                             spans: &mut Vec<(Range<usize>, String)>| {
                let text = match tok {
                    Some(t) if !used_tok.get(t).copied().unwrap_or(true) => {
                        if let Some(u) = used_tok.get_mut(t) {
                            *u = true;
                        }
                        toks.get(t)
                            .and_then(|r| trimmed.get(r.clone()))
                            .unwrap_or("")
                            .to_string()
                    }
                    _ => String::new(),
                };
                spans.push((s..e, text));
            };
            for (i, g) in shaped.iter().enumerate() {
                let t = token_of(g.cluster);
                match cur {
                    Some((ct, _)) if ct == t => {}
                    Some((ct, s)) => {
                        close(ct, s, i, &mut spans);
                        cur = Some((t, i));
                    }
                    None => cur = Some((t, i)),
                }
                glyphs.push(Placed {
                    face: g.face,
                    gid: g.gid,
                    x: x + g.x_off,
                    y: y + g.y_off,
                    pen: x,
                    adv: g.adv,
                    text: g.text.clone(),
                });
                x += g.adv;
            }
            if let Some((ct, s)) = cur {
                close(ct, s, shaped.len(), &mut spans);
            }
            let lb = Rect::new(x_start, y + desc, x_start + width, y + asc);
            bbox = Some(bbox.map_or(lb, |b| b.union(&lb)));
            lines.push(Line { glyphs, spans });
        }
    }
    Ok(Laid {
        faces: ctx.faces,
        lines,
        size: req.size,
        bbox: bbox.unwrap_or_default(),
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    fn req(text: &str, width: f64) -> Request<'_> {
        Request {
            text,
            x0: 100.0,
            top: 700.0,
            width,
            size: 12.0,
            line_height: None,
            align: Align::Start,
            rtl: None,
            family: Family::Serif,
            bold: false,
            original: None,
        }
    }

    #[test]
    fn arabic_wraps_right_aligned_with_word_spans() {
        let l = layout(&req("مرحبا بالعالم الجميل من زود", 80.0)).unwrap();
        assert!(l.lines.len() >= 2, "{}", l.lines.len());
        // Right aligned: every line ends at the right edge (±0.5 pt).
        for line in &l.lines {
            let last = line.glyphs.iter().map(|g| g.x).fold(f64::MIN, f64::max);
            assert!(last <= 180.5);
        }
        // Spans are in visual order: reversed per right-to-left line.
        let words: Vec<String> = l
            .lines
            .iter()
            .flat_map(|x| x.spans.iter().rev().map(|s| s.1.clone()))
            .filter(|t| !t.trim().is_empty())
            .collect();
        assert_eq!(words, ["مرحبا", "بالعالم", "الجميل", "من", "زود"]);
    }

    #[test]
    fn latin_in_serif_uses_amiri_and_sans_uses_inter() {
        let mut r = req("Hello", 300.0);
        let l = layout(&r).unwrap();
        assert_eq!(l.faces.len(), 1);
        r.family = Family::Sans;
        r.text = "Hello سلام";
        let l = layout(&r).unwrap();
        assert_eq!(l.faces.len(), 2);
    }

    #[test]
    fn bad_sizes_are_errors() {
        let mut r = req("x", 100.0);
        r.size = f64::NAN;
        assert!(layout(&r).is_err());
        let r = req("x", -1.0);
        assert!(layout(&r).is_err());
    }
}
