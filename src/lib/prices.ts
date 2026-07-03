// USD price oracle for the Wallet portfolio. Every consumer maps an asset symbol
// to one canonical CoinGecko id, then reads through this module's persisted cache.
// We price by TOKEN SYMBOL, not by per-chain contract address: the same asset on
// different chains is the same price (USDT on Arbitrum == USDT on OP), and
// Wanchain wanXXX assets price off their underlying token (wanUSDT -> USDT).
//
// Two resiliencies, both at the user's request:
//   * Wanchain wrapped/staked assets price off their underlying — wanUSDT→USDT,
//     wanETH→ETH, wanBTC→BTC, xWAN→WAN — see priceIdForSymbol().
//   * A successful fetch updates one global localStorage oracle cache. The cache is
//     reused across native/token rows and across app restarts; by default it will
//     not refresh more often than once every 30 minutes.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./platform";

export type Price = { usd: number; change24h: number; synthetic?: boolean };

export type PriceState =
  | { status: "loading" }
  | { status: "ok"; prices: Record<string, Price> }
  | { status: "error"; message: string };

const ZERO_PRICE: Price = { usd: 0, change24h: 0, synthetic: true };

export function priceForChainAsset(chainName: string, price: Price | undefined): Price | undefined {
  if (/testnet/i.test(chainName)) return ZERO_PRICE;
  return price;
}

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
  MATIC: "polygon-ecosystem-token",
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

export type PriceOracleSnapshot = {
  updatedAt: number;
  prices: Record<string, Price>;
};

// --- persistent global price oracle -----------------------------------------
const PRICE_ORACLE_CACHE_KEY = "autodesktop.priceOracle.v1";
const PRICE_ORACLE_TTL_MS = 30 * 60 * 1000;
let oracleInFlight: Promise<PriceOracleSnapshot> | null = null;
let oracleInFlightIds: string[] = [];

function emptyOracle(): PriceOracleSnapshot {
  return { updatedAt: 0, prices: {} };
}

function loadOracle(): PriceOracleSnapshot {
  try {
    const raw = localStorage.getItem(PRICE_ORACLE_CACHE_KEY);
    if (!raw) return emptyOracle();
    const parsed = JSON.parse(raw) as PriceOracleSnapshot;
    if (!parsed || typeof parsed.updatedAt !== "number" || !parsed.prices) {
      return emptyOracle();
    }
    return parsed;
  } catch {
    /* corrupt cache — ignore */
  }
  return emptyOracle();
}

function saveOracle(snapshot: PriceOracleSnapshot): void {
  try {
    localStorage.setItem(PRICE_ORACLE_CACHE_KEY, JSON.stringify(snapshot));
  } catch {
    /* storage full / unavailable — fetched prices still returned */
  }
}

export function mergeOracleSnapshot(
  snapshot: PriceOracleSnapshot,
  fresh: Record<string, Price>,
  updatedAt: number,
): PriceOracleSnapshot {
  return {
    updatedAt,
    prices: { ...snapshot.prices, ...fresh },
  };
}

function saveFreshOraclePrices(fresh: Record<string, Price>): void {
  saveOracle(mergeOracleSnapshot(loadOracle(), fresh, Date.now()));
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

function hasAllIds(snapshot: PriceOracleSnapshot, ids: string[]): boolean {
  return ids.every((id) => snapshot.prices[id]);
}

function pickIds(snapshot: PriceOracleSnapshot, ids: string[]): Record<string, Price> {
  const out: Record<string, Price> = {};
  for (const id of ids) {
    if (snapshot.prices[id]) out[id] = snapshot.prices[id];
  }
  return out;
}

function writePriceDiagnosticLog(message: string): void {
  if (!isTauri()) return;
  void invoke("write_diagnostic_log", { message: `frontend ${message}` }).catch(() => undefined);
}

async function readPriceOracle(ids: string[]): Promise<Record<string, Price>> {
  const uniqueIds = [...new Set(ids)].sort();
  if (isTauri()) {
    writePriceDiagnosticLog(`price oracle invoke start ids=${uniqueIds.join(",")}`);
    try {
      const prices = await invoke<Record<string, Price>>("get_price_oracle_prices", { ids: uniqueIds });
      writePriceDiagnosticLog(
        `price oracle invoke ok ids=${uniqueIds.join(",")} returned=${Object.keys(prices).join(",")}`,
      );
      saveFreshOraclePrices(prices);
      return prices;
    } catch (e) {
      writePriceDiagnosticLog(
        `price oracle invoke failed ids=${uniqueIds.join(",")} error=${e instanceof Error ? e.message : String(e)}`,
      );
      throw e;
    }
  }

  const cached = loadOracle();
  const freshEnough = Date.now() - cached.updatedAt <= PRICE_ORACLE_TTL_MS;
  if (freshEnough && hasAllIds(cached, uniqueIds)) return pickIds(cached, uniqueIds);

  if (!oracleInFlight || !uniqueIds.every((id) => oracleInFlightIds.includes(id))) {
    oracleInFlightIds = uniqueIds;
    oracleInFlight = fetchByIds(uniqueIds)
      .then((fresh) => {
        const snapshot = mergeOracleSnapshot(loadOracle(), fresh, Date.now());
        saveOracle(snapshot);
        return snapshot;
      })
      .finally(() => {
        oracleInFlight = null;
        oracleInFlightIds = [];
      });
  }

  try {
    return pickIds(await oracleInFlight, uniqueIds);
  } catch (e) {
    const fallback = pickIds(loadOracle(), uniqueIds);
    if (Object.keys(fallback).length > 0) return fallback;
    throw e;
  }
}

function pricesBySymbol(
  symbols: string[],
  oraclePrices: Record<string, Price>,
): Record<string, Price> {
  const out: Record<string, Price> = {};
  for (const symbol of symbols) {
    const id = priceIdForSymbol(symbol);
    if (id && oraclePrices[id]) out[symbol.toUpperCase()] = oraclePrices[id];
  }
  return out;
}

function tokenPricesByKey(
  entries: string[],
  oraclePrices: Record<string, Price>,
): Record<string, Price> {
  const out: Record<string, Price> = {};
  for (const entry of entries) {
    const [tokenKey, symbol] = entry.split("@");
    const id = priceIdForSymbol(symbol ?? "");
    if (id && oraclePrices[id]) out[tokenKey] = oraclePrices[id];
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
  const [state, setState] = useState<PriceState>(() => {
    const syms = key ? key.split(",") : [];
    const prices = pricesBySymbol(syms, loadOracle().prices);
    return Object.keys(prices).length > 0 ? { status: "ok", prices } : { status: "loading" };
  });
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const syms = key ? key.split(",") : [];
    const ids = [...new Set(syms.map(priceIdForSymbol).filter((id): id is string => !!id))];
    if (ids.length === 0) {
      setState({ status: "ok", prices: {} });
      return;
    }

    let cancelled = false;
    setState({ status: "loading" });
    readPriceOracle(ids)
      .then((byId) => {
        if (cancelled) return;
        setState({ status: "ok", prices: pricesBySymbol(syms, byId) });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const cached = pricesBySymbol(syms, loadOracle().prices);
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
  const [prices, setPrices] = useState<Record<string, Price>>(() =>
    tokenPricesByKey(key ? key.split("|") : [], loadOracle().prices),
  );
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const entries = key ? key.split("|") : [];
    const ids = [
      ...new Set(
        entries
          .map((entry) => priceIdForSymbol(entry.split("@")[1] ?? ""))
          .filter((id): id is string => !!id),
      ),
    ];
    if (ids.length === 0) {
      setPrices(tokenPricesByKey(entries, loadOracle().prices));
      return;
    }

    let cancelled = false;
    readPriceOracle(ids)
      .then((byId) => {
        if (cancelled) return;
        setPrices(tokenPricesByKey(entries, byId));
      })
      .catch(() => {
        // A pricing outage must not blank already-shown amounts — keep the cached
        // values (loaded into state on mount), never a fabricated zero.
        if (!cancelled) {
          setPrices((p) => ({ ...tokenPricesByKey(entries, loadOracle().prices), ...p }));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [key, nonce]);

  return { prices, refresh };
}
