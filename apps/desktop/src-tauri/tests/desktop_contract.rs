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

fn repo_file(relative: &str) -> String {
    let path = manifest().join("../../..").join(relative);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()))
}

/// On macOS the toolbar is the title bar: the window draws no title of its
/// own, the content runs under the title bar, and the traffic lights sit in
/// the toolbar's strip — inside the room the UI leaves for them
/// (`--traffic-lights` in styles/tokens.css).
#[test]
fn the_window_merges_its_title_bar_with_the_toolbar() {
    let config = json("tauri.conf.json");
    let main = config["app"]["windows"]
        .as_array()
        .expect("windows array")
        .iter()
        .find(|w| w["label"] == "main")
        .expect("a window labelled main")
        .clone();
    assert_eq!(
        main["titleBarStyle"], "Overlay",
        "the content must run under the title bar"
    );
    assert_eq!(
        main["hiddenTitle"], true,
        "the toolbar shows the document's title, not the window"
    );

    let x = main["trafficLightPosition"]["x"]
        .as_f64()
        .expect("trafficLightPosition.x");
    let y = main["trafficLightPosition"]["y"]
        .as_f64()
        .expect("trafficLightPosition.y");
    let tokens = repo_file("packages/ui/src/styles/tokens.css");
    let px = |name: &str| -> f64 {
        let line = tokens
            .lines()
            .find(|line| line.trim_start().starts_with(&format!("{name}:")))
            .unwrap_or_else(|| panic!("tokens.css defines {name}"));
        line.split(':')
            .nth(1)
            .unwrap()
            .trim()
            .trim_end_matches(';')
            .trim_end_matches("px")
            .parse()
            .unwrap()
    };
    // Three 14-pt buttons 20 pt apart: the last ends 54 pt after the first starts.
    assert!(
        x + 54.0 + 8.0 <= px("--traffic-lights"),
        "the toolbar leaves {} pt for traffic lights that end at {} pt",
        px("--traffic-lights"),
        x + 54.0
    );
    // Centred in the toolbar: a 14-pt button whose top is y points down.
    let toolbar = px("--toolbar-h");
    assert!(
        ((y + 7.0) - toolbar / 2.0).abs() <= 1.0,
        "the traffic lights ({y}) are not centred in the {toolbar}-pt toolbar"
    );
}

/// The toolbar drags the window — everywhere but on a control — and a double
/// click on it zooms the window, which is Tauri's drag region with the
/// permission to start a drag.
#[test]
fn the_toolbar_drags_the_window() {
    let capability = json("capabilities/default.json");
    let granted: Vec<&str> = capability["permissions"]
        .as_array()
        .expect("permissions array")
        .iter()
        .filter_map(|value| value.as_str())
        .collect();
    assert!(
        granted.contains(&"core:window:allow-start-dragging"),
        "without it a press on the toolbar moves nothing"
    );
    let toolbar = repo_file("packages/ui/src/shell/Toolbar.tsx");
    assert!(
        toolbar.contains(r#"data-tauri-drag-region="deep""#),
        "the toolbar must be a deep drag region (its controls still take clicks)"
    );
}

/// The menu bar is built from the UI's model and sends its items back: the
/// command is registered, menu events are forwarded, and both sides use the
/// same event name.
#[test]
fn the_menu_bar_reaches_the_ui() {
    let lib = std::fs::read_to_string(manifest().join("src/lib.rs")).expect("lib.rs");
    assert!(
        lib.contains("menu::set_menu"),
        "the UI's set_menu command is not registered"
    );
    assert!(
        lib.contains("on_menu_event"),
        "menu events are not forwarded to the page"
    );
    assert!(
        lib.contains(".manage(menu::MenuState"),
        "set_menu needs its state"
    );
    let host = repo_file("packages/ui/src/core/host-tauri.ts");
    assert!(
        host.contains(&format!(
            "MENU_EVENT = '{}'",
            warraq_desktop_lib::menu::MENU_EVENT
        )),
        "host-tauri.ts listens for a different menu event than menu.rs sends"
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

/// The app is ZOOD PDF in every build (محرر زود PDF in the Arabic interface).
/// Windows builds make only the NSIS installer, which is Unicode throughout.
#[test]
fn the_product_name_is_zood_pdf() {
    let config = json("tauri.conf.json");
    assert_eq!(config["productName"], "ZOOD PDF");
    assert_eq!(config["mainBinaryName"], "warraq-desktop");
    assert_eq!(config["app"]["windows"][0]["title"], "ZOOD PDF");
    let windows = json("tauri.windows.conf.json");
    assert_eq!(windows["bundle"]["targets"], serde_json::json!(["nsis"]));
}

/// The Library reaches folders through this host and nowhere else: every
/// command `packages/ui/src/core/host-tauri.ts` invokes for it has to be
/// registered, or the panel's promise rejects with "command not found" and the
/// person sees an empty list with no reason — exactly the silent failure the
/// rest of this file exists to stop.
#[test]
fn the_library_commands_the_panel_invokes_are_registered() {
    let lib = std::fs::read_to_string(manifest().join("src/lib.rs")).expect("lib.rs");
    let host = repo_file("packages/ui/src/core/host-tauri.ts");
    for command in [
        "library_scan_start",
        "library_scan_stop",
        "library_read_file",
        "library_stat",
        "library_index_path",
        "library_index_save",
        "library_index_load",
        "library_index_list",
        "library_index_delete",
        "library_watch_start",
        "library_watch_stop",
    ] {
        assert!(
            lib.contains(&format!("library::{command}")),
            "{command} is not registered in the invoke handler"
        );
        assert!(
            host.contains(&format!("'{command}'")),
            "host-tauri.ts no longer invokes {command}; the Rust side would be dead code"
        );
    }
    // The folder picker is the dialog plugin's, with `recursive` — which is
    // what puts everything under the chosen folder in the fs scope, and so
    // what lets the walk and the reads see it at all.
    assert!(
        host.contains("multiple: true, directory: true, recursive: true"),
        "pickLibraryFolders must ask for directories recursively, or nothing under them is readable"
    );
}

/// Both sides have to name the same events, or the progress and the watcher
/// are silent while the walk runs perfectly well.
#[test]
fn the_library_events_carry_the_same_names_on_both_sides() {
    let host = repo_file("packages/ui/src/core/host-tauri.ts");
    for (name, event) in [
        (
            "LIBRARY_SCAN_EVENT",
            warraq_desktop_lib::library::LIBRARY_SCAN_EVENT,
        ),
        (
            "LIBRARY_WATCH_EVENT",
            warraq_desktop_lib::library::LIBRARY_WATCH_EVENT,
        ),
    ] {
        assert!(
            host.contains(&format!("{name} = '{event}'")),
            "host-tauri.ts listens for a different {name} than library.rs sends"
        );
    }
}

/// The index is the person's own documents' text. It goes where their data
/// goes — the app's data directory — and never into a temporary folder the
/// system sweeps, or anywhere the page could name.
#[test]
fn the_index_is_written_where_the_persons_data_lives() {
    let library = std::fs::read_to_string(manifest().join("src/library.rs")).expect("library.rs");
    assert!(
        library.contains("app_data_dir()"),
        "the index must live in the app's own data directory"
    );
    assert!(
        !library.contains("temp_dir()")
            || library
                .split("mod tests")
                .next()
                .is_some_and(|before| !before.contains("temp_dir()")),
        "nothing outside the tests may put the index in a temporary folder"
    );
}

/// The recent list opens a file again only through these commands; a missing
/// one makes the home screen fall back, silently, to asking for the file.
#[test]
fn the_recent_commands_the_home_screen_invokes_are_registered() {
    let lib = std::fs::read_to_string(manifest().join("src/lib.rs")).expect("lib.rs");
    let host = repo_file("packages/ui/src/core/host-tauri.ts");
    for command in ["recent_remember", "recent_path", "recent_forget"] {
        assert!(
            lib.contains(&format!("recent::{command}")),
            "{command} is not registered in the invoke handler"
        );
        assert!(
            host.contains(&format!("'{command}'")),
            "host-tauri.ts no longer invokes {command}; the Rust side would be dead code"
        );
    }
    assert!(
        host.contains(&format!(
            "OPEN_FILE_EVENT = '{}'",
            warraq_desktop_lib::OPEN_FILE_EVENT
        )),
        "host-tauri.ts listens for a different OPEN_FILE_EVENT than lib.rs sends: a PDF \
         double-clicked while the app runs would bring the window forward and open nothing"
    );
}

/// Windows: a .pdf is associated with the app, under the file class whose
/// icon the installer hook replaces with the document icon it installs.
#[test]
fn windows_gives_pdf_files_the_document_icon() {
    let windows = json("tauri.windows.conf.json");
    let bundle = &windows["bundle"];
    let association = &bundle["fileAssociations"][0];
    assert_eq!(association["ext"], serde_json::json!(["pdf"]));
    let class = association["name"].as_str().expect("file class name");

    // The Windows file replaces the resources list as a whole: PDFium's
    // notices must stay in it beside the icon.
    let resources: Vec<&str> = bundle["resources"]
        .as_array()
        .expect("resources")
        .iter()
        .filter_map(|r| r.as_str())
        .collect();
    for needed in [
        "resources/pdfium/LICENSE",
        "resources/windows/pdf-document.ico",
    ] {
        assert!(
            resources.contains(&needed),
            "tauri.windows.conf.json no longer bundles {needed}"
        );
    }
    assert!(manifest()
        .join("resources/windows/pdf-document.ico")
        .is_file());

    let hooks_path = bundle["windows"]["nsis"]["installerHooks"]
        .as_str()
        .expect("installerHooks");
    let hooks = std::fs::read_to_string(manifest().join(hooks_path)).expect("hooks.nsh");
    assert!(
        hooks.contains(&format!(
            "Software\\Classes\\{class}\\DefaultIcon\" \"\" \"$INSTDIR\\resources\\windows\\pdf-document.ico\""
        )),
        "the installer hook must set {class}'s icon to the installed document icon"
    );
}

/// Updates (docs/updates.md): the apps read the stable channel only, never the
/// test builds' releases, and install only what the project's key signed. The
/// update files are made by the release workflow alone, so a test build never
/// needs the private key.
#[test]
fn updates_come_signed_from_the_stable_channel() {
    let config = json("tauri.conf.json");
    let updater = &config["plugins"]["updater"];
    assert_eq!(
        updater["endpoints"],
        serde_json::json!([
            "https://github.com/MFvision/ZOOD-PDF/releases/download/updates-stable/latest.json"
        ]),
        "the updater must read the stable channel, which only the release workflow changes"
    );
    assert!(
        updater["pubkey"]
            .as_str()
            .is_some_and(|key| key.len() > 100),
        "the updater has no public key: it would refuse every update"
    );
    assert!(
        config["bundle"]["createUpdaterArtifacts"].is_null(),
        "update files belong to desktop-release.yml; here every test build would need the key"
    );

    let lib = std::fs::read_to_string(manifest().join("src/lib.rs")).expect("lib.rs");
    let ui = repo_file("packages/ui/src/updates/updates.ts");
    for command in ["update_check", "update_install"] {
        assert!(
            lib.contains(&format!("updates::{command}")),
            "{command} is not registered in the invoke handler"
        );
        assert!(
            ui.contains(&format!("'{command}'")),
            "updates.ts no longer invokes {command}"
        );
    }
    assert!(
        ui.contains(&format!(
            "'{}'",
            warraq_desktop_lib::updates::PROGRESS_EVENT
        )),
        "updates.ts listens for a different progress event than updates.rs sends"
    );
    let workflow = repo_file(".github/workflows/desktop-release.yml");
    for platform in ["windows-x86_64", "darwin-aarch64"] {
        assert!(
            workflow.contains(platform),
            "desktop-release.yml no longer writes the {platform} update"
        );
    }
}
