// Tiny toast store — transient confirmations (copied address, refreshed, etc.).
// External store + auto-dismiss, no dependency. Rendered by <ToastHost/> (ui.tsx).

import { useSyncExternalStore } from "react";
import { motionMs } from "./transitions";

export type ToastKind = "ok" | "info" | "warn";
export type ToastAction = {
  label?: string;
  url?: string;
  onClick: () => void;
};
export type Toast = {
  id: string;
  msg: string;
  kind: ToastKind;
  action?: ToastAction;
  card?: boolean;
  /** Set for the length of the close animation, just before removal. */
  leaving?: boolean;
};
export type ToastOptions = {
  card?: boolean;
  durationMs?: number;
};

let toasts: Toast[] = [];
let seq = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function toast(
  msg: string,
  kind: ToastKind = "ok",
  action?: ToastAction,
  options?: ToastOptions,
) {
  const id = `t${++seq}`;
  toasts = [...toasts, { id, msg, kind, action, card: options?.card }];
  emit();
  // Flag the toast as leaving first so <ToastHost/> can play the close
  // transition, then drop it once that transition has finished.
  setTimeout(() => {
    toasts = toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t));
    emit();
    setTimeout(() => {
      toasts = toasts.filter((t) => t.id !== id);
      emit();
    }, motionMs("--toast-close", 250));
  }, options?.durationMs ?? 2200);
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => toasts,
  );
}
