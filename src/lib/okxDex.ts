import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./platform";

export const OKX_NATIVE_TOKEN_ADDRESS = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

export type OkxChain = {
  chainIndex: string;
  chainName: string;
  dexTokenApproveAddress?: string;
};

export type OkxToken = {
  chainIndex: string;
  decimals: string;
  tokenContractAddress: string;
  tokenLogoUrl?: string;
  tokenName: string;
  tokenSymbol: string;
};

export type OkxTokenInfo = {
  decimal?: string;
  isHoneyPot?: boolean;
  taxRate?: string;
  tokenContractAddress?: string;
  tokenSymbol?: string;
  tokenUnitPrice?: string | null;
};

export type OkxDexRoute = {
  dexProtocol?: {
    dexName?: string;
    percent?: string;
  };
  fromToken?: OkxTokenInfo;
  toToken?: OkxTokenInfo;
};

export type OkxQuote = {
  chainIndex: string;
  swapMode?: string;
  fromTokenAmount: string;
  toTokenAmount: string;
  tradeFee?: string;
  estimateGasFee?: string;
  dexRouterList?: OkxDexRoute[];
  fromToken?: OkxTokenInfo;
  toToken?: OkxTokenInfo;
  priceImpactPercent?: string;
};

export type OkxTx = {
  from?: string;
  gas?: string;
  gasPrice?: string;
  maxPriorityFeePerGas?: string;
  to: string;
  value: string;
  data: string;
  minReceiveAmount?: string;
  maxSpendAmount?: string;
  slippagePercent?: string;
};

export type OkxSwap = {
  routerResult: OkxQuote;
  tx: OkxTx;
};

export type OkxApproveTransaction = {
  data: string;
  dexContractAddress: string;
  gasLimit?: string;
  gasPrice?: string;
};

export type OkxHistory = {
  chainIndex: string;
  txHash: string;
  status: "pending" | "success" | "fail" | string;
  txType?: string;
  errorMsg?: string;
  fromTokenDetails?: { symbol?: string; amount?: string; tokenAddress?: string };
  toTokenDetails?: { symbol?: string; amount?: string; tokenAddress?: string };
};

type OkxEnvelope<T> = {
  code: string;
  msg?: string;
  data: T;
};

export type OkxQuoteParams = {
  chainIndex: string;
  amount: string;
  fromTokenAddress: string;
  toTokenAddress: string;
  swapMode?: "exactIn" | "exactOut";
  priceImpactProtectionPercent?: string;
};

export type OkxSwapParams = OkxQuoteParams & {
  slippagePercent: string;
  userWalletAddress: string;
};

function unwrapList<T>(res: OkxEnvelope<T[]>): T[] {
  if (res.code !== "0") throw new Error(res.msg || `OKX DEX error ${res.code}`);
  return Array.isArray(res.data) ? res.data : [];
}

function unwrapValue<T>(res: OkxEnvelope<T>): T {
  if (res.code !== "0") throw new Error(res.msg || `OKX DEX error ${res.code}`);
  return res.data;
}

async function okxInvoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!isTauri()) throw new Error("OKX DEX is available in the desktop app.");
  return invoke<T>(command, args);
}

export async function okxSupportedChains(): Promise<OkxChain[]> {
  return unwrapList(await okxInvoke<OkxEnvelope<OkxChain[]>>("okx_dex_supported_chains"));
}

export async function okxTokens(chainIndex: string): Promise<OkxToken[]> {
  return unwrapList(await okxInvoke<OkxEnvelope<OkxToken[]>>("okx_dex_tokens", { chainIndex }));
}

export async function okxQuote(params: OkxQuoteParams): Promise<OkxQuote> {
  const list = unwrapList(await okxInvoke<OkxEnvelope<OkxQuote[]>>("okx_dex_quote", { req: params }));
  if (!list[0]) throw new Error("OKX DEX returned no quote.");
  return list[0];
}

export async function okxSwap(params: OkxSwapParams): Promise<OkxSwap> {
  const list = unwrapList(await okxInvoke<OkxEnvelope<OkxSwap[]>>("okx_dex_swap", { req: params }));
  if (!list[0]) throw new Error("OKX DEX returned no swap transaction.");
  return list[0];
}

export async function okxApproveTransaction(
  chainIndex: string,
  tokenContractAddress: string,
  approveAmount: string,
): Promise<OkxApproveTransaction> {
  const list = unwrapList(
    await okxInvoke<OkxEnvelope<OkxApproveTransaction[]>>("okx_dex_approve_transaction", {
      chainIndex,
      tokenContractAddress,
      approveAmount,
    }),
  );
  if (!list[0]) throw new Error("OKX DEX returned no approval transaction.");
  return list[0];
}

export async function okxHistory(chainIndex: string, txHash: string): Promise<OkxHistory | null> {
  const data = unwrapValue(await okxInvoke<OkxEnvelope<OkxHistory | OkxHistory[] | null>>("okx_dex_history", {
    chainIndex,
    txHash,
  }));
  if (Array.isArray(data)) return data[0] ?? null;
  return data ?? null;
}

export function okxTokenAddress(address: string | undefined): string {
  if (!address) return OKX_NATIVE_TOKEN_ADDRESS;
  return address.toLowerCase();
}
