// Self-contained keccak-256 (the pre-NIST 0x01 padding Ethereum uses) for
// EIP-55 address checksums. BigInt lanes — slow by hashing standards, but our
// inputs are 40-byte address strings, so simplicity and zero deps win
// (VISION.md "ultra-lightweight"). Verified against the standard test vectors
// and the EIP-55 spec addresses in keccak.test.ts.

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROTC = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44];
const PILN = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];
const M64 = (1n << 64n) - 1n;

const rotl = (x: bigint, n: number) => ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M64;

function keccakF(s: bigint[]): void {
  for (let round = 0; round < 24; round++) {
    // θ
    const c = [0, 1, 2, 3, 4].map((x) => s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]);
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) s[x + y] ^= d;
    }
    // ρ + π
    let last = s[1];
    for (let i = 0; i < 24; i++) {
      const j = PILN[i];
      const tmp = s[j];
      s[j] = rotl(last, ROTC[i]);
      last = tmp;
    }
    // χ
    for (let y = 0; y < 25; y += 5) {
      const row = s.slice(y, y + 5);
      for (let x = 0; x < 5; x++) s[y + x] = row[x] ^ (~row[(x + 1) % 5] & M64 & row[(x + 2) % 5]);
    }
    // ι
    s[0] ^= RC[round];
  }
}

/** keccak-256 of a string (UTF-8) or bytes → lowercase hex, no 0x prefix. */
export function keccak256(input: Uint8Array | string): string {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const rate = 136; // 1600/8 - 2*32
  const padded = new Uint8Array((Math.floor(data.length / rate) + 1) * rate);
  padded.set(data);
  padded[data.length] ^= 0x01; // keccak (pre-SHA-3) domain bit
  padded[padded.length - 1] ^= 0x80;

  const state = new Array<bigint>(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + b]);
      state[i] ^= lane;
    }
    keccakF(state);
  }

  let out = "";
  for (let i = 0; i < 4; i++) {
    let lane = state[i];
    for (let b = 0; b < 8; b++) {
      out += (lane & 0xffn).toString(16).padStart(2, "0");
      lane >>= 8n;
    }
  }
  return out;
}

/** EIP-55 checksummed form of an address (input must be 0x + 40 hex chars). */
export function toChecksumAddress(address: string): string {
  const hex = address.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(hex)) throw new Error(`not an address: ${address}`);
  const hash = keccak256(hex);
  let out = "0x";
  for (let i = 0; i < 40; i++) {
    out += parseInt(hash[i], 16) >= 8 ? hex[i].toUpperCase() : hex[i];
  }
  return out;
}
