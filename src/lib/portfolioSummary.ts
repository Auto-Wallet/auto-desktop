import type { Price } from "./prices";
import { weiToUsd } from "./format";

export type PortfolioBalanceState =
  | { status: "loading" }
  | { status: "ok"; wei: string }
  | { status: "error"; message: string };

export type PortfolioAsset = {
  balance: PortfolioBalanceState | undefined;
  decimals: number;
  price: Price | undefined;
  priceSource: "native" | "token";
};

export type PortfolioSummary =
  | { status: "loading"; total: null; change: null }
  | { status: "incomplete"; total: null; change: null }
  | { status: "partial"; total: number; change: number }
  | { status: "ready"; total: number; change: number };

export type PortfolioSummaryInput = {
  accountCurrent: boolean;
  assets: PortfolioAsset[];
  tokenBalanceStates: Array<PortfolioBalanceState | undefined>;
  nativePriceStatus: "loading" | "ok" | "error";
  tokenPriceStatus: "loading" | "ok" | "error";
  defi: {
    enabled: boolean;
    status: "idle" | "loading" | "ok" | "error";
    totalUsd: number;
  };
};

export function summarizePortfolio(input: PortfolioSummaryInput): PortfolioSummary {
  const balanceStates = [
    ...input.assets.map((asset) => asset.balance),
    ...input.tokenBalanceStates,
  ];
  const balancesLoading = balanceStates.some(
    (state) => !state || state.status === "loading",
  );
  const defiLoading =
    input.defi.enabled &&
    (input.defi.status === "idle" || input.defi.status === "loading");

  if (!input.accountCurrent || balancesLoading || defiLoading) {
    return { status: "loading", total: null, change: null };
  }

  let incomplete =
    balanceStates.some((state) => state?.status === "error") ||
    (input.defi.enabled && input.defi.status === "error");

  let total =
    input.defi.enabled && input.defi.status === "ok" ? input.defi.totalUsd : 0;
  let delta = 0;
  for (const asset of input.assets) {
    if (asset.balance?.status === "error") continue;
    if (asset.balance?.status !== "ok")
      throw new Error("portfolio balance resolution invariant violated");
    if (BigInt(asset.balance.wei) === 0n) continue;
    if (!asset.price) {
      const priceStatus =
        asset.priceSource === "native"
          ? input.nativePriceStatus
          : input.tokenPriceStatus;
      if (priceStatus === "loading") {
        return { status: "loading", total: null, change: null };
      }
      incomplete = true;
      continue;
    }
    const value = weiToUsd(asset.balance.wei, asset.decimals, asset.price.usd);
    total += value;
    delta += value * (asset.price.change24h / 100);
  }

  const previous = total - delta;
  const change = previous > 0 ? (delta / previous) * 100 : 0;
  if (incomplete) {
    return total > 0
      ? { status: "partial", total, change }
      : { status: "incomplete", total: null, change: null };
  }
  return {
    status: "ready",
    total,
    change,
  };
}
