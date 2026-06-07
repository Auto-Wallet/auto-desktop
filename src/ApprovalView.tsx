import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./ApprovalView.css";
import { Icon, type IconName } from "./lib/icons";
import { Avatar } from "./lib/ui";
import { useT, type TFn } from "./lib/i18n";
import { formatUnits, parseUnits, shortAddress, toHexQuantity } from "./lib/format";
import { isTauri } from "./lib/platform";
import { simulateTx, type SimulationPreview } from "./lib/simulation";

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
  // Editable EIP-1559 fees (Gwei) for an eth_sendTransaction request: the max fee
  // cap and the priority fee (tip). Both are sent back as wei-hex overrides.
  const [maxFeeGwei, setMaxFeeGwei] = useState("");
  const [maxPrioGwei, setMaxPrioGwei] = useState("");
  const [feeError, setFeeError] = useState(false);
  const [prioError, setPrioError] = useState(false);
  // Which tx view: the structured basics, raw JSON, or the calldata hex.
  const [txView, setTxView] = useState<"basic" | "json" | "hex">("basic");
  // Pre-sign balance-change simulation for the active eth_sendTransaction request.
  const [sim, setSim] = useState<SimulationPreview | null>(null);
  const [simPending, setSimPending] = useState(false);

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
      setMaxPrioGwei(formatUnits(current.tx.max_priority_fee_per_gas, 9, 6));
      setFeeError(false);
      setPrioError(false);
    }
  }, [current?.id, current?.tx?.max_fee_per_gas, current?.tx?.max_priority_fee_per_gas]);

  // Simulate the active tx to preview the signer's balance changes before signing.
  useEffect(() => {
    const tx = current?.tx;
    if (!tx) {
      setSim(null);
      setSimPending(false);
      return;
    }
    let cancelled = false;
    setSim(null);
    setSimPending(true);
    void simulateTx({
      chainId: parseInt(tx.chain_id, 16),
      from: tx.from,
      to: tx.to || null,
      data: tx.data,
      value: BigInt(tx.value || "0x0"),
      gas: BigInt(tx.gas || "0x0"),
      nativeSymbol: tx.symbol,
    })
      .then((preview) => {
        if (!cancelled) setSim(preview);
      })
      .finally(() => {
        if (!cancelled) setSimPending(false);
      });
    return () => {
      cancelled = true;
    };
  }, [current?.id, current?.tx?.chain_id, current?.tx?.to, current?.tx?.data, current?.tx?.value]);

  const decide = useCallback(
    async (req: PendingRequest, approve: boolean) => {
      let args: Record<string, unknown> = { id: req.id };
      if (approve && req.tx) {
        // Hand back the (possibly edited) EIP-1559 fees as wei-hex overrides. Parse
        // each separately so the offending field is the one flagged. (The backend
        // re-clamps priority ≤ max fee, so we don't have to.)
        let maxFeePerGas: string;
        let maxPriorityFeePerGas: string;
        try {
          maxFeePerGas = toHexQuantity(parseUnits(maxFeeGwei, 9));
        } catch {
          setFeeError(true);
          return;
        }
        try {
          maxPriorityFeePerGas = toHexQuantity(parseUnits(maxPrioGwei, 9));
        } catch {
          setPrioError(true);
          return;
        }
        args = { id: req.id, maxFeePerGas, maxPriorityFeePerGas };
      }
      setBusy(true);
      try {
        await invoke(approve ? "approve_request" : "reject_request", args);
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [refresh, maxFeeGwei, maxPrioGwei],
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
          <>
            <div className="apv-tabs">
              {(["basic", "json", "hex"] as const).map((v) => (
                <button
                  key={v}
                  className={`apv-tab${txView === v ? " on" : ""}`}
                  onClick={() => setTxView(v)}
                >
                  {v === "basic" ? t("approval.tabBasic") : v === "json" ? "JSON" : "HEX"}
                </button>
              ))}
            </div>
            {txView === "basic" ? (
              <>
                <SimPreview sim={sim} pending={simPending} t={t} />
                <TxDetails
                tx={current.tx}
                maxFeeGwei={maxFeeGwei}
                onMaxFee={(v) => {
                  setMaxFeeGwei(v);
                  setFeeError(false);
                }}
                feeError={feeError}
                maxPrioGwei={maxPrioGwei}
                onMaxPrio={(v) => {
                  setMaxPrioGwei(v);
                  setPrioError(false);
                }}
                prioError={prioError}
                t={t}
                />
              </>
            ) : txView === "json" ? (
              <pre className="apv-msg">{txAsJson(current.tx)}</pre>
            ) : (
              <pre className="apv-msg">{current.tx.data && current.tx.data !== "0x" ? current.tx.data : "0x"}</pre>
            )}
          </>
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

// Pre-sign balance-change preview from the simulation API.
function SimPreview({ sim, pending, t }: { sim: SimulationPreview | null; pending: boolean; t: TFn }) {
  return (
    <div className="apv-sim">
      <div className="apv-sim-head">
        <Icon name="activity" size={14} /> {t("approval.simTitle")}
        {pending && <span className="apv-sim-tag">{t("approval.simulating")}</span>}
      </div>
      {pending ? (
        <div className="apv-sim-skel">
          <span className="skeleton" style={{ width: "60%", height: 14 }} />
          <span className="skeleton" style={{ width: "40%", height: 14 }} />
        </div>
      ) : sim && sim.status === "failed" ? (
        <div className="apv-sim-bad">
          <Icon name="alert" size={15} /> {sim.error || t("approval.simRevert")}
        </div>
      ) : sim && sim.status === "unavailable" ? (
        <div className="apv-sim-note">{t("approval.simUnavailable")}</div>
      ) : sim && sim.changes.length > 0 ? (
        <div className="apv-sim-list">
          {sim.changes.map((c) => (
            <div key={c.key} className={`apv-sim-row ${c.direction}`}>
              <span className="sym">{c.symbol}</span>
              <span className="delta mono">{c.formattedDelta}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="apv-sim-note">{t("approval.simNoChange")}</div>
      )}
    </div>
  );
}

// The tx as the EIP-1193 params a dApp sent, pretty-printed (raw hex values).
function txAsJson(tx: TxDisplay): string {
  return JSON.stringify(
    {
      from: tx.from,
      to: tx.to,
      value: tx.value,
      data: tx.data,
      gas: tx.gas,
      nonce: tx.nonce,
      maxFeePerGas: tx.max_fee_per_gas,
      maxPriorityFeePerGas: tx.max_priority_fee_per_gas,
      chainId: tx.chain_id,
    },
    null,
    2,
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
  maxPrioGwei,
  onMaxPrio,
  prioError,
  t,
}: {
  tx: TxDisplay;
  maxFeeGwei: string;
  onMaxFee: (v: string) => void;
  feeError: boolean;
  maxPrioGwei: string;
  onMaxPrio: (v: string) => void;
  prioError: boolean;
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
      <FeeInput label={t("approval.maxPriority")} value={maxPrioGwei} onChange={onMaxPrio} err={prioError} hint={t("approval.maxPriorityHint")} />
      <FeeInput label={t("approval.maxFee")} value={maxFeeGwei} onChange={onMaxFee} err={feeError} hint={t("approval.maxFeeHint")} />
    </div>
  );
}

// One editable EIP-1559 fee field (in Gwei).
function FeeInput({
  label,
  value,
  onChange,
  err,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  err: boolean;
  hint: string;
}) {
  return (
    <div className="apv-fee">
      <label className="field-label">{label}</label>
      <div className={`apv-fee-input${err ? " err" : ""}`}>
        <input className="input mono" value={value} inputMode="decimal" onChange={(e) => onChange(e.target.value)} />
        <span className="apv-fee-unit">Gwei</span>
      </div>
      <div className="apv-fee-hint">{hint}</div>
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
