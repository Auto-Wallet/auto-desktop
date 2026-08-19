import { afterEach, describe, expect, test } from "bun:test";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { enableTouchId, getTouchIdStatus, unlockVaultWithTouchId } from "./vault";

Object.defineProperty(globalThis, "window", {
  value: globalThis,
  configurable: true,
});

afterEach(() => clearMocks());

describe("Touch ID vault bridge", () => {
  test("reads Touch ID state from the native vault command", async () => {
    const calls: Array<{ command: string; args: unknown }> = [];
    mockIPC((command, args) => {
      calls.push({ command, args });
      return { available: true, enabled: true };
    });

    expect(await getTouchIdStatus()).toEqual({ available: true, enabled: true });
    expect(calls).toEqual([{ command: "touch_id_status", args: {} }]);
  });

  test("passes localized reasons to native Touch ID prompts", async () => {
    const calls: Array<{ command: string; args: unknown }> = [];
    mockIPC((command, args) => {
      calls.push({ command, args });
      return "0x1234";
    });

    await enableTouchId("enable wallet unlock");
    await unlockVaultWithTouchId("unlock wallet");

    expect(calls).toEqual([
      { command: "enable_touch_id", args: { reason: "enable wallet unlock" } },
      { command: "unlock_vault_with_touch_id", args: { reason: "unlock wallet" } },
      { command: "vault_status", args: {} },
    ]);
  });
});
