import { afterEach, describe, expect, test } from "bun:test";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { AUTO_LOCK_CHOICES, createActivityReporter, getAutoLockMinutes, setAutoLockMinutes } from "./autoLock";

Object.defineProperty(globalThis, "window", {
  value: globalThis,
  configurable: true,
});

afterEach(() => clearMocks());

describe("auto-lock settings bridge", () => {
  test("reads and writes the idle minutes", async () => {
    const calls: Array<{ command: string; args: unknown }> = [];
    mockIPC((command, args) => {
      calls.push({ command, args });
      if (command === "get_auto_lock_minutes") return 15;
      if (command === "set_auto_lock_minutes") return (args as { minutes: number }).minutes;
      throw new Error(`unexpected ${command}`);
    });
    expect(await getAutoLockMinutes()).toBe(15);
    expect(await setAutoLockMinutes(60)).toBe(60);
    expect(calls[1]).toEqual({ command: "set_auto_lock_minutes", args: { minutes: 60 } });
  });

  test("offers Never plus increasing timeouts", () => {
    expect(AUTO_LOCK_CHOICES[0]).toBe(0);
    const rest = AUTO_LOCK_CHOICES.slice(1);
    expect(rest.every((m, i) => i === 0 || m > rest[i - 1])).toBe(true);
    expect(AUTO_LOCK_CHOICES).toContain(15);
  });
});

describe("activity reporter", () => {
  test("reports at most once per interval", () => {
    const sent: number[] = [];
    let now = 1_000;
    const report = createActivityReporter(30_000, () => now, () => sent.push(now));
    report(); // first input: sent
    now += 10_000;
    report(); // within 30s: dropped
    now += 25_000;
    report(); // 35s after the first: sent
    expect(sent).toEqual([1_000, 36_000]);
  });
});
