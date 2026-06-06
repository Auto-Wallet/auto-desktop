import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./ApprovalView.css";
import { Icon, type IconName } from "./lib/icons";
import { Avatar } from "./lib/ui";
import { useT, type TFn } from "./lib/i18n";
import { shortAddress } from "./lib/format";
import { isTauri } from "./lib/platform";

// Mirrors the Rust `PendingRequest` (src-tauri/src/lib.rs).
interface PendingRequest {
  id: string;
  method: string;
  origin: string;
  summary: string;
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

  const decide = useCallback(
    async (id: string, approve: boolean) => {
      setBusy(true);
      try {
        await invoke(approve ? "approve_request" : "reject_request", { id });
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const current = requests[0];

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

        <div>
          <div className="field-label" style={{ padding: "0 2px 7px" }}>
            {t("approval.message")}
          </div>
          <pre className="apv-msg">{current.summary}</pre>
        </div>

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
        <button className="btn btn-ghost btn-lg" disabled={busy} onClick={() => void decide(current.id, false)}>
          {t("approval.reject")}
        </button>
        <button
          className="btn btn-aurora btn-lg grow"
          disabled={busy}
          onClick={() => void decide(current.id, true)}
        >
          {busy ? t("approval.waiting") : t("approval.approve")}
        </button>
      </footer>
    </div>
  );
}

export default ApprovalView;
