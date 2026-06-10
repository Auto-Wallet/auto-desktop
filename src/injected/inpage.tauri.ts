// AutoDesktop injection entry. Bundled to a self-contained IIFE
// (scripts/build-injected.ts → src-tauri/injected/inpage.js) and injected into
// every dApp webview as an initialization_script. It wires the Tauri transport
// to the shared EIP-1193/6963 provider from auto-wallet-core.

import { installProvider, type ProviderTransport } from 'auto-wallet-core';

type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

function findInvoke(): InvokeFn | null {
  const w = window as unknown as {
    __TAURI_INTERNALS__?: { invoke?: InvokeFn };
    __TAURI__?: { core?: { invoke?: InvokeFn } };
  };
  if (w.__TAURI_INTERNALS__?.invoke) return w.__TAURI_INTERNALS__.invoke.bind(w.__TAURI_INTERNALS__);
  if (w.__TAURI__?.core?.invoke) return w.__TAURI__.core.invoke.bind(w.__TAURI__.core);
  return null;
}

// The init script can run before Tauri injects its IPC bootstrap, so poll briefly.
function waitForInvoke(timeoutMs = 5000): Promise<InvokeFn> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const fn = findInvoke();
      if (fn) return resolve(fn);
      if (Date.now() - start > timeoutMs) return reject(new Error('AutoDesktop: Tauri IPC unavailable'));
      setTimeout(tick, 30);
    };
    tick();
  });
}

let invokeReady: Promise<InvokeFn> | null = null;
const getInvoke = () => (invokeReady ??= waitForInvoke());

function providerError(error: unknown): Error {
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : String(error);
  const out = new Error(message) as Error & { code?: number };
  const codeMatch = message.match(/(?:code\s*)?(\b49\d{2}\b|\b4\d{3}\b)/i);
  if (codeMatch) out.code = Number(codeMatch[1]);
  return out;
}

const transport: ProviderTransport = {
  async request({ method, params }) {
    const invoke = await getInvoke();
    // NOTE: we intentionally do NOT forward `origin`. The page-reported origin is
    // untrusted; the Rust `wallet_request` command derives the real caller origin
    // from the webview context instead (see src-tauri/src/lib.rs).
    try {
      return await invoke('wallet_request', { method, params });
    } catch (e) {
      throw providerError(e);
    }
  },
  subscribe(handler) {
    // The backend pushes wallet events (chainChanged, …) by eval'ing
    // `window.__autoWalletPush(name, payload)` in this webview — see
    // push_chain_changed() in src-tauri/src/lib.rs. We deliberately do NOT use the
    // Tauri event API, so the dApp capability stays scoped to allow-wallet-request
    // only (no core:event). The shell drives this via set_active_chain.
    const w = window as unknown as {
      __autoWalletPush?: (name: string, payload: unknown) => void;
    };
    w.__autoWalletPush = (name, payload) => {
      try {
        handler(name, payload);
      } catch (e) {
        console.error('[AutoDesktop] push handler error', e);
      }
    };
    return () => {
      delete w.__autoWalletPush;
    };
  },
};

// lockEthereum: the dapp webview is guaranteed sole-provider, so pin
// window.ethereum and freeze the provider prototype against page hijacking.
installProvider(transport, { forceInject: true, lockEthereum: true });
console.log('[AutoDesktop] Auto Wallet provider injected');

// Route "open in a new window" intents (window.open / <a target="_blank">) to the
// OS default browser. WKWebView would otherwise silently drop them (there's no
// second window). Only http(s) is forwarded; the Rust command re-validates the
// scheme. Normal in-page navigation (target=_self) is untouched.
function installLinkInterceptor() {
  const openExternal = (url: string): boolean => {
    let target: string;
    try {
      target = new URL(url, location.href).toString();
    } catch {
      return false;
    }
    if (!/^https?:\/\//i.test(target)) return false;
    void getInvoke()
      .then((invoke) => invoke('open_external_url', { url: target }))
      .catch((e) => console.error('[AutoDesktop] open_external_url failed', e));
    return true;
  };

  const nativeOpen = window.open.bind(window);
  window.open = function (url?: string | URL, target?: string, features?: string): Window | null {
    const u = url == null ? '' : String(url);
    if (u && openExternal(u)) return null;
    return nativeOpen(url as string, target, features);
  } as typeof window.open;

  document.addEventListener(
    'click',
    (e) => {
      const anchor = (e.target as Element | null)?.closest?.('a') as HTMLAnchorElement | null;
      if (!anchor || anchor.target !== '_blank') return;
      const href = anchor.href || anchor.getAttribute('href') || '';
      if (openExternal(href)) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true,
  );
}
installLinkInterceptor();
