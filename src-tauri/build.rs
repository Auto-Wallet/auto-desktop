fn main() {
    embed_test_manifest();
    tauri_build::build()
}

/// On Windows, `cargo test` executables get no application manifest, so they
/// load the pre-v6 comctl32.dll — whose missing TaskDialogIndirect import
/// kills the process at startup with 0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND
/// (known tauri::test issue, https://github.com/orgs/tauri-apps/discussions/11179).
///
/// All tests here are LIB unit tests (`mod tests` / `mod e2e` in lib.rs), which
/// `cargo:rustc-link-arg-tests` does NOT cover (it only targets `tests/`
/// integration-test targets, and errors when none exist). So a plain
/// `rustc-link-arg` is used, gated behind AUTODESKTOP_TEST_MANIFEST so normal
/// builds are untouched — set it ONLY for `cargo test --lib` (CI does), where
/// the real bin (which gets its own manifest from tauri-build) is never linked.
fn embed_test_manifest() {
    println!("cargo:rerun-if-env-changed=AUTODESKTOP_TEST_MANIFEST");
    println!("cargo:rerun-if-changed=test-manifest.xml");
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    let enabled = std::env::var("AUTODESKTOP_TEST_MANIFEST").is_ok_and(|v| v == "1");
    if enabled && target_os == "windows" && target_env == "msvc" {
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("test-manifest.xml");
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
}
