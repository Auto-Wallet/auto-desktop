import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./ApprovalView.css";

// Mirrors the Rust `PendingRequest` (src-tauri/src/lib.rs).
interface PendingRequest {
  id: string;
  method: string;
  origin: string;
  summary: string;
}

const METHOD_LABEL: Record<string, string> = {
  personal_sign: "Sign message",
  eth_sign: "Sign data",
  eth_signTypedData_v4: "Sign typed data",
  eth_sendTransaction: "Send transaction",
};

/**
 * The approval window UI (loaded via index.html?view=approval in a dedicated
 * native window). It polls the backend for pending signing requests and lets the
 * user approve or reject. The approve/reject commands are granted ONLY to this
 * "approval" webview — the dapp webview can never reach them.
 */
function ApprovalView() {
  const [requests, setRequests] = useState<PendingRequest[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const list = await invoke<PendingRequest[]>("get_pending_requests");
    setRequests(list);
  }, []);

  useEffect(() => {
    void refresh();
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
        <div className="idle-mark">◆</div>
        <p>No pending requests</p>
      </div>
    );
  }

  return (
    <div className="approval">
      <header className="approval-head">
        <span className="approval-kind">{METHOD_LABEL[current.method] ?? current.method}</span>
        {requests.length > 1 && (
          <span className="approval-queue">1 of {requests.length}</span>
        )}
      </header>

      <div className="approval-origin">
        <span className="dot" />
        {current.origin}
      </div>

      <div className="approval-body">
        <div className="field-label">Message</div>
        <pre className="approval-message">{current.summary}</pre>
        <div className="approval-note">
          Only approve requests from sites you trust. Approving signs with your active account.
        </div>
      </div>

      <footer className="approval-actions">
        <button
          className="btn reject"
          disabled={busy}
          onClick={() => void decide(current.id, false)}
        >
          Reject
        </button>
        <button
          className="btn approve"
          disabled={busy}
          onClick={() => void decide(current.id, true)}
        >
          Approve
        </button>
      </footer>
    </div>
  );
}

export default ApprovalView;
