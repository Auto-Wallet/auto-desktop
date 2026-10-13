import { afterEach, expect, test } from 'bun:test';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { RelayProvider } from './relay-provider';
import { NATIVE_TOKEN_ADDRESS, type QuoteParams } from './types';

Object.defineProperty(globalThis, 'window', { value: globalThis, configurable: true });
const originalFetch = globalThis.fetch;
function blockFrontendFetch(message: string) {
  globalThis.fetch = Object.assign(async () => { throw new Error(message); }, {
    preconnect: originalFetch.preconnect,
  });
}
afterEach(() => {
  clearMocks();
  globalThis.fetch = originalFetch;
});

const params: QuoteParams = {
  fromChainId: 8453, toChainId: 42161,
  fromToken: { chainId: 8453, address: NATIVE_TOKEN_ADDRESS, symbol: 'ETH', name: 'Ether', decimals: 18, logo: '' },
  toToken: { chainId: 42161, address: NATIVE_TOKEN_ADDRESS, symbol: 'ETH', name: 'Ether', decimals: 18, logo: '' },
  fromAddress: '0x1111111111111111111111111111111111111111',
  toAddress: '0x2222222222222222222222222222222222222222',
  fromAmount: '0.01', slippage: 0.005,
};

test('Relay quotes use backend authentication and preserve swap inputs', async () => {
  const calls: unknown[] = [];
  blockFrontendFetch('Missing API key: frontend request is unauthenticated');
  mockIPC((command, args) => {
    calls.push({ command, args });
    return {
      steps: [], fees: {},
      details: { currencyOut: { amount: '9000000000000000', amountFormatted: '0.009' } },
    };
  });

  const quote = await new RelayProvider().getQuote(params);

  expect(quote.amountOutRaw).toBe('9000000000000000');
  expect(quote.amountOutMinRaw).toBe('8955000000000000');
  expect(calls).toEqual([{ command: 'relay_quote', args: { body: {
    user: params.fromAddress, recipient: params.toAddress,
    originChainId: 8453, destinationChainId: 42161,
    originCurrency: NATIVE_TOKEN_ADDRESS, destinationCurrency: NATIVE_TOKEN_ADDRESS,
    amount: '10000000000000000', tradeType: 'EXACT_INPUT', slippageTolerance: '50',
    appFees: [{ recipient: '0x7521EDa00E2Ce05aC4a9d8353d096CCB970d5188', fee: '10' }],
    referrer: 'auto-desktop',
  } } }]);
});

test('Relay metadata and status also use fixed backend commands', async () => {
  blockFrontendFetch('Relay requests must use the backend');
  const calls: unknown[] = [];
  mockIPC((command, args) => {
    calls.push({ command, args });
    if (command === 'relay_chains') return { chains: [{
      id: 8453, name: 'Base', vmType: 'evm',
      currency: { symbol: 'ETH', name: 'Ether', address: NATIVE_TOKEN_ADDRESS, decimals: 18 },
    }] };
    if (command === 'relay_status') return { status: 'success', txHashes: ['0xdestination'] };
    throw new Error(`Unexpected command: ${command}`);
  });
  const provider = new RelayProvider();
  expect(await provider.loadChains()).toEqual([{ chainId: 8453, name: 'Base', logo: '', nativeSymbol: 'ETH' }]);
  expect((await provider.loadTokensByChain()).get(8453)).toEqual([params.fromToken]);
  const status = await provider.getStatus({ params, sourceHash: '0xsource', requestId: 'req&another=value' });
  expect(status.state).toBe('success');
  expect(status.destHash).toBe('0xdestination');
  expect(calls).toEqual([
    { command: 'relay_chains', args: {} },
    { command: 'relay_chains', args: {} },
    { command: 'relay_status', args: { requestId: 'req&another=value' } },
  ]);
});

test('Relay backend errors remain visible in the quote UI', async () => {
  mockIPC(() => { throw 'RELAY_API_KEY is not configured'; });
  let caught: unknown;
  try { await new RelayProvider().getQuote(params); } catch (error) { caught = error; }
  expect(caught instanceof Error).toBe(true);
  expect((caught as Error).message).toBe('RELAY_API_KEY is not configured');
});
