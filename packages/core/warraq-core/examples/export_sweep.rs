//! Runs every core operation Export uses on each PDF given, natively, and
//! reports any that panic or fail: `cargo run --example export_sweep -- a.pdf b.pdf`.
use std::panic::{catch_unwind, AssertUnwindSafe};

fn main() {
    for path in std::env::args().skip(1) {
        let bytes = std::fs::read(&path).unwrap();
        let outcome = catch_unwind(AssertUnwindSafe(|| -> Result<(), String> {
            let mut doc = warraq_core::Document::open(bytes, None).map_err(|e| e.to_string())?;
            for page in 0..doc.page_count() {
                let t = std::time::Instant::now();
                doc.extract_text(page)
                    .map_err(|e| format!("extract_text {page}: {e}"))?;
                doc.text_lines(page)
                    .map_err(|e| format!("text_lines {page}: {e}"))?;
                doc.paragraphs(page)
                    .map_err(|e| format!("paragraphs {page}: {e}"))?;
                let arg = format!("{{\"page\":{page}}}");
                for op in ["export.tables", "export.lines", "links.list"] {
                    doc.call(op, &arg, vec![])
                        .map_err(|e| format!("{op} {page}: {e}"))?;
                }
                doc.call(
                    "export.picture",
                    &format!("{{\"page\":{page},\"scale\":2}}"),
                    vec![],
                )
                .map_err(|e| format!("export.picture {page}: {e}"))?;
                doc.render_page(page, 2.0)
                    .map_err(|e| format!("render {page}: {e}"))?;
                let ms = t.elapsed().as_millis();
                if ms > 3000 {
                    eprintln!("SLOW\t{path}\tpage {page}\t{ms}ms");
                }
            }
            Ok(())
        }));
        match outcome {
            Ok(Ok(())) => println!("ok\t{path}"),
            Ok(Err(e)) => println!("ERR\t{path}\t{e}"),
            Err(_) => println!("PANIC\t{path}"),
        }
    }
}
