import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { BUNDLED_CHAIN_LOGOS, ChainIcon, chainIconCandidates } from "./ChainIcon";

const bundledFiles = readdirSync(new URL("../../public/logos", import.meta.url)).filter((f) =>
  /^chain-0x[0-9a-f]+\.(png|webp)$/.test(f),
);

describe("chainIconCandidates", () => {
  test("lists exactly the chain logos shipped in public/logos", () => {
    const listed = Object.entries(BUNDLED_CHAIN_LOGOS).map(([id, ext]) => `chain-${id}.${ext}`);
    expect(listed.sort()).toEqual(bundledFiles.sort());
  });

  test("a custom chain without a logo goes straight to its letter badge", () => {
    // Guessing /logos/chain-<id>.png for chains we ship nothing for relied on
    // <img> onError; WebKit's cached failures left an empty circle instead.
    expect(chainIconCandidates("0x4115")).toEqual([]);
    expect(chainIconCandidates("0xA869")).toEqual([]);

    const html = renderToStaticMarkup(
      <ChainIcon chain={{ id: "0x4115", name: "0G Mainnet", symbol: "0G", color: "#6b7280" }} size={16} />,
    );
    expect(html).not.toContain("<img");
    expect(html).toContain(">0G</span>");
  });

  test("every candidate for a built-in chain points at a file that exists", () => {
    for (const id of ["0x1", "0x1e0", "0xa86a"]) {
      const local = chainIconCandidates(id).filter((src) => src.startsWith("/logos/"));
      expect(local.length).toBe(1);
      expect(bundledFiles).toContain(local[0].slice("/logos/".length));
    }
  });
});
