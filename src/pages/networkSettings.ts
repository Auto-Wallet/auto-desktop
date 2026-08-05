export type SettingsChainSearchTarget = {
  id: string;
  name: string;
  symbol: string;
  rpc: string;
  explorerUrl?: string;
};

export function filterSettingsChains<T extends SettingsChainSearchTarget>(
  chains: readonly T[],
  query: string,
): T[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...chains];

  return chains.filter((chain) => {
    const decimalId = Number.parseInt(chain.id, 16).toString(10);
    return [
      chain.name,
      chain.symbol,
      chain.id,
      decimalId,
      chain.rpc,
      chain.explorerUrl ?? "",
    ].some((value) => value.toLocaleLowerCase().includes(needle));
  });
}
