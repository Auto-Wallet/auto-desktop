import "./BrowserView.css";
import { useEffect, useRef } from "react";
import { useChains } from "../lib/chains";
import { shortAddress } from "../lib/format";
import { useActiveAccount } from "../lib/accounts";
import { setActiveChain, useActiveChain } from "../lib/activeChain";
import { useT } from "../lib/i18n";
import { faviconOf, hostOf, type Dapp } from "../lib/dapps";
import { dappLabel, hideDapp, isTauri, openDapp, rectOf, setDappBounds } from "../lib/platform";

export type Tab = { id: string; dapp: Dapp };

// The chrome around one open dApp tab (VISION feature ③): top bar with the URL,
// current chain and account, content below. Each tab is a persistent native
// `dapp-<id>` child webview (Rust-side, window.ethereum injected) that the shell
// shows over `.browser-content`; switching tabs hides one and shows another
// without reloading. In the browser preview we stand it in with an <iframe>.
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
        <button className="back" onClick={onBack} title={t("browser.back")}>
          ‹
        </button>
        <div className="url-bar">
          <img className="url-favicon" src={faviconOf(dapp.url)} alt="" width={16} height={16} />
          <span className="url-text">{dapp.url}</span>
        </div>
        <div className="chips">
          <label className="chip chain" style={{ ["--dot" as string]: chain.color }}>
            <span className="chain-dot-sm" />
            <select value={chainId} onChange={(e) => void setActiveChain(e.target.value)}>
              {chains.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <span className="chip account">{shortAddress(account.address, 6, 4)}</span>
        </div>
      </header>

      <section className="browser-content" ref={contentRef}>
        {native ? (
          // The native webview renders here; nothing to paint in the shell.
          <div className="native-placeholder" />
        ) : (
          <>
            <iframe className="dapp-frame" src={dapp.url} title={dapp.name} />
            <div className="frame-note">
              In the desktop app, <b>{hostOf(dapp.url)}</b> loads in a native webview here
              with <code>window.ethereum</code> injected. Some sites block the preview iframe.
            </div>
          </>
        )}
      </section>
    </div>
  );
}
