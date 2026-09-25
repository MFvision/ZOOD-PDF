//! Guards the desktop configuration against the known traps (docs/SPEC.md §6).

use serde_json::Value;

const CARGO: &str = include_str!("../Cargo.toml");
const CONF: &str = include_str!("../tauri.conf.json");
const CAPS: &str = include_str!("../capabilities/main.json");
const PLIST: &str = include_str!("../Info.plist");

fn conf() -> Value {
    serde_json::from_str(CONF).unwrap_or(Value::Null)
}

fn s<'a>(v: &'a Value, ptr: &str) -> &'a str {
    v.pointer(ptr).and_then(Value::as_str).unwrap_or("")
}

#[test]
fn tauri_custom_protocol_feature_is_declared_and_default() {
    let cargo: toml::Table = toml::from_str(CARGO).unwrap_or_default();
    let features = cargo.get("features").and_then(|f| f.as_table());
    let list = |name: &str| -> Vec<String> {
        features
            .and_then(|f| f.get(name))
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default()
    };
    assert_eq!(
        list("custom-protocol"),
        vec!["tauri/custom-protocol".to_owned()]
    );
    assert!(list("default").contains(&"custom-protocol".to_owned()));
}

#[test]
fn names_and_identifier() {
    let c = conf();
    assert_eq!(s(&c, "/productName"), "ZOOD PDF");
    assert_eq!(s(&c, "/identifier"), "sa.zood.pdf");
    assert_eq!(s(&c, "/app/windows/0/title"), "ZOOD PDF");
    assert!(PLIST.contains("<key>CFBundleDisplayName</key>\n  <string>ZOOD PDF</string>"));
    assert!(PLIST.contains("<key>CFBundleName</key>\n  <string>ZOOD PDF</string>"));
}

#[test]
fn strict_csp() {
    let c = conf();
    let csp = s(&c, "/app/security/csp");
    let directives: Vec<&str> = csp.split(';').map(str::trim).collect();
    for d in [
        "default-src 'self'",
        "script-src 'self' 'wasm-unsafe-eval'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' blob: data:",
        "connect-src 'self' ipc: http://ipc.localhost http://localhost:11434 http://localhost:1234 https://api.anthropic.com",
        "worker-src 'self' blob:",
    ] {
        assert!(directives.contains(&d), "missing `{d}` in {csp}");
    }
    assert!(!csp.contains("unsafe-eval'") || csp.contains("wasm-unsafe-eval"));
    assert!(!csp.contains(" *") && !csp.contains("http:;") && !csp.contains("https:;"));
    // Tauri would add a nonce to style-src, which disables 'unsafe-inline' (EmbedPDF styles).
    let keep = c.pointer("/app/security/dangerousDisableAssetCspModification");
    assert_eq!(keep, Some(&serde_json::json!(["style-src"])));
}

#[test]
fn macos_title_bar_is_merged_into_the_toolbar() {
    let c = conf();
    assert_eq!(s(&c, "/app/windows/0/titleBarStyle"), "Overlay");
    assert_eq!(
        c.pointer("/app/windows/0/hiddenTitle"),
        Some(&Value::Bool(true))
    );
    assert_eq!(
        c.pointer("/app/windows/0/dragDropEnabled"),
        Some(&Value::Bool(true))
    );
}

#[test]
fn windows_bundles_nsis_only_with_arabic() {
    let c = conf();
    let targets: Vec<&str> = c
        .pointer("/bundle/targets")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    assert!(targets.contains(&"nsis"));
    assert!(
        !targets.contains(&"msi"),
        "WiX/MSI cannot write the Arabic name"
    );
    // AppImage would bundle LGPL WebKitGTK/GTK libraries into our artefact (ADR 0002/0007).
    assert!(!targets.contains(&"appimage"));
    for t in ["app", "deb"] {
        assert!(targets.contains(&t), "{t}");
    }
    let langs = c.pointer("/bundle/windows/nsis/languages");
    assert!(langs
        .and_then(Value::as_array)
        .is_some_and(|a| a.contains(&Value::from("Arabic"))));
    assert_eq!(
        c.pointer("/bundle/windows/nsis/displayLanguageSelector"),
        Some(&Value::Bool(true))
    );
}

#[test]
fn capabilities_are_minimal() {
    let caps: Value = serde_json::from_str(CAPS).unwrap_or(Value::Null);
    let perms: Vec<&str> = caps
        .pointer("/permissions")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    assert!(!perms.is_empty());
    for p in &perms {
        assert!(!p.starts_with("shell:"), "{p}");
        assert!(!p.starts_with("http:"), "{p}");
        assert!(!p.ends_with(":default"), "no blanket defaults: {p}");
        assert!(!p.contains("scope"), "no static fs scopes: {p}");
    }
    for p in [
        "dialog:allow-open",
        "dialog:allow-save",
        "fs:allow-read-file",
        "fs:allow-write-file",
    ] {
        assert!(perms.contains(&p), "{p}");
    }
    // Every permission object form (with inline scopes) is refused too.
    assert!(caps
        .pointer("/permissions")
        .and_then(Value::as_array)
        .is_some_and(|a| a.iter().all(Value::is_string)));
    let fs_perms: Vec<&&str> = perms.iter().filter(|p| p.starts_with("fs:")).collect();
    assert_eq!(fs_perms.len(), 2, "{fs_perms:?}");
    for c in zood_pdf_desktop::COMMANDS {
        let p = format!("allow-{}", c.replace('_', "-"));
        assert!(perms.contains(&p.as_str()), "{p}");
    }
}

#[test]
fn no_shell_plugin_dependency() {
    assert!(!CARGO.contains("tauri-plugin-shell"));
    assert!(!CARGO.contains("tauri-plugin-http"));
}
