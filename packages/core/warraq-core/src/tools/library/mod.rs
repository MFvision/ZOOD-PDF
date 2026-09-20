//! The Library: one search across a whole folder of files, not just the open
//! one.
//!
//! The ops are static (`call_static`), because an index is built with no
//! document open: the host walks a folder, hands each file's bytes — or, for
//! the kinds the core does not read, the text it read itself — to
//! `library.add`, and later asks `library.search` one question of all of them.
//! An index stays in memory behind a handle until `library.close`, and
//! `library.save` gives the host its bytes to write where the person's data
//! lives (the app's data directory on the desktop, IndexedDB in the browser).
//!
//! Nothing here reaches the network, opens a file by name, or keeps a
//! password: the core is handed bytes and hands back JSON.
//!
//! * [`index`] — what the index holds, and how a document goes in
//! * [`search`] — the ranked, Arabic-aware search and how it ranks
//! * [`dates`] — the date the document itself carries
//! * [`rules`] — the person's own rules for tagging
//! * [`format`] — the index as bytes, and how a bad one is refused
//! * [`tokens`] — the words, normalized the way the find bar searches
pub mod dates;
pub mod format;
pub mod index;
pub mod rules;
pub mod search;
pub mod tokens;

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use self::index::{Added, Index, Kind};
use self::rules::{Rule, Scope};
use self::search::Filters;
use super::{args, Reply};
use crate::{CoreError, Document};

/// Indexes one host may hold open at once.
const MAX_OPEN: usize = 8;
/// The largest file `library.add` reads (256 MB): a file past it is skipped,
/// not loaded.
const MAX_FILE_BYTES: usize = 256 * 1024 * 1024;
/// Hits one `library.search` answers with when the caller does not say.
const DEFAULT_LIMIT: usize = 50;

/* ---------------------------------------------------------------- registry */

#[derive(Default)]
struct Open {
    indexes: HashMap<u32, Index>,
    next: u32,
}

/// The open indexes. Every host calls the core from one thread — the browser's
/// worker, the desktop's core thread — but the lock costs nothing and makes a
/// second one safe rather than surprising.
fn open() -> &'static Mutex<Open> {
    static OPEN: OnceLock<Mutex<Open>> = OnceLock::new();
    OPEN.get_or_init(Default::default)
}

fn with_index<T>(handle: u32, work: impl FnOnce(&mut Index) -> T) -> Result<T, CoreError> {
    let mut open = open().lock().unwrap_or_else(|e| e.into_inner());
    let index = open
        .indexes
        .get_mut(&handle)
        .ok_or_else(|| CoreError::Args(format!("library: index {handle} is not open")))?;
    Ok(work(index))
}

/* ---------------------------------------------------------- the operations */

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Handle {
    handle: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageText {
    page: u32,
    text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Add {
    handle: u32,
    key: String,
    #[serde(default)]
    name: String,
    /// What the host says the file is; an unknown word is taken as no answer,
    /// and the name's ending decides instead.
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    modified: i64,
    /// The file's size as the host sees it; without it, the bytes handed over.
    /// With `modified`, this is what tells an unchanged file from a new one.
    #[serde(default)]
    bytes: Option<u64>,
    #[serde(default)]
    pages: Option<u32>,
    /// Only to open a protected PDF; it is never written into the index.
    #[serde(default)]
    password: Option<String>,
    /// The text the host read itself, for the kinds the core does not open.
    #[serde(default)]
    text: Option<Vec<PageText>>,
    /// Unix seconds, so `library.document` can say when a file was indexed.
    /// The core has no clock of its own in the browser.
    #[serde(default)]
    now: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Forget {
    handle: u32,
    keys: Vec<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct FilterArgs {
    #[serde(default)]
    kinds: Vec<String>,
    #[serde(default)]
    folders: Vec<String>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    from: Option<String>,
    #[serde(default)]
    to: Option<String>,
    #[serde(default)]
    scanned_only: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Search {
    handle: u32,
    query: String,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    offset: Option<usize>,
    #[serde(default)]
    filters: Option<FilterArgs>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Key {
    handle: u32,
    key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Tag {
    handle: u32,
    key: String,
    #[serde(default)]
    add: Vec<String>,
    #[serde(default)]
    remove: Vec<String>,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RuleArgs {
    tag: String,
    #[serde(default)]
    words: Vec<String>,
    #[serde(default)]
    all: bool,
    #[serde(default = "yes")]
    enabled: bool,
    /// `text`, `name` or `both`; anything else is `text`.
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    kinds: Vec<String>,
}

fn yes() -> bool {
    true
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Rules {
    handle: u32,
    /// The rules as they should be from now on; left out, the rules are only
    /// read back.
    #[serde(default)]
    set: Option<Vec<RuleArgs>>,
    /// Run them over every document already in the index.
    #[serde(default)]
    apply: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HitOut {
    key: String,
    name: String,
    page: u32,
    line: u32,
    text: String,
    spans: Vec<[usize; 2]>,
    score: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    date: Option<String>,
    kind: &'static str,
    tags: Vec<String>,
}

pub fn call_static(name: &str, json: &str, blobs: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    match name {
        "open" => open_index(blobs),
        "add" => add(args(json)?, blobs),
        "forget" => {
            let a: Forget = args(json)?;
            let left = with_index(a.handle, |index| index.forget(&a.keys))?;
            Reply::of(&serde_json::json!({ "documents": left }))
        }
        "search" => search(args(json)?),
        "document" => {
            let a: Key = args(json)?;
            let found = with_index(a.handle, |index| index.document(&a.key))?;
            let found = found.ok_or_else(|| {
                CoreError::Args(format!("library.document: {} is not in the index", a.key))
            })?;
            let path = found.key.contains(['/', '\\']).then(|| found.key.clone());
            Reply::of(&serde_json::json!({
                "key": found.key,
                "name": found.name,
                "kind": found.kind.as_str(),
                "pages": found.pages,
                "chars": found.chars,
                "date": found.date,
                "tags": found.tags,
                "indexed": found.indexed,
                "modified": found.modified,
                "bytes": found.bytes,
                "path": path,
            }))
        }
        "tag" => {
            let a: Tag = args(json)?;
            let tags = with_index(a.handle, |index| index.tag(&a.key, &a.add, &a.remove))??;
            Reply::of(&serde_json::json!({ "tags": tags }))
        }
        "stats" => {
            let a: Handle = args(json)?;
            let stats = with_index(a.handle, |index| index.stats())?;
            let kinds: serde_json::Map<String, serde_json::Value> = stats
                .kinds
                .into_iter()
                .map(|(kind, count)| (kind.to_string(), count.into()))
                .collect();
            let tags: serde_json::Map<String, serde_json::Value> = stats
                .tags
                .into_iter()
                .map(|(tag, count)| (tag, count.into()))
                .collect();
            Reply::of(&serde_json::json!({
                "documents": stats.documents,
                "pages": stats.pages,
                "words": stats.words,
                "bytes": stats.bytes,
                "kinds": kinds,
                "tags": tags,
            }))
        }
        "rules" => rules(args(json)?),
        "save" => {
            let a: Handle = args(json)?;
            let bytes = with_index(a.handle, |index| format::write(index))?;
            Ok(Reply::of(&serde_json::json!({ "bytes": bytes.len() }))?.with_blob(bytes))
        }
        "close" => {
            let a: Handle = args(json)?;
            let mut open = open().lock().unwrap_or_else(|e| e.into_inner());
            open.indexes.remove(&a.handle);
            Reply::of(&serde_json::json!({}))
        }
        _ => Err(CoreError::UnknownOp(format!("library.{name}"))),
    }
}

/// `library.open`: an index read from bytes, or a new empty one.
fn open_index(blobs: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let index = match blobs.first() {
        Some(bytes) if !bytes.is_empty() => format::read(bytes)?,
        _ => Index::default(),
    };
    let (documents, words) = (index.documents(), index.words());
    let mut open = open().lock().unwrap_or_else(|e| e.into_inner());
    if open.indexes.len() >= MAX_OPEN {
        return Err(CoreError::Args(format!(
            "library.open: {MAX_OPEN} indexes are already open; close one first"
        )));
    }
    open.next = open.next.wrapping_add(1).max(1);
    while open.indexes.contains_key(&open.next) {
        open.next = open.next.wrapping_add(1).max(1);
    }
    let handle = open.next;
    open.indexes.insert(handle, index);
    Reply::of(&serde_json::json!({
        "handle": handle,
        "documents": documents,
        "words": words,
    }))
}

/// `library.add`: read a file's text — with the core, or as the host read it —
/// and put it in the index.
fn add(a: Add, blobs: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    // Before anything is read: a file under a key the index could never hold
    // is a mistake in the host, not a file to be indexed.
    if a.key.is_empty() || a.key.chars().count() > index::MAX_KEY_CHARS {
        return Err(CoreError::Args(
            "library.add needs a key, and a short one".into(),
        ));
    }
    let kind = a.kind.as_deref().and_then(Kind::parse);
    let name = if a.name.is_empty() {
        a.key
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(&a.key)
            .to_string()
    } else {
        a.name.clone()
    };
    let bytes = a
        .bytes
        .unwrap_or_else(|| blobs.first().map(|b| b.len()).unwrap_or(0) as u64);

    // A file the index has no room for is skipped before anything is read.
    if with_index(a.handle, |index| index.full())? {
        return skipped("indexFull", kind.unwrap_or(Kind::Pdf));
    }

    // Nor is a file that has not been written to since it went in read again:
    // asked here, before the bytes are opened, a second pass over a folder of
    // a thousand files costs a lookup each. (The index asks again for itself —
    // this is a saving, not the rule.)
    if a.text.is_none() {
        let guess = kind.or_else(|| Kind::from_name(&name)).unwrap_or(Kind::Pdf);
        let known = with_index(a.handle, |index| {
            // Whether a PDF is really a scan is only known once it has been
            // read, so a PDF is asked about under both names.
            let mut answer = index.unchanged(&a.key, a.modified, bytes, guess, false);
            if answer.is_none() && guess == Kind::Pdf {
                answer = index.unchanged(&a.key, a.modified, bytes, Kind::Scan, false);
            }
            answer
        })?;
        if let Some(outcome) = known {
            return answer(&outcome);
        }
    }

    let (pages_text, pages) = match a.text {
        Some(text) => {
            // `saturating_add`: a host that says page 4 294 967 295 must get an
            // answer, not an overflow.
            let pages = text
                .iter()
                .map(|p| p.page.saturating_add(1))
                .max()
                .unwrap_or(0);
            (
                text.into_iter().map(|p| (p.page, p.text)).collect(),
                a.pages.unwrap_or(pages),
            )
        }
        None => {
            let Some(file) = blobs.into_iter().next() else {
                return Err(CoreError::Args(
                    "library.add takes the file's bytes, or its text".into(),
                ));
            };
            if file.len() > MAX_FILE_BYTES {
                return skipped("tooLarge", kind.unwrap_or(Kind::Pdf));
            }
            match read_pdf(file, a.password.as_deref()) {
                Ok(read) => read,
                Err(why) => return skipped(why, kind.unwrap_or(Kind::Pdf)),
            }
        }
    };

    let about = Added {
        key: a.key,
        name,
        kind,
        modified: a.modified,
        bytes,
        pages: a.pages.unwrap_or(pages),
    };
    let outcome = with_index(a.handle, |index| index.add(about, pages_text, a.now))??;
    answer(&outcome)
}

/// What `library.add` says, however it got there.
fn answer(outcome: &index::AddOutcome) -> Result<Reply, CoreError> {
    Reply::of(&serde_json::json!({
        "added": outcome.added,
        "skipped": outcome.skipped,
        "pages": outcome.pages,
        "chars": outcome.chars,
        "date": outcome.date,
        "guessedKind": outcome.kind.as_str(),
        "truncated": outcome.truncated,
    }))
}

fn skipped(why: &'static str, kind: Kind) -> Result<Reply, CoreError> {
    answer(&index::AddOutcome {
        added: false,
        skipped: Some(why),
        pages: 0,
        chars: 0,
        date: None,
        kind,
        truncated: false,
    })
}

/// A file's text, one entry per page, and how many pages it has.
type PagesRead = (Vec<(u32, String)>, u32);

/// A PDF's text, page by page, with the reader the rest of محرر PDF uses. A
/// page that will not be read leaves an empty page behind instead of ending
/// the run: one broken page must not cost the whole file.
fn read_pdf(bytes: Vec<u8>, password: Option<&str>) -> Result<PagesRead, &'static str> {
    let document = Document::open(bytes, password).map_err(|error| {
        let message = error.to_string();
        if message.contains("E_PASSWORD") {
            "password"
        } else {
            "unreadable"
        }
    })?;
    let count = document.page_count().min(index::MAX_PAGES_PER_DOCUMENT);
    let mut pages = Vec::with_capacity(count);
    for page in 0..count {
        let text = document
            .all_lines(page)
            .map(|lines| {
                lines
                    .iter()
                    .map(|line| line.text.as_str())
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();
        pages.push((page as u32, text));
    }
    let count = count as u32;
    Ok((pages, count))
}

fn search(a: Search) -> Result<Reply, CoreError> {
    let given = a.filters.unwrap_or_default();
    let filters = Filters {
        // A kind this build does not know narrows nothing, rather than
        // failing a search the person is typing.
        kinds: given.kinds.iter().filter_map(|k| Kind::parse(k)).collect(),
        folders: given.folders,
        tags: given.tags.iter().map(|t| index::clean_tag(t)).collect(),
        from: given.from,
        to: given.to,
        scanned_only: given.scanned_only,
    };
    let limit = a.limit.unwrap_or(DEFAULT_LIMIT).min(search::MAX_HITS);
    let offset = a.offset.unwrap_or(0);
    let results = with_index(a.handle, |index| {
        index.search(&a.query, &filters, offset, limit)
    })?;
    let hits: Vec<HitOut> = results
        .hits
        .into_iter()
        .map(|hit| HitOut {
            key: hit.key,
            name: hit.name,
            page: hit.page,
            line: hit.line,
            text: hit.text,
            spans: hit.spans.into_iter().map(|(at, len)| [at, len]).collect(),
            score: hit.score,
            date: hit.date,
            kind: hit.kind.as_str(),
            tags: hit.tags,
        })
        .collect();
    Reply::of(&serde_json::json!({ "total": results.total, "hits": hits }))
}

fn rules(a: Rules) -> Result<Reply, CoreError> {
    let set = a.set.map(|rules| {
        rules
            .into_iter()
            .map(|r| Rule {
                tag: r.tag,
                words: r.words,
                all: r.all,
                enabled: r.enabled,
                scope: r
                    .scope
                    .as_deref()
                    .and_then(Scope::parse)
                    .unwrap_or(Scope::Text),
                kinds: r.kinds.iter().filter_map(|k| Kind::parse(k)).collect(),
            })
            .collect::<Vec<_>>()
    });
    let (kept, tagged) = with_index(a.handle, |index| {
        if let Some(rules) = set {
            index.set_rules(rules);
        }
        let tagged = if a.apply { index.apply_rules() } else { 0 };
        let kept: Vec<RuleArgs> = index
            .rules()
            .iter()
            .map(|r| RuleArgs {
                tag: r.tag.clone(),
                words: r.words.clone(),
                all: r.all,
                enabled: r.enabled,
                scope: Some(r.scope.as_str().to_string()),
                kinds: r.kinds.iter().map(|k| k.as_str().to_string()).collect(),
            })
            .collect();
        (kept, tagged)
    })?;
    Reply::of(&serde_json::json!({ "rules": kept, "tagged": tagged }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json(reply: &Reply) -> serde_json::Value {
        serde_json::from_str(&reply.json).expect("the answer is JSON")
    }

    fn open_new() -> u32 {
        let reply = call_static("open", "{}", vec![]).expect("opened");
        json(&reply)["handle"].as_u64().expect("a handle") as u32
    }

    fn close(handle: u32) {
        call_static("close", &format!("{{\"handle\":{handle}}}"), vec![]).expect("closed");
    }

    fn add_text(handle: u32, key: &str, text: &str) -> serde_json::Value {
        let args = serde_json::json!({
            "handle": handle,
            "key": key,
            "name": key.rsplit('/').next().unwrap_or(key),
            "kind": "pdf",
            "modified": 1_700_000_000i64,
            "now": 1_700_000_500i64,
            "text": [{ "page": 0, "text": text }],
        });
        json(&call_static("add", &args.to_string(), vec![]).expect("added"))
    }

    #[test]
    fn the_ops_open_add_search_tag_save_and_close() {
        let handle = open_new();
        let added = add_text(handle, "/دفتر/فاتورة.pdf", "فاتورة ضريبية بتاريخ 3/4/2026");
        assert_eq!(added["added"], true);
        assert_eq!(added["guessedKind"], "pdf");
        assert_eq!(added["date"], "2026-04-03");

        let found = json(
            &call_static(
                "search",
                &serde_json::json!({ "handle": handle, "query": "فاتوره" }).to_string(),
                vec![],
            )
            .expect("searched"),
        );
        assert_eq!(found["total"], 1);
        assert_eq!(found["hits"][0]["key"], "/دفتر/فاتورة.pdf");
        assert_eq!(found["hits"][0]["page"], 0);
        assert!(!found["hits"][0]["spans"]
            .as_array()
            .expect("spans")
            .is_empty());

        let tagged = json(
            &call_static(
                "tag",
                &serde_json::json!({ "handle": handle, "key": "/دفتر/فاتورة.pdf", "add": ["مهم"] })
                    .to_string(),
                vec![],
            )
            .expect("tagged"),
        );
        assert_eq!(tagged["tags"][0], "مهم");

        let stats = json(
            &call_static("stats", &format!("{{\"handle\":{handle}}}"), vec![]).expect("stats"),
        );
        assert_eq!(stats["documents"], 1);
        assert_eq!(stats["kinds"]["pdf"], 1);
        assert_eq!(stats["tags"]["مهم"], 1);

        let saved =
            call_static("save", &format!("{{\"handle\":{handle}}}"), vec![]).expect("saved");
        let bytes = saved.blobs.into_iter().next().expect("the index's bytes");
        assert!(!bytes.is_empty());
        close(handle);

        // It comes back with its document and its tag.
        let reopened = json(&call_static("open", "{}", vec![bytes]).expect("reopened"));
        let handle = reopened["handle"].as_u64().expect("a handle") as u32;
        assert_eq!(reopened["documents"], 1);
        let document = json(
            &call_static(
                "document",
                &serde_json::json!({ "handle": handle, "key": "/دفتر/فاتورة.pdf" }).to_string(),
                vec![],
            )
            .expect("document"),
        );
        assert_eq!(document["tags"][0], "مهم");
        assert_eq!(document["path"], "/دفتر/فاتورة.pdf");
        assert_eq!(document["indexed"], 1_700_000_500i64);
        close(handle);
    }

    #[test]
    fn a_handle_that_is_not_open_is_an_error_not_a_crash() {
        let error = call_static("search", "{\"handle\":999999,\"query\":\"x\"}", vec![])
            .expect_err("refused");
        assert!(error.to_string().contains("is not open"), "{error}");
        // and closing one twice is quiet
        let handle = open_new();
        close(handle);
        close(handle);
    }

    #[test]
    fn an_index_that_is_not_one_is_refused() {
        let error = call_static("open", "{}", vec![b"not an index".to_vec()]).expect_err("refused");
        assert!(error.to_string().starts_with("E_INDEX"), "{error}");
    }

    #[test]
    fn a_file_that_is_not_a_pdf_is_skipped_with_its_reason() {
        let handle = open_new();
        let args = serde_json::json!({
            "handle": handle, "key": "/a.bin", "name": "a.bin", "modified": 1,
        });
        let out =
            json(&call_static("add", &args.to_string(), vec![vec![0u8; 64]]).expect("answered"));
        assert_eq!(out["added"], false);
        assert_eq!(out["skipped"], "unreadable");
        close(handle);
    }

    #[test]
    fn rules_are_read_back_and_can_be_run_over_what_is_already_indexed() {
        let handle = open_new();
        add_text(handle, "/a.pdf", "فاتورة ضريبية");
        let set = serde_json::json!({
            "handle": handle,
            "set": [{ "tag": "فواتير", "words": ["فاتورة"], "scope": "both" }],
            "apply": true,
        });
        let out = json(&call_static("rules", &set.to_string(), vec![]).expect("rules"));
        assert_eq!(out["tagged"], 1);
        assert_eq!(out["rules"][0]["tag"], "فواتير");
        assert_eq!(out["rules"][0]["scope"], "both");
        let read = json(
            &call_static("rules", &format!("{{\"handle\":{handle}}}"), vec![]).expect("read back"),
        );
        assert_eq!(read["rules"].as_array().expect("rules").len(), 1);
        assert_eq!(read["tagged"], 0);
        close(handle);
    }

    #[test]
    fn arguments_no_host_should_send_are_answered_not_crashed_on() {
        let handle = open_new();
        // The last page there could ever be, and one page past every cap.
        let args = serde_json::json!({
            "handle": handle,
            "key": "/odd.pdf",
            "name": "odd.pdf",
            "kind": "something this build has never heard of",
            "modified": i64::MIN,
            "pages": u32::MAX,
            "text": [{ "page": u32::MAX, "text": "مكتبة" }],
        });
        let out = json(&call_static("add", &args.to_string(), vec![]).expect("answered"));
        assert_eq!(out["added"], true);
        assert!(out["pages"].as_u64().unwrap_or(0) <= index::MAX_PAGES_PER_DOCUMENT as u64);
        assert_eq!(out["guessedKind"], "pdf", "an unknown kind falls back");
        assert_eq!(search_for(handle, "مكتبة")["total"], 1);

        // An offset past the end, and a limit larger than the cap.
        let far = serde_json::json!({
            "handle": handle, "query": "مكتبة", "offset": u32::MAX, "limit": u32::MAX,
        });
        let out = json(&call_static("search", &far.to_string(), vec![]).expect("answered"));
        assert_eq!(out["total"], 1);
        assert!(out["hits"].as_array().expect("hits").is_empty());

        // A key no file could have.
        let long = serde_json::json!({ "handle": handle, "key": "ا".repeat(100_000) });
        assert!(call_static("add", &long.to_string(), vec![vec![0u8; 8]]).is_err());
        close(handle);
    }

    fn search_for(handle: u32, query: &str) -> serde_json::Value {
        json(
            &call_static(
                "search",
                &serde_json::json!({ "handle": handle, "query": query }).to_string(),
                vec![],
            )
            .expect("searched"),
        )
    }

    #[test]
    fn an_op_the_library_does_not_have_says_so() {
        let error = call_static("dance", "{}", vec![]).expect_err("refused");
        assert!(error.to_string().contains("E_UNKNOWN_OP"), "{error}");
    }
}
