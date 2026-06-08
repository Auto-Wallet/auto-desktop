// Accounts store — the address switcher behind VISION feature ① ("方便地切换不同
// 钱包地址"). Sources, merged in order:
//   * SIGNER accounts — the accounts held by each unlocked WALLET (Rust-side: one
//     or more independent seeds / private keys / Ledgers). These come from the
//     vault store; the backend can actually sign with them.
//   * WATCH-only accounts — arbitrary addresses the user adds to view balances,
//     persisted to localStorage. The backend never signs for these.
//
// The active address is tracked locally; selecting a signer account also tells the
// backend to switch its active signing account, while selecting a watch-only address
// exposes that public address to dApps without changing the signing key.

import { useEffect, useSyncExternalStore } from "react";
import { isAddress } from "./format";
import {
  exposeDappAccount,
  getVaultAccounts,
  selectAccount,
  useVault,
  type VaultKind,
  type VaultState,
} from "./vault";

export type Account = {
  address: string;
  label: string;
  /** true = a vault wallet holds this key and can sign; false = watch-only. */
  signer: boolean;
  /** Secret kind of the owning wallet, or "watch" for a watch-only address. */
  kind: VaultKind | "watch";
  /** Owning wallet id ("" for watch-only). */
  walletId: string;
  /** Account index within its wallet (for labels). */
  index: number;
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

/** Signer accounts across every wallet, labeled by wallet (with an index suffix
 *  when a wallet holds more than one account). */
function signerAccounts(vault: VaultState): Account[] {
  return vault.wallets.flatMap((w) =>
    w.accounts.map((address, i) => ({
      address,
      label: w.accounts.length > 1 ? `${w.label} · ${i + 1}` : w.label,
      signer: true,
      kind: w.kind,
      walletId: w.id,
      index: i,
    })),
  );
}
function watchAccounts(): Account[] {
  return watch.map((w) => ({
    address: w.address,
    label: w.label,
    signer: false,
    kind: "watch" as const,
    walletId: "",
    index: 0,
  }));
}

function allAccounts(vault: VaultState): Account[] {
  return [...signerAccounts(vault), ...watchAccounts()];
}

/** The active account; falls back to the backend's active signer (then the first
 *  account) when no local selection (or a stale one) is set. */
export function useActiveAccount(): Account {
  const vault = useVault();
  const local = useSyncExternalStore(subscribe, () => activeAddress);
  const all = allAccounts(vault);
  const pick = (addr: string | null | undefined) =>
    addr
      ? all.find((a) => a.address.toLowerCase() === addr.toLowerCase())
      : undefined;
  const fallback = pick(vault.active) ??
    all[0] ?? {
      address: "0x",
      label: "—",
      signer: false,
      kind: "watch" as const,
      walletId: "",
      index: 0,
    };
  return pick(local) ?? fallback;
}

export function useAccounts(): Account[] {
  const vault = useVault();
  useSyncExternalStore(subscribe, () => watch); // re-render on watch changes
  return allAccounts(vault);
}

/** Keep the backend's dApp-visible account in lockstep with the shell. Signers also
 *  switch the backend signing account; watch-only addresses are exposed only as a
 *  public account for read-only portfolio dApps. */
export function useActiveAccountSync(): void {
  const vault = useVault();
  const active = useActiveAccount();
  useEffect(() => {
    if (!isAddress(active.address)) return;
    if (active.signer) {
      if (vault.phase !== "unlocked") return;
      if (
        vault.active &&
        vault.active.toLowerCase() === active.address.toLowerCase()
      )
        return;
      void selectAccount(active.address);
      return;
    }
    void exposeDappAccount(active.address);
  }, [vault.phase, vault.active, active.address, active.signer]);
}

/** The wallet that owns the active account (for per-wallet UI like Settings → Security). */
export function useActiveWallet() {
  const vault = useVault();
  const active = useActiveAccount();
  return (
    vault.wallets.find((w) =>
      w.accounts.some((a) => a.toLowerCase() === active.address.toLowerCase()),
    ) ?? null
  );
}

/** Switch the active account. Signer accounts switch the backend signing key;
 *  watch-only accounts only switch the public dApp account. */
export function setActive(address: string) {
  activeAddress = address;
  localStorage.setItem(ACTIVE_KEY, address);
  emit();

  const signer = getVaultAccounts().some(
    (a) => a.toLowerCase() === address.toLowerCase(),
  );
  if (signer) {
    void selectAccount(address);
  } else {
    void exposeDappAccount(address);
  }
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
  watch = [
    ...watch,
    { address: addr, label: label?.trim() || `Watch ${watch.length + 1}` },
  ];
  localStorage.setItem(WATCH_KEY, JSON.stringify(watch));
  emit();
  setActive(addr);
}

/** Remove a watch-only address. (Signer wallets are removed via deleteWallet.) */
export function removeWatchAccount(address: string) {
  const lower = address.toLowerCase();
  watch = watch.filter((w) => w.address.toLowerCase() !== lower);
  localStorage.setItem(WATCH_KEY, JSON.stringify(watch));
  if (activeAddress?.toLowerCase() === lower) {
    activeAddress = null;
    localStorage.removeItem(ACTIVE_KEY);
  }
  emit();
}

/** Rename a watch-only address. Signer wallet labels are renamed via renameWallet. */
export function renameWatchAccount(address: string, label: string) {
  const lower = address.toLowerCase();
  const next = label.trim();
  if (!next) return;
  watch = watch.map((w) =>
    w.address.toLowerCase() === lower ? { ...w, label: next } : w,
  );
  localStorage.setItem(WATCH_KEY, JSON.stringify(watch));
  emit();
}
