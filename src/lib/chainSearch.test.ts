import { describe, expect, test } from "bun:test";
import { filterChains } from "./chainSearch";

const CHAINS = [
  { id: "0x1", name: "Ethereum", symbol: "ETH" },
  { id: "0xa", name: "OP Mainnet", symbol: "ETH" },
  { id: "0xa4b1", name: "Arbitrum One", symbol: "ETH" },
  { id: "0x89", name: "Polygon", symbol: "POL" },
];

describe("filterChains", () => {
  test("returns all chains for an empty query", () => {
    expect(filterChains(CHAINS, "   ")).toEqual(CHAINS);
  });

  test("matches names and symbols without case sensitivity", () => {
    expect(filterChains(CHAINS, "  arbitrum  ").map((chain) => chain.id)).toEqual(["0xa4b1"]);
    expect(filterChains(CHAINS, "pol").map((chain) => chain.id)).toEqual(["0x89"]);
  });

  test("matches hexadecimal and decimal chain IDs", () => {
    expect(filterChains(CHAINS, "0x89").map((chain) => chain.id)).toEqual(["0x89"]);
    expect(filterChains(CHAINS, "42161").map((chain) => chain.id)).toEqual(["0xa4b1"]);
  });
});
