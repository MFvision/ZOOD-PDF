//! Paragraph text: itemisation (style runs × bidi levels × font coverage × UAX #14 segments),
//! shaping, greedy line breaking, visual reordering (UAX #9 L2) and justification.
//!
//! **Justification.** Right-to-left lines that contain Arabic are justified with kashida
//! (U+0640 TATWEEL) first: each Arabic word offers one opportunity — the last place where a
//! dual-joining letter connects to the next joining letter (never inside lam-alef) — and tatweels
//! are handed out round robin (at most [`MAX_KASHIDA_PER_WORD`] per word). Only the width the
//! kashidas cannot absorb is spread over the spaces. Latin lines stretch spaces. The inserted
//! tatweels are drawn but never extracted: every word keeps its original text as `/ActualText`.

use std::ops::Range;

use unicode_bidi::{Level, ParagraphBidiInfo};
use unicode_linebreak::{linebreaks, BreakOpportunity};

use crate::error::{CreateError, Result};
use crate::fonts::{font, font_for_char, FontId, Glyph};
use crate::limits;
use crate::model::{Color, Dir, Paragraph, Style};

/// Most tatweels inserted into one word when justifying.
pub const MAX_KASHIDA_PER_WORD: usize = 4;

/// A shaped piece of a line: one font, one direction, one style, word or whitespace.
#[derive(Debug, Clone, PartialEq)]
pub struct Piece {
    /// Logical byte range in the paragraph text.
    pub range: Range<usize>,
    /// Logical text (what `/ActualText` says).
    pub text: String,
    pub font: FontId,
    pub size: f64,
    pub color: Color,
    pub italic: bool,
    pub underline: bool,
    pub level: u8,
    pub space: bool,
    /// Glyphs in visual order (font units).
    pub glyphs: Vec<Glyph>,
    /// Advance width in points.
    pub width: f64,
    /// Extra advance in points added after the piece (justified spaces).
    pub extra: f64,
    /// BCP 47 language of the piece (`ar` for Arabic script unless the source said otherwise).
    pub lang: String,
    /// Contains Arabic-script letters (written with `/ActualText`).
    pub arabic: bool,
    /// Tatweels were inserted for justification (glyph clusters no longer index `text`).
    pub stretched: bool,
}

impl Piece {
    pub fn rtl(&self) -> bool {
        self.level % 2 == 1
    }
}

/// A UAX #14 segment: pieces up to and including the trailing spaces of one break opportunity.
#[derive(Debug, Clone, PartialEq)]
pub struct Segment {
    pub pieces: Vec<Piece>,
    pub mandatory: bool,
}

impl Segment {
    fn width(&self) -> f64 {
        self.pieces.iter().map(|p| p.width).sum()
    }
    /// Width without trailing whitespace (what must fit on the line).
    fn width_trimmed(&self) -> f64 {
        let n = self
            .pieces
            .iter()
            .rposition(|p| !p.space)
            .map_or(0, |i| i + 1);
        self.pieces.iter().take(n).map(|p| p.width).sum()
    }
}

/// A shaped paragraph ready for line breaking.
#[derive(Debug, Clone, PartialEq)]
pub struct ShapedPara {
    pub segments: Vec<Segment>,
    pub base_rtl: bool,
    /// Metrics of the paragraph's first style (for empty paragraphs).
    pub empty_style: Style,
}

/// One laid-out line: pieces in visual order with x offsets (points, from the line's left).
#[derive(Debug, Clone, PartialEq)]
pub struct Line {
    pub pieces: Vec<(f64, Piece)>,
    pub width: f64,
    pub ascent: f64,
    pub descent: f64,
    /// Ends with a forced break or the paragraph end (not justified).
    pub last: bool,
}

impl Line {
    pub fn height(&self) -> f64 {
        self.ascent + self.descent
    }
}

pub fn is_arabic(c: char) -> bool {
    matches!(c, '\u{0600}'..='\u{06FF}' | '\u{0750}'..='\u{077F}' | '\u{08A0}'..='\u{08FF}'
        | '\u{FB50}'..='\u{FDFF}' | '\u{FE70}'..='\u{FEFF}')
}

/// Does `text` contain a strong right-to-left character (Arabic or Hebrew)?
pub fn has_rtl(text: &str) -> bool {
    text.chars()
        .any(|c| is_arabic(c) || matches!(c, '\u{0590}'..='\u{05FF}'))
}

/// First-strong direction (UAX #9 P2), `None` when there is no strong character.
pub fn first_strong_rtl(text: &str) -> Option<bool> {
    for c in text.chars() {
        if is_arabic(c) || matches!(c, '\u{0590}'..='\u{05FF}') {
            if c.is_alphabetic() || matches!(c, '\u{0621}'..='\u{064A}') {
                return Some(true);
            }
        } else if c.is_alphabetic() {
            return Some(false);
        }
    }
    None
}

/// Resolve a paragraph's base direction.
///
/// `Dir::Auto` uses the **dominant** script (more right-to-left letters than left-to-right ones
/// → RTL), then the first strong character, then `default_rtl`. Plain UAX #9 P2 would make
/// "ZOOD PDF يدعم العربية" a left-to-right paragraph; for an Arabic-first document creator the
/// sentence is Arabic, and extractors (ours included) read it back that way.
pub fn base_rtl(dir: Dir, text: &str, default_rtl: bool) -> bool {
    match dir {
        Dir::Rtl => true,
        Dir::Ltr => false,
        Dir::Auto => {
            let (mut r, mut l) = (0usize, 0usize);
            for c in text.chars().take(4096) {
                if is_arabic(c) || matches!(c, '\u{0590}'..='\u{05FF}') {
                    if c.is_alphabetic() {
                        r += 1;
                    }
                } else if c.is_alphabetic() {
                    l += 1;
                }
            }
            if r != l {
                r > l
            } else {
                first_strong_rtl(text).unwrap_or(default_rtl)
            }
        }
    }
}

/// Shape a paragraph. `default_rtl` applies to `Dir::Auto` paragraphs without strong letters.
pub fn shape_paragraph(para: &Paragraph, default_rtl: bool) -> Result<ShapedPara> {
    let empty_style = para
        .runs
        .first()
        .map(|r| r.style.clone())
        .unwrap_or_default();
    // Paragraph text with forced breaks as U+2028 (bidi WS, UAX #14 BK) and tabs as spaces.
    let mut text = String::new();
    let mut run_of: Vec<(Range<usize>, usize)> = Vec::new();
    for (i, r) in para.runs.iter().enumerate() {
        let start = text.len();
        for c in r.text.chars() {
            text.push(match c {
                '\n' | '\r' | '\u{2029}' | '\u{000B}' => '\u{2028}',
                '\t' => ' ',
                c if c.is_control() => ' ',
                c => c,
            });
        }
        run_of.push((start..text.len(), i));
        limits::check(text.len(), limits::MAX_PARAGRAPH_BYTES, "paragraph size")?;
    }
    let rtl = base_rtl(para.style.dir, &text, default_rtl);
    if text.is_empty() {
        return Ok(ShapedPara {
            segments: Vec::new(),
            base_rtl: rtl,
            empty_style,
        });
    }
    let base = if rtl { Level::rtl() } else { Level::ltr() };
    let bidi = ParagraphBidiInfo::new(&text, Some(base));
    let level_at = |i: usize| bidi.levels.get(i).map_or(base.number(), |l| l.number());
    let run_at = |i: usize| {
        run_of
            .iter()
            .find(|(r, _)| r.contains(&i))
            .map_or(0, |(_, k)| *k)
    };

    let mut segments = Vec::new();
    let mut prev = 0usize;
    for (end, op) in linebreaks(&text) {
        let Some(seg_text) = text.get(prev..end) else {
            continue;
        };
        let mut pieces = Vec::new();
        // Split the segment into pieces.
        let mut cur: Option<(usize, (usize, u8, bool, FontId))> = None;
        let flush = |from: usize, to: usize, key: (usize, u8, bool, FontId), pieces: &mut Vec<Piece>| -> Result<()> {
            let (run, level, space, fid) = key;
            let Some(t) = text.get(from..to) else {
                return Ok(());
            };
            let t: String = t.chars().filter(|&c| c != '\u{2028}').collect();
            if t.is_empty() {
                return Ok(());
            }
            let style = para.runs.get(run).map(|r| r.style.clone()).unwrap_or_default();
            pieces.push(make_piece(from..to, t, fid, level, space, &style)?);
            Ok(())
        };
        for (off, c) in seg_text.char_indices() {
            let i = prev + off;
            let run = run_at(i);
            let style = para.runs.get(run).map(|r| &r.style);
            let pref = style.map_or(FontId::CairoRegular, |s| FontId::for_family(s.family, s.bold));
            let space = c.is_whitespace();
            let fid = match &cur {
                // Spaces and marks stay in the current font.
                Some((_, (_, _, _, f))) if space || is_mark(c) => *f,
                _ => font_for_char(pref, c),
            };
            let key = (run, level_at(i), space, fid);
            match &cur {
                Some((s, k)) if *k == key => {
                    let _ = s;
                }
                Some((s, k)) => {
                    flush(*s, i, *k, &mut pieces)?;
                    cur = Some((i, key));
                }
                None => cur = Some((i, key)),
            }
        }
        if let Some((s, k)) = cur {
            flush(s, end, k, &mut pieces)?;
        }
        segments.push(Segment {
            pieces,
            mandatory: op == BreakOpportunity::Mandatory && end < text.len(),
        });
        prev = end;
    }
    Ok(ShapedPara {
        segments,
        base_rtl: rtl,
        empty_style,
    })
}

fn is_mark(c: char) -> bool {
    matches!(c, '\u{064B}'..='\u{065F}' | '\u{0670}' | '\u{06D6}'..='\u{06DC}'
        | '\u{06DF}'..='\u{06E4}' | '\u{06E7}' | '\u{06E8}' | '\u{06EA}'..='\u{06ED}'
        | '\u{0300}'..='\u{036F}' | '\u{200C}' | '\u{200D}')
}

/// Shape one piece of text.
pub fn make_piece(
    range: Range<usize>,
    text: String,
    fid: FontId,
    level: u8,
    space: bool,
    style: &Style,
) -> Result<Piece> {
    let f = font(fid)?;
    let size = if style.size.is_finite() {
        style.size.clamp(1.0, 400.0)
    } else {
        11.0
    };
    let rtl = level % 2 == 1;
    let glyphs = f.shape(&text, rtl);
    let width = glyphs.iter().map(|g| g.x_advance).sum::<f64>() * f.scale(size);
    let arabic = text.chars().any(is_arabic);
    let lang = style
        .lang
        .clone()
        .filter(|l| !l.is_empty())
        .map(|l| {
            // A run tagged "en" can still contain Arabic words (fallback font): say so.
            if arabic && !l.starts_with("ar") && !l.starts_with("fa") && !l.starts_with("ur") {
                "ar".to_string()
            } else {
                l
            }
        })
        .unwrap_or_else(|| if arabic { "ar".into() } else { "en".into() });
    Ok(Piece {
        range,
        text,
        font: fid,
        size,
        color: style.color,
        italic: style.italic,
        underline: style.underline,
        level,
        space,
        glyphs,
        width,
        extra: 0.0,
        lang,
        arabic,
        stretched: false,
    })
}

/// Natural width of the whole paragraph on one line, and the widest unbreakable segment.
pub fn measure(p: &ShapedPara) -> (f64, f64) {
    let mut total = 0.0f64;
    let mut line = 0.0f64;
    let mut widest = 0.0f64;
    for s in &p.segments {
        line += s.width();
        widest = widest.max(s.width_trimmed());
        if s.mandatory {
            total = total.max(line);
            line = 0.0;
        }
    }
    (total.max(line), widest)
}

/// Split one piece so its first part is at most `max_w` wide (at least one character).
fn split_piece(p: &Piece, max_w: f64) -> Result<(Piece, Option<Piece>)> {
    let f = font(p.font)?;
    let scale = f.scale(p.size);
    // Advance per cluster start (logical byte offset in p.text).
    let mut adv: Vec<(usize, f64)> = Vec::new();
    for g in &p.glyphs {
        match adv.iter_mut().find(|(c, _)| *c == g.cluster) {
            Some(e) => e.1 += g.x_advance * scale,
            None => adv.push((g.cluster, g.x_advance * scale)),
        }
    }
    adv.sort_by_key(|e| e.0);
    let mut acc = 0.0;
    let mut cut = 0usize;
    for (k, (c, w)) in adv.iter().enumerate() {
        if acc + w > max_w && k > 0 {
            cut = *c;
            break;
        }
        acc += w;
    }
    if cut == 0 || cut >= p.text.len() || !p.text.is_char_boundary(cut) {
        return Ok((p.clone(), None));
    }
    let style = Style {
        family: crate::model::Family::Sans,
        bold: false,
        italic: p.italic,
        underline: p.underline,
        size: p.size,
        color: p.color,
        lang: Some(p.lang.clone()),
    };
    let (a, b) = p.text.split_at(cut);
    let mid = p.range.start + cut.min(p.range.len());
    let first = make_piece(p.range.start..mid, a.to_string(), p.font, p.level, p.space, &style)?;
    let second = make_piece(mid..p.range.end, b.to_string(), p.font, p.level, p.space, &style)?;
    Ok((first, Some(second)))
}

/// Emergency split of a segment wider than the line into chunks that fit.
fn split_segment(seg: Segment, width: f64) -> Result<Vec<Segment>> {
    let mut out = Vec::new();
    let mut cur: Vec<Piece> = Vec::new();
    let mut cur_w = 0.0;
    let mut queue: std::collections::VecDeque<Piece> = seg.pieces.into();
    let mut guard = 0usize;
    while let Some(p) = queue.pop_front() {
        guard += 1;
        if guard > 100_000 {
            return Err(CreateError::limit("line splitting"));
        }
        if p.space || cur_w + p.width <= width {
            cur_w += p.width;
            cur.push(p);
            continue;
        }
        let room = (width - cur_w).max(0.0);
        let (a, b) = split_piece(&p, room)?;
        match b {
            Some(b) if a.width <= room || cur.is_empty() => {
                cur.push(a);
                out.push(Segment {
                    pieces: std::mem::take(&mut cur),
                    mandatory: false,
                });
                cur_w = 0.0;
                queue.push_front(b);
            }
            _ if !cur.is_empty() => {
                out.push(Segment {
                    pieces: std::mem::take(&mut cur),
                    mandatory: false,
                });
                cur_w = 0.0;
                queue.push_front(p);
            }
            _ => {
                // A single cluster wider than the line: place it anyway.
                cur_w += p.width;
                cur.push(p);
            }
        }
    }
    out.push(Segment {
        pieces: cur,
        mandatory: seg.mandatory,
    });
    Ok(out)
}

/// Break a shaped paragraph into lines of at most `width` points (logical order inside).
/// Each line comes with `true` when it ends with a forced break or the paragraph end.
pub fn break_lines(p: &ShapedPara, width: f64) -> Result<Vec<(Vec<Piece>, bool)>> {
    let width = width.max(1.0);
    let mut lines: Vec<(Vec<Piece>, bool)> = Vec::new();
    let mut cur: Vec<Piece> = Vec::new();
    let mut cur_w = 0.0;
    for seg in &p.segments {
        let segs = if seg.width_trimmed() > width {
            split_segment(seg.clone(), width)?
        } else {
            vec![seg.clone()]
        };
        for s in segs {
            if !cur.is_empty() && cur_w + s.width_trimmed() > width + 0.01 {
                lines.push((std::mem::take(&mut cur), false));
                cur_w = 0.0;
            }
            cur_w += s.width();
            cur.extend(s.pieces);
            if s.mandatory {
                lines.push((std::mem::take(&mut cur), true));
                cur_w = 0.0;
            }
        }
    }
    if !cur.is_empty() || lines.is_empty() {
        lines.push((cur, true));
    }
    if let Some(last) = lines.last_mut() {
        last.1 = true;
    }
    Ok(lines)
}

/// Visual order (UAX #9 L2) of a line's pieces, trailing whitespace removed (L1).
pub fn visual_order(mut pieces: Vec<Piece>, base_rtl: bool) -> Vec<Piece> {
    while pieces.last().is_some_and(|p| p.space) {
        pieces.pop();
    }
    let base = u8::from(base_rtl);
    // Trailing whitespace would take the paragraph level; leading spaces keep theirs.
    let max = pieces.iter().map(|p| p.level).max().unwrap_or(base);
    let min_odd = pieces
        .iter()
        .map(|p| p.level)
        .filter(|l| l % 2 == 1)
        .min()
        .unwrap_or(max + 1);
    let mut lvl = max;
    while lvl >= min_odd && lvl > 0 {
        let mut i = 0;
        while i < pieces.len() {
            if pieces.get(i).is_some_and(|p| p.level >= lvl) {
                let s = i;
                while pieces.get(i).is_some_and(|p| p.level >= lvl) {
                    i += 1;
                }
                if let Some(sl) = pieces.get_mut(s..i) {
                    sl.reverse();
                }
            } else {
                i += 1;
            }
        }
        lvl -= 1;
    }
    pieces
}

/// Arabic joining type (subset of ArabicShaping.txt) for kashida placement.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Join {
    Dual,
    Right,
    Transparent,
    None,
}

fn joining(c: char) -> Join {
    match c {
        '\u{064B}'..='\u{065F}' | '\u{0670}' | '\u{06D6}'..='\u{06DC}' | '\u{06DF}'..='\u{06E4}'
        | '\u{06E7}' | '\u{06E8}' | '\u{06EA}'..='\u{06ED}' => Join::Transparent,
        '\u{0622}'..='\u{0625}' | '\u{0627}' | '\u{0629}' | '\u{062F}'..='\u{0632}' | '\u{0648}'
        | '\u{0671}'..='\u{0673}' | '\u{0675}'..='\u{0677}' | '\u{0688}'..='\u{0699}' | '\u{06C0}'
        | '\u{06C3}'..='\u{06CB}' | '\u{06CD}' | '\u{06CF}' | '\u{06D2}' | '\u{06D3}' | '\u{06D5}'
        | '\u{06EE}' | '\u{06EF}' => Join::Right,
        '\u{0626}' | '\u{0628}' | '\u{062A}'..='\u{062E}' | '\u{0633}'..='\u{063F}'
        | '\u{0640}'..='\u{0647}' | '\u{0649}' | '\u{064A}' | '\u{066E}' | '\u{066F}'
        | '\u{0678}'..='\u{0687}' | '\u{069A}'..='\u{06BF}' | '\u{06C1}' | '\u{06C2}' | '\u{06CC}'
        | '\u{06CE}' | '\u{06D0}' | '\u{06D1}' | '\u{06FA}'..='\u{06FC}' | '\u{06FF}' => Join::Dual,
        _ => Join::None,
    }
}

/// Byte offset in `word` where a kashida can go: the last join between a dual-joining letter and
/// a following joining letter, not inside lam-alef, placed after the first letter's marks.
pub fn kashida_point(word: &str) -> Option<usize> {
    let chars: Vec<(usize, char)> = word.char_indices().collect();
    let mut best = None;
    for (k, &(_, c)) in chars.iter().enumerate() {
        if joining(c) != Join::Dual || c == '\u{0640}' {
            continue;
        }
        // Skip transparent marks after c.
        let mut j = k + 1;
        while chars.get(j).is_some_and(|&(_, m)| joining(m) == Join::Transparent) {
            j += 1;
        }
        let Some(&(pos, next)) = chars.get(j) else {
            continue;
        };
        if !matches!(joining(next), Join::Dual | Join::Right) || next == '\u{0640}' {
            continue;
        }
        if c == '\u{0644}' && matches!(next, '\u{0622}' | '\u{0623}' | '\u{0625}' | '\u{0627}' | '\u{0671}') {
            continue;
        }
        best = Some(pos);
    }
    best
}

/// Lay out one line: justify when asked, then place pieces left to right.
pub fn place_line(
    logical: Vec<Piece>,
    base_rtl: bool,
    width: f64,
    justify: bool,
) -> Result<Line> {
    let mut pieces = visual_order(logical, base_rtl);
    let natural: f64 = pieces.iter().map(|p| p.width).sum();
    let mut extra = width - natural;
    if justify && extra > 0.01 {
        if base_rtl {
            extra = add_kashidas(&mut pieces, extra)?;
        }
        let spaces: Vec<usize> = pieces
            .iter()
            .enumerate()
            .filter(|(_, p)| p.space)
            .map(|(i, _)| i)
            .collect();
        // Do not stretch absurdly (a line with one word and a long gap).
        if !spaces.is_empty() && extra > 0.01 {
            let each = extra / spaces.len() as f64;
            for i in spaces {
                if let Some(p) = pieces.get_mut(i) {
                    p.extra = each;
                }
            }
        }
    }
    let mut x = 0.0;
    let mut ascent: f64 = 0.0;
    let mut descent: f64 = 0.0;
    let mut placed = Vec::with_capacity(pieces.len());
    for p in pieces {
        let f = font(p.font)?;
        let s = f.scale(p.size);
        ascent = ascent.max(f.ascender * s);
        descent = descent.max(-f.descender * s + f.line_gap * s);
        let w = p.width + p.extra;
        placed.push((x, p));
        x += w;
    }
    Ok(Line {
        pieces: placed,
        width: x,
        ascent,
        descent,
        last: !justify,
    })
}

/// Insert tatweels into Arabic words to absorb `extra` points; returns what is left.
fn add_kashidas(pieces: &mut [Piece], extra: f64) -> Result<f64> {
    let budget = extra;
    let mut extra = extra;
    // (piece index, insertion byte offset, tatweel width)
    let mut ops: Vec<(usize, usize, f64)> = Vec::new();
    for (i, p) in pieces.iter().enumerate() {
        if p.space || !p.arabic || !p.rtl() {
            continue;
        }
        let Some(pos) = kashida_point(&p.text) else {
            continue;
        };
        let f = font(p.font)?;
        if !f.covers('\u{0640}') {
            continue;
        }
        let tw: f64 = f.shape("\u{0640}", true).iter().map(|g| g.x_advance).sum::<f64>()
            * f.scale(p.size);
        if tw > 0.1 {
            ops.push((i, pos, tw));
        }
    }
    if ops.is_empty() {
        return Ok(extra);
    }
    let mut counts = vec![0usize; ops.len()];
    let mut progress = true;
    while progress {
        progress = false;
        for (k, &(_, _, tw)) in ops.iter().enumerate() {
            let c = counts.get(k).copied().unwrap_or(MAX_KASHIDA_PER_WORD);
            if c < MAX_KASHIDA_PER_WORD && extra >= tw {
                if let Some(slot) = counts.get_mut(k) {
                    *slot += 1;
                }
                extra -= tw;
                progress = true;
            }
        }
    }
    let mut used = 0.0;
    for (k, &(i, pos, _)) in ops.iter().enumerate() {
        let n = counts.get(k).copied().unwrap_or(0);
        if n == 0 {
            continue;
        }
        let Some(p) = pieces.get_mut(i) else { continue };
        let before = p.width;
        let mut shaped_text = String::with_capacity(p.text.len() + 2 * n);
        shaped_text.push_str(p.text.get(..pos).unwrap_or(""));
        for _ in 0..n {
            shaped_text.push('\u{0640}');
        }
        shaped_text.push_str(p.text.get(pos..).unwrap_or(""));
        let f = font(p.font)?;
        let glyphs = f.shape(&shaped_text, true);
        let width = glyphs.iter().map(|g| g.x_advance).sum::<f64>() * f.scale(p.size);
        // The ActualText stays p.text; only the drawing gets the tatweels.
        p.glyphs = glyphs;
        p.width = width;
        p.stretched = true;
        used += width - before;
    }
    let _ = extra;
    Ok((budget - used).max(0.0))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;
    use crate::model::{Family, ParaStyle, Run};

    fn para(text: &str, family: Family, dir: Dir) -> Paragraph {
        Paragraph {
            runs: vec![Run::new(
                text,
                Style {
                    family,
                    size: 12.0,
                    ..Style::default()
                },
            )],
            style: ParaStyle {
                dir,
                ..ParaStyle::default()
            },
        }
    }

    #[test]
    fn kashida_points_follow_joining_rules() {
        // كتاب: kaf-teh join, teh-alef join (alef is right-joining) → last opportunity before alef.
        assert_eq!(kashida_point("كتاب"), Some("كت".len()));
        // لا: lam-alef never gets a kashida.
        assert_eq!(kashida_point("لا"), None);
        // دار: dal and alef do not join forward.
        assert_eq!(kashida_point("دار"), None);
        // Marks stay with their letter: بَيت → after the fatha? no: last is يت.
        assert_eq!(kashida_point("بَيت"), Some("بَي".len()));
        assert_eq!(kashida_point("word"), None);
    }

    #[test]
    fn mixed_line_reorders_to_visual() {
        let p = shape_paragraph(&para("مرحبا ZOOD PDF اليوم", Family::Sans, Dir::Auto), false).unwrap();
        assert!(p.base_rtl);
        let lines = break_lines(&p, 1000.0).unwrap();
        assert_eq!(lines.len(), 1);
        let line = place_line(lines[0].0.clone(), true, 1000.0, false).unwrap();
        let words: Vec<&str> = line
            .pieces
            .iter()
            .filter(|(_, p)| !p.space)
            .map(|(_, p)| p.text.as_str())
            .collect();
        // Left to right on the page: last Arabic word, the Latin run in its own order, first word.
        assert_eq!(words, vec!["اليوم", "ZOOD", "PDF", "مرحبا"]);
        // Inter has no Arabic: Arabic pieces fall back to Cairo only if family is Latin.
        let p2 = shape_paragraph(&para("abc مرحبا", Family::Latin, Dir::Auto), false).unwrap();
        let fonts: Vec<FontId> = p2.segments.iter().flat_map(|s| s.pieces.iter().map(|p| p.font)).collect();
        assert!(fonts.contains(&FontId::InterRegular) && fonts.contains(&FontId::CairoRegular));
    }

    #[test]
    fn lines_break_at_opportunities_and_fit() {
        let text = "the quick brown fox jumps over the lazy dog ".repeat(5);
        let p = shape_paragraph(&para(&text, Family::Latin, Dir::Ltr), false).unwrap();
        let lines = break_lines(&p, 150.0).unwrap();
        assert!(lines.len() > 3);
        for (l, _) in &lines {
            let placed = place_line(l.clone(), false, 150.0, false).unwrap();
            assert!(placed.width <= 150.01, "{}", placed.width);
        }
        // Words are never split when they fit.
        let all: String = lines.iter().flat_map(|l| &l.0).map(|p| p.text.as_str()).collect();
        assert_eq!(all.trim_end(), text.trim_end());
    }

    #[test]
    fn overlong_words_are_split() {
        let p = shape_paragraph(&para(&"x".repeat(200), Family::Latin, Dir::Ltr), false).unwrap();
        let lines = break_lines(&p, 50.0).unwrap();
        assert!(lines.len() > 3);
        let joined: String = lines.iter().flat_map(|l| &l.0).map(|p| p.text.as_str()).collect();
        assert_eq!(joined, "x".repeat(200));
    }

    #[test]
    fn arabic_justification_prefers_kashida() {
        let text = "كتب الطالب درسه في المكتبة العامة بعد الظهر ثم عاد إلى بيته مسرورا";
        let p = shape_paragraph(&para(text, Family::Serif, Dir::Rtl), true).unwrap();
        let lines = break_lines(&p, 200.0).unwrap();
        assert!(lines.len() >= 2);
        assert!(!lines[0].1);
        let first = place_line(lines[0].0.clone(), true, 200.0, true).unwrap();
        assert!((first.width - 200.0).abs() < 1.5, "justified width {}", first.width);
        // Some word got tatweel glyphs (more glyphs than its unjustified shaping).
        let stretched = first.pieces.iter().any(|(_, p)| {
            !p.space && font(p.font).unwrap().shape(&p.text, true).len() < p.glyphs.len()
        });
        assert!(stretched, "kashida inserted");
        // Text (ActualText) is unchanged.
        assert!(first.pieces.iter().all(|(_, p)| !p.text.contains('\u{0640}')));
        // Latin justification stretches spaces instead.
        let lp = shape_paragraph(&para(&"lorem ipsum dolor sit amet ".repeat(4), Family::Latin, Dir::Ltr), false).unwrap();
        let ll = break_lines(&lp, 200.0).unwrap();
        let l0 = place_line(ll[0].0.clone(), false, 200.0, true).unwrap();
        assert!((l0.width - 200.0).abs() < 0.5);
        assert!(l0.pieces.iter().any(|(_, p)| p.space && p.extra > 0.0));
    }

    #[test]
    fn forced_breaks_make_lines() {
        let p = shape_paragraph(&para("one\ntwo", Family::Latin, Dir::Ltr), false).unwrap();
        let lines = break_lines(&p, 500.0).unwrap();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].1 && lines[1].1);
        let (w, widest) = measure(&p);
        assert!(w > 0.0 && widest > 0.0 && widest <= w);
    }
}
