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
    pub size: f32,
    /// Horizontal advance in the same units as `x`; 0 when unknown.
    pub advance: f32,
    pub text: Option<String>,
    pub gid: u32,
    pub font: u32,
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
    if c.is_ascii_digit()
        || ('\u{0660}'..='\u{0669}').contains(&c)
        || ('\u{06F0}'..='\u{06F9}').contains(&c)
    {
        return Class::Num;
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
            if units[i].class == Class::Num {
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
    let is_bracket = |u: &Unit| u.chars.len() == 1 && mirror_bracket(u.chars[0]) != u.chars[0];
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

struct Cluster {
    x: f32,
    adv: f32,
    text: String,
}

/// Group glyphs into lines, order clusters by position, attach marks, and
/// convert each line to logical order.
pub fn reconstruct_lines(glyphs: &[PositionedGlyph]) -> Vec<TextLine> {
    let mut items: Vec<&PositionedGlyph> = glyphs
        .iter()
        .filter(|g| g.text.as_ref().map(|t| !t.is_empty()).unwrap_or(false))
        .collect();
    if items.is_empty() {
        return vec![];
    }
    let is_mark = |g: &PositionedGlyph| {
        g.text
            .as_ref()
            .and_then(|t| t.chars().next())
            .map(crate::normalize::is_mark_or_control)
            .unwrap_or(false)
    };
    items.sort_by(|a, b| {
        a.y.partial_cmp(&b.y)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.x.partial_cmp(&b.x).unwrap_or(std::cmp::Ordering::Equal))
    });
    // 1. lines from base glyphs
    let mut lines: Vec<(f32, f32, Vec<&PositionedGlyph>)> = vec![]; // (baseline y, size, glyphs)
    let mut marks: Vec<&PositionedGlyph> = vec![];
    for g in items {
        if is_mark(g) {
            marks.push(g);
            continue;
        }
        match lines.last_mut() {
            Some((y, size, v)) if (g.y - *y).abs() <= 0.55 * size.max(g.size).max(1.0) => v.push(g),
            _ => lines.push((g.y, g.size, vec![g])),
        }
    }
    // 2. attach marks to a base on the nearest line: the base whose advance box contains the
    //    mark, else the nearest base center (bases are sorted by x first; indexes refer to that order)
    for (_, _, v) in lines.iter_mut() {
        v.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap_or(std::cmp::Ordering::Equal));
    }
    let mut attached: Vec<Vec<(usize, &PositionedGlyph)>> = vec![vec![]; lines.len()];
    for m in marks {
        let li = lines
            .iter()
            .enumerate()
            .min_by(|(_, a), (_, b)| (a.0 - m.y).abs().partial_cmp(&(b.0 - m.y).abs()).unwrap())
            .map(|(i, _)| i);
        if let Some(li) = li {
            let line = &lines[li].2;
            let mc = m.x + m.advance / 2.0;
            let inside = line.iter().position(|b| {
                b.advance > 0.0
                    && mc >= b.x - 0.05 * b.size
                    && mc <= b.x + b.advance + 0.05 * b.size
            });
            let bi = inside.unwrap_or_else(|| {
                line.iter()
                    .enumerate()
                    .min_by(|(_, a), (_, b)| {
                        ((a.x + a.advance / 2.0) - mc)
                            .abs()
                            .partial_cmp(&((b.x + b.advance / 2.0) - mc).abs())
                            .unwrap()
                    })
                    .map(|(i, _)| i)
                    .unwrap_or(0)
            });
            attached[li].push((bi, m));
        }
    }
    let mut out = vec![];
    for (li, (y, size, bases)) in lines.into_iter().enumerate() {
        let mut clusters: Vec<Cluster> = bases
            .iter()
            .map(|g| Cluster {
                x: g.x,
                adv: g.advance,
                text: g.text.clone().unwrap_or_default(),
            })
            .collect();
        for (bi, m) in &attached[li] {
            if let Some(c) = clusters.get_mut(*bi) {
                c.text.push_str(m.text.as_deref().unwrap_or(""));
            }
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
        // the producer positioned glyphs with metrics of another font instance (Skia + variable fonts).
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
        out.push(TextLine {
            text,
            x: x0,
            y: y - size,
            width: x1 - x0,
            height: size * 1.2,
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
                size: 10.0,
                advance: 10.0,
                text: Some(c.to_string()),
                gid: 0,
                font: 0,
            })
            .collect()
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
            size: 10.0,
            advance: 10.0,
            text: Some("\u{FEFB}".into()),
            gid: 0,
            font: 0,
        }];
        assert_eq!(reconstruct_lines(&pres)[0].text, "لا");
    }

    #[test]
    fn gaps_between_clusters_become_spaces() {
        let g = vec![
            PositionedGlyph {
                x: 0.0,
                y: 0.0,
                size: 10.0,
                advance: 10.0,
                text: Some("a".into()),
                gid: 0,
                font: 0,
            },
            PositionedGlyph {
                x: 30.0,
                y: 0.0,
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
