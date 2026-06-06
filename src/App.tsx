import { useEffect, useRef, useState } from "react";
import "./App.css";
import mascot from "./assets/mascot.png";
import WalletPage from "./pages/WalletPage";
import DappsPage from "./pages/DappsPage";
import BrowserView from "./pages/BrowserView";
import SettingsPage from "./pages/SettingsPage";
import LockScreen from "./pages/LockScreen";
import { faviconOf, type Dapp } from "./lib/dapps";
import { closeDapp, dappLabel } from "./lib/platform";
import { refreshVaultStatus, useVault } from "./lib/vault";
import { useT } from "./lib/i18n";

type Page = "wallet" | "dapps" | "browser" | "settings";
type Tab = { id: string; dapp: Dapp };

const NAV: { key: "wallet" | "dapps"; i18n: string; icon: string }[] = [
  { key: "wallet", i18n: "nav.wallet", icon: "👛" },
  { key: "dapps", i18n: "nav.dapps", icon: "🧩" },
];

function App() {
  const { t } = useT();
  const vault = useVault();

  // Gate the whole app behind the vault: load its status on boot, then show the
  // lock/setup screen until the wallet is unlocked for this session. A backend
  // already unlocked on boot (vite HMR during dev) opens the gate without a prompt.
  const [sessionUnlocked, setSessionUnlocked] = useState(false);
  const phaseRef = useRef(vault.phase);
  phaseRef.current = vault.phase;
  useEffect(() => {
    void refreshVaultStatus().then(() => {
      if (phaseRef.current === "unlocked") setSessionUnlocked(true);
    });
  }, []);
  // Locking the wallet (or any drop to a non-unlocked phase) re-closes the gate.
  useEffect(() => {
    if (vault.phase === "locked" || vault.phase === "absent") setSessionUnlocked(false);
  }, [vault.phase]);

  const [page, setPage] = useState<Page>("wallet");
  // Every open dApp is a persistent tab (its own native webview); switching tabs
  // just shows/hides them. VISION feature ②③.
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  const activeTab = tabs.find((t) => t.id === activeId) ?? null;

  // Open (or focus) a tab for a dApp.
  function openTab(dapp: Dapp) {
    setTabs((prev) => (prev.some((t) => t.id === dapp.id) ? prev : [...prev, { id: dapp.id, dapp }]));
    setActiveId(dapp.id);
    setPage("browser");
  }

  function closeTab(id: string) {
    void closeDapp(dappLabel(id)); // destroy the native webview
    const remaining = tabs.filter((t) => t.id !== id);
    setTabs(remaining);
    if (activeId === id) {
      const next = remaining[remaining.length - 1] ?? null;
      setActiveId(next?.id ?? null);
      setPage(next ? "browser" : "dapps");
    }
  }

  // Boot splash while we read the vault status, then the lock/setup gate.
  if (vault.phase === "loading") {
    return (
      <div className="boot">
        <img src={mascot} alt="" width={48} height={48} />
      </div>
    );
  }
  if (!sessionUnlocked) {
    return <LockScreen onDone={() => setSessionUnlocked(true)} />;
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-mark" src={mascot} alt="" width={28} height={28} />
          <span className="brand-name">AutoDesktop</span>
        </div>

        <nav className="nav">
          {NAV.map((item) => (
            <button
              key={item.key}
              className={`nav-item${page === item.key ? " active" : ""}`}
              onClick={() => setPage(item.key)}
            >
              <span className="nav-icon">{item.icon}</span>
              {t(item.i18n)}
            </button>
          ))}

          {tabs.length > 0 && (
            <>
              <div className="nav-section">{t("nav.opened")}</div>
              {tabs.map((t) => (
                <TabItem
                  key={t.id}
                  tab={t}
                  active={page === "browser" && t.id === activeId}
                  onOpen={() => {
                    setActiveId(t.id);
                    setPage("browser");
                  }}
                  onClose={() => closeTab(t.id)}
                />
              ))}
            </>
          )}
        </nav>

        <button
          className={`nav-item settings${page === "settings" ? " active" : ""}`}
          onClick={() => setPage("settings")}
        >
          <span className="nav-icon">⚙️</span>
          {t("nav.settings")}
        </button>
      </aside>

      <main className="main">
        {page === "wallet" && <WalletPage />}
        {page === "dapps" && <DappsPage onOpen={openTab} />}
        {page === "browser" && activeTab && (
          <BrowserView key={activeTab.id} tab={activeTab} onBack={() => setPage("dapps")} />
        )}
        {page === "settings" && <SettingsPage />}
      </main>
    </div>
  );
}

function TabItem({
  tab,
  active,
  onOpen,
  onClose,
}: {
  tab: Tab;
  active: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  return (
    <div className={`nav-item tab${active ? " active" : ""}`} onClick={onOpen}>
      <img className="tab-favicon" src={faviconOf(tab.dapp.url)} alt="" width={16} height={16} />
      <span className="tab-name">{tab.dapp.name}</span>
      <button
        className="tab-close"
        title="Close tab"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        ×
      </button>
    </div>
  );
}

export default App;
