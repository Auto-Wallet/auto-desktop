// Decoders for what a dApp actually asks the user to sign — pure functions, no
// Tauri/network access, so the approval window can show real recipients,
// spenders and amounts instead of opaque calldata. All input is UNTRUSTED.

/** The subset of a prepared transaction the decoders need. */
export interface CalldataCarrier {
  to: string;
  data: string;
}

/** The EIP-712 payload as the dApp sent it (every field may be junk). */
export interface TypedDataPayload {
  domain?: Record<string, unknown>;
  primaryType?: string;
  message?: unknown;
}

export type ApprovalDetails = {
  tokenAddress: string;
  spender: string;
  amountRaw: bigint;
};

/** A decoded ERC-20 transfer / transferFrom carried by a dApp transaction. */
export type TransferDetails = {
  tokenAddress: string;
  owner: string | null;
  recipient: string;
  amountRaw: bigint;
};

/** What a permit-style EIP-712 signature would grant, extracted for display. */
export type PermitInfo = {
  spender: string | null;
  token: string | null;
  amountRaw: bigint | null;
  unlimited: boolean;
  deadline: bigint | null;
  chainHex: string | null;
};

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

export function parseApprovalDetails(tx: CalldataCarrier): ApprovalDetails | null {
  if (!tx.to || !tx.data?.startsWith("0x095ea7b3")) return null;
  const data = tx.data.slice(2);
  if (data.length < 8 + 64 + 64) return null;
  const spenderWord = data.slice(8, 72);
  const amountWord = data.slice(72, 136);
  const spender = `0x${spenderWord.slice(24)}`;
  if (!ADDR_RE.test(spender)) return null;
  return {
    tokenAddress: tx.to,
    spender,
    amountRaw: BigInt(`0x${amountWord}`),
  };
}

// Decode an ERC-20 transfer(address,uint256) / transferFrom(address,address,uint256)
// carried by a dApp transaction, so the approval window shows the REAL recipient
// and token amount instead of "to: token contract, 0 ETH".
export function parseTransferDetails(tx: CalldataCarrier): TransferDetails | null {
  if (!tx.to || !tx.data) return null;
  const data = tx.data.replace(/^0x/, "");
  const selector = data.slice(0, 8).toLowerCase();
  const word = (i: number) => data.slice(8 + i * 64, 8 + (i + 1) * 64);
  const addr = (w: string) => `0x${w.slice(24)}`;
  if (selector === "a9059cbb" && data.length >= 8 + 128) {
    const recipient = addr(word(0));
    if (!ADDR_RE.test(recipient)) return null;
    return { tokenAddress: tx.to, owner: null, recipient, amountRaw: BigInt(`0x${word(1)}`) };
  }
  if (selector === "23b872dd" && data.length >= 8 + 192) {
    const owner = addr(word(0));
    const recipient = addr(word(1));
    if (!ADDR_RE.test(owner) || !ADDR_RE.test(recipient)) return null;
    return { tokenAddress: tx.to, owner, recipient, amountRaw: BigInt(`0x${word(2)}`) };
  }
  return null;
}

export function encodeErc20Approve(spender: string, amount: bigint): string {
  const addr = spender.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(addr)) throw new Error("invalid spender");
  return `0x095ea7b3${addr.padStart(64, "0")}${amount.toString(16).padStart(64, "0")}`;
}

export const MAX_UINT256 = (1n << 256n) - 1n;
export const MAX_UINT160 = (1n << 160n) - 1n; // Permit2 amounts are uint160
export const MAX_UINT96 = (1n << 96n) - 1n; // UNI-style permits are uint96

// dApp-supplied values may be numbers, decimal strings, or hex strings — or junk.
export function asBigint(v: unknown): bigint | null {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.trunc(v));
  if (typeof v === "string") {
    try {
      return BigInt(v);
    } catch {
      return null;
    }
  }
  return null;
}

export function chainIdToHex(v: unknown): string | null {
  const n = asBigint(v);
  return n !== null && n > 0n ? `0x${n.toString(16)}` : null;
}

// Recognize permit-style typed data (ERC-2612, DAI permit, Permit2 single/batch/
// transfer) and pull out what the signature would actually grant. Untrusted
// input: anything that doesn't parse stays null and renders as "—".
export function detectPermit(data: TypedDataPayload): PermitInfo | null {
  const msg = data.message;
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return null;
  const m = msg as Record<string, unknown>;
  const domain = (data.domain ?? {}) as Record<string, unknown>;
  // Permit2 nests token+amount: PermitSingle/PermitBatch under `details`,
  // PermitTransferFrom under `permitted` (arrays for the batch variants).
  const nestedRaw = m.details ?? m.permitted;
  const nested = Array.isArray(nestedRaw) ? nestedRaw[0] : nestedRaw;
  const inner =
    nested && typeof nested === "object" ? (nested as Record<string, unknown>) : undefined;
  const spender = typeof m.spender === "string" ? m.spender : null;
  const daiAllowed = m.allowed === true || m.allowed === "true";
  const amountRaw = daiAllowed
    ? null
    : asBigint(m.value ?? m.amount ?? m.wad ?? inner?.amount ?? inner?.value);
  const primary = String(data.primaryType ?? "");
  if (!/permit/i.test(primary) && !(spender && (amountRaw !== null || daiAllowed))) return null;
  const tokenField = inner?.token ?? m.token;
  const token =
    typeof tokenField === "string"
      ? tokenField
      : typeof domain.verifyingContract === "string"
        ? domain.verifyingContract
        : null;
  const deadline = asBigint(m.deadline ?? m.sigDeadline ?? m.expiry ?? inner?.expiration);
  const unlimited =
    daiAllowed ||
    amountRaw === MAX_UINT256 ||
    amountRaw === MAX_UINT160 ||
    amountRaw === MAX_UINT96;
  return { spender, token, amountRaw, unlimited, deadline, chainHex: chainIdToHex(domain.chainId) };
}
