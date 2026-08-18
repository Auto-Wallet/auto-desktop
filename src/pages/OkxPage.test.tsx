import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { OkxDcdOrder } from "../lib/okxAccount";

const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as Storage;

const { OrderList, OrderYieldSummary } = await import("./OkxPage");

const settledOrder: OkxDcdOrder = {
  orderId: "10957529",
  productId: "BTC-USDC-260818-63750-C",
  optionType: "call",
  state: "settled",
  strike: "63750",
  principal: "0.9466",
  principalCurrency: "BTC",
  annualizedYield: "0.7354",
  yieldAmount: "0.00123456",
  yieldCurrency: "BTC",
  expiresAt: 1787068800000,
  settledAmount: "60348.75",
  settledCurrency: "USDC",
  settlementPrice: "64120.5",
};

describe("OKX Dual Investment table", () => {
  test("shows every order field in a table instead of cards", () => {
    const html = renderToStaticMarkup(<OrderList orders={[settledOrder]} />);

    expect(html).toContain("<table");
    expect(html).toContain("okx-order-table");
    expect(html).not.toContain("okx-order-card");
    expect(html).toContain("BTC-USDC-260818-63750-C");
    expect(html).toContain("10957529");
    expect(html).toContain("73.54%");
    expect(html).toContain("0.9466");
    expect(html).toContain("63,750");
    expect(html).toContain("0.00123456");
    expect(html).toContain("60,348.75");
    expect(html).toContain("64,120.5");
    expect(html).toContain("Settled");
    expect(html).toContain("($79.16)");
    expect(html).not.toContain("okx-order-yield-summary");
  });

  test("renders the all-order yield summary above the table", () => {
    const html = renderToStaticMarkup(<OrderYieldSummary orders={[settledOrder]} />);

    expect(html).toContain("okx-order-yield-summary");
    expect(html).toContain("Total yield");
    expect(html).toContain("Average APR");
    expect(html).toContain("73.54%");
    expect(html).toContain("+0.00123456 BTC");
    expect(html).toContain("($79.16)");
  });
});
