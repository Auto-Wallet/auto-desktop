import type { ActivityRecord } from "./activity";

export type ExplorerChain = {
  id: string;
  name: string;
  explorerUrl?: string;
};

function txUrlFromBase(base: string, hash: string): string {
  const trimmed = base.trim();
  if (trimmed.includes("{hash}")) return trimmed.replace("{hash}", hash);
  if (trimmed.endsWith("/") || trimmed.endsWith("=")) return `${trimmed}${hash}`;
  return `${trimmed}/${hash}`;
}

export function txExplorerUrl(
  chain: ExplorerChain | undefined,
  record: ActivityRecord,
): string | null {
  return explorerTxUrl(chain, record.chainId, record.chainName, record.hash);
}

/** Explorer link for a bare hash — the swap flow has no ActivityRecord for the
 *  destination-chain transaction, only the hash the provider reports. */
export function explorerTxUrl(
  chain: ExplorerChain | undefined,
  chainId: string,
  chainName: string,
  hash: string,
): string | null {
  if (!hash) return null;
  if (chain?.explorerUrl) return txUrlFromBase(chain.explorerUrl, hash);

  const id = chainId.toLowerCase();
  const name = (chain?.name ?? chainName).toLowerCase();
  const bases: Record<string, string> = {
    "0x1": "https://etherscan.io/tx/",
    "0x2105": "https://basescan.org/tx/",
    "0xa": "https://optimistic.etherscan.io/tx/",
    "0xa4b1": "https://arbiscan.io/tx/",
    "0x89": "https://polygonscan.com/tx/",
    "0x38": "https://bscscan.com/tx/",
    "0xa86a": "https://snowtrace.io/tx/",
    "0xe708": "https://lineascan.build/tx/",
    "0x13e31": "https://blastscan.io/tx/",
    "0x144": "https://era.zksync.network/tx/",
    "0x44d": "https://zkevm.polygonscan.com/tx/",
    "0x92": "https://sonicscan.org/tx/",
    "0xc4": "https://www.oklink.com/xlayer/tx/",
    "0x1e0": "https://worldscan.org/tx/",
    "0x250": "https://astar.subscan.io/evm_transaction/",
    "0x378": "https://wanscan.org/tx/",
    "0x440": "https://andromeda-explorer.metis.io/tx/",
    "0xa4ec": "https://celoscan.io/tx/",
  };
  const base =
    bases[id] ?? (name.includes("0g") ? "https://chainscan.0g.ai/tx/" : null);
  return base ? `${base}${hash}` : null;
}
