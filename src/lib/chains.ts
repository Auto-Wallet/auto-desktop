// Frontend chain registry. Mirrors the Rust registry in src-tauri/src/lib.rs
// (`const CHAINS`) — same ids and RPC endpoints — plus display metadata the
// backend doesn't need (native token symbol, brand color). Keep the two in sync.

export type Chain = {
  /** EIP-155 chain id as a 0x-hex string (what dApps see via eth_chainId). */
  id: string;
  name: string;
  rpc: string;
  /** Native gas-token symbol shown in the Wallet page. */
  symbol: string;
  /** Native token decimals (always 18 for these EVM chains). */
  decimals: number;
  /** Brand color for the chain dot/badge. */
  color: string;
};

export const CHAINS: Chain[] = [
  { id: "0x1",    name: "Ethereum",     rpc: "https://ethereum-rpc.publicnode.com",    symbol: "ETH", decimals: 18, color: "#627EEA" },
  { id: "0x2105", name: "Base",         rpc: "https://base-rpc.publicnode.com",        symbol: "ETH", decimals: 18, color: "#0052FF" },
  { id: "0xa",    name: "OP Mainnet",   rpc: "https://optimism-rpc.publicnode.com",    symbol: "ETH", decimals: 18, color: "#FF0420" },
  { id: "0xa4b1", name: "Arbitrum One", rpc: "https://arbitrum-one-rpc.publicnode.com", symbol: "ETH", decimals: 18, color: "#28A0F0" },
  { id: "0x89",   name: "Polygon",      rpc: "https://polygon-bor-rpc.publicnode.com", symbol: "POL", decimals: 18, color: "#8247E5" },
];

export function findChain(id: string): Chain | undefined {
  const want = id.toLowerCase();
  return CHAINS.find((c) => c.id.toLowerCase() === want);
}
