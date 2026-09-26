//! Shared helpers for warraq-sign integration tests: fixture paths, the test PKI, external
//! checkers (openssl CLI, pyHanko) that are skipped when absent.
#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::path::{Path, PathBuf};
use std::process::Command;

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

/// Answer a timestamp request with the test TSA.
pub fn tsa_reply(dir: &Path, req: &[u8]) -> Vec<u8> {
    std::fs::write(dir.join("req.tsq"), req).unwrap();
    std::fs::copy(pki("tsa.cnf"), dir.join("tsa.cnf")).unwrap();
    if !dir.join("tsaserial").exists() {
        std::fs::write(dir.join("tsaserial"), "01\n").unwrap();
    }
    let out = Command::new("openssl")
        .current_dir(dir)
        .args([
            "ts",
            "-reply",
            "-config",
            "tsa.cnf",
            "-queryfile",
            "req.tsq",
            "-out",
            "resp.tsr",
        ])
        .arg("-inkey")
        .arg(pki("tsa.key"))
        .arg("-signer")
        .arg(pki("tsa.pem"))
        .arg("-chain")
        .arg(pki("root.pem"))
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    std::fs::read(dir.join("resp.tsr")).unwrap()
}

/// Answer an OCSP request with the test responder (delegated OCSPSigning certificate).
pub fn ocsp_reply(dir: &Path, req: &[u8]) -> Vec<u8> {
    std::fs::write(dir.join("ocsp.req"), req).unwrap();
    let out = Command::new("openssl")
        .args(["ocsp", "-ndays", "3650"])
        .arg("-index")
        .arg(pki("int/index.txt"))
        .arg("-CA")
        .arg(pki("int.pem"))
        .arg("-rsigner")
        .arg(pki("ocsp.pem"))
        .arg("-rkey")
        .arg(pki("ocsp.key"))
        .arg("-reqin")
        .arg(dir.join("ocsp.req"))
        .arg("-respout")
        .arg(dir.join("ocsp.resp"))
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    std::fs::read(dir.join("ocsp.resp")).unwrap()
}

/// The python interpreter with pyHanko, if any (`WARRAQ_PYTHON` or `python3`).
pub fn pyhanko_python() -> Option<String> {
    let py = std::env::var("WARRAQ_PYTHON").unwrap_or_else(|_| "python3".into());
    let ok = Command::new(&py)
        .args(["-c", "import pyhanko, pyhanko_certvalidator"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    ok.then_some(py)
}

/// Run tests/fixtures/sign/pyhanko_check.py on `pdf`; one JSON value per signature.
pub fn pyhanko_check(py: &str, pdf: &Path, password: Option<&str>) -> Vec<serde_json::Value> {
    let mut cmd = Command::new(py);
    cmd.arg(fixture("pyhanko_check.py"))
        .arg(pki("root.pem"))
        .arg(pdf);
    if let Some(p) = password {
        cmd.arg(p);
    }
    let out = cmd.output().unwrap();
    assert!(
        out.status.success(),
        "pyhanko: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}
