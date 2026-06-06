// Accounts store — the address switcher behind VISION feature #1 ("方便地切换
// 不同钱包地址"). A tiny external store (useSyncExternalStore), persisted to
// localStorage, no state library.
//
// The first account is the signing account the Rust backend actually holds
// (currently the labeled Anvil #0 dev key). Additional accounts are watch-only
// addresses for viewing balances across chains — switching the active one drives
// the Wallet page. Real signing still happens Rust-side for the signing account.

import { useSyncExternalStore } from "react";
import { isAddress } from "./format";

export type Account = {
  address: string;
  label: string;
  /** true = the backend holds this key and can sign; false = watch-only. */
  signer: boolean;
};

// The address derived from the backend's active signing key (Anvil #0 dev key).
const SIGNER_ADDRESS = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

const DEFAULT_ACCOUNTS: Account[] = [
  { address: SIGNER_ADDRESS, label: "Account 1", signer: true },
];

const ACCOUNTS_KEY = "autodesktop.accounts";
const ACTIVE_KEY = "autodesktop.activeAddress";

type State = { accounts: Account[]; active: string };

function load(): State {
  const rawAccounts = localStorage.getItem(ACCOUNTS_KEY);
  const accounts = rawAccounts ? (JSON.parse(rawAccounts) as Account[]) : DEFAULT_ACCOUNTS;
  const active = localStorage.getItem(ACTIVE_KEY) ?? accounts[0]?.address ?? SIGNER_ADDRESS;
  return { accounts, active };
}

let state: State = load();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function persist() {
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(state.accounts));
  localStorage.setItem(ACTIVE_KEY, state.active);
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function setActive(address: string) {
  if (!state.accounts.some((a) => a.address === address)) return;
  state = { ...state, active: address };
  persist();
  emit();
}

/** Add a watch-only address; throws on a malformed address (no silent skip). */
export function addWatchAccount(address: string, label?: string) {
  const addr = address.trim();
  if (!isAddress(addr)) throw new Error(`Not a valid address: ${address}`);
  const lower = addr.toLowerCase();
  if (state.accounts.some((a) => a.address.toLowerCase() === lower)) {
    setActive(state.accounts.find((a) => a.address.toLowerCase() === lower)!.address);
    return;
  }
  const account: Account = {
    address: addr,
    label: label?.trim() || `Account ${state.accounts.length + 1}`,
    signer: false,
  };
  state = { accounts: [...state.accounts, account], active: addr };
  persist();
  emit();
}

export function useAccounts(): Account[] {
  return useSyncExternalStore(subscribe, () => state.accounts);
}

export function useActiveAccount(): Account {
  const active = useSyncExternalStore(subscribe, () => state.active);
  return state.accounts.find((a) => a.address === active) ?? state.accounts[0];
}
