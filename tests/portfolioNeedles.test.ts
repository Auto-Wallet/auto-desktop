import { describe, expect, test } from "bun:test";
import { withoutNeedles } from "../src/lib/portfolioHistory";

const HOUR = 3600;
const T0 = 1786000000;

/** Readings an hour apart, in the order they were taken. */
function series(...totals: number[]) {
  return totals.map((totalUsd, i) => ({
    address: "0x7521eda00e2ce05ac4a9d8353d096ccb970d5188",
    totalUsd,
    timestamp: T0 + i * HOUR,
  }));
}

const totals = (samples: { totalUsd: number }[]) => samples.map((s) => s.totalUsd);

describe("needle readings", () => {
  test("drops a reading both of its neighbours disagree with", () => {
    // A portfolio cannot fall by two thirds and come back to the same figure an
    // hour later. That is a total captured while a source was still loading.
    expect(totals(withoutNeedles(series(90000, 90100, 8.68, 90200, 90300)))).toEqual([
      90000, 90100, 90200, 90300,
    ]);
  });

  test("drops an upward needle the same way", () => {
    expect(totals(withoutNeedles(series(90000, 250000, 90200)))).toEqual([90000, 90200]);
  });

  test("keeps a real step — it does not come back", () => {
    // Half the wallet moved out and stayed out. Every reading after the step
    // disagrees with the one before it, and none of them return.
    expect(totals(withoutNeedles(series(90000, 40000, 40100, 39900, 40050)))).toEqual([
      90000, 40000, 40100, 39900, 40050,
    ]);
  });

  test("drops a run of bad refreshes, not just a single one", () => {
    // The real history: three partial totals in a row between good readings.
    expect(
      totals(withoutNeedles(series(90118, 29765, 29714, 41000, 90497, 90500))),
    ).toEqual([90118, 90497, 90500]);
  });

  test("drops a shallow excursion that lands back on the same figure", () => {
    // Straight out of the real history: one DeFi protocol drops out of the
    // total for a few hours and comes back. Only a third of the wallet, so a
    // depth threshold alone never caught it — but it returns to within 0.5% of
    // the figure it left, which no market does.
    expect(
      totals(withoutNeedles(series(147142, 96418, 96500, 146481, 146900))),
    ).toEqual([147142, 146481, 146900]);
  });

  test("an excursion that begins with a mild bad reading goes whole", () => {
    // Also from the real history: a reading 10% short (too shallow to judge on
    // its own) immediately followed by one 67% short, then the value lands back
    // on the figure from before both. The level it returns to is the one that
    // decides — not whichever reading happened to come last.
    expect(
      totals(withoutNeedles(series(90118, 80720, 29766, 90498, 90349))),
    ).toEqual([90118, 90498, 90349]);
  });

  test("keeps a dip that comes back only roughly — that is a market", () => {
    // Same 34% depth, but the recovery misses by 12%. A source that dropped out
    // returns the holdings it was holding; a market lands wherever it lands.
    const bounce = series(147142, 96418, 129000, 131000);
    expect(totals(withoutNeedles(bounce))).toEqual(totals(bounce));
  });

  test("drops a multi-day dropout that lands back on the same figure", () => {
    // The wide V in the real chart: one protocol gone for three days, then the
    // total back within 0.45% of what it was. Too long for the ordinary window,
    // but no market takes a wallet down a third and returns it to the dollar.
    const days = (n: number) => T0 + n * 24 * HOUR;
    const dip = [
      { address: "0xa", totalUsd: 147142, timestamp: days(0) },
      { address: "0xa", totalUsd: 96418, timestamp: days(1.7) },
      { address: "0xa", totalUsd: 96500, timestamp: days(2.4) },
      { address: "0xa", totalUsd: 146481, timestamp: days(3) },
      { address: "0xa", totalUsd: 146900, timestamp: days(3.5) },
    ];
    expect(totals(withoutNeedles(dip))).toEqual([147142, 146481, 146900]);
  });

  test("keeps a multi-day dip that comes back near, but not on, the figure", () => {
    // 3% off after three days is a market finding its way back. Only the
    // ordinary one-day window is that forgiving.
    const days = (n: number) => T0 + n * 24 * HOUR;
    const dip = [
      { address: "0xa", totalUsd: 147142, timestamp: days(0) },
      { address: "0xa", totalUsd: 96418, timestamp: days(1.7) },
      { address: "0xa", totalUsd: 142800, timestamp: days(3) },
    ];
    expect(totals(withoutNeedles(dip))).toEqual([147142, 96418, 142800]);
  });

  test("keeps a dip that lasts longer than a day", () => {
    // Out for a week and back is a thing a wallet can actually do; a needle is
    // not. Beyond the span the readings are taken at face value.
    const week = [
      { address: "0xa", totalUsd: 90000, timestamp: T0 },
      { address: "0xa", totalUsd: 20000, timestamp: T0 + 2 * 24 * HOUR },
      { address: "0xa", totalUsd: 90000, timestamp: T0 + 7 * 24 * HOUR },
    ];
    expect(totals(withoutNeedles(week))).toEqual([90000, 20000, 90000]);
  });

  test("keeps the newest reading — nothing brackets it yet", () => {
    // The last point is the live total. It may well be mid-load, but calling it
    // a needle would hide the number the wallet is showing right now.
    expect(totals(withoutNeedles(series(90000, 90100, 30000)))).toEqual([
      90000, 90100, 30000,
    ]);
  });

  test("ordinary volatility survives", () => {
    const noisy = series(90000, 84000, 96000, 88000, 92000, 87000);
    expect(totals(withoutNeedles(noisy))).toEqual(totals(noisy));
  });

  test("too few readings to judge are passed through", () => {
    expect(totals(withoutNeedles(series(90000, 8.68)))).toEqual([90000, 8.68]);
  });
});
