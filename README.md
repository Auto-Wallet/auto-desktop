# AutoDesktop

A super-lightweight, **RabbyDesktop-style native desktop wallet + dApp browser**, built on **Tauri 2 + React + TypeScript**. It embeds remote dApp pages in native child webviews and injects an EIP-1193 wallet provider (`window.ethereum`) into them — like a browser-extension wallet, but a native app with a small installer.

AutoDesktop is the desktop counterpart to the **Auto Wallet** browser extension.

> **Product north star & the 6 core features:** [VISION.md](VISION.md)
> **How to work in this repo (architecture, security boundary, conventions):** [CLAUDE.md](CLAUDE.md)

## Related Code

AutoDesktop owns its wallet core in this repo:

| Path | Role |
| --- | --- |
| `src/wallet-core` | EIP-1193/6963 provider, platform adapter interfaces, and portable wallet-facing TypeScript. |
| `src` | Trusted React shell UI plus the dApp injection entry. |
| `src-tauri` | Tauri backend, native/window/webview concerns, key custody, signing, and RPC forwarding. |

The existing Chrome MV3 browser-extension wallet (`../auto-wallet`) is maintained separately and does not consume this core.

## Quick start

Use **bun** (not npm) for everything.

```bash
bun install                 # install deps
bun run tauri dev           # run the app (builds the injected provider + vite + cargo)
bun run tauri build         # production bundle (.app / .dmg)

bun run build:injected      # rebuild the injected provider IIFE (required after editing src/injected/* or src/wallet-core/*)
bunx tsc --noEmit           # typecheck the frontend

cd src-tauri && cargo test           # Rust unit tests + offline in-process E2E (deterministic, no network)
cd src-tauri && cargo test -- --ignored   # LIVE E2E: forwards to real public RPC nodes (network)
cd src-tauri && cargo check          # fast Rust typecheck
```

If the dev server is killed, a stray `vite` may hold port 1420 — free it with `lsof -ti tcp:1420 | xargs kill -9`.

## What's built

- **Encrypted HD key vault** — BIP-39 mnemonic + manual BIP-32/BIP-44 derivation on pure-Rust k256; sealed at rest with Argon2id (64 MiB) + AES-256-GCM. Private keys live only in Rust, only while unlocked, and never cross into any webview.
- **Onboarding** — first-run chooser: create a new HD wallet, import (recovery phrase **or** a single raw private key), or connect a Ledger (placeholder — see below). Unlock screen with a checkbox-gated "forgot password → reset wallet" escape hatch.
- **Signing + approval flow** — `personal_sign`, `eth_sendTransaction` (EIP-1559 type-2), and `eth_signTypedData_v4` (EIP-712). Each signing request suspends and opens a **separate top-level approval window**; the backend signs only after the user approves there. dApps can never self-approve.
- **Multi-webview dApp browser** — a container window with a trusted local `shell` webview (the React UI) and per-tab remote `dapp-*` webviews rendered on top, with an injected provider.
- **Read-only RPC forwarding** — non-signing JSON-RPC is proxied to the selected chain's public node.
- **Network management** — built-in chains (Ethereum, Base, OP, Arbitrum, Polygon) plus user-added custom chains and editable RPC/params, persisted to disk.
- **i18n** — English / 中文.

### Pending

- **Ledger** (hardware wallet) — v1 requirement. WKWebView has no WebHID, so this needs a Rust `hidapi` transport behind `HidTransport`. Presented in onboarding as an honest placeholder until wired.
- **Multi-wallet** — currently a single vault; importing a private key is the *first* wallet, not multiple independent secrets coexisting.
- Custom ERC-20 tokens on the Wallet page, collapsible sidebar / editable URL bar.

See the project memory roadmap for live per-slice progress.

## Architecture

### Multi-webview model

There is **no window defined in `tauri.conf.json`** — `src-tauri/src/lib.rs` `run()`/`setup()` builds a container `Window`, a local **`shell`** child webview (the React UI, full window, underneath), and remote **`dapp-*`** child webviews positioned in the content rect. Native child webviews render *on top of* the shell in their rectangle — which is why the sidebar/topbar stay visible and why approval UI must be a separate window, not an in-shell modal. Multi-webview requires the Cargo `unstable` feature.

### Wallet bridge & security boundary

```
dApp page → injected window.ethereum → invoke('wallet_request', {method, params})
          → Rust wallet_request command → handle_rpc() (single backend entry)
          → route: Wallet (local state) | Signing (key + user approval) | Forward (read-only RPC)
```

The boundary is enforced by Tauri's ACL across three capability files:

- `capabilities/default.json` — scoped to the **`shell`** webview only; grants the trusted UI its commands (incl. the vault commands).
- `capabilities/dapp.json` — scoped to **`dapp-*`** webviews + `remote.urls`; grants **only** `allow-wallet-request`. That one command is the entire attack surface exposed to untrusted dApps. Never add `core:*`/`fs:*`/`shell:*` here.
- `capabilities/approval.json` — scoped to the dedicated **`approval`** window; grants the approve/reject/list commands so a page can never self-approve.

The caller origin is derived from the engine-set `webview.url()`, never from a JS param.

### Injection pipeline

`src/injected/inpage.tauri.ts` (a Tauri `invoke`-based `ProviderTransport` calling `src/wallet-core`'s `installProvider`) → bundled to a self-contained IIFE by `scripts/build-injected.ts` → written to `src-tauri/injected/inpage.js` → embedded in Rust via `include_str!` → set as each dapp webview's `initialization_script`. Because `include_str!` is compile-time, editing `src/injected/*` or `src/wallet-core/*` requires `bun run build:injected` **and** a Rust rebuild (`tauri dev` does this on startup, but not on mid-session file changes).

## Project layout

```
src/                    React shell (trusted UI)
  pages/                WalletPage, DappsPage, BrowserView, SettingsPage, LockScreen, ApprovalView
  lib/                  vault, chains, accounts, activeChain, useBalances, rpc, i18n, dapps, platform…
  injected/             inpage.tauri.ts — the provider transport bundled into dApp pages
  wallet-core/          EIP-1193/6963 provider and wallet adapter interfaces
src-tauri/src/          Rust backend
  lib.rs                window/webview setup, wallet bridge, vault + chain commands, in-process E2E
  vault.rs              BIP-39/32/44 derivation + Argon2id/AES-GCM keystore (pure crypto core)
  eth_tx.rs             EIP-1559 transaction RLP encoding + signing
  eip712.rs             EIP-712 typed-data hashing + signing
src-tauri/capabilities/ ACL capability files (default / dapp / approval)
src-tauri/permissions/  app-command permission definitions
scripts/                build-injected + CDP/native verification harnesses
```

## Testing

`tauri-driver`/WebdriverIO (the official UI-E2E path) **does not work on macOS** — Apple ships no WKWebView WebDriver. So the wallet bridge is E2E-tested **in-process** with `tauri::test`'s mock runtime (`mod e2e` in `lib.rs`), which drives the real `invoke('wallet_request') → command → handle_rpc` pipeline — including the `dapp.json` ACL grant and trustworthy-origin derivation — without a GUI. Offline tests run by default; the live network-forward test is `#[ignore]`d (run with `cargo test -- --ignored`).

The frontend onboarding/Settings flows are verified visually via a Chrome CDP harness against the vite dev server (`scripts/*-test.ts`), and natively via macOS `screencapture` (`scripts/native-shot.sh`).

## Platform constraints (macOS / WKWebView)

- **No WebHID/WebUSB** → Ledger/hardware support must go through a Rust `hidapi` transport behind `HidTransport`.
- **Custom URI schemes are one-way from remote pages** — WebKit blocks `fetch()` to a registered scheme, so the wallet bridge uses `invoke`, not a custom scheme.
