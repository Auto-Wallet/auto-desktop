// In-app replacement for window.confirm().
//
// Why this exists: wry's WKUIDelegate
// (wry/src/wkwebview/class/wry_web_view_ui_delegate.rs) implements only the
// file-upload, media-permission and new-window callbacks. It never implements
// runJavaScriptAlertPanel / runJavaScriptConfirmPanel / runJavaScriptTextInputPanel,
// and WKWebView has no built-in dialog UI of its own — so a webview calling
// confirm() gets an immediate `false` with nothing drawn on screen, and every
// `if (confirm(...))` branch is dead code. (lib.rs already routes the dApp
// webview's dialogs around this; the shell needs the same treatment.)
//
// The host lives in lib/ui.tsx as <ConfirmHost/>.

import { useSyncExternalStore } from "react";

export type ConfirmRequest = {
  id: number;
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger: boolean;
};

type Pending = { req: ConfirmRequest; resolve: (ok: boolean) => void };

let queue: Pending[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function subscribeConfirm(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The request currently on screen, or null. */
export function getConfirm(): ConfirmRequest | null {
  return queue.length > 0 ? queue[0].req : null;
}

export function useConfirm(): ConfirmRequest | null {
  return useSyncExternalStore(subscribeConfirm, getConfirm, getConfirm);
}

/**
 * Ask the user to confirm. Resolves true if they accept, false if they cancel.
 * Concurrent asks queue up in order rather than replacing each other, so a
 * second prompt can never silently swallow the first one's answer.
 */
export function askConfirm(opts: {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    queue = [
      ...queue,
      {
        req: {
          id: nextId++,
          title: opts.title,
          message: opts.message,
          confirmLabel: opts.confirmLabel,
          cancelLabel: opts.cancelLabel,
          danger: opts.danger ?? false,
        },
        resolve,
      },
    ];
    emit();
  });
}

/** Answer the request with this id. A stale id is ignored. */
export function resolveConfirm(id: number, ok: boolean): void {
  const hit = queue.find((p) => p.req.id === id);
  if (!hit) return;
  queue = queue.filter((p) => p.req.id !== id);
  emit();
  hit.resolve(ok);
}
