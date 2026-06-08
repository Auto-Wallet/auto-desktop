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
  gas?: string;
  nonce?: string;
  maxPriorityFeePerGas?: string;
  maxFeePerGas?: string;
  origin: string;
  kind: "send" | "contract" | "token_send" | "speedup" | "cancel";
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
  status?: "submitted" | "confirmed" | "failed" | "replaced" | string | null;
  timestamp: number;
};

let activity: ActivityRecord[] = [];
let listenerBound = false;
const listeners = new Set<() => void>();

function statusRank(status: ActivityRecord["status"]): number {
  switch (status) {
    case "confirmed":
    case "failed":
      return 3;
    case "replaced":
      return 2;
    case "submitted":
    default:
      return 1;
  }
}

function mergeActivity(next: ActivityRecord[]): ActivityRecord[] {
  if (activity.length === 0) return next;
  const currentById = new Map(activity.map((record) => [record.id, record]));
  return next.map((incoming) => {
    const current = currentById.get(incoming.id);
    if (!current) return incoming;
    if (statusRank(current.status) > statusRank(incoming.status)) {
      return { ...incoming, status: current.status };
    }
    return incoming;
  });
}

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
  activity = mergeActivity(await invoke<ActivityRecord[]>("get_activity"));
  emit();
  if (!listenerBound) {
    listenerBound = true;
    void listen("activity-changed", () => void loadActivity());
  }
}

export async function syncActivityReceipts(): Promise<void> {
  if (!isTauri()) return;
  try {
    activity = mergeActivity(await invoke<ActivityRecord[]>("sync_activity_receipts"));
    emit();
    return;
  } catch (e) {
    console.warn("[AutoDesktop] backend receipt sync unavailable, falling back to node_rpc", e);
  }

  let changed = false;
  const next = await Promise.all(
    activity.map(async (record) => {
      if ((record.status ?? "submitted") !== "submitted") return record;
      try {
        const receipt = await invoke<Record<string, unknown> | null>("node_rpc", {
          chainId: record.chainId,
          method: "eth_getTransactionReceipt",
          params: [record.hash],
        });
        if (!receipt) return record;
        const status = receipt.status === "0x1" ? "confirmed" : "failed";
        if (record.status === status) return record;
        changed = true;
        return { ...record, status };
      } catch (err) {
        console.warn("[AutoDesktop] receipt fallback failed", record.hash, err);
        return record;
      }
    }),
  );
  if (changed) {
    activity = next;
    emit();
  }
}

export async function replaceActivityTransaction(
  activityId: string,
  action: "speedup" | "cancel",
  maxFeePerGas: string,
  maxPriorityFeePerGas: string,
): Promise<string> {
  if (!isTauri()) return "0x" + "be".repeat(32);
  return invoke<string>("replace_activity_transaction", {
    activityId,
    action,
    maxFeePerGas,
    maxPriorityFeePerGas,
  });
}
