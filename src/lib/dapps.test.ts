import { expect, test } from "bun:test";

const values = new Map<string, string>();
const storage: Storage = {
  get length() {
    return values.size;
  },
  clear() {
    values.clear();
  },
  getItem(key) {
    return values.has(key) ? values.get(key)! : null;
  },
  key(index) {
    const keys = [...values.keys()];
    return index >= 0 && index < keys.length ? keys[index] : null;
  },
  removeItem(key) {
    values.delete(key);
  },
  setItem(key, value) {
    values.set(key, value);
  },
};
Object.defineProperty(globalThis, "localStorage", { value: storage });

const { faviconOf, refreshDappIcon } = await import("./dapps");

test("faviconOf requests the site's own root favicon", () => {
  expect(faviconOf("https://example.com/swap")).toBe(
    "https://example.com/favicon.ico",
  );
});

test("refreshDappIcon saves a cache-busting timestamp", () => {
  refreshDappIcon("uniswap", 1_234_567);

  const raw = storage.getItem("autodesktop.dapps");
  if (raw === null) throw new Error("dApp store was not saved");
  const saved = JSON.parse(raw) as Array<{
    id: string;
    iconRefreshAt?: number;
  }>;
  const uniswap = saved.find((dapp) => dapp.id === "uniswap");
  if (uniswap === undefined) throw new Error("Uniswap was not saved");
  expect(uniswap.iconRefreshAt).toBe(1_234_567);
  expect(faviconOf("https://app.uniswap.org", uniswap.iconRefreshAt)).toBe(
    "https://app.uniswap.org/favicon.ico?autodesktop-refresh=1234567",
  );
});
