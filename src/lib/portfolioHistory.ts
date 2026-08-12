import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { isTauri } from "./platform";

export type PortfolioSnapshot = {
  address: string;
  totalUsd: number;
  timestamp: number;
};

/**
 * A peak or trough on the drawn curve. Coordinates are fractions of the chart
 * box (0..1), not viewBox units: the SVG stretches to fill its box with
 * `preserveAspectRatio="none"`, so HTML labels positioned in percent land
 * exactly on the point while escaping that horizontal stretch.
 */
export type TrendExtreme = {
  xPct: number;
  yPct: number;
  totalUsd: number;
  timestamp: number;
  /**
   * Whether this point is a stored reading, and so can be deleted. The live
   * total is drawn as the last point but has not been written yet — offering to
   * remove it would delete whichever stored reading happened to share its
   * second, or nothing at all.
   */
  deletable: boolean;
};

/** A drawn point, tagged with whether it came off disk. */
type ChartSample = PortfolioSnapshot & { persisted: boolean };

export type PortfolioTrend = {
  snapshots: PortfolioSnapshot[];
  percent: number | null;
  label: "24h" | "1h";
  path: string;
  areaPath: string;
  isFlat: boolean;
  high: TrendExtreme | null;
  low: TrendExtreme | null;
};

const HOUR = 60 * 60;
const DAY = 24 * HOUR;

/**
 * How far a reading has to sit from the last good one to be suspect. Ordinary
 * volatility stays well inside this; a total missing a source misses by 35-100%.
 */
const NEEDLE_EXCURSION = 0.15;
/**
 * How close the far side has to land for the excursion to be judged unreal.
 * This is the part that does the work: across the whole recorded history, every
 * one of these round trips comes back within 0.8% of the figure it left — the
 * same holdings, priced minutes apart. A market that really fell a third and
 * bounced does not land back on the old number to the dollar.
 */
const NEEDLE_RETURN = 0.05;
/** Past this, a dip is something the wallet did, not something it misread. */
const NEEDLE_MAX_SPAN = DAY;
/**
 * A round trip that lands back on the same figure to within this is not a
 * coincidence at any length — prices alone would have moved it. Dropouts that
 * last days are common (one protocol unreachable for a weekend), so an exact
 * return buys a longer window than a loose one.
 */
const NEEDLE_EXACT_RETURN = 0.01;
const NEEDLE_EXACT_MAX_SPAN = 4 * DAY;

/** Relative distance between two totals, 0 (same) to 1 (nothing in common). */
function apart(a: number, b: number): number {
  const hi = Math.max(a, b);
  return hi > 0 ? Math.abs(a - b) / hi : 0;
}

/**
 * Drops needle readings: values the wallet never actually held, left behind by
 * a total captured while one of its sources was still in flight.
 *
 * A reading is a needle when the value walks away from the last good one and
 * walks straight back — within a day, to all but the same figure it left. A
 * wallet cannot do that; a half-loaded refresh does it constantly. A genuine
 * move (funds out, and out they stay) never returns, so it is kept, and so is
 * the newest reading, which nothing has bracketed yet. A dip that comes back
 * only roughly is kept too: that is a market, not a dropped source.
 *
 * Deliberately not a fallback that quietly smooths bad data away: the readings
 * stay on disk, and anything that fails this test is a measurement the wallet
 * should never have written in the first place.
 */
export function withoutNeedles<T extends { totalUsd: number; timestamp: number }>(
  samples: T[],
): T[] {
  if (samples.length < 3) return samples;
  const kept: T[] = [];
  let i = 0;
  while (i < samples.length) {
    const anchor = kept[kept.length - 1];
    if (!anchor || apart(samples[i].totalUsd, anchor.totalUsd) <= NEEDLE_EXCURSION) {
      kept.push(samples[i]);
      i += 1;
      continue;
    }
    // Away from the last good reading. Only a return to a level the wallet was
    // just holding proves the readings in between were never real.
    //
    // The level it returns to is not always the reading right before: an
    // excursion often opens with a reading only 10% short, too shallow to judge
    // on its own, which has already been accepted by the time the deep one
    // arrives. So every recent reading is a candidate, and whichever one the
    // value lands back on decides where the excursion started.
    let back = -1;
    let from = -1;
    for (let j = i + 1; j < samples.length && back === -1; j++) {
      if (samples[j].timestamp - anchor.timestamp > NEEDLE_EXACT_MAX_SPAN) break;
      for (let k = kept.length - 1; k >= 0; k--) {
        const span = samples[j].timestamp - kept[k].timestamp;
        if (span > NEEDLE_EXACT_MAX_SPAN) break;
        const gap = apart(samples[j].totalUsd, kept[k].totalUsd);
        const returned =
          (gap <= NEEDLE_RETURN && span <= NEEDLE_MAX_SPAN) ||
          (gap <= NEEDLE_EXACT_RETURN && span <= NEEDLE_EXACT_MAX_SPAN);
        if (returned && apart(samples[i].totalUsd, kept[k].totalUsd) > NEEDLE_EXCURSION) {
          back = j;
          from = k;
          break;
        }
      }
    }
    if (back === -1) {
      kept.push(samples[i]);
      i += 1;
      continue;
    }
    kept.length = from + 1; // whatever followed that level was part of the excursion
    i = back;
  }
  return kept;
}

function pickBaseline(
  snapshots: PortfolioSnapshot[],
  current: PortfolioSnapshot,
): { sample: PortfolioSnapshot | null; label: "24h" | "1h" } {
  const sorted = snapshots
    .filter((s) => s.timestamp < current.timestamp && s.totalUsd > 0)
    .sort((a, b) => a.timestamp - b.timestamp);
  const target24h = current.timestamp - DAY;
  const sample24h = [...sorted]
    .reverse()
    .find((s) => s.timestamp <= target24h);
  if (sample24h) return { sample: sample24h, label: "24h" };

  const target1h = current.timestamp - HOUR;
  const sample1h = [...sorted]
    .reverse()
    .find((s) => s.timestamp <= target1h);
  if (sample1h) return { sample: sample1h, label: "1h" };

  // While the wallet is still accumulating its first hour of local data, use the
  // earliest available point in the current 1h window. This keeps the percentage
  // and the visible sparkline direction consistent instead of showing 0.00% next
  // to a sloped line.
  return { sample: sorted[0] ?? null, label: "1h" };
}

type TrendPoint = readonly [number, number];

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function smoothPath(points: TrendPoint[]): string {
  if (points.length < 2) return "";
  if (points.length === 2) {
    const [a, b] = points;
    const midX = (a[0] + b[0]) / 2;
    return `M ${a[0].toFixed(1)} ${a[1].toFixed(1)} C ${midX.toFixed(1)} ${a[1].toFixed(1)} ${midX.toFixed(1)} ${b[1].toFixed(1)} ${b[0].toFixed(1)} ${b[1].toFixed(1)}`;
  }

  const tension = 0.42;
  let path = `M ${points[0][0].toFixed(1)} ${points[0][1].toFixed(1)}`;

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const dx = p2[0] - p1[0];
    const minCx = p1[0] + dx * 0.18;
    const maxCx = p2[0] - dx * 0.18;
    const c1x = clamp(p1[0] + (p2[0] - p0[0]) * tension / 6, minCx, maxCx);
    const c1y = p1[1] + (p2[1] - p0[1]) * tension / 6;
    const c2x = clamp(p2[0] - (p3[0] - p1[0]) * tension / 6, minCx, maxCx);
    const c2y = p2[1] - (p3[1] - p1[1]) * tension / 6;
    path += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }

  return path;
}

/** Exported for tests; the hook is the only caller in the app. */
export function buildTrendPath(
  samples: ChartSample[],
): Pick<PortfolioTrend, "path" | "areaPath" | "isFlat" | "high" | "low"> {
  const width = 320;
  const height = 118;
  const padX = 8;
  const padY = 22;
  const usableW = width - padX * 2;
  const usableH = height - padY * 2;
  const values = samples.map((s) => s.totalUsd);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const rangePercent = max > 0 ? ((max - min) / max) * 100 : 0;
  const flat =
    !Number.isFinite(min) ||
    !Number.isFinite(max) ||
    max - min < 0.01 ||
    rangePercent < 0.005;
  const minT = Math.min(...samples.map((s) => s.timestamp));
  const maxT = Math.max(...samples.map((s) => s.timestamp));
  const points = samples.map((s, index) => {
    const x =
      maxT === minT
        ? padX + (usableW * index) / Math.max(1, samples.length - 1)
        : padX + ((s.timestamp - minT) / (maxT - minT)) * usableW;
    const y = flat
      ? height / 2
      : padY + (1 - (s.totalUsd - min) / (max - min)) * usableH;
    return [x, y] as const;
  });
  const path =
    points.length > 1
      ? smoothPath(points)
      : `M ${padX} ${height / 2} L ${width - padX} ${height / 2}`;
  const first = points[0] ?? [padX, height / 2];
  const last = points[points.length - 1] ?? [width - padX, height / 2];
  const areaPath = `${path} L ${last[0].toFixed(1)} ${height} L ${first[0].toFixed(1)} ${height} Z`;

  // Peak and trough. A flat line has neither — every point is both, and marking
  // one would claim a high and a low that the wallet never actually had.
  let hi = 0;
  let lo = 0;
  samples.forEach((s, i) => {
    if (s.totalUsd > samples[hi].totalUsd) hi = i;
    if (s.totalUsd < samples[lo].totalUsd) lo = i;
  });
  const extreme = (i: number): TrendExtreme => ({
    xPct: points[i][0] / width,
    yPct: points[i][1] / height,
    totalUsd: samples[i].totalUsd,
    timestamp: samples[i].timestamp,
    deletable: samples[i].persisted,
  });
  const marked = !flat && hi !== lo && points.length > 1;

  return {
    path,
    areaPath,
    isFlat: flat,
    high: marked ? extreme(hi) : null,
    low: marked ? extreme(lo) : null,
  };
}

export function usePortfolioHistory(
  address: string | undefined,
  total: number | null,
  // True while `total` is not yet a complete, comparable figure — still loading,
  // or missing a source that normally counts toward it. Recording is refused
  // until it clears: a partial total is not a smaller portfolio, and writing it
  // to the history puts a permanent false crash in the chart.
  pending: boolean,
): PortfolioTrend & {
  recordNow: () => Promise<void>;
  reload: () => Promise<void>;
  remove: (timestamp: number) => Promise<void>;
} {
  const [snapshots, setSnapshots] = useState<PortfolioSnapshot[]>([]);

  const reload = useCallback(async () => {
    if (!address || !isTauri()) {
      setSnapshots([]);
      return;
    }
    setSnapshots(await invoke<PortfolioSnapshot[]>("get_portfolio_history", { address }));
  }, [address]);

  const recordNow = useCallback(async () => {
    if (!address || total == null || pending || !isTauri()) return;
    const next = await invoke<PortfolioSnapshot[]>("record_portfolio_snapshot", {
      address,
      totalUsd: total,
    });
    setSnapshots(next);
  }, [address, pending, total]);

  const remove = useCallback(
    async (timestamp: number) => {
      if (!address || !isTauri()) return;
      setSnapshots(
        await invoke<PortfolioSnapshot[]>("delete_portfolio_snapshot", {
          address,
          timestamp,
        }),
      );
    },
    [address],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  return useMemo(() => {
    const now = Math.floor(Date.now() / 1000);
    const current: ChartSample | undefined =
      total != null
        ? { address: address ?? "", totalUsd: total, timestamp: now, persisted: false }
        : undefined;
    const stored: ChartSample[] = snapshots
      .filter((s) => s.totalUsd > 0)
      .map((s) => ({ ...s, persisted: true }));
    // Despiked before anything reads them, so the curve, the marked extremes and
    // the 24h baseline all agree about which readings the wallet actually had.
    // The live total goes in first: it is what brackets the newest stored
    // reading, and without it a needle recorded minutes ago has nothing after it
    // to prove it was one.
    const clean = withoutNeedles(current ? [...stored, current] : stored);
    const chartSamples = clean.slice(-80);
    const safeSamples: ChartSample[] =
      chartSamples.length > 0
        ? chartSamples
        : [
            { address: address ?? "", totalUsd: 1, timestamp: now - HOUR, persisted: false },
            { address: address ?? "", totalUsd: 1, timestamp: now, persisted: false },
          ];
    const { sample, label } = current
      ? pickBaseline(
          clean.filter((s) => s.persisted),
          current,
        )
      : { sample: null, label: "1h" as const };
    const percent =
      current && sample && sample.totalUsd > 0
        ? ((current.totalUsd - sample.totalUsd) / sample.totalUsd) * 100
        : null;
    const paths = buildTrendPath(safeSamples);
    return {
      snapshots,
      percent,
      label,
      ...paths,
      recordNow,
      reload,
      remove,
    };
  }, [address, recordNow, reload, remove, snapshots, total]);
}
