# WebDriver E2E (experimental, Windows-only)

UI-level E2E through [tauri-driver](https://tauri.app/develop/tests/webdriver/),
the official Tauri WebDriver path. It supports **Windows and Linux only** —
there is no WKWebView WebDriver on macOS — which makes it a natural fit for
this repo: macOS is covered by daily manual testing, and this suite covers the
platform the developer can't easily run.

## Status

Scaffold. Runs as the `e2e-windows-experimental` job in `.github/workflows/ci.yml`:
manual trigger (workflow_dispatch) and `continue-on-error: true` until the
multi-webview window-handle behavior under msedgedriver is confirmed stable.
The blocking Windows coverage lives in the `smoke-windows` job instead
(`scripts/smoke-ci.ts` + `src-tauri/src/smoke.rs`).

## Running (on a Windows machine)

```powershell
cargo install tauri-driver --locked
bun run tauri build --debug --no-bundle   # from the repo root
cd e2e\wdio
bun install
$env:EDGEWEBDRIVER = "C:\path\to\dir-containing-msedgedriver"  # version must match WebView2
bun run wdio run wdio.conf.js
```

GitHub Windows runners preinstall msedgedriver and export `EDGEWEBDRIVER`.

## Known unknowns

- How msedgedriver enumerates the shell vs. `dapp-*` child webviews as window
  handles (the spec scans all handles rather than assuming an order).
- Whether `tauri:options.application` launching interferes with the updater
  plugin's startup check on runners without network restrictions.
