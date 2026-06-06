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
