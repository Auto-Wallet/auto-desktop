export type SearchableChain = {
  id: string;
  name: string;
  symbol: string;
};

export function filterChains<T extends SearchableChain>(chains: readonly T[], query: string): T[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return [...chains];

  return chains.filter((chain) => {
    const numericId = Number.parseInt(chain.id, 16).toString(10);
    return [chain.name, chain.symbol, chain.id, numericId]
      .some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
  });
}
