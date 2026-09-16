//! Unicode Bidirectional Algorithm (UAX #9) helpers over the `unicode-bidi` crate.
//!
//! `unicode-bidi` 0.3.18 resolves a European terminator that *follows* a number
//! (`15%`) to the paragraph level instead of the number's level (rule W5), which
//! renders `(15%)` as `(%15)` in Arabic text. We therefore take its per-character
//! levels, repair W5, and reorder ourselves.
use std::ops::Range;
use unicode_bidi::{bidi_class, BidiClass, BidiInfo, Level};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Ltr,
    Rtl,
}

/// One run of a line in VISUAL order (left to right on the page).
/// `range` is a byte range into the LOGICAL string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VisualRun {
    pub range: Range<usize>,
    pub direction: Direction,
    pub level: u8,
}

/// Base direction of a paragraph: first strong character wins, LTR when none (UAX #9 P3).
pub fn base_direction(text: &str) -> Direction {
    let info = BidiInfo::new(text, None);
    match info.paragraphs.first() {
        Some(p) if p.level.is_ltr() => Direction::Ltr,
        Some(_) => Direction::Rtl,
        None => Direction::Ltr,
    }
}

/// Resolved embedding level of every character (with the W5 repair).
pub fn char_levels(line: &str) -> Vec<(usize, char, Level)> {
    let info = BidiInfo::new(line, None);
    let mut out: Vec<(usize, char, Level)> = line
        .char_indices()
        .map(|(i, c)| (i, c, info.levels[i]))
        .collect();
    // W5 repair: a run of European terminators directly after a European number takes the number's level
    let mut i = 0;
    while i < out.len() {
        if bidi_class(out[i].1) == BidiClass::EN {
            let en_level = out[i].2;
            let mut j = i + 1;
            while j < out.len() && bidi_class(out[j].1) == BidiClass::ET {
                out[j].2 = en_level;
                j += 1;
            }
            i = j;
        } else {
            i += 1;
        }
    }
    out
}

/// Resolve the visual runs of a single line of logical text.
pub fn visual_runs(line: &str) -> Vec<VisualRun> {
    let chars = char_levels(line);
    if chars.is_empty() {
        return vec![];
    }
    let levels: Vec<Level> = chars.iter().map(|c| c.2).collect();
    let visual: Vec<usize> = BidiInfo::reorder_visual(&levels);
    let mut runs: Vec<VisualRun> = vec![];
    for &ci in &visual {
        let (byte, ch, level) = chars[ci];
        let end = byte + ch.len_utf8();
        let dir = if level.is_rtl() {
            Direction::Rtl
        } else {
            Direction::Ltr
        };
        match runs.last_mut() {
            Some(r)
                if r.level == level.number()
                    && r.direction == dir
                    && (if dir == Direction::Ltr {
                        r.range.end == byte
                    } else {
                        r.range.start == end
                    }) =>
            {
                if dir == Direction::Ltr {
                    r.range.end = end;
                } else {
                    r.range.start = byte;
                }
            }
            _ => runs.push(VisualRun {
                range: byte..end,
                direction: dir,
                level: level.number(),
            }),
        }
    }
    runs
}

/// Reorder a logical line into the visual character sequence (test helper and
/// reference for `extract`): mirrors brackets in RTL runs like a renderer does.
pub fn to_visual(line: &str) -> String {
    let mut out = String::new();
    for r in visual_runs(line) {
        let seg = &line[r.range.clone()];
        match r.direction {
            Direction::Rtl => {
                // reverse by base+marks units: a mark glyph sits on its base, never before it
                let mut units: Vec<Vec<char>> = vec![];
                for c in seg.chars() {
                    match units.last_mut() {
                        Some(u) if crate::normalize::is_mark_or_control(c) => u.push(c),
                        _ => units.push(vec![c]),
                    }
                }
                for u in units.iter().rev() {
                    out.extend(u.iter().map(|c| crate::normalize::mirror_bracket(*c)));
                }
            }
            Direction::Ltr => out.push_str(seg),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn latin_run_with_numbers_stays_together_after_arabic_label() {
        let runs = visual_runs("رقم الفاتورة: INV-2026-0042");
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0].direction, Direction::Ltr);
        assert_eq!(
            &"رقم الفاتورة: INV-2026-0042"[runs[0].range.clone()],
            "INV-2026-0042"
        );
        assert_eq!(runs[1].direction, Direction::Rtl);
    }

    #[test]
    fn numbers_after_latin_belong_to_the_latin_run_w7() {
        let line = "اشتراك سنوي في خدمة Warraq Pro | 1 | 1,200.00 | 1,200.00";
        let runs = visual_runs(line);
        let ltr: Vec<&str> = runs
            .iter()
            .filter(|r| r.direction == Direction::Ltr)
            .map(|r| &line[r.range.clone()])
            .collect();
        assert_eq!(ltr, vec!["Warraq Pro | 1 | 1,200.00 | 1,200.00"]);
    }

    #[test]
    fn base_direction_detects_ltr_paragraph_with_arabic_words() {
        assert_eq!(base_direction("The word كتاب means book"), Direction::Ltr);
        assert_eq!(base_direction("كلمة book بالإنجليزية"), Direction::Rtl);
        assert_eq!(base_direction("1234"), Direction::Ltr);
    }

    #[test]
    fn percent_after_a_number_stays_with_the_number_w5() {
        assert_eq!(to_visual("ضريبة (15%)"), "(15%) ةبيرض");
        assert_eq!(to_visual("نسبة (12.5%) مقارنة"), "ةنراقم (12.5%) ةبسن");
        assert_eq!(to_visual("abc"), "abc");
    }
}
