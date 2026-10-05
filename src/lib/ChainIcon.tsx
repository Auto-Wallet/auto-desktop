import { useMemo, useState } from "react";
import { chainLogo, type Chain } from "./chains";

type ChainLike = Pick<Chain, "id" | "name" | "symbol" | "color">;

/**
 * Chain logos shipped in public/logos, by chain id. Only these are tried:
 * guessing a path for a chain we ship nothing for relied on <img> onError, and
 * WebKit's cached failures could swallow it and leave an empty circle.
 * ChainIcon.test.tsx keeps this list in step with the folder.
 */
export const BUNDLED_CHAIN_LOGOS: Record<string, "png" | "webp"> = {
  "0x1": "png",
  "0x13e31": "png",
  "0x144": "png",
  "0x1e0": "webp",
  "0x2105": "png",
  "0x250": "png",
  "0x378": "png",
  "0x38": "png",
  "0x440": "png",
  "0x44d": "webp",
  "0x89": "png",
  "0x92": "webp",
  "0xa": "png",
  "0xa4b1": "png",
  "0xa4ec": "png",
  "0xa86a": "png",
  "0xc4": "png",
  "0xe708": "png",
};

export function chainIconCandidates(chainId: string): string[] {
  const id = chainId.toLowerCase();
  const ext = BUNDLED_CHAIN_LOGOS[id];
  return [chainLogo(id), ext ? `/logos/chain-${id}.${ext}` : undefined].filter(
    (v, i, arr): v is string => !!v && arr.indexOf(v) === i,
  );
}

function iconCandidates(chain: ChainLike): string[] {
  return chainIconCandidates(chain.id);
}

export function ChainIcon({
  chain,
  size = 18,
  className = "",
}: {
  chain: ChainLike;
  size?: number;
  className?: string;
}) {
  const candidates = useMemo(
    () => iconCandidates(chain),
    [chain.id, chain.name, chain.symbol, chain.color],
  );
  // Keyed by chain id so a new chain restarts the list. A reset effect ran on
  // every mount too, after a fast cached failure, and sent the icon back to a
  // source that had already failed.
  const [tried, setTried] = useState({ id: chain.id, count: 0 });
  const index = tried.id === chain.id ? tried.count : 0;
  const src = candidates[index];
  const letters = chain.symbol.slice(0, chain.symbol.length > 3 ? 3 : chain.symbol.length);

  return (
    <span
      className={`chain-icon ${className}`}
      style={{ width: size, height: size }}
      title={chain.name}
    >
      {src ? (
        <img
          src={src}
          alt=""
          width={size}
          height={size}
          onError={() => setTried({ id: chain.id, count: index + 1 })}
        />
      ) : (
        <span
          className="chain-icon-fallback"
          style={{
            background: chain.color,
            fontSize: size <= 12 ? 0 : Math.max(9, Math.min(12, size * 0.38)),
          }}
        >
          {size <= 12 ? "" : letters}
        </span>
      )}
    </span>
  );
}
