import "./BrowserView.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useChains, type Chain } from "../lib/chains";
import { shortAddress } from "../lib/format";
import { setActive, useAccounts, useActiveAccount } from "../lib/accounts";
import { setActiveChain, useActiveChain } from "../lib/activeChain";
import { useT } from "../lib/i18n";
import { Icon } from "../lib/icons";
import { Avatar } from "../lib/ui";
import { toast, useToasts } from "../lib/toast";
import { ChainIcon } from "../lib/ChainIcon";
import { faviconOf, hostOf, type Dapp } from "../lib/dapps";
import {
  dappLabel,
  hideDapp,
  isTauri,
  openDapp,
  rectOf,
  reloadDapp,
  setDappBounds,
} from "../lib/platform";

export type Tab = { id: string; dapp: Dapp };

// The chrome around one open dApp tab (VISION feature ③), restyled to Aurora:
// top bar with back/reload, the URL, the active chain + account chips, content
// below. Each tab is a persistent native `dapp-<id>` child webview (Rust-side,
// window.ethereum injected) that the shell shows over `.browser-content`;
// switching tabs hides one and shows another without reloading. In the browser
// preview we stand it in with an <iframe>. The native-webview positioning logic
// is unchanged — only the surrounding chrome was redesigned.
export default function BrowserView({ tab, onBack }: { tab: Tab; onBack: () => void }) {
  const { dapp } = tab;
  const { t } = useT();
  const label = dappLabel(tab.id);
  const chainId = useActiveChain();
  const chains = useChains();
  const chain = chains.find((c) => c.id === chainId) ?? chains[0];
  const contentRef = useRef<HTMLDivElement>(null);
  const native = isTauri();
  const toasts = useToasts();

  const [focus, setFocus] = useState(false);
  const [currentUrl, setCurrentUrl] = useState(dapp.url);
  const [url, setUrl] = useState(dapp.url);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [reloading, setReloading] = useState(false);

  // A topbar dropdown (chain / account) is drawn by the SHELL, but the dApp's
  // native child webview renders ON TOP of the shell within the content rect — so a
  // menu hanging into that rect gets occluded by the page. While any menu is open we
  // hide the dApp webview (it's not closed — the page is preserved) and re-show it on
  // close. `openMenus` counts open menus so two toggles can't desync the visibility.
  const [openMenus, setOpenMenus] = useState(0);
  const reportMenu = useCallback(
    (open: boolean) => setOpenMenus((n) => Math.max(0, n + (open ? 1 : -1))),
    [],
  );
  const menuOpen = openMenus > 0;

  useEffect(() => {
    setCurrentUrl(dapp.url);
    setUrl(dapp.url);
  }, [dapp.url]);

  useEffect(() => {
    if (!native) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listen<{ label: string; url: string }>("dapp-navigated", (event) => {
      if (event.payload?.label !== label) return;
      setCurrentUrl(event.payload.url);
      setUrl(event.payload.url);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [native, label]);

  // Show this tab's native webview over the content rect, track resizes, and hide
  // it (NOT close — the tab persists) when this view unmounts/switches away.
  useEffect(() => {
    if (!native) return;
    const el = contentRef.current;
    if (!el) return;

    void openDapp(label, dapp.url, rectOf(el));

    const sync = () => void setDappBounds(label, rectOf(el));
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    window.addEventListener("resize", sync);

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", sync);
      void hideDapp(label);
    };
  }, [native, label, dapp.url]);

  // Native child webviews render above the shell, so shell overlays cannot truly
  // float over the dApp webview. While a top-right menu or toast is visible, keep
  // the dApp at its original vertical position and crop only the right strip behind
  // that overlay. Cropping the top/bottom strips made pages look pushed around.
  useEffect(() => {
    if (!native) return;
    const el = contentRef.current;
    if (!el) return;
    const id = requestAnimationFrame(() => {
      const full = rectOf(el);
      const overlays = Array.from(
        document.querySelectorAll<HTMLElement>(".chain-menu, .toast-wrap .toast"),
      );
      const overlayLeft = overlays
        .map((overlay) => overlay.getBoundingClientRect())
        .filter((overlay) => overlay.bottom > full.y && overlay.top < full.y + full.h)
        .filter((overlay) => overlay.left < full.x + full.w && overlay.right > full.x)
        .reduce((left, overlay) => Math.min(left, overlay.left), full.x + full.w);

      if (overlayLeft >= full.x + full.w) {
        void openDapp(label, dapp.url, full);
        return;
      }

      const width = Math.max(1, Math.min(full.w, overlayLeft - full.x - 8));
      void setDappBounds(label, { x: full.x, y: full.y, w: width, h: full.h });
    });
    return () => cancelAnimationFrame(id);
  }, [menuOpen, native, label, dapp.url, toasts.length]);

  async function handleReload() {
    if (reloading) return;
    setReloading(true);
    try {
      if (native) {
        await reloadDapp(label);
      } else {
        setReloadNonce((n) => n + 1);
      }
      window.setTimeout(() => setReloading(false), 800);
    } catch {
      setReloading(false);
    }
  }

  return (
    <div className="browser">
      <header className="browser-bar">
        <button className="icon-btn" onClick={onBack} title={t("browser.back")}>
          <Icon name="arrowLeft" size={18} />
        </button>
        <button
          className={`icon-btn browser-reload${reloading ? " loading" : ""}`}
          onClick={() => void handleReload()}
          title={t("browser.reload")}
          disabled={reloading}
        >
          <Icon name="refresh" size={17} />
        </button>

        <div className={`url-bar${focus ? " focus" : ""}`}>
          <span className="lock-ic">
            <Icon name="lock" size={14} />
          </span>
          <img className="url-fav" src={faviconOf(dapp.url)} alt="" />
          <input
            value={url}
            spellCheck={false}
            onChange={(e) => setUrl(e.target.value)}
            onFocus={(e) => {
              setFocus(true);
              e.target.select();
            }}
            onBlur={() => {
              setFocus(false);
              setUrl(currentUrl);
            }}
          />
          <Icon name="external" size={15} />
        </div>

        <div className="browser-chips">
          <ChainChip chain={chain} chains={chains} onMenu={reportMenu} />
          <AcctChip onMenu={reportMenu} />
        </div>
      </header>

      <section className="browser-content" ref={contentRef}>
        {native ? (
          <div className="native-placeholder" />
        ) : (
          <>
            <iframe
              key={reloadNonce}
              className="dapp-frame"
              src={dapp.url}
              title={dapp.name}
              onLoad={() => setReloading(false)}
            />
            <div className="frame-note">
              <Icon name="shieldCheck" size={15} /> In the desktop app, <b>{hostOf(dapp.url)}</b> loads in a
              native webview with <code>window.ethereum</code> injected.
            </div>
          </>
        )}
      </section>
    </div>
  );
}

// The account chip in the dApp top bar IS a wallet switcher: picking an account
// runs setActive → selectAccount, which switches the backend's active signer and
// pushes accountsChanged into this dApp, so the page follows the new address.
function AcctChip({ onMenu }: { onMenu: (open: boolean) => void }) {
  const { t } = useT();
  const accounts = useAccounts();
  const active = useActiveAccount();
  const [open, setOpen] = useState(false);
  // Tell the parent when the menu is open so it can keep the native webview below it.
  useEffect(() => {
    if (!open) return;
    onMenu(true);
    return () => onMenu(false);
  }, [open, onMenu]);
  const isActive = (addr: string) => addr.toLowerCase() === active.address.toLowerCase();
  function copyAddress(address: string) {
    void navigator.clipboard.writeText(address);
    toast(t("common.copied"));
  }
  return (
    <div className="chain-wrap">
      <button className="acct-chip" onClick={() => setOpen((o) => !o)} title={t("wallet.switchAccount")}>
        <Avatar address={active.address} size={24} />
        <span className="mono">{shortAddress(active.address, 5, 4)}</span>
        <Icon name="chevronD" size={14} />
      </button>
      {open && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 30 }} onClick={() => setOpen(false)} />
          <div className="chain-menu acct-pop scroll">
            {accounts.map((a) => (
              <div
                key={a.address}
                role="button"
                tabIndex={0}
                className={`acct-opt${isActive(a.address) ? " on" : ""}`}
                onClick={() => {
                  setActive(a.address);
                  setOpen(false);
                }}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.preventDefault();
                  setActive(a.address);
                  setOpen(false);
                }}
              >
                <Avatar address={a.address} size={28} />
                <span className="meta">
                  <span className="l">{a.label}</span>
                  <span className="a">{shortAddress(a.address, 8, 6)}</span>
                </span>
                <button
                  className="acct-copy"
                  title={t("wallet.copy")}
                  onClick={(e) => {
                    e.stopPropagation();
                    copyAddress(a.address);
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
          </div>
        </>
      )}
    </div>
  );
}

function ChainChip({ chain, chains, onMenu }: { chain: Chain; chains: Chain[]; onMenu: (open: boolean) => void }) {
  const [open, setOpen] = useState(false);
  // Hide the dApp webview underneath while this menu is open (see AcctChip).
  useEffect(() => {
    if (!open) return;
    onMenu(true);
    return () => onMenu(false);
  }, [open, onMenu]);
  return (
    <div className="chain-wrap">
      <button className="chain-chip" onClick={() => setOpen((o) => !o)}>
        <ChainIcon chain={chain} size={16} />
        {chain.name}
        <Icon name="chevronD" size={14} />
      </button>
      {open && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 30 }} onClick={() => setOpen(false)} />
          <div className="chain-menu">
            {chains.map((c) => (
              <button
                key={c.id}
                className={`chain-opt${c.id === chain.id ? " on" : ""}`}
                onClick={() => {
                  void setActiveChain(c.id);
                  setOpen(false);
                }}
              >
                <ChainIcon chain={c} size={20} />
                <span className="nm">{c.name}</span>
                {c.id === chain.id && (
                  <span className="check">
                    <Icon name="check" size={16} />
                  </span>
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
