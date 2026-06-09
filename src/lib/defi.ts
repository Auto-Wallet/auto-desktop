import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "./platform";

export type DefiPositionToken = {
  symbol: string;
  balance?: string | null;
  balanceUsd?: number | null;
};

export type DefiPosition = {
  id: string;
  appName: string;
  appImageUrl?: string | null;
  appUrl?: string | null;
  networkName: string;
  chainId: string;
  label: string;
  groupLabel?: string | null;
  balanceUsd: number;
  symbols: string[];
  tokens: DefiPositionToken[];
};

export type DefiState =
  | { status: "idle"; positions: DefiPosition[]; error?: undefined }
  | { status: "loading"; positions: DefiPosition[]; error?: undefined }
  | { status: "ok"; positions: DefiPosition[]; error?: undefined }
  | { status: "error"; positions: DefiPosition[]; error: string };

export function useDefiPositions(address: string | undefined): DefiState & {
  refresh: () => Promise<void>;
} {
  const requestRef = useRef(0);
  const mountedRef = useRef(true);
  const [state, setState] = useState<DefiState>({
    status: "idle",
    positions: [],
  });

  useEffect(
    () => () => {
      mountedRef.current = false;
      requestRef.current += 1;
    },
    [],
  );

  const refresh = useCallback(async () => {
    const requestId = ++requestRef.current;
    if (!address || !isTauri()) {
      setState({ status: "idle", positions: [] });
      return;
    }
    setState((prev) => ({ status: "loading", positions: prev.positions }));
    try {
      const positions = await invoke<DefiPosition[]>("get_defi_positions", {
        address,
      });
      if (mountedRef.current && requestId === requestRef.current) {
        setState({ status: "ok", positions });
      }
    } catch (err) {
      if (mountedRef.current && requestId === requestRef.current) {
        setState({
          status: "error",
          positions: [],
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }, [address]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { ...state, refresh };
}
