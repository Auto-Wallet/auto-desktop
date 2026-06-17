import { invoke } from "@tauri-apps/api/core";
import type React from "react";
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

export type DefiSource = "Zapper" | "DeBank";
type DefiPositionsResponse = {
  source: DefiSource;
  positions: DefiPosition[];
};

const DEFI_CLIENT_TIMEOUT_MS = 30_000;
const defiInFlightByKey = new Map<string, Promise<DefiPositionsResponse>>();
const defiStateByAddress = new Map<string, DefiState>();
const defiStateListenersByAddress = new Map<string, Set<(state: DefiState) => void>>();

export type DefiState =
  | { status: "idle"; positions: DefiPosition[]; source?: DefiSource; error?: undefined }
  | { status: "loading"; positions: DefiPosition[]; source?: DefiSource; error?: undefined }
  | { status: "ok"; positions: DefiPosition[]; source: DefiSource; error?: undefined }
  | { status: "error"; positions: DefiPosition[]; source?: DefiSource; error: string };

export function useDefiPositions(
  address: string | undefined,
  hasWalletAssetsOverOneUsd: boolean | undefined = false,
  enabled = true,
): DefiState & {
  refresh: (force?: boolean) => Promise<void>;
} {
  const controllerRef = useRef<DefiRefreshController | null>(null);
  const [state, setState] = useState<DefiState>({
    status: "idle",
    positions: [],
  });
  if (!controllerRef.current) {
    controllerRef.current = createDefiRefreshController({
      isAvailable: isTauri,
      invokeDefiPositions: (request) =>
        invoke<DefiPositionsResponse>("get_defi_positions", request),
      setState,
      log: console,
    });
  }

  useEffect(
    () => () => {
      controllerRef.current?.dispose();
    },
    [],
  );
  useEffect(() => {
    if (!enabled) {
      setState({ status: "idle", positions: [] });
      return undefined;
    }
    if (!address) return undefined;
    const cached = getCachedDefiState(address);
    if (cached) setState(cached);
    return subscribeDefiState(address, setState);
  }, [address, enabled]);

  const refresh = useCallback(async (force = false) => {
    await controllerRef.current?.refresh({
      address,
      hasWalletAssetsOverOneUsd,
      enabled,
      force,
    });
  }, [address, hasWalletAssetsOverOneUsd, enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { ...state, refresh };
}

type DefiRefreshRequest = {
  address: string;
  hasWalletAssetsOverOneUsd: boolean;
};

type DefiRefreshInput = {
  address: string | undefined;
  hasWalletAssetsOverOneUsd: boolean | undefined;
  enabled?: boolean;
  force?: boolean;
};

type DefiRefreshControllerDeps = {
  isAvailable: () => boolean;
  invokeDefiPositions: (request: DefiRefreshRequest) => Promise<DefiPositionsResponse>;
  setState: React.Dispatch<React.SetStateAction<DefiState>>;
  timeoutMs?: number;
  log?: Pick<Console, "info" | "warn">;
};

export type DefiRefreshController = {
  refresh: (input: DefiRefreshInput) => Promise<void>;
  dispose: () => void;
};

export function createDefiRefreshController({
  isAvailable,
  invokeDefiPositions,
  setState,
  timeoutMs = DEFI_CLIENT_TIMEOUT_MS,
  log,
}: DefiRefreshControllerDeps): DefiRefreshController {
  let requestId = 0;
  let mounted = true;
  let inFlightKey: string | null = null;
  let activeAddress: string | null = null;

  return {
    async refresh({
      address,
      hasWalletAssetsOverOneUsd,
      enabled = true,
      force = false,
    }: DefiRefreshInput) {
      if (!enabled || !address || !isAvailable()) {
        requestId += 1;
        inFlightKey = null;
        activeAddress = null;
        setState({ status: "idle", positions: [] });
        return;
      }
      const normalizedAddress = address.toLowerCase();
      activeAddress = normalizedAddress;
      if (hasWalletAssetsOverOneUsd === undefined) {
        setState((prev) =>
          prev.positions.length > 0 || prev.status === "loading"
            ? prev
            : { status: "idle", positions: [] },
        );
        return;
      }

      const requestKey = defiRequestKey(address, hasWalletAssetsOverOneUsd);
      if (!force && inFlightKey === requestKey) {
        log?.info("[AutoDesktop] DeFi refresh skipped duplicate", {
          address,
          hasWalletAssetsOverOneUsd,
          requestKey,
        });
        return;
      }

      const currentRequestId = ++requestId;
      inFlightKey = requestKey;
      const startedAt = Date.now();
      log?.info("[AutoDesktop] DeFi refresh start", {
        address,
        hasWalletAssetsOverOneUsd,
        requestId: currentRequestId,
        requestKey,
        force,
      });
      setState((prev) => ({ status: "loading", positions: prev.positions, source: prev.source }));

      try {
        const result = await getDefiPositionsWithSingleFlight({
          requestKey,
          request: { address, hasWalletAssetsOverOneUsd },
          invokeDefiPositions,
          timeoutMs,
          force,
        });
        log?.info("[AutoDesktop] DeFi refresh done", {
          address,
          requestId: currentRequestId,
          source: result.source,
          positions: result.positions.length,
          elapsedMs: Date.now() - startedAt,
        });
        const nextState = publishDefiState(address, {
          status: "ok",
          positions: result.positions,
          source: result.source,
        });
        log?.info("[AutoDesktop] DeFi state published", {
          address,
          source: nextState.source,
          positions: nextState.positions.length,
          requestId: currentRequestId,
          currentRequestId: requestId,
        });
        if (mounted && activeAddress === normalizedAddress) {
          setState(nextState);
        } else {
          log?.info("[AutoDesktop] DeFi refresh stale result ignored", {
            address,
            requestId: currentRequestId,
            currentRequestId: requestId,
            requestKey,
            activeAddress,
          });
        }
      } catch (err) {
        log?.warn("[AutoDesktop] DeFi refresh failed", {
          address,
          requestId: currentRequestId,
          elapsedMs: Date.now() - startedAt,
          error: err instanceof Error ? err.message : String(err),
        });
        if (mounted && currentRequestId === requestId) {
          setState((prev) =>
            prev.positions.length > 0
              ? prev
              : {
                  status: "error",
                  positions: [],
                  error: err instanceof Error ? err.message : String(err),
                },
          );
        } else {
          log?.info("[AutoDesktop] DeFi refresh stale error ignored", {
            address,
            requestId: currentRequestId,
            currentRequestId: requestId,
            requestKey,
          });
        }
      } finally {
        if (inFlightKey === requestKey) {
          inFlightKey = null;
        }
      }
    },

    dispose() {
      mounted = false;
      requestId += 1;
      inFlightKey = null;
      activeAddress = null;
    },
  };
}

function defiRequestKey(address: string, hasWalletAssetsOverOneUsd: boolean): string {
  return `${address.toLowerCase()}:${hasWalletAssetsOverOneUsd ? "assets" : "no-assets"}`;
}

function getCachedDefiState(address: string): DefiState | undefined {
  return defiStateByAddress.get(address.toLowerCase());
}

function subscribeDefiState(
  address: string,
  listener: (state: DefiState) => void,
): () => void {
  const key = address.toLowerCase();
  let listeners = defiStateListenersByAddress.get(key);
  if (!listeners) {
    listeners = new Set();
    defiStateListenersByAddress.set(key, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners?.delete(listener);
    if (listeners?.size === 0) defiStateListenersByAddress.delete(key);
  };
}

function publishDefiState(address: string, state: DefiState): DefiState {
  const key = address.toLowerCase();
  const previous = defiStateByAddress.get(key);
  const next =
    state.status === "ok" &&
    state.positions.length === 0 &&
    previous?.status === "ok" &&
    previous.positions.length > 0
      ? previous
      : state;
  defiStateByAddress.set(key, next);
  const listeners = defiStateListenersByAddress.get(key);
  if (listeners) {
    for (const listener of listeners) listener(next);
  }
  return next;
}

export function clearDefiStateCacheForTests(): void {
  defiInFlightByKey.clear();
  defiStateByAddress.clear();
  defiStateListenersByAddress.clear();
}

function getDefiPositionsWithSingleFlight({
  requestKey,
  request,
  invokeDefiPositions,
  timeoutMs,
  force,
}: {
  requestKey: string;
  request: DefiRefreshRequest;
  invokeDefiPositions: (request: DefiRefreshRequest) => Promise<DefiPositionsResponse>;
  timeoutMs: number;
  force: boolean;
}): Promise<DefiPositionsResponse> {
  if (!force) {
    const existing = defiInFlightByKey.get(requestKey);
    if (existing) return existing;
  }

  const promise = withTimeout(
    invokeDefiPositions(request),
    timeoutMs,
    "DeFi request timed out after 30s",
  );
  defiInFlightByKey.set(requestKey, promise);
  const clearIfCurrent = () => {
    if (defiInFlightByKey.get(requestKey) === promise) {
      defiInFlightByKey.delete(requestKey);
    }
  };
  promise.then(clearIfCurrent, clearIfCurrent);
  return promise;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        globalThis.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        globalThis.clearTimeout(timer);
        reject(error);
      },
    );
  });
}
