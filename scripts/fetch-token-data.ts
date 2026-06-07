// Fetch-once generator for the wallet's DEFAULT supported chains + tokens.
//
// Per the product decision: we do NOT hit the xflows API at runtime. Instead we
// fetch its supported-chains / supported-tokens lists ONCE here (during dev),
// filter to the EVM chains this (secp256k1/EVM-only) wallet can actually use,
// merge in a curated RPC + brand color for each, and bake the result into the
// committed module `src/lib/tokenData.ts`. Re-run with `bun run gen:tokens`
// whenever you want to refresh the snapshot.
//
//   Source: https://xflows.wanchain.org/api/v3/supported/{chains,tokens}
//   (the openapi.json host xflows-open-api.wanscan.org only serves the docs page)

import { mkdir } from "node:fs/promises";

const BASE = "https://xflows.wanchain.org";
const OUT = new URL("../src/lib/tokenData.ts", import.meta.url).pathname;
// Logos are downloaded ONCE here into the app's static assets so they ship with
// the build and load locally — no per-render network fetch (which blanks the icons
// on a bad connection). tokenData stores the local `/logos/<slug>.<ext>` path.
const LOGO_DIR = new URL("../public/logos/", import.meta.url).pathname;

/** Download a remote logo into public/logos and return its local `/logos/...` path
 *  (or "" if there's no URL or the download fails — the UI falls back to a glyph). */
async function localizeLogo(remoteUrl: string, slug: string): Promise<string> {
  if (!remoteUrl) return "";
  try {
    const res = await fetch(remoteUrl);
    if (!res.ok) return "";
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) return "";
    const ext = (new URL(remoteUrl).pathname.match(/\.(png|webp|svg|jpe?g|gif)$/i)?.[1] ?? "png").toLowerCase();
    const file = `${slug}.${ext}`;
    await Bun.write(LOGO_DIR + file, buf);
    return `/logos/${file}`;
  } catch {
    return "";
  }
}

// Curated EVM chains: chainId(dec) -> { rpc, color }. Only chains listed here are
// emitted — this is also how non-EVM xflows chains (Solana/TRON/Bitcoin/Cardano/
// Sui/Kava) get excluded, since this wallet can only sign/read EVM chains. The
// name / native symbol / decimals / logo come from the API.
const EVM: Record<number, { rpc: string; color: string }> = {
  1: { rpc: "https://ethereum-rpc.publicnode.com", color: "#627EEA" },
  10: { rpc: "https://optimism-rpc.publicnode.com", color: "#FF0420" },
  56: { rpc: "https://bsc-rpc.publicnode.com", color: "#F3BA2F" },
  137: { rpc: "https://polygon-bor-rpc.publicnode.com", color: "#8247E5" },
  196: { rpc: "https://rpc.xlayer.tech", color: "#1A1A1A" },
  324: { rpc: "https://mainnet.era.zksync.io", color: "#8C8DFC" },
  592: { rpc: "https://evm.astar.network", color: "#1B6DC1" },
  888: { rpc: "https://gwan-ssl.wandevs.org:56891", color: "#2A6BE9" },
  1088: { rpc: "https://andromeda.metis.io/?owner=1088", color: "#00DACC" },
  1101: { rpc: "https://zkevm-rpc.com", color: "#7B3FE4" },
  8453: { rpc: "https://base-rpc.publicnode.com", color: "#0052FF" },
  42161: { rpc: "https://arbitrum-one-rpc.publicnode.com", color: "#28A0F0" },
  42220: { rpc: "https://forno.celo.org", color: "#FCB728" },
  43114: { rpc: "https://avalanche-c-chain-rpc.publicnode.com", color: "#E84142" },
  59144: { rpc: "https://linea-rpc.publicnode.com", color: "#61DFFF" },
  81457: { rpc: "https://blast-rpc.publicnode.com", color: "#FCD000" },
  480: { rpc: "https://worldchain-mainnet.g.alchemy.com/public", color: "#1A1A1A" },
  146: { rpc: "https://rpc.soniclabs.com", color: "#1969FF" },
};

const ZERO = "0x0000000000000000000000000000000000000000";
const toHexId = (n: number) => "0x" + n.toString(16);

type ApiChain = {
  chainId: number;
  chainName: string;
  symbol: string;
  decimals: number;
  logo?: string;
};
type ApiToken = {
  decimals: string;
  tokenContractAddress: string;
  tokenLogoUrl?: string;
  tokenName: string;
  tokenSymbol: string;
};
type ApiTokenGroup = { chainId: number; tokens: ApiToken[] };

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
  const body = (await res.json()) as { success: boolean; data: T };
  if (!body.success) throw new Error(`GET ${path} -> success:false`);
  return body.data;
}

async function main() {
  console.log("fetching xflows supported chains + tokens…");
  const [apiChains, apiTokens] = await Promise.all([
    getJson<ApiChain[]>("/api/v3/supported/chains"),
    getJson<ApiTokenGroup[]>("/api/v3/supported/tokens"),
  ]);

  // EVM-only wallet: these xflows chains are intentionally NOT supported (different
  // curve / address model — secp256k1/EVM only, so we can't sign or read them).
  // Listed EXPLICITLY so that a NEW chain appearing in the API which is neither here
  // nor in the curated EVM map becomes a hard error instead of being silently
  // dropped. That enforces the product rule that our default chain set must stay a
  // SUPERSET of the API's EVM chains ("只能多不能少").
  const NON_EVM = new Set<number>([
    195, // TRON (TVM)
    501, // Solana
    2147483648, // Bitcoin
    2147485463, // Cardano
    2147484432, // Sui
    2147484107, // Kava (native/Cosmos id here, not Kava-EVM 2222)
  ]);
  const unclassified = apiChains.filter((c) => !EVM[c.chainId] && !NON_EVM.has(c.chainId));
  if (unclassified.length) {
    throw new Error(
      `xflows lists chain(s) not classified as EVM or non-EVM: ` +
        unclassified.map((c) => `${c.chainName}(${c.chainId})`).join(", ") +
        `\n  → add an EVM entry (rpc + color) for each EVM chain so the wallet supports it, ` +
        `or add its chainId to NON_EVM if it can't be (the default set must be ≥ the API's EVM set).`,
    );
  }

  await mkdir(LOGO_DIR, { recursive: true });

  const chains = apiChains
    .filter((c) => EVM[c.chainId])
    .map((c) => ({
      id: toHexId(c.chainId),
      name: c.chainName,
      symbol: c.symbol,
      rpc: EVM[c.chainId].rpc,
      decimals: c.decimals ?? 18, // a couple of chains omit it; EVM native is 18
      color: EVM[c.chainId].color,
      logo: c.logo ?? "",
    }))
    .sort((a, b) => parseInt(a.id, 16) - parseInt(b.id, 16));
  // Bake each chain logo locally (slug by chain id).
  for (const c of chains) c.logo = await localizeLogo(c.logo, `chain-${c.id}`);

  // Per-chain ERC-20 token lists. Drop the native (zero-address) pseudo-token —
  // native balances come from the chain itself, not an ERC-20 read.
  const tokens: Record<string, { address: string; symbol: string; name: string; decimals: number; logo: string }[]> = {};
  let tokenCount = 0;
  for (const group of apiTokens) {
    if (!EVM[group.chainId]) continue;
    const chainHex = toHexId(group.chainId);
    const list = group.tokens
      .filter((tk) => tk.tokenContractAddress.toLowerCase() !== ZERO)
      .map((tk) => ({
        address: tk.tokenContractAddress.toLowerCase(),
        symbol: tk.tokenSymbol,
        name: tk.tokenName,
        decimals: parseInt(tk.decimals, 10),
        logo: tk.tokenLogoUrl ?? "",
      }));
    // Bake each token logo locally (slug by chain id + contract address).
    for (const tk of list) tk.logo = await localizeLogo(tk.logo, `${chainHex}-${tk.address}`);
    if (list.length) {
      tokens[chainHex] = list;
      tokenCount += list.length;
    }
  }

  const header = `// AUTO-GENERATED by scripts/fetch-token-data.ts — DO NOT EDIT BY HAND.
// Snapshot of the wallet's default supported chains + ERC-20 tokens, fetched once
// from the xflows API and baked in (no runtime fetch). Regenerate: bun run gen:tokens
//
//   chains: ${chains.length} (EVM only)   tokens: ${tokenCount} across ${Object.keys(tokens).length} chains
`;

  const body = `${header}
export type TokenMeta = {
  /** ERC-20 contract address, lowercased. */
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  /** Remote logo URL (may be empty). */
  logo: string;
};

export type ChainMeta = {
  /** EIP-155 chain id as 0x-hex. */
  id: string;
  name: string;
  /** Native gas-token symbol. */
  symbol: string;
  rpc: string;
  decimals: number;
  color: string;
  /** Remote chain logo URL (may be empty). */
  logo: string;
};

/** Default supported EVM chains (snapshot). */
export const SUPPORTED_CHAINS: ChainMeta[] = ${JSON.stringify(chains, null, 2)};

/** Default ERC-20 tokens per chain (0x-hex chain id -> tokens). */
export const DEFAULT_TOKENS: Record<string, TokenMeta[]> = ${JSON.stringify(tokens, null, 2)};
`;

  await Bun.write(OUT, body);
  console.log(`wrote ${OUT}`);
  console.log(`  ${chains.length} chains: ${chains.map((c) => c.name).join(", ")}`);
  console.log(`  ${tokenCount} tokens across ${Object.keys(tokens).length} chains`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
