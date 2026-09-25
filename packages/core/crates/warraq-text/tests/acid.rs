//! The Arabic acid gate.
//!
//! For every non-scanned PDF in `tests/corpus/manifest.json`, extract the logical-order text
//! and compare it with its truth file using a normalised character accuracy
//! (`1 − Levenshtein / truth length` after NFC, removal of invisible formatting characters and
//! whitespace collapsing). The test fails when any file drops below its threshold in
//! `tests/acid/baseline.json` — a regression gate. Files are loaded and decrypted by `warraq-pdf`
//! (the product path); the manifest can still mark a file `pending_decryption` to skip it.
//!
//! Run: `cargo test -p warraq-text --test acid -- --nocapture`
//! Env: `ACID_VERBOSE=1` prints extracted vs truth text for files below 100 %;
//!      `ACID_LOADER=lopdf` loads with the stand-alone `LopdfSource` instead of `warraq-pdf`;
//!      `ACID_BLESS=1` rewrites the baseline from the measured values (minus a small margin).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::Value;
use unicode_normalization::UnicodeNormalization;
use warraq_text::{extract_all, plain_text, DocSource, LayoutOptions, LopdfSource};

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../..")
        .canonicalize()
        .unwrap()
}

/// Normalisation used for the accuracy metric (not for extraction).
fn norm(s: &str) -> Vec<char> {
    let nfc: String = s.nfc().collect();
    let mut out = Vec::with_capacity(nfc.len());
    let mut space = true;
    for c in nfc.chars() {
        if matches!(c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{061C}' | '\u{FEFF}' | '\u{00AD}')
        {
            continue;
        }
        if c.is_whitespace() {
            if !space {
                out.push(' ');
                space = true;
            }
        } else {
            out.push(c);
            space = false;
        }
    }
    if out.last() == Some(&' ') {
        out.pop();
    }
    out
}

fn levenshtein(a: &[char], b: &[char]) -> usize {
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur = vec![0usize; b.len() + 1];
    for (i, ca) in a.iter().enumerate() {
        cur[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let sub = prev[j] + usize::from(ca != cb);
            cur[j + 1] = sub.min(prev[j + 1] + 1).min(cur[j] + 1);
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()]
}

fn accuracy(extracted: &str, truth: &str) -> f64 {
    let (e, t) = (norm(extracted), norm(truth));
    if t.is_empty() {
        return if e.is_empty() { 1.0 } else { 0.0 };
    }
    (1.0 - levenshtein(&e, &t) as f64 / t.len() as f64).max(0.0)
}

#[test]
fn accuracy_metric_sanity() {
    assert_eq!(accuracy("سلام  عليكم\n", "سلام عليكم"), 1.0);
    assert!((accuracy("abcd", "abce") - 0.75).abs() < 1e-9);
    assert_eq!(accuracy("", "abc"), 0.0);
    assert_eq!(accuracy("می\u{200C}توانند", "می‌توانند"), 1.0);
}

struct Row {
    id: String,
    producer: String,
    status: String,
    accuracy: Option<f64>,
    baseline: Option<f64>,
}

#[test]
fn arabic_acid_gate() {
    let root = repo();
    let corpus = root.join("tests/corpus");
    let manifest: Value = serde_json::from_str(
        &std::fs::read_to_string(corpus.join("manifest.json")).expect("manifest.json"),
    )
    .unwrap();
    let baseline_path = root.join("tests/acid/baseline.json");
    let baseline: Value = std::fs::read_to_string(&baseline_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null);
    let verbose = std::env::var_os("ACID_VERBOSE").is_some();
    let bless = std::env::var_os("ACID_BLESS").is_some();
    let use_lopdf = std::env::var("ACID_LOADER").is_ok_and(|v| v == "lopdf");
    println!(
        "loader: {}",
        if use_lopdf {
            "lopdf (stand-alone)"
        } else {
            "warraq-pdf (product path)"
        }
    );

    let mut rows: Vec<Row> = Vec::new();
    let mut failures: Vec<String> = Vec::new();
    for f in manifest["files"].as_array().unwrap() {
        if f["flags"]["scanned"].as_bool().unwrap_or(false) {
            continue;
        }
        let id = f["id"].as_str().unwrap().to_string();
        let producer = f["producer"].as_str().unwrap_or("").to_string();
        let base = baseline["files"][&id].as_f64();
        let path = corpus.join(f["path"].as_str().unwrap());
        let Ok(bytes) = std::fs::read(&path) else {
            if f["committed"].as_bool().unwrap_or(true) {
                failures.push(format!("{id}: missing committed file {}", path.display()));
            }
            rows.push(Row {
                id,
                producer,
                status: "missing".into(),
                accuracy: None,
                baseline: base,
            });
            continue;
        };
        let truth = std::fs::read_to_string(corpus.join(f["truth"].as_str().unwrap())).unwrap();
        let password = f["password"].as_str();
        if f["pending_decryption"].as_bool().unwrap_or(false) {
            rows.push(Row {
                id,
                producer,
                status: "pending_decryption".into(),
                accuracy: None,
                baseline: base,
            });
            continue;
        }
        // Product path: warraq-pdf loads and decrypts; the text engine reads the document in
        // place. `ACID_LOADER=lopdf` uses the stand-alone lopdf loader instead.
        let extracted = if use_lopdf {
            LopdfSource::open(&bytes, password)
                .map_err(|e| e.to_string())
                .and_then(|src| {
                    extract_all(&src, &LayoutOptions::default()).map_err(|e| e.to_string())
                })
        } else {
            warraq_pdf::Pdf::open(bytes, password)
                .map_err(|e| format!("warraq-pdf: {e}"))
                .and_then(|pdf| {
                    extract_all(
                        &DocSource::borrowed(pdf.document()),
                        &LayoutOptions::default(),
                    )
                    .map_err(|e| e.to_string())
                })
        };
        let text = match extracted {
            Ok(p) => plain_text(&p),
            Err(e) => {
                failures.push(format!("{id}: {e}"));
                rows.push(Row {
                    id,
                    producer,
                    status: "open/extract error".into(),
                    accuracy: None,
                    baseline: base,
                });
                continue;
            }
        };
        let acc = accuracy(&text, &truth);
        if verbose && acc < 1.0 {
            println!(
                "\n=== {id} ({:.2}%)\n--- extracted\n{text}\n--- truth\n{truth}",
                acc * 100.0
            );
        }
        let status = match base {
            Some(b) if acc + 1e-9 < b => {
                failures.push(format!(
                    "{id}: accuracy {:.2}% < baseline {:.2}%",
                    acc * 100.0,
                    b * 100.0
                ));
                "REGRESSION".to_string()
            }
            Some(_) => "ok".to_string(),
            None => "no baseline".to_string(),
        };
        rows.push(Row {
            id,
            producer,
            status,
            accuracy: Some(acc),
            baseline: base,
        });
    }

    println!(
        "\n{:<44} {:<24} {:>9} {:>9}  status",
        "file", "producer", "accuracy", "baseline"
    );
    println!("{}", "-".repeat(100));
    for r in &rows {
        let a = r
            .accuracy
            .map_or("-".to_string(), |a| format!("{:.2}%", a * 100.0));
        let b = r
            .baseline
            .map_or("-".to_string(), |b| format!("{:.2}%", b * 100.0));
        println!(
            "{:<44} {:<24} {:>9} {:>9}  {}",
            r.id, r.producer, a, b, r.status
        );
    }
    let measured: Vec<f64> = rows.iter().filter_map(|r| r.accuracy).collect();
    if !measured.is_empty() {
        println!(
            "{} files measured, mean accuracy {:.2}%",
            measured.len(),
            measured.iter().sum::<f64>() / measured.len() as f64 * 100.0
        );
    }

    if bless {
        let mut files = BTreeMap::new();
        for r in &rows {
            if let (Some(a), false) = (r.accuracy, r.status.starts_with("pending")) {
                // 0.2 percentage points of slack for harmless layout jitter.
                let t = ((a - 0.002).max(0.0) * 10_000.0).floor() / 10_000.0;
                files.insert(r.id.clone(), Value::from(t));
            }
        }
        let out = serde_json::json!({
            "about": "Per-file minimum normalised character accuracy for the Arabic acid gate (tests/acid). Regenerate with ACID_BLESS=1 only when a change is an intended improvement.",
            "files": files,
        });
        std::fs::write(
            &baseline_path,
            serde_json::to_string_pretty(&out).unwrap() + "\n",
        )
        .unwrap();
        println!("baseline written to {}", baseline_path.display());
        return;
    }
    assert!(
        failures.is_empty(),
        "acid gate failures:\n{}",
        failures.join("\n")
    );
}
