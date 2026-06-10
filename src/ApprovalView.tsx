import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./ApprovalView.css";
import { Icon, type IconName } from "./lib/icons";
import { Avatar } from "./lib/ui";
import { useT, type TFn } from "./lib/i18n";
import { formatUnits, parseUnits, shortAddress, toHexQuantity } from "./lib/format";
import { isTauri } from "./lib/platform";
import { rpc } from "./lib/rpc";
import { simulateTx, type SimulationPreview } from "./lib/simulation";
import {
  detectPermit,
  encodeErc20Approve,
  parseApprovalDetails,
  parseTransferDetails,
  type ApprovalDetails,
  type TransferDetails,
  type TypedDataPayload,
} from "./lib/decode";

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
  typed_data?: TypedDataPayload;
}
type ApprovalTokenInfo = {
  symbol: string;
  decimals: number;
  balanceRaw: string;
  balance: string;
};
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
    case "wallet_addEthereumChain":
      return { title: t("approval.addNetwork"), icon: "globe", coral: false };
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
  const [approvalInfo, setApprovalInfo] = useState<ApprovalTokenInfo | null>(null);
  const [approvalAmount, setApprovalAmount] = useState("");
  const [approvalError, setApprovalError] = useState("");

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
  const approvalDetails = useMemo(
    () => (current?.tx ? parseApprovalDetails(current.tx) : null),
    [current?.id, current?.tx?.to, current?.tx?.data],
  );
  const transferDetails = useMemo(
    () => (current?.tx ? parseTransferDetails(current.tx) : null),
    [current?.id, current?.tx?.to, current?.tx?.data],
  );

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

  useEffect(() => {
    let cancelled = false;
    setApprovalInfo(null);
    setApprovalError("");
    setApprovalAmount("");
    if (!current?.tx || !approvalDetails) return;

    void loadApprovalTokenInfo(current.tx.chain_id, approvalDetails.tokenAddress, current.tx.from)
      .then((info) => {
        if (cancelled) return;
        setApprovalInfo(info);
        setApprovalAmount(formatTokenAmountForInput(approvalDetails.amountRaw, info.decimals));
      })
      .catch((e) => {
        if (!cancelled) {
          setApprovalError(errText(e) || "Unable to load token balance.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [approvalDetails, current?.id, current?.tx?.chain_id, current?.tx?.from]);

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
        const balanceChanges =
          sim?.status === "success" && sim.changes.length > 0
            ? sim.changes.map((c) => ({
                symbol: c.symbol,
                formattedDelta: c.formattedDelta,
                direction: c.direction,
              }))
            : undefined;
        let txData: string | undefined;
        if (approvalDetails) {
          if (approvalInfo) {
            try {
              txData = encodeErc20Approve(
                approvalDetails.spender,
                parseUnits(approvalAmount.trim(), approvalInfo.decimals),
              );
            } catch {
              setApprovalError(t("approval.approveAmountInvalid"));
              return;
            }
          } else if (!approvalError) {
            // Token metadata still loading — re-encoding needs real decimals.
            setApprovalError(t("approval.approveTokenLoading"));
            return;
          }
          // Metadata load FAILED (approvalError shown): the editable-amount
          // feature is unavailable, so the dApp's original calldata is sent
          // untouched — never re-encode with guessed decimals.
        }
        args = {
          id: req.id,
          maxFeePerGas,
          maxPriorityFeePerGas,
          txData,
          balanceChanges,
        };
      }
      setBusy(true);
      try {
        await invoke(approve ? "approve_request" : "reject_request", args);
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [refresh, maxFeeGwei, maxPrioGwei, sim, approvalDetails, approvalInfo, approvalAmount, t],
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
                transferDetails={transferDetails}
                approvalDetails={approvalDetails}
                approvalInfo={approvalInfo}
                approvalAmount={approvalAmount}
                onApprovalAmount={(v) => {
                  setApprovalAmount(v);
                  setApprovalError("");
                }}
                approvalError={approvalError}
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
        ) : current.typed_data ? (
          <TypedDataDetails data={current.typed_data} t={t} />
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
          <Icon name="alert" size={16} />
          {current.method === "wallet_addEthereumChain" ? t("approval.addNetworkWarn") : t("approval.warn")}
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
  transferDetails,
  approvalDetails,
  approvalInfo,
  approvalAmount,
  onApprovalAmount,
  approvalError,
  maxFeeGwei,
  onMaxFee,
  feeError,
  maxPrioGwei,
  onMaxPrio,
  prioError,
  t,
}: {
  tx: TxDisplay;
  transferDetails: TransferDetails | null;
  approvalDetails: ApprovalDetails | null;
  approvalInfo: ApprovalTokenInfo | null;
  approvalAmount: string;
  onApprovalAmount: (v: string) => void;
  approvalError: string;
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
      {transferDetails && <TransferSection tx={tx} details={transferDetails} t={t} />}
      {approvalDetails && (
        <div className="apv-approve-editor">
          <div className="apv-approve-head">
            <span>{t("approval.approveTitle")}</span>
            <span className="apv-approve-pill">{t("approval.editable")}</span>
          </div>
          <Row
            label={t("approval.token")}
            value={approvalInfo?.symbol ?? shortAddress(approvalDetails.tokenAddress, 10, 8)}
            mono={!approvalInfo}
          />
          <Row
            label={t("approval.spender")}
            value={shortAddress(approvalDetails.spender, 10, 8)}
            mono
          />
          <div className="apv-approve-field">
            <label className="field-label">{t("approval.approveAmount")}</label>
            <input
              className={`input mono${approvalError ? " err" : ""}`}
              value={approvalAmount}
              inputMode="decimal"
              placeholder={approvalInfo ? `${t("approval.amount")} (${approvalInfo.symbol})` : t("approval.approveTokenLoading")}
              disabled={!approvalInfo}
              onChange={(e) => onApprovalAmount(e.target.value)}
            />
            <div className="apv-approve-meta">
              <span>
                {t("approval.balance")}:{" "}
                {approvalInfo
                  ? `${approvalInfo.balance} ${approvalInfo.symbol}`
                  : t("approval.approveTokenLoading")}
              </span>
              {approvalInfo && (
                <button type="button" onClick={() => onApprovalAmount(approvalInfo.balance)}>
                  {t("approval.useBalance")}
                </button>
              )}
            </div>
            {approvalError && <div className="apv-approve-error">{approvalError}</div>}
          </div>
        </div>
      )}
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

function Row({
  label,
  value,
  mono,
  danger,
}: {
  label: string;
  value: string;
  mono?: boolean;
  danger?: boolean;
}) {
  return (
    <div className="apv-row">
      <span className="apv-row-l">{label}</span>
      <span className={`apv-row-v${mono ? " mono" : ""}${danger ? " danger" : ""}`}>{value}</span>
    </div>
  );
}

function errText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

function formatDeadline(deadline: bigint | null, t: TFn): string {
  if (deadline === null) return "—";
  if (deadline >= 253402300800n) return t("approval.permitNeverExpires"); // ≥ year 10000
  return new Date(Number(deadline) * 1000).toLocaleString();
}

// Full EIP-712 payload display: permit warning (spender/allowance/deadline) when
// the signature grants token spending, then domain + primaryType + the complete
// message. A summary line alone would be blind signing.
function TypedDataDetails({ data, t }: { data: TypedDataPayload; t: TFn }) {
  const permit = useMemo(() => detectPermit(data), [data]);
  const [tokenMeta, setTokenMeta] = useState<{ symbol: string; decimals: number } | null>(null);

  useEffect(() => {
    setTokenMeta(null);
    if (!permit?.token || !permit.chainHex || permit.amountRaw === null || permit.unlimited) return;
    let cancelled = false;
    // Display-only enrichment: if metadata can't load, the raw amount (the
    // ground truth) stays on screen — nothing is hidden or defaulted.
    void Promise.all([
      readErc20Symbol(permit.chainHex, permit.token),
      readErc20Decimals(permit.chainHex, permit.token),
    ])
      .then(([symbol, decimals]) => {
        if (!cancelled) setTokenMeta({ symbol, decimals });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [permit?.token, permit?.chainHex, permit?.amountRaw, permit?.unlimited]);

  const domain = (data.domain ?? {}) as Record<string, unknown>;
  const allowanceLabel = !permit
    ? ""
    : permit.unlimited
      ? t("approval.permitAmountUnlimited")
      : permit.amountRaw === null
        ? "—"
        : tokenMeta
          ? `${formatTokenAmountForInput(permit.amountRaw, tokenMeta.decimals)} ${tokenMeta.symbol}`
          : t("approval.rawAmount", { n: permit.amountRaw.toString() });

  return (
    <div className="apv-typed">
      {permit && (
        <div className="apv-permit">
          <div className="apv-permit-title">
            <Icon name="alert" size={15} /> {t("approval.permitWarnTitle")}
          </div>
          <div className="apv-permit-body">{t("approval.permitWarnBody")}</div>
          {permit.token && (
            <Row
              label={t("approval.token")}
              value={
                tokenMeta
                  ? `${tokenMeta.symbol} (${shortAddress(permit.token, 8, 6)})`
                  : shortAddress(permit.token, 10, 8)
              }
              mono={!tokenMeta}
            />
          )}
          {permit.spender && (
            <Row label={t("approval.spender")} value={shortAddress(permit.spender, 10, 8)} mono />
          )}
          <Row label={t("approval.allowance")} value={allowanceLabel} danger={permit.unlimited} />
          <Row
            label={t("approval.deadline")}
            value={formatDeadline(permit.deadline, t)}
            danger={permit.deadline !== null && permit.deadline >= 253402300800n}
          />
        </div>
      )}
      <div className="apv-tx">
        {typeof domain.name === "string" && (
          <Row label={t("approval.typedDomain")} value={domain.name} />
        )}
        {typeof domain.version === "string" && (
          <Row label={t("approval.typedVersion")} value={domain.version} />
        )}
        {domain.chainId != null && (
          <Row label={t("approval.typedChainId")} value={String(domain.chainId)} mono />
        )}
        {typeof domain.verifyingContract === "string" && (
          <Row
            label={t("approval.typedContract")}
            value={shortAddress(domain.verifyingContract, 10, 8)}
            mono
          />
        )}
        {typeof data.primaryType === "string" && (
          <Row label={t("approval.typedType")} value={data.primaryType} mono />
        )}
      </div>
      <div>
        <div className="field-label" style={{ padding: "0 2px 7px" }}>
          {t("approval.message")}
        </div>
        <pre className="apv-msg">{JSON.stringify(data.message, null, 2)}</pre>
      </div>
    </div>
  );
}

// Decoded ERC-20 transfer details (read-only) for a dApp transaction.
function TransferSection({
  tx,
  details,
  t,
}: {
  tx: TxDisplay;
  details: TransferDetails;
  t: TFn;
}) {
  const [meta, setMeta] = useState<{ symbol: string; decimals: number } | null>(null);
  const [metaFailed, setMetaFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setMeta(null);
    setMetaFailed(false);
    // Display-only enrichment: on failure the raw amount + token address stay
    // visible and a note says why — never a silently-guessed 18 decimals.
    void Promise.all([
      readErc20Symbol(tx.chain_id, details.tokenAddress),
      readErc20Decimals(tx.chain_id, details.tokenAddress),
    ])
      .then(([symbol, decimals]) => {
        if (!cancelled) setMeta({ symbol, decimals });
      })
      .catch(() => {
        if (!cancelled) setMetaFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [tx.chain_id, details.tokenAddress]);

  return (
    <div className="apv-approve-editor">
      <div className="apv-approve-head">
        <span>{t("approval.transferTitle")}</span>
        <span className="apv-approve-pill">{t("approval.decoded")}</span>
      </div>
      <Row
        label={t("approval.token")}
        value={
          meta
            ? `${meta.symbol} (${shortAddress(details.tokenAddress, 8, 6)})`
            : shortAddress(details.tokenAddress, 10, 8)
        }
        mono={!meta}
      />
      {details.owner && (
        <Row label={t("approval.transferOwner")} value={shortAddress(details.owner, 10, 8)} mono />
      )}
      <Row
        label={t("approval.transferRecipient")}
        value={shortAddress(details.recipient, 10, 8)}
        mono
      />
      <Row
        label={t("approval.amount")}
        value={
          meta
            ? `${formatTokenAmountForInput(details.amountRaw, meta.decimals)} ${meta.symbol}`
            : t("approval.rawAmount", { n: details.amountRaw.toString() })
        }
      />
      {metaFailed && <div className="apv-approve-error">{t("approval.tokenMetaFailed")}</div>}
    </div>
  );
}

async function loadApprovalTokenInfo(
  chainId: string,
  tokenAddress: string,
  owner: string,
): Promise<ApprovalTokenInfo> {
  const [symbol, decimals, balanceRaw] = await Promise.all([
    readErc20Symbol(chainId, tokenAddress),
    readErc20Decimals(chainId, tokenAddress),
    rpc<string>(chainId, "eth_call", [
      { to: tokenAddress, data: `0x70a08231${owner.replace(/^0x/, "").padStart(64, "0")}` },
      "latest",
    ]),
  ]);
  return {
    symbol,
    decimals,
    balanceRaw,
    balance: formatTokenAmountForInput(BigInt(balanceRaw), decimals),
  };
}

async function readErc20Symbol(chainId: string, tokenAddress: string): Promise<string> {
  try {
    const raw = await rpc<string>(chainId, "eth_call", [
      { to: tokenAddress, data: "0x95d89b41" },
      "latest",
    ]);
    return decodeAbiString(raw) || "TOKEN";
  } catch {
    return "TOKEN";
  }
}

async function readErc20Decimals(chainId: string, tokenAddress: string): Promise<number> {
  // NO fallback on failure: a guessed default (18) would re-encode an edited
  // approve at the wrong scale (e.g. USDC is 6) — a funds-loss bug. Fail loudly;
  // callers decide whether to block (approve editor) or degrade to raw display.
  const raw = await rpc<string>(chainId, "eth_call", [
    { to: tokenAddress, data: "0x313ce567" },
    "latest",
  ]);
  const value = Number(BigInt(raw));
  if (!Number.isFinite(value) || value < 0 || value > 255) {
    throw new Error(`unexpected ERC-20 decimals() result: ${raw}`);
  }
  return value;
}

function decodeAbiString(raw: string): string {
  const hex = raw.replace(/^0x/, "");
  if (hex.length === 64) return decodeBytes(hex);
  if (hex.length >= 128) {
    const len = Number(BigInt(`0x${hex.slice(64, 128)}`));
    if (Number.isFinite(len) && len >= 0) {
      return decodeBytes(hex.slice(128, 128 + len * 2));
    }
  }
  return "";
}

function decodeBytes(hex: string): string {
  const bytes = hex.match(/.{1,2}/g)?.map((b) => Number.parseInt(b, 16)) ?? [];
  const trimmed = bytes.filter((b) => b !== 0);
  return new TextDecoder().decode(new Uint8Array(trimmed)).trim();
}

function formatTokenAmountForInput(value: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const frac = value % base;
  if (frac === 0n) return whole.toString();
  return `${whole}.${frac.toString().padStart(decimals, "0").replace(/0+$/, "")}`;
}

export default ApprovalView;
