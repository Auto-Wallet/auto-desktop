import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

// i18n reads localStorage while its module body runs, and bun's test env has no
// DOM. Static imports are hoisted above this, so lib/ui comes in dynamically —
// after the stub is in place (see ConfirmHost.test.tsx).
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as Storage;

const { DappIcon } = await import("./ui");

describe("DappIcon", () => {
  test("shows the bundled icon for a dApp we ship one for", () => {
    const html = renderToStaticMarkup(
      <DappIcon url="https://app.uniswap.org" name="Uniswap" size={18} radius={5} className="tab-fav" />,
    );

    expect(html).toContain('src="/logos/dapps/uniswap.png"');
    expect(html).toContain('class="tab-fav"');
  });

  test("falls back to the site's own favicon for a hand-added dApp", () => {
    const html = renderToStaticMarkup(
      <DappIcon url="https://debank.com" name="Debank" size={18} radius={5} className="tab-fav" />,
    );

    expect(html).toContain('src="https://debank.com/favicon.ico"');
  });

  test("a manual icon refresh reaches every place the icon shows", () => {
    const html = renderToStaticMarkup(
      <DappIcon url="https://debank.com" name="Debank" size={18} refreshAt={42} />,
    );

    expect(html).toContain('src="https://debank.com/favicon.ico?autodesktop-refresh=42"');
  });
});
