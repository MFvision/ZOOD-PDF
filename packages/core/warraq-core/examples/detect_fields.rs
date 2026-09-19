//! Prints what Prepare form's detection proposes for a PDF, and, given the
//! labelled set, how well it finds the fields a person marked.
//!
//!   cargo run -p warraq-core --example detect_fields -- file.pdf
//!   cargo run -p warraq-core --example detect_fields -- --eval <repo>
//!
//! `--eval` reads `tests/fixtures/forms/truth.json` and prints precision,
//! recall, and how often the type and the name are right, per file and in
//! total — the numbers `docs/STATUS.md` reports.
use warraq_core::tools::forms_eval::{evaluate, Totals};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--eval") {
        let repo = args.get(1).map(String::as_str).unwrap_or(".");
        let (rows, totals): (Vec<_>, Totals) = evaluate(repo);
        println!(
            "{:<48} {:>5} {:>5} {:>5} {:>6} {:>6} {:>6} {:>6}",
            "file", "truth", "found", "match", "prec", "recall", "type", "name"
        );
        for r in &rows {
            println!(
                "{:<48} {:>5} {:>5} {:>5} {:>6.2} {:>6.2} {:>6.2} {:>6.2}",
                r.file,
                r.truth,
                r.found,
                r.matched,
                r.precision(),
                r.recall(),
                r.type_rate(),
                r.name_rate()
            );
            for miss in &r.misses {
                println!("    missed: {miss}");
            }
            for extra in &r.extras {
                println!("    extra:  {extra}");
            }
            for wrong in &r.wrong {
                println!("    wrong:  {wrong}");
            }
        }
        for t in &totals.1 {
            println!(
                "{:<48} {:>5} {:>5} {:>5} {:>6.2} {:>6.2} {:>6.2} {:>6.2}",
                t.file,
                t.truth,
                t.found,
                t.matched,
                t.precision(),
                t.recall(),
                t.type_rate(),
                t.name_rate()
            );
        }
        let t = &totals.0;
        println!(
            "{:<48} {:>5} {:>5} {:>5} {:>6.2} {:>6.2} {:>6.2} {:>6.2}",
            "TOTAL",
            t.truth,
            t.found,
            t.matched,
            t.precision(),
            t.recall(),
            t.type_rate(),
            t.name_rate()
        );
        return;
    }
    for path in args {
        let bytes = std::fs::read(&path).expect("read the file");
        let doc = warraq_core::Document::open(bytes, None).expect("open the file");
        for (page, found) in doc.detect_fields(&[]).expect("detect") {
            println!("{path} page {}", page + 1);
            for p in found {
                println!(
                    "  {:<10} {:<8} {:<30} [{:.0} {:.0} {:.0} {:.0}] rtl={} {:?}",
                    p.kind,
                    p.source,
                    p.name,
                    p.rect[0],
                    p.rect[1],
                    p.rect[2],
                    p.rect[3],
                    p.rtl,
                    p.tooltip
                );
            }
        }
    }
}
