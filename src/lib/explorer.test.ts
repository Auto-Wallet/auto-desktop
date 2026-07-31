import { describe, expect, it } from "bun:test";
import { explorerTxUrl, txExplorerUrl } from "./explorer";
import type { ActivityRecord } from "./activity";

const HASH = "0x212e4a0d1111222233334444555566667777888899990000aaaabbbbe917b714";
const DEST = "0xf5873cb211112222333344445555666677778888999900001111222285428ed2";

describe("explorerTxUrl", () => {
  it("uses the chain's configured base, appending the hash", () => {
    expect(
      explorerTxUrl(
        { id: "0x1", name: "Ethereum", explorerUrl: "https://etherscan.io/tx/" },
        "0x1",
        "Ethereum",
        HASH,
      ),
    ).toBe(`https://etherscan.io/tx/${HASH}`);
  });

  it("inserts the hash into a {hash} placeholder", () => {
    expect(
      explorerTxUrl(
        { id: "0x92", name: "Sonic", explorerUrl: "https://x.io/?tx={hash}&v=1" },
        "0x92",
        "Sonic",
        HASH,
      ),
    ).toBe(`https://x.io/?tx=${HASH}&v=1`);
  });

  it("adds the missing separator when the base has no trailing slash", () => {
    expect(
      explorerTxUrl(
        { id: "0x92", name: "Sonic", explorerUrl: "https://sonicscan.org/tx" },
        "0x92",
        "Sonic",
        HASH,
      ),
    ).toBe(`https://sonicscan.org/tx/${HASH}`);
  });

  it("falls back to the built-in map for a chain the user has not configured", () => {
    // Destination chains of a bridge are often absent from the local chain list.
    expect(explorerTxUrl(undefined, "0x2105", "Base", DEST)).toBe(
      `https://basescan.org/tx/${DEST}`,
    );
    expect(explorerTxUrl(undefined, "0x92", "Sonic", HASH)).toBe(
      `https://sonicscan.org/tx/${HASH}`,
    );
  });

  it("matches 0G by name because its id is not in the map", () => {
    expect(explorerTxUrl(undefined, "0x40d9", "0G Mainnet", HASH)).toBe(
      `https://chainscan.0g.ai/tx/${HASH}`,
    );
  });

  it("returns null for an unknown chain and for an empty hash", () => {
    expect(explorerTxUrl(undefined, "0xdeadbeef", "Nowhere", HASH)).toBeNull();
    expect(
      explorerTxUrl({ id: "0x1", name: "Ethereum", explorerUrl: "https://etherscan.io/tx/" }, "0x1", "Ethereum", ""),
    ).toBeNull();
  });
});

describe("txExplorerUrl", () => {
  it("reads chain and hash off the activity record", () => {
    const record = {
      chainId: "0xa4b1",
      chainName: "Arbitrum One",
      hash: HASH,
    } as ActivityRecord;
    expect(txExplorerUrl(undefined, record)).toBe(`https://arbiscan.io/tx/${HASH}`);
  });
});
