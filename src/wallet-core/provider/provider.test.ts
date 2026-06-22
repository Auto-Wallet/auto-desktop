import { describe, expect, test } from 'bun:test';
import { AutoWalletProvider } from './provider';
import type { ProviderTransport } from '../adapters/transport';

function fakeTransport(
  handler: (req: { method: string; params?: unknown[] }) => unknown,
): ProviderTransport {
  return {
    request: async (req) => handler(req),
    subscribe: () => () => {},
  };
}

describe('AutoWalletProvider chainId cache', () => {
  test('wallet_switchEthereumChain normalizes the cached chainId and the emitted event', async () => {
    const provider = new AutoWalletProvider(
      fakeTransport(({ method }) => (method === 'wallet_switchEthereumChain' ? null : [])),
    );
    const emitted: unknown[] = [];
    provider.on('chainChanged', (id) => emitted.push(id));

    // dApps send sloppy notations; the cache and the event must be canonical
    // 0x-hex (matching what the backend's eth_chainId returns), or the page's
    // view of the chain desyncs from the wallet.
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0XA4B1' }],
    });
    expect(provider.chainId).toBe('0xa4b1');
    expect(emitted).toEqual(['0xa4b1']);
  });

  test('switching to the already-selected chain does not re-emit chainChanged', async () => {
    const provider = new AutoWalletProvider(
      fakeTransport(({ method }) => (method === 'wallet_switchEthereumChain' ? null : [])),
    );
    const emitted: unknown[] = [];
    provider.on('chainChanged', (id) => emitted.push(id));

    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x89' }] });
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '137' }] });
    expect(provider.chainId).toBe('0x89');
    expect(emitted).toEqual(['0x89']); // second switch is a no-op, no duplicate event
  });

  test('a junk chainId param never poisons the cache', async () => {
    const provider = new AutoWalletProvider(
      fakeTransport(({ method }) => (method === 'wallet_switchEthereumChain' ? null : [])),
    );
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: 'not-a-chain' }],
    });
    expect(provider.chainId).toBe('0x1'); // untouched default
  });
});
