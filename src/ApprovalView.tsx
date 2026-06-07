import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./ApprovalView.css";
import { Icon, type IconName } from "./lib/icons";
import { Avatar } from "./lib/ui";
import { useT, type TFn } from "./lib/i18n";
import { formatUnits, parseUnits, shortAddress, toHexQuantity } from "./lib/format";
import { isTauri } from "./lib/platform";

// Mirrors the Rust `PreparedTx` (snake_case from serde).
interface TxDisplay {
  chain_id: string;
  chain_name: string;
  symbol: string;
  from: string;
  to: string;
  value: string;
  data: string;
  gas: string;
  nonce: string;
  max_priority_fee_per_gas: string;
  max_fee_per_gas: string;
}

// Mirrors the Rust `PendingRequest` (src-tauri/src/lib.rs).
interface PendingRequest {
  id: string;
  method: string;
  origin: string;
  summary: string;
  tx?: TxDisplay;
}
// Mirrors the Rust vault status (read once so the window can show WHO signs).
interface VaultStatusDto {
  address: string | null;
  kind: "hd" | "privkey" | "ledger" | null;
}

function kindMeta(method: string, t: TFn): { title: string; icon: IconName; coral: boolean } {
  switch (method) {
    case "personal_sign":
      return { title: t("approval.signMessage"), icon: "edit", coral: false };
    case "eth_sign":
      return { title: t("approval.signData"), icon: "edit", coral: false };
    case "eth_signTypedData_v4":
      return { title: t("approval.signTyped"), icon: "edit", coral: false };
    case "eth_sendTransaction":
      return { title: t("approval.sendTx"), icon: "send", coral: true };
    default:
      return { title: method, icon: "shield", coral: false };
  }
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/**
 * The approval window UI (loaded via index.html?view=approval in a dedicated
 * native window). It polls the backend for pending signing requests and lets the
 * user approve or reject. The approve/reject commands are granted ONLY to this
 * "approval" webview — the dapp webview can never reach them.
 */
function ApprovalView() {
  const { t } = useT();
  const [requests, setRequests] = useState<PendingRequest[]>([]);
  const [signer, setSigner] = useState<VaultStatusDto | null>(null);
  const [busy, setBusy] = useState(false);
  // Editable max fee (Gwei) for an eth_sendTransaction request.
  const [maxFeeGwei, setMaxFeeGwei] = useState("");
  const [feeError, setFeeError] = useState(false);

  const refresh = useCallback(async () => {
    if (!isTauri()) return;
    const list = await invoke<PendingRequest[]>("get_pending_requests");
    setRequests(list);
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    void refresh();
    void invoke<VaultStatusDto>("vault_status")
      .then((s) => setSigner(s))
      .catch(() => setSigner(null));
    const timer = setInterval(() => void refresh(), 500);
    return () => clearInterval(timer);
  }, [refresh]);

  const current = requests[0];

  // Seed the editable fee field from the resolved tx whenever the active request
  // changes (so the user starts from the suggested max fee, in Gwei).
  useEffect(() => {
    if (current?.tx) {
      setMaxFeeGwei(formatUnits(current.tx.max_fee_per_gas, 9, 6));
      setFeeError(false);
    }
  }, [current?.id, current?.tx?.max_fee_per_gas]);

  const decide = useCallback(
    async (req: PendingRequest, approve: boolean) => {
      let args: Record<string, unknown> = { id: req.id };
      if (approve && req.tx) {
        // Hand back the (possibly edited) max fee as a wei-hex override.
        try {
          args = { id: req.id, maxFeePerGas: toHexQuantity(parseUnits(maxFeeGwei, 9)) };
        } catch {
          setFeeError(true);
          return;
        }
      }
      setBusy(true);
      try {
        await invoke(approve ? "approve_request" : "reject_request", args);
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [refresh, maxFeeGwei],
  );

  if (!current) {
    return (
      <div className="approval idle">
        <div>
          <div className="idle-mark">
            <Icon name="shieldCheck" size={26} />
          </div>
          <p>{t("approval.idle")}</p>
        </div>
      </div>
    );
  }

  const meta = kindMeta(current.method, t);
  const isLedger = signer?.kind === "ledger";

  return (
    <div className="approval">
      <header className="approval-head">
        <Icon name="shield" size={14} /> {t("approval.title")}
        {requests.length > 1 && (
          <span className="approval-queue">{t("approval.queue", { i: 1, n: requests.length })}</span>
        )}
      </header>

      <div className="approval-body scroll">
        <div className="apv-kind">
          <span className={`kic${meta.coral ? " coral" : ""}`}>
            <Icon name={meta.icon} size={24} />
          </span>
          <h2>{meta.title}</h2>
          <div className="sub mono">{current.method}</div>
        </div>

        <div className="apv-origin">
          <span className="of">
            <Icon name="globe" size={16} />
          </span>
          <div className="od">
            <div className="oh">{hostOf(current.origin)}</div>
            <div className="os">{current.origin}</div>
          </div>
        </div>

        {current.tx ? (
          <TxDetails
            tx={current.tx}
            maxFeeGwei={maxFeeGwei}
            onMaxFee={(v) => {
              setMaxFeeGwei(v);
              setFeeError(false);
            }}
            feeError={feeError}
            t={t}
          />
        ) : (
          <div>
            <div className="field-label" style={{ padding: "0 2px 7px" }}>
              {t("approval.message")}
            </div>
            <pre className="apv-msg">{current.summary}</pre>
          </div>
        )}

        {signer?.address && (
          <div className="apv-signer">
            <Avatar address={signer.address} size={28} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="sl">{t("approval.signingWith")}</div>
              <div className="sn">{shortAddress(signer.address, 8, 6)}</div>
            </div>
            {isLedger && (
              <span className="badge ledger">
                <Icon name="ledger" size={11} /> Ledger
              </span>
            )}
          </div>
        )}

        <div className="apv-warn">
          <Icon name="alert" size={16} /> {t("approval.warn")}
        </div>

        {isLedger && busy && (
          <div className="ledger-confirm">
            <Icon name="ledger" size={17} /> {t("approval.ledgerConfirm")}
          </div>
        )}
      </div>

      <footer className="approval-foot">
        <button className="btn btn-ghost btn-lg" disabled={busy} onClick={() => void decide(current, false)}>
          {t("approval.reject")}
        </button>
        <button
          className="btn btn-aurora btn-lg grow"
          disabled={busy}
          onClick={() => void decide(current, true)}
        >
          {busy ? t("approval.waiting") : t("approval.approve")}
        </button>
      </footer>
    </div>
  );
}

function toBigintSafe(hex: string): string {
  try {
    return BigInt(hex).toString();
  } catch {
    return hex;
  }
}

// Transaction details for an eth_sendTransaction approval, with an editable max fee.
function TxDetails({
  tx,
  maxFeeGwei,
  onMaxFee,
  feeError,
  t,
}: {
  tx: TxDisplay;
  maxFeeGwei: string;
  onMaxFee: (v: string) => void;
  feeError: boolean;
  t: TFn;
}) {
  const hasData = !!tx.data && tx.data !== "0x" && tx.data.length > 2;
  const dataBytes = hasData ? tx.data.replace(/^0x/, "").length / 2 : 0;
  return (
    <div className="apv-tx">
      <Row label={t("approval.network")} value={tx.chain_name} />
      <Row
        label={t("approval.to")}
        mono
        value={tx.to ? shortAddress(tx.to, 10, 8) : t("approval.newContract")}
      />
      <Row label={t("approval.amount")} value={`${formatUnits(tx.value, 18)} ${tx.symbol}`} />
      <Row label={t("approval.gasLimit")} value={toBigintSafe(tx.gas)} mono />
      <Row label={t("approval.nonce")} value={toBigintSafe(tx.nonce)} mono />
      {hasData && <Row label={t("approval.data")} value={t("approval.dataBytes", { n: dataBytes })} />}
      <div className="apv-fee">
        <label className="field-label">{t("approval.maxFee")}</label>
        <div className={`apv-fee-input${feeError ? " err" : ""}`}>
          <input
            className="input mono"
            value={maxFeeGwei}
            inputMode="decimal"
            onChange={(e) => onMaxFee(e.target.value)}
          />
          <span className="apv-fee-unit">Gwei</span>
        </div>
        <div className="apv-fee-hint">{t("approval.maxFeeHint")}</div>
      </div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="apv-row">
      <span className="apv-row-l">{label}</span>
      <span className={`apv-row-v${mono ? " mono" : ""}`}>{value}</span>
    </div>
  );
}

export default ApprovalView;
