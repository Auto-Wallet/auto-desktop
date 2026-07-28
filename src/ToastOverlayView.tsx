import { useEffect, useState } from "react";
import { openExternalUrl } from "./lib/platform";
import type { ToastKind } from "./lib/toast";
import { motionMs, useEnterExit } from "./lib/transitions";

type OverlayToast = {
  id: string;
  msg: string;
  kind: ToastKind;
  card?: boolean;
  actionLabel?: string;
  actionUrl?: string;
};

export default function ToastOverlayView() {
  const [toasts, setToasts] = useState<OverlayToast[]>([]);

  useEffect(() => {
    document.body.classList.add("toast-overlay-body");
    const saved = localStorage.getItem("autodesktop.toastOverlayPayload");
    if (saved) {
      try {
        const next = JSON.parse(saved)?.toasts;
        if (Array.isArray(next)) setToasts(next);
      } catch {
        // Ignore stale payloads; the shell will broadcast the next state.
      }
    }
    const channel = new BroadcastChannel("autodesktop-toast-overlay");
    channel.onmessage = (event) => {
      const next = event.data?.toasts;
      if (Array.isArray(next)) setToasts(next);
    };
    return () => {
      channel.close();
      document.body.classList.remove("toast-overlay-body");
    };
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="toast-overlay-root">
      {toasts.map((t) => (
        <OverlayToastItem key={t.id} t={t} />
      ))}
    </div>
  );
}

/**
 * The overlay mirrors the shell's toasts into a native child webview, so it
 * only ever learns about a toast that already exists — it plays the rise-in
 * on mount. Removal is driven by the next broadcast, so there is no leaving
 * state to animate here.
 */
function OverlayToastItem({ t }: { t: OverlayToast }) {
  const { cls } = useEnterExit(true, motionMs("--toast-close", 250));
  const base = `toast t-toast${cls === "is-open" ? " is-open" : ""} ${t.kind}${
    t.card ? " card" : ""
  }`;
  const content = (
    <>
      <span className="tdot" />
      <span className="toast-msg">{t.msg}</span>
      {t.actionLabel && <span className="toast-action">{t.actionLabel}</span>}
    </>
  );
  return t.actionUrl ? (
    <button
      type="button"
      className={`${base} actionable`}
      onClick={() => void openExternalUrl(t.actionUrl!)}
    >
      {content}
    </button>
  ) : (
    <div className={base}>{content}</div>
  );
}
