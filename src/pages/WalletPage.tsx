import { useState } from "react";
import "./WalletPage.css";
import { useChains } from "../lib/chains";
import { formatUnits, shortAddress } from "../lib/format";
import {
  addWatchAccount,
  setActive,
  useAccounts,
  useActiveAccount,
} from "../lib/accounts";
import { addVaultAccount, lockVault, useVault } from "../lib/vault";
import { useBalances, type BalanceState } from "../lib/useBalances";
import { useT } from "../lib/i18n";

export default function WalletPage() {
  const { t } = useT();
  const chains = useChains();
  const accounts = useAccounts();
  const active = useActiveAccount();
  const vault = useVault();
  const { balances, refresh } = useBalances(active?.address);

  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  function copyAddress() {
    navigator.clipboard.writeText(active.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  return (
    <div className="wallet">
      <header className="wallet-head">
        {/* The whole pill is the account switcher — click to switch / add / import. */}
        <div
          className={`acct${menuOpen ? " open" : ""}`}
          onClick={() => setMenuOpen((o) => !o)}
          title={t("wallet.switchAccount")}
        >
          <Avatar address={active.address} />
          <div className="acct-meta">
            <div className="acct-label">
              {active.label}
              {/* Only watch-only accounts get a badge; the signer account is the
                  default and needs none (feedback: "签名" was confusing). A Ledger
                  wallet is badged so the user knows signing happens on the device. */}
              {!active.signer ? (
                <span className="badge watch">{t("wallet.watch")}</span>
              ) : (
                vault.kind === "ledger" && <span className="badge ledger">Ledger</span>
              )}
            </div>
            <div className="acct-addr">{shortAddress(active.address, 10, 8)}</div>
          </div>
          <span className="acct-switch">
            {t("wallet.switchAccount")}
            <span className={`caret${menuOpen ? " up" : ""}`}>⌄</span>
          </span>
        </div>

        <div className="head-actions">
          <button className="icon-btn" onClick={copyAddress} title="Copy address">
            {copied ? `✓ ${t("wallet.copied")}` : `⧉ ${t("wallet.copy")}`}
          </button>
          <button className="icon-btn" onClick={refresh} title="Refresh balances">
            ⟳ {t("wallet.refresh")}
          </button>
        </div>

        {menuOpen && (
          <AccountMenu
            onPick={(addr) => {
              setActive(addr);
              setMenuOpen(false);
            }}
            onClose={() => setMenuOpen(false)}
            activeAddress={active.address}
            accounts={accounts}
          />
        )}
      </header>

      <section className="assets">
        <div className="assets-head">
          <span className="field-label">
            {t("wallet.assets")} · {t("wallet.chains", { n: chains.length })}
          </span>
        </div>
        <div className="asset-list">
          {chains.map((chain) => (
            <AssetRow
              key={chain.id}
              name={chain.name}
              symbol={chain.symbol}
              color={chain.color}
              decimals={chain.decimals}
              state={balances[chain.id]}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

function AssetRow({
  name,
  symbol,
  color,
  decimals,
  state,
}: {
  name: string;
  symbol: string;
  color: string;
  decimals: number;
  state: BalanceState | undefined;
}) {
  return (
    <div className="asset-row">
      <span className="chain-dot" style={{ background: color }} />
      <div className="asset-name">
        <div className="asset-chain">{name}</div>
        <div className="asset-sym">{symbol}</div>
      </div>
      <div className="asset-bal">
        {!state || state.status === "loading" ? (
          <span className="bal-skeleton" />
        ) : state.status === "error" ? (
          <span className="bal-error" title={state.message}>
            failed
          </span>
        ) : (
          <span className="bal-amount">
            {formatUnits(state.wei, decimals)} <span className="bal-sym">{symbol}</span>
          </span>
        )}
      </div>
    </div>
  );
}

function AccountMenu({
  accounts,
  activeAddress,
  onPick,
  onClose,
}: {
  accounts: ReturnType<typeof useAccounts>;
  activeAddress: string;
  onPick: (addr: string) => void;
  onClose: () => void;
}) {
  const { t } = useT();
  const isLedger = useVault().kind === "ledger";
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit() {
    try {
      addWatchAccount(value);
      setValue("");
      setAdding(false);
      setError(null);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <>
      <div className="menu-backdrop" onClick={onClose} />
      <div className="acct-menu">
        {accounts.map((a) => (
          <button
            key={a.address}
            className={`acct-menu-item${a.address === activeAddress ? " active" : ""}`}
            onClick={() => onPick(a.address)}
          >
            <Avatar address={a.address} size={24} />
            <div className="acct-menu-meta">
              <div className="acct-menu-label">{a.label}</div>
              <div className="acct-menu-addr">{shortAddress(a.address)}</div>
            </div>
            {a.address === activeAddress && <span className="check">✓</span>}
          </button>
        ))}

        {adding ? (
          <div className="add-row">
            <input
              autoFocus
              className="add-input"
              placeholder={t("wallet.pasteAddr")}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
            <button className="add-go" onClick={submit}>
              {t("wallet.add")}
            </button>
            {error && <div className="add-error">{error}</div>}
          </div>
        ) : (
          <>
            {/* HD "add account" only applies to a mnemonic wallet — a Ledger derives
                accounts by reconnecting the device, not from a local seed. */}
            {!isLedger && (
              <button
                className="acct-menu-add"
                onClick={async () => {
                  const addr = await addVaultAccount();
                  setActive(addr);
                  onClose();
                }}
              >
                + {t("wallet.addAccount")}
              </button>
            )}
            <button className="acct-menu-add" onClick={() => setAdding(true)}>
              + {t("wallet.addWatch")}
            </button>
          </>
        )}

        {/* A Ledger wallet has no in-process secret to lock (and locking would force
            a reconnect), so the lock action is only for software wallets. */}
        {!isLedger && (
          <button
            className="acct-menu-lock"
            onClick={async () => {
              await lockVault();
              onClose();
            }}
          >
            🔒 {t("wallet.lock")}
          </button>
        )}
      </div>
    </>
  );
}

// Deterministic gradient avatar from the address — distinct per account, no
// image lib, no network.
function Avatar({ address, size = 38 }: { address: string; size?: number }) {
  const h1 = parseInt(address.slice(2, 6), 16) % 360;
  const h2 = parseInt(address.slice(6, 10), 16) % 360;
  return (
    <span
      className="avatar"
      style={{
        width: size,
        height: size,
        background: `linear-gradient(135deg, hsl(${h1} 80% 62%), hsl(${h2} 75% 52%))`,
      }}
    />
  );
}
