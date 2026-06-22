// EIP-1193 (provider) + EIP-6963 (multi-wallet discovery) types.

export interface RequestArguments {
  method: string;
  params?: unknown[] | object;
}

export interface ProviderRpcError extends Error {
  code: number;
  data?: unknown;
}

export type ProviderEvent =
  | 'accountsChanged'
  | 'chainChanged'
  | 'connect'
  | 'disconnect'
  | 'message';

/** EIP-6963 provider metadata announced for wallet discovery. */
export interface EIP6963ProviderInfo {
  /** Globally unique id for this provider instance (UUID v4). */
  uuid: string;
  /** Human-readable wallet name. */
  name: string;
  /** Data URI icon (square). */
  icon: string;
  /** Reverse-DNS wallet identifier, e.g. "com.auto-wallet". */
  rdns: string;
}
