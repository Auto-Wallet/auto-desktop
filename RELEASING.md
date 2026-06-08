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
2. **Bump the SDK submodule** if `auto-wallet-core` changed (see below).
3. Commit, then tag and push:
   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```
4. The workflow builds all three OSes in parallel and creates the GitHub Release
   with auto-generated notes.

## The `auto-wallet-core` submodule

The shared SDK is consumed as a git **submodule** (`auto-wallet-core/`, repo
`Auto-Wallet/auto-wallet-core`) so CI can fetch it — the runner has no access to
the local sibling checkout used in dev. CI installs it via `bun link` + `bun install`.

The submodule is **pinned to a commit**. Local dev still uses your sibling
`../auto-wallet-core` via the global `bun link`; the submodule only matters for CI.
So before tagging, if the SDK changed, push it and advance the pointer:

```bash
# 1) push SDK changes from your working copy
git -C ../auto-wallet-core add -A && git -C ../auto-wallet-core commit -m "..."
git -C ../auto-wallet-core push

# 2) advance the submodule pointer in this repo, then commit
git submodule update --remote auto-wallet-core
git add auto-wallet-core && git commit -m "Bump auto-wallet-core"
```

Otherwise the release builds from the **old** pinned SDK commit.

## Required GitHub secrets (macOS signing/notarization)

`APPLE_CERTIFICATE` (base64 of the Developer ID Application `.p12`),
`APPLE_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_PASSWORD` (app-specific
password), `APPLE_TEAM_ID`. The signing identity is derived from the imported
certificate at build time, so no `APPLE_SIGNING_IDENTITY` secret is needed.
