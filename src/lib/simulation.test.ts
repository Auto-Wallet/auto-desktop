import { afterEach, describe, expect, test } from "bun:test";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { simulateTx } from "./simulation";

// Drive the app's real path: the shell calls the `simulate_tx` command.
Object.defineProperty(globalThis, "window", {
  value: globalThis,
  configurable: true,
});

const SIGNER = "0x7521eda00e2ce05ac4a9d8353d096ccb970d5188";

function mockSimulation(body: unknown) {
  mockIPC((command) => {
    if (command !== "simulate_tx") throw new Error(`unexpected command ${command}`);
    return { ok: true, status: 200, data: body };
  });
}

afterEach(() => clearMocks());

describe("simulateTx balance changes", () => {
  test("keeps the token's own symbol case", async () => {
    mockSimulation({
      success: true,
      balance_changes: [
        {
          address: SIGNER,
          native_delta: "0",
          token_deltas: [
            { token: "0x00000000000000000000000000000000000000a1", symbol: "xWAN", decimals: 18, delta: "-4145857704000000000000" },
            { token: "0x00000000000000000000000000000000000000a2", symbol: "wanUSDT", decimals: 6, delta: "113800582" },
            { token: "0x00000000000000000000000000000000000000a3", symbol: "USDt", decimals: 6, delta: "5000000" },
          ],
        },
      ],
    });

    const preview = await simulateTx({
      chainId: 888,
      from: SIGNER,
      to: "0x2eA407Aa69be7367BF231E76B51fab9eC436766c",
      data: "0x",
      value: 0n,
      gas: 300_000n,
      nativeSymbol: "WAN",
    });

    expect(preview.error).toBeUndefined();
    expect(preview.status).toBe("success");
    expect(preview.changes.map((c) => [c.symbol, c.formattedDelta])).toEqual([
      ["xWAN", "-4145.857704"],
      ["USDt", "+5"],
      ["wanUSDT", "+113.800582"],
    ]);
  });
});
