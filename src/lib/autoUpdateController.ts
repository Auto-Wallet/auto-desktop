export const AUTO_UPDATE_INTERVAL_MS = 60 * 60 * 1000;

export type DownloadedUpdate = {
  version: string;
  installAndRelaunch: () => Promise<void>;
  discard: () => Promise<void>;
};

export type AutoUpdateSnapshot = {
  status: "idle" | "checking" | "ready" | "installing" | "ignored";
  version: string | null;
  error: string | null;
};

type TimerHandle = number;

type AutoUpdateDependencies = {
  findAndDownload: () => Promise<DownloadedUpdate | null>;
  schedule: (callback: () => void, delay: number) => TimerHandle;
  cancel: (timer: TimerHandle) => void;
  reportError: (error: unknown) => void;
};

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

export function createAutoUpdateController(deps: AutoUpdateDependencies) {
  let snapshot: AutoUpdateSnapshot = {
    status: "idle",
    version: null,
    error: null,
  };
  let started = false;
  let ignored = false;
  let timer: TimerHandle | null = null;
  let pending: DownloadedUpdate | null = null;
  let runPromise: Promise<void> | null = null;
  const listeners = new Set<() => void>();

  function publish(next: AutoUpdateSnapshot) {
    snapshot = next;
    for (const listener of listeners) listener();
  }

  function clearTimer() {
    if (timer === null) return;
    deps.cancel(timer);
    timer = null;
  }

  function scheduleNextCheck() {
    if (ignored || pending) return;
    clearTimer();
    timer = deps.schedule(() => {
      timer = null;
      void runCheck();
    }, AUTO_UPDATE_INTERVAL_MS);
  }

  async function executeCheck() {
    if (ignored || pending) return;
    publish({ status: "checking", version: null, error: null });
    try {
      const update = await deps.findAndDownload();
      if (ignored) {
        await update?.discard();
        return;
      }
      if (update) {
        pending = update;
        publish({ status: "ready", version: update.version, error: null });
        return;
      }
      publish({ status: "idle", version: null, error: null });
    } catch (error) {
      deps.reportError(error);
      publish({ status: "idle", version: null, error: null });
    }
    scheduleNextCheck();
  }

  function runCheck(): Promise<void> {
    if (runPromise) return runPromise;
    const current = executeCheck().finally(() => {
      if (runPromise === current) runPromise = null;
    });
    runPromise = current;
    return current;
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start(): Promise<void> {
      if (ignored) return Promise.resolve();
      if (started) return runPromise ?? Promise.resolve();
      started = true;
      return runCheck();
    },
    whenIdle(): Promise<void> {
      return runPromise ?? Promise.resolve();
    },
    async ignore(): Promise<void> {
      if (ignored) return;
      ignored = true;
      clearTimer();
      const update = pending;
      pending = null;
      publish({ status: "ignored", version: null, error: null });
      if (!update) return;
      try {
        await update.discard();
      } catch (error) {
        deps.reportError(error);
      }
    },
    async install(): Promise<void> {
      if (!pending || snapshot.status === "installing") return;
      const update = pending;
      publish({ status: "installing", version: update.version, error: null });
      try {
        await update.installAndRelaunch();
      } catch (error) {
        deps.reportError(error);
        publish({
          status: "ready",
          version: update.version,
          error: errorText(error),
        });
      }
    },
  };
}
