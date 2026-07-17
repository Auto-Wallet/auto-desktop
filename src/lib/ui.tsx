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
            className={`toast ${t.kind}${t.card ? " card" : ""} actionable`}
            onClick={t.action.onClick}
          >
            {content}
          </button>
        ) : (
          <div key={t.id} className={`toast ${t.kind}${t.card ? " card" : ""}`}>
            {content}
          </div>
        );
      })}
    </div>
  );
}
