import { describe, expect, test } from "bun:test";
import { buildTrendPath } from "../src/lib/portfolioHistory";

const at = (totalUsd: number, timestamp: number, persisted: boolean) => ({
  address: "0x7521eda00e2ce05ac4a9d8353d096ccb970d5188",
  totalUsd,
  timestamp,
  persisted,
});

describe("trend extremes", () => {
  test("marks the peak and the trough, both deletable when stored", () => {
    const { high, low } = buildTrendPath([
      at(100, 1000, true),
      at(8.68, 2000, true), // a total captured before DeFi answered
      at(140, 3000, true),
      at(120, 4000, true),
    ]);

    expect(low?.totalUsd).toBe(8.68);
    expect(low?.timestamp).toBe(2000);
    expect(high?.totalUsd).toBe(140);
    expect(high?.timestamp).toBe(3000);
    // y grows downward in the viewBox, so the trough sits below the peak.
    expect(low!.yPct).toBeGreaterThan(high!.yPct);
    expect([high?.deletable, low?.deletable]).toEqual([true, true]);
  });

  test("the live total offers no delete — it is not in the history yet", () => {
    const { high, low } = buildTrendPath([
      at(100, 1000, true),
      at(999, 2000, false), // the current value, drawn but not written
    ]);

    expect(high?.totalUsd).toBe(999);
    expect(high?.deletable).toBe(false);
    // Deleting by timestamp would otherwise take out whichever stored reading
    // shared that second — or fail, having promised a button.
    expect(low?.deletable).toBe(true);
  });

  test("a flat line has no peak and no trough to mark", () => {
    const { high, low } = buildTrendPath([
      at(100, 1000, true),
      at(100, 2000, true),
    ]);

    expect(high).toBeNull();
    expect(low).toBeNull();
  });
});
