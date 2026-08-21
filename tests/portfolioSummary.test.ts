import { describe, expect, test } from "bun:test";
import { summarizePortfolio } from "../src/lib/portfolioSummary";

const price = { usd: 3_000, change24h: 0 };

describe("wallet total display", () => {
  test("does not report zero while another native balance is still loading", () => {
    const summary = summarizePortfolio({
      accountCurrent: true,
      assets: [
        {
          balance: { status: "ok", wei: "0" },
          decimals: 18,
          price,
          priceSource: "native",
        },
        {
          balance: { status: "loading" },
          decimals: 18,
          price,
          priceSource: "native",
        },
      ],
      tokenBalanceStates: [],
      nativePriceStatus: "ok",
      tokenPriceStatus: "ok",
      defi: { enabled: false, status: "idle", totalUsd: 0 },
    });

    expect(summary).toEqual({ status: "loading", total: null, change: null });
  });

  test("reports exact zero after every balance source has completed", () => {
    const summary = summarizePortfolio({
      accountCurrent: true,
      assets: [
        {
          balance: { status: "ok", wei: "0" },
          decimals: 18,
          price,
          priceSource: "native",
        },
      ],
      tokenBalanceStates: [
        { status: "ok", wei: "0x0" },
        { status: "ok", wei: "0x0" },
      ],
      nativePriceStatus: "loading",
      tokenPriceStatus: "ok",
      defi: { enabled: false, status: "idle", totalUsd: 0 },
    });

    expect(summary).toEqual({ status: "ready", total: 0, change: 0 });
  });

  test("waits for the default ERC-20 scan before reporting zero", () => {
    const summary = summarizePortfolio({
      accountCurrent: true,
      assets: [
        {
          balance: { status: "ok", wei: "0" },
          decimals: 18,
          price,
          priceSource: "native",
        },
      ],
      tokenBalanceStates: [
        { status: "ok", wei: "0x0" },
        { status: "loading" },
      ],
      nativePriceStatus: "ok",
      tokenPriceStatus: "ok",
      defi: { enabled: false, status: "idle", totalUsd: 0 },
    });

    expect(summary).toEqual({ status: "loading", total: null, change: null });
  });

  test("marks the total incomplete when any balance request fails", () => {
    const summary = summarizePortfolio({
      accountCurrent: true,
      assets: [
        {
          balance: { status: "ok", wei: "0" },
          decimals: 18,
          price,
          priceSource: "native",
        },
        {
          balance: { status: "error", message: "RPC timed out" },
          decimals: 18,
          price,
          priceSource: "native",
        },
      ],
      tokenBalanceStates: [{ status: "ok", wei: "0x0" }],
      nativePriceStatus: "ok",
      tokenPriceStatus: "ok",
      defi: { enabled: false, status: "idle", totalUsd: 0 },
    });

    expect(summary).toEqual({ status: "incomplete", total: null, change: null });
  });

  test("does not omit a held token whose USD price is still loading", () => {
    const summary = summarizePortfolio({
      accountCurrent: true,
      assets: [
        {
          balance: { status: "ok", wei: "1000000" },
          decimals: 6,
          price: undefined,
          priceSource: "token",
        },
      ],
      tokenBalanceStates: [{ status: "ok", wei: "1000000" }],
      nativePriceStatus: "ok",
      tokenPriceStatus: "loading",
      defi: { enabled: false, status: "idle", totalUsd: 0 },
    });

    expect(summary).toEqual({ status: "loading", total: null, change: null });
  });

  test("marks the total incomplete when a held token has no USD price", () => {
    const summary = summarizePortfolio({
      accountCurrent: true,
      assets: [
        {
          balance: { status: "ok", wei: "1000000" },
          decimals: 6,
          price: undefined,
          priceSource: "token",
        },
      ],
      tokenBalanceStates: [{ status: "ok", wei: "1000000" }],
      nativePriceStatus: "ok",
      tokenPriceStatus: "error",
      defi: { enabled: false, status: "idle", totalUsd: 0 },
    });

    expect(summary).toEqual({ status: "incomplete", total: null, change: null });
  });

  test("does not treat an unpriced held asset as zero after prices settle", () => {
    const summary = summarizePortfolio({
      accountCurrent: true,
      assets: [
        {
          balance: { status: "ok", wei: "1" },
          decimals: 0,
          price: undefined,
          priceSource: "token",
        },
      ],
      tokenBalanceStates: [{ status: "ok", wei: "1" }],
      nativePriceStatus: "ok",
      tokenPriceStatus: "ok",
      defi: { enabled: false, status: "idle", totalUsd: 0 },
    });

    expect(summary).toEqual({ status: "incomplete", total: null, change: null });
  });

  test("does not report a tokens-only zero while enabled DeFi is unresolved", () => {
    const base = {
      accountCurrent: true,
      assets: [
        {
          balance: { status: "ok" as const, wei: "0" },
          decimals: 18,
          price,
          priceSource: "native" as const,
        },
      ],
      tokenBalanceStates: [{ status: "ok" as const, wei: "0x0" }],
      nativePriceStatus: "ok" as const,
      tokenPriceStatus: "ok" as const,
    };

    expect(
      summarizePortfolio({
        ...base,
        defi: { enabled: true, status: "loading", totalUsd: 0 },
      }),
    ).toEqual({ status: "loading", total: null, change: null });
    expect(
      summarizePortfolio({
        ...base,
        defi: { enabled: true, status: "error", totalUsd: 0 },
      }),
    ).toEqual({ status: "incomplete", total: null, change: null });
  });

  test("does not show the previous account total during an account switch", () => {
    const summary = summarizePortfolio({
      accountCurrent: false,
      assets: [
        {
          balance: { status: "ok", wei: "1000000000000000000" },
          decimals: 18,
          price,
          priceSource: "native",
        },
      ],
      tokenBalanceStates: [{ status: "ok", wei: "0x0" }],
      nativePriceStatus: "ok",
      tokenPriceStatus: "ok",
      defi: { enabled: false, status: "idle", totalUsd: 0 },
    });

    expect(summary).toEqual({ status: "loading", total: null, change: null });
  });

  test("adds complete wallet and DeFi values", () => {
    const summary = summarizePortfolio({
      accountCurrent: true,
      assets: [
        {
          balance: { status: "ok", wei: "1000000000000000000" },
          decimals: 18,
          price: { usd: 3_000, change24h: 10 },
          priceSource: "native",
        },
        {
          balance: { status: "ok", wei: "2000000" },
          decimals: 6,
          price: { usd: 1, change24h: 0 },
          priceSource: "token",
        },
      ],
      tokenBalanceStates: [{ status: "ok", wei: "2000000" }],
      nativePriceStatus: "ok",
      tokenPriceStatus: "ok",
      defi: { enabled: true, status: "ok", totalUsd: 100 },
    });

    expect(summary.status).toBe("ready");
    if (summary.status !== "ready") throw new Error("portfolio should be ready");
    expect(summary.total).toBe(3_102);
    expect(summary.change).toBeCloseTo((300 / 2_802) * 100, 8);
  });
});
