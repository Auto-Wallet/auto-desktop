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

const transport: ProviderTransport = {
  async request({ method, params }) {
    const invoke = await getInvoke();
    // NOTE: we intentionally do NOT forward `origin`. The page-reported origin is
    // untrusted; the Rust `wallet_request` command derives the real caller origin
    // from the webview context instead (see src-tauri/src/lib.rs).
    return invoke('wallet_request', { method, params });
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

installProvider(transport, { forceInject: true });
console.log('[AutoDesktop] Auto Wallet provider injected');
