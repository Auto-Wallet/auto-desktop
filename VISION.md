# AutoDesktop — Product Vision

> The north star. CLAUDE.md says *how* to work in this repo; this says *what* we're building and *why*.
> Read this before planning features — without it, work drifts backend-deep and the visible product stalls.

## North star (one line)

**A super-lightweight, RabbyDesktop-style desktop wallet + dApp browser** — native, small installer, minimal/streamlined features. Named **AutoDesktop**, the desktop counterpart to the **Auto Wallet** browser extension.

## Why

RabbyDesktop is no longer maintained and its codebase is too heavy. We want the same *experience* — browse DeFi dApps in a native window with a wallet attached — but **超轻量级 (ultra-lightweight)、安装包很小 (small installer)、功能非常精简 (minimal features)**.

## Non-negotiable principles

- **超轻量 / 安装包小 / 功能精简** — every dependency and feature is weighed against installer size and simplicity. When in doubt, leave it out.
- **Native, not Electron** — Tauri 2 + system WebView.
- **Security boundary is sacred** — untrusted dApp webviews get only the wallet bridge; keys never enter any webview (see CLAUDE.md). 
- **Share logic via the SDK** — portable wallet logic lives in `auto-wallet-core` so both wallets benefit; Tauri-specific glue stays here.
- **v1 must include Ledger** (via a Rust `hidapi` transport, since WKWebView has no WebHID).

## The 6 core features (the product)

1. **总体布局**：~1280×720 可调窗口、左侧可伸缩侧边栏。首页 **Wallet**：展示钱包在各链的资产，支持多链查看、添加自定义 Token、方便地切换不同钱包地址。
2. **dApps 页**：自由添加各种 DeFi 应用，每个一张小卡片（logo + 名字，名字可自动获取也可手动改）。**必须支持搜索和置顶。**
3. **内嵌 dApp 浏览器**：点开应用就打开网页，像 RabbyDesktop —— 侧栏显示网页标签页，上方显示网址 / 当前钱包 / 当前链，下方是网页内容。
4. **复用 auto-wallet**：内嵌/复用已有的 auto-wallet 钱包逻辑（通过 SDK）。
5. **网页内连接钱包、发交易**。
6. **Settings**（侧栏左下角）：管理 Chains、语言、关于、检查更新等。

## "Done" for v1

A user can: open the app → see their multi-chain balances → add/search/pin dApps → open a dApp in the embedded browser → connect the wallet and send a transaction → switch address/chain → manage chains in Settings. Small installer. Ledger works.

## Reality check — snapshot 2026-06-06 (point-in-time; the durable goal is above)

The hard technical risks are retired (multi-webview, provider injection, scoped IPC bridge, read-only RPC forwarding, trustworthy origin, a real signing/approval flow, an on-macOS E2E harness). But the **visible product is still thin**: the shell is a static mock, only one hard-coded dApp loads, and features ①②③⑥ are essentially unbuilt. Backend is ahead of the product. Next priority is making the product *visible and usable* by wiring the working backend into the real UI — not digging the backend deeper.

(Live build status / per-slice progress lives in the project memory roadmap, not here.)
