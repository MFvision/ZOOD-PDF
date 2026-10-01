//! Compare: what changed between two versions of a document — their text
//! word by word, in the order it is read, and how each page looks.
//!
//! The web and desktop hosts compare in the interface
//! (`packages/ui/src/compare`: `normalize.ts`, `diff.ts`, `comparison.ts`,
//! `visual.ts`); a native host has no such layer, so the same rules are here,
//! rule for rule, and the tests below are the interface's own cases. Both read
//! each page with `Document::extract_text` — logical order, so Arabic is
//! compared as it is read, not as the glyphs are laid out — and both compare
//! a page with the page in the same place of the other version.
//!
//! - `compare.text` (static): `{olderPassword?, newerPassword?, ignoreMarks?,
//!   unifyLetters?, context?}` + the older PDF + the newer one. Every page's
//!   words, compared; the changes counted as words added and removed and as
//!   places inserted, deleted and replaced, and shown as passages with
//!   unchanged words round them.
//! - `compare.visual` (static): `{olderPassword?, newerPassword?, pages?,
//!   width?}` + the two PDFs. The pages both versions have (or those listed),
//!   drawn `width` pixels wide and compared cell by cell: the boxes, as
//!   fractions of the page, where they look different.
use serde::{Deserialize, Serialize};
use unicode_normalization::UnicodeNormalization;
use warraq_text::normalize::{is_mark_or_control, is_presentation_form};

use super::{args, Reply};
use crate::{CoreError, Document};

/* --------------------------------------------------------------- words */

/// How two words are judged the same (`normalize.ts`).
#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareOptions {
    /// Tashkeel, tatweel and the other marks and controls search ignores.
    #[serde(default)]
    pub ignore_marks: bool,
    /// The alef variants, taa marbuta and haa, alef maqsura and yaa (and
    /// keheh and kaf) as one letter each.
    #[serde(default)]
    pub unify_letters: bool,
}

fn unify(c: char) -> char {
    match c {
        'أ' | 'إ' | 'آ' | 'ٱ' => 'ا',
        'ة' => 'ه',
        'ى' | 'ی' => 'ي',
        'ک' => 'ك',
        _ => c,
    }
}

/// The form of `word` the comparison matches on: canonical (NFC), Arabic
/// presentation forms as the letters they stand for, then the options. The
/// empty string means nothing is left to compare (a lone tatweel, marks
/// ignored). Digits and case are compared as they are: "٢٠٢٦" rewritten as
/// "2026" is an edit a comparison has to show.
pub fn comparison_key(word: &str, options: CompareOptions) -> String {
    let mut key = String::with_capacity(word.len());
    for c in word.nfc() {
        let mut push = |letter: char| {
            if options.ignore_marks && is_mark_or_control(letter) {
                return;
            }
            key.push(if options.unify_letters {
                unify(letter)
            } else {
                letter
            });
        };
        if is_presentation_form(c) {
            // Once, not recursively: some code points in these blocks have no
            // compatibility form and NFKC hands them back unchanged.
            for letter in c.to_string().nfkc() {
                push(letter);
            }
        } else {
            push(c);
        }
    }
    key
}

/// A page's words as shown and as compared, split at whitespace.
struct Words {
    shown: Vec<String>,
    keys: Vec<String>,
}

fn words_of(text: &str, options: CompareOptions) -> Words {
    let mut words = Words {
        shown: Vec::new(),
        keys: Vec::new(),
    };
    for word in text.split_whitespace() {
        let key = comparison_key(word, options);
        if key.is_empty() {
            continue;
        }
        words.shown.push(word.to_owned());
        words.keys.push(key);
    }
    words
}

/* ----------------------------------------------------------------- diff */

/// Edits beyond which a stretch is one change: walking the script back keeps
/// every step's furthest points, D² numbers for D edits (`diff.ts`).
pub const MAX_EDITS: usize = 2000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SegmentKind {
    Same,
    Changed,
}

/// Words `[start, end)` of each sequence: matching, or one replaced by the
/// other (either side may be empty).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Segment {
    pub kind: SegmentKind,
    pub older: (usize, usize),
    pub newer: (usize, usize),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Move {
    Same,
    Delete,
    Insert,
}

/// The moves of a shortest edit script from `a` to `b` (Myers 1986), or
/// None past `max_edits`.
fn shortest_path(a: &[u32], b: &[u32], max_edits: usize) -> Option<Vec<Move>> {
    let n = a.len() as isize;
    let m = b.len() as isize;
    let limit = (a.len() + b.len()).min(max_edits) as isize;
    let offset = limit + 1;
    let mut v = vec![0isize; (2 * limit + 3) as usize];
    let mut trace: Vec<Vec<isize>> = Vec::new();
    for d in 0..=limit {
        trace.push(if d == 0 {
            Vec::new()
        } else {
            v[(offset - d + 1) as usize..(offset + d) as usize].to_vec()
        });
        let mut k = -d;
        while k <= d {
            let below = v[(offset + k - 1) as usize];
            let above = v[(offset + k + 1) as usize];
            let mut x = if k == -d || (k != d && below < above) {
                above
            } else {
                below + 1
            };
            let mut y = x - k;
            while x < n && y < m && a[x as usize] == b[y as usize] {
                x += 1;
                y += 1;
            }
            v[(offset + k) as usize] = x;
            if x >= n && y >= m {
                return Some(walk_back(&trace, d, n, m));
            }
            k += 2;
        }
    }
    None
}

fn walk_back(trace: &[Vec<isize>], edits: isize, n: isize, m: isize) -> Vec<Move> {
    let mut moves = Vec::with_capacity((n + m) as usize);
    let (mut x, mut y) = (n, m);
    let mut d = edits;
    while d > 0 {
        let before = &trace[d as usize];
        let furthest = |k: isize| before.get((k + d - 1) as usize).copied().unwrap_or(0);
        let k = x - y;
        let from = if k == -d || (k != d && furthest(k - 1) < furthest(k + 1)) {
            k + 1
        } else {
            k - 1
        };
        let from_x = furthest(from);
        let from_y = from_x - from;
        while x > from_x && y > from_y {
            moves.push(Move::Same);
            x -= 1;
            y -= 1;
        }
        // Down (x unchanged) takes a word from `b`; right takes one from `a`.
        moves.push(if x == from_x {
            Move::Insert
        } else {
            Move::Delete
        });
        x = from_x;
        y = from_y;
        d -= 1;
    }
    while x > 0 && y > 0 {
        moves.push(Move::Same);
        x -= 1;
        y -= 1;
    }
    moves.reverse();
    moves
}

fn append(
    segments: &mut Vec<Segment>,
    kind: SegmentKind,
    (older, newer): (usize, usize),
    (older_end, newer_end): (usize, usize),
) {
    if older_end == older && newer_end == newer {
        return;
    }
    if let Some(last) = segments.last_mut() {
        if last.kind == kind {
            last.older.1 = older_end;
            last.newer.1 = newer_end;
            return;
        }
    }
    segments.push(Segment {
        kind,
        older: (older, older_end),
        newer: (newer, newer_end),
    });
}

/// The shortest edit script from `older` to `newer`: runs of matching words
/// and the changes between them, covering both, in order.
pub fn edit_script(older: &[String], newer: &[String], max_edits: usize) -> Vec<Segment> {
    // Numbers compare faster than strings.
    let mut ids = std::collections::HashMap::<&str, u32>::new();
    let mut a = Vec::with_capacity(older.len());
    for word in older {
        let next = ids.len() as u32;
        a.push(*ids.entry(word.as_str()).or_insert(next));
    }
    let mut b = Vec::with_capacity(newer.len());
    for word in newer {
        let next = ids.len() as u32;
        b.push(*ids.entry(word.as_str()).or_insert(next));
    }

    let mut start = 0;
    while start < a.len() && start < b.len() && a[start] == b[start] {
        start += 1;
    }
    let (mut end_a, mut end_b) = (a.len(), b.len());
    while end_a > start && end_b > start && a[end_a - 1] == b[end_b - 1] {
        end_a -= 1;
        end_b -= 1;
    }

    let mut segments = Vec::new();
    append(&mut segments, SegmentKind::Same, (0, 0), (start, start));
    match shortest_path(&a[start..end_a], &b[start..end_b], max_edits) {
        None => append(
            &mut segments,
            SegmentKind::Changed,
            (start, start),
            (end_a, end_b),
        ),
        Some(moves) => {
            let (mut x, mut y) = (start, start);
            for step in moves {
                match step {
                    Move::Same => {
                        append(&mut segments, SegmentKind::Same, (x, y), (x + 1, y + 1));
                        x += 1;
                        y += 1;
                    }
                    Move::Delete => {
                        append(&mut segments, SegmentKind::Changed, (x, y), (x + 1, y));
                        x += 1;
                    }
                    Move::Insert => {
                        append(&mut segments, SegmentKind::Changed, (x, y), (x, y + 1));
                        y += 1;
                    }
                }
            }
        }
    }
    append(
        &mut segments,
        SegmentKind::Same,
        (end_a, end_b),
        (a.len(), b.len()),
    );
    segments
}

fn weight(s: &Segment) -> usize {
    (s.older.1 - s.older.0).max(s.newer.1 - s.newer.0)
}

/// A run of matching words shorter than the changes on both sides of it
/// becomes part of one change: a rewritten sentence reads as one, not as
/// pieces round its one shared "في".
pub fn join_short_runs(segments: &[Segment]) -> Vec<Segment> {
    let mut list = segments.to_vec();
    loop {
        let mut joined = false;
        let mut out: Vec<Segment> = Vec::with_capacity(list.len());
        let mut i = 0;
        while i < list.len() {
            let segment = list[i];
            let after = list.get(i + 1).copied();
            match (out.last_mut(), after) {
                (Some(before), Some(after))
                    if segment.kind == SegmentKind::Same
                        && before.kind == SegmentKind::Changed
                        && after.kind == SegmentKind::Changed
                        && weight(&segment) < weight(before)
                        && weight(&segment) < weight(&after) =>
                {
                    before.older.1 = after.older.1;
                    before.newer.1 = after.newer.1;
                    i += 2;
                    joined = true;
                }
                _ => {
                    out.push(segment);
                    i += 1;
                }
            }
        }
        list = out;
        if !joined {
            return list;
        }
    }
}

/// What changed from `older` to `newer`, word by word, as a person reads it.
pub fn diff_words(older: &[String], newer: &[String]) -> Vec<Segment> {
    join_short_runs(&edit_script(older, newer, MAX_EDITS))
}

/* ----------------------------------------------------------- passages */

/// Unchanged words shown each side of a change by default.
pub const CONTEXT_WORDS: usize = 8;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Part {
    /// `same`, `removed` or `added`.
    pub kind: &'static str,
    pub text: String,
    /// For `removed` and `added`: which change of the whole comparison it
    /// belongs to (the `changes` list's index), so a host can step to it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub change: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Passage {
    /// Unchanged words come before it and are not shown.
    pub before: bool,
    /// Unchanged words come after it and are not shown.
    pub after: bool,
    pub parts: Vec<Part>,
}

/// One place where the versions differ.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    /// One-based.
    pub page: usize,
    /// `inserted` (words only the newer has), `deleted` (only the older) or
    /// `replaced` (some words by others).
    pub kind: &'static str,
    pub removed: String,
    pub added: String,
    pub removed_words: usize,
    pub added_words: usize,
    /// Which of the page's passages shows it.
    pub passage: usize,
}

fn same_part(newer: &[String], segment: &Segment, from: usize, to: usize) -> Part {
    // Unchanged words are shown as the newer version has them.
    Part {
        kind: "same",
        text: newer[segment.newer.0 + from..segment.newer.0 + to].join(" "),
        change: None,
    }
}

/// Groups a page's changes into passages, `context` unchanged words either
/// side; each change is added to `changes` as it is met.
fn passages_of(
    page: usize,
    segments: &[Segment],
    older: &[String],
    newer: &[String],
    context: usize,
    changes: &mut Vec<Change>,
) -> Vec<Passage> {
    let mut passages: Vec<Passage> = Vec::new();
    let mut open = false;
    for (index, segment) in segments.iter().enumerate() {
        if segment.kind == SegmentKind::Changed {
            if !open {
                passages.push(Passage {
                    before: false,
                    after: false,
                    parts: Vec::new(),
                });
                open = true;
            }
            let removed = older[segment.older.0..segment.older.1].join(" ");
            let added = newer[segment.newer.0..segment.newer.1].join(" ");
            let removed_words = segment.older.1 - segment.older.0;
            let added_words = segment.newer.1 - segment.newer.0;
            let number = changes.len();
            let passage = passages.len() - 1;
            let current = passages.last_mut().expect("a passage is open");
            if removed_words > 0 {
                current.parts.push(Part {
                    kind: "removed",
                    text: removed.clone(),
                    change: Some(number),
                });
            }
            if added_words > 0 {
                current.parts.push(Part {
                    kind: "added",
                    text: added.clone(),
                    change: Some(number),
                });
            }
            changes.push(Change {
                page,
                kind: match (removed_words, added_words) {
                    (0, _) => "inserted",
                    (_, 0) => "deleted",
                    _ => "replaced",
                },
                removed,
                added,
                removed_words,
                added_words,
                passage,
            });
            continue;
        }
        let length = segment.newer.1 - segment.newer.0;
        let last = index == segments.len() - 1;
        if index == 0 {
            // The words before the first change: the end of them leads into it.
            if last {
                break;
            }
            let from = length.saturating_sub(context);
            passages.push(Passage {
                before: from > 0,
                after: false,
                parts: vec![same_part(newer, segment, from, length)],
            });
            open = true;
        } else if !open {
            continue;
        } else if last {
            let to = length.min(context);
            let current = passages.last_mut().expect("a passage is open");
            current.parts.push(same_part(newer, segment, 0, to));
            current.after = to < length;
            open = false;
        } else if length <= 2 * context {
            // Two changes this close read as one passage.
            let current = passages.last_mut().expect("a passage is open");
            current.parts.push(same_part(newer, segment, 0, length));
        } else {
            let current = passages.last_mut().expect("a passage is open");
            current.parts.push(same_part(newer, segment, 0, context));
            current.after = true;
            passages.push(Passage {
                before: true,
                after: false,
                parts: vec![same_part(newer, segment, length - context, length)],
            });
        }
    }
    passages
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageChange {
    /// One-based: page n of one version against page n of the other.
    pub page: usize,
    pub in_older: bool,
    pub in_newer: bool,
    pub added: usize,
    pub removed: usize,
    pub passages: Vec<Passage>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
    pub older_pages: usize,
    pub newer_pages: usize,
    /// Every word of each version: none means there was no text to compare (a scan).
    pub older_words: usize,
    pub newer_words: usize,
    /// Words added and removed, over every page.
    pub added: usize,
    pub removed: usize,
    /// Places where words were inserted, deleted or replaced.
    pub inserted: usize,
    pub deleted: usize,
    pub replaced: usize,
    /// Only the pages whose words differ, in page order.
    pub pages: Vec<PageChange>,
    /// Every change, in reading order, page after page.
    pub changes: Vec<Change>,
}

/// Every page of `older` against the page in the same place of `newer`;
/// pages past the shorter version are wholly removed or added.
pub fn compare_pages(
    older: &[String],
    newer: &[String],
    options: CompareOptions,
    context: usize,
) -> Comparison {
    let mut result = Comparison {
        older_pages: older.len(),
        newer_pages: newer.len(),
        older_words: 0,
        newer_words: 0,
        added: 0,
        removed: 0,
        inserted: 0,
        deleted: 0,
        replaced: 0,
        pages: Vec::new(),
        changes: Vec::new(),
    };
    for index in 0..older.len().max(newer.len()) {
        let before = words_of(older.get(index).map_or("", String::as_str), options);
        let after = words_of(newer.get(index).map_or("", String::as_str), options);
        result.older_words += before.keys.len();
        result.newer_words += after.keys.len();
        let segments = diff_words(&before.keys, &after.keys);
        let (mut added, mut removed) = (0, 0);
        for segment in segments.iter().filter(|s| s.kind == SegmentKind::Changed) {
            removed += segment.older.1 - segment.older.0;
            added += segment.newer.1 - segment.newer.0;
        }
        if added + removed == 0 {
            continue;
        }
        result.added += added;
        result.removed += removed;
        let passages = passages_of(
            index + 1,
            &segments,
            &before.shown,
            &after.shown,
            context,
            &mut result.changes,
        );
        result.pages.push(PageChange {
            page: index + 1,
            in_older: index < older.len(),
            in_newer: index < newer.len(),
            added,
            removed,
            passages,
        });
    }
    for change in &result.changes {
        match change.kind {
            "inserted" => result.inserted += 1,
            "deleted" => result.deleted += 1,
            _ => result.replaced += 1,
        }
    }
    result
}

/* --------------------------------------------------------------- visual */

/// A box on the page, in fractions of its width and height from the top-left.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Box {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

/// Cell side, in pixels of the render.
const CELL: usize = 8;
/// A pixel differs when its luminance moves more than this: past anti-aliasing.
const PIXEL: f32 = 48.0;
/// A cell changes when this share of its pixels differ.
const SHARE: f32 = 0.03;
/// Pages whose proportions differ by more than this are different pages.
const SHAPE: f32 = 0.01;

fn luminance(rgba: &[u8], at: usize) -> f32 {
    0.2126 * rgba[at] as f32 + 0.7152 * rgba[at + 1] as f32 + 0.0722 * rgba[at + 2] as f32
}

/// The boxes where `after` looks different from `before` (`visual.ts`). Pages
/// of another shape are one change, the whole page.
pub fn visual_changes(before: &warraq_render::Bitmap, after: &warraq_render::Bitmap) -> Vec<Box> {
    let (bw, bh) = (before.width as usize, before.height as usize);
    let (aw, ah) = (after.width as usize, after.height as usize);
    if bw == 0 || bh == 0 || aw == 0 || ah == 0 {
        return if (bw * bh == 0) != (aw * ah == 0) {
            vec![Box {
                x: 0.0,
                y: 0.0,
                w: 1.0,
                h: 1.0,
            }]
        } else {
            Vec::new()
        };
    }
    if before.rgba.len() < bw * bh * 4 || after.rgba.len() < aw * ah * 4 {
        return vec![Box {
            x: 0.0,
            y: 0.0,
            w: 1.0,
            h: 1.0,
        }];
    }
    let shape_before = bw as f32 / bh as f32;
    let shape_after = aw as f32 / ah as f32;
    if (shape_before - shape_after).abs() > SHAPE * shape_before {
        return vec![Box {
            x: 0.0,
            y: 0.0,
            w: 1.0,
            h: 1.0,
        }];
    }
    let width = bw.min(aw);
    let height = bh.min(ah);
    let columns = width.div_ceil(CELL);
    let rows = height.div_ceil(CELL);
    let mut changed = vec![false; columns * rows];
    // Each render sampled at the same place of the page, whatever its size.
    let pixel = |raster: &warraq_render::Bitmap, x: usize, y: usize| {
        let (rw, rh) = (raster.width as usize, raster.height as usize);
        let sx = ((x * rw) / width).min(rw - 1);
        let sy = ((y * rh) / height).min(rh - 1);
        luminance(&raster.rgba, (sy * rw + sx) * 4)
    };
    for row in 0..rows {
        for column in 0..columns {
            let (mut differing, mut total) = (0usize, 0usize);
            for y in row * CELL..((row + 1) * CELL).min(height) {
                for x in column * CELL..((column + 1) * CELL).min(width) {
                    total += 1;
                    if (pixel(before, x, y) - pixel(after, x, y)).abs() > PIXEL {
                        differing += 1;
                    }
                }
            }
            if differing > 0 && differing as f32 >= SHARE * total as f32 {
                changed[row * columns + column] = true;
            }
        }
    }
    merge(&changed, columns, rows)
        .into_iter()
        .map(|(c0, r0, c1, r1)| Box {
            x: (c0 * CELL) as f32 / width as f32,
            y: (r0 * CELL) as f32 / height as f32,
            w: (((c1 + 1) * CELL).min(width) - c0 * CELL) as f32 / width as f32,
            h: (((r1 + 1) * CELL).min(height) - r0 * CELL) as f32 / height as f32,
        })
        .collect()
}

/// Changed cells within two cells of each other gathered into one box;
/// largest first.
fn merge(changed: &[bool], columns: usize, rows: usize) -> Vec<(usize, usize, usize, usize)> {
    let mut seen = vec![false; changed.len()];
    let mut boxes = Vec::new();
    for start in 0..changed.len() {
        if !changed[start] || seen[start] {
            continue;
        }
        let (mut c0, mut r0) = (start % columns, start / columns);
        let (mut c1, mut r1) = (c0, r0);
        let mut queue = vec![start];
        seen[start] = true;
        while let Some(at) = queue.pop() {
            let (column, row) = (at % columns, at / columns);
            c0 = c0.min(column);
            c1 = c1.max(column);
            r0 = r0.min(row);
            r1 = r1.max(row);
            for dy in -2isize..=2 {
                for dx in -2isize..=2 {
                    let x = column as isize + dx;
                    let y = row as isize + dy;
                    if x < 0 || y < 0 || x >= columns as isize || y >= rows as isize {
                        continue;
                    }
                    let next = y as usize * columns + x as usize;
                    if changed[next] && !seen[next] {
                        seen[next] = true;
                        queue.push(next);
                    }
                }
            }
        }
        boxes.push((c0, r0, c1, r1));
    }
    boxes.sort_by_key(|&(c0, r0, c1, r1)| std::cmp::Reverse((c1 - c0 + 1) * (r1 - r0 + 1)));
    boxes
}

/* ------------------------------------------------------------ the calls */

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TextArgs {
    #[serde(default)]
    older_password: Option<String>,
    #[serde(default)]
    newer_password: Option<String>,
    #[serde(flatten)]
    options: CompareOptions,
    #[serde(default)]
    context: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VisualArgs {
    #[serde(default)]
    older_password: Option<String>,
    #[serde(default)]
    newer_password: Option<String>,
    /// Zero-based pages to compare; every page both have when absent.
    #[serde(default)]
    pages: Option<Vec<usize>>,
    /// Pixels across a page: enough for a tick or a stamp.
    #[serde(default)]
    width: Option<f32>,
}

/// The pages a call may list: a host asks for a few at a time, which is how
/// it shows progress and stops between pages. Without a list every page both
/// versions have is drawn, one pair at a time.
const MAX_VISUAL_PAGES: usize = 64;

fn two(blobs: Vec<Vec<u8>>, op: &str) -> Result<(Vec<u8>, Vec<u8>), CoreError> {
    let mut blobs = blobs.into_iter();
    match (blobs.next(), blobs.next()) {
        (Some(older), Some(newer)) => Ok((older, newer)),
        _ => Err(CoreError::Args(format!(
            "compare.{op} takes the older PDF and the newer one"
        ))),
    }
}

fn texts(doc: &Document) -> Vec<String> {
    // A page that cannot be read compares as a page with no words.
    (0..doc.page_count())
        .map(|index| doc.extract_text(index).unwrap_or_default())
        .collect()
}

pub fn call_static(name: &str, json: &str, blobs: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    match name {
        "text" => {
            let a: TextArgs = args(json)?;
            let (older, newer) = two(blobs, name)?;
            let older = Document::open(older, a.older_password.as_deref())?;
            let newer = Document::open(newer, a.newer_password.as_deref())?;
            let context = a.context.unwrap_or(CONTEXT_WORDS).min(50);
            Reply::of(&compare_pages(
                &texts(&older),
                &texts(&newer),
                a.options,
                context,
            ))
        }
        "visual" => {
            let a: VisualArgs = args(json)?;
            let (older, newer) = two(blobs, name)?;
            let older = Document::open(older, a.older_password.as_deref())?;
            let newer = Document::open(newer, a.newer_password.as_deref())?;
            let common = older.page_count().min(newer.page_count());
            let width = a.width.unwrap_or(480.0).clamp(64.0, 2000.0);
            let pages: Vec<usize> = match a.pages {
                Some(list) if list.len() > MAX_VISUAL_PAGES => {
                    return Err(CoreError::Args(format!(
                        "compare.visual lists at most {MAX_VISUAL_PAGES} pages a call"
                    )));
                }
                Some(list) => list.into_iter().filter(|&p| p < common).collect(),
                None => (0..common).collect(),
            };
            let draw = |doc: &Document, index: usize| -> Result<warraq_render::Bitmap, CoreError> {
                let page_width = doc.page_size(index).map(|(w, _)| w).unwrap_or(612.0);
                doc.render_page(index, width / page_width.max(1.0))
            };
            let mut out = Vec::with_capacity(pages.len());
            for index in pages {
                let boxes = match (draw(&older, index), draw(&newer, index)) {
                    (Ok(before), Ok(after)) => visual_changes(&before, &after),
                    // One side cannot be drawn: the page cannot be said to look the same.
                    (Ok(_), Err(_)) | (Err(_), Ok(_)) => vec![Box {
                        x: 0.0,
                        y: 0.0,
                        w: 1.0,
                        h: 1.0,
                    }],
                    (Err(e), Err(_)) => return Err(e),
                };
                out.push(serde_json::json!({ "page": index + 1, "boxes": boxes }));
            }
            Reply::of(&serde_json::json!({
                "olderPages": older.page_count(),
                "newerPages": newer.page_count(),
                "pages": out,
            }))
        }
        _ => Err(CoreError::UnknownOp(format!("compare.{name}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXACT: CompareOptions = CompareOptions {
        ignore_marks: false,
        unify_letters: false,
    };

    fn words(text: &str) -> Vec<String> {
        text.split(' ')
            .filter(|w| !w.is_empty())
            .map(String::from)
            .collect()
    }

    fn show(older: &[String], newer: &[String], segments: &[Segment]) -> String {
        segments
            .iter()
            .map(|s| {
                if s.kind == SegmentKind::Same {
                    return newer[s.newer.0..s.newer.1].join(" ");
                }
                let removed = older[s.older.0..s.older.1].join(" ");
                let added = newer[s.newer.0..s.newer.1].join(" ");
                [
                    (!removed.is_empty()).then(|| format!("[-{removed}-]")),
                    (!added.is_empty()).then(|| format!("{{+{added}+}}")),
                ]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" ")
            })
            .collect::<Vec<_>>()
            .join(" ")
    }

    fn diff(older: &str, newer: &str) -> String {
        let (a, b) = (words(older), words(newer));
        show(&a, &b, &diff_words(&a, &b))
    }

    fn passage(p: &Passage) -> String {
        let mut out: Vec<String> = Vec::new();
        if p.before {
            out.push("…".into());
        }
        for part in &p.parts {
            out.push(match part.kind {
                "same" => part.text.clone(),
                "removed" => format!("[-{}-]", part.text),
                _ => format!("{{+{}+}}", part.text),
            });
        }
        if p.after {
            out.push("…".into());
        }
        out.join(" ")
    }

    #[test]
    fn marks_inserted_removed_and_replaced_words() {
        assert_eq!(
            diff("صباح الخير", "صباح الخير يا عالم"),
            "صباح الخير {+يا عالم+}"
        );
        assert_eq!(
            diff("صباح عالم", "صباح الخير يا عالم"),
            "صباح {+الخير يا+} عالم"
        );
        assert_eq!(
            diff("صباح الخير يا عالم", "الخير يا عالم"),
            "[-صباح-] الخير يا عالم"
        );
        assert_eq!(
            diff(
                "يدفع المستأجر ألف ريال شهريا",
                "يدفع المستأجر ألفي ريال شهريا"
            ),
            "يدفع المستأجر [-ألف-] {+ألفي+} ريال شهريا"
        );
        assert_eq!(
            diff(
                "تقرير البنك الدولي World Bank 2021",
                "تقرير البنك الدولي World Bank 2022"
            ),
            "تقرير البنك الدولي World Bank [-2021-] {+2022+}"
        );
        assert!(diff_words(&[], &[]).is_empty());
    }

    #[test]
    fn reads_a_rewritten_sentence_as_one_change() {
        let a = words("اجتمع الوزراء أمس في العاصمة الجديدة");
        let b = words("وصل الرئيس اليوم في موكب رسمي");
        assert_eq!(
            show(&a, &b, &edit_script(&a, &b, MAX_EDITS)),
            "[-اجتمع الوزراء أمس-] {+وصل الرئيس اليوم+} في [-العاصمة الجديدة-] {+موكب رسمي+}"
        );
        assert_eq!(
            show(&a, &b, &diff_words(&a, &b)),
            "[-اجتمع الوزراء أمس في العاصمة الجديدة-] {+وصل الرئيس اليوم في موكب رسمي+}"
        );
        assert_eq!(
            diff("أ ب ج د هـ", "س ب ج د ص"),
            "[-أ-] {+س+} ب ج د [-هـ-] {+ص+}"
        );
    }

    #[test]
    fn the_script_is_minimal_and_covers_both_sequences() {
        // A seeded walk over small alphabets: every script covers both
        // sequences in order and keeps as many words as the longest common
        // subsequence, which is what a shortest script keeps.
        let mut state: u32 = 7;
        let mut next = || {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            state
        };
        for _ in 0..300 {
            let a: Vec<String> = (0..next() % 14)
                .map(|_| format!("w{}", next() % 4))
                .collect();
            let b: Vec<String> = (0..next() % 14)
                .map(|_| format!("w{}", next() % 4))
                .collect();
            let script = edit_script(&a, &b, MAX_EDITS);
            let (mut x, mut y, mut kept) = (0, 0, 0);
            for s in &script {
                assert_eq!((s.older.0, s.newer.0), (x, y));
                if s.kind == SegmentKind::Same {
                    assert_eq!(a[s.older.0..s.older.1], b[s.newer.0..s.newer.1]);
                    kept += s.older.1 - s.older.0;
                }
                (x, y) = (s.older.1, s.newer.1);
            }
            assert_eq!((x, y), (a.len(), b.len()));
            let mut row = vec![0usize; b.len() + 1];
            for i in 1..=a.len() {
                let mut next_row = vec![0usize; b.len() + 1];
                for j in 1..=b.len() {
                    next_row[j] = if a[i - 1] == b[j - 1] {
                        row[j - 1] + 1
                    } else {
                        row[j].max(next_row[j - 1])
                    };
                }
                row = next_row;
            }
            assert_eq!(kept, row[b.len()]);
        }
    }

    #[test]
    fn past_the_limit_the_middle_is_one_change() {
        let a: Vec<String> = (0..50).map(|i| format!("a{i}")).collect();
        let b: Vec<String> = (0..50).map(|i| format!("b{i}")).collect();
        let script = edit_script(&a, &b, 10);
        assert_eq!(
            script,
            vec![Segment {
                kind: SegmentKind::Changed,
                older: (0, 50),
                newer: (0, 50)
            }]
        );
    }

    const TITLE: &str = "كلمة رئيس مجموعة البنك الدولي ديفيد مالباس";
    const SENTENCE: &str = "هذه جملة جديدة كتبها اختبار المقارنة";
    const BODY: &str =
        "صباح الخير. يسعدني أن ألتقي بكم عبر شبكة الإنترنت. سألقي كلمة، ثم يسعدني أن أتلقَّى الأسئلة.";

    #[test]
    fn the_same_text_however_broken_into_lines_is_unchanged() {
        let result = compare_pages(
            &[format!("{TITLE}\n{BODY}")],
            &[format!("{TITLE} {}", BODY.replacen(". ", ".\n", 1))],
            EXACT,
            CONTEXT_WORDS,
        );
        assert_eq!((result.older_words, result.newer_words), (23, 23));
        assert!(result.pages.is_empty() && result.changes.is_empty());
        assert_eq!((result.added, result.removed), (0, 0));
    }

    #[test]
    fn finds_the_changed_page_and_counts_truthfully() {
        let older = [
            "الصفحة الأولى".to_owned(),
            format!("{TITLE}\n06/13/2021\n{BODY}"),
            "الصفحة الثالثة".to_owned(),
        ];
        let newer = [
            "الصفحة الأولى".to_owned(),
            format!("{SENTENCE}\n06/13/2021\n{BODY}"),
            "الصفحة الثالثة".to_owned(),
        ];
        let result = compare_pages(&older, &newer, EXACT, CONTEXT_WORDS);
        assert_eq!(result.pages.len(), 1);
        let page = &result.pages[0];
        assert_eq!((page.page, page.added, page.removed), (2, 6, 7));
        assert_eq!(
            (result.inserted, result.deleted, result.replaced),
            (0, 0, 1)
        );
        assert_eq!(
            page.passages.iter().map(passage).collect::<Vec<_>>(),
            vec![format!(
                "[-{TITLE}-] {{+{SENTENCE}+}} 06/13/2021 صباح الخير. يسعدني أن ألتقي بكم عبر …"
            )]
        );
        assert_eq!(result.changes[0].removed, TITLE);
        assert_eq!(result.changes[0].added, SENTENCE);
        assert_eq!(result.changes[0].page, 2);
    }

    #[test]
    fn splits_distant_changes_and_numbers_each() {
        let w: Vec<String> = (1..=30).map(|i| format!("ك{i}")).collect();
        let far: Vec<String> = w
            .iter()
            .enumerate()
            .map(|(i, x)| {
                if i == 2 || i == 25 {
                    format!("{x}+")
                } else {
                    x.clone()
                }
            })
            .collect();
        let result = compare_pages(&[w.join(" ")], &[far.join(" ")], EXACT, 2);
        assert_eq!(
            result.pages[0]
                .passages
                .iter()
                .map(passage)
                .collect::<Vec<_>>(),
            vec![
                "ك1 ك2 [-ك3-] {+ك3++} ك4 ك5 …".to_owned(),
                "… ك24 ك25 [-ك26-] {+ك26++} ك27 ك28 …".to_owned()
            ]
        );
        assert_eq!(result.changes.len(), 2);
        assert_eq!(result.changes[1].passage, 1);
        assert_eq!(result.pages[0].passages[1].parts[1].change, Some(1));
    }

    #[test]
    fn a_page_only_one_version_has_is_wholly_inserted_or_deleted() {
        let two = ["أ ب".to_owned(), "ج د".to_owned()];
        let three = ["أ ب".to_owned(), "ج د".to_owned(), "هـ و ز".to_owned()];
        let more = compare_pages(&two, &three, EXACT, CONTEXT_WORDS);
        assert_eq!((more.added, more.removed, more.inserted), (3, 0, 1));
        assert!(!more.pages[0].in_older && more.pages[0].in_newer);
        assert_eq!(more.changes[0].kind, "inserted");
        let fewer = compare_pages(&three, &two, EXACT, CONTEXT_WORDS);
        assert_eq!((fewer.removed, fewer.deleted), (3, 1));
    }

    #[test]
    fn tashkeel_and_letter_forms_count_only_while_asked() {
        let plain = [format!("{SENTENCE}\n{BODY}")];
        let marked = [format!("هَذِهِ جُمْلَةٌ جَدِيدَةٌ كَتَبَهَا اخْتِبَارُ\nالْمُقَارَنَةِ\n{BODY}")];
        assert_eq!(compare_pages(&plain, &marked, EXACT, 8).pages.len(), 1);
        let ignoring = CompareOptions {
            ignore_marks: true,
            unify_letters: false,
        };
        assert!(compare_pages(&plain, &marked, ignoring, 8).pages.is_empty());
        let older = ["إلى المكتبة الكبرى".to_owned()];
        let newer = ["الي المكتبه الكبري".to_owned()];
        assert_eq!(compare_pages(&older, &newer, EXACT, 8).added, 3);
        let unifying = CompareOptions {
            ignore_marks: false,
            unify_letters: true,
        };
        assert!(compare_pages(&older, &newer, unifying, 8).pages.is_empty());
        // Presentation forms are the letters they stand for, always.
        assert_eq!(comparison_key("\u{FEFB}", EXACT), "لا");
        assert_eq!(comparison_key("ـ", ignoring), "");
    }

    fn corpus(name: &str) -> Vec<u8> {
        std::fs::read(format!(
            "{}/../../../tests/corpus/arabic/generated/{name}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap()
    }

    fn reply(op: &str, args: serde_json::Value, blobs: Vec<Vec<u8>>) -> serde_json::Value {
        let r = call_static(op, &args.to_string(), blobs).unwrap();
        serde_json::from_str(&r.json).unwrap()
    }

    #[test]
    fn a_file_against_itself_has_no_change_of_text_or_look() {
        let pdf = corpus("chrome-notonaskh-justified-3pages.pdf");
        let text = reply(
            "text",
            serde_json::json!({}),
            vec![pdf.clone(), pdf.clone()],
        );
        assert_eq!(text["olderPages"], 3);
        assert!(text["olderWords"].as_u64().unwrap() > 100);
        assert_eq!(text["changes"].as_array().unwrap().len(), 0);
        let looks = reply("visual", serde_json::json!({}), vec![pdf.clone(), pdf]);
        let pages = looks["pages"].as_array().unwrap();
        assert_eq!(pages.len(), 3);
        assert!(pages
            .iter()
            .all(|p| p["boxes"].as_array().unwrap().is_empty()));
    }

    #[test]
    fn an_edited_copy_shows_its_words_and_where_it_looks_different() {
        let pdf = corpus("chrome-notonaskh-justified-3pages.pdf");
        let mut doc = Document::open(pdf.clone(), None).unwrap();
        let font = std::fs::read(format!(
            "{}/../../../tests/fonts/Amiri-Regular.ttf",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap();
        doc.add_text(1, 300.0, 760.0, 14.0, "سطر جديد للمقارنة", &font)
            .unwrap();
        let edited = doc.save().unwrap();
        let text = reply(
            "text",
            serde_json::json!({}),
            vec![pdf.clone(), edited.clone()],
        );
        let changes = text["changes"].as_array().unwrap();
        assert_eq!(changes.len(), 1, "{text}");
        assert_eq!(changes[0]["kind"], "inserted");
        assert_eq!(changes[0]["added"], "سطر جديد للمقارنة");
        assert_eq!(changes[0]["page"], 2);
        assert_eq!(
            (text["added"].as_u64(), text["removed"].as_u64()),
            (Some(3), Some(0))
        );
        let looks = reply(
            "visual",
            serde_json::json!({ "pages": [0, 1] }),
            vec![pdf, edited],
        );
        let pages = looks["pages"].as_array().unwrap();
        assert!(pages[0]["boxes"].as_array().unwrap().is_empty());
        let boxes = pages[1]["boxes"].as_array().unwrap();
        assert_eq!(boxes.len(), 1);
        // Low on the page, where the line was written.
        assert!(boxes[0]["y"].as_f64().unwrap() > 0.8, "{boxes:?}");
    }

    /// Writes `tests/fixtures/compare/notonaskh-3pages-line-added.pdf`: the
    /// corpus's three-page Naskh file with one Arabic line drawn low on its
    /// second page — the other version the iOS app's UI tests compare with.
    /// `cargo test -p warraq-core make_compare_fixture -- --ignored`
    #[test]
    #[ignore]
    fn make_compare_fixture() {
        let mut doc = Document::open(corpus("chrome-notonaskh-justified-3pages.pdf"), None).unwrap();
        let font = std::fs::read(format!(
            "{}/../../../tests/fonts/Amiri-Regular.ttf",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap();
        doc.add_text(1, 300.0, 760.0, 14.0, "سطر جديد للمقارنة", &font)
            .unwrap();
        let folder = format!("{}/../../../tests/fixtures/compare", env!("CARGO_MANIFEST_DIR"));
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(format!("{folder}/notonaskh-3pages-line-added.pdf"), doc.save().unwrap()).unwrap();
    }

    #[test]
    fn refuses_what_is_not_two_pdfs_and_asks_for_passwords() {
        let pdf = corpus("chrome-notonaskh-justified-3pages.pdf");
        assert!(call_static("text", "{}", vec![pdf.clone()]).is_err());
        assert!(call_static("text", "{}", vec![pdf.clone(), b"not a pdf".to_vec()]).is_err());
        let locked = corpus("variant-encrypted-aes256.pdf");
        let err = call_static("text", "{}", vec![pdf.clone(), locked.clone()]).unwrap_err();
        assert!(err.to_string().starts_with("E_PASSWORD"), "{err}");
        let pages: Vec<usize> = (0..65).collect();
        assert!(call_static(
            "visual",
            &serde_json::json!({ "pages": pages }).to_string(),
            vec![pdf.clone(), pdf]
        )
        .is_err());
    }
}
