import "./BrowserView.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { useChains, type Chain } from "../lib/chains";
import { shortAddress } from "../lib/format";
import { setActive, useAccounts, useActiveAccount } from "../lib/accounts";
import { setActiveChain, useActiveChain } from "../lib/activeChain";
import { useT } from "../lib/i18n";
import { Icon } from "../lib/icons";
import { Avatar } from "../lib/ui";
import { toast } from "../lib/toast";
import { faviconOf, hostOf, type Dapp } from "../lib/dapps";
import { dappLabel, hideDapp, isTauri, openDapp, rectOf, setDappBounds } from "../lib/platform";

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

  const [focus, setFocus] = useState(false);
  const [url, setUrl] = useState(dapp.url);

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

  // Native child webviews render above the shell, so a shell dropdown cannot truly
  // float over the dApp webview. While a menu is open, keep the page visible below
  // the menu by cropping only the top strip that the menu occupies.
  useEffect(() => {
    if (!native) return;
    const el = contentRef.current;
    if (!el) return;
    const id = requestAnimationFrame(() => {
      if (!menuOpen) {
        void openDapp(label, dapp.url, rectOf(el));
        return;
      }
      const full = rectOf(el);
      const menu = document.querySelector(".chain-menu") as HTMLElement | null;
      const menuBottom = menu?.getBoundingClientRect().bottom ?? full.y;
      const top = Math.min(full.y + full.h - 1, Math.max(full.y, menuBottom + 8));
      void setDappBounds(label, { x: full.x, y: top, w: full.w, h: full.y + full.h - top });
    });
    return () => cancelAnimationFrame(id);
  }, [menuOpen, native, label, dapp.url]);

  return (
    <div className="browser">
      <header className="browser-bar">
        <button className="icon-btn" onClick={onBack} title={t("browser.back")}>
          <Icon name="arrowLeft" size={18} />
        </button>
        <button className="icon-btn" onClick={() => toast(t("browser.reloaded"))} title={t("browser.reload")}>
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
              setUrl(dapp.url);
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
            <iframe className="dapp-frame" src={dapp.url} title={dapp.name} />
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
        <span className="chain-dot" style={{ width: 11, height: 11, background: chain.color }} />
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
                <span className="chain-dot" style={{ width: 18, height: 18, background: c.color }} />
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
