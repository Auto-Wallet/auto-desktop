// Vault store — the front of the encrypted HD key vault (VISION ④⑤ + the wallet's
// real key ownership). A tiny external store over the Rust vault commands
// (create/import/unlock/lock/select/add). Private keys live ONLY in Rust; this
// layer sees addresses + the one-time mnemonic on the backup screen, never a key.
//
// In the plain browser dev-preview there is no Tauri backend, so the actions run
// against an in-memory DEMO vault (the publicly-known Anvil accounts) so the
// lock/setup/backup UI is fully browseable for screenshot testing.

import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import { isTauri } from "./platform";

export type VaultPhase = "loading" | "absent" | "locked" | "unlocked";

export type VaultState = {
  phase: VaultPhase;
  /** Active address when unlocked, or the stored address (for display) when locked. */
  address: string | null;
  /** All unlocked account addresses (empty when locked). */
  accounts: string[];
  /** Index of the active account within `accounts`. */
  active: number;
};

type RustStatus = {
  exists: boolean;
  unlocked: boolean;
  address: string | null;
  accounts: string[];
  active: number;
};
type NewVault = { address: string; mnemonic: string };

// Publicly-known Anvil/Hardhat dev addresses — used ONLY for the no-backend
// browser preview. NOT secrets.
const DEMO_ADDRESSES = [
  "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
  "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
  "0x90f79bf6eb2c4f870365e785982e1f101e93b906",
  "0x15d34aaf54267db7d7c367839aaf71a00a2c6a65",
];
const DEMO_MNEMONIC = "test test test test test test test test test test test junk";

let state: VaultState = { phase: "loading", address: null, accounts: [], active: 0 };
let demoCreated = false;

const listeners = new Set<() => void>();
function set(patch: Partial<VaultState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}
function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useVault(): VaultState {
  return useSyncExternalStore(subscribe, () => state);
}

/** Non-hook read of the current unlocked account addresses (for the accounts store). */
export function getVaultAccounts(): string[] {
  return state.accounts;
}

/** Load the vault status from the backend (or the demo) on startup. */
export async function refreshVaultStatus(): Promise<void> {
  if (!isTauri()) {
    set(
      demoCreated
        ? { phase: "unlocked", address: DEMO_ADDRESSES[0], accounts: [DEMO_ADDRESSES[0]], active: 0 }
        : { phase: "absent", address: null, accounts: [], active: 0 },
    );
    return;
  }
  const s = await invoke<RustStatus>("vault_status");
  set({
    phase: !s.exists ? "absent" : s.unlocked ? "unlocked" : "locked",
    address: s.address,
    accounts: s.accounts,
    active: s.active,
  });
}

/** Create a new wallet. Returns the mnemonic for the ONE-TIME backup screen. */
export async function createVault(password: string): Promise<string> {
  if (!isTauri()) {
    demoCreated = true;
    set({ phase: "unlocked", address: DEMO_ADDRESSES[0], accounts: [DEMO_ADDRESSES[0]], active: 0 });
    return DEMO_MNEMONIC;
  }
  const nv = await invoke<NewVault>("create_vault", { password });
  set({ phase: "unlocked", address: nv.address, accounts: [nv.address], active: 0 });
  return nv.mnemonic;
}

/** Import a wallet from a recovery phrase. */
export async function importVault(password: string, mnemonic: string): Promise<void> {
  if (!isTauri()) {
    demoCreated = true;
    set({ phase: "unlocked", address: DEMO_ADDRESSES[0], accounts: [DEMO_ADDRESSES[0]], active: 0 });
    return;
  }
  const address = await invoke<string>("import_vault", { password, mnemonic: mnemonic.trim() });
  set({ phase: "unlocked", address, accounts: [address], active: 0 });
}

/** Unlock the on-disk vault. Throws "incorrect password" on a bad password. */
export async function unlockVault(password: string): Promise<void> {
  if (!isTauri()) {
    demoCreated = true;
    set({ phase: "unlocked", address: DEMO_ADDRESSES[0], accounts: [DEMO_ADDRESSES[0]], active: 0 });
    return;
  }
  await invoke<string>("unlock_vault", { password });
  await refreshVaultStatus(); // populate the full account list + active index
}

/** Lock the wallet (drop keys from memory). */
export async function lockVault(): Promise<void> {
  if (isTauri()) {
    await invoke("lock_vault");
    await refreshVaultStatus();
    return;
  }
  demoCreated = false;
  set({ phase: "absent", accounts: [], active: 0 });
}

/** Switch the active HD account (pushes accountsChanged to dApps backend-side). */
export async function selectVaultAccount(index: number): Promise<void> {
  if (!isTauri()) {
    set({ active: index, address: state.accounts[index] ?? state.address });
    return;
  }
  const address = await invoke<string>("select_account", { index });
  set({ active: index, address });
}

/** Derive + persist the next HD account. Returns its address. */
export async function addVaultAccount(): Promise<string> {
  if (!isTauri()) {
    const next = DEMO_ADDRESSES[state.accounts.length] ?? `0x${"0".repeat(40)}`;
    set({ accounts: [...state.accounts, next] });
    return next;
  }
  const address = await invoke<string>("add_account");
  set({ accounts: [...state.accounts, address] });
  return address;
}
