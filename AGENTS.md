# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

> **Product goal & the 6 core features live in [VISION.md](VISION.md).** Read it before planning features — without the north star, work drifts backend-deep and the visible product (Wallet / dApps / Settings pages) stalls. This file is *how* to work in the repo; VISION.md is *what* we're building and *why*.

## What this is

**AutoDesktop** — a lightweight, RabbyDesktop-style desktop wallet & dApp browser built on **Tauri 2 + React + TypeScript**. It embeds remote dApp web pages and injects an EIP-1193 wallet provider (`window.ethereum`) into them, like a browser-extension wallet but native.

It is one of three sibling packages (kept as separate directories/repos, linked via `bun link`):

- `../auto-wallet-core` — **shared, platform-agnostic SDK** (EIP-1193/6963 provider, platform adapter interfaces, and—over time—the ported wallet logic). Source of truth for both wallets.
- `../auto-wallet` — the existing Chrome MV3 **browser-extension** wallet. AutoDesktop reuses its logic via the SDK; it will migrate onto the SDK later.
- this repo (`auto-desktop`) — the Tauri desktop app: implements the **Tauri-side** adapters and all native/window/webview concerns.

Use **bun** (not npm) for everything.

## Commands

```bash
bun install                 # install deps (also relinks the SDK if package.json says link:auto-wallet-core)
bun run tauri dev           # run the app (beforeDevCommand runs build:injected + vite, then cargo builds)
bun run tauri build         # production bundle (.app/.dmg)

bun run build:injected      # rebuild the injected provider IIFE (see "Injection pipeline" — REQUIRED after editing src/injected/* or the SDK provider)
bunx tsc --noEmit           # typecheck the frontend (incl. the injection entry + SDK imports)

cd src-tauri && cargo test  # Rust unit tests + offline E2E (deterministic, no network)
cd src-tauri && cargo test -- --ignored   # LIVE E2E: forwards to real public RPC nodes (network)
cd src-tauri && cargo check # fast Rust typecheck

cd ../auto-wallet-core && bun run typecheck   # typecheck the SDK
```

When the dev server is killed, a stray `vite` may keep port 1420 held; free it with `lsof -ti tcp:1420 | xargs kill -9` before re-running.

### Testing strategy (E2E)
`tauri-driver` / WebdriverIO (the official UI-E2E path) **does not work on macOS** — Apple ships no
WKWebView WebDriver. So the wallet bridge is E2E-tested in-process with **`tauri::test`'s mock runtime**
(see `mod e2e` in `lib.rs`), which drives the *real* `invoke('wallet_request') → command → handle_rpc`
pipeline — including the **`dapp.json` ACL grant** (the mock webview is built as the `dapp` webview on a
remote URL) and the trustworthy-origin derivation — without a GUI. Notes:
- The `test` feature is enabled via `[dev-dependencies] tauri = { features = ["test"] }`.
- Commands taking a webview must be **generic over the runtime** (`webview: tauri::Webview<R>`), or
  `generate_handler!` can't build them for `MockRuntime`.
- `generate_context!` defines a one-per-crate `_EMBED_INFO_PLIST` static — expand it at exactly one call
  site. Both `run()` and the tests share the single generic `build_context::<R>()`.
- `e2e_pipeline_offline` runs by default; the live-network forward test is `#[ignore]`d (run with `--ignored`).
- For full UI-level E2E later, the macOS route is a community plugin (`tauri-plugin-webdriver` / CrabNebula
  `tauri-plugin-automation`) embedded in the app — not adopted yet.

## Architecture

### Multi-webview dApp browser (the core model)
There is **no window defined in `tauri.conf.json`** (`app.windows: []`). `src-tauri/src/lib.rs` `run()` builds everything in `setup()`:

- a container **`Window`** (`tauri::window::WindowBuilder`), then
- a **`shell`** child webview (local, trusted) loading the React UI, full window, underneath, and
- a **`dapp`** child webview (remote, untrusted) loading the dApp URL, positioned in the content rect — native child webviews render **on top of** the shell in their rectangle (this is why the sidebar/topbar stay visible and why approval UI must be a separate window, not an in-shell modal).

Multi-webview (`Window::add_child`) requires the Cargo feature `tauri = { features = ["unstable"] }`.

### Wallet bridge & security boundary (read before touching capabilities)
dApp page → injected `window.ethereum` → `invoke('wallet_request', {method, params})` → Rust `wallet_request` command → `handle_rpc()` (the single backend entry). `handle_rpc` routes each method one of three ways (`route_method`): **Wallet** (answered from local state — accounts, selected chain), **Signing** (needs the key + user approval), **Forward** (read-only, proxied to the selected chain's public RPC node).

The security model is enforced by Tauri's ACL across three capability files:
- `src-tauri/capabilities/default.json` — scoped to `webviews: ["shell"]` only. Grants `core:default` etc. to the trusted UI. **Do not scope it to `windows:["main"]`** — that would cover the dapp webview too.
- `src-tauri/capabilities/dapp.json` — scoped to `webviews: ["dapp"]` + `remote.urls`. Grants **only** `allow-wallet-request` and nothing else. That one command is the entire attack surface exposed to untrusted dApps. **Never add `core:*` / `fs:*` / `shell:*` here.**
- `src-tauri/capabilities/approval.json` — scoped to `webviews: ["approval"]` (local). Grants the approve/reject/list commands to the **dedicated approval window only**. The dapp webview is deliberately NOT granted these, so a page can never self-approve its own signing request. **Never grant these to `dapp`.**

Non-obvious ACL facts (verified): app commands work from local webviews with no permission, but a **remote** webview calling a bare app command fails with `"... not allowed. Plugin not found"`. The fix is a permission `.toml` (e.g. `permissions/wallet-request.toml`, `permissions/approval.toml`) defining the bare `allow-*` id — tauri-build does **not** auto-generate app-command permissions — and listing it in the capability. (Local capabilities also require the caller's IPC URL to be `local`; remote ones match against `remote.urls`.)

**Trustworthy origin (done):** `wallet_request` takes `webview: tauri::Webview<R>` and derives the caller origin from `webview.url()` (engine-set), never from a JS param. Commands taking a webview must be **generic over the runtime** or `generate_handler!` can't build them for the test `MockRuntime`.

**Signing/approval flow:** a Signing method suspends in `request_approval` (a per-request `tokio::oneshot` + a 300s timeout) and opens a **separate top-level approval window** (`index.html?view=approval` → `ApprovalView.tsx`) — separate because the dapp webview renders on top of the shell, so an in-shell modal can't cover it. The window's `approve_request`/`reject_request` resolve the channel; approve → the backend signs (Rust-side key, never in any webview), reject → EIP-1193 `4001`. ⚠️ The active key is currently the **publicly-known Anvil #0 dev key** (`DEV_PRIVKEY_HEX`, labeled in `lib.rs`) — the encrypted password-unlocked vault is the next slice. Only `personal_sign` is wired so far; other signing methods reject up-front.

### Injection pipeline (how the provider gets into dApp pages)
`src/injected/inpage.tauri.ts` (defines the Tauri `invoke`-based `ProviderTransport`, calls the SDK's `installProvider`) → bundled to a self-contained IIFE by `scripts/build-injected.ts` (`Bun.build`, `format: iife`) → written to `src-tauri/injected/inpage.js` → embedded in Rust via `include_str!` → set as the dapp webview's `initialization_script`.

**`include_str!` is compile-time**, so editing `src/injected/*` or the SDK provider requires `bun run build:injected` **and** a Rust rebuild. `bun run tauri dev` does this automatically on startup (beforeDevCommand), but Tauri's file watcher will **not** rebuild the bundle mid-session.

### SDK relationship
`auto-wallet-core` exports raw TS source (no build step in dev; consumers bundle it). It is consumed two ways here: type-only by the React shell, and bundled into the injected IIFE by `bun build`. Platform differences live behind adapter interfaces in `auto-wallet-core/src/adapters/` — `ProviderTransport`, `StorageAdapter`, `ConfirmAdapter`, `HidTransport`. AutoDesktop supplies the Tauri implementations; keep portable logic in the SDK, Tauri-specific glue here.

## Platform constraints (macOS / WKWebView)
- **No WebHID/WebUSB** in WKWebView → Ledger/hardware support must go through a Rust `hidapi` transport behind `HidTransport`, not `@ledgerhq/hw-transport-webhid`.
- **Custom URI schemes are one-way from remote pages**: a remote https page can hit a registered scheme via subresource load (`new Image().src=...`) but `fetch()` to it is blocked by WebKit. The wallet bridge therefore uses `invoke`, not the `adipc://` scheme (which remains only as a diagnostic beacon endpoint in `lib.rs`).
