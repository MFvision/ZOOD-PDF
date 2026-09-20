//! The Library's index: what it holds, and how a document goes into it.
//!
//! An inverted index over the words of every document, with the place of
//! every word, so a search can both rank documents and mark the match inside
//! the line it found. The index never holds a file's bytes — only its text,
//! its words' places, and what the host told it about the file — and every
//! part of it is capped, so a folder of a hundred thousand files cannot make
//! it grow without end.
//!
//! Two files whose text is identical — the same report filed in two folders —
//! share one stored text: the text is keyed by its SHA-256, and each document
//! points at it. Forgetting one of them leaves the other's text alone.
use std::collections::{BTreeMap, HashMap};

use sha2::{Digest, Sha256};

use super::rules::Rule;
use super::tokens::tokenize;
use crate::CoreError;

/* ------------------------------------------------------------------ bounds */

/// The most documents one index holds.
pub const MAX_DOCUMENTS: usize = 200_000;
/// The most distinct texts (documents that are copies share one).
pub const MAX_CONTENTS: usize = MAX_DOCUMENTS;
/// Pages read from one document.
pub const MAX_PAGES_PER_DOCUMENT: usize = 20_000;
/// Lines kept for one document.
pub const MAX_LINES_PER_DOCUMENT: usize = 400_000;
/// Characters kept of one line; the rest of the line is cut off.
pub const MAX_CHARS_PER_LINE: usize = 20_000;
/// Characters kept of one document.
pub const MAX_CHARS_PER_DOCUMENT: u64 = 2_000_000;
/// Words indexed for one document.
pub const MAX_TOKENS_PER_DOCUMENT: usize = 400_000;
/// Characters the whole index keeps. Past it a document is skipped with
/// `indexFull` instead of the index eating the machine: at roughly three
/// bytes of index per character, this is about 150 MB.
pub const MAX_INDEX_CHARS: u64 = 48_000_000;
/// Distinct terms in one index.
pub const MAX_TERMS: usize = 4_000_000;
/// Tags on one document, and the length of one.
pub const MAX_TAGS_PER_DOCUMENT: usize = 64;
pub const MAX_TAG_CHARS: usize = 64;
/// Rules in one index.
pub const MAX_RULES: usize = 200;
/// The longest key (a path) and name a host may hand over, in characters.
pub const MAX_KEY_CHARS: usize = 4096;

/// A word's place is its line and its place in that line, packed into one
/// number so a posting list is a sorted run of integers.
const ORDINAL_BITS: u32 = 20;
pub(super) const ORDINAL_MASK: u64 = (1 << ORDINAL_BITS) - 1;

pub fn position(line: u32, ordinal: u32) -> u64 {
    (u64::from(line) << ORDINAL_BITS) | (u64::from(ordinal) & ORDINAL_MASK)
}

pub fn line_of(position: u64) -> u32 {
    (position >> ORDINAL_BITS) as u32
}

pub fn ordinal_of(position: u64) -> u32 {
    (position & ORDINAL_MASK) as u32
}

/* ------------------------------------------------------------------- kinds */

/// What a file is, as the Library shows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Kind {
    Pdf = 0,
    /// A PDF whose pages carry no text: the interface reads it with OCR and
    /// hands the text back.
    Scan = 1,
    Image = 2,
    Word = 3,
    Excel = 4,
    PowerPoint = 5,
    Html = 6,
    Text = 7,
    Markdown = 8,
}

impl Kind {
    pub const COUNT: usize = 9;

    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Pdf => "pdf",
            Kind::Scan => "scan",
            Kind::Image => "image",
            Kind::Word => "word",
            Kind::Excel => "excel",
            Kind::PowerPoint => "powerpoint",
            Kind::Html => "html",
            Kind::Text => "text",
            Kind::Markdown => "markdown",
        }
    }

    pub fn parse(name: &str) -> Option<Kind> {
        Some(match name {
            "pdf" => Kind::Pdf,
            "scan" => Kind::Scan,
            "image" => Kind::Image,
            "word" => Kind::Word,
            "excel" => Kind::Excel,
            "powerpoint" => Kind::PowerPoint,
            "html" => Kind::Html,
            "text" => Kind::Text,
            "markdown" => Kind::Markdown,
            _ => return None,
        })
    }

    pub fn from_byte(byte: u8) -> Option<Kind> {
        Some(match byte {
            0 => Kind::Pdf,
            1 => Kind::Scan,
            2 => Kind::Image,
            3 => Kind::Word,
            4 => Kind::Excel,
            5 => Kind::PowerPoint,
            6 => Kind::Html,
            7 => Kind::Text,
            8 => Kind::Markdown,
            _ => return None,
        })
    }

    /// The kind a file's name suggests, for a host that did not say.
    pub fn from_name(name: &str) -> Option<Kind> {
        let lower = name.to_lowercase();
        let extension = lower.rsplit_once('.')?.1;
        Some(match extension {
            "pdf" => Kind::Pdf,
            "png" | "jpg" | "jpeg" | "tif" | "tiff" | "webp" | "heic" | "heif" | "bmp" | "gif" => {
                Kind::Image
            }
            "doc" | "docx" | "rtf" | "odt" => Kind::Word,
            "xls" | "xlsx" | "csv" | "ods" => Kind::Excel,
            "ppt" | "pptx" | "odp" => Kind::PowerPoint,
            "htm" | "html" | "xhtml" => Kind::Html,
            "md" | "markdown" => Kind::Markdown,
            "txt" | "text" | "log" => Kind::Text,
            _ => return None,
        })
    }
}

/* ------------------------------------------------------------------ pieces */

/// One line of a document, and the page it is on.
#[derive(Debug, Clone)]
pub struct Line {
    pub page: u32,
    pub text: String,
}

/// The date a document carries, once it has been found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FoundDate {
    /// The Gregorian date, `YYYY-MM-DD`.
    pub iso: String,
    /// How the document wrote it, so the interface can show that instead.
    pub raw: String,
    /// It was written in the Hijri calendar.
    pub hijri: bool,
}

/// A document's text, kept once however many files hold it.
#[derive(Debug)]
pub struct Content {
    pub hash: [u8; 32],
    pub pages: u32,
    pub chars: u64,
    pub words: u32,
    /// The document was longer than the index takes; the rest is not in it.
    pub truncated: bool,
    pub date: Option<FoundDate>,
    pub lines: Vec<Line>,
    /// The documents whose text this is.
    pub docs: Vec<u32>,
}

/// One file in the index.
#[derive(Debug)]
pub struct Doc {
    pub key: String,
    pub name: String,
    pub kind: Kind,
    /// When the file was last written, as the host counts it (Unix seconds).
    pub modified: i64,
    /// When it went into the index (Unix seconds).
    pub indexed: i64,
    pub bytes: u64,
    pub content: u32,
    pub tags: Vec<String>,
    /// Tags the person took off by hand: a rule never puts one back.
    pub untagged: Vec<String>,
}

/// A term's places in one document's text.
#[derive(Debug)]
pub struct Posting {
    pub content: u32,
    /// Ascending, packed by `position`.
    pub positions: Vec<u64>,
}

/// What a host says about a file it is adding.
#[derive(Debug, Clone)]
pub struct Added {
    pub key: String,
    pub name: String,
    pub kind: Option<Kind>,
    pub modified: i64,
    pub bytes: u64,
    /// The pages the file has, when the host knows more than the text shows.
    pub pages: u32,
}

/// What `library.add` answers.
#[derive(Debug, Clone)]
pub struct AddOutcome {
    pub added: bool,
    pub skipped: Option<&'static str>,
    pub pages: u32,
    pub chars: u64,
    pub date: Option<String>,
    pub kind: Kind,
    pub truncated: bool,
}

/// What `library.document` answers.
#[derive(Debug, Clone)]
pub struct DocumentInfo {
    pub key: String,
    pub name: String,
    pub kind: Kind,
    pub pages: u32,
    pub chars: u64,
    pub date: Option<String>,
    pub tags: Vec<String>,
    pub indexed: i64,
    pub modified: i64,
    pub bytes: u64,
}

/// What `library.stats` answers.
#[derive(Debug, Clone, Default)]
pub struct Stats {
    pub documents: usize,
    pub pages: u64,
    pub words: u64,
    pub bytes: u64,
    pub kinds: Vec<(&'static str, usize)>,
    pub tags: Vec<(String, usize)>,
}

/* ------------------------------------------------------------------- index */

#[derive(Debug, Default)]
pub struct Index {
    pub(super) contents: Vec<Option<Content>>,
    pub(super) docs: Vec<Option<Doc>>,
    pub(super) terms: BTreeMap<Box<str>, Vec<Posting>>,
    pub(super) rules: Vec<Rule>,
    by_key: HashMap<String, u32>,
    by_hash: HashMap<[u8; 32], u32>,
    free_contents: Vec<u32>,
    free_docs: Vec<u32>,
    live_docs: usize,
    chars: u64,
    words: u64,
    positions: u64,
    text_bytes: u64,
    term_bytes: u64,
}

impl Index {
    /// Rebuild the lookups after reading a file, refusing one that contradicts
    /// itself (two documents under one key, a text nobody points at).
    pub(super) fn from_parts(
        contents: Vec<Option<Content>>,
        docs: Vec<Option<Doc>>,
        terms: BTreeMap<Box<str>, Vec<Posting>>,
        rules: Vec<Rule>,
    ) -> Result<Index, CoreError> {
        let mut index = Index {
            contents,
            docs,
            terms,
            rules,
            ..Default::default()
        };
        for slot in 0..index.docs.len() {
            let Some(doc) = index.docs[slot].as_ref() else {
                continue;
            };
            let (key, content) = (doc.key.clone(), doc.content);
            let bytes = (doc.key.len() + doc.name.len()) as u64;
            if index.by_key.insert(key, slot as u32).is_some() {
                return Err(CoreError::Index("two documents under one key".into()));
            }
            index.live_docs += 1;
            index.text_bytes += bytes;
            // A text nobody points at would never be searched and never freed.
            let Some(Some(text)) = index.contents.get(content as usize) else {
                return Err(CoreError::Index("a document without its text".into()));
            };
            if !text.docs.contains(&(slot as u32)) {
                return Err(CoreError::Index("a text that disowns its document".into()));
            }
        }
        for slot in 0..index.contents.len() {
            let Some(content) = index.contents[slot].as_ref() else {
                continue;
            };
            if content.docs.is_empty() {
                return Err(CoreError::Index("a text no document holds".into()));
            }
            let (hash, chars, words) = (content.hash, content.chars, content.words);
            let bytes: u64 = content.lines.iter().map(|l| l.text.len() as u64).sum();
            if index.by_hash.insert(hash, slot as u32).is_some() {
                return Err(CoreError::Index("one text stored twice".into()));
            }
            index.chars += chars;
            index.words += u64::from(words);
            index.text_bytes += bytes;
        }
        for (term, postings) in &index.terms {
            index.term_bytes += term.len() as u64;
            index.positions += postings
                .iter()
                .map(|p| p.positions.len() as u64)
                .sum::<u64>();
        }
        if index.chars > MAX_INDEX_CHARS {
            return Err(CoreError::Index(format!(
                "the index holds {} characters, past the {MAX_INDEX_CHARS} this build takes",
                index.chars
            )));
        }
        Ok(index)
    }

    pub fn documents(&self) -> usize {
        self.live_docs
    }

    pub fn words(&self) -> u64 {
        self.words
    }

    /// Distinct texts in the index: what a search counts documents by, since
    /// two copies of one file hold one text between them.
    pub(super) fn live_contents(&self) -> usize {
        self.by_hash.len()
    }

    /// A plain search, for the tests and for anything that wants the ranking
    /// with no filters and no paging.
    #[cfg(test)]
    pub(super) fn search_for(&self, query: &str) -> Result<Vec<super::search::Hit>, CoreError> {
        Ok(self
            .search(query, &super::search::Filters::default(), 0, 50)
            .hits)
    }

    pub fn rules(&self) -> &[Rule] {
        &self.rules
    }

    pub(super) fn doc(&self, slot: u32) -> Option<&Doc> {
        self.docs.get(slot as usize)?.as_ref()
    }

    pub(super) fn content(&self, slot: u32) -> Option<&Content> {
        self.contents.get(slot as usize)?.as_ref()
    }

    pub(super) fn live_docs(&self) -> impl Iterator<Item = (u32, &Doc)> {
        self.docs
            .iter()
            .enumerate()
            .filter_map(|(slot, doc)| Some((slot as u32, doc.as_ref()?)))
    }

    /// Put a file in the index, or say why it was not.
    ///
    /// `pages_text` is the file's text, one entry per page. A key already in
    /// the index whose file has not been written to since is left alone; one
    /// whose file changed is read again, and the tags the person put on it are
    /// kept.
    pub fn add(
        &mut self,
        about: Added,
        pages_text: Vec<(u32, String)>,
        now: i64,
    ) -> Result<AddOutcome, CoreError> {
        if about.key.is_empty() || about.key.chars().count() > MAX_KEY_CHARS {
            return Err(CoreError::Args(
                "library.add needs a key, and a short one".into(),
            ));
        }
        let name = if about.name.chars().count() > MAX_KEY_CHARS {
            about.name.chars().take(MAX_KEY_CHARS).collect()
        } else {
            about.name.clone()
        };

        // The kind the host said, or the name's, and `scan` for a PDF whose
        // pages carry nothing to index.
        let empty = pages_text.iter().all(|(_, text)| text.trim().is_empty());
        let mut kind = about
            .kind
            .or_else(|| Kind::from_name(&name))
            .unwrap_or(Kind::Pdf);
        if kind == Kind::Pdf && empty {
            kind = Kind::Scan;
        }

        // Unchanged: the host's own size-and-time check, kept here too so a
        // second pass over a folder never reads a file twice.
        if let Some(&slot) = self.by_key.get(&about.key) {
            if let Some(doc) = self.doc(slot) {
                // A scan already in the index carries no text of its own. When
                // the interface comes back with what OCR read, that is not the
                // same file coming round again, however untouched the file is.
                let had_text = self.content(doc.content).is_some_and(|c| c.chars > 0);
                let unchanged = about.modified != 0
                    && doc.modified == about.modified
                    && doc.bytes == about.bytes
                    && doc.kind == kind
                    && (had_text || empty);
                if unchanged {
                    let content = self.content(doc.content);
                    return Ok(AddOutcome {
                        added: false,
                        skipped: Some("unchanged"),
                        pages: content.map(|c| c.pages).unwrap_or(0),
                        chars: content.map(|c| c.chars).unwrap_or(0),
                        date: content.and_then(|c| c.date.as_ref()).map(|d| d.iso.clone()),
                        kind: doc.kind,
                        truncated: content.map(|c| c.truncated).unwrap_or(false),
                    });
                }
            }
        }

        if self.live_docs >= MAX_DOCUMENTS {
            return Ok(AddOutcome {
                added: false,
                skipped: Some("indexFull"),
                pages: 0,
                chars: 0,
                date: None,
                kind,
                truncated: false,
            });
        }
        if self.chars >= MAX_INDEX_CHARS {
            return Ok(AddOutcome {
                added: false,
                skipped: Some("indexFull"),
                pages: 0,
                chars: 0,
                date: None,
                kind,
                truncated: false,
            });
        }

        // The person's own tags survive a re-reading of the file.
        let (kept_tags, kept_untagged) = match self.by_key.get(&about.key).copied() {
            Some(slot) => {
                let kept = self
                    .doc(slot)
                    .map(|d| (d.tags.clone(), d.untagged.clone()))
                    .unwrap_or_default();
                self.remove(slot);
                kept
            }
            None => (Vec::new(), Vec::new()),
        };

        let hash = content_hash(&pages_text);
        let content_slot = match self.by_hash.get(&hash).copied() {
            // Another file with the same text: point at the one already read.
            Some(slot) if self.content(slot).is_some() => slot,
            _ => {
                let content = self.build_content(hash, &about, pages_text)?;
                self.store_content(content)
            }
        };

        let doc = Doc {
            key: about.key.clone(),
            name,
            kind,
            modified: about.modified,
            indexed: now,
            bytes: about.bytes,
            content: content_slot,
            tags: kept_tags,
            untagged: kept_untagged,
        };
        let doc_slot = match self.free_docs.pop() {
            Some(slot) => {
                self.docs[slot as usize] = Some(doc);
                slot
            }
            None => {
                self.docs.push(Some(doc));
                (self.docs.len() - 1) as u32
            }
        };
        self.by_key.insert(about.key, doc_slot);
        self.live_docs += 1;
        if let Some(Some(content)) = self.contents.get_mut(content_slot as usize) {
            content.docs.push(doc_slot);
        }
        if let Some(doc) = self.doc(doc_slot) {
            self.text_bytes += (doc.key.len() + doc.name.len()) as u64;
        }
        self.apply_rules_to(doc_slot);

        let content = self.content(content_slot);
        Ok(AddOutcome {
            added: true,
            skipped: None,
            pages: content.map(|c| c.pages).unwrap_or(0),
            chars: content.map(|c| c.chars).unwrap_or(0),
            date: content.and_then(|c| c.date.as_ref()).map(|d| d.iso.clone()),
            kind,
            truncated: content.map(|c| c.truncated).unwrap_or(false),
        })
    }

    /// Read a document's text into lines and words, within every bound.
    fn build_content(
        &self,
        hash: [u8; 32],
        about: &Added,
        mut pages_text: Vec<(u32, String)>,
    ) -> Result<Content, CoreError> {
        pages_text.sort_by_key(|(page, _)| *page);
        pages_text.truncate(MAX_PAGES_PER_DOCUMENT);
        let room = MAX_INDEX_CHARS.saturating_sub(self.chars);

        let mut lines: Vec<Line> = Vec::new();
        let mut chars = 0u64;
        let mut truncated = false;
        let mut last_page = 0u32;
        'pages: for (page, text) in pages_text {
            let page = page.min(MAX_PAGES_PER_DOCUMENT as u32 - 1);
            last_page = last_page.max(page);
            for raw in text.split('\n') {
                let line = raw.trim();
                if line.is_empty() {
                    continue;
                }
                if lines.len() >= MAX_LINES_PER_DOCUMENT
                    || chars >= MAX_CHARS_PER_DOCUMENT
                    || chars >= room
                {
                    truncated = true;
                    break 'pages;
                }
                let line = cut_to_chars(line, MAX_CHARS_PER_LINE, &mut truncated);
                chars += line.chars().count() as u64;
                lines.push(Line { page, text: line });
            }
        }

        let date = super::dates::find(&lines);
        Ok(Content {
            hash,
            pages: about
                .pages
                .max(last_page + 1)
                .min(MAX_PAGES_PER_DOCUMENT as u32),
            chars,
            // `store_content` counts the words as it indexes them.
            words: 0,
            truncated,
            date,
            lines,
            docs: Vec::new(),
        })
    }

    /// Put a freshly read text in a slot and index every word of it.
    fn store_content(&mut self, mut content: Content) -> u32 {
        // One pass over the lines, gathering each term's places, then one
        // insertion per term: a document's words touch the term map once each.
        let mut places: BTreeMap<Box<str>, Vec<u64>> = BTreeMap::new();
        let mut words = 0usize;
        'lines: for (line, text) in content.lines.iter().enumerate() {
            for (ordinal, token) in tokenize(&text.text).into_iter().enumerate() {
                if ordinal as u64 > ORDINAL_MASK {
                    break;
                }
                if words >= MAX_TOKENS_PER_DOCUMENT {
                    content.truncated = true;
                    break 'lines;
                }
                words += 1;
                places
                    .entry(token.text.into_boxed_str())
                    .or_default()
                    .push(position(line as u32, ordinal as u32));
            }
        }
        content.words = words.min(u32::MAX as usize) as u32;

        let slot = match self.free_contents.pop() {
            Some(slot) => {
                self.contents[slot as usize] = Some(content);
                slot
            }
            None => {
                self.contents.push(Some(content));
                (self.contents.len() - 1) as u32
            }
        };
        let content = self.contents[slot as usize].as_ref().expect("just stored");
        self.chars += content.chars;
        self.words += u64::from(content.words);
        self.text_bytes += content
            .lines
            .iter()
            .map(|l| l.text.len() as u64)
            .sum::<u64>();
        self.by_hash.insert(content.hash, slot);

        let room_for_terms = MAX_TERMS.saturating_sub(self.terms.len());
        let mut fresh = 0usize;
        for (term, positions) in places {
            self.positions += positions.len() as u64;
            match self.terms.get_mut(&term) {
                Some(postings) => postings.push(Posting {
                    content: slot,
                    positions,
                }),
                None => {
                    if fresh >= room_for_terms {
                        self.positions -= positions.len() as u64;
                        continue;
                    }
                    fresh += 1;
                    self.term_bytes += term.len() as u64;
                    self.terms.insert(
                        term,
                        vec![Posting {
                            content: slot,
                            positions,
                        }],
                    );
                }
            }
        }
        slot
    }

    /// Forget documents by key; answers how many are left.
    pub fn forget(&mut self, keys: &[String]) -> usize {
        let slots: Vec<u32> = keys
            .iter()
            .filter_map(|key| self.by_key.get(key).copied())
            .collect();
        for slot in slots {
            self.remove(slot);
        }
        self.live_docs
    }

    /// Take one document out, and its text with it when nothing else holds it.
    fn remove(&mut self, slot: u32) {
        let Some(doc) = self.docs.get_mut(slot as usize).and_then(Option::take) else {
            return;
        };
        self.by_key.remove(&doc.key);
        self.free_docs.push(slot);
        self.live_docs = self.live_docs.saturating_sub(1);
        self.text_bytes = self
            .text_bytes
            .saturating_sub((doc.key.len() + doc.name.len()) as u64);
        let Some(Some(content)) = self.contents.get_mut(doc.content as usize) else {
            return;
        };
        content.docs.retain(|d| *d != slot);
        if !content.docs.is_empty() {
            return;
        }
        let content = self.contents[doc.content as usize].take().expect("held");
        self.by_hash.remove(&content.hash);
        self.free_contents.push(doc.content);
        self.chars = self.chars.saturating_sub(content.chars);
        self.words = self.words.saturating_sub(u64::from(content.words));
        self.text_bytes = self.text_bytes.saturating_sub(
            content
                .lines
                .iter()
                .map(|l| l.text.len() as u64)
                .sum::<u64>(),
        );
        // One pass over the term map per forgotten text is the price of
        // postings that never carry a tombstone.
        let gone = doc.content;
        let mut freed_places = 0u64;
        let mut freed_terms = 0u64;
        self.terms.retain(|term, postings| {
            let before: usize = postings.iter().map(|p| p.positions.len()).sum();
            postings.retain(|p| p.content != gone);
            let after: usize = postings.iter().map(|p| p.positions.len()).sum();
            freed_places += (before - after) as u64;
            if postings.is_empty() {
                freed_terms += term.len() as u64;
                return false;
            }
            true
        });
        self.positions = self.positions.saturating_sub(freed_places);
        self.term_bytes = self.term_bytes.saturating_sub(freed_terms);
    }

    /// The documents a key names, for `library.document`.
    pub fn document(&self, key: &str) -> Option<DocumentInfo> {
        let slot = *self.by_key.get(key)?;
        let doc = self.doc(slot)?;
        let content = self.content(doc.content)?;
        Some(DocumentInfo {
            key: doc.key.clone(),
            name: doc.name.clone(),
            kind: doc.kind,
            pages: content.pages,
            chars: content.chars,
            date: content.date.as_ref().map(|d| d.iso.clone()),
            tags: doc.tags.clone(),
            indexed: doc.indexed,
            modified: doc.modified,
            bytes: doc.bytes,
        })
    }

    /// Tag a document by hand. A tag the person takes off is remembered, so no
    /// rule puts it back.
    pub fn tag(
        &mut self,
        key: &str,
        add: &[String],
        remove: &[String],
    ) -> Result<Vec<String>, CoreError> {
        let slot = *self
            .by_key
            .get(key)
            .ok_or_else(|| CoreError::Args(format!("library.tag: {key} is not in the index")))?;
        let doc = self
            .docs
            .get_mut(slot as usize)
            .and_then(Option::as_mut)
            .ok_or_else(|| CoreError::Args("library.tag: the document has gone".into()))?;
        for tag in remove {
            let tag = clean_tag(tag);
            if tag.is_empty() {
                continue;
            }
            doc.tags.retain(|t| *t != tag);
            if !doc.untagged.contains(&tag) && doc.untagged.len() < MAX_TAGS_PER_DOCUMENT {
                doc.untagged.push(tag);
            }
        }
        for tag in add {
            let tag = clean_tag(tag);
            if tag.is_empty() || doc.tags.len() >= MAX_TAGS_PER_DOCUMENT {
                continue;
            }
            doc.untagged.retain(|t| *t != tag);
            if !doc.tags.contains(&tag) {
                doc.tags.push(tag);
            }
        }
        doc.tags.sort();
        Ok(doc.tags.clone())
    }

    pub fn stats(&self) -> Stats {
        let mut stats = Stats {
            documents: self.live_docs,
            words: self.words,
            ..Default::default()
        };
        let mut kinds = [0usize; Kind::COUNT];
        let mut tags: BTreeMap<&str, usize> = BTreeMap::new();
        let mut doc_bytes = 0u64;
        for (_, doc) in self.live_docs() {
            kinds[doc.kind as usize] += 1;
            for tag in &doc.tags {
                *tags.entry(tag.as_str()).or_default() += 1;
            }
            doc_bytes += (doc.key.len() + doc.name.len() + 48) as u64;
        }
        for content in self.contents.iter().flatten() {
            stats.pages += u64::from(content.pages);
        }
        stats.kinds = (0..Kind::COUNT)
            .filter(|k| kinds[*k] > 0)
            .filter_map(|k| Some((Kind::from_byte(k as u8)?.as_str(), kinds[k])))
            .collect();
        stats.tags = tags.into_iter().map(|(t, n)| (t.to_string(), n)).collect();
        // About what the index holds: its text, its terms, and a varint's
        // worth per word's place — within a few per cent of what `save` writes.
        stats.bytes = self.text_bytes + self.term_bytes + self.positions * 2 + doc_bytes;
        stats
    }

    /// Whether the index has room for another document's text.
    pub fn full(&self) -> bool {
        self.chars >= MAX_INDEX_CHARS || self.live_docs >= MAX_DOCUMENTS
    }
}

/// A document's text, hashed so two copies of one file share it. The page
/// number and the length go into the hash with the text, so two documents
/// whose pages run together into the same characters are still told apart.
fn content_hash(pages_text: &[(u32, String)]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"WRQLIB-text-1");
    for (page, text) in pages_text {
        hasher.update(page.to_le_bytes());
        hasher.update((text.len() as u64).to_le_bytes());
        hasher.update(text.as_bytes());
    }
    hasher.finalize().into()
}

/// Cut a line to a number of characters, never inside one.
fn cut_to_chars(line: &str, most: usize, truncated: &mut bool) -> String {
    match line.char_indices().nth(most) {
        Some((at, _)) => {
            *truncated = true;
            line[..at].to_string()
        }
        None => line.to_string(),
    }
}

/// A tag is one line, trimmed, and no longer than a tag may be.
pub fn clean_tag(tag: &str) -> String {
    let flat: String = tag
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    flat.trim().chars().take(MAX_TAG_CHARS).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn about(key: &str) -> Added {
        Added {
            key: key.into(),
            name: key.rsplit('/').next().unwrap_or(key).into(),
            kind: Some(Kind::Pdf),
            modified: 1_700_000_000,
            bytes: 1024,
            pages: 1,
        }
    }

    #[test]
    fn a_document_goes_in_and_comes_back_out() {
        let mut index = Index::default();
        let out = index
            .add(
                about("/a/تقرير.pdf"),
                vec![(0, "تقرير سنوي\nعن المكتبة".into())],
                10,
            )
            .expect("added");
        assert!(out.added);
        assert_eq!(out.pages, 1);
        assert_eq!(index.documents(), 1);
        assert_eq!(index.words(), 4);
        assert_eq!(index.forget(&["/a/تقرير.pdf".into()]), 0);
        assert_eq!(index.words(), 0);
        assert!(index.terms.is_empty(), "the terms go with the document");
    }

    #[test]
    fn a_file_that_has_not_changed_is_not_read_again() {
        let mut index = Index::default();
        index
            .add(about("/a.pdf"), vec![(0, "نص".into())], 10)
            .expect("added");
        let again = index
            .add(about("/a.pdf"), vec![(0, "نص".into())], 20)
            .expect("second");
        assert!(!again.added);
        assert_eq!(again.skipped, Some("unchanged"));
        assert_eq!(index.documents(), 1);
    }

    #[test]
    fn a_file_that_changed_is_read_again_and_keeps_its_tags() {
        let mut index = Index::default();
        index
            .add(about("/a.pdf"), vec![(0, "الأول".into())], 10)
            .expect("added");
        index.tag("/a.pdf", &["مهم".into()], &[]).expect("tagged");
        let mut later = about("/a.pdf");
        later.modified += 60;
        index
            .add(later, vec![(0, "الثاني".into())], 20)
            .expect("again");
        let doc = index.document("/a.pdf").expect("there");
        assert_eq!(doc.tags, vec!["مهم"]);
        assert!(index.terms.contains_key("الثاني"));
        assert!(!index.terms.contains_key("الاول"), "the old text is gone");
    }

    #[test]
    fn two_files_with_the_same_text_store_it_once() {
        let mut index = Index::default();
        let text = vec![(0, "نفس النص تماما".to_string())];
        index.add(about("/one.pdf"), text.clone(), 10).expect("one");
        index.add(about("/two.pdf"), text, 10).expect("two");
        assert_eq!(index.documents(), 2);
        assert_eq!(index.contents.iter().flatten().count(), 1);
        // and forgetting one leaves the other's text alone
        index.forget(&["/one.pdf".into()]);
        assert_eq!(index.contents.iter().flatten().count(), 1);
        index.forget(&["/two.pdf".into()]);
        assert_eq!(index.contents.iter().flatten().count(), 0);
    }

    #[test]
    fn a_pdf_with_no_text_is_a_scan() {
        let mut index = Index::default();
        let out = index
            .add(about("/scan.pdf"), vec![(0, "   ".into())], 10)
            .expect("added");
        assert_eq!(out.kind, Kind::Scan);
        // The interface reads it with OCR and hands the text back under the
        // same key. The file on disk was never touched, so its size and time
        // have not changed — and that must not read as "unchanged".
        let mut later = about("/scan.pdf");
        later.kind = Some(Kind::Scan);
        let filled = index
            .add(later, vec![(0, "بسم الله".into())], 20)
            .expect("ocr");
        assert!(filled.added, "{filled:?}");
        assert_eq!(
            index.document("/scan.pdf").map(|d| d.kind),
            Some(Kind::Scan)
        );
        assert!(index.terms.contains_key("الله"));
        // Now that it has text, a second pass over the folder really is one.
        let mut again = about("/scan.pdf");
        again.kind = Some(Kind::Scan);
        let second = index
            .add(again, vec![(0, "بسم الله".into())], 30)
            .expect("second");
        assert_eq!(second.skipped, Some("unchanged"));
    }

    #[test]
    fn a_tag_taken_off_by_hand_is_remembered() {
        let mut index = Index::default();
        index
            .add(about("/a.pdf"), vec![(0, "نص".into())], 10)
            .expect("added");
        index.tag("/a.pdf", &["فواتير".into()], &[]).expect("on");
        let left = index.tag("/a.pdf", &[], &["فواتير".into()]).expect("off");
        assert!(left.is_empty());
        let doc = index.doc(0).expect("there");
        assert_eq!(doc.untagged, vec!["فواتير"]);
    }

    #[test]
    fn a_line_longer_than_the_cap_is_cut_on_a_character() {
        let mut index = Index::default();
        let long = "ا ".repeat(MAX_CHARS_PER_LINE);
        let out = index
            .add(about("/long.pdf"), vec![(0, long)], 10)
            .expect("added");
        assert!(out.truncated);
        assert!(out.chars <= MAX_CHARS_PER_LINE as u64);
    }

    #[test]
    fn a_page_number_past_the_cap_cannot_run_away() {
        let mut index = Index::default();
        let out = index
            .add(about("/odd.pdf"), vec![(u32::MAX, "نص".into())], 10)
            .expect("added");
        assert!(out.pages as usize <= MAX_PAGES_PER_DOCUMENT);
    }
}
