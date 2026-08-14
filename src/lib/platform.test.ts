import { afterEach, expect, test } from "bun:test";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { goBackDapp } from "./platform";

Object.defineProperty(globalThis, "window", {
  value: globalThis,
  configurable: true,
});

afterEach(() => clearMocks());

test("the browser back control navigates inside the active dApp webview", async () => {
  const calls: Array<{ command: string; args: unknown }> = [];
  mockIPC((command, args) => {
    calls.push({ command, args });
  });

  await goBackDapp("dapp-uniswap");

  expect(calls).toEqual([
    { command: "go_back_dapp", args: { label: "dapp-uniswap" } },
  ]);
});
