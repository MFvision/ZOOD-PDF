//! Shared helpers for warraq-sign integration tests: fixture paths, the test PKI, external
//! checkers (openssl CLI, pyHanko) that are skipped when absent.
#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::path::PathBuf;

pub const PW: &str = "test123";

pub fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../..")
}

pub fn pki(name: &str) -> PathBuf {
    repo_root().join("tests/fixtures/sign/pki").join(name)
}

pub fn read_pki(name: &str) -> Vec<u8> {
    std::fs::read(pki(name)).unwrap_or_else(|e| panic!("fixture {name}: {e}"))
}

pub fn fixture(name: &str) -> PathBuf {
    repo_root().join("tests/fixtures/sign").join(name)
}

pub fn has_openssl() -> bool {
    std::process::Command::new("openssl")
        .arg("version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// A private scratch directory for one test.
pub fn scratch(test: &str) -> PathBuf {
    let d = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
        .join("warraq-sign")
        .join(test);
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}
