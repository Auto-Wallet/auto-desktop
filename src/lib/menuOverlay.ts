// Native dropdown-menu overlay (Tauri only). Native dApp child webviews render
// ON TOP of the shell, so the browser top-bar dropdowns (account / chain
// switcher) can't be plain in-shell DOM — the page would cover them. While a
// menu is open the shell instead shows a transparent FULL-WINDOW local child
// webview (`menu-overlay`, index.html?view=menu-overlay) stacked above the dApp
// webview and renders the menu there (MenuOverlayView.tsx). State flows
// shell → overlay over a BroadcastChannel (+ localStorage for the overlay's
// cold start, same trick as the toast overlay); clicks flow back
// overlay → shell as actions, and ALL state changes happen shell-side — the
// overlay webview itself invokes nothing.

import { useEffect, useRef } from "react";
import { isTauri, syncMenuOverlay } from "./platform";

export const MENU_OVERLAY_CHANNEL = "autodesktop-menu-overlay";
export const MENU_OVERLAY_KEY = "autodesktop.menuOverlayPayload";

/** Menu placement in window coordinates — the overlay covers the whole window,
 *  so window coords are overlay coords. */
export type MenuAnchor = { top: number; right: number };

export type MenuOverlayPayload =
  | {
      kind: "account";
      anchor: MenuAnchor;
      accounts: { address: string; label: string }[];
      activeAddress: string;
      copyTitle: string;
    }
  | {
      kind: "chain";
      anchor: MenuAnchor;
      chains: { id: string; name: string; symbol: string; color: string }[];
      activeChainId: string;
    }
  | {
      kind: "dialog";
      id: string;
      dialogKind: "alert" | "confirm" | "prompt" | "print";
      origin: string;
      message: string;
      defaultValue?: string | null;
      labels: {
        title: string;
        ok: string;
        cancel: string;
        promptPlaceholder: string;
      };
    };

export type MenuOverlayAction =
  | { type: "dismiss" }
  | { type: "select-account"; address: string }
  | { type: "copy-address"; address: string }
  | { type: "select-chain"; id: string }
  | { type: "resolve-dapp-dialog"; id: string; action: "ok" | "cancel"; value?: string | null };

/** Mirrors the in-shell `.chain-menu` placement: 8px below the chip,
 *  right-aligned to it. */
export function menuAnchorFor(chip: HTMLElement): MenuAnchor {
  const r = chip.getBoundingClientRect();
  return { top: r.bottom + 8, right: Math.max(window.innerWidth - r.right, 0) };
}

/** Shell side: while `payload` is non-null, show the native overlay with it and
 *  apply the actions the overlay posts back. Pass null when the menu is closed. */
export function useMenuOverlay(
  payload: MenuOverlayPayload | null,
  onAction: (action: MenuOverlayAction) => void,
) {
  const actionRef = useRef(onAction);
  actionRef.current = onAction;

  // Keyed on the serialized payload (it is also what goes over the wire), so a
  // re-render that rebuilds an identical payload object doesn't tear the
  // overlay down and flash it back up.
  const json = payload ? JSON.stringify(payload) : null;
  const open = json !== null;

  // Visibility + action channel — keyed on `open` ONLY. A payload CONTENT
  // change while the menu is open (e.g. selecting a chain flips activeChainId
  // in the same tick that closes the menu) must NOT tear the overlay down and
  // re-show it: the async hide/show invokes could complete out of order and
  // strand the transparent full-window overlay on top of the app, eating every
  // click (the "switch network freezes the wallet" bug).
  useEffect(() => {
    if (!isTauri() || !open) return;

    const channel = new BroadcastChannel(MENU_OVERLAY_CHANNEL);
    channel.onmessage = (event) => {
      const action = event.data?.action as MenuOverlayAction | undefined;
      if (action) actionRef.current(action);
    };

    void syncMenuOverlay({ x: 0, y: 0, w: window.innerWidth, h: window.innerHeight }).catch(
      () => undefined,
    );

    // The overlay rect would go stale on resize — just dismiss, like blur.
    const dismiss = () => actionRef.current({ type: "dismiss" });
    window.addEventListener("resize", dismiss);

    return () => {
      window.removeEventListener("resize", dismiss);
      // Clear the overlay's rendered menu before hiding so the next open can't
      // flash the previous items while the fresh state is in flight.
      channel.postMessage({ state: null });
      channel.close();
      localStorage.removeItem(MENU_OVERLAY_KEY);
      void syncMenuOverlay(null).catch(() => undefined);
    };
  }, [open]);

  // Menu content — posted to the overlay over the channel whenever it changes;
  // no native show/hide involved.
  useEffect(() => {
    if (!isTauri() || !json) return;

    const channel = new BroadcastChannel(MENU_OVERLAY_CHANNEL);
    localStorage.setItem(MENU_OVERLAY_KEY, json);
    const post = () => channel.postMessage({ state: JSON.parse(json) });
    post();
    // The overlay webview is created lazily on first open and may still be
    // booting when the first message fires; localStorage + this retry cover it.
    const retry = window.setTimeout(post, 80);

    return () => {
      window.clearTimeout(retry);
      channel.close();
    };
  }, [json]);
}
