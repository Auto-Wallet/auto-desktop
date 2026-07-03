import { describe, expect, test } from "bun:test";
import { priceForChainAsset, priceIdForSymbol } from "./prices";

describe("priceForChainAsset", () => {
  test("forces assets on chains whose name contains testnet to synthetic zero", () => {
    expect(priceForChainAsset("Sepolia Testnet", { usd: 2200, change24h: 1.2 })).toEqual({
      usd: 0,
      change24h: 0,
      synthetic: true,
    });
    expect(priceForChainAsset("WAN TESTNET", { usd: 0.23, change24h: -4 })).toEqual({
      usd: 0,
      change24h: 0,
      synthetic: true,
    });
  });

  test("keeps live prices for non-testnet chains", () => {
    const price = { usd: 2200, change24h: 1.2 };
    expect(priceForChainAsset("Ethereum", price)).toBe(price);
  });
});

describe("priceIdForSymbol", () => {
  test("uses the current Polygon Ecosystem Token id for POL and MATIC", () => {
    expect(priceIdForSymbol("POL")).toBe("polygon-ecosystem-token");
    expect(priceIdForSymbol("MATIC")).toBe("polygon-ecosystem-token");
  });

  test("prices Wanchain wanXXX assets from the underlying token", () => {
    expect(priceIdForSymbol("wanUSDT")).toBe("tether");
    expect(priceIdForSymbol("wanUSDC")).toBe("usd-coin");
    expect(priceIdForSymbol("wanETH")).toBe("ethereum");
    expect(priceIdForSymbol("wanBTC")).toBe("bitcoin");
  });

  test("prices xWAN from WAN", () => {
    expect(priceIdForSymbol("xWAN")).toBe("wanchain");
  });
});
