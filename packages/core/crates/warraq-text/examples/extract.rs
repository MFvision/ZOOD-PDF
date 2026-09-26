//! Print the logical-order text of a PDF: `cargo run -p warraq-text --example extract -- file.pdf [password] [--json]`

use std::process::ExitCode;

use warraq_text::{extract_all, plain_text, LayoutOptions, LopdfSource};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let json = args.iter().any(|a| a == "--json");
    let pos: Vec<&String> = args.iter().filter(|a| !a.starts_with("--")).collect();
    let Some(path) = pos.first() else {
        eprintln!("usage: extract file.pdf [password] [--json]");
        return ExitCode::from(2);
    };
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("{path}: {e}");
            return ExitCode::from(1);
        }
    };
    let src = match LopdfSource::open(&bytes, pos.get(1).map(|s| s.as_str())) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("{path}: {e}");
            return ExitCode::from(1);
        }
    };
    match extract_all(&src, &LayoutOptions::default()) {
        Ok(pages) => {
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&pages).unwrap_or_default()
                );
            } else {
                println!("{}", plain_text(&pages));
            }
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("{path}: {e}");
            ExitCode::from(1)
        }
    }
}
