import { useEffect, useMemo, useState } from "react";
import { chainLogo, type Chain } from "./chains";

type ChainLike = Pick<Chain, "id" | "name" | "symbol" | "color">;

function iconCandidates(chain: ChainLike): string[] {
  const id = chain.id.toLowerCase();
  return [
    chainLogo(id),
    `/logos/chain-${id}.png`,
    `/logos/chain-${id}.webp`,
  ].filter((v, i, arr): v is string => !!v && arr.indexOf(v) === i);
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
  const [index, setIndex] = useState(0);
  useEffect(() => setIndex(0), [chain.id]);
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
          onError={() => setIndex((i) => i + 1)}
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
