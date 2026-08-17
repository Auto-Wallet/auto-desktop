import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./platform";

export type OkxRegion = "global" | "us" | "eu" | "tr";

export type OkxCredentialsInput = {
  apiKey: string;
  secretKey: string;
  passphrase: string;
  region: OkxRegion;
};

export type OkxConnectionStatus =
  | { configured: false; apiKeyHint: null; region: null }
  | { configured: true; apiKeyHint: string; region: OkxRegion };

export type OkxAsset = {
  account: "trading" | "funding";
  currency: string;
  balance: string;
  available: string;
  frozen: string;
  usdValue: string | null;
};

export type OkxPortfolioAsset = {
  accounts: ("trading" | "funding" | "earn")[];
  currency: string;
  balance: string;
  available: string;
  frozen: string;
  usdValue: string | null;
};

export type OkxAssets = {
  totalEquityUsd: string;
  updatedAt: number;
  accountValues: {
    funding: string;
    trading: string;
    earn: string;
  };
  assets: OkxAsset[];
};

export type OkxDcdOrderState =
  | "initial"
  | "live"
  | "pending_settle"
  | "settled"
  | "pending_redeem"
  | "redeemed"
  | "rejected";

export type OkxDcdOrder = {
  orderId: string;
  productId: string;
  optionType: "call" | "put";
  state: OkxDcdOrderState;
  strike: string;
  principal: string;
  principalCurrency: string;
  annualizedYield: string;
  yieldAmount: string | null;
  yieldCurrency: string | null;
  expiresAt: number;
  settledAmount: string | null;
  settledCurrency: string | null;
  settlementPrice: string | null;
};

type JsonRecord = Record<string, unknown>;

const REGIONS = new Set<OkxRegion>(["global", "us", "eu", "tr"]);
const ORDER_STATES = new Set<OkxDcdOrderState>([
  "initial",
  "live",
  "pending_settle",
  "settled",
  "pending_redeem",
  "redeemed",
  "rejected",
]);

export function createSingleFlight<T>(operation: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;

  return () => {
    if (inFlight !== null) return inFlight;

    const request = operation();
    inFlight = request;
    const clear = () => {
      if (inFlight === request) inFlight = null;
    };
    void request.then(clear, clear);
    return request;
  };
}

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function optionalString(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  return string(value, label);
}

function availableAmount(value: unknown, label: string): string {
  const amount = string(value, label);
  return amount === "" ? "0" : amount;
}

function timestamp(value: unknown, label: string): number {
  const raw = string(value, label);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} is invalid`);
  return parsed;
}

function parseEnvelope(value: unknown, label: string): unknown[] {
  const envelope = record(value, label);
  const code = string(envelope.code, `${label}.code`);
  if (code !== "0") {
    const message = string(envelope.msg, `${label}.msg`);
    throw new Error(`OKX API ${code}: ${message}`);
  }
  return array(envelope.data, `${label}.data`);
}

function parseOptionalCodeEnvelope(value: unknown, label: string): unknown[] {
  const envelope = record(value, label);
  if (envelope.code !== undefined) {
    const code = envelope.code === 0 ? "0" : string(envelope.code, `${label}.code`);
    if (code !== "0") {
      const message = string(envelope.msg, `${label}.msg`);
      throw new Error(`OKX API ${code}: ${message}`);
    }
  }
  return array(envelope.data, `${label}.data`);
}

export function parseOkxConnectionStatus(value: unknown): OkxConnectionStatus {
  const status = record(value, "OKX connection status");
  if (typeof status.configured !== "boolean") {
    throw new Error("OKX connection status.configured must be a boolean");
  }
  if (!status.configured) {
    if (status.apiKeyHint !== null || status.region !== null) {
      throw new Error("Unconfigured OKX status must not expose connection details");
    }
    return { configured: false, apiKeyHint: null, region: null };
  }
  const region = string(status.region, "OKX connection status.region") as OkxRegion;
  if (!REGIONS.has(region)) throw new Error("OKX connection status.region is invalid");
  return {
    configured: true,
    apiKeyHint: string(status.apiKeyHint, "OKX connection status.apiKeyHint"),
    region,
  };
}

export function parseOkxAssets(value: unknown): OkxAssets {
  const root = record(value, "OKX assets");
  const valuationRows = parseEnvelope(root.valuation, "OKX account valuation");
  if (valuationRows.length !== 1) {
    throw new Error("OKX account valuation must contain one summary");
  }
  const valuation = record(valuationRows[0], "OKX account valuation summary");
  const accountValues = record(valuation.details, "OKX account valuation summary.details");
  const tradingRows = parseEnvelope(root.trading, "OKX trading balance");
  if (tradingRows.length !== 1) {
    throw new Error("OKX trading balance must contain one account summary");
  }
  const summary = record(tradingRows[0], "OKX trading account summary");
  const details = array(summary.details, "OKX trading account summary.details");
  const trading: OkxAsset[] = details.map((value, index) => {
    const item = record(value, `OKX trading asset ${index}`);
    return {
      account: "trading",
      currency: string(item.ccy, `OKX trading asset ${index}.ccy`),
      balance: string(item.eq, `OKX trading asset ${index}.eq`),
      available: availableAmount(item.availEq, `OKX trading asset ${index}.availEq`),
      frozen: availableAmount(item.frozenBal, `OKX trading asset ${index}.frozenBal`),
      usdValue: optionalString(item.eqUsd, `OKX trading asset ${index}.eqUsd`),
    };
  });
  const funding = parseEnvelope(root.funding, "OKX funding balance").map((value, index) => {
    const item = record(value, `OKX funding asset ${index}`);
    return {
      account: "funding" as const,
      currency: string(item.ccy, `OKX funding asset ${index}.ccy`),
      balance: string(item.bal, `OKX funding asset ${index}.bal`),
      available: availableAmount(item.availBal, `OKX funding asset ${index}.availBal`),
      frozen: availableAmount(item.frozenBal, `OKX funding asset ${index}.frozenBal`),
      usdValue: null,
    };
  });
  return {
    totalEquityUsd: string(valuation.totalBal, "OKX account valuation summary.totalBal"),
    updatedAt: timestamp(valuation.ts, "OKX account valuation summary.ts"),
    accountValues: {
      funding: string(accountValues.funding, "OKX account valuation summary.details.funding"),
      trading: string(accountValues.trading, "OKX account valuation summary.details.trading"),
      earn: string(accountValues.earn, "OKX account valuation summary.details.earn"),
    },
    assets: [...trading, ...funding],
  };
}

export function parseOkxDcdOrders(value: unknown): OkxDcdOrder[] {
  return parseOptionalCodeEnvelope(value, "OKX Dual Investment orders").map((value, index) => {
    const item = record(value, `OKX Dual Investment order ${index}`);
    const productId = string(item.productId, `OKX Dual Investment order ${index}.productId`);
    const optionType = productId.endsWith("-C")
      ? "call"
      : productId.endsWith("-P")
        ? "put"
        : null;
    if (optionType === null) {
      throw new Error(`OKX Dual Investment order ${index}.productId has no option type`);
    }
    const state = string(item.state, `OKX Dual Investment order ${index}.state`).toLowerCase() as OkxDcdOrderState;
    if (!ORDER_STATES.has(state)) {
      throw new Error(`OKX Dual Investment order ${index}.state is invalid`);
    }
    let principalCurrency: string;
    if (item.notionalCcy !== undefined) {
      principalCurrency = string(item.notionalCcy, `OKX Dual Investment order ${index}.notionalCcy`);
    } else {
      const productCurrencies = productId.split("-");
      if (productCurrencies.length < 2) {
        throw new Error(`OKX Dual Investment order ${index}.productId has no currency pair`);
      }
      principalCurrency = optionType === "call" ? productCurrencies[0] : productCurrencies[1];
    }
    const expiry = item.expTime !== undefined ? item.expTime : item.settleTime;
    return {
      orderId: string(item.ordId, `OKX Dual Investment order ${index}.ordId`),
      productId,
      optionType,
      state,
      strike: string(item.strike, `OKX Dual Investment order ${index}.strike`),
      principal: string(item.notionalSz, `OKX Dual Investment order ${index}.notionalSz`),
      principalCurrency,
      annualizedYield: string(item.annualizedYield, `OKX Dual Investment order ${index}.annualizedYield`),
      yieldAmount: optionalString(item.yieldSz, `OKX Dual Investment order ${index}.yieldSz`),
      yieldCurrency: optionalString(item.yieldCcy, `OKX Dual Investment order ${index}.yieldCcy`),
      expiresAt: timestamp(expiry, `OKX Dual Investment order ${index}.settleTime`),
      settledAmount: optionalString(item.settleSz, `OKX Dual Investment order ${index}.settleSz`),
      settledCurrency: optionalString(item.settleCcy, `OKX Dual Investment order ${index}.settleCcy`),
      settlementPrice: optionalString(item.settlePx, `OKX Dual Investment order ${index}.settlePx`),
    };
  });
}

async function okxInvoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!isTauri()) throw new Error("OKX account access is available in the desktop app.");
  return invoke<T>(command, args);
}

export async function getOkxConnectionStatus(): Promise<OkxConnectionStatus> {
  return parseOkxConnectionStatus(await okxInvoke("okx_connection_status"));
}

export async function saveOkxCredentials(creds: OkxCredentialsInput): Promise<OkxConnectionStatus> {
  return parseOkxConnectionStatus(await okxInvoke("okx_save_credentials", { creds }));
}

export async function deleteOkxCredentials(): Promise<void> {
  await okxInvoke("okx_delete_credentials");
}

export async function getOkxAssets(): Promise<OkxAssets> {
  return parseOkxAssets(await okxInvoke("okx_get_assets"));
}

export async function getOkxDcdOrders(): Promise<OkxDcdOrder[]> {
  return parseOkxDcdOrders(await okxInvoke("okx_get_dcd_orders"));
}

export function isCurrentDcdOrder(order: OkxDcdOrder): boolean {
  return order.state === "initial"
    || order.state === "live"
    || order.state === "pending_settle"
    || order.state === "pending_redeem";
}

function addDecimalStrings(left: string, right: string, label: string): string {
  const decimal = /^-?\d+(?:\.\d+)?$/;
  if (!decimal.test(left) || !decimal.test(right)) {
    throw new Error(`${label} must contain decimal strings`);
  }
  const scaleOf = (value: string) => {
    const point = value.indexOf(".");
    return point === -1 ? 0 : value.length - point - 1;
  };
  const scale = Math.max(scaleOf(left), scaleOf(right));
  const toUnits = (value: string) => {
    const negative = value.startsWith("-");
    const unsigned = negative ? value.slice(1) : value;
    const parts = unsigned.split(".");
    const whole = parts[0];
    const fraction = parts.length === 2 ? parts[1] : "";
    const units = BigInt(`${whole}${fraction.padEnd(scale, "0")}`);
    return negative ? -units : units;
  };
  const total = toUnits(left) + toUnits(right);
  if (scale === 0) return total.toString();
  const negative = total < 0n;
  const digits = (negative ? -total : total).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, -scale);
  const fraction = digits.slice(-scale).replace(/0+$/, "");
  const sign = negative ? "-" : "";
  return fraction.length === 0 ? `${sign}${whole}` : `${sign}${whole}.${fraction}`;
}

export function mergeOkxPortfolioAssets(
  assets: OkxAssets,
  orders: OkxDcdOrder[],
): OkxPortfolioAsset[] {
  const portfolio = new Map<string, OkxPortfolioAsset>();

  for (const asset of assets.assets) {
    const existing = portfolio.get(asset.currency);
    if (existing === undefined) {
      portfolio.set(asset.currency, {
        accounts: [asset.account],
        currency: asset.currency,
        balance: asset.balance,
        available: asset.available,
        frozen: asset.frozen,
        usdValue: asset.usdValue,
      });
      continue;
    }
    if (!existing.accounts.includes(asset.account)) existing.accounts.push(asset.account);
    existing.balance = addDecimalStrings(existing.balance, asset.balance, `${asset.currency} balance`);
    existing.available = addDecimalStrings(existing.available, asset.available, `${asset.currency} available`);
    existing.frozen = addDecimalStrings(existing.frozen, asset.frozen, `${asset.currency} frozen`);
    if (existing.usdValue !== null && asset.usdValue !== null) {
      existing.usdValue = addDecimalStrings(existing.usdValue, asset.usdValue, `${asset.currency} USD value`);
    } else {
      existing.usdValue = null;
    }
  }

  for (const order of orders) {
    if (!isCurrentDcdOrder(order)) continue;
    const existing = portfolio.get(order.principalCurrency);
    if (existing === undefined) {
      portfolio.set(order.principalCurrency, {
        accounts: ["earn"],
        currency: order.principalCurrency,
        balance: order.principal,
        available: "0",
        frozen: order.principal,
        usdValue: null,
      });
      continue;
    }
    if (!existing.accounts.includes("earn")) existing.accounts.push("earn");
    existing.balance = addDecimalStrings(
      existing.balance,
      order.principal,
      `${order.principalCurrency} balance`,
    );
    existing.frozen = addDecimalStrings(
      existing.frozen,
      order.principal,
      `${order.principalCurrency} frozen`,
    );
    existing.usdValue = null;
  }

  return [...portfolio.values()];
}
