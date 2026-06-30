import { useEffect, useState } from "react";
import {
  MENU_OVERLAY_CHANNEL,
  MENU_OVERLAY_KEY,
  type MenuOverlayAction,
  type MenuOverlayPayload,
} from "./lib/menuOverlay";
import { shortAddress } from "./lib/format";
import { Avatar } from "./lib/ui";
import { Icon } from "./lib/icons";
import { ChainIcon } from "./lib/ChainIcon";

// The interactive twin of ToastOverlayView: renders the browser top-bar dropdown
// menus (account / chain switcher) inside the transparent full-window
// `menu-overlay` child webview, which native stacking puts above the dApp
// webview — BrowserView's in-shell dropdowns would be covered by the page.
// Purely presentational: every click is posted back to the shell over the
// BroadcastChannel and applied there (see lib/menuOverlay.ts).

function post(action: MenuOverlayAction) {
  const channel = new BroadcastChannel(MENU_OVERLAY_CHANNEL);
  channel.postMessage({ action });
  window.setTimeout(() => channel.close(), 80);
}

export default function MenuOverlayView() {
  const [menu, setMenu] = useState<MenuOverlayPayload | null>(null);

  useEffect(() => {
    document.body.classList.add("menu-overlay-body");
    const saved = localStorage.getItem(MENU_OVERLAY_KEY);
    if (saved) {
      try {
        setMenu(JSON.parse(saved));
      } catch {
        // Ignore stale payloads; the shell broadcasts the live state right after.
      }
    }
    const channel = new BroadcastChannel(MENU_OVERLAY_CHANNEL);
    channel.onmessage = (event) => {
      if (event.data && "state" in event.data) setMenu(event.data.state);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (menu?.kind === "dialog") {
        post({ type: "resolve-dapp-dialog", id: menu.id, action: "cancel" });
      } else {
        post({ type: "dismiss" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      channel.close();
      document.body.classList.remove("menu-overlay-body");
    };
  }, [menu]);

  if (!menu) return null;

  if (menu.kind === "dialog") {
    return (
      <div className="menu-overlay-root dialog">
        <DappDialog dialog={menu} />
      </div>
    );
  }

  return (
    <div className="menu-overlay-root" onMouseDown={() => post({ type: "dismiss" })}>
      <div
        className={`chain-menu menu-overlay-menu${menu.kind === "account" ? " acct-pop scroll" : ""}`}
        style={{ top: menu.anchor.top, right: menu.anchor.right }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {menu.kind === "account" ? <AcctMenu menu={menu} /> : <ChainMenu menu={menu} />}
      </div>
    </div>
  );
}

function DappDialog({ dialog }: { dialog: Extract<MenuOverlayPayload, { kind: "dialog" }> }) {
  const [value, setValue] = useState(dialog.defaultValue ?? "");
  const isPrompt = dialog.dialogKind === "prompt";
  const showCancel = dialog.dialogKind === "confirm" || dialog.dialogKind === "prompt";

  return (
    <div className="dapp-dialog-card" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
      <div className="dapp-dialog-head">
        <span className="dapp-dialog-icon">
          <Icon name="alert" size={18} />
        </span>
        <div>
          <div className="dapp-dialog-title">{dialog.labels.title}</div>
          <div className="dapp-dialog-origin">{dialog.origin}</div>
        </div>
      </div>
      <div className="dapp-dialog-message">{dialog.message || "\u00a0"}</div>
      {isPrompt && (
        <input
          className="input"
          value={value}
          autoFocus
          placeholder={dialog.labels.promptPlaceholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            post({ type: "resolve-dapp-dialog", id: dialog.id, action: "ok", value });
          }}
        />
      )}
      <div className="dapp-dialog-actions">
        {showCancel && (
          <button
            className="btn btn-ghost"
            onClick={() => post({ type: "resolve-dapp-dialog", id: dialog.id, action: "cancel" })}
          >
            {dialog.labels.cancel}
          </button>
        )}
        <button
          className="btn btn-primary"
          autoFocus={!isPrompt}
          onClick={() => post({ type: "resolve-dapp-dialog", id: dialog.id, action: "ok", value })}
        >
          {dialog.labels.ok}
        </button>
      </div>
    </div>
  );
}

// Markup mirrors AcctChip's in-shell dropdown (BrowserView.tsx) so both render
// identically from the same CSS.
function AcctMenu({ menu }: { menu: Extract<MenuOverlayPayload, { kind: "account" }> }) {
  const isActive = (addr: string) => addr.toLowerCase() === menu.activeAddress.toLowerCase();
  return (
    <>
      {menu.accounts.map((a) => (
        <div
          key={a.address}
          role="button"
          tabIndex={0}
          className={`acct-opt${isActive(a.address) ? " on" : ""}`}
          onClick={() => post({ type: "select-account", address: a.address })}
          onKeyDown={(e) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            post({ type: "select-account", address: a.address });
          }}
        >
          <Avatar address={a.address} size={28} />
          <span className="meta">
            <span className="l">{a.label}</span>
            <span className="a">{shortAddress(a.address, 8, 6)}</span>
          </span>
          <button
            type="button"
            className="acct-copy"
            title={menu.copyTitle}
            aria-label={menu.copyTitle}
            onClick={(e) => {
              e.stopPropagation();
              post({ type: "copy-address", address: a.address });
            }}
          >
            <Icon name="copy" size={14} />
          </button>
          {isActive(a.address) && (
            <span className="check">
              <Icon name="check" size={15} />
            </span>
          )}
        </div>
      ))}
    </>
  );
}

// Markup mirrors ChainChip's in-shell dropdown (BrowserView.tsx).
function ChainMenu({ menu }: { menu: Extract<MenuOverlayPayload, { kind: "chain" }> }) {
  return (
    <>
      {menu.chains.map((c) => (
        <button
          key={c.id}
          className={`chain-opt${c.id === menu.activeChainId ? " on" : ""}`}
          onClick={() => post({ type: "select-chain", id: c.id })}
        >
          <ChainIcon chain={c} size={20} />
          <span className="nm">{c.name}</span>
          {c.id === menu.activeChainId && (
            <span className="check">
              <Icon name="check" size={16} />
            </span>
          )}
        </button>
      ))}
    </>
  );
}
