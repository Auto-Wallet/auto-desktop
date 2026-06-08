// Transaction simulation (balance-change preview) via the BCS API — ported from the
// auto-wallet extension (src/background/bcs-simulation.ts). The approval window calls
// this before signing so the user sees the estimated balance changes. The shell is
// trusted local code, so it may call the public API directly (like prices.ts/rpc.ts).

import { invoke } from "@tauri-apps/api/core";
import { formatUnits } from "./format";
import { isTauri } from "./platform";

const BCS_API_URL = "https://balance-change-simulate-api.wanscan.org";
const BCS_TIMEOUT_MS = 8_000;
const MAX_SAFE_GAS = BigInt(Number.MAX_SAFE_INTEGER);

export type SimulatedTokenChange = {
  key: string;
  symbol: string;
  name?: string;
  address?: string;
  decimals: number;
  rawDelta: string;
  /** Signed, human-readable delta, e.g. "+1.5" / "-0.0034". */
  formattedDelta: string;
  direction: "in" | "out";
};

export type SimulationPreview = {
  status: "success" | "failed" | "unavailable";
  error?: string;
  gasUsed?: string;
  changes: SimulatedTokenChange[];
};

export type SimulateArgs = {
  chainId: number;
  from: string;
  to: string | null;
  data: string | null;
  value: bigint;
  gas: bigint;
  nativeSymbol?: string;
};

type SimulationApiResponse = {
  ok: boolean;
  status: number;
  data: any;
};

function formatDelta(raw: bigint, decimals: number): string {
  const abs = raw < 0n ? -raw : raw;
  return `${raw < 0n ? "-" : "+"}${formatUnits(abs.toString(), decimals, 6)}`;
}

function parseRaw(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    if (value.startsWith("0x")) return BigInt(value);
    if (/^-?\d+$/.test(value)) return BigInt(value);
  } catch {
    /* not a number */
  }
  return null;
}

function friendlyUnavailable(status: number, message: string): string {
  const lower = message.toLowerCase();
  if (status >= 500 || lower.includes("unsupported") || lower.includes("not supported"))
    return "Simulation is not available for this network yet.";
  return message;
}

function pickErrorMessage(parsed: any, fallback: string): string {
  return (
    (typeof parsed?.error === "string" && parsed.error) ||
    parsed?.error?.message ||
    parsed?.message ||
    parsed?.revert_reason ||
    fallback
  );
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** Simulate `tx` and return the signer's estimated balance changes. Never throws —
 *  failures/timeouts/unsupported networks resolve to an `unavailable`/`failed`
 *  preview the UI can show honestly (it never blocks approval). */
export async function simulateTx(args: SimulateArgs): Promise<SimulationPreview> {
  // Contract creations have no `to`; the API requires one. Skip rather than mislead.
  if (!args.to)
    return { status: "unavailable", error: "Simulation does not support contract deployments.", changes: [] };

  const url = BCS_API_URL.replace(/\/+$/, "") + "/simulate";
  const cappedGas = args.gas > MAX_SAFE_GAS ? MAX_SAFE_GAS : args.gas;
  try {
    const request = {
      chain_id: args.chainId,
      from: args.from,
      to: args.to,
      data: args.data ?? "0x",
      value: args.value.toString(),
      gas: Number(cappedGas),
    };
    const api = isTauri()
      ? await invoke<SimulationApiResponse>("simulate_tx", { req: request })
      : await fetchSimulation(url, request);
    const data = api.data ?? {};
    if (!api.ok) {
      const msg = pickErrorMessage(data, `Simulation API error (${api.status})`);
      return { status: "unavailable", error: friendlyUnavailable(api.status, msg), changes: [] };
    }
    const status: "success" | "failed" = data?.success ? "success" : "failed";
    const gasUsed = typeof data?.gas_used === "string" ? data.gas_used : undefined;
    const error =
      status === "failed"
        ? (typeof data?.revert_reason === "string" && data.revert_reason) || "Transaction would revert"
        : undefined;
    const changes = extractSignerChanges(data, args.from, args.nativeSymbol ?? "ETH");
    return { status, error, gasUsed, changes };
  } catch (e: any) {
    return { status: "unavailable", error: e?.message ?? String(e), changes: [] };
  }
}

async function fetchSimulation(url: string, request: Record<string, unknown>): Promise<SimulationApiResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BCS_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, data: text ? safeJson(text) : {} };
  } finally {
    clearTimeout(timer);
  }
}

function extractSignerChanges(data: any, signer: string, nativeSymbolRaw: string): SimulatedTokenChange[] {
  const balances: any[] = Array.isArray(data?.balance_changes) ? data.balance_changes : [];
  const target = signer.toLowerCase();
  const entry = balances.find(
    (b: any) => typeof b?.address === "string" && b.address.toLowerCase() === target,
  );
  if (!entry) return [];

  const out: SimulatedTokenChange[] = [];
  const nativeSymbol = nativeSymbolRaw.toUpperCase();

  const nativeRaw = parseRaw(entry.native_delta);
  if (nativeRaw !== null && nativeRaw !== 0n) {
    out.push({
      key: `native:${nativeSymbol}`,
      symbol: nativeSymbol,
      decimals: 18,
      rawDelta: nativeRaw.toString(),
      formattedDelta: formatDelta(nativeRaw, 18),
      direction: nativeRaw > 0n ? "in" : "out",
    });
  }

  const tokenDeltas: any[] = Array.isArray(entry.token_deltas) ? entry.token_deltas : [];
  for (const td of tokenDeltas) {
    const raw = parseRaw(td?.delta);
    if (raw === null || raw === 0n) continue;
    const address = typeof td?.token === "string" ? td.token : undefined;
    const symbol =
      typeof td?.symbol === "string" && td.symbol.length > 0 ? td.symbol.toUpperCase() : "TOKEN";
    const name = typeof td?.name === "string" ? td.name : undefined;
    const decimals = typeof td?.decimals === "number" ? td.decimals : 18;
    out.push({
      key: address ? address.toLowerCase() : `${symbol}:${decimals}`,
      symbol,
      name,
      address,
      decimals,
      rawDelta: raw.toString(),
      formattedDelta: formatDelta(raw, decimals),
      direction: raw > 0n ? "in" : "out",
    });
  }

  out.sort((a, b) =>
    a.direction !== b.direction ? (a.direction === "out" ? -1 : 1) : a.symbol.localeCompare(b.symbol),
  );
  return out;
}
