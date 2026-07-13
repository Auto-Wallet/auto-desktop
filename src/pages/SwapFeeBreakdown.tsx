import type { TFn } from "../lib/i18n";
import type { NeutralFee, NeutralFeeKind } from "../lib/swap";

const FEE_LABEL_KEYS: Record<NeutralFeeKind, string> = {
  network: "wallet.feeNetwork",
  bridge: "wallet.feeBridge",
  protocol: "wallet.feeProtocol",
  provider: "wallet.feeProvider",
  dex: "wallet.feeDex",
  relay: "wallet.feeRelay",
  app: "wallet.feeApp",
};

export function SwapFeeBreakdown({ fees, t }: { fees: NeutralFee[]; t: TFn }) {
  return (
    <section className="swap-fee-breakdown" aria-label={t("wallet.feeDetails")}>
      <div className="swap-fee-heading">{t("wallet.feeDetails")}</div>
      {fees.length === 0 ? (
        <div className="swap-summary-row swap-fee-unavailable">
          <span>{t("wallet.feeUnavailable")}</span>
        </div>
      ) : (
        fees.map((fee, index) => (
          <div className="swap-summary-row" key={`${fee.kind}:${fee.symbol}:${index}`}>
            <span>{t(FEE_LABEL_KEYS[fee.kind])}</span>
            <b>{fee.amount} {fee.symbol}</b>
          </div>
        ))
      )}
    </section>
  );
}
