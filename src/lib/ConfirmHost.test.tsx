import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

// i18n reads localStorage while its module body runs, and bun's test env has no
// DOM. Static imports are hoisted above this, so the two modules under test come
// in dynamically — after the stub is in place.
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as Storage;

const { askConfirm, getConfirm, resolveConfirm } = await import("./confirm");
const { ConfirmHost } = await import("./ui");

describe("ConfirmHost", () => {
  test("renders nothing while no request is pending", () => {
    expect(renderToStaticMarkup(<ConfirmHost />)).toBe("");
  });

  test("renders the pending request's title, message and labels", async () => {
    const answer = askConfirm({
      title: "Delete safeTest?",
      message: "The wallet is removed from this device.",
      confirmLabel: "Delete",
      danger: true,
    });

    const html = renderToStaticMarkup(<ConfirmHost />);
    expect(html).toContain("Delete safeTest?");
    expect(html).toContain("The wallet is removed from this device.");
    expect(html).toContain(">Delete<");
    // A destructive action gets the danger button, and the card rides the
    // modal transition so it opens like every other dialog in the app.
    expect(html).toContain("btn-danger");
    expect(html).toContain("t-modal");
    expect(html).toContain("t-scrim");

    resolveConfirm(getConfirm()!.id, false);
    expect(await answer).toBe(false);
    expect(renderToStaticMarkup(<ConfirmHost />)).toBe("");
  });

  test("a non-destructive request uses the primary button", async () => {
    const answer = askConfirm({ title: "Continue?" });
    expect(renderToStaticMarkup(<ConfirmHost />)).toContain("btn-primary");
    resolveConfirm(getConfirm()!.id, true);
    expect(await answer).toBe(true);
  });
});
