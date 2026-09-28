import { invoke } from "@tauri-apps/api/core";

/** Idle minutes offered in Settings; 0 = never lock automatically. */
export const AUTO_LOCK_CHOICES = [0, 5, 15, 30, 60, 240] as const;

export async function getAutoLockMinutes(): Promise<number> {
  return invoke<number>("get_auto_lock_minutes");
}

export async function setAutoLockMinutes(minutes: number): Promise<number> {
  return invoke<number>("set_auto_lock_minutes", { minutes });
}

/**
 * Throttle the shell's "the user did something" heartbeat: the idle timer only
 * needs minute-level precision, so one IPC call per `intervalMs` is plenty.
 */
export function createActivityReporter(
  intervalMs: number,
  now: () => number,
  send: () => void,
): () => void {
  let last = -Infinity;
  return () => {
    const t = now();
    if (t - last < intervalMs) return;
    last = t;
    send();
  };
}
