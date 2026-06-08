// dApps store — the app cards behind VISION feature ② (add DeFi apps, each a
// card with logo + name, search + pin). Tiny external store + localStorage, no
// state library. Favicons load via an <img> src (no CORS needed for images);
// names auto-derive from the host and are user-editable.

import { useSyncExternalStore } from "react";

export type Dapp = {
  id: string;
  url: string;
  name: string;
  pinned: boolean;
};

const SEED: Dapp[] = [
  { id: "uniswap", url: "https://app.uniswap.org", name: "Uniswap", pinned: true },
  { id: "aave", url: "https://app.aave.com", name: "Aave", pinned: false },
  { id: "lido", url: "https://stake.lido.fi", name: "Lido", pinned: false },
  { id: "curve", url: "https://curve.fi", name: "Curve", pinned: false },
  { id: "1inch", url: "https://app.1inch.io", name: "1inch", pinned: false },
  { id: "opensea", url: "https://opensea.io", name: "OpenSea", pinned: false },
  { id: "xflows", url: "https://xflows.wanchain.org", name: "XFlows", pinned: false },
  { id: "wanchain-bridge", url: "https://bridge.wanchain.org", name: "Wanchain Bridge", pinned: false },
  { id: "relay", url: "https://relay.link", name: "Relay", pinned: false },
  { id: "pendle", url: "https://app.pendle.finance", name: "Pendle", pinned: false },
  { id: "benqi", url: "https://app.benqi.fi", name: "Benqi", pinned: false },
];

const ADDED_BUILTIN_HOSTS = new Set([
  "xflows.wanchain.org",
  "bridge.wanchain.org",
  "relay.link",
  "app.pendle.finance",
  "app.benqi.fi",
]);

const KEY = "autodesktop.dapps";

function load(): Dapp[] {
  const raw = localStorage.getItem(KEY);
  if (!raw) return SEED;
  const saved = JSON.parse(raw) as Dapp[];
  return mergeAddedBuiltins(saved);
}

let state: Dapp[] = load();
const listeners = new Set<() => void>();

function commit(next: Dapp[]) {
  state = next;
  localStorage.setItem(KEY, JSON.stringify(state));
  for (const l of listeners) l();
}

function mergeAddedBuiltins(saved: Dapp[]): Dapp[] {
  const hosts = new Set(saved.map((d) => hostOf(d.url)));
  const missing = SEED.filter((d) => ADDED_BUILTIN_HOSTS.has(hostOf(d.url)) && !hosts.has(hostOf(d.url)));
  return missing.length ? [...saved, ...missing] : saved;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function hostOf(url: string): string {
  return new URL(url).hostname;
}

/** Favicon URL for a dApp — DuckDuckGo's icon service, loaded as an <img>. */
export function faviconOf(url: string): string {
  return `https://icons.duckduckgo.com/ip3/${hostOf(url)}.ico`;
}

// "app.uniswap.org" -> "Uniswap": drop common sub-parts and the TLD, capitalize.
function deriveName(url: string): string {
  const host = hostOf(url).replace(/^www\./, "");
  const parts = host.split(".");
  const core = parts.length > 2 && ["app", "stake", "swap"].includes(parts[0])
    ? parts[1]
    : parts[0];
  return core.charAt(0).toUpperCase() + core.slice(1);
}

/** Normalize user input to a URL; throws on something that isn't a web address. */
function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const u = new URL(withScheme); // throws on garbage
  if (!u.hostname.includes(".")) throw new Error(`Not a valid URL: ${input}`);
  return u.origin + (u.pathname === "/" ? "" : u.pathname);
}

export function addDapp(input: string, name?: string): Dapp {
  const url = normalizeUrl(input);
  const host = hostOf(url);
  if (state.some((d) => hostOf(d.url) === host)) {
    throw new Error(`Already added: ${host}`);
  }
  const dapp: Dapp = {
    id: `${host}-${state.length}`,
    url,
    name: name?.trim() || deriveName(url),
    pinned: false,
  };
  commit([...state, dapp]);
  return dapp;
}

export function removeDapp(id: string) {
  commit(state.filter((d) => d.id !== id));
}

export function togglePin(id: string) {
  commit(state.map((d) => (d.id === id ? { ...d, pinned: !d.pinned } : d)));
}

export function renameDapp(id: string, name: string) {
  const clean = name.trim();
  if (!clean) return;
  commit(state.map((d) => (d.id === id ? { ...d, name: clean } : d)));
}

export function useDapps(): Dapp[] {
  return useSyncExternalStore(subscribe, () => state);
}
