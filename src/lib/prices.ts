// Native-token USD prices for the Wallet portfolio — fetched live from the free
// CoinGecko API (the shell is trusted local code, so it may call public services
// directly, like rpc.ts). We price ONLY the native gas tokens we actually hold a
// real balance for; we never fabricate a price. On failure the hook reports an
// honest error state — callers show the balance without USD, never a fake zero.

import { useCallback, useEffect, useState } from "react";

export type Price = { usd: number; change24h: number };

export type PriceState =
  | { status: "loading" }
  | { status: "ok"; prices: Record<string, Price> }
  | { status: "error"; message: string };

// Native-token symbol -> CoinGecko id. Only the symbols our chains actually use
// (plus a few common ones) — an unknown symbol simply gets no price.
const SYMBOL_TO_ID: Record<string, string> = {
  ETH: "ethereum",
  WETH: "weth",
  POL: "polygon-ecosystem-token",
  MATIC: "matic-network",
  BNB: "binancecoin",
  AVAX: "avalanche-2",
  FTM: "fantom",
  XDAI: "xdai",
  CELO: "celo",
  GNO: "gnosis",
};

export function priceIdFor(symbol: string): string | undefined {
  return SYMBOL_TO_ID[symbol.toUpperCase()];
}

// 0x-hex chain id -> CoinGecko asset-platform id, for ERC-20 contract pricing.
// Only chains we're confident about — an unmapped chain simply gets no token
// prices (we never fabricate one). See usePrices for the native-token path.
const PLATFORM_BY_CHAIN: Record<string, string> = {
  "0x1": "ethereum",
  "0xa": "optimistic-ethereum",
  "0x38": "binance-smart-chain",
  "0x89": "polygon-pos",
  "0xa4b1": "arbitrum-one",
  "0x2105": "base",
  "0xa86a": "avalanche",
  "0xe708": "linea",
  "0x13e31": "blast",
  "0x144": "zksync",
  "0x44d": "polygon-zkevm",
  "0x250": "astar",
  "0x378": "wanchain",
  "0x440": "metis-andromeda",
  "0xa4ec": "celo",
};

export function platformForChain(chainId: string): string | undefined {
  return PLATFORM_BY_CHAIN[chainId.toLowerCase()];
}

/** A token to price: its chain + contract address. */
export type PricedToken = { chainId: string; address: string };

const tkPriceKey = (chainId: string, address: string) =>
  `${chainId.toLowerCase()}:${address.toLowerCase()}`;

/**
 * Live USD prices for ERC-20 tokens, looked up by contract address per chain via
 * CoinGecko. Returns a map keyed `chainId:address`. Tokens on unmapped chains or
 * that CoinGecko doesn't know simply get no entry — never a fabricated price.
 */
export function useTokenPrices(tokens: PricedToken[]): {
  prices: Record<string, Price>;
  refresh: () => void;
} {
  // Stable key so we only refetch when the actual contract set changes.
  const key = [...new Set(tokens.map((t) => tkPriceKey(t.chainId, t.address)))].sort().join("|");
  const [prices, setPrices] = useState<Record<string, Price>>({});
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const pairs = key ? key.split("|") : [];
    // Group contract addresses by CoinGecko platform.
    const byPlatform: Record<string, { chainId: string; address: string }[]> = {};
    for (const pair of pairs) {
      const [chainId, address] = pair.split(":");
      const platform = platformForChain(chainId);
      if (!platform) continue;
      (byPlatform[platform] ??= []).push({ chainId, address });
    }
    const platforms = Object.keys(byPlatform);
    if (platforms.length === 0) {
      setPrices({});
      return;
    }

    let cancelled = false;
    Promise.all(
      platforms.map(async (platform) => {
        const group = byPlatform[platform];
        const addrs = [...new Set(group.map((g) => g.address))].join(",");
        const res = await fetch(
          `https://api.coingecko.com/api/v3/simple/token_price/${platform}` +
            `?contract_addresses=${addrs}&vs_currencies=usd&include_24hr_change=true`,
        );
        if (!res.ok) throw new Error(`CoinGecko token_price ${platform} HTTP ${res.status}`);
        const body = (await res.json()) as Record<string, { usd?: number; usd_24h_change?: number }>;
        const out: Record<string, Price> = {};
        for (const g of group) {
          const row = body[g.address.toLowerCase()];
          if (row && typeof row.usd === "number") {
            out[tkPriceKey(g.chainId, g.address)] = { usd: row.usd, change24h: row.usd_24h_change ?? 0 };
          }
        }
        return out;
      }),
    )
      .then((results) => {
        if (cancelled) return;
        setPrices(Object.assign({}, ...results));
      })
      .catch(() => {
        // A pricing outage must not blank already-shown amounts; leave prices as-is.
        // (Individual tokens simply render without USD — never a fake zero.)
      });

    return () => {
      cancelled = true;
    };
  }, [key, nonce]);

  return { prices, refresh };
}

export { tkPriceKey };

/**
 * Live USD prices for the given native-token symbols. The symbol set is
 * normalized (uppercased, deduped, sorted) into a stable key, so re-renders with
 * the same chains don't refetch.
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
      const id = priceIdFor(s);
      if (id) idBySym[s] = id;
    }
    const ids = [...new Set(Object.values(idBySym))];
    if (ids.length === 0) {
      setState({ status: "ok", prices: {} });
      return;
    }

    let cancelled = false;
    setState({ status: "loading" });
    fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(
        ",",
      )}&vs_currencies=usd&include_24hr_change=true`,
    )
      .then(async (res) => {
        if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
        const body = (await res.json()) as Record<
          string,
          { usd?: number; usd_24h_change?: number }
        >;
        if (cancelled) return;
        const prices: Record<string, Price> = {};
        for (const [sym, id] of Object.entries(idBySym)) {
          const row = body[id];
          if (row && typeof row.usd === "number") {
            prices[sym] = { usd: row.usd, change24h: row.usd_24h_change ?? 0 };
          }
        }
        setState({ status: "ok", prices });
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setState({ status: "error", message: e instanceof Error ? e.message : String(e) });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [key, nonce]);

  return { state, refresh };
}
