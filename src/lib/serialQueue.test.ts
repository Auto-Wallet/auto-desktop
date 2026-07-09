import { describe, expect, test } from "bun:test";
import { createSerialQueue } from "./serialQueue";

// Regression for the "switch network freezes the whole wallet" bug: the
// menu-overlay show/hide invokes are async Tauri commands that run concurrently
// on the backend thread pool, so a slow `show` (reparent + resize + show, under
// the webview-creation lock) issued BEFORE a fast `hide` could complete AFTER
// it — leaving a transparent full-window overlay permanently eating every
// click. The queue must guarantee overlay state requests apply in issue order.

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("createSerialQueue", () => {
  test("a slow op issued first cannot overtake a fast op issued after it", async () => {
    const queue = createSerialQueue();
    const applied: string[] = [];

    let releaseShow!: () => void;
    const showGate = new Promise<void>((r) => (releaseShow = r));

    // "show" resolves only when released; "hide" would resolve immediately.
    const show = queue(async () => {
      await showGate;
      applied.push("show");
    });
    const hide = queue(async () => {
      applied.push("hide");
    });

    // Give the (buggy) concurrent path every chance to run "hide" early.
    await tick();
    expect(applied).toEqual([]); // hide must NOT have run while show is pending

    releaseShow();
    await Promise.all([show, hide]);
    expect(applied).toEqual(["show", "hide"]); // last requested state wins
  });

  test("ops run strictly one at a time", async () => {
    const queue = createSerialQueue();
    let running = 0;
    let maxConcurrent = 0;
    const op = () =>
      queue(async () => {
        running += 1;
        maxConcurrent = Math.max(maxConcurrent, running);
        await tick();
        running -= 1;
      });
    await Promise.all([op(), op(), op(), op()]);
    expect(maxConcurrent).toBe(1);
  });

  test("a rejected op does not stall the queue, and the caller still sees the error", async () => {
    const queue = createSerialQueue();
    const applied: string[] = [];

    const failing = queue(async () => {
      throw new Error("sync_menu_overlay failed");
    });
    const after = queue(async () => {
      applied.push("after");
    });

    await expect(failing).rejects.toThrow("sync_menu_overlay failed");
    await after;
    expect(applied).toEqual(["after"]);
  });

  test("returns the op's resolved value", async () => {
    const queue = createSerialQueue();
    await expect(queue(async () => 42)).resolves.toBe(42);
  });
});
