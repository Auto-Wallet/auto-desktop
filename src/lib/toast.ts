// Tiny toast store — transient confirmations (copied address, refreshed, etc.).
// External store + auto-dismiss, no dependency. Rendered by <ToastHost/> (ui.tsx).

import { useSyncExternalStore } from "react";

export type ToastKind = "ok" | "info" | "warn";
export type Toast = { id: string; msg: string; kind: ToastKind };

let toasts: Toast[] = [];
let seq = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function toast(msg: string, kind: ToastKind = "ok") {
  const id = `t${++seq}`;
  toasts = [...toasts, { id, msg, kind }];
  emit();
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    emit();
  }, 2200);
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
