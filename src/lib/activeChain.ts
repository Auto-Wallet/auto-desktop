// The active wallet network (the chain dApps see via eth_chainId) — a single
// global, MetaMask-style, shared by the browser-bar chain selector and Settings.
// Source of truth is the Rust backend (`current_chain`); this store mirrors it and
// drives it via set_active_chain (which also pushes chainChanged to open dApps).

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { BUILTIN_CHAINS } from "./chains";
import { isTauri } from "./platform";

let chainId = BUILTIN_CHAINS[0].id; // "0x1" until the backend value loads
const listeners = new Set<() => void>();
let loadStarted = false;

function emit() {
  for (const l of listeners) l();
}

// Pull the real current chain from the backend once (in the Tauri app only).
function ensureLoaded() {
  if (loadStarted || !isTauri()) return;
  loadStarted = true;
  invoke<string>("get_active_chain")
    .then((id) => {
      if (id && id !== chainId) {
        chainId = id;
        emit();
      }
    })
    .catch((e) => console.error("[AutoDesktop] get_active_chain failed", e));
}

/** Switch the active wallet network. Updates the backend (which notifies dApps). */
export async function setActiveChain(id: string): Promise<void> {
  chainId = id;
  emit();
  if (isTauri()) {
    await invoke("set_active_chain", { chainId: id }).catch((e) =>
      console.error("[AutoDesktop] set_active_chain failed", e),
    );
  }
}

export function useActiveChain(): string {
  ensureLoaded();
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => chainId,
  );
}
