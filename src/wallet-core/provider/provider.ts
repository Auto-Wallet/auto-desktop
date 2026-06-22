import type { ProviderTransport } from '../adapters/transport';
import type { ProviderRpcError, RequestArguments } from '../types/eip1193';

type EventHandler = (...args: unknown[]) => void;

/**
 * EIP-1193 provider injected into dApp pages as `window.ethereum`. Transport-
 * agnostic: all RPC goes through the injected {@link ProviderTransport}, keeping
 * page-facing provider behavior separate from the Tauri backend.
 *
 * The old postMessage bridge shape was replaced by the transport abstraction.
 */
export class AutoWalletProvider {
  readonly isAutoWallet = true;
  /**
   * Set to `true` at injection time only when we're the sole provider on the page,
   * so legacy "Connect Wallet" buttons that look for MetaMask still work. Never
   * impersonate when another wallet is present.
   */
  isMetaMask = false;

  private readonly _events = new Map<string, Set<EventHandler>>();
  private readonly _transport: ProviderTransport;
  private _chainId = '0x1';
  private _accounts: string[] = [];

  constructor(transport: ProviderTransport) {
    this._transport = transport;
    this._transport.subscribe((name, payload) => this._handleEvent(name, payload));
    void this._init();
  }

  /** Proactively fetch state so dApps see the connected account after a reload. */
  private async _init(): Promise<void> {
    try {
      const accounts = (await this.request({ method: 'eth_accounts' })) as string[];
      if (accounts?.length) this._accounts = accounts;
      await this.request({ method: 'eth_chainId' }); // request() caches the result
    } catch {
      /* not connected yet — fine */
    }
  }

  get chainId(): string {
    return this._chainId;
  }

  get selectedAddress(): string | null {
    return this._accounts[0] ?? null;
  }

  // EIP-1193
  async request(args: RequestArguments): Promise<unknown> {
    const method = args.method;
    const params = (Array.isArray(args.params) ? args.params : []) as unknown[];

    const origin = typeof location !== 'undefined' ? location.origin : '';
    const result = await this._transport.request({ method, params, origin });

    // Keep local cache + emit events in sync with backend responses.
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') {
      this._accounts = (result as string[]) ?? this._accounts;
    } else if (method === 'eth_chainId') {
      // Cache only a well-formed id — a junk response must not poison the cache.
      const normalized = normalizeChainId(typeof result === 'string' ? result : undefined);
      if (normalized) this._chainId = normalized;
    } else if (method === 'wallet_switchEthereumChain') {
      // The backend accepted the switch. Cache/emit the CANONICAL 0x-hex id —
      // dApps send sloppy notations ('0XA4B1', '137') and caching those raw
      // would desync `provider.chainId` from what eth_chainId returns. A junk
      // id that somehow got past the backend is ignored rather than cached.
      const p = params[0] as { chainId?: string } | undefined;
      const normalized = normalizeChainId(p?.chainId);
      if (normalized && normalized !== this._chainId) {
        this._chainId = normalized;
        this._emit('chainChanged', normalized);
      }
    }
    return result;
  }

  // Legacy: enable() == eth_requestAccounts
  enable(): Promise<string[]> {
    return this.request({ method: 'eth_requestAccounts' }) as Promise<string[]>;
  }

  // Legacy: send / sendAsync
  send(methodOrPayload: string | { method: string; params?: unknown[]; id?: unknown }, paramsOrCallback?: unknown[] | ((...a: unknown[]) => void)): unknown {
    if (typeof methodOrPayload === 'string') {
      return this.request({ method: methodOrPayload, params: paramsOrCallback as unknown[] });
    }
    const payload = methodOrPayload;
    if (typeof paramsOrCallback === 'function') {
      const cb = paramsOrCallback;
      this.request({ method: payload.method, params: payload.params })
        .then((result) => cb(null, { id: payload.id, jsonrpc: '2.0', result }))
        .catch((err) => cb(err));
      return;
    }
    return this.request({ method: payload.method, params: payload.params });
  }

  sendAsync(payload: { method: string; params?: unknown[]; id?: unknown }, callback: (...a: unknown[]) => void): void {
    this.request({ method: payload.method, params: payload.params })
      .then((result) => callback(null, { id: payload.id, jsonrpc: '2.0', result }))
      .catch((err) => callback(err));
  }

  // EIP-1193 events
  on(event: string, handler: EventHandler): this {
    if (!this._events.has(event)) this._events.set(event, new Set());
    this._events.get(event)!.add(handler);
    return this;
  }

  removeListener(event: string, handler: EventHandler): this {
    this._events.get(event)?.delete(handler);
    return this;
  }

  removeAllListeners(event?: string): this {
    if (event) this._events.delete(event);
    else this._events.clear();
    return this;
  }

  private _emit(event: string, ...args: unknown[]): void {
    this._events.get(event)?.forEach((handler) => {
      try {
        handler(...args);
      } catch (e) {
        console.error('[Auto Wallet] event handler error:', e);
      }
    });
  }

  private _handleEvent(eventName: string, payload: unknown): void {
    if (eventName === 'accountsChanged') {
      this._accounts = (payload as string[]) ?? [];
    } else if (eventName === 'chainChanged') {
      this._chainId = payload as string;
    }
    this._emit(eventName, payload);
  }
}

export function isProviderRpcError(e: unknown): e is ProviderRpcError {
  return e instanceof Error && typeof (e as ProviderRpcError).code === 'number';
}

/** '0XA4B1' / '137' / '0x89' → canonical lowercase 0x-hex; null if unparseable. */
function normalizeChainId(id: string | undefined): string | null {
  if (!id) return null;
  const s = id.trim();
  const value = /^0x[0-9a-fA-F]+$/i.test(s)
    ? BigInt(s.toLowerCase())
    : /^[0-9]+$/.test(s)
      ? BigInt(s)
      : null;
  return value && value > 0n ? `0x${value.toString(16)}` : null;
}
