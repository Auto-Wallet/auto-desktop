import { useMemo, useState } from "react";
import "./WalletPage.css";
import { useChains, type Chain } from "../lib/chains";
import { fmtPct, fmtUsd, formatUnits, shortAddress, weiToUsd } from "../lib/format";
import {
  addVaultAccount,
  lockVault,
  useVault,
  type VaultState,
} from "../lib/vault";
import {
  addWatchAccount,
  setActive,
  useAccounts,
  useActiveAccount,
  type Account,
} from "../lib/accounts";
import { useBalances, type BalanceState } from "../lib/useBalances";
import { usePrices, type Price, type PriceState } from "../lib/prices";
import { useT } from "../lib/i18n";
import { Icon, type IconName } from "../lib/icons";
import { Avatar } from "../lib/ui";
import { toast } from "../lib/toast";

// Wallet page (VISION ①). Aurora portfolio: account switcher, hero with a REAL
// total (native balances × live CoinGecko prices), quick actions, a per-chain
// native token list with USD, and an honest "coming soon" for activity. No
// fabricated holdings — prices/balances that fail surface as explicit states.
export default function WalletPage() {
  const { t } = useT();
  const chains = useChains();
  const accounts = useAccounts();
  const active = useActiveAccount();
  const vault = useVault();
  const { balances, refresh } = useBalances(active.address);
  const { state: prices, refresh: refreshPrices } = usePrices(chains.map((c) => c.symbol));

  const [hidden, setHidden] = useState(false);
  const [tab, setTab] = useState<"tokens" | "activity">("tokens");
  const [filter, setFilter] = useState<string>("all");
  const [showReceive, setShowReceive] = useState(false);

  const isWatch = !active.signer;
  const portfolio = useMemo(
    () => computePortfolio(chains, balances, prices),
    [chains, balances, prices],
  );

  function copyAddress() {
    navigator.clipboard.writeText(active.address);
    toast(t("common.copied"));
  }
  function refreshAll() {
    refresh();
    refreshPrices();
    toast(t("common.refreshed"));
  }

  const shownChains = chains.filter((c) => filter === "all" || c.id === filter);

  return (
    <>
      <div className="topbar">
        <AccountSwitcher accounts={accounts} active={active} vault={vault} />
        <div className="grow" />
        <button className="icon-btn" title={t("wallet.copy")} onClick={copyAddress}>
          <Icon name="copy" size={17} />
        </button>
        <button className="icon-btn" title={t("wallet.refresh")} onClick={refreshAll}>
          <Icon name="refresh" size={17} />
        </button>
      </div>

      <div className="page scroll">
        <div className="wallet-pad">
          {/* Portfolio hero */}
          <div className="hero">
            <div className="hero-row">
              <div>
                <div className="hero-label">
                  <Icon name="wallet" size={15} /> {t("wallet.total")} · {active.label}
                </div>
                {portfolio.loading && portfolio.total == null ? (
                  <div className="hero-skel" />
                ) : portfolio.total != null ? (
                  <>
                    <div className="hero-total disp tnum">
                      {hidden ? "••••••" : <HeroAmount n={portfolio.total} />}
                    </div>
                    {portfolio.change != null && (
                      <div className="hero-change">
                        <span className="pill">
                          <Icon name={portfolio.change >= 0 ? "arrowUp" : "arrowDown"} size={13} />
                          {fmtPct(portfolio.change)}
                        </span>
                        <span style={{ opacity: 0.9 }}>· 24h</span>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div className="hero-total disp tnum">{hidden ? "••••••" : "$—"}</div>
                    <div className="hero-note">
                      <Icon name="info" size={13} /> {t("wallet.pricesUnavailable")}
                    </div>
                  </>
                )}
              </div>
              <button
                className="hero-eye"
                onClick={() => setHidden((h) => !h)}
                title={hidden ? t("wallet.showBalance") : t("wallet.hideBalance")}
              >
                <Icon name={hidden ? "eyeOff" : "eye"} size={17} />
              </button>
            </div>
          </div>

          {/* Quick actions */}
          {isWatch ? (
            <div className="quick">
              <div className="card watch-banner">
                <Icon name="eye" size={18} /> {t("wallet.watchOnly")}
              </div>
            </div>
          ) : (
            <div className="quick">
              <QuickBtn icon="receive" label={t("wallet.receive")} onClick={() => setShowReceive(true)} />
              <QuickBtn icon="send" coral label={t("wallet.send")} onClick={() => toast(t("wallet.sendSoon"), "info")} />
              <QuickBtn icon="swap" label={t("wallet.swap")} onClick={() => toast(t("wallet.swapSoon"), "info")} />
              <QuickBtn icon="buy" label={t("wallet.buy")} onClick={() => toast(t("wallet.buySoon"), "info")} />
            </div>
          )}

          {/* Tokens / Activity */}
          <div className="holdings">
            <div className="holdings-head">
              <div className="seg">
                <button className={tab === "tokens" ? "on" : ""} onClick={() => setTab("tokens")}>
                  {t("wallet.tokens")}
                </button>
                <button className={tab === "activity" ? "on" : ""} onClick={() => setTab("activity")}>
                  {t("wallet.activity")}
                </button>
              </div>
            </div>

            {tab === "tokens" ? (
              <>
                <div className="chain-filter">
                  <button
                    className={`cf-pill${filter === "all" ? " on" : ""}`}
                    onClick={() => setFilter("all")}
                  >
                    {t("wallet.allNetworks")}
                  </button>
                  {chains.map((c) => (
                    <button
                      key={c.id}
                      className={`cf-pill${filter === c.id ? " on" : ""}`}
                      onClick={() => setFilter(c.id)}
                    >
                      <span className="chain-dot" style={{ width: 9, height: 9, background: c.color }} />
                      {c.name}
                    </button>
                  ))}
                </div>
                <div className="token-list">
                  {shownChains.map((c) => (
                    <TokenRow
                      key={c.id}
                      chain={c}
                      state={balances[c.id]}
                      price={prices.status === "ok" ? prices.prices[c.symbol.toUpperCase()] : undefined}
                    />
                  ))}
                </div>
                <button className="add-token" onClick={() => toast(t("wallet.tokensSoon"), "info")}>
                  <Icon name="plus" size={16} /> {t("wallet.addToken")}
                </button>
              </>
            ) : (
              <div className="empty">
                <div className="empty-ic">
                  <Icon name="activity" size={28} />
                </div>
                {t("wallet.activitySoon")}
              </div>
            )}
          </div>
        </div>
      </div>

      {showReceive && <ReceiveModal account={active} onClose={() => setShowReceive(false)} />}
    </>
  );
}

type Portfolio = { total: number | null; change: number | null; loading: boolean };

function computePortfolio(chains: Chain[], balances: Record<string, BalanceState>, prices: PriceState): Portfolio {
  const loading =
    prices.status === "loading" ||
    chains.some((c) => !balances[c.id] || balances[c.id].status === "loading");
  if (prices.status !== "ok") return { total: null, change: null, loading };

  let total = 0;
  let delta = 0;
  let priced = false;
  for (const c of chains) {
    const b = balances[c.id];
    if (!b || b.status !== "ok") continue;
    const p = prices.prices[c.symbol.toUpperCase()];
    if (!p) continue;
    const v = weiToUsd(b.wei, c.decimals, p.usd);
    total += v;
    delta += v * (p.change24h / 100);
    priced = true;
  }
  if (!priced) return { total: null, change: null, loading };
  const prev = total - delta;
  const change = prev > 0 ? (delta / prev) * 100 : 0;
  return { total, change, loading };
}

function HeroAmount({ n }: { n: number }) {
  const [whole, cents] = fmtUsd(n).replace("$", "").split(".");
  return (
    <>
      ${whole}
      <span className="cents">.{cents}</span>
    </>
  );
}

function QuickBtn({
  icon,
  label,
  coral,
  onClick,
}: {
  icon: IconName;
  label: string;
  coral?: boolean;
  onClick: () => void;
}) {
  return (
    <button className={`quick-btn${coral ? " coral" : ""}`} onClick={onClick}>
      <span className="quick-ic">
        <Icon name={icon} size={20} />
      </span>
      <span className="lbl">{label}</span>
    </button>
  );
}

function Coin({ symbol, color, size = 40 }: { symbol: string; color: string; size?: number }) {
  const letters = symbol.slice(0, symbol.length > 3 ? 3 : symbol.length);
  return (
    <span className="coin" style={{ width: size, height: size }}>
      <span
        className="coin-glyph"
        style={{ width: size, height: size, background: color, fontSize: letters.length > 2 ? 11 : 13 }}
      >
        {letters}
      </span>
    </span>
  );
}

function TokenRow({
  chain,
  state,
  price,
}: {
  chain: Chain;
  state: BalanceState | undefined;
  price?: Price;
}) {
  const usd = state?.status === "ok" && price ? weiToUsd(state.wei, chain.decimals, price.usd) : null;
  const up = (price?.change24h ?? 0) >= 0;
  return (
    <div className="token-row">
      <Coin symbol={chain.symbol} color={chain.color} />
      <div className="token-meta">
        <div className="token-name">{chain.name}</div>
        <div className="token-sub">
          <span className="chain-dot" style={{ width: 8, height: 8, background: chain.color }} />
          {chain.symbol}
          {price && <span className={`chg ${up ? "up" : "down"}`}>{fmtPct(price.change24h)}</span>}
        </div>
      </div>
      <div className="token-right">
        {!state || state.status === "loading" ? (
          <span className="skeleton" style={{ width: 72, height: 14 }} />
        ) : state.status === "error" ? (
          <span className="token-err" title={state.message}>
            failed
          </span>
        ) : (
          <>
            {usd != null && <div className="token-usd tnum">{fmtUsd(usd)}</div>}
            <div className="token-amt">
              {formatUnits(state.wei, chain.decimals)} {chain.symbol}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function AccountTypeBadge({ account, ledger }: { account: Account; ledger: boolean }) {
  const { t } = useT();
  if (!account.signer)
    return (
      <span className="badge neutral">
        <Icon name="eye" size={11} /> {t("wallet.watch")}
      </span>
    );
  if (ledger)
    return (
      <span className="badge ledger">
        <Icon name="ledger" size={11} /> Ledger
      </span>
    );
  return null;
}

function AccountSwitcher({
  accounts,
  active,
  vault,
}: {
  accounts: Account[];
  active: Account;
  vault: VaultState;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [val, setVal] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const isLedger = vault.kind === "ledger";

  function close() {
    setOpen(false);
    setAdding(false);
    setErr(null);
  }
  function submitWatch() {
    try {
      addWatchAccount(val);
      setVal("");
      close();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="acct-switch">
      <div className="acct-pill" onClick={() => setOpen((o) => !o)} title={t("wallet.switchAccount")}>
        <Avatar address={active.address} size={34} />
        <div>
          <div className="nm">
            {active.label} <AccountTypeBadge account={active} ledger={isLedger} />
          </div>
          <div className="ad">{shortAddress(active.address, 8, 6)}</div>
        </div>
        <Icon name="chevronD" size={16} />
      </div>

      {open && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 30 }} onClick={close} />
          <div className="acct-menu">
            <div className="acct-menu-head">
              <span>{t("wallet.wallets")}</span>
              <span>{accounts.length}</span>
            </div>
            {accounts.map((a) => (
              <button
                key={a.address}
                className={`acct-row${a.address === active.address ? " on" : ""}`}
                onClick={() => {
                  setActive(a.address);
                  close();
                }}
              >
                <Avatar address={a.address} size={32} />
                <div className="meta">
                  <div className="l">
                    {a.label} <AccountTypeBadge account={a} ledger={isLedger} />
                  </div>
                  <div className="a">{shortAddress(a.address, 10, 6)}</div>
                </div>
                {a.address === active.address && (
                  <span className="check">
                    <Icon name="check" size={16} />
                  </span>
                )}
              </button>
            ))}

            {adding ? (
              <>
                <div className="acct-add-row">
                  <input
                    className="input mono"
                    autoFocus
                    placeholder={t("wallet.pasteAddr")}
                    value={val}
                    onChange={(e) => {
                      setVal(e.target.value);
                      setErr(null);
                    }}
                    onKeyDown={(e) => e.key === "Enter" && submitWatch()}
                  />
                  <button className="btn btn-primary btn-sm" onClick={submitWatch}>
                    {t("wallet.add")}
                  </button>
                </div>
                {err && <div className="acct-add-err">{err}</div>}
              </>
            ) : (
              <div className="acct-menu-foot">
                {/* HD "add account" only applies to a mnemonic wallet — a Ledger derives
                    accounts by reconnecting the device, not from a local seed. */}
                {!isLedger && (
                  <button
                    className="acct-act"
                    onClick={async () => {
                      const addr = await addVaultAccount();
                      setActive(addr);
                      close();
                    }}
                  >
                    <Icon name="plus" size={16} /> {t("wallet.addAccount")}
                  </button>
                )}
                <button className="acct-act" onClick={() => setAdding(true)}>
                  <Icon name="eye" size={16} /> {t("wallet.addWatch")}
                </button>
                {/* A Ledger wallet has no in-process secret to lock. */}
                {!isLedger && (
                  <button
                    className="acct-act danger"
                    onClick={async () => {
                      close();
                      await lockVault();
                    }}
                  >
                    <Icon name="lock" size={16} /> {t("wallet.lockWallet")}
                  </button>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function ReceiveModal({ account, onClose }: { account: Account; onClose: () => void }) {
  const { t } = useT();
  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">{t("wallet.receive")}</div>
          <button className="icon-btn bare" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="modal-body">
          <div className="receive-id">
            <Avatar address={account.address} size={26} />
            <span className="nm">{account.label}</span>
          </div>
          <div className="addr-box">
            <span className="a">{account.address}</span>
            <button
              className="icon-btn"
              onClick={() => {
                navigator.clipboard.writeText(account.address);
                toast(t("common.copied"));
              }}
            >
              <Icon name="copy" size={16} />
            </button>
          </div>
          <div className="receive-hint">
            <Icon name="info" size={16} /> {t("wallet.receiveHint")}
          </div>
        </div>
      </div>
    </div>
  );
}
