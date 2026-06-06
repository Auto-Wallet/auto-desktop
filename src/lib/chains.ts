// Chain registry — now backend-owned (VISION ⑥: manage Chains). The Rust side
// (src-tauri/src/lib.rs `chains_state`) is the source of truth: built-in chains
// plus any user-added networks / RPC overrides, persisted to chains.json. This
// store mirrors it for the UI and exposes add/edit/remove. In the browser preview
// (no Tauri) it falls back to the in-memory built-ins.

import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import { isTauri } from "./platform";

export type Chain = {
  /** EIP-155 chain id as a 0x-hex string (what dApps see via eth_chainId). */
  id: string;
  name: string;
  /** Native gas-token symbol shown in the Wallet page. */
  symbol: string;
  rpc: string;
  /** Native token decimals (usually 18). */
  decimals: number;
  /** Brand color for the chain dot/badge. */
  color: string;
  /** Built-in chains can be edited (rpc/name/symbol) but not removed. */
  builtin: boolean;
};

export const BUILTIN_CHAINS: Chain[] = [
  { id: "0x1",    name: "Ethereum",     symbol: "ETH", rpc: "https://ethereum-rpc.publicnode.com",    decimals: 18, color: "#627EEA", builtin: true },
  { id: "0x2105", name: "Base",         symbol: "ETH", rpc: "https://base-rpc.publicnode.com",        decimals: 18, color: "#0052FF", builtin: true },
  { id: "0xa",    name: "OP Mainnet",   symbol: "ETH", rpc: "https://optimism-rpc.publicnode.com",    decimals: 18, color: "#FF0420", builtin: true },
  { id: "0xa4b1", name: "Arbitrum One", symbol: "ETH", rpc: "https://arbitrum-one-rpc.publicnode.com", decimals: 18, color: "#28A0F0", builtin: true },
  { id: "0x89",   name: "Polygon",      symbol: "POL", rpc: "https://polygon-bor-rpc.publicnode.com", decimals: 18, color: "#8247E5", builtin: true },
];

let chains: Chain[] = BUILTIN_CHAINS;
const listeners = new Set<() => void>();
function emit() {
  for (const l of listeners) l();
}
function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useChains(): Chain[] {
  return useSyncExternalStore(subscribe, () => chains);
}

/** Non-reactive read of the current chain list. */
export function getChains(): Chain[] {
  return chains;
}

export function findChain(id: string): Chain | undefined {
  const want = id.toLowerCase();
  return chains.find((c) => c.id.toLowerCase() === want);
}

/** Load the effective chain registry from the backend (or fall back to built-ins). */
export async function loadChains(): Promise<void> {
  if (!isTauri()) {
    chains = BUILTIN_CHAINS;
    emit();
    return;
  }
  chains = await invoke<Chain[]>("get_chains");
  emit();
}

export async function addChain(chain: Omit<Chain, "builtin">): Promise<void> {
  const next: Chain = { ...chain, builtin: false };
  if (!isTauri()) {
    chains = [...chains, next];
    emit();
    return;
  }
  chains = await invoke<Chain[]>("add_chain", { chain: next });
  emit();
}

export async function updateChain(chain: Chain): Promise<void> {
  if (!isTauri()) {
    chains = chains.map((c) => (c.id.toLowerCase() === chain.id.toLowerCase() ? { ...chain } : c));
    emit();
    return;
  }
  chains = await invoke<Chain[]>("update_chain", { chain });
  emit();
}

export async function removeChain(id: string): Promise<void> {
  if (!isTauri()) {
    chains = chains.filter((c) => c.id.toLowerCase() !== id.toLowerCase());
    emit();
    return;
  }
  chains = await invoke<Chain[]>("remove_chain", { id });
  emit();
}
