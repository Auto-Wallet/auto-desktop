// Display formatting. No external deps (BigInt is enough) — keeps the bundle
// small per the VISION.md "ultra-lightweight" principle.

/** "0x1a2b...c3d4" from a full address. */
export function shortAddress(addr: string, lead = 6, tail = 4): string {
  if (addr.length <= lead + tail) return addr;
  return `${addr.slice(0, lead)}…${addr.slice(-tail)}`;
}

/** Wei (hex or decimal string) -> human token amount, trimmed. */
export function formatUnits(value: string, decimals = 18, maxFrac = 4): string {
  const wei = value.startsWith("0x") ? BigInt(value) : BigInt(value || "0");
  const base = 10n ** BigInt(decimals);
  const whole = wei / base;
  const frac = wei % base;
  if (frac === 0n) return whole.toString();

  // Left-pad the fractional part to `decimals`, then keep up to maxFrac digits.
  let fracStr = frac.toString().padStart(decimals, "0").slice(0, maxFrac);
  fracStr = fracStr.replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : whole.toString();
}

/** Basic 0x-address shape check (not a checksum verification). */
export function isAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(s.trim());
}

/**
 * Human token amount -> integer base units (wei). Throws on a malformed amount or
 * more fractional digits than `decimals` — callers validate first, so a bad value
 * surfaces loudly instead of silently truncating (CLAUDE: no fallback masking).
 */
export function parseUnits(amount: string, decimals = 18): bigint {
  const s = amount.trim();
  if (s === "" || s === "." || !/^\d*\.?\d*$/.test(s)) {
    throw new Error(`invalid amount: "${amount}"`);
  }
  const [whole, frac = ""] = s.split(".");
  if (frac.length > decimals) throw new Error(`too many decimals (max ${decimals})`);
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

/** A bigint -> minimal 0x-hex quantity (EIP-1474 style, no leading zeros). */
export function toHexQuantity(n: bigint): string {
  return "0x" + n.toString(16);
}

/** USD amount, e.g. `$1,234.56` (or `+$12.30` / `−$4.00` with sign). */
export function fmtUsd(n: number, opts: { sign?: boolean; dp?: number } = {}): string {
  const { sign = false, dp = 2 } = opts;
  const abs = Math.abs(n);
  const s = abs.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
  const pre = (sign && n > 0 ? "+" : n < 0 ? "−" : "") + "$";
  return pre + s;
}

/** Signed percent, e.g. `+2.40%` / `−1.10%`. */
export function fmtPct(n: number): string {
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(2)}%`;
}

/** wei (hex/decimal string) -> USD number, using a price per whole token. */
export function weiToUsd(value: string, decimals: number, priceUsd: number): number {
  const wei = value.startsWith("0x") ? BigInt(value) : BigInt(value || "0");
  // Keep 6 fractional digits of token amount before multiplying by price.
  const scaled = (wei * 1_000_000n) / 10n ** BigInt(decimals);
  return (Number(scaled) / 1_000_000) * priceUsd;
}
