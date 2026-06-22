import type { ProviderTransport } from '../adapters/transport';
import type { EIP6963ProviderInfo } from '../types/eip1193';
import { AutoWalletProvider } from './provider';

const BLOCKED_PROVIDER_HOSTS = new Set(['docs.google.com']);

/** AutoDesktop injection policy: http/https only, minus a blocklist. */
export function isProviderInjectionAllowed(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return !BLOCKED_PROVIDER_HOSTS.has(url.hostname.toLowerCase());
}

// Compact placeholder brand icon (swap for the real Auto Wallet PNG later).
const DEFAULT_ICON =
  'data:image/svg+xml;base64,' +
  btoaSafe(
    '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">' +
      '<rect width="96" height="96" rx="22" fill="#5b8cff"/>' +
      '<text x="50%" y="56%" text-anchor="middle" dominant-baseline="middle" ' +
      'font-family="system-ui,Arial" font-size="52" font-weight="700" fill="#fff">A</text>' +
      '</svg>',
  );

function btoaSafe(s: string): string {
  if (typeof btoa === 'function') return btoa(s);
  // Non-browser fallback (build/test only).
  return Buffer.from(s, 'binary').toString('base64');
}

export const DEFAULT_PROVIDER_INFO: EIP6963ProviderInfo = {
  uuid: '10a4b7f8-3c2d-4e5a-9f6b-1d2e3f4a5b6c',
  name: 'Auto Wallet',
  icon: DEFAULT_ICON,
  rdns: 'com.auto-wallet',
};

export interface InstallOptions {
  /** Override EIP-6963 metadata (name/icon/rdns/uuid). */
  info?: Partial<EIP6963ProviderInfo>;
  /** Overwrite an existing `window.ethereum` even if another wallet set it. */
  forceInject?: boolean;
  /** Skip the http/https + blocklist policy check (default: enforce it). */
  skipPolicy?: boolean;
  /**
   * Make `window.ethereum` non-replaceable and freeze the provider's prototype,
   * so page scripts can't swap in or patch a fake provider. Use where this
   * wallet is guaranteed to be the only one (the AutoDesktop dapp webview).
   */
  lockEthereum?: boolean;
}

/**
 * Create the provider, announce it via EIP-6963, and (unless another wallet is
 * present) install it as `window.ethereum`. Always exposes `window.autoWallet`.
 * Returns the provider, or null if injection is disallowed on this page.
 */
export function installProvider(
  transport: ProviderTransport,
  opts: InstallOptions = {},
): AutoWalletProvider | null {
  if (!opts.skipPolicy && !isProviderInjectionAllowed(location.href)) {
    return null;
  }

  const provider = new AutoWalletProvider(transport);
  const info: EIP6963ProviderInfo = { ...DEFAULT_PROVIDER_INFO, ...opts.info };

  // EIP-6963 announce/request
  const announce = () =>
    window.dispatchEvent(
      new CustomEvent('eip6963:announceProvider', {
        detail: Object.freeze({ info, provider }),
      }),
    );
  window.addEventListener('eip6963:requestProvider', announce);
  announce();

  // window.ethereum (legacy detection)
  const w = window as unknown as { ethereum?: unknown; autoWallet?: unknown };
  const existing = w.ethereum;
  const hadOther = !!existing && existing !== provider;
  if (opts.forceInject || !existing) {
    provider.isMetaMask = !hadOther; // only impersonate when sole provider
    if (opts.lockEthereum) {
      Object.freeze(Object.getPrototypeOf(provider)); // request/send/on un-patchable
      Object.defineProperty(w, 'ethereum', {
        value: provider,
        writable: false,
        configurable: false,
        enumerable: true,
      });
    } else {
      w.ethereum = provider;
    }
  }
  w.autoWallet = provider;

  return provider;
}
