// A per-resource async serial queue. The overlay webviews (menu / toast) are
// driven by ASYNC Tauri commands that execute concurrently on the backend's
// thread pool, so two in-flight invokes for the same overlay can complete in
// either order. A slow `show` overtaken by a fast `hide` leaves a transparent
// full-window overlay permanently covering the app and eating every click (the
// "switch network freezes the wallet" bug). Funneling each overlay's invokes
// through one of these queues guarantees the last requested state is the one
// that ends up applied.

export type SerialQueue = <T>(op: () => Promise<T>) => Promise<T>;

export function createSerialQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return (op) => {
    const run = tail.then(op, op);
    // Failures propagate to the caller of THIS op only; the queue moves on.
    tail = run.catch(() => undefined);
    return run;
  };
}
