//! One ranked search across every document in the index.
//!
//! The query is read the way the find bar reads one — tashkeel ignored, alef,
//! taa marbuta, yaa and the digit shapes unified, case folded — and then
//! matched whole word against whole word. The last word of the query also
//! matches as a beginning, so results narrow as the person types; wrapping the
//! query in quotation marks ("أمر شراء", «أمر شراء») asks for the phrase and
//! nothing else.
//!
//! # How the ranking works
//!
//! A document's score is Okapi BM25 over the query's words (k₁ = 1.2,
//! b = 0.75), multiplied by how much of the query it holds and by what its
//! words do together:
//!
//! ```text
//! score = Σᵢ idf(tᵢ)·tf(fᵢ, len) · coverage² · (1 + 2·ln(1+phrases) + ½·ln(1+lines))
//! ```
//!
//! * **A phrase beats scattered words.** `phrases` counts the places where the
//!   query's words stand together, in order, on one line; `lines` counts the
//!   lines that hold every word of the query. Both enter through a logarithm,
//!   so the first one counts for much and the hundredth for little.
//! * **More matches beat fewer.** `tf` grows with the number of times a word
//!   appears, with diminishing returns — a word twenty times over is not twice
//!   as good as one ten times over.
//! * **A shorter document beats a longer one on the same count.** `tf` divides
//!   by the document's length against the average (that is what b = 0.75 does),
//!   so a word once in a one-page letter beats the same word once in a
//!   five-hundred-page book.
//! * **A document holding the whole query beats one holding half of it**, by
//!   the square of the fraction it holds — a rarer word still counts for more
//!   than a common one, because `idf` rises as fewer documents hold it.
//!
//! The hits of one document are ordered by what each line does: a line
//! carrying the phrase first, then lines holding more of the query's distinct
//! words, then lines holding them more often, then by page and line.
use std::collections::{HashMap, HashSet};

use super::index::{line_of, ordinal_of, position, Content, Doc, Index, Kind, ORDINAL_MASK};
use super::tokens::{terms, tokenize};

/// Words of a query that are used; the rest are dropped.
pub const MAX_QUERY_TERMS: usize = 16;
/// Words the last word of a query may grow into as a beginning.
pub const MAX_PREFIX_TERMS: usize = 32;
/// Hits one search ranks. Past it the answer says it has this many.
pub const MAX_HITS: usize = 5_000;
/// Lines one document contributes, so a single long book cannot fill a page
/// of results.
pub const MAX_HITS_PER_DOCUMENT: usize = 50;
/// Places read before the search stops widening: a one-letter query over a
/// full index must still answer.
const MAX_POSITIONS_SCANNED: u64 = 4_000_000;
/// Documents one search weighs. Past it the documents already met are still
/// ranked in full; a query that reaches more than this is one word every file
/// holds, and the ranking of the fifty-thousand-and-first is no answer anyway.
const MAX_CANDIDATES: usize = 50_000;
/// Marks on one line.
const MAX_SPANS_PER_LINE: usize = 64;

const K1: f64 = 1.2;
const B: f64 = 0.75;
const PHRASE_WEIGHT: f64 = 2.0;
const NEAR_WEIGHT: f64 = 0.5;

/// What narrows a search.
#[derive(Debug, Default, Clone)]
pub struct Filters {
    /// Any of these kinds; empty means every kind.
    pub kinds: Vec<Kind>,
    /// Under any of these folders (a prefix of the key, at a separator).
    pub folders: Vec<String>,
    /// Carrying any of these tags.
    pub tags: Vec<String>,
    /// The document's own date, `YYYY-MM-DD`, within these bounds. A document
    /// with no date is left out as soon as either bound is given.
    pub from: Option<String>,
    pub to: Option<String>,
    /// Only scans and documents with no text of their own.
    pub scanned_only: bool,
}

impl Filters {
    fn keeps(&self, doc: &Doc, content: &Content) -> bool {
        if !self.kinds.is_empty() && !self.kinds.contains(&doc.kind) {
            return false;
        }
        if !self.folders.is_empty() && !self.folders.iter().any(|f| under(&doc.key, f)) {
            return false;
        }
        if !self.tags.is_empty() && !self.tags.iter().any(|t| doc.tags.contains(t)) {
            return false;
        }
        if self.scanned_only && doc.kind != Kind::Scan && content.chars > 0 {
            return false;
        }
        if self.from.is_some() || self.to.is_some() {
            let Some(date) = content.date.as_ref().map(|d| d.iso.as_str()) else {
                return false;
            };
            if self.from.as_deref().is_some_and(|from| date < from) {
                return false;
            }
            if self.to.as_deref().is_some_and(|to| date > to) {
                return false;
            }
        }
        true
    }
}

/// The key names a file under the folder — at a separator, so `/دفتر/2026`
/// does not take in `/دفتر/2026-قديم`.
fn under(key: &str, folder: &str) -> bool {
    let folder = folder.trim_end_matches(['/', '\\']);
    if folder.is_empty() {
        return true;
    }
    key == folder
        || key
            .strip_prefix(folder)
            .is_some_and(|rest| rest.starts_with('/') || rest.starts_with('\\'))
}

/// One line of one document that answered the query.
#[derive(Debug, Clone)]
pub struct Hit {
    pub key: String,
    pub name: String,
    /// The page the line is on, counted from zero.
    pub page: u32,
    /// Which line of that page it is, counted from zero.
    pub line: u32,
    pub text: String,
    /// Byte ranges of `text` that answered the query: `(start, length)`.
    pub spans: Vec<(usize, usize)>,
    /// The document's score; every hit of one document carries the same one.
    pub score: f32,
    pub date: Option<String>,
    pub kind: Kind,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct Results {
    /// Hits the search ranked, at most `MAX_HITS`.
    pub total: usize,
    pub hits: Vec<Hit>,
}

/// A document that answered, and its best lines.
struct Ranked<'a> {
    content: u32,
    score: f64,
    /// The first key that holds this text: what settles a tie between two
    /// equal scores, so the answer does not depend on the order the folder
    /// happened to be walked in, or on an index having been saved since.
    key: &'a str,
    /// Line, and what that line does, best first.
    lines: Vec<(u32, i64)>,
}

/// Where one hit is; its text and marks are made only for the page shown.
struct Place {
    content: u32,
    doc: u32,
    line: u32,
    score: f32,
}

/// A query in quotation marks asks for the phrase; the marks come off.
fn unquote(query: &str) -> (&str, bool) {
    let text = query.trim();
    for (open, close) in [
        ('"', '"'),
        ('\u{201C}', '\u{201D}'),
        ('«', '»'),
        ('\u{2018}', '\u{2019}'),
    ] {
        if let Some(inner) = text.strip_prefix(open).and_then(|t| t.strip_suffix(close)) {
            return (inner, true);
        }
    }
    (text, false)
}

impl Index {
    /// Search the whole index. `offset` and `limit` page through the ranking.
    pub fn search(&self, query: &str, filters: &Filters, offset: usize, limit: usize) -> Results {
        let (text, want_phrase) = unquote(query);
        let mut words = terms(text);
        words.truncate(MAX_QUERY_TERMS);
        if words.is_empty() {
            return Results::default();
        }

        // Every term of the index this query reaches, the last word's
        // beginnings included.
        let mut expansions: Vec<Vec<&str>> = Vec::with_capacity(words.len());
        for (i, word) in words.iter().enumerate() {
            let mut names: Vec<&str> = Vec::new();
            if let Some((key, _)) = self.terms.get_key_value(word.as_str()) {
                names.push(key);
            }
            let last = i + 1 == words.len();
            if last && !want_phrase && word.chars().count() >= 3 {
                let from: Box<str> = word.as_str().into();
                for (key, _) in self
                    .terms
                    .range(from..)
                    .take_while(|(key, _)| key.starts_with(word.as_str()))
                    .take(MAX_PREFIX_TERMS)
                {
                    if key.as_ref() != word.as_str() {
                        names.push(key);
                    }
                }
            }
            expansions.push(names);
        }
        let marked: HashSet<&str> = expansions.iter().flatten().copied().collect();

        let n = words.len();
        let mut per_content: HashMap<u32, Vec<Vec<u64>>> = HashMap::new();
        let mut scanned = 0u64;
        'gather: for (i, names) in expansions.iter().enumerate() {
            for name in names {
                let Some(postings) = self.terms.get(*name) else {
                    continue;
                };
                for posting in postings {
                    if self.content(posting.content).is_none() {
                        continue;
                    }
                    scanned += posting.positions.len() as u64;
                    if scanned > MAX_POSITIONS_SCANNED {
                        break 'gather;
                    }
                    // A document the search has not met yet costs a list per
                    // word of the query, so the widening stops somewhere; the
                    // documents already met go on being filled in.
                    let room = per_content.len() < MAX_CANDIDATES;
                    if let Some(lists) = per_content.get_mut(&posting.content) {
                        lists[i].extend_from_slice(&posting.positions);
                    } else if room {
                        let mut lists = vec![Vec::new(); n];
                        lists[i].extend_from_slice(&posting.positions);
                        per_content.insert(posting.content, lists);
                    }
                }
            }
        }
        if per_content.is_empty() {
            return Results::default();
        }
        for lists in per_content.values_mut() {
            for list in lists.iter_mut() {
                // A word the query repeats, or several beginnings of one word,
                // may name the same place twice.
                list.sort_unstable();
                list.dedup();
            }
        }

        let documents = self.live_contents().max(1) as f64;
        let mut df = vec![0usize; n];
        for lists in per_content.values() {
            for (i, list) in lists.iter().enumerate() {
                if !list.is_empty() {
                    df[i] += 1;
                }
            }
        }
        let idf: Vec<f64> = df
            .iter()
            .map(|d| (1.0 + (documents - *d as f64 + 0.5) / (*d as f64 + 0.5)).ln())
            .collect();
        let average = (self.words() as f64 / documents).max(1.0);

        let mut ranked: Vec<Ranked<'_>> = Vec::with_capacity(per_content.len());
        for (slot, lists) in &per_content {
            let Some(content) = self.content(*slot) else {
                continue;
            };
            let length = f64::from(content.words.max(1));
            let mut base = 0.0;
            let mut held = 0usize;
            for (i, list) in lists.iter().enumerate() {
                let f = list.len() as f64;
                if f == 0.0 {
                    continue;
                }
                held += 1;
                base += idf[i] * (f * (K1 + 1.0)) / (f + K1 * (1.0 - B + B * length / average));
            }
            if held == 0 {
                continue;
            }
            let (phrases, near, lines) = line_work(lists);
            if want_phrase && n > 1 && phrases == 0 {
                continue;
            }
            let coverage = held as f64 / n as f64;
            let score = base
                * coverage
                * coverage
                * (1.0
                    + PHRASE_WEIGHT * (1.0 + phrases as f64).ln()
                    + NEAR_WEIGHT * (1.0 + near as f64).ln());
            ranked.push(Ranked {
                content: *slot,
                score,
                key: content
                    .docs
                    .iter()
                    .filter_map(|slot| self.doc(*slot))
                    .map(|doc| doc.key.as_str())
                    .min()
                    .unwrap_or_default(),
                lines,
            });
        }
        ranked.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.key.cmp(b.key))
        });

        // The places, in the order they will be shown; their text and marks
        // are made only for the page asked for.
        let mut places: Vec<Place> = Vec::new();
        'places: for entry in &ranked {
            let Some(content) = self.content(entry.content) else {
                continue;
            };
            let mut docs: Vec<u32> = content.docs.clone();
            // Copies of one file answer in a settled order; almost every text
            // belongs to exactly one file, so the sort is usually not run.
            if docs.len() > 1 {
                docs.sort_by_key(|slot| self.doc(*slot).map(|d| d.key.clone()));
            }
            for slot in docs {
                let Some(doc) = self.doc(slot) else { continue };
                if !filters.keeps(doc, content) {
                    continue;
                }
                for (line, _) in entry.lines.iter().take(MAX_HITS_PER_DOCUMENT) {
                    places.push(Place {
                        content: entry.content,
                        doc: slot,
                        line: *line,
                        score: entry.score as f32,
                    });
                    if places.len() >= MAX_HITS {
                        break 'places;
                    }
                }
            }
        }

        let total = places.len();
        let hits = places
            .iter()
            .skip(offset)
            .take(limit)
            .filter_map(|place| self.hit(place, &marked))
            .collect();
        Results { total, hits }
    }

    /// Everything the interface shows for one hit.
    fn hit(&self, place: &Place, marked: &HashSet<&str>) -> Option<Hit> {
        let content = self.content(place.content)?;
        let doc = self.doc(place.doc)?;
        let line = content.lines.get(place.line as usize)?;
        // Which line of its page this is: the lines are kept in page order, so
        // walking back to the top of the page is a few steps.
        let mut on_page = 0u32;
        let mut before = place.line as usize;
        while before > 0 && content.lines[before - 1].page == line.page {
            before -= 1;
            on_page += 1;
        }
        let mut spans: Vec<(usize, usize)> = Vec::new();
        for token in tokenize(&line.text) {
            if spans.len() >= MAX_SPANS_PER_LINE {
                break;
            }
            if marked.contains(token.text.as_str()) {
                spans.push((token.start, token.len));
            }
        }
        Some(Hit {
            key: doc.key.clone(),
            name: doc.name.clone(),
            page: line.page,
            line: on_page,
            text: line.text.clone(),
            spans,
            score: place.score,
            date: content.date.as_ref().map(|d| d.iso.clone()),
            kind: doc.kind,
            tags: doc.tags.clone(),
        })
    }

    /// Whether the phrase stands, word for word, somewhere in a text. Used by
    /// the tag rules.
    pub(super) fn phrase_in_content(&self, content: u32, phrase: &[String]) -> bool {
        let mut lists: Vec<&Vec<u64>> = Vec::with_capacity(phrase.len());
        for word in phrase {
            let Some(postings) = self.terms.get(word.as_str()) else {
                return false;
            };
            let Some(posting) = postings.iter().find(|p| p.content == content) else {
                return false;
            };
            lists.push(&posting.positions);
        }
        let Some(first) = lists.first() else {
            return false;
        };
        if lists.len() == 1 {
            return !first.is_empty();
        }
        first.iter().any(|start| follows(&lists[1..], *start))
    }
}

/// Every word of the phrase after the first stands at the next place.
fn follows(rest: &[&Vec<u64>], start: u64) -> bool {
    rest.iter().enumerate().all(|(step, list)| {
        let ordinal = ordinal_of(start) as u64 + step as u64 + 1;
        ordinal <= ORDINAL_MASK
            && list
                .binary_search(&position(line_of(start), ordinal as u32))
                .is_ok()
    })
}

/// What the query's words do inside one document: how often they stand
/// together, how many lines hold all of them, and what each line is worth.
fn line_work(lists: &[Vec<u64>]) -> (usize, usize, Vec<(u32, i64)>) {
    let n = lists.len();
    // Per line: which of the query's words are on it, how often, and whether
    // they stand together.
    let mut per_line: HashMap<u32, (u32, u32, u32)> = HashMap::new();
    for (i, list) in lists.iter().enumerate() {
        for at in list {
            let entry = per_line.entry(line_of(*at)).or_insert((0, 0, 0));
            entry.0 |= 1u32 << i.min(31);
            entry.1 += 1;
        }
    }
    let mut phrases = 0usize;
    if n > 1 {
        let rest: Vec<&Vec<u64>> = lists[1..].iter().collect();
        for start in &lists[0] {
            if follows(&rest, *start) {
                phrases += 1;
                if let Some(entry) = per_line.get_mut(&line_of(*start)) {
                    entry.2 += 1;
                }
            }
        }
    }
    let full = (1u32 << n.min(31)) - 1;
    let near = per_line
        .values()
        .filter(|(held, _, _)| *held == full)
        .count();
    let mut lines: Vec<(u32, i64)> = per_line
        .into_iter()
        .map(|(line, (held, times, phrase))| {
            let score = 1_000_000 * i64::from(phrase)
                + 1_000 * i64::from(held.count_ones())
                + i64::from(times);
            (line, score)
        })
        .collect();
    lines.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    (phrases, near, lines)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::library::index::Added;

    fn about(key: &str) -> Added {
        Added {
            key: key.into(),
            name: key.rsplit('/').next().unwrap_or(key).into(),
            kind: Some(Kind::Pdf),
            modified: 1,
            bytes: 10,
            pages: 1,
        }
    }

    fn with(files: &[(&str, &str)]) -> Index {
        let mut index = Index::default();
        for (key, text) in files {
            index
                .add(about(key), vec![(0, (*text).to_string())], 1)
                .expect("added");
        }
        index
    }

    fn keys(results: &Results) -> Vec<&str> {
        let mut out: Vec<&str> = Vec::new();
        for hit in &results.hits {
            if !out.contains(&hit.key.as_str()) {
                out.push(&hit.key);
            }
        }
        out
    }

    fn search(index: &Index, query: &str) -> Results {
        index.search(query, &Filters::default(), 0, 50)
    }

    #[test]
    fn a_word_is_found_however_it_is_written() {
        let index = with(&[("/a.pdf", "الفَاتُورَةُ الضريبية رقم ١٢٣")]);
        for query in ["الفاتورة", "الفاتوره", "الْفاتورةِ", "الفاتورة"]
        {
            assert_eq!(search(&index, query).total, 1, "{query}");
        }
        assert_eq!(search(&index, "123").total, 1, "digits are one shape");
        assert_eq!(search(&index, "١٢٣").total, 1);
    }

    #[test]
    fn a_phrase_ranks_above_the_same_words_scattered() {
        let index = with(&[
            ("/scattered.pdf", "أمر من الإدارة وطلب شراء منفصل"),
            ("/together.pdf", "أمر شراء رقم 4"),
        ]);
        assert_eq!(keys(&search(&index, "أمر شراء"))[0], "/together.pdf");
    }

    #[test]
    fn quotation_marks_ask_for_the_phrase_and_nothing_else() {
        let index = with(&[
            ("/scattered.pdf", "أمر من الإدارة وطلب شراء منفصل"),
            ("/together.pdf", "أمر شراء رقم 4"),
        ]);
        assert_eq!(keys(&search(&index, "\"أمر شراء\"")), vec!["/together.pdf"]);
        assert_eq!(keys(&search(&index, "«أمر شراء»")), vec!["/together.pdf"]);
    }

    #[test]
    fn more_of_the_word_ranks_above_less_of_it() {
        let filler = "كلمة ".repeat(40);
        let index = with(&[
            ("/once.pdf", &format!("مكتبة {filler}")),
            ("/often.pdf", &format!("مكتبة مكتبة مكتبة مكتبة {filler}")),
        ]);
        assert_eq!(keys(&search(&index, "مكتبة"))[0], "/often.pdf");
    }

    #[test]
    fn the_shorter_document_ranks_above_the_longer_on_the_same_count() {
        let index = with(&[
            ("/long.pdf", &format!("مكتبة {}", "حشو ".repeat(400))),
            ("/short.pdf", "مكتبة الملك فهد"),
        ]);
        assert_eq!(keys(&search(&index, "مكتبة"))[0], "/short.pdf");
    }

    #[test]
    fn a_document_holding_the_whole_query_ranks_above_one_holding_half() {
        let index = with(&[
            ("/half.pdf", "تقرير الأداء السنوي للإدارة العامة"),
            ("/whole.pdf", "تقرير الميزانية السنوي والإيرادات"),
        ]);
        let hits = search(&index, "تقرير الميزانية");
        assert_eq!(keys(&hits)[0], "/whole.pdf");
    }

    #[test]
    fn the_match_is_marked_inside_the_line_the_person_sees() {
        let index = with(&[("/a.pdf", "قال: «الفَاتُورَةُ» جاهزة")]);
        let hits = search(&index, "الفاتورة");
        let hit = &hits.hits[0];
        assert_eq!(hit.spans.len(), 1);
        let (start, len) = hit.spans[0];
        assert_eq!(&hit.text[start..start + len], "الفَاتُورَةُ");
    }

    #[test]
    fn the_last_word_of_a_query_also_matches_as_a_beginning() {
        let index = with(&[("/a.pdf", "المكتبة الوطنية")]);
        assert_eq!(search(&index, "المكت").total, 1);
        // …but not in a phrase, where the words are taken as written
        assert_eq!(search(&index, "\"المكت\"").total, 0);
    }

    #[test]
    fn a_hit_says_which_page_and_which_line_of_it() {
        let mut index = Index::default();
        index
            .add(
                about("/a.pdf"),
                vec![(0, "أول\nثان".into()), (3, "ثالث\nرابع\nمكتبة".into())],
                1,
            )
            .expect("added");
        let hit = &search(&index, "مكتبة").hits[0];
        assert_eq!((hit.page, hit.line), (3, 2));
    }

    #[test]
    fn filters_narrow_by_folder_kind_tag_date_and_scans() {
        let mut index = Index::default();
        for (key, kind, text) in [
            ("/دفتر/2026/a.pdf", Kind::Pdf, "مكتبة التاريخ 1/2/2026"),
            ("/دفتر/2025/b.pdf", Kind::Pdf, "مكتبة التاريخ 1/2/2025"),
            ("/دفتر/2026-قديم/c.docx", Kind::Word, "مكتبة"),
            ("/دفتر/2026/d.pdf", Kind::Scan, "مكتبة"),
        ] {
            let mut about = about(key);
            about.kind = Some(kind);
            index.add(about, vec![(0, text.into())], 1).expect("added");
        }
        index
            .tag("/دفتر/2025/b.pdf", &["مهم".into()], &[])
            .expect("tagged");

        let folder = Filters {
            folders: vec!["/دفتر/2026".into()],
            ..Default::default()
        };
        assert_eq!(keys(&index.search("مكتبة", &folder, 0, 50)).len(), 2);

        let kind = Filters {
            kinds: vec![Kind::Word],
            ..Default::default()
        };
        assert_eq!(
            keys(&index.search("مكتبة", &kind, 0, 50)),
            vec!["/دفتر/2026-قديم/c.docx"]
        );

        let tag = Filters {
            tags: vec!["مهم".into()],
            ..Default::default()
        };
        assert_eq!(
            keys(&index.search("مكتبة", &tag, 0, 50)),
            vec!["/دفتر/2025/b.pdf"]
        );

        let dates = Filters {
            from: Some("2026-01-01".into()),
            to: Some("2026-12-31".into()),
            ..Default::default()
        };
        assert_eq!(
            keys(&index.search("مكتبة", &dates, 0, 50)),
            vec!["/دفتر/2026/a.pdf"]
        );

        let scans = Filters {
            scanned_only: true,
            ..Default::default()
        };
        assert_eq!(
            keys(&index.search("مكتبة", &scans, 0, 50)),
            vec!["/دفتر/2026/d.pdf"]
        );
    }

    #[test]
    fn documents_that_answer_alike_are_ordered_by_name_whatever_the_order_they_went_in() {
        let forwards = with(&[("/a.pdf", "مكتبة عامة"), ("/b.pdf", "مكتبة خاصة")]);
        let backwards = with(&[("/b.pdf", "مكتبة خاصة"), ("/a.pdf", "مكتبة عامة")]);
        assert_eq!(keys(&search(&forwards, "مكتبة")), vec!["/a.pdf", "/b.pdf"]);
        assert_eq!(keys(&search(&backwards, "مكتبة")), vec!["/a.pdf", "/b.pdf"]);
    }

    #[test]
    fn paging_walks_the_same_ranking() {
        let index = with(&[
            ("/a.pdf", "مكتبة"),
            ("/b.pdf", "مكتبة"),
            ("/c.pdf", "مكتبة"),
        ]);
        let all = search(&index, "مكتبة");
        assert_eq!(all.total, 3);
        let second = index.search("مكتبة", &Filters::default(), 1, 1);
        assert_eq!(second.total, 3);
        assert_eq!(second.hits.len(), 1);
        assert_eq!(second.hits[0].key, all.hits[1].key);
    }

    #[test]
    fn a_query_with_no_words_finds_nothing() {
        let index = with(&[("/a.pdf", "مكتبة")]);
        assert_eq!(search(&index, "").total, 0);
        assert_eq!(search(&index, "،،، …").total, 0);
        assert_eq!(search(&index, "لاشيءهنا").total, 0);
    }

    #[test]
    fn a_file_in_two_folders_answers_under_both_names() {
        let index = with(&[("/one/تقرير.pdf", "مكتبة"), ("/two/تقرير.pdf", "مكتبة")]);
        assert_eq!(keys(&search(&index, "مكتبة")).len(), 2);
    }
}
