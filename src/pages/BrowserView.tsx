import "./BrowserView.css";
import { useEffect, useRef, useState } from "react";
import { useChains, type Chain } from "../lib/chains";
import { shortAddress } from "../lib/format";
import { useActiveAccount } from "../lib/accounts";
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
  const account = useActiveAccount();
  const chainId = useActiveChain();
  const chains = useChains();
  const chain = chains.find((c) => c.id === chainId) ?? chains[0];
  const contentRef = useRef<HTMLDivElement>(null);
  const native = isTauri();

  const [focus, setFocus] = useState(false);
  const [url, setUrl] = useState(dapp.url);

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
          <ChainChip chain={chain} chains={chains} />
          <div className="acct-chip" title={account.label}>
            <Avatar address={account.address} size={24} />
            <span className="mono">{shortAddress(account.address, 5, 4)}</span>
          </div>
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

function ChainChip({ chain, chains }: { chain: Chain; chains: Chain[] }) {
  const [open, setOpen] = useState(false);
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
