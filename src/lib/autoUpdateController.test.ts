import { describe, expect, test } from "bun:test";
import {
  AUTO_UPDATE_INTERVAL_MS,
  createAutoUpdateController,
  type DownloadedUpdate,
} from "./autoUpdateController";

function harness(results: Array<DownloadedUpdate | null | Error>) {
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const cancelled: number[] = [];
  let checks = 0;
  const controller = createAutoUpdateController({
    findAndDownload: async () => {
      const result = results[checks++];
      if (result instanceof Error) throw result;
      return result ?? null;
    },
    schedule: (callback, delay) => {
      timers.push({ callback, delay });
      return timers.length;
    },
    cancel: (id) => cancelled.push(id as number),
    reportError: () => undefined,
  });
  return { controller, timers, cancelled, checks: () => checks };
}

describe("auto update controller", () => {
  test("does not show the notice until the package download finishes", async () => {
    let finishDownload!: (update: DownloadedUpdate) => void;
    const download = new Promise<DownloadedUpdate>((resolve) => {
      finishDownload = resolve;
    });
    const controller = createAutoUpdateController({
      findAndDownload: () => download,
      schedule: (callback, delay) => window.setTimeout(callback, delay),
      cancel: (id) => window.clearTimeout(id),
      reportError: () => undefined,
    });

    const startup = controller.start();
    expect(controller.getSnapshot().status).toBe("checking");

    finishDownload({
      version: "0.3.0",
      installAndRelaunch: async () => undefined,
      discard: async () => undefined,
    });
    await startup;

    expect(controller.getSnapshot().status).toBe("ready");
  });

  test("checks on startup, downloads before notifying, and stops polling while ready", async () => {
    let installed = 0;
    const update: DownloadedUpdate = {
      version: "0.3.0",
      installAndRelaunch: async () => void installed++,
      discard: async () => undefined,
    };
    const h = harness([update]);

    await h.controller.start();

    expect(h.controller.getSnapshot()).toEqual({
      status: "ready",
      version: "0.3.0",
      error: null,
    });
    expect(h.checks()).toBe(1);
    expect(h.timers).toEqual([]);
    expect(installed).toBe(0);
  });

  test("checks again one hour after no update is found", async () => {
    const h = harness([null, null]);

    await h.controller.start();
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0].delay).toBe(AUTO_UPDATE_INTERVAL_MS);

    h.timers[0].callback();
    await h.controller.whenIdle();

    expect(h.checks()).toBe(2);
  });

  test("a failed check is retried after one hour", async () => {
    const h = harness([new Error("offline"), null]);

    await h.controller.start();

    expect(h.controller.getSnapshot().status).toBe("idle");
    expect(h.timers[0].delay).toBe(AUTO_UPDATE_INTERVAL_MS);
  });

  test("ignore hides the notice, discards the download, and stops this session", async () => {
    let discarded = 0;
    const update: DownloadedUpdate = {
      version: "0.3.0",
      installAndRelaunch: async () => undefined,
      discard: async () => void discarded++,
    };
    const h = harness([update]);
    await h.controller.start();

    await h.controller.ignore();

    expect(h.controller.getSnapshot()).toEqual({
      status: "ignored",
      version: null,
      error: null,
    });
    expect(discarded).toBe(1);
    await h.controller.start();
    expect(h.checks()).toBe(1);
  });

  test("update installs the downloaded package and reports install failures", async () => {
    let installs = 0;
    const update: DownloadedUpdate = {
      version: "0.3.0",
      installAndRelaunch: async () => {
        installs++;
        throw new Error("install denied");
      },
      discard: async () => undefined,
    };
    const h = harness([update]);
    await h.controller.start();

    await h.controller.install();

    expect(installs).toBe(1);
    expect(h.controller.getSnapshot()).toEqual({
      status: "ready",
      version: "0.3.0",
      error: "install denied",
    });
  });
});
