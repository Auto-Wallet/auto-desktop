import { describe, expect, test } from "bun:test";
import { priceForChainAsset } from "./prices";

describe("priceForChainAsset", () => {
  test("forces assets on chains whose name contains testnet to zero", () => {
    expect(priceForChainAsset("Sepolia Testnet", { usd: 2200, change24h: 1.2 })).toEqual({
      usd: 0,
      change24h: 0,
    });
    expect(priceForChainAsset("WAN TESTNET", { usd: 0.23, change24h: -4 })).toEqual({
      usd: 0,
      change24h: 0,
    });
  });

  test("keeps live prices for non-testnet chains", () => {
    const price = { usd: 2200, change24h: 1.2 };
    expect(priceForChainAsset("Ethereum", price)).toBe(price);
  });
});
