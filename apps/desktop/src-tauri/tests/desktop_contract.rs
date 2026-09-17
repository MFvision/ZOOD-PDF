//! What the desktop shell must keep in place for the UI to reach a file.
//!
//! Every item here fails silently when it drifts: the open panel does nothing
//! at all, a dropped file does nothing, a save reports success and writes
//! nothing. That is precisely how the first desktop build shipped — it could
//! not open a single PDF — so these are pinned rather than left to review.

use std::path::{Path, PathBuf};

fn manifest() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn json(relative: &str) -> serde_json::Value {
    let path: PathBuf = manifest().join(relative);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{} is not JSON: {e}", path.display()))
}

/// `packages/ui/src/core/host-tauri.ts` invokes these; without the permission
/// the invoke is rejected and the UI shows nothing.
#[test]
fn the_capability_grants_what_the_ui_invokes() {
    let capability = json("capabilities/default.json");
    let granted: Vec<&str> = capability["permissions"]
        .as_array()
        .expect("permissions array")
        .iter()
        .map(|value| value.as_str().expect("permission string"))
        .collect();

    for needed in [
        // `pickPdfFile` / `savePdfFile`.
        "dialog:allow-open",
        "dialog:allow-save",
        // `savePdfFile` writes through the fs plugin.
        "fs:allow-write-file",
        // `core:default` carries the event permissions `onNativeFileDrop` needs.
        "core:default",
    ] {
        assert!(
            granted.contains(&needed),
            "capabilities/default.json no longer grants {needed}; the UI call that needs it \
             will fail silently"
        );
    }
}

/// With native drag-and-drop on, the webview never sees a `drop` event: the
/// host catches it and re-emits `warraq://file-drop`, which the UI listens for.
/// Turning it off would silence the listener and hand drops to the webview
/// instead — a different design, and one no test here covers.
#[test]
fn the_window_keeps_native_drag_and_drop() {
    let config = json("tauri.conf.json");
    let windows = config["app"]["windows"].as_array().expect("windows array");
    let main = windows
        .iter()
        .find(|w| w["label"] == "main")
        .expect("a window labelled main");
    assert_eq!(
        main["dragDropEnabled"], true,
        "the UI listens for the host's drop event, not the DOM one"
    );
}

/// The rasterizer has to travel inside the bundle, or an installed copy
/// quietly falls back to the pure-Rust renderer.
#[test]
fn the_macos_bundle_carries_pdfium() {
    let config = json("tauri.macos.conf.json");
    let resources = config["bundle"]["resources"]
        .as_array()
        .expect("bundle resources");
    let library = "resources/pdfium/libpdfium.dylib";
    assert!(
        resources.iter().any(|r| r == library),
        "tauri.macos.conf.json must bundle {library}"
    );
    assert!(
        Path::new(&manifest().join(library)).is_file(),
        "{library} is missing from the source tree"
    );
}

/// The one that cost the most: with `custom-protocol` off, `tauri` compiles in
/// dev mode even for a release build, the bundled app navigates to
/// `build.devUrl`, and the window comes up empty on a machine with no dev
/// server. Warraq shipped exactly that — an app that opened and could do
/// nothing at all — because the feature was never declared.
#[test]
fn the_crate_declares_custom_protocol() {
    let manifest_text = std::fs::read_to_string(manifest().join("Cargo.toml")).expect("Cargo.toml");
    assert!(
        manifest_text.contains(r#"custom-protocol = ["tauri/custom-protocol"]"#),
        "the desktop crate must declare custom-protocol, or every bundled build \
         opens an empty window pointed at the dev server"
    );
    // The pairing only matters because a dev URL exists to fall back to.
    assert!(
        json("tauri.conf.json")["build"]["devUrl"].is_string(),
        "build.devUrl is what an unfeatured build would load instead of the bundle"
    );
}

/// The bundled UI must come from the build that strips the document's own
/// Content-Security-Policy; see `apps/web/src/csp.test.ts` for why.
#[test]
fn the_bundle_is_built_for_the_desktop_host() {
    let config = json("tauri.conf.json");
    for (key, script) in [
        ("beforeBuildCommand", "build:tauri"),
        ("beforeDevCommand", "dev:tauri"),
    ] {
        let command = config["build"][key].as_str().unwrap_or_default();
        assert!(
            command.ends_with(script),
            "{key} must run {script}, not the browser build: got {command:?}"
        );
    }
}
