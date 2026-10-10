import { afterEach, expect, spyOn, test } from "bun:test";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { MouseEvent, ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Render the real button with React's hooks, then drive its click handler.
// Only the browser/OS clipboard boundary is stubbed.
if (typeof localStorage === "undefined") {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => null },
  });
}
const { CopyButton } = await import("./ui");
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

afterEach(() => {
  clearMocks();
  for (const [key, descriptor] of [
    ["window", originalWindow],
    ["navigator", originalNavigator],
  ] as const) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

function browserClipboard(writeText: (value: string) => Promise<void>) {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { clearTimeout, setTimeout },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: { writeText } },
  });
}

function buttonClick(onCopied: () => void, onCopyFailed?: () => void) {
  let click!: (event: MouseEvent<HTMLButtonElement>) => void | Promise<void>;
  function Probe() {
    const button = CopyButton({
      value: "0x7521ed00000000000000000000000000000d5188",
      onCopied,
      onCopyFailed,
    });
    click = (button as ReactElement<{ onClick: typeof click }>).props.onClick;
    return button;
  }
  renderToStaticMarkup(<Probe />);
  return () => click({ stopPropagation() {} } as MouseEvent<HTMLButtonElement>);
}

test("copy confirms only after the clipboard replaces the previous text", async () => {
  let clipboard = "old clipboard text";
  let complete!: () => void;
  browserClipboard((value) => new Promise<void>((resolve) => {
    complete = () => {
      clipboard = value;
      resolve();
    };
  }));
  let copied = 0;
  const click = buttonClick(() => copied++);
  const pending = click();
  const beforeWrite = { clipboard, copied };
  complete();
  await pending;

  expect(beforeWrite).toEqual({ clipboard: "old clipboard text", copied: 0 });
  expect(clipboard).toBe("0x7521ed00000000000000000000000000000d5188");
  expect(copied).toBe(1);
});

test("a native clipboard error sends failure to the menu instead of success", async () => {
  browserClipboard(async () => { throw new Error("must use native clipboard"); });
  mockIPC(() => { throw new Error("OS clipboard unavailable"); });
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const results: boolean[] = [];
  try {
    await buttonClick(() => results.push(true), () => results.push(false))();
    expect(results).toEqual([false]);
    expect(errors.mock.calls.length).toBe(1);
  } finally {
    errors.mockRestore();
  }
});

test("a denied write reports failure without confirming success", async () => {
  browserClipboard(async () => { throw new Error("Clipboard denied"); });
  const errors = spyOn(console, "error").mockImplementation(() => {});
  let copied = 0;
  const click = buttonClick(() => copied++);
  try {
    await expect(Promise.resolve(click())).resolves.toBeUndefined();
    expect(copied).toBe(0);
    expect(errors.mock.calls.length).toBe(1);
  } finally {
    errors.mockRestore();
  }
});

test("native copy uses the OS bridge even without a browser click permission", async () => {
  let browserWrites = 0;
  browserClipboard(async () => { browserWrites++; });
  const calls: Array<{ command: string; args: unknown }> = [];
  let clipboard = "old native text";
  let complete!: () => void;
  mockIPC((command, args) => {
    calls.push({ command, args });
    return new Promise<void>((resolve) => {
      complete = () => {
        clipboard = (args as { text: string }).text;
        resolve();
      };
    });
  });
  let copied = 0;
  const pending = buttonClick(() => copied++)();
  const beforeWrite = { clipboard, copied };
  if (complete) complete();
  await pending;

  expect(calls).toEqual([{
    command: "plugin:clipboard-manager|write_text",
    args: { text: "0x7521ed00000000000000000000000000000d5188" },
  }]);
  expect(browserWrites).toBe(0);
  expect(beforeWrite).toEqual({ clipboard: "old native text", copied: 0 });
  expect(clipboard).toBe("0x7521ed00000000000000000000000000000d5188");
  expect(copied).toBe(1);
});
