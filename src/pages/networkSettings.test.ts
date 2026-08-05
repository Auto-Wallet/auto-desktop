import { describe, expect, test } from "bun:test";
import { filterSettingsChains } from "./networkSettings";

const CHAINS = [
  {
    id: "0x1",
    name: "Ethereum",
    symbol: "ETH",
    rpc: "https://ethereum-rpc.publicnode.com",
    explorerUrl: "https://etherscan.io/tx/",
  },
  {
    id: "0x38",
    name: "BNB Chain",
    symbol: "BNB",
    rpc: "https://bsc-dataseed.bnbchain.org",
    explorerUrl: "https://bscscan.com/tx/",
  },
];

describe("filterSettingsChains", () => {
  test("matches the network fields shown in Settings", () => {
    expect(filterSettingsChains(CHAINS, "bnb").map((chain) => chain.id)).toEqual(["0x38"]);
    expect(filterSettingsChains(CHAINS, "56").map((chain) => chain.id)).toEqual(["0x38"]);
    expect(filterSettingsChains(CHAINS, "bscscan").map((chain) => chain.id)).toEqual(["0x38"]);
    expect(filterSettingsChains(CHAINS, "dataseed").map((chain) => chain.id)).toEqual(["0x38"]);
  });

  test("returns all networks for a blank query", () => {
    expect(filterSettingsChains(CHAINS, "  ")).toEqual(CHAINS);
  });
});
