use std::path::Path;

/// `tauri::generate_context!` embeds `frontendDist` at compile time, so `cargo test` needs
/// *something* there. When the UI has not been built (e.g. a fresh checkout running only
/// the Rust tests) a one-line page that says so is written. `tauri build` / the smoke test
/// always run `pnpm build:ui` first, which replaces it with the real interface.
fn ensure_frontend_dist() {
    let dist = Path::new("../dist");
    if dist.join("index.html").exists() {
        return;
    }
    let page = "<!doctype html><meta charset=utf-8><title>ZOOD PDF</title>\
<p>UI not built. Run <code>pnpm -C apps/desktop build</code> and rebuild.</p>";
    if std::fs::create_dir_all(dist).is_ok()
        && std::fs::write(dist.join("index.html"), page).is_ok()
    {
        println!("cargo:warning=apps/desktop/dist was missing; wrote a placeholder page (build the UI first for a real app)");
    }
}

fn main() {
    ensure_frontend_dist();
    // Declaring the app's commands makes each one require an explicit permission in
    // capabilities/main.json (nothing is allowed implicitly). Keep in sync with lib.rs COMMANDS.
    let manifest = tauri_build::AppManifest::new().commands(&[
        "host_info",
        "app_ready",
        "set_locale",
        "set_menu",
        "print_pdf",
        "suggest_save_path",
        "print_open",
        "print_page",
        "print_close",
    ]);
    if let Err(e) = tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest)) {
        println!("cargo:warning=tauri-build failed: {e:#}");
        std::process::exit(1);
    }
}
