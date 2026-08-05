import { describe, expect, test } from "bun:test";
import { BUILTIN_CHAINS } from "./chains";

describe("built-in chains", () => {
  test("uses the BNB Chain RPC that returns pending blocks", () => {
    expect(BUILTIN_CHAINS.find((chain) => chain.id === "0x38")?.rpc).toBe(
      "https://bsc-dataseed.bnbchain.org",
    );
  });
});
