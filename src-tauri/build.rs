fn main() {
    embed_test_manifest();
    tauri_build::build()
}

/// On Windows, `cargo test` executables get no application manifest, so they
/// load the pre-v6 comctl32.dll — whose missing TaskDialogIndirect import
/// kills the process at startup with 0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND
/// (known tauri::test issue, https://github.com/orgs/tauri-apps/discussions/11179).
/// Embed a Common-Controls v6 manifest into TEST targets only;
/// the real binary already gets its manifest from tauri-build.
fn embed_test_manifest() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if target_os == "windows" && target_env == "msvc" {
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("test-manifest.xml");
        println!("cargo:rerun-if-changed=test-manifest.xml");
        println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg-tests=/MANIFESTINPUT:{}", manifest.display());
    }
}
