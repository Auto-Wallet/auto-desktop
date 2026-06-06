// Fetches the native balance for one address across every chain in the
// registry, in parallel. Each chain resolves independently so a slow or failing
// node never blocks the others — and a failure is surfaced as an explicit error
// row, never a fake zero (VISION/CLAUDE: no fallback masking).

import { useCallback, useEffect, useState } from "react";
import { useChains, type Chain } from "./chains";
import { getBalance } from "./rpc";

export type BalanceState =
  | { status: "loading" }
  | { status: "ok"; wei: string }
  | { status: "error"; message: string };

export type Balances = Record<string, BalanceState>;

const allLoading = (chains: Chain[]): Balances =>
  Object.fromEntries(chains.map((c) => [c.id, { status: "loading" }])) as Balances;

export function useBalances(address: string | undefined) {
  const chains = useChains();
  const [balances, setBalances] = useState<Balances>(() => allLoading(chains));
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    setBalances(allLoading(chains));

    for (const chain of chains) {
      getBalance(chain.id, address)
        .then((wei) => {
          if (cancelled) return;
          setBalances((prev) => ({ ...prev, [chain.id]: { status: "ok", wei } }));
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          const message = err instanceof Error ? err.message : String(err);
          setBalances((prev) => ({ ...prev, [chain.id]: { status: "error", message } }));
        });
    }

    return () => {
      cancelled = true;
    };
  }, [address, nonce, chains]);

  return { balances, refresh };
}
