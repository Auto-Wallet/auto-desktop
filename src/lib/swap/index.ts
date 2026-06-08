// Provider registry and union helpers. The SwapPage consumes this module
// instead of talking to any single provider directly.

import { RelayProvider } from './relay-provider';
import { XFlowsProvider } from './xflows-provider';
import {
  type NeutralQuote,
  type ProviderChain,
  type ProviderId,
  type ProviderToken,
  type QuoteParams,
  type SwapProvider,
} from './types';

export * from './types';

export const PROVIDERS: SwapProvider[] = [new XFlowsProvider(), new RelayProvider()];

export function getProvider(id: ProviderId): SwapProvider {
  const p = PROVIDERS.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown swap provider: ${id}`);
  return p;
}

export interface MergedChain extends ProviderChain {
  providers: ProviderId[];
}

export interface MergedToken extends ProviderToken {
  providers: ProviderId[];
}

export interface SupportedSets {
  chains: MergedChain[];
  tokensByChain: Map<number, MergedToken[]>;
}

/**
 * Load chains and tokens from every provider and union them. The merged list
 * shows the strict union — UI components can use the `providers` field on
 * each entry to discriminate "both / xflows only / relay only".
 *
 * Dedup keys:
 *   chains: chainId
 *   tokens: chainId + address.toLowerCase()
 *
 * Where multiple providers describe the same entity, we prefer the first
 * non-empty value (name/logo) provider-by-provider so the UI shows the most
 * complete metadata.
 */
export async function loadSupportedSets(): Promise<SupportedSets> {
  const results = await Promise.all(
    PROVIDERS.map(async (p) => {
      try {
        const [chains, tokens] = await Promise.all([p.loadChains(), p.loadTokensByChain()]);
        return { id: p.id, chains, tokens, ok: true as const };
      } catch (err) {
        // Don't fail the whole page just because one provider's metadata is
        // down — still surface the other provider's universe. The error will
        // resurface at quote time anyway, which is more actionable.
        console.warn(`[swap] ${p.id} loadSupportedSets failed`, err);
        return { id: p.id, chains: [] as ProviderChain[], tokens: new Map<number, ProviderToken[]>(), ok: false as const };
      }
    }),
  );

  const chainMap = new Map<number, MergedChain>();
  for (const r of results) {
    for (const c of r.chains) {
      const existing = chainMap.get(c.chainId);
      if (existing) {
        if (!existing.providers.includes(r.id)) existing.providers.push(r.id);
        // Prefer non-empty logo if we didn't have one yet
        if (!existing.logo && c.logo) existing.logo = c.logo;
      } else {
        chainMap.set(c.chainId, { ...c, providers: [r.id] });
      }
    }
  }

  const tokensByChain = new Map<number, MergedToken[]>();
  for (const r of results) {
    for (const [chainId, list] of r.tokens.entries()) {
      let arr = tokensByChain.get(chainId);
      if (!arr) {
        arr = [];
        tokensByChain.set(chainId, arr);
      }
      for (const t of list) {
        const key = t.address.toLowerCase();
        const existing = arr.find((x) => x.address.toLowerCase() === key);
        if (existing) {
          if (!existing.providers.includes(r.id)) existing.providers.push(r.id);
          if (!existing.logo && t.logo) existing.logo = t.logo;
        } else {
          arr.push({ ...t, address: t.address.toLowerCase(), providers: [r.id] });
        }
      }
    }
  }

  return { chains: [...chainMap.values()].sort((a, b) => a.name.localeCompare(b.name)), tokensByChain };
}

export interface QuoteSlot {
  providerId: ProviderId;
  displayName: string;
  loading: boolean;
  quote: NeutralQuote | null;
  error: string | null;
  unsupported: boolean;   // provider doesn't support this chain pair / token
}

/**
 * Pick the "best value" quote across providers.
 *
 * Prefer net USD value (amountOutUsd minus *extra* costs paid on top — e.g.
 * origin-chain gas, dex protocol fees in native currency) when every quoted
 * slot reports it. Comparing raw amountOut alone is misleading when fees
 * vary wildly between providers: a slightly higher output number can easily
 * be eaten by a $2 gas charge.
 *
 * Falls back to amountOutRaw (smallest-unit bigint) when at least one slot
 * lacks USD pricing. Both providers describe the same destination token, so
 * decimals match and a direct comparison is safe.
 */
export function pickBestSlot(slots: QuoteSlot[]): QuoteSlot | null {
  const withQuote = slots.filter((s) => s.quote);
  if (withQuote.length === 0) return null;
  const allHaveNet = withQuote.every((s) => typeof s.quote!.netValueUsd === 'number');
  if (allHaveNet) {
    let best: QuoteSlot | null = null;
    let bestUsd = -Infinity;
    for (const s of withQuote) {
      const v = s.quote!.netValueUsd!;
      if (v > bestUsd) { bestUsd = v; best = s; }
    }
    return best;
  }
  let best: QuoteSlot | null = null;
  let bestRaw = -1n;
  for (const s of withQuote) {
    try {
      const v = BigInt(s.quote!.amountOutRaw);
      if (v > bestRaw) { bestRaw = v; best = s; }
    } catch { /* skip non-numeric */ }
  }
  return best;
}

/**
 * Fire every provider's `getQuote` in parallel and return one slot per
 * provider (loading/quote/error). The caller renders a card per slot.
 * Each slot reports `unsupported: true` if either the from-chain or
 * to-chain isn't covered by that provider — quotes for those are skipped
 * (they'd fail with a noisy 400 otherwise).
 */
export async function fetchAllQuotes(
  params: QuoteParams,
  supportedChainsByProvider: Map<ProviderId, Set<number>>,
): Promise<QuoteSlot[]> {
  const slots: QuoteSlot[] = PROVIDERS.map((p) => ({
    providerId: p.id,
    displayName: p.displayName,
    loading: true,
    quote: null,
    error: null,
    unsupported: false,
  }));
  await Promise.all(
    PROVIDERS.map(async (p, idx) => {
      const slot = slots[idx]!;
      const supported = supportedChainsByProvider.get(p.id);
      if (supported && (!supported.has(params.fromChainId) || !supported.has(params.toChainId))) {
        slot.loading = false;
        slot.unsupported = true;
        return;
      }
      try {
        const q = await p.getQuote(params);
        slot.loading = false;
        slot.quote = q;
      } catch (err) {
        slot.loading = false;
        slot.error = err instanceof Error ? err.message : 'Quote failed';
      }
    }),
  );
  return slots;
}
