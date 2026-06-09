import { beforeEach, describe, expect, test } from "bun:test";
import {
  clearDefiStateCacheForTests,
  createDefiRefreshController,
  type DefiPosition,
  type DefiState,
} from "../src/lib/defi";

const ADDRESS_A = "0x7521eda00e2ce05ac4a9d8353d096ccb970d5188";
const ADDRESS_B = "0x2fb4d46372ea1748ec3c29bd2c7b536019df5200";
const ADDRESS_C = "0x1111111111111111111111111111111111111111";

beforeEach(() => {
  clearDefiStateCacheForTests();
});

describe("DeFi refresh state", () => {
  test("sets ok with DeBank positions after a successful refresh", async () => {
    const harness = createHarness();

    await harness.controller.refresh({
      address: ADDRESS_A,
      hasWalletAssetsOverOneUsd: true,
    });

    expect(harness.state).toEqual({
      status: "ok",
      positions: [position("debank-1")],
      source: "DeBank",
    });
  });

  test("keeps the settled DeFi state while wallet asset signal is pending", async () => {
    const harness = createHarness({
      initialState: {
        status: "ok",
        positions: [position("existing")],
        source: "DeBank",
      },
    });

    await harness.controller.refresh({
      address: ADDRESS_A,
      hasWalletAssetsOverOneUsd: undefined,
    });

    expect(harness.state).toEqual({
      status: "ok",
      positions: [position("existing")],
      source: "DeBank",
    });
  });

  test("does not stale an in-flight DeBank refresh while wallet asset signal is pending", async () => {
    const debankRequest = deferred<ReturnType<typeof response>>();
    const harness = createHarness({
      invokeDefiPositions: () => debankRequest.promise,
    });

    const refresh = harness.controller.refresh({
      address: ADDRESS_A,
      hasWalletAssetsOverOneUsd: true,
    });
    await harness.controller.refresh({
      address: ADDRESS_A,
      hasWalletAssetsOverOneUsd: undefined,
    });

    debankRequest.resolve(response("DeBank", [position("debank-after-pending")]));
    await refresh;

    expect(harness.state).toEqual({
      status: "ok",
      positions: [position("debank-after-pending")],
      source: "DeBank",
    });
  });

  test("applies a non-empty stale success for the active address", async () => {
    const debankRequest = deferred<ReturnType<typeof response>>();
    const newerRequest = deferred<ReturnType<typeof response>>();
    const harness = createHarness({
      invokeDefiPositions: ({ hasWalletAssetsOverOneUsd }) =>
        hasWalletAssetsOverOneUsd ? debankRequest.promise : newerRequest.promise,
    });

    const debankRefresh = harness.controller.refresh({
      address: ADDRESS_A,
      hasWalletAssetsOverOneUsd: true,
    });
    const newerRefresh = harness.controller.refresh({
      address: ADDRESS_A,
      hasWalletAssetsOverOneUsd: false,
    });

    debankRequest.resolve(response("DeBank", [position("stale-but-useful")]));
    await debankRefresh;

    expect(harness.state).toEqual({
      status: "ok",
      positions: [position("stale-but-useful")],
      source: "DeBank",
    });

    newerRequest.resolve(response("Zapper", []));
    await newerRefresh;

    expect(harness.state).toEqual({
      status: "ok",
      positions: [position("stale-but-useful")],
      source: "DeBank",
    });
  });

  test("ignores an older failed request after a newer request succeeds", async () => {
    const falseRequest = deferred<ReturnType<typeof response>>();
    const trueRequest = deferred<ReturnType<typeof response>>();
    const harness = createHarness({
      invokeDefiPositions: ({ hasWalletAssetsOverOneUsd }) =>
        hasWalletAssetsOverOneUsd ? trueRequest.promise : falseRequest.promise,
    });

    const older = harness.controller.refresh({
      address: ADDRESS_B,
      hasWalletAssetsOverOneUsd: false,
    });
    const newer = harness.controller.refresh({
      address: ADDRESS_B,
      hasWalletAssetsOverOneUsd: true,
    });

    trueRequest.resolve(response("DeBank", [position("newer")]));
    await newer;
    falseRequest.reject(new Error("Zapper unavailable"));
    await older;

    expect(harness.state).toEqual({
      status: "ok",
      positions: [position("newer")],
      source: "DeBank",
    });
  });

  test("shares the same in-flight request across StrictMode-style duplicate controllers", async () => {
    const shared = deferred<ReturnType<typeof response>>();
    let calls = 0;
    const invokeDefiPositions = () => {
      calls += 1;
      return shared.promise;
    };
    const first = createHarness({ invokeDefiPositions });
    const second = createHarness({ invokeDefiPositions });

    const firstRefresh = first.controller.refresh({
      address: ADDRESS_C,
      hasWalletAssetsOverOneUsd: true,
    });
    const secondRefresh = second.controller.refresh({
      address: ADDRESS_C,
      hasWalletAssetsOverOneUsd: true,
    });

    expect(calls).toBe(1);
    shared.resolve(response("DeBank", [position("shared")]));
    await Promise.all([firstRefresh, secondRefresh]);

    expect(first.state.status).toBe("ok");
    expect(second.state.status).toBe("ok");
    expect(first.state.positions).toEqual([position("shared")]);
    expect(second.state.positions).toEqual([position("shared")]);
  });
});

function createHarness({
  initialState = { status: "idle", positions: [] },
  invokeDefiPositions = async () => response("DeBank", [position("debank-1")]),
}: {
  initialState?: DefiState;
  invokeDefiPositions?: Parameters<typeof createDefiRefreshController>[0]["invokeDefiPositions"];
} = {}) {
  let state = initialState;
  const setState: Parameters<typeof createDefiRefreshController>[0]["setState"] = (next) => {
    state =
      typeof next === "function"
        ? (next as (prev: DefiState) => DefiState)(state)
        : next;
  };
  const controller = createDefiRefreshController({
    isAvailable: () => true,
    invokeDefiPositions,
    setState,
  });

  return {
    controller,
    get state() {
      return state;
    },
  };
}

function response(source: "Zapper" | "DeBank", positions: DefiPosition[]) {
  return { source, positions };
}

function position(id: string): DefiPosition {
  return {
    id,
    appName: "Aave",
    networkName: "Ethereum",
    chainId: "1",
    label: "Lending",
    balanceUsd: 12.34,
    symbols: ["USDC"],
    tokens: [{ symbol: "USDC", balanceUsd: 12.34 }],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
