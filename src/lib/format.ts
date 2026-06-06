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
