import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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

const { OrderHeadActions, OrderList, OrderYieldSummary } = await import("./OkxPage");

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
  test("keeps the yield summary visible for current holdings", () => {
    const currentOrder: OkxDcdOrder = {
      ...settledOrder,
      orderId: "current",
      state: "live",
      annualizedYield: "0.8273",
      yieldAmount: null,
      yieldCurrency: null,
      settledAmount: null,
      settledCurrency: null,
      settlementPrice: null,
    };
    const html = renderToStaticMarkup(
      <OrderHeadActions
        allOrders={[currentOrder, settledOrder]}
        showAllOrders={false}
        onShowAllOrders={() => {}}
      />,
    );

    expect(html).toContain("okx-order-yield-summary");
    expect(html).toContain("+0.001235 BTC");
    expect(html).toContain("78.14%");
    expect(html).not.toContain("82.73%");
    expect(html).toContain('<button class="on">Current</button>');
  });

  test("shows every order field in a table instead of cards", () => {
    const html = renderToStaticMarkup(<OrderList orders={[settledOrder]} />);

    expect(html).toContain("<table");
    expect(html).toContain("okx-order-table");
    expect(html).not.toContain("okx-order-card");
    expect(html).toContain("<th>APR</th>");
    expect(html).not.toContain("Annualized yield");
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
    expect(html).toContain("+0.001235 BTC");
    expect(html).toContain("($79.16)");
  });

  test("formats stablecoin totals to two decimals and other totals to six", () => {
    const btcOrder = { ...settledOrder, yieldAmount: "0.00508687" };
    const usdcOrder: OkxDcdOrder = {
      ...settledOrder,
      orderId: "usdc-yield",
      optionType: "put",
      principal: "60462",
      principalCurrency: "USDC",
      yieldAmount: "164.80074235",
      yieldCurrency: "USDC",
    };
    const html = renderToStaticMarkup(<OrderYieldSummary orders={[btcOrder, usdcOrder]} />);

    expect(html).toContain("+0.005087 BTC");
    expect(html).toContain("+164.80 USDC");
    expect(html).not.toContain("0.00508687 BTC");
    expect(html).not.toContain("164.80074235 USDC");
  });

  test("reserves more table width for yield, settlement, and status details", () => {
    const css = readFileSync(new URL("./OkxPage.css", import.meta.url), "utf8");

    expect(css).toContain("min-width: 960px");
    expect(css).toContain(".okx-order-table th:first-child {\n  width: 22%");
    expect(css).toContain(".okx-order-table th:nth-child(2) { width: 8%; }");
    expect(css).toContain(".okx-order-table th:nth-child(6) { width: 18%; }");
  });
});
