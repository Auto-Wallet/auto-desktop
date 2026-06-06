// Accounts store — the address switcher behind VISION feature ① ("方便地切换不同
// 钱包地址"). Two sources, merged:
//   * SIGNER accounts — the HD accounts held by the encrypted vault (Rust-side).
//     These come from the vault store; the backend can actually sign with them.
//   * WATCH-only accounts — arbitrary addresses the user adds to view balances,
//     persisted to localStorage. The backend never signs for these.
//
// The active address is tracked locally; selecting a signer account also tells the
// backend to switch its active signing account (and pushes accountsChanged to dApps).

import { useSyncExternalStore } from "react";
import { isAddress } from "./format";
import { getVaultAccounts, selectVaultAccount, useVault } from "./vault";

export type Account = {
  address: string;
  label: string;
  /** true = the vault holds this key and can sign; false = watch-only. */
  signer: boolean;
};

type Watch = { address: string; label: string };

const WATCH_KEY = "autodesktop.watchAccounts";
const ACTIVE_KEY = "autodesktop.activeAddress";

function loadWatch(): Watch[] {
  const raw = localStorage.getItem(WATCH_KEY);
  return raw ? (JSON.parse(raw) as Watch[]) : [];
}

let watch: Watch[] = loadWatch();
let activeAddress: string | null = localStorage.getItem(ACTIVE_KEY);

const listeners = new Set<() => void>();
function emit() {
  for (const l of listeners) l();
}
function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function signerAccounts(vaultAddrs: string[]): Account[] {
  return vaultAddrs.map((address, i) => ({ address, label: `Account ${i + 1}`, signer: true }));
}
function watchAccounts(): Account[] {
  return watch.map((w) => ({ address: w.address, label: w.label, signer: false }));
}

/** The active account; falls back to the vault's active signer when no local
 *  selection (or a stale one) is set. */
export function useActiveAccount(): Account {
  const vault = useVault();
  const active = useSyncExternalStore(subscribe, () => activeAddress);
  const all = [...signerAccounts(vault.accounts), ...watchAccounts()];
  const byVault = all.find((a) => a.address.toLowerCase() === (vault.address ?? "").toLowerCase());
  const fallback = byVault ??
    all[0] ?? { address: vault.address ?? "0x", label: "Account 1", signer: true };
  if (!active) return fallback;
  return all.find((a) => a.address.toLowerCase() === active.toLowerCase()) ?? fallback;
}

export function useAccounts(): Account[] {
  const vault = useVault();
  useSyncExternalStore(subscribe, () => watch); // re-render on watch changes
  return [...signerAccounts(vault.accounts), ...watchAccounts()];
}

/** Switch the active account. If it's a vault signer account, also switch the
 *  backend's active signing account (so signing + dApps follow the selection). */
export function setActive(address: string) {
  activeAddress = address;
  localStorage.setItem(ACTIVE_KEY, address);
  emit();

  const idx = getVaultAccounts().findIndex((a) => a.toLowerCase() === address.toLowerCase());
  if (idx >= 0) void selectVaultAccount(idx);
}

/** Add a watch-only address; throws on a malformed address (no silent skip). */
export function addWatchAccount(address: string, label?: string) {
  const addr = address.trim();
  if (!isAddress(addr)) throw new Error(`Not a valid address: ${address}`);
  const lower = addr.toLowerCase();
  const existing = [...getVaultAccounts(), ...watch.map((w) => w.address)].find(
    (a) => a.toLowerCase() === lower,
  );
  if (existing) {
    setActive(existing);
    return;
  }
  watch = [...watch, { address: addr, label: label?.trim() || `Watch ${watch.length + 1}` }];
  localStorage.setItem(WATCH_KEY, JSON.stringify(watch));
  emit();
  setActive(addr);
}
