// Thin client over the XFlows v3 API. Used by the Swap page and the
// background ERC20-approve helper. All requests go to xflows.wanchain.org.
//
// Reference: https://xflows.wanchain.org/api/v3
//
// The API returns `{ success, data }` envelopes; on failure `success: false`
// with `error` populated. We unwrap to `data` and throw on `!success`.

const BASE = 'https://xflows.wanchain.org/api/v3';

export interface XfChain {
  chainId: number;
  chainName: string;
  logo: string;
  symbol: string;
  chainType: string;
  decimals?: number;
}

export interface XfToken {
  chainId?: number;
  decimals: string;
  tokenContractAddress: string;
  tokenLogoUrl: string;
  tokenName: string;
  tokenSymbol: string;
  asciiTokenAddress?: string;
  wanBridgeOnly?: boolean;
}

export interface XfTokensByChain {
  chainId: number;
  tokens: XfToken[];
}

export interface XfFee {
  nativeFeeAmount?: string;
  nativeFeeSymbol?: string;
  nativeFeeDecimals?: number;
  tokenFeeAmount?: string;
  tokenFeeSymbol?: string;
  tokenFeeDecimals?: number;
  tokenFeeContract?: string;
}

export interface XfQuote {
  amountOut: string;
  amountOutRaw: string;
  slippage: number;
  amountOutMin: string;
  amountOutMinRaw: string;
  priceImpact: number;
  approvalAddress?: string;
  workMode: number;
  bridge?: string;
  dex?: string;
  nativeFees: XfFee[];
  tokenFees: XfFee[];
  error?: string;
  extraData?: any;
}

export interface XfBuildTx {
  chainId: number;
  tx: {
    to?: string;
    value?: string;
    data?: string;
    approvalAddress?: string;
  };
}

export interface XfStatus {
  statusCode: number; // 1 Success, 2 Failed, 3 Processing, 4/5 Refunded, 6 Trusteeship, 7 Risk
  statusMsg: string;
  receiveAmount?: string;
  receiveAmountRaw?: string;
  workMode: number;
  error?: string;
  sourceHash?: string;
  destinationHash?: string;
  swapHash?: string;
  refundHash?: string;
  timestamp?: number;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`XFlows ${path} HTTP ${res.status}`);
  const json = await res.json();
  if (json && json.success === false) {
    throw new Error(json.error?.message ?? json.error ?? 'XFlows request failed');
  }
  return json.data as T;
}

async function post<T>(path: string, body: object): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`XFlows ${path} HTTP ${res.status}`);
  const json = await res.json();
  if (json && json.success === false) {
    throw new Error(json.error?.message ?? json.error ?? 'XFlows request failed');
  }
  return json.data as T;
}

export function getSupportedChains(): Promise<XfChain[]> {
  return get<XfChain[]>('/supported/chains');
}

export function getSupportedTokens(): Promise<XfTokensByChain[]> {
  return get<XfTokensByChain[]>('/supported/tokens');
}

export function getSupportedTokensForChain(chainId: number): Promise<XfToken[]> {
  return get<XfToken[]>(`/supported/tokens?chainId=${chainId}`);
}

export interface QuoteRequest {
  fromChainId: number;
  toChainId: number;
  fromTokenAddress: string;
  toTokenAddress: string;
  fromAddress: string;
  toAddress: string;
  fromAmount: string;
  bridge?: string;
  dex?: string;
  slippage?: number;
}

export function getQuote(req: QuoteRequest): Promise<XfQuote> {
  return post<XfQuote>('/quote', req);
}

export function buildTx(req: QuoteRequest & { partner?: string }): Promise<XfBuildTx> {
  return post<XfBuildTx>('/buildTx', req);
}

export interface StatusRequest extends Omit<QuoteRequest, 'slippage'> {
  hash: string;
}

export function getStatus(req: StatusRequest): Promise<XfStatus> {
  return post<XfStatus>('/status', req);
}

/**
 * XFlows returns separate chain IDs for non-EVM networks (Bitcoin, Cardano,
 * Solana, SUI, Tron, XRPL) that don't fit in a 32-bit signed int. This wallet
 * is EVM-only, so we filter them out for both source and destination.
 *
 * EVM chains keep their native chainId (≤ 1_000_000), so any chain with id
 * above that — or explicitly listed below — is non-EVM and skipped.
 */
const NON_EVM_CHAIN_IDS = new Set<number>([
  195,        // Tron
  501,        // Solana
  // Bitcoin / Cardano / SUI / XRPL all use 2^31+ ids and are filtered by range.
]);

export function isEvmChain(chainId: number): boolean {
  if (chainId <= 0) return false;
  if (chainId > 1_000_000) return false;
  if (NON_EVM_CHAIN_IDS.has(chainId)) return false;
  return true;
}

export const NATIVE_TOKEN_ADDRESS = '0x0000000000000000000000000000000000000000';

export function isNativeToken(address: string): boolean {
  return address.toLowerCase() === NATIVE_TOKEN_ADDRESS;
}
