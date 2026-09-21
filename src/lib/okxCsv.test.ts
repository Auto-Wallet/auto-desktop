import { expect, test } from "bun:test";
import { buildOkxDcdCsv, csvCell } from "./okxCsv";
import type { OkxDcdOrder } from "./okxAccount";

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
  createdAt: 1786982400000,
  updatedAt: 1787068800000,
  expiresAt: 1787068800000,
  settledAt: 1787068800000,
  settledAmount: "60348.75",
  settledCurrency: "USDC",
  settlementPrice: "64120.5",
};

test("exports source precision, UTC timestamps, BOM and every supplied order", () => {
  const csv = buildOkxDcdCsv([settledOrder, { ...settledOrder, orderId: "live", state: "live" }], true);
  expect(csv.startsWith('\uFEFF"订单ID"')).toBe(true);
  expect(csv.split("\r\n").length).toBe(4);
  expect(csv).toContain('"0.9466","BTC","0.7354","0.00123456","BTC"');
  expect(csv).toContain('"2026-08-17T16:00:00.000Z"');
  expect(csv).toContain('"live","BTC-USDC-260818-63750-C","call","live"');
});

test("exports redemption losses and actual redemption time", () => {
  const csv = buildOkxDcdCsv([{ ...settledOrder, state: "redeemed", settledCurrency: "BTC", settledAmount: "0.9366", updatedAt: 1786723200000 }], false);
  expect(csv).toContain('"-0.01","BTC"');
  expect(csv).toContain('"2026-08-14T16:00:00.000Z","2026-08-14T16:00:00.000Z"');
});

test("escapes separators, quotes, newlines and spreadsheet formulas without changing numbers", () => {
  expect(csvCell('a,"b"\nc')).toBe('"a,""b""\nc"');
  expect(csvCell('=1+1')).toBe('"\'=1+1"');
  expect(csvCell('-0.000001')).toBe('"-0.000001"');
  expect(csvCell(null)).toBe('""');
});
