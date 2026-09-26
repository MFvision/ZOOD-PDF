//! Licence gate for everything linked into the desktop binary (docs/decisions/0002-licences.md).
//! Uses `cargo tree -e normal,no-proc-macro` for the host platform: resolver-accurate, and
//! it leaves out build-dependencies and proc-macro subtrees, which run at compile time and
//! are not shipped (e.g. Tauri's build-time HTML tooling pulls MPL-2.0 `cssparser`).

use std::process::Command;

const ALLOWED: &[&str] = &[
    "MIT",
    "MIT-0",
    "Apache-2.0",
    "Apache-2.0 WITH LLVM-exception",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "ISC",
    "Zlib",
    "Unicode-3.0",
    "Unicode-DFS-2016",
    "CC0-1.0",
    "0BSD",
];

fn clean(s: &str) -> &str {
    s.trim().trim_matches(|c| c == '(' || c == ')').trim()
}

/// SPDX expression check: every AND-term needs at least one allowed OR-alternative.
fn permissive(expr: &str) -> bool {
    let expr = expr.replace('/', " OR ");
    !expr.trim().is_empty()
        && expr
            .split(" AND ")
            .all(|term| term.split(" OR ").any(|alt| ALLOWED.contains(&clean(alt))))
}

#[test]
fn spdx_parsing() {
    assert!(permissive("MIT OR Apache-2.0"));
    assert!(permissive("(MIT OR Apache-2.0) AND Unicode-3.0"));
    assert!(permissive("Apache-2.0/MIT"));
    assert!(!permissive("MPL-2.0"));
    assert!(!permissive("MIT AND LGPL-2.1-or-later"));
    assert!(!permissive("GPL-3.0"));
    assert!(!permissive(""));
}

#[test]
fn shipped_dependencies_are_permissive() {
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
    let out = Command::new(cargo)
        .args([
            "tree",
            "--offline",
            "-e",
            "normal,no-proc-macro",
            "--prefix",
            "none",
            "--format",
            "{p}|{l}",
        ])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output();
    let Ok(out) = out else {
        unreachable!("cargo tree could not run")
    };
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let text = String::from_utf8_lossy(&out.stdout);
    let mut crates = 0;
    let mut bad = Vec::new();
    for line in text.lines() {
        let line = line.trim_end_matches(" (*)");
        let Some((pkg, lic)) = line.split_once('|') else {
            continue;
        };
        crates += 1;
        if pkg.starts_with("zood-pdf-desktop ") {
            continue;
        }
        if !permissive(lic) {
            bad.push(format!("{pkg} ({lic})"));
        }
    }
    assert!(crates > 50, "tree looks wrong: {crates} lines");
    bad.sort();
    bad.dedup();
    assert!(
        bad.is_empty(),
        "non-permissive crates linked into the app:\n{}",
        bad.join("\n")
    );
}

#[test]
fn mpl_option_ext_is_patched_out() {
    let lock = include_str!("../Cargo.lock");
    let entry = lock
        .split("[[package]]")
        .find(|p| p.contains("name = \"option-ext\""))
        .unwrap_or("");
    assert!(!entry.is_empty());
    assert!(
        !entry.contains("source ="),
        "option-ext must come from vendor/option-ext:\n{entry}"
    );
}
