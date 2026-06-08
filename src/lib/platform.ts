// Platform bridge for the embedded dApp browser (VISION feature ③).
//
// Each open dApp tab is its own NATIVE child webview (Rust-side, with
// window.ethereum injected), labeled `dapp-<id>`, that the shell positions over
// the `.browser-content` rect via these commands. In the plain browser dev-preview
// there is no native webview, so isTauri() is false and BrowserView falls back to
// an <iframe>.

import { invoke } from "@tauri-apps/api/core";

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export type Rect = { x: number; y: number; w: number; h: number };

/** Webview label for a tab. Must match the `dapp-<id>` shape the Rust label
 *  guard enforces (capabilities/dapp.json scopes `dapp-*`). */
export function dappLabel(tabId: string): string {
  return `dapp-${tabId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

/** Create-or-show the tab webview over `rect`. Navigates to `url` only on first
 *  creation, so switching back to a tab preserves its page. */
export function openDapp(
  label: string,
  url: string,
  rect: Rect,
): Promise<void> {
  return invoke("open_dapp", { label, url, ...rect });
}

/** Track the content rect across window/layout resizes. */
export function setDappBounds(label: string, rect: Rect): Promise<void> {
  return invoke("set_dapp_bounds", { label, ...rect });
}

/** Hide a tab webview (switch to another tab / Wallet / dApps). */
export function hideDapp(label: string): Promise<void> {
  return invoke("hide_dapp", { label });
}

/** Close (destroy) a tab webview when its tab is closed. */
export function closeDapp(label: string): Promise<void> {
  return invoke("close_dapp", { label });
}

export async function openExternalUrl(url: string): Promise<void> {
  if (!isTauri()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  await invoke("open_external_url", { url });
}

/** Viewport-relative rect of an element = its position within the window, since
 *  the trusted shell webview fills the window at (0,0). */
export function rectOf(el: HTMLElement): Rect {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}
