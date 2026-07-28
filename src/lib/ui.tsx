// Shared presentational atoms used across the shell, Wallet, and the approval
// window: the deterministic gradient Avatar and the ToastHost.

import { useCallback, useEffect, useRef } from "react";
import { resolveConfirm, useConfirm, type ConfirmRequest } from "./confirm";
import { Icon } from "./icons";
import { useT } from "./i18n";
import { useToasts, type Toast } from "./toast";
import { motionMs, useEnterExit, useIconSwap, useModalExit } from "./transitions";

/** Deterministic gradient from an address — distinct per account, no image/network. */
export function avatarBg(address: string): string {
  const a = address && address.length >= 10 ? address : "0x00000000";
  const h1 = parseInt(a.slice(2, 6), 16) % 360;
  const h2 = parseInt(a.slice(6, 10), 16) % 360;
  return `linear-gradient(135deg, hsl(${h1} 78% 62%), hsl(${h2} 72% 50%))`;
}

export function Avatar({
  address,
  size = 36,
  sq,
}: {
  address: string;
  size?: number;
  sq?: boolean;
}) {
  return (
    <span
      className={`avatar${sq ? " sq" : ""}`}
      style={{ width: size, height: size, background: avatarBg(address) }}
    />
  );
}

/** Deterministic two-hue gradient from any string (dApp names, hosts). */
export function nameGradient(name: string): string {
  const s = name.trim().toLowerCase() || "?";
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  const h1 = Math.abs(h) % 360;
  const h2 = (h1 + 36 + (Math.abs(h >> 8) % 72)) % 360;
  return `linear-gradient(135deg, hsl(${h1} 74% 60%), hsl(${h2} 70% 46%))`;
}

/**
 * Letter avatar for dApps without a bundled icon — deterministic gradient by
 * name, so "Twap-web" always gets the same face. Rounded-square like the app
 * icons it sits next to.
 */
export function DappAvatar({
  name,
  size = 50,
  radius,
  style,
}: {
  name: string;
  size?: number;
  radius?: number;
  style?: React.CSSProperties;
}) {
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: radius ?? Math.round(size * 0.3),
        background: nameGradient(name),
        color: "#fff",
        display: "inline-grid",
        placeItems: "center",
        fontFamily: "var(--font-display)",
        fontWeight: 700,
        fontSize: Math.round(size * 0.44),
        lineHeight: 1,
        flex: "none",
        boxShadow: "inset 0 0 0 1px rgba(0, 0, 0, 0.08)",
        textShadow: "0 1px 2px rgba(0, 0, 0, 0.18)",
        userSelect: "none",
        ...style,
      }}
    >
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

/**
 * Copy-to-clipboard button whose icon cross-fades to a check for a beat.
 *
 * Each instance owns its swap state, so one row in a list of accounts confirms
 * on its own instead of flipping every sibling. `onCopied` runs after the write
 * — that is where the toast goes.
 */
export function CopyButton({
  value,
  title,
  className = "icon-btn",
  size = 16,
  onCopied,
  children,
}: {
  value: string;
  title?: string;
  className?: string;
  size?: number;
  onCopied?: () => void;
  children?: React.ReactNode;
}) {
  const { state, fire } = useIconSwap();
  return (
    <button
      type="button"
      className={className}
      title={title}
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard.writeText(value);
        fire();
        onCopied?.();
      }}
    >
      <span className="t-icon-swap" data-state={state}>
        <span className="t-icon" data-icon="a">
          <Icon name="copy" size={size} />
        </span>
        <span className="t-icon" data-icon="b">
          <Icon name="check" size={size} />
        </span>
      </span>
      {children}
    </button>
  );
}

/**
 * One toast, riding the .t-toast rise-from-below. The snippet's resting state
 * IS the closed state, so `.is-open` alone gives the slow-in / quick-out
 * asymmetry — `leaving` (set by the store just before removal) drops it.
 */
function ToastItem({ t }: { t: Toast }) {
  const { cls } = useEnterExit(!t.leaving, motionMs("--toast-close", 250));
  const open = cls === "is-open" ? " is-open" : "";
  const base = `toast t-toast${open} ${t.kind}${t.card ? " card" : ""}`;
  const content = (
    <>
      <span className="tdot" />
      <span className="toast-msg">{t.msg}</span>
      {t.action?.label && <span className="toast-action">{t.action.label}</span>}
    </>
  );
  return t.action ? (
    <button type="button" className={`${base} actionable`} onClick={t.action.onClick}>
      {content}
    </button>
  ) : (
    <div className={base}>{content}</div>
  );
}

export function ToastHost() {
  const toasts = useToasts();
  if (toasts.length === 0) return null;
  return (
    <div className="toast-wrap">
      {toasts.map((t) => (
        <ToastItem key={t.id} t={t} />
      ))}
    </div>
  );
}

/**
 * Renders whatever askConfirm() is waiting on. Mount it once, next to
 * <ToastHost/>. See lib/confirm.ts for why the app can't use window.confirm.
 */
export function ConfirmHost() {
  const req = useConfirm();
  // Keyed by id so each request replays the modal's enter transition instead of
  // inheriting the previous one's finished state.
  return req ? <ConfirmDialog key={req.id} req={req} /> : null;
}

function ConfirmDialog({ req }: { req: ConfirmRequest }) {
  const { t } = useT();
  // useModalExit takes a single completion callback, so the answer rides a ref:
  // the button sets it, `close` plays the exit, and the store is told last.
  const answer = useRef(false);
  const { cls, close } = useModalExit(() => resolveConfirm(req.id, answer.current));
  const settle = useCallback(
    (ok: boolean) => {
      answer.current = ok;
      close();
    },
    [close],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") settle(false);
      if (e.key === "Enter") settle(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settle]);

  return (
    <div className={`scrim t-scrim ${cls}`} onClick={() => settle(false)}>
      <div
        role="alertdialog"
        aria-modal="true"
        className={`modal confirm-modal t-modal ${cls}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div className="modal-title">{req.title}</div>
        </div>
        {req.message && (
          <div className="modal-body">
            <p className="confirm-msg">{req.message}</p>
          </div>
        )}
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={() => settle(false)}>
            {req.cancelLabel ?? t("common.cancel")}
          </button>
          <button
            autoFocus
            className={`btn ${req.danger ? "btn-danger" : "btn-primary"}`}
            onClick={() => settle(true)}
          >
            {req.confirmLabel ?? t("common.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
