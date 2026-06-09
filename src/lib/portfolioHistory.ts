import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { isTauri } from "./platform";

export type PortfolioSnapshot = {
  address: string;
  totalUsd: number;
  timestamp: number;
};

export type PortfolioTrend = {
  snapshots: PortfolioSnapshot[];
  percent: number | null;
  label: "24h" | "1h";
  path: string;
  areaPath: string;
  isFlat: boolean;
};

const HOUR = 60 * 60;
const DAY = 24 * HOUR;

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

function buildTrendPath(samples: PortfolioSnapshot[]): Pick<PortfolioTrend, "path" | "areaPath" | "isFlat"> {
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
  return { path, areaPath, isFlat: flat };
}

export function usePortfolioHistory(
  address: string | undefined,
  total: number | null,
  loading: boolean,
): PortfolioTrend & {
  recordNow: () => Promise<void>;
  reload: () => Promise<void>;
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
    if (!address || total == null || loading || !isTauri()) return;
    const next = await invoke<PortfolioSnapshot[]>("record_portfolio_snapshot", {
      address,
      totalUsd: total,
    });
    setSnapshots(next);
  }, [address, loading, total]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return useMemo(() => {
    const now = Math.floor(Date.now() / 1000);
    const current =
      total != null
        ? { address: address ?? "", totalUsd: total, timestamp: now }
        : undefined;
    const chartSamples = current
      ? [...snapshots.filter((s) => s.totalUsd > 0), current].slice(-80)
      : snapshots.filter((s) => s.totalUsd > 0).slice(-80);
    const safeSamples =
      chartSamples.length > 0
        ? chartSamples
        : [{ address: address ?? "", totalUsd: 1, timestamp: now - HOUR }, { address: address ?? "", totalUsd: 1, timestamp: now }];
    const { sample, label } = current
      ? pickBaseline(snapshots, current)
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
    };
  }, [address, recordNow, reload, snapshots, total]);
}
