//! Logical-order reconstruction from positioned glyphs (ADR-0005).
//!
//! Input: glyphs in any order with page positions (y grows downwards), font size
//! and the Unicode text each glyph maps to. Output: lines of LOGICAL text.
use crate::bidi::Direction;
use crate::normalize::{fold_presentation_forms, mirror_bracket};
use unicode_normalization::UnicodeNormalization;

#[derive(Debug, Clone, PartialEq)]
pub struct PositionedGlyph {
    pub x: f32,
    pub y: f32,
    /// Rotation of the text's baseline, in radians. Real documents put rotated
    /// runs beside horizontal ones (sidebars, stamps, table headers); mixing them
    /// into the same line would corrupt both.
    pub angle: f32,
    pub size: f32,
    /// Horizontal advance in the same units as `x`; 0 when unknown.
    pub advance: f32,
    pub text: Option<String>,
    pub gid: u32,
    pub font: u32,
}

/// Glyphs drawn inside a marked-content sequence with `/ActualText` stand
/// for that text instead of their own (PDF 2.0 §14.9.4): each such run
/// becomes one glyph, carrying the text, spanning where the run was drawn.
///
/// `inside[i]` lists the sequences glyph `i` was drawn in, outermost first,
/// and `texts[k]` is sequence `k`'s `/ActualText`; the outermost text wins, as
/// a replacement covers everything inside it. An empty text says the glyphs
/// say nothing, and they are dropped. A run that does not sit on one line
/// keeps its own glyphs: its text would have nowhere to go.
pub fn with_actual_text(
    glyphs: Vec<PositionedGlyph>,
    inside: &[Vec<u32>],
    texts: &[Option<String>],
) -> Vec<PositionedGlyph> {
    let span_of = |i: usize| -> Option<u32> {
        inside
            .get(i)?
            .iter()
            .copied()
            .find(|k| matches!(texts.get(*k as usize), Some(Some(_))))
    };
    // Glyph indices of each span, in drawing order.
    let mut runs: std::collections::BTreeMap<u32, Vec<usize>> = Default::default();
    for i in 0..glyphs.len() {
        if let Some(k) = span_of(i) {
            runs.entry(k).or_default().push(i);
        }
    }
    let mut replaced: std::collections::HashMap<usize, Option<PositionedGlyph>> =
        Default::default();
    for (k, members) in &runs {
        let text = texts[*k as usize].clone().unwrap_or_default();
        let run: Vec<&PositionedGlyph> = members.iter().map(|&i| &glyphs[i]).collect();
        let base = run
            .iter()
            .find(|g| g.advance > 0.0)
            .copied()
            .unwrap_or(run[0]);
        if run
            .iter()
            .any(|g| (g.y - base.y).abs() > base.size.max(1.0) * 1.5)
        {
            continue;
        }
        let merged = (!text.is_empty()).then(|| {
            let (left, right) = if base.angle.abs() < 0.01 {
                let left = run.iter().map(|g| g.x).fold(f32::INFINITY, f32::min);
                let right = run
                    .iter()
                    .map(|g| g.x + g.advance)
                    .fold(f32::NEG_INFINITY, f32::max);
                (left, right)
            } else {
                (base.x, base.x + run.iter().map(|g| g.advance).sum::<f32>())
            };
            PositionedGlyph {
                x: left,
                advance: (right - left).max(0.0),
                text: Some(text),
                ..base.clone()
            }
        });
        // The run's text goes where its first glyph was drawn; the rest go.
        replaced.insert(members[0], merged);
        for &i in &members[1..] {
            replaced.insert(i, None);
        }
    }
    glyphs
        .into_iter()
        .enumerate()
        .filter_map(|(i, g)| match replaced.remove(&i) {
            Some(merged) => merged,
            None => Some(g),
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq)]
pub struct TextLine {
    pub text: String,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub direction: Direction,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Class {
    Rtl,
    Ltr,
    Num,
    Neutral,
}

fn classify(c: char) -> Class {
    use unicode_script::{Script, UnicodeScript};
    // The Arabic decimal and thousands separators are part of the number they
    // sit in (UAX #9 class AN, as the digits are): read as letters, they cut
    // "٧٥٫٠٠" in two and turned it round as "٠٠٫٧٥".
    if c.is_ascii_digit()
        || ('\u{0660}'..='\u{0669}').contains(&c)
        || ('\u{06F0}'..='\u{06F9}').contains(&c)
        || c == '\u{066B}'
        || c == '\u{066C}'
    {
        return Class::Num;
    }
    // The Arabic percent sign ends a number as `%` does (UAX #9 class ET).
    if c == '\u{066A}' {
        return Class::Neutral;
    }
    if crate::normalize::is_mark_or_control(c) {
        return Class::Neutral;
    }
    match c.script() {
        Script::Arabic | Script::Hebrew | Script::Syriac | Script::Thaana | Script::Nko => {
            Class::Rtl
        }
        Script::Common | Script::Inherited => Class::Neutral,
        _ if c.is_alphabetic() => Class::Ltr,
        _ => Class::Neutral,
    }
}

/// Glyphs of one line, paired with their index in content order.
type LineGlyphs<'a> = Vec<(usize, &'a PositionedGlyph)>;

/// A line: baseline y, font size, and its glyphs.
type Line<'a> = (f32, f32, LineGlyphs<'a>);

/// A base character with the combining marks that follow it in the visual sequence.
#[derive(Clone, Debug)]
struct Unit {
    chars: Vec<char>,
    class: Class,
}

fn units(visual: &[char]) -> Vec<Unit> {
    units_from_clusters(&visual.iter().map(|c| c.to_string()).collect::<Vec<_>>())
}

/// Build reordering units from visual clusters. A cluster (one glyph's text,
/// logical inside itself, e.g. a folded ligature "لا") is never split; marks
/// join the preceding unit.
fn units_from_clusters(clusters: &[String]) -> Vec<Unit> {
    let mut out: Vec<Unit> = vec![];
    for text in clusters {
        let chars: Vec<char> = text.chars().collect();
        if chars.is_empty() {
            continue;
        }
        let is_mark = crate::normalize::is_mark_or_control(chars[0]);
        match out.last_mut() {
            Some(u) if is_mark => u.chars.extend(chars),
            _ => {
                let class = chars
                    .iter()
                    .map(|c| classify(*c))
                    .find(|c| *c != Class::Neutral)
                    .unwrap_or(Class::Neutral);
                out.push(Unit { chars, class })
            }
        }
    }
    out
}

/// Reverse a visual char sequence into logical order.
pub fn visual_to_logical(visual: &[char]) -> (String, Direction) {
    reorder_units(units(visual))
}

/// Reverse a visual sequence of clusters into logical order.
pub fn clusters_to_logical(clusters: &[String]) -> (String, Direction) {
    reorder_units(units_from_clusters(clusters))
}

fn reorder_units(units: Vec<Unit>) -> (String, Direction) {
    // Base direction of a visual line: the logical start of an RTL paragraph is its RIGHT end,
    // so the rightmost strong letter decides; a line without RTL letters is LTR. ("The word كتاب"
    // is the known ambiguity: geometry and content order refine this in reconstruct_lines.)
    let rightmost = units
        .iter()
        .rev()
        .find(|u| matches!(u.class, Class::Rtl | Class::Ltr))
        .map(|u| u.class);
    let has_rtl = units.iter().any(|u| u.class == Class::Rtl);
    let base = match rightmost {
        Some(Class::Rtl) => Direction::Rtl,
        Some(Class::Ltr) => Direction::Ltr,
        _ if has_rtl => Direction::Rtl,
        _ => Direction::Ltr,
    };
    // Embedded-run membership (the inverse of UAX #9 W5/W7/N1 applied to a visual sequence):
    //  * RTL base: Latin letters and numbers are members; a European terminator (%, °, currency)
    //    next to a number joins it (W5); neutrals (incl. spaces) between two members join only
    //    when both sides are Latin-attached, because numbers count as RTL for neutrals (N1) unless
    //    Latin text precedes them (W7). "items 3" and "3 items" are the same visual sequence, so the
    //    W7 reading (Latin first) is preferred; Phase 2 adds content-stream order as a tie breaker.
    //  * LTR base: Arabic letters are members; neutrals between two of them join.
    let n = units.len();
    let mut member: Vec<bool> = units
        .iter()
        .map(|u| match base {
            Direction::Rtl => matches!(u.class, Class::Ltr | Class::Num),
            Direction::Ltr => u.class == Class::Rtl,
        })
        .collect();
    if base == Direction::Rtl {
        let is_et = |u: &Unit| {
            u.chars.len() == 1
                && unicode_bidi::bidi_class(u.chars[0]) == unicode_bidi::BidiClass::ET
        };
        for i in 0..n {
            // W5 joins a terminator to a European number only: beside
            // Arabic-Indic digits (class AN) `٪` and `%` stay neutral.
            let european = !units[i].chars.iter().any(|c| {
                ('\u{0660}'..='\u{0669}').contains(c) || matches!(c, '\u{066B}' | '\u{066C}')
            });
            if units[i].class == Class::Num && european {
                let mut j = i + 1;
                while j < n && is_et(&units[j]) {
                    member[j] = true;
                    j += 1;
                }
                let mut j = i as isize - 1;
                while j >= 0 && is_et(&units[j as usize]) {
                    member[j as usize] = true;
                    j -= 1;
                }
            }
        }
    }
    // Latin-attached kind of each member (RTL base): a number joins Latin text when a Latin member
    // is on either side of it within a chain that contains no RTL letter and no bracket (bracket
    // pairs take the embedding direction, UAX #9 N0, so they split chains).
    // only true bracket pairs (UAX #9 BD14/BD15) split chains; < > and quotation marks do not
    let is_bracket =
        |u: &Unit| u.chars.len() == 1 && matches!(u.chars[0], '(' | ')' | '[' | ']' | '{' | '}');
    let mut latin_kind: Vec<bool> = units.iter().map(|u| u.class == Class::Ltr).collect();
    for forward in [true, false] {
        let mut attached = false;
        let idx: Vec<usize> = if forward {
            (0..n).collect()
        } else {
            (0..n).rev().collect()
        };
        for i in idx {
            match units[i].class {
                Class::Ltr => attached = true,
                Class::Rtl => attached = false,
                Class::Num if member[i] => latin_kind[i] |= attached,
                _ if is_bracket(&units[i]) => attached = false,
                _ => {}
            }
        }
    }
    let mut i = 0;
    while i < n {
        if !member[i] && units[i].class == Class::Neutral {
            let mut j = i;
            while j < n && !member[j] && units[j].class == Class::Neutral {
                j += 1;
            }
            let has_bracket = (i..j).any(|k| is_bracket(&units[k]));
            // W4: a single separator (, . / : - +) between two numbers keeps the number together
            let single_separator = j == i + 1
                && units[i].chars.len() == 1
                && matches!(
                    unicode_bidi::bidi_class(units[i].chars[0]),
                    unicode_bidi::BidiClass::CS | unicode_bidi::BidiClass::ES
                );
            let join = !has_bracket
                && i > 0
                && member[i - 1]
                && j < n
                && member[j]
                && match base {
                    Direction::Rtl => {
                        (latin_kind[i - 1] && latin_kind[j])
                            || (single_separator
                                && units[i - 1].class == Class::Num
                                && units[j].class == Class::Num)
                    }
                    Direction::Ltr => true,
                };
            if join {
                for k in i..j {
                    member[k] = true;
                    latin_kind[k] = true;
                }
            }
            i = j;
        } else {
            i += 1;
        }
    }
    let mirror = |u: &Unit| -> Vec<char> { u.chars.iter().map(|c| mirror_bracket(*c)).collect() };
    let mut out: Vec<char> = Vec::with_capacity(units.len() * 2);
    match base {
        Direction::Rtl => {
            // reverse everything (mirroring brackets outside embedded runs), then restore embedded LTR runs
            let mut rev: Vec<(Vec<char>, bool)> = units
                .iter()
                .zip(member.iter())
                .rev()
                .map(|(u, m)| (if *m { u.chars.clone() } else { mirror(u) }, *m))
                .collect();
            let mut k = 0;
            while k < rev.len() {
                if rev[k].1 {
                    let mut e = k;
                    while e < rev.len() && rev[e].1 {
                        e += 1;
                    }
                    rev[k..e].reverse();
                    k = e;
                } else {
                    k += 1;
                }
            }
            for (chars, _) in rev {
                out.extend(chars);
            }
        }
        Direction::Ltr => {
            let mut k = 0;
            while k < n {
                if member[k] {
                    let mut e = k;
                    while e < n && member[e] {
                        e += 1;
                    }
                    for u in units[k..e].iter().rev() {
                        out.extend(mirror(u));
                    }
                    k = e;
                } else {
                    out.extend(units[k].chars.iter().copied());
                    k += 1;
                }
            }
        }
    }
    (out.into_iter().collect(), base)
}

/// Skia and Word often map the shared yeh/kaf glyphs of Arabic fonts to the Persian code points
/// (U+06CC, U+06A9). In a line that has Arabic letters but no Persian-only letters, restore the
/// Arabic code points so that copy and search behave for Arabic text.
pub fn normalize_persian_letters(s: &str) -> String {
    let persian_only = s.chars().any(|c| {
        matches!(
            c,
            'پ' | 'چ' | 'ژ' | 'گ' | 'ڤ' | 'ں' | 'ے' | 'ھ' | 'ٹ' | 'ڈ' | 'ڑ' | '۰'..='۹'
        )
    });
    if persian_only || !s.chars().any(|c| ('\u{0600}'..='\u{06FF}').contains(&c)) {
        return s.to_string();
    }
    s.chars()
        .map(|c| match c {
            'ی' => 'ي',
            'ک' => 'ك',
            other => other,
        })
        .collect()
}

/// Recompose a skeleton letter followed by combining dot marks (see the render crate) into the
/// dotted letter: ٮ + dot below = ب, ٯ + two dots above = ق, ه + two dots above = ة, ...
pub fn recompose_dots(cluster: &str) -> String {
    let chars: Vec<char> = cluster.chars().collect();
    if chars.len() < 2 {
        return cluster.to_string();
    }
    let dots = |c: char| match c {
        '\u{0307}' => Some((true, 1)),
        '\u{0308}' => Some((true, 2)),
        '\u{20DB}' => Some((true, 3)),
        '\u{0323}' => Some((false, 1)),
        '\u{0324}' => Some((false, 2)),
        '\u{20E8}' => Some((false, 3)),
        _ => None,
    };
    let mut out = String::with_capacity(cluster.len());
    let mut i = 0;
    while i < chars.len() {
        let base = chars[i];
        let mut j = i + 1;
        let mut letter = base;
        while j < chars.len() {
            if let Some((above, n)) = dots(chars[j]) {
                letter = match (letter, above, n) {
                    ('ٮ', false, 1) => 'ب',
                    ('ٮ', true, 2) => 'ت',
                    ('ٮ', true, 3) => 'ث',
                    ('ٮ', true, 1) | ('ں', true, 1) => 'ن',
                    ('ٮ', false, 2) | ('ى', false, 2) => 'ي',
                    ('ٮ', false, 3) => 'پ',
                    ('ح', true, 1) => 'خ',
                    ('ح', false, 1) => 'ج',
                    ('ح', false, 3) => 'چ',
                    ('د', true, 1) => 'ذ',
                    ('ر', true, 1) => 'ز',
                    ('ر', true, 3) => 'ژ',
                    ('س', true, 3) => 'ش',
                    ('ص', true, 1) => 'ض',
                    ('ط', true, 1) => 'ظ',
                    ('ع', true, 1) => 'غ',
                    ('ڡ', true, 1) => 'ف',
                    ('ڡ', true, 3) => 'ڤ',
                    ('ٯ', true, 2) => 'ق',
                    ('ه', true, 2) => 'ة',
                    ('ک', true, 1) | ('ك', true, 1) => 'ك',
                    (other, _, _) => {
                        out.push(other);
                        out.push(chars[j]);
                        letter = '\0';
                        j += 1;
                        continue;
                    }
                };
                j += 1;
            } else {
                break;
            }
        }
        if letter != '\0' {
            out.push(letter);
        }
        i = j;
    }
    out
}

struct Cluster {
    x: f32,
    adv: f32,
    text: String,
}

/// Group glyphs into lines, order clusters by position, attach marks, and
/// convert each line to logical order.
const PLACEHOLDER: &str = "\u{FFFD}";

/// Text of a glyph, or the placeholder when the producer gave it none.
fn glyph_text(g: &PositionedGlyph) -> &str {
    g.text
        .as_deref()
        .filter(|t| !t.is_empty())
        .unwrap_or(PLACEHOLDER)
}

pub fn reconstruct_lines(glyphs: &[PositionedGlyph]) -> Vec<TextLine> {
    // The slice is in CONTENT order, which carries information geometry does not:
    // a shaper emits a mark immediately next to the base it belongs to (before it
    // for right-to-left runs, after it for left-to-right ones) and positions it at
    // that base's pen origin. Attaching by box containment instead gets marks wrong
    // whenever the offset pushes them just outside their base's advance box.
    let indexed: Vec<(usize, &PositionedGlyph)> = glyphs
        .iter()
        .enumerate()
        .filter(|(_, g)| g.size > 0.0)
        .collect();
    if indexed.is_empty() {
        return vec![];
    }
    let is_mark = |g: &PositionedGlyph| {
        glyph_text(g)
            .chars()
            .next()
            .map(crate::normalize::is_mark_or_control)
            .unwrap_or(false)
    };
    // Glyphs are grouped per baseline angle, each in its own frame, so a rotated
    // sidebar (real documents put them beside the text) never joins a horizontal
    // paragraph and stretches its box. A sixteenth of a turn is fine enough:
    // text is almost always axis-aligned or at a deliberate slant.
    const SECTOR: f32 = std::f32::consts::TAU / 16.0;
    let bucket = |a: f32| (a / SECTOR).round() as i32;
    // Position along and across the baseline of a run at angle `a`, in that
    // run's own frame: x grows in reading order along the baseline, y grows down
    // the page as the run sees it. `a` is y-up (the renderer negates it) while
    // these coordinates are y-down, so the rotation is by +a. It used to be by
    // -a, which mirrored every rotated run: a sidebar read "cilbuP" for "Public".
    // For horizontal text (a = 0) this is the identity, so nothing else moves.
    let frame = |g: &PositionedGlyph, a: f32| -> (f32, f32) {
        let (s, c) = a.sin_cos();
        (g.x * c - g.y * s, g.x * s + g.y * c)
    };
    let mut angles: Vec<i32> = indexed.iter().map(|(_, g)| bucket(g.angle)).collect();
    angles.sort_unstable();
    angles.dedup();

    // 1. lines from base glyphs, in reading order down each run's own axis
    let mut lines: Vec<Line> = vec![];
    // the angle of each line, parallel to `lines`
    let mut line_angles: Vec<f32> = vec![];
    let mut marks: LineGlyphs = vec![];
    for b in angles {
        // The frame turns by the run's own slant — the median of its glyphs'
        // — not the sector's middle: a crooked scan's text layer, turned with
        // it, keeps its lines apart only along its real slant. Within half a
        // degree of the middle the middle is kept, so straight text, and
        // text turned by a whole quarter, read exactly as they always have.
        let middle = b as f32 * SECTOR;
        let mut slants: Vec<f32> = indexed
            .iter()
            .filter(|(_, g)| bucket(g.angle) == b)
            .map(|(_, g)| g.angle)
            .collect();
        slants.sort_by(f32::total_cmp);
        let slant = slants.get(slants.len() / 2).copied().unwrap_or(middle);
        let angle = if (slant - middle).abs() < 0.5f32.to_radians() {
            middle
        } else {
            slant
        };
        let mut sorted: Vec<(usize, &PositionedGlyph)> = indexed
            .iter()
            .copied()
            .filter(|(_, g)| bucket(g.angle) == b)
            .collect();
        sorted.sort_by(|a, b| {
            let (ax, ay) = frame(a.1, angle);
            let (bx, by) = frame(b.1, angle);
            ay.partial_cmp(&by)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(ax.partial_cmp(&bx).unwrap_or(std::cmp::Ordering::Equal))
        });
        // A new angle never continues the previous angle's last line: the two
        // `y`s are measured in different frames and only coincide by accident.
        let first_line_of_angle = lines.len();
        for (ci, g) in sorted {
            if is_mark(g) {
                marks.push((ci, g));
                continue;
            }
            let (_, gy) = frame(g, angle);
            let continuing = lines.len() > first_line_of_angle;
            match lines.last_mut() {
                Some((y, size, v))
                    if continuing && (gy - *y).abs() <= 0.55 * size.max(g.size).max(1.0) =>
                {
                    v.push((ci, g))
                }
                _ => {
                    lines.push((gy, g.size, vec![(ci, g)]));
                    line_angles.push(angle);
                }
            }
        }
    }
    // Along each line's own baseline. Screen x only works for horizontal text:
    // every glyph of a vertical line has the same one.
    for ((_, _, v), angle) in lines.iter_mut().zip(&line_angles) {
        v.sort_by(|a, b| {
            frame(a.1, *angle)
                .0
                .partial_cmp(&frame(b.1, *angle).0)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
    }

    // 2. attach marks: the owning base is content-adjacent and shares the mark's pen origin
    let mut where_base: std::collections::HashMap<usize, (usize, usize)> = Default::default();
    for (li, (_, _, v)) in lines.iter().enumerate() {
        for (pos, (ci, _)) in v.iter().enumerate() {
            where_base.insert(*ci, (li, pos));
        }
    }
    let mut base_indices: Vec<usize> = where_base.keys().copied().collect();
    base_indices.sort_unstable();
    let mut attached: Vec<LineGlyphs> = vec![vec![]; lines.len()];
    for (ci, m) in marks {
        let after = base_indices.partition_point(|b| *b < ci);
        let candidates: Vec<usize> = [
            after.checked_sub(1).map(|i| base_indices[i]),
            base_indices.get(after).copied(),
        ]
        .into_iter()
        .flatten()
        .collect();
        let is_space = |bi: &usize| -> bool {
            let (li, pos) = where_base[bi];
            glyph_text(lines[li].2[pos].1).trim().is_empty()
        };
        let on_same_line = |bi: &usize| -> bool {
            let (li, _) = where_base[bi];
            (lines[li].0 - frame(m, line_angles[li]).1).abs()
                <= 0.8 * lines[li].1.max(m.size).max(1.0)
        };
        // a combining mark belongs to a letter, never to a space
        let chosen = candidates
            .iter()
            .filter(|bi| on_same_line(bi) && !is_space(bi))
            .min_by(|a, b| {
                let dx = |bi: &usize| {
                    let (li, pos) = where_base[bi];
                    let a = line_angles[li];
                    (frame(lines[li].2[pos].1, a).0 - frame(m, a).0).abs()
                };
                dx(a)
                    .partial_cmp(&dx(b))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .copied()
            // nothing content-adjacent on this line: fall back to the nearest base centre
            .or_else(|| {
                let li = lines
                    .iter()
                    .enumerate()
                    .min_by(|(ai, a), (bi, b)| {
                        let da = (a.0 - frame(m, line_angles[*ai]).1).abs();
                        let db = (b.0 - frame(m, line_angles[*bi]).1).abs();
                        da.partial_cmp(&db).unwrap()
                    })?
                    .0;
                let mc = m.x + m.advance / 2.0;
                lines[li]
                    .2
                    .iter()
                    .min_by(|a, b| {
                        ((a.1.x + a.1.advance / 2.0) - mc)
                            .abs()
                            .partial_cmp(&((b.1.x + b.1.advance / 2.0) - mc).abs())
                            .unwrap()
                    })
                    .map(|(ci, _)| *ci)
            });
        if let Some(bi) = chosen {
            let (li, pos) = where_base[&bi];
            attached[li].push((pos, m));
        }
    }

    let mut out = vec![];
    for (li, ((y, size, bases), angle)) in lines.into_iter().zip(line_angles).enumerate() {
        let mut clusters: Vec<Cluster> = bases
            .iter()
            .map(|(_, g)| Cluster {
                // along the baseline, so word gaps are measured the way the run reads
                x: frame(g, angle).0,
                adv: g.advance,
                text: glyph_text(g).to_string(),
            })
            .collect();
        for (pos, m) in &attached[li] {
            if let Some(c) = clusters.get_mut(*pos) {
                let t = glyph_text(m);
                let first = t.chars().next().unwrap_or('\0');
                let dot =
                    t.chars().count() == 1 && matches!(first, '\u{0307}' | '\u{0308}' | '\u{20DB}');
                if !dot {
                    c.text.push_str(t);
                    continue;
                }
                // recovered dot glyphs sit clearly above or below the baseline (y grows downwards);
                // a blob on the baseline is a small letter form, not a dot
                let dy = frame(m, angle).1 - y;
                if dy.abs() < 0.08 * size {
                    c.text.push('\u{FFFD}');
                } else if dy > 0.0 {
                    c.text.push(match first {
                        '\u{0307}' => '\u{0323}',
                        '\u{0308}' => '\u{0324}',
                        _ => '\u{20E8}',
                    });
                } else {
                    c.text.push(first);
                }
            }
        }
        for c in clusters.iter_mut() {
            c.text = recompose_dots(&c.text);
        }
        // 3. visual string with spaces on gaps
        let median_adv = {
            let mut a: Vec<f32> = clusters
                .iter()
                .map(|c| c.adv)
                .filter(|a| *a > 0.0)
                .collect();
            a.sort_by(|x, y| x.partial_cmp(y).unwrap());
            a.get(a.len() / 2).copied().unwrap_or(size * 0.5)
        };
        // Lines that carry explicit space glyphs only get extra spaces on wide gaps (cells,
        // columns); lines without any get them on word-sized gaps. Advances may be off when
        // the producer positioned glyphs with metrics of another font instance.
        let has_space_glyphs = clusters
            .iter()
            .any(|c| c.text.trim().is_empty() && !c.text.is_empty());
        let gap_threshold = if has_space_glyphs { 0.7 } else { 0.25 } * size.max(1.0);
        let mut visual: Vec<String> = vec![];
        let mut prev_end: Option<f32> = None;
        for c in &clusters {
            if let Some(pe) = prev_end {
                let gap = c.x - pe;
                if gap > gap_threshold
                    && !visual.last().map(|t| t.ends_with(' ')).unwrap_or(true)
                    && !c.text.starts_with(' ')
                {
                    visual.push(" ".to_string());
                }
            }
            visual.push(fold_presentation_forms(&c.text));
            prev_end = Some(c.x + if c.adv > 0.0 { c.adv } else { median_adv });
        }
        let (logical, direction) = clusters_to_logical(&visual);
        let text: String = normalize_persian_letters(&logical.nfc().collect::<String>())
            .trim()
            .to_string();
        if text.is_empty() || text.chars().all(|c| c == '\u{FFFD}') {
            continue;
        }
        let x0 = clusters.first().map(|c| c.x).unwrap_or(0.0);
        let x1 = clusters
            .last()
            .map(|c| c.x + c.adv.max(median_adv))
            .unwrap_or(x0);
        // Horizontal lines keep exactly the box they always had. A rotated line
        // reports where it sits on the page, which is what hit-testing and the
        // text layer need, rather than coordinates in its own frame.
        let (bx, by, bw, bh) = if angle == 0.0 {
            (x0, y - size, x1 - x0, size * 1.2)
        } else {
            let xs = bases.iter().map(|(_, g)| g.x);
            let ys = bases.iter().map(|(_, g)| g.y);
            let (min_x, max_x) =
                xs.fold((f32::MAX, f32::MIN), |(lo, hi), v| (lo.min(v), hi.max(v)));
            let (min_y, max_y) =
                ys.fold((f32::MAX, f32::MIN), |(lo, hi), v| (lo.min(v), hi.max(v)));
            (
                min_x - size,
                min_y - size,
                max_x - min_x + 2.0 * size,
                max_y - min_y + 2.0 * size,
            )
        };
        out.push(TextLine {
            text,
            x: bx,
            y: by,
            width: bw,
            height: bh,
            direction,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bidi::to_visual;

    fn glyphs_from_visual(visual: &str, y: f32) -> Vec<PositionedGlyph> {
        visual
            .chars()
            .enumerate()
            .map(|(i, c)| PositionedGlyph {
                x: i as f32 * 10.0,
                y,
                angle: 0.0,
                size: 10.0,
                advance: 10.0,
                text: Some(c.to_string()),
                gid: 0,
                font: 0,
            })
            .collect()
    }

    /// A run turned a quarter turn, as sidebars and table headers are. `up`
    /// reads bottom-to-top (device y falls along the text), otherwise top-to-
    /// bottom. `angle` is what the renderer records: the baseline direction in
    /// y-up terms, so a run climbing the screen is +π/2.
    fn rotated_run(text: &str, x: f32, start_y: f32, up: bool) -> Vec<PositionedGlyph> {
        let step = if up { -10.0 } else { 10.0 };
        let angle = if up {
            std::f32::consts::FRAC_PI_2
        } else {
            -std::f32::consts::FRAC_PI_2
        };
        text.chars()
            .enumerate()
            .map(|(i, c)| PositionedGlyph {
                x,
                y: start_y + i as f32 * step,
                angle,
                size: 10.0,
                advance: 10.0,
                text: Some(c.to_string()),
                gid: 0,
                font: 0,
            })
            .collect()
    }

    /// Regression: the World Bank Word export's margin note read
    /// "cilbuPrusolcsiD…" — every rotated run came out backwards, because the
    /// run's own frame was mirrored and the line was then re-sorted by screen x,
    /// which is the same for every glyph of a vertical line.
    #[test]
    fn a_run_turned_a_quarter_turn_reads_forwards_in_both_directions() {
        for up in [true, false] {
            let lines = reconstruct_lines(&rotated_run("Public Disclosure", 30.0, 600.0, up));
            let texts: Vec<&str> = lines.iter().map(|l| l.text.as_str()).collect();
            assert_eq!(texts, ["Public Disclosure"], "up={up}");
        }
    }

    /// Two margin notes side by side are two lines, read in order across the
    /// margin — and neither may borrow glyphs from horizontal body text that
    /// happens to sit at the same coordinate in its own frame.
    #[test]
    fn rotated_lines_stay_apart_from_each_other_and_from_body_text() {
        let mut glyphs = rotated_run("Authorized", 30.0, 600.0, true);
        glyphs.extend(rotated_run("Public", 45.0, 600.0, true));
        glyphs.extend(glyphs_from_visual("body text", 30.0));
        let lines = reconstruct_lines(&glyphs);
        let texts: Vec<&str> = lines.iter().map(|l| l.text.as_str()).collect();
        assert!(texts.contains(&"Authorized"), "{texts:?}");
        assert!(texts.contains(&"Public"), "{texts:?}");
        assert!(texts.contains(&"body text"), "{texts:?}");
        assert_eq!(lines.len(), 3, "{texts:?}");
    }

    const LINES: &[&str] = &[
        "فاتورة ضريبية مبسطة",
        "رقم الفاتورة: INV-2026-0042",
        "التاريخ: ١٦ سبتمبر ٢٠٢٦",
        "اشتراك سنوي في خدمة Warraq Pro | 1 | 1,200.00 | 1,200.00",
        "ضريبة القيمة المضافة (15%): 450.00 ر.س",
        "شكراً لتعاملكم معنا — Thank you for your business",
        "اشترى أحمد 3 كتب من متجر Amazon بسعر 45.50 دولاراً (شامل الضريبة) في 12/09/2026.",
        "The word كتاب means book in Arabic, and مكتبة means library.",
        "رقم الهاتف: +966 50 123 4567",
        "نسبة النمو (12.5%) مقارنة بـ (10%) العام الماضي",
        "المجموع ٧٥٫٠٠ ر.س",
        "الإجمالي: ١٬٥٠٠٫٥٠ ر.س شاملًا ١٥٪ ضريبة",
        "قال: «مرحباً» ثم غادر.",
        "استخدم الاختصار Ctrl+S للحفظ ثم اضغط File > Save As.",
        "زبان فارسی: پژوهش، گچ، ژاله، کتاب، یک، آموزش",
    ];

    #[test]
    fn visual_to_logical_round_trips_every_corpus_line() {
        for line in LINES {
            let visual: Vec<char> = to_visual(line).chars().collect();
            let (logical, _) = visual_to_logical(&visual);
            assert_eq!(
                logical,
                *line,
                "visual was {:?}",
                visual.iter().collect::<String>()
            );
        }
    }

    #[test]
    fn reconstruct_lines_orders_lines_top_to_bottom_and_returns_logical_text() {
        let mut g = glyphs_from_visual(&to_visual(LINES[1]), 100.0);
        g.extend(glyphs_from_visual(&to_visual(LINES[0]), 50.0));
        g.reverse(); // content order must not matter
        let lines = reconstruct_lines(&g);
        assert_eq!(
            lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>(),
            vec![LINES[0], LINES[1]]
        );
        assert_eq!(lines[0].direction, Direction::Rtl);
    }

    #[test]
    fn marks_are_attached_to_their_base_and_presentation_forms_folded() {
        // base "ب" at x=20 with a fatha drawn 2 units to the right (visual) and 4 units above
        let mut g = glyphs_from_visual(&to_visual("كتب"), 100.0);
        g.push(PositionedGlyph {
            x: 22.0,
            y: 96.0,
            angle: 0.0,
            size: 10.0,
            advance: 0.0,
            text: Some("\u{064E}".into()),
            gid: 0,
            font: 0,
        });
        let lines = reconstruct_lines(&g);
        assert_eq!(lines[0].text, "كَتب");
        let pres = vec![PositionedGlyph {
            x: 0.0,
            y: 0.0,
            angle: 0.0,
            size: 10.0,
            advance: 10.0,
            text: Some("\u{FEFB}".into()),
            gid: 0,
            font: 0,
        }];
        assert_eq!(reconstruct_lines(&pres)[0].text, "لا");
    }

    #[test]
    fn skeleton_letters_with_combining_dots_recompose() {
        assert_eq!(recompose_dots("ٮ\u{0323}"), "ب");
        assert_eq!(recompose_dots("ٯ\u{0308}"), "ق");
        assert_eq!(recompose_dots("ه\u{0308}"), "ة");
        assert_eq!(recompose_dots("ڡ\u{0307}"), "ف");
        assert_eq!(recompose_dots("س\u{20DB}"), "ش");
        assert_eq!(recompose_dots("ب\u{064E}"), "ب\u{064E}"); // real marks untouched
        assert_eq!(recompose_dots("ا"), "ا");
    }

    #[test]
    fn lines_slanting_a_few_degrees_read_along_their_slant() {
        // Two lines of letters, 8° counter-clockwise (y grows down): across
        // the width each drifts two lines' height, so read level they mix.
        let slant = 8f32.to_radians();
        let line = |text: &str, y0: f32| -> Vec<PositionedGlyph> {
            text.chars()
                .enumerate()
                .map(|(i, c)| {
                    let along = i as f32 * 30.0;
                    PositionedGlyph {
                        x: 100.0 + along * slant.cos(),
                        y: y0 - along * slant.sin(),
                        angle: slant,
                        size: 12.0,
                        advance: 10.0,
                        text: Some(c.to_string()),
                        gid: 1,
                        font: 0,
                    }
                })
                .collect()
        };
        let mut glyphs = line("abcdefghijklmn", 300.0);
        glyphs.extend(line("opqrstuvwxyz", 324.0));
        let lines: Vec<String> = reconstruct_lines(&glyphs)
            .into_iter()
            .map(|l| l.text)
            .collect();
        assert_eq!(
            lines,
            ["a b c d e f g h i j k l m n", "o p q r s t u v w x y z"]
        );
    }

    #[test]
    fn a_run_with_actual_text_reads_as_that_text() {
        // Amiri's الخير: the kha is two glyphs, the second without text.
        let glyph = |x: f32, text: Option<&str>| PositionedGlyph {
            x,
            y: 100.0,
            angle: 0.0,
            size: 12.0,
            advance: 5.0,
            text: text.map(str::to_string),
            gid: 1,
            font: 0,
        };
        let glyphs = vec![
            glyph(0.0, Some("ر")),
            glyph(5.0, Some("ي")),
            glyph(10.0, Some("خ")),
            glyph(15.0, None),
            glyph(20.0, Some("ل")),
            glyph(25.0, Some("ا")),
            glyph(40.0, Some("في")),
        ];
        let inside = vec![vec![0], vec![0], vec![0], vec![0], vec![0], vec![0], vec![]];
        let texts = vec![Some("الخير".to_string())];
        let out = with_actual_text(glyphs.clone(), &inside, &texts);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].text.as_deref(), Some("الخير"));
        assert_eq!(
            (out[0].x, out[0].advance),
            (0.0, 30.0),
            "the whole word's width"
        );
        let lines = reconstruct_lines(&out);
        assert_eq!(lines[0].text, "في الخير");

        // Without the text, the glyphs are read as they are.
        assert_eq!(with_actual_text(glyphs.clone(), &inside, &[None]), glyphs);
        // An empty text: decoration, not read at all.
        let dropped = with_actual_text(glyphs, &inside, &[Some(String::new())]);
        assert_eq!(dropped.len(), 1);
    }

    #[test]
    fn gaps_between_clusters_become_spaces() {
        let g = vec![
            PositionedGlyph {
                x: 0.0,
                y: 0.0,
                angle: 0.0,
                size: 10.0,
                advance: 10.0,
                text: Some("a".into()),
                gid: 0,
                font: 0,
            },
            PositionedGlyph {
                x: 30.0,
                y: 0.0,
                angle: 0.0,
                size: 10.0,
                advance: 10.0,
                text: Some("b".into()),
                gid: 0,
                font: 0,
            },
        ];
        assert_eq!(reconstruct_lines(&g)[0].text, "a b");
    }
}
