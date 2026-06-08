import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";
import { isTauri } from "./platform";

export type ActivityRecord = {
  id: string;
  hash: string;
  chainId: string;
  chainName: string;
  symbol: string;
  from: string;
  to: string;
  value: string;
  data: string;
  origin: string;
  kind: "send" | "contract" | "token_send";
  counterparty?: string | null;
  assetSymbol?: string | null;
  assetDecimals?: number | null;
  amount?: string | null;
  tokenAddress?: string | null;
  balanceChanges?: {
    symbol: string;
    formattedDelta: string;
    direction: "in" | "out" | string;
  }[];
  status?: "submitted" | "confirmed" | "failed" | string | null;
  timestamp: number;
};

let activity: ActivityRecord[] = [];
let listenerBound = false;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useActivity(): ActivityRecord[] {
  return useSyncExternalStore(subscribe, () => activity);
}

export async function loadActivity(): Promise<void> {
  if (!isTauri()) {
    activity = [];
    emit();
    return;
  }
  activity = await invoke<ActivityRecord[]>("get_activity");
  emit();
  if (!listenerBound) {
    listenerBound = true;
    void listen("activity-changed", () => void loadActivity());
  }
}
