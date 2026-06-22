/**
 * How the injected EIP-1193 provider (running in a dApp page) reaches the wallet
 * backend, and how the backend pushes events back. AutoDesktop supplies this via
 * Tauri IPC plus a narrowly-scoped dApp command capability.
 */
export interface ProviderTransport {
  /**
   * Forward an RPC request to the wallet backend and resolve with its result
   * (or reject with a ProviderRpcError-shaped error). `origin` is the dApp origin
   * as seen by the page; the backend should still verify the true caller origin.
   */
  request(args: { method: string; params?: unknown[]; origin: string }): Promise<unknown>;

  /**
   * Subscribe to wallet-pushed events (accountsChanged, chainChanged, …).
   * Returns an unsubscribe function. May be a no-op on platforms that don't push.
   */
  subscribe(handler: (eventName: string, payload: unknown) => void): () => void;
}
