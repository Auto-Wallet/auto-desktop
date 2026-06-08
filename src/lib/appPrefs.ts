import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import { isTauri } from "./platform";

export type CloseBehavior = "hide" | "quit";

const DEFAULT_CLOSE_BEHAVIOR: CloseBehavior =
  typeof navigator !== "undefined" && /Mac/i.test(navigator.platform) ? "hide" : "quit";

let closeBehavior: CloseBehavior = DEFAULT_CLOSE_BEHAVIOR;
let loadStarted = false;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function ensureLoaded() {
  if (loadStarted || !isTauri()) return;
  loadStarted = true;
  invoke<CloseBehavior>("get_close_behavior")
    .then((next) => {
      if (next === "hide" || next === "quit") {
        closeBehavior = next;
        emit();
      }
    })
    .catch((e) => console.error("[AutoDesktop] get_close_behavior failed", e));
}

export async function setCloseBehavior(next: CloseBehavior): Promise<void> {
  closeBehavior = next;
  emit();
  if (isTauri()) {
    closeBehavior = await invoke<CloseBehavior>("set_close_behavior", { closeBehavior: next });
    emit();
  }
}

export function useCloseBehavior(): CloseBehavior {
  ensureLoaded();
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => closeBehavior,
  );
}
