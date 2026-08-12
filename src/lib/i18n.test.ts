import { expect, test } from "bun:test";

// i18n reads the saved language at module load; the test runtime has no DOM.
const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  value: {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => (values.has(key) ? values.get(key)! : null),
    key: (i: number) => [...values.keys()][i] ?? null,
    removeItem: (key: string) => void values.delete(key),
    setItem: (key: string, value: string) => void values.set(key, value),
  } satisfies Storage,
});

const { localeTag, translate, translationKeys } = await import("./i18n");

// The Send button reads its label straight off the backend's phase name. A phase
// with no string renders as raw "wallet.phase.awaiting-window" text, because
// translate() falls back to the key — which is exactly what the user would see.
const PHASES = [
  "preparing",
  "awaiting-window",
  "awaiting-approval",
  "broadcasting",
];

for (const lang of ["en", "zh"] as const) {
  for (const phase of PHASES) {
    test(`${lang}: the ${phase} phase has a label`, () => {
      const key = `wallet.phase.${phase}`;
      const text = translate(lang, key);
      expect(text).not.toBe(key);
      expect(text.length).toBeGreaterThan(0);
    });
  }
}

test("zh and en carry the same set of keys", () => {
  // A key added to one dictionary only is invisible at runtime: translate()
  // falls back to English, so zh users silently get an English string.
  const en = new Set(translationKeys("en"));
  const zh = new Set(translationKeys("zh"));
  expect([...en].filter((k) => !zh.has(k))).toEqual([]);
  expect([...zh].filter((k) => !en.has(k))).toEqual([]);
});

test("dates follow the UI language, not the machine locale", () => {
  // Regression: the portfolio chart and the activity list passed `undefined` to
  // toLocale*String, so macOS decided — and a Chinese machine printed "7月13日"
  // into the English UI.
  const when = new Date(Date.UTC(2026, 6, 13, 12));
  const short = { month: "short", day: "numeric" } as const;
  expect(when.toLocaleDateString(localeTag("en"), short)).toBe("Jul 13");
  expect(when.toLocaleDateString(localeTag("zh"), short)).toBe("7月13日");
});
