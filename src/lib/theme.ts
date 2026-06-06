// Theme preference store — light / dark / system, persisted to localStorage and
// applied via `document.documentElement.dataset.theme`. Imported by BOTH the shell
// (App) and the separate approval window (ApprovalView) so the whole app — every
// OS window — follows one setting. Tiny external store, no dependency.

import { useSyncExternalStore } from "react";

export type ThemePref = "light" | "dark" | "system";
export type EffectiveTheme = "light" | "dark";

const KEY = "autodesktop.theme";

function initialPref(): ThemePref {
  const saved = localStorage.getItem(KEY);
  return saved === "light" || saved === "dark" || saved === "system" ? saved : "light";
}

let pref: ThemePref = initialPref();
const listeners = new Set<() => void>();

const mql =
  typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

export function effectiveTheme(): EffectiveTheme {
  if (pref === "system") return mql?.matches ? "dark" : "light";
  return pref;
}

function apply() {
  document.documentElement.dataset.theme = effectiveTheme();
}

function emit() {
  apply();
  for (const l of listeners) l();
}

// Follow the OS when on "system".
mql?.addEventListener("change", () => {
  if (pref === "system") emit();
});

// Apply the saved theme immediately on first import (before first paint).
apply();

export function setThemePref(next: ThemePref) {
  if (next === pref) return;
  pref = next;
  localStorage.setItem(KEY, next);
  emit();
}

export function useThemePref(): ThemePref {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => pref,
  );
}

/** Reactive effective ("light"|"dark") theme — re-renders on pref or OS change. */
export function useEffectiveTheme(): EffectiveTheme {
  useThemePref(); // subscribe
  return effectiveTheme();
}
