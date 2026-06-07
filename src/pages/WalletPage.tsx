import { useMemo, useState } from "react";
import "./WalletPage.css";
import { chainLogo, findChain, useChains, type Chain } from "../lib/chains";
import {
  fmtPct,
  fmtUsd,
  formatUnits,
  isAddress,
  parseUnits,
  shortAddress,
  toHexQuantity,
  weiToUsd,
} from "../lib/format";
import {
  addVaultAccount,
  createVault,
  deleteWallet,
  importPrivateKey,
  importVault,
  renameWallet,
  useVault,
  walletSend,
  type WalletInfo,
} from "../lib/vault";
import { LedgerList, useLedgerScan } from "../lib/LedgerPicker";
import {
  addWatchAccount,
  removeWatchAccount,
  setActive,
  useAccounts,
  useActiveAccount,
  type Account,
} from "../lib/accounts";
import { useBalances, type BalanceState } from "../lib/useBalances";
import {
  usePrices,
  useTokenPrices,
  tkPriceKey,
  type Price,
  type PriceState,
  type PricedToken,
} from "../lib/prices";
import {
  addCustomToken,
  encodeErc20Transfer,
  fetchTokenMeta,
  isCustomToken,
  removeCustomToken,
  tokenKey,
  tokensForChain,
  useCustomTokens,
  useTokenBalances,
  type CustomStore,
  type TokenBalance,
  type TokenMeta,
} from "../lib/tokens";
import { useT, type TFn } from "../lib/i18n";
import { Icon, type IconName } from "../lib/icons";
import { Avatar } from "../lib/ui";
import { QrCode } from "../lib/qr";
import { toast } from "../lib/toast";

// Wallet page (VISION ①). Aurora portfolio: account/wallet switcher (create/import/
// link + rename/delete), hero with a REAL total (native balances × live CoinGecko
// prices), quick actions, a per-chain native token list with USD, and an honest
// "coming soon" for activity. No fabricated holdings — failed prices/balances
// surface as explicit states.
export default function WalletPage() {
  const { t } = useT();
  const chains = useChains();
  const chainIds = useMemo(() => chains.map((c) => c.id), [chains]);
  const active = useActiveAccount();
  const custom = useCustomTokens();
  const { balances, refresh } = useBalances(active.address);
  const { tokenBalances, refreshTokens } = useTokenBalances(active.address, chainIds);
  const { state: prices, refresh: refreshPrices } = usePrices(chains.map((c) => c.symbol));

  // Price only the ERC-20s actually held (>0); unmapped/unknown ones get no USD.
  const pricedTokens = useMemo<PricedToken[]>(() => {
    const out: PricedToken[] = [];
    for (const c of chains) {
      for (const tk of tokensForChain(custom, c.id)) {
        const st = tokenBalances[tokenKey(c.id, tk.address)];
        if (st?.status === "ok" && BigInt(st.wei) > 0n) out.push({ chainId: c.id, address: tk.address });
      }
    }
    return out;
  }, [chains, custom, tokenBalances]);
  const { prices: tokenPrices, refresh: refreshTokenPrices } = useTokenPrices(pricedTokens);

  const [tab, setTab] = useState<"tokens" | "activity">("tokens");
  const [filter, setFilter] = useState<string>("all");
  const [showReceive, setShowReceive] = useState(false);
  const [showAddToken, setShowAddToken] = useState(false);
  const [showSend, setShowSend] = useState(false);

  const isWatch = !active.signer;

  // Assets the active account can actually send (non-zero native + ERC-20).
  const sendableAssets = useMemo<SendAsset[]>(() => {
    const out: SendAsset[] = [];
    for (const c of chains) {
      const nb = balances[c.id];
      if (nb?.status === "ok" && BigInt(nb.wei) > 0n) {
        out.push({
          key: `n:${c.id}`,
          chainId: c.id,
          chainName: c.name,
          kind: "native",
          symbol: c.symbol,
          decimals: c.decimals,
          color: c.color,
          logo: chainLogo(c.id),
          wei: nb.wei,
        });
      }
      for (const tk of tokensForChain(custom, c.id)) {
        const st = tokenBalances[tokenKey(c.id, tk.address)];
        if (st?.status === "ok" && BigInt(st.wei) > 0n) {
          out.push({
            key: `e:${c.id}:${tk.address}`,
            chainId: c.id,
            chainName: c.name,
            kind: "erc20",
            symbol: tk.symbol,
            decimals: tk.decimals,
            address: tk.address,
            color: seedColor(tk.address),
            logo: tk.logo || undefined,
            wei: st.wei,
          });
        }
      }
    }
    return out;
  }, [chains, balances, tokenBalances, custom]);

  const rows = useMemo(() => {
    const shown = chains.filter((c) => filter === "all" || c.id === filter);
    return buildRows(shown, custom, balances, tokenBalances, prices, tokenPrices);
  }, [chains, filter, custom, balances, tokenBalances, prices, tokenPrices]);
  const portfolio = useMemo(
    () => computePortfolio(rows, prices.status === "loading"),
    [rows, prices.status],
  );

  function copyAddress() {
    navigator.clipboard.writeText(active.address);
    toast(t("common.copied"));
  }
  function refreshAll() {
    refresh();
    refreshTokens();
    refreshPrices();
    refreshTokenPrices();
    toast(t("common.refreshed"));
  }

  return (
    <div className="page scroll">
      <div className="wallet-pad">
        {/* Account header row — aligned with the hero's left edge; copy sits next
            to the wallet switcher. */}
        <div className="wallet-head">
          <AccountSwitcher />
          <button className="icon-btn" title={t("wallet.copy")} onClick={copyAddress}>
            <Icon name="copy" size={17} />
          </button>
        </div>

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
                    <HeroAmount n={portfolio.total} />
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
                  <div className="hero-total disp tnum">$—</div>
                  <div className="hero-note">
                    <Icon name="info" size={13} /> {t("wallet.pricesUnavailable")}
                  </div>
                </>
              )}
            </div>
            {/* Refresh balances + prices (the eye/hide-balance toggle was dropped). */}
            <button className="hero-eye" onClick={refreshAll} title={t("wallet.refresh")}>
              <Icon name="refresh" size={17} />
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
            <QuickBtn icon="send" coral label={t("wallet.send")} onClick={() => setShowSend(true)} />
            <QuickBtn icon="swap" label={t("wallet.swap")} onClick={() => toast(t("wallet.swapSoon"), "info")} />
            <QuickBtn icon="bridge" label={t("wallet.bridge")} onClick={() => toast(t("wallet.bridgeSoon"), "info")} />
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
                {rows.map((r) => (
                  <HoldingRow key={r.key} row={r} t={t} />
                ))}
              </div>
              <button className="add-token" onClick={() => setShowAddToken(true)}>
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

      {showReceive && <ReceiveModal account={active} onClose={() => setShowReceive(false)} />}
      {showAddToken && <AddTokenModal defaultChain={filter !== "all" ? filter : undefined} onClose={() => setShowAddToken(false)} />}
      {showSend && <SendModal assets={sendableAssets} onClose={() => setShowSend(false)} />}
    </div>
  );
}

// One sendable balance (native coin or held ERC-20) for the Send picker.
type SendAsset = {
  key: string;
  chainId: string;
  chainName: string;
  kind: "native" | "erc20";
  symbol: string;
  decimals: number;
  address?: string;
  color: string;
  logo?: string;
  wei: string;
};

type Portfolio = { total: number | null; change: number | null; loading: boolean };

// A balance state — native (BalanceState) and ERC-20 (TokenBalance) are the same
// shape; the unified row carries whichever applies.
type BalState = BalanceState | TokenBalance | undefined;

// One line in the token list: a chain's native coin, or an ERC-20 held on it.
type DisplayRow = {
  key: string;
  chainName: string;
  chainColor: string;
  kind: "native" | "erc20";
  symbol: string;
  decimals: number;
  /** Coin-glyph background color (chain brand for native, seeded for tokens). */
  color: string;
  logo?: string;
  state: BalState;
  price?: Price;
  isCustom?: boolean;
};

// Deterministic pleasant color from a string (token contract) — only used as the
// glyph background when a token has no logo.
function seedColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 64% 55%)`;
}

function isHeld(st: BalState): boolean {
  return st?.status === "ok" && BigInt(st.wei) > 0n;
}

// Native (always) + ERC-20 (held>0 or user-added) rows for the shown chains.
function buildRows(
  shown: Chain[],
  custom: CustomStore,
  balances: Record<string, BalanceState>,
  tokenBalances: Record<string, TokenBalance>,
  prices: PriceState,
  tokenPrices: Record<string, Price>,
): DisplayRow[] {
  const rows: DisplayRow[] = [];
  for (const c of shown) {
    rows.push({
      key: `native:${c.id}`,
      chainName: c.name,
      chainColor: c.color,
      kind: "native",
      symbol: c.symbol,
      decimals: c.decimals,
      color: c.color,
      logo: chainLogo(c.id),
      state: balances[c.id],
      price: prices.status === "ok" ? prices.prices[c.symbol.toUpperCase()] : undefined,
    });
    for (const tk of tokensForChain(custom, c.id)) {
      const st = tokenBalances[tokenKey(c.id, tk.address)];
      const cust = isCustomToken(custom, c.id, tk.address);
      if (!cust && !isHeld(st)) continue; // hide zero-balance default tokens
      rows.push({
        key: `erc20:${c.id}:${tk.address}`,
        chainName: c.name,
        chainColor: c.color,
        kind: "erc20",
        symbol: tk.symbol,
        decimals: tk.decimals,
        color: seedColor(tk.address),
        logo: tk.logo || undefined,
        state: st,
        price: tokenPrices[tkPriceKey(c.id, tk.address)],
        isCustom: cust,
      });
    }
  }
  return rows;
}

function computePortfolio(rows: DisplayRow[], pricesLoading: boolean): Portfolio {
  const loading = pricesLoading || rows.some((r) => !r.state || r.state.status === "loading");
  let total = 0;
  let delta = 0;
  let priced = false;
  for (const r of rows) {
    if (!r.state || r.state.status !== "ok" || !r.price) continue;
    const v = weiToUsd(r.state.wei, r.decimals, r.price.usd);
    total += v;
    delta += v * (r.price.change24h / 100);
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

function Coin({
  symbol,
  color,
  size = 40,
  logo,
}: {
  symbol: string;
  color: string;
  size?: number;
  logo?: string;
}) {
  const [broken, setBroken] = useState(false);
  const letters = symbol.slice(0, symbol.length > 3 ? 3 : symbol.length);
  return (
    <span className="coin" style={{ width: size, height: size }}>
      {logo && !broken ? (
        <img className="coin-img" src={logo} width={size} height={size} alt="" onError={() => setBroken(true)} />
      ) : (
        <span
          className="coin-glyph"
          style={{ width: size, height: size, background: color, fontSize: letters.length > 2 ? 11 : 13 }}
        >
          {letters}
        </span>
      )}
    </span>
  );
}

// Token-first row (#5): the token symbol is the headline, the chain it lives on is
// the secondary tag. Works for both the native coin and held ERC-20s.
function HoldingRow({ row, t }: { row: DisplayRow; t: TFn }) {
  const usd =
    row.state?.status === "ok" && row.price ? weiToUsd(row.state.wei, row.decimals, row.price.usd) : null;
  const up = (row.price?.change24h ?? 0) >= 0;
  return (
    <div className="token-row">
      <Coin symbol={row.symbol} color={row.color} logo={row.logo} />
      <div className="token-meta">
        <div className="token-name">
          {row.symbol}
          {row.isCustom && <span className="badge neutral">{t("wallet.custom")}</span>}
        </div>
        <div className="token-sub">
          <span className="chain-dot" style={{ width: 8, height: 8, background: row.chainColor }} />
          {row.chainName}
          {row.price && <span className={`chg ${up ? "up" : "down"}`}>{fmtPct(row.price.change24h)}</span>}
        </div>
      </div>
      <div className="token-right">
        {!row.state || row.state.status === "loading" ? (
          <span className="skeleton" style={{ width: 72, height: 14 }} />
        ) : row.state.status === "error" ? (
          <span className="token-err" title={row.state.message}>
            failed
          </span>
        ) : (
          <>
            {usd != null && <div className="token-usd tnum">{fmtUsd(usd)}</div>}
            <div className="token-amt">
              {formatUnits(row.state.wei, row.decimals)} {row.symbol}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function KindBadge({ kind, t }: { kind: WalletInfo["kind"]; t: TFn }) {
  if (kind === "ledger")
    return (
      <span className="badge ledger">
        <Icon name="ledger" size={11} /> Ledger
      </span>
    );
  if (kind === "privkey")
    return (
      <span className="badge neutral">
        <Icon name="key" size={11} /> {t("lock.importTab.privkey")}
      </span>
    );
  return null;
}

function AccountSwitcher() {
  const { t } = useT();
  const vault = useVault();
  const accounts = useAccounts();
  const active = useActiveAccount();
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);

  const watchAccounts = accounts.filter((a) => !a.signer);

  function close() {
    setOpen(false);
    setRenaming(null);
  }

  return (
    <div className="acct-switch">
      <button className="acct-pill" onClick={() => setOpen((o) => !o)} title={t("wallet.switchAccount")}>
        <Avatar address={active.address} size={34} />
        <div className="acct-pill-meta">
          <div className="nm">
            {active.label}
            {active.kind === "ledger" && (
              <span className="badge ledger">
                <Icon name="ledger" size={11} /> Ledger
              </span>
            )}
            {active.kind === "watch" && (
              <span className="badge neutral">
                <Icon name="eye" size={11} /> {t("wallet.watch")}
              </span>
            )}
          </div>
          <div className="ad">{shortAddress(active.address, 8, 6)}</div>
        </div>
        <Icon name="chevronD" size={16} />
      </button>

      {open && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 30 }} onClick={close} />
          <div className="acct-menu scroll">
            <div className="acct-menu-head">
              <span>{t("wallet.wallets")}</span>
              <span>{vault.wallets.length}</span>
            </div>

            {vault.wallets.map((w) => (
              <WalletGroup
                key={w.id}
                wallet={w}
                active={active}
                t={t}
                renaming={renaming === w.id}
                onRename={() => setRenaming(w.id)}
                onRenameDone={() => setRenaming(null)}
                onPick={(addr) => {
                  setActive(addr);
                  close();
                }}
              />
            ))}

            {watchAccounts.length > 0 && (
              <div className="acct-group">
                <div className="acct-group-head">
                  <span>{t("wallet.watchGroup")}</span>
                </div>
                {watchAccounts.map((a) => (
                  <div key={a.address} className={`acct-row${a.address === active.address ? " on" : ""}`}>
                    <button
                      className="acct-row-main"
                      onClick={() => {
                        setActive(a.address);
                        close();
                      }}
                    >
                      <Avatar address={a.address} size={30} />
                      <div className="meta">
                        <div className="l">{a.label}</div>
                        <div className="a">{shortAddress(a.address, 10, 6)}</div>
                      </div>
                      {a.address === active.address && (
                        <span className="check">
                          <Icon name="check" size={16} />
                        </span>
                      )}
                    </button>
                    <button
                      className="icon-btn bare acct-row-act"
                      title={t("wallet.removeWatch")}
                      onClick={() => {
                        if (confirm(t("wallet.deleteWatchConfirm"))) {
                          removeWatchAccount(a.address);
                          toast(t("wallet.removed"));
                        }
                      }}
                    >
                      <Icon name="trash" size={15} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <button className="acct-add-wallet" onClick={() => setAdding(true)}>
              <Icon name="plus" size={16} /> {t("wallet.addWallet")}
            </button>
          </div>
        </>
      )}

      {adding && (
        <AddWalletModal
          hasPassword={vault.hasPassword}
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            close();
          }}
        />
      )}
    </div>
  );
}

function WalletGroup({
  wallet,
  active,
  t,
  renaming,
  onRename,
  onRenameDone,
  onPick,
}: {
  wallet: WalletInfo;
  active: Account;
  t: TFn;
  renaming: boolean;
  onRename: () => void;
  onRenameDone: () => void;
  onPick: (address: string) => void;
}) {
  const [name, setName] = useState(wallet.label);

  async function saveName() {
    const next = name.trim();
    if (next && next !== wallet.label) {
      await renameWallet(wallet.id, next);
      toast(t("wallet.renamed"));
    }
    onRenameDone();
  }

  return (
    <div className="acct-group">
      <div className="acct-group-head wallet">
        {renaming ? (
          <input
            className="input acct-rename"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void saveName();
              if (e.key === "Escape") onRenameDone();
            }}
            onBlur={() => void saveName()}
          />
        ) : (
          <>
            <span className="wallet-label">
              {wallet.label}
              <KindBadge kind={wallet.kind} t={t} />
            </span>
            <div className="wallet-acts">
              <button className="icon-btn bare" title={t("wallet.rename")} onClick={onRename}>
                <Icon name="edit" size={14} />
              </button>
              <button
                className="icon-btn bare"
                title={t("wallet.delete")}
                onClick={() => {
                  if (confirm(t("wallet.deleteConfirm"))) {
                    void deleteWallet(wallet.id).then(() => toast(t("wallet.removed")));
                  }
                }}
              >
                <Icon name="trash" size={14} />
              </button>
            </div>
          </>
        )}
      </div>

      {wallet.accounts.map((addr, i) => (
        <button
          key={addr}
          className={`acct-row-main${addr === active.address ? " on" : ""}`}
          onClick={() => onPick(addr)}
        >
          <Avatar address={addr} size={30} />
          <div className="meta">
            <div className="l">
              {wallet.accounts.length > 1 ? `${t("wallet.account")} ${i + 1}` : shortAddress(addr, 12, 8)}
            </div>
            {wallet.accounts.length > 1 && <div className="a">{shortAddress(addr, 10, 6)}</div>}
          </div>
          {addr === active.address && (
            <span className="check">
              <Icon name="check" size={16} />
            </span>
          )}
        </button>
      ))}

      {wallet.kind === "hd" && (
        <button
          className="acct-add-account"
          onClick={() =>
            void addVaultAccount(wallet.id).then((addr) => {
              setActive(addr);
            })
          }
        >
          <Icon name="plus" size={14} /> {t("wallet.addAccount")}
        </button>
      )}
    </div>
  );
}

// ---- Add Wallet (create / import / connect Ledger / watch) -------------------

function pwScore(pw: string): number {
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
  if (/[0-9!@#$%^&*]/.test(pw)) s++;
  return Math.min(s, 4);
}
function errText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

type AddStep = "menu" | "create" | "import" | "ledger" | "watch" | "backup";

function AddWalletModal({
  hasPassword,
  onClose,
  onDone,
}: {
  hasPassword: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useT();
  const [step, setStep] = useState<AddStep>("menu");
  const [mnemonic, setMnemonic] = useState("");

  const opts: { s: AddStep; ic: IconName; label: string; coral?: boolean }[] = [
    { s: "create", ic: "plus", label: t("wallet.createWallet") },
    { s: "import", ic: "download", label: t("wallet.importWallet"), coral: true },
    { s: "ledger", ic: "ledger", label: t("wallet.connectLedger") },
    { s: "watch", ic: "eye", label: t("wallet.watchAddress") },
  ];

  return (
    <div className="scrim" onClick={onClose}>
      <div className={`modal${step === "ledger" ? " wide" : ""}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            {step === "backup" ? t("wallet.backupNew") : t("wallet.addWalletTitle")}
          </div>
          <button className="icon-btn bare" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="modal-body">
          {step === "menu" && (
            <div className="add-opts">
              {opts.map((o) => (
                <button key={o.s} className={`add-opt${o.coral ? " coral" : ""}`} onClick={() => setStep(o.s)}>
                  <span className="add-opt-ic">
                    <Icon name={o.ic} size={19} />
                  </span>
                  <span className="add-opt-label">{o.label}</span>
                  <Icon name="chevronR" size={16} />
                </button>
              ))}
            </div>
          )}
          {step === "create" && (
            <CreateWalletForm
              needsPassword={!hasPassword}
              onBack={() => setStep("menu")}
              onCreated={(m) => {
                setMnemonic(m);
                setStep("backup");
              }}
            />
          )}
          {step === "import" && (
            <ImportWalletForm needsPassword={!hasPassword} onBack={() => setStep("menu")} onDone={onDone} />
          )}
          {step === "ledger" && <LedgerForm onBack={() => setStep("menu")} onDone={onDone} />}
          {step === "watch" && <WatchForm onBack={() => setStep("menu")} onDone={onDone} />}
          {step === "backup" && <BackupBox mnemonic={mnemonic} onDone={onDone} />}
        </div>
      </div>
    </div>
  );
}

function PasswordPair({
  pw,
  setPw,
  confirm,
  setConfirm,
  t,
}: {
  pw: string;
  setPw: (v: string) => void;
  confirm: string;
  setConfirm: (v: string) => void;
  t: TFn;
}) {
  const score = pwScore(pw);
  return (
    <>
      <div className="add-note">{t("wallet.setPasswordHint")}</div>
      <div className="field">
        <label className="field-label">{t("lock.newPassword")}</label>
        <input className="input" type="password" value={pw} placeholder={t("lock.min8")} onChange={(e) => setPw(e.target.value)} />
        <div className={`pw-strength s${score}`}>
          <i />
          <i />
          <i />
          <i />
        </div>
      </div>
      <div className="field">
        <label className="field-label">{t("lock.confirm")}</label>
        <input className="input" type="password" value={confirm} placeholder={t("lock.confirm")} onChange={(e) => setConfirm(e.target.value)} />
      </div>
    </>
  );
}

function CreateWalletForm({
  needsPassword,
  onBack,
  onCreated,
}: {
  needsPassword: boolean;
  onBack: () => void;
  onCreated: (mnemonic: string) => void;
}) {
  const { t } = useT();
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (needsPassword) {
      if (pw.length < 8) return setError(t("lock.errShort"));
      if (pw !== confirm) return setError(t("lock.errMatch"));
    }
    setBusy(true);
    setError(null);
    try {
      const { mnemonic, address } = await createVault(needsPassword ? pw : undefined);
      setActive(address); // make the new wallet active everywhere (shell + backend + dApps)
      toast(t("wallet.added"));
      onCreated(mnemonic);
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  }

  return (
    <div className="add-form">
      {needsPassword ? (
        <PasswordPair pw={pw} setPw={setPw} confirm={confirm} setConfirm={setConfirm} t={t} />
      ) : (
        <div className="add-note">{t("lock.optCreateDesc")}</div>
      )}
      {error && (
        <div className="lock-err">
          <Icon name="alert" size={16} /> {error}
        </div>
      )}
      <div className="add-acts">
        <button className="btn btn-ghost btn-sm" onClick={onBack}>
          {t("lock.back")}
        </button>
        <button className="btn btn-aurora btn-sm" disabled={busy} onClick={submit}>
          {busy ? "…" : t("wallet.createWallet")}
        </button>
      </div>
    </div>
  );
}

function ImportWalletForm({
  needsPassword,
  onBack,
  onDone,
}: {
  needsPassword: boolean;
  onBack: () => void;
  onDone: () => void;
}) {
  const { t } = useT();
  const [tab, setTab] = useState<"phrase" | "privkey">("phrase");
  const [phrase, setPhrase] = useState("");
  const [privkey, setPrivkey] = useState("");
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (tab === "phrase") {
      const words = phrase.trim().split(/\s+/).length;
      if (words !== 12 && words !== 24) return setError(t("lock.errPhrase"));
    } else {
      const body = privkey.trim().replace(/^0x/i, "");
      if (!/^[0-9a-fA-F]{64}$/.test(body)) return setError(t("lock.errPrivkey"));
    }
    if (needsPassword) {
      if (pw.length < 8) return setError(t("lock.errShort"));
      if (pw !== confirm) return setError(t("lock.errMatch"));
    }
    setBusy(true);
    setError(null);
    try {
      const ref =
        tab === "phrase"
          ? await importVault(needsPassword ? pw : undefined, phrase)
          : await importPrivateKey(needsPassword ? pw : undefined, privkey);
      setActive(ref.address); // make the imported wallet active everywhere
      toast(t("wallet.added"));
      onDone();
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  }

  return (
    <div className="add-form">
      <div className="seg lock-seg">
        <button className={tab === "phrase" ? "on" : ""} onClick={() => setTab("phrase")}>
          {t("lock.importTab.phrase")}
        </button>
        <button className={tab === "privkey" ? "on" : ""} onClick={() => setTab("privkey")}>
          {t("lock.importTab.privkey")}
        </button>
      </div>
      {tab === "phrase" ? (
        <textarea
          className="textarea mono"
          rows={3}
          value={phrase}
          onChange={(e) => setPhrase(e.target.value)}
          placeholder={t("lock.phrasePlaceholder")}
        />
      ) : (
        <textarea
          className="textarea mono"
          rows={2}
          value={privkey}
          onChange={(e) => setPrivkey(e.target.value)}
          placeholder={t("lock.privkeyPlaceholder")}
        />
      )}
      {needsPassword && (
        <PasswordPair pw={pw} setPw={setPw} confirm={confirm} setConfirm={setConfirm} t={t} />
      )}
      {error && (
        <div className="lock-err">
          <Icon name="alert" size={16} /> {error}
        </div>
      )}
      <div className="add-acts">
        <button className="btn btn-ghost btn-sm" onClick={onBack}>
          {t("lock.back")}
        </button>
        <button className="btn btn-aurora btn-sm" disabled={busy} onClick={submit}>
          {busy ? "…" : tab === "phrase" ? t("lock.import") : t("lock.importPrivkey")}
        </button>
      </div>
    </div>
  );
}

function LedgerForm({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const { t } = useT();
  const { accounts, page, loading, connecting, started, error, scan, nextPage, prevPage, pick } =
    useLedgerScan((ref) => {
      setActive(ref.address); // make the connected Ledger account active everywhere
      toast(t("wallet.added"));
      onDone();
    });
  const showList = started && (accounts.length > 0 || loading);

  return (
    <div className="add-form">
      {showList ? (
        <LedgerList
          accounts={accounts}
          page={page}
          loading={loading}
          connecting={connecting}
          onPick={pick}
          onPrev={prevPage}
          onNext={nextPage}
        />
      ) : (
        <div className="add-note">{connecting ? t("lock.ledgerConnecting") : t("lock.ledgerIntro")}</div>
      )}
      {error && (
        <div className="lock-err">
          <Icon name="alert" size={16} /> {error}
        </div>
      )}
      <div className="add-acts">
        <button className="btn btn-ghost btn-sm" onClick={onBack}>
          {t("lock.back")}
        </button>
        {!showList && (
          <button className="btn btn-aurora btn-sm" disabled={loading} onClick={scan}>
            {loading ? "…" : error ? t("lock.retry") : t("lock.ledgerScan")}
          </button>
        )}
      </div>
    </div>
  );
}

function WatchForm({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const { t } = useT();
  const [val, setVal] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit() {
    try {
      addWatchAccount(val);
      toast(t("wallet.added"));
      onDone();
    } catch (e) {
      setError(errText(e));
    }
  }

  return (
    <div className="add-form">
      <div className="field">
        <label className="field-label">{t("wallet.watchAddress")}</label>
        <input
          className="input mono"
          autoFocus
          value={val}
          placeholder={t("wallet.pasteAddr")}
          onChange={(e) => {
            setVal(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
      </div>
      {error && (
        <div className="lock-err">
          <Icon name="alert" size={16} /> {error}
        </div>
      )}
      <div className="add-acts">
        <button className="btn btn-ghost btn-sm" onClick={onBack}>
          {t("lock.back")}
        </button>
        <button className="btn btn-primary btn-sm" disabled={!val} onClick={submit}>
          {t("wallet.add")}
        </button>
      </div>
    </div>
  );
}

function BackupBox({ mnemonic, onDone }: { mnemonic: string; onDone: () => void }) {
  const { t } = useT();
  const [revealed, setRevealed] = useState(false);
  const [acked, setAcked] = useState(false);
  const words = mnemonic.trim().split(/\s+/);
  return (
    <div className="add-form">
      <div className="warn-box">
        <Icon name="alert" size={16} /> {t("lock.backupWarn")}
      </div>
      <div style={{ position: "relative" }}>
        <ol className={`mnemonic${revealed ? "" : " blurred"}`}>
          {words.map((w, i) => (
            <li key={i}>
              <span className="n">{i + 1}</span>
              {w}
            </li>
          ))}
        </ol>
        {!revealed && (
          <div className="reveal-mnemonic" onClick={() => setRevealed(true)}>
            <span className="pill">
              <Icon name="eye" size={15} /> {t("lock.tapReveal")}
            </span>
          </div>
        )}
      </div>
      <label className="lock-check">
        <input type="checkbox" checked={acked} onChange={(e) => setAcked(e.target.checked)} />
        {t("lock.backupAck")}
      </label>
      <button className="btn btn-aurora btn-block" disabled={!acked} onClick={onDone}>
        {t("lock.continue")}
      </button>
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
          <div className="receive-qr">
            <QrCode value={account.address} size={208} />
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

// Add a custom ERC-20 (#8): pick a chain, paste the contract address, scan its
// on-chain metadata, then persist it. Already-added customs are listed with a
// remove control.
function AddTokenModal({ defaultChain, onClose }: { defaultChain?: string; onClose: () => void }) {
  const { t } = useT();
  const chains = useChains();
  const custom = useCustomTokens();
  const [chainId, setChainId] = useState<string>(defaultChain ?? chains[0]?.id ?? "0x1");
  const [addr, setAddr] = useState("");
  const [scanned, setScanned] = useState<TokenMeta | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const customList = useMemo(() => {
    const out: { chainId: string; token: TokenMeta }[] = [];
    for (const [cid, list] of Object.entries(custom)) {
      for (const tk of list) out.push({ chainId: cid, token: tk });
    }
    return out;
  }, [custom]);

  function reset() {
    setScanned(null);
    setError(null);
  }
  async function scan() {
    const a = addr.trim();
    if (!isAddress(a)) return setError(t("wallet.invalidAddress"));
    setBusy(true);
    reset();
    try {
      setScanned(await fetchTokenMeta(chainId, a));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }
  function add() {
    if (!scanned) return;
    addCustomToken(chainId, scanned);
    toast(t("wallet.tokenAdded"));
    setAddr("");
    setScanned(null);
  }

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">{t("wallet.addToken")}</div>
          <button className="icon-btn bare" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="modal-body">
          <div className="add-form">
            <div className="field">
              <label className="field-label">{t("wallet.network")}</label>
              <select
                className="input"
                value={chainId}
                onChange={(e) => {
                  setChainId(e.target.value);
                  reset();
                }}
              >
                {chains.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="field-label">{t("wallet.tokenAddress")}</label>
              <div className="scan-row">
                <input
                  className="input mono"
                  value={addr}
                  placeholder="0x…"
                  onChange={(e) => {
                    setAddr(e.target.value);
                    reset();
                  }}
                  onKeyDown={(e) => e.key === "Enter" && void scan()}
                />
                <button className="btn btn-ghost btn-sm" disabled={busy || !addr.trim()} onClick={() => void scan()}>
                  {busy ? t("wallet.scanning") : t("wallet.scan")}
                </button>
              </div>
            </div>
            {error && (
              <div className="lock-err">
                <Icon name="alert" size={16} /> {error}
              </div>
            )}
            {scanned && (
              <div className="scan-preview">
                <Coin symbol={scanned.symbol} color={seedColor(scanned.address)} logo={scanned.logo || undefined} size={36} />
                <div className="scan-meta">
                  <div className="l">
                    {scanned.symbol} <span className="muted">· {scanned.name}</span>
                  </div>
                  <div className="a">
                    {shortAddress(scanned.address, 10, 8)} · {scanned.decimals} decimals
                  </div>
                </div>
                <button className="btn btn-aurora btn-sm" onClick={add}>
                  {t("wallet.add")}
                </button>
              </div>
            )}
          </div>

          {customList.length > 0 && (
            <div className="custom-list">
              <div className="custom-list-head">{t("wallet.customTokens")}</div>
              {customList.map(({ chainId: cid, token }) => (
                <div key={`${cid}:${token.address}`} className="custom-row">
                  <Coin symbol={token.symbol} color={seedColor(token.address)} logo={token.logo || undefined} size={28} />
                  <div className="custom-meta">
                    <div className="l">{token.symbol}</div>
                    <div className="a">
                      {findChain(cid)?.name ?? cid} · {shortAddress(token.address, 8, 6)}
                    </div>
                  </div>
                  <button
                    className="icon-btn bare"
                    title={t("wallet.removeToken")}
                    onClick={() => {
                      removeCustomToken(cid, token.address);
                      toast(t("wallet.removed"));
                    }}
                  >
                    <Icon name="trash" size={15} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Wallet-initiated Send (#7): pick a held asset (native or ERC-20), recipient, and
// amount; the actual confirm (with gas details) happens in the approval window.
function SendModal({ assets, onClose }: { assets: SendAsset[]; onClose: () => void }) {
  const { t } = useT();
  const [sel, setSel] = useState<string>(assets[0]?.key ?? "");
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const asset = assets.find((a) => a.key === sel);

  function setMax() {
    if (asset) setAmount(formatUnits(asset.wei, asset.decimals, asset.decimals));
  }

  async function submit() {
    if (!asset) return;
    if (!isAddress(recipient)) return setError(t("wallet.invalidRecipient"));
    let amountWei: bigint;
    try {
      amountWei = parseUnits(amount, asset.decimals);
    } catch {
      return setError(t("wallet.invalidAmount"));
    }
    if (amountWei <= 0n) return setError(t("wallet.invalidAmount"));
    if (amountWei > BigInt(asset.wei)) return setError(t("wallet.insufficient"));

    const to = recipient.trim();
    const tx =
      asset.kind === "native"
        ? { to, value: toHexQuantity(amountWei) }
        : { to: asset.address as string, value: "0x0", data: encodeErc20Transfer(to, amountWei) };

    setBusy(true);
    setError(null);
    try {
      await walletSend(asset.chainId, tx);
      toast(t("wallet.sent"));
      onClose();
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  }

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">{t("wallet.send")}</div>
          <button className="icon-btn bare" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="modal-body">
          {assets.length === 0 ? (
            <div className="add-note">{t("wallet.noSendable")}</div>
          ) : (
            <div className="add-form">
              <div className="field">
                <label className="field-label">{t("wallet.sendAsset")}</label>
                <select
                  className="input"
                  value={sel}
                  onChange={(e) => {
                    setSel(e.target.value);
                    setError(null);
                  }}
                >
                  {assets.map((a) => (
                    <option key={a.key} value={a.key}>
                      {a.symbol} · {a.chainName} ({formatUnits(a.wei, a.decimals)})
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label className="field-label">{t("wallet.recipient")}</label>
                <input
                  className="input mono"
                  value={recipient}
                  placeholder="0x…"
                  onChange={(e) => {
                    setRecipient(e.target.value);
                    setError(null);
                  }}
                />
              </div>
              <div className="field">
                <label className="field-label">
                  {t("wallet.amount")}
                  {asset && (
                    <span className="field-aux">
                      {t("wallet.available")}: {formatUnits(asset.wei, asset.decimals)} {asset.symbol}
                    </span>
                  )}
                </label>
                <div className="scan-row">
                  <input
                    className="input mono"
                    value={amount}
                    inputMode="decimal"
                    placeholder="0.0"
                    onChange={(e) => {
                      setAmount(e.target.value);
                      setError(null);
                    }}
                    onKeyDown={(e) => e.key === "Enter" && void submit()}
                  />
                  <button className="btn btn-ghost btn-sm" onClick={setMax}>
                    {t("wallet.max")}
                  </button>
                </div>
              </div>
              {error && (
                <div className="lock-err">
                  <Icon name="alert" size={16} /> {error}
                </div>
              )}
              <div className="add-note send-note">
                <Icon name="info" size={15} /> {t("wallet.sendApprovalHint")}
              </div>
              <div className="add-acts">
                <button className="btn btn-ghost btn-sm" onClick={onClose}>
                  {t("wallet.cancel")}
                </button>
                <button
                  className="btn btn-aurora btn-sm"
                  disabled={busy || !asset || !recipient || !amount}
                  onClick={() => void submit()}
                >
                  {busy ? t("wallet.sending") : t("wallet.send")}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
