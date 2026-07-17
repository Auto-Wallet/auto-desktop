// Display formatting. No external deps (BigInt is enough) — keeps the bundle
// small per the VISION.md "ultra-lightweight" principle.

import { toChecksumAddress } from "./keccak";

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

/**
 * Address validity: shape, plus EIP-55 checksum when the address is mixed-case.
 * All-lowercase / all-uppercase carry no checksum information and pass on shape
 * alone; a mixed-case address with a broken checksum is a mangled paste and is
 * rejected — that case-mix is exactly what EIP-55 exists to catch.
 */
export function isAddress(s: string): boolean {
  const a = s.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return false;
  const hex = a.slice(2);
  if (hex === hex.toLowerCase() || hex === hex.toUpperCase()) return true;
  return toChecksumAddress(a) === a;
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
  const pre = (sign && n > 0 ? "+" : n < 0 ? "−" : "") + "$";
  const tiny = fmtTiny(n);
  if (tiny) return pre + tiny;
  const abs = Math.abs(n);
  const s = abs.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
  return pre + s;
}

const SUB_DIGITS = ["₀", "₁", "₂", "₃", "₄", "₅", "₆", "₇", "₈", "₉"];

/**
 * Subscript notation for tiny magnitudes: 0.0000123 -> "0.0₄123" — the
 * subscript counts the zeros between the decimal point and the first
 * significant digit (a widespread crypto convention for dust). Returns null
 * outside (0, 0.0001) so callers keep their normal formatting there.
 */
export function fmtTiny(n: number): string | null {
  if (!Number.isFinite(n)) return null;
  const abs = Math.abs(n);
  if (abs === 0 || abs >= 0.0001) return null;
  // Zeros between the decimal point and the first significant digit.
  let zeros = Math.ceil(-Math.log10(abs)) - 1;
  const sig = abs * 10 ** (zeros + 1); // in [1, 10)
  let sigStr = sig.toPrecision(4);
  if (Number.parseFloat(sigStr) >= 10) {
    // Rounding bumped 9.999… up to 10 — one zero fewer, shift the digit down.
    zeros -= 1;
    sigStr = (sig / 10).toPrecision(4);
  }
  if (sigStr.includes(".")) sigStr = sigStr.replace(/0+$/, "").replace(/\.$/, "");
  // The significand reads as a continuation of the decimals: "0.0₄123",
  // never "0.0₄1.23".
  sigStr = sigStr.replace(".", "");
  const sub = String(zeros)
    .split("")
    .map((d) => SUB_DIGITS[Number(d)])
    .join("");
  return `0.0${sub}${sigStr}`;
}

/**
 * Display-only token amount from base units: subscript notation for dust
 * (0.0₄123), otherwise 6 significant digits via fmtAmount. Never for editable
 * inputs — the subscript glyphs don't parse (parseUnits would reject them).
 */
export function fmtUnitsDisplay(value: string, decimals = 18): string {
  return fmtAmount(formatUnits(value, decimals, Math.min(decimals, 18)));
}

/**
 * Token amount for display. Readability beats raw precision (the exact value
 * always sits in the element's title tooltip): dust (<0.0001) uses subscript
 * notation, 1M+ compacts to `2.5M` / `8.72B`, and everything in between keeps
 * 6 significant digits with thousands separators and trimmed trailing zeros.
 */
export function fmtAmount(value: string): string {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) return value;
  const abs = Math.abs(n);
  const tiny = fmtTiny(abs);
  if (tiny) return (n < 0 ? "−" : "") + tiny;
  if (abs >= 1_000_000) {
    return n.toLocaleString("en-US", {
      notation: "compact",
      maximumFractionDigits: 2,
    });
  }
  // 6 significant digits, re-rounded then localized ("33.6506" / "25,755.3").
  const rounded = Number.parseFloat(n.toPrecision(6));
  return rounded.toLocaleString("en-US", { maximumFractionDigits: 6 });
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
