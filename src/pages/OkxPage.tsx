import { FormEvent, useEffect, useMemo, useState } from "react";
import "./OkxPage.css";
import { askConfirm } from "../lib/confirm";
import { Icon } from "../lib/icons";
import { useT } from "../lib/i18n";
import {
  calculateOkxDcdWeightedApr,
  deleteOkxCredentials,
  createSingleFlight,
  estimateOkxDcdOrderYieldUsd,
  getOkxAssets,
  getOkxConnectionStatus,
  getOkxDcdOrders,
  isCurrentDcdOrder,
  isUsdStablecoin,
  mergeOkxPortfolioAssets,
  saveOkxCredentials,
  sumOkxDcdYieldByCurrency,
  type OkxAssets,
  type OkxConnectionStatus,
  type OkxCredentialsInput,
  type OkxDcdOrder,
  type OkxPortfolioAsset,
  type OkxRegion,
} from "../lib/okxAccount";
import { openExternalUrl } from "../lib/platform";

const API_KEY_URL = "https://www.okx.com/account/my-api";

const REGIONS: { value: OkxRegion; label: string }[] = [
  { value: "global", label: "Global · www.okx.com" },
  { value: "us", label: "US / Australia · us.okx.com" },
  { value: "eu", label: "Europe · eea.okx.com" },
  { value: "tr", label: "Türkiye · tr.okx.com" },
];

const STATE_KEYS: Record<OkxDcdOrder["state"], string> = {
  initial: "okx.state.initial",
  live: "okx.state.live",
  pending_settle: "okx.state.pendingSettle",
  settled: "okx.state.settled",
  pending_redeem: "okx.state.pendingRedeem",
  redeemed: "okx.state.redeemed",
  rejected: "okx.state.rejected",
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

function formatMoney(value: string): string {
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(number);
}

function formatAmount(value: string): string {
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 8 }).format(number);
}

function formatSummaryYieldAmount(value: string, currency: string): string {
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  const fractionDigits = isUsdStablecoin(currency) ? 2 : 6;
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(number);
}

function formatYield(value: string): string {
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  return `${(number * 100).toFixed(2)}%`;
}

function formatDate(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export default function OkxPage() {
  const { t } = useT();
  const [status, setStatus] = useState<OkxConnectionStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [assets, setAssets] = useState<OkxAssets | null>(null);
  const [assetsError, setAssetsError] = useState<string | null>(null);
  const [orders, setOrders] = useState<OkxDcdOrder[] | null>(null);
  const [ordersError, setOrdersError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [showAllOrders, setShowAllOrders] = useState(true);
  const [showConnection, setShowConnection] = useState(false);

  const refreshData = useMemo(() => createSingleFlight(() => {
    setRefreshing(true);
    setAssetsError(null);
    setOrdersError(null);
    return Promise.allSettled([
      getOkxAssets().then(setAssets),
      getOkxDcdOrders().then(setOrders),
    ]).then((results) => {
      if (results[0].status === "rejected") setAssetsError(errorMessage(results[0].reason));
      if (results[1].status === "rejected") setOrdersError(errorMessage(results[1].reason));
      setRefreshing(false);
    });
  }), []);

  useEffect(() => {
    let active = true;
    getOkxConnectionStatus()
      .then((next) => {
        if (!active) return;
        setStatus(next);
        if (next.configured) void refreshData();
      })
      .catch((error) => {
        if (active) setStatusError(errorMessage(error));
      });
    return () => {
      active = false;
    };
  }, [refreshData]);

  const visibleOrders = useMemo(() => {
    if (orders === null) return null;
    return showAllOrders ? orders : orders.filter(isCurrentDcdOrder);
  }, [orders, showAllOrders]);

  const portfolioAssets = useMemo(() => {
    if (assets === null) return null;
    if (orders === null) return mergeOkxPortfolioAssets(assets, []);
    return mergeOkxPortfolioAssets(assets, orders);
  }, [assets, orders]);

  if (statusError !== null) {
    return <PageError message={statusError} />;
  }
  if (status === null) {
    return <div className="okx-page okx-loading"><span /><span /><span /></div>;
  }
  if (!status.configured) {
    return <OkxSetup onConnected={(next) => {
      setStatus(next);
      void refreshData();
    }} />;
  }

  const disconnect = () => {
    void askConfirm({
      title: t("okx.disconnectTitle"),
      message: t("okx.disconnectHint"),
      confirmLabel: t("okx.disconnect"),
      cancelLabel: t("common.cancel"),
      danger: true,
    }).then((approved) => {
      if (!approved) return;
      void deleteOkxCredentials().then(() => {
        setAssets(null);
        setOrders(null);
        setShowConnection(false);
        setStatus({ configured: false, apiKeyHint: null, region: null });
      });
    });
  };

  return (
    <div className="okx-page">
      <header className="okx-header">
        <div>
          <div className="okx-eyebrow"><OkxMark size={18} /> OKX</div>
          <h1>{t("okx.title")}</h1>
          <p>{t("okx.subtitle")}</p>
        </div>
        <div className="okx-header-actions">
          <span className="okx-connected"><i />{t("okx.connected")} · {status.apiKeyHint}</span>
          <button className="okx-icon-button" title={t("okx.connection")} onClick={() => setShowConnection((value) => !value)}>
            <Icon name="settings" size={18} />
          </button>
          <button className="okx-refresh" disabled={refreshing} onClick={() => void refreshData()}>
            <Icon name="refresh" size={16} />
            {refreshing ? t("okx.refreshing") : t("wallet.refresh")}
          </button>
        </div>
      </header>

      {showConnection && (
        <section className="okx-connection-bar">
          <div>
            <strong>{t("okx.connection")}</strong>
            <span>{status.apiKeyHint} · {regionLabel(status.region)}</span>
          </div>
          <button className="okx-danger-link" onClick={disconnect}>{t("okx.disconnect")}</button>
        </section>
      )}

      <section className="okx-balance-hero">
        <div className="okx-pixel-field" aria-hidden="true">
          {Array.from({ length: 9 }, (_, index) => <i key={index} />)}
        </div>
        <div className="okx-hero-total">
          <span>{t("okx.totalEquity")}</span>
          <strong className="tnum">{assets === null ? "—" : formatMoney(assets.totalEquityUsd)} <em>USDT</em></strong>
          <small>{assets === null ? t("okx.loadingAssets") : t("okx.updatedAt", { time: formatDate(assets.updatedAt) })}</small>
        </div>
        <div className="okx-account-overview">
          <div className="okx-account-overview-head">
            <span>{t("okx.accountDistribution")}</span>
            <div className="okx-hero-note"><Icon name="shieldCheck" size={15} />{t("okx.readOnly")}</div>
          </div>
          <div className="okx-account-values">
            {(["funding", "trading", "earn"] as const).map((account) => (
              <div key={account}>
                <span><i className={account} />{t(`okx.account.${account}`)}</span>
                <strong className="tnum">{assets === null ? "—" : formatMoney(assets.accountValues[account])}</strong>
                <small>USDT</small>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="okx-section">
        <div className="okx-section-head">
          <div>
            <h2>{t("okx.assets")}</h2>
            <p>{t("okx.assetsHint")}</p>
          </div>
          {portfolioAssets !== null && <span className="okx-count">{portfolioAssets.length}</span>}
        </div>
        {assetsError !== null ? <InlineError message={assetsError} /> : <AssetTable assets={portfolioAssets} />}
      </section>

      <section className="okx-section okx-orders-section">
        <div className="okx-section-head">
          <div>
            <h2>{t("okx.dualInvestment")}</h2>
            <p>{t("okx.dualInvestmentHint")}</p>
          </div>
          <OrderHeadActions
            allOrders={ordersError === null ? orders : null}
            showAllOrders={showAllOrders}
            onShowAllOrders={setShowAllOrders}
          />
        </div>
        {ordersError !== null
          ? <DcdError message={ordersError} />
          : <OrderList orders={visibleOrders} />}
      </section>
    </div>
  );
}

function OkxSetup({ onConnected }: { onConnected: (status: OkxConnectionStatus) => void }) {
  const { t } = useT();
  const [form, setForm] = useState<OkxCredentialsInput>({
    apiKey: "",
    secretKey: "",
    passphrase: "",
    region: "global",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    void saveOkxCredentials({
      apiKey: form.apiKey.trim(),
      secretKey: form.secretKey.trim(),
      passphrase: form.passphrase,
      region: form.region,
    }).then(onConnected).catch((reason) => {
      setError(errorMessage(reason));
      setSaving(false);
    });
  };

  return (
    <div className="okx-page okx-setup-page">
      <div className="okx-setup-intro">
        <div className="okx-setup-brand"><OkxMark size={44} /></div>
        <span className="okx-kicker">OKX · READ ONLY</span>
        <h1>{t("okx.setupTitle")}</h1>
        <p>{t("okx.setupSubtitle")}</p>
        <ol className="okx-steps">
          <li><b>01</b><span><strong>{t("okx.stepCreate")}</strong><small>{t("okx.stepCreateHint")}</small></span></li>
          <li><b>02</b><span><strong>{t("okx.stepPermission")}</strong><small>{t("okx.stepPermissionHint")}</small></span></li>
          <li><b>03</b><span><strong>{t("okx.stepConnect")}</strong><small>{t("okx.stepConnectHint")}</small></span></li>
        </ol>
        <button className="okx-open-api" onClick={() => void openExternalUrl(API_KEY_URL)}>
          {t("okx.openApiPage")} <Icon name="external" size={16} />
        </button>
      </div>

      <form className="okx-setup-form" onSubmit={submit}>
        <div className="okx-form-heading">
          <span><Icon name="key" size={18} /></span>
          <div><h2>{t("okx.connectTitle")}</h2><p>{t("okx.connectHint")}</p></div>
        </div>
        <label>
          <span>{t("okx.region")}</span>
          <select value={form.region} onChange={(event) => setForm({ ...form, region: event.target.value as OkxRegion })}>
            {REGIONS.map((region) => <option key={region.value} value={region.value}>{region.label}</option>)}
          </select>
        </label>
        <label>
          <span>API Key</span>
          <input autoComplete="off" value={form.apiKey} onChange={(event) => setForm({ ...form, apiKey: event.target.value })} required />
        </label>
        <label>
          <span>Secret Key</span>
          <input type="password" autoComplete="new-password" value={form.secretKey} onChange={(event) => setForm({ ...form, secretKey: event.target.value })} required />
        </label>
        <label>
          <span>Passphrase</span>
          <input type="password" autoComplete="new-password" value={form.passphrase} onChange={(event) => setForm({ ...form, passphrase: event.target.value })} required />
        </label>
        <div className="okx-storage-note"><Icon name="lock" size={16} /><span>{t("okx.storageNote")}</span></div>
        {error !== null && <InlineError message={error} />}
        <button className="okx-connect-button" disabled={saving} type="submit">
          {saving ? t("okx.verifying") : t("okx.verifyConnect")}
          {!saving && <Icon name="chevronR" size={16} />}
        </button>
      </form>
    </div>
  );
}

function AssetTable({ assets }: { assets: OkxPortfolioAsset[] | null }) {
  const { t } = useT();
  if (assets === null) return <TableSkeleton rows={3} />;
  if (assets.length === 0) return <EmptyState title={t("okx.noAssets")} />;
  return (
    <div className="okx-table-wrap">
      <table className="okx-table">
        <thead><tr><th>{t("okx.asset")}</th><th>{t("okx.account")}</th><th>{t("okx.available")}</th><th>{t("okx.frozen")}</th><th>{t("okx.balance")}</th></tr></thead>
        <tbody>{assets.map((asset) => (
          <tr key={asset.currency}>
            <td><Coin currency={asset.currency} /><strong>{asset.currency}</strong></td>
            <td><div className="okx-account-tags">{asset.accounts.map((account) => (
              <span key={account} className={`okx-account-tag ${account}`}>{t(`okx.account.${account}`)}</span>
            ))}</div></td>
            <td className="tnum">{formatAmount(asset.available)}</td>
            <td className="tnum">{formatAmount(asset.frozen)}</td>
            <td className="tnum"><strong>{formatAmount(asset.balance)}</strong>{asset.usdValue !== null && <small>${formatMoney(asset.usdValue)}</small>}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function Coin({ currency }: { currency: string }) {
  const known: Record<string, { glyph: string; className: string }> = {
    BTC: { glyph: "₿", className: "btc" },
    ETH: { glyph: "◆", className: "eth" },
    USDC: { glyph: "$", className: "usdc" },
    USDT: { glyph: "₮", className: "usdt" },
  };
  const appearance = known[currency];
  return (
    <span className={`okx-coin${appearance === undefined ? "" : ` ${appearance.className}`}`}>
      {appearance === undefined ? currency.slice(0, 1) : appearance.glyph}
    </span>
  );
}

export function OrderYieldSummary({ orders }: { orders: OkxDcdOrder[] }) {
  const { t } = useT();
  const totals = sumOkxDcdYieldByCurrency(orders);
  const averageApr = calculateOkxDcdWeightedApr(orders);
  return (
    <div className="okx-order-yield-summary">
      <span className="okx-order-yield-summary-icon"><Icon name="activity" size={16} /></span>
      <div>
        <span className="okx-order-yield-summary-label">{t("okx.totalYield")}</span>
        <div className="okx-order-yield-summary-values">
          {totals.length === 0
            ? <strong className="okx-order-empty">—</strong>
            : totals.map((total) => (
              <strong className="tnum" key={total.currency}>
                +{formatSummaryYieldAmount(total.amount, total.currency)} {total.currency}
                {!isUsdStablecoin(total.currency) && total.usdValue !== null && (
                  <small title={t("okx.estimatedUsd")}>(${formatMoney(total.usdValue)})</small>
                )}
              </strong>
            ))}
          </div>
      </div>
      <span className="okx-order-yield-summary-divider" aria-hidden="true" />
      <div className="okx-order-yield-summary-average" title={t("okx.averageAprHint")}>
        <span className="okx-order-yield-summary-label">{t("okx.averageApr")}</span>
        <strong className="tnum">{averageApr === null ? "—" : formatYield(averageApr)}</strong>
      </div>
    </div>
  );
}

export function OrderHeadActions({
  allOrders,
  showAllOrders,
  onShowAllOrders,
}: {
  allOrders: OkxDcdOrder[] | null;
  showAllOrders: boolean;
  onShowAllOrders: (showAll: boolean) => void;
}) {
  const { t } = useT();
  return (
    <div className="okx-order-head-actions">
      {allOrders !== null && <OrderYieldSummary orders={allOrders} />}
      <div className="okx-segmented">
        <button className={!showAllOrders ? "on" : ""} onClick={() => onShowAllOrders(false)}>{t("okx.current")}</button>
        <button className={showAllOrders ? "on" : ""} onClick={() => onShowAllOrders(true)}>{t("okx.all")}</button>
      </div>
    </div>
  );
}

export function OrderList({ orders }: { orders: OkxDcdOrder[] | null }) {
  const { t } = useT();
  if (orders === null) return <TableSkeleton rows={2} />;
  if (orders.length === 0) return <EmptyState title={t("okx.noOrders")} hint={t("okx.noOrdersHint")} />;
  return (
    <div className="okx-order-table-wrap">
      <table className="okx-order-table">
        <thead>
          <tr>
            <th>{t("okx.product")}</th>
            <th>{t("okx.annualizedYield")}</th>
            <th>{t("okx.principal")}</th>
            <th>{t("okx.strike")}</th>
            <th>{t("okx.yield")}</th>
            <th>{t("okx.settlement")}</th>
            <th>{t("okx.expiryAndStatus")}</th>
          </tr>
        </thead>
        <tbody>{orders.map((order) => {
          const [baseCurrency, quoteCurrency] = order.productId.split("-");
          if (baseCurrency === undefined || quoteCurrency === undefined) {
            throw new Error(`OKX Dual Investment product ${order.productId} has no currency pair`);
          }
          const yieldUsdValue = estimateOkxDcdOrderYieldUsd(order);
          return (
            <tr key={order.orderId}>
              <td>
                <div className="okx-order-product">
                  <Coin currency={order.principalCurrency} />
                  <div>
                    <div className="okx-order-product-title">
                      <span className={`okx-option ${order.optionType}`}>{t(order.optionType === "call" ? "okx.sellHigh" : "okx.buyLow")}</span>
                      <strong>{baseCurrency} / {quoteCurrency}</strong>
                    </div>
                    <small className="okx-order-product-id">{order.productId}</small>
                    <small>{t("okx.orderId")} #{order.orderId}</small>
                  </div>
                </div>
              </td>
              <td><strong className="okx-order-apr tnum">{formatYield(order.annualizedYield)}</strong></td>
              <td><strong className="tnum">{formatAmount(order.principal)} {order.principalCurrency}</strong></td>
              <td><strong className="tnum">{formatAmount(order.strike)} {quoteCurrency}</strong></td>
              <td>{order.yieldAmount === null || order.yieldCurrency === null
                ? <span className="okx-order-empty">—</span>
                : <div className="okx-order-return">
                  <strong className="tnum">+{formatAmount(order.yieldAmount)} {order.yieldCurrency}</strong>
                  {!isUsdStablecoin(order.yieldCurrency) && yieldUsdValue !== null && (
                    <small className="tnum" title={t("okx.estimatedUsd")}>(${formatMoney(yieldUsdValue)})</small>
                  )}
                </div>}</td>
              <td>
                <div className="okx-order-settlement">
                  <span>{t("okx.settledAmount")}</span>
                  <strong className="tnum">{order.settledAmount === null || order.settledCurrency === null
                    ? "—"
                    : `${formatAmount(order.settledAmount)} ${order.settledCurrency}`}</strong>
                  <span>{t("okx.settlementPrice")}</span>
                  <strong className="tnum">{order.settlementPrice === null
                    ? "—"
                    : `${formatAmount(order.settlementPrice)} ${quoteCurrency}`}</strong>
                </div>
              </td>
              <td>
                <div className="okx-order-state-cell">
                  <time dateTime={new Date(order.expiresAt).toISOString()}>{formatDate(order.expiresAt)}</time>
                  <span className={`okx-state ${order.state}`}>{t(STATE_KEYS[order.state])}</span>
                </div>
              </td>
            </tr>
          );
        })}</tbody>
      </table>
    </div>
  );
}

function OkxMark({ size }: { size: number }) {
  return <span className="okx-mark" style={{ width: size, height: size }}><Icon name="okx" size={size} sw={0} fill="currentColor" /></span>;
}

function InlineError({ message }: { message: string }) {
  return <div className="okx-inline-error"><Icon name="alert" size={17} /><span>{message}</span></div>;
}

function DcdError({ message }: { message: string }) {
  const { t } = useT();
  const accessDisabled = message.includes("50038") || message.includes("50030");
  return <div className="okx-dcd-error"><span><Icon name="info" size={20} /></span><div><strong>{accessDisabled ? t("okx.dcdAccessTitle") : t("okx.dcdErrorTitle")}</strong><p>{accessDisabled ? t("okx.dcdAccessHint") : message}</p>{accessDisabled && <code>{message}</code>}</div></div>;
}

function PageError({ message }: { message: string }) {
  return <div className="okx-page"><div className="okx-page-error"><OkxMark size={32} /><h2>OKX</h2><p>{message}</p></div></div>;
}

function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return <div className="okx-empty"><span><Icon name="doc" size={22} /></span><strong>{title}</strong>{hint !== undefined && <p>{hint}</p>}</div>;
}

function TableSkeleton({ rows }: { rows: number }) {
  return <div className="okx-skeleton">{Array.from({ length: rows }, (_, index) => <span key={index} />)}</div>;
}

function regionLabel(region: OkxRegion): string {
  const match = REGIONS.find((item) => item.value === region);
  if (match === undefined) throw new Error(`Unsupported OKX region: ${region}`);
  return match.label;
}
