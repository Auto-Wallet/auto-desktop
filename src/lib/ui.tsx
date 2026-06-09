// Shared presentational atoms used across the shell, Wallet, and the approval
// window: the deterministic gradient Avatar and the ToastHost.

import { useToasts } from "./toast";

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

export function ToastHost() {
  const toasts = useToasts();
  if (toasts.length === 0) return null;
  return (
    <div className="toast-wrap">
      {toasts.map((t) => {
        const content = (
          <>
            <span className="tdot" />
            <span className="toast-msg">{t.msg}</span>
            {t.action?.label && <span className="toast-action">{t.action.label}</span>}
          </>
        );
        return t.action ? (
          <button
            key={t.id}
            type="button"
            className={`toast ${t.kind} actionable`}
            onClick={t.action.onClick}
          >
            {content}
          </button>
        ) : (
          <div key={t.id} className={`toast ${t.kind}`}>
            {content}
          </div>
        );
      })}
    </div>
  );
}
