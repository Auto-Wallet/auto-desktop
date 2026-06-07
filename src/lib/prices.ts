// USD prices for the Wallet portfolio — fetched live from the free CoinGecko API
// (the shell is trusted local code, so it may call public services directly, like
// rpc.ts). We price by TOKEN SYMBOL, not by per-chain contract address: the same
// asset on different chains is the same price (USDT on Arbitrum == USDT on OP), and
// CoinGecko's per-contract endpoint simply doesn't know most bridged contracts.
//
// Two resiliencies, both at the user's request:
//   * Wanchain wrapped/staked assets price off their underlying — wanUSDT→USDT,
//     wanETH→ETH, wanBTC→BTC, xWAN→WAN — see priceIdForSymbol().
//   * Every successful fetch is cached to localStorage; when the network is down or
//     CoinGecko fails we fall back to the last cached price (a stale-but-REAL value,
//     never a fabricated zero) so the total still shows.

import { useCallback, useEffect, useState } from "react";

export type Price = { usd: number; change24h: number };

export type PriceState =
  | { status: "loading" }
  | { status: "ok"; prices: Record<string, Price> }
  | { status: "error"; message: string };

// Token/native SYMBOL (uppercased) -> CoinGecko coin id. An unknown symbol simply
// gets no price (never a fabricated one).
const SYMBOL_TO_ID: Record<string, string> = {
  ETH: "ethereum",
  WETH: "ethereum",
  BTC: "bitcoin",
  WBTC: "wrapped-bitcoin",
  USDT: "tether",
  USDC: "usd-coin",
  DAI: "dai",
  BUSD: "binance-usd",
  BNB: "binancecoin",
  POL: "polygon-ecosystem-token",
  MATIC: "matic-network",
  AVAX: "avalanche-2",
  FTM: "fantom",
  CELO: "celo",
  GNO: "gnosis",
  XDAI: "xdai",
  WAN: "wanchain",
  METIS: "metis-token",
  OKB: "okb",
  ASTR: "astar",
  ADA: "cardano",
  S: "sonic-3",
};

/**
 * Resolve a token/native symbol to a CoinGecko id, applying Wanchain aliases:
 *   * `xWAN` (staked WAN) tracks WAN.
 *   * `wanXXX` (bridged) tracks XXX — wanUSDT→USDT, wanETH→ETH, wanBTC→BTC, …
 * Returns undefined when we have no confident mapping (→ no price, not a fake zero).
 */
export function priceIdForSymbol(symbol: string): string | undefined {
  const s = symbol.toUpperCase();
  if (SYMBOL_TO_ID[s]) return SYMBOL_TO_ID[s];
  if (s === "XWAN") return SYMBOL_TO_ID.WAN;
  if (s.startsWith("WAN") && s.length > 3) return SYMBOL_TO_ID[s.slice(3)];
  return undefined;
}

/** A token to price: its chain + contract address + symbol (symbol drives pricing). */
export type PricedToken = { chainId: string; address: string; symbol: string };

const tkPriceKey = (chainId: string, address: string) =>
  `${chainId.toLowerCase()}:${address.toLowerCase()}`;
export { tkPriceKey };

// --- localStorage price cache (stale-but-real fallback) -----------------------
const NATIVE_CACHE_KEY = "autodesktop.priceCache.native"; // { SYMBOL: Price }
const TOKEN_CACHE_KEY = "autodesktop.priceCache.token"; // { chainId:address: Price }

function loadCache(key: string): Record<string, Price> {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw) as Record<string, Price>;
  } catch {
    /* corrupt cache — ignore */
  }
  return {};
}
// Merge fresh prices over the existing cache, persist, and return the merged map
// (so a symbol that failed THIS fetch still shows its last known price).
function mergeCache(key: string, fresh: Record<string, Price>): Record<string, Price> {
  const merged = { ...loadCache(key), ...fresh };
  try {
    localStorage.setItem(key, JSON.stringify(merged));
  } catch {
    /* storage full / unavailable — fetched prices still returned */
  }
  return merged;
}

// One CoinGecko simple/price call for a set of coin ids → { id: Price }.
async function fetchByIds(ids: string[]): Promise<Record<string, Price>> {
  const res = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}` +
      `&vs_currencies=usd&include_24hr_change=true`,
  );
  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
  const body = (await res.json()) as Record<string, { usd?: number; usd_24h_change?: number }>;
  const out: Record<string, Price> = {};
  for (const [id, row] of Object.entries(body)) {
    if (row && typeof row.usd === "number") out[id] = { usd: row.usd, change24h: row.usd_24h_change ?? 0 };
  }
  return out;
}

/**
 * Live USD prices for native-token symbols. The symbol set is normalized
 * (uppercased, deduped, sorted) into a stable key, so re-renders with the same
 * chains don't refetch. On a fetch failure we serve the cached prices instead of
 * blanking the total.
 */
export function usePrices(symbols: string[]): { state: PriceState; refresh: () => void } {
  const key = [...new Set(symbols.map((s) => s.toUpperCase()))].sort().join(",");
  const [state, setState] = useState<PriceState>({ status: "loading" });
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const syms = key ? key.split(",") : [];
    const idBySym: Record<string, string> = {};
    for (const s of syms) {
      const id = priceIdForSymbol(s);
      if (id) idBySym[s] = id;
    }
    const ids = [...new Set(Object.values(idBySym))];
    if (ids.length === 0) {
      setState({ status: "ok", prices: {} });
      return;
    }

    let cancelled = false;
    setState({ status: "loading" });
    fetchByIds(ids)
      .then((byId) => {
        if (cancelled) return;
        const fresh: Record<string, Price> = {};
        for (const [sym, id] of Object.entries(idBySym)) {
          if (byId[id]) fresh[sym] = byId[id];
        }
        setState({ status: "ok", prices: mergeCache(NATIVE_CACHE_KEY, fresh) });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const cached = loadCache(NATIVE_CACHE_KEY);
        if (Object.keys(cached).length > 0) {
          setState({ status: "ok", prices: cached }); // stale-but-real fallback
        } else {
          setState({ status: "error", message: e instanceof Error ? e.message : String(e) });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [key, nonce]);

  return { state, refresh };
}

/**
 * Live USD prices for ERC-20 tokens, priced by SYMBOL (see file header) and keyed
 * back to `chainId:address` so the same asset on every chain shares one price.
 * Cached to localStorage; on failure the cached prices are served.
 */
export function useTokenPrices(tokens: PricedToken[]): {
  prices: Record<string, Price>;
  refresh: () => void;
} {
  // Stable key so we only refetch when the actual (token, symbol) set changes.
  const key = [...new Set(tokens.map((t) => `${tkPriceKey(t.chainId, t.address)}@${t.symbol}`))]
    .sort()
    .join("|");
  const [prices, setPrices] = useState<Record<string, Price>>(() => loadCache(TOKEN_CACHE_KEY));
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const entries = key ? key.split("|") : [];
    // token key -> coin id, and the set of unique ids to fetch.
    const idByToken: Record<string, string> = {};
    for (const e of entries) {
      const [tkey, symbol] = e.split("@");
      const id = priceIdForSymbol(symbol ?? "");
      if (id) idByToken[tkey] = id;
    }
    const ids = [...new Set(Object.values(idByToken))];
    if (ids.length === 0) {
      setPrices(loadCache(TOKEN_CACHE_KEY));
      return;
    }

    let cancelled = false;
    fetchByIds(ids)
      .then((byId) => {
        if (cancelled) return;
        const fresh: Record<string, Price> = {};
        for (const [tkey, id] of Object.entries(idByToken)) {
          if (byId[id]) fresh[tkey] = byId[id];
        }
        setPrices(mergeCache(TOKEN_CACHE_KEY, fresh));
      })
      .catch(() => {
        // A pricing outage must not blank already-shown amounts — keep the cached
        // values (loaded into state on mount), never a fabricated zero.
        if (!cancelled) setPrices((p) => ({ ...loadCache(TOKEN_CACHE_KEY), ...p }));
      });

    return () => {
      cancelled = true;
    };
  }, [key, nonce]);

  return { prices, refresh };
}
