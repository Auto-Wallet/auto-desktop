# AutoDesktop — Product Vision

> The north star. CLAUDE.md says *how* to work in this repo; this says *what* we're building and *why*.
> Read this before planning features — without it, work drifts backend-deep and the visible product stalls.

## North star (one line)

**A super-lightweight, RabbyDesktop-style desktop wallet + dApp browser** — native, small installer, minimal/streamlined features. Named **AutoDesktop**, the desktop counterpart to the **Auto Wallet** browser extension.

## Why

RabbyDesktop is no longer maintained and its codebase is too heavy. We want the same *experience* — browse DeFi dApps in a native window with a wallet attached — but **ultra-lightweight, with a small installer and a minimal, streamlined feature set**.

## Non-negotiable principles

- **Ultra-lightweight / small installer / minimal features** — every dependency and feature is weighed against installer size and simplicity. When in doubt, leave it out.
- **Native, not Electron** — Tauri 2 + system WebView.
- **The security boundary is sacred** — untrusted dApp webviews get only the wallet bridge; keys never enter any webview (see CLAUDE.md).
- **Share logic via the SDK** — portable wallet logic lives in `auto-wallet-core` so both wallets benefit; Tauri-specific glue stays here.
- **v1 must include Ledger** (via a Rust `hidapi` transport, since WKWebView has no WebHID).

## The 6 core features (the product)

1. **Overall layout** — a ~1280×720 resizable window with a collapsible left sidebar. The home page is **Wallet**: shows the wallet's assets across chains, supports multi-chain viewing, adding custom tokens, and conveniently switching between wallet addresses.
2. **dApps page** — freely add DeFi apps, each shown as a small card (logo + name; the name can be fetched automatically or edited by hand). **Must support search and pinning.**
3. **Embedded dApp browser** — opening an app loads its web page, RabbyDesktop-style: the sidebar lists page tabs, the top bar shows the URL / current wallet / current chain, and the page content fills the area below.
4. **Reuse auto-wallet** — embed/reuse the existing auto-wallet wallet logic (via the SDK).
5. **Connect the wallet and send transactions from within web pages.**
6. **Settings** (bottom-left of the sidebar) — manage Chains, language, about, check for updates, and so on.

## "Done" for v1

A user can: open the app → see their multi-chain balances → add/search/pin dApps → open a dApp in the embedded browser → connect the wallet and send a transaction → switch address/chain → manage chains in Settings. Small installer. Ledger works.

## Reality check — snapshot 2026-06-06 (point-in-time; the durable goal is above)

The hard technical risks are retired (multi-webview, provider injection, scoped IPC bridge, read-only RPC forwarding, trustworthy origin, a real signing/approval flow, an on-macOS E2E harness). Since the previous snapshot the product has also caught up substantially on the visible side:

- **Real key ownership shipped** — an encrypted HD key vault (BIP-39/32/44 + Argon2id + AES-256-GCM), a first-run onboarding chooser (create / import recovery phrase or raw private key / connect Ledger), unlock, and a checkbox-gated "forgot password → reset" escape hatch.
- **Feature ⑤ done** — connect + sign from web pages: `personal_sign`, `eth_sendTransaction` (EIP-1559), and `eth_signTypedData_v4` (EIP-712), each gated by the separate approval window.
- **Ledger done (hardware-verified)** — the v1 non-negotiable. A Rust `hidapi` transport speaks the Ledger Ethereum-app APDUs directly (no WebHID, no `@ledgerhq` JS); a Ledger account needs no password and signs on the device. Connecting and an on-device `eth_sendTransaction` were confirmed end-to-end on a real device.
- **Feature ② mostly done** — the dApps page has cards, search, pin, and manual add.
- **Feature ③ working** — the embedded browser loads real dApps with live RPC forwarding (URL bar is read-only / not yet editable).
- **Feature ⑥ mostly done** — Settings has full network management (built-in + custom chains, editable RPC/params, persisted), language, about, and a Tauri updater-backed manual check/install flow.
- **Feature ① partly done** — the Wallet page shows multi-chain balances and switches addresses; **custom tokens** and the **collapsible sidebar** are not built yet.

**Biggest remaining gaps for v1:** **custom ERC-20 tokens** on the Wallet page, the **collapsible sidebar / editable URL bar**, and **multi-wallet** (multiple independent secrets coexisting — today it's a single vault). Keep weighing every addition against the small-installer / minimal-features principle.

(Live build status / per-slice progress lives in the project memory roadmap, not here.)
