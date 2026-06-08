import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import "./App.css";
import mascot from "./assets/mascot.png";
import WalletPage from "./pages/WalletPage";
import DappsPage from "./pages/DappsPage";
import BrowserView from "./pages/BrowserView";
import SettingsPage from "./pages/SettingsPage";
import LockScreen from "./pages/LockScreen";
import { ensureDapp, faviconOf, type Dapp } from "./lib/dapps";
import { closeDapp, dappLabel, isTauri } from "./lib/platform";
import { refreshVaultStatus, useVault } from "./lib/vault";
import { useActiveAccount, useActiveAccountSync } from "./lib/accounts";
import { loadChains } from "./lib/chains";
import { useT } from "./lib/i18n";
import { Icon } from "./lib/icons";
import { setThemePref, useEffectiveTheme } from "./lib/theme";
import { shortAddress } from "./lib/format";
import { Avatar, ToastHost } from "./lib/ui";
import { toast } from "./lib/toast";
import type { ActivityRecord } from "./lib/activity";

type Page = "wallet" | "dapps" | "browser" | "settings";
type Tab = { id: string; dapp: Dapp };

const SIDEBAR_KEY = "autodesktop.sidebarCollapsed";

function App() {
  const vault = useVault();
  const { t, lang } = useT();
  // Reconcile the backend's active signer with the shell's remembered selection so a
  // dApp always connects to the account shown in the sidebar (and follows wallet
  // switches). Backend resets to the first account on every unlock; this re-syncs it.
  useActiveAccountSync();

  // Gate the whole app behind the vault: load its status on boot, then show the
  // lock/setup screen until the wallet is unlocked for this session. A backend
  // already unlocked on boot (vite HMR during dev) opens the gate without a prompt.
  const [sessionUnlocked, setSessionUnlocked] = useState(false);
  const phaseRef = useRef(vault.phase);
  phaseRef.current = vault.phase;
  useEffect(() => {
    void loadChains();
    void refreshVaultStatus().then(() => {
      if (phaseRef.current === "unlocked") setSessionUnlocked(true);
    });
  }, []);
  useEffect(() => {
    if (vault.phase === "locked" || vault.phase === "absent")
      setSessionUnlocked(false);
  }, [vault.phase]);
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listen<ActivityRecord>("activity-recorded", (event) => {
      const hash = event.payload?.hash;
      toast(
        t("wallet.txSubmitted", { hash: hash ? shortAddress(hash, 8, 6) : "" }),
      );
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [lang]);

  const [page, setPage] = useState<Page>("wallet");
  const [collapsed, setCollapsed] = useState<boolean>(
    () => localStorage.getItem(SIDEBAR_KEY) === "1",
  );
  function toggleSidebar() {
    setCollapsed((c) => {
      localStorage.setItem(SIDEBAR_KEY, c ? "0" : "1");
      return !c;
    });
  }

  // Every open dApp is a persistent tab (its own native webview); switching tabs
  // just shows/hides them. VISION feature ②③.
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeTab = tabs.find((t) => t.id === activeId) ?? null;

  function openTab(dapp: Dapp) {
    setTabs((prev) =>
      prev.some((t) => t.id === dapp.id)
        ? prev
        : [...prev, { id: dapp.id, dapp }],
    );
    setActiveId(dapp.id);
    setPage("browser");
  }

  useEffect(() => {
    const onOpenDapp = (event: Event) => {
      const dapp = (event as CustomEvent<Dapp>).detail;
      if (!dapp?.id || !dapp.url || !dapp.name) return;
      openTab(ensureDapp(dapp.url, dapp.name));
    };
    window.addEventListener("autodesktop:open-dapp", onOpenDapp);
    return () => window.removeEventListener("autodesktop:open-dapp", onOpenDapp);
  }, []);

  function closeTab(id: string) {
    void closeDapp(dappLabel(id));
    const remaining = tabs.filter((t) => t.id !== id);
    setTabs(remaining);
    if (activeId === id) {
      const next = remaining[remaining.length - 1] ?? null;
      setActiveId(next?.id ?? null);
      setPage(next ? "browser" : "dapps");
    }
  }

  if (vault.phase === "loading") {
    return (
      <div className="boot">
        <img src={mascot} alt="" width={48} height={48} />
      </div>
    );
  }
  if (!sessionUnlocked) {
    return (
      <>
        <LockScreen onDone={() => setSessionUnlocked(true)} />
        <ToastHost />
      </>
    );
  }

  return (
    <div className="app">
      <Sidebar
        collapsed={collapsed}
        onToggle={toggleSidebar}
        page={page}
        setPage={setPage}
        tabs={tabs}
        activeId={activeId}
        onOpenTab={(id) => {
          setActiveId(id);
          setPage("browser");
        }}
        onCloseTab={closeTab}
      />

      <main className="main">
        {page === "wallet" && <WalletPage />}
        {page === "dapps" && <DappsPage onOpen={openTab} />}
        {page === "browser" && activeTab && (
          <BrowserView
            key={activeTab.id}
            tab={activeTab}
            onBack={() => setPage("dapps")}
          />
        )}
        {page === "settings" && <SettingsPage />}
      </main>

      <ToastHost />
    </div>
  );
}

function Sidebar({
  collapsed,
  onToggle,
  page,
  setPage,
  tabs,
  activeId,
  onOpenTab,
  onCloseTab,
}: {
  collapsed: boolean;
  onToggle: () => void;
  page: Page;
  setPage: (p: Page) => void;
  tabs: Tab[];
  activeId: string | null;
  onOpenTab: (id: string) => void;
  onCloseTab: (id: string) => void;
}) {
  const { t } = useT();
  const account = useActiveAccount();
  const theme = useEffectiveTheme();

  const nav: {
    key: "wallet" | "dapps";
    i18n: string;
    icon: "wallet" | "compass";
  }[] = [
    { key: "wallet", i18n: "nav.wallet", icon: "wallet" },
    { key: "dapps", i18n: "nav.explore", icon: "compass" },
  ];

  return (
    <aside className={`sidebar${collapsed ? " collapsed" : ""}`}>
      <div className="side-top">
        <div className="brand">
          <img className="brand-mark" src={mascot} alt="" />
          {!collapsed && (
            <span className="brand-name">
              Auto<b>Desktop</b>
            </span>
          )}
        </div>
        <button
          className="icon-btn bare"
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={onToggle}
          style={collapsed ? { alignSelf: "center" } : undefined}
        >
          <Icon name="sidebar" size={17} />
        </button>
      </div>

      <nav className="nav">
        {nav.map((item) => (
          <button
            key={item.key}
            className={`nav-item${page === item.key ? " active" : ""}`}
            title={collapsed ? t(item.i18n) : ""}
            onClick={() => setPage(item.key)}
          >
            <span className="nav-ic">
              <Icon name={item.icon} size={19} />
            </span>
            {!collapsed && <span className="nav-label">{t(item.i18n)}</span>}
          </button>
        ))}

        {tabs.length > 0 && (
          <>
            {!collapsed ? (
              <div className="nav-section">{t("nav.opened")}</div>
            ) : (
              <div style={{ height: 12 }} />
            )}
            {tabs.map((tab) => (
              <div
                key={tab.id}
                className={`nav-item tab-item${page === "browser" && tab.id === activeId ? " active" : ""}`}
                title={collapsed ? tab.dapp.name : ""}
                onClick={() => onOpenTab(tab.id)}
              >
                <img className="tab-fav" src={faviconOf(tab.dapp.url)} alt="" />
                {!collapsed && (
                  <>
                    <span className="tab-name">{tab.dapp.name}</span>
                    <button
                      className="tab-close"
                      title="Close tab"
                      onClick={(e) => {
                        e.stopPropagation();
                        onCloseTab(tab.id);
                      }}
                    >
                      <Icon name="close" size={13} />
                    </button>
                  </>
                )}
              </div>
            ))}
          </>
        )}
      </nav>

      <button
        className={`nav-item${page === "settings" ? " active" : ""}`}
        title={collapsed ? t("nav.settings") : ""}
        onClick={() => setPage("settings")}
        style={{ marginBottom: 8 }}
      >
        <span className="nav-ic">
          <Icon name="settings" size={19} />
        </span>
        {!collapsed && <span className="nav-label">{t("nav.settings")}</span>}
      </button>

      <div className="side-foot">
        <div className="theme-seg">
          <button
            className={theme === "light" ? "on" : ""}
            title="Light"
            onClick={() => setThemePref("light")}
          >
            <Icon name="sun" size={16} />
          </button>
          <button
            className={theme === "dark" ? "on" : ""}
            title="Dark"
            onClick={() => setThemePref("dark")}
          >
            <Icon name="moon" size={16} />
          </button>
        </div>
        <button
          className="acct-foot"
          onClick={() => setPage("wallet")}
          title={collapsed ? account.label : ""}
        >
          <Avatar address={account.address} size={30} />
          {!collapsed && (
            <div className="acct-foot-meta">
              <div className="acct-foot-name">{account.label}</div>
              <div className="acct-foot-addr">
                {shortAddress(account.address, 6, 4)}
              </div>
            </div>
          )}
        </button>
      </div>
    </aside>
  );
}

export default App;
