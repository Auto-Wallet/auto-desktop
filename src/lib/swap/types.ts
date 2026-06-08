// Neutral types shared by all swap providers (XFlows, Relay, …). Each
// provider implements `SwapProvider` and exposes its own client elsewhere.

export type ProviderId = 'xflows' | 'relay';

export interface ProviderChain {
  chainId: number;
  name: string;
  logo: string;
  nativeSymbol: string;
}

export interface ProviderToken {
  chainId: number;
  address: string;           // checksummed or lowercased; native = 0x000…000
  symbol: string;
  name: string;
  decimals: number;
  logo: string;
}

export interface QuoteParams {
  fromChainId: number;
  toChainId: number;
  fromToken: ProviderToken;
  toToken: ProviderToken;
  fromAddress: string;
  toAddress: string;
  fromAmount: string;        // human-readable (e.g. "1.5")
  slippage: number;          // 0.01 = 1%
}

export interface NeutralFee {
  label: string;             // "Network fee", "Bridge fee", "App fee", …
  amount: string;            // human-readable
  symbol: string;
}

export interface NeutralQuote {
  providerId: ProviderId;
  amountOut: string;         // human-readable
  amountOutRaw: string;      // smallest unit
  amountOutMin: string;
  amountOutMinRaw: string;
  priceImpact?: number;      // percent (e.g. 0.32 for 0.32%)
  rate?: string;
  fees: NeutralFee[];
  routeDescription?: string;
  estimatedTimeSeconds?: number;
  approvalSpender?: string;  // ERC20 spender we need to approve, if any
  // Net USD value: amountOutUsd minus any *extra* costs the user pays on top
  // of the input (gas + provider fees paid in native currency). Fees that
  // are already deducted from amountOut (relay/app/bridge fees) are NOT
  // re-subtracted here — that would double-count. Higher is better.
  // Undefined when the provider doesn't report USD prices.
  netValueUsd?: number;
  amountOutUsd?: number;     // for display only
  raw: unknown;              // opaque payload for prepareSwap
}

export interface PreparedTx {
  to: string;
  data: string;
  value: string;             // hex (0x…) or decimal string
  chainId: number;
}

export interface PreparedSwap {
  providerId: ProviderId;
  swapTx: PreparedTx;
  requestId?: string;        // Relay needs this for /intents/status polling
}

export type SwapState = 'pending' | 'success' | 'failed' | 'refunded';

export interface NeutralStatus {
  state: SwapState;
  message: string;
  sourceHash?: string;
  destHash?: string;
  receiveAmount?: string;    // human-readable
  receiveSymbol?: string;
  hint?: string;             // optional UI hint (e.g. trusteeship instructions)
}

export interface StatusArgs {
  params: QuoteParams;
  sourceHash: string;
  requestId?: string;
}

export interface SwapProvider {
  id: ProviderId;
  displayName: string;
  loadChains(): Promise<ProviderChain[]>;
  loadTokensByChain(): Promise<Map<number, ProviderToken[]>>;
  getQuote(params: QuoteParams): Promise<NeutralQuote>;
  prepareSwap(params: QuoteParams, quote: NeutralQuote): Promise<PreparedSwap>;
  getStatus(args: StatusArgs): Promise<NeutralStatus>;
}

export const NATIVE_TOKEN_ADDRESS = '0x0000000000000000000000000000000000000000';

export function isNativeAddress(address: string): boolean {
  return address.toLowerCase() === NATIVE_TOKEN_ADDRESS;
}

/**
 * EVM-only filter shared by all providers. Both XFlows and Relay return
 * non-EVM chains (Solana/Bitcoin/TON/Tron/Sui/…) that this wallet can't sign
 * for, so we drop them at the data layer.
 */
const NON_EVM_CHAIN_IDS = new Set<number>([
  195, // Tron
  501, // Solana
]);

export function isEvmChainId(chainId: number): boolean {
  if (!Number.isFinite(chainId) || chainId <= 0) return false;
  if (chainId > 1_000_000) return false;
  if (NON_EVM_CHAIN_IDS.has(chainId)) return false;
  return true;
}
