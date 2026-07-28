import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { askConfirm, getConfirm, resolveConfirm, subscribeConfirm } from "./confirm";

describe("confirm store", () => {
  test("resolves true when the request is approved", async () => {
    const answer = askConfirm({ title: "Delete wallet?" });
    const req = getConfirm();
    expect(req?.title).toBe("Delete wallet?");
    resolveConfirm(req!.id, true);
    expect(await answer).toBe(true);
    expect(getConfirm()).toBeNull();
  });

  test("resolves false when the request is rejected", async () => {
    const answer = askConfirm({ title: "Delete wallet?" });
    resolveConfirm(getConfirm()!.id, false);
    expect(await answer).toBe(false);
  });

  test("queues concurrent asks instead of dropping one", async () => {
    const first = askConfirm({ title: "first" });
    const second = askConfirm({ title: "second" });
    expect(getConfirm()?.title).toBe("first");

    resolveConfirm(getConfirm()!.id, true);
    expect(await first).toBe(true);

    // The second only surfaces once the first is answered.
    expect(getConfirm()?.title).toBe("second");
    resolveConfirm(getConfirm()!.id, false);
    expect(await second).toBe(false);
  });

  test("a stale id leaves the live request alone", async () => {
    const answer = askConfirm({ title: "live" });
    const live = getConfirm()!;
    resolveConfirm(live.id + 999, true);
    expect(getConfirm()?.id).toBe(live.id);
    resolveConfirm(live.id, false);
    expect(await answer).toBe(false);
  });

  test("notifies subscribers on ask and on resolve", async () => {
    let hits = 0;
    const off = subscribeConfirm(() => {
      hits++;
    });
    const answer = askConfirm({ title: "watch" });
    expect(hits).toBe(1);
    resolveConfirm(getConfirm()!.id, true);
    await answer;
    expect(hits).toBe(2);
    off();
  });

  test("carries the labels and danger flag through to the request", async () => {
    const answer = askConfirm({
      title: "Remove network?",
      message: "This cannot be undone.",
      confirmLabel: "Remove",
      cancelLabel: "Keep",
      danger: true,
    });
    const req = getConfirm()!;
    expect(req.message).toBe("This cannot be undone.");
    expect(req.confirmLabel).toBe("Remove");
    expect(req.cancelLabel).toBe("Keep");
    expect(req.danger).toBe(true);
    resolveConfirm(req.id, false);
    await answer;
  });
});

// wry's WKUIDelegate (wkwebview/class/wry_web_view_ui_delegate.rs) implements
// only the file-upload, media-permission and new-window callbacks — none of the
// runJavaScriptAlert/Confirm/TextInputPanel ones. WKWebView ships no built-in
// dialog UI, so a shell webview calling confirm() gets an instant `false` and
// the guarded branch never runs. Every native dialog call must go through the
// in-app store instead.
describe("shell never calls the native dialogs", () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        // injected/ and wallet-core/ run inside the dApp page, where the
        // injected provider replaces these APIs with its own bridge.
        if (entry === "injected" || entry === "wallet-core") continue;
        walk(path, out);
      } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
        out.push(path);
      }
    }
    return out;
  }

  const NAMES = ["confirm", "alert", "prompt"] as const;

  test("no confirm() / alert() / prompt() call survives in shell code", () => {
    const offenders: string[] = [];
    for (const file of walk("src")) {
      const raw = readFileSync(file, "utf8");
      // Blank out comments rather than dropping them, so line numbers survive.
      const src = raw
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
        .replace(/\/\/[^\n]*/g, "");
      // A file that declares its own `confirm` is calling that, not the global.
      const shadowed = new Set(
        NAMES.filter((n) =>
          new RegExp(`(function\\s+${n}\\s*\\(|(const|let|var)\\s+${n}\\s*=)`).test(src),
        ),
      );
      src.split("\n").forEach((line, i) => {
        for (const n of NAMES) {
          if (shadowed.has(n)) continue;
          // A call, not a property access (`vault.confirm(`).
          if (new RegExp(`(^|[^.\\w])(window\\.)?${n}\\s*\\(`).test(line)) {
            offenders.push(`${file}:${i + 1}  ${raw.split("\n")[i].trim()}`);
          }
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
