import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { TFn } from "../lib/i18n";
import { SwapFeeBreakdown } from "./SwapFeeBreakdown";

const labels: Record<string, string> = {
  "wallet.feeDetails": "Fee details",
  "wallet.feeUnavailable": "Not reported by provider",
  "wallet.feeNetwork": "Network fee",
  "wallet.feeBridge": "Bridge fee",
  "wallet.feeProtocol": "Protocol fee",
  "wallet.feeProvider": "Provider fee",
  "wallet.feeDex": "DEX fee",
  "wallet.feeRelay": "Relay fee",
  "wallet.feeApp": "App fee",
};

const t: TFn = (key) => {
  const translated = labels[key];
  if (!translated) throw new Error(`Missing test translation: ${key}`);
  return translated;
};

describe("SwapFeeBreakdown", () => {
  test("shows every fee reported by the selected quote with its amount and asset", () => {
    const html = renderToStaticMarkup(
      <SwapFeeBreakdown
        t={t}
        fees={[
          { kind: "network", amount: "0.000012", symbol: "ETH" },
          { kind: "bridge", amount: "0.000047", symbol: "wanETH" },
          { kind: "app", amount: "0.10%", symbol: "ETH" },
        ]}
      />,
    );

    expect(html).toContain("Fee details");
    expect(html).toContain("Network fee");
    expect(html).toContain("0.000012 ETH");
    expect(html).toContain("Bridge fee");
    expect(html).toContain("0.000047 wanETH");
    expect(html).toContain("App fee");
    expect(html).toContain("0.10% ETH");
  });

  test("states when the provider did not report a fee breakdown", () => {
    const html = renderToStaticMarkup(<SwapFeeBreakdown t={t} fees={[]} />);

    expect(html).toContain("Fee details");
    expect(html).toContain("Not reported by provider");
  });
});
