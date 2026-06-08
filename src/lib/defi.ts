import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
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
  refresh: () => void;
} {
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<DefiState>({
    status: "idle",
    positions: [],
  });
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    if (!address || !isTauri()) {
      setState({ status: "idle", positions: [] });
      return;
    }
    setState((prev) => ({ status: "loading", positions: prev.positions }));
    invoke<DefiPosition[]>("get_defi_positions", { address })
      .then((positions) => {
        if (!cancelled) setState({ status: "ok", positions });
      })
      .catch((err) => {
        if (!cancelled) {
          setState({
            status: "error",
            positions: [],
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [address, nonce]);

  return { ...state, refresh };
}
