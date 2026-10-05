import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Chain } from "../lib/chains";
import type { TFn } from "../lib/i18n";

// Another test file may already have installed a read-only stub; reuse it.
if (!("localStorage" in globalThis)) {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    } as Storage,
  });
}

const { ChainFilterOptions, DefiSection, HoldingRow } = await import("./WalletPage");

const t = ((key: string) => key) as TFn;

function renderDefiToggle(enabled: boolean): string {
  const html = renderToStaticMarkup(
    <DefiSection
      t={t}
      defi={{ status: "ok", positions: [], source: "Zerion" }}
      enabled={enabled}
      onEnabledChange={() => undefined}
    />,
  );
  const match = html.match(/<button[^>]*role="switch"[^>]*>[\s\S]*?<\/button>/);
  if (!match) throw new Error(`DeFi switch not rendered: ${html}`);
  return match[0];
}

describe("DefiSection switch", () => {
  // The thumb only moves through the shared .t-toggle / .t-toggle-thumb rules
  // in transitions.css; without them the thumb sits left while the track is on.
  test("an enabled switch moves its thumb to the on side", () => {
    const html = renderDefiToggle(true);
    expect(html).toContain('aria-checked="true"');
    expect(html).toMatch(/class="toggle t-toggle[^"]* on"/);
    expect(html).toContain('data-on="true"');
    expect(html).toContain('class="t-toggle-thumb"');
  });

  test("a disabled switch keeps its thumb on the off side", () => {
    const html = renderDefiToggle(false);
    expect(html).toContain('aria-checked="false"');
    expect(html).not.toMatch(/class="[^"]* on"/);
    expect(html).toContain('data-on="false"');
    expect(html).toContain('class="t-toggle-thumb"');
  });
});

const base: Chain = {
  id: "0x2105",
  name: "Base",
  symbol: "ETH",
  rpc: "https://base-rpc.publicnode.com",
  decimals: 18,
  color: "#0052ff",
  builtin: true,
};

function renderChainOptions(chains: Chain[], query: string): string {
  return renderToStaticMarkup(
    <ChainFilterOptions
      t={t}
      chains={chains}
      query={query}
      filter="all"
      highlightedChainIds={new Set()}
      onPick={() => undefined}
    />,
  );
}

describe("ChainFilterOptions", () => {
  test("says nothing matched when a search finds no network", () => {
    const html = renderChainOptions([], "zzz");
    expect(html).toContain("wallet.noNetworkMatches");
    expect(html).toContain("wallet.allNetworks");
  });

  test("lists matches without the empty message", () => {
    const html = renderChainOptions([base], "base");
    expect(html).toContain(">Base<");
    expect(html).not.toContain("wallet.noNetworkMatches");
  });

  test("an empty query with no chains is not a failed search", () => {
    expect(renderChainOptions([], "  ")).not.toContain("wallet.noNetworkMatches");
  });
});

const failedGlmr = {
  key: "n:0x504",
  kind: "native",
  chainId: "0x504",
  chainName: "Moonbeam",
  chainSymbol: "GLMR",
  chainColor: "#e1147b",
  symbol: "GLMR",
  name: "Glimmer",
  decimals: 18,
  color: "#e1147b",
  state: { status: "error", message: "rpc.api.moonbeam.network: HTTP 503" },
} as const;

describe("HoldingRow load error", () => {
  test("names the failure in the user's language, shows why, and offers a retry", () => {
    const html = renderToStaticMarkup(
      <HoldingRow
        row={failedGlmr}
        t={t}
        canSign
        onOpen={() => undefined}
        onSend={() => undefined}
        onSwap={() => undefined}
        onRetry={() => undefined}
      />,
    );
    expect(html).not.toContain(">failed<");
    expect(html).toContain("wallet.balanceFailed");
    expect(html).toContain("rpc.api.moonbeam.network: HTTP 503");
    expect(html).toMatch(/<button[^>]*>wallet.retry<\/button>/);
  });

  test("hides the hover send/swap actions so they cannot cover Retry", () => {
    const html = renderToStaticMarkup(
      <HoldingRow
        row={failedGlmr}
        t={t}
        canSign
        onOpen={() => undefined}
        onSend={() => undefined}
        onSwap={() => undefined}
        onRetry={() => undefined}
      />,
    );
    expect(html).not.toContain("token-actions");
    expect(html).not.toContain("wallet.send");
  });
});
