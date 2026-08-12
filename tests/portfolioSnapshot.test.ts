import { describe, expect, test } from "bun:test";
import { isPortfolioTotalPending, type DefiState } from "../src/lib/defi";

// Regression: the wallet recorded a portfolio snapshot as soon as balances and
// prices resolved, while DeFi was still "idle" — it had not even started. For a
// wallet whose value is nearly all DeFi that wrote a tokens-only total into the
// permanent history, so the chart showed a crash to near-zero and back that
// never happened. One real history had samples of $9 and $41k sitting among
// $136k neighbours.
const statuses: DefiState["status"][] = ["idle", "loading", "ok", "error"];

describe("portfolio snapshot gating", () => {
  test("waits for DeFi to succeed before the total counts as final", () => {
    const pendingByStatus = Object.fromEntries(
      statuses.map((status) => [
        status,
        isPortfolioTotalPending({
          balancesLoading: false,
          defiEnabled: true,
          defiStatus: status,
        }),
      ]),
    );

    expect(pendingByStatus).toEqual({
      idle: true,
      loading: true,
      // Only a successful DeFi load makes the number comparable to its
      // neighbours in the history.
      ok: false,
      // On error DeFi contributes no positions at all, so the total is
      // known-incomplete — recording it would fake the same crash.
      error: true,
    });
  });

  test("an account with DeFi switched off records on balances alone", () => {
    for (const status of statuses) {
      expect(
        isPortfolioTotalPending({
          balancesLoading: false,
          defiEnabled: false,
          defiStatus: status,
        }),
      ).toBe(false);
    }
  });

  test("balances still loading always wins, whatever DeFi says", () => {
    for (const defiEnabled of [true, false]) {
      for (const status of statuses) {
        expect(
          isPortfolioTotalPending({
            balancesLoading: true,
            defiEnabled,
            defiStatus: status,
          }),
        ).toBe(true);
      }
    }
  });
});
