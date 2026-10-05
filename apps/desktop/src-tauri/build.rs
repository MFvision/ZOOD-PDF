fn main() {
    link_clang_runtime();
    tauri_build::build()
}

/// llama.cpp's Metal code asks the system which macOS it is on
/// (`@available`), which compiles to a call into clang's own runtime
/// (`___isPlatformVersionAtLeast` in libclang_rt.osx.a). rustc links without
/// the C compiler's default libraries, so that runtime has to be named, or
/// the release link fails with the symbol undefined. The compiler says where
/// its runtime is.
fn link_clang_runtime() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let clang = std::env::var("CC").unwrap_or_else(|_| "clang".into());
    let Ok(out) = std::process::Command::new(clang)
        .arg("--print-runtime-dir")
        .output()
    else {
        return;
    };
    let dir = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !dir.is_empty() && std::path::Path::new(&dir).join("libclang_rt.osx.a").exists() {
        println!("cargo:rustc-link-search=native={dir}");
        println!("cargo:rustc-link-lib=static=clang_rt.osx");
    }
}
