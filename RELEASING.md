# Releasing

Builds are produced by **`.github/workflows/release.yml`**, triggered when a `v*`
tag is pushed. Each release publishes standalone clients with OS/arch in the name:

| OS      | Asset                                  | Notes                                   |
| ------- | -------------------------------------- | --------------------------------------- |
| macOS   | `AutoDesktop_<ver>_macos_aarch64.dmg`  | Apple Silicon, signed + notarized       |
| macOS   | `AutoDesktop_<ver>_macos_x64.dmg`      | Intel, signed + notarized               |
| Windows | `AutoDesktop_<ver>_windows_x64.zip`    | Standalone `.exe` (WebView2 from system)|

## Cut a release

1. **Bump the version** in `package.json`, `src-tauri/Cargo.toml`, and
   `src-tauri/tauri.conf.json` (keep all three in sync).
2. Commit, then tag and push:
   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```
3. The workflow builds all three OSes in parallel and creates the GitHub Release
   with auto-generated notes.

## Required GitHub secrets (macOS signing/notarization)

`APPLE_CERTIFICATE` (base64 of the Developer ID Application `.p12`),
`APPLE_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_PASSWORD` (app-specific
password), `APPLE_TEAM_ID`. The signing identity is derived from the imported
certificate at build time, so no `APPLE_SIGNING_IDENTITY` secret is needed.
