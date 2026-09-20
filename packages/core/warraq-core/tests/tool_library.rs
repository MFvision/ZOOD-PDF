//! The Library through `call_static`, the way every host reaches it: a whole
//! folder of real files indexed, searched across, saved, read back, and — since
//! the index is a file like any other — attacked.
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;
use std::time::Instant;

use serde_json::Value;
use warraq_core::{call_static, Reply};

fn corpus_root() -> PathBuf {
    PathBuf::from(format!(
        "{}/../../../tests/corpus/arabic",
        env!("CARGO_MANIFEST_DIR")
    ))
}

/// Every PDF of the corpus, in a settled order, the many-page performance
/// fixtures left out: this is about breadth, not throughput.
fn corpus_files() -> Vec<PathBuf> {
    let mut files = Vec::new();
    for folder in ["generated", "realworld"] {
        let Ok(entries) = std::fs::read_dir(corpus_root().join(folder)) else {
            continue;
        };
        let mut here: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|e| e == "pdf"))
            .filter(|p| {
                !p.file_name()
                    .is_some_and(|n| n.to_string_lossy().starts_with("perf-"))
            })
            .collect();
        here.sort();
        files.extend(here);
    }
    files
}

fn json(reply: &Reply) -> Value {
    serde_json::from_str(&reply.json).expect("the answer is JSON")
}

fn call(op: &str, args: Value, blobs: Vec<Vec<u8>>) -> Value {
    json(&call_static(op, &args.to_string(), blobs).unwrap_or_else(|e| panic!("{op}: {e}")))
}

fn open_index(bytes: Option<Vec<u8>>) -> u32 {
    let blobs = bytes.map(|b| vec![b]).unwrap_or_default();
    call("library.open", serde_json::json!({}), blobs)["handle"]
        .as_u64()
        .expect("a handle") as u32
}

fn close(handle: u32) {
    call(
        "library.close",
        serde_json::json!({ "handle": handle }),
        vec![],
    );
}

fn add_file(handle: u32, path: &PathBuf, password: Option<&str>) -> Value {
    add_file_as(handle, path, &path.to_string_lossy(), password)
}

fn add_file_as(handle: u32, path: &PathBuf, key: &str, password: Option<&str>) -> Value {
    let bytes = std::fs::read(path).expect("a corpus file");
    let name = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    call(
        "library.add",
        serde_json::json!({
            "handle": handle,
            "key": key,
            "name": name,
            "kind": "pdf",
            "modified": 1_700_000_000i64,
            "now": 1_700_000_500i64,
            "password": password,
        }),
        vec![bytes],
    )
}

fn search(handle: u32, query: &str) -> Value {
    call(
        "library.search",
        serde_json::json!({ "handle": handle, "query": query, "limit": 200 }),
        vec![],
    )
}

/// The distinct files a search answered with.
fn files_found(results: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for hit in results["hits"].as_array().expect("hits") {
        let name = hit["name"].as_str().unwrap_or_default().to_string();
        if !out.contains(&name) {
            out.push(name);
        }
    }
    out
}

#[test]
fn the_whole_arabic_corpus_goes_into_one_index_and_is_searched_across() {
    let files = corpus_files();
    assert!(
        files.len() >= 40,
        "the corpus is not where it was: {}",
        files.len()
    );
    let handle = open_index(None);

    let started = Instant::now();
    let (mut added, mut scans, mut skipped) = (0, 0, Vec::new());
    for file in &files {
        let out = add_file(handle, file, None);
        if out["added"].as_bool().unwrap_or(false) {
            added += 1;
            if out["guessedKind"] == "scan" {
                scans += 1;
            }
        } else {
            skipped.push(format!(
                "{}: {}",
                file.file_name().unwrap_or_default().to_string_lossy(),
                out["skipped"].as_str().unwrap_or("?")
            ));
        }
    }
    let indexing = started.elapsed();

    // Only the protected files are refused, and they say why.
    assert!(
        skipped.iter().all(|s| s.contains("password")),
        "unexpected skips: {skipped:?}"
    );
    assert!(
        added >= 40,
        "only {added} of {} files were indexed",
        files.len()
    );
    assert!(
        scans >= 3,
        "the corpus's scans were not seen as scans ({scans})"
    );

    let stats = call(
        "library.stats",
        serde_json::json!({ "handle": handle }),
        vec![],
    );
    assert_eq!(stats["documents"].as_u64(), Some(added as u64));
    assert!(stats["words"].as_u64().unwrap_or(0) > 10_000, "{stats}");

    // One Arabic word, written with no tashkeel, found across many files.
    let started = Instant::now();
    let found = search(handle, "العربية");
    let searching = started.elapsed();
    assert!(
        files_found(&found).len() >= 5,
        "العربية was found in only {:?}",
        files_found(&found)
    );
    // …and the word is marked inside the line the person would read.
    let hit = &found["hits"][0];
    let text = hit["text"].as_str().expect("the line");
    let spans = hit["spans"].as_array().expect("spans");
    assert!(!spans.is_empty(), "no mark on {text}");
    for span in spans {
        let at = span[0].as_u64().expect("a start") as usize;
        let len = span[1].as_u64().expect("a length") as usize;
        assert!(
            text.is_char_boundary(at) && text.is_char_boundary(at + len),
            "{text}"
        );
        assert!(!text[at..at + len].trim().is_empty());
    }

    let saved =
        call_static("library.save", &format!("{{\"handle\":{handle}}}"), vec![]).expect("saved");
    let bytes = saved.blobs.into_iter().next().expect("the index");
    // What `library.stats` says the index takes is an estimate; it must stay
    // near what saving it really writes, or the number is worse than none.
    let held = stats["bytes"].as_u64().expect("a size") as f64;
    let written = bytes.len() as f64;
    assert!(
        (held / written - 1.0).abs() < 0.25,
        "stats says {held} bytes, saving writes {written}"
    );
    eprintln!(
        "library: {added} files indexed in {indexing:?}; index {} KB on disk, {} KB held; \
         one search {searching:?}",
        bytes.len() / 1024,
        stats["bytes"].as_u64().unwrap_or(0) / 1024,
    );
    close(handle);

    // The saved index answers the same search.
    let handle = open_index(Some(bytes));
    assert_eq!(
        files_found(&search(handle, "العربية")),
        files_found(&found),
        "the saved index answers differently"
    );
    close(handle);
}

#[test]
fn a_protected_file_is_skipped_until_its_password_is_given() {
    let file = corpus_root().join("generated/variant-encrypted-aes256.pdf");
    let handle = open_index(None);
    let without = add_file(handle, &file, None);
    assert_eq!(without["added"], false);
    assert_eq!(without["skipped"], "password");
    assert_eq!(search(handle, "العربية")["total"], 0);

    // A key of its own: this checkout's own path carries the code name, and
    // what is being proved here is that the PASSWORD is nowhere in the index.
    let with = add_file_as(handle, &file, "/محفوظات/مقفل.pdf", Some("warraq"));
    assert_eq!(with["added"], true, "{with}");
    assert!(with["chars"].as_u64().unwrap_or(0) > 0);

    let saved =
        call_static("library.save", &format!("{{\"handle\":{handle}}}"), vec![]).expect("saved");
    let bytes = saved.blobs.into_iter().next().expect("the index");
    assert!(
        !bytes.windows(6).any(|w| w == b"warraq"),
        "the password went into the index"
    );
    close(handle);
}

#[test]
fn a_pdf_whose_pages_carry_no_text_is_a_scan_the_interface_can_fill_in() {
    let file = corpus_root().join("generated/scan-notonaskh-300dpi-skewed-jpeg.pdf");
    let handle = open_index(None);
    let out = add_file(handle, &file, None);
    assert_eq!(out["guessedKind"], "scan", "{out}");
    assert_eq!(out["chars"], 0);
    assert_eq!(search(handle, "المكتبة")["total"], 0);

    // The interface reads it with OCR and hands the text back under the same
    // key; now it is found.
    let key = file.to_string_lossy().to_string();
    let filled = call(
        "library.add",
        serde_json::json!({
            // The same size and time the first pass saw: the file itself was
            // never touched, only read.
            "handle": handle,
            "key": key,
            "name": "scan.pdf",
            "kind": "scan",
            "modified": 1_700_000_000i64,
            "text": [{ "page": 0, "text": "المكتبة الوطنية\nالتاريخ 5/6/2026" }],
        }),
        vec![],
    );
    assert_eq!(filled["added"], true);
    assert_eq!(filled["date"], "2026-06-05");
    assert_eq!(search(handle, "المكتبة")["total"], 1);
    let scans = call(
        "library.search",
        serde_json::json!({
            "handle": handle,
            "query": "المكتبة",
            "filters": { "scannedOnly": true },
        }),
        vec![],
    );
    assert_eq!(scans["total"], 1, "a scan stays a scan once its text is in");
    close(handle);
}

#[test]
fn a_second_pass_over_a_folder_reads_nothing_twice() {
    let file = corpus_root().join("generated/chrome-cairo-mixed-invoice.pdf");
    let handle = open_index(None);
    assert_eq!(add_file(handle, &file, None)["added"], true);
    let again = add_file(handle, &file, None);
    assert_eq!(again["added"], false);
    assert_eq!(again["skipped"], "unchanged");
    assert!(
        again["chars"].as_u64().unwrap_or(0) > 0,
        "it still says what it holds"
    );

    // The host may know the file's size without handing over its bytes, and a
    // size that changed means the file did.
    let key = file.to_string_lossy().to_string();
    let resized = call(
        "library.add",
        serde_json::json!({
            "handle": handle, "key": key, "name": "invoice.pdf", "kind": "pdf",
            "modified": 1_700_000_000i64, "bytes": 999_999,
            "text": [{ "page": 0, "text": "نص آخر تماما" }],
        }),
        vec![],
    );
    assert_eq!(resized["added"], true);
    assert_eq!(
        call(
            "library.document",
            serde_json::json!({ "handle": handle, "key": key }),
            vec![],
        )["bytes"],
        999_999
    );
    close(handle);
}

#[test]
fn forgetting_a_file_takes_it_out_of_every_answer() {
    let handle = open_index(None);
    for (key, text) in [("/a.pdf", "المكتبة الوطنية"), ("/b.pdf", "المكتبة العامة")]
    {
        call(
            "library.add",
            serde_json::json!({
                "handle": handle, "key": key, "name": key, "kind": "pdf",
                "modified": 1, "text": [{ "page": 0, "text": text }],
            }),
            vec![],
        );
    }
    assert_eq!(search(handle, "المكتبة")["total"], 2);
    let left = call(
        "library.forget",
        serde_json::json!({ "handle": handle, "keys": ["/a.pdf"] }),
        vec![],
    );
    assert_eq!(left["documents"], 1);
    assert_eq!(files_found(&search(handle, "المكتبة")), vec!["/b.pdf"]);
    // Forgetting what is not there is quiet.
    assert_eq!(
        call(
            "library.forget",
            serde_json::json!({ "handle": handle, "keys": ["/nowhere.pdf"] }),
            vec![],
        )["documents"],
        1
    );
    close(handle);
}

/* --------------------------------------------------- the index is a file too */

/// The same reproducible PRNG the PDF robustness harness uses.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: usize) -> usize {
        if n == 0 {
            0
        } else {
            (self.next() % n as u64) as usize
        }
    }
}

/// An index with enough in it to have every part of the format in play.
fn an_index() -> Vec<u8> {
    let handle = open_index(None);
    call(
        "library.rules",
        serde_json::json!({
            "handle": handle,
            "set": [{ "tag": "فواتير", "words": ["فاتورة"], "scope": "both" }],
        }),
        vec![],
    );
    for (key, text) in [
        (
            "/دفتر/فاتورة.pdf",
            "فاتورة ضريبية رقم ١٢٣\nالتاريخ ٣ رمضان ١٤٤٧هـ",
        ),
        ("/دفتر/عقد.pdf", "عقد إيجار\nحرر في 15 يونيو 2026"),
        (
            "/نسخة/فاتورة.pdf",
            "فاتورة ضريبية رقم ١٢٣\nالتاريخ ٣ رمضان ١٤٤٧هـ",
        ),
    ] {
        call(
            "library.add",
            serde_json::json!({
                "handle": handle, "key": key, "name": key, "kind": "pdf",
                "modified": 1_700_000_000i64, "now": 1_700_000_500i64,
                "text": [{ "page": 0, "text": text }],
            }),
            vec![],
        );
    }
    call(
        "library.tag",
        serde_json::json!({ "handle": handle, "key": "/دفتر/عقد.pdf", "add": ["مهم"] }),
        vec![],
    );
    let saved =
        call_static("library.save", &format!("{{\"handle\":{handle}}}"), vec![]).expect("saved");
    close(handle);
    saved.blobs.into_iter().next().expect("the index")
}

#[test]
fn an_index_carries_its_documents_tags_rules_and_dates_across_a_save() {
    let bytes = an_index();
    let handle = open_index(Some(bytes));
    let document = call(
        "library.document",
        serde_json::json!({ "handle": handle, "key": "/دفتر/فاتورة.pdf" }),
        vec![],
    );
    assert_eq!(
        document["date"], "2026-02-20",
        "3 Ramadan 1447 (Umm al-Qura)"
    );
    assert_eq!(document["tags"][0], "فواتير", "the rule's tag came back");
    assert_eq!(document["indexed"], 1_700_000_500i64);
    let contract = call(
        "library.document",
        serde_json::json!({ "handle": handle, "key": "/دفتر/عقد.pdf" }),
        vec![],
    );
    assert_eq!(contract["date"], "2026-06-15");
    assert_eq!(contract["tags"][0], "مهم");
    let rules = call(
        "library.rules",
        serde_json::json!({ "handle": handle }),
        vec![],
    );
    assert_eq!(rules["rules"][0]["tag"], "فواتير");
    // The two copies of one file are both answered, from one stored text.
    assert_eq!(files_found(&search(handle, "فاتورة")).len(), 2);
    close(handle);
}

#[test]
fn a_damaged_index_is_refused_and_never_panics() {
    let good = an_index();
    let mut refused = 0usize;
    for seed in 0..400u64 {
        let mut rng = Rng(seed | 1);
        let mut bytes = good.clone();
        match rng.below(4) {
            0 => bytes.truncate(rng.below(bytes.len())),
            1 => {
                for _ in 0..8 {
                    let at = rng.below(bytes.len());
                    bytes[at] ^= 1 << rng.below(8);
                }
            }
            2 => {
                // A count blown up to something enormous: the classic
                // "allocate a gigabyte" bug.
                let at = rng.below(bytes.len().saturating_sub(8));
                for k in 0..8 {
                    bytes[at + k] = if k == 7 { 0x7f } else { 0xff };
                }
            }
            _ => {
                let at = rng.below(bytes.len());
                let to = (at + 1 + rng.below(64)).min(bytes.len());
                bytes.drain(at..to);
            }
        }
        if bytes == good {
            continue;
        }
        let answer = catch_unwind(AssertUnwindSafe(|| {
            call_static("library.open", "{}", vec![bytes])
        }));
        let answer = answer.unwrap_or_else(|_| panic!("a damaged index panicked (seed {seed})"));
        match answer {
            Err(error) => {
                assert!(error.to_string().starts_with("E_INDEX"), "{error}");
                refused += 1;
            }
            // A mutation the checksum happens to survive cannot happen — but
            // if the reader ever loads one, it must at least be usable.
            Ok(reply) => {
                let handle = json(&reply)["handle"].as_u64().expect("a handle") as u32;
                let _ = search(handle, "فاتورة");
                close(handle);
            }
        }
    }
    assert!(
        refused > 350,
        "only {refused} of 400 damaged indexes were refused"
    );
}

#[test]
fn bytes_that_were_never_an_index_are_refused() {
    let pdf = std::fs::read(corpus_root().join("generated/chrome-cairo-mixed-invoice.pdf"))
        .expect("a corpus file");
    for bytes in [
        b"WRQLIB".to_vec(),
        b"WRQLIB\x01\x00\x00\x00".to_vec(),
        vec![0u8; 4096],
        vec![0xffu8; 4096],
        pdf,
    ] {
        let answer = catch_unwind(AssertUnwindSafe(|| {
            call_static("library.open", "{}", vec![bytes])
        }));
        let answer = answer.expect("opening rubbish must not panic");
        assert!(answer.is_err(), "rubbish was taken for an index");
    }
    // No bytes at all is not rubbish: it is a new index, as `library.open`
    // with no blob at all is.
    let handle = open_index(Some(vec![]));
    assert_eq!(search(handle, "أي شيء")["total"], 0);
    close(handle);
}

/// The path `packages/core/fuzz/fuzz_targets/library_index.rs` drives, so a
/// rename cannot quietly leave the nightly fuzz job building nothing.
#[test]
fn the_fuzz_target_reaches_the_reader_the_way_it_says_it_does() {
    use warraq_core::tools::library::format;
    use warraq_core::tools::library::search::Filters;

    assert!(format::read(b"nothing like an index").is_err());
    let index = format::read(&an_index()).expect("a real one loads");
    assert!(index.search("فاتورة", &Filters::default(), 0, 10).total > 0);
    assert_eq!(index.stats().documents, 3);
    assert_eq!(format::write(&index).len(), an_index().len());
}

#[test]
fn a_search_over_an_empty_index_answers_nothing_at_all() {
    let handle = open_index(None);
    assert_eq!(search(handle, "أي شيء")["total"], 0);
    let stats = call(
        "library.stats",
        serde_json::json!({ "handle": handle }),
        vec![],
    );
    assert_eq!(stats["documents"], 0);
    assert_eq!(stats["words"], 0);
    close(handle);
}
