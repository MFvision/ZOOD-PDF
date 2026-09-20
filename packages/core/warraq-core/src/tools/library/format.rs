//! The Library index on disk: one bounded, versioned, endian-safe file.
//!
//! The index is the person's own text, so it is read back as hostile input
//! like any PDF: every count is checked against a cap AND against the bytes
//! that are left before anything is allocated, every string is validated
//! UTF-8, every reference (a posting's document, a position's line) is
//! checked against what was actually read, and the file ends with eight bytes
//! of SHA-256 over the rest, so a file that was cut short or flipped is
//! refused instead of half-loaded. Nothing here panics: every path returns
//! `Err(CoreError::Index)`.
//!
//! Numbers are little-endian in the header and LEB128 varints in the body;
//! the same bytes load on a big-endian machine. Lists that are naturally
//! ascending — a term's documents, a posting's positions, a content's line
//! pages — are delta-coded, which both shrinks the file and lets the reader
//! reject a scrambled one.
//!
//! ```text
//! "WRQLIB" version:u16 reserved:u16 | contents | terms | documents | rules | sha256[..8]
//! ```
use std::collections::BTreeMap;

use sha2::{Digest, Sha256};

use super::index::{
    Content, Doc, FoundDate, Index, Kind, Line, Posting, MAX_CHARS_PER_LINE, MAX_CONTENTS,
    MAX_DOCUMENTS, MAX_KEY_CHARS, MAX_LINES_PER_DOCUMENT, MAX_PAGES_PER_DOCUMENT, MAX_RULES,
    MAX_TAGS_PER_DOCUMENT, MAX_TAG_CHARS, MAX_TERMS,
};
use super::rules::{Rule, Scope, MAX_WORDS_PER_RULE};
use super::tokens::MAX_TOKEN_CHARS;
use crate::CoreError;

const MAGIC: &[u8; 6] = b"WRQLIB";
/// Bumped whenever the body changes shape; an older or newer file is refused
/// with its number, never guessed at.
pub const FORMAT_VERSION: u16 = 1;
/// Bytes of SHA-256 kept at the end.
const CHECKSUM: usize = 8;
/// The largest index file that is even looked at (1 GiB).
pub const MAX_INDEX_BYTES: usize = 1 << 30;
/// The most postings one term may carry, and the most positions one posting
/// may: a term in every document of a full index, at every word of it.
const MAX_POSTINGS_PER_TERM: usize = MAX_CONTENTS;
const MAX_POSITIONS_PER_POSTING: usize = 4_000_000;

fn bad(what: impl std::fmt::Display) -> CoreError {
    CoreError::Index(what.to_string())
}

/* ----------------------------------------------------------------- reading */

struct Reader<'a> {
    data: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, at: 0 }
    }

    fn left(&self) -> usize {
        self.data.len().saturating_sub(self.at)
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], CoreError> {
        let end = self
            .at
            .checked_add(n)
            .ok_or_else(|| bad("length overflow"))?;
        let slice = self
            .data
            .get(self.at..end)
            .ok_or_else(|| bad("the index ends in the middle of a record"))?;
        self.at = end;
        Ok(slice)
    }

    fn byte(&mut self) -> Result<u8, CoreError> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> Result<u16, CoreError> {
        let b = self.take(2)?;
        Ok(u16::from_le_bytes([b[0], b[1]]))
    }

    /// LEB128, at most ten bytes, so a run of 0x80 cannot spin.
    fn varint(&mut self) -> Result<u64, CoreError> {
        let mut value = 0u64;
        for step in 0..10 {
            let byte = self.byte()?;
            let part = u64::from(byte & 0x7f);
            value |= part
                .checked_shl(step * 7)
                .ok_or_else(|| bad("a number too large for the index"))?;
            if byte & 0x80 == 0 {
                return Ok(value);
            }
        }
        Err(bad("a number too large for the index"))
    }

    fn zigzag(&mut self) -> Result<i64, CoreError> {
        let n = self.varint()?;
        Ok(((n >> 1) as i64) ^ -((n & 1) as i64))
    }

    fn usize_at_most(&mut self, cap: usize, what: &str) -> Result<usize, CoreError> {
        let n = self.varint()?;
        if n > cap as u64 {
            return Err(bad(format!(
                "{what}: {n} is past the {cap} the index allows"
            )));
        }
        Ok(n as usize)
    }

    /// A count of records, refused when the bytes that are left cannot hold
    /// that many even at `least` bytes each: no `with_capacity` on a number a
    /// broken file made up.
    fn count(&mut self, cap: usize, least: usize, what: &str) -> Result<usize, CoreError> {
        let n = self.usize_at_most(cap, what)?;
        if n.saturating_mul(least.max(1)) > self.left() {
            return Err(bad(format!(
                "{what}: {n} records do not fit in the {} bytes that are left",
                self.left()
            )));
        }
        Ok(n)
    }

    fn string(&mut self, max_bytes: usize, what: &str) -> Result<String, CoreError> {
        let n = self.usize_at_most(max_bytes, what)?;
        let bytes = self.take(n)?;
        String::from_utf8(bytes.to_vec()).map_err(|_| bad(format!("{what} is not UTF-8")))
    }
}

/* ----------------------------------------------------------------- writing */

#[derive(Default)]
struct Writer {
    out: Vec<u8>,
}

impl Writer {
    fn varint(&mut self, mut value: u64) {
        loop {
            let byte = (value & 0x7f) as u8;
            value >>= 7;
            if value == 0 {
                self.out.push(byte);
                return;
            }
            self.out.push(byte | 0x80);
        }
    }

    fn zigzag(&mut self, value: i64) {
        self.varint(((value << 1) ^ (value >> 63)) as u64);
    }

    fn string(&mut self, s: &str) {
        self.varint(s.len() as u64);
        self.out.extend_from_slice(s.as_bytes());
    }

    fn byte(&mut self, b: u8) {
        self.out.push(b);
    }
}

/* ------------------------------------------------------------------ format */

/// The index as bytes. Slots freed by `library.forget` are left out, so
/// saving is also what compacts the index.
pub fn write(index: &Index) -> Vec<u8> {
    // Dense ids for the file: the live slots, in order.
    let mut content_id = vec![u32::MAX; index.contents.len()];
    let mut contents = Vec::new();
    for (slot, content) in index.contents.iter().enumerate() {
        if let Some(content) = content {
            content_id[slot] = contents.len() as u32;
            contents.push(content);
        }
    }
    let mut doc_id = vec![u32::MAX; index.docs.len()];
    let mut docs = Vec::new();
    for (slot, doc) in index.docs.iter().enumerate() {
        if let Some(doc) = doc {
            doc_id[slot] = docs.len() as u32;
            docs.push(doc);
        }
    }

    let mut w = Writer::default();
    w.out.extend_from_slice(MAGIC);
    w.out.extend_from_slice(&FORMAT_VERSION.to_le_bytes());
    w.out.extend_from_slice(&0u16.to_le_bytes());

    w.varint(contents.len() as u64);
    for content in &contents {
        w.out.extend_from_slice(&content.hash);
        w.varint(u64::from(content.pages));
        w.varint(content.chars);
        w.varint(u64::from(content.words));
        w.byte(u8::from(content.truncated));
        match &content.date {
            None => w.byte(0),
            Some(date) => {
                w.byte(1);
                w.string(&date.iso);
                w.string(&date.raw);
                w.byte(u8::from(date.hijri));
            }
        }
        w.varint(content.lines.len() as u64);
        let mut page = 0u32;
        for line in &content.lines {
            w.varint(u64::from(line.page.saturating_sub(page)));
            page = line.page;
            w.string(&line.text);
        }
        let mut live: Vec<u32> = content
            .docs
            .iter()
            .filter_map(|slot| doc_id.get(*slot as usize).copied())
            .filter(|id| *id != u32::MAX)
            .collect();
        live.sort_unstable();
        w.varint(live.len() as u64);
        for id in live {
            w.varint(u64::from(id));
        }
    }

    w.varint(index.terms.len() as u64);
    for (term, postings) in &index.terms {
        w.string(term);
        let mut live: Vec<(u32, &Vec<u64>)> = postings
            .iter()
            .filter_map(|p| {
                let id = *content_id.get(p.content as usize)?;
                (id != u32::MAX).then_some((id, &p.positions))
            })
            .collect();
        live.sort_unstable_by_key(|(id, _)| *id);
        w.varint(live.len() as u64);
        let mut previous = 0u32;
        for (id, positions) in live {
            w.varint(u64::from(id - previous));
            previous = id;
            w.varint(positions.len() as u64);
            let mut last = 0u64;
            for position in positions {
                w.varint(position.saturating_sub(last));
                last = *position;
            }
        }
    }

    w.varint(docs.len() as u64);
    for doc in &docs {
        w.string(&doc.key);
        w.string(&doc.name);
        w.byte(doc.kind as u8);
        w.zigzag(doc.modified);
        w.zigzag(doc.indexed);
        w.varint(doc.bytes);
        w.varint(u64::from(
            content_id.get(doc.content as usize).copied().unwrap_or(0),
        ));
        w.varint(doc.tags.len() as u64);
        for tag in &doc.tags {
            w.string(tag);
        }
        w.varint(doc.untagged.len() as u64);
        for tag in &doc.untagged {
            w.string(tag);
        }
    }

    w.varint(index.rules.len() as u64);
    for rule in &index.rules {
        w.string(&rule.tag);
        w.varint(rule.words.len() as u64);
        for word in &rule.words {
            w.string(word);
        }
        w.byte(u8::from(rule.all) | (u8::from(rule.enabled) << 1));
        w.byte(rule.scope as u8);
        w.varint(rule.kinds.len() as u64);
        for kind in &rule.kinds {
            w.byte(*kind as u8);
        }
    }

    let digest = Sha256::digest(&w.out);
    w.out.extend_from_slice(&digest[..CHECKSUM]);
    w.out
}

/// Read an index back, or say why it cannot be read. Never panics.
pub fn read(bytes: &[u8]) -> Result<Index, CoreError> {
    if bytes.len() > MAX_INDEX_BYTES {
        return Err(bad(format!(
            "the index is {} bytes, past the {MAX_INDEX_BYTES} this reader takes",
            bytes.len()
        )));
    }
    if bytes.len() < MAGIC.len() + 4 + CHECKSUM {
        return Err(bad("too short to be an index"));
    }
    let body = &bytes[..bytes.len() - CHECKSUM];
    let expected = &bytes[bytes.len() - CHECKSUM..];
    let digest = Sha256::digest(body);
    if digest[..CHECKSUM] != *expected {
        return Err(bad("the index is damaged: its checksum does not hold"));
    }

    let mut r = Reader::new(body);
    if r.take(MAGIC.len())? != MAGIC {
        return Err(bad("not an index of محرر PDF"));
    }
    let version = r.u16()?;
    if version != FORMAT_VERSION {
        return Err(bad(format!(
            "index version {version}; this build reads {FORMAT_VERSION}"
        )));
    }
    if r.u16()? != 0 {
        return Err(bad("the index sets a flag this build does not know"));
    }

    // A content costs at least its hash plus a few numbers.
    let count = r.count(MAX_CONTENTS, 36, "documents' text")?;
    let mut contents: Vec<Option<Content>> = Vec::with_capacity(count);
    for _ in 0..count {
        let mut hash = [0u8; 32];
        hash.copy_from_slice(r.take(32)?);
        let pages = r.usize_at_most(MAX_PAGES_PER_DOCUMENT, "pages")? as u32;
        let chars = r.varint()?;
        let words = r.usize_at_most(u32::MAX as usize, "words")? as u32;
        let truncated = r.byte()? != 0;
        let date = match r.byte()? {
            0 => None,
            1 => Some(FoundDate {
                iso: r.string(32, "a date")?,
                raw: r.string(256, "a date as written")?,
                hijri: r.byte()? != 0,
            }),
            other => return Err(bad(format!("a date marked {other}"))),
        };
        let lines_count = r.count(MAX_LINES_PER_DOCUMENT, 2, "lines")?;
        let mut lines = Vec::with_capacity(lines_count);
        let mut page = 0u32;
        for _ in 0..lines_count {
            page = page
                .checked_add(r.usize_at_most(MAX_PAGES_PER_DOCUMENT, "a line's page")? as u32)
                .ok_or_else(|| bad("a line past the last page"))?;
            let text = r.string(MAX_CHARS_PER_LINE * 4, "a line")?;
            lines.push(Line { page, text });
        }
        let docs_count = r.count(MAX_DOCUMENTS, 1, "a text's documents")?;
        let mut docs = Vec::with_capacity(docs_count);
        for _ in 0..docs_count {
            docs.push(r.usize_at_most(MAX_DOCUMENTS, "a text's document")? as u32);
        }
        contents.push(Some(Content {
            hash,
            pages,
            chars,
            words,
            truncated,
            date,
            lines,
            docs,
        }));
    }

    let terms_count = r.count(MAX_TERMS, 3, "terms")?;
    let mut terms: BTreeMap<Box<str>, Vec<Posting>> = BTreeMap::new();
    let mut previous_term: Option<String> = None;
    for _ in 0..terms_count {
        let term = r.string(MAX_TOKEN_CHARS * 4, "a term")?;
        // Terms are written in order; out of order means a scrambled file,
        // and it would also cost a lookup per term to notice later.
        if previous_term.as_deref().is_some_and(|p| p >= term.as_str()) {
            return Err(bad("the index's terms are out of order"));
        }
        let postings_count = r.count(MAX_POSTINGS_PER_TERM, 2, "a term's documents")?;
        let mut postings = Vec::with_capacity(postings_count);
        let mut content = 0u64;
        for k in 0..postings_count {
            let step = r.varint()?;
            // The first posting may be document 0; the rest must move on.
            if k > 0 && step == 0 {
                return Err(bad("a term names one document twice"));
            }
            content = content
                .checked_add(step)
                .ok_or_else(|| bad("a term's documents overflow"))?;
            let slot = usize::try_from(content).map_err(|_| bad("a document past the index"))?;
            let lines = contents
                .get(slot)
                .and_then(|c| c.as_ref())
                .map(|c| c.lines.len())
                .ok_or_else(|| bad("a term names a document the index does not hold"))?;
            let positions_count = r.count(
                MAX_POSITIONS_PER_POSTING,
                1,
                "a term's places in a document",
            )?;
            let mut positions = Vec::with_capacity(positions_count);
            let mut position = 0u64;
            for j in 0..positions_count {
                let step = r.varint()?;
                if j > 0 && step == 0 {
                    return Err(bad("a term is in one place twice"));
                }
                position = position
                    .checked_add(step)
                    .ok_or_else(|| bad("a term's places overflow"))?;
                if super::index::line_of(position) as usize >= lines {
                    return Err(bad("a term on a line the document does not have"));
                }
                positions.push(position);
            }
            postings.push(Posting {
                content: slot as u32,
                positions,
            });
        }
        terms.insert(term.clone().into_boxed_str(), postings);
        previous_term = Some(term);
    }

    let docs_count = r.count(MAX_DOCUMENTS, 8, "documents")?;
    let mut docs: Vec<Option<Doc>> = Vec::with_capacity(docs_count);
    for _ in 0..docs_count {
        let key = r.string(MAX_KEY_CHARS * 4, "a document's key")?;
        let name = r.string(MAX_KEY_CHARS * 4, "a document's name")?;
        let kind =
            Kind::from_byte(r.byte()?).ok_or_else(|| bad("a kind this build does not know"))?;
        let modified = r.zigzag()?;
        let indexed = r.zigzag()?;
        let bytes = r.varint()?;
        let content = r.usize_at_most(MAX_CONTENTS, "a document's text")? as u32;
        if contents.get(content as usize).map(Option::is_none) != Some(false) {
            return Err(bad("a document whose text the index does not hold"));
        }
        let tags = read_tags(&mut r, "a tag")?;
        let untagged = read_tags(&mut r, "a tag taken off")?;
        docs.push(Some(Doc {
            key,
            name,
            kind,
            modified,
            indexed,
            bytes,
            content,
            tags,
            untagged,
        }));
    }

    let rules_count = r.count(MAX_RULES, 4, "rules")?;
    let mut rules = Vec::with_capacity(rules_count);
    for _ in 0..rules_count {
        let tag = r.string(MAX_TAG_CHARS * 4, "a rule's tag")?;
        let words_count = r.count(MAX_WORDS_PER_RULE, 1, "a rule's words")?;
        let mut words = Vec::with_capacity(words_count);
        for _ in 0..words_count {
            words.push(r.string(MAX_TOKEN_CHARS * 8, "a rule's word")?);
        }
        let flags = r.byte()?;
        let scope =
            Scope::from_byte(r.byte()?).ok_or_else(|| bad("a rule looks somewhere unknown"))?;
        let kinds_count = r.count(Kind::COUNT, 1, "a rule's kinds")?;
        let mut kinds = Vec::with_capacity(kinds_count);
        for _ in 0..kinds_count {
            kinds.push(
                Kind::from_byte(r.byte()?).ok_or_else(|| bad("a rule names an unknown kind"))?,
            );
        }
        rules.push(Rule {
            tag,
            words,
            all: flags & 1 != 0,
            enabled: flags & 2 != 0,
            scope,
            kinds,
        });
    }

    if r.left() != 0 {
        return Err(bad(format!("{} bytes past the end of the index", r.left())));
    }

    // Every document a text claims must exist and point back at it, or the
    // two lists disagree and a search would answer a document that is not there.
    for (slot, content) in contents.iter().enumerate() {
        let Some(content) = content else { continue };
        for id in &content.docs {
            match docs.get(*id as usize).and_then(|d| d.as_ref()) {
                Some(doc) if doc.content as usize == slot => {}
                _ => return Err(bad("a text and a document disagree about each other")),
            }
        }
    }

    Index::from_parts(contents, docs, terms, rules)
}

fn read_tags(r: &mut Reader<'_>, what: &str) -> Result<Vec<String>, CoreError> {
    let count = r.count(MAX_TAGS_PER_DOCUMENT, 1, what)?;
    let mut tags = Vec::with_capacity(count);
    for _ in 0..count {
        tags.push(r.string(MAX_TAG_CHARS * 4, what)?);
    }
    Ok(tags)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::library::index::Added;

    fn small() -> Index {
        let mut index = Index::default();
        index
            .add(
                Added {
                    key: "/دفتر/فاتورة.pdf".into(),
                    name: "فاتورة.pdf".into(),
                    kind: Some(Kind::Pdf),
                    modified: 1_700_000_000,
                    bytes: 4096,
                    pages: 1,
                },
                vec![(0, "فاتورة رقم 12 بتاريخ 3/4/2026".to_string())],
                1_700_000_100,
            )
            .expect("added");
        index
    }

    #[test]
    fn an_index_survives_the_round_trip() {
        let index = small();
        let bytes = write(&index);
        let back = read(&bytes).expect("reads back");
        assert_eq!(back.documents(), 1);
        assert_eq!(back.words(), index.words());
        let hits = back.search_for("فاتوره").expect("searched");
        assert_eq!(hits.len(), 1);
        assert_eq!(
            back.document("/دفتر/فاتورة.pdf").map(|d| d.date.clone()),
            Some(Some("2026-04-03".into()))
        );
    }

    #[test]
    fn a_file_that_is_not_an_index_is_refused() {
        assert!(read(b"").is_err());
        assert!(read(b"%PDF-1.7\n").is_err());
        let mut bytes = write(&small());
        bytes[0] = b'X';
        assert!(read(&bytes).is_err());
    }

    #[test]
    fn a_flipped_byte_anywhere_is_caught_by_the_checksum() {
        let bytes = write(&small());
        for at in [0, 8, bytes.len() / 2, bytes.len() - 1] {
            let mut broken = bytes.clone();
            broken[at] ^= 0x40;
            assert!(read(&broken).is_err(), "byte {at} went unnoticed");
        }
    }

    #[test]
    fn a_truncated_index_is_refused_not_half_loaded() {
        let bytes = write(&small());
        for cut in 1..bytes.len() {
            assert!(read(&bytes[..cut]).is_err(), "cut at {cut} loaded");
        }
    }

    #[test]
    fn another_version_is_refused_by_number() {
        let mut index = write(&small());
        index[6] = 9;
        index[7] = 0;
        let digest = Sha256::digest(&index[..index.len() - CHECKSUM]);
        let at = index.len() - CHECKSUM;
        index[at..].copy_from_slice(&digest[..CHECKSUM]);
        let error = read(&index).expect_err("refused");
        assert!(error.to_string().contains("version 9"), "{error}");
    }
}
