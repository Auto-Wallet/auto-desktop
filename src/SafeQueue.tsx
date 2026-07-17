import { useCallback, useEffect, useMemo, useState } from "react";
import "./SafeQueue.css";
import { findChain } from "./lib/chains";
import { fmtUnitsDisplay, shortAddress } from "./lib/format";
import { Icon } from "./lib/icons";
import { useT } from "./lib/i18n";
import { openExternalUrl } from "./lib/platform";
import {
  confirmSafeTransaction,
  getSafeByAddress,
  loadSafePendingTransactions,
  safeWalletUrl,
  type SafeTransaction,
} from "./lib/safes";
import { toast } from "./lib/toast";

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

export function SafeQueue({ address }: { address: string }) {
  const { t } = useT();
  const safe = getSafeByAddress(address);
  const [transactions, setTransactions] = useState<SafeTransaction[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signingHash, setSigningHash] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!safe) return;
    setLoading(true);
    setError(null);
    try {
      setTransactions(await loadSafePendingTransactions(safe));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setLoading(false);
    }
  }, [safe?.address, safe?.serviceUrl]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const chain = safe ? findChain(safe.chainId) : undefined;
  const externalUrl = safe ? safeWalletUrl(safe) : null;
  const ordered = useMemo(
    () =>
      [...transactions].sort(
        (a, b) =>
          BigInt(a.nonce) < BigInt(b.nonce)
            ? -1
            : BigInt(a.nonce) > BigInt(b.nonce)
              ? 1
              : 0,
      ),
    [transactions],
  );

  if (!safe) return null;

  async function confirm(transaction: SafeTransaction) {
    if (!safe) throw new Error("Safe account is no longer imported");
    setSigningHash(transaction.safeTxHash);
    setError(null);
    try {
      await confirmSafeTransaction(safe, transaction);
      toast(t("safe.confirmed"));
      await refresh();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSigningHash(null);
    }
  }

  return (
    <section className="safe-queue">
      <div className="safe-queue-head">
        <div>
          <div className="safe-queue-title">
            <Icon name="shield" size={16} />
            {t("safe.queue")}
          </div>
          <div className="safe-queue-sub">
            {chain?.name ?? safe.chainId} · {t("safe.threshold", {
              threshold: safe.threshold,
              owners: safe.owners.length,
            })}{" "}
            · {t("safe.localOwner")} {shortAddress(safe.ownerAddress, 8, 6)}
          </div>
        </div>
        <div className="safe-queue-actions">
          {externalUrl && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => void openExternalUrl(externalUrl)}
            >
              <Icon name="external" size={14} /> {t("safe.openWallet")}
            </button>
          )}
          <button
            type="button"
            className="icon-btn"
            title={t("wallet.refresh")}
            disabled={loading}
            onClick={() => void refresh()}
          >
            <Icon name="refresh" size={15} />
          </button>
        </div>
      </div>

      {error && (
        <div className="safe-error">
          <Icon name="alert" size={15} /> {error}
        </div>
      )}

      {loading && ordered.length === 0 ? (
        <div className="safe-empty">{t("safe.loading")}</div>
      ) : ordered.length === 0 ? (
        <div className="safe-empty">{t("safe.noPending")}</div>
      ) : (
        <div className="safe-tx-list">
          {ordered.map((transaction) => {
            const confirmations = transaction.confirmations ?? [];
            const ownerConfirmed = confirmations.some((confirmation) =>
              confirmation.owner.toLowerCase() === safe.ownerAddress.toLowerCase(),
            );
            const hasData =
              typeof transaction.data === "string" &&
              transaction.data !== "0x" &&
              transaction.data.length > 2;
            return (
              <article className="safe-tx" key={transaction.safeTxHash}>
                <div className="safe-tx-main">
                  <div className="safe-tx-name">
                    {hasData ? t("safe.contractCall") : t("safe.transfer")}
                    <span>#{String(transaction.nonce)}</span>
                  </div>
                  <div className="safe-tx-to mono">
                    {shortAddress(transaction.to, 10, 8)}
                  </div>
                  <div className="safe-tx-meta">
                    {fmtUnitsDisplay(transaction.value, 18)}{" "}
                    {chain?.symbol ?? ""}
                    <span>·</span>
                    {t("safe.confirmations", {
                      current: confirmations.length,
                      required: transaction.confirmationsRequired,
                    })}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={ownerConfirmed || signingHash !== null}
                  onClick={() => void confirm(transaction)}
                >
                  {ownerConfirmed
                    ? t("safe.signed")
                    : signingHash === transaction.safeTxHash
                      ? t("safe.signing")
                      : t("safe.sign")}
                </button>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
